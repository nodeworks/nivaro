import { describe, expect, it } from 'vitest'
import { substituteParams } from '../../../services/custom-query-substitute.js'

// M23 (security audit 2026-10-27): `:param` substitution is literal-aware —
// a value can never leave the literal it lands in.

describe('substituteParams', () => {
  it('keeps the existing whole-token literals', () => {
    const d = new Date('2026-01-02T03:04:05.678Z')
    expect(
      substituteParams('SELECT * FROM t WHERE a = :a AND b = :b AND c = :c AND d = :d AND e = :e', {
        a: "O'Brien",
        b: 5,
        c: true,
        d,
        e: null
      })
    ).toBe(
      "SELECT * FROM t WHERE a = 'O''Brien' AND b = 5 AND c = 1 AND d = '2026-01-02 03:04:05.678' AND e = NULL"
    )
  })

  it('an undeclared :name outside quotes is NULL, as before', () => {
    expect(substituteParams('SELECT :missing', {})).toBe('SELECT NULL')
  })

  it("binds a :param inside a string literal as escaped text — '%:term%' works", () => {
    expect(substituteParams("SELECT * FROM t WHERE name LIKE '%:term%'", { term: 'ab' })).toBe(
      "SELECT * FROM t WHERE name LIKE '%ab%'"
    )
    expect(substituteParams("WHERE x LIKE N':term%'", { term: 'z' })).toBe("WHERE x LIKE N'z%'")
  })

  it('cannot break out of a string literal', () => {
    const evil = "x'; DROP TABLE users; --"
    const out = substituteParams("SELECT * FROM t WHERE name LIKE '%:term%'", { term: evil })
    expect(out).toBe("SELECT * FROM t WHERE name LIKE '%x''; DROP TABLE users; --%'")
    // whole-token form too
    expect(substituteParams('WHERE name = :term', { term: evil })).toBe(
      "WHERE name = 'x''; DROP TABLE users; --'"
    )
  })

  it('leaves undeclared :names inside strings alone (times, URLs)', () => {
    expect(substituteParams("SELECT '12:30', 'http://x:8080/a'", { a: 1 })).toBe(
      "SELECT '12:30', 'http://x:8080/a'"
    )
  })

  it('never substitutes inside comments or quoted identifiers', () => {
    const sql = [
      '-- filter by :term',
      '/* outer /* :term */ still comment :term */',
      'SELECT [col:term], "id:term" FROM t WHERE a = :term'
    ].join('\n')
    const out = substituteParams(sql, { term: 'a\n*/ DROP TABLE t; --' })
    expect(out.split('\n')[0]).toBe('-- filter by :term')
    expect(out).toContain('/* outer /* :term */ still comment :term */')
    expect(out).toContain('SELECT [col:term], "id:term" FROM t WHERE a = ')
    expect(out.endsWith("'a\n*/ DROP TABLE t; --'")).toBe(true)
  })

  it('does not treat type::Method as a parameter', () => {
    expect(substituteParams('SELECT geography::Point(:lat, 0, 4326)', { lat: 1.5, Point: 9 })).toBe(
      'SELECT geography::Point(1.5, 0, 4326)'
    )
  })

  it('handles doubled quotes inside a literal', () => {
    expect(substituteParams("SELECT 'it''s :v'", { v: "o'k" })).toBe("SELECT 'it''s o''k'")
  })
})
