// tm-actions review fixes: traces never keep a credential's bound value; record broadcasts with no
// action still reach other replicas' temporary caches (and nothing else).
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

import { pubsub, topics } from '../../graphql/pubsub.js'
import {
  closeItemEvents,
  initItemEvents,
  onCollectionTouched,
  onItemEvent
} from '../item-events.js'
import { broadcastCollectionUpdate } from '../realtime.js'
import {
  attachQueryTracing,
  beginTrace,
  finishTrace,
  keepNext,
  keptBindings,
  listTraces,
  REDACTED_BINDING
} from '../request-trace.js'
import { setTimedRulesForTest } from './timed-rules.js'

describe('trace bindings', () => {
  it('redacts the bindings of statements naming a credential column', () => {
    const token = 'tok_live_abc123'
    expect(
      keptBindings('select * from [nivaro_users] where [static_token] = @p0', [token])
    ).toEqual([REDACTED_BINDING])
    expect(keptBindings('update [nivaro_settings] set [smtp_pass] = @p0', ['pw'])).toEqual([
      REDACTED_BINDING
    ])
    expect(keptBindings('select * from x where key_hash = @p0 and id = @p1', ['h', 3])).toEqual([
      REDACTED_BINDING,
      REDACTED_BINDING
    ])
    expect(keptBindings('select * from orders where id = @p0', [7])).toEqual([7])
  })

  it('redacts lookups by a bare token or api_key column (share links, forms, widget feeds)', () => {
    expect(
      keptBindings('select * from [nivaro_share_links] where [token] = @p0', ['s3cr3t'])
    ).toEqual([REDACTED_BINDING])
    expect(keptBindings('select * from x where api_key = @p0', ['k'])).toEqual([REDACTED_BINDING])
    expect(keptBindings('select * from tokens_used where n = @p0', [1])).toEqual([1])
  })

  it('a kept trace (slow, debug window, GET /traces/:id) never holds the raw token', () => {
    const handlers: Record<string, (...a: unknown[]) => void> = {}
    attachQueryTracing({
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        handlers[ev] = fn
      }
    })
    const off = keepNext('test', () => true)
    const token = 'tok_live_secret_value'
    beginTrace('/api/items/orders', {} as object)
    const q = {
      __knexQueryUid: 'q1',
      sql: 'select top (1) * from [nivaro_users] where [static_token] = @p0',
      bindings: [token]
    }
    handlers.query(q)
    handlers['query-response'](null, q)
    const plain = {
      __knexQueryUid: 'q2',
      sql: 'select * from orders where id = @p0',
      bindings: [5]
    }
    handlers.query(plain)
    handlers['query-response'](null, plain)
    finishTrace({
      method: 'GET',
      route: '/api/items/:c',
      url: '/api/items/orders',
      status: 200,
      user: null
    })
    off()
    const kept = JSON.stringify(listTraces(1)[0])
    expect(kept).not.toContain(token)
    expect(kept).toContain(REDACTED_BINDING)
    expect(kept).toContain('"bindings":[5]')
  })
})

describe('cross-replica bust for broadcasts without an action', () => {
  afterEach(async () => {
    setTimedRulesForTest([])
    await closeItemEvents()
  })

  async function fakeRedis() {
    const conn = Object.assign(new EventEmitter(), {
      subscribe: async () => 1,
      quit: async () => 'OK'
    })
    const published: string[] = []
    await initItemEvents({
      duplicate: () => conn,
      publish: async (_c: string, raw: string) => {
        published.push(raw)
        return 1
      }
    } as never)
    return { conn, published }
  }

  it('publishes a touch for an aspect only while a cache is on', async () => {
    const { published } = await fakeRedis()
    broadcastCollectionUpdate(undefined, 'orders', 1, { changed_fields: ['$state'] })
    expect(published).toHaveLength(0)
    setTimedRulesForTest([
      {
        kind: 'cache',
        id: 'r1',
        target: 'items/orders',
        until: Date.now() + 60_000,
        at: Date.now(),
        by: null,
        by_name: null
      }
    ])
    broadcastCollectionUpdate(undefined, 'orders', 1, { changed_fields: ['$lock'] })
    expect(published.map((p) => JSON.parse(p).touched)).toEqual([
      { collection: 'orders', tenant: '' }
    ])
  })

  it('a touch from another replica reaches the cache listener, not subscriptions', async () => {
    const { conn } = await fakeRedis()
    const touched: Array<[string, string]> = []
    const events: unknown[] = []
    const offs = [
      onCollectionTouched((c, t) => touched.push([c, t])),
      onItemEvent((ev) => events.push(ev))
    ]
    const sub = pubsub.asyncIterator(topics.itemMutated('orders', '*', ''))
    const next = Promise.race([sub.next(), new Promise<null>((r) => setTimeout(() => r(null), 10))])
    conn.emit(
      'message',
      'chan',
      JSON.stringify({ node: 'another-replica', touched: { collection: 'orders', tenant: '' } })
    )
    expect(await next).toBeNull()
    await sub.return?.()
    for (const off of offs) off()
    expect(touched).toEqual([['orders', '']])
    expect(events).toHaveLength(0)
  })
})
