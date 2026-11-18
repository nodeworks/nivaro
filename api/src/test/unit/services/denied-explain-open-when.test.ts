import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Why can't I?" for an owner-only move with an open_when (migration 533):
// the explanation asks the same owner gate the move does and says the same
// sentence — anyone could make it while the conditions hold, this record does
// not meet them.

const OPEN_WHEN = JSON.stringify({
  workflows: [{ field: '$state', op: 'neq', value: 'waiting_on_po' }]
})

vi.mock('../../../services/access-explain.js', () => ({
  explainAccess: vi.fn(async () => ({ access: true, reasons: [] })),
  viewerSafeReasons: (r: unknown[]) => r
}))
vi.mock('../../../services/permissions.js', () => ({
  applyRowFilter: vi.fn(),
  can: vi.fn(async () => true),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/lock-presence.js', () => ({ lockIsLive: () => false }))
vi.mock('../../../services/owner-explain.js', () => ({
  explainRecordOwners: vi.fn(async () => ({ owners: [{ name: 'Pat Lee', unavailable: false }] }))
}))

const main = vi.hoisted(() => ({
  instance: { id: 'inst-main', current_state: 'S-PO', template: 'tpl' } as Record<string, unknown>
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => main.instance)
}))

let holds = false
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
              { is_owner: false, state: 'Waiting on PO', assigned_owners: ['Pat Lee'] },
              false,
              {
                holds: async () => holds,
                stateLabels: async () => new Map([['waiting_on_po', 'Waiting on PO']])
              }
            )
    )
  }
})

vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => {
    const rows: Record<string, unknown> = {
      nivaro_workflow_transitions: {
        template: 'tpl',
        label: 'Send Back',
        from_state: null,
        required_roles: null,
        require_owner: 1,
        open_when: OPEN_WHEN
      },
      nivaro_workflow_instances: { id: 'inst-1', current_state: 'S-PO' },
      nivaro_users: { id: 'u-1', role: 'R' }
    }
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'leftJoin', 'orderBy', 'orderByRaw', 'select'])
      c[m] = vi.fn(() => c)
    c.first = vi.fn(() => Promise.resolve(t.startsWith('nivaro_item_locks') ? null : rows[t]))
    c.catch = (fn: unknown) => Promise.resolve(c).catch(fn as never)
    return c
  })
}))

import { explainDenied } from '../../../services/denied-explain.js'
import { checkTransitionOwner } from '../../../services/record-access.js'

const user = { id: 'u-1', role: 'R' } as never

beforeEach(() => {
  vi.clearAllMocks()
  holds = false
})

describe('explainDenied — open_when', () => {
  it('says anyone could make it while the conditions hold, and this record does not', async () => {
    const ex = await explainDenied(user, false, {
      collection: 'workflows',
      id: '7',
      action: 'transition',
      transitionId: 'T-SB'
    })
    expect(checkTransitionOwner).toHaveBeenCalledWith(
      expect.objectContaining({ openWhen: OPEN_WHEN, instanceId: 'inst-main' })
    )
    const owner = ex.reasons.find((r) => r.type === 'transition_owner')
    expect(owner?.message).toBe(
      "Anyone can make this move while the record is not at Waiting on PO — this record does not meet that, so only the owner of Waiting on PO can. You don't own Waiting on PO on this record — Pat Lee does."
    )
  })

  it('no owner reason while the conditions hold', async () => {
    holds = true
    const ex = await explainDenied(user, false, {
      collection: 'workflows',
      id: '7',
      action: 'transition',
      transitionId: 'T-SB'
    })
    expect(ex.reasons.find((r) => r.type === 'transition_owner')).toBeUndefined()
  })

  it("judges the record's current instance (as the gate does); a branch move falls back to its template's", async () => {
    main.instance = { id: 'inst-other', current_state: 'X', template: 'another-template' }
    await explainDenied(user, false, {
      collection: 'workflows',
      id: '7',
      action: 'transition',
      transitionId: 'T-SB'
    })
    expect(checkTransitionOwner).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1' })
    )
    main.instance = { id: 'inst-main', current_state: 'S-PO', template: 'tpl' }
  })
})
