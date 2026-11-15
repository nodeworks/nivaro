import { describe, expect, it, vi } from 'vitest'

// A knex-like builder: chain methods return itself, toSQL compiles, awaiting runs the "query".
const runs: string[] = []
function builder(table: string) {
  const where: unknown[] = []
  const qb = {
    where(...a: unknown[]) {
      where.push(a)
      return qb
    },
    select() {
      return qb
    },
    toSQL() {
      return { sql: `select * from ${table} where ?`, bindings: where }
    },
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      runs.push(table)
      return Promise.resolve([{ table }]).then(res, rej)
    }
  }
  return qb
}
vi.mock('../../db/index.js', () => ({ db: (table: string) => builder(table) }))

import { forgetChunkReads, memoDb } from './memo-db.js'

describe('ready-to-send memo db', () => {
  it('runs each distinct statement once; metadata outlives a chunk, record reads do not', async () => {
    const cache = new Map<string, Promise<unknown>>()
    const m = memoDb(cache) as unknown as (t: string) => ReturnType<typeof builder>
    await m('nivaro_fields').where('collection', 'orders').select()
    await m('nivaro_fields').where('collection', 'orders').select()
    await m('nivaro_fields').where('collection', 'lines').select()
    await m('order_lines').where('order', 1)
    await m('order_lines').where('order', 1)
    expect(runs).toEqual(['nivaro_fields', 'nivaro_fields', 'order_lines'])
    forgetChunkReads(cache)
    await m('nivaro_fields').where('collection', 'orders').select()
    await m('order_lines').where('order', 1)
    expect(runs).toEqual(['nivaro_fields', 'nivaro_fields', 'order_lines', 'order_lines'])
  })
})
