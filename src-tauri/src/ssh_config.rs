use crate::models::ServerDraft;
use std::path::{Path, PathBuf};

pub fn default_config_path() -> Result<PathBuf, String> {
    dirs::home_dir().map(|home| home.join(".ssh").join("config")).ok_or_else(|| "无法定位用户主目录".into())
}

pub fn import(path: &Path) -> Result<Vec<ServerDraft>, String> {
    let content = std::fs::read_to_string(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    Ok(parse(&content))
}

// First value wins, in file order, across all matching Host blocks.
// Wildcard blocks contribute defaults but do not create server entries.
pub fn parse(content: &str) -> Vec<ServerDraft> {
    let mut blocks: Vec<(Vec<String>, Vec<(String, String)>)> = vec![(vec!["*".into()], Vec::new())];
    let mut aliases = Vec::new();
    for line in content.lines() {
        let tokens = config_tokens(line);
        let Some(keyword) = tokens.first() else { continue };
        let key = keyword.to_ascii_lowercase();
        if key == "host" {
            for alias in &tokens[1..] {
                if !alias.contains(['*', '?']) && !alias.starts_with('!') && !aliases.contains(alias) { aliases.push(alias.clone()); }
            }
            blocks.push((tokens[1..].to_vec(), Vec::new()));
        } else {
            blocks.last_mut().unwrap().1.push((key, tokens[1..].join(" ")));
        }
    }
    aliases.into_iter().map(|alias| {
        let mut values = std::collections::HashMap::new();
        for (patterns, options) in &blocks {
            let matches = patterns.iter().any(|p| !p.starts_with('!') && host_matches(p, &alias))
                && !patterns.iter().any(|p| p.strip_prefix('!').is_some_and(|p| host_matches(p, &alias)));
            if matches { for (key, value) in options { values.entry(key.as_str()).or_insert(value.clone()); } }
        }
        ServerDraft { id: None, name: alias.clone(), location: None,
            host: values.get("hostname").cloned().unwrap_or_else(|| alias.clone()),
            port: values.get("port").and_then(|p| p.parse().ok()).unwrap_or(22),
            username: values.get("user").cloned().unwrap_or_else(default_username),
            ssh_alias: Some(alias), identity_file: values.get("identityfile").cloned(),
            proxy_jump: values.get("proxyjump").filter(|p| !p.eq_ignore_ascii_case("none")).cloned(), ssh_hops: Vec::new(),
            tags: Vec::new(), sampling_interval_seconds: 2, history_retention_days: 90,
            remote_history_enabled: false, auth_method: "sshConfig".into(), password: None, save_password: false }
    }).collect()
}

fn host_matches(pattern: &str, host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let mut previous = vec![false; host.len() + 1]; previous[0] = true;
    for p in pattern.to_ascii_lowercase().bytes() {
        let mut next = vec![false; host.len() + 1];
        if p == b'*' { next[0] = previous[0]; }
        for (i, h) in host.bytes().enumerate() {
            next[i + 1] = if p == b'*' { previous[i + 1] || next[i] }
                else { previous[i] && (p == b'?' || p == h) };
        }
        previous = next;
    }
    previous[host.len()]
}

pub fn validate_transfer_draft(draft: &ServerDraft) -> Result<(), String> {
    crate::ssh_routes::validate(&draft.ssh_hops)?;
    if draft.ssh_hops.is_empty() && draft.proxy_jump.as_deref().is_some_and(|p| !p.trim().is_empty() && !p.eq_ignore_ascii_case("none")) {
        return Err(format!("{} 使用 ProxyJump：跳板机连接及认证配置无法完整迁移，请在目标电脑重新配置后手动添加", draft.name));
    }
    Ok(())
}

pub fn parse_transfer(content: &str) -> Result<Vec<ServerDraft>, String> {
    for line in content.lines() {
        let tokens = config_tokens(line);
        let Some(key) = tokens.first() else { continue };
        match key.to_ascii_lowercase().as_str() {
            "host" | "hostname" | "user" | "port" | "identityfile" | "proxyjump"
            | "serveraliveinterval" | "serveralivecountmax" | "tcpkeepalive" => {},
            _ => return Err(format!("SSH Config 暂不支持迁移指令 {key}，请展开为 Host、HostName、User、Port 等具体配置后重试")),
        }
        if tokens.len() < 2 { return Err(format!("SSH Config 指令 {key} 缺少参数")); }
        if key.eq_ignore_ascii_case("port") && tokens[1].parse::<u16>().ok().is_none_or(|p| p == 0) {
            return Err("SSH Config 端口无效".into());
        }
        if tokens[1..].iter().any(|v| v.contains('%') || v.contains("${")) {
            return Err("SSH Config 暂不支持迁移变量，请改为具体连接参数".into());
        }
    }
    let mut drafts = parse(content);
    let source = drafts.clone();
    for draft in &mut drafts {
        if let Ok(mut hops) = crate::ssh_routes::resolve(draft, &source) {
            // Plaintext SSH Config carries no key material; use target Agent.
            for hop in &mut hops { hop.auth_method = "sshAgent".into(); hop.identity_file = None; hop.credential_id = None; }
            if !hops.is_empty() { draft.proxy_jump = crate::ssh_routes::concrete_chain(&hops); }
            draft.ssh_hops = hops;
        }
    }
    Ok(drafts)
}

fn config_tokens(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => quoted = !quoted,
            '#' if !quoted => break,
            '\\' if quoted && matches!(chars.peek(), Some('"' | '\\')) => {
                token.push(chars.next().unwrap());
            }
            ch if ch.is_whitespace() && !quoted => {
                if !token.is_empty() { tokens.push(std::mem::take(&mut token)); }
            }
            _ => token.push(ch),
        }
    }
    if !token.is_empty() { tokens.push(token); }
    tokens
}

fn default_username() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "root".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concrete_proxyjump_is_selectable_without_a_host_block() {
        let drafts = parse_transfer("Host target\n HostName 192.0.2.10\n ProxyJump jump-user@192.0.2.1:2201\n").unwrap();
        assert_eq!(drafts.len(), 1);
        assert!(validate_transfer_draft(&drafts[0]).is_ok());
        assert_eq!(drafts[0].ssh_hops[0].host, "192.0.2.1");
        assert_eq!(drafts[0].ssh_hops[0].username, "jump-user");
        assert_eq!(drafts[0].ssh_hops[0].port, 2201);
    }

    #[test]
    fn common_options_follow_openssh_first_value_and_pattern_rules() {
        let values = parse_transfer("User global\nHost gpu-a gpu-b\n HostName 192.0.2.10\n Port 2222\n Port 3333\nHost gpu-? !gpu-b\n Port 4444\nHost *\n User ignored\n Port 5555\n").unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0].username, "global");
        assert_eq!(values[0].port, 2222);
        assert_eq!(values[1].port, 2222);
        let values = parse_transfer("Host gpu-a\n HostName 192.0.2.10\nHost gpu-b\n HostName 192.0.2.11\nHost gpu-? !gpu-b\n User alice\nHost *\n User bob\n Port 2222\n").unwrap();
        assert_eq!(values[0].username, "alice");
        assert_eq!(values[1].username, "bob");
        assert_eq!(values[1].port, 2222);
    }

    #[test]
    fn transfer_rejects_unportable_dependencies_and_unsupported_syntax() {
        let config = "Host gpu-review\n HostName 192.0.2.10\nHost *\n User remote-review\n Port 2222\n ProxyJump jump-review\n";
        let values = parse(config);
        assert_eq!(values[0].username, "remote-review");
        assert_eq!(values[0].port, 2222);
        assert_eq!(values[0].proxy_jump.as_deref(), Some("jump-review"));
        let preview = parse_transfer(config).unwrap();
        assert!(validate_transfer_draft(&preview[0]).unwrap_err().contains("ProxyJump"));
        for directive in ["Include other", "Match all", "ProxyCommand ssh jump", "HostName %h.example", "Port invalid"] {
            assert!(parse_transfer(&format!("Host gpu\n {directive}\n")).is_err(), "{directive}");
        }
    }

    #[test]
    fn mixed_ssh_config_preserves_direct_hosts_in_preview() {
        let drafts = parse_transfer("Host direct\n HostName 192.0.2.10\nHost via-jump\n HostName 192.0.2.11\n ProxyJump jump-review\nHost *\n User reviewer\n Port 2222\n").unwrap();
        assert_eq!(drafts.len(), 2);
        assert!(validate_transfer_draft(&drafts[0]).is_ok());
        assert!(validate_transfer_draft(&drafts[1]).is_err());
        assert_eq!(drafts[0].username, "reviewer");
        assert_eq!(drafts[0].port, 2222);
    }

    #[test]
    fn plaintext_config_resolves_multihop_routes_without_copying_source_keys() {
        let drafts = parse_transfer("Host outer\n HostName 192.0.2.1\n User alice\n Port 2201\n IdentityFile /source/secret\nHost inner\n HostName 192.0.2.2\n User bob\n Port 2202\n ProxyJump outer\nHost target\n HostName 192.0.2.3\n User carol\n ProxyJump inner\n").unwrap();
        assert_eq!(drafts[2].ssh_hops.len(), 2);
        assert_eq!(drafts[2].ssh_hops[0].host, "192.0.2.1");
        assert_eq!(drafts[2].ssh_hops[1].port, 2202);
        assert!(drafts[2].ssh_hops.iter().all(|h| h.auth_method == "sshAgent" && h.identity_file.is_none() && h.credential_id.is_none()));
        assert!(validate_transfer_draft(&drafts[2]).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn common_parameters_match_system_ssh_without_network_access() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config");
        let config = "Host gpu-review\n HostName 192.0.2.10\nHost *\n User remote-review\n Port 2222\n";
        std::fs::write(&path, config).unwrap();
        let output = std::process::Command::new("ssh").args(["-G", "-F"]).arg(&path).arg("gpu-review").output().unwrap();
        assert!(output.status.success());
        let output = String::from_utf8(output.stdout).unwrap();
        let values = parse_transfer(config).unwrap();
        assert!(output.lines().any(|l| l == format!("hostname {}", values[0].host)));
        assert!(output.lines().any(|l| l == format!("user {}", values[0].username)));
        assert!(output.lines().any(|l| l == format!("port {}", values[0].port)));
    }

    #[test]
    fn parses_hosts_and_skips_wildcards() {
        let values = parse("Host *\n  ServerAliveInterval 30\nHost gpu-a\n HostName 10.0.0.1\n User alice\n Port 2222\n IdentityFile ~/.ssh/id_ed25519\n ProxyJump bastion\nHost gpu-*\n HostName ignored\n");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].host, "10.0.0.1");
        assert_eq!(values[0].port, 2222);
        assert_eq!(values[0].proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(values[0].history_retention_days, 90);
    }

    #[test]
    fn quoted_identity_paths_keep_spaces_and_hashes_without_quote_characters() {
        let values = parse("Host quoted-key\n HostName 127.0.0.2\n User fixture\n IdentityFile \"/tmp/RackTop Keys/test#1.key\" # local key\n");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].identity_file.as_deref(), Some("/tmp/RackTop Keys/test#1.key"));
        assert_eq!(values[0].host, "127.0.0.2");
    }
}
