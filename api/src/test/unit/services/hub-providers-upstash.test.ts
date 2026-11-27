import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 17: the Upstash adapter against recorded (fake-valued) answers.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { ensureCoreProviders, CORE_PROVIDERS } = await import(
  '../../../services/hub/providers/index.js'
)
const registry = await import('../../../services/hub/providers/registry.js')
const { upstashAdapter } = await import('../../../services/hub/providers/upstash/index.js')

import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/upstash/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const KEY = 'test-secret-upstash-key-0001'
const EMAIL = 'hub@example.com'
const DB = '11111111-2222-3333-4444-555555555555'
const TYPE = 'upstash.redis_database'
const PW = 'test-secret-upstash-pw-0001'

interface Call {
  method: string
  path: string
  body: any
  headers: Record<string, string>
}
interface Route {
  method: string
  path: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function harness(routes: Route[]) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      path: u.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = routes.find((r) => r.method === call.method && r.path.test(call.path))
    if (!hit) return new Response('{"error":"not found"}', { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: upstashAdapter,
    connectionId: 1,
    config: { email: EMAIL },
    secrets: { apiKey: KEY },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

function desired(
  fields: Record<string, unknown>,
  externalId: string | null = null
): DesiredResource {
  return {
    resourceId: 7,
    type: TYPE,
    externalId,
    scope: 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs: {},
    tags: {}
  }
}

const observedDb = (over: Record<string, unknown> = {}): Observed => ({
  type: TYPE,
  externalId: DB,
  name: 'demo-cache',
  fields: {
    name: 'demo-cache',
    region: 'us-east-1',
    eviction: false,
    tls: true,
    plan: 'Pay as You Go',
    ...over
  },
  tags: {}
})

const op = (over: Partial<PlannedOp>): PlannedOp => ({
  kind: 'update',
  type: TYPE,
  resourceId: 7,
  externalId: DB,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})

const typeSpec = () => upstashAdapter.types[0]

beforeEach(() => {
  registry.resetProvidersForTest()
})

describe('upstash adapter: registration', () => {
  it('is a core provider on api.upstash.com with a secret API key', () => {
    ensureCoreProviders()
    expect(registry.getProvider('upstash')).toBe(upstashAdapter)
    expect(CORE_PROVIDERS).toContain(upstashAdapter)
    expect(upstashAdapter.connection.hosts({})).toEqual(['api.upstash.com'])
    expect(upstashAdapter.connection.fields.find((f) => f.key === 'apiKey')?.secret).toBe(true)
    expect(upstashAdapter.connection.fields.find((f) => f.key === 'email')?.secret).toBeFalsy()
    expect(upstashAdapter.connection.describe({ email: EMAIL })).not.toContain(KEY)
    expect(upstashAdapter.connection.validate?.({ email: 'nope' }, {})).not.toEqual([])
    expect(upstashAdapter.types.map((t) => t.key)).toEqual([TYPE])
  })

  it('refuses a host other than api.upstash.com', async () => {
    const { ctx } = harness([])
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
  })
})

describe('upstash adapter: testConnection', () => {
  it('lists missing permissions when the key is refused', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /databases$/, status: 401, body: fx('error-unauthorized') }
    ])
    const r = await upstashAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual([
      'read Redis databases',
      'manage Redis databases (the API key is account-wide)'
    ])
    expect(r.message).not.toContain(KEY)
  })

  it('answers who the credentials are when the key works', async () => {
    const { ctx, calls } = harness([{ method: 'GET', path: /databases$/, body: fx('databases') }])
    const r = await upstashAdapter.testConnection(ctx)
    expect(r).toMatchObject({ ok: true, missing: [], identity: `Upstash account ${EMAIL}` })
    expect(calls[0].headers.authorization).toBe(
      `Basic ${Buffer.from(`${EMAIL}:${KEY}`).toString('base64')}`
    )
  })
})

describe('upstash adapter: observe and list', () => {
  it('observe maps provider fields and carries no password or token', async () => {
    const { ctx } = harness([{ method: 'GET', path: /\/database\/[^/]+$/, body: fx('database') }])
    const seen = await upstashAdapter.observe(ctx, TYPE, DB)
    expect(seen).toMatchObject({
      type: TYPE,
      externalId: DB,
      name: 'demo-cache',
      status: 'active',
      fields: {
        name: 'demo-cache',
        region: 'us-east-1',
        eviction: false,
        tls: true,
        plan: 'Pay as You Go',
        endpoint: 'demo-cache-12345.upstash.io',
        port: 6379
      }
    })
    const text = JSON.stringify(seen)
    expect(text).not.toContain(PW)
    expect(text).not.toContain('test-secret-rest-token')
  })

  it('a deleted or missing database observes as gone', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /\/database\//, body: { ...fx('database'), state: 'deleted' } }
    ])
    expect(await upstashAdapter.observe(ctx, TYPE, DB)).toBeNull()
    const { ctx: c2 } = harness([])
    expect(await upstashAdapter.observe(c2, TYPE, DB)).toBeNull()
  })

  it('list skips deleted databases', async () => {
    const { ctx } = harness([{ method: 'GET', path: /databases$/, body: fx('databases') }])
    const page = await upstashAdapter.list(ctx, TYPE)
    expect(page.cursor).toBeNull()
    expect(page.items.map((i) => i.name)).toEqual(['demo-cache'])
  })

  it('refuses an id that is not a safe path segment', async () => {
    const { ctx, calls } = harness([])
    await expect(upstashAdapter.observe(ctx, TYPE, '../x')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    await expect(upstashAdapter.observe(ctx, TYPE, 'a/b')).rejects.toMatchObject({ code: 'BAD_ID' })
    await expect(upstashAdapter.observe(ctx, TYPE, '')).rejects.toMatchObject({ code: 'BAD_ID' })
    expect(calls).toEqual([])
  })
})

describe('upstash adapter: plan', () => {
  const { ctx } = harness([])

  it('create says it and names the REDIS_URL binding', () => {
    const [p] = upstashAdapter.plan(
      ctx,
      desired({ name: 'demo-cache', region: 'us-east-1', eviction: true }),
      null
    )
    expect(p.kind).toBe('create')
    expect(p.reason).toContain('Upstash Redis database demo-cache')
    expect(p.reason).toContain('REDIS_URL')
    expect(p.reason).toContain('external')
    expect(p.changes.map((c) => c.field)).toEqual(['name', 'region', 'eviction'])
  })

  it('update lists changed fields with their labels and preconditions', () => {
    const [p] = upstashAdapter.plan(
      ctx,
      desired({ name: 'demo-cache', region: 'us-east-1', eviction: true }, DB),
      observedDb()
    )
    expect(p).toMatchObject({ kind: 'update', externalId: DB, preconditions: { eviction: false } })
    expect(p.reason).toContain('Eviction')
    expect(p.changes).toEqual([{ field: 'eviction', from: false, to: true }])
  })

  it('a region change is a replace; delete is a delete; no change is nothing', () => {
    const [r] = upstashAdapter.plan(
      ctx,
      desired({ name: 'demo-cache', region: 'eu-west-1', eviction: false }, DB),
      observedDb()
    )
    expect(r.kind).toBe('replace')
    expect(r.reason).toContain('new, empty database')
    const [d] = upstashAdapter.plan(ctx, null, observedDb())
    expect(d.kind).toBe('delete')
    expect(d.reason).toContain('no way back')
    expect(
      upstashAdapter.plan(
        ctx,
        desired({ name: 'demo-cache', region: 'us-east-1', eviction: false }, DB),
        observedDb()
      )
    ).toEqual([])
  })
})

describe('upstash adapter: risk flags and cost', () => {
  it('risk flags per type', () => {
    const r = (kind: PlannedOp['kind']) => typeSpec().risk(op({ kind }), null)
    expect(r('create')).toEqual([])
    expect(r('update')).toEqual([])
    expect(r('delete')).toEqual(['destructive', 'data_loss'])
    expect(r('replace')).toEqual(['destructive', 'data_loss'])
    expect(typeSpec().costClass?.(desired({}))).toBe('monthly')
  })
})

describe('upstash adapter: apply', () => {
  const want = () => desired({ name: 'demo-cache', region: 'us-east-1', eviction: true })

  it('create posts once, answers the id and the sealed-bound redis_url output', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /databases$/, body: [] },
      { method: 'POST', path: /\/database$/, body: fx('database') }
    ])
    const res = await upstashAdapter.apply(ctx, op({ kind: 'create', externalId: null }), want())
    expect(res.ok).toBe(true)
    expect(res.externalId).toBe(DB)
    expect(res.outputs).toEqual({
      redis_url: `rediss://default:${PW}@demo-cache-12345.upstash.io:6379`
    })
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.body).toMatchObject({
      database_name: 'demo-cache',
      primary_region: 'us-east-1',
      tls: true,
      eviction: true
    })
    expect(JSON.stringify(res.observed)).not.toContain(PW)
    expect(JSON.stringify(res.answer)).not.toContain(PW)
  })

  it('create is idempotent: a resumed create with its id recorded posts nothing', async () => {
    const { ctx, calls } = harness([{ method: 'GET', path: /\/database\//, body: fx('database') }])
    const res = await upstashAdapter.apply(
      ctx,
      op({ kind: 'create', externalId: null }),
      desired({ name: 'demo-cache', region: 'us-east-1' }, DB)
    )
    expect(res.answer).toMatchObject({ already: 'exists' })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('create over a database the Hub did not make is ALREADY_EXISTS, nothing written', async () => {
    const { ctx, calls } = harness([{ method: 'GET', path: /databases$/, body: fx('databases') }])
    await expect(
      upstashAdapter.apply(ctx, op({ kind: 'create', externalId: null }), want())
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('findExisting names a database of the same name for the plan', async () => {
    const { ctx } = harness([{ method: 'GET', path: /databases$/, body: fx('databases') }])
    const hit = await upstashAdapter.findExisting?.(ctx, TYPE, want())
    expect(hit?.externalId).toBe(DB)
    const { ctx: c2 } = harness([{ method: 'GET', path: /databases$/, body: [] }])
    expect(await upstashAdapter.findExisting?.(c2, TYPE, want())).toBeNull()
  })

  it('update reads first and writes only what differs (eviction on, then already on)', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/database\//, body: fx('database') },
      { method: 'POST', path: /enable-eviction/, body: 'OK' }
    ])
    const res = await upstashAdapter.apply(ctx, op({}), want())
    expect(res.ok).toBe(true)
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      `/v2/redis/enable-eviction/${DB}`
    ])
    const { ctx: c2, calls: calls2 } = harness([
      { method: 'GET', path: /\/database\//, body: { ...fx('database'), eviction: true } }
    ])
    const again = await upstashAdapter.apply(c2, op({}), want())
    expect(again.answer).toMatchObject({ already: 'matches' })
    expect(calls2.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('a rename goes through the rename call', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/database\//, body: fx('database') },
      { method: 'POST', path: /\/rename\//, body: 'OK' }
    ])
    await upstashAdapter.apply(
      ctx,
      op({}),
      desired({ name: 'renamed', region: 'us-east-1', eviction: false }, DB)
    )
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.path).toBe(`/v2/redis/rename/${DB}`)
    expect(post?.body).toEqual({ name: 'renamed' })
  })

  it('delete removes it; deleting what is already gone is a success', async () => {
    const { ctx, calls } = harness([{ method: 'DELETE', path: /\/database\//, body: 'OK' }])
    const res = await upstashAdapter.apply(ctx, op({ kind: 'delete' }), null)
    expect(res).toMatchObject({ ok: true, externalId: DB, observed: null })
    expect(calls[0].method).toBe('DELETE')
    const { ctx: c2 } = harness([{ method: 'DELETE', path: /\/database\//, status: 404, body: '' }])
    expect((await upstashAdapter.apply(c2, op({ kind: 'delete' }), null)).ok).toBe(true)
  })

  it('replace deletes then creates in the new region', async () => {
    const { ctx, calls } = harness([
      { method: 'DELETE', path: /\/database\//, body: 'OK' },
      { method: 'GET', path: /databases$/, body: [] },
      { method: 'POST', path: /\/database$/, body: fx('database-free') }
    ])
    const res = await upstashAdapter.apply(
      ctx,
      op({ kind: 'replace' }),
      desired({ name: 'free-cache', region: 'eu-west-1', eviction: true }, DB)
    )
    expect(res.externalId).toBe('aaaaaaaa-2222-3333-4444-555555555555')
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'GET', 'POST'])
    expect(res.outputs?.redis_url).toContain('free-cache-99999.upstash.io')
  })

  it('refuses a region Upstash does not offer', async () => {
    const { ctx, calls } = harness([])
    await expect(
      upstashAdapter.apply(
        ctx,
        op({ kind: 'create', externalId: null }),
        desired({ name: 'x', region: 'mars-1' })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    expect(calls).toEqual([])
  })
})

describe('upstash adapter: errors', () => {
  it('maps 429 to a retryable error and says when to retry', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /databases$/,
        status: 429,
        body: fx('error-rate-limited'),
        headers: { 'retry-after': '7' }
      }
    ])
    const err: ProviderError = await upstashAdapter.list(ctx, TYPE).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('retry after 7 s')
  })

  it('a 5xx is retryable, a 401 and a 400 are not', async () => {
    const mk = (status: number) =>
      harness([{ method: 'GET', path: /databases$/, status, body: { error: 'nope' } }]).ctx
    expect(await upstashAdapter.list(mk(503), TYPE).catch((e) => e)).toMatchObject({
      retryable: true,
      code: 'PROVIDER_UNAVAILABLE'
    })
    expect(await upstashAdapter.list(mk(401), TYPE).catch((e) => e)).toMatchObject({
      retryable: false,
      code: 'AUTH_FAILED'
    })
    expect(await upstashAdapter.list(mk(400), TYPE).catch((e) => e)).toMatchObject({
      retryable: false,
      code: 'PROVIDER_REJECTED'
    })
  })

  it('secrets never appear in errors', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /databases$/, status: 401, body: fx('error-unauthorized') }
    ])
    const err: ProviderError = await upstashAdapter.list(ctx, TYPE).catch((e) => e)
    expect(err.message).toContain('Upstash answered 401')
    expect(err.message).not.toContain(KEY)
    const fetchFail = makeProviderContext({
      adapter: upstashAdapter,
      connectionId: 2,
      config: { email: EMAIL },
      secrets: { apiKey: KEY },
      fetch: {
        fetchImpl: (async () => {
          throw new TypeError(`getaddrinfo failed for ${KEY}`)
        }) as any,
        timeoutMs: 200
      }
    })
    const e2: Error = await upstashAdapter.list(fetchFail, TYPE).catch((e) => e)
    expect(e2.message).not.toContain(KEY)
  })
})

describe('upstash adapter: outputs', () => {
  it('declares redis_url as a secret output; none leak into observed or desired', async () => {
    expect(typeSpec().outputs).toEqual([
      { key: 'redis_url', label: 'Redis connection URL', secret: true }
    ])
    expect(typeSpec().outputs?.[0].onceOnly).toBeFalsy()
    const { ctx } = harness([{ method: 'GET', path: /\/database\//, body: fx('database') }])
    const seen = await upstashAdapter.observe(ctx, TYPE, DB)
    expect(Object.keys(seen?.fields ?? {})).not.toContain('redis_url')
    expect(Object.keys(seen?.fields ?? {})).not.toContain('password')
    const plan = upstashAdapter.plan(ctx, desired({ name: 'a', region: 'us-east-1' }), null)
    expect(JSON.stringify(plan)).not.toContain('rediss://')
    // No field of the type holds a connection value.
    expect(typeSpec().fields.map((f) => f.key)).not.toContain('redis_url')
  })

  it('readOutputs re-reads the URL (not once-only); an unreadable database answers none', async () => {
    const { ctx } = harness([{ method: 'GET', path: /\/database\//, body: fx('database') }])
    expect(await upstashAdapter.readOutputs?.(ctx, TYPE, DB)).toEqual({
      redis_url: `rediss://default:${PW}@demo-cache-12345.upstash.io:6379`
    })
    const { ctx: c2 } = harness([])
    expect(await upstashAdapter.readOutputs?.(c2, TYPE, DB)).toEqual({})
  })

  it('an unusual password is URL-encoded', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /\/database\//,
        body: { ...fx('database'), password: 'test-secret/with:odd@chars' }
      }
    ])
    const out = await upstashAdapter.readOutputs?.(ctx, TYPE, DB)
    expect(out?.redis_url).toBe(
      'rediss://default:test-secret%2Fwith%3Aodd%40chars@demo-cache-12345.upstash.io:6379'
    )
  })
})

describe('upstash adapter: health', () => {
  it('ok when active, warn otherwise, down when gone', async () => {
    const { ctx } = harness([{ method: 'GET', path: /\/database\//, body: fx('database') }])
    expect((await upstashAdapter.health?.(ctx, TYPE, DB))?.status).toBe('ok')
    const { ctx: c2 } = harness([
      { method: 'GET', path: /\/database\//, body: { ...fx('database'), state: 'suspended' } }
    ])
    expect((await upstashAdapter.health?.(c2, TYPE, DB))?.status).toBe('warn')
    const { ctx: c3 } = harness([])
    expect((await upstashAdapter.health?.(c3, TYPE, DB))?.status).toBe('down')
  })
})

describe('upstash adapter: estimates', () => {
  beforeEach(() => ensureCoreProviders())

  it('estimate from recorded price answer: pay as you go is a known zero plus usage, with the unit prices in the note', async () => {
    const { ctx, calls } = harness([])
    const e = await typeSpec().estimate?.(ctx, desired({ name: 'a', region: 'us-east-1' }), null)
    expect(e).toMatchObject({
      basis: 'usage',
      confidence: 'usage_varies',
      monthlyCents: 0,
      priceAsOf: '2026-11-26'
    })
    expect(e?.note).toContain('plus usage')
    expect(e?.note).toContain('$0.20 per 100,000 commands')
    expect(e?.note).toContain('$0.25 per GB')
    expect(calls).toEqual([])
  })

  it('a free database is free; another plan is "No estimate"; never throws', async () => {
    const { ctx } = harness([])
    const free = await typeSpec().estimate?.(ctx, null, observedDb({ plan: 'Free' }))
    expect(free).toMatchObject({ basis: 'free', confidence: 'exact', monthlyCents: 0 })
    const fixed = await typeSpec().estimate?.(ctx, null, observedDb({ plan: 'Fixed 1GB' }))
    expect(fixed?.confidence).toBe('unknown')
    const none = await typeSpec().estimate?.(ctx, null, null)
    expect(none?.confidence).toBe('unknown')
  })

  it('every costed type carries an estimate', () => {
    expect(
      upstashAdapter.types.every((t) => t.costClass == null || typeof t.estimate === 'function')
    ).toBe(true)
    expect(upstashAdapter.bundledPrices?.asOf).toBe('2026-11-26')
  })
})
