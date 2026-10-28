import { describe, expect, it } from 'vitest'
import {
  labelSearchFieldsOf,
  narrowSearchColumns,
  parseSearchFields,
  withLabelSearchFields
} from '../../../services/search-fields.js'

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

describe('browser_config.label_search_fields', () => {
  it('reads the list from JSON text or an object, like search_fields', () => {
    expect(labelSearchFieldsOf('{"label_search_fields":["name","project"]}')).toEqual([
      'name',
      'project'
    ])
    expect(labelSearchFieldsOf({ label_search_fields: ['name', ' name ', 'project'] })).toEqual([
      'name',
      'project'
    ])
  })
  it('is independent of search_fields', () => {
    expect(labelSearchFieldsOf({ search_fields: ['name'] })).toBeNull()
    expect(parseSearchFields({ label_search_fields: ['name'] })).toBeNull()
  })
  it('unset, empty, malformed or unsafe names mean none', () => {
    expect(labelSearchFieldsOf(null)).toBeNull()
    expect(labelSearchFieldsOf(undefined)).toBeNull()
    expect(labelSearchFieldsOf('{"label_search_fields":[]}')).toBeNull()
    expect(labelSearchFieldsOf('{oops')).toBeNull()
    expect(labelSearchFieldsOf({ label_search_fields: 'name' })).toBeNull()
    expect(labelSearchFieldsOf({ label_search_fields: ['a b', "x'--", '9lives'] })).toBeNull()
    expect(labelSearchFieldsOf({ label_search_fields: ['ok', 'x]; drop'] })).toEqual(['ok'])
  })
  it('adds only text columns of the table, after the label columns, once', () => {
    const available = new Set(['request_number', 'name', 'project', 'notes'])
    expect(
      withLabelSearchFields(['request_number'], ['name', 'password', 'project'], available)
    ).toEqual(['request_number', 'name', 'project'])
    expect(withLabelSearchFields(['name'], ['name'], ['name'])).toEqual(['name'])
    expect(withLabelSearchFields(['request_number'], null, available)).toEqual(['request_number'])
    // A template with no text field (no label columns) can still be found by the extras.
    expect(withLabelSearchFields([], ['project'], available)).toEqual(['project'])
  })
})
