import { describe, expect, it } from 'vitest'
import { narrowSearchColumns, parseSearchFields } from '../../../services/search-fields.js'

describe('browser_config.search_fields', () => {
  it('reads the list from JSON text or an object', () => {
    expect(parseSearchFields('{"search_fields":["workflow_id","name"]}')).toEqual([
      'workflow_id',
      'name'
    ])
    expect(parseSearchFields({ search_fields: ['name', 'name', ' title '] })).toEqual([
      'name',
      'title'
    ])
  })
  it('unset, empty, malformed or unsafe names mean every column', () => {
    expect(parseSearchFields(null)).toBeNull()
    expect(parseSearchFields('{"search_fields":[]}')).toBeNull()
    expect(parseSearchFields('not json')).toBeNull()
    expect(parseSearchFields({ search_fields: 'name' })).toBeNull()
    expect(parseSearchFields({ search_fields: ['x; DROP TABLE y', '1abc'] })).toBeNull()
  })
  it('only ever narrows the searchable columns', () => {
    const all = ['workflow_id', 'name', 'description']
    expect(narrowSearchColumns(all, ['name', 'password'])).toEqual(['name'])
    expect(narrowSearchColumns(all, null)).toEqual(all)
    // Nothing configured is searchable → fall back rather than search nothing.
    expect(narrowSearchColumns(all, ['password'])).toEqual(all)
  })
})
