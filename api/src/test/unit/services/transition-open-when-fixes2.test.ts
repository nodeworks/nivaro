import { beforeEach, describe, expect, it, vi } from 'vitest'

// open_when review round 2: `$state` values are the template's EXACT keys
// (the evaluator compares as written), renames of any kind are rewritten
// without overwriting a concurrent edit, children_* rules are refused, an
// unknown step is never read as "not at X", columns are matched the same way
// on every path, and refusal words are said only for a set the gate can use.

vi.mock('../../../db/index.js', () => ({ db: vi.fn(), dbRead: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))

import { settleOwnerVerdict } from '../../../services/record-access.js'
import {
  normalizeOpenWhen,
  OPEN_WHEN_READ,
  openTransitionIds,
  openTransitionIdsBatch,
  openWhenHolds,
  openWhenRulesFor,
  renameStateKeyInOpenWhen,
  rewriteOpenWhenStateKey,
  settleOpenWhen,
  stepsOfInstanceTemplate
} from '../../../services/transition-open-when.js'

const KEYS = new Set(['draft', 'manager_approval', 'waiting_on_po', 'completed'])
const statesDb = vi.fn(() => ({
  where: () => ({ select: async () => [...KEYS].map((key) => ({ key })) })
}))
const move = (ow: unknown) => [{ id: 'sb', require_owner: 1, open_when: JSON.stringify(ow) }]
const judge = (ow: unknown, record: Record<string, unknown>, keys = KEYS) =>
  openTransitionIds({
    collection: 'workflows',
    item: '1',
    instanceId: 'i',
    transitions: move(ow),
    stateKeys: keys,
    read: vi.fn(async () => ({ id: 1, ...record })) as never
  }).then((s) => s.has('SB'))

beforeEach(() => vi.clearAllMocks())

describe('1 — $state values are exact keys', () => {
  it('save rewrites a key typed in another case or with spaces to the exact key', async () => {
    const r = await settleOpenWhen(
      'tpl',
      [
        { field: '$state', op: 'neq', value: 'WAITING_ON_PO' },
        { field: '$state', op: 'neq', value: ' waiting_on_po ' },
        { field: '$state', op: 'in', value: 'Draft , COMPLETED' }
      ],
      true,
      statesDb as never
    )
    expect(r.error).toBeUndefined()
    expect(JSON.parse(r.value as string)).toEqual([
      { field: '$state', op: 'neq', value: 'waiting_on_po' },
      { field: '$state', op: 'neq', value: 'waiting_on_po' },
      { field: '$state', op: 'in', value: 'draft,completed' }
    ])
  })

  it('is / is not refuse a list (use "is one of")', () => {
    const r = normalizeOpenWhen([{ field: '$state', op: 'neq', value: 'waiting_on_po,completed' }])
    expect(r.value).toBeNull()
    expect(r.error).toBe(
      'open_when: Current step "is" / "is not" takes one step — use "is one of" for a list'
    )
  })

  it('a stored value that is not an exact, untrimmed key keeps the owner rule', async () => {
    const at = { $state: 'manager_approval' }
    expect(await judge([{ field: '$state', op: 'neq', value: 'waiting_on_po' }], at)).toBe(true)
    for (const value of ['WAITING_ON_PO', ' waiting_on_po', 'waiting_on_po,completed'])
      expect(await judge([{ field: '$state', op: 'neq', value }], at)).toBe(false)
    expect(
      openWhenRulesFor('[{"field":"$state","op":"neq","value":"Waiting_On_PO"}]', 'workflows', KEYS)
    ).toBeNull()
  })
})

describe('2 — a case-only rename is rewritten too', () => {
  it('rewrites whenever the key changes, comparing exactly', () => {
    const raw = '[{"field":"$state","op":"neq","value":"waiting_on_po"}]'
    expect(renameStateKeyInOpenWhen(raw, 'waiting_on_po', 'Waiting_On_PO')).toBe(
      '[{"field":"$state","op":"neq","value":"Waiting_On_PO"}]'
    )
    expect(renameStateKeyInOpenWhen(raw, 'waiting_on_po', 'waiting_on_po')).toBeNull()
    // Another key that only differs in case is a different key — untouched.
    expect(renameStateKeyInOpenWhen(raw, 'WAITING_ON_PO', 'x')).toBeNull()
  })
})

describe('3 — children_* rules are refused in open_when', () => {
  it('on save with a clear message, and as unusable when judged', async () => {
    for (const op of ['children_in_state', 'children_not_in_state']) {
      const rule = { field: 'workflow_lines:workflow', op, value: 'ordred' }
      expect(normalizeOpenWhen([rule]).error).toBe(
        `open_when: ${op} cannot be used in "Anyone can make this move when…" — use linked rows instead`
      )
      expect(
        await judge([rule], { 'workflow_lines:workflow\u0001ordred': { total: 3, matched: 0 } })
      ).toBe(false)
    }
  })
})

describe('4 — no step to read is unknown, never "not at X"', () => {
  const neq = [{ field: '$state', op: 'neq', value: 'waiting_on_po' }]
  it('a record without $state on it keeps the owner rule', async () => {
    expect(await judge(neq, {})).toBe(false)
  })

  it('the page batch leaves an unknown or missing step off the record', async () => {
    const { db } = await import('../../../db/index.js')
    const rowsDb = vi.fn(() => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'where', 'whereIn', 'whereRaw']) c[m] = vi.fn(() => c)
      // biome-ignore lint/suspicious/noThenProperty: knex-shaped thenable fake
      c.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve([{ id: 1 }, { id: 2 }, { id: 3 }]).then(ok)
      return c
    })
    vi.mocked(db).mockImplementation(rowsDb as never)
    vi.doMock('../../../services/collections.js', () => ({
      getPhysicalColumns: vi.fn(async () => new Set(['id']))
    }))
    const entry = (key: string, stateKey: string | null) => ({
      key,
      collection: 'workflows',
      item: { a: '1', b: '2', c: '3' }[key] as string,
      instanceId: key,
      stateKey,
      stateKeys: KEYS,
      moves: move(neq)
    })
    const out = await openTransitionIdsBatch(
      [entry('a', null), entry('b', 'gone_step'), entry('c', 'manager_approval')],
      rowsDb as never
    )
    expect(out.get('a')?.size).toBe(0)
    expect(out.get('b')?.size).toBe(0)
    // Control: a known step that is not waiting on PO opens.
    expect([...(out.get('c') ?? [])]).toEqual(['SB'])
  })
})

describe('5 — column names are matched the same way on every path', () => {
  const rules = [{ field: 'Amount', op: 'lt', value: '1000' }] as never
  it('a rule field in another case reads the column (select * casing or the alias)', () => {
    expect(openWhenHolds(rules, { id: 1, amount: 10 })).toBe(true)
    expect(openWhenHolds(rules, { id: 1, Amount: 10 })).toBe(true)
    expect(openWhenHolds(rules, { id: 1, amount: 5000 })).toBe(false)
  })
  it('two keys equal ignoring case are ambiguous — unknown', () => {
    expect(openWhenHolds(rules, { id: 1, amount: 10, AMOUNT: 10 })).toBe(false)
  })
})

describe('6 — $state is judged against the instance template', () => {
  it('reuses the loaded steps for the same template, reads the other one otherwise', async () => {
    const loaded = [{ key: 'manager_approval', label: 'Manager Approval' }]
    expect(await stepsOfInstanceTemplate('TPL', 'tpl', loaded, vi.fn() as never)).toEqual([
      { key: 'manager_approval', label: 'Manager Approval' }
    ])
    const other = vi.fn(() => ({
      where: (w: { template: string }) => ({
        select: async () =>
          w.template === 'addendum-tpl' ? [{ key: 'review', label: 'Review' }] : []
      })
    }))
    expect(await stepsOfInstanceTemplate('addendum-tpl', 'tpl', loaded, other as never)).toEqual([
      { key: 'review', label: 'Review' }
    ])
    const broken = vi.fn(() => {
      throw new Error('down')
    })
    expect(await stepsOfInstanceTemplate('x', 'tpl', loaded, broken as never)).toEqual([])
  })
})

describe('7 — an unusable set is never described as "Anyone can make this move while…"', () => {
  const notOwner = { is_owner: false, state: 'Manager Approval', assigned_owners: ['Pat Lee'] }
  const opts = (openWhen: unknown) => ({
    collection: 'workflows',
    item: '7',
    instanceId: 'inst-1',
    openWhen: JSON.stringify(openWhen)
  })
  it('a step the instance template does not have → the plain owner sentence', async () => {
    const r = await settleOwnerVerdict(
      opts([{ field: '$state', op: 'neq', value: 'waiting_on_fusion' }]),
      notOwner,
      false,
      {
        holds: async () => false,
        stateLabels: async () => new Map([['waiting_on_po', 'Waiting on PO']])
      }
    )
    expect(r.allowed).toBe(false)
    expect(r.open_when_unmet).toBeUndefined()
    expect(r.message).toBe(
      "Only the owner of Manager Approval can make this move. You don't own Manager Approval on this record — Pat Lee does."
    )
  })
})

describe('8 — the rename rewrite never overwrites a concurrent edit', () => {
  it('compares-and-sets on the text read, re-reads on a miss, stays in its template', async () => {
    const OLD = '[{"field":"$state","op":"neq","value":"waiting_on_po"}]'
    const CONCURRENT = '[{"field":"$state","op":"in","value":"draft,waiting_on_po"}]'
    const store = new Map<string, { template: string; open_when: string }>([
      ['t1', { template: 'tpl', open_when: OLD }],
      ['t-other', { template: 'other', open_when: OLD }]
    ])
    let raced = false
    const trx = vi.fn((_table: string) => {
      let filter: Record<string, unknown> = {}
      const c: Record<string, unknown> = {}
      const match = () =>
        [...store].filter(([id, r]) =>
          Object.entries(filter).every(([k, v]) => (k === 'id' ? id === v : (r as never)[k] === v))
        )
      c.where = (w: Record<string, unknown>) => {
        filter = { ...filter, ...w }
        return c
      }
      c.whereNotNull = () => c
      c.select = async () => match().map(([id, r]) => ({ id, open_when: r.open_when }))
      c.first = async () => match()[0]?.[1]
      c.update = async (v: { open_when: string }) => {
        // Someone saves t1 between the read and the first write.
        if (!raced) {
          raced = true
          store.set('t1', { template: 'tpl', open_when: CONCURRENT })
        }
        const hits = match()
        for (const [id, r] of hits) store.set(id, { ...r, open_when: v.open_when })
        return hits.length
      }
      return c
    })
    expect(await rewriteOpenWhenStateKey(trx as never, 'tpl', 'waiting_on_po', 'awaiting_po')).toBe(
      1
    )
    // The concurrent edit is kept, with the key rewritten in it.
    expect(store.get('t1')?.open_when).toBe(
      '[{"field":"$state","op":"in","value":"draft,awaiting_po"}]'
    )
    // Another template's transition is never touched.
    expect(store.get('t-other')?.open_when).toBe(OLD)
  })
})

describe('9 — wiring', () => {
  it('every open_when read fails closed on everything unknown', async () => {
    expect(OPEN_WHEN_READ).toEqual({
      strict: true,
      absentUnknown: true,
      strictFilters: true,
      noOverlay: true
    })
    const read = vi.fn(async () => ({ id: 1, $state: 'draft' }))
    await openTransitionIds({
      collection: 'workflows',
      item: '1',
      instanceId: 'i',
      transitions: move([{ field: '$state', op: 'neq', value: 'waiting_on_po' }]),
      stateKeys: KEYS,
      read: read as never
    })
    expect(read).toHaveBeenCalledWith(
      'workflows',
      '1',
      expect.any(Array),
      expect.objectContaining({
        strict: true,
        absentUnknown: true,
        strictFilters: true,
        noOverlay: true,
        instanceId: 'i'
      })
    )
  })
})
