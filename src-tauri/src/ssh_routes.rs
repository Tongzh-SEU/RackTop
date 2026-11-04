use crate::models::{Server, ServerDraft, SshHop};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

const MAX_HOPS: usize = 16;

pub fn resolve(draft: &ServerDraft, drafts: &[ServerDraft]) -> Result<Vec<SshHop>, String> {
    fn visit(draft: &ServerDraft, drafts: &[ServerDraft], seen: &mut Vec<String>, hops: &mut Vec<SshHop>) -> Result<(), String> {
        if !draft.ssh_hops.is_empty() { hops.extend(draft.ssh_hops.clone()); return Ok(()); }
        let specs: Vec<_> = draft.proxy_jump.as_deref().unwrap_or("").split(',').map(str::trim).filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("none")).collect();
        // An explicit comma list is the complete route. Only a single alias
        // inherits that alias's own ProxyJump chain.
        let inherit_route = specs.len() == 1;
        for spec in specs {
            if seen.len() > MAX_HOPS || hops.len() >= MAX_HOPS { return Err("跳板机链超过 16 层".into()); }
            let (user, endpoint) = spec.rsplit_once('@').map(|(u,h)| (Some(u),h)).unwrap_or((None,spec));
            let (name, port) = if let Some(rest) = endpoint.strip_prefix('[') {
                let (host, tail) = rest.split_once(']').ok_or("跳板机 IPv6 地址格式无效")?;
                let port = if tail.is_empty() { None } else { Some(tail.strip_prefix(':').ok_or("跳板机端口格式无效")?.parse::<u16>().map_err(|_| "跳板机端口无效")?) };
                (host, port)
            } else if let Some((host, port)) = endpoint.rsplit_once(':') {
                (host, Some(port.parse::<u16>().map_err(|_| "跳板机端口无效")?))
            } else { (endpoint, None) };
            if name.is_empty() || port == Some(0) { return Err("跳板机地址或端口无效".into()); }
            let candidates: Vec<_> = drafts.iter().filter(|d| d.ssh_alias.as_deref() == Some(name) || d.name == name || (d.host == name && port.is_none_or(|p| d.port == p) && user.is_none_or(|u| d.username == u))).collect();
            // IP literals and qualified hostnames are concrete endpoints, even
            // without a matching Host record. Bare unresolved aliases still
            // require their configuration so credentials are not silently lost.
            let concrete = name.parse::<std::net::IpAddr>().is_ok() || name.contains('.')
                || (user.is_some() && port.is_some());
            if candidates.is_empty() && concrete {
                hops.push(SshHop { host: name.into(), port: port.unwrap_or(22), username: user.unwrap_or(&draft.username).into(), auth_method: "sshAgent".into(), identity_file: None, credential_id: None });
                continue;
            }
            if candidates.len() != 1 { return Err(format!("跳板机 {name} 的连接配置缺失或不唯一")); }
            let source = candidates[0];
            let id = format!("{}@{}:{}", source.username, source.host, source.port);
            if seen.contains(&id) { return Err("跳板机依赖存在循环".into()); }
            seen.push(id);
            if inherit_route { visit(source, drafts, seen, hops)?; }
            seen.pop();
            hops.push(SshHop { host: source.host.clone(), port: port.unwrap_or(source.port), username: user.unwrap_or(&source.username).into(), auth_method: source.auth_method.clone(), identity_file: source.identity_file.clone(), credential_id: source.id.clone() });
        }
        Ok(())
    }
    let mut hops = Vec::new();
    let mut seen = vec![format!("{}@{}:{}", draft.username, draft.host, draft.port)];
    visit(draft, drafts, &mut seen, &mut hops)?;
    if hops.len() > MAX_HOPS { return Err("跳板机链超过 16 层".into()); }
    validate(&hops)?;
    Ok(hops)
}

fn safe_host(host: &str) -> bool {
    !host.is_empty() && !host.starts_with('-') && host.bytes().all(|c| c.is_ascii_alphanumeric() || b".:-_[]".contains(&c))
}

pub fn validate(hops: &[SshHop]) -> Result<(), String> {
    if hops.len() > MAX_HOPS { return Err("跳板机链超过 16 层".into()); }
    for hop in hops {
        if !safe_host(&hop.host) || hop.username.is_empty() || hop.username.chars().any(|c| c.is_whitespace() || c.is_control()) || hop.port == 0 { return Err("跳板机连接参数无效".into()); }
        if !matches!(hop.auth_method.as_str(), "sshAgent" | "privateKey" | "sshConfig" | "password") { return Err("跳板机认证方式无效".into()); }
    }
    Ok(())
}

pub fn concrete_chain(hops: &[SshHop]) -> Option<String> {
    if hops.is_empty() { return None; }
    Some(hops.iter().map(|h| format!("{}@{}:{}", h.username, if h.host.contains(':') { format!("[{}]", h.host.trim_matches(['[', ']'])) } else { h.host.clone() }, h.port)).collect::<Vec<_>>().join(","))
}

pub fn proxy_option(hops: &[SshHop], target_host: &str) -> Result<Option<String>, String> {
    if hops.is_empty() { return Ok(None); }
    validate(hops)?;
    if !safe_host(target_host) { return Err("跳转目标地址包含不支持的字符".into()); }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let executable = executable.to_str().ok_or("应用路径不是 UTF-8")?;
    #[cfg(unix)]
    let quoted = format!("'{}'", executable.replace('%', "%%").replace('\'', "'\\''"));
    #[cfg(windows)]
    let quoted = format!("\"{}\"", executable.replace('"', ""));
    let data = URL_SAFE_NO_PAD.encode(serde_json::to_vec(hops).map_err(|e| e.to_string())?);
    Ok(Some(format!("ProxyCommand={quoted} --racktop-proxy {data} %h %p")))
}

// Runs before the GUI/ASKPASS branch. Each hop gets its own credential,
// preventing the destination's password from being offered to a jump host.
pub fn run_proxy(data: &str, host: &str, port: &str) -> Result<i32, String> {
    if data.len() > 128 * 1024 { return Err("跳板机参数过长".into()); }
    let mut hops: Vec<SshHop> = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(data).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    validate(&hops)?;
    let hop = hops.pop().ok_or("缺少跳板机")?;
    let password = if hop.auth_method == "password" {
        Some(keyring::Entry::new("com.racktop.desktop", hop.credential_id.as_deref().ok_or("跳板机缺少凭据")?).map_err(|e| e.to_string())?.get_password().map_err(|e| format!("无法读取跳板机密码：{e}"))?)
    } else { None };
    let server = Server { id: String::new(), name: "jump".into(), location: None, host: hop.host, port: hop.port, username: hop.username, ssh_alias: None, identity_file: hop.identity_file, proxy_jump: None, ssh_hops: hops, tags: Vec::new(), sampling_interval_seconds: 2, history_retention_days: 90, remote_history_enabled: false, remote_history_last_sync_at: None, sort_order: 0, auth_method: hop.auth_method, status: "unknown".into(), last_error: None, last_seen_at: None };
    let port: u16 = port.parse().map_err(|_| "转发端口无效")?;
    if port == 0 || host.is_empty() || host.chars().any(|c| c.is_whitespace() || c.is_control()) { return Err("转发目标无效".into()); }
    let (mut command, target) = crate::collector::configured_ssh_command(&server, password.as_deref())?;
    if password.is_none() { command.env_remove("RACKTOP_ASKPASS_PASSWORD"); }
    command.args(["-W", &format!("[{}]:{port}", host.trim_matches(['[', ']'])), &target]);
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; Err(command.as_std_mut().exec().to_string()) }
    #[cfg(windows)]
    { let status = command.as_std_mut().status().map_err(|e| e.to_string())?; Ok(status.code().unwrap_or(1)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn draft(name: &str, proxy: Option<&str>) -> ServerDraft {
        ServerDraft { id: Some(name.into()), name: name.into(), location: None, host: format!("{name}.example"), port: 2222, username: name.into(), ssh_alias: Some(name.into()), identity_file: Some(format!("/{name}.key")), proxy_jump: proxy.map(str::to_owned), ssh_hops: Vec::new(), tags: Vec::new(), sampling_interval_seconds: 2, history_retention_days: 90, remote_history_enabled: false, auth_method: "privateKey".into(), password: None, save_password: false }
    }
    #[test]
    fn concrete_endpoints_need_no_host_record() {
        let target = draft("target", Some("jump-user@192.0.2.1:2201,other@[2001:db8::1]:2202"));
        let hops = resolve(&target, &[]).unwrap();
        assert_eq!(hops.len(), 2);
        assert_eq!(hops[0].host, "192.0.2.1");
        assert_eq!(hops[0].username, "jump-user");
        assert_eq!(hops[1].host, "2001:db8::1");
        assert!(hops.iter().all(|h| h.auth_method == "sshAgent" && h.credential_id.is_none() && h.identity_file.is_none()));
        assert!(resolve(&draft("target", Some("missing-alias")), &[]).is_err());
    }
    #[test]
    fn concrete_endpoints_default_to_target_user_and_standard_port() {
        for (spec, host, username, port) in [
            ("[2001:db8::1]:2202", "2001:db8::1", "target", 2202),
            ("[2001:db8::1]", "2001:db8::1", "target", 22),
            ("jump.example", "jump.example", "target", 22),
            ("jump.example:2202", "jump.example", "target", 2202),
            ("other@jump.example", "jump.example", "other", 22),
            ("192.0.2.1", "192.0.2.1", "target", 22),
        ] {
            let hops = resolve(&draft("target", Some(spec)), &[]).unwrap();
            assert_eq!(hops.len(), 1, "{spec}");
            assert_eq!((&*hops[0].host, &*hops[0].username, hops[0].port), (host, username, port));
            assert_eq!(hops[0].auth_method, "sshAgent");
        }
    }
    #[test]
    fn explicit_list_overrides_nested_jump_routes() {
        let inner = draft("inner", None);
        let outer = draft("outer", Some("inner"));
        let target = draft("target", Some("outer,inner"));
        let hops = resolve(&target, &[inner, outer]).unwrap();
        assert_eq!(hops.iter().map(|h| h.host.as_str()).collect::<Vec<_>>(), vec!["outer.example", "inner.example"]);
    }
    #[test]
    fn permits_sixteen_hops_and_rejects_seventeen() {
        for count in [16, 17] {
            let sources: Vec<_> = (0..count).map(|i| {
                let mut hop = draft(&format!("hop{i}"), None);
                hop.proxy_jump = (i > 0).then(|| format!("hop{}", i - 1));
                hop
            }).collect();
            let target = draft("target", Some(&format!("hop{}", count - 1)));
            let result = resolve(&target, &sources);
            if count == 16 { assert_eq!(result.unwrap().len(), 16); } else { assert!(result.is_err()); }
            let list = (0..count).map(|i| format!("hop{i}")).collect::<Vec<_>>().join(",");
            let result = resolve(&draft("target", Some(&list)), &sources);
            if count == 16 { assert_eq!(result.unwrap().len(), 16); } else { assert!(result.is_err()); }
        }
    }
    #[test]
    fn resolves_nested_and_explicit_chains_with_overrides() {
        let a = draft("outer", None);
        let b = draft("inner", Some("outer"));
        let target = draft("target", Some("override@inner:2200"));
        let hops = resolve(&target, &[a.clone(), b.clone(), target.clone()]).unwrap();
        assert_eq!(hops.len(), 2);
        assert_eq!(hops[0].host, "outer.example");
        assert_eq!(hops[0].identity_file.as_deref(), Some("/outer.key"));
        assert_eq!(hops[1].username, "override");
        assert_eq!(hops[1].port, 2200);
        let explicit = draft("target", Some("outer,inner"));
        assert_eq!(resolve(&explicit, &[a, b, explicit.clone()]).unwrap().len(), 2);
    }
    #[test]
    fn rejects_cycles_missing_dependencies_and_shell_metacharacters() {
        let a = draft("a", Some("b")); let b = draft("b", Some("a"));
        assert!(resolve(&a, &[a.clone(), b]).is_err());
        assert!(resolve(&a, &[a.clone()]).is_err());
        let mut hop = resolve(&draft("target", Some("a")), &[draft("a", None)]).unwrap();
        assert!(proxy_option(&hop, "host;touch /tmp/no").is_err());
        hop[0].host = "bad'host".into();
        assert!(proxy_option(&hop, "target.example").is_err());
    }
    #[test]
    fn generated_proxy_contains_only_connection_metadata() {
        let hops = resolve(&draft("target", Some("jump")), &[draft("jump", None)]).unwrap();
        let option = proxy_option(&hops, "target.example").unwrap().unwrap();
        assert!(option.contains("--racktop-proxy"));
        assert!(option.ends_with(" %h %p"));
        assert!(!option.contains("PRIVATE KEY"));
        assert!(!option.contains("password"));
    }
}
