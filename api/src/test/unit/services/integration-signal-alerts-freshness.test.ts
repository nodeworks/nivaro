import { describe, expect, it, vi } from 'vitest'

/**
 * Item 6 of the fix round: "new since yesterday" in the digest must count a
 * row whose OCCURRENCE moved on within 24h even though a reoccurrence never
 * re-stamps `first_seen` (it stays a plain UPDATE) — `alerted_at` is the
 * column that actually moves when the same row is surfaced again. This
 * file's `signalCounts()` cache is process-local; kept to ONE call so it
 * can't return a stale result from an earlier test.
 */
type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}

function subsQb(name: string) {
  const rows = () => tables[name] ?? []
  const filters: Array<(r: Row) => boolean> = []
  const api = {
    where(o: Row) {
      filters.push((r) => Object.entries(o).every(([k, v]) => r[k] === v))
      return api
    },
    whereNull(k: string) {
      filters.push((r) => r[k] == null)
      return api
    },
    distinct() {
      return api
    },
    async select() {
      return rows()
        .filter((r) => filters.every((f) => f(r)))
        .map((r) => ({ ...r }))
    }
  }
  return api
}

function usersRolesQb() {
  return {
    join() {
      return this
    },
    whereIn() {
      return this
    },
    whereNot() {
      return this
    },
    where() {
      return this
    },
    async select() {
      // Every table in this file's fixture is a live admin — item 1 is
      // covered separately; this file is only about the freshness math.
      return (tables.nivaro_users ?? []).map((u) => ({ id: u.id }))
    }
  }
}

vi.mock('../../../db/index.js', () => ({
  db: (t: string) => (t.startsWith('nivaro_users') ? usersRolesQb() : subsQb(t))
}))
vi.mock('../../../services/integration-signal-settings.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/integration-signal-settings.js')>()),
  loadActiveSnoozes: async () => [],
  resolveThresholds: async () => ({ enabled: true, severity: 'warn', thresholds: {} })
}))
vi.mock('../../../services/integration-signals.js', () => ({
  getIntegrationSignal: () => undefined,
  listIntegrationSignals: () => [
    { id: 'core:push-failed', label: 'Failed pushes', severity: 'warn', thresholds: [] },
    { id: 'core:other-signal', label: 'Other signal', severity: 'warn', thresholds: [] }
  ]
}))
vi.mock('../../../services/notification-target.js', () => ({
  resolveTargetUrl: async () => '/x'
}))

import { integrationSignalsDigest } from '../../../services/integration-signal-alerts.js'

describe('integration-signal digest freshness — alerted_at OR first_seen', () => {
  it('a reoccurring row (stale first_seen, recent alerted_at) counts fresh; an untouched stale row does not', async () => {
    tables.nivaro_users = [{ id: 'ADMIN-1', status: 'active', is_redacted: false, role: 'r' }]
    tables.nivaro_integration_signal_subscriptions = [
      {
        id: 1,
        user: 'ADMIN-1',
        signal: 'core:push-failed',
        mode: 'digest',
        last_notified_at: null
      },
      {
        id: 2,
        user: 'ADMIN-1',
        signal: 'core:other-signal',
        mode: 'digest',
        last_notified_at: null
      }
    ]
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
    const oneHourAgo = new Date(Date.now() - 3_600_000)
    tables.nivaro_integration_signal_rows = [
      {
        signal: 'core:push-failed',
        cleared_at: null,
        payload: JSON.stringify({ key: 'reoccurred', title: 'T', actions: [] }),
        first_seen: twoDaysAgo,
        alerted_at: oneHourAgo
      },
      {
        signal: 'core:other-signal',
        cleared_at: null,
        payload: JSON.stringify({ key: 'stale', title: 'T', actions: [] }),
        first_seen: twoDaysAgo,
        alerted_at: null
      }
    ]

    const section = await integrationSignalsDigest('ADMIN-1')
    expect(section?.lines).toEqual([
      { text: 'Failed pushes — 1 open · 1 new since yesterday', url: '/x' },
      { text: 'Other signal — 1 open · 0 new since yesterday', url: '/x' }
    ])
  })
})
