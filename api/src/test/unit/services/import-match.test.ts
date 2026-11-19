import { describe, expect, it } from 'vitest'
import {
  ambiguousMatchText,
  describeMatch,
  matchCellKey,
  matchKeyOf,
  matchKindOf,
  matchSetupProblem,
  matchUsable,
  parseMatchFields,
  storeMatchFields
} from '../../../services/import-match.js'

// Collection imports match on one or more fields, stored in nivaro_import_jobs.id_field without a
// migration: a plain name, a comma list, or (read only) a JSON array. One comparison rule serves
// the run, the preview and row repair, written to agree with SQL Server `=` under the default
// case-insensitive collation.

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

describe('matchSetupProblem — refused before a job is stored', () => {
  const map = { Warehouse: 'warehouse', CIFA: 'cifa', Qty: 'on_hand' }

  it('a match field no column of the file is mapped to is refused (review #1)', () => {
    expect(
      matchSetupProblem({ matchFields: ['warehouse', 'id'], columnMap: map, strategy: 'overwrite' })
    ).toMatchObject({
      code: 'MATCH_FIELD_NOT_MAPPED',
      error: expect.stringMatching(/^id is a match field/)
    })
    expect(
      matchSetupProblem({
        matchFields: ['warehouse', 'cifa'],
        columnMap: map,
        strategy: 'overwrite'
      })
    ).toBeNull()
  })

  it('overwrite / merge with no match field needs confirm_no_match; skip never does (review #2)', () => {
    for (const strategy of ['overwrite', 'merge'])
      expect(matchSetupProblem({ matchFields: [], columnMap: map, strategy })?.code).toBe(
        'NO_MATCH_FIELDS'
      )
    expect(
      matchSetupProblem({
        matchFields: [],
        columnMap: map,
        strategy: 'overwrite',
        confirmNoMatch: true
      })
    ).toBeNull()
    expect(matchSetupProblem({ matchFields: [], columnMap: map, strategy: 'skip' })).toBeNull()
    expect(matchSetupProblem({ matchFields: [], columnMap: map, strategy: undefined })).toBeNull()
  })
})

describe('comparison keys (review #3, #12)', () => {
  it('kinds: links and the id compare as ids, number fields as numbers, the rest as text', () => {
    expect(matchKindOf('warehouse', 'integer', true)).toBe('id')
    expect(matchKindOf('id', 'integer', false)).toBe('id')
    expect(matchKindOf('qty', 'integer', false)).toBe('number')
    expect(matchKindOf('code', 'string', false)).toBe('text')
    expect(matchKindOf('active', 'boolean', false)).toBe('bool')
  })

  it('text: a blank cell is the same as an empty string and NULL (the importer writes "")', () => {
    expect(matchCellKey('', 'text')).toBeNull()
    expect(matchCellKey('   ', 'text')).toBeNull()
    expect(matchCellKey(null, 'text')).toBeNull()
  })

  it('text compares like the database collation: case and trailing spaces ignored, not numbers', () => {
    expect(matchCellKey('Main', 'text')).toBe(matchCellKey('MAIN  ', 'text'))
    expect(matchCellKey('012', 'text')).not.toBe(matchCellKey('12', 'text'))
    expect(matchCellKey(' a', 'text')).not.toBe(matchCellKey('a', 'text'))
  })

  it('numbers compare as numbers only in number fields', () => {
    expect(matchCellKey('012', 'number')).toBe(matchCellKey(12, 'number'))
    expect(matchCellKey('12.0', 'number')).toBe(matchCellKey('12', 'number'))
    expect(matchCellKey(7, 'id')).toBe(matchCellKey('7', 'id'))
    expect(matchCellKey('ABC-1', 'id')).toBe(matchCellKey('abc-1', 'id'))
  })

  it('a row matches only when some match value is not blank; order matters', () => {
    const kinds = ['id', 'text'] as const
    expect(matchUsable([null, ''], [...kinds])).toBe(false)
    expect(matchUsable([1, ''], [...kinds])).toBe(true)
    expect(matchKeyOf([1, 'x'], [...kinds])).toBe(matchKeyOf(['1', 'X'], [...kinds]))
    expect(matchKeyOf([1, null], [...kinds])).toBe(matchKeyOf([1, ''], [...kinds]))
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
