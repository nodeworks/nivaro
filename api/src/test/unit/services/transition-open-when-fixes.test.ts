import { beforeEach, describe, expect, it, vi } from 'vitest'

// open_when review round 1: every rule must be usable as written, `$state`
// values must be steps of the template (a renamed key never opens a move),
// the stored shape is canonical, turning owner-only off clears the rules, and
// Rob's real config (2026-11-18) works exactly as meant.

vi.mock('../../../db/index.js', () => ({ db: vi.fn(), dbRead: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../services/permissions.js', () => ({
  getAllowedFields: vi.fn(async () => ['id', 'title']),
  can: vi.fn(async (_u: unknown, _a: string, c: string) => c === 'readable_links')
}))

import {
  describeOpenWhen,
  normalizeOpenWhen,
  openTransitionIds,
  openWhenForPatch,
  openWhenRulesFor,
  renameStateKeyInOpenWhen,
  rewriteOpenWhenStateKey,
  ruleReadJudge,
  settleOpenWhen,
  stateRulesKnown,
  unknownStateKeys
} from '../../../services/transition-open-when.js'
import { relatedCountKey } from '../../../services/workflow-conditions.js'

const PO = 'workflow_purchase_orders_junction:workflow'

// ── Rob's config, exactly as it will be applied (open-when-config.md) ──────
const WORKFLOW_APPROVAL = {
  workflows: [
    { field: '$addendum_active', op: 'neq', value: 'true' },
    { field: PO, op: 'related_none', value: null },
    { field: '$state', op: 'neq', value: 'waiting_on_oracle_submission' },
    { field: '$state', op: 'neq', value: 'waiting_on_po' },
    { field: '$state', op: 'neq', value: 'waiting_on_beeline_submission' }
  ],
  nivaro_addendums: [
    { field: '$state', op: 'neq', value: 'waiting_on_oracle_submission' },
    { field: '$state', op: 'neq', value: 'waiting_on_po' },
    { field: '$state', op: 'neq', value: 'waiting_on_beeline_submission' }
  ]
}
const INVENTORY_REQUEST_APPROVAL = {
  inventory_request: [
    { field: '$state', op: 'neq', value: 'order_submission' },
    { field: '$state', op: 'neq', value: 'warehouse_submission' }
  ]
}
const WF_KEYS = new Set([
  'draft',
  'manager_approval',
  'waiting_on_oracle_submission',
  'waiting_on_po',
  'waiting_on_beeline_submission',
  'completed',
  'canceled'
])
const IR_KEYS = new Set(['draft', 'order_submission', 'warehouse_submission', 'completed'])

const reader = (record: Record<string, unknown>) => vi.fn(async () => record)
const move = (openWhen: unknown) => [{ id: 'sb', require_owner: 1, open_when: openWhen }]

beforeEach(() => vi.clearAllMocks())

describe("Rob's Send Back / Cancel config (2026-11-18)", () => {
  it('stores as written', () => {
    expect(normalizeOpenWhen(WORKFLOW_APPROVAL).error).toBeUndefined()
    expect(JSON.parse(normalizeOpenWhen(WORKFLOW_APPROVAL).value as string)).toEqual(
      WORKFLOW_APPROVAL
    )
    expect(normalizeOpenWhen(INVENTORY_REQUEST_APPROVAL).error).toBeUndefined()
    expect(unknownStateKeys(JSON.stringify(WORKFLOW_APPROVAL), WF_KEYS)).toEqual([])
    expect(unknownStateKeys(JSON.stringify(INVENTORY_REQUEST_APPROVAL), IR_KEYS)).toEqual([])
  })

  const judge = (collection: string, ow: unknown, keys: Set<string>, rec: object) =>
    openTransitionIds({
      collection,
      item: '1',
      instanceId: 'i',
      transitions: move(JSON.stringify(ow)),
      stateKeys: keys,
      read: reader({ id: 1, ...rec }) as never
    }).then((s) => s.has('SB'))

  const valid = { $state: 'manager_approval', $addendum_active: false, [PO]: 0 }

  it('a valid workflow is open to anyone; each disqualifier keeps it owner-only', async () => {
    expect(await judge('workflows', WORKFLOW_APPROVAL, WF_KEYS, valid)).toBe(true)
    expect(
      await judge('workflows', WORKFLOW_APPROVAL, WF_KEYS, { ...valid, $addendum_active: true })
    ).toBe(false)
    expect(await judge('workflows', WORKFLOW_APPROVAL, WF_KEYS, { ...valid, [PO]: 1 })).toBe(false)
    for (const step of [
      'waiting_on_oracle_submission',
      'waiting_on_po',
      'waiting_on_beeline_submission'
    ])
      expect(await judge('workflows', WORKFLOW_APPROVAL, WF_KEYS, { ...valid, $state: step })).toBe(
        false
      )
  })

  it("an addendum's own move is open even when the parent has a PO; its steps still limit it", async () => {
    const addendum = { $state: 'manager_approval', [PO]: 4 }
    expect(await judge('nivaro_addendums', WORKFLOW_APPROVAL, WF_KEYS, addendum)).toBe(true)
    expect(
      await judge('nivaro_addendums', WORKFLOW_APPROVAL, WF_KEYS, {
        ...addendum,
        $state: 'waiting_on_po'
      })
    ).toBe(false)
  })

  it('inventory requests: open except Order Submission and Warehouse Submission', async () => {
    expect(
      await judge('inventory_request', INVENTORY_REQUEST_APPROVAL, IR_KEYS, { $state: 'draft' })
    ).toBe(true)
    for (const step of ['order_submission', 'warehouse_submission'])
      expect(
        await judge('inventory_request', INVENTORY_REQUEST_APPROVAL, IR_KEYS, { $state: step })
      ).toBe(false)
    // The workflow template's rules say nothing for inventory requests.
    expect(await judge('inventory_request', WORKFLOW_APPROVAL, WF_KEYS, valid)).toBe(false)
  })
})

describe('1 — a $state value that names no step never opens', () => {
  it('an empty value is unusable at save and at judging', () => {
    expect(normalizeOpenWhen([{ field: '$state', op: 'neq', value: '' }]).error).toBeTruthy()
    expect(normalizeOpenWhen([{ field: '$state', op: 'neq', value: ' , ' }]).error).toBeTruthy()
    expect(normalizeOpenWhen([{ field: 'amount', op: 'gt', value: '' }]).error).toBeTruthy()
    expect(normalizeOpenWhen([{ field: 'amount', op: 'gt' }]).error).toBeTruthy()
    // Ops that take no value still save.
    expect(normalizeOpenWhen([{ field: 'vendor', op: 'null' }]).error).toBeUndefined()
    expect(normalizeOpenWhen([{ field: PO, op: 'related_none', value: null }]).error).toBe(
      undefined
    )
    expect(openWhenRulesFor('[{"field":"$state","op":"neq","value":""}]', 'workflows')).toBeNull()
    expect(normalizeOpenWhen([{ field: '$state', op: 'gt', value: 'x' }]).error).toBeTruthy()
  })

  it('a key that is not a step of the template makes the set unusable (no read)', async () => {
    const renamed = JSON.stringify([{ field: '$state', op: 'neq', value: 'waiting_on_fusion' }])
    expect(openWhenRulesFor(renamed, 'workflows', WF_KEYS)).toBeNull()
    expect(
      stateRulesKnown([{ field: '$state', op: 'in', value: 'draft, waiting_on_po' }], WF_KEYS)
    ).toBe(true)
    // Round 2: keys are compared EXACTLY (the evaluator does) — another case is unknown.
    expect(
      stateRulesKnown([{ field: '$state', op: 'in', value: 'draft, WAITING_ON_PO' }], WF_KEYS)
    ).toBe(false)
    const read = reader({ id: 1, $state: 'manager_approval' })
    const ids = await openTransitionIds({
      collection: 'workflows',
      item: '1',
      instanceId: 'i',
      transitions: move(renamed),
      stateKeys: WF_KEYS,
      read: read as never
    })
    expect(ids.size).toBe(0)
    expect(read).not.toHaveBeenCalled()
  })

  it('with no step keys known (instance unreadable) a $state rule keeps the owner rule', async () => {
    const ids = await openTransitionIds({
      collection: 'workflows',
      item: '1',
      instanceId: 'i',
      transitions: move('[{"field":"$state","op":"neq","value":"waiting_on_po"}]'),
      stateKeys: new Set(),
      read: reader({ id: 1, $state: 'draft' }) as never
    })
    expect(ids.size).toBe(0)
  })

  it('save refuses a value that is not a step of the template, naming it', async () => {
    const fake = vi.fn(() => ({
      where: () => ({ select: async () => [...WF_KEYS].map((key) => ({ key })) })
    }))
    const r = await settleOpenWhen(
      'tpl',
      [{ field: '$state', op: 'neq', value: 'waiting_on_fusion' }],
      true,
      fake as never
    )
    expect(r.value).toBeNull()
    expect(r.error).toBe('open_when names a step that is not on this pipeline: waiting_on_fusion')
    const ok = await settleOpenWhen('tpl', WORKFLOW_APPROVAL, true, fake as never)
    expect(ok.error).toBeUndefined()
    expect(ok.value).toBe(JSON.stringify(WORKFLOW_APPROVAL))
  })

  it('a renamed step key is rewritten in the template open_when (rewrite, not refuse)', async () => {
    expect(
      JSON.parse(
        renameStateKeyInOpenWhen(
          JSON.stringify(WORKFLOW_APPROVAL),
          'waiting_on_po',
          'awaiting_po'
        ) as string
      ).workflows[3]
    ).toEqual({ field: '$state', op: 'neq', value: 'awaiting_po' })
    expect(
      renameStateKeyInOpenWhen(
        '[{"field":"$state","op":"in","value":"draft, waiting_on_po"}]',
        'waiting_on_po',
        'awaiting_po'
      )
    ).toBe('[{"field":"$state","op":"in","value":"draft,awaiting_po"}]')
    expect(renameStateKeyInOpenWhen(JSON.stringify(WORKFLOW_APPROVAL), 'nope', 'x')).toBeNull()

    const updates: Array<{ id: string; open_when: string }> = []
    const rows = [
      { id: 't1', open_when: JSON.stringify(WORKFLOW_APPROVAL) },
      { id: 't2', open_when: '{"workflows":[]}' }
    ]
    const trx = vi.fn((_table: string) => {
      let id = ''
      const c: Record<string, unknown> = {}
      c.where = (w: { id?: string }) => {
        if (w.id) id = w.id
        return c
      }
      c.whereNotNull = () => c
      c.select = async () => rows
      c.update = async (v: { open_when: string }) => {
        updates.push({ id, open_when: v.open_when })
        return 1
      }
      return c
    })
    expect(await rewriteOpenWhenStateKey(trx as never, 'tpl', 'waiting_on_po', 'awaiting_po')).toBe(
      1
    )
    expect(updates.map((u) => u.id)).toEqual(['t1'])
    expect(unknownStateKeys(updates[0].open_when, new Set([...WF_KEYS, 'awaiting_po']))).toEqual([])
  })
})

describe('5 — a record that is not there opens nothing', () => {
  it('virtual fields alone (no id) do not count as a record', async () => {
    const ids = await openTransitionIds({
      collection: 'workflows',
      item: '404',
      instanceId: 'i',
      transitions: move('[{"field":"$state","op":"neq","value":"waiting_on_po"}]'),
      stateKeys: WF_KEYS,
      read: reader({ $state: 'draft', $addendum_active: false }) as never
    })
    expect(ids.size).toBe(0)
  })
})

describe('7 — refusal words name only what the viewer may read', () => {
  const rules = [
    { field: '$state', op: 'neq', value: 'waiting_on_po' },
    { field: 'title', op: 'nnull', value: null },
    { field: 'secret_amount', op: 'gt', value: '1000' },
    { field: 'project.budget', op: 'gt', value: '5' },
    { field: 'readable_links:workflow', op: 'related_none', value: null },
    { field: 'hidden_links:workflow', op: 'related_none', value: null }
  ] as never[]
  const labels = new Map([['waiting_on_po', 'Waiting on PO']])

  it('a non-admin hears the readable parts and "a condition this record doesn\'t meet"', async () => {
    const canRead = await ruleReadJudge(
      { user: { id: 'u', role: 'r' }, isAdmin: false },
      'workflows',
      rules
    )
    expect(describeOpenWhen(rules, labels, canRead)).toBe(
      'the record is not at Waiting on PO, Title is set, it has no Readable links rows and a condition this record doesn’t meet'
    )
  })

  it('an admin hears every rule; no viewer hears only the step and addendum facts', async () => {
    const admin = await ruleReadJudge({ isAdmin: true }, 'workflows', rules)
    expect(describeOpenWhen(rules, labels, admin)).toContain('Secret amount is over 1000')
    const none = await ruleReadJudge(null, 'workflows', rules)
    expect(describeOpenWhen(rules, labels, none)).toBe(
      'the record is not at Waiting on PO and a condition this record doesn’t meet'
    )
  })

  it('on an addendum, record fields (read from its parent) are never named to a non-admin', async () => {
    const canRead = await ruleReadJudge(
      { user: { id: 'u', role: 'r' }, isAdmin: false },
      'nivaro_addendums',
      rules
    )
    expect(canRead(rules[1] as never)).toBe(false)
  })
})

describe('8 — $addendum_active is stored as "true" / "false" only', () => {
  it('booleans become strings; anything else is refused', () => {
    expect(normalizeOpenWhen([{ field: '$addendum_active', op: 'eq', value: true }]).value).toBe(
      '[{"field":"$addendum_active","op":"eq","value":"true"}]'
    )
    for (const value of ['yes', '1', 1, 'TRUE', ''])
      expect(normalizeOpenWhen([{ field: '$addendum_active', op: 'eq', value }]).error).toBeTruthy()
    expect(normalizeOpenWhen([{ field: '$addendum_active', op: 'gt', value: 'true' }]).error).toBe(
      'open_when: Addendum going through approval takes is / is not'
    )
  })
})

describe('12 — owner-only off clears open_when', () => {
  it('nothing is stored without require_owner, whatever is sent', async () => {
    const fake = vi.fn()
    expect(await settleOpenWhen('tpl', WORKFLOW_APPROVAL, false, fake as never)).toEqual({
      value: null
    })
    expect(fake).not.toHaveBeenCalled()
  })
})

describe('12 — a PATCH that turns owner-only off clears open_when in the same write', () => {
  const states = vi.fn(() => ({
    where: () => ({ select: async () => [...WF_KEYS].map((key) => ({ key })) })
  }))
  const patch = (o: Partial<Parameters<typeof openWhenForPatch>[0]>) =>
    openWhenForPatch(
      {
        templateId: 'tpl',
        storedRequireOwner: 1,
        bodyRequireOwner: undefined,
        bodyOpenWhen: undefined,
        ...o
      },
      states as never
    )

  it('off → cleared, even when the body sends rules', async () => {
    expect(await patch({ bodyRequireOwner: false })).toEqual({ value: null })
    expect(await patch({ bodyRequireOwner: false, bodyOpenWhen: WORKFLOW_APPROVAL })).toEqual({
      value: null
    })
  })

  it('untouched → left alone; rules on an owner-only move → settled', async () => {
    expect(await patch({})).toBeNull()
    expect((await patch({ bodyOpenWhen: WORKFLOW_APPROVAL }))?.value).toBe(
      JSON.stringify(WORKFLOW_APPROVAL)
    )
    // Rules sent for a move that is not owner-only are not stored.
    expect(await patch({ storedRequireOwner: 0, bodyOpenWhen: WORKFLOW_APPROVAL })).toEqual({
      value: null
    })
  })
})

describe('related count key', () => {
  it('is the bare field for a filterless count (what the page batch fills)', () => {
    expect(relatedCountKey(PO, null)).toBe(PO)
  })
})
