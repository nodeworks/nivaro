import type { Knex } from 'knex'
import { describe, expect, it } from 'vitest'
import { tsql } from './tsql-translate.js'

const k = (client: string) => ({ client: { config: { client } } }) as unknown as Knex

describe('tsql()', () => {
  it('leaves SQL Server text untouched', () => {
    const sql = "SELECT TOP 5 [user], ISNULL(a, 1) FROM t WHERE x LIKE 'a[_]%'"
    expect(tsql(k('mssql'), sql)).toBe(sql)
  })

  it('quotes brackets, hoists TOP and uses ILIKE on Postgres', () => {
    const out = tsql(
      k('pg'),
      "SELECT TOP 5 t.[user], u.[key] FROM t WHERE t.path LIKE 'nivaro[_]%' ORDER BY t.id"
    )
    expect(out).toBe(
      `SELECT t."user", u."key" FROM t WHERE t.path ILIKE 'nivaro\\_%' ORDER BY t.id LIMIT 5`
    )
  })

  it('quotes with backticks and keeps LIKE on MySQL', () => {
    const out = tsql(k('mysql'), 'SELECT TOP (3) [to] FROM m WHERE s LIKE ? ORDER BY id')
    expect(out).toBe('SELECT `to` FROM m WHERE s LIKE ? ORDER BY id LIMIT 3')
  })

  it('puts a subquery LIMIT before its closing paren', () => {
    const out = tsql(
      k('pg'),
      '(SELECT TOP 1 p.v FROM p WHERE p.c = r.c ORDER BY p.f DESC) AS prev FROM r'
    )
    expect(out).toBe('(SELECT p.v FROM p WHERE p.c = r.c ORDER BY p.f DESC LIMIT 1) AS prev FROM r')
  })

  it('rewrites date and string functions', () => {
    const pg = tsql(
      k('pg'),
      'SELECT DATEPART(hour, l.at), DATEDIFF(minute, a, GETUTCDATE()), ISNULL(x, 0), LEN(y) FROM t'
    )
    expect(pg).toContain('EXTRACT(HOUR FROM l.at)::int')
    expect(pg).toContain("(now() at time zone 'utc')")
    expect(pg).toContain('COALESCE(x, 0)')
    expect(pg).toContain('CHAR_LENGTH(y)')
    const my = tsql(k('mysql'), 'SELECT DATEPART(dayofyear, l.at), DATEADD(day, -7, GETUTCDATE())')
    expect(my).toContain('DAYOFYEAR(l.at)')
    expect(my).toContain('DATE_ADD(UTC_TIMESTAMP(), INTERVAL (-7) DAY)')
  })

  it('casts to text and leaves string literals alone', () => {
    expect(tsql(k('pg'), "SELECT CAST(a AS NVARCHAR(36)) FROM t WHERE n = '[x] LIKE'")).toBe(
      `SELECT CAST(a AS text) FROM t WHERE n = '[x] LIKE'`
    )
    expect(tsql(k('mysql'), 'SELECT CAST(a AS varchar(20))')).toBe('SELECT CAST(a AS CHAR)')
  })

  it('reads the request log user as a uuid on Postgres only', () => {
    expect(tsql(k('pg'), 'JOIN u ON u.id = l.[user]')).toContain('CAST(l."user" AS uuid)')
    expect(tsql(k('mysql'), 'JOIN u ON u.id = l.[user]')).toBe('JOIN u ON u.id = l.`user`')
  })
})
