import knex from 'knex'
import { describe, expect, it } from 'vitest'
import * as h from '../../../db/sql-dialect.js'

// Compile-only knex instances: nothing connects. The real-engine check (all three databases
// return the same values) was run against SQL Server Edge, Postgres 16 and MySQL 8.4.
const ms = knex({ client: 'mssql' })
const pg = knex({ client: 'pg' })
const my = knex({ client: 'mysql2' })

describe('sql-dialect', () => {
  it('gives SQL Server exactly the T-SQL call sites used to write', () => {
    expect(h.nowUtc(ms)).toBe('GETUTCDATE()')
    expect(h.dateAdd(ms, 'day', -7, 'x')).toBe('DATEADD(day, -7, x)')
    expect(h.dateDiff(ms, 'minute', 'a', 'b')).toBe('DATEDIFF(minute, a, b)')
    expect(h.tryCastInt(ms, 'v')).toBe('TRY_CAST(v AS INT)')
    expect(h.castText(ms, 'v', 255)).toBe('CAST(v AS NVARCHAR(255))')
    expect(h.jsonValue(ms, 'c', '$.a.b')).toBe("JSON_VALUE(c, '$.a.b')")
    expect(h.noLock(ms)).toBe(' WITH (NOLOCK)')
    expect(h.topN(ms, 5)).toBe('TOP (5) ')
    expect(h.limitN(ms, 5)).toBe('')
    expect(h.likeEscape(ms)).toBe("ESCAPE '\\'")
    expect(h.likeCi(ms)).toBe('LIKE')
  })

  it('speaks Postgres', () => {
    expect(h.nowUtc(pg)).toBe("(now() at time zone 'utc')")
    expect(h.dateAdd(pg, 'day', -7, 'x')).toBe("(x + (-7) * interval '1 day')")
    expect(h.jsonValue(pg, 'c', '$.a[0]')).toBe("((c)::jsonb #>> '{a,0}')")
    expect(h.noLock(pg)).toBe('')
    expect(h.topN(pg, 5)).toBe('')
    expect(h.limitN(pg, 5)).toBe(' LIMIT 5')
    expect(h.likeCi(pg)).toBe('ILIKE')
    expect(h.equalsCi(pg, 'a', '?')).toBe('LOWER(a) = LOWER(?)')
  })

  it('speaks MySQL', () => {
    expect(h.nowUtc(my)).toBe('UTC_TIMESTAMP()')
    expect(h.dateAdd(my, 'month', 2, 'x')).toBe('DATE_ADD(x, INTERVAL (2) MONTH)')
    expect(h.dateDiff(my, 'day', 'a', 'b')).toBe('TIMESTAMPDIFF(DAY, a, b)')
    expect(h.likeEscape(my)).toBe("ESCAPE '\\\\'")
    expect(h.stringAgg(my, 'x', ',', 'x')).toBe("GROUP_CONCAT(x ORDER BY x SEPARATOR ',')")
    expect(h.concat(my, "'a'", 'b')).toBe("CONCAT('a', b)")
  })

  it('never returns a literal ? (knex.raw would read it as a binding)', () => {
    for (const k of [ms, pg, my])
      for (const sql of [h.tryCastInt(k, 'v'), h.tryCastNumber(k, 'v'), h.tryCastDate(k, 'v')])
        expect(sql).not.toContain('?')
  })

  it('refuses untrusted shapes', () => {
    expect(() => h.jsonValue(pg, 'c', "$.a'); DROP TABLE x; --")).toThrow()
    expect(() => h.topN(ms, Number.NaN)).toThrow()
  })
})
