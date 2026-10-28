import { describe, expect, it } from 'vitest'
import { rankColumns, searchRankOrder } from './list-search-rank.js'

describe('search_rank ordering', () => {
  it('orders exact → prefix (primary first) → word starts → other', () => {
    const o = searchRankOrder('1002', ['cifa_number', 'description'])
    expect(o?.sql).toBe(
      'CASE WHEN ?? LIKE ? THEN 0 WHEN ?? LIKE ? THEN 1 WHEN ?? LIKE ? THEN 2 ' +
        'WHEN ?? LIKE ? THEN 3 WHEN (?? LIKE ? OR ?? LIKE ? OR ?? LIKE ? OR ?? LIKE ?) THEN 4 ELSE 5 END'
    )
    expect(o?.bindings).toEqual([
      'cifa_number',
      '1002',
      'description',
      '1002',
      'cifa_number',
      '1002%',
      'description',
      '1002%',
      'cifa_number',
      '1002%',
      'cifa_number',
      '%[^A-Za-z0-9]1002%',
      'description',
      '1002%',
      'description',
      '%[^A-Za-z0-9]1002%'
    ])
  })

  it('every word must start a word of some column; qualifies by table', () => {
    const o = searchRankOrder('  fiber   jumper ', ['description'], { table: 'cifa_items' })
    expect(o?.sql).toBe(
      'CASE WHEN ??.?? LIKE ? THEN 0 WHEN ??.?? LIKE ? THEN 2 ' +
        'WHEN (??.?? LIKE ? OR ??.?? LIKE ?) AND (??.?? LIKE ? OR ??.?? LIKE ?) THEN 4 ELSE 5 END'
    )
    expect(o?.bindings.slice(0, 3)).toEqual(['cifa_items', 'description', 'fiber jumper'])
    expect(o?.bindings).toContain('%[^A-Za-z0-9]jumper%')
  })

  it('escapes LIKE wildcards, uses a space boundary off MSSQL, skips blanks', () => {
    const o = searchRankOrder('50%_x', ['a'], { mssql: false })
    expect(o?.bindings).toEqual([
      'a',
      '50[%][_]x',
      'a',
      '50[%][_]x%',
      'a',
      '50[%][_]x%',
      'a',
      '% 50[%][_]x%'
    ])
    expect(searchRankOrder('  ', ['a'])).toBeNull()
    expect(searchRankOrder('x', [])).toBeNull()
    expect(searchRankOrder('x', ['bad name;--'])).toBeNull()
  })

  it('rank columns follow the request search_fields order, capped', () => {
    expect(
      rankColumns(['description', 'cifa_number', 'mfr'], ['cifa_number', 'description'])
    ).toEqual(['cifa_number', 'description', 'mfr'])
    expect(rankColumns(['b', 'a'], null)).toEqual(['b', 'a'])
    expect(
      rankColumns(
        Array.from({ length: 12 }, (_, i) => `c${i}`),
        null
      )
    ).toHaveLength(8)
  })
})
