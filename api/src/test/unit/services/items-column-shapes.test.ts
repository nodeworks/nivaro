import type knexFactory from 'knex'
import { afterAll, describe, expect, it, vi } from 'vitest'

// columnShapes off SQL Server reads knex's columnInfo, which spells types the engine's own way
// (SQLite `integer` / `decimal(12,2)`, Postgres `integer` / `double precision`). The number and
// text-length checks know the SQL Server names, so a bad number on an integer column used to
// reach the database ("A value does not match its field's type") instead of the field-named
// refusal SQL Server gives ("Qty must be a number"), and SQLite stored over-long text as given.

const mem = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('../../../db/index.js', async () => {
  const k = (await import('knex')).default({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  mem.db = k
  return { db: k, dbRead: k, isMssql: () => false }
})

import { numberProblem } from '../../../lib/sql-value-fit.js'
import { columnShapes } from '../../../services/items.js'

describe('columnShapes on SQLite', () => {
  afterAll(async () => {
    await (mem.db as ReturnType<typeof knexFactory>).destroy()
  })

  it('reads engine type names as the SQL Server names the checks know, with text length', async () => {
    const db = mem.db as ReturnType<typeof knexFactory>
    await db.raw(
      'CREATE TABLE p5_shapes (id integer primary key, qty integer, amount decimal(12,2), ratio double precision, label varchar(5), note text)'
    )
    const s = await columnShapes('p5_shapes')
    expect(s.get('qty')?.type).toBe('int')
    expect(s.get('amount')?.type).toBe('decimal')
    expect(s.get('ratio')?.type).toBe('float')
    expect((s.get('label') as { length?: number | null }).length).toBe(5)
    expect((s.get('note') as { length?: number | null }).length ?? null).toBeNull()
    expect(numberProblem('abc', s.get('qty'))).toBe('must be a number')
    expect(numberProblem('1,000.25', s.get('amount'))).toBe('must be a number')
    expect(numberProblem('12', s.get('qty'))).toBeNull()
  })
})
