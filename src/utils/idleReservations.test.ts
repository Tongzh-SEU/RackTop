import { describe, expect, it } from 'vitest'
import type { IdleReservation } from '../types/models'
import { CURRENT_SNAPSHOT_STABLE_SECONDS, evaluateIdleReservation, idleReservationFiltersEqual, idleReservationSummary } from './idleReservations'

const reservation: IdleReservation = {
  id: 'reservation-1',
  name: 'A100 预约',
  filters: { gpuMemoryGb: 40, cpuMemoryGb: 0, otherUserProcess: 'none', gpuModel: 'all', cpuModel: 'all', duration: 0, tag: 'all' },
  createdAt: 1_000,
  expiresAt: null,
  notifyMode: 'continuous',
  status: 'active',
  matchedGpuKeys: [],
}

describe('idle reservations', () => {
  it('requires current-snapshot matches to stay stable for thirty seconds', () => {
    const first = evaluateIdleReservation(reservation, ['server:gpu'], {}, 1_000)
    expect(first.notificationGpuKeys).toEqual([])
    expect(first.pendingSince['server:gpu']).toBe(1_000)
    expect(evaluateIdleReservation(reservation, ['server:gpu'], first.pendingSince, 1_000 + CURRENT_SNAPSHOT_STABLE_SECONDS - 1).notificationGpuKeys).toEqual([])
    const ready = evaluateIdleReservation(reservation, ['server:gpu'], first.pendingSince, 1_000 + CURRENT_SNAPSHOT_STABLE_SECONDS)
    expect(ready.notificationGpuKeys).toEqual(['server:gpu'])
    expect(ready.reservation.matchedGpuKeys).toEqual(['server:gpu'])
  })

  it('does not notify GPUs that were already matching when the reservation was created', () => {
    const baseline = { ...reservation, matchedGpuKeys: ['server:gpu'] }
    expect(evaluateIdleReservation(baseline, ['server:gpu'], {}, 2_000).notificationGpuKeys).toEqual([])
    const released = evaluateIdleReservation(baseline, [], {}, 2_001)
    expect(released.reservation.matchedGpuKeys).toEqual([])
  })

  it('completes a one-shot reservation after its first notification', () => {
    const oneShot = { ...reservation, filters: { ...reservation.filters, duration: 5 }, notifyMode: 'once' as const }
    const result = evaluateIdleReservation(oneShot, ['server:gpu'], {}, 2_000)
    expect(result.notificationGpuKeys).toEqual(['server:gpu'])
    expect(result.reservation.status).toBe('completed')
  })

  it('expires active reservations and formats their exact conditions', () => {
    const expired = evaluateIdleReservation({ ...reservation, expiresAt: 1_500 }, [], {}, 1_500)
    expect(expired.reservation.status).toBe('expired')
    expect(idleReservationSummary(reservation.filters)).toContain('稳定 30 秒')
    expect(idleReservationFiltersEqual(reservation.filters, { ...reservation.filters })).toBe(true)
  })
})
