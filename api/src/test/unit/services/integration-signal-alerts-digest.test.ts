import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Item 1 of the fix round: `integrationSignalsDigestAudience()` and
 * `integrationSignalsDigest(userId)` must agree with the real-time path — a
 * demoted or offboarded subscriber gets no audience membership and no
 * section, even though their subscription row still exists.
 */
type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}

function subsQb(name: string) {
  const rows = () => tables[name] ?? []
  const filters: Array<(r: Row) => boolean> = []
  const matched = () => rows().filter((r) => filters.every((f) => f(r)))
  const api = {
    where(o: Row) {
      filters.push((r) => Object.entries(o).every(([k, v]) => r[k] === v))
      return api
    },
    whereNull(k: string) {
      filters.push((r) => r[k] == null)
      return api
    },
    // `.distinct(col)` is knex's own TERMINAL call in production (awaited
    // with no trailing `.select()`) — it has to be a thenable itself, not
    // just a chain step, or `await db(...).distinct(col)` resolves to the
    // builder object rather than the rows.
    async distinct(col: string) {
      const seen = new Set<unknown>()
      const out: Row[] = []
      for (const r of matched()) {
        if (seen.has(r[col])) continue
        seen.add(r[col])
        out.push({ [col]: r[col] })
      }
      return out
    },
    async select() {
      return matched().map((r) => ({ ...r }))
    }
  }
  return api
}

function usersRolesQb() {
  const ids: string[] = []
  let excludeStatus: string | null = null
  let requireLive = false
  let requireAdmin = false
  const api = {
    join() {
      return api
    },
    whereIn(_col: string, vs: string[]) {
      ids.push(...vs)
      return api
    },
    whereNot(col: string, v: string) {
      if (col === 'u.status') excludeStatus = v
      return api
    },
    where(col: string, v: unknown) {
      if (col === 'u.is_redacted') requireLive = v === false
      if (col === 'r.admin_access') requireAdmin = v === true
      return api
    },
    async select() {
      const users = (tables.nivaro_users ?? []) as Row[]
      const roles = (tables.nivaro_roles ?? []) as Row[]
      return users
        .filter((u) => ids.includes(String(u.id)))
        .filter((u) => !excludeStatus || u.status !== excludeStatus)
        .filter((u) => !requireLive || u.is_redacted === false)
        .filter((u) => {
          if (!requireAdmin) return true
          const role = roles.find((r) => r.id === u.role)
          return !!role?.admin_access
        })
        .map((u) => ({ id: u.id }))
    }
  }
  return api
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
    { id: 'core:push-failed', label: 'Failed pushes', severity: 'warn', thresholds: [] }
  ]
}))
vi.mock('../../../services/notification-target.js', () => ({
  resolveTargetUrl: async () => '/integrations?tab=firefight&signal=core%3Apush-failed'
}))

import {
  integrationSignalsDigest,
  integrationSignalsDigestAudience
} from '../../../services/integration-signal-alerts.js'

describe('integration-signal digest — admin_access at delivery', () => {
  beforeEach(() => {
    tables.nivaro_roles = [
      { id: 'role-admin', admin_access: true },
      { id: 'role-user', admin_access: false }
    ]
    tables.nivaro_users = [
      { id: 'ADMIN-1', status: 'active', is_redacted: false, role: 'role-admin' },
      { id: 'DEMOTED-1', status: 'active', is_redacted: false, role: 'role-user' }
    ]
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
        user: 'DEMOTED-1',
        signal: 'core:push-failed',
        mode: 'digest',
        last_notified_at: null
      }
    ]
    tables.nivaro_integration_signal_rows = [
      {
        signal: 'core:push-failed',
        cleared_at: null,
        payload: JSON.stringify({ key: 'k1', title: 'T1', actions: [] }),
        first_seen: new Date(),
        alerted_at: null
      }
    ]
  })

  it('excludes a demoted subscriber from the digest audience', async () => {
    expect(await integrationSignalsDigestAudience()).toEqual(['ADMIN-1'])
  })

  it('renders a section for a still-admin subscriber', async () => {
    const section = await integrationSignalsDigest('ADMIN-1')
    expect(section).not.toBeNull()
    expect(section?.lines).toHaveLength(1)
    expect(section?.lines[0].text).toContain('Failed pushes')
  })

  it('renders no section for a subscriber who is no longer an admin', async () => {
    expect(await integrationSignalsDigest('DEMOTED-1')).toBeNull()
  })

  it('renders no section for a suspended subscriber even though their role is still admin', async () => {
    ;(tables.nivaro_users.find((u) => u.id === 'ADMIN-1') as Row).status = 'suspended'
    expect(await integrationSignalsDigest('ADMIN-1')).toBeNull()
  })

  it('excludes a suspended subscriber from the audience too', async () => {
    ;(tables.nivaro_users.find((u) => u.id === 'ADMIN-1') as Row).status = 'suspended'
    expect(await integrationSignalsDigestAudience()).toEqual([])
  })
})
