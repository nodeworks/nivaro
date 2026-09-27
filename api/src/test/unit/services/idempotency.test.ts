import { describe, expect, it, vi } from 'vitest'
import {
  beginIdempotency,
  isGraphQLMutation,
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
