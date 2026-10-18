// #2273 temporary cache: key isolation, busting, what is never kept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

import { withTrafficStore } from '../traffic-taps.js'
import {
  bustAllTempCache,
  CACHE_HEADER,
  cacheableCollection,
  cacheKey,
  identityKey,
  isRelational,
  MAX_LIVE,
  normalizeQuery,
  noteCollectionChanged,
  onlySessionCookie,
  relatedCollections,
  resetTempCache,
  ruleFor,
  startTempCache,
  tempCacheLookup,
  tempCacheSize,
  tempCacheStore
} from './temp-cache.js'
import { setTimedRulesForTest, type TimedRule } from './timed-rules.js'

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002'

function rule(over: Partial<TimedRule> = {}): TimedRule {
  return {
    kind: 'cache',
    id: 'r1',
    target: 'items/orders',
    until: Date.now() + 600_000,
    at: Date.now(),
    by: null,
    by_name: null,
    opts: { entry_s: 30, related: ['customers'] },
    ...over
  }
}

function req(over: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    headers: {},
    params: { collection: 'orders' },
    query: { limit: '10', sort: 'id' },
    routeOptions: { url: '/api/items/:collection' },
    authMethod: 'session',
    user: { id: ALICE, role: 'role-1' },
    isAdmin: false,
    workspaceId: null,
    ...over
  }
}

function reply() {
  const headers: Record<string, unknown> = {}
  const r = {
    statusCode: 200,
    sent: undefined as unknown,
    headers,
    code(n: number) {
      r.statusCode = n
      return r
    },
    header(k: string, v: string) {
      headers[k.toLowerCase()] = v
      return r
    },
    getHeader(k: string) {
      return headers[k.toLowerCase()]
    },
    send(b: unknown) {
      r.sent = b
      return r
    }
  }
  return r
}

/** One full round trip: lookup, and on a miss the route answers `body` and onSend keeps it. */
function roundTrip(
  q: ReturnType<typeof req>,
  body = '{"data":[1]}',
  status = 200,
  ct = 'application/json; charset=utf-8'
) {
  const rep = reply()
  const hit = tempCacheLookup(q as never, rep as never)
  if (!hit) {
    rep.statusCode = status
    rep.header('content-type', ct)
    tempCacheStore(q, rep as never, body)
  }
  return { hit, rep }
}

beforeEach(() => {
  resetTempCache()
  setTimedRulesForTest([rule()])
})
afterEach(() => {
  setTimedRulesForTest([])
  resetTempCache()
})

describe('identity and keys', () => {
  it('never caches an anonymous request', () => {
    expect(identityKey({ user: null })).toBeNull()
    const { hit } = roundTrip(req({ user: null }))
    expect(hit).toBe(false)
    expect(tempCacheSize().entries).toBe(0)
  })

  it('gives every distinct caller identity its own key', () => {
    const base = { authMethod: 'session', user: { id: ALICE, role: 'r' }, isAdmin: false }
    const ids = new Set(
      [
        base,
        { ...base, user: { id: BOB, role: 'r' } },
        { ...base, user: { id: ALICE, role: 'other' } },
        { ...base, isAdmin: true },
        { ...base, authMethod: 'api_key', apiKeyId: 7 },
        { ...base, authMethod: 'api_key', apiKeyId: 8 },
        { ...base, authMethod: 'key_sim', apiKeySimulatedId: 7 },
        { ...base, authMethod: 'masquerade', masqueradeAdminId: BOB },
        { ...base, workspaceId: 'w2' }
      ].map((x) => identityKey(x as never))
    )
    expect(ids.size).toBe(9)
  })

  it('treats user id case and query key order as the same request', () => {
    expect(identityKey({ user: { id: ALICE.toUpperCase() } })).toBe(
      identityKey({ user: { id: ALICE } })
    )
    expect(normalizeQuery({ b: '2', a: { y: 1, x: 2 } })).toBe(
      normalizeQuery({ a: { x: 2, y: 1 }, b: '2' })
    )
    expect(normalizeQuery({ limit: '10' })).not.toBe(normalizeQuery({ limit: '11' }))
  })

  it('keys differ per store (tenant), route, params and query', () => {
    const p = { store: 'default', identity: 'i', route: '/a', params: '{}', query: '{}' }
    const keys = new Set([
      cacheKey(p),
      cacheKey({ ...p, store: 't:x' }),
      cacheKey({ ...p, identity: 'j' }),
      cacheKey({ ...p, route: '/b' }),
      cacheKey({ ...p, params: '{"id":"1"}' }),
      cacheKey({ ...p, query: '{"a":1}' })
    ])
    expect(keys.size).toBe(6)
  })
})

describe('serving', () => {
  it('answers the same caller from memory and marks the response', () => {
    expect(roundTrip(req()).hit).toBe(false)
    const second = roundTrip(req({ query: { sort: 'id', limit: '10' } }))
    expect(second.hit).toBe(true)
    expect(second.rep.sent).toBe('{"data":[1]}')
    expect(second.rep.headers[CACHE_HEADER]).toBe('hit')
  })

  it('never serves one caller’s answer to another', () => {
    roundTrip(req())
    expect(roundTrip(req({ user: { id: BOB, role: 'role-1' } })).hit).toBe(false)
    expect(roundTrip(req({ authMethod: 'api_key', apiKeyId: 3 })).hit).toBe(false)
    expect(roundTrip(req({ workspaceId: 'other' })).hit).toBe(false)
  })

  it('never serves across stores (tenants)', () => {
    withTrafficStore('t:one', () => roundTrip(req()))
    expect(withTrafficStore('t:two', () => roundTrip(req())).hit).toBe(false)
    expect(withTrafficStore('t:one', () => roundTrip(req())).hit).toBe(true)
  })

  it('applies only to the allowlisted read routes of a collection with a rule', () => {
    expect(ruleFor(req({ method: 'POST' }) as never)).toBeNull()
    expect(
      ruleFor(req({ routeOptions: { url: '/api/items/:collection/export' } }) as never)
    ).toBeNull()
    expect(ruleFor(req({ params: { collection: 'invoices' } }) as never)).toBeNull()
    expect(ruleFor(req({ routeOptions: { url: '/api/items/:collection/:id' } }) as never)?.id).toBe(
      'r1'
    )
  })

  it('bypasses on Cache-Control: no-cache from the caller', () => {
    roundTrip(req())
    expect(roundTrip(req({ headers: { 'cache-control': 'no-cache' } })).hit).toBe(false)
  })

  it('keeps nothing but a 200 JSON answer without Set-Cookie', () => {
    roundTrip(req(), '{"error":"x"}', 403)
    expect(tempCacheSize().entries).toBe(0)
    roundTrip(req(), '<html>', 200, 'text/html')
    expect(tempCacheSize().entries).toBe(0)
    const q = req()
    const rep = reply()
    tempCacheLookup(q as never, rep as never)
    rep.header('content-type', 'application/json')
    rep.header('set-cookie', 'sid=1')
    tempCacheStore(q, rep as never, '{}')
    expect(tempCacheSize().entries).toBe(0)
    // the same answer without the cookie is kept
    const q2 = req()
    const rep2 = reply()
    tempCacheLookup(q2 as never, rep2 as never)
    rep2.header('content-type', 'application/json')
    tempCacheStore(q2, rep2 as never, '{}')
    expect(tempCacheSize().entries).toBe(1)
  })

  it('expires entries after their seconds', () => {
    const t0 = Date.now()
    const q = req()
    const rep = reply()
    tempCacheLookup(q as never, rep as never, t0)
    rep.header('content-type', 'application/json')
    tempCacheStore(q, rep as never, '{}', t0)
    expect(tempCacheLookup(req() as never, reply() as never, t0 + 29_000)).toBe(true)
    expect(tempCacheLookup(req() as never, reply() as never, t0 + 31_000)).toBe(false)
  })
})

describe('busting', () => {
  it('a write to the collection drops its answers', () => {
    roundTrip(req())
    noteCollectionChanged('orders')
    expect(roundTrip(req()).hit).toBe(false)
  })

  it('a write to a related collection drops them too; an unrelated one does not', () => {
    roundTrip(req())
    noteCollectionChanged('unrelated')
    expect(roundTrip(req()).hit).toBe(true)
    noteCollectionChanged('customers')
    expect(roundTrip(req()).hit).toBe(false)
  })

  it('a query through relations is dropped by any write', () => {
    const q = req({ query: { fields: 'id,customer.name' } })
    expect(isRelational(normalizeQuery(q.query))).toBe(true)
    roundTrip(q)
    expect(roundTrip(q).hit).toBe(true)
    noteCollectionChanged('anything_else')
    expect(roundTrip(q).hit).toBe(false)
  })

  it('a write during the read discards the answer', () => {
    const q = req()
    const rep = reply()
    tempCacheLookup(q as never, rep as never)
    noteCollectionChanged('orders') // lands while the route runs
    rep.header('content-type', 'application/json')
    tempCacheStore(q, rep as never, '{"stale":true}')
    expect(tempCacheSize().entries).toBe(0)
  })

  it('a remote write busts only its own tenant', () => {
    withTrafficStore('t:a', () => roundTrip(req()))
    noteCollectionChanged('orders', 'b')
    expect(withTrafficStore('t:a', () => roundTrip(req())).hit).toBe(true)
    noteCollectionChanged('orders', 'a')
    expect(withTrafficStore('t:a', () => roundTrip(req())).hit).toBe(false)
  })

  it('entries go when their rule ends', () => {
    roundTrip(req())
    expect(tempCacheSize().entries).toBe(1)
    setTimedRulesForTest([])
    expect(tempCacheSize().entries).toBe(0)
  })
})

describe('switching it on', () => {
  it('allows ordinary collections only', () => {
    expect(cacheableCollection('items/orders')).toBe('orders')
    expect(cacheableCollection('system/nivaro_users')).toBeNull()
    expect(cacheableCollection('items/nivaro_users')).toBeNull()
    expect(cacheableCollection('items/chat_messages')).toBeNull()
    expect(cacheableCollection('queries/x')).toBeNull()
  })

  it('finds relations on both sides, junctions and M2A lists included', () => {
    expect(
      relatedCollections('orders', [
        { many_collection: 'orders', one_collection: 'customers' },
        { many_collection: 'order_lines', one_collection: 'orders' },
        { many_collection: 'orders_tags', one_collection: 'orders' },
        {
          many_collection: 'notes',
          one_collection: null,
          one_allowed_collections: ['orders', 'x']
        },
        { many_collection: 'a', one_collection: 'b' }
      ]).sort()
    ).toEqual(['customers', 'notes', 'order_lines', 'orders_tags', 'x'])
  })

  it('validates minutes, entry seconds and the target, and needs Redis', async () => {
    setTimedRulesForTest([])
    const user = { id: ALICE }
    await expect(startTempCache({ target: 'items/nivaro_users', user })).rejects.toMatchObject({
      code: 'CACHE_TARGET'
    })
    await expect(
      startTempCache({ target: 'items/orders', minutes: 16, user })
    ).rejects.toMatchObject({ code: 'CACHE_MINUTES' })
    await expect(
      startTempCache({ target: 'items/orders', entrySeconds: 301, user })
    ).rejects.toMatchObject({ code: 'CACHE_ENTRY_S' })
    await expect(startTempCache({ target: 'items/orders', user })).rejects.toMatchObject({
      code: 'CACHE_UNAVAILABLE'
    })
  })
})

describe('review fixes', () => {
  function keep(q: ReturnType<typeof req>, cookie?: string | string[]) {
    const rep = reply()
    tempCacheLookup(q as never, rep as never)
    rep.header('content-type', 'application/json')
    if (cookie) (rep.headers as Record<string, unknown>)['set-cookie'] = cookie
    tempCacheStore(q, rep as never, '{"data":[1]}')
    return rep
  }

  it('keeps an answer whose only cookie renews the rolling session, never the cookie', () => {
    expect(onlySessionCookie(undefined)).toBe(true)
    expect(onlySessionCookie('nivaro_session=abc; Path=/; HttpOnly')).toBe(true)
    expect(onlySessionCookie(['nivaro_session=abc', 'other=1'])).toBe(false)
    expect(onlySessionCookie('nivaro_sessionx=1')).toBe(false)
    keep(req(), 'nivaro_session=abc.sig; Path=/; HttpOnly; SameSite=Lax')
    expect(tempCacheSize().entries).toBe(1)
    const { hit, rep } = roundTrip(req())
    expect(hit).toBe(true)
    expect(rep.headers['set-cookie']).toBeUndefined()
    resetTempCache()
    keep(req(), ['nivaro_session=abc', 'theme=dark'])
    expect(tempCacheSize().entries).toBe(0)
  })

  it('an access change busts every entry, relational or not, and a read that raced it', () => {
    roundTrip(req())
    roundTrip(req({ query: { fields: 'id,customer.name' } }))
    expect(roundTrip(req()).hit).toBe(true)
    bustAllTempCache()
    expect(roundTrip(req()).hit).toBe(false)
    expect(roundTrip(req({ query: { fields: 'id,customer.name' } })).hit).toBe(false)
    const q = req({ query: { limit: '5' } })
    const rep = reply()
    tempCacheLookup(q as never, rep as never)
    bustAllTempCache() // a policy edit lands while the read runs
    rep.header('content-type', 'application/json')
    tempCacheStore(q, rep as never, '{}')
    expect(roundTrip(req({ query: { limit: '5' } })).hit).toBe(false)
  })

  it('a record event on a system table busts every entry', () => {
    roundTrip(req())
    noteCollectionChanged('nivaro_user_scopes')
    expect(roundTrip(req()).hit).toBe(false)
    roundTrip(req())
    noteCollectionChanged('directus_permissions')
    expect(roundTrip(req()).hit).toBe(false)
  })

  it('an API key scope edit gives the caller a new key', () => {
    const base = { authMethod: 'api_key', apiKeyId: 7, user: { id: ALICE, role: 'r' } }
    const a = identityKey({ ...base, apiKeyScopes: [{ collection: 'orders', actions: ['read'] }] })
    const b = identityKey({ ...base, apiKeyScopes: [{ collection: 'x', actions: ['read'] }] })
    const c = identityKey({
      ...base,
      user: { ...base.user, api_key_scope_restrictions: [{ dimension: 'd', values: [1] }] }
    })
    expect(new Set([a, b, c, identityKey(base)]).size).toBe(4)
  })

  it('treats nested filters, quantifiers and deep as relational', () => {
    const rel = (query: Record<string, unknown>) => isRelational(normalizeQuery(query))
    expect(rel({ filter: JSON.stringify({ tags: { name: { _eq: 'x' } } }) })).toBe(true)
    expect(
      rel({ filter: JSON.stringify({ _and: [{ lines: { _some: { qty: { _gt: 1 } } } }] }) })
    ).toBe(true)
    expect(rel({ deep: '{}' })).toBe(true)
    expect(rel({ filter: JSON.stringify({ status: { _eq: 'open' }, id: { _in: [1, 2] } }) })).toBe(
      false
    )
    expect(rel({ filter: JSON.stringify({ _or: [{ status: { _null: true } }] }) })).toBe(false)
    // a nested-filter read is busted by a write to the far collection
    const q = req({ query: { filter: JSON.stringify({ tags: { name: { _eq: 'x' } } }) } })
    roundTrip(q)
    expect(roundTrip(q).hit).toBe(true)
    noteCollectionChanged('tags')
    expect(roundTrip(q).hit).toBe(false)
  })

  it('includes the far side of an M2M (and M2A) through its junction', () => {
    expect(
      relatedCollections('orders', [
        { many_collection: 'orders_tags', one_collection: 'orders', junction_field: 'tags_id' },
        { many_collection: 'orders_tags', one_collection: 'tags', junction_field: 'orders_id' },
        { many_collection: 'orders_items', one_collection: 'orders', junction_field: 'item' },
        {
          many_collection: 'orders_items',
          one_collection: null,
          one_allowed_collections: ['pages', 'posts'],
          junction_field: 'orders_id'
        },
        { many_collection: 'tags', one_collection: 'colours' }
      ]).sort()
    ).toEqual(['orders_items', 'orders_tags', 'pages', 'posts', 'tags'])
  })

  it('refuses a cache past the live cap', async () => {
    const live = Array.from({ length: MAX_LIVE }, (_, i) =>
      rule({ id: `r${i}`, target: `items/c${i}` })
    )
    setTimedRulesForTest(live, {} as never)
    await expect(
      startTempCache({ target: 'items/orders', user: { id: ALICE }, loadRelations: async () => [] })
    ).rejects.toMatchObject({ code: 'CACHE_LIMIT', status: 409 })
  })
})
