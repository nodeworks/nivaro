import knex from 'knex'
import { describe, expect, it } from 'vitest'
import {
  isMariaDb,
  knexClientFor,
  MYSQL_FLAVOR_KEY,
  mariaDbBinding,
  mariaDbBindingCompat,
  mariaDbColumnDefault,
  mysqlFlavor,
  mysqlFlavorConfig,
  serverFlavorProblem,
  versionIsMariaDb
} from '../../../db/mysql-flavor.js'
import * as h from '../../../db/sql-dialect.js'

// Compile-only knex instances: nothing connects. The real-engine check (every sql-dialect helper
// returns the same value on MySQL 8.4, MariaDB 11.4 and MariaDB 10.11) was run separately.
const ms = knex({ client: 'mssql' })
const pg = knex({ client: 'pg' })
const my = knex({ client: 'mysql2' })
const maria = knex({ client: 'mysql2', ...mysqlFlavorConfig(true) })

mariaDbBindingCompat()

describe('mysql-flavor', () => {
  it('marks a MariaDB pool on the knex config and nothing else', () => {
    expect(mysqlFlavorConfig(true)).toEqual({ [MYSQL_FLAVOR_KEY]: 'mariadb' })
    expect(mysqlFlavorConfig(false)).toEqual({})
    expect(isMariaDb(maria)).toBe(true)
    for (const k of [ms, pg, my, null, undefined]) expect(isMariaDb(k)).toBe(false)
    expect(mysqlFlavor(maria)).toBe('mariadb')
    expect(mysqlFlavor(my)).toBe('mysql')
    expect(mysqlFlavor(ms)).toBeNull()
    expect(mysqlFlavor(pg)).toBeNull()
  })

  it('MariaDB speaks the MySQL dialect: every helper returns what it returns for MySQL', () => {
    expect(h.sqlDialect(maria)).toBe('mysql')
    const each = (k: typeof my) => [
      h.qi(k, 'a`b'),
      h.nowUtc(k),
      h.nowLocal(k),
      h.dateAdd(k, 'day', -7, 'x'),
      h.dateAdd(k, 'month', '?', 'x'),
      ...(['second', 'minute', 'hour', 'day', 'week', 'month', 'year'] as const).map((u) =>
        h.dateDiff(k, u, 'a', 'b')
      ),
      ...(['year', 'month', 'day', 'hour', 'minute', 'second', 'weekday', 'quarter'] as const).map(
        (p) => h.datePart(k, p, 'x')
      ),
      h.dateOnly(k, 'x'),
      h.castText(k, 'x'),
      h.castText(k, 'x', 40),
      h.tryCastInt(k, 'x'),
      h.tryCastInt(k, 'x', true),
      h.tryCastNumber(k, 'x'),
      h.tryCastDate(k, 'x'),
      h.ifNull(k, 'a', 'b'),
      h.textLength(k, 'x'),
      h.textPosition(k, 'a', 'b'),
      h.concat(k, 'a', 'b'),
      h.stringAgg(k, 'x', ', ', 'x'),
      h.jsonValue(k, 'c', '$.a[0]'),
      h.isJson(k, 'x'),
      h.likeEscape(k),
      h.likeCi(k),
      h.notLikeCi(k),
      h.equalsCi(k, 'a', 'b'),
      h.noLock(k),
      h.tableHint(k, 'READPAST'),
      h.lockForUpdate(k),
      h.lockForUpdate(k, { skipLocked: true }),
      h.topN(k, 3),
      h.limitN(k, 3),
      h.offsetFetch(k, 2, 3),
      h.boolLit(k, true)
    ]
    expect(each(maria)).toEqual(each(my))
  })

  it('names the setting to change when DB_CLIENT and the server disagree', () => {
    expect(versionIsMariaDb('11.4.13-MariaDB-ubu2404')).toBe(true)
    expect(versionIsMariaDb('8.4.3')).toBe(false)
    expect(serverFlavorProblem(false, '11.4.13-MariaDB-ubu2404')).toMatch(/Set DB_CLIENT=mariadb/)
    expect(serverFlavorProblem(true, '8.4.3')).toMatch(/Set DB_CLIENT=mysql2/)
    expect(serverFlavorProblem(false, '8.4.3')).toBeNull()
    expect(serverFlavorProblem(false, '8.4.3', 'latin1')).toBeNull() // MySQL left as it was
    expect(serverFlavorProblem(true, '11.4.13-MariaDB', 'utf8mb4')).toBeNull()
    expect(serverFlavorProblem(true, '10.11.19-MariaDB-ubu2204')).toBeNull()
    expect(serverFlavorProblem(true, '10.6.20-MariaDB')).toMatch(/older than 10\.11/)
    expect(serverFlavorProblem(true, '5.5.5-10.4.1-MariaDB')).toMatch(/older than 10\.11/)
    expect(serverFlavorProblem(true, '11.4.13-MariaDB', 'latin1')).toMatch(/utf8mb4/)
  })

  it('maps the control plane client name onto knex', () => {
    expect(knexClientFor('mariadb')).toEqual({ client: 'mysql2', [MYSQL_FLAVOR_KEY]: 'mariadb' })
    expect(knexClientFor('mysql2')).toEqual({ client: 'mysql2' })
    expect(knexClientFor('pg')).toEqual({ client: 'pg' })
    expect(isMariaDb(knex({ ...knexClientFor('mariadb') }))).toBe(true)
  })
})

describe('MariaDB timestamp bindings', () => {
  it('sends a zoned ISO timestamp as its UTC wall time', () => {
    expect(mariaDbBinding('2026-12-01T10:00:00.000Z')).toBe('2026-12-01 10:00:00.000')
    expect(mariaDbBinding('2026-12-01T10:00:00Z')).toBe('2026-12-01 10:00:00')
    expect(mariaDbBinding('2026-12-01T10:00Z')).toBe('2026-12-01 10:00:00')
    expect(mariaDbBinding('2026-12-01 10:00:00.5Z')).toBe('2026-12-01 10:00:00.5')
    expect(mariaDbBinding('2026-12-01T10:00:00.123456789Z')).toBe('2026-12-01 10:00:00.123456')
    expect(mariaDbBinding('2026-12-01T01:30:00+02:00')).toBe('2026-11-30 23:30:00')
    expect(mariaDbBinding('2026-12-31T22:00:00.250-05:00')).toBe('2027-01-01 03:00:00.250')
  })

  it('leaves everything else alone', () => {
    for (const v of [
      '2026-12-01',
      '2026-12-01T10:00:00',
      '2026-12-01 10:00:00.000',
      'due 2026-12-01T10:00:00Z',
      '2026-12-01T10:00:00Z ',
      '2026-02-30T10:00:00Z',
      '2026-12-01T10:00:00+0200',
      'abc',
      '',
      42,
      null,
      undefined,
      true
    ])
      expect(mariaDbBinding(v)).toBe(v)
    const d = new Date('2026-12-01T10:00:00Z')
    expect(mariaDbBinding(d)).toBe(d)
  })

  it('applies to MariaDB pools only — builder and raw — and never to MySQL', () => {
    const iso = '2026-12-01T10:00:00.000Z'
    expect(maria('t').insert({ d: iso, s: 'x' }).toSQL().toNative().bindings).toEqual([
      '2026-12-01 10:00:00.000',
      'x'
    ])
    expect(maria.raw('select ? as v, ? as w', [iso, 5]).toSQL().toNative().bindings).toEqual([
      '2026-12-01 10:00:00.000',
      5
    ])
    expect(maria('t').where('d', '>', iso).toSQL().toNative().bindings).toEqual([
      '2026-12-01 10:00:00.000'
    ])
    expect(my('t').insert({ d: iso }).toSQL().toNative().bindings).toEqual([iso])
    expect(pg('t').insert({ d: iso }).toSQL().toNative().bindings).toEqual([iso])
    expect(ms('t').insert({ d: iso }).toSQL().toNative().bindings).toEqual([iso])
  })
})

describe('sql-dialect helpers that differ on MariaDB', () => {
  it('collateCiAs: MySQL 0900, MariaDB uca1400, unchanged elsewhere', () => {
    expect(h.collateCiAs(my, 'x')).toBe('(x COLLATE utf8mb4_0900_as_ci)')
    expect(h.collateCiAs(maria, 'x')).toBe('(x COLLATE utf8mb4_uca1400_as_ci)')
    expect(h.collateCiAs(pg, 'x')).toBe('x')
    expect(h.collateCiAs(ms, 'x')).toBe('x')
  })

  it('statementTimeoutSql: max_execution_time (ms) on MySQL, max_statement_time (s) on MariaDB', () => {
    expect(h.statementTimeoutSql(my, 1500)).toBe('SET SESSION max_execution_time = 1500')
    expect(h.statementTimeoutSql(maria, 1500)).toBe('SET SESSION max_statement_time = 1.5')
    expect(h.statementTimeoutSql(maria, 0)).toBe('SET SESSION max_statement_time = 0')
    expect(h.statementTimeoutSql(pg, 1500)).toBe('SET statement_timeout = 1500')
    expect(h.statementTimeoutSql(ms, 1500)).toBe('')
    expect(h.statementTimeoutSql(my, -5)).toBe('SET SESSION max_execution_time = 0')
    expect(() => h.statementTimeoutSql(my, Number.NaN)).toThrow()
    expect(h.statementTimeoutResetSql(my)).toBe('SET SESSION max_execution_time = DEFAULT')
    expect(h.statementTimeoutResetSql(maria)).toBe('SET SESSION max_statement_time = DEFAULT')
    expect(h.statementTimeoutResetSql(pg)).toBe('RESET statement_timeout')
    expect(h.statementTimeoutResetSql(ms)).toBe('')
  })
})

describe('mariaDbColumnDefault', () => {
  it('words MariaDB catalog defaults the way MySQL does', () => {
    expect(mariaDbColumnDefault("'abc'")).toBe('abc')
    expect(mariaDbColumnDefault("'it''s'")).toBe("it's")
    expect(mariaDbColumnDefault("'NULL'")).toBe('NULL')
    expect(mariaDbColumnDefault('NULL')).toBeNull()
    expect(mariaDbColumnDefault(null)).toBeNull()
    expect(mariaDbColumnDefault('current_timestamp()')).toBe('CURRENT_TIMESTAMP')
    expect(mariaDbColumnDefault('current_timestamp(3)')).toBe('CURRENT_TIMESTAMP(3)')
    expect(mariaDbColumnDefault('0')).toBe('0')
    expect(mariaDbColumnDefault("''")).toBe('')
  })
})
