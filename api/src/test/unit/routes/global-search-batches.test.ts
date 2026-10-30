import { describe, expect, it } from 'vitest'
import { searchColumns } from '../../../routes/global-search.js'

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
