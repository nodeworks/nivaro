import { describe, expect, it, vi } from 'vitest'

// Army 11: the instance read names the partners a move ORDERS from (blocking
// pushes only) and the highlight rules a record matches (the "On hold" chip),
// judged only on fields the caller may read.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(),
  requireAuth: vi.fn(),
  requireAdmin: vi.fn()
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))

const state = vi.hoisted(() => ({
  rules: [] as unknown[],
  row: undefined as Record<string, unknown> | undefined,
  allowed: null as string[] | null
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  getAllowedFields: vi.fn(async () => state.allowed)
}))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((t: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'select', 'join', 'leftJoin'])
      c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => state.row)
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    c.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(t === 'nivaro_at_risk_rules' ? state.rules : []).then(res)
    return c
  })
  return { db }
})

import { recordFlags, stripTransitionActions } from '../../../routes/pipelines.js'

const user = { id: 'u1', role: 'r1' } as never

describe('stripTransitionActions order_partners', () => {
  it('lists blocking pushes only, once each', () => {
    const t = stripTransitionActions({
      id: 'x',
      actions: [
        { type: 'erp_submit', external_api: 'MDSi', blocking: true },
        { type: 'erp_submit', external_api: 'Fusion IIP', blocking: true },
        { type: 'erp_submit', external_api: 'MWF' },
        { type: 'create_record' }
      ]
    })
    expect(t.pushes).toBe(3)
    expect(t.order_partners).toEqual(['MDSi', 'Fusion IIP'])
    expect('actions' in t).toBe(false)
  })
  it('an approval orders nothing', () => {
    expect(stripTransitionActions({ id: 'a', actions: null }).order_partners).toEqual([])
  })
})

describe('recordFlags', () => {
  const hold = {
    id: 2,
    collection: 'workflows',
    name: 'On hold',
    conditions: JSON.stringify([{ field: 'is_on_hold', op: 'eq', value: true }]),
    highlight_color: 'amber',
    is_active: true
  }
  const sent = {
    ...hold,
    id: 1,
    name: 'Sent back',
    conditions: JSON.stringify([{ field: 'is_send_back', op: 'eq', value: true }]),
    highlight_color: 'red'
  }

  it('returns every rule the record matches', async () => {
    state.rules = [sent, hold]
    state.row = { is_on_hold: true, is_send_back: true }
    state.allowed = null
    expect(await recordFlags(user, false, 'workflows', '1')).toEqual([
      { name: 'Sent back', color: 'red' },
      { name: 'On hold', color: 'amber' }
    ])
  })

  it('skips a rule on a field the caller cannot read', async () => {
    state.rules = [sent, hold]
    state.row = { is_on_hold: true, is_send_back: true }
    state.allowed = ['id', 'is_on_hold']
    expect(await recordFlags(user, false, 'workflows', '1')).toEqual([
      { name: 'On hold', color: 'amber' }
    ])
  })

  it('nothing for a record that is not held, or no user', async () => {
    state.rules = [hold]
    state.row = { is_on_hold: false }
    state.allowed = null
    expect(await recordFlags(user, false, 'workflows', '1')).toEqual([])
    expect(await recordFlags(undefined, false, 'workflows', '1')).toEqual([])
  })
})
