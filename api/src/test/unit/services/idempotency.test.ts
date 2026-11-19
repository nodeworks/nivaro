import { describe, expect, it, vi } from 'vitest'
import {
  beginIdempotency,
  isGraphQLMutation,
  registerIdempotencyStore,
  requestFingerprint,
  stableStringify
} from '../../../services/idempotency.js'

/** A Redis double that honours SET … NX and GET. */
function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    set: vi.fn(async (k: string, v: string, ...flags: unknown[]) => {
      if (flags.includes('NX') && store.has(k)) return null
      store.set(k, v)
      return 'OK'
    }),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0))
  }
}

function fakeReply() {
  const r = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    code(n: number) {
      r.statusCode = n
      return r
    },
    header(k: string, v: string) {
      r.headers[k] = v
      return r
    },
    send(b: unknown) {
      r.body = b
      return r
    }
  }
  return r
}

function fakeReq(opts: {
  key?: string
  body?: unknown
  url?: string
  user?: Record<string, unknown> | null
  redis?: ReturnType<typeof fakeRedis> | null
  method?: string
}) {
  return {
    method: opts.method ?? 'POST',
    url: opts.url ?? '/api/items/orders',
    raw: { url: opts.url ?? '/api/items/orders' },
    headers: opts.key === undefined ? {} : { 'idempotency-key': opts.key },
    body: opts.body ?? { name: 'a' },
    user: opts.user === null ? undefined : (opts.user ?? { id: 'abc' }),
    server: { redis: opts.redis === null ? undefined : (opts.redis ?? fakeRedis()) },
    log: { warn: vi.fn() },
    idempotency: undefined as unknown
  }
}

// biome-ignore lint/suspicious/noExplicitAny: test doubles stand in for fastify types
const begin = (req: any, reply: any, scope = 'items') => beginIdempotency(req, reply, scope)

describe('idempotency — fingerprints', () => {
  it('ignores key order, keeps value differences', () => {
    expect(stableStringify({ a: 1, b: [1, { y: 2, x: 1 }] })).toBe(
      stableStringify({ b: [1, { x: 1, y: 2 }], a: 1 })
    )
    expect(requestFingerprint('POST', '/x', { a: 1 })).not.toBe(
      requestFingerprint('POST', '/x', { a: 2 })
    )
    expect(requestFingerprint('POST', '/x', { a: 1 })).not.toBe(
      requestFingerprint('POST', '/y', { a: 1 })
    )
  })

  it('tells a mutation from a read', () => {
    expect(isGraphQLMutation('mutation { create_orders_item(data: {}) { id } }')).toBe(true)
    expect(isGraphQLMutation('  # leading comment\n mutation M($d: JSON) { x }')).toBe(true)
    expect(isGraphQLMutation('query { orders { id } }')).toBe(false)
    expect(isGraphQLMutation('{ orders { id } }')).toBe(false)
    expect(isGraphQLMutation('query Q { mutation_log { id } }')).toBe(false)
    expect(isGraphQLMutation(undefined)).toBe(false)
  })
})

describe('idempotency — claiming a key', () => {
  it('does nothing without the header', async () => {
    const req = fakeReq({})
    expect(await begin(req, fakeReply())).toBeNull()
    expect(req.idempotency).toBeUndefined()
  })

  it('claims a new key and lets the request run', async () => {
    const redis = fakeRedis()
    const req = fakeReq({ key: 'k-1', redis })
    expect(await begin(req, fakeReply())).toBeNull()
    expect(req.idempotency).toBeTruthy()
    expect(redis.store.size).toBe(1)
  })

  it('refuses a twin that arrives while the first is running', async () => {
    const redis = fakeRedis()
    await begin(fakeReq({ key: 'k-1', redis }), fakeReply())
    const reply = fakeReply()
    const second = fakeReq({ key: 'k-1', redis })
    expect(await begin(second, reply)).toBe(reply)
    expect(reply.statusCode).toBe(409)
    expect((reply.body as { code: string }).code).toBe('IDEMPOTENCY_IN_PROGRESS')
    expect(second.idempotency).toBeUndefined()
  })

  it('replays the stored answer for the same request', async () => {
    const redis = fakeRedis()
    const first = fakeReq({ key: 'k-1', redis })
    await begin(first, fakeReply())
    const claim = first.idempotency as { redisKey: string; fingerprint: string }
    redis.store.set(
      claim.redisKey,
      JSON.stringify({
        state: 'done',
        fingerprint: claim.fingerprint,
        status: 201,
        body: '{"data":{"id":7}}',
        content_type: 'application/json; charset=utf-8',
        finished_at: '2026-09-27T00:00:00.000Z'
      })
    )
    const reply = fakeReply()
    expect(await begin(fakeReq({ key: 'k-1', redis }), reply)).toBe(reply)
    expect(reply.statusCode).toBe(201)
    expect(reply.body).toBe('{"data":{"id":7}}')
    expect(reply.headers['idempotent-replay']).toBe('true')
  })

  it('refuses the same key on a different request', async () => {
    const redis = fakeRedis()
    await begin(fakeReq({ key: 'k-1', redis, body: { name: 'a' } }), fakeReply())
    const reply = fakeReply()
    await begin(fakeReq({ key: 'k-1', redis, body: { name: 'b' } }), reply)
    expect(reply.statusCode).toBe(422)
    expect((reply.body as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('keeps callers apart', async () => {
    const redis = fakeRedis()
    await begin(fakeReq({ key: 'k-1', redis, user: { id: 'one' } }), fakeReply())
    const other = fakeReq({ key: 'k-1', redis, user: { id: 'two' } })
    expect(await begin(other, fakeReply())).toBeNull()
    expect(redis.store.size).toBe(2)
  })

  it('scopes by API key when the caller used one', async () => {
    const redis = fakeRedis()
    await begin(fakeReq({ key: 'k-1', redis, user: { id: 'one', api_key_id: 4 } }), fakeReply())
    const sameUserOtherKey = fakeReq({ key: 'k-1', redis, user: { id: 'one', api_key_id: 5 } })
    expect(await begin(sameUserOtherKey, fakeReply())).toBeNull()
  })

  it('keys updates and deletes too, never reads', async () => {
    for (const method of ['PATCH', 'DELETE']) {
      const req = fakeReq({ key: `k-${method}`, method, url: '/api/items/orders/7' })
      expect(await begin(req, fakeReply())).toBeNull()
      expect(req.idempotency).toBeTruthy()
    }
    const get = fakeReq({ key: 'k-get', method: 'GET' })
    expect(await begin(get, fakeReply())).toBeNull()
    expect(get.idempotency).toBeUndefined()
  })

  it('a repeated delete gets the first answer, not a second delete', async () => {
    const redis = fakeRedis()
    const first = fakeReq({
      key: 'k-del',
      method: 'DELETE',
      url: '/api/items/orders/7',
      body: null,
      redis
    })
    await begin(first, fakeReply())
    const claim = first.idempotency as { redisKey: string; fingerprint: string }
    redis.store.set(
      claim.redisKey,
      JSON.stringify({
        state: 'done',
        fingerprint: claim.fingerprint,
        status: 204,
        body: '',
        content_type: null,
        finished_at: '2026-11-18T00:00:00.000Z'
      })
    )
    const reply = fakeReply()
    const again = fakeReq({
      key: 'k-del',
      method: 'DELETE',
      url: '/api/items/orders/7',
      body: null,
      redis
    })
    expect(await begin(again, reply)).toBe(reply)
    expect(reply.statusCode).toBe(204)
    expect(again.idempotency).toBeUndefined()
  })

  it('the same key on a PATCH of another record is refused', async () => {
    const redis = fakeRedis()
    await begin(
      fakeReq({ key: 'k-p', method: 'PATCH', url: '/api/items/orders/7', redis }),
      fakeReply()
    )
    const first = [...redis.store.keys()][0]
    redis.store.set(
      first,
      JSON.stringify({
        ...JSON.parse(redis.store.get(first) as string),
        state: 'done',
        status: 200,
        body: '{}',
        content_type: null,
        finished_at: 'x'
      })
    )
    const reply = fakeReply()
    await begin(fakeReq({ key: 'k-p', method: 'PATCH', url: '/api/items/orders/8', redis }), reply)
    expect(reply.statusCode).toBe(422)
  })

  it('rejects a malformed key', async () => {
    const reply = fakeReply()
    await begin(fakeReq({ key: 'has space' }), reply)
    expect(reply.statusCode).toBe(400)
  })

  it('runs the request when Redis is missing or failing', async () => {
    expect(await begin(fakeReq({ key: 'k-1', redis: null }), fakeReply())).toBeNull()
    const broken = fakeRedis()
    broken.set.mockRejectedValue(new Error('down'))
    const req = fakeReq({ key: 'k-1', redis: broken })
    expect(await begin(req, fakeReply())).toBeNull()
    expect(req.idempotency).toBeUndefined()
  })

  it('never answers an unauthenticated caller from the store', async () => {
    const redis = fakeRedis()
    const req = fakeReq({ key: 'k-1', redis, user: null })
    expect(await begin(req, fakeReply())).toBeNull()
    expect(redis.store.size).toBe(0)
  })
})

describe('fingerprint and stored failures (automatic retries)', () => {
  it('a query string counts; no query string fingerprints as before', () => {
    expect(requestFingerprint('PATCH', '/x', { a: 1 }, 'dry_run=1')).not.toBe(
      requestFingerprint('PATCH', '/x', { a: 1 })
    )
    expect(requestFingerprint('PATCH', '/x', { a: 1 }, '')).toBe(
      requestFingerprint('PATCH', '/x', { a: 1 })
    )
    expect(requestFingerprint('PATCH', '/x', null, 'b=2&a=1')).toBe(
      requestFingerprint('PATCH', '/x', null, 'a=1&b=2')
    )
  })

  /** Runs the global onSend hook for a claimed request and returns the store. */
  async function finish(key: string, status: number, body: string) {
    const redis = fakeRedis()
    let hook: ((req: unknown, reply: unknown, payload: unknown) => Promise<unknown>) | undefined
    registerIdempotencyStore({
      redis,
      addHook: (_n: string, fn: typeof hook) => {
        hook = fn
      }
    } as never)
    const req = fakeReq({ key, method: 'PATCH', url: '/api/items/orders/7', redis })
    await begin(req, fakeReply())
    const reply = { statusCode: status, getHeader: () => 'application/json' }
    await hook?.(req, reply, body)
    return redis
  }

  it('an app-minted key keeps a server error as the final answer', async () => {
    const redis = await finish('nvr-1', 500, '{"error":"boom"}')
    const stored = JSON.parse([...redis.store.values()][0] as string)
    expect(stored.state).toBe('done')
    expect(stored.status).toBe(500)
  })

  it('a "nothing ran" 503 and a refusal release the key so the retry runs', async () => {
    expect((await finish('nvr-2', 503, '{"code":"SERVER_BUSY"}')).store.size).toBe(0)
    expect((await finish('nvr-3', 422, '{"error":"no"}')).store.size).toBe(0)
  })

  it("a partner's own key still releases on a server error (unchanged)", async () => {
    expect((await finish('partner-1', 500, '{"error":"boom"}')).store.size).toBe(0)
  })
})
