use crate::{
    models::{Server, ServerDraft},
    ssh_keys::expand_identity_path,
    storage::Database,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ring::{
    aead::{self, Aad, LessSafeKey, Nonce, UnboundKey},
    pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};
use uuid::Uuid;

const FORMAT: &str = "racktop-server-config";
const FORMAT_VERSION: u32 = 1;
const PBKDF2_ITERATIONS: u32 = 600_000;
const MAX_PACKAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_KEY_BYTES: usize = 1024 * 1024;
const MAX_SERVERS: usize = 500;
const PACKAGE_AAD: &[u8] = b"racktop-server-config/v1";
const MAX_PENDING_AGE_SECS: u64 = 30 * 60;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncryptedPackage {
    format: String,
    version: u32,
    iterations: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackagePayload {
    kind: String,
    #[serde(default)]
    ssh_config: Option<String>,
    servers: Vec<PackageServer>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageServer {
    draft: ServerDraft,
    private_key: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferServerPreview {
    pub draft: ServerDraft,
    pub includes_private_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPreview {
    pub import_id: String,
    pub servers: Vec<TransferServerPreview>,
    pub private_key_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedPackage {
    pub package: String,
    pub server_count: usize,
    pub private_key_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedExport {
    pub path: String,
    pub server_count: usize,
    pub private_key_count: usize,
}

pub fn save_export(path: &Path, exported: ExportedPackage) -> Result<SavedExport, String> {
    let temporary = path.with_file_name(format!(".racktop-export-{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary).map_err(|error| format!("无法创建配置包：{error}"))?;
        file.write_all(exported.package.as_bytes()).and_then(|()| file.sync_all())
            .map_err(|error| format!("无法写入配置包：{error}"))?;
        fs::rename(&temporary, path).map_err(|error| format!("无法保存配置包：{error}"))?;
        Ok(SavedExport { path: path.to_string_lossy().into_owned(), server_count: exported.server_count, private_key_count: exported.private_key_count })
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub imported_count: usize,
    pub private_keys_installed: usize,
}

struct PendingImport {
    payload: PackagePayload,
    created_at: Instant,
}

#[derive(Default)]
pub struct ConfigTransferState {
    pending: Mutex<HashMap<String, PendingImport>>,
}

impl ConfigTransferState {
    pub fn prepare_import(&self, package: &str, passphrase: &str) -> Result<TransferPreview, String> {
        validate_passphrase(passphrase)?;
        if package.len() > MAX_PACKAGE_BYTES {
            return Err("配置包超过 32 MB，无法导入".into());
        }
        let payload = decrypt_package(package, passphrase)?;
        validate_payload(&payload)?;
        let import_id = Uuid::new_v4().to_string();
        let servers = payload
            .servers
            .iter()
            .map(|item| {
                let mut draft = item.draft.clone();
                draft.id = None;
                draft.identity_file = None;
                draft.password = None;
                draft.save_password = false;
                TransferServerPreview {
                    draft,
                    includes_private_key: item.private_key.is_some(),
                }
            })
            .collect::<Vec<_>>();
        let private_key_count = payload
            .servers
            .iter()
            .filter(|item| item.private_key.is_some())
            .count();

        let mut pending = self.pending.lock().map_err(|error| error.to_string())?;
        pending.retain(|_, item| item.created_at.elapsed().as_secs() < MAX_PENDING_AGE_SECS);
        if pending.len() >= 16 {
            return Err("待确认的导入任务过多，请关闭未完成的导入窗口后重试".into());
        }
        pending.insert(
            import_id.clone(),
            PendingImport {
                payload,
                created_at: Instant::now(),
            },
        );

        Ok(TransferPreview {
            import_id,
            servers,
            private_key_count,
        })
    }

    pub fn discard_import(&self, import_id: &str) -> Result<(), String> {
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .remove(import_id);
        Ok(())
    }

    pub fn commit_import(
        &self,
        import_id: &str,
        selected_indexes: &[usize],
        database: &Database,
        app_data_dir: &Path,
    ) -> Result<TransferResult, String> {
        let payload = {
            let pending = self.pending.lock().map_err(|error| error.to_string())?;
            let item = pending
                .get(import_id)
                .ok_or_else(|| "导入预览已失效，请重新选择配置包".to_string())?;
            if item.created_at.elapsed().as_secs() >= MAX_PENDING_AGE_SECS {
                return Err("导入预览已过期，请重新选择配置包".into());
            }
            item.payload.clone()
        };

        if selected_indexes.is_empty() {
            return Err("至少选择一台服务器".into());
        }
        let mut indexes = selected_indexes.to_vec();
        indexes.sort_unstable();
        indexes.dedup();
        if indexes.iter().any(|index| *index >= payload.servers.len()) {
            return Err("导入选择无效，请重新预览配置包".into());
        }

        let current_servers = database.list_servers()?;
        for index in &indexes {
            let candidate = &payload.servers[*index].draft;
            if let Some(existing) = current_servers.iter().find(|server| same_connection(server, candidate)) {
                return Err(format!(
                    "目标应用已存在 {}（{}@{}:{}），请取消选择后重试",
                    existing.name,
                    candidate.username.trim(),
                    candidate.host.trim(),
                    candidate.port
                ));
            }
        }

        let mut imported_count = 0;
        let mut private_keys_installed = 0;
        for index in indexes {
            let item = &payload.servers[index];
            let mut draft = item.draft.clone();
            draft.id = None;
            // Aliases refer to the source device's ~/.ssh/config. Use the
            // concrete connection stored in the package on the target device.
            draft.ssh_alias = None;
            draft.identity_file = None;
            draft.save_password = draft.auth_method == "password" && draft.password.is_some();

            let key_path = if let Some(encoded_key) = &item.private_key {
                let key_bytes = STANDARD
                    .decode(encoded_key)
                    .map_err(|_| "配置包中的私钥数据无效".to_string())?;
                Some(write_private_key(app_data_dir, &key_bytes)?)
            } else {
                None
            };
            if let Some(path) = &key_path {
                draft.identity_file = Some(path.to_string_lossy().into_owned());
            }

            if let Err(error) = database.save_server(draft) {
                if let Some(path) = key_path {
                    // If compensating cleanup itself failed, do not break the
                    // surviving row by removing its credential file.
                    if database.list_servers().is_ok_and(|servers| !servers.iter().any(|server| server.identity_file.as_deref() == path.to_str())) {
                        let _ = fs::remove_file(path);
                    }
                }
                return Err(format!("导入服务器失败：{error}；此前已导入 {imported_count} 台"));
            }
            imported_count += 1;
            if key_path.is_some() {
                private_keys_installed += 1;
            }
        }

        self.discard_import(import_id)?;
        Ok(TransferResult {
            imported_count,
            private_keys_installed,
        })
    }
}

pub fn export(database: &Database, passphrase: &str, kind: &str) -> Result<ExportedPackage, String> {
    if !matches!(kind, "racktop" | "ssh") {
        return Err("未知的配置包类型".into());
    }
    let servers = database.list_servers()?;
    if servers.is_empty() {
        return Err("当前没有可导出的服务器".into());
    }
    if servers.len() > MAX_SERVERS {
        return Err("服务器数量超过 500 台，无法导出".into());
    }

    let server_count = servers.len();
    if kind == "ssh" {
        return Ok(ExportedPackage { package: render_ssh_config(&servers), server_count, private_key_count: 0 });
    }
    validate_passphrase(passphrase)?;
    let ssh_config = None;
    let mut private_key_count = 0;
    let mut package_servers = Vec::with_capacity(servers.len());
    for server in servers {
        let mut private_key = None;
        if matches!(server.auth_method.as_str(), "privateKey" | "sshConfig") {
            if let Some(identity_file) = server.identity_file.as_deref().filter(|value| !value.trim().is_empty()) {
                let path = resolve_identity_path(identity_file);
                let metadata = fs::metadata(&path).map_err(|error| {
                    format!("无法读取 {} 的私钥 {}：{error}", server.name, path.display())
                })?;
                if !metadata.is_file() || metadata.len() > MAX_KEY_BYTES as u64 {
                    return Err(format!("{} 的私钥无效或超过 1 MB", server.name));
                }
                let bytes = fs::read(&path).map_err(|error| {
                    format!("无法读取 {} 的私钥 {}：{error}", server.name, path.display())
                })?;
                if bytes.is_empty() {
                    return Err(format!("{} 的私钥文件为空", server.name));
                }
                private_key = Some(STANDARD.encode(bytes));
                private_key_count += 1;
            } else if server.auth_method == "privateKey" {
                return Err(format!("{} 使用私钥认证，但没有配置私钥文件", server.name));
            }
        }

        let password = if server.auth_method == "password" {
            Some(
                database
                    .get_password(&server.id, false)?
                    .ok_or_else(|| format!("{} 的 SSH 密码不可用，无法完整导出", server.name))?,
            )
        } else {
            None
        };
        package_servers.push(PackageServer {
            draft: ServerDraft {
                id: None,
                name: server.name,
                location: server.location,
                host: server.host,
                port: server.port,
                username: server.username,
                ssh_alias: server.ssh_alias,
                identity_file: None,
                proxy_jump: server.proxy_jump,
                tags: server.tags,
                sampling_interval_seconds: server.sampling_interval_seconds,
                history_retention_days: server.history_retention_days,
                remote_history_enabled: server.remote_history_enabled,
                auth_method: server.auth_method,
                password,
                save_password: false,
            },
            private_key,
        });
    }

    let package = encrypt_payload(
        &PackagePayload {
            kind: kind.into(),
            ssh_config,
            servers: package_servers,
        },
        passphrase,
    )?;
    Ok(ExportedPackage {
        package,
        server_count,
        private_key_count,
    })
}

fn validate_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.chars().count() < 8 {
        return Err("迁移密码至少需要 8 个字符".into());
    }
    Ok(())
}

fn encrypt_payload(payload: &PackagePayload, passphrase: &str) -> Result<String, String> {
    let rng = SystemRandom::new();
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rng.fill(&mut salt).map_err(|_| "无法生成加密随机数".to_string())?;
    rng.fill(&mut nonce_bytes).map_err(|_| "无法生成加密随机数".to_string())?;

    let mut key_bytes = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(PBKDF2_ITERATIONS).expect("non-zero PBKDF2 iterations"),
        &salt,
        passphrase.as_bytes(),
        &mut key_bytes,
    );
    let key = UnboundKey::new(&aead::AES_256_GCM, &key_bytes)
        .map(LessSafeKey::new)
        .map_err(|_| "无法初始化 AES-GCM 加密".to_string())?;
    let mut ciphertext = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_bytes),
        Aad::from(PACKAGE_AAD),
        &mut ciphertext,
    )
    .map_err(|_| "无法加密配置包".to_string())?;

    let package = serde_json::to_string(&EncryptedPackage {
        format: FORMAT.into(),
        version: FORMAT_VERSION,
        iterations: PBKDF2_ITERATIONS,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce_bytes),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|error| error.to_string())?;
    if package.len() > MAX_PACKAGE_BYTES {
        return Err("配置包超过 32 MB，无法导出".into());
    }
    Ok(package)
}

fn decrypt_package(package: &str, passphrase: &str) -> Result<PackagePayload, String> {
    if package.len() > MAX_PACKAGE_BYTES {
        return Err("配置包超过 32 MB，无法导入".into());
    }
    let envelope: EncryptedPackage =
        serde_json::from_str(package).map_err(|_| "配置包格式无效".to_string())?;
    if envelope.format != FORMAT
        || envelope.version != FORMAT_VERSION
        || envelope.iterations != PBKDF2_ITERATIONS
    {
        return Err("不支持此版本的配置包".into());
    }
    let salt: [u8; 16] = STANDARD
        .decode(envelope.salt)
        .map_err(|_| "配置包加密信息无效".to_string())?
        .try_into()
        .map_err(|_| "配置包加密信息无效".to_string())?;
    let nonce_bytes: [u8; 12] = STANDARD
        .decode(envelope.nonce)
        .map_err(|_| "配置包加密信息无效".to_string())?
        .try_into()
        .map_err(|_| "配置包加密信息无效".to_string())?;
    let mut ciphertext = STANDARD
        .decode(envelope.ciphertext)
        .map_err(|_| "配置包加密信息无效".to_string())?;
    if ciphertext.len() < aead::AES_256_GCM.tag_len() {
        return Err("配置包已损坏".into());
    }

    let mut key_bytes = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(PBKDF2_ITERATIONS).expect("non-zero PBKDF2 iterations"),
        &salt,
        passphrase.as_bytes(),
        &mut key_bytes,
    );
    let key = UnboundKey::new(&aead::AES_256_GCM, &key_bytes)
        .map(LessSafeKey::new)
        .map_err(|_| "无法初始化 AES-GCM 解密".to_string())?;
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(PACKAGE_AAD),
            &mut ciphertext,
        )
        .map_err(|_| "迁移密码错误或配置包已损坏".to_string())?;
    let payload: PackagePayload = serde_json::from_slice(plaintext)
        .map_err(|_| "解密后的配置数据格式无效".to_string())?;
    validate_payload(&payload)?;
    Ok(payload)
}

fn validate_payload(payload: &PackagePayload) -> Result<(), String> {
    if !matches!(payload.kind.as_str(), "racktop" | "ssh")
        || (payload.kind == "ssh" && payload.ssh_config.as_deref().is_none_or(str::is_empty))
    {
        return Err("配置包类型或 SSH Config 内容无效".into());
    }
    if payload.servers.is_empty() || payload.servers.len() > MAX_SERVERS {
        return Err("配置包中的服务器数量无效".into());
    }
    for item in &payload.servers {
        let draft = &item.draft;
        if draft.name.trim().chars().count() > 24 {
            return Err("配置包中的服务器名称不能超过 24 个字符".into());
        }
        if draft.host.trim().is_empty() || draft.username.trim().is_empty() || draft.port == 0 {
            return Err("配置包包含无效的服务器地址".into());
        }
        if !matches!(draft.auth_method.as_str(), "sshAgent" | "privateKey" | "password" | "sshConfig") {
            return Err("配置包包含不支持的认证方式".into());
        }
        if draft.auth_method == "privateKey" && item.private_key.is_none() {
            return Err(format!("{} 缺少私钥文件", draft.name));
        }
        if draft.auth_method == "password" && draft.password.as_deref().is_none_or(str::is_empty) {
            return Err(format!("{} 缺少 SSH 密码", draft.name));
        }
        if let Some(encoded_key) = &item.private_key {
            let key_len = STANDARD
                .decode(encoded_key)
                .map_err(|_| "配置包中的私钥数据无效".to_string())?
                .len();
            if key_len == 0 || key_len > MAX_KEY_BYTES {
                return Err("配置包中的私钥为空或超过 1 MB".into());
            }
        }
    }
    Ok(())
}

fn render_ssh_config(servers: &[Server]) -> String {
    servers
        .iter()
        .enumerate()
        .map(|(index, server)| {
            let alias = server
                .ssh_alias
                .as_deref()
                .filter(|alias| {
                    !alias.trim().is_empty()
                        && alias.chars().all(|character| {
                            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
                        })
                })
                .map(str::to_owned)
                .unwrap_or_else(|| format!("racktop-server-{}", index + 1));
            let mut block = format!(
                "Host {alias}\n  HostName {}\n  User {}\n  Port {}",
                ssh_config_value(&server.host),
                ssh_config_value(&server.username),
                server.port
            );
            if let Some(proxy_jump) = server.proxy_jump.as_deref().filter(|value| !value.trim().is_empty()) {
                block.push_str(&format!("\n  ProxyJump {}", ssh_config_value(proxy_jump)));
            }
            block
        })
        .collect::<Vec<_>>()
        .join("\n\n")
        + "\n"
}

fn ssh_config_value(value: &str) -> String {
    if value.chars().any(|character| character.is_whitespace() || matches!(character, '"' | '\\' | '#')) {
        format!(
            "\"{}\"",
            value.replace('\\', "\\\\").replace('"', "\\\"").replace('#', "\\#")
        )
    } else {
        value.to_owned()
    }
}

fn resolve_identity_path(value: &str) -> PathBuf {
    let path = expand_identity_path(value);
    if path.is_absolute() {
        path
    } else {
        dirs::home_dir().unwrap_or_default().join(path)
    }
}

fn same_connection(server: &Server, draft: &ServerDraft) -> bool {
    server.host.trim().eq_ignore_ascii_case(draft.host.trim())
        && server.port == draft.port
        && server.username.trim() == draft.username.trim()
}

fn write_private_key(app_data_dir: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() || bytes.len() > MAX_KEY_BYTES {
        return Err("私钥为空或超过 1 MB".into());
    }
    let key_dir = app_data_dir.join("ssh-keys");
    fs::create_dir_all(&key_dir).map_err(|error| format!("无法创建私钥目录：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&key_dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法保护私钥目录：{error}"))?;
    }

    let path = key_dir.join(format!("{}.key", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("无法创建私钥文件：{error}"))?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        let _ = fs::remove_file(&path);
        return Err(format!("无法写入私钥文件：{error}"));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const TEST_KEY: &[u8] = b"-----BEGIN OPENSSH PRIVATE KEY-----\ntest fixture\n-----END OPENSSH PRIVATE KEY-----\n";
    const PASSPHRASE: &str = "correct horse battery staple";

    #[test]
    fn failed_save_rolls_back_row_and_key_and_remaining_batch_can_retry() {
        let directory = tempdir().unwrap();
        let db_path = directory.path().join("target.sqlite");
        let database = Database::open(&db_path).unwrap();
        let fault = rusqlite::Connection::open(&db_path).unwrap();
        fault.execute_batch("CREATE TRIGGER fail_credentials BEFORE UPDATE OF credential_storage_state ON servers WHEN NEW.host='fail.example' BEGIN SELECT RAISE(FAIL, 'injected'); END;").unwrap();
        let state = ConfigTransferState::default();
        let mut first = draft(None); first.host = "ok.example".into();
        let mut second = draft(None); second.host = "fail.example".into();
        state.pending.lock().unwrap().insert("test".into(), PendingImport {
            payload: PackagePayload { kind: "racktop".into(), ssh_config: None, servers: vec![
                PackageServer { draft: first, private_key: Some(STANDARD.encode(TEST_KEY)) },
                PackageServer { draft: second, private_key: Some(STANDARD.encode(TEST_KEY)) },
            ] }, created_at: Instant::now(),
        });
        assert!(state.commit_import("test", &[0, 1], &database, directory.path()).is_err());
        let saved = database.list_servers().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].host, "ok.example");
        assert!(Path::new(saved[0].identity_file.as_deref().unwrap()).exists());
        assert_eq!(fs::read_dir(directory.path().join("ssh-keys")).unwrap().count(), 1);
        fault.execute_batch("DROP TRIGGER fail_credentials;").unwrap();
        assert_eq!(state.commit_import("test", &[1], &database, directory.path()).unwrap().imported_count, 1);
        assert_eq!(database.list_servers().unwrap().len(), 2);
    }

    #[test]
    fn imported_key_is_retained_for_other_records_and_cleanup_then_reclaimed() {
        let directory = tempdir().unwrap();
        let database = Database::open(&directory.path().join("target.sqlite")).unwrap();
        let key = write_private_key(directory.path(), TEST_KEY).unwrap();
        let first = database.save_server(draft(Some(key.to_string_lossy().into_owned()))).unwrap();
        let mut other = draft(Some(key.to_string_lossy().into_owned())); other.host = "other.example".into();
        let second = database.save_server(other).unwrap();
        database.delete_server(&first.id).unwrap();
        assert!(key.exists());
        database.enqueue_remote_cleanup(&second, 100, "offline", None).unwrap();
        database.delete_server_record(&second.id, false).unwrap();
        assert!(key.exists());
        database.finish_remote_cleanup(&second.id, false).unwrap();
        assert!(!key.exists());
        let original = directory.path().join("user-owned.key");
        fs::write(&original, TEST_KEY).unwrap();
        let user_server = database.save_server(draft(Some(original.to_string_lossy().into_owned()))).unwrap();
        database.delete_server(&user_server.id).unwrap();
        assert!(original.exists());
    }

    fn draft(identity_file: Option<String>) -> ServerDraft {
        ServerDraft {
            id: None,
            name: "Transfer test".into(),
            location: Some("Lab".into()),
            host: "192.0.2.10".into(),
            port: 2222,
            username: "tester".into(),
            ssh_alias: Some("transfer-test".into()),
            identity_file,
            proxy_jump: Some("gateway".into()),
            tags: vec!["test".into()],
            sampling_interval_seconds: 3,
            history_retention_days: 21,
            remote_history_enabled: false,
            auth_method: "privateKey".into(),
            password: None,
            save_password: false,
        }
    }

    #[test]
    fn encrypted_package_moves_server_and_private_key_between_databases() {
        let source_dir = tempdir().unwrap();
        let target_dir = tempdir().unwrap();
        let key_path = source_dir.path().join("source-key");
        fs::write(&key_path, TEST_KEY).unwrap();
        let source = Database::open(&source_dir.path().join("source.sqlite")).unwrap();
        source.save_server(draft(Some(key_path.to_string_lossy().into_owned()))).unwrap();

        let exported = export(&source, PASSPHRASE, "racktop").unwrap();
        assert_eq!(exported.server_count, 1);
        assert_eq!(exported.private_key_count, 1);
        assert!(!exported.package.contains("BEGIN OPENSSH"));

        let target = Database::open(&target_dir.path().join("target.sqlite")).unwrap();
        let state = ConfigTransferState::default();
        let preview = state.prepare_import(&exported.package, PASSPHRASE).unwrap();
        assert_eq!(preview.private_key_count, 1);
        assert!(preview.servers[0].includes_private_key);
        assert!(preview.servers[0].draft.identity_file.is_none());
        assert!(preview.servers[0].draft.password.is_none());

        let result = state
            .commit_import(&preview.import_id, &[0], &target, target_dir.path())
            .unwrap();
        assert_eq!(result.imported_count, 1);
        assert_eq!(result.private_keys_installed, 1);
        let imported = target.list_servers().unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].host, "192.0.2.10");
        assert_eq!(imported[0].port, 2222);
        assert!(imported[0].ssh_alias.is_none());
        let imported_key = Path::new(imported[0].identity_file.as_deref().unwrap());
        assert_eq!(fs::read(imported_key).unwrap(), TEST_KEY);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(imported_key).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(imported_key.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn wrong_password_and_tampered_ciphertext_are_rejected() {
        let source_dir = tempdir().unwrap();
        let key_path = source_dir.path().join("source-key");
        fs::write(&key_path, TEST_KEY).unwrap();
        let source = Database::open(&source_dir.path().join("source.sqlite")).unwrap();
        source.save_server(draft(Some(key_path.to_string_lossy().into_owned()))).unwrap();
        let exported = export(&source, PASSPHRASE, "racktop").unwrap();
        let state = ConfigTransferState::default();

        assert!(state.prepare_import(&exported.package, "wrong password").is_err());
        let mut envelope: EncryptedPackage = serde_json::from_str(&exported.package).unwrap();
        let mut bytes = STANDARD.decode(envelope.ciphertext).unwrap();
        bytes[0] ^= 1;
        envelope.ciphertext = STANDARD.encode(bytes);
        let tampered = serde_json::to_string(&envelope).unwrap();
        assert!(state.prepare_import(&tampered, PASSPHRASE).is_err());
    }

    #[test]
    fn export_rejects_a_missing_private_key_instead_of_silently_omitting_it() {
        let source_dir = tempdir().unwrap();
        let source = Database::open(&source_dir.path().join("source.sqlite")).unwrap();
        source
            .save_server(draft(Some(source_dir.path().join("missing-key").to_string_lossy().into_owned())))
            .unwrap();
        let error = export(&source, PASSPHRASE, "racktop").unwrap_err();
        assert!(error.contains("无法读取 Transfer test 的私钥"));
    }

    #[test]
    fn ssh_export_is_plain_text_without_password_or_private_keys() {
        let source_dir = tempdir().unwrap();
        let key_path = source_dir.path().join("source-key");
        fs::write(&key_path, TEST_KEY).unwrap();
        let source = Database::open(&source_dir.path().join("source.sqlite")).unwrap();
        source.save_server(draft(Some(key_path.to_string_lossy().into_owned()))).unwrap();

        let exported = export(&source, "", "ssh").unwrap();
        assert_eq!(exported.private_key_count, 0);
        let ssh_config = exported.package;
        assert!(ssh_config.contains("Host transfer-test"));
        assert!(ssh_config.contains("HostName 192.0.2.10"));
        assert!(!ssh_config.contains("IdentityFile"));
        assert!(ssh_config.contains("ProxyJump gateway"));
        assert_eq!(crate::ssh_config::parse(&ssh_config).len(), 1);
    }

    #[test]
    #[ignore = "writes only the two explicitly named isolated development data directories"]
    fn isolated_development_apps_round_trip() {
        let fixture_dir = PathBuf::from(std::env::var("RACKTOP_MIGRATION_FIXTURE_DIR").expect("explicit fixture directory required"));
        assert!(fixture_dir.is_absolute());
        let data = dirs::data_dir().unwrap();
        let source_dir = data.join("com.racktop.dev.migration.source");
        let target_dir = data.join("com.racktop.dev.migration.target");
        let source = Database::open(&source_dir.join("racktop.sqlite")).unwrap();
        let target = Database::open(&target_dir.join("racktop.sqlite")).unwrap();
        assert!(source.list_servers().unwrap().is_empty(), "source must start empty");
        assert!(target.list_servers().unwrap().is_empty(), "target must start empty");
        let key_path = fixture_dir.join("id_ed25519");
        let mut test_server = draft(Some(key_path.to_string_lossy().into_owned()));
        test_server.name = "迁移测试服务器".into();
        test_server.host = "127.0.0.1".into();
        test_server.port = 9;
        test_server.proxy_jump = None;
        test_server.ssh_alias = Some("source-only-test-alias".into());
        source.save_server(test_server).unwrap();
        let exported = export(&source, PASSPHRASE, "racktop").unwrap();
        let package_path = fixture_dir.join("migration-round-trip.json");
        save_export(&package_path, exported).unwrap();
        let package = fs::read_to_string(&package_path).unwrap();
        let state = ConfigTransferState::default();
        assert!(state.prepare_import(&package, "wrong-password").is_err());
        assert!(target.list_servers().unwrap().is_empty());
        assert!(!target_dir.join("ssh-keys").exists());
        let preview = state.prepare_import(&package, PASSPHRASE).unwrap();
        assert!(!target_dir.join("ssh-keys").exists(), "preview cannot install keys");
        let result = state.commit_import(&preview.import_id, &[0], &target, &target_dir).unwrap();
        assert_eq!(result.imported_count, 1);
        let imported = target.list_servers().unwrap().pop().unwrap();
        let imported_key = PathBuf::from(imported.identity_file.unwrap());
        assert!(imported_key.starts_with(&target_dir));
        assert_eq!(fs::read(&imported_key).unwrap(), fs::read(&key_path).unwrap());
        let fingerprint = |path: &Path| {
            let output = std::process::Command::new("ssh-keygen").arg("-y").arg("-f").arg(path).output().unwrap();
            assert!(output.status.success());
            output.stdout
        };
        assert_eq!(fingerprint(&imported_key), fingerprint(&key_path), "restored private key must yield the same public key");
        let again = state.prepare_import(&package, PASSPHRASE).unwrap();
        assert!(state.commit_import(&again.import_id, &[0], &target, &target_dir).is_err());
        assert_eq!(target.list_servers().unwrap().len(), 1);
        assert_eq!(fs::read_dir(target_dir.join("ssh-keys")).unwrap().count(), 1);
        println!("Isolated migration PASS: encrypted file, wrong-password rejection, deferred key writes, byte-identical private key, identical SSH public key, duplicate rejection.");
    }
}
