import { describe, expect, it } from 'vitest'
import type { RowRulePlan } from './row-rules-apply.js'
import { mergeForcedIntoPlan, overlayForced, sanitizeForcedPatches } from './row-rules-forced.js'

describe('row-rules forced patches', () => {
  it('keeps only rows in the run, plain field names and scalar values', () => {
    const out = sanitizeForcedPatches(
      {
        '1': { category: 3, 'bad-name': 1, id: 9, obj: { x: 1 } },
        '2': { category: 4 },
        'pending:0': { category: null }
      },
      new Set(['1', 'pending:0'])
    )
    expect(out).toEqual({ '1': { category: 3 }, 'pending:0': { category: null } })
    expect(sanitizeForcedPatches([1, 2], new Set(['1']))).toEqual({})
  })

  it('overlays forced values on the rows the planner judges', () => {
    const rows = overlayForced(
      [
        { id: 1, category: 7 },
        { id: 2, category: 8 }
      ],
      {
        '1': { category: 3 }
      }
    )
    expect(rows).toEqual([
      { id: 1, category: 3 },
      { id: 2, category: 8 }
    ])
  })

  it('merges into an existing change; the rules win on the same field', () => {
    const plan: RowRulePlan = {
      rows: 2,
      fields: { task: 1 },
      changes: [{ id: '1', patch: { task: 5 }, before: { task: 1 }, locked: [] }]
    }
    const original = new Map<string, Record<string, unknown>>([
      ['1', { id: 1, category: 7, task: 1 }],
      ['2', { id: 2, category: 8 }]
    ])
    mergeForcedIntoPlan(plan, { '1': { category: 3, task: 9 }, '2': { category: 4 } }, original)
    expect(plan.changes[0]).toEqual({
      id: '1',
      patch: { task: 5, category: 3 },
      before: { task: 1, category: 7 },
      locked: []
    })
    // A row the rules left alone still gets a change for the forced value.
    expect(plan.changes[1]).toEqual({
      id: '2',
      patch: { category: 4 },
      before: { category: 8 },
      locked: []
    })
    expect(plan.fields).toEqual({ task: 1, category: 2 })
  })

  it('skips a forced value equal to what the row already holds', () => {
    const plan: RowRulePlan = { rows: 1, fields: {}, changes: [] }
    mergeForcedIntoPlan(plan, { '1': { category: 3 } }, new Map([['1', { id: 1, category: '3' }]]))
    expect(plan.changes).toEqual([])
  })
})
