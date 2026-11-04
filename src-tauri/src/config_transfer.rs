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
struct HopSecret { private_key: Option<String>, password: Option<String> }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageServer {
    #[serde(default)]
    hop_secrets: Vec<HopSecret>,
    draft: ServerDraft,
    private_key: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferServerPreview {
    pub draft: ServerDraft,
    pub includes_private_key: bool,
    pub blocked_reason: Option<String>,
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
        let mut payload = decrypt_package(package, passphrase)?;
        resolve_package_routes(&mut payload);
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
                for hop in &mut draft.ssh_hops { hop.identity_file = None; hop.credential_id = None; }
                draft.save_password = false;
                TransferServerPreview {
                    draft,
                    includes_private_key: item.private_key.is_some(),
                    blocked_reason: crate::ssh_config::validate_transfer_draft(&item.draft).err(),
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

        validate_payload(&payload)?;
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
            crate::ssh_config::validate_transfer_draft(candidate)?;
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

            let mut route_keys = Vec::new();
            let mut route_credentials = Vec::new();
            let route_result = (|| -> Result<(), String> {
                for (hop, secret) in draft.ssh_hops.iter_mut().zip(&item.hop_secrets) {
                    hop.identity_file = None; hop.credential_id = None;
                    if let Some(encoded) = &secret.private_key {
                        let key = write_private_key(app_data_dir, &STANDARD.decode(encoded).map_err(|e| e.to_string())?)?;
                        hop.identity_file = Some(key.to_string_lossy().into_owned()); route_keys.push(key);
                    }
                    if let Some(password) = &secret.password {
                        let id = format!("racktop-hop-{}", Uuid::new_v4());
                        let entry = keyring::Entry::new("com.racktop.desktop", &id).map_err(|e| e.to_string())?;
                        entry.set_password(password).map_err(|e| format!("无法保存跳板机密码：{e}"))?;
                        hop.credential_id = Some(id.clone()); route_credentials.push(id);
                    }
                }
                Ok(())
            })();
            if let Err(error) = route_result { discard_hop_files(&route_keys, &route_credentials); return Err(error); }
            // Resolved routes are self-contained; never invoke the source alias.
            if !draft.ssh_hops.is_empty() { draft.proxy_jump = crate::ssh_routes::concrete_chain(&draft.ssh_hops); }
            let key_path = if let Some(encoded_key) = &item.private_key {
                let key_bytes = STANDARD
                    .decode(encoded_key)
                    .map_err(|_| "配置包中的私钥数据无效".to_string())?;
                Some(match write_private_key(app_data_dir, &key_bytes) { Ok(path) => path, Err(error) => { discard_hop_files(&route_keys, &route_credentials); return Err(error); } })
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
                // The DB compensation owns route-key cleanup if a row was inserted.
                // Only discard staged files once absence of surviving references is known.
                if database.list_servers().is_ok_and(|servers| !servers.iter().any(|s| s.ssh_hops.iter().any(|h| h.identity_file.as_deref().is_some_and(|p| route_keys.iter().any(|k| k.to_str() == Some(p))) || h.credential_id.as_ref().is_some_and(|id| route_credentials.contains(id))))) {
                    discard_hop_files(&route_keys, &route_credentials);
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
    for server in &servers {
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
        let mut hop_secrets = Vec::new();
        for hop in &server.ssh_hops {
            let private_key = if matches!(hop.auth_method.as_str(), "privateKey" | "sshConfig") {
                hop.identity_file.as_deref().map(|p| read_transfer_key(p)).transpose()?
            } else { None };
            let password = if hop.auth_method == "password" {
                let id = hop.credential_id.as_deref().ok_or("跳板机缺少密码凭据")?;
                Some(keyring::Entry::new("com.racktop.desktop", id).map_err(|e| e.to_string())?.get_password().map_err(|e| e.to_string())?)
            } else { None };
            if private_key.is_some() { private_key_count += 1; }
            hop_secrets.push(HopSecret { private_key, password });
        }
        package_servers.push(PackageServer { hop_secrets,
            draft: ServerDraft {
                id: None,
                name: server.name.clone(),
                location: server.location.clone(),
                host: server.host.clone(),
                port: server.port,
                username: server.username.clone(),
                ssh_alias: server.ssh_alias.clone(),
                identity_file: None,
                proxy_jump: server.proxy_jump.clone(), ssh_hops: server.ssh_hops.clone(),
                tags: server.tags.clone(),
                sampling_interval_seconds: server.sampling_interval_seconds,
                history_retention_days: server.history_retention_days,
                remote_history_enabled: server.remote_history_enabled,
                auth_method: server.auth_method.clone(),
                password,
                save_password: false,
            },
            private_key,
        });
    }

    let mut payload = PackagePayload { kind: kind.into(), ssh_config, servers: package_servers };
    resolve_package_routes(&mut payload);
    let package = encrypt_payload(&payload, passphrase)?;
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

fn read_transfer_key(path: &str) -> Result<String, String> {
    let path = expand_identity_path(path);
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_KEY_BYTES as u64 { return Err("跳板机私钥无效或超过 1 MB".into()); }
    Ok(STANDARD.encode(fs::read(path).map_err(|e| e.to_string())?))
}

fn discard_hop_files(keys: &[PathBuf], credentials: &[String]) {
    for key in keys { let _ = fs::remove_file(key); }
    for id in credentials { if let Ok(entry) = keyring::Entry::new("com.racktop.desktop", id) { let _ = entry.delete_credential(); } }
}

fn resolve_package_routes(payload: &mut PackagePayload) {
    let source = payload.servers.clone();
    let drafts: Vec<_> = source.iter().enumerate().map(|(index, item)| { let mut draft = item.draft.clone(); draft.id = Some(index.to_string()); draft }).collect();
    for item in &mut payload.servers {
        if !item.draft.ssh_hops.is_empty() { continue; }
        let Ok(mut hops) = crate::ssh_routes::resolve(&item.draft, &drafts) else { continue };
        let mut secrets = Vec::new();
        for hop in &mut hops {
            let secret = hop.credential_id.as_deref().and_then(|i| i.parse::<usize>().ok()).map(|index| {
                let dependency = &source[index];
                HopSecret { private_key: dependency.private_key.clone(), password: dependency.draft.password.clone() }
            });
            let secret = secret.or_else(|| (hop.auth_method == "sshAgent" && hop.credential_id.is_none() && hop.identity_file.is_none()).then_some(HopSecret { private_key: None, password: None }));
            let Some(secret) = secret else { continue };
            secrets.push(secret);
            hop.identity_file = None; hop.credential_id = None;
        }
        // Existing resolved chains nested under raw aliases require their own
        // credential payloads; fail closed rather than lose those credentials.
        if secrets.len() != hops.len() { continue; }
        item.draft.ssh_hops = hops;
        item.hop_secrets = secrets;
    }
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
        crate::ssh_routes::validate(&draft.ssh_hops)?;
        if item.hop_secrets.len() != draft.ssh_hops.len() { return Err("跳板机凭据数量与连接链不匹配".into()); }
        for (hop, secret) in draft.ssh_hops.iter().zip(&item.hop_secrets) {
            if hop.auth_method == "password" && secret.password.as_deref().is_none_or(str::is_empty) { return Err("跳板机缺少密码".into()); }
            if hop.auth_method == "privateKey" && secret.private_key.is_none() { return Err("跳板机缺少私钥".into()); }
            if let Some(key) = &secret.private_key {
                let bytes = STANDARD.decode(key).map_err(|_| "跳板机私钥数据无效")?;
                if bytes.is_empty() || bytes.len() > MAX_KEY_BYTES { return Err("跳板机私钥无效或过大".into()); }
            }
        }
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
    fn concrete_agent_jump_round_trips_through_encrypted_and_plain_exports() {
        let directory = tempdir().unwrap();
        let source = Database::open(&directory.path().join("source.sqlite")).unwrap();
        let target = Database::open(&directory.path().join("target.sqlite")).unwrap();
        let mut server = draft(None); server.auth_method = "sshAgent".into();
        server.proxy_jump = Some("jump-user@192.0.2.1:2201".into());
        source.save_server(server).unwrap();
        let package = export(&source, PASSPHRASE, "racktop").unwrap();
        let state = ConfigTransferState::default();
        let preview = state.prepare_import(&package.package, PASSPHRASE).unwrap();
        assert!(preview.servers[0].blocked_reason.is_none());
        assert_eq!(preview.servers[0].draft.ssh_hops.len(), 1);
        state.commit_import(&preview.import_id, &[0], &target, directory.path()).unwrap();
        let imported = target.list_servers().unwrap().pop().unwrap();
        assert_eq!(imported.ssh_hops[0].host, "192.0.2.1");
        assert_eq!(imported.ssh_hops[0].port, 2201);
        assert_eq!(imported.ssh_hops[0].auth_method, "sshAgent");
        assert!(!directory.path().join("ssh-keys").exists());
        let plain = export(&target, "", "ssh").unwrap();
        let drafts = crate::ssh_config::parse_transfer(&plain.package).unwrap();
        assert_eq!(drafts.len(), 1);
        assert!(crate::ssh_config::validate_transfer_draft(&drafts[0]).is_ok());
        assert_eq!(drafts[0].ssh_hops[0].username, "jump-user");
        assert_eq!(drafts[0].ssh_hops[0].port, 2201);
    }

    #[test]
    fn encrypted_multihop_round_trip_is_self_contained_and_reclaims_route_keys() {
        let source_dir = tempdir().unwrap(); let target_dir = tempdir().unwrap();
        let source = Database::open(&source_dir.path().join("source.sqlite")).unwrap();
        let target_path = target_dir.path().join("target.sqlite");
        let target = Database::open(&target_path).unwrap();
        let outer_key = source_dir.path().join("outer.key"); fs::write(&outer_key, TEST_KEY).unwrap();
        let mut outer = draft(Some(outer_key.to_string_lossy().into_owned()));
        outer.name = "outer".into(); outer.ssh_alias = Some("outer-alias".into()); outer.host = "192.0.2.1".into(); outer.username = "outer-user".into(); outer.port = 2201;
        source.save_server(outer).unwrap();
        let mut inner = draft(None); inner.auth_method = "sshAgent".into(); inner.name = "inner".into(); inner.ssh_alias = Some("inner-alias".into()); inner.host = "192.0.2.2".into(); inner.port = 2202; inner.proxy_jump = Some("outer-alias".into());
        source.save_server(inner).unwrap();
        let mut destination = draft(None); destination.auth_method = "sshAgent".into(); destination.name = "destination".into(); destination.proxy_jump = Some("inner-alias".into());
        source.save_server(destination).unwrap();
        let exported = export(&source, PASSPHRASE, "racktop").unwrap();
        let state = ConfigTransferState::default(); let preview = state.prepare_import(&exported.package, PASSPHRASE).unwrap();
        let index = preview.servers.iter().position(|s| s.draft.name == "destination").unwrap();
        assert!(preview.servers[index].blocked_reason.is_none());
        assert_eq!(preview.servers[index].draft.ssh_hops.len(), 2);
        assert!(preview.servers[index].draft.ssh_hops[0].identity_file.is_none());
        state.commit_import(&preview.import_id, &[index], &target, target_dir.path()).unwrap();
        let server = target.list_servers().unwrap().pop().unwrap();
        assert_eq!(server.ssh_hops[0].username, "outer-user"); assert_eq!(server.ssh_hops[0].port, 2201);
        assert_eq!(server.ssh_hops[1].port, 2202);
        assert!(server.ssh_alias.is_none());
        let key = PathBuf::from(server.ssh_hops[0].identity_file.as_deref().unwrap());
        assert_eq!(fs::read(&key).unwrap(), TEST_KEY);
        let (command, _) = crate::collector::configured_ssh_command(&server, None).unwrap();
        let args: Vec<_> = command.as_std().get_args().map(|s| s.to_string_lossy().into_owned()).collect();
        assert!(args.iter().any(|a| a.contains("--racktop-proxy")));
        assert!(!args.iter().any(|a| a == "-J"));
        // Exporting again must include the independent hop key, even though
        // neither hop was selected as a separate server record.
        let again = export(&target, PASSPHRASE, "racktop").unwrap();
        let decoded = decrypt_package(&again.package, PASSPHRASE).unwrap();
        assert!(decoded.servers[0].hop_secrets[0].private_key.is_some());
        let reopened = Database::open(&target_path).unwrap();
        assert_eq!(reopened.get_server(&server.id).unwrap().ssh_hops.len(), 2);
        target.enqueue_remote_cleanup(&server, 100, "offline", None).unwrap();
        target.delete_server_record(&server.id, false).unwrap(); assert!(key.exists());
        target.finish_remote_cleanup(&server.id, false).unwrap(); assert!(!key.exists());
        assert!(outer_key.exists());
    }

    #[test]
    fn encrypted_password_hop_secret_is_carried_but_never_exposed_in_preview() {
        let mut jump = draft(None); jump.name = "jump".into(); jump.host = "192.0.2.1".into(); jump.auth_method = "password".into(); jump.password = Some("hop-test-secret".into()); jump.ssh_alias = Some("jump".into());
        let mut destination = draft(None); destination.auth_method = "sshAgent".into(); destination.proxy_jump = Some("jump".into());
        let payload = PackagePayload { kind: "racktop".into(), ssh_config: None, servers: vec![
            PackageServer { draft: jump, private_key: None, hop_secrets: Vec::new() },
            PackageServer { draft: destination, private_key: None, hop_secrets: Vec::new() },
        ] };
        let package = encrypt_payload(&payload, PASSPHRASE).unwrap(); let state = ConfigTransferState::default();
        let preview = state.prepare_import(&package, PASSPHRASE).unwrap();
        assert!(preview.servers[1].blocked_reason.is_none());
        let pending = state.pending.lock().unwrap();
        assert_eq!(pending[&preview.import_id].payload.servers[1].hop_secrets[0].password.as_deref(), Some("hop-test-secret"));
        assert!(!serde_json::to_string(&preview).unwrap().contains("hop-test-secret"));
    }

    #[test]
    fn mixed_package_previews_all_servers_and_imports_supported_selection_only() {
        let directory = tempdir().unwrap();
        let database = Database::open(&directory.path().join("target.sqlite")).unwrap();
        let mut target = draft(None); target.host = "jump-target.example".into();
        target.proxy_jump = Some("jump-review".into());
        let package = encrypt_payload(&PackagePayload { kind: "racktop".into(), ssh_config: None, servers: vec![
            PackageServer { hop_secrets: Vec::new(), draft: draft(None), private_key: Some(STANDARD.encode(TEST_KEY)) },
            PackageServer { hop_secrets: Vec::new(), draft: target, private_key: Some(STANDARD.encode(TEST_KEY)) },
        ] }, PASSPHRASE).unwrap();
        let state = ConfigTransferState::default();
        let preview = state.prepare_import(&package, PASSPHRASE).unwrap();
        assert_eq!(preview.servers.len(), 2);
        assert!(preview.servers[0].blocked_reason.is_none());
        assert!(preview.servers[1].blocked_reason.is_some());
        assert!(state.commit_import(&preview.import_id, &[0, 1], &database, directory.path()).is_err());
        assert!(database.list_servers().unwrap().is_empty());
        assert!(!directory.path().join("ssh-keys").exists());
        let result = state.commit_import(&preview.import_id, &[0], &database, directory.path()).unwrap();
        assert_eq!(result.imported_count, 1);
        assert_eq!(database.list_servers().unwrap().len(), 1);
        assert_eq!(fs::read_dir(directory.path().join("ssh-keys")).unwrap().count(), 1);
    }

    #[test]
    fn encrypted_jump_dependencies_fail_before_writing_records_or_keys() {
        let directory = tempdir().unwrap();
        let database = Database::open(&directory.path().join("target.sqlite")).unwrap();
        let mut target = draft(None);
        target.proxy_jump = Some("jump-review".into());
        let payload = PackagePayload { kind: "racktop".into(), ssh_config: None, servers: vec![
            PackageServer { hop_secrets: Vec::new(), draft: target, private_key: Some(STANDARD.encode(TEST_KEY)) },
        ] };
        let package = encrypt_payload(&payload, PASSPHRASE).unwrap();
        let state = ConfigTransferState::default();
        let preview = state.prepare_import(&package, PASSPHRASE).unwrap();
        assert!(preview.servers[0].blocked_reason.as_deref().unwrap().contains("ProxyJump"));
        state.pending.lock().unwrap().insert("legacy-preview".into(), PendingImport { payload, created_at: Instant::now() });
        assert!(state.commit_import("legacy-preview", &[0], &database, directory.path()).err().unwrap().contains("ProxyJump"));
        assert!(database.list_servers().unwrap().is_empty());
        assert!(!directory.path().join("ssh-keys").exists());
    }

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
                PackageServer { hop_secrets: Vec::new(), draft: first, private_key: Some(STANDARD.encode(TEST_KEY)) },
                PackageServer { hop_secrets: Vec::new(), draft: second, private_key: Some(STANDARD.encode(TEST_KEY)) },
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

    #[test]
    fn equivalent_key_paths_protect_server_and_cleanup_references() {
        for queued in [false, true] {
            let directory = tempdir().unwrap();
            let database = Database::open(&directory.path().join("target.sqlite")).unwrap();
            let key = write_private_key(directory.path(), TEST_KEY).unwrap();
            let alias = key.parent().unwrap().join(".").join(key.file_name().unwrap());
            let first = database.save_server(draft(Some(key.to_string_lossy().into_owned()))).unwrap();
            let mut other = draft(Some(alias.to_string_lossy().into_owned()));
            other.host = "other.example".into();
            let second = database.save_server(other).unwrap();
            if queued {
                database.enqueue_remote_cleanup(&second, 100, "offline", None).unwrap();
                database.delete_server_record(&second.id, false).unwrap();
            }
            database.delete_server(&first.id).unwrap();
            assert!(key.exists());
            if queued { database.finish_remote_cleanup(&second.id, false).unwrap(); }
            else { database.delete_server(&second.id).unwrap(); }
            assert!(!key.exists());
        }
    }

    #[test]
    fn editing_authentication_reclaims_only_unreferenced_imported_keys() {
        for method in ["sshAgent", "password", "privateKey"] {
            let directory = tempdir().unwrap();
            let database = Database::open(&directory.path().join("target.sqlite")).unwrap();
            let key = write_private_key(directory.path(), TEST_KEY).unwrap();
            let replacement = write_private_key(directory.path(), TEST_KEY).unwrap();
            let server = database.save_server(draft(Some(key.to_string_lossy().into_owned()))).unwrap();
            let mut edit = draft(None);
            edit.id = Some(server.id);
            edit.auth_method = method.into();
            if method == "password" { edit.password = Some("test-only".into()); }
            if method == "privateKey" { edit.identity_file = Some(replacement.to_string_lossy().into_owned()); }
            database.save_server(edit).unwrap();
            assert!(!key.exists(), "{method}");
            assert!(replacement.exists());
        }
    }

    #[test]
    fn editing_retains_keys_used_by_other_servers_or_cleanup_tasks() {
        for queued in [false, true] {
            let directory = tempdir().unwrap();
            let database = Database::open(&directory.path().join("target.sqlite")).unwrap();
            let key = write_private_key(directory.path(), TEST_KEY).unwrap();
            let first = database.save_server(draft(Some(key.to_string_lossy().into_owned()))).unwrap();
            let alias = key.parent().unwrap().join(".").join(key.file_name().unwrap());
            let mut other = draft(Some(alias.to_string_lossy().into_owned()));
            other.host = "other.example".into();
            let second = database.save_server(other).unwrap();
            if queued {
                database.enqueue_remote_cleanup(&second, 100, "offline", None).unwrap();
                database.delete_server_record(&second.id, false).unwrap();
            }
            let mut edit = draft(None); edit.id = Some(first.id); edit.auth_method = "sshAgent".into();
            database.save_server(edit).unwrap();
            assert!(key.exists());
            if queued { database.finish_remote_cleanup(&second.id, false).unwrap(); }
            else { database.delete_server(&second.id).unwrap(); }
            assert!(!key.exists());
        }
    }

    #[test]
    fn failed_edit_and_user_owned_keys_are_never_reclaimed() {
        let directory = tempdir().unwrap();
        let db_path = directory.path().join("target.sqlite");
        let database = Database::open(&db_path).unwrap();
        let key = write_private_key(directory.path(), TEST_KEY).unwrap();
        let server = database.save_server(draft(Some(key.to_string_lossy().into_owned()))).unwrap();
        let fault = rusqlite::Connection::open(&db_path).unwrap();
        fault.execute_batch("CREATE TRIGGER fail_edit BEFORE UPDATE ON servers BEGIN SELECT RAISE(FAIL, 'injected'); END;").unwrap();
        let mut edit = draft(None); edit.id = Some(server.id.clone()); edit.auth_method = "sshAgent".into();
        assert!(database.save_server(edit).is_err());
        assert!(key.exists());
        assert_eq!(database.get_server(&server.id).unwrap().identity_file, server.identity_file);
        fault.execute_batch("DROP TRIGGER fail_edit;").unwrap();
        database.delete_server(&server.id).unwrap();
        let original = directory.path().join("user-owned.key");
        fs::write(&original, TEST_KEY).unwrap();
        let server = database.save_server(draft(Some(original.to_string_lossy().into_owned()))).unwrap();
        let mut edit = draft(None); edit.id = Some(server.id); edit.auth_method = "sshAgent".into();
        database.save_server(edit).unwrap();
        assert!(original.exists());
    }

    #[test]
    fn unresolved_key_reference_conservatively_prevents_reclamation() {
        let directory = tempdir().unwrap();
        let database = Database::open(&directory.path().join("target.sqlite")).unwrap();
        let key = write_private_key(directory.path(), TEST_KEY).unwrap();
        let first = database.save_server(draft(Some(key.to_string_lossy().into_owned()))).unwrap();
        let mut other = draft(Some(directory.path().join("unavailable.key").to_string_lossy().into_owned()));
        other.host = "other.example".into();
        database.save_server(other).unwrap();
        database.delete_server(&first.id).unwrap();
        assert!(key.exists());
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
            proxy_jump: None, ssh_hops: Vec::new(),
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
        let mut server = draft(Some(key_path.to_string_lossy().into_owned()));
        server.proxy_jump = Some("gateway".into());
        source.save_server(server).unwrap();

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
