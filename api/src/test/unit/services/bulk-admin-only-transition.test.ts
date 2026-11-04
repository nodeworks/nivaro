import { beforeEach, describe, expect, it, vi } from 'vitest'

// Post-approval locks (2026-11-04): a move the edit lock's admin-only tier
// keeps for admins (Cancel Workflow, Send Back past approval) must be refused
// on the bulk bar too — the bulk runner gates transitions itself and once let
// a non-admin owner bulk-cancel an approved record.

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) => ({ id })),
  updateOne: vi.fn(async () => ({}))
}))
vi.mock('../../../services/live-progress.js', () => ({
  openBulkRowProgress: vi.fn(() => ({
    next: () => {},
    end: () => {},
    done: () => {},
    close: () => {}
  }))
}))
// Record 1 sits in an admin-only state, record 2 in an approval state.
vi.mock('../../../services/edit-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/edit-lock.js')>()),
  adminOnlyTransitionsFor: vi.fn(async () => new Set(['T-CANCEL'])),
  adminOnlyStateOf: vi.fn(async (_c: string, item: string) =>
    item === '1' ? { key: 'waiting_on_po', label: 'Waiting on PO' } : null
  )
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => {
    const row =
      t === 'nivaro_workflow_bindings'
        ? { template: 'tpl' }
        : t === 'nivaro_workflow_instances'
          ? { id: 'inst-1', collection: 'workflows', item: '1', current_state: 'S1' }
          : undefined
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy']) c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => row)
    c.select = vi.fn(async () =>
      t === 'nivaro_workflow_transitions'
        ? [
            {
              id: 'T-CANCEL',
              label: 'Cancel Workflow',
              from_state: null,
              to_state: 'S-CANCELED',
              required_roles: null
            }
          ]
        : []
    )
    return c
  })
}))

import { runDefinition } from '../../../services/bulk-actions.js'

const def = {
  kind: 'transition',
  collection: 'workflows',
  config: { transition_label: 'Cancel Workflow' },
  guard: []
} as never
const asPerson = { user: { id: 'u-1', role: 'R' }, isAdmin: false } as never
const asAdmin = { user: { id: 'u-admin', role: 'ADMIN' }, isAdmin: true } as never

beforeEach(() => vi.clearAllMocks())

describe('bulk transition — admin-only moves', () => {
  it('a non-admin fails on the record in an admin-only state; the others go on', async () => {
    const r = await runDefinition(def, ['1', '2'], 'No longer needed', asPerson, { dryRun: true })
    expect(r.failed).toBe(1)
    expect(r.succeeded).toBe(1)
    expect(r.outcomes).toEqual([
      {
        item: '1',
        outcome: 'fail',
        reason:
          'Only administrators can make this move at Waiting on PO. Use Request help to ask for a change.'
      },
      { item: '2', outcome: 'change', reason: 'Cancel Workflow' }
    ])
  })

  it('a non-admin in an approval state is judged as before', async () => {
    const r = await runDefinition(def, ['2'], 'No longer needed', asPerson, { dryRun: true })
    expect(r.failed).toBe(0)
    expect(r.outcomes[0]).toMatchObject({ item: '2', outcome: 'change' })
  })

  it('an admin runs the move in any state', async () => {
    const r = await runDefinition(def, ['1', '2'], 'No longer needed', asAdmin, { dryRun: true })
    expect(r.failed).toBe(0)
    expect(r.succeeded).toBe(2)
  })
})
