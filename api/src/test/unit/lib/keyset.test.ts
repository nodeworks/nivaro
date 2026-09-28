import { describe, expect, it } from 'vitest'
import {
  CURSOR_START,
  decodeCursor,
  encodeCursor,
  keysetBranches,
  keysetSorts
} from '../../../lib/keyset.js'

const SECRET = 'a-secret-long-enough-for-the-test-suite'

describe('keysetSorts', () => {
  it('adds id so no two rows tie', () => {
    expect(keysetSorts(['-changed'])).toEqual([
      { column: 'changed', desc: true },
      { column: 'id', desc: false }
    ])
  })
  it('keeps the direction the caller gave id', () => {
    expect(keysetSorts(['-id'])).toEqual([{ column: 'id', desc: true }])
  })
  it('sorts by id alone when nothing is named', () => {
    expect(keysetSorts(undefined)).toEqual([{ column: 'id', desc: false }])
  })
  it('refuses a sort through a linked record', () => {
    expect(() => keysetSorts(['vendor.name'])).toThrowError(/linked record/)
  })
  it('refuses a name that is not an identifier', () => {
    expect(() => keysetSorts(['name; drop table x'])).toThrowError()
  })
})

describe('cursor', () => {
  const sorts = keysetSorts(['-changed'])
  it('round-trips values, dates and nulls', () => {
    const when = new Date('2026-09-27T12:00:00.003Z')
    const c = encodeCursor('workflows', sorts, [when, 42], SECRET)
    expect(decodeCursor(c, 'workflows', sorts, SECRET)).toEqual([when, 42])
    const n = encodeCursor('workflows', sorts, [null, 'abc'], SECRET)
    expect(decodeCursor(n, 'workflows', sorts, SECRET)).toEqual([null, 'abc'])
  })
  it('reads start and empty as the beginning', () => {
    expect(decodeCursor(CURSOR_START, 'workflows', sorts, SECRET)).toBeNull()
    expect(decodeCursor('', 'workflows', sorts, SECRET)).toBeNull()
  })
  it('refuses a cursor that was edited', () => {
    const c = encodeCursor('workflows', sorts, [null, 42], SECRET)
    const body = Buffer.from(
      JSON.stringify({ c: 'workflows', s: '-changed,id', v: [null, 1] })
    ).toString('base64url')
    const forged = `${body}.${c.split('.')[1]}`
    expect(() => decodeCursor(forged, 'workflows', sorts, SECRET)).toThrowError(/not valid/)
  })
  it('refuses a cursor signed with another secret', () => {
    const c = encodeCursor('workflows', sorts, [null, 42], 'another-secret')
    expect(() => decodeCursor(c, 'workflows', sorts, SECRET)).toThrowError(/not valid/)
  })
  it('refuses another collection or another sort', () => {
    const c = encodeCursor('workflows', sorts, [null, 42], SECRET)
    expect(() => decodeCursor(c, 'vendors', sorts, SECRET)).toThrowError(/another collection/)
    expect(() => decodeCursor(c, 'workflows', keysetSorts(['name']), SECRET)).toThrowError(
      /made for sort/
    )
  })
  it('refuses text that is not a cursor', () => {
    expect(() => decodeCursor('nonsense', 'workflows', sorts, SECRET)).toThrowError(/not valid/)
  })
})

describe('keysetBranches', () => {
  it('id ascending: rows with a greater id', () => {
    expect(keysetBranches(keysetSorts([]), [10])).toEqual([[{ column: 0, test: 'gt' }]])
  })
  it('two columns: after in the first, or equal and after in the second', () => {
    expect(keysetBranches(keysetSorts(['name']), ['m', 10])).toEqual([
      [{ column: 0, test: 'gt' }],
      [
        { column: 0, test: 'eq' },
        { column: 1, test: 'gt' }
      ]
    ])
  })
  it('descending past a value also reaches the rows with no value', () => {
    expect(keysetBranches(keysetSorts(['-changed']), ['x', 10])[0]).toEqual([
      { column: 0, test: 'lt_or_null' }
    ])
  })
  it('ascending from a row with no value: every row that has one', () => {
    expect(keysetBranches(keysetSorts(['changed']), [null, 10])).toEqual([
      [{ column: 0, test: 'not_null' }],
      [
        { column: 0, test: 'null' },
        { column: 1, test: 'gt' }
      ]
    ])
  })
  it('descending from a row with no value: only the tie-break remains', () => {
    expect(keysetBranches(keysetSorts(['-changed']), [null, 10])).toEqual([
      [
        { column: 0, test: 'null' },
        { column: 1, test: 'gt' }
      ]
    ])
  })
  it('where NULL sorts last, ascending past a value reaches the empty rows', () => {
    expect(keysetBranches(keysetSorts(['changed']), ['x', 10], false)[0]).toEqual([
      { column: 0, test: 'gt_or_null' }
    ])
  })
})
