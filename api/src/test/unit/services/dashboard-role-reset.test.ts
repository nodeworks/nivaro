import { beforeEach, describe, expect, it, vi } from 'vitest'

// One in-memory users table behind a knex-shaped chain: only the calls the
// service makes (whereIn / where / whereNotNull / select / update).
let users: Array<{ id: string; role: string | null; status: string | null; is_redacted: boolean | null; preferences: string | null }> = []
const updates: Array<{ id: string; preferences: string }> = []
const logged: Array<Record<string, unknown>> = []
let logFails = false

vi.mock('../../../db/index.js', () => {
  const chain = () => {
    let rows = [...users]
    const q: Record<string, unknown> = {}
    q.whereIn = (_c: string, ids: string[]) => {
      rows = rows.filter((r) => r.role && ids.includes(r.role))
      return q
    }
    q.whereNotNull = () => {
      rows = rows.filter((r) => r.role != null)
      return q
    }
    q.where = (a: unknown, b?: unknown, c?: unknown) => {
      if (typeof a === 'function') return q // status / redacted groups: fixture rows are all live
      if (a === 'preferences' && b === 'like') rows = rows.filter((r) => (r.preferences ?? '').includes('"dashboard"'))
      if (a && typeof a === 'object' && 'id' in (a as object)) {
        const id = (a as { id: string }).id
        return {
          update: (patch: { preferences: string }) => {
            updates.push({ id, preferences: patch.preferences })
            return Promise.resolve(1)
          }
        }
      }
      void c
      return q
    }
    q.select = () => Promise.resolve(rows)
    return q
  }
  return { db: Object.assign(() => chain(), {}) }
})
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (row: Record<string, unknown>) => {
    if (logFails) return null
    logged.push(row)
    return logged.length
  }
}))

const LAYOUT = { version: 1, items: [{ id: 'a', kind: 'widget', key: 'inbox', x: 0, y: 0, w: 6, h: 3 }] }

describe('dashboard role reset', () => {
  beforeEach(() => {
    updates.length = 0
    logged.length = 0
    logFails = false
    users = [
      { id: 'U1', role: 'CREATOR', status: 'active', is_redacted: false, preferences: JSON.stringify({ dashboard: LAYOUT, timezone: 'UTC' }) },
      { id: 'U2', role: 'CREATOR', status: 'active', is_redacted: false, preferences: JSON.stringify({ dashboard: null }) },
      { id: 'U3', role: 'CREATOR', status: 'active', is_redacted: false, preferences: null },
      { id: 'U4', role: 'APPROVER', status: 'active', is_redacted: false, preferences: JSON.stringify({ dashboard: LAYOUT }) }
    ]
  })

  it('counts people and saved layouts per role', async () => {
    const { dashboardLayoutSummary } = await import('../../../services/dashboard-role-reset.js')
    const s = await dashboardLayoutSummary()
    expect(s.find((r) => r.role === 'CREATOR')).toEqual({ role: 'CREATOR', people: 3, customized: 1 })
    expect(s.find((r) => r.role === 'APPROVER')).toEqual({ role: 'APPROVER', people: 1, customized: 1 })
  })

  it('clears only the chosen roles, keeps other preferences, and logs the prior layout first', async () => {
    const { resetDashboardLayouts } = await import('../../../services/dashboard-role-reset.js')
    const r = await resetDashboardLayouts(['creator'], 'ADMIN')
    expect(r.reset).toBe(1)
    expect(updates).toEqual([{ id: 'U1', preferences: JSON.stringify({ timezone: 'UTC' }) }])
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ action: 'dashboard-layout-reset', item: 'U1', user: 'ADMIN' })
    expect(JSON.parse(String(logged[0].comment))).toEqual({ role: 'CREATOR', prior: LAYOUT })
  })

  it('does not clear a layout it could not log', async () => {
    logFails = true
    const { resetDashboardLayouts } = await import('../../../services/dashboard-role-reset.js')
    expect((await resetDashboardLayouts(['CREATOR'], 'ADMIN')).reset).toBe(0)
    expect(updates).toHaveLength(0)
  })
})
