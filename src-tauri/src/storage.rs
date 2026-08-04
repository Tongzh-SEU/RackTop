use crate::models::{AppSettings, HistoryHeatmapPoint, HistoryPoint, IdleReservation, Server, ServerDraft, Snapshot};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Mutex,
};
use uuid::Uuid;

pub struct Database {
    connection: Mutex<Connection>,
    session_passwords: Mutex<HashMap<String, String>>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA foreign_keys=ON;
                 CREATE TABLE IF NOT EXISTS servers (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    location TEXT,
                    host TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    ssh_alias TEXT,
                    identity_file TEXT,
                    proxy_jump TEXT,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    sampling_interval_seconds INTEGER NOT NULL DEFAULT 2,
                    history_retention_days INTEGER NOT NULL DEFAULT 30,
                    remote_history_enabled INTEGER NOT NULL DEFAULT 0,
                    remote_history_last_sync_at INTEGER,
                    auth_method TEXT NOT NULL DEFAULT 'sshAgent',
                    status TEXT NOT NULL DEFAULT 'unknown',
                    last_error TEXT,
                    last_seen_at INTEGER
                 );
                 CREATE TABLE IF NOT EXISTS snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    server_id TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    cpu_utilization REAL NOT NULL,
                    memory_utilization REAL NOT NULL,
                    swap_utilization REAL NOT NULL DEFAULT 0,
                    gpu_json TEXT NOT NULL,
                    gpu_memory_json TEXT NOT NULL DEFAULT '{}',
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_snapshots_lookup ON snapshots(server_id, timestamp);
                 CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS idle_reservations (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    filters_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER,
                    notify_mode TEXT NOT NULL,
                    status TEXT NOT NULL,
                    matched_gpu_keys_json TEXT NOT NULL DEFAULT '[]'
                 );",
            )
            .map_err(|error| error.to_string())?;
        let snapshot_columns = {
            let mut statement = connection.prepare("PRAGMA table_info(snapshots)").map_err(|error| error.to_string())?;
            let columns = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?;
            columns.filter_map(Result::ok).collect::<HashSet<_>>()
        };
        if !snapshot_columns.contains("gpu_memory_json") {
            connection.execute("ALTER TABLE snapshots ADD COLUMN gpu_memory_json TEXT NOT NULL DEFAULT '{}'", []).map_err(|error| error.to_string())?;
        }
        if !snapshot_columns.contains("swap_utilization") {
            connection.execute("ALTER TABLE snapshots ADD COLUMN swap_utilization REAL NOT NULL DEFAULT 0", []).map_err(|error| error.to_string())?;
        }
        let server_columns = {
            let mut statement = connection.prepare("PRAGMA table_info(servers)").map_err(|error| error.to_string())?;
            let columns = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?;
            columns.filter_map(Result::ok).collect::<HashSet<_>>()
        };
        if !server_columns.contains("location") {
            connection.execute("ALTER TABLE servers ADD COLUMN location TEXT", []).map_err(|error| error.to_string())?;
        }
        if !server_columns.contains("remote_history_enabled") {
            connection.execute("ALTER TABLE servers ADD COLUMN remote_history_enabled INTEGER NOT NULL DEFAULT 0", []).map_err(|error| error.to_string())?;
        }
        if !server_columns.contains("remote_history_last_sync_at") {
            connection.execute("ALTER TABLE servers ADD COLUMN remote_history_last_sync_at INTEGER", []).map_err(|error| error.to_string())?;
        }
        connection.execute(
            "DELETE FROM snapshots WHERE id NOT IN (SELECT MAX(id) FROM snapshots GROUP BY server_id,timestamp)",
            [],
        ).map_err(|error| error.to_string())?;
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_unique ON snapshots(server_id,timestamp)", []).map_err(|error| error.to_string())?;
        Ok(Self { connection: Mutex::new(connection), session_passwords: Mutex::new(HashMap::new()) })
    }

    pub fn list_servers(&self) -> Result<Vec<Server>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare("SELECT id,name,location,host,port,username,ssh_alias,identity_file,proxy_jump,tags_json,sampling_interval_seconds,history_retention_days,remote_history_enabled,remote_history_last_sync_at,auth_method,status,last_error,last_seen_at FROM servers ORDER BY name COLLATE NOCASE")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                let tags: String = row.get(9)?;
                Ok(Server {
                    id: row.get(0)?, name: row.get(1)?, location: row.get(2)?, host: row.get(3)?, port: row.get(4)?, username: row.get(5)?,
                    ssh_alias: row.get(6)?, identity_file: row.get(7)?, proxy_jump: row.get(8)?,
                    tags: serde_json::from_str(&tags).unwrap_or_default(), sampling_interval_seconds: row.get(10)?,
                    history_retention_days: row.get(11)?, remote_history_enabled: row.get(12)?, remote_history_last_sync_at: row.get(13)?,
                    auth_method: row.get(14)?, status: row.get(15)?, last_error: row.get(16)?, last_seen_at: row.get(17)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }

    pub fn get_server(&self, id: &str) -> Result<Server, String> {
        self.list_servers()?
            .into_iter()
            .find(|server| server.id == id)
            .ok_or_else(|| format!("找不到服务器 {id}"))
    }

    pub fn save_server(&self, draft: ServerDraft) -> Result<Server, String> {
        if draft.host.trim().is_empty() || draft.username.trim().is_empty() {
            return Err("主机地址和用户名不能为空".into());
        }
        if draft.port == 0 {
            return Err("SSH 端口必须在 1–65535 之间".into());
        }
        let id = draft.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
        let name = if draft.name.trim().is_empty() { draft.host.trim().to_string() } else { draft.name.trim().to_string() };
        let tags = serde_json::to_string(&draft.tags).map_err(|error| error.to_string())?;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let duplicate_name = connection.query_row(
            "SELECT name FROM servers WHERE lower(trim(host))=lower(trim(?1)) AND port=?2 AND trim(username)=trim(?3) AND id<>?4 LIMIT 1",
            params![draft.host, draft.port, draft.username, id],
            |row| row.get::<_, String>(0),
        ).optional().map_err(|error| error.to_string())?;
        if let Some(existing_name) = duplicate_name {
            return Err(format!("服务器已存在：{existing_name}（{}@{}:{}）", draft.username.trim(), draft.host.trim(), draft.port));
        }
        connection.execute(
            "INSERT INTO servers (id,name,location,host,port,username,ssh_alias,identity_file,proxy_jump,tags_json,sampling_interval_seconds,history_retention_days,remote_history_enabled,auth_method,status)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'unknown')
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,host=excluded.host,port=excluded.port,username=excluded.username,ssh_alias=excluded.ssh_alias,identity_file=excluded.identity_file,proxy_jump=excluded.proxy_jump,tags_json=excluded.tags_json,sampling_interval_seconds=excluded.sampling_interval_seconds,history_retention_days=excluded.history_retention_days,remote_history_enabled=excluded.remote_history_enabled,auth_method=excluded.auth_method",
            params![id, name, blank_to_none(draft.location), draft.host.trim(), draft.port, draft.username.trim(), blank_to_none(draft.ssh_alias), blank_to_none(draft.identity_file), blank_to_none(draft.proxy_jump), tags, draft.sampling_interval_seconds.max(2), draft.history_retention_days.max(1), draft.remote_history_enabled, draft.auth_method],
        ).map_err(|error| error.to_string())?;
        drop(connection);

        if draft.auth_method == "password" {
            if let Some(password) = draft.password.filter(|value| !value.is_empty()) {
                self.session_passwords.lock().map_err(|error| error.to_string())?.insert(id.clone(), password.clone());
                if draft.save_password {
                    let entry = keyring::Entry::new("com.racktop.desktop", &id).map_err(|error| error.to_string())?;
                    entry.set_password(&password).map_err(|error| format!("无法写入系统安全凭据存储：{error}"))?;
                }
            }
        }
        self.get_server(&id)
    }

    pub fn delete_server(&self, id: &str) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection.execute("DELETE FROM servers WHERE id=?1", [id]).map_err(|error| error.to_string())?;
        if let Ok(entry) = keyring::Entry::new("com.racktop.desktop", id) {
            let _ = entry.delete_credential();
        }
        Ok(())
    }

    pub fn get_password(&self, id: &str) -> Result<Option<String>, String> {
        if let Some(password) = self.session_passwords.lock().map_err(|error| error.to_string())?.get(id).cloned() {
            return Ok(Some(password));
        }
        let entry = keyring::Entry::new("com.racktop.desktop", id).map_err(|error| error.to_string())?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("无法读取系统安全凭据：{error}")),
        }
    }

    pub fn update_status(&self, id: &str, status: &str, error: Option<&str>, timestamp: Option<i64>) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection.execute("UPDATE servers SET status=?2,last_error=?3,last_seen_at=COALESCE(?4,last_seen_at) WHERE id=?1", params![id, status, error, timestamp]).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn save_snapshot(&self, snapshot: &Snapshot) -> Result<(), String> {
        let settings = self.get_settings()?;
        if !settings.history_enabled { return Ok(()); }
        let server = self.get_server(&snapshot.server_id)?;
        let memory_utilization = if snapshot.system.memory_total_bytes > 0 { snapshot.system.memory_used_bytes as f64 / snapshot.system.memory_total_bytes as f64 * 100.0 } else { 0.0 };
        let swap_utilization = if snapshot.system.swap_total_bytes > 0 { snapshot.system.swap_used_bytes as f64 / snapshot.system.swap_total_bytes as f64 * 100.0 } else { 0.0 };
        let gpu_map: HashMap<&str, f64> = snapshot.gpus.iter().map(|gpu| (gpu.uuid.as_str(), gpu.utilization)).collect();
        let gpu_memory_map: HashMap<&str, f64> = snapshot.gpus.iter().map(|gpu| (gpu.uuid.as_str(), if gpu.memory_total_mb > 0.0 { (gpu.memory_used_mb / gpu.memory_total_mb * 100.0).clamp(0.0, 100.0) } else { 0.0 })).collect();
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection.execute(
            "INSERT INTO snapshots(server_id,timestamp,cpu_utilization,memory_utilization,swap_utilization,gpu_json,gpu_memory_json,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(server_id,timestamp) DO UPDATE SET cpu_utilization=excluded.cpu_utilization,memory_utilization=excluded.memory_utilization,swap_utilization=excluded.swap_utilization,gpu_json=excluded.gpu_json,gpu_memory_json=excluded.gpu_memory_json,payload_json=excluded.payload_json",
            params![snapshot.server_id, snapshot.timestamp, snapshot.system.cpu_utilization, memory_utilization, swap_utilization, serde_json::to_string(&gpu_map).unwrap_or_else(|_| "{}".into()), serde_json::to_string(&gpu_memory_map).unwrap_or_else(|_| "{}".into()), serde_json::to_string(snapshot).map_err(|error| error.to_string())?],
        ).map_err(|error| error.to_string())?;
        let cutoff = snapshot.timestamp - i64::from(server.history_retention_days) * 86_400;
        connection.execute("DELETE FROM snapshots WHERE server_id=?1 AND timestamp < ?2", params![snapshot.server_id, cutoff]).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn remote_history_cursor(&self, server_id: &str, now: i64) -> Result<i64, String> {
        let server = self.get_server(server_id)?;
        Ok(server.remote_history_last_sync_at.unwrap_or(now - 30 * 86_400).saturating_sub(60))
    }

    pub fn import_remote_history(&self, server_id: &str, points: &[HistoryPoint]) -> Result<usize, String> {
        if points.is_empty() { return Ok(0); }
        let settings = self.get_settings()?;
        if !settings.history_enabled { return Ok(0); }
        let server = self.get_server(server_id)?;
        let latest = points.iter().map(|point| point.timestamp).max().unwrap_or_default();
        let cutoff = latest - i64::from(server.history_retention_days) * 86_400;
        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        let mut imported = 0usize;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO snapshots(server_id,timestamp,cpu_utilization,memory_utilization,swap_utilization,gpu_json,gpu_memory_json,payload_json)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,'{}') ON CONFLICT(server_id,timestamp) DO NOTHING"
            ).map_err(|error| error.to_string())?;
            for point in points.iter().filter(|point| point.timestamp >= cutoff) {
                imported += statement.execute(params![
                    server_id,
                    point.timestamp,
                    point.cpu_utilization,
                    point.memory_utilization,
                    point.swap_utilization,
                    serde_json::to_string(&point.gpu_utilizations).map_err(|error| error.to_string())?,
                    serde_json::to_string(&point.gpu_memory_utilizations).map_err(|error| error.to_string())?,
                ]).map_err(|error| error.to_string())?;
            }
        }
        transaction.execute("DELETE FROM snapshots WHERE server_id=?1 AND timestamp < ?2", params![server_id, cutoff]).map_err(|error| error.to_string())?;
        transaction.execute(
            "UPDATE servers SET remote_history_last_sync_at=MAX(COALESCE(remote_history_last_sync_at,0),?2) WHERE id=?1",
            params![server_id, latest],
        ).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(imported)
    }

    pub fn get_history(&self, server_id: &str, from_timestamp: i64) -> Result<Vec<HistoryPoint>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection.prepare("SELECT timestamp,cpu_utilization,memory_utilization,swap_utilization,gpu_json,gpu_memory_json FROM snapshots WHERE server_id=?1 AND timestamp>=?2 ORDER BY timestamp").map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![server_id, from_timestamp], |row| {
            let gpu_json: String = row.get(4)?;
            let gpu_memory_json: String = row.get(5)?;
            Ok(HistoryPoint { timestamp: row.get(0)?, cpu_utilization: row.get(1)?, memory_utilization: row.get(2)?, swap_utilization: row.get(3)?, gpu_utilizations: serde_json::from_str(&gpu_json).unwrap_or_default(), gpu_memory_utilizations: serde_json::from_str(&gpu_memory_json).unwrap_or_default() })
        }).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }

    pub fn get_history_heatmap(&self, server_id: &str, from_timestamp: i64, timezone_offset_seconds: i64, gpu_uuids: &[String]) -> Result<Vec<HistoryHeatmapPoint>, String> {
        const BUCKET_SECONDS: i64 = 3 * 60 * 60;
        let offset = timezone_offset_seconds.clamp(-86_400, 86_400);
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection.prepare(
            "SELECT ((timestamp + ?3) / ?4) * ?4 - ?3 AS bucket,
                    COUNT(*), AVG(cpu_utilization), AVG(memory_utilization)
             FROM snapshots
             WHERE server_id=?1 AND timestamp>=?2
             GROUP BY bucket ORDER BY bucket"
        ).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![server_id, from_timestamp, offset, BUCKET_SECONDS], |row| {
            Ok(HistoryHeatmapPoint {
                timestamp: row.get(0)?,
                sample_count: row.get(1)?,
                cpu_utilization: row.get(2)?,
                memory_utilization: row.get(3)?,
                gpu_utilizations: HashMap::new(),
                gpu_memory_utilizations: HashMap::new(),
            })
        }).map_err(|error| error.to_string())?;
        let mut buckets = rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        let bucket_indexes: HashMap<i64, usize> = buckets.iter().enumerate().map(|(index, point)| (point.timestamp, index)).collect();

        for gpu_uuid in gpu_uuids {
            let json_path = format!("$.{}", serde_json::to_string(gpu_uuid).map_err(|error| error.to_string())?);
            let mut gpu_statement = connection.prepare(
                "SELECT ((timestamp + ?3) / ?4) * ?4 - ?3 AS bucket,
                        AVG(CAST(json_extract(gpu_json, ?5) AS REAL)),
                        AVG(CAST(json_extract(gpu_memory_json, ?5) AS REAL))
                 FROM snapshots
                 WHERE server_id=?1 AND timestamp>=?2
                 GROUP BY bucket ORDER BY bucket"
            ).map_err(|error| error.to_string())?;
            let gpu_rows = gpu_statement.query_map(params![server_id, from_timestamp, offset, BUCKET_SECONDS, json_path], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<f64>>(1)?, row.get::<_, Option<f64>>(2)?))
            }).map_err(|error| error.to_string())?;
            for row in gpu_rows {
                let (timestamp, utilization, memory_utilization) = row.map_err(|error| error.to_string())?;
                let Some(index) = bucket_indexes.get(&timestamp).copied() else { continue };
                if let Some(value) = utilization { buckets[index].gpu_utilizations.insert(gpu_uuid.clone(), value.clamp(0.0, 100.0)); }
                if let Some(value) = memory_utilization { buckets[index].gpu_memory_utilizations.insert(gpu_uuid.clone(), value.clamp(0.0, 100.0)); }
            }
        }

        Ok(buckets)
    }

    pub fn get_settings(&self) -> Result<AppSettings, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let json: Option<String> = connection.query_row("SELECT value_json FROM settings WHERE key='app'", [], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
        json.map(|value| serde_json::from_str(&value).map_err(|error| error.to_string())).transpose().map(|value| value.unwrap_or_default())
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let json = serde_json::to_string(settings).map_err(|error| error.to_string())?;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection.execute("INSERT INTO settings(key,value_json) VALUES('app',?1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json", [json]).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_idle_reservations(&self) -> Result<Vec<IdleReservation>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection.prepare(
            "SELECT id,name,filters_json,created_at,expires_at,notify_mode,status,matched_gpu_keys_json FROM idle_reservations ORDER BY created_at DESC",
        ).map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| {
            let filters_json: String = row.get(2)?;
            let matched_json: String = row.get(7)?;
            Ok(IdleReservation {
                id: row.get(0)?,
                name: row.get(1)?,
                filters: serde_json::from_str(&filters_json).unwrap_or(serde_json::Value::Null),
                created_at: row.get(3)?,
                expires_at: row.get(4)?,
                notify_mode: row.get(5)?,
                status: row.get(6)?,
                matched_gpu_keys: serde_json::from_str(&matched_json).unwrap_or_default(),
            })
        }).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }

    pub fn save_idle_reservation(&self, reservation: IdleReservation) -> Result<IdleReservation, String> {
        if reservation.id.trim().is_empty() || reservation.name.trim().is_empty() {
            return Err("预约名称不能为空".into());
        }
        if !matches!(reservation.notify_mode.as_str(), "once" | "continuous") {
            return Err("预约通知方式无效".into());
        }
        if !matches!(reservation.status.as_str(), "active" | "paused" | "completed" | "expired") {
            return Err("预约状态无效".into());
        }
        let filters_json = serde_json::to_string(&reservation.filters).map_err(|error| error.to_string())?;
        let matched_json = serde_json::to_string(&reservation.matched_gpu_keys).map_err(|error| error.to_string())?;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection.execute(
            "INSERT INTO idle_reservations(id,name,filters_json,created_at,expires_at,notify_mode,status,matched_gpu_keys_json)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,filters_json=excluded.filters_json,expires_at=excluded.expires_at,notify_mode=excluded.notify_mode,status=excluded.status,matched_gpu_keys_json=excluded.matched_gpu_keys_json",
            params![reservation.id, reservation.name.trim(), filters_json, reservation.created_at, reservation.expires_at, reservation.notify_mode, reservation.status, matched_json],
        ).map_err(|error| error.to_string())?;
        Ok(IdleReservation { name: reservation.name.trim().to_string(), ..reservation })
    }

    pub fn delete_idle_reservation(&self, id: &str) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection.execute("DELETE FROM idle_reservations WHERE id=?1", [id]).map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|text| { let trimmed = text.trim().to_string(); (!trimmed.is_empty()).then_some(trimmed) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{GpuMetric, SystemMetric};

    fn draft(name: &str, retention_days: u32) -> ServerDraft {
        ServerDraft {
            id: None,
            name: name.into(),
            location: None,
            host: "10.0.0.1".into(),
            port: 22,
            username: "test".into(),
            ssh_alias: None,
            identity_file: None,
            proxy_jump: None,
            tags: vec!["lab".into()],
            sampling_interval_seconds: 2,
            history_retention_days: retention_days,
            remote_history_enabled: false,
            auth_method: "sshAgent".into(),
            password: None,
            save_password: false,
        }
    }

    fn snapshot(server_id: &str, timestamp: i64) -> Snapshot {
        Snapshot {
            server_id: server_id.into(),
            hostname: "gpu-test".into(),
            username: "test".into(),
            os_id: "ubuntu".into(),
            os_name: "Ubuntu".into(),
            timestamp,
            status: "online".into(),
            system: SystemMetric { cpu_model: "Test CPU".into(), memory_total_bytes: 1024, ..Default::default() },
            gpus: Vec::new(),
            processes: Vec::new(),
            cpu_processes: Vec::new(),
            processes_sampled: true,
            nvidia_smi: "available".into(),
            nvidia_message: None,
        }
    }

    #[test]
    fn server_round_trip_does_not_store_password() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let saved = db.save_server(ServerDraft { location: Some("Lab 301 / Rack R2".into()), sampling_interval_seconds: 1, password: Some("secret".into()), ..draft("GPU", 30) }).unwrap();
        assert_eq!(saved.sampling_interval_seconds, 2);
        assert_eq!(saved.location.as_deref(), Some("Lab 301 / Rack R2"));
        assert_eq!(db.list_servers().unwrap().len(), 1);
    }

    #[test]
    fn retention_cleanup_is_scoped_to_the_sampled_server() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let short = db.save_server(draft("short", 1)).unwrap();
        let long = db.save_server(ServerDraft { port: 2222, ..draft("long", 30) }).unwrap();
        let old_timestamp = 1_000_000;

        db.save_snapshot(&snapshot(&short.id, old_timestamp)).unwrap();
        db.save_snapshot(&snapshot(&long.id, old_timestamp)).unwrap();
        db.save_snapshot(&snapshot(&short.id, old_timestamp + 2 * 86_400)).unwrap();

        let short_history = db.get_history(&short.id, 0).unwrap();
        let long_history = db.get_history(&long.id, 0).unwrap();
        assert_eq!(short_history.len(), 1);
        assert_eq!(short_history[0].timestamp, old_timestamp + 2 * 86_400);
        assert_eq!(long_history.len(), 1);
        assert_eq!(long_history[0].timestamp, old_timestamp);
    }

    #[test]
    fn retention_is_never_saved_below_one_day() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let saved = db.save_server(draft("GPU", 0)).unwrap();
        assert_eq!(saved.history_retention_days, 1);
    }

    #[test]
    fn aggregates_cpu_and_gpu_history_into_local_three_hour_buckets() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let server = db.save_server(draft("Heatmap", 30)).unwrap();
        let mut first = snapshot(&server.id, 21_600 + 300);
        first.system.cpu_utilization = 20.0;
        first.system.memory_used_bytes = 256;
        first.gpus.push(GpuMetric { index: 0, name: "NVIDIA Test".into(), uuid: "GPU-heatmap".into(), utilization: 40.0, memory_utilization: 0.0, memory_used_mb: 10_240.0, memory_total_mb: 40_960.0, temperature_celsius: 40.0, power_watts: 80.0 });
        let mut second = snapshot(&server.id, 21_600 + 7_200);
        second.system.cpu_utilization = 60.0;
        second.system.memory_used_bytes = 768;
        second.gpus.push(GpuMetric { index: 0, name: "NVIDIA Test".into(), uuid: "GPU-heatmap".into(), utilization: 80.0, memory_utilization: 0.0, memory_used_mb: 30_720.0, memory_total_mb: 40_960.0, temperature_celsius: 40.0, power_watts: 80.0 });
        db.save_snapshot(&first).unwrap();
        db.save_snapshot(&second).unwrap();

        let buckets = db.get_history_heatmap(&server.id, 0, 0, &["GPU-heatmap".into()]).unwrap();
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].timestamp, 21_600);
        assert_eq!(buckets[0].sample_count, 2);
        assert_eq!(buckets[0].cpu_utilization, 40.0);
        assert_eq!(buckets[0].memory_utilization, 50.0);
        assert_eq!(buckets[0].gpu_utilizations.get("GPU-heatmap"), Some(&60.0));
        assert_eq!(buckets[0].gpu_memory_utilizations.get("GPU-heatmap"), Some(&50.0));
    }

    #[test]
    fn imports_remote_history_incrementally_without_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let server = db.save_server(ServerDraft { remote_history_enabled: true, ..draft("Remote", 30) }).unwrap();
        let point = HistoryPoint {
            timestamp: 1_722_700_800,
            cpu_utilization: 12.5,
            memory_utilization: 40.0,
            swap_utilization: 3.0,
            gpu_utilizations: HashMap::from([("GPU-a".into(), 80.0)]),
            gpu_memory_utilizations: HashMap::from([("GPU-a".into(), 50.0)]),
        };

        assert_eq!(db.import_remote_history(&server.id, std::slice::from_ref(&point)).unwrap(), 1);
        assert_eq!(db.import_remote_history(&server.id, std::slice::from_ref(&point)).unwrap(), 0);
        assert_eq!(db.get_history(&server.id, 0).unwrap().len(), 1);
        assert_eq!(db.get_server(&server.id).unwrap().remote_history_last_sync_at, Some(point.timestamp));
        assert_eq!(db.remote_history_cursor(&server.id, point.timestamp + 120).unwrap(), point.timestamp - 60);
    }

    #[test]
    fn idle_reservations_round_trip_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let saved = db.save_idle_reservation(IdleReservation {
            id: "reservation-1".into(),
            name: "  A100 预约  ".into(),
            filters: serde_json::json!({ "gpuMemoryGb": 40, "duration": 0 }),
            created_at: 1_000,
            expires_at: Some(2_000),
            notify_mode: "continuous".into(),
            status: "active".into(),
            matched_gpu_keys: vec!["server-1:gpu-0".into()],
        }).unwrap();
        assert_eq!(saved.name, "A100 预约");

        let reservations = db.list_idle_reservations().unwrap();
        assert_eq!(reservations.len(), 1);
        assert_eq!(reservations[0].filters["gpuMemoryGb"], 40);
        assert_eq!(reservations[0].matched_gpu_keys, vec!["server-1:gpu-0"]);

        db.delete_idle_reservation("reservation-1").unwrap();
        assert!(db.list_idle_reservations().unwrap().is_empty());
    }

    #[test]
    fn rejects_duplicate_connection_targets_and_deletes_history() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let saved = db.save_server(draft("first", 30)).unwrap();
        let duplicate = db.save_server(ServerDraft { name: "duplicate".into(), ..draft("duplicate", 30) });
        assert!(duplicate.unwrap_err().contains("服务器已存在"));

        db.save_snapshot(&snapshot(&saved.id, 1_000_000)).unwrap();
        db.delete_server(&saved.id).unwrap();
        assert!(db.list_servers().unwrap().is_empty());
        assert!(db.get_history(&saved.id, 0).unwrap().is_empty());
    }

    #[test]
    fn migrates_and_stores_capacity_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite");
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch("CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, timestamp INTEGER NOT NULL, cpu_utilization REAL NOT NULL, memory_utilization REAL NOT NULL, gpu_json TEXT NOT NULL, payload_json TEXT NOT NULL);").unwrap();
        drop(legacy);

        let db = Database::open(&path).unwrap();
        let server = db.save_server(draft("GPU memory", 30)).unwrap();
        let mut sample = snapshot(&server.id, 1_000_000);
        sample.system.swap_used_bytes = 512;
        sample.system.swap_total_bytes = 2048;
        sample.gpus.push(GpuMetric { index: 0, name: "NVIDIA Test".into(), uuid: "GPU-memory".into(), utilization: 40.0, memory_utilization: 20.0, memory_used_mb: 10_240.0, memory_total_mb: 40_960.0, temperature_celsius: 40.0, power_watts: 80.0 });
        db.save_snapshot(&sample).unwrap();

        let history = db.get_history(&server.id, 0).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].swap_utilization, 25.0);
        assert_eq!(history[0].gpu_memory_utilizations.get("GPU-memory"), Some(&25.0));
    }

    #[test]
    fn migrates_server_location_without_losing_existing_servers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy-servers.sqlite");
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch(
            "CREATE TABLE servers (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
                username TEXT NOT NULL, ssh_alias TEXT, identity_file TEXT, proxy_jump TEXT,
                tags_json TEXT NOT NULL DEFAULT '[]', sampling_interval_seconds INTEGER NOT NULL DEFAULT 2,
                history_retention_days INTEGER NOT NULL DEFAULT 30, auth_method TEXT NOT NULL DEFAULT 'sshAgent',
                status TEXT NOT NULL DEFAULT 'unknown', last_error TEXT, last_seen_at INTEGER
            );
            INSERT INTO servers (id,name,host,port,username) VALUES ('legacy','Legacy GPU','10.0.0.9',22,'test');",
        ).unwrap();
        drop(legacy);

        let db = Database::open(&path).unwrap();
        let existing = db.get_server("legacy").unwrap();
        assert_eq!(existing.name, "Legacy GPU");
        assert_eq!(existing.location, None);

        let updated = db.save_server(ServerDraft {
            id: Some(existing.id),
            location: Some("Lab 301 / Rack R2 / U18".into()),
            ..draft("Legacy GPU", 30)
        }).unwrap();
        assert_eq!(updated.location.as_deref(), Some("Lab 301 / Rack R2 / U18"));
    }
}
