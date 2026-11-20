// The db/dialect/*.ts helpers and the SQLite connection functions, run on a real SQLite
// database (better-sqlite3): each answer is the one SQL Server gives for the same data.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { affectedRows, deleteBatchSql, updateBatchSql } from '../../../db/dialect/batch-write.js'
import {
  approxRowCount as catalogRowCount,
  describeColumns,
  foreignKeysNonMssql,
  listBaseTables,
  listColumnNames,
  routineDefinition,
  tableSizesKb
} from '../../../db/dialect/catalog.js'
import {
  dateBucket,
  dateLabel,
  escapeLikeFor,
  floatType,
  hourBucket,
  insertReturningRow,
  isoDateParam,
  isoWeekLabel,
  jsonHasObject,
  jsonScalar,
  physicalColumnNames,
  stdevAgg,
  tryFloat,
  tryIsoDate,
  withinSecond
} from '../../../db/dialect/ef.js'
import {
  baseTableNames,
  castFailureCondition,
  currentDatabaseName,
  dropForeignKeysOnColumn,
  foreignKeysOnTable,
  foreignKeysTouching,
  groupIndexes,
  hasIdentityColumn,
  indexKeyColumns,
  nonMssqlStorage,
  physicalType,
  referencedTables,
  renameColumn,
  renameTable,
  tableFootprints,
  tableRowCounts
} from '../../../db/dialect/h1.js'
import {
  columnTypes,
  dayText,
  foreignKeyColumnsTo,
  approxRowCount as h2RowCount,
  leadingIndexColumns,
  portableSql,
  primaryKeyColumns,
  uuidColumnsNamed
} from '../../../db/dialect/h2.js'
import {
  allTableRowsSql,
  hiddenEmailSql,
  inboundForeignKeysSql,
  notPrefixedSql,
  numericDataTypes,
  portableColumns,
  sqlInList,
  sqlText,
  tableRowsSql,
  textDataTypes
} from '../../../db/dialect/items-query.js'
import { runSqlText } from '../../../db/dialect/sqlserver-features.js'
import { hourBucket as trafficHour } from '../../../db/dialect/traffic-d.js'
import { tsql } from '../../../db/dialect/tsql-translate.js'
import {
  approxTableCounts,
  bucketLabel,
  bucketLabelSpaced,
  byteLength,
  castBigint,
  castFloat,
  infoCols,
  infoColumns,
  listNivaroTables,
  quoteIdent
} from '../../../db/dialect/users-ai-config.js'
import { castDate, collateCiAs } from '../../../db/sql-dialect.js'
import {
  fitSqliteDateOps,
  splitSqlStatements,
  sqliteAfterCreate,
  sqliteCompat,
  sqliteDriverProblem,
  sqliteLike,
  sqliteTextFunctions
} from '../../../db/sqlite.js'

sqliteCompat()

let dir: string
let k: Knex
const one = async (sql: string, b: unknown[] = []) =>
  ((await k.raw(`SELECT ${sql} AS v`, b as never)) as Array<{ v: unknown }>)[0]?.v

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nvr-sqlite-dialect-'))
  k = knex({
    client: 'better-sqlite3',
    connection: { filename: join(dir, 'h.db') },
    useNullAsDefault: true,
    pool: { min: 1, max: 3, afterCreate: sqliteAfterCreate }
  })
  await k.schema.createTable('owners', (t) => {
    t.increments('id')
    t.string('name', 100)
  })
  await k.schema.createTable('things', (t) => {
    t.increments('id')
    t.string('label', 100)
    t.text('body')
    t.integer('n')
    t.decimal('amount', 12, 2)
    t.boolean('flag')
    t.date('day')
    t.timestamp('at')
    t.uuid('ref')
    t.json('meta')
    t.integer('owner_id').references('owners.id')
    t.index(['label'], 'ix_things_label')
  })
  await k('owners').insert([{ name: 'Acme' }, { name: 'Beta' }])
  await k('things').insert([
    {
      label: 'Alpha',
      body: '50% off_sale',
      n: 3,
      amount: 1.5,
      flag: true,
      day: '2026-11-16',
      at: new Date('2026-11-20T10:20:30.456Z'),
      ref: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      meta: '{"a":{"b":5},"t":true,"s":"x","o":{"z":1}}',
      owner_id: 1
    },
    {
      label: 'beta',
      body: 'ÉCOLE',
      n: 5,
      amount: 2.5,
      flag: false,
      day: '2026-11-22',
      at: new Date('2026-11-22T23:59:59.999Z'),
      ref: null,
      meta: 'not json',
      owner_id: 2
    },
    {
      label: 'Gamma',
      body: null,
      n: null,
      amount: null,
      flag: null,
      day: null,
      at: null,
      ref: null,
      meta: null,
      owner_id: null
    }
  ])
})
afterAll(async () => {
  await k.destroy()
  rmSync(dir, { recursive: true, force: true })
})

describe('sqlite connection functions', () => {
  it('LIKE: backslash escapes by default, ESCAPE names its own, case-insensitive for every letter', async () => {
    expect(sqliteLike('nivaro\\_%', 'nivaro_users')).toBe(1)
    expect(sqliteLike('nivaro\\_%', 'nivaroXusers')).toBe(0)
    expect(sqliteLike('%école%', 'ÉCOLE')).toBe(1)
    expect(sqliteLike('a!%', 'a%', '!')).toBe(1)
    expect(sqliteLike(null, 'x')).toBeNull()
    expect(await one(`'50% off' LIKE ?`, ['50\\%%'])).toBe(1)
    expect(await one(`'500 off' LIKE ?`, ['50\\%%'])).toBe(0)
    expect(await one(`'a_b' LIKE 'a\\_b' ESCAPE '\\'`)).toBe(1)
    expect(await one(`'ÉCOLE' NOT LIKE ?`, ['%école%'])).toBe(0)
    expect(await k('things').where('label', 'like', 'al%').pluck('label')).toEqual(['Alpha'])
  })

  it('text functions answer as SQL Server / MySQL do', async () => {
    expect(await one(`LEFT('héllo', 2)`)).toBe('hé')
    expect(await one(`RIGHT('héllo', 3)`)).toBe('llo')
    expect(await one(`CHAR_LENGTH('héllo')`)).toBe(5)
    expect(await one(`LPAD('7', 3, '0')`)).toBe('007')
    expect(await one(`LOCATE('/', '/api/x/', 2)`)).toBe(5)
    expect(await one(`MD5('a')`)).toBe('0cc175b9c0f1b6a831c399e269772661')
    expect(await one(`LEFT(NULL, 2)`)).toBeNull()
    expect(sqliteTextFunctions.right('abc', 0)).toBe('')
    expect(await one('CURRENT_SCHEMA()')).toBe('main')
  })

  it('STDDEV_SAMP aggregate (NULL below two values)', async () => {
    const v = (await one(`(SELECT ${stdevAgg(k, 'n')} FROM things)`)) as number
    expect(v).toBeCloseTo(Math.SQRT2, 10)
    expect(await one(`(SELECT ${stdevAgg(k, 'n')} FROM things WHERE id = 1)`)).toBeNull()
  })

  it('splits a script on semicolons outside quotes and comments', () => {
    expect(splitSqlStatements("select 1; select ';' -- ;\n; /* ; */ select 2;")).toEqual([
      'select 1',
      "select ';' -- ;",
      '/* ; */ select 2'
    ])
  })

  it('reads a declared boolean column as true / false', async () => {
    expect(await k('things').orderBy('id').pluck('flag')).toEqual([true, false, null])
  })
})

describe('sqlite: a write with db inside a transaction joins it', () => {
  it('does not wait for its own transaction, and rolls back with it', async () => {
    await k.schema.createTable('tx_t', (t) => {
      t.increments('id')
      t.string('v')
    })
    const t0 = Date.now()
    await k.transaction(async (trx) => {
      await trx('tx_t').insert({ v: 'trx' })
      await k('tx_t').insert({ v: 'db' }) // the pool's other connection: would wait 60 s
    })
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(await k('tx_t').orderBy('id').pluck('v')).toEqual(['trx', 'db'])
    await expect(
      k.transaction(async (trx) => {
        await trx('tx_t').insert({ v: 'trx2' })
        await k('tx_t').insert({ v: 'db2' })
        throw new Error('undo')
      })
    ).rejects.toThrow('undo')
    expect(await k('tx_t').count({ n: '*' })).toEqual([{ n: 2 }])
    // After the transaction a write on db runs on its own again.
    await k('tx_t').insert({ v: 'after' })
    expect(await k('tx_t').count({ n: '*' })).toEqual([{ n: 3 }])
  })
})

describe('sqlite: dialect/ef.ts', () => {
  it('labels, buckets and dates', async () => {
    expect(await one(dateLabel(k, '?', 'yyyy-MM'), ['2026-11-20T10:00:00.000Z'])).toBe('2026-11')
    expect(await one(dateLabel(k, '?', 'yyyy-MM-dd'), ['2026-11-20T10:00:00.000Z'])).toBe(
      '2026-11-20'
    )
    expect(await one(isoWeekLabel(k, '?'), ['2026-01-01', '2026-01-01'])).toBe('2026-W01')
    expect(await one(isoWeekLabel(k, '?'), [null, null])).toBe('-W')
    expect(await one(dateBucket(k, 'day', '?'), ['2026-11-20T10:00:00.000Z'])).toBe('2026-11-20')
    // 2026-11-20 is a Friday: its week starts Monday the 16th.
    expect(
      await one(`(SELECT ${dateBucket(k, 'week', 'x')} FROM (SELECT ? AS x))`, [
        '2026-11-20T10:00:00.000Z'
      ])
    ).toBe('2026-11-16')
    expect(
      await one(`(SELECT ${dateBucket(k, 'week', 'x')} FROM (SELECT ? AS x))`, ['2026-11-16'])
    ).toBe('2026-11-16')
    expect(await one(dateBucket(k, 'month', '?'), ['2026-11-20T10:00:00.000Z'])).toBe('2026-11-01')
    expect(await one(hourBucket(k, '?'), ['2026-11-20T10:20:30.456Z'])).toEqual(
      new Date('2026-11-20T10:00:00.000Z')
    )
    expect(await one(isoDateParam(k), ['2026-01-05'])).toBe('2026-01-05')
    expect(
      await one(`(SELECT ${withinSecond(k, 'x')} FROM (SELECT ? AS x))`, [
        '2026-11-20T10:00:00.400Z',
        '2026-11-20T10:00:01.300Z'
      ])
    ).toBe(1)
    expect(
      await one(`(SELECT ${withinSecond(k, 'x')} FROM (SELECT ? AS x))`, [
        '2026-11-20T10:00:00.000Z',
        '2026-11-20T10:00:01.300Z'
      ])
    ).toBe(0)
    expect(floatType(k)).toBe('REAL')
  })

  it('JSON scalars (SQL Server JSON_VALUE answers)', async () => {
    const at = (path: string, id = 1) =>
      one(`(SELECT ${jsonScalar(k, 'meta')} FROM things WHERE id = ${id})`, [path])
    expect(await at('$.a.b')).toBe('5')
    expect(await at('$.t')).toBe('true')
    expect(await at('$.s')).toBe('x')
    expect(await at('$.o')).toBeNull()
    expect(await at('$.missing')).toBeNull()
    expect(await at('$.s', 2)).toBeNull() // not JSON
    expect(await one(`(SELECT ${jsonHasObject(k, 'meta', 'o')} FROM things WHERE id = 1)`)).toBe(1)
    expect(await one(`(SELECT ${jsonHasObject(k, 'meta', 's')} FROM things WHERE id = 1)`)).toBe(0)
    expect(
      await one(`(SELECT ${jsonHasObject(k, 'meta', 'o')} FROM things WHERE id = 2)`)
    ).toBeNull()
  })

  it('try-conversions', async () => {
    const f = tryFloat(k, '?', ['x'])
    expect(f.bindings).toHaveLength(2)
    expect(await one(f.sql, [' 12.5 ', ' 12.5 '])).toBe(12.5)
    expect(await one(f.sql, ['abc', 'abc'])).toBeNull()
    const d = tryIsoDate(k, '?', ['x'])
    expect(await one(d.sql, ['2026-01-05', '2026-01-05'])).toBe('2026-01-05')
    expect(await one(d.sql, ['5/1/2026', '5/1/2026'])).toBeNull()
  })

  it('escapes LIKE text the way the default escape reads it', async () => {
    const p = `%${escapeLikeFor(k, '50%')}%`
    expect(await k('things').where('body', 'like', p).pluck('label')).toEqual(['Alpha'])
    expect(
      await k('things')
        .where('body', 'like', `%${escapeLikeFor(k, 'f_s')}%`)
        .pluck('label')
    ).toEqual(['Alpha'])
  })

  it('insertReturningRow and physicalColumnNames', async () => {
    const r = await insertReturningRow<{ id: number; name: string }>(k, 'owners', { name: 'Cee' })
    expect(r).toMatchObject({ id: 3, name: 'Cee' })
    expect(await physicalColumnNames(k, 'owners')).toEqual(['id', 'name'])
  })
})

describe('sqlite: dialect/catalog.ts', () => {
  it('tables, columns, keys, counts, sizes', async () => {
    expect([...(await listBaseTables(k))]).toEqual(expect.arrayContaining(['owners', 'things']))
    expect(await listColumnNames(k, 'owners')).toEqual(['id', 'name'])
    expect(await catalogRowCount(k, 'things')).toBe(3)
    expect(await catalogRowCount(k, 'nope')).toBeNull()
    const cols = await describeColumns(k, 'owners')
    expect(cols).toEqual([
      { name: 'id', isIdentity: true, isComputed: false },
      { name: 'name', isIdentity: false, isComputed: false }
    ])
    expect(await routineDefinition(k, 'p')).toBeNull()
    const fks = await foreignKeysNonMssql(k, { referencedTable: 'owners' })
    expect(fks).toEqual([
      { table: 'things', column: 'owner_id', ref_table: 'owners', untrusted: false }
    ])
    const kb = await tableSizesKb(k, ['things', 'OWNERS', 'nope'])
    expect(kb.get('things')).toBeGreaterThan(0)
    expect(kb.has('owners')).toBe(true)
    expect(kb.has('nope')).toBe(false)
  })
})

describe('sqlite: dialect/h1.ts', () => {
  it('database, tables, indexes, keys, storage', async () => {
    expect(await currentDatabaseName(k)).toBe('h')
    expect(await baseTableNames(k)).toEqual(expect.arrayContaining(['owners', 'things']))
    const counts = new Map((await tableRowCounts(k)).map((r) => [r.table_name, r.row_count]))
    expect(counts.get('things')).toBe(3)
    const idx = groupIndexes(await indexKeyColumns(k))
    expect(idx.find((i) => i.index === 'ix_things_label')).toMatchObject({
      table: 'things',
      columns: ['label'],
      unique: false,
      primary: false
    })
    expect(idx.find((i) => i.table === 'things' && i.primary)?.columns).toEqual(['id'])
    const foot = (await tableFootprints(k)).find((t) => t.name === 'things')
    expect(foot?.row_count).toBe(3)
    expect(Number(foot?.size_mb)).toBeGreaterThanOrEqual(0)
    const st = await nonMssqlStorage(k)
    expect(st.total_mb).toBeGreaterThanOrEqual(0)
    expect(st.top_tables.map((t) => t.table_name)).toContain('things')
    expect(await referencedTables(k)).toEqual(
      expect.arrayContaining([{ referenced: 'owners', parent: 'things', fk: 'fk_things_0' }])
    )
    expect(await foreignKeysOnTable(k, 'things')).toEqual([
      {
        constraint_name: 'fk_things_0',
        column_name: 'owner_id',
        referenced_table: 'owners',
        referenced_column: 'id'
      }
    ])
    expect(await foreignKeysTouching(k, 'owners', 'id')).toEqual([{ fk_name: 'fk_things_0' }])
    expect(await hasIdentityColumn(k, 'things')).toBe(true)
    expect(await hasIdentityColumn(k, 'things', 'n')).toBe(false)
  })

  it('schema edits: types, cast checks, renames, dropping a foreign key', async () => {
    expect(physicalType(k, 'boolean')).toBe('boolean')
    expect(physicalType(k, 'datetime')).toBe('datetime')
    expect(physicalType(k, 'string', 40)).toBe('varchar(40)')
    const failing = async (
      type: Parameters<typeof castFailureCondition>[2],
      col: string,
      len?: number
    ) =>
      (
        await k.raw(
          `SELECT label FROM things WHERE ${col} IS NOT NULL AND ${castFailureCondition(k, col, type, len)} ORDER BY id`
        )
      ).map((r: { label: string }) => r.label)
    expect(await failing('integer', 'body')).toEqual(['Alpha', 'beta'])
    expect(await failing('integer', 'n')).toEqual([])
    expect(await failing('uuid', 'ref')).toEqual([])
    expect(await failing('uuid', 'label')).toEqual(['Alpha', 'beta', 'Gamma'])
    expect(await failing('string', 'body', 5)).toEqual(['Alpha'])
    expect(await failing('date', 'day')).toEqual([])
    await k.schema.createTable('ren', (t) => {
      t.increments('id')
      t.string('a')
      t.integer('o').references('owners.id')
    })
    await renameColumn(k, 'ren', 'a', 'b')
    await renameTable(k, 'ren', 'ren2')
    expect(await listColumnNames(k, 'ren2')).toEqual(['id', 'b', 'o'])
    expect(await dropForeignKeysOnColumn(k, 'ren2', 'o')).toBe(1)
    expect(await foreignKeysOnTable(k, 'ren2')).toEqual([])
  })
})

describe('sqlite: dialect/h2.ts', () => {
  it('catalog reads', async () => {
    expect(await foreignKeyColumnsTo(k, 'owners')).toEqual(
      expect.arrayContaining([{ table_name: 'things', column_name: 'owner_id' }])
    )
    const types = new Map((await columnTypes(k, 'things')).map((c) => [c.column_name, c.data_type]))
    expect(types.get('label')).toBe('nvarchar')
    expect(types.get('n')).toBe('int')
    expect(types.get('flag')).toBe('bit')
    expect(types.get('at')).toBe('datetime2')
    expect(await leadingIndexColumns(k, 'things')).toEqual(new Set(['label', 'id']))
    expect(await h2RowCount(k, 'things')).toBe(3)
    expect(await h2RowCount(k, 'nope')).toBe(0)
    expect(await primaryKeyColumns(k, 'things')).toEqual([{ col: 'id', type: 'int' }])
    expect(await uuidColumnsNamed(k, ['ref', 'label'])).toEqual([
      { table_name: 'things', column_name: 'ref' }
    ])
    expect(await one(dayText(k, '?'), ['2026-11-20T23:00:00.000Z'])).toBe('2026-11-20')
  })

  it('portableSql runs the T-SQL statement builders’ text', async () => {
    const sql = portableSql(
      k,
      "SELECT [label] FROM [things] WHERE [id] IN (SELECT [value] FROM OPENJSON(?)) AND CAST([label] AS nvarchar(20)) COLLATE Latin1_General_100_BIN2 LIKE N'%a%' ESCAPE '\\' ORDER BY [id]"
    )
    expect((await k.raw(sql, ['[1,2,3]'])).map((r: { label: string }) => r.label)).toEqual([
      'Alpha',
      'beta',
      'Gamma'
    ])
  })
})

describe('sqlite: dialect/items-query.ts', () => {
  it('type lists, people filters, row counts, prefixes, keys, columns', async () => {
    const textCols = (
      await k.raw(
        `SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'things' AND DATA_TYPE IN ${sqlInList(textDataTypes(k))} ORDER BY ordinal_position`
      )
    ).map((r: { c: string }) => r.c)
    expect(textCols).toEqual(['label', 'body', 'ref'])
    const numCols = (
      await k.raw(
        `SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'things' AND DATA_TYPE IN ${sqlInList(numericDataTypes(k))} ORDER BY ordinal_position`
      )
    ).map((r: { c: string }) => r.c)
    expect(numCols).toEqual(['id', 'n', 'amount', 'owner_id'])
    const h = hiddenEmailSql(k)
    const pass = async (email: string) =>
      one(
        `(SELECT CASE WHEN ${h.legacy} AND ${h.redacted} AND ${h.invalid} THEN 1 ELSE 0 END FROM (SELECT ? AS email))`,
        [email]
      )
    expect(await pass('pat@x.test')).toBe(1)
    expect(await pass('Redacted_12@x')).toBe(0)
    expect(await pass('RedactedX@x')).toBe(1)
    expect(await pass('legacy-1@x')).toBe(0)
    expect(await pass('a@invalid.local')).toBe(0)
    expect(await one(`(${tableRowsSql(k)})`, ['things'])).toBe(3)
    const all = new Map(
      (await k.raw(allTableRowsSql(k))).map((r: { table_name: string; rows: number }) => [
        r.table_name,
        r.rows
      ])
    )
    expect(all.get('owners')).toBe(3)
    expect(
      await one(`(SELECT ${notPrefixedSql(k, 'x', 'nivaro')} FROM (SELECT ? AS x))`, [
        'nivaro_users'
      ])
    ).toBe(0)
    expect(
      await one(`(SELECT ${notPrefixedSql(k, 'x', 'nivaro')} FROM (SELECT ? AS x))`, [
        'nivaroXusers'
      ])
    ).toBe(1)
    expect(await k.raw(inboundForeignKeysSql(k), ['owners'])).toEqual(
      expect.arrayContaining([{ table_name: 'things', column_name: 'owner_id' }])
    )
    const pc = new Map((await portableColumns(k, 'things')).map((c) => [c.name, c]))
    expect(pc.get('id')).toMatchObject({ sql: 'int', identity: true })
    expect(pc.get('label')).toMatchObject({ sql: 'nvarchar(100)', maxChars: 100 })
    expect(pc.get('flag')?.sql).toBe('bit')
    expect(pc.get('at')?.sql).toMatch(/^datetime2/)
    const g = sqlText(k)
    expect(g.id('a"b')).toBe('"a""b"')
    expect(await one(`(SELECT ${g.idText('id')} FROM things WHERE id = 2)`)).toBe('2')
  })
})

describe('sqlite: the other helper files', () => {
  it('users-ai-config', async () => {
    expect(await one(castBigint(k, '?'), ['12'])).toBe(12)
    expect(await one(castFloat(k, '?'), ['1.5'])).toBe(1.5)
    expect(quoteIdent(k, 'user')).toBe('"user"')
    expect(await one(bucketLabel(k, '?', 'hour'), ['2026-11-20T10:20:30.456Z'])).toBe(
      '2026-11-20T10'
    )
    expect(await one(bucketLabel(k, '?', 'day'), ['2026-11-20T10:20:30.456Z'])).toBe('2026-11-20')
    expect(await one(bucketLabelSpaced(k, '?', 'hour'), ['2026-11-20T10:20:30.456Z'])).toBe(
      '2026-11-20 10:00'
    )
    expect(await one(byteLength(k, '?'), ['é'])).toBe(2)
    await k.schema.createTable('nivaro_x', (t) => t.increments('id'))
    expect(await listNivaroTables(k)).toEqual(['nivaro_x'])
    expect(await approxTableCounts(k, 'nivaro')).toEqual([{ name: 'nivaro_x', row_count: 0 }])
    expect(
      (
        await infoColumns(k)
          .where('table_name', 'owners')
          .orderBy('ordinal_position')
          .select(infoCols('column_name'))
      ).map((r: { column_name: string }) => r.column_name)
    ).toEqual(['id', 'name'])
  })

  it('batch writes, traffic hour, tsql, collation, SQL text', async () => {
    await k.schema.createTable('bw', (t) => {
      t.increments('id')
      t.integer('v')
    })
    await k('bw').insert([{ v: 1 }, { v: 1 }, { v: 1 }])
    expect(affectedRows(await k.raw(updateBatchSql(k, 'bw', 'v = ?', 'v = ?', 2), [2, 1]))).toBe(2)
    expect(affectedRows(await k.raw(deleteBatchSql(k, 'bw', 'v = ?', 2), [2]))).toBe(2)
    expect(await k('bw').count({ n: '*' })).toEqual([{ n: 1 }])
    expect(await one(trafficHour(k, '?'), ['2026-11-20T10:20:30.456Z'])).toEqual(
      new Date('2026-11-20T10:00:00.000Z')
    )
    const t = tsql(
      k,
      "SELECT TOP 2 [label], LEN(label) AS l, CHARINDEX('a', label) AS p, DATEPART(weekday, '2026-11-20') AS w, DATEDIFF(day, '2026-11-01', '2026-11-20') AS dd, DATEADD(day, 1, '2026-11-20T00:00:00.000Z') AS da FROM [things] WHERE label LIKE 'a[_]%' OR label LIKE 'al%' ORDER BY id"
    )
    expect(await k.raw(t)).toEqual([
      { label: 'Alpha', l: 5, p: 5, w: 6, dd: 19, da: new Date('2026-11-21T00:00:00.000Z') }
    ])
    expect(await one(`${collateCiAs(k, "'ABC'")} = 'abc'`)).toBe(1)
    expect(await runSqlText(k, "SELECT 'a?' AS x; SELECT 2 AS x")).toEqual([{ x: 'a?' }, { x: 2 }])
  })
})

describe('sqlite: dates in filters, castDate, the optional driver', () => {
  it('puts filter values in the stored shape and names a value that is no date', () => {
    const ops: Record<string, unknown> = { _gt: '2026-11-20 10:00', _in: ['2026-11-21'], _eq: null }
    expect(fitSqliteDateOps(ops, 'datetime')).toBeNull()
    expect(ops).toEqual({
      _gt: '2026-11-20T10:00:00.000Z',
      _in: ['2026-11-21T00:00:00.000Z'],
      _eq: null
    })
    const day: Record<string, unknown> = {
      _between: ['2026-11-01T05:00:00Z', new Date('2026-11-30T00:00:00Z')]
    }
    expect(fitSqliteDateOps(day, 'date')).toBeNull()
    expect(day._between).toEqual(['2026-11-01', '2026-11-30'])
    expect(fitSqliteDateOps({ _lt: '$NOW' }, 'datetime')).toBe('_lt')
    expect(fitSqliteDateOps({ _contains: 'x' }, 'datetime')).toBeNull()
  })

  it('castDate groups and compares by day and reads back as a Date', async () => {
    expect(castDate({ client: { config: { client: 'mssql' } } } as never, 'x', 'date')).toBe(
      'CAST(x AS date)'
    )
    expect(await one(castDate(k, '?'), ['2026-11-20T23:59:59.999Z'])).toEqual(
      new Date('2026-11-20T00:00:00.000Z')
    )
    expect(
      await one(`${castDate(k, '?')} = ${castDate(k, '?')}`, [
        '2026-11-20T01:00:00.000Z',
        '2026-11-20'
      ])
    ).toBe(1)
  })

  it('names a missing better-sqlite3 plainly', () => {
    expect(sqliteDriverProblem(() => undefined)).toBeNull()
    const msg = sqliteDriverProblem(() => {
      throw new Error("Cannot find module 'better-sqlite3'")
    })
    expect(msg).toMatch(/DB_CLIENT=sqlite needs the better-sqlite3 module/)
    expect(msg).toMatch(/Cannot find module/)
  })
})
