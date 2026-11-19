import { describe, expect, it } from 'vitest'
import {
  ambiguousMatchText,
  describeMatch,
  matchKey,
  parseMatchFields,
  rowMatchValues,
  storeMatchFields
} from '../../../services/import-match.js'

// Collection imports match on one or more fields, stored in nivaro_import_jobs.id_field without a
// migration: a plain name, a comma list, or (read only) a JSON array.

describe('parseMatchFields / storeMatchFields', () => {
  it('reads a plain name, a comma list, a JSON array or an array; drops junk and repeats', () => {
    expect(parseMatchFields('code')).toEqual(['code'])
    expect(parseMatchFields('warehouse, cifa')).toEqual(['warehouse', 'cifa'])
    expect(parseMatchFields('["warehouse","cifa"]')).toEqual(['warehouse', 'cifa'])
    expect(parseMatchFields(['warehouse', 'cifa', 'cifa', '', 'bad name;'])).toEqual([
      'warehouse',
      'cifa'
    ])
    expect(parseMatchFields(null)).toEqual([])
    expect(parseMatchFields('')).toEqual([])
    expect(parseMatchFields('[broken')).toEqual([])
  })

  it('stores one field as its name, several as a comma list, none as null', () => {
    expect(storeMatchFields('code')).toBe('code')
    expect(storeMatchFields(['warehouse', 'cifa'])).toBe('warehouse,cifa')
    expect(storeMatchFields([])).toBeNull()
    expect(storeMatchFields(undefined)).toBeNull()
  })
})

describe('matching values', () => {
  it('a row with every match value empty cannot match (it is created)', () => {
    expect(rowMatchValues({ a: '', b: null }, ['a', 'b']).usable).toBe(false)
    expect(rowMatchValues({ a: 1, b: '' }, ['a', 'b'])).toEqual({ values: [1, null], usable: true })
    expect(rowMatchValues({ a: 1 }, []).usable).toBe(false)
  })

  it('keys compare like the database: numbers vs numeric text, case, blanks as null', () => {
    expect(matchKey([12, 'Main'])).toBe(matchKey(['12', ' main ']))
    expect(matchKey([null, 'x'])).toBe(matchKey(['', 'X']))
    expect(matchKey([1, null])).not.toBe(matchKey([1, 'x']))
    expect(matchKey([1, 2])).not.toBe(matchKey([2, 1]))
  })

  it('an ambiguous row is described in field labels with the file values', () => {
    const labels: Record<string, string> = { warehouse: 'Warehouse', cifa: 'CIFA' }
    const said = describeMatch(
      ['warehouse', 'cifa'],
      { warehouse: 'East', cifa: '' },
      (f) => labels[f]
    )
    expect(said).toBe("Warehouse 'East' and CIFA empty")
    expect(ambiguousMatchText(said)).toMatch(/^More than one existing record matches Warehouse/)
  })
})
