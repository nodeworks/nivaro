import { beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny in-memory stand-in for the tables delivery touches.
type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}
function qb(name: string) {
  const rows = () => tables[name] ?? []
  const filters: Array<(r: Row) => boolean> = []
  const apply = () => rows().filter((r) => filters.every((f) => f(r)))
  const api = {
    where(o: Row | string, op?: string, v?: unknown) {
      if (typeof o === 'string') {
        const col = o
        filters.push((r) => {
          const x = r[col]
          if (x == null || v == null) return false
          const a = new Date(x as Date).getTime()
          const b = new Date(v as Date).getTime()
          return op === '>=' ? a >= b : op === '<' ? a < b : a === b
        })
        return api
      }
      filters.push((r) => Object.entries(o).every(([k, val]) => r[k] === val))
      return api
    },
    whereNull(k: string) {
      filters.push((r) => r[k] == null)
      return api
    },
    whereIn(k: string, vs: unknown[]) {
      filters.push((r) => vs.includes(r[k]))
      return api
    },
    async select() {
      return apply().map((r) => ({ ...r }))
    },
    async update(patch: Row) {
      const hit = apply()
      for (const r of hit) Object.assign(r, patch)
      return hit.length
    }
  }
  return api
}

/**
 * `db('nivaro_users as u').join('nivaro_roles as r', 'r.id', 'u.role')...` —
 * a hand-rolled stand-in for exactly this one query shape (join always
 * present; filters recorded by column name), backed by `tables.nivaro_users`
 * / `tables.nivaro_roles`. Good enough to prove the CALLING code's behavior
 * without building a general SQL engine.
 */
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
  db: (t: string) => (t.startsWith('nivaro_users') ? usersRolesQb() : qb(t))
}))

const maint = { on: false }
vi.mock('../../../services/security.js', () => ({ maintenanceState: async () => ({ ...maint }) }))
type NotifyResult = { id: number | null; decision: { dropped: boolean }; lane: null }
const notifyUser = vi.fn(
  async (): Promise<NotifyResult> => ({ id: 1, decision: { dropped: false }, lane: null })
)
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser }))
vi.mock('../../../services/integration-signal-settings.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/integration-signal-settings.js')>()),
  loadActiveSnoozes: async () => [],
  resolveThresholds: async () => ({ enabled: true, severity: 'warn', thresholds: {} })
}))
const resolveFriendlyIds = vi.fn(
  async (_collection: string, ids: string[]) => new Map(ids.map((id) => [id, `REC-${id}`]))
)
vi.mock('../../../services/workflow-transitions.js', () => ({ resolveFriendlyIds }))
vi.mock('../../../services/integration-signals.js', () => ({
  getIntegrationSignal: (id: string) =>
    id === 'core:push-failed'
      ? { id, label: 'Failed pushes', severity: 'warn', thresholds: [] }
      : undefined,
  listIntegrationSignals: () => []
}))

import { deliverSignalAlerts, setApp } from '../../../services/integration-signal-alerts.js'

const summary = (keys: string[], again: string[] = []) => ({
  ran_at: new Date().toISOString(),
  results: [
    { signal: 'core:push-failed', count: 1, error: null, new_keys: keys, reoccurred_keys: again }
  ]
})

describe('deliverSignalAlerts', () => {
  beforeEach(() => {
    maint.on = false
    notifyUser.mockClear()
    notifyUser.mockImplementation(
      async (): Promise<NotifyResult> => ({ id: 1, decision: { dropped: false }, lane: null })
    )
    tables.nivaro_roles = [
      { id: 'role-admin', admin_access: true },
      { id: 'role-user', admin_access: false }
    ]
    tables.nivaro_users = [
      { id: 'AUTO', status: 'active', is_redacted: false, role: 'role-admin' },
      { id: 'DIGESTER', status: 'active', is_redacted: false, role: 'role-admin' }
    ]
    tables.nivaro_integration_signal_subscriptions = [
      { id: 1, user: 'AUTO', signal: 'core:push-failed', mode: 'realtime', last_notified_at: null },
      {
        id: 2,
        user: 'DIGESTER',
        signal: 'core:push-failed',
        mode: 'digest',
        last_notified_at: null
      }
    ]
    tables.nivaro_integration_signal_rows = [
      {
        id: 10,
        signal: 'core:push-failed',
        row_key: 'workflows:1:P:/x',
        cleared_at: null,
        alerted_at: null,
        payload: JSON.stringify({ key: 'workflows:1:P:/x', title: 'P /x', actions: [] })
      }
    ]
    setApp({} as never)
  })

  it('tells only the real-time subscriber, once, then stamps the row', async () => {
    await deliverSignalAlerts(summary(['workflows:1:P:/x']))
    expect(notifyUser).toHaveBeenCalledTimes(1)
    const [, user, opts] = notifyUser.mock.calls[0] as unknown as [unknown, string, Row]
    expect(user).toBe('AUTO')
    expect(opts.subject).toBe('1 new · Failed pushes')
    expect(opts.category).toBe('integrations')
    expect(opts.target).toMatchObject({
      kind: 'integration',
      query: 'tab=firefight&signal=core%3Apush-failed'
    })
    expect(tables.nivaro_integration_signal_rows[0].alerted_at).toBeInstanceOf(Date)
    expect(tables.nivaro_integration_signal_subscriptions[0].last_notified_at).toBeInstanceOf(Date)
    expect(tables.nivaro_integration_signal_subscriptions[1].last_notified_at).toBeNull()

    // The same key reported again (a racing cycle) is not news.
    await deliverSignalAlerts(summary(['workflows:1:P:/x']))
    expect(notifyUser).toHaveBeenCalledTimes(1)
  })

  it('a re-occurrence of an alerted row is news — "happened again"', async () => {
    tables.nivaro_integration_signal_rows[0].alerted_at = new Date(Date.now() - 7 * 3600_000)
    await deliverSignalAlerts(summary(['workflows:1:P:/x'], ['workflows:1:P:/x']))
    expect(notifyUser).toHaveBeenCalledTimes(1)
    const [, , opts] = notifyUser.mock.calls[0] as unknown as [unknown, string, Row]
    expect(opts.message).toBe('P /x — happened again')
  })

  it('nothing in maintenance mode, nothing without subscribers', async () => {
    maint.on = true
    await deliverSignalAlerts(summary(['workflows:1:P:/x']))
    maint.on = false
    tables.nivaro_integration_signal_subscriptions = []
    await deliverSignalAlerts(summary(['workflows:1:P:/x']))
    expect(notifyUser).not.toHaveBeenCalled()
    expect(tables.nivaro_integration_signal_rows[0].alerted_at).toBeNull()
  })

  it('never throws out of the cycle', async () => {
    notifyUser.mockRejectedValueOnce(new Error('boom'))
    await expect(deliverSignalAlerts(summary(['workflows:1:P:/x']))).resolves.toBeUndefined()
  })

  // ── item 1: recipients must still be admins at delivery ──────────────────

  it('a demoted subscriber (role lost admin_access) gets no real-time alert', async () => {
    ;(tables.nivaro_users.find((u) => u.id === 'AUTO') as Row).role = 'role-user'
    await deliverSignalAlerts(summary(['workflows:1:P:/x']))
    expect(notifyUser).not.toHaveBeenCalled()
    expect(tables.nivaro_integration_signal_rows[0].alerted_at).toBeNull()
  })

  it('a suspended subscriber gets no real-time alert', async () => {
    ;(tables.nivaro_users.find((u) => u.id === 'AUTO') as Row).status = 'suspended'
    await deliverSignalAlerts(summary(['workflows:1:P:/x']))
    expect(notifyUser).not.toHaveBeenCalled()
  })

  it('a redacted subscriber gets no real-time alert', async () => {
    ;(tables.nivaro_users.find((u) => u.id === 'AUTO') as Row).is_redacted = true
    await deliverSignalAlerts(summary(['workflows:1:P:/x']))
    expect(notifyUser).not.toHaveBeenCalled()
  })

  // ── item 3: only stamp when at least one recipient actually heard it ──────

  it('leaves the row unstamped when notifyUser throws for every recipient — retried next cycle', async () => {
    notifyUser.mockRejectedValueOnce(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await deliverSignalAlerts(summary(['workflows:1:P:/x']))
    expect(tables.nivaro_integration_signal_rows[0].alerted_at).toBeNull()
    expect(tables.nivaro_integration_signal_subscriptions[0].last_notified_at).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('leaves the row unstamped when every recipient is dropped downstream (e.g. muted)', async () => {
    notifyUser.mockResolvedValueOnce({ id: null, decision: { dropped: true }, lane: null })
    await deliverSignalAlerts(summary(['workflows:1:P:/x']))
    expect(tables.nivaro_integration_signal_rows[0].alerted_at).toBeNull()
  })

  it('stamps once at least one recipient actually heard it, even if others were dropped', async () => {
    tables.nivaro_integration_signal_subscriptions.push({
      id: 3,
      user: 'DIGESTER',
      signal: 'core:push-failed',
      mode: 'realtime',
      last_notified_at: null
    })
    notifyUser.mockResolvedValueOnce({ id: null, decision: { dropped: true }, lane: null }) // AUTO
    notifyUser.mockResolvedValueOnce({ id: 2, decision: { dropped: false }, lane: null }) // DIGESTER
    await deliverSignalAlerts(summary(['workflows:1:P:/x']))
    expect(tables.nivaro_integration_signal_rows[0].alerted_at).toBeInstanceOf(Date)
  })

  // ── steady outage / recovery / retry ─────────────────────────────────────

  it('a steady outage over three cycles alerts exactly once; recovery then a new failure alerts again', async () => {
    const k = 'workflows:1:P:/x'
    // Cycle 1: the row is new.
    await deliverSignalAlerts(summary([k]))
    // Cycles 2 and 3: the same problem, still going — even if its occurrence
    // were to move, the re-alert window keeps it quiet.
    await deliverSignalAlerts(summary([k], [k]))
    await deliverSignalAlerts(summary([k], [k]))
    expect(notifyUser).toHaveBeenCalledTimes(1)

    // Recovery: the row cleared. A new failure later is a brand-new row.
    tables.nivaro_integration_signal_rows[0].cleared_at = new Date()
    tables.nivaro_integration_signal_rows.push({
      id: 11,
      signal: 'core:push-failed',
      row_key: k,
      cleared_at: null,
      alerted_at: null,
      first_seen: new Date(),
      payload: JSON.stringify({ key: k, title: 'P /x', actions: [] })
    })
    await deliverSignalAlerts(summary([k]))
    expect(notifyUser).toHaveBeenCalledTimes(2)
  })

  it('a row left unstamped by a failed delivery is offered again on the next cycle', async () => {
    tables.nivaro_integration_signal_rows[0].first_seen = new Date()
    notifyUser.mockRejectedValueOnce(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await deliverSignalAlerts(summary(['workflows:1:P:/x']))
    warn.mockRestore()
    expect(tables.nivaro_integration_signal_rows[0].alerted_at).toBeNull()

    // Next cycle: nothing new for this signal — the row is retried anyway.
    await deliverSignalAlerts(summary([]))
    expect(notifyUser).toHaveBeenCalledTimes(2)
    expect(tables.nivaro_integration_signal_rows[0].alerted_at).toBeInstanceOf(Date)
  })

  it('an unstamped row older than a day is not retried', async () => {
    tables.nivaro_integration_signal_rows[0].first_seen = new Date(Date.now() - 2 * 86_400_000)
    await deliverSignalAlerts(summary([]))
    expect(notifyUser).not.toHaveBeenCalled()
  })

  it('each line names the record it is about — one lookup per collection', async () => {
    resolveFriendlyIds.mockClear()
    tables.nivaro_integration_signal_rows = [
      {
        id: 10,
        signal: 'core:push-failed',
        row_key: 'workflows:1:P:/x',
        cleared_at: null,
        alerted_at: null,
        payload: JSON.stringify({
          key: 'workflows:1:P:/x',
          title: 'P /x',
          record: { collection: 'workflows', id: '1' },
          actions: []
        })
      },
      {
        id: 12,
        signal: 'core:push-failed',
        row_key: 'workflows:2:P:/x',
        cleared_at: null,
        alerted_at: null,
        payload: JSON.stringify({
          key: 'workflows:2:P:/x',
          title: 'P /x',
          record: { collection: 'workflows', id: '2', label: 'Already named' },
          actions: []
        })
      }
    ]
    await deliverSignalAlerts(summary(['workflows:1:P:/x', 'workflows:2:P:/x']))
    const [, , opts] = notifyUser.mock.calls[0] as unknown as [unknown, string, Row]
    expect(String(opts.message).split('\n').sort()).toEqual([
      'P /x · Already named',
      'P /x · REC-1'
    ])
    expect(resolveFriendlyIds).toHaveBeenCalledTimes(1)
    expect(resolveFriendlyIds).toHaveBeenCalledWith('workflows', ['1'])
  })
})
