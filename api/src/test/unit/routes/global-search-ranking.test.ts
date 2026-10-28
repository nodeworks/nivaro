import { describe, expect, it } from 'vitest'
import {
  combinedFilter,
  exactStatement,
  finishHits,
  fuzzyStatement,
  mergeFound,
  parseLabelSearchFields,
  toHit
} from '../../../routes/global-search.js'

// Search program 2026-10-28 (items 1/4/5/6/23): exact-id pass, typo pass,
// ranking signals and matched-field reporting on the omnisearch route.

const P = {
  collection: 'workflows',
  display_name: 'Workflows',
  template: '{{workflow_id}} {{name}}'
}
const labelOf = (_c: string, f: string) => (f === 'workflow_id' ? 'Workflow ID' : f)

type Found = NonNullable<ReturnType<typeof toHit>>
const found = (over: Partial<Found>): Found => ({
  collection: 'workflows',
  display_name: 'Workflows',
  id: 1,
  label: 'x',
  snippet: 'x',
  tier: 'contains',
  ...over
})
const noSignals = {
  userId: 'u-1',
  learned: new Map(),
  recent: new Set<string>(),
  owned: new Set<string>()
}

describe('toHit — matched field', () => {
  it('names the best-matching readable column and its value', () => {
    const item = { id: 7, workflow_id: 'AB26-1', name: 'Canton grounding', user_created: 'u-1' }
    const hit = toHit(P, item, ['name', 'workflow_id'], ['canton'], labelOf)
    expect(hit).toMatchObject({
      label: 'AB26-1 Canton grounding',
      matched_field: 'name',
      matched_value: 'Canton grounding',
      tier: 'prefix',
      createdBy: 'u-1'
    })
  })

  it('never matches on a column absent from the row as the caller read it', () => {
    // `secret_code` holds the phrase in the table but was withheld from this reader.
    const item = { id: 7, name: 'Other' }
    expect(toHit(P, item, ['name', 'secret_code'], ['xyz'], labelOf)).toBeNull()
  })
})

describe('mergeFound / finishHits', () => {
  it('one hit per record, the best tier wins, exact ranks first', () => {
    const merged = mergeFound(
      [found({ id: 2, tier: 'exact', exact: true, label: 'AB26-2' })],
      [found({ id: 1, tier: 'prefix', label: 'Canton' }), found({ id: 2, tier: 'contains' })],
      [found({ id: 3, tier: 'fuzzy', similarity: 0.9, label: 'Cantn' })]
    )
    expect(merged).toHaveLength(3)
    const ranked = finishHits(merged, noSignals)
    expect(ranked.map((r) => r.id)).toEqual([2, 1, 3])
    expect(ranked[0].exact).toBe(true)
    expect(ranked.every((r) => !('tier' in r) && !('createdBy' in r))).toBe(true)
  })

  it('mine: created by me, owned, or opened recently — and it lifts the hit', () => {
    const hits = [
      found({ id: 1, label: 'a1' }),
      found({ id: 2, label: 'a2', createdBy: 'U-1' }),
      found({ id: 3, label: 'a3' }),
      found({ id: 4, label: 'a4' })
    ]
    const ranked = finishHits(hits, {
      ...noSignals,
      owned: new Set(['workflows:3']),
      recent: new Set(['workflows:4'])
    })
    expect(ranked.map((r) => [r.id, r.mine ?? false])).toEqual([
      [2, true],
      [3, true],
      [4, true],
      [1, false]
    ])
  })

  it('learned: records others opened for this query rank higher in their band', () => {
    const ranked = finishHits([found({ id: 1, label: 'a' }), found({ id: 2, label: 'bb' })], {
      ...noSignals,
      learned: new Map([['workflows:2', 3]])
    })
    expect(ranked[0].id).toBe(2)
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score ?? 0)
  })
})

describe('exact-id statement', () => {
  it('equality on readable id columns; numeric columns only for digits', () => {
    const batch = [{ collection: 'workflows', cols: ['workflow_id'], nums: ['po_number'] }]
    const words = exactStatement(batch, 'AB26-1')
    expect(words?.sql).toContain('WHERE [workflow_id] = ?')
    expect(words?.sql).not.toContain('po_number')
    expect(words?.bindings).toEqual(['AB26-1'])
    const digits = exactStatement(batch, '12345')
    expect(digits?.sql).toContain('[workflow_id] = ? OR [po_number] = ?')
    expect(digits?.bindings).toEqual(['12345', 12345])
    expect(exactStatement([{ collection: 'x', cols: [], nums: [] }], 'B1')).toBeNull()
  })
})

describe('typo statement', () => {
  it('binds every chunk, inlines only the integer threshold', () => {
    const s = fuzzyStatement([{ collection: 'vendors', cols: ['name'] }], 'cantn')
    expect(s?.sql).toContain('CROSS APPLY')
    expect(s?.sql).toContain('x.s0 >= 2')
    expect(s?.bindings).toEqual(['%can%', '%ant%', '%ntn%'])
    expect(s?.sql).not.toContain('can')
  })
})

describe('label search fields + filters', () => {
  it('parses browser_config.label_search_fields defensively', () => {
    expect(parseLabelSearchFields('{"label_search_fields":["project_name","x;drop"]}')).toEqual([
      'project_name'
    ])
    expect(parseLabelSearchFields(null)).toEqual([])
    expect(parseLabelSearchFields('nope')).toEqual([])
  })

  it('ANDs the text filter with field filters', () => {
    const text = { _or: [{ name: { _contains: 'a' } }] }
    expect(combinedFilter(text, [])).toBe(text)
    expect(combinedFilter(text, [{ status: { _eq: 'open' } }])).toEqual({
      _and: [text, { status: { _eq: 'open' } }]
    })
    expect(combinedFilter(null, [{ s: 1 }])).toEqual({ s: 1 })
  })
})
