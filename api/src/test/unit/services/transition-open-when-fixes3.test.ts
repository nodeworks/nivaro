import { beforeEach, describe, expect, it, vi } from 'vitest'

// open_when review round 3: `$` names are exact, nothing is cleaned away into
// "anyone", a collection named twice is unusable, the single gate checks the
// step belongs to the instance's template, and an addendum whose step is
// missing counts as in progress.

vi.mock('../../../db/index.js', () => ({ db: vi.fn(), dbRead: vi.fn() }))

import {
  addendumInProgress,
  addendumStepsInProgress,
  addendumsInProgressFor
} from '../../../services/addendum-summary.js'
import {
  normalizeOpenWhen,
  openTransitionIds,
  openWhenHolds,
  openWhenRulesFor
} from '../../../services/transition-open-when.js'

const KEYS = new Set(['draft', 'manager_approval', 'waiting_on_po'])
const move = (ow: unknown) => [{ id: 'sb', require_owner: 1, open_when: JSON.stringify(ow) }]
const judge = (ow: unknown, record: Record<string, unknown>, collection = 'workflows') =>
  openTransitionIds({
    collection,
    item: '1',
    instanceId: 'i',
    transitions: move(ow),
    stateKeys: KEYS,
    read: vi.fn(async () => ({ id: 1, ...record })) as never
  }).then((s) => s.has('SB'))

beforeEach(() => vi.clearAllMocks())

describe('A — $ names are exact and never folded', () => {
  it('$State / $Addendum_Active are refused on save and unusable when judged', async () => {
    for (const field of ['$State', '$Addendum_Active', '$anything']) {
      expect(normalizeOpenWhen([{ field, op: 'neq', value: 'x' }]).error).toBe(
        `open_when: "${field}" is not a field (use $state or $addendum_active)`
      )
      expect(openWhenRulesFor(JSON.stringify([{ field, op: 'neq', value: 'x' }]), 'w')).toBeNull()
    }
    expect(
      await judge([{ field: '$State', op: 'neq', value: 'waiting_on_po' }], {
        $state: 'manager_approval'
      })
    ).toBe(false)
  })

  it('the record lookup never folds a $ name or a linked count onto another key', () => {
    // Exact names still read.
    expect(
      openWhenHolds([{ field: '$state', op: 'neq', value: 'x' }] as never, { $state: 'draft' })
    ).toBe(true)
    // A linked-row count under another case is not the rule's count.
    expect(
      openWhenHolds([{ field: 'Lines:workflow', op: 'related_none', value: null }] as never, {
        'lines:workflow': 0
      })
    ).toBe(false)
  })
})

describe('B — a rule with no field is refused, never cleaned into "anyone"', () => {
  it('a collection entry of blank rules is an error, not []', () => {
    const r = normalizeOpenWhen({ workflows: [{ field: '', op: 'eq', value: '' }] })
    expect(r.value).toBeNull()
    expect(r.error).toBe('open_when.workflows: a rule has no field')
    // One blank beside a real rule is refused too (no silent widening).
    expect(
      normalizeOpenWhen({
        workflows: [
          { field: '$state', op: 'neq', value: 'waiting_on_po' },
          { field: '  ', op: 'eq', value: '' }
        ]
      }).error
    ).toBe('open_when.workflows: a rule has no field')
    expect(normalizeOpenWhen([{ field: '', op: 'eq' }]).error).toBe(
      'open_when: a rule has no field'
    )
  })

  it('a stored entry of blank rules is unusable when judged (owner rule)', async () => {
    expect(
      openWhenRulesFor('{"workflows":[{"field":"","op":"eq","value":""}]}', 'workflows')
    ).toBeNull()
    expect(await judge({ workflows: [{ field: '', op: 'eq', value: '' }] }, {})).toBe(false)
    // An honest empty list still means anyone, always.
    expect(await judge({ workflows: [] }, {})).toBe(true)
  })
})

describe('D — a collection named twice (case only) is unusable', () => {
  it('refused on save, owner rule when judged', async () => {
    expect(normalizeOpenWhen({ workflows: [], Workflows: [] }).error).toBe(
      'open_when names the collection "Workflows" twice'
    )
    const twice = { workflows: [], Workflows: [{ field: '$state', op: 'eq', value: 'draft' }] }
    expect(openWhenRulesFor(JSON.stringify(twice), 'workflows')).toBeNull()
    expect(await judge(twice, { $state: 'draft' })).toBe(false)
  })
})

describe("E — the single gate drops a step that is not the instance template's", () => {
  it('a $state the template does not list is unknown, never "not at X"', async () => {
    const neq = [{ field: '$state', op: 'neq', value: 'waiting_on_po' }]
    expect(await judge(neq, { $state: 'manager_approval' })).toBe(true)
    expect(await judge(neq, { $state: 'step_of_another_template' })).toBe(false)
    expect(await judge(neq, { $state: null })).toBe(false)
  })
})

describe('F — an addendum whose step is missing counts as in progress', () => {
  it('pure: a missing step is in progress; terminal is not; no instance is not', () => {
    expect(addendumStepsInProgress([{ is_terminal: null, missing_step: true }])).toBe(true)
    expect(addendumStepsInProgress([{ is_terminal: 1, missing_step: false }])).toBe(false)
    expect(addendumStepsInProgress([])).toBe(false)
  })

  function fake(rows: Array<Record<string, unknown>>) {
    const calls: string[] = []
    const chain: Record<string, unknown> = {}
    for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereRaw']) {
      chain[m] = vi.fn((...a: unknown[]) => {
        calls.push(`${m}:${String(a[0])}`)
        return chain
      })
    }
    chain.select = vi.fn(() => chain)
    // biome-ignore lint/suspicious/noThenProperty: knex-shaped thenable fake
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(rows).then(ok)
    const db = Object.assign(
      vi.fn(() => chain),
      { raw: vi.fn((s: string) => s) }
    )
    return { db, calls }
  }

  it('reads the step with a LEFT join so a gone step is seen (single and page)', async () => {
    const one = fake([{ state_id: null, is_terminal: null }])
    expect(await addendumInProgress('workflows', '7', one.db as never)).toBe(true)
    expect(one.calls).toContain('leftJoin:nivaro_workflow_states as s')
    const page = fake([
      { parent_id: '7', state_id: null, is_terminal: null },
      { parent_id: '8', state_id: 'S-DONE', is_terminal: 1 }
    ])
    expect([
      ...(await addendumsInProgressFor('workflows', ['7', '8', '9'], page.db as never))
    ]).toEqual(['7'])
  })
})
