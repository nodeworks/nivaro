import { beforeEach, describe, expect, it, vi } from 'vitest'

// open_when on the bulk bar (migration 533): the bulk runner gates each record
// itself, so it must hand the move's open_when to the same owner gate — a
// non-owner bulk-sends-back the valid records and is refused the rest.

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
vi.mock('../../../services/edit-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/edit-lock.js')>()),
  adminOnlyTransitionsFor: vi.fn(async () => new Set<string>()),
  adminOnlyStateOf: vi.fn(async () => null)
}))

const OPEN_WHEN = JSON.stringify([{ field: '$state', op: 'neq', value: 'waiting_on_po' }])

// The real shared settle step with a fake owner verdict (nobody here owns the
// step) and a fake record read: record 1 is valid, record 2 is waiting on PO.
vi.mock('../../../services/record-access.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/record-access.js')>()
  return {
    ...real,
    checkTransitionOwner: vi.fn(
      async (o: {
        collection: string
        item: string
        instanceId: string
        openWhen?: unknown
        isAdmin: boolean
      }) =>
        o.isAdmin
          ? { allowed: true, message: '', is_owner: false, is_creator: false }
          : real.settleOwnerVerdict(
              o,
              { is_owner: false, state: 'Manager Approval', assigned_owners: [] },
              false,
              {
                holds: async ({ item }) => item === '1',
                stateLabels: async () => new Map([['waiting_on_po', 'Waiting on PO']])
              }
            )
    )
  }
})

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
              id: 'T-SEND-BACK',
              label: 'Send Back',
              from_state: null,
              to_state: 'S0',
              required_roles: null,
              require_owner: 1,
              open_when: OPEN_WHEN
            }
          ]
        : []
    )
    return c
  })
}))

import { runDefinition } from '../../../services/bulk-actions.js'
import { checkTransitionOwner } from '../../../services/record-access.js'

const def = {
  kind: 'transition',
  collection: 'workflows',
  config: { transition_label: 'Send Back' },
  guard: []
} as never
const asPerson = { user: { id: 'u-1', role: 'R' }, isAdmin: false } as never
const asAdmin = { user: { id: 'u-admin', role: 'ADMIN' }, isAdmin: true } as never

beforeEach(() => vi.clearAllMocks())

describe('bulk transition — open_when', () => {
  it('a non-owner moves the records that meet it; the others get the owner refusal', async () => {
    const r = await runDefinition(def, ['1', '2'], 'Needs a fix', asPerson, { dryRun: true })
    expect(r.succeeded).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.outcomes[0]).toMatchObject({ item: '1', outcome: 'change' })
    expect(r.outcomes[1]).toMatchObject({
      item: '2',
      outcome: 'fail',
      reason:
        'Anyone can make this move while the record is not at Waiting on PO — this record does not meet that, so only the owner of Manager Approval can. No one owns Manager Approval on this record yet — an administrator can make it, or ask to be made the owner.'
    })
    expect(checkTransitionOwner).toHaveBeenCalledWith(
      expect.objectContaining({ item: '2', openWhen: OPEN_WHEN })
    )
  })

  it('admins are unaffected (never asked)', async () => {
    const r = await runDefinition(def, ['1', '2'], 'x', asAdmin, { dryRun: true })
    expect(r.succeeded).toBe(2)
    expect(checkTransitionOwner).not.toHaveBeenCalled()
  })
})
