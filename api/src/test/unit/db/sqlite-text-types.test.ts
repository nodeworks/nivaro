import Database from 'better-sqlite3'
import knex from 'knex'
import { describe, expect, it } from 'vitest'
import { sqliteAfterCreate, sqliteCompat, withNocase } from '../../../db/sqlite.js'
import { createTableColumns, sqliteTextNocase } from '../../../db/sqlite-collation.js'
import {
  fitSqliteWriteValue,
  parseSqlServerDateTime,
  SqliteValueRefusal,
  sqliteColumnShape
} from '../../../db/sqlite-values.js'
import { describeValueRefusal } from '../../../lib/db-refusal.js'

sqliteCompat()

const memory = () =>
  knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })

const raw = () => {
  const db = new Database(':memory:')
  sqliteAfterCreate(db as never, () => {})
  return db
}

describe('sqlite: declared types as SQL Server names them', () => {
  it('maps every type knex declares', () => {
    expect(sqliteColumnShape('integer')).toEqual({ type: 'int' })
    expect(sqliteColumnShape('integer', true)).toEqual({ type: 'bigint' })
    expect(sqliteColumnShape('bigint')).toEqual({ type: 'bigint' })
    expect(sqliteColumnShape('boolean')).toEqual({ type: 'bit' })
    expect(sqliteColumnShape('char(36)')).toEqual({ type: 'uniqueidentifier' })
    expect(sqliteColumnShape('varchar(255)')).toEqual({ type: 'nvarchar', length: 255 })
    expect(sqliteColumnShape('text')).toEqual({ type: 'nvarchar', length: -1 })
    expect(sqliteColumnShape('decimal(10, 2)')).toEqual({
      type: 'decimal',
      precision: 10,
      scale: 2
    })
    expect(sqliteColumnShape('float')).toEqual({ type: 'float' })
    expect(sqliteColumnShape('date')).toEqual({ type: 'date' })
    expect(sqliteColumnShape('datetime')).toEqual({ type: 'datetime2' })
    expect(sqliteColumnShape(null)).toEqual({ type: '' })
  })
})

describe('sqlite: write values converted or refused as SQL Server does', () => {
  const conv = (v: unknown, declared: string) =>
    fitSqliteWriteValue('f', v, sqliteColumnShape(declared))
  const refused = (v: unknown, declared: string) => {
    try {
      conv(v, declared)
      return null
    } catch (err) {
      return (err as SqliteValueRefusal).kind
    }
  }
  it('integers', () => {
    expect(conv(' 12 ', 'integer')).toBe(12)
    expect(conv('+5', 'integer')).toBe(5)
    expect(conv(12.7, 'integer')).toBe(12)
    expect(conv(-12.7, 'integer')).toBe(-12)
    expect(conv(true, 'integer')).toBe(1)
    expect(conv('', 'integer')).toBe(0)
    expect(conv('9007199254740993', 'bigint')).toBe('9007199254740993')
    for (const bad of ['12.7', '1e3', '.5', '1,000', 'abc'])
      expect(refused(bad, 'integer')).toBe('mismatch')
  })
  it('decimals round half away from zero; floats', () => {
    expect(conv('12.345', 'decimal(10, 2)')).toBe(12.35)
    expect(conv(-12.345, 'decimal(10, 2)')).toBe(-12.35)
    expect(conv('12.', 'decimal(10, 2)')).toBe(12)
    expect(conv('9.995', 'decimal(10, 2)')).toBe(10)
    expect(refused('', 'decimal(10, 2)')).toBe('mismatch')
    expect(refused('1e3', 'decimal(10, 2)')).toBe('mismatch')
    expect(refused(99999999.995, 'decimal(10, 2)')).toBe('range')
    expect(conv('', 'float')).toBe(0)
    expect(conv('1e3', 'float')).toBe(1000)
  })
  it('bits, uuids, nulls and raw expressions', () => {
    expect(conv('TRUE', 'boolean')).toBe(true)
    expect(conv(' 1 ', 'boolean')).toBe(true)
    expect(conv('2', 'boolean')).toBe(true)
    expect(conv('', 'boolean')).toBe(false)
    expect(conv(0.5, 'boolean')).toBe(true)
    expect(refused('yes', 'boolean')).toBe('mismatch')
    expect(conv('{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}', 'char(36)')).toBe(
      'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'
    )
    expect(refused('', 'char(36)')).toBe('mismatch')
    expect(refused('aaaaaaaabbbb4ccc8dddeeeeeeeeeeee', 'char(36)')).toBe('mismatch')
    expect(conv(null, 'integer')).toBe(null)
    const r = { toSQL: () => ({}) }
    expect(conv(r, 'datetime')).toBe(r)
    expect(conv('any text', 'varchar(10)')).toBe('any text')
  })
  it('dates and datetimes: the wall clock as written', () => {
    expect(conv('2026-11-20T10:00:00Z', 'date')).toBe('2026-11-20')
    expect(conv('11/20/2026', 'date')).toBe('2026-11-20')
    expect(conv('Nov 20 2026', 'date')).toBe('2026-11-20')
    expect(conv('20261120', 'date')).toBe('2026-11-20')
    expect(conv('', 'date')).toBe('1900-01-01')
    expect(conv('2026-11-20T10:00:00+02:00', 'datetime')).toBe('2026-11-20T10:00:00.000Z')
    expect(conv('11/20/2026 2:30 PM', 'datetime')).toBe('2026-11-20T14:30:00.000Z')
    expect(conv('2026-11-20T10:00:00.1234567Z', 'datetime')).toBe('2026-11-20T10:00:00.123Z')
    expect(conv('2026-11-20', 'datetime')).toBe('2026-11-20T00:00:00.000Z')
    for (const bad of ['garbage', '2026-02-30', '2026-13-01', '2026-11-20T25:00']) {
      expect(refused(bad, 'date')).toBe('mismatch')
      expect(parseSqlServerDateTime(bad)).toBeNull()
    }
    expect(refused(5, 'date')).toBe('mismatch')
  })
  it('answers 400 VALUE_TYPE_MISMATCH / VALUE_OUT_OF_RANGE', () => {
    expect(describeValueRefusal(new SqliteValueRefusal('mismatch', 'qty'))?.code).toBe(
      'VALUE_TYPE_MISMATCH'
    )
    expect(describeValueRefusal(new SqliteValueRefusal('range', 'qty'))?.code).toBe(
      'VALUE_OUT_OF_RANGE'
    )
  })
})

describe('sqlite: text compares case-insensitively', () => {
  it('new text columns are declared COLLATE NOCASE; decimals keep precision', async () => {
    expect(withNocase('varchar(10)')).toBe('varchar(10) collate nocase')
    expect(withNocase('integer')).toBe('integer')
    expect(withNocase('text collate binary')).toBe('text collate binary')
    const k = memory()
    try {
      await k.schema.createTable('t', (t) => {
        t.increments('id')
        t.string('name', 10).unique()
        t.uuid('u')
        t.decimal('p', 10, 2)
      })
      const sql = String((await k.raw("SELECT sql FROM sqlite_master WHERE name = 't'"))[0].sql)
      expect(sql).toMatch(/`name` varchar\(10\) collate nocase/)
      expect(sql).toMatch(/`u` char\(36\) collate nocase/)
      expect(sql).toMatch(/`p` decimal\(10, 2\)/)
      await k('t').insert([{ name: 'b' }, { name: 'A' }, { name: 'c' }])
      expect(await k('t').orderBy('name').pluck('name')).toEqual(['A', 'b', 'c'])
      expect(await k('t').where('name', 'a').pluck('name')).toEqual(['A'])
      expect(await k('t').whereIn('name', ['B', 'C']).orderBy('name').pluck('name')).toEqual([
        'b',
        'c'
      ])
      await expect(k('t').insert({ name: 'B' })).rejects.toThrow(/UNIQUE/)
      // An altered column keeps it.
      await k.schema.alterTable('t', (t) => {
        t.integer('name2')
      })
      await k.schema.alterTable('t', (t) => {
        t.string('name2', 20).alter()
      })
      await k('t').where('name', 'A').update({ name2: 'Zed' })
      expect(await k('t').where('name2', 'zED').pluck('name')).toEqual(['A'])
    } finally {
      await k.destroy()
    }
  })

  it('reads a bigint past 2^53 as its exact digits', async () => {
    const k = memory()
    try {
      await k.schema.createTable('b', (t) => {
        t.increments('id')
        t.bigInteger('big')
        t.integer('n')
      })
      await k('b').insert([
        { big: '9007199254740993', n: 1 },
        { big: 5, n: 2 }
      ])
      const rows = await k('b').orderBy('id').select('big', 'n')
      expect(rows).toEqual([
        { big: '9007199254740993', n: 1 },
        { big: 5, n: 2 }
      ])
    } finally {
      await k.destroy()
    }
  })

  it('finds the column definitions of a CREATE TABLE text', () => {
    const cols = createTableColumns(
      "CREATE TABLE `t` (`id` integer not null primary key, `a` varchar(5) default 'x,y' check (a in ('p', 'q')), \"b c\" text COLLATE BINARY, [d] char(36), e text, primary key (id), unique (a, e))"
    )
    expect(cols.map((c) => [c.name, c.collated])).toEqual([
      ['id', false],
      ['a', false],
      ['b c', true],
      ['d', false],
      ['e', false],
      [null, false],
      [null, false]
    ])
  })

  it('brings an older database in line, keeping data, indexes and foreign keys', () => {
    const db = raw()
    db.exec(`
      CREATE TABLE parent (id char(36) PRIMARY KEY, code varchar(10) NOT NULL DEFAULT 'a,b', note text);
      CREATE TABLE child (id integer PRIMARY KEY AUTOINCREMENT, parent_id char(36) REFERENCES parent(id), label varchar(20), kind text CHECK (kind IN ('x', 'y')));
      CREATE UNIQUE INDEX ux_parent_code ON parent(code);
      CREATE INDEX ix_child_label ON child(label) WHERE label IS NOT NULL;
      CREATE TABLE dupes (id integer PRIMARY KEY, k varchar(10), other text);
      CREATE UNIQUE INDEX ux_dupes_k ON dupes(k);
      INSERT INTO parent VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1', 'Beta', 'n'), ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2', 'alpha', NULL);
      INSERT INTO child (parent_id, label, kind) VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1', 'Red', 'x'), ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2', 'red', 'y'), (NULL, 'blue', NULL);
      INSERT INTO dupes (k, other) VALUES ('ABC', 'Q'), ('abc', 'q');
    `)
    expect(db.prepare("SELECT count(*) n FROM child WHERE label = 'RED'").get()).toEqual({ n: 0 })
    const r = sqliteTextNocase(db as never)
    expect(r.skipped).toEqual([])
    expect(r.keptExact).toEqual(['dupes.k'])
    expect(r.converted.sort()).toEqual(
      [
        'child.kind',
        'child.label',
        'child.parent_id',
        'dupes.other',
        'parent.code',
        'parent.id',
        'parent.note'
      ].sort()
    )
    expect(db.prepare("SELECT count(*) n FROM child WHERE label = 'RED'").get()).toEqual({ n: 2 })
    expect(db.prepare("SELECT count(*) n FROM dupes WHERE other = 'q'").get()).toEqual({ n: 2 })
    expect(db.prepare("SELECT count(*) n FROM dupes WHERE k = 'abc'").get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT code FROM parent ORDER BY code').pluck().all()).toEqual([
      'alpha',
      'Beta'
    ])
    expect(() =>
      db
        .prepare("INSERT INTO parent VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3', 'BETA', NULL)")
        .run()
    ).toThrow(/UNIQUE/)
    expect(() => db.prepare("INSERT INTO child (parent_id) VALUES ('nope')").run()).toThrow(
      /FOREIGN KEY/
    )
    expect(() => db.prepare("INSERT INTO child (kind) VALUES ('z')").run()).toThrow(/CHECK/)
    // The FK lookup and the partial index still work; the file is sound.
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM child WHERE parent_id = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEE1'"
        )
        .get()
    ).toEqual({ n: 1 })
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(
      String(
        (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'parent'").get() as { sql: string })
          .sql
      )
    ).toBe(
      "CREATE TABLE parent (id char(36) PRIMARY KEY COLLATE NOCASE, code varchar(10) NOT NULL DEFAULT 'a,b' COLLATE NOCASE, note text COLLATE NOCASE)"
    )
    // Once in line, nothing to do; the case duplicates converted once cleaned.
    expect(sqliteTextNocase(db as never)).toEqual({
      converted: [],
      keptExact: ['dupes.k'],
      skipped: []
    })
    db.prepare("DELETE FROM dupes WHERE k = 'abc'").run()
    expect(sqliteTextNocase(db as never).converted).toEqual(['dupes.k'])
    db.close()
  })
})
