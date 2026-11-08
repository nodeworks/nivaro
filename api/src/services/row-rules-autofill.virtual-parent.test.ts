import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 11 f4 M3: a rehearsed create checked nested child rows WITHOUT their
// parent, so the 'lock' row rule that drops a line price a role may not set
// (and the rule that derives it) never ran — the rehearsal said the copied
// $2 was kept while the real create stored $1. A virtual parent (the parent
// as it would be stored) now feeds those rules.

const state = vi.hoisted(() => ({
  dbReads: [] as string[],
  contexts: [] as Array<Record<string, unknown>>
}))

const LAYOUT_ROW = {
  parent_collection: 'workflows',
  field: 'workflow_lines',
  overrides: JSON.stringify({
    options: {
      parent_context_fields: ['project_type'],
      row_rules: [{ target_type: 'lock', target_field: 'price' }]
    }
  })
}
const RELATION = {
  one_collection: 'workflows',
  one_field: 'workflow_lines',
  many_collection: 'workflow_line_items',
  many_field: 'workflow'
}

vi.mock('../db/index.js', () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {}
    const self = () => q
    for (const m of ['join', 'where', 'whereRaw', 'whereIn', 'whereNull']) q[m] = self
    q.select = async () => {
      if (table.startsWith('nivaro_layout_field_assignments')) return [LAYOUT_ROW]
      if (table === 'nivaro_relations') return [RELATION]
      return []
    }
    q.first = async () => {
      state.dbReads.push(table)
      return { id: 9, project_type: 'stored' }
    }
    return q
  }
  return { db: (table: string) => chain(table) }
})

vi.mock('./field-rules.js', () => ({
  RowRuleLookupCache: class {
    queries = 0
  },
  evaluateRowRules: async (
    _db: unknown,
    _c: string,
    row: Record<string, unknown>,
    parent: Record<string, unknown>,
    _rules: unknown,
    _x: unknown,
    opts?: { locks?: Set<string>; locksOnly?: boolean; targetFields?: string[] }
  ) => {
    state.contexts.push(parent)
    // The rule: non-admins may not set a price; the rules derive 1.
    if (opts?.locks) opts.locks.add('price')
    else row.price = 1
  }
}))
vi.mock('./field-rules-stats.js', () => ({ recordRuleEvalSample: () => {} }))

import {
  applyRowLocksOnWrite,
  applyRowRulesOnCreate,
  clearRowRuleCache,
  virtualParentFor
} from './row-rules-autofill.js'

beforeEach(() => {
  clearRowRuleCache()
  state.dbReads = []
  state.contexts = []
})

describe('virtualParentFor', () => {
  const cfg = { parentCollection: 'workflows' }
  const vp = { collection: 'workflows', row: { project_type: 2 } }
  it('answers only for a row with no stored parent, of the same parent collection', () => {
    expect(virtualParentFor(cfg, null, vp)).toEqual({ project_type: 2 })
    expect(virtualParentFor(cfg, '', vp)).toEqual({ project_type: 2 })
    expect(virtualParentFor(cfg, 12, vp)).toBeUndefined()
    expect(virtualParentFor({ parentCollection: 'other' }, null, vp)).toBeUndefined()
    expect(virtualParentFor(cfg, null, undefined)).toBeUndefined()
  })
})

describe('row rules on a nested rehearsal', () => {
  it('without a parent the lock rule is skipped (the old rehearsal)', async () => {
    const payload: Record<string, unknown> = { quantity: 5, price: 2 }
    const callerFields = new Set(Object.keys(payload))
    const dropped = await applyRowLocksOnWrite('workflow_line_items', payload, callerFields, null)
    expect(dropped).toEqual([])
    expect(payload.price).toBe(2)
  })

  it('a virtual parent runs the lock + derive rules the real create runs: $2 → 1', async () => {
    const payload: Record<string, unknown> = { quantity: 5, price: 2 }
    const callerFields = new Set(Object.keys(payload))
    const parent = { collection: 'workflows', row: { project_type: 2 } }
    const dropped = await applyRowLocksOnWrite(
      'workflow_line_items',
      payload,
      callerFields,
      null,
      false,
      parent
    )
    expect(dropped).toEqual(['price'])
    expect(callerFields.has('price')).toBe(false)
    await applyRowRulesOnCreate('workflow_line_items', payload, callerFields, parent)
    expect(payload.price).toBe(1)
    // The parent context came from the virtual row, not a database read.
    expect(state.contexts.every((c) => c.project_type === 2)).toBe(true)
    expect(state.dbReads).toEqual([])
  })

  it('a row that names its stored parent still reads the stored row', async () => {
    const payload: Record<string, unknown> = { workflow: 9, quantity: 5, price: 2 }
    const callerFields = new Set(Object.keys(payload))
    await applyRowLocksOnWrite('workflow_line_items', payload, callerFields, null, false, {
      collection: 'workflows',
      row: { project_type: 2 }
    })
    expect(state.dbReads).toContain('workflows')
    expect(state.contexts[0]?.project_type).toBe('stored')
  })
})
