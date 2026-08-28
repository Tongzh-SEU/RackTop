import type { HistoryPoint } from '../types/models'

interface CacheEntry {
  expiresAt: number
  points?: HistoryPoint[]
  request?: Promise<HistoryPoint[]>
}

const historyCache = new Map<string, CacheEntry>()

export function getCachedTrendHistory(key: string) {
  return historyCache.get(key)?.points
}

export function loadCachedTrendHistory(key: string, loader: () => Promise<HistoryPoint[]>, maxAgeMs = 25_000) {
  const cached = historyCache.get(key)
  if (cached?.points && cached.expiresAt > Date.now()) return Promise.resolve(cached.points)
  if (cached?.request) return cached.request

  const request = loader().then((points) => {
    historyCache.set(key, { points, expiresAt: Date.now() + maxAgeMs })
    return points
  }).catch((error) => {
    if (historyCache.get(key)?.request === request) historyCache.delete(key)
    throw error
  })
  historyCache.set(key, { points: cached?.points, expiresAt: cached?.expiresAt ?? 0, request })
  return request
}

export function clearTrendHistoryCache() {
  historyCache.clear()
}
