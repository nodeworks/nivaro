import { beforeEach, describe, expect, it, vi } from 'vitest'

// open_when on the surfaces that OFFER and EXPLAIN moves (migration 533): the
// `$workflow_instance.available_transitions` list and the record page's
// blocked moves follow the same answer the gate gives.

vi.mock('../../../db/index.js', () => ({ db: vi.fn(), dbRead: vi.fn() }))

import { blockedMoveReasons } from '../../../services/blocked-moves.js'
import {
  applyOwnerOnly,
  type InstanceRow,
  type TransitionRow
} from '../../../services/record-instance.js'

const ME = 'AB000000-0000-4000-8000-000000000001'
const OPEN_WHEN = '[{"field":"$state","op":"neq","value":"waiting_on_po"}]'

const inst = (id: string): InstanceRow => ({
  id,
  template: 'T',
  collection: 'workflows',
  item: id.replace('i', ''),
  current_state: 'S1',
  started_at: null,
  completed_at: null
})
const tx = (id: string, extra: Partial<TransitionRow> = {}): TransitionRow => ({
  id,
  template: 'T',
  from_state: 'S1',
  to_state: 'S2',
  label: id,
  color: null,
  required_roles: null,
  sort: 0,
  ...extra
})

beforeEach(() => vi.clearAllMocks())

describe('$workflow_instance.available_transitions (applyOwnerOnly)', () => {
  const page = () => [
    {
      instance: inst('i1'),
      available: [
        tx('approve', { require_owner: true }),
        tx('send-back', { require_owner: true, open_when: OPEN_WHEN })
      ]
    },
    {
      instance: inst('i2'),
      available: [tx('send-back', { require_owner: 1, open_when: OPEN_WHEN })]
    }
  ]
  const nobody = vi.fn(async () => new Map())
  const noCreators = vi.fn(async () => new Map<string, string>())

  it('offers an open move to a non-owner only on records where it holds', async () => {
    const entries = page()
    const openOf = vi.fn(
      async (
        items: Array<{ instance: InstanceRow; moves: TransitionRow[] }>
      ): Promise<Map<string, Set<string>>> =>
        new Map(
          items.map((i) => [i.instance.id, new Set(i.instance.id === 'i1' ? ['SEND-BACK'] : [])])
        )
    )
    await applyOwnerOnly(
      entries,
      { role: 'r', isAdmin: false, userId: ME },
      nobody,
      noCreators,
      openOf as never
    )
    expect(entries[0].available.map((t) => t.id)).toEqual(['send-back'])
    expect(entries[1].available).toEqual([])
    // One call for the page; only the refused moves with an open_when are judged.
    expect(openOf).toHaveBeenCalledTimes(1)
    expect(openOf.mock.calls[0]?.[0]?.map((i) => i.moves.map((t) => t.id))).toEqual([
      ['send-back'],
      ['send-back']
    ])
  })

  it('a failed open_when read offers nothing extra', async () => {
    const entries = page()
    const openOf = vi.fn(async () => {
      throw new Error('down')
    })
    await applyOwnerOnly(
      entries,
      { role: 'r', isAdmin: false, userId: ME },
      nobody,
      noCreators,
      openOf
    )
    expect(entries.every((e) => e.available.length === 0)).toBe(true)
  })

  it('owners and admins are never judged', async () => {
    const owns = vi.fn(
      async () =>
        new Map([
          ['i1', [{ id: ME }]],
          ['i2', [{ id: ME }]]
        ])
    )
    const openOf = vi.fn(async () => new Map<string, Set<string>>())
    const entries = page()
    await applyOwnerOnly(
      entries,
      { role: 'r', isAdmin: false, userId: ME },
      owns,
      noCreators,
      openOf
    )
    expect(openOf).not.toHaveBeenCalled()
    expect(entries[0].available).toHaveLength(2)
    const adminPage = page()
    await applyOwnerOnly(
      adminPage,
      { role: 'a', isAdmin: true, userId: ME },
      nobody,
      noCreators,
      openOf
    )
    expect(openOf).not.toHaveBeenCalled()
    expect(adminPage[0].available).toHaveLength(2)
  })
})

describe('blocked moves (record page) — open_when words', () => {
  const base = {
    isAdmin: false,
    role: 'r',
    roleNames: new Map<string, string>(),
    actor: { is_owner: false, is_creator: false, step: 'Waiting on PO', owner_names: ['Pat Lee'] },
    adminOnly: new Map<string, string>(),
    skipped: new Map<string, string[]>(),
    states: [],
    currentStateId: 'S1'
  }
  const moves = [
    { id: 'send-back', to_state: 'S0', require_owner: true, open_when: OPEN_WHEN },
    { id: 'approve', to_state: 'S2', require_owner: true }
  ]

  it('a held-back move with an open_when says why it is not open here', () => {
    const out = blockedMoveReasons({
      ...base,
      candidates: moves,
      offeredIds: new Set(),
      openWhenWords: new Map([['send-back', 'the record is not at Waiting on PO']])
    })
    expect(out.map((o) => [o.move.id, o.blocked.reason])).toEqual([
      [
        'send-back',
        "Anyone can make this move while the record is not at Waiting on PO — this record does not meet that, so only the owner of Waiting on PO can. You don't own Waiting on PO on this record — Pat Lee does."
      ],
      [
        'approve',
        "Only the owner of Waiting on PO can make this move. You don't own Waiting on PO on this record — Pat Lee does."
      ]
    ])
  })

  it('an open move is on offer, never blocked', () => {
    const out = blockedMoveReasons({
      ...base,
      candidates: moves,
      offeredIds: new Set(['send-back'])
    })
    expect(out.map((o) => o.move.id)).toEqual(['approve'])
  })
})
