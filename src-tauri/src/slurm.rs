use crate::{collector, models::Server};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use tokio::time::Duration;

const NODES_SCRIPT: &str = r#"set -eu
export LC_ALL=C
unset SINFO_ALL SINFO_PARTITION SLURM_CLUSTERS
nodes=$(sinfo --local --Node --noheader --format='%R|%N|%n|%o|%T|%C|%G')
printf '%s\n' '__RACKTOP_NODE_HOST__'
hostname || :
printf '%s\n' '__RACKTOP_NODE_ADDRESSES__'
if command -v getent >/dev/null && command -v timeout >/dev/null; then
  hosts=$(printf '%s\n' "$nodes" | awk -F '|' '{ for (i = 3; i <= 4; i++) if ($i ~ /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ && !seen[$i]++) print $i }')
  if [ -n "$hosts" ]; then
    set -f
    timeout 3 getent hosts $hosts || :
  fi
fi
printf '%s\n%s\n' '__RACKTOP_NODES__' "$nodes"
"#;

const JOBS_SCRIPT: &str = r#"set -eu
export LC_ALL=C
unset SQUEUE_ACCOUNT SQUEUE_ALL SQUEUE_ARRAY SQUEUE_NAMES SQUEUE_LICENSES \
      SQUEUE_PARTITION SQUEUE_PRIORITY SQUEUE_QOS SQUEUE_SIBLING SQUEUE_USERS \
      SQUEUE_FORMAT SQUEUE_FORMAT2 SQUEUE_SORT SQUEUE_STATES SLURM_CLUSTERS
printf '%s\n' '__RACKTOP_USER__'
id -un
if jobs=$(squeue --local --states=PENDING --json); then
  printf '%s\n%s\n' '__RACKTOP_JOBS_JSON__' "$jobs"
else
  printf '%s\n' '__RACKTOP_JOBS_TEXT__'
  separator=$(printf '\036')
  squeue --local --noheader --states=PENDING --format="%i|%u|%P|%C|%r|%j${separator}"
fi
"#;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlurmOverview {
    username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    query_hostname: Option<String>,
    partitions: Vec<SlurmPartition>,
    nodes: BTreeMap<String, SlurmNode>,
    jobs: Vec<SlurmJob>,
    #[serde(skip_serializing_if = "Option::is_none")]
    partition_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    job_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlurmPartition {
    name: String,
    node_names: BTreeSet<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlurmNode {
    hostname: String,
    address: String,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    resolved_addresses: BTreeSet<std::net::IpAddr>,
    state: String,
    cpu_total: Option<u64>,
    cpu_allocated: Option<u64>,
    gpu_types: Vec<SlurmGpuType>,
}

#[derive(Debug, PartialEq, Serialize)]
struct SlurmGpuType {
    name: String,
    count: u32,
}

#[derive(Debug, Serialize)]
struct SlurmJob {
    id: String,
    user: String,
    partition: String,
    cpus: Option<u64>,
    reason: String,
    name: String,
}

pub async fn collect(server: &Server, password: Option<&str>, include_jobs: bool) -> Result<SlurmOverview, String> {
    let (nodes, jobs) = tokio::join!(
        query(server, password, NODES_SCRIPT),
        async {
            if include_jobs {
                query(server, password, JOBS_SCRIPT).await
            } else {
                Ok(String::new())
            }
        },
    );
    let nodes = nodes.and_then(|output| {
        let query_hostname = split_section(&output, "__RACKTOP_NODE_HOST__")
            .ok()
            .and_then(|(_, rest)| rest.lines().next())
            .map(str::trim)
            .filter(|value| {
                !value.is_empty()
                    && !value.contains(char::is_whitespace)
                    && *value != "__RACKTOP_NODES__"
            })
            .map(str::to_owned);
        let (partitions, nodes) = parse_nodes(&output)?;
        Ok((partitions, nodes, query_hostname))
    });
    let jobs = jobs.and_then(|output| if include_jobs { parse_jobs(&output) } else { Ok((String::new(), Vec::new())) });
    if let (Err(nodes), Err(jobs)) = (&nodes, &jobs) {
        return Err(if nodes == jobs {
            nodes.clone()
        } else {
            format!("分区：{nodes}；作业：{jobs}")
        });
    }
    let (partitions, nodes, query_hostname, partition_error) = match nodes {
        Ok((partitions, nodes, query_hostname)) => (partitions, nodes, query_hostname, None),
        Err(error) => (Vec::new(), BTreeMap::new(), None, Some(error)),
    };
    let (username, jobs, job_error) = match jobs {
        Ok((username, jobs)) => (username, jobs, None),
        Err(error) => (String::new(), Vec::new(), Some(error)),
    };
    Ok(SlurmOverview {
        username,
        query_hostname,
        partitions,
        nodes,
        jobs,
        partition_error,
        job_error,
    })
}

async fn query(server: &Server, password: Option<&str>, script: &str) -> Result<String, String> {
    let (command, target) = collector::configured_ssh_command(server, password)?;
    let output = collector::run_ssh_script(
        command,
        &target,
        script,
        Duration::from_secs(20),
        "Slurm 查询超时（20 秒）",
    )
    .await?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_nodes(text: &str) -> Result<(Vec<SlurmPartition>, BTreeMap<String, SlurmNode>), String> {
    let (metadata, node_lines) = split_section(text, "__RACKTOP_NODES__")?;
    let mut addresses = BTreeMap::<String, BTreeSet<std::net::IpAddr>>::new();
    if let Ok((_, address_lines)) = split_section(metadata, "__RACKTOP_NODE_ADDRESSES__") {
        for line in address_lines.lines() {
            let mut fields = line.split_whitespace();
            let Some(ip) = fields.next().and_then(|value| value.parse().ok()) else {
                continue;
            };
            for host in fields.take_while(|field| !field.starts_with('#')) {
                addresses
                    .entry(host.trim_end_matches('.').to_ascii_lowercase())
                    .or_default()
                    .insert(ip);
            }
        }
    }
    let mut memberships = BTreeMap::<String, BTreeSet<String>>::new();
    let mut nodes = BTreeMap::new();
    for line in node_lines.lines().filter(|line| !line.trim().is_empty()) {
        let fields: Vec<_> = line.split('|').map(str::trim).collect();
        let [partition, name, hostname, address, state, cpus, gres] = fields.as_slice() else {
            return Err("无法识别 Slurm 节点记录".into());
        };
        let names = memberships.entry((*partition).to_owned()).or_default();
        if matches!(*name, "" | "(null)" | "n/a") {
            continue;
        }
        names.insert((*name).to_owned());
        nodes.entry((*name).to_owned()).or_insert_with(|| {
            let cpu_counts: Vec<_> = cpus.split('/').collect();
            SlurmNode {
                hostname: (*hostname).to_owned(),
                address: (*address).to_owned(),
                resolved_addresses: [hostname, address]
                    .into_iter()
                    .filter_map(|host| {
                        addresses.get(&host.trim_end_matches('.').to_ascii_lowercase())
                    })
                    .flatten()
                    .copied()
                    .collect(),
                state: (*state).to_owned(),
                cpu_total: cpu_counts.get(3).and_then(|value| value.parse().ok()),
                cpu_allocated: cpu_counts.first().and_then(|value| value.parse().ok()),
                gpu_types: parse_gpu_types(gres),
            }
        });
    }
    let partitions = memberships
        .into_iter()
        .map(|(name, node_names)| SlurmPartition { name, node_names })
        .collect();
    Ok((partitions, nodes))
}

fn parse_jobs(text: &str) -> Result<(String, Vec<SlurmJob>), String> {
    let (_, output) = split_section(text, "__RACKTOP_USER__")?;
    let (username, output) = output.split_once('\n').ok_or("Slurm 作业查询返回不完整")?;
    let username = username.trim();
    if username.is_empty() || username.contains(char::is_whitespace) {
        return Err("无法识别 Slurm 查询使用的 SSH 账号".into());
    }
    let jobs = if let Some(json) = output.strip_prefix("__RACKTOP_JOBS_JSON__\n") {
        parse_json_jobs(json)?
    } else {
        let rows = output
            .strip_prefix("__RACKTOP_JOBS_TEXT__\n")
            .ok_or("Slurm 作业查询返回不完整")?;
        if !rows.trim().is_empty() && !rows.trim_end().ends_with('\x1e') {
            return Err("Slurm 等待作业输出不完整".into());
        }
        rows.split('\x1e')
            .filter(|row| !row.trim().is_empty())
            .map(parse_job)
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok((username.into(), jobs))
}

fn slurm_number(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        if value["set"].as_bool() == Some(false) || value["infinite"].as_bool() == Some(true) {
            return None;
        }
        value["number"].as_u64()
    })
}

fn parse_json_jobs(text: &str) -> Result<Vec<SlurmJob>, String> {
    let document: Value =
        serde_json::from_str(text).map_err(|error| format!("无法读取 Slurm 作业 JSON：{error}"))?;
    if let Some(error) = document["errors"]
        .as_array()
        .and_then(|errors| errors.first())
    {
        let description = error["description"]
            .as_str()
            .or(error["error"].as_str())
            .unwrap_or("未提供详情");
        return Err(format!("Slurm 返回作业查询错误：{description}"));
    }
    let jobs = document["jobs"]
        .as_array()
        .ok_or("Slurm 作业 JSON 缺少作业列表")?;
    jobs.iter()
        .filter(|job| match &job["job_state"] {
            Value::String(state) => state == "PENDING",
            Value::Array(states) => states.iter().any(|state| state.as_str() == Some("PENDING")),
            _ => false,
        })
        .map(|job| {
            let id = slurm_number(&job["job_id"]).ok_or("Slurm 作业 JSON 缺少作业 ID")?;
            let array = slurm_number(&job["array_job_id"]).filter(|id| *id > 0);
            let id = match (
                array,
                job["array_task_string"]
                    .as_str()
                    .filter(|value| !value.is_empty()),
                slurm_number(&job["array_task_id"]).filter(|value| *value < u32::MAX as u64 - 1),
            ) {
                (Some(array), Some(tasks), _) => {
                    format!("{array}_[{}]", tasks.trim_matches(['[', ']']))
                }
                (Some(array), None, Some(task)) => format!("{array}_{task}"),
                _ => id.to_string(),
            };
            let user = job["user_name"]
                .as_str()
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .or_else(|| slurm_number(&job["user_id"]).map(|id| id.to_string()))
                .ok_or("Slurm 作业 JSON 缺少提交账号")?;
            Ok(SlurmJob {
                id,
                user,
                partition: job["partition"].as_str().unwrap_or_default().to_owned(),
                cpus: slurm_number(&job["cpus"]),
                reason: job["state_reason"].as_str().unwrap_or_default().to_owned(),
                name: job["name"].as_str().unwrap_or_default().to_owned(),
            })
        })
        .collect()
}

fn split_section<'a>(text: &'a str, name: &str) -> Result<(&'a str, &'a str), String> {
    let marker = format!("{name}\n");
    if let Some(rest) = text.strip_prefix(&marker) {
        return Ok(("", rest));
    }
    text.split_once(&format!("\n{marker}"))
        .ok_or_else(|| "Slurm 查询返回不完整".into())
}

fn parse_gpu_types(gres: &str) -> Vec<SlurmGpuType> {
    let mut depth = 0u32;
    gres.split(|character| match character {
        '(' => {
            depth += 1;
            false
        }
        ')' => {
            depth = depth.saturating_sub(1);
            false
        }
        ',' => depth == 0,
        _ => false,
    })
    .filter_map(|resource| {
        let gpu = resource.split('(').next()?.strip_prefix("gpu:")?;
        let (name, count) = gpu.rsplit_once(':').unwrap_or(("GPU", gpu));
        Some(SlurmGpuType {
            name: name.to_owned(),
            count: count.parse().ok()?,
        })
    })
    .collect()
}

fn parse_job(line: &str) -> Result<SlurmJob, String> {
    let fields: Vec<_> = line
        .trim_start_matches(['\r', '\n'])
        .splitn(6, '|')
        .map(str::trim)
        .collect();
    let [id, user, partition, cpus, reason, name] = fields.as_slice() else {
        return Err("无法识别 Slurm 等待作业记录".into());
    };
    Ok(SlurmJob {
        id: (*id).into(),
        user: (*user).into(),
        partition: (*partition).into(),
        cpus: cpus.parse().ok(),
        reason: (*reason).into(),
        name: (*name).into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_shared_nodes_and_typed_gpus() {
        let text = "banner\n__RACKTOP_NODES__\ncompute|n1|n1|10.0.0.8|mixed|8/24/0/32|gpu:a100:2(S:0,1),gpu:h100:4,mps:100\ngpu|n1|n1|10.0.0.8|mixed|8/24/0/32|gpu:a100:2(S:0,1),gpu:h100:4,mps:100\ngpu|n1|n1|10.0.0.8|mixed|8/24/0/32|gpu:a100:2(S:0,1),gpu:h100:4,mps:100\n";
        let (partitions, nodes) = parse_nodes(text).unwrap();
        assert_eq!(partitions.len(), 2);
        assert_eq!(partitions[1].node_names.len(), 1);
        assert_eq!(nodes["n1"].cpu_allocated, Some(8));
        assert_eq!(
            nodes["n1"].gpu_types,
            vec![
                SlurmGpuType {
                    name: "a100".into(),
                    count: 2
                },
                SlurmGpuType {
                    name: "h100".into(),
                    count: 4
                },
            ]
        );
    }

    #[test]
    fn keeps_resolved_node_addresses_tied_to_their_advertised_hosts() {
        let text = "__RACKTOP_NODE_HOST__\nlogin\n__RACKTOP_NODE_ADDRESSES__\n192.0.2.10 worker1.example WORKER-PRIVATE. # alias\n2001:db8::1 worker1.example\n192.0.2.20 worker2.example\n__RACKTOP_NODES__\ncompute|worker1|worker1.example|worker-private|idle|0/8/0/8|(null)\ncompute|worker2|worker2.example|192.0.2.20|idle|0/8/0/8|(null)\n";
        let (_, nodes) = parse_nodes(text).unwrap();
        assert_eq!(
            nodes["worker1"].resolved_addresses,
            ["192.0.2.10", "2001:db8::1"]
                .map(|ip| ip.parse().unwrap())
                .into()
        );
        assert_eq!(
            nodes["worker2"].resolved_addresses,
            ["192.0.2.20".parse().unwrap()].into()
        );
    }

    #[test]
    fn reads_multiline_json_jobs_and_only_includes_pending_jobs() {
        let text = "__RACKTOP_USER__\nme\n__RACKTOP_JOBS_JSON__\n{\"errors\":[],\"jobs\":[{\"job_id\":134,\"array_job_id\":134,\"array_task_string\":\"1-3\",\"user_name\":\"me\",\"partition\":\"gpu\",\"cpus\":{\"set\":true,\"number\":4},\"job_state\":[\"PENDING\"],\"state_reason\":\"Priority\",\"name\":\"train|eval\\nnext line\"},{\"job_id\":135,\"user_name\":\"other\",\"job_state\":[\"RUNNING\"]}]}";
        let (username, jobs) = parse_jobs(text).unwrap();
        assert_eq!(username, "me");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, "134_[1-3]");
        assert_eq!(jobs[0].cpus, Some(4));
        assert_eq!(jobs[0].name, "train|eval\nnext line");
    }

    #[test]
    fn reads_multiline_legacy_jobs_with_record_terminators() {
        let text = "__RACKTOP_USER__\nme\n__RACKTOP_JOBS_TEXT__\n134|me|gpu|4|Priority|train|eval\nnext line\x1e\n135|other|gpu|8|Resources|other-job\x1e\n";
        let (_, jobs) = parse_jobs(text).unwrap();
        assert_eq!(jobs[0].name, "train|eval\nnext line");
        assert_eq!(jobs[1].user, "other");
    }

    #[test]
    fn distinguishes_empty_queue_from_incomplete_response() {
        let text = "__RACKTOP_USER__\nme\n__RACKTOP_JOBS_TEXT__\n";
        assert!(parse_jobs(text).unwrap().1.is_empty());
        assert!(parse_jobs(text.trim_end()).is_err());
        assert!(parse_jobs(&format!("{text}135|other|gpu|8|Resources|other-job")).is_err());
    }
}
