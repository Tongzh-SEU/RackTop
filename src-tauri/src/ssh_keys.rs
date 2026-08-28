use crate::models::Server;
use std::path::{Path, PathBuf};

const MANAGED_KEY_FILENAME: &str = "racktop_ed25519";

pub fn expand_identity_path(value: &str) -> PathBuf {
    if value == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(value));
    }
    if let Some(relative) = value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(relative);
        }
    }
    PathBuf::from(value)
}

pub fn is_managed_identity_path(value: &str) -> bool {
    let normalized = value.trim().replace('\\', "/");
    let path = Path::new(&normalized);
    path.file_name().and_then(|name| name.to_str()) == Some(MANAGED_KEY_FILENAME)
        && path.parent().and_then(Path::file_name).and_then(|name| name.to_str()) == Some(".ssh")
}

pub fn managed_public_key(server: &Server) -> Result<Option<String>, String> {
    let Some(identity) = server.identity_file.as_deref().filter(|value| is_managed_identity_path(value)) else {
        return Ok(None);
    };
    let mut public_path = expand_identity_path(identity).into_os_string();
    public_path.push(".pub");
    let public_path = PathBuf::from(public_path);
    let line = std::fs::read_to_string(&public_path)
        .map_err(|error| format!("无法读取 RackTop 专用公钥 {}：{error}", public_path.display()))?;
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 2 || !is_public_key_algorithm(fields[0]) || fields[1].is_empty() {
        return Err(format!("RackTop 专用公钥 {} 格式无效", public_path.display()));
    }
    Ok(Some(format!("{} {}", fields[0], fields[1])))
}

fn is_public_key_algorithm(value: &str) -> bool {
    value.starts_with("ssh-") || value.starts_with("ecdsa-") || value.starts_with("sk-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_the_racktop_key_inside_ssh_directory() {
        assert!(is_managed_identity_path("~/.ssh/racktop_ed25519"));
        assert!(is_managed_identity_path("C:\\Users\\alice\\.ssh\\racktop_ed25519"));
        assert!(!is_managed_identity_path("~/.ssh/id_ed25519"));
        assert!(!is_managed_identity_path("~/racktop_ed25519"));
    }
}
