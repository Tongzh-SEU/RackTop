use crate::models::ServerDraft;
use std::path::{Path, PathBuf};

pub fn default_config_path() -> Result<PathBuf, String> {
    dirs::home_dir().map(|home| home.join(".ssh").join("config")).ok_or_else(|| "无法定位用户主目录".into())
}

pub fn import(path: &Path) -> Result<Vec<ServerDraft>, String> {
    let content = std::fs::read_to_string(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    Ok(parse(&content))
}

pub fn parse(content: &str) -> Vec<ServerDraft> {
    #[derive(Default)]
    struct HostBlock { aliases: Vec<String>, hostname: Option<String>, user: Option<String>, port: Option<u16>, identity_file: Option<String>, proxy_jump: Option<String> }
    fn finish(block: HostBlock, output: &mut Vec<ServerDraft>) {
        for alias in block.aliases.into_iter().filter(|value| !value.contains('*') && !value.contains('?') && !value.starts_with('!')) {
            let hostname = block.hostname.clone().unwrap_or_else(|| alias.clone());
            output.push(ServerDraft { id: None, name: alias.clone(), location: None, host: hostname, port: block.port.unwrap_or(22), username: block.user.clone().unwrap_or_else(default_username), ssh_alias: Some(alias), identity_file: block.identity_file.clone(), proxy_jump: block.proxy_jump.clone(), tags: Vec::new(), sampling_interval_seconds: 2, history_retention_days: 90, remote_history_enabled: false, auth_method: "sshConfig".into(), password: None, save_password: false });
        }
    }
    let mut output = Vec::new();
    let mut current: Option<HostBlock> = None;
    for raw_line in content.lines() {
        let tokens = config_tokens(raw_line);
        let Some(keyword) = tokens.first() else { continue; };
        let key = keyword.to_ascii_lowercase();
        let value = tokens[1..].join(" ");
        if key == "host" {
            if let Some(block) = current.take() { finish(block, &mut output); }
            current = Some(HostBlock { aliases: tokens[1..].to_vec(), ..Default::default() });
        } else if let Some(block) = current.as_mut() {
            match key.as_str() {
                "hostname" => block.hostname = Some(value),
                "user" => block.user = Some(value),
                "port" => block.port = value.parse().ok(),
                "identityfile" => block.identity_file = Some(value),
                "proxyjump" => block.proxy_jump = Some(value),
                _ => {}
            }
        }
    }
    if let Some(block) = current { finish(block, &mut output); }
    output
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
