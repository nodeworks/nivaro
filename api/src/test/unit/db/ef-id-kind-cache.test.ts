import type { Knex } from 'knex'
import { describe, expect, it, vi } from 'vitest'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import { forgetAppState } from '../../../services/app-state.js'

// Hub phase 6 final review (core) M6: MySQL's "is this key auto-increment or text" answer is
// cached per app + table + column, not per knex handle — every transaction is a new handle, so the
// old WeakMap re-read columnInfo for each insert inside a transaction. And an app that leaves the
// process loses its answers (forgetAppState).

function fakeMysql(columnInfo: (table: string, col: string) => Promise<unknown>): Knex {
  const k = ((table: string) => ({
    columnInfo: (col: string) => columnInfo(table, col),
    insert: async () => [7]
  })) as unknown as Knex
  ;(k as unknown as { client: unknown }).client = { config: { client: 'mysql2' } }
  return k
}

describe('MySQL id-kind cache', () => {
  it('one columnInfo read per app + table + column across handles (transactions)', async () => {
    const info = vi.fn(async () => ({ type: 'int' }))
    const a = fakeMysql(info)
    const trx = fakeMysql(info)
    expect(await insertReturningId(a, 'ef_cache_t1', { name: 'x' })).toBe(7)
    expect(await insertReturningId(trx, 'ef_cache_t1', { name: 'y' })).toBe(7)
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('each app reads its own answer, and forgets it when it leaves', async () => {
    const info = vi.fn(async () => ({ type: 'int' }))
    const k = fakeMysql(info)
    const inApp = (app: string) =>
      new Promise<unknown>((resolve, reject) =>
        runWithTenantDb(
          k,
          app,
          () => {
            insertReturningId(k, 'ef_cache_t2', { name: 'x' }).then(resolve, reject)
          },
          app
        )
      )
    await inApp('efa-e1')
    await inApp('efb-e2')
    expect(info).toHaveBeenCalledTimes(2)
    await inApp('efa-e1')
    expect(info).toHaveBeenCalledTimes(2)
    forgetAppState('efa-e1')
    await inApp('efa-e1')
    expect(info).toHaveBeenCalledTimes(3)
  })
})
