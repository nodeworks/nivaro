import { EventEmitter } from 'node:events'
import type { Knex } from 'knex'
import { afterEach, describe, expect, it } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import { pubsub, topics } from '../../../graphql/pubsub.js'
import { closeItemEvents, initItemEvents, publishItemEvent } from '../../../services/item-events.js'
import { roomKind, splitTenantRoom } from '../../../services/socket-transport.js'
import {
  publishSseEvent,
  type SseEvent,
  sseEventForTenant,
  subscribeSse
} from '../../../services/sse-hub.js'
import { currentTenantKey, tenantScopedRoom } from '../../../services/tenant-rooms.js'

/** Run `fn` as if inside tenant `id`'s request (cloud mode's AsyncLocalStorage context). */
function inTenant<T>(id: string, fn: () => T): T {
  let out: T
  runWithTenantDb(
    {} as Knex,
    `slug-${id}`,
    () => {
      out = fn()
    },
    id
  )
  return out!
}

/** Collect what an async iterator yields within one macrotask. */
async function drain<T>(it: AsyncIterableIterator<T>): Promise<T[]> {
  const got: T[] = []
  for (;;) {
    const r = await Promise.race([
      it.next(),
      new Promise<null>((res) => setTimeout(() => res(null), 5))
    ])
    if (!r || r.done) break
    got.push(r.value)
  }
  await it.return?.()
  return got
}

describe("SSE stream: one tenant never reads another tenant's changes", () => {
  const offs: Array<() => void> = []
  afterEach(() => {
    for (const off of offs.splice(0)) off()
  })

  /** A stream opened under a tenant: captures the tenant the way events-stream.ts does. */
  function openStream(tenantId: string | null) {
    const tenant = tenantId ? inTenant(tenantId, () => currentTenantKey()) : currentTenantKey()
    const got: Array<Omit<SseEvent, 'tenant'>> = []
    offs.push(
      subscribeSse((ev) => {
        const p = sseEventForTenant(ev, tenant)
        if (p) got.push(p)
      })
    )
    return got
  }

  it('delivers a write to its own tenant only, without the tenant stamp', () => {
    const a = openStream('A')
    const b = openStream('B')
    inTenant('A', () => publishSseEvent({ collection: 'orders', item: 7, action: 'update' }))
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ collection: 'orders', item: 7 })
    expect(a[0]).not.toHaveProperty('tenant')
    expect(b).toHaveLength(0)
    inTenant('B', () => publishSseEvent({ collection: 'orders', item: 7, action: 'update' }))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('self-hosted (no tenant) streams see untenanted writes and nothing else', () => {
    const plain = openStream(null)
    publishSseEvent({ collection: 'orders', item: 1 })
    inTenant('A', () => publishSseEvent({ collection: 'orders', item: 2 }))
    expect(plain.map((e) => e.item)).toEqual([1])
  })
})

describe('GraphQL itemMutated: topics and the Redis relay carry the tenant', () => {
  afterEach(() => closeItemEvents())

  it('keys topics per tenant; self-hosted names are unchanged', () => {
    expect(topics.itemMutated('orders', '7')).toBe('item:mutated:orders:7')
    expect(inTenant('A', () => topics.itemMutated('orders', '7'))).toBe('t:A:item:mutated:orders:7')
    expect(topics.workflowStateChanged('orders', '7', 'B')).toBe('t:B:workflow:state:orders:7')
    expect(topics.pipelineStateChanged('orders', '7', '')).toBe('pipeline:state:orders:7')
  })

  it('a write in tenant A reaches A subscribers only', async () => {
    const a = pubsub.asyncIterator(topics.itemMutated('orders', '*', 'A'))
    const aOne = pubsub.asyncIterator(topics.itemMutated('orders', '7', 'A'))
    const b = pubsub.asyncIterator(topics.itemMutated('orders', '*', 'B'))
    inTenant('A', () =>
      publishItemEvent({ collection: 'orders', item: '7', action: 'update', changed_fields: ['x'] })
    )
    const [gotA, gotAOne, gotB] = await Promise.all([drain(a), drain(aOne), drain(b)])
    expect(gotA).toHaveLength(1)
    expect(gotAOne).toHaveLength(1)
    expect(gotB).toHaveLength(0)
    expect((gotA[0] as { itemMutated: Record<string, unknown> }).itemMutated).not.toHaveProperty(
      'tenant'
    )
  })

  it("an event relayed from another replica lands on its own tenant's topic", async () => {
    const conn = Object.assign(new EventEmitter(), {
      subscribe: async () => 1,
      quit: async () => 'OK'
    })
    const published: string[] = []
    const redis = {
      duplicate: () => conn,
      publish: async (_c: string, raw: string) => {
        published.push(raw)
        return 1
      }
    }
    await initItemEvents(redis as never)
    // This replica's own publish carries its tenant onto the wire.
    inTenant('A', () =>
      publishItemEvent({ collection: 'orders', item: '1', action: 'create', changed_fields: [] })
    )
    expect(JSON.parse(published[0]).ev.tenant).toBe('A')

    const a = pubsub.asyncIterator(topics.itemMutated('orders', '*', 'A'))
    const b = pubsub.asyncIterator(topics.itemMutated('orders', '*', 'B'))
    conn.emit(
      'message',
      'chan',
      JSON.stringify({
        node: 'another-replica',
        ev: {
          collection: 'orders',
          item: '9',
          action: 'update',
          changed_fields: [],
          at: new Date().toISOString(),
          tenant: 'B'
        }
      })
    )
    const [gotA, gotB] = await Promise.all([drain(a), drain(b)])
    expect(gotA).toHaveLength(0)
    expect(gotB).toHaveLength(1)
  })
})

describe('record and item rooms are per tenant in cloud mode', () => {
  it('two tenants with the same record id get different rooms; self-hosted is unchanged', () => {
    const a = inTenant('A', () => tenantScopedRoom('record:orders:7'))
    const b = inTenant('B', () => tenantScopedRoom('record:orders:7'))
    expect(a).toBe('t:A:record:orders:7')
    expect(b).toBe('t:B:record:orders:7')
    expect(tenantScopedRoom('record:orders:7')).toBe('record:orders:7')
    expect(inTenant('A', () => tenantScopedRoom('item:orders:7'))).toBe('t:A:item:orders:7')
  })

  it('splitTenantRoom recovers the room and its tenant', () => {
    expect(splitTenantRoom('t:A:record:orders:7')).toEqual({ tenant: 'A', room: 'record:orders:7' })
    expect(splitTenantRoom('record:orders:7')).toEqual({ tenant: '', room: 'record:orders:7' })
  })

  it('payload-size rows group tenant rooms by kind (counters are already per tenant)', () => {
    expect(roomKind('t:A:record:orders:7')).toBe('record:orders:*')
    expect(roomKind('t:B:collection:orders')).toBe('collection:orders')
  })
})
