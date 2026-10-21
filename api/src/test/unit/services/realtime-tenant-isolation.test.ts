import type { Knex } from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Cloud mode: two tenants share one API process, one Redis and one socket
// server. Record-change events (ids + field names) must reach only the
// tenant that made the write — live, batched, or replayed.
const sent = vi.hoisted(() => ({
  broadcasts: [] as Array<{ tenant: string | undefined; collection: string; item: unknown }>,
  emits: [] as Array<{ room: string; event: string }>
}))

vi.mock('../../../services/io-holder.js', () => {
  const op = {
    to: (room: string) => ({
      emit: (event: string) => {
        sent.emits.push({ room, event })
      }
    })
  }
  return { getIo: () => ({ ...op, local: op }) }
})
vi.mock('../../../services/event-journal-store.js', () => ({
  replayFromTable: vi.fn(async () => ({ full: true, events: [] })),
  recordDurable: vi.fn(),
  flushDurable: vi.fn(async () => {}),
  maxDurableSeq: vi.fn(async () => null)
}))
vi.mock('../../../services/event-stream.js', () => ({
  streamActive: () => false,
  publishToStream: vi.fn(async () => false)
}))
vi.mock('../../../services/realtime.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  return {
    broadcastCollectionUpdate: (_io: unknown, collection: string, item: unknown) => {
      sent.broadcasts.push({ tenant: getTenantId(), collection, item })
    }
  }
})

import { runWithTenantDb } from '../../../db/tenant-context.js'
import { journaledEmit, replaySince, setJournalRedis } from '../../../services/event-journal.js'
import { announceRawWrites, flushRawWriteQueue } from '../../../services/raw-write-announcer.js'
import { tenantScopedRoom } from '../../../services/tenant-rooms.js'

const dbA = { name: 'A' } as unknown as Knex
const dbB = { name: 'B' } as unknown as Knex

/** Run `fn` inside a tenant's context and wait for it. */
function inTenant<T>(db: Knex, id: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb(db, id, () => void fn().then(resolve, reject), id)
  })
}

/** A Redis double: one shared sequence and one shared sorted-set journal. */
function sharedRedis() {
  let seq = 0
  const rooms: Record<string, number> = {}
  const journal: Array<{ seq: number; raw: string }> = []
  return {
    incr: vi.fn(async () => ++seq),
    multi: () => {
      // #2462 — the sequence and the room counter come from one transaction.
      const results: Array<[null, number]> = []
      const m = {
        incr: (key: string) => {
          if (key === 'nvr:ev:seq') results.push([null, ++seq])
          else {
            rooms[key] = (rooms[key] ?? 0) + 1
            results.push([null, rooms[key]])
          }
          return m
        },
        zadd: (_k: string, s: number, raw: string) => {
          journal.push({ seq: s, raw })
          return m
        },
        zremrangebyrank: () => m,
        expire: () => m,
        exec: async () => results
      }
      return m
    },
    zrange: vi.fn(async () => (journal.length ? [journal[0].raw, String(journal[0].seq)] : [])),
    zrangebyscore: vi.fn(async (_k: string, min: string) => {
      const after = Number(String(min).replace('(', ''))
      return journal.filter((j) => j.seq > after).map((j) => j.raw)
    }),
    get: vi.fn(async () => String(seq))
  }
}

beforeEach(() => {
  sent.broadcasts = []
  sent.emits = []
  flushRawWriteQueue()
})

describe('raw-write batches with two tenants in one window', () => {
  it('broadcasts each tenant batch inside its own tenant context', async () => {
    await inTenant(dbA, 'tenant-a', () =>
      announceRawWrites('orders', [1, 2], { action: 'update', changed_fields: ['status'] })
    )
    await inTenant(dbB, 'tenant-b', () =>
      announceRawWrites('orders', [9], { action: 'update', changed_fields: ['total'] })
    )
    // Flushed from tenant A's context (where the debounce timer was armed).
    await inTenant(dbA, 'tenant-a', async () => flushRawWriteQueue())

    const a = sent.broadcasts.filter((b) => b.tenant === 'tenant-a').map((b) => b.item)
    const b = sent.broadcasts.filter((b) => b.tenant === 'tenant-b').map((b) => b.item)
    expect(a.sort()).toEqual(['1', '2'])
    expect(b).toEqual(['9'])
    expect(sent.broadcasts).toHaveLength(3)
  })

  it('a no-tenant batch flushed from a tenant timer stays outside every tenant', async () => {
    await announceRawWrites('orders', [5])
    await inTenant(dbA, 'tenant-a', () => announceRawWrites('orders', [6]))
    await inTenant(dbA, 'tenant-a', async () => flushRawWriteQueue())
    expect(sent.broadcasts).toEqual(
      expect.arrayContaining([
        { tenant: undefined, collection: 'orders', item: '5' },
        { tenant: 'tenant-a', collection: 'orders', item: '6' }
      ])
    )
  })
})

describe('journaled events are tenant-scoped', () => {
  it('emits to the tenant room and replays only the asking tenant', async () => {
    setJournalRedis(sharedRedis() as never)
    await inTenant(dbA, 'tenant-a', () =>
      journaledEmit('collection:orders', 'collection:update', { collection: 'orders', item: 1 })
    )
    await inTenant(dbB, 'tenant-b', () =>
      journaledEmit('collection:orders', 'collection:update', { collection: 'orders', item: 2 })
    )
    expect(sent.emits.map((e) => e.room)).toEqual([
      't:tenant-a:collection:orders',
      't:tenant-b:collection:orders'
    ])

    // A tenant-A socket sits in A's room only; its catch-up never sees B's write.
    const roomsA = new Set([tenantScopedRoom('collection:orders', 'tenant-a')])
    const replay = await replaySince(0, roomsA)
    expect(replay.full).toBe(false)
    expect(replay.events.map((e) => e.payload.item)).toEqual([1])
  })

  it('self-hosted (no tenant) keeps the plain room name', async () => {
    setJournalRedis(sharedRedis() as never)
    const r = await journaledEmit('collection:orders', 'collection:update', { item: 1 })
    expect(r.room).toBe('collection:orders')
  })
})
