import type { Knex } from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Which tenant context each durable-journal insert ran in, and on which connection.
const inserts = vi.hoisted(
  () => [] as Array<{ via: string; tenant: string | undefined; rooms: string[] }>
)

vi.mock('../../../db/index.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  const db = (_table: string) => ({
    insert: async (rows: Array<{ room: string }>) => {
      inserts.push({ via: 'db', tenant: getTenantId(), rooms: rows.map((r) => r.room) })
    }
  })
  return { db }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => true }))

import { getTenantId, runWithTenantDb } from '../../../db/tenant-context.js'
import {
  _resetDurableForTests,
  flushDurable,
  recordDurable
} from '../../../services/event-journal-store.js'

function tenantKnex(name: string): Knex {
  const k = (_table: string) => ({
    insert: async (rows: Array<{ room: string }>) => {
      inserts.push({ via: name, tenant: getTenantId(), rooms: rows.map((r) => r.room) })
    }
  })
  return Object.assign(k, { schema: { hasTable: async () => true } }) as unknown as Knex
}

const entry = (seq: number, room: string) => ({
  seq,
  room,
  event: 'collection:update',
  payload: { collection: 'orders', item: seq }
})

beforeEach(() => {
  inserts.length = 0
  _resetDurableForTests()
})

describe('durable journal flush with tenants', () => {
  it('writes no-tenant rows outside the tenant whose emit triggered the flush', async () => {
    const dbA = tenantKnex('tenant-a-db')
    recordDurable(entry(1, 'collection:orders'))
    await new Promise<void>((resolve, reject) => {
      runWithTenantDb(
        dbA,
        'tenant-a',
        () => {
          recordDurable(entry(2, 't:tenant-a:collection:orders'))
          flushDurable().then(resolve, reject)
        },
        'tenant-a'
      )
    })
    expect(inserts).toEqual(
      expect.arrayContaining([
        { via: 'db', tenant: undefined, rooms: ['collection:orders'] },
        { via: 'tenant-a-db', tenant: 'tenant-a', rooms: ['t:tenant-a:collection:orders'] }
      ])
    )
    expect(inserts).toHaveLength(2)
  })
})
