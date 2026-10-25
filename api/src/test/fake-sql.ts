import knexFactory, { type Knex } from 'knex'

/** One statement as the fake runner saw it. */
export interface FakeQuery {
  method: string
  sql: string
  bindings: unknown[]
}

/**
 * A real knex (mssql dialect) whose statements never reach a server: each one
 * is handed to `answer`, whose return value is the query's result (`first` →
 * a row or undefined, `select` → rows, `update`/`del` → a count, `insert` with
 * returning → rows). Lets a route test assert on the SQL a gate adds.
 */
export function makeFakeDb(answer: (q: FakeQuery) => unknown): Knex {
  const knex = knexFactory({ client: 'mssql' })
  const client = knex.client as unknown as Record<string, unknown>
  client.acquireConnection = async () => ({})
  client.releaseConnection = async () => {}
  client._query = async (_conn: unknown, obj: Record<string, unknown>) => {
    obj.response = await answer({
      method: String(obj.method ?? ''),
      sql: String(obj.sql ?? ''),
      bindings: (obj.bindings as unknown[]) ?? []
    })
    return obj
  }
  client.processResponse = (obj: Record<string, unknown>) => obj.response
  return knex
}
