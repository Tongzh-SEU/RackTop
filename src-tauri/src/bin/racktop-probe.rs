use racktop_lib::{collector, models::{Server, Snapshot}};

#[tokio::main]
async fn main() {
    let targets: Vec<String> = std::env::args().skip(1).collect();
    let targets = if targets.is_empty() {
        vec!["tongzh@10.201.37.233".into(), "tongzh@10.201.127.132".into()]
    } else {
        targets
    };
    let mut tasks = tokio::task::JoinSet::new();
    for (index, target) in targets.into_iter().enumerate() {
        let (username, host) = target.split_once('@').unwrap_or(("tongzh", target.as_str()));
        let server = Server {
            id: format!("probe-{index}"), name: target.clone(), location: None, host: host.into(), port: 22, username: username.into(),
            ssh_alias: None, identity_file: None, proxy_jump: None, tags: vec!["integration-test".into()],
            sampling_interval_seconds: 2, history_retention_days: 1, remote_history_enabled: false, remote_history_last_sync_at: None, sort_order: index as i64, auth_method: "sshAgent".into(),
            status: "unknown".into(), last_error: None, last_seen_at: None,
        };
        tasks.spawn(async move { (target, collector::collect(&server).await) });
    }
    let mut snapshots: Vec<Snapshot> = Vec::new();
    let mut failures = Vec::new();
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok((_target, Ok(snapshot))) => snapshots.push(snapshot),
            Ok((target, Err(error))) => failures.push(format!("{target}: {error}")),
            Err(error) => failures.push(format!("采集任务异常：{error}")),
        }
    }
    snapshots.sort_by(|left, right| left.server_id.cmp(&right.server_id));
    println!("{}", serde_json::to_string_pretty(&snapshots).expect("serialize snapshots"));
    if !failures.is_empty() {
        eprintln!("{}", failures.join("\n"));
        std::process::exit(1);
    }
}
