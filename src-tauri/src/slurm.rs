use crate::{collector, models::Server};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use tokio::time::Duration;

const SCRIPT: &str = r#"set -eu
export LC_ALL=C
for tool in sinfo squeue; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '%s\n' "SSH 登录节点找不到 Slurm 命令：$tool" >&2
    exit 1
  fi
done
printf '%s\n' '__RACKTOP_USER__'
id -un
printf '%s\n' '__RACKTOP_NODES__'
sinfo --local --Node --noheader --format='%R|%N|%n|%o|%T|%C|%G'
printf '%s\n' '__RACKTOP_JOBS__'
squeue --local --noheader --states=PENDING --format='%i|%u|%P|%C|%r|%j'
"#;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlurmOverview {
    username: String,
    partitions: Vec<SlurmPartition>,
    nodes: BTreeMap<String, SlurmNode>,
    jobs: Vec<SlurmJob>,
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
    cpus: u64,
    reason: String,
    name: String,
}

pub async fn collect(server: &Server, password: Option<&str>) -> Result<SlurmOverview, String> {
    let (command, target) = collector::configured_ssh_command(server, password)?;
    let output = collector::run_ssh_script(
        command,
        &target,
        SCRIPT,
        Duration::from_secs(20),
        "Slurm 查询超时（20 秒）",
    )
    .await?;
    parse(&String::from_utf8_lossy(&output.stdout))
}

fn parse(text: &str) -> Result<SlurmOverview, String> {
    let (_, text) = split_section(text, "__RACKTOP_USER__")?;
    let (username, rest) = split_section(text, "__RACKTOP_NODES__")?;
    let (node_lines, job_lines) = split_section(rest, "__RACKTOP_JOBS__")?;
    let username = username.trim();
    if username.is_empty() || username.contains(char::is_whitespace) {
        return Err("无法识别 Slurm 查询使用的 SSH 账号".into());
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
    let jobs = job_lines
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_job)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SlurmOverview {
        username: username.into(),
        partitions,
        nodes,
        jobs,
    })
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
    let fields: Vec<_> = line.splitn(6, '|').map(str::trim).collect();
    let [id, user, partition, cpus, reason, name] = fields.as_slice() else {
        return Err("无法识别 Slurm 等待作业记录".into());
    };
    Ok(SlurmJob {
        id: (*id).into(),
        user: (*user).into(),
        partition: (*partition).into(),
        cpus: cpus.parse().map_err(|_| "无法识别 Slurm 作业 CPU 数量")?,
        reason: (*reason).into(),
        name: (*name).into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_shared_nodes_typed_gpus_and_pending_job_arrays() {
        let text = "banner\n__RACKTOP_USER__\nme\n__RACKTOP_NODES__\ncompute|n1|n1|10.0.0.8|mixed|8/24/0/32|gpu:a100:2(S:0,1),gpu:h100:4,mps:100\ngpu|n1|n1|10.0.0.8|mixed|8/24/0/32|gpu:a100:2(S:0,1),gpu:h100:4,mps:100\ngpu|n1|n1|10.0.0.8|mixed|8/24/0/32|gpu:a100:2(S:0,1),gpu:h100:4,mps:100\n__RACKTOP_JOBS__\n134_[1-3]|me|gpu|4|Priority|train|eval\n135|other|gpu|8|Resources|other-job\n";
        let overview = parse(text).unwrap();
        assert_eq!(overview.partitions.len(), 2);
        assert_eq!(overview.partitions[1].node_names.len(), 1);
        assert_eq!(overview.nodes["n1"].cpu_allocated, Some(8));
        assert_eq!(
            overview.nodes["n1"].gpu_types,
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
        assert_eq!(overview.jobs[0].name, "train|eval");
        assert_eq!(overview.jobs[1].user, "other");
    }

    #[test]
    fn distinguishes_empty_queue_from_incomplete_response() {
        let text = "__RACKTOP_USER__\nme\n__RACKTOP_NODES__\n__RACKTOP_JOBS__\n";
        assert!(parse(text).unwrap().jobs.is_empty());
        assert!(parse(text.trim_end()).is_err());
    }
}
