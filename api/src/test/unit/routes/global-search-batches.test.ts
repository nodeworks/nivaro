import { describe, expect, it } from 'vitest'
import { excludedFromGlobalSearch, searchColumns } from '../../../routes/global-search.js'

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

// Army 6 D5: legacy support tickets are out of global search (records, counts, pages, exact
// ids, meaning matches, Cmd+K) — `browser_config.global_search = false` on the collection.
describe('global search — browser_config.global_search', () => {
  it('false (stored as JSON text or an object) takes a collection out', () => {
    expect(excludedFromGlobalSearch('{"global_search":false}')).toBe(true)
    expect(excludedFromGlobalSearch({ global_search: false })).toBe(true)
    expect(excludedFromGlobalSearch({ global_search: 'false' })).toBe(true)
  })
  it('anything else keeps it in', () => {
    expect(excludedFromGlobalSearch(null)).toBe(false)
    expect(excludedFromGlobalSearch('{"search_fields":["name"]}')).toBe(false)
    expect(excludedFromGlobalSearch({ global_search: true })).toBe(false)
    expect(excludedFromGlobalSearch('not json')).toBe(false)
  })
})
