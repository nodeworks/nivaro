import { beforeEach, describe, expect, it, vi } from 'vitest'

// Post-approval lock: the lists that offer moves (the record panel's instance
// read, the Command Center peek) hide the moves an admin-only state keeps for
// administrators. The record's state is read ONCE per list — not once per
// listed move — and not at all when no listed move is on offer.

const state = vi.hoisted(() => ({
  listed: new Set(['T-CANCEL', 'T-BACK', 'T-HOLD']),
  adminOnly: true as boolean
}))

vi.mock('../../../services/edit-lock.js', () => ({
  adminOnlyTransitionsFor: vi.fn(async () => state.listed),
  adminOnlyStateOf: vi.fn(async () =>
    state.adminOnly ? { key: 'approved', label: 'Approved' } : null
  )
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => ({
    id: 'I1',
    template: 'T',
    current_state: 'S-APPROVED',
    completed_at: null
  }))
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const q: Record<string, unknown> = {}
    q.where = () => q
    q.orderBy = async () =>
      ['t-cancel', 'T-BACK', 'T-HOLD', 'T-NOTE'].map((id) => ({
        id,
        label: id,
        from_state: null,
        required_roles: null
      }))
    return q
  })
}))

import { offeredTransitions } from '../../../services/command-center/peek.js'
import { adminOnlyStateOf, adminOnlyTransitionsFor } from '../../../services/edit-lock.js'
import { withoutAdminOnlyMoves } from '../../../services/manual-transition-gate.js'

const moves = ['T-CANCEL', 'T-BACK', 'T-HOLD', 'T-NOTE'].map((id) => ({ id }))
const ids = (ts: Array<{ id: unknown }>) => ts.map((t) => t.id)

beforeEach(() => {
  vi.clearAllMocks()
  state.listed = new Set(['T-CANCEL', 'T-BACK', 'T-HOLD'])
  state.adminOnly = true
})

describe('withoutAdminOnlyMoves', () => {
  it('hides every listed move with ONE state read', async () => {
    const out = await withoutAdminOnlyMoves({
      isAdmin: false,
      collection: 'orders',
      item: '7',
      transitions: moves
    })
    expect(ids(out)).toEqual(['T-NOTE'])
    expect(adminOnlyStateOf).toHaveBeenCalledTimes(1)
    expect(adminOnlyStateOf).toHaveBeenCalledWith('orders', '7')
  })

  it('keeps them all outside an admin-only state', async () => {
    state.adminOnly = false
    const out = await withoutAdminOnlyMoves({
      isAdmin: false,
      collection: 'orders',
      item: '7',
      transitions: moves
    })
    expect(ids(out)).toEqual(ids(moves))
    expect(adminOnlyStateOf).toHaveBeenCalledTimes(1)
  })

  it('reads no state when no listed move is on offer, and nothing at all for admins', async () => {
    state.listed = new Set(['T-OTHER'])
    await withoutAdminOnlyMoves({
      isAdmin: false,
      collection: 'orders',
      item: '7',
      transitions: moves
    })
    expect(adminOnlyStateOf).not.toHaveBeenCalled()
    const out = await withoutAdminOnlyMoves({
      isAdmin: true,
      collection: 'orders',
      item: '7',
      transitions: moves
    })
    expect(ids(out)).toEqual(ids(moves))
    expect(adminOnlyTransitionsFor).toHaveBeenCalledTimes(1)
  })
})

describe('Command Center peek — offeredTransitions', () => {
  const user = { id: 'U1', role: 'R' } as never

  it('a non-admin is not offered the admin-only moves; the state is read once', async () => {
    const out = await offeredTransitions(user, false, 'orders', '7')
    expect(out.map((t) => t.key)).toEqual(['T-NOTE'])
    expect(adminOnlyStateOf).toHaveBeenCalledTimes(1)
  })

  it('an admin is offered every move and no state is read', async () => {
    const out = await offeredTransitions(user, true, 'orders', '7')
    expect(out.map((t) => t.key)).toEqual(['t-cancel', 'T-BACK', 'T-HOLD', 'T-NOTE'])
    expect(adminOnlyStateOf).not.toHaveBeenCalled()
  })
})
