import { beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny in-memory stand-in for the three tables delivery touches.
type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}
function qb(name: string) {
  const rows = () => tables[name] ?? []
  const filters: Array<(r: Row) => boolean> = []
  const apply = () => rows().filter((r) => filters.every((f) => f(r)))
  const api = {
    where(o: Row) {
      filters.push((r) => Object.entries(o).every(([k, v]) => r[k] === v))
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
vi.mock('../../../db/index.js', () => ({ db: (t: string) => qb(t) }))

const maint = { on: false }
vi.mock('../../../services/security.js', () => ({ maintenanceState: async () => ({ ...maint }) }))
const notifyUser = vi.fn(async () => ({ id: 1 }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser }))
vi.mock('../../../services/integration-signal-settings.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/integration-signal-settings.js')>()),
  loadActiveSnoozes: async () => [],
  resolveThresholds: async () => ({ enabled: true, severity: 'warn', thresholds: {} })
}))
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
    tables.nivaro_integration_signal_rows[0].alerted_at = new Date()
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
})
