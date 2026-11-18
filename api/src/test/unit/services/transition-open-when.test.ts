import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Anyone can make this move when…" (open_when, migration 533): an owner-only
// move is open to anyone while its rules hold for the record — and stays
// owner-only whenever they do not, cannot be read, or name a field the record
// does not carry (fail closed).

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { addendumInProgress, addendumStepsInProgress } from '../../../services/addendum-summary.js'
import { movesToOpen, offeredToActor, settleOwnerVerdict } from '../../../services/record-access.js'
import {
  describeOpenWhen,
  hasOpenWhen,
  normalizeOpenWhen,
  openTransitionIds,
  openWhenHolds,
  openWhenHoldsOn,
  openWhenRulesFor
} from '../../../services/transition-open-when.js'
import { relatedCountKey } from '../../../services/workflow-conditions.js'

const PO = 'workflow_purchase_orders_junction:workflow'
const PO_KEY = relatedCountKey(PO, null)

/** Rob's case, as stored: workflows need no addendum in approval, no PO and
 *  not waiting on Fusion / PO; an addendum (same template) only the state limits. */
const ROB = {
  workflows: [
    { field: '$addendum_active', op: 'neq', value: 'true' },
    { field: PO, op: 'related_none', value: null },
    { field: '$state', op: 'neq', value: 'waiting_on_fusion_submission' },
    { field: '$state', op: 'neq', value: 'waiting_on_po' }
  ],
  nivaro_addendums: [
    { field: '$state', op: 'neq', value: 'waiting_on_fusion_submission' },
    { field: '$state', op: 'neq', value: 'waiting_on_po' }
  ]
}

const validWorkflow = {
  id: 7,
  $state: 'manager_approval',
  $addendum_active: false,
  [PO_KEY]: 0
}

beforeEach(() => vi.clearAllMocks())

describe('openWhenRulesFor — which rules apply to this record', () => {
  it('a plain rule list applies to every collection', () => {
    const raw = JSON.stringify([{ field: '$state', op: 'eq', value: 'a' }])
    expect(openWhenRulesFor(raw, 'workflows')).toHaveLength(1)
    expect(openWhenRulesFor(raw, 'nivaro_addendums')).toHaveLength(1)
  })

  it('a map applies per collection; a collection with no entry keeps the owner rule', () => {
    const raw = JSON.stringify(ROB)
    expect(openWhenRulesFor(raw, 'workflows')).toHaveLength(4)
    expect(openWhenRulesFor(raw, 'nivaro_addendums')).toHaveLength(2)
    expect(openWhenRulesFor(raw, 'inventory_request')).toBeNull()
  })

  it('an empty list for a collection means anyone, always; a plain empty list means not set', () => {
    expect(openWhenRulesFor(JSON.stringify({ workflows: [] }), 'workflows')).toEqual([])
    expect(openWhenRulesFor('[]', 'workflows')).toBeNull()
    expect(openWhenRulesFor(null, 'workflows')).toBeNull()
    expect(openWhenRulesFor('', 'workflows')).toBeNull()
  })

  it('fails closed on bad JSON, unknown ops, empty fields and system-table counts', () => {
    expect(openWhenRulesFor('{not json', 'workflows')).toBeNull()
    expect(openWhenRulesFor('[{"field":"x","op":"nope","value":1}]', 'workflows')).toBeNull()
    expect(openWhenRulesFor('[{"field":"","op":"eq","value":1}]', 'workflows')).toBeNull()
    expect(
      openWhenRulesFor('[{"field":"nivaro_users:id","op":"related_none"}]', 'workflows')
    ).toBeNull()
    expect(openWhenRulesFor('"text"', 'workflows')).toBeNull()
  })

  it('reads an already-parsed value too (formatTransition parses the column)', () => {
    expect(openWhenRulesFor(ROB, 'workflows')).toHaveLength(4)
  })
})

describe('openWhenHolds — the pure judgement', () => {
  const rules = ROB.workflows as never

  it('holds for a valid workflow', () => {
    expect(openWhenHolds(rules, validWorkflow)).toBe(true)
  })

  it('an addendum going through approval closes it', () => {
    expect(openWhenHolds(rules, { ...validWorkflow, $addendum_active: true })).toBe(false)
  })

  it('a purchase order closes it (related_none)', () => {
    expect(openWhenHolds(rules, { ...validWorkflow, [PO_KEY]: 1 })).toBe(false)
  })

  it('$state neq: waiting on Fusion submission / waiting on PO close it', () => {
    expect(openWhenHolds(rules, { ...validWorkflow, $state: 'waiting_on_po' })).toBe(false)
    expect(openWhenHolds(rules, { ...validWorkflow, $state: 'waiting_on_fusion_submission' })).toBe(
      false
    )
  })

  it('$state in takes a comma list', () => {
    const r = [{ field: '$state', op: 'in', value: 'draft, manager_approval' }] as never
    expect(openWhenHolds(r, { $state: 'manager_approval' })).toBe(true)
    expect(openWhenHolds(r, { $state: 'waiting_on_po' })).toBe(false)
  })

  it('$addendum_active eq/neq read booleans and "true"/"false" alike', () => {
    expect(
      openWhenHolds([{ field: '$addendum_active', op: 'eq', value: true }] as never, {
        $addendum_active: true
      })
    ).toBe(true)
    expect(
      openWhenHolds([{ field: '$addendum_active', op: 'eq', value: 'false' }] as never, {
        $addendum_active: false
      })
    ).toBe(true)
    expect(
      openWhenHolds([{ field: '$addendum_active', op: 'neq', value: 'true' }] as never, {
        $addendum_active: true
      })
    ).toBe(false)
  })

  it('a field the record does not carry fails closed (even for neq / related_none)', () => {
    expect(openWhenHolds([{ field: 'nope', op: 'neq', value: 'x' }] as never, { id: 1 })).toBe(
      false
    )
    expect(
      openWhenHolds([{ field: PO, op: 'related_none', value: null }] as never, { id: 1 })
    ).toBe(false)
    expect(openWhenHolds(rules, {})).toBe(false)
  })

  it('no rules hold (an explicit empty list = anyone)', () => {
    expect(openWhenHolds([], { id: 1 })).toBe(true)
  })
})

describe('openTransitionIds — one read for the record, fail closed', () => {
  const moves = [
    { id: 'send-back', require_owner: 1, open_when: JSON.stringify(ROB) },
    { id: 'approve', require_owner: 1, open_when: null },
    { id: 'note', require_owner: 0, open_when: JSON.stringify(ROB) }
  ]

  it('opens the owner-only moves whose rules hold — reading once, as strict', async () => {
    const read = vi.fn(async (..._a: unknown[]) => ({ ...validWorkflow }))
    const ids = await openTransitionIds({
      collection: 'workflows',
      item: '7',
      instanceId: 'inst-1',
      transitions: moves,
      read: read as never
    })
    expect([...ids]).toEqual(['SEND-BACK'])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]?.[3]).toMatchObject({
      strict: true,
      absentUnknown: true,
      instanceId: 'inst-1'
    })
  })

  it('opens nothing when the rules are false', async () => {
    const read = vi.fn(async () => ({ ...validWorkflow, [PO_KEY]: 2 }))
    const ids = await openTransitionIds({
      collection: 'workflows',
      item: '7',
      transitions: moves,
      read: read as never
    })
    expect(ids.size).toBe(0)
  })

  it('opens nothing when the read fails or finds no record', async () => {
    const fails = vi.fn(async () => {
      throw new Error('read failed')
    })
    expect(
      (
        await openTransitionIds({
          collection: 'workflows',
          item: '7',
          transitions: moves,
          read: fails as never
        })
      ).size
    ).toBe(0)
    const empty = vi.fn(async () => ({}))
    expect(
      (
        await openTransitionIds({
          collection: 'workflows',
          item: '7',
          transitions: moves,
          read: empty as never
        })
      ).size
    ).toBe(0)
  })

  it('an addendum record judges its own rules: a parent PO does not block it', async () => {
    const read = vi.fn(async () => ({ ...validWorkflow, [PO_KEY]: 3, $state: 'manager_approval' }))
    const ids = await openTransitionIds({
      collection: 'nivaro_addendums',
      item: 'a-1',
      transitions: moves,
      read: read as never
    })
    expect([...ids]).toEqual(['SEND-BACK'])
  })

  it('a collection with no entry in the map stays owner-only without a read', async () => {
    const read = vi.fn(async () => ({ ...validWorkflow }))
    const ids = await openTransitionIds({
      collection: 'inventory_request',
      item: '1',
      transitions: moves,
      read: read as never
    })
    expect(ids.size).toBe(0)
    expect(read).not.toHaveBeenCalled()
  })

  it('an empty list for the collection opens the move with no read', async () => {
    const read = vi.fn(async () => ({}))
    const ids = await openTransitionIds({
      collection: 'workflows',
      item: '1',
      transitions: [{ id: 'cancel', require_owner: true, open_when: '{"workflows":[]}' }],
      read: read as never
    })
    expect([...ids]).toEqual(['CANCEL'])
    expect(read).not.toHaveBeenCalled()
  })

  it('openWhenHoldsOn answers for one move', async () => {
    const read = vi.fn(async () => ({ ...validWorkflow }))
    expect(
      await openWhenHoldsOn({
        collection: 'workflows',
        item: '7',
        openWhen: ROB,
        read: read as never
      })
    ).toBe(true)
  })
})

describe('the owner gate with open_when (settleOwnerVerdict — every gate path)', () => {
  const opts = (openWhen: unknown) => ({
    collection: 'workflows',
    item: '7',
    instanceId: 'inst-1',
    allowCreator: false,
    openWhen
  })
  const notOwner = { is_owner: false, state: 'Manager Approval', assigned_owners: ['Pat Lee'] }
  const labels = async () => new Map([['waiting_on_po', 'Waiting on PO']])

  it('refuses a non-owner when open_when is false, and says why', async () => {
    const r = await settleOwnerVerdict(
      opts(JSON.stringify([{ field: '$state', op: 'neq', value: 'waiting_on_po' }])),
      notOwner,
      false,
      { holds: async () => false, stateLabels: labels }
    )
    expect(r.allowed).toBe(false)
    expect(r.open_when_unmet).toBe(true)
    expect(r.message).toBe(
      "Anyone can make this move while the record is not at Waiting on PO — this record does not meet that, so only the owner of Manager Approval can. You don't own Manager Approval on this record — Pat Lee does."
    )
  })

  it('allows a non-owner when open_when holds', async () => {
    const r = await settleOwnerVerdict(opts(JSON.stringify(ROB)), notOwner, false, {
      holds: async () => true
    })
    expect(r).toMatchObject({ allowed: true, open: true, message: '' })
  })

  it('fails closed when the open_when read throws or the JSON is bad', async () => {
    const throws = await settleOwnerVerdict(opts(JSON.stringify(ROB)), notOwner, false, {
      holds: async () => {
        throw new Error('db down')
      },
      stateLabels: labels
    })
    expect(throws.allowed).toBe(false)
    const holds = vi.fn(async () => true)
    const bad = await settleOwnerVerdict(opts('{oops'), notOwner, false, { holds })
    expect(bad.allowed).toBe(false)
    expect(holds).not.toHaveBeenCalled()
    expect(bad.message).toBe(
      "Only the owner of Manager Approval can make this move. You don't own Manager Approval on this record — Pat Lee does."
    )
  })

  it('owners pass without the open_when read; no open_when = today', async () => {
    const holds = vi.fn(async () => false)
    const owner = await settleOwnerVerdict(
      opts(JSON.stringify(ROB)),
      { ...notOwner, is_owner: true },
      false,
      { holds }
    )
    expect(owner.allowed).toBe(true)
    expect(holds).not.toHaveBeenCalled()
    const plain = await settleOwnerVerdict(opts(null), notOwner, false, { holds })
    expect(plain.allowed).toBe(false)
    expect(holds).not.toHaveBeenCalled()
  })

  it('a collection without an entry keeps the owner rule', async () => {
    const holds = vi.fn(async () => true)
    const r = await settleOwnerVerdict(
      { ...opts(JSON.stringify(ROB)), collection: 'inventory_request' },
      notOwner,
      false,
      { holds }
    )
    expect(r.allowed).toBe(false)
    expect(holds).not.toHaveBeenCalled()
  })
})

describe('list surfaces: offeredToActor + movesToOpen', () => {
  const moves = [
    { id: 'approve', require_owner: true, open_when: null },
    {
      id: 'send-back',
      require_owner: true,
      open_when: '[{"field":"$state","op":"neq","value":"x"}]'
    },
    { id: 'note', require_owner: false }
  ]
  const stranger = { is_owner: false, is_creator: false }

  it('only refused owner-only moves with an open_when are worth a read', () => {
    expect(movesToOpen(moves, stranger).map((m) => m.id)).toEqual(['send-back'])
    expect(movesToOpen(moves, { is_owner: true, is_creator: false })).toEqual([])
  })

  it('an open move is offered to a non-owner', () => {
    expect(offeredToActor(moves, stranger, new Set(['SEND-BACK'])).map((m) => m.id)).toEqual([
      'send-back',
      'note'
    ])
    expect(offeredToActor(moves, stranger).map((m) => m.id)).toEqual(['note'])
  })
})

describe('normalizeOpenWhen (stored shape)', () => {
  it('stores a rule list, a map (keeping empty lists), or null', () => {
    expect(normalizeOpenWhen([{ field: '$state', op: 'eq', value: 'a' }]).value).toBe(
      '[{"field":"$state","op":"eq","value":"a"}]'
    )
    expect(normalizeOpenWhen({ workflows: [] }).value).toBe('{"workflows":[]}')
    expect(normalizeOpenWhen([]).value).toBeNull()
    expect(normalizeOpenWhen([{ field: '', op: 'eq', value: '' }]).value).toBeNull()
    expect(normalizeOpenWhen(null).value).toBeNull()
  })

  it('refuses what it cannot use', () => {
    expect(normalizeOpenWhen('{bad').error).toBeTruthy()
    expect(normalizeOpenWhen([{ field: 'x', op: 'bogus' }]).error).toBeTruthy()
    expect(normalizeOpenWhen({ 'bad name': [] }).error).toBeTruthy()
    expect(normalizeOpenWhen({ workflows: 'x' }).error).toBeTruthy()
  })

  it('hasOpenWhen tells set from not set', () => {
    expect(hasOpenWhen(JSON.stringify(ROB))).toBe(true)
    expect(hasOpenWhen('{"workflows":[]}')).toBe(true)
    expect(hasOpenWhen('[]')).toBe(false)
    expect(hasOpenWhen(null)).toBe(false)
  })
})

describe('describeOpenWhen', () => {
  it("reads Rob's workflow rules", () => {
    const labels = new Map([
      ['waiting_on_po', 'Waiting on PO'],
      ['waiting_on_fusion_submission', 'Waiting on Fusion Submission']
    ])
    expect(describeOpenWhen(ROB.workflows as never, labels)).toBe(
      'no addendum is going through approval, it has no Workflow purchase orders junction rows, the record is not at Waiting on Fusion Submission and the record is not at Waiting on PO'
    )
    expect(describeOpenWhen([], labels)).toBeNull()
  })
})

describe('$addendum_active comes from the addendum pipeline', () => {
  it('a step that is not terminal is in progress; terminal or none is not', () => {
    expect(addendumStepsInProgress([{ is_terminal: false }])).toBe(true)
    expect(addendumStepsInProgress([{ is_terminal: null }])).toBe(true)
    expect(addendumStepsInProgress([{ is_terminal: 1 }])).toBe(false)
    expect(addendumStepsInProgress([{ is_terminal: true }, { is_terminal: 1 }])).toBe(false)
    expect(addendumStepsInProgress([])).toBe(false)
  })

  it('reads the addendums of THIS record through their instances (no status column)', async () => {
    const calls: Array<[string, unknown[]]> = []
    const chain: Record<string, unknown> = {}
    for (const m of ['join', 'where']) {
      chain[m] = vi.fn((...a: unknown[]) => {
        calls.push([m, a])
        return chain
      })
    }
    chain.select = vi.fn(async () => [{ is_terminal: 0 }])
    const fake = Object.assign(
      vi.fn(() => chain),
      { raw: vi.fn((sql: string) => sql) }
    )
    expect(await addendumInProgress('workflows', '372789', fake as never)).toBe(true)
    expect(fake).toHaveBeenCalledWith('nivaro_addendums as a')
    expect(calls.filter(([m]) => m === 'where').map(([, a]) => a)).toEqual([
      ['a.parent_collection', 'workflows'],
      ['a.parent_id', '372789']
    ])
    // Never filtered by nivaro_addendums.status.
    expect(JSON.stringify(calls)).not.toContain('status')
    void db
  })
})
