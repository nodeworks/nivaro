import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { utcNow } from '../../../db/dialect.js'
import {
  dialectOf,
  dropIndexesOn,
  ensureIndex,
  indexExists,
  listIndexes,
  longTextType,
  qid
} from '../../../db/portable-ddl.js'
import * as h from '../../../db/sql-dialect.js'
import {
  convertRows,
  fromSqliteTime,
  isSqliteClient,
  rewriteInformationSchema,
  SqliteWriteLock,
  sqliteAfterCreate,
  sqliteCompat,
  sqliteDeploymentProblem,
  sqlitePoolMax,
  sqliteRegexp,
  toSqliteTime
} from '../../../db/sqlite.js'

sqliteCompat()

// Compile-only: nothing connects.
const lite = knex({ client: 'better-sqlite3', useNullAsDefault: true })

const memory = () =>
  knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })

describe('sqlite: deployment', () => {
  it('names the SQLite knex clients', () => {
    expect(isSqliteClient('better-sqlite3')).toBe(true)
    expect(isSqliteClient('sqlite3')).toBe(true)
    expect(isSqliteClient('mysql2')).toBe(false)
  })

  it('refuses cloud mode, a process role and a read replica', () => {
    expect(sqliteDeploymentProblem({ DB_CLIENT: 'mssql', NIVARO_ROLE: 'web' })).toBeNull()
    expect(sqliteDeploymentProblem({ DB_CLIENT: 'sqlite' })).toBeNull()
    expect(sqliteDeploymentProblem({ DB_CLIENT: 'sqlite', CLOUD_META_DB_URL: 'x' })).toMatch(
      /cloud mode/
    )
    expect(sqliteDeploymentProblem({ DB_CLIENT: 'sqlite', NIVARO_ROLE: 'worker' })).toMatch(
      /NIVARO_ROLE=worker/
    )
    expect(sqliteDeploymentProblem({ DB_CLIENT: 'sqlite', DB_READ_HOST: 'r' })).toMatch(/replica/)
  })

  it('keeps a few connections', () => {
    expect(sqlitePoolMax(60)).toBe(8)
    expect(sqlitePoolMax(2)).toBe(2)
  })
})

describe('sqlite: time values', () => {
  it('writes a Date as UTC ISO text, a UTC midnight as a date', () => {
    expect(toSqliteTime(new Date('2026-11-20T10:20:30.456Z'))).toBe('2026-11-20T10:20:30.456Z')
    expect(toSqliteTime(new Date('2026-11-20T00:00:00.000Z'))).toBe('2026-11-20')
    expect(toSqliteTime(new Date('nope'))).toBeNull()
  })

  it('reads stored text (and legacy epoch ms) back as the same instant', () => {
    const t = '2026-11-20T10:20:30.456Z'
    expect((fromSqliteTime(t) as Date).toISOString()).toBe(t)
    expect((fromSqliteTime('2026-11-20 10:20:30') as Date).toISOString()).toBe(
      '2026-11-20T10:20:30.000Z'
    )
    expect((fromSqliteTime('2026-11-20') as Date).toISOString()).toBe('2026-11-20T00:00:00.000Z')
    expect((fromSqliteTime(Date.parse(t)) as Date).toISOString()).toBe(t)
    expect(fromSqliteTime('not a date')).toBe('not a date')
  })

  it('converts declared date columns, and stored-shape expressions only', () => {
    const rows = [
      { a: '2026-11-20T10:00:00.000Z', b: '2026-11-20', c: '2026-11-20T10:00:00.000Z', d: 'x' }
    ]
    convertRows(
      [
        { name: 'a', type: 'datetime' },
        { name: 'b', type: 'date' },
        { name: 'c', type: null },
        { name: 'd', type: 'varchar(255)' }
      ],
      rows
    )
    expect(rows[0].a).toBeInstanceOf(Date)
    expect(rows[0].b).toBeInstanceOf(Date)
    expect(rows[0].c).toBeInstanceOf(Date)
    expect(rows[0].d).toBe('x')
    const text = [{ e: '2026-11-20' }]
    convertRows([{ name: 'e', type: null }], text)
    expect(text[0].e).toBe('2026-11-20')
  })

  it('REGEXP function', () => {
    expect(sqliteRegexp('^a.c$', 'abc')).toBe(1)
    expect(sqliteRegexp('^a.c$', 'abd')).toBe(0)
    expect(sqliteRegexp('x', null)).toBeNull()
  })
})

describe('sqlite: write lock', () => {
  it('hands the lock on in order and times a stuck waiter out', async () => {
    const lock = new SqliteWriteLock()
    const a = {}
    const b = {}
    const c = {}
    await lock.acquire(a)
    await lock.acquire(a) // re-entrant for its holder
    const order: string[] = []
    const pb = lock.acquire(b).then(() => order.push('b'))
    const pc = lock.acquire(c, 20).catch((e) => order.push(e.code))
    await pc
    expect(order).toEqual(['SQLITE_WRITE_LOCK_TIMEOUT'])
    lock.release(c) // not the holder: nothing happens
    expect(lock.holder).toBe(a)
    lock.release(a)
    await pb
    expect(lock.holder).toBe(b)
    lock.release(b)
    expect(lock.holder).toBeNull()
  })
})

describe('sqlite: sql-dialect helpers (compile)', () => {
  it('is its own dialect', () => {
    expect(h.sqlDialect(lite)).toBe('sqlite')
    expect(dialectOf(lite)).toBe('sqlite')
  })

  it('speaks SQLite', () => {
    expect(h.qi(lite, 'a"b')).toBe('"a""b"')
    expect(h.nowUtc(lite)).toBe("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
    expect(h.dateAdd(lite, 'day', -7, 'x')).toBe(
      "strftime('%Y-%m-%dT%H:%M:%fZ', x, (-7) || ' days')"
    )
    expect(h.dateAdd(lite, 'week', 2, 'x')).toBe(
      "strftime('%Y-%m-%dT%H:%M:%fZ', x, ((2) * 7) || ' days')"
    )
    expect(h.datePart(lite, 'weekday', 'x')).toBe("(CAST(strftime('%w', x) AS INTEGER) + 1)")
    expect(h.dateOnly(lite, 'x')).toBe('date(x)')
    expect(h.castText(lite, 'v')).toBe('CAST(v AS TEXT)')
    expect(h.castText(lite, 'v', 10)).toBe('substr(CAST(v AS TEXT), 1, 10)')
    expect(h.textLength(lite, 'v')).toBe('LENGTH(v)')
    expect(h.textPosition(lite, 'n', 'h')).toBe('(SELECT INSTR(h, n) FROM (SELECT n AS n, h AS h))')
    expect(h.concat(lite, "'a'", 'b')).toBe("('a' || b)")
    expect(h.stringAgg(lite, 'x', ',', 'x')).toBe("STRING_AGG(CAST(x AS TEXT), ',' ORDER BY x)")
    expect(h.isJson(lite, 'c')).toBe('json_valid(c)')
    expect(h.likeEscape(lite)).toBe("ESCAPE '\\'")
    expect(h.likeCi(lite)).toBe('LIKE')
    expect(h.notLikeCi(lite)).toBe('NOT LIKE')
    expect(h.equalsCi(lite, 'a', '?')).toBe('LOWER(a) = LOWER(?)')
    expect(h.noLock(lite)).toBe('')
    expect(h.tableHint(lite, 'READPAST')).toBe('')
    expect(h.lockForUpdate(lite, { skipLocked: true })).toBe('')
    expect(h.topN(lite, 5)).toBe('')
    expect(h.limitN(lite, 5)).toBe(' LIMIT 5')
    expect(h.offsetFetch(lite, 10, 5)).toBe(' LIMIT 5 OFFSET 10')
    expect(h.boolLit(lite, true)).toBe('1')
    expect(h.ifNull(lite, 'a', 'b')).toBe('COALESCE(a, b)')
  })

  it('never returns a literal ?', () => {
    for (const sql of [
      h.tryCastInt(lite, 'v'),
      h.tryCastNumber(lite, 'v'),
      h.tryCastDate(lite, 'v'),
      h.dateDiff(lite, 'month', 'a', 'b'),
      h.jsonValue(lite, 'c', '$.a')
    ])
      expect(sql).not.toContain('?')
  })

  it('portable-ddl names', () => {
    expect(longTextType(lite)).toBe('text')
    expect(qid(lite, 'x')).toBe('"x"')
  })
})

// Real engine: every helper run on SQLite, compared with what SQL Server returns for the same
// input (SQL Server's answers written out by hand; where they differ by design it is said).
describe('sqlite: helpers on a real database', () => {
  let k: Knex
  // Inputs are bound once as columns x, y (helpers may name an expression twice).
  const one = async (sql: string, b: any[] = []) => {
    const rows = (await k.raw(`SELECT ${sql} AS v FROM (SELECT ? AS x, ? AS y)`, [
      b[0] ?? null,
      b[1] ?? null
    ])) as Array<{ v: unknown }>
    return rows[0]?.v
  }
  const T = '2026-11-20T10:00:00.000Z'
  beforeAll(() => {
    k = memory()
  })
  afterAll(() => k.destroy())

  it('time', async () => {
    const now = (await one(h.nowUtc(k))) as Date
    expect(now).toBeInstanceOf(Date)
    expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(5000)
    expect(await one(h.dateAdd(k, 'day', -7, 'x'), [T])).toEqual(new Date('2026-11-13T10:00:00Z'))
    expect(await one(h.dateAdd(k, 'week', 1, 'x'), [T])).toEqual(new Date('2026-11-27T10:00:00Z'))
    expect(await one(h.dateAdd(k, 'month', 2, 'x'), [new Date(T)])).toEqual(
      new Date('2027-01-20T10:00:00Z')
    )
    expect(await one(h.dateAdd(k, 'minute', 'y', 'x'), [T, 30])).toEqual(
      new Date('2026-11-20T10:30:00Z')
    )
    expect(await one(h.dateDiff(k, 'minute', 'x', 'y'), [T, '2026-11-20T10:59:59.999Z'])).toBe(59)
    expect(await one(h.dateDiff(k, 'second', 'x', 'y'), [T, '2026-11-20T10:01:00.000Z'])).toBe(60)
    expect(await one(h.dateDiff(k, 'day', 'x', 'y'), [T, '2026-11-23T09:00:00.000Z'])).toBe(2)
    expect(await one(h.dateDiff(k, 'week', 'x', 'y'), ['2026-11-01', '2026-11-20'])).toBe(2)
    expect(await one(h.dateDiff(k, 'month', 'x', 'y'), ['2026-01-31', '2026-03-01'])).toBe(1)
    expect(await one(h.dateDiff(k, 'year', 'x', 'y'), ['2020-06-01', '2026-05-31'])).toBe(5)
    expect(await one(h.datePart(k, 'weekday', 'x'), [T])).toBe(6) // a Friday
    expect(await one(h.datePart(k, 'quarter', 'x'), [T])).toBe(4)
    expect(await one(h.datePart(k, 'year', 'x'), [T])).toBe(2026)
    expect(await one(h.datePart(k, 'minute', 'x'), ['2026-11-20T10:07:00.000Z'])).toBe(7)
    // SQL Server returns a DATE; SQLite has none, so the day as text.
    expect(await one(h.dateOnly(k, 'x'), [T])).toBe('2026-11-20')
    expect((await one(utcNow(k).toQuery())) as Date).toBeInstanceOf(Date)
  })

  it('casts', async () => {
    expect(await one(h.castText(k, 'x', 3), ['abcdef'])).toBe('abc')
    expect(await one(h.castText(k, 'x'), [12])).toBe('12')
    expect(await one(h.tryCastInt(k, 'x'), [' 42 '])).toBe(42)
    expect(await one(h.tryCastInt(k, 'x'), ['-7'])).toBe(-7)
    expect(await one(h.tryCastInt(k, 'x'), ['4.2'])).toBeNull()
    expect(await one(h.tryCastInt(k, 'x'), ['x'])).toBeNull()
    expect(await one(h.tryCastNumber(k, 'x'), ['4.5e1'])).toBe(45)
    expect(await one(h.tryCastNumber(k, 'x'), ['.5'])).toBe(0.5)
    expect(await one(h.tryCastNumber(k, 'x'), ['abc'])).toBeNull()
    expect(await one(h.tryCastDate(k, 'x'), ['2026-11-20'])).toEqual(new Date('2026-11-20'))
    expect(await one(h.tryCastDate(k, 'x'), ['2026-11-20 10:00:00'])).toEqual(new Date(T))
    expect(await one(h.tryCastDate(k, 'x'), ['nope'])).toBeNull()
  })

  it('text and JSON', async () => {
    // SQL Server's LEN drops trailing spaces (3); SQLite, Postgres and MySQL count them.
    expect(await one(h.textLength(k, 'x'), ['abc '])).toBe(4)
    expect(await one(h.textPosition(k, 'x', 'y'), ['b', 'abc'])).toBe(2)
    expect(await one(h.textPosition(k, 'x', 'y'), ['z', 'abc'])).toBe(0)
    expect(await one(h.concat(k, 'x', 'y'), ['a', 'b'])).toBe('ab')
    expect(await one(h.ifNull(k, 'NULL', 'x'), ['d'])).toBe('d')
    const j = '{"a":{"b":5},"t":true,"o":{},"s":"x"}'
    expect(await one(h.jsonValue(k, 'x', '$.a.b'), [j])).toBe('5')
    expect(await one(h.jsonValue(k, 'x', '$.t'), [j])).toBe('true')
    expect(await one(h.jsonValue(k, 'x', '$.s'), [j])).toBe('x')
    expect(await one(h.jsonValue(k, 'x', '$.o'), [j])).toBeNull()
    expect(await one(h.jsonValue(k, 'x', '$.a'), ['not json'])).toBeNull()
    expect(await one(h.isJson(k, 'x'), [j])).toBe(1)
    expect(await one(h.isJson(k, 'x'), ['{'])).toBe(0)
    expect(await one(`(x ${h.likeCi(k)} y ${h.likeEscape(k)})`, ['A_C', 'a\\_c'])).toBe(1)
    expect(await one(`(x ${h.likeCi(k)} y ${h.likeEscape(k)})`, ['abc', 'a\\_c'])).toBe(0)
    expect(await one(`(x ${h.notLikeCi(k)} y)`, ['ABC', 'ab%'])).toBe(0)
    expect(await one(h.equalsCi(k, 'x', 'y'), ['Abc', 'aBC'])).toBe(1)
    expect(await one(h.boolLit(k, true))).toBe(1)
    const agg = (await k.raw(
      `SELECT ${h.stringAgg(k, 'x', ', ', 'x DESC')} AS v FROM (SELECT 1 AS x UNION SELECT 2 UNION SELECT 3)`
    )) as Array<{ v: string }>
    expect(agg[0].v).toBe('3, 2, 1')
    const page = (await k.raw(
      `SELECT ${h.topN(k, 2)}x FROM (SELECT 1 AS x UNION SELECT 2 UNION SELECT 3) ORDER BY x${h.offsetFetch(k, 1, 2)}`
    )) as Array<{ x: number }>
    expect(page.map((r) => r.x)).toEqual([2, 3])
  })
})

describe('sqlite: knex on a real database', () => {
  let k: Knex
  beforeAll(() => {
    k = memory()
  })
  afterAll(() => k.destroy())

  it('stores and reads timestamps as UTC, defaults in the same shape', async () => {
    await k.schema.createTable('t', (t) => {
      t.increments('id')
      t.timestamp('at')
      t.date('day')
      t.boolean('flag')
      t.timestamp('created_at').defaultTo(k.fn.now())
      t.timestamp('updated_at').defaultTo(utcNow(k))
    })
    const at = new Date('2026-11-20T10:20:30.456Z')
    await k('t').insert({ at, day: new Date('2026-11-20T00:00:00Z'), flag: true })
    const [row] = await k('t').select('*')
    expect(row.at).toEqual(at)
    expect(row.day).toEqual(new Date('2026-11-20T00:00:00Z'))
    expect(row.flag).toBe(true)
    expect(row.created_at).toBeInstanceOf(Date)
    expect(Math.abs(row.created_at.getTime() - Date.now())).toBeLessThan(5000)
    const raw = (await k.raw(
      "SELECT '=' || at AS a, '=' || day AS d, '=' || created_at AS c, '=' || updated_at AS u FROM t"
    )) as Array<Record<string, string>>
    expect(raw[0].a).toBe('=2026-11-20T10:20:30.456Z')
    expect(raw[0].d).toBe('=2026-11-20')
    expect(raw[0].c).toMatch(/^=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(raw[0].u).toMatch(/^=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    // A Date filter compares as the same instant.
    expect(await k('t').where('at', '>', new Date('2026-11-20T10:20:30.455Z'))).toHaveLength(1)
    expect(await k('t').where('at', '>', new Date('2026-11-20T10:20:30.456Z'))).toHaveLength(0)
    expect(await k('t').where('at', '>=', new Date('2026-11-20T00:00:00Z'))).toHaveLength(1)
    // MAX() of a timestamp column is a Date, like the other databases.
    const [m] = (await k('t').max({ m: 'at' })) as Array<{ m: Date }>
    expect(m.m).toEqual(at)
  })

  it('adds a column with a non-constant default by rebuilding the table, keeping keys', async () => {
    await k.schema.createTable('p', (t) => {
      t.increments('id')
    })
    await k.schema.createTable('c', (t) => {
      t.increments('id')
      t.integer('p_id').references('id').inTable('p')
      t.string('name').index('ix_c_name')
    })
    await k('p').insert({ id: 1 })
    await k('c').insert({ p_id: 1, name: 'a' })
    await k.schema.alterTable('c', (t) => {
      t.timestamp('seen_at').notNullable().defaultTo(k.fn.now())
      t.string('note')
    })
    const [row] = await k('c').select('*')
    expect(row.name).toBe('a')
    expect(row.seen_at).toBeInstanceOf(Date)
    expect(await indexExists(k, 'c', 'ix_c_name')).toBe(true)
    await expect(k('c').insert({ p_id: 99, name: 'b' })).rejects.toThrow(/FOREIGN KEY/)
  })

  it('portable-ddl index helpers', async () => {
    await k.schema.createTable('ix', (t) => {
      t.increments('id')
      t.string('a')
      t.string('b')
    })
    await ensureIndex(k, {
      name: 'ux_ix_a',
      table: 'ix',
      columns: ['a', 'b DESC'],
      unique: true,
      include: ['b'],
      where: "a IS NOT NULL AND b <> N'x'"
    })
    await ensureIndex(k, { name: 'ux_ix_a', table: 'ix', columns: ['a'] }) // exists: no-op
    const ix = (await listIndexes(k, 'ix')).find((i) => i.name === 'ux_ix_a')
    expect(ix).toMatchObject({ unique: true, primary: false, columns: ['a', 'b'] })
    // partial: a duplicate outside the filter is allowed
    await k('ix').insert([
      { a: null, b: 'q' },
      { a: null, b: 'q' }
    ])
    await k('ix').insert({ a: 'z', b: 'q' })
    await expect(k('ix').insert({ a: 'z', b: 'q' })).rejects.toThrow(/UNIQUE/)
    expect(await dropIndexesOn(k, 'ix', ['b', 'a'], { unique: true })).toEqual(['ux_ix_a'])
    expect(await indexExists(k, 'ix', 'ux_ix_a')).toBe(false)
  })
})

describe('sqlite: one writer, several readers', () => {
  let dir: string
  let k: Knex
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nvr-sqlite-'))
    k = knex({
      client: 'better-sqlite3',
      connection: { filename: join(dir, 'w.db') },
      useNullAsDefault: true,
      pool: { min: 1, max: 3, afterCreate: sqliteAfterCreate }
    })
  })
  afterAll(async () => {
    await k.destroy()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads during an open transaction; a second writer waits for COMMIT without blocking', async () => {
    await k.schema.createTable('w', (t) => {
      t.increments('id')
      t.string('v')
    })
    const steps: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const trx = k.transaction(async (tx) => {
      await tx('w').insert({ v: 'in-trx' })
      steps.push('trx wrote')
      await gate
      steps.push('trx commits')
    })
    await new Promise((r) => setTimeout(r, 20))
    // A reader on another connection sees the committed state at once (WAL).
    expect(await k('w').count({ n: '*' })).toEqual([{ n: 0 }])
    steps.push('read')
    // A writer outside waits (asynchronously: this timer still fires) until the commit.
    const outside = k('w')
      .insert({ v: 'outside' })
      .then(() => steps.push('outside wrote'))
    await new Promise((r) => setTimeout(r, 30))
    steps.push('timer')
    release()
    await trx
    await outside
    expect(steps).toEqual(['trx wrote', 'read', 'timer', 'trx commits', 'outside wrote'])
    expect((await k('w').count({ n: '*' }))[0]).toEqual({ n: 2 })
  })
})

describe('sqlite: INFORMATION_SCHEMA', () => {
  let k: Knex
  beforeAll(async () => {
    k = memory()
    await k.schema.createTable('parent', (t) => {
      t.increments('id')
      t.string('code', 40).notNullable().unique()
    })
    await k.schema.createTable('child', (t) => {
      t.increments('id')
      t.integer('parent_id').references('id').inTable('parent')
      t.decimal('amount', 12, 2)
    })
  })
  afterAll(() => k.destroy())

  it('leaves other SQL alone', () => {
    expect(rewriteInformationSchema('SELECT 1')).toBe('SELECT 1')
  })

  it('answers TABLES, COLUMNS and the key views like the other databases', async () => {
    const t = (await k.raw(
      "SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN ('pg_catalog', 'information_schema')",
      ['child']
    )) as Array<{ cnt: number }>
    expect(t[0].cnt).toBe(1)
    const cols = (await k.raw(
      'SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE FROM information_schema.columns c WHERE c.table_name = ? AND TABLE_SCHEMA = DATABASE() ORDER BY ORDINAL_POSITION',
      ['parent']
    )) as Array<Record<string, unknown>>
    expect(cols).toEqual([
      {
        COLUMN_NAME: 'id',
        DATA_TYPE: 'integer',
        CHARACTER_MAXIMUM_LENGTH: null,
        NUMERIC_PRECISION: null,
        NUMERIC_SCALE: null,
        IS_NULLABLE: 'NO'
      },
      {
        COLUMN_NAME: 'code',
        DATA_TYPE: 'varchar',
        CHARACTER_MAXIMUM_LENGTH: 40,
        NUMERIC_PRECISION: null,
        NUMERIC_SCALE: null,
        IS_NULLABLE: 'NO'
      }
    ])
    const pk = (await k.raw(
      `SELECT kcu.COLUMN_NAME AS c FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_NAME = kcu.TABLE_NAME
        WHERE tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`,
      ['child']
    )) as Array<{ c: string }>
    expect(pk).toEqual([{ c: 'id' }])
    const fk = (await k.raw(
      `SELECT kcu.COLUMN_NAME AS c, kcu.REFERENCED_TABLE_NAME AS r FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_NAME = kcu.TABLE_NAME
        WHERE tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'`,
      ['child']
    )) as Array<{ c: string; r: string }>
    expect(fk).toEqual([{ c: 'parent_id', r: 'parent' }])
    const uq = (await k.raw(
      "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_NAME = 'parent' AND CONSTRAINT_TYPE = 'UNIQUE'"
    )) as Array<{ n: number }>
    expect(uq[0].n).toBe(1)
  })
})
