import knex from 'knex'
import { describe, expect, it } from 'vitest'
import { mysqlDdlCompat, shortMysqlName } from '../../../db/mysql-ddl-compat.js'
import { dialectOf, longTextType, parseTsqlIndex, qid } from '../../../db/portable-ddl.js'

// Compile-only knex instances: nothing connects.
const mysql = knex({ client: 'mysql2' })
const pg = knex({ client: 'pg' })
const mssql = knex({ client: 'mssql' })
mysqlDdlCompat()

describe('parseTsqlIndex', () => {
  it('reads an IF NOT EXISTS guard, INCLUDE and a filter', () => {
    expect(
      parseTsqlIndex(`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_a' AND object_id = OBJECT_ID('t'))
         CREATE INDEX ix_a ON nivaro_activity (mcp_conn, [timestamp] DESC)
         INCLUDE ([user], [action]) WHERE mcp_conn IS NOT NULL`)
    ).toEqual({
      name: 'ix_a',
      table: 'nivaro_activity',
      columns: ['mcp_conn', 'timestamp DESC'],
      unique: false,
      include: ['user', 'action'],
      where: 'mcp_conn IS NOT NULL'
    })
  })

  it('reads a unique index behind IF OBJECT_ID(...) AND NOT EXISTS, with WITH options', () => {
    const spec = parseTsqlIndex(`IF OBJECT_ID('nivaro_x') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_b')
       CREATE UNIQUE NONCLUSTERED INDEX ux_b ON [dbo].[nivaro_x] (seal_seq) WHERE seal_seq IS NOT NULL
       WITH (SORT_IN_TEMPDB = ON)`)
    expect(spec).toMatchObject({
      name: 'ux_b',
      table: 'nivaro_x',
      columns: ['seal_seq'],
      unique: true
    })
    expect(spec.where).toBe('seal_seq IS NOT NULL')
  })

  it('refuses text that is not a CREATE INDEX', () => {
    expect(() => parseTsqlIndex('ALTER TABLE t ADD c int')).toThrow(/not a CREATE INDEX/)
  })
})

describe('dialect helpers', () => {
  it('names the dialect and its long text type', () => {
    expect([dialectOf(mssql), dialectOf(pg), dialectOf(mysql)]).toEqual(['mssql', 'pg', 'mysql'])
    expect([longTextType(mssql), longTextType(pg), longTextType(mysql)]).toEqual([
      'nvarchar(max)',
      'text',
      'longtext'
    ])
    expect([qid(mssql, 'user'), qid(pg, 'user'), qid(mysql, 'user')]).toEqual([
      '[user]',
      '"user"',
      '`user`'
    ])
  })
})

describe('MySQL DDL compat', () => {
  it('keeps short names and shortens long ones to 64 characters, the same way every time', () => {
    expect(shortMysqlName('nivaro_tasks_kind_index')).toBe('nivaro_tasks_kind_index')
    const long = 'nivaro_record_links_from_collection_from_item_to_collection_to_item_unique'
    const short = shortMysqlName(long)
    expect(short).toHaveLength(64)
    expect(short).toBe(shortMysqlName(long))
    expect(short.startsWith('nivaro_record_links_from_collection_from_item_to_collec_')).toBe(true)
  })

  it('makes auto-increment ids signed so integer references line up', () => {
    const sql = mysql.schema
      .createTable('a', (t) => {
        t.increments('id')
        t.bigIncrements('big')
      })
      .toString()
    expect(sql).toContain('`id` int not null auto_increment primary key')
    expect(sql).not.toContain('unsigned')
  })

  it('keys collection columns on 64 characters and shortens long generated index names', () => {
    const sql = mysql.schema
      .createTable('nivaro_record_links', (t) => {
        t.string('from_collection', 255)
        t.string('from_item', 255)
        t.string('to_collection', 255)
        t.string('to_item', 255)
        t.unique(['from_collection', 'from_item', 'to_collection', 'to_item'])
      })
      .toString()
    expect(sql).toContain('`from_collection`(64), `from_item`, `to_collection`(64), `to_item`')
    expect(sql).toContain(
      shortMysqlName('nivaro_record_links_from_collection_from_item_to_collection_to_item_unique')
    )
  })

  it('stores long no-default nivaro_settings text off the row, and nothing else', () => {
    const settings = mysql.schema
      .alterTable('nivaro_settings', (t) => {
        t.string('long_note', 500)
        t.string('with_default', 500).defaultTo('x')
        t.string('short', 100)
      })
      .toString()
    expect(settings).toContain('`long_note` text')
    expect(settings).toContain('`with_default` varchar(500)')
    expect(settings).toContain('`short` varchar(100)')
    const other = mysql.schema.alterTable('other', (t) => t.string('long_note', 500)).toString()
    expect(other).toContain('`long_note` varchar(500)')
  })

  it('makes a plain text() LONGTEXT (TEXT holds 64 KB), keeping an asked-for size', () => {
    const sql = mysql.schema
      .createTable('t', (t) => {
        t.text('plain')
        t.text('medium', 'mediumtext')
        t.text('long', 'longtext')
        t.text('with_default').defaultTo('[]')
      })
      .toString()
    expect(sql).toContain('`plain` longtext')
    expect(sql).toContain('`medium` mediumtext')
    expect(sql).toContain('`long` longtext')
    expect(sql).toContain('`with_default` longtext')
    expect(pg.schema.createTable('t', (t) => t.text('plain')).toString()).toContain('"plain" text')
  })

  it('leaves SQL Server and Postgres DDL alone', () => {
    const ms = mssql.schema.createTable('a', (t) => t.increments('id')).toString()
    const p = pg.schema.createTable('a', (t) => t.increments('id')).toString()
    expect(ms).toContain('[id] int identity(1,1) not null primary key')
    expect(p).toContain('"id" serial primary key')
  })
})
