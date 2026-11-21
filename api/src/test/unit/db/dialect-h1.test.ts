import type { Knex } from 'knex'
import { describe, expect, it } from 'vitest'
import {
  castFailureCondition,
  groupIndexes,
  inThisSchema,
  isUuidColumn,
  pgUsing,
  physicalType,
  reviveIsoDates
} from '../../../db/dialect/h1.js'

const knexOf = (client: string) => ({ client: { config: { client } } }) as unknown as Knex
const ms = knexOf('mssql')
const pg = knexOf('pg')
const my = knexOf('mysql2')

describe('db/dialect/h1', () => {
  it('scopes information_schema reads off SQL Server only', () => {
    expect(inThisSchema(ms, 't.TABLE_SCHEMA')).toBe('')
    expect(inThisSchema(pg, 't.TABLE_SCHEMA')).toBe(' AND t.TABLE_SCHEMA = current_schema()')
    expect(inThisSchema(my, 't.TABLE_SCHEMA')).toBe(' AND t.TABLE_SCHEMA = DATABASE()')
  })

  it('maps abstract types to physical ones', () => {
    expect(physicalType(pg, 'string', 50)).toBe('varchar(50)')
    expect(physicalType(pg, 'datetime')).toBe('timestamptz')
    expect(physicalType(pg, 'boolean')).toBe('boolean')
    expect(physicalType(my, 'uuid')).toBe('char(36)')
    expect(physicalType(my, 'boolean')).toBe('tinyint(1)')
    expect(physicalType(my, 'string', 99999)).toBe('varchar(255)')
  })

  it('builds the "cannot convert" condition without a ? placeholder', () => {
    for (const k of [pg, my]) {
      for (const t of [
        'string',
        'text',
        'integer',
        'bigInteger',
        'boolean',
        'decimal',
        'float',
        'date',
        'datetime',
        'uuid'
      ] as const)
        expect(castFailureCondition(k, 'c', t, 20)).not.toContain('?')
    }
    expect(castFailureCondition(pg, '"c"', 'integer')).toContain('~')
    expect(castFailureCondition(my, '`c`', 'integer')).toContain('REGEXP')
    expect(pgUsing(pg, '"c"', 'boolean')).toContain('CASE WHEN')
  })

  it('converts a Postgres column by what it is now (fromType)', () => {
    // a timestamp prints with its zone ('… 03:04:05+00'): it always converts to a date/time
    expect(castFailureCondition(pg, '"c"', 'date', undefined, 'datetimeoffset')).toBe('1 = 0')
    expect(pgUsing(pg, '"c"', 'date', 'datetimeoffset')).toBe('("c")::date')
    expect(pgUsing(pg, '"c"', 'datetime', 'date')).toBe('("c")::timestamptz')
    // a timestamp as text reads like MySQL's DATETIME(3), in UTC
    expect(pgUsing(pg, '"c"', 'string', 'datetimeoffset')).toBe(
      `(to_char(("c") AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS'))::varchar(255)`
    )
    expect(pgUsing(pg, '"c"', 'text', 'datetime2')).toBe(
      `to_char(("c"), 'YYYY-MM-DD HH24:MI:SS.MS')`
    )
    // a boolean converts like SQL Server's bit: 1 / 0
    const bit = '(CASE WHEN "c" THEN 1 WHEN NOT "c" THEN 0 END)'
    expect(pgUsing(pg, '"c"', 'string', 'bit')).toBe(`${bit}::varchar(255)`)
    expect(castFailureCondition(pg, '"c"', 'integer', undefined, 'bit')).toContain(bit)
    expect(pgUsing(pg, '"c"', 'boolean', 'bit')).toBe(pgUsing(pg, '"c"', 'boolean'))
    // no source type, or not Postgres: unchanged
    expect(castFailureCondition(pg, '"c"', 'date')).toBe(
      castFailureCondition(pg, '"c"', 'date', undefined, undefined)
    )
    expect(castFailureCondition(my, '`c`', 'date', undefined, 'datetime2')).toBe(
      castFailureCondition(my, '`c`', 'date')
    )
  })

  it('groups index key columns in order', () => {
    const rows = [
      {
        table_name: 't',
        index_name: 'i',
        seq: 2,
        column_name: 'b',
        is_unique: false,
        is_primary: false,
        has_filter: false
      },
      {
        table_name: 't',
        index_name: 'i',
        seq: 1,
        column_name: 'a',
        is_unique: false,
        is_primary: false,
        has_filter: false
      }
    ]
    expect(groupIndexes(rows)[0]).toMatchObject({ table: 't', index: 'i', columns: ['a', 'b'] })
  })

  it('turns ISO text back into Dates off SQL Server', () => {
    const row = { a: '2026-11-19T10:00:00.000Z', b: 'x' }
    expect(reviveIsoDates(ms, row)).toBe(row)
    const out = reviveIsoDates(my, row)
    expect(out.a).toBeInstanceOf(Date)
    expect(out.b).toBe('x')
  })

  it('recognises uuid columns on all three databases', () => {
    expect(isUuidColumn('uniqueidentifier')).toBe(true)
    expect(isUuidColumn('uuid')).toBe(true)
    expect(isUuidColumn('char', 36)).toBe(true)
    expect(isUuidColumn('char', 10)).toBe(false)
    expect(isUuidColumn('int')).toBe(false)
  })
})
