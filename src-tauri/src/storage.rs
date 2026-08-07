use crate::models::{AppSettings, HistoryHeatmapPoint, HistoryPoint, IdleReservation, Server, ServerDraft, Snapshot, UsageDistribution, UsagePoint, UsageUserAggregate};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

const REMOTE_CLEANUP_TTL_SECONDS: i64 = 86_400;
const RAW_HISTORY_SECONDS: i64 = 3 * 60 * 60;
const TREND_HISTORY_SECONDS: i64 = 72 * 60 * 60;
const LONG_HISTORY_BUCKET_SECONDS: i64 = 10 * 60;

#[derive(Debug, Clone)]
pub struct RemoteCleanupTask {
    pub server: Server,
    pub expires_at: i64,
}

pub struct Database {
    connection: Mutex<Connection>,
    session_passwords: Mutex<HashMap<String, String>>,
    path: PathBuf,
}

#[derive(Default)]
struct HeatmapAccumulator {
    sample_count: i64,
    cpu_sum: f64,
    memory_sum: f64,
    gpu_utilizations: HashMap<String, (f64, i64)>,
    gpu_memory_utilizations: HashMap<String, (f64, i64)>,
}

#[derive(Default)]
struct HourlyHistoryBucket {
    sample_count: i64,
    cpu_sum: f64,
    memory_sum: f64,
    gpu_utilization_sums: HashMap<String, f64>,
    gpu_utilization_counts: HashMap<String, i64>,
    gpu_memory_sums: HashMap<String, f64>,
    gpu_memory_counts: HashMap<String, i64>,
}

struct StoredHistorySample {
    cpu_utilization: f64,
    memory_utilization: f64,
    gpu_utilizations: HashMap<String, f64>,
    gpu_memory_utilizations: HashMap<String, f64>,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompactedHistoryRange {
    #[serde(default)]
    history_range_version: u8,
    #[serde(default)]
    sample_count: i64,
    #[serde(default)]
    cpu_min: f64,
    #[serde(default)]
    cpu_max: f64,
    #[serde(default)]
    memory_min: f64,
    #[serde(default)]
    memory_max: f64,
    #[serde(default)]
    swap_min: f64,
    #[serde(default)]
    swap_max: f64,
    #[serde(default)]
    gpu_mins: HashMap<String, f64>,
    #[serde(default)]
    gpu_maxes: HashMap<String, f64>,
    #[serde(default)]
    gpu_memory_mins: HashMap<String, f64>,
    #[serde(default)]
    gpu_memory_maxes: HashMap<String, f64>,
}

#[derive(Default)]
struct TrendHistoryBucket {
    row_count: i64,
    sample_count: i64,
    cpu_sum: f64,
    memory_sum: f64,
    swap_sum: f64,
    cpu_min: Option<f64>,
    cpu_max: Option<f64>,
    memory_min: Option<f64>,
    memory_max: Option<f64>,
    swap_min: Option<f64>,
    swap_max: Option<f64>,
    gpu_utilization_sums: HashMap<String, f64>,
    gpu_utilization_counts: HashMap<String, i64>,
    gpu_mins: HashMap<String, f64>,
    gpu_maxes: HashMap<String, f64>,
    gpu_memory_sums: HashMap<String, f64>,
    gpu_memory_counts: HashMap<String, i64>,
    gpu_memory_mins: HashMap<String, f64>,
    gpu_memory_maxes: HashMap<String, f64>,
}

fn hour_start(timestamp: i64) -> i64 {
    timestamp - timestamp.rem_euclid(3_600)
}

fn bucket_start(timestamp: i64, bucket_seconds: i64) -> i64 {
    timestamp - timestamp.rem_euclid(bucket_seconds)
}

fn merge_min(target: &mut Option<f64>, value: f64) { *target = Some(target.map_or(value, |current| current.min(value))); }
fn merge_max(target: &mut Option<f64>, value: f64) { *target = Some(target.map_or(value, |current| current.max(value))); }
fn merge_map_min(target: &mut HashMap<String, f64>, values: &HashMap<String, f64>) { for (key, value) in values { target.entry(key.clone()).and_modify(|current| *current = current.min(*value)).or_insert(*value); } }
fn merge_map_max(target: &mut HashMap<String, f64>, values: &HashMap<String, f64>) { for (key, value) in values { target.entry(key.clone()).and_modify(|current| *current = current.max(*value)).or_insert(*value); } }

fn add_trend_sample(bucket: &mut TrendHistoryBucket, cpu: f64, memory: f64, swap: f64, gpu_json: &str, gpu_memory_json: &str, payload_json: &str) {
    let range: CompactedHistoryRange = serde_json::from_str(payload_json).unwrap_or_default();
    let weight = if range.history_range_version == 1 { range.sample_count.max(1) } else { 1 };
    let gpu_values: HashMap<String, f64> = serde_json::from_str(gpu_json).unwrap_or_default();
    let gpu_memory_values: HashMap<String, f64> = serde_json::from_str(gpu_memory_json).unwrap_or_default();
    bucket.row_count += 1;
    bucket.sample_count += weight;
    bucket.cpu_sum += cpu * weight as f64;
    bucket.memory_sum += memory * weight as f64;
    bucket.swap_sum += swap * weight as f64;
    merge_min(&mut bucket.cpu_min, if range.history_range_version == 1 { range.cpu_min } else { cpu });
    merge_max(&mut bucket.cpu_max, if range.history_range_version == 1 { range.cpu_max } else { cpu });
    merge_min(&mut bucket.memory_min, if range.history_range_version == 1 { range.memory_min } else { memory });
    merge_max(&mut bucket.memory_max, if range.history_range_version == 1 { range.memory_max } else { memory });
    merge_min(&mut bucket.swap_min, if range.history_range_version == 1 { range.swap_min } else { swap });
    merge_max(&mut bucket.swap_max, if range.history_range_version == 1 { range.swap_max } else { swap });
    adjust_metric_totals(&mut bucket.gpu_utilization_sums, &mut bucket.gpu_utilization_counts, &gpu_values, weight);
    adjust_metric_totals(&mut bucket.gpu_memory_sums, &mut bucket.gpu_memory_counts, &gpu_memory_values, weight);
    merge_map_min(&mut bucket.gpu_mins, if range.history_range_version == 1 { &range.gpu_mins } else { &gpu_values });
    merge_map_max(&mut bucket.gpu_maxes, if range.history_range_version == 1 { &range.gpu_maxes } else { &gpu_values });
    merge_map_min(&mut bucket.gpu_memory_mins, if range.history_range_version == 1 { &range.gpu_memory_mins } else { &gpu_memory_values });
    merge_map_max(&mut bucket.gpu_memory_maxes, if range.history_range_version == 1 { &range.gpu_memory_maxes } else { &gpu_memory_values });
}

fn insert_compacted_trend(connection: &Connection, server_id: &str, timestamp: i64, bucket: &TrendHistoryBucket) -> Result<(), String> {
    let samples = bucket.sample_count.max(1) as f64;
    let gpu_utilizations: HashMap<String, f64> = bucket.gpu_utilization_sums.iter().filter_map(|(uuid, sum)| {
        let count = bucket.gpu_utilization_counts.get(uuid).copied().unwrap_or_default();
        (count > 0).then_some((uuid.clone(), sum / count as f64))
    }).collect();
    let gpu_memory_utilizations: HashMap<String, f64> = bucket.gpu_memory_sums.iter().filter_map(|(uuid, sum)| {
        let count = bucket.gpu_memory_counts.get(uuid).copied().unwrap_or_default();
        (count > 0).then_some((uuid.clone(), sum / count as f64))
    }).collect();
    let range = CompactedHistoryRange { history_range_version: 1, sample_count: bucket.sample_count, cpu_min: bucket.cpu_min.unwrap_or_default(), cpu_max: bucket.cpu_max.unwrap_or_default(), memory_min: bucket.memory_min.unwrap_or_default(), memory_max: bucket.memory_max.unwrap_or_default(), swap_min: bucket.swap_min.unwrap_or_default(), swap_max: bucket.swap_max.unwrap_or_default(), gpu_mins: bucket.gpu_mins.clone(), gpu_maxes: bucket.gpu_maxes.clone(), gpu_memory_mins: bucket.gpu_memory_mins.clone(), gpu_memory_maxes: bucket.gpu_memory_maxes.clone() };
    connection.execute(
        "INSERT INTO snapshots(server_id,timestamp,cpu_utilization,memory_utilization,swap_utilization,gpu_json,gpu_memory_json,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![server_id, timestamp, bucket.cpu_sum / samples, bucket.memory_sum / samples, bucket.swap_sum / samples, serde_json::to_string(&gpu_utilizations).map_err(|error| error.to_string())?, serde_json::to_string(&gpu_memory_utilizations).map_err(|error| error.to_string())?, serde_json::to_string(&range).map_err(|error| error.to_string())?],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn compact_time_bucket(connection: &Connection, server_id: &str, start: i64, end: i64) -> Result<(), String> {
    let mut bucket = TrendHistoryBucket::default();
    {
        let mut statement = connection.prepare("SELECT cpu_utilization,memory_utilization,swap_utilization,gpu_json,gpu_memory_json,payload_json FROM snapshots WHERE server_id=?1 AND timestamp>=?2 AND timestamp<?3").map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![server_id, start, end], |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?))).map_err(|error| error.to_string())?;
        for row in rows {
            let (cpu, memory, swap, gpu_json, gpu_memory_json, payload_json) = row.map_err(|error| error.to_string())?;
            add_trend_sample(&mut bucket, cpu, memory, swap, &gpu_json, &gpu_memory_json, &payload_json);
        }
    }
    if bucket.row_count > 1 {
        connection.execute("DELETE FROM snapshots WHERE server_id=?1 AND timestamp>=?2 AND timestamp<?3", params![server_id, start, end]).map_err(|error| error.to_string())?;
        insert_compacted_trend(connection, server_id, start, &bucket)?;
    }
    Ok(())
}

fn compact_completed_tiers(connection: &Connection, server_id: &str, latest: i64) -> Result<(), String> {
    let long_end = bucket_start(latest - RAW_HISTORY_SECONDS, LONG_HISTORY_BUCKET_SECONDS);
    compact_time_bucket(connection, server_id, long_end - LONG_HISTORY_BUCKET_SECONDS, long_end)?;
    connection.execute("DELETE FROM snapshots WHERE server_id=?1 AND timestamp<?2", params![server_id, latest - TREND_HISTORY_SECONDS]).map_err(|error| error.to_string())?;
    Ok(())
}

fn compact_server_snapshot_history(connection: &Connection, server_id: &str, latest: i64) -> Result<usize, String> {
    let raw_cutoff = latest - RAW_HISTORY_SECONDS;
    let trend_cutoff = latest - TREND_HISTORY_SECONDS;
    let mut buckets: BTreeMap<i64, TrendHistoryBucket> = BTreeMap::new();
    {
        let mut statement = connection.prepare("SELECT timestamp,cpu_utilization,memory_utilization,swap_utilization,gpu_json,gpu_memory_json,payload_json FROM snapshots WHERE server_id=?1 AND timestamp>=?2 AND timestamp<?3 ORDER BY timestamp").map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![server_id, trend_cutoff, raw_cutoff], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?, row.get::<_, f64>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?))).map_err(|error| error.to_string())?;
        for row in rows {
            let (timestamp, cpu, memory, swap, gpu_json, gpu_memory_json, payload_json) = row.map_err(|error| error.to_string())?;
            add_trend_sample(buckets.entry(bucket_start(timestamp, LONG_HISTORY_BUCKET_SECONDS)).or_default(), cpu, memory, swap, &gpu_json, &gpu_memory_json, &payload_json);
        }
    }
    let removed = connection.execute("DELETE FROM snapshots WHERE server_id=?1 AND timestamp<?2", params![server_id, raw_cutoff]).map_err(|error| error.to_string())?;
    for (timestamp, bucket) in buckets { insert_compacted_trend(connection, server_id, timestamp, &bucket)?; }
    Ok(removed)
}

fn compact_existing_snapshot_history(connection: &mut Connection) -> Result<usize, String> {
    let servers = {
        let mut statement = connection.prepare("SELECT server_id,MAX(timestamp) FROM snapshots GROUP BY server_id").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let mut removed = 0usize;
    for (server_id, latest) in servers { removed += compact_server_snapshot_history(&transaction, &server_id, latest)?; }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(removed)
}

fn adjust_metric_totals(sums: &mut HashMap<String, f64>, counts: &mut HashMap<String, i64>, values: &HashMap<String, f64>, direction: i64) {
    for (uuid, value) in values {
        *sums.entry(uuid.clone()).or_default() += *value * direction as f64;
        *counts.entry(uuid.clone()).or_default() += direction;
        if counts.get(uuid).copied().unwrap_or_default() <= 0 {
            counts.remove(uuid);
            sums.remove(uuid);
        }
    }
}

fn update_hourly_history_bucket(connection: &Connection, server_id: &str, timestamp: i64, previous: Option<&StoredHistorySample>, next: &StoredHistorySample) -> Result<(), String> {
    let bucket_timestamp = hour_start(timestamp);
    let mut bucket = connection.query_row(
        "SELECT sample_count,cpu_sum,memory_sum,gpu_utilization_sums_json,gpu_utilization_counts_json,gpu_memory_sums_json,gpu_memory_counts_json
         FROM history_hourly_buckets WHERE server_id=?1 AND timestamp=?2",
        params![server_id, bucket_timestamp],
        |row| {
            Ok(HourlyHistoryBucket {
                sample_count: row.get(0)?,
                cpu_sum: row.get(1)?,
                memory_sum: row.get(2)?,
                gpu_utilization_sums: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
                gpu_utilization_counts: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
                gpu_memory_sums: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
                gpu_memory_counts: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
            })
        },
    ).optional().map_err(|error| error.to_string())?.unwrap_or_default();

    if let Some(previous) = previous {
        bucket.cpu_sum -= previous.cpu_utilization;
        bucket.memory_sum -= previous.memory_utilization;
        adjust_metric_totals(&mut bucket.gpu_utilization_sums, &mut bucket.gpu_utilization_counts, &previous.gpu_utilizations, -1);
        adjust_metric_totals(&mut bucket.gpu_memory_sums, &mut bucket.gpu_memory_counts, &previous.gpu_memory_utilizations, -1);
    } else {
        bucket.sample_count += 1;
    }
    bucket.cpu_sum += next.cpu_utilization;
    bucket.memory_sum += next.memory_utilization;
    adjust_metric_totals(&mut bucket.gpu_utilization_sums, &mut bucket.gpu_utilization_counts, &next.gpu_utilizations, 1);
    adjust_metric_totals(&mut bucket.gpu_memory_sums, &mut bucket.gpu_memory_counts, &next.gpu_memory_utilizations, 1);

    connection.execute(
        "INSERT INTO history_hourly_buckets(server_id,timestamp,sample_count,cpu_sum,memory_sum,gpu_utilization_sums_json,gpu_utilization_counts_json,gpu_memory_sums_json,gpu_memory_counts_json)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(server_id,timestamp) DO UPDATE SET sample_count=excluded.sample_count,cpu_sum=excluded.cpu_sum,memory_sum=excluded.memory_sum,gpu_utilization_sums_json=excluded.gpu_utilization_sums_json,gpu_utilization_counts_json=excluded.gpu_utilization_counts_json,gpu_memory_sums_json=excluded.gpu_memory_sums_json,gpu_memory_counts_json=excluded.gpu_memory_counts_json",
        params![
            server_id,
            bucket_timestamp,
            bucket.sample_count,
            bucket.cpu_sum,
            bucket.memory_sum,
            serde_json::to_string(&bucket.gpu_utilization_sums).map_err(|error| error.to_string())?,
            serde_json::to_string(&bucket.gpu_utilization_counts).map_err(|error| error.to_string())?,
            serde_json::to_string(&bucket.gpu_memory_sums).map_err(|error| error.to_string())?,
            serde_json::to_string(&bucket.gpu_memory_counts).map_err(|error| error.to_string())?,
        ],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn rebuild_hourly_history_buckets(connection: &mut Connection) -> Result<(), String> {
    let mut buckets: BTreeMap<(String, i64), HourlyHistoryBucket> = BTreeMap::new();
    {
        let mut statement = connection.prepare(
            "SELECT server_id,timestamp,cpu_utilization,memory_utilization,gpu_json,gpu_memory_json FROM snapshots ORDER BY server_id,timestamp"
        ).map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, f64>(2)?, row.get::<_, f64>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?))
        }).map_err(|error| error.to_string())?;
        for row in rows {
            let (server_id, timestamp, cpu, memory, gpu_json, gpu_memory_json) = row.map_err(|error| error.to_string())?;
            let bucket = buckets.entry((server_id, hour_start(timestamp))).or_default();
            bucket.sample_count += 1;
            bucket.cpu_sum += cpu;
            bucket.memory_sum += memory;
            adjust_metric_totals(&mut bucket.gpu_utilization_sums, &mut bucket.gpu_utilization_counts, &serde_json::from_str(&gpu_json).unwrap_or_default(), 1);
            adjust_metric_totals(&mut bucket.gpu_memory_sums, &mut bucket.gpu_memory_counts, &serde_json::from_str(&gpu_memory_json).unwrap_or_default(), 1);
        }
    }
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM history_hourly_buckets", []).map_err(|error| error.to_string())?;
    for ((server_id, timestamp), bucket) in buckets {
        transaction.execute(
            "INSERT INTO history_hourly_buckets(server_id,timestamp,sample_count,cpu_sum,memory_sum,gpu_utilization_sums_json,gpu_utilization_counts_json,gpu_memory_sums_json,gpu_memory_counts_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![server_id, timestamp, bucket.sample_count, bucket.cpu_sum, bucket.memory_sum, serde_json::to_string(&bucket.gpu_utilization_sums).map_err(|error| error.to_string())?, serde_json::to_string(&bucket.gpu_utilization_counts).map_err(|error| error.to_string())?, serde_json::to_string(&bucket.gpu_memory_sums).map_err(|error| error.to_string())?, serde_json::to_string(&bucket.gpu_memory_counts).map_err(|error| error.to_string())?],
        ).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
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
                    sort_order INTEGER NOT NULL DEFAULT 0,
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
                 CREATE TABLE IF NOT EXISTS history_hourly_buckets (
                    server_id TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    sample_count INTEGER NOT NULL,
                    cpu_sum REAL NOT NULL,
                    memory_sum REAL NOT NULL,
                    gpu_utilization_sums_json TEXT NOT NULL DEFAULT '{}',
                    gpu_utilization_counts_json TEXT NOT NULL DEFAULT '{}',
                    gpu_memory_sums_json TEXT NOT NULL DEFAULT '{}',
                    gpu_memory_counts_json TEXT NOT NULL DEFAULT '{}',
                    PRIMARY KEY(server_id,timestamp),
                    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_history_hourly_lookup ON history_hourly_buckets(server_id,timestamp);
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
                 );
                 CREATE TABLE IF NOT EXISTS usage_buckets (
                    server_id TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    gpu_uuid TEXT NOT NULL,
                    username TEXT NOT NULL,
                    active_seconds INTEGER NOT NULL,
                    memory_mb_seconds REAL NOT NULL,
                    coverage_seconds INTEGER NOT NULL,
                    PRIMARY KEY(server_id,timestamp,gpu_uuid,username),
                    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_usage_lookup ON usage_buckets(server_id,timestamp);",
            )
            .map_err(|error| error.to_string())?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS remote_cleanup_queue (
                server_id TEXT PRIMARY KEY,
                server_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                last_error TEXT
             );"
        ).map_err(|error| error.to_string())?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS storage_migrations (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);").map_err(|error| error.to_string())?;
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
        if !server_columns.contains("sort_order") {
            connection.execute("ALTER TABLE servers ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0", []).map_err(|error| error.to_string())?;
        }
        let reservation_columns = {
            let mut statement = connection.prepare("PRAGMA table_info(idle_reservations)").map_err(|error| error.to_string())?;
            let columns = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?;
            columns.filter_map(Result::ok).collect::<HashSet<_>>()
        };
        if !reservation_columns.contains("current_available_gpu_keys_json") {
            connection.execute("ALTER TABLE idle_reservations ADD COLUMN current_available_gpu_keys_json TEXT NOT NULL DEFAULT '[]'", []).map_err(|error| error.to_string())?;
        }
        if !reservation_columns.contains("pending_confirmation_gpu_keys_json") {
            connection.execute("ALTER TABLE idle_reservations ADD COLUMN pending_confirmation_gpu_keys_json TEXT NOT NULL DEFAULT '[]'", []).map_err(|error| error.to_string())?;
        }
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS local_usage_minutes (
                server_id TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                PRIMARY KEY(server_id,timestamp),
                FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
             );"
        ).map_err(|error| error.to_string())?;
        connection.execute(
            "DELETE FROM snapshots WHERE id NOT IN (SELECT MAX(id) FROM snapshots GROUP BY server_id,timestamp)",
            [],
        ).map_err(|error| error.to_string())?;
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_unique ON snapshots(server_id,timestamp)", []).map_err(|error| error.to_string())?;
        let hourly_bucket_count: i64 = connection.query_row("SELECT COUNT(*) FROM history_hourly_buckets", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        let snapshot_count: i64 = connection.query_row("SELECT COUNT(*) FROM snapshots", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        if hourly_bucket_count == 0 && snapshot_count > 0 {
            rebuild_hourly_history_buckets(&mut connection)?;
        }
        let tier_migration_applied: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM storage_migrations WHERE key='snapshot-tier-v2')", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        if !tier_migration_applied && snapshot_count > 0 {
            let removed_snapshots = compact_existing_snapshot_history(&mut connection)?;
            connection.execute("INSERT INTO storage_migrations(key,applied_at) VALUES('snapshot-tier-v2',unixepoch())", []).map_err(|error| error.to_string())?;
            if removed_snapshots > 0 {
                connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;").map_err(|error| error.to_string())?;
            }
        }
        Ok(Self { connection: Mutex::new(connection), session_passwords: Mutex::new(HashMap::new()), path: path.to_path_buf() })
    }

    pub fn storage_size_bytes(&self) -> u64 {
        let sidecar = |suffix: &str| {
            let mut value = self.path.as_os_str().to_os_string();
            value.push(suffix);
            PathBuf::from(value)
        };
        let wal_path = sidecar("-wal");
        let shm_path = sidecar("-shm");
        [&self.path, &wal_path, &shm_path]
            .into_iter()
            .filter_map(|path| std::fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .sum()
    }

    pub fn list_servers(&self) -> Result<Vec<Server>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare("SELECT id,name,location,host,port,username,ssh_alias,identity_file,proxy_jump,tags_json,sampling_interval_seconds,history_retention_days,remote_history_enabled,remote_history_last_sync_at,auth_method,status,last_error,last_seen_at,sort_order FROM servers ORDER BY sort_order,name COLLATE NOCASE")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                let tags: String = row.get(9)?;
                Ok(Server {
                    id: row.get(0)?, name: row.get(1)?, location: row.get(2)?, host: row.get(3)?, port: row.get(4)?, username: row.get(5)?,
                    ssh_alias: row.get(6)?, identity_file: row.get(7)?, proxy_jump: row.get(8)?,
                    tags: serde_json::from_str(&tags).unwrap_or_default(), sampling_interval_seconds: row.get(10)?,
                    history_retention_days: row.get(11)?, remote_history_enabled: row.get(12)?, remote_history_last_sync_at: row.get(13)?,
                    auth_method: row.get(14)?, status: row.get(15)?, last_error: row.get(16)?, last_seen_at: row.get(17)?, sort_order: row.get(18)?,
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
            "INSERT INTO servers (id,name,location,host,port,username,ssh_alias,identity_file,proxy_jump,tags_json,sampling_interval_seconds,history_retention_days,remote_history_enabled,auth_method,status,sort_order)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'unknown',COALESCE((SELECT MAX(sort_order)+1 FROM servers),0))
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

    pub fn reorder_servers(&self, server_ids: &[String]) -> Result<(), String> {
        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        for (index, id) in server_ids.iter().enumerate() {
            transaction.execute("UPDATE servers SET sort_order=?2 WHERE id=?1", params![id, index as i64]).map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn delete_server(&self, id: &str) -> Result<(), String> {
        self.delete_server_record(id, true)
    }

    pub fn delete_server_record(&self, id: &str, delete_credential: bool) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection.execute("DELETE FROM servers WHERE id=?1", [id]).map_err(|error| error.to_string())?;
        if delete_credential {
            if let Ok(entry) = keyring::Entry::new("com.racktop.desktop", id) {
                let _ = entry.delete_credential();
            }
            self.session_passwords.lock().map_err(|error| error.to_string())?.remove(id);
        }
        Ok(())
    }

    pub fn enqueue_remote_cleanup(&self, server: &Server, now: i64, error: &str) -> Result<(), String> {
        let server_json = serde_json::to_string(server).map_err(|error| error.to_string())?;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection.execute(
            "INSERT INTO remote_cleanup_queue (server_id,server_json,created_at,expires_at,last_error) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(server_id) DO UPDATE SET server_json=excluded.server_json,expires_at=excluded.expires_at,last_error=excluded.last_error",
            params![server.id, server_json, now, now + REMOTE_CLEANUP_TTL_SECONDS, error],
        ).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_remote_cleanup_tasks(&self) -> Result<Vec<RemoteCleanupTask>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection.prepare("SELECT server_json,expires_at,last_error FROM remote_cleanup_queue ORDER BY created_at").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| {
            let server_json: String = row.get(0)?;
            Ok(RemoteCleanupTask { server: serde_json::from_str(&server_json).map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error)))?, expires_at: row.get(1)? })
        }).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }

    pub fn update_remote_cleanup_error(&self, server_id: &str, error: &str) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection.execute("UPDATE remote_cleanup_queue SET last_error=?2 WHERE server_id=?1", params![server_id, error]).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn finish_remote_cleanup(&self, server_id: &str) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection.execute("DELETE FROM remote_cleanup_queue WHERE server_id=?1", [server_id]).map_err(|error| error.to_string())?;
        drop(connection);
        if let Ok(entry) = keyring::Entry::new("com.racktop.desktop", server_id) {
            let _ = entry.delete_credential();
        }
        self.session_passwords.lock().map_err(|error| error.to_string())?.remove(server_id);
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
        let gpu_map: HashMap<String, f64> = snapshot.gpus.iter().map(|gpu| (gpu.uuid.clone(), gpu.utilization)).collect();
        let gpu_memory_map: HashMap<String, f64> = snapshot.gpus.iter().map(|gpu| (gpu.uuid.clone(), if gpu.memory_total_mb > 0.0 { (gpu.memory_used_mb / gpu.memory_total_mb * 100.0).clamp(0.0, 100.0) } else { 0.0 })).collect();
        let next_sample = StoredHistorySample { cpu_utilization: snapshot.system.cpu_utilization, memory_utilization, gpu_utilizations: gpu_map, gpu_memory_utilizations: gpu_memory_map };
        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        let previous = transaction.query_row(
            "SELECT cpu_utilization,memory_utilization,gpu_json,gpu_memory_json FROM snapshots WHERE server_id=?1 AND timestamp=?2",
            params![snapshot.server_id, snapshot.timestamp],
            |row| Ok(StoredHistorySample {
                cpu_utilization: row.get(0)?,
                memory_utilization: row.get(1)?,
                gpu_utilizations: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default(),
                gpu_memory_utilizations: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
            }),
        ).optional().map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO snapshots(server_id,timestamp,cpu_utilization,memory_utilization,swap_utilization,gpu_json,gpu_memory_json,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(server_id,timestamp) DO UPDATE SET cpu_utilization=excluded.cpu_utilization,memory_utilization=excluded.memory_utilization,swap_utilization=excluded.swap_utilization,gpu_json=excluded.gpu_json,gpu_memory_json=excluded.gpu_memory_json,payload_json=excluded.payload_json",
            params![snapshot.server_id, snapshot.timestamp, next_sample.cpu_utilization, next_sample.memory_utilization, swap_utilization, serde_json::to_string(&next_sample.gpu_utilizations).unwrap_or_else(|_| "{}".into()), serde_json::to_string(&next_sample.gpu_memory_utilizations).unwrap_or_else(|_| "{}".into()), serde_json::to_string(snapshot).map_err(|error| error.to_string())?],
        ).map_err(|error| error.to_string())?;
        update_hourly_history_bucket(&transaction, &snapshot.server_id, snapshot.timestamp, previous.as_ref(), &next_sample)?;
        compact_completed_tiers(&transaction, &snapshot.server_id, snapshot.timestamp)?;
        let cutoff = snapshot.timestamp - i64::from(server.history_retention_days) * 86_400;
        transaction.execute("DELETE FROM history_hourly_buckets WHERE server_id=?1 AND timestamp < ?2", params![snapshot.server_id, hour_start(cutoff)]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
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
        let mut imported_points = Vec::new();
        {
            let mut statement = transaction.prepare(
                "INSERT INTO snapshots(server_id,timestamp,cpu_utilization,memory_utilization,swap_utilization,gpu_json,gpu_memory_json,payload_json)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,'{}') ON CONFLICT(server_id,timestamp) DO NOTHING"
            ).map_err(|error| error.to_string())?;
            for point in points.iter().filter(|point| point.timestamp >= cutoff) {
                let inserted = statement.execute(params![
                    server_id,
                    point.timestamp,
                    point.cpu_utilization,
                    point.memory_utilization,
                    point.swap_utilization,
                    serde_json::to_string(&point.gpu_utilizations).map_err(|error| error.to_string())?,
                    serde_json::to_string(&point.gpu_memory_utilizations).map_err(|error| error.to_string())?,
                ]).map_err(|error| error.to_string())?;
                imported += inserted;
                if inserted > 0 { imported_points.push(point); }
            }
        }
        for point in imported_points {
            let sample = StoredHistorySample {
                cpu_utilization: point.cpu_utilization,
                memory_utilization: point.memory_utilization,
                gpu_utilizations: point.gpu_utilizations.clone(),
                gpu_memory_utilizations: point.gpu_memory_utilizations.clone(),
            };
            update_hourly_history_bucket(&transaction, server_id, point.timestamp, None, &sample)?;
        }
        compact_server_snapshot_history(&transaction, server_id, latest)?;
        transaction.execute("DELETE FROM history_hourly_buckets WHERE server_id=?1 AND timestamp < ?2", params![server_id, hour_start(cutoff)]).map_err(|error| error.to_string())?;
        transaction.execute(
            "UPDATE servers SET remote_history_last_sync_at=MAX(COALESCE(remote_history_last_sync_at,0),?2) WHERE id=?1",
            params![server_id, latest],
        ).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(imported)
    }

    pub fn import_remote_usage(&self, server_id: &str, points: &[UsagePoint], now: i64) -> Result<usize, String> {
        if points.is_empty() { return Ok(0); }
        let cutoff = now - 90 * 86_400;
        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        let mut imported = 0usize;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO usage_buckets(server_id,timestamp,gpu_uuid,username,active_seconds,memory_mb_seconds,coverage_seconds)
                 SELECT ?1,?2,?3,?4,?5,?6,?7
                 WHERE NOT EXISTS (SELECT 1 FROM local_usage_minutes WHERE server_id=?1 AND timestamp=?2)
                 ON CONFLICT(server_id,timestamp,gpu_uuid,username) DO UPDATE SET active_seconds=excluded.active_seconds,memory_mb_seconds=excluded.memory_mb_seconds,coverage_seconds=excluded.coverage_seconds"
            ).map_err(|error| error.to_string())?;
            for point in points.iter().filter(|point| point.timestamp >= cutoff && point.timestamp <= now + 300) {
                imported += statement.execute(params![server_id, point.timestamp, point.gpu_uuid, point.username, point.active_seconds, point.memory_mb_seconds, point.coverage_seconds]).map_err(|error| error.to_string())?;
            }
        }
        transaction.execute("DELETE FROM usage_buckets WHERE server_id=?1 AND timestamp < ?2", params![server_id, cutoff]).map_err(|error| error.to_string())?;
        transaction.execute("DELETE FROM local_usage_minutes WHERE server_id=?1 AND timestamp < ?2", params![server_id, cutoff]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(imported)
    }

    pub fn save_local_usage(&self, snapshot: &Snapshot) -> Result<usize, String> {
        if !self.get_settings()?.history_enabled || snapshot.gpus.is_empty() { return Ok(0); }
        let timestamp = snapshot.timestamp - snapshot.timestamp.rem_euclid(60);
        let cutoff = timestamp - 90 * 86_400;
        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        let claimed = transaction.execute(
            "INSERT OR IGNORE INTO local_usage_minutes(server_id,timestamp) VALUES(?1,?2)",
            params![snapshot.server_id, timestamp],
        ).map_err(|error| error.to_string())?;
        if claimed == 0 {
            transaction.commit().map_err(|error| error.to_string())?;
            return Ok(0);
        }

        transaction.execute(
            "DELETE FROM usage_buckets WHERE server_id=?1 AND timestamp=?2",
            params![snapshot.server_id, timestamp],
        ).map_err(|error| error.to_string())?;
        let gpu_uuids: HashSet<&str> = snapshot.gpus.iter().map(|gpu| gpu.uuid.as_str()).collect();
        let mut memory_by_user: HashMap<(&str, &str), f64> = HashMap::new();
        for process in snapshot.processes.iter().filter(|process| {
            gpu_uuids.contains(process.gpu_uuid.as_str()) && is_attributable_gpu_process(&process.username, &process.command)
        }) {
            *memory_by_user.entry((process.gpu_uuid.as_str(), process.username.as_str())).or_default() += process.memory_used_mb.max(0.0);
        }
        let mut inserted = 0usize;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO usage_buckets(server_id,timestamp,gpu_uuid,username,active_seconds,memory_mb_seconds,coverage_seconds)
                 VALUES(?1,?2,?3,?4,?5,?6,60)"
            ).map_err(|error| error.to_string())?;
            for gpu in &snapshot.gpus {
                inserted += statement.execute(params![snapshot.server_id, timestamp, gpu.uuid, USAGE_COVERAGE_USER, 0, 0.0]).map_err(|error| error.to_string())?;
            }
            for ((gpu_uuid, username), memory_mb) in memory_by_user {
                inserted += statement.execute(params![snapshot.server_id, timestamp, gpu_uuid, username, 60, memory_mb * 60.0]).map_err(|error| error.to_string())?;
            }
        }
        transaction.execute("DELETE FROM usage_buckets WHERE server_id=?1 AND timestamp < ?2", params![snapshot.server_id, cutoff]).map_err(|error| error.to_string())?;
        transaction.execute("DELETE FROM local_usage_minutes WHERE server_id=?1 AND timestamp < ?2", params![snapshot.server_id, cutoff]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(inserted)
    }

    pub fn get_usage_distribution(&self, server_id: &str, from_timestamp: i64, requested_days: i64) -> Result<UsageDistribution, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection.prepare(
            "SELECT username,SUM(active_seconds),SUM(memory_mb_seconds) FROM usage_buckets WHERE server_id=?1 AND timestamp>=?2 AND username<>?3 GROUP BY username ORDER BY SUM(active_seconds) DESC"
        ).map_err(|error| error.to_string())?;
        let users = statement.query_map(params![server_id, from_timestamp, USAGE_COVERAGE_USER], |row| Ok(UsageUserAggregate { username: row.get(0)?, active_seconds: row.get(1)?, memory_mb_seconds: row.get(2)? }))
            .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        let covered_days = connection.query_row(
            "SELECT COUNT(DISTINCT date(timestamp,'unixepoch')) FROM usage_buckets WHERE server_id=?1 AND timestamp>=?2",
            params![server_id, from_timestamp], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        let coverage_gpu_seconds = connection.query_row(
            "SELECT COALESCE(SUM(coverage),0) FROM (SELECT timestamp,gpu_uuid,MAX(coverage_seconds) AS coverage FROM usage_buckets WHERE server_id=?1 AND timestamp>=?2 GROUP BY timestamp,gpu_uuid)",
            params![server_id, from_timestamp], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        Ok(UsageDistribution { users, covered_days, requested_days, coverage_gpu_seconds })
    }

    pub fn get_history(&self, server_id: &str, from_timestamp: i64) -> Result<Vec<HistoryPoint>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection.prepare("SELECT timestamp,cpu_utilization,memory_utilization,swap_utilization,gpu_json,gpu_memory_json,payload_json FROM snapshots WHERE server_id=?1 AND timestamp>=?2 ORDER BY timestamp").map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![server_id, from_timestamp], |row| {
            let gpu_json: String = row.get(4)?;
            let gpu_memory_json: String = row.get(5)?;
            let payload_json: String = row.get(6)?;
            let cpu_utilization = row.get(1)?;
            let memory_utilization = row.get(2)?;
            let swap_utilization = row.get(3)?;
            let gpu_utilizations: HashMap<String, f64> = serde_json::from_str(&gpu_json).unwrap_or_default();
            let gpu_memory_utilizations: HashMap<String, f64> = serde_json::from_str(&gpu_memory_json).unwrap_or_default();
            let range: CompactedHistoryRange = serde_json::from_str(&payload_json).unwrap_or_default();
            let compacted = range.history_range_version == 1;
            Ok(HistoryPoint { timestamp: row.get(0)?, cpu_utilization, memory_utilization, swap_utilization, cpu_min: if compacted { range.cpu_min } else { cpu_utilization }, cpu_max: if compacted { range.cpu_max } else { cpu_utilization }, memory_min: if compacted { range.memory_min } else { memory_utilization }, memory_max: if compacted { range.memory_max } else { memory_utilization }, swap_min: if compacted { range.swap_min } else { swap_utilization }, swap_max: if compacted { range.swap_max } else { swap_utilization }, gpu_mins: if compacted { range.gpu_mins } else { gpu_utilizations.clone() }, gpu_maxes: if compacted { range.gpu_maxes } else { gpu_utilizations.clone() }, gpu_memory_mins: if compacted { range.gpu_memory_mins } else { gpu_memory_utilizations.clone() }, gpu_memory_maxes: if compacted { range.gpu_memory_maxes } else { gpu_memory_utilizations.clone() }, gpu_utilizations, gpu_memory_utilizations })
        }).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }

    pub fn get_history_heatmap(&self, server_id: &str, from_timestamp: i64, timezone_offset_seconds: i64, gpu_uuids: &[String]) -> Result<Vec<HistoryHeatmapPoint>, String> {
        const BUCKET_SECONDS: i64 = 3 * 60 * 60;
        let offset = timezone_offset_seconds.clamp(-86_400, 86_400);
        let requested_gpus: HashSet<&str> = gpu_uuids.iter().map(String::as_str).collect();
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection.prepare(
            "SELECT ((timestamp + ?3) / ?4) * ?4 - ?3 AS bucket,
                    sample_count,cpu_sum,memory_sum,gpu_utilization_sums_json,gpu_utilization_counts_json,gpu_memory_sums_json,gpu_memory_counts_json
             FROM history_hourly_buckets
             WHERE server_id=?1 AND timestamp>=?2
             ORDER BY timestamp"
        ).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![server_id, hour_start(from_timestamp), offset, BUCKET_SECONDS], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, f64>(2)?, row.get::<_, f64>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?))
        }).map_err(|error| error.to_string())?;
        let mut accumulators: BTreeMap<i64, HeatmapAccumulator> = BTreeMap::new();
        for row in rows {
            let (timestamp, sample_count, cpu_sum, memory_sum, gpu_sums_json, gpu_counts_json, gpu_memory_sums_json, gpu_memory_counts_json) = row.map_err(|error| error.to_string())?;
            let accumulator = accumulators.entry(timestamp).or_default();
            accumulator.sample_count += sample_count;
            accumulator.cpu_sum += cpu_sum;
            accumulator.memory_sum += memory_sum;
            let gpu_counts: HashMap<String, i64> = serde_json::from_str(&gpu_counts_json).unwrap_or_default();
            for (gpu_uuid, value) in serde_json::from_str::<HashMap<String, f64>>(&gpu_sums_json).unwrap_or_default() {
                if !requested_gpus.contains(gpu_uuid.as_str()) { continue; }
                let count = gpu_counts.get(&gpu_uuid).copied().unwrap_or_default();
                let total = accumulator.gpu_utilizations.entry(gpu_uuid).or_default();
                total.0 += value;
                total.1 += count;
            }
            let gpu_memory_counts: HashMap<String, i64> = serde_json::from_str(&gpu_memory_counts_json).unwrap_or_default();
            for (gpu_uuid, value) in serde_json::from_str::<HashMap<String, f64>>(&gpu_memory_sums_json).unwrap_or_default() {
                if !requested_gpus.contains(gpu_uuid.as_str()) { continue; }
                let count = gpu_memory_counts.get(&gpu_uuid).copied().unwrap_or_default();
                let total = accumulator.gpu_memory_utilizations.entry(gpu_uuid).or_default();
                total.0 += value;
                total.1 += count;
            }
        }
        Ok(accumulators.into_iter().map(|(timestamp, accumulator)| {
            let samples = accumulator.sample_count.max(1) as f64;
            HistoryHeatmapPoint {
                timestamp,
                sample_count: accumulator.sample_count,
                cpu_utilization: (accumulator.cpu_sum / samples).clamp(0.0, 100.0),
                memory_utilization: (accumulator.memory_sum / samples).clamp(0.0, 100.0),
                gpu_utilizations: accumulator.gpu_utilizations.into_iter().filter_map(|(uuid, (sum, count))| (count > 0).then_some((uuid, (sum / count as f64).clamp(0.0, 100.0)))).collect(),
                gpu_memory_utilizations: accumulator.gpu_memory_utilizations.into_iter().filter_map(|(uuid, (sum, count))| (count > 0).then_some((uuid, (sum / count as f64).clamp(0.0, 100.0)))).collect(),
            }
        }).collect())
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
            "SELECT id,name,filters_json,created_at,expires_at,notify_mode,status,matched_gpu_keys_json,current_available_gpu_keys_json,pending_confirmation_gpu_keys_json FROM idle_reservations ORDER BY created_at DESC",
        ).map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| {
            let filters_json: String = row.get(2)?;
            let matched_json: String = row.get(7)?;
            let current_json: String = row.get(8)?;
            let pending_json: String = row.get(9)?;
            Ok(IdleReservation {
                id: row.get(0)?,
                name: row.get(1)?,
                filters: serde_json::from_str(&filters_json).unwrap_or(serde_json::Value::Null),
                created_at: row.get(3)?,
                expires_at: row.get(4)?,
                notify_mode: row.get(5)?,
                status: row.get(6)?,
                matched_gpu_keys: serde_json::from_str(&matched_json).unwrap_or_default(),
                current_available_gpu_keys: serde_json::from_str(&current_json).unwrap_or_default(),
                pending_confirmation_gpu_keys: serde_json::from_str(&pending_json).unwrap_or_default(),
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
        let current_json = serde_json::to_string(&reservation.current_available_gpu_keys).map_err(|error| error.to_string())?;
        let pending_json = serde_json::to_string(&reservation.pending_confirmation_gpu_keys).map_err(|error| error.to_string())?;
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        connection.execute(
            "INSERT INTO idle_reservations(id,name,filters_json,created_at,expires_at,notify_mode,status,matched_gpu_keys_json,current_available_gpu_keys_json,pending_confirmation_gpu_keys_json)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,filters_json=excluded.filters_json,expires_at=excluded.expires_at,notify_mode=excluded.notify_mode,status=excluded.status,matched_gpu_keys_json=excluded.matched_gpu_keys_json,current_available_gpu_keys_json=excluded.current_available_gpu_keys_json,pending_confirmation_gpu_keys_json=excluded.pending_confirmation_gpu_keys_json",
            params![reservation.id, reservation.name.trim(), filters_json, reservation.created_at, reservation.expires_at, reservation.notify_mode, reservation.status, matched_json, current_json, pending_json],
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

const USAGE_COVERAGE_USER: &str = "__racktop_coverage__";

fn is_attributable_gpu_process(username: &str, command: &str) -> bool {
    const SYSTEM_USERS: &[&str] = &["root", "unknown", "gdm", "lightdm", "sddm"];
    const SERVICE_PATTERNS: &[&str] = &[
        "xorg", "xwayland", "gnome-shell", "nvidia-persistenced", "nvidia-powerd", "nvitop", "nvtop",
        ".vscode-server", "code-server", ".cursor-server", "cursor-server", "codex", "claude",
        "tailscale", "zerotier", "openvpn", "openconnect", "wireguard", "clash", "mihomo", "sing-box", "v2ray", "xray", "cloudflared",
    ];
    let username = username.trim().to_ascii_lowercase();
    let command = command.to_ascii_lowercase();
    !username.is_empty() && !SYSTEM_USERS.contains(&username.as_str()) && !SERVICE_PATTERNS.iter().any(|pattern| command.contains(pattern))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{GpuMetric, ProcessMetric, SystemMetric};

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
            disks: Vec::new(),
            processes: Vec::new(),
            cpu_processes: Vec::new(),
            processes_sampled: true,
            nvidia_smi: "available".into(),
            nvidia_message: None,
        }
    }

    #[test]
    fn reports_sqlite_database_and_sidecar_storage_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("size.sqlite");
        let db = Database::open(&path).unwrap();
        db.save_server(draft("Size", 90)).unwrap();
        let expected = [path.clone(), PathBuf::from(format!("{}-wal", path.display())), PathBuf::from(format!("{}-shm", path.display()))]
            .iter()
            .filter_map(|file| std::fs::metadata(file).ok())
            .map(|metadata| metadata.len())
            .sum::<u64>();
        assert!(expected > 0);
        assert_eq!(db.storage_size_bytes(), expected);
    }

    fn gpu_process(gpu_uuid: &str, username: &str, command: &str, memory_used_mb: f64) -> ProcessMetric {
        ProcessMetric {
            gpu_uuid: gpu_uuid.into(),
            gpu_index: 0,
            pid: 100,
            parent_pid: 1,
            username: username.into(),
            command: command.into(),
            memory_used_mb,
            sm_utilization: None,
            cpu_percent: 1.0,
            elapsed: "00:01".into(),
            is_current_user: true,
            is_group_leader: true,
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
    fn server_order_can_be_rearranged_and_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let first = db.save_server(draft("first", 30)).unwrap();
        let second = db.save_server(ServerDraft { port: 2222, ..draft("second", 30) }).unwrap();
        db.reorder_servers(&[second.id.clone(), first.id.clone()]).unwrap();
        let ordered = db.list_servers().unwrap();
        assert_eq!(ordered.iter().map(|server| server.id.as_str()).collect::<Vec<_>>(), vec![second.id, first.id]);
        assert_eq!(ordered[0].sort_order, 0);
        assert_eq!(ordered[1].sort_order, 1);
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
        assert_eq!(short_history.len(), 2);
        assert_eq!(long_history.len(), 1);
        assert_eq!(long_history[0].timestamp, old_timestamp);
        let short_heatmap = db.get_history_heatmap(&short.id, 0, 0, &[]).unwrap();
        let long_heatmap = db.get_history_heatmap(&long.id, 0, 0, &[]).unwrap();
        assert_eq!(short_heatmap.len(), 1);
        assert_eq!(long_heatmap.len(), 1);
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
    fn replacing_a_snapshot_updates_the_hourly_bucket_without_double_counting() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let server = db.save_server(draft("Replace", 30)).unwrap();
        let mut sample = snapshot(&server.id, 21_900);
        sample.system.cpu_utilization = 20.0;
        sample.gpus.push(GpuMetric { index: 0, name: "NVIDIA Test".into(), uuid: "GPU-replace".into(), utilization: 25.0, memory_utilization: 0.0, memory_used_mb: 10_240.0, memory_total_mb: 40_960.0, temperature_celsius: 40.0, power_watts: 80.0 });
        db.save_snapshot(&sample).unwrap();
        sample.system.cpu_utilization = 80.0;
        sample.gpus[0].utilization = 75.0;
        sample.gpus[0].memory_used_mb = 30_720.0;
        db.save_snapshot(&sample).unwrap();

        let buckets = db.get_history_heatmap(&server.id, 0, 0, &["GPU-replace".into()]).unwrap();
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].sample_count, 1);
        assert_eq!(buckets[0].cpu_utilization, 80.0);
        assert_eq!(buckets[0].gpu_utilizations.get("GPU-replace"), Some(&75.0));
        assert_eq!(buckets[0].gpu_memory_utilizations.get("GPU-replace"), Some(&75.0));
    }

    #[test]
    fn keeps_three_hours_raw_then_compacts_older_trends_and_preserves_peaks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let server_id = {
            let db = Database::open(&path).unwrap();
            let server = db.save_server(draft("Tiered trend", 30)).unwrap();
            let latest = 2_000_000;
            let raw_start = latest - 2 * 3_600;
            for (offset, value) in [(10, 10.0), (70, 90.0), (130, 20.0)] {
                let mut sample = snapshot(&server.id, raw_start + offset);
                sample.system.cpu_utilization = value;
                db.save_snapshot(&sample).unwrap();
            }
            let long_bucket = bucket_start(latest - 30 * 3_600, LONG_HISTORY_BUCKET_SECONDS);
            for (offset, value) in [(10, 5.0), (310, 75.0)] {
                let mut sample = snapshot(&server.id, long_bucket + offset);
                sample.system.cpu_utilization = value;
                db.save_snapshot(&sample).unwrap();
            }
            db.save_snapshot(&snapshot(&server.id, latest)).unwrap();
            server.id
        };

        let reopened = Database::open(&path).unwrap();
        let history = reopened.get_history(&server_id, 0).unwrap();
        assert_eq!(history.len(), 5);
        let raw_values: Vec<_> = history.iter().filter(|point| point.timestamp >= 2_000_000 - 3 * 3_600).map(|point| point.cpu_utilization).collect();
        assert!(raw_values.contains(&10.0));
        assert!(raw_values.contains(&90.0));
        assert!(raw_values.contains(&20.0));
        let long = history.iter().find(|point| point.cpu_max == 75.0).unwrap();
        assert!((long.cpu_utilization - 40.0).abs() < 0.01);
        assert_eq!(long.cpu_min, 5.0);
    }

    #[test]
    fn backfills_hourly_buckets_when_opening_an_existing_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let server_id = {
            let db = Database::open(&path).unwrap();
            let server = db.save_server(draft("Backfill", 30)).unwrap();
            let mut sample = snapshot(&server.id, 21_900);
            sample.system.cpu_utilization = 55.0;
            db.save_snapshot(&sample).unwrap();
            db.connection.lock().unwrap().execute("DELETE FROM history_hourly_buckets", []).unwrap();
            server.id
        };

        let reopened = Database::open(&path).unwrap();
        let buckets = reopened.get_history_heatmap(&server_id, 0, 0, &[]).unwrap();
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].sample_count, 1);
        assert_eq!(buckets[0].cpu_utilization, 55.0);
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
            cpu_min: 12.5, cpu_max: 12.5, memory_min: 40.0, memory_max: 40.0, swap_min: 3.0, swap_max: 3.0,
            gpu_mins: HashMap::from([("GPU-a".into(), 80.0)]), gpu_maxes: HashMap::from([("GPU-a".into(), 80.0)]),
            gpu_memory_mins: HashMap::from([("GPU-a".into(), 50.0)]), gpu_memory_maxes: HashMap::from([("GPU-a".into(), 50.0)]),
        };

        assert_eq!(db.import_remote_history(&server.id, std::slice::from_ref(&point)).unwrap(), 1);
        assert_eq!(db.import_remote_history(&server.id, std::slice::from_ref(&point)).unwrap(), 0);
        assert_eq!(db.get_history(&server.id, 0).unwrap().len(), 1);
        let heatmap = db.get_history_heatmap(&server.id, 0, 0, &["GPU-a".into()]).unwrap();
        assert_eq!(heatmap.len(), 1);
        assert_eq!(heatmap[0].gpu_utilizations.get("GPU-a"), Some(&80.0));
        assert_eq!(db.get_server(&server.id).unwrap().remote_history_last_sync_at, Some(point.timestamp));
        assert_eq!(db.remote_history_cursor(&server.id, point.timestamp + 120).unwrap(), point.timestamp - 60);
    }

    #[test]
    fn local_usage_is_recorded_once_per_minute_and_wins_over_remote_data() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let server = db.save_server(draft("Usage", 30)).unwrap();
        let mut sample = snapshot(&server.id, 1_000_019);
        sample.gpus = vec![
            GpuMetric { index: 0, name: "GPU 0".into(), uuid: "GPU-a".into(), utilization: 50.0, memory_utilization: 0.0, memory_used_mb: 0.0, memory_total_mb: 40_000.0, temperature_celsius: 40.0, power_watts: 80.0 },
            GpuMetric { index: 1, name: "GPU 1".into(), uuid: "GPU-b".into(), utilization: 0.0, memory_utilization: 0.0, memory_used_mb: 0.0, memory_total_mb: 40_000.0, temperature_celsius: 40.0, power_watts: 80.0 },
        ];
        sample.processes = vec![
            gpu_process("GPU-a", "alice", "python train.py", 2_000.0),
            gpu_process("GPU-a", "alice", "python worker.py", 1_000.0),
            gpu_process("GPU-a", "root", "python service.py", 10_000.0),
            gpu_process("GPU-a", "bob", "/opt/codex service", 10_000.0),
        ];

        assert_eq!(db.save_local_usage(&sample).unwrap(), 3);
        assert_eq!(db.save_local_usage(&sample).unwrap(), 0);
        let distribution = db.get_usage_distribution(&server.id, 0, 30).unwrap();
        assert_eq!(distribution.coverage_gpu_seconds, 120);
        assert_eq!(distribution.users.len(), 1);
        assert_eq!(distribution.users[0].username, "alice");
        assert_eq!(distribution.users[0].active_seconds, 60);
        assert_eq!(distribution.users[0].memory_mb_seconds, 180_000.0);

        let remote = UsagePoint { timestamp: 999_960, gpu_uuid: "GPU-a".into(), username: "remote-user".into(), active_seconds: 60, memory_mb_seconds: 60_000.0, coverage_seconds: 60 };
        assert_eq!(db.import_remote_usage(&server.id, &[remote], 1_000_019).unwrap(), 0);
        assert_eq!(db.get_usage_distribution(&server.id, 0, 30).unwrap().users.len(), 1);
    }

    #[test]
    fn local_usage_cleanup_keeps_only_ninety_days() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let server = db.save_server(draft("Usage retention", 30)).unwrap();
        let mut old = snapshot(&server.id, 1_000_000);
        old.gpus.push(GpuMetric { index: 0, name: "GPU".into(), uuid: "GPU-a".into(), utilization: 0.0, memory_utilization: 0.0, memory_used_mb: 0.0, memory_total_mb: 40_000.0, temperature_celsius: 40.0, power_watts: 80.0 });
        db.save_local_usage(&old).unwrap();
        let mut current = old.clone();
        current.timestamp += 91 * 86_400;
        db.save_local_usage(&current).unwrap();
        let distribution = db.get_usage_distribution(&server.id, 0, 90).unwrap();
        assert_eq!(distribution.coverage_gpu_seconds, 60);
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
            current_available_gpu_keys: vec![],
            pending_confirmation_gpu_keys: vec![],
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
    fn remote_cleanup_queue_survives_local_delete_in_isolated_database() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("cleanup.sqlite")).unwrap();
        let saved = db.save_server(ServerDraft { remote_history_enabled: true, ..draft("cleanup", 30) }).unwrap();
        db.enqueue_remote_cleanup(&saved, 10_000, "offline").unwrap();
        db.delete_server_record(&saved.id, false).unwrap();

        let tasks = db.list_remote_cleanup_tasks().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].server.name, "cleanup");
        assert_eq!(tasks[0].expires_at, 10_000 + 86_400);

        db.finish_remote_cleanup(&saved.id).unwrap();
        assert!(db.list_remote_cleanup_tasks().unwrap().is_empty());
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
        assert_eq!(existing.sort_order, 0);

        let updated = db.save_server(ServerDraft {
            id: Some(existing.id),
            location: Some("Lab 301 / Rack R2 / U18".into()),
            ..draft("Legacy GPU", 30)
        }).unwrap();
        assert_eq!(updated.location.as_deref(), Some("Lab 301 / Rack R2 / U18"));
    }
}
