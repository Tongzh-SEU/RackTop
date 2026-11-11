use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

const MAX_LIVE_COLLECTIONS: usize = 4;

/// Shared by all live snapshot invocations in this desktop process.
/// Disk scans, terminals and other clients have their own lifecycles.
pub struct CollectionLimiter {
    servers: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    slots: Arc<Semaphore>,
}

impl Default for CollectionLimiter {
    fn default() -> Self {
        Self {
            servers: Mutex::default(),
            slots: Arc::new(Semaphore::new(MAX_LIVE_COLLECTIONS)),
        }
    }
}

pub struct CollectionPermit {
    _slot: OwnedSemaphorePermit,
    _server: OwnedMutexGuard<()>,
}

impl CollectionLimiter {
    pub async fn acquire(&self, server_id: &str) -> Result<CollectionPermit, String> {
        let server = {
            let mut servers = self.servers.lock().map_err(|error| error.to_string())?;
            // Retain only active or queued IDs, including after a server is removed.
            servers.retain(|_, entry| entry.strong_count() > 0);
            match servers.get(server_id).and_then(Weak::upgrade) {
                Some(server) => server,
                None => {
                    let server = Arc::new(AsyncMutex::new(()));
                    servers.insert(server_id.into(), Arc::downgrade(&server));
                    server
                }
            }
        };
        // Wait for this server first so duplicates cannot consume global slots
        // and block unrelated nodes. Dropping either future releases its guards.
        let server = server.lock_owned().await;
        let slot = self.slots.clone().acquire_owned().await.map_err(|error| error.to_string())?;
        Ok(CollectionPermit { _slot: slot, _server: server })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    #[tokio::test]
    async fn bounds_active_collections_and_releases_capacity() {
        let limiter = CollectionLimiter::default();
        let mut active = Vec::new();
        for id in 0..MAX_LIVE_COLLECTIONS {
            active.push(limiter.acquire(&id.to_string()).await.unwrap());
        }
        let mut fifth = Box::pin(limiter.acquire("fifth"));
        assert!(timeout(Duration::from_millis(20), &mut fifth).await.is_err());
        active.pop();
        let _fifth = timeout(Duration::from_secs(1), fifth).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn same_server_waits_without_taking_another_global_slot() {
        let limiter = CollectionLimiter::default();
        let first = limiter.acquire("same").await.unwrap();
        let mut second = Box::pin(limiter.acquire("same"));
        assert!(timeout(Duration::from_millis(20), &mut second).await.is_err());
        let mut others = Vec::new();
        for id in 0..MAX_LIVE_COLLECTIONS - 1 {
            others.push(timeout(Duration::from_secs(1), limiter.acquire(&id.to_string())).await.unwrap().unwrap());
        }
        drop(first);
        let _second = timeout(Duration::from_secs(1), second).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn cancelling_a_global_waiter_releases_its_server_lock() {
        let limiter = CollectionLimiter::default();
        let mut active = Vec::new();
        for id in 0..MAX_LIVE_COLLECTIONS {
            active.push(limiter.acquire(&id.to_string()).await.unwrap());
        }
        assert!(timeout(Duration::from_millis(20), limiter.acquire("cancelled")).await.is_err());
        active.pop();
        let _retry = timeout(Duration::from_secs(1), limiter.acquire("cancelled")).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn cancelling_a_same_server_waiter_does_not_block_later_requests() {
        let limiter = CollectionLimiter::default();
        let first = limiter.acquire("same").await.unwrap();
        assert!(timeout(Duration::from_millis(20), limiter.acquire("same")).await.is_err());
        drop(first);
        let _retry = timeout(Duration::from_secs(1), limiter.acquire("same")).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn completed_server_entries_are_pruned() {
        let limiter = CollectionLimiter::default();
        for id in 0..100 {
            drop(limiter.acquire(&id.to_string()).await.unwrap());
        }
        let _last = limiter.acquire("last").await.unwrap();
        assert_eq!(limiter.servers.lock().unwrap().len(), 1);
    }
}
