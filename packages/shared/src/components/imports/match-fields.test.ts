import { describe, expect, it } from 'vitest'
import {
  canStartImport,
  matchFieldOptions,
  NO_MATCH_WARNING,
  noMatchWarning,
  parseMatchFields
} from './match-fields'

// EFP prod 2026-11-19: a re-run with "Overwrite" and no match field created every row again.

describe('collection-import match fields', () => {
  it('reads one name, a comma list or a JSON array', () => {
    expect(parseMatchFields('code')).toEqual(['code'])
    expect(parseMatchFields('warehouse,cifa')).toEqual(['warehouse', 'cifa'])
    expect(parseMatchFields('["warehouse","cifa"]')).toEqual(['warehouse', 'cifa'])
    expect(parseMatchFields(null)).toEqual([])
    expect(parseMatchFields(' ')).toEqual([])
  })

  it('warns when no match field is chosen, whatever the strategy', () => {
    expect(noMatchWarning([])).toBe(NO_MATCH_WARNING)
    expect(NO_MATCH_WARNING).toBe('No match fields: every row will be created as a new record')
    expect(noMatchWarning(['warehouse'])).toBeNull()
  })

  it('without a match field the import starts only after an explicit confirm', () => {
    expect(canStartImport([], false)).toBe(false)
    expect(canStartImport([], true)).toBe(true)
    expect(canStartImport(['warehouse', 'cifa'], false)).toBe(true)
  })
})

describe('match field options (review: an unmapped match field read blank on every row)', () => {
  const fields = [
    { value: 'id', label: 'ID', hint: 'id' },
    { value: 'warehouse', label: 'Warehouse', hint: 'warehouse' },
    { value: 'cifa', label: 'CIFA', hint: 'cifa' },
    { value: 'tags', label: 'Tags', hint: 'tags · links several' }
  ]

  it('offers only fields a column of the file is mapped to, never a link to several', () => {
    const opts = matchFieldOptions(fields, new Set(['warehouse', 'tags']))
    expect(opts.map((o) => o.value)).toEqual(['warehouse'])
  })

  it('offers ID only when a column is mapped to it', () => {
    expect(matchFieldOptions(fields, new Set(['cifa'])).map((o) => o.value)).toEqual(['cifa'])
    expect(matchFieldOptions(fields, new Set(['id', 'cifa'])).map((o) => o.value)).toEqual([
      'id',
      'cifa'
    ])
  })
})
