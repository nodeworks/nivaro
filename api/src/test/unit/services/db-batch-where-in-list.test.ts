import knex from 'knex'
import { describe, expect, it } from 'vitest'
import { JSON_LIST_MIN, whereInList } from '../../../services/db-batch.js'

// No connection is opened: toSQL() only compiles.
const mssql = knex({ client: 'mssql' })
const pg = knex({ client: 'pg' })
const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

describe('whereInList', () => {
  it('keeps a plain IN list below the threshold', () => {
    const q = whereInList(mssql('t as t0'), 't0.id', ids(JSON_LIST_MIN - 1))
      .select('t0.id')
      .toSQL()
    expect(q.sql).toMatch(/\[t0\]\.\[id\] in \(\?(, \?)+\)/)
    expect(q.bindings).toHaveLength(JSON_LIST_MIN - 1)
  })

  it('binds one OPENJSON array from the threshold on SQL Server', () => {
    const q = whereInList(mssql('t as t0'), 't0.id', [...ids(JSON_LIST_MIN), null])
      .select('t0.id')
      .toSQL()
    expect(q.sql).toContain('[t0].[id] IN (SELECT [value] FROM OPENJSON(?))')
    expect(q.bindings).toHaveLength(1)
    // null ids dropped (IN (NULL) never matches); every value sent as text
    expect(JSON.parse(String(q.bindings[0]))).toEqual(ids(JSON_LIST_MIN).map(String))
  })

  it('other dialects keep whereIn whatever the length', () => {
    const q = whereInList(pg('t'), 'id', ids(500)).select('id').toSQL()
    expect(q.sql).not.toContain('OPENJSON')
    expect(q.bindings).toHaveLength(500)
  })
})
