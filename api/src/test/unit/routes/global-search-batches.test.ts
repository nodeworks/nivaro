import { describe, expect, it } from 'vitest'
import { balanceByRows, searchColumns } from '../../../routes/global-search.js'

describe('global search — row-balanced batches', () => {
  it('spreads the big tables across batches, largest first', () => {
    const plan = [
      { c: 'a', rows: 400 },
      { c: 'b', rows: 350 },
      { c: 'c', rows: 300 },
      { c: 'd', rows: 200 },
      { c: 'e', rows: 10 },
      { c: 'f', rows: 5 }
    ]
    const batches = balanceByRows(plan, 4)
    expect(batches).toHaveLength(4)
    expect(batches.map((b) => b.map((p) => p.c))).toEqual([['a'], ['b'], ['c'], ['d', 'e', 'f']])
    expect(batches.flat()).toHaveLength(plan.length)
  })
  it('never makes empty batches', () => {
    expect(balanceByRows([{ rows: 1 }], 4)).toHaveLength(1)
    expect(balanceByRows([], 4)).toEqual([])
  })
})

describe('global search — searchColumns', () => {
  const p = {
    collection: 'workflows',
    display_name: 'Workflows',
    columns: ['name', 'secret_code', 'workflow_id'],
    labelColumns: ['workflow_id'],
    template: '{{workflow_id}}',
    rows: 10
  }
  it('matches every search column, or only the label ones', () => {
    expect(searchColumns(p, false)).toEqual(['name', 'secret_code', 'workflow_id'])
    expect(searchColumns(p, true)).toEqual(['workflow_id'])
  })
  it('never matches a column the caller may not read', () => {
    expect(searchColumns(p, false, ['id', 'name', 'workflow_id'])).toEqual(['name', 'workflow_id'])
    expect(searchColumns(p, true, ['id', 'name'])).toEqual([])
    expect(searchColumns(p, false, null)).toEqual(p.columns)
    expect(searchColumns(p, false, ['*'])).toEqual(p.columns)
  })
})
