import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 17: the Redis Cloud adapter against recorded (fake-valued) answers.

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
const { redisCloudAdapter } = await import('../../../services/hub/providers/redis-cloud/index.js')
const { waitTask } = await import('../../../services/hub/providers/redis-cloud/client.js')

import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/redis-cloud/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const ACCOUNT_KEY = 'test-secret-rc-key-0001'
const USER_KEY = 'test-secret-rc-user-0001'
const SUB = 'redis-cloud.subscription'
const DB = 'redis-cloud.database'
const PW = 'test-secret-rc-pw-0001'

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: any
  headers: Record<string, string>
}
interface Route {
  method: string
  path: RegExp
  status?: number
  /** One answer, or a list answered in turn (the last repeats). */
  body?: unknown | (() => unknown)
  seq?: unknown[]
  headers?: Record<string, string>
}

let nextConnection = 100

function harness(routes: Route[], accountId = '4242') {
  const calls: Call[] = []
  const seen = new Map<Route, number>()
  const all: Route[] = [...routes, { method: 'GET', path: /^\/v1\/$/, body: fx('account') }]
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      path: u.pathname,
      query: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = all.find((r) => r.method === call.method && r.path.test(call.path))
    if (!hit) return new Response('{"error":{"type":"NOT_FOUND"}}', { status: 404 })
    let body = hit.body
    if (hit.seq) {
      const n = seen.get(hit) ?? 0
      seen.set(hit, n + 1)
      body = hit.seq[Math.min(n, hit.seq.length - 1)]
    }
    return new Response(JSON.stringify(typeof body === 'function' ? body() : (body ?? {})), {
      status: hit.status ?? 200,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: redisCloudAdapter,
    // A connection of its own per harness: remembered task ids live per connection.
    connectionId: nextConnection++,
    config: { accountId },
    secrets: { accountKey: ACCOUNT_KEY, userKey: USER_KEY },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

const desiredSub = (
  fields: Record<string, unknown>,
  externalId: string | null = null
): DesiredResource => ({
  resourceId: 7,
  type: SUB,
  externalId,
  scope: 'shared',
  appId: null,
  environmentId: null,
  fields,
  refs: {},
  tags: {}
})

const desiredDb = (
  fields: Record<string, unknown>,
  sub: string | null = 'fixed:1001',
  externalId: string | null = null
): DesiredResource => ({
  resourceId: 8,
  type: DB,
  externalId,
  scope: 'app',
  appId: 1,
  environmentId: 2,
  fields,
  refs: { subscription: sub },
  tags: {}
})

const observedSub = (over: Record<string, unknown> = {}): Observed => ({
  type: SUB,
  externalId: 'fixed:1001',
  name: 'demo-sub',
  fields: { name: 'demo-sub', kind: 'fixed', planId: 5001, planName: 'Essentials 250MB', ...over },
  tags: {}
})

const observedDb = (over: Record<string, unknown> = {}): Observed => ({
  type: DB,
  externalId: 'fixed:1001/3003',
  name: 'demo-db',
  fields: {
    subscription: 'fixed:1001',
    name: 'demo-db',
    protocol: 'redis',
    dataEvictionPolicy: 'noeviction',
    replication: false,
    dataPersistence: 'none',
    ...over
  },
  tags: {}
})

const op = (over: Partial<PlannedOp>): PlannedOp => ({
  kind: 'update',
  type: DB,
  resourceId: 8,
  externalId: 'fixed:1001/3003',
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})

const spec = (key: string) => redisCloudAdapter.types.find((t) => t.key === key)!

const dbWant = () =>
  desiredDb({
    name: 'demo-db',
    protocol: 'redis',
    dataEvictionPolicy: 'allkeys-lru',
    replication: false,
    dataPersistence: 'none'
  })

beforeEach(() => {
  registry.resetProvidersForTest()
})

describe('redis-cloud adapter: registration', () => {
  it('is a core provider on api.redislabs.com with a pinned account and two secret keys', () => {
    ensureCoreProviders()
    expect(registry.getProvider('redis-cloud')).toBe(redisCloudAdapter)
    expect(CORE_PROVIDERS).toContain(redisCloudAdapter)
    expect(redisCloudAdapter.connection.hosts({})).toEqual(['api.redislabs.com'])
    const f = (k: string) => redisCloudAdapter.connection.fields.find((x) => x.key === k)
    expect(f('accountKey')?.secret).toBe(true)
    expect(f('userKey')?.secret).toBe(true)
    expect(f('accountId')?.secret).toBeFalsy()
    expect(redisCloudAdapter.connection.validate?.({ accountId: 'x' }, {})).not.toEqual([])
    expect(redisCloudAdapter.types.map((t) => t.key)).toEqual([SUB, DB])
    expect(spec(SUB).scope).toBe('shared')
    expect(spec(DB).scope).toBe('app')
  })

  it('refuses a host other than api.redislabs.com', async () => {
    const { ctx } = harness([])
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
  })
})

describe('redis-cloud adapter: testConnection', () => {
  it('lists missing permissions when the keys are refused', async () => {
    const { ctx } = harness([{ method: 'GET', path: /^\/v1\/$/, status: 401, body: {} }])
    const r = await redisCloudAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.missing).toHaveLength(4)
    expect(r.message).not.toContain(ACCOUNT_KEY)
  })

  it('fails when the keys belong to another account than the pinned one', async () => {
    const { ctx } = harness([], '9999')
    const r = await redisCloudAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('not the pinned account 9999')
  })

  it('answers the account when the keys can read subscriptions; flags no read access', async () => {
    const good = harness([
      { method: 'GET', path: /fixed\/subscriptions$/, body: fx('fixed-subscriptions') }
    ])
    const r = await redisCloudAdapter.testConnection(good.ctx)
    expect(r).toMatchObject({ ok: true, missing: [], identity: 'account Test Account (4242)' })
    expect(good.calls[0].headers['x-api-key']).toBe(ACCOUNT_KEY)
    expect(good.calls[0].headers['x-api-secret-key']).toBe(USER_KEY)
    const denied = harness([
      { method: 'GET', path: /fixed\/subscriptions$/, status: 403, body: fx('error-forbidden') }
    ])
    const d = await redisCloudAdapter.testConnection(denied.ctx)
    expect(d.ok).toBe(false)
    expect(d.missing.length).toBe(4)
  })
})

describe('redis-cloud adapter: pinned account', () => {
  it('every read and write is refused when the keys belong to another account', async () => {
    const { ctx, calls } = harness([], '9999')
    for (const attempt of [
      () => redisCloudAdapter.observe(ctx, SUB, 'fixed:1001'),
      () => redisCloudAdapter.observe(ctx, DB, 'fixed:1001/3003'),
      () => redisCloudAdapter.list(ctx, DB),
      () => redisCloudAdapter.apply(ctx, op({ kind: 'delete' }), null),
      () => redisCloudAdapter.readOutputs!(ctx, DB, 'fixed:1001/3003')
    ])
      await expect(attempt()).rejects.toMatchObject({ code: 'REDIS_CLOUD_OUT_OF_ACCOUNT' })
    expect(calls.every((c) => c.method === 'GET' && c.path === '/v1/')).toBe(true)
  })
})

describe('redis-cloud adapter: observe and list', () => {
  it('observe maps a fixed subscription and a Pro one', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /fixed\/subscriptions\/1001$/, body: fx('fixed-subscription') },
      { method: 'GET', path: /^\/v1\/subscriptions\/2002$/, body: fx('pro-subscription') }
    ])
    const fixed = await redisCloudAdapter.observe(ctx, SUB, 'fixed:1001')
    expect(fixed).toMatchObject({
      externalId: 'fixed:1001',
      name: 'demo-sub',
      status: 'active',
      fields: { kind: 'fixed', planId: 5001, planName: 'Essentials 250MB', region: 'us-east-1' }
    })
    const pro = await redisCloudAdapter.observe(ctx, SUB, 'pro:2002')
    expect(pro?.fields).toMatchObject({ kind: 'pro', planId: null, provider: 'AWS' })
  })

  it('observe maps a database and carries no password', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /fixed\/subscriptions\/1001\/databases\/3003$/,
        body: fx('fixed-database')
      }
    ])
    const seen = await redisCloudAdapter.observe(ctx, DB, 'fixed:1001/3003')
    expect(seen).toMatchObject({
      externalId: 'fixed:1001/3003',
      name: 'demo-db',
      status: 'active',
      fields: {
        subscription: 'fixed:1001',
        protocol: 'redis',
        dataEvictionPolicy: 'noeviction',
        replication: false,
        dataPersistence: 'none',
        memoryLimitInGb: 0.25
      }
    })
    expect(JSON.stringify(seen)).not.toContain(PW)
  })

  it('a missing resource observes as gone; a malformed id is refused before any call', async () => {
    const { ctx, calls } = harness([])
    expect(await redisCloudAdapter.observe(ctx, SUB, 'fixed:1001')).toBeNull()
    for (const bad of ['fixed:../1', 'fixed:1/2', 'x:1', '1', '', 'fixed:1;2'])
      await expect(redisCloudAdapter.observe(ctx, SUB, bad)).rejects.toMatchObject({
        code: 'BAD_EXTERNAL_ID'
      })
    await expect(redisCloudAdapter.observe(ctx, DB, 'fixed:1001/..')).rejects.toMatchObject({
      code: 'BAD_EXTERNAL_ID'
    })
    expect(calls.filter((c) => c.path !== '/v1/')).toHaveLength(1)
  })

  it('lists subscriptions fixed first, then Pro', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /fixed\/subscriptions$/, body: fx('fixed-subscriptions') },
      { method: 'GET', path: /^\/v1\/subscriptions$/, body: fx('pro-subscriptions') }
    ])
    const a = await redisCloudAdapter.list(ctx, SUB)
    expect(a.items.map((i) => i.externalId)).toEqual(['fixed:1001'])
    expect(a.cursor).toBe('pro')
    const b = await redisCloudAdapter.list(ctx, SUB, a.cursor)
    expect(b.items.map((i) => i.externalId)).toEqual(['pro:2002'])
    expect(b.cursor).toBeNull()
  })

  it('lists databases one subscription per page, both shapes of the answer', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /fixed\/subscriptions$/, body: fx('fixed-subscriptions') },
      { method: 'GET', path: /^\/v1\/subscriptions$/, body: fx('pro-subscriptions') },
      {
        method: 'GET',
        path: /fixed\/subscriptions\/1001\/databases$/,
        body: fx('fixed-databases')
      },
      { method: 'GET', path: /^\/v1\/subscriptions\/2002\/databases$/, body: fx('pro-databases') }
    ])
    const a = await redisCloudAdapter.list(ctx, DB)
    expect(a.items.map((i) => i.externalId)).toEqual(['fixed:1001/3003'])
    expect(a.cursor).toBe('1')
    const b = await redisCloudAdapter.list(ctx, DB, a.cursor)
    expect(b.items.map((i) => i.externalId)).toEqual(['pro:2002/4004'])
    expect(b.cursor).toBeNull()
    expect(JSON.stringify([a, b])).not.toContain('test-secret-rc-pw')
  })
})

describe('redis-cloud adapter: plan', () => {
  const { ctx } = harness([])

  it('creates a subscription and a database, and names the REDIS_URL binding for the database', () => {
    const [s] = redisCloudAdapter.plan(
      ctx,
      desiredSub({ name: 'demo-sub', planId: 5001, paymentMethodId: 77 }),
      null
    )
    expect(s.kind).toBe('create')
    expect(s.reason).toContain('Redis Cloud subscription demo-sub')
    expect(s.changes.map((c) => c.field)).toEqual(['name', 'planId', 'paymentMethodId'])
    const [d] = redisCloudAdapter.plan(ctx, dbWant(), null)
    expect(d.kind).toBe('create')
    expect(d.reason).toContain('REDIS_URL')
    expect(d.reason).toContain('external')
  })

  it('Pro is adopt-only: a Pro create, change or delete is PRO_ADOPT_ONLY', () => {
    expect(() =>
      redisCloudAdapter.plan(ctx, desiredSub({ name: 'p', kind: 'pro' }), null)
    ).toThrowError(expect.objectContaining({ code: 'PRO_ADOPT_ONLY' }))
    const pro = observedSub({ kind: 'pro', planId: null, name: 'pro-sub' })
    expect(() =>
      redisCloudAdapter.plan(ctx, null, { ...pro, externalId: 'pro:2002' })
    ).toThrowError(expect.objectContaining({ code: 'PRO_ADOPT_ONLY' }))
    expect(() =>
      redisCloudAdapter.plan(ctx, desiredSub({ name: 'renamed', kind: 'pro' }), {
        ...pro,
        externalId: 'pro:2002'
      })
    ).toThrowError(expect.objectContaining({ code: 'PRO_ADOPT_ONLY' }))
    // Adopting one unchanged is a no-op.
    expect(
      redisCloudAdapter.plan(ctx, desiredSub({ name: 'pro-sub', kind: 'pro' }, 'pro:2002'), {
        ...pro,
        externalId: 'pro:2002'
      })
    ).toEqual([])
    expect(() =>
      redisCloudAdapter.plan(ctx, desiredDb({ name: 'x' }, 'pro:2002'), null)
    ).toThrowError(expect.objectContaining({ code: 'PRO_ADOPT_ONLY' }))
  })

  it('update lists changed fields with their labels; no change plans nothing', () => {
    const [s] = redisCloudAdapter.plan(
      ctx,
      desiredSub({ name: 'demo-sub', planId: 5002 }, 'fixed:1001'),
      observedSub()
    )
    expect(s).toMatchObject({ kind: 'update', preconditions: { planId: 5001 } })
    expect(s.reason).toContain('Essentials plan id')
    const [d] = redisCloudAdapter.plan(ctx, dbWant(), observedDb())
    expect(d).toMatchObject({ kind: 'update', externalId: 'fixed:1001/3003' })
    expect(d.changes).toEqual([
      { field: 'dataEvictionPolicy', from: 'noeviction', to: 'allkeys-lru' }
    ])
    expect(
      redisCloudAdapter.plan(
        ctx,
        desiredDb({ name: 'demo-db', dataEvictionPolicy: 'noeviction', replication: false }),
        observedDb()
      )
    ).toEqual([])
  })

  it('a database moved to another subscription is a replace; deletes are deletes', () => {
    const [r] = redisCloudAdapter.plan(
      ctx,
      desiredDb({ name: 'demo-db' }, 'fixed:1002'),
      observedDb()
    )
    expect(r.kind).toBe('replace')
    expect(r.reason).toContain('another subscription')
    expect(redisCloudAdapter.plan(ctx, null, observedDb())[0].reason).toContain('no way back')
    expect(redisCloudAdapter.plan(ctx, null, observedSub())[0].kind).toBe('delete')
  })
})

describe('redis-cloud adapter: risk flags and cost', () => {
  it('risk flags per type', () => {
    const r = (key: string, kind: PlannedOp['kind']) => spec(key).risk(op({ kind }), null)
    expect(r(SUB, 'create')).toEqual([])
    expect(r(SUB, 'update')).toEqual([])
    expect(r(SUB, 'delete')).toEqual(['destructive'])
    expect(r(DB, 'create')).toEqual([])
    expect(r(DB, 'update')).toEqual([])
    expect(r(DB, 'delete')).toEqual(['destructive', 'data_loss'])
    expect(r(DB, 'replace')).toEqual(['destructive', 'data_loss'])
    expect(spec(SUB).costClass?.(desiredSub({}))).toBe('monthly')
    expect(spec(DB).costClass).toBeUndefined()
  })
})

describe('redis-cloud adapter: apply (asynchronous tasks)', () => {
  const createRoutes = (): Route[] => [
    { method: 'GET', path: /fixed\/subscriptions\/1001$/, body: fx('fixed-subscription') },
    { method: 'GET', path: /fixed\/subscriptions\/1001\/databases$/, body: { subscription: {} } },
    {
      method: 'POST',
      path: /fixed\/subscriptions\/1001\/databases$/,
      status: 202,
      body: fx('task-accepted')
    },
    { method: 'GET', path: /\/tasks\/task-0001$/, body: fx('task-done-database') },
    {
      method: 'GET',
      path: /fixed\/subscriptions\/1001\/databases\/3003$/,
      body: fx('fixed-database')
    }
  ]

  it('a database create posts once, polls the task to done and answers the id and redis_url', async () => {
    const { ctx, calls } = harness(createRoutes())
    const res = await redisCloudAdapter.apply(
      ctx,
      op({ kind: 'create', externalId: null }),
      dbWant()
    )
    expect(res.ok).toBe(true)
    expect(res.externalId).toBe('fixed:1001/3003')
    expect(res.outputs).toEqual({
      redis_url: `redis://default:${PW}@redis-12000.c1.us-east-1-1.ec2.cloud.redislabs.com:12000`
    })
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.body).toMatchObject({
      name: 'demo-db',
      protocol: 'redis',
      dataEvictionPolicy: 'allkeys-lru',
      replication: false,
      enableDefaultUser: true
    })
    // The password is generated by the adapter and never answered anywhere else.
    expect(typeof post?.body.password).toBe('string')
    expect(JSON.stringify(res.observed)).not.toContain(PW)
    expect(JSON.stringify(res.answer)).not.toContain(PW)
    expect(JSON.stringify(res.answer)).not.toContain(post?.body.password)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('polls while the task is in progress, then finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const routes = createRoutes().filter((r) => !/tasks/.test(String(r.path)))
      routes.push({
        method: 'GET',
        path: /\/tasks\/task-0001$/,
        seq: [fx('task-accepted'), fx('task-in-progress'), fx('task-done-database')]
      })
      const { ctx, calls } = harness(routes)
      const running = redisCloudAdapter.apply(
        ctx,
        op({ kind: 'create', externalId: null }),
        dbWant()
      )
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(3000)
      const res = await running
      expect(res.externalId).toBe('fixed:1001/3003')
      expect(calls.filter((c) => /tasks/.test(c.path))).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a task still running when the wait ends is a retryable TASK_PENDING naming the task; resume polls it, never posts twice', async () => {
    let finished = false
    const routes = createRoutes().filter((r) => !/tasks/.test(String(r.path)))
    routes.push({
      method: 'GET',
      path: /\/tasks\/task-0001$/,
      body: () => (finished ? fx('task-done-database') : fx('task-in-progress'))
    })
    const { ctx, calls } = harness(routes)
    let tick = 0
    const base = new Date('2026-11-26T12:00:00Z').getTime()
    Object.assign(ctx, { now: () => new Date(base + tick) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const settled = redisCloudAdapter
        .apply(ctx, op({ kind: 'create', externalId: null }), dbWant())
        .catch((e) => e)
      for (let i = 0; i < 90; i++) {
        tick += 3000
        await vi.advanceTimersByTimeAsync(3000)
      }
      const err = await settled
      expect(err).toBeInstanceOf(ProviderError)
      expect(err).toMatchObject({ code: 'TASK_PENDING', retryable: true })
      expect(err.message).toContain('task-0001')
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
    // Resume on the same connection: the task has finished; no second POST, no collision.
    finished = true
    const res = await redisCloudAdapter.apply(
      ctx,
      op({ kind: 'create', externalId: null }),
      dbWant()
    )
    expect(res.externalId).toBe('fixed:1001/3003')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('a create that finds a database of that name it did not start is ALREADY_EXISTS, nothing written', async () => {
    const routes = createRoutes().filter(
      (r) => !(r.method === 'GET' && /databases\$\//.test(String(r.path)))
    )
    routes.unshift({
      method: 'GET',
      path: /fixed\/subscriptions\/1001\/databases$/,
      body: fx('fixed-databases')
    })
    const { ctx, calls } = harness(routes)
    await expect(
      redisCloudAdapter.apply(ctx, op({ kind: 'create', externalId: null }), dbWant())
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('a create whose id is already recorded reads it back and posts nothing', async () => {
    const { ctx, calls } = harness(createRoutes())
    const res = await redisCloudAdapter.apply(
      ctx,
      op({ kind: 'create', externalId: null }),
      desiredDb({ name: 'demo-db' }, 'fixed:1001', 'fixed:1001/3003')
    )
    expect(res.answer).toMatchObject({ already: 'exists' })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('a database in a subscription that is not active yet is a retryable SUBSCRIPTION_NOT_READY', async () => {
    const { ctx, calls } = harness([
      {
        method: 'GET',
        path: /fixed\/subscriptions\/1001$/,
        body: { ...fx('fixed-subscription'), status: 'pending' }
      }
    ])
    await expect(
      redisCloudAdapter.apply(ctx, op({ kind: 'create', externalId: null }), dbWant())
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_NOT_READY', retryable: true })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('a database cannot be created in a Pro subscription', async () => {
    const { ctx, calls } = harness([])
    await expect(
      redisCloudAdapter.apply(
        ctx,
        op({ kind: 'create', externalId: null }),
        desiredDb({ name: 'x' }, 'pro:2002')
      )
    ).rejects.toMatchObject({ code: 'PRO_ADOPT_ONLY' })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('a failed task is a non-retryable error with the provider text scrubbed of secrets', async () => {
    const routes = createRoutes().filter((r) => !/tasks/.test(String(r.path)))
    routes.push({ method: 'GET', path: /\/tasks\/task-0001$/, body: fx('task-error') })
    const { ctx } = harness(routes)
    const err: ProviderError = await redisCloudAdapter
      .apply(ctx, op({ kind: 'create', externalId: null }), dbWant())
      .catch((e) => e)
    expect(err).toMatchObject({ code: 'PROVIDER_REJECTED', retryable: false })
    expect(err.message).toContain('DATABASE_NAME_TAKEN')
    expect(err.message).not.toContain(ACCOUNT_KEY)
  })

  it('update reads first, sends only what differs, polls the task; same values write nothing', async () => {
    const { ctx, calls } = harness([
      {
        method: 'GET',
        path: /fixed\/subscriptions\/1001\/databases\/3003$/,
        body: fx('fixed-database')
      },
      {
        method: 'PUT',
        path: /fixed\/subscriptions\/1001\/databases\/3003$/,
        status: 202,
        body: { ...fx('task-accepted'), taskId: 'task-0003' }
      },
      {
        method: 'GET',
        path: /\/tasks\/task-0003$/,
        body: {
          taskId: 'task-0003',
          status: 'processing-completed',
          response: { resourceId: 3003 }
        }
      }
    ])
    const res = await redisCloudAdapter.apply(ctx, op({}), dbWant())
    expect(res.ok).toBe(true)
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ dataEvictionPolicy: 'allkeys-lru' })
    const same = harness([
      {
        method: 'GET',
        path: /fixed\/subscriptions\/1001\/databases\/3003$/,
        body: fx('fixed-database')
      }
    ])
    const again = await redisCloudAdapter.apply(
      same.ctx,
      op({}),
      desiredDb({ name: 'demo-db', dataEvictionPolicy: 'noeviction', replication: false })
    )
    expect(again.answer).toMatchObject({ already: 'matches' })
    expect(same.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('an update that names a different subscription than the target is TARGET_MISMATCH', async () => {
    const { ctx, calls } = harness([])
    await expect(
      redisCloudAdapter.apply(ctx, op({}), desiredDb({ name: 'demo-db' }, 'fixed:1002'))
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(calls.filter((c) => c.path !== '/v1/')).toEqual([])
  })

  it('delete polls the task; deleting what is gone is a success', async () => {
    const { ctx, calls } = harness([
      {
        method: 'DELETE',
        path: /fixed\/subscriptions\/1001\/databases\/3003$/,
        status: 202,
        body: { ...fx('task-accepted'), taskId: 'task-0004' }
      },
      {
        method: 'GET',
        path: /\/tasks\/task-0004$/,
        body: { taskId: 'task-0004', status: 'processing-completed' }
      }
    ])
    const res = await redisCloudAdapter.apply(ctx, op({ kind: 'delete' }), null)
    expect(res).toMatchObject({ ok: true, externalId: 'fixed:1001/3003', observed: null })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
    const gone = harness([
      {
        method: 'DELETE',
        path: /fixed\/subscriptions\/1001\/databases\/3003$/,
        status: 404,
        body: {}
      }
    ])
    expect((await redisCloudAdapter.apply(gone.ctx, op({ kind: 'delete' }), null)).ok).toBe(true)
  })

  it('a subscription is created as a task on a plan, refuses a taken name, and is not deleted while it holds databases', async () => {
    const make = harness([
      { method: 'GET', path: /fixed\/subscriptions$/, body: { subscriptions: [] } },
      { method: 'GET', path: /^\/v1\/subscriptions$/, body: { subscriptions: [] } },
      {
        method: 'POST',
        path: /fixed\/subscriptions$/,
        status: 202,
        body: { ...fx('task-accepted'), taskId: 'task-0002' }
      },
      { method: 'GET', path: /\/tasks\/task-0002$/, body: fx('task-done-subscription') },
      { method: 'GET', path: /fixed\/subscriptions\/1001$/, body: fx('fixed-subscription') }
    ])
    const res = await redisCloudAdapter.apply(
      make.ctx,
      op({ kind: 'create', type: SUB, externalId: null }),
      desiredSub({ name: 'demo-sub', planId: 5001, paymentMethodId: 77 })
    )
    expect(res.externalId).toBe('fixed:1001')
    expect(make.calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'demo-sub',
      planId: 5001,
      paymentMethodId: 77
    })
    const taken = harness([
      { method: 'GET', path: /fixed\/subscriptions$/, body: fx('fixed-subscriptions') },
      { method: 'GET', path: /^\/v1\/subscriptions$/, body: { subscriptions: [] } }
    ])
    await expect(
      redisCloudAdapter.apply(
        taken.ctx,
        op({ kind: 'create', type: SUB, externalId: null }),
        desiredSub({ name: 'demo-sub', planId: 5001 })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    const full = harness([
      { method: 'GET', path: /fixed\/subscriptions\/1001$/, body: fx('fixed-subscription') },
      { method: 'GET', path: /fixed\/subscriptions\/1001\/databases$/, body: fx('fixed-databases') }
    ])
    await expect(
      redisCloudAdapter.apply(
        full.ctx,
        op({ kind: 'delete', type: SUB, externalId: 'fixed:1001' }),
        null
      )
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_NOT_EMPTY' })
    expect(full.calls.filter((c) => c.method === 'DELETE')).toEqual([])
  })

  it('a Pro subscription cannot be changed or deleted by apply either', async () => {
    const { ctx } = harness([])
    await expect(
      redisCloudAdapter.apply(ctx, op({ kind: 'delete', type: SUB, externalId: 'pro:2002' }), null)
    ).rejects.toMatchObject({ code: 'PRO_ADOPT_ONLY' })
  })

  it('findExisting names a same-named subscription or database for the plan', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /fixed\/subscriptions$/, body: fx('fixed-subscriptions') },
      { method: 'GET', path: /^\/v1\/subscriptions$/, body: { subscriptions: [] } },
      { method: 'GET', path: /fixed\/subscriptions\/1001\/databases$/, body: fx('fixed-databases') }
    ])
    expect(
      (await redisCloudAdapter.findExisting?.(ctx, SUB, desiredSub({ name: 'demo-sub' })))
        ?.externalId
    ).toBe('fixed:1001')
    expect((await redisCloudAdapter.findExisting?.(ctx, DB, dbWant()))?.externalId).toBe(
      'fixed:1001/3003'
    )
    // A subscription made in the same change has no id yet.
    expect(
      await redisCloudAdapter.findExisting?.(ctx, DB, desiredDb({ name: 'demo-db' }, null))
    ).toBeNull()
  })
})

describe('redis-cloud adapter: waitTask', () => {
  it('answers the resource id of a completed task and refuses a bad task id', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /\/tasks\/task-0001$/, body: fx('task-done-database') }
    ])
    expect(await waitTask(ctx, 'task-0001')).toEqual({ taskId: 'task-0001', resourceId: 3003 })
    await expect(waitTask(ctx, '../x')).rejects.toMatchObject({ code: 'BAD_ID' })
  })
})

describe('redis-cloud adapter: errors', () => {
  it('maps 429 to a retryable error and says when to retry', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /fixed\/subscriptions$/,
        status: 429,
        body: fx('error-rate-limited'),
        headers: { 'retry-after': '9' }
      }
    ])
    const err: ProviderError = await redisCloudAdapter.list(ctx, SUB).catch((e) => e)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('retry after 9 s')
    expect(err.message).toContain('TOO_MANY_REQUESTS')
  })

  it('secrets never appear in errors', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /fixed\/subscriptions\/1001$/,
        status: 400,
        body: { error: { type: 'BAD', description: `bad key ${ACCOUNT_KEY} and ${USER_KEY}` } }
      }
    ])
    const err: ProviderError = await redisCloudAdapter
      .observe(ctx, SUB, 'fixed:1001')
      .catch((e) => e)
    expect(err.message).toContain('Redis Cloud answered 400')
    expect(err.message).not.toContain(ACCOUNT_KEY)
    expect(err.message).not.toContain(USER_KEY)
    const failing = makeProviderContext({
      adapter: redisCloudAdapter,
      connectionId: 3,
      config: { accountId: '4242' },
      secrets: { accountKey: ACCOUNT_KEY, userKey: USER_KEY },
      fetch: {
        fetchImpl: (async () => {
          throw new TypeError(`getaddrinfo failed for ${USER_KEY}`)
        }) as any,
        timeoutMs: 200
      }
    })
    const e2: Error = await redisCloudAdapter.list(failing, SUB).catch((e) => e)
    expect(e2.message).not.toContain(USER_KEY)
  })
})

describe('redis-cloud adapter: outputs', () => {
  it('declares redis_url on the database only; none leak into observed, desired or plans', async () => {
    expect(spec(DB).outputs).toEqual([
      { key: 'redis_url', label: 'Redis connection URL', secret: true }
    ])
    expect(spec(DB).outputs?.[0].onceOnly).toBeFalsy()
    expect(spec(SUB).outputs).toBeUndefined()
    const { ctx } = harness([
      {
        method: 'GET',
        path: /fixed\/subscriptions\/1001\/databases\/3003$/,
        body: fx('fixed-database')
      }
    ])
    const seen = await redisCloudAdapter.observe(ctx, DB, 'fixed:1001/3003')
    expect(Object.keys(seen?.fields ?? {})).not.toContain('redis_url')
    expect(Object.keys(seen?.fields ?? {})).not.toContain('password')
    expect(JSON.stringify(redisCloudAdapter.plan(ctx, dbWant(), null))).not.toContain('redis://')
    expect(spec(DB).fields.map((f) => f.key)).not.toContain('redis_url')
  })

  it('readOutputs re-reads the URL (TLS databases use rediss); a Pro database too', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /fixed\/subscriptions\/1001\/databases\/3003$/,
        body: {
          ...fx('fixed-database'),
          security: { password: PW, enableDefaultUser: true, enableTls: true }
        }
      },
      {
        method: 'GET',
        path: /^\/v1\/subscriptions\/2002\/databases\/4004$/,
        body: fx('pro-databases').subscription[0].databases[0]
      }
    ])
    const a = await redisCloudAdapter.readOutputs?.(ctx, DB, 'fixed:1001/3003')
    expect(a?.redis_url).toBe(
      `rediss://default:${PW}@redis-12000.c1.us-east-1-1.ec2.cloud.redislabs.com:12000`
    )
    const b = await redisCloudAdapter.readOutputs?.(ctx, DB, 'pro:2002/4004')
    expect(b?.redis_url).toContain('redis-14000')
    expect(await redisCloudAdapter.readOutputs?.(ctx, SUB, 'fixed:1001')).toEqual({})
  })

  it('a database without a readable password has no output', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /fixed\/subscriptions\/1001\/databases\/3003$/,
        body: { ...fx('fixed-database'), security: { enableDefaultUser: false } }
      }
    ])
    expect(await redisCloudAdapter.readOutputs?.(ctx, DB, 'fixed:1001/3003')).toEqual({})
  })
})

describe('redis-cloud adapter: health', () => {
  it('ok when active, warn while pending, down when gone', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /fixed\/subscriptions\/1001$/, body: fx('fixed-subscription') }
    ])
    expect((await redisCloudAdapter.health?.(ctx, SUB, 'fixed:1001'))?.status).toBe('ok')
    const pending = harness([
      {
        method: 'GET',
        path: /fixed\/subscriptions\/1001$/,
        body: { ...fx('fixed-subscription'), status: 'pending' }
      }
    ])
    expect((await redisCloudAdapter.health?.(pending.ctx, SUB, 'fixed:1001'))?.status).toBe('warn')
    const gone = harness([])
    expect((await redisCloudAdapter.health?.(gone.ctx, SUB, 'fixed:1001'))?.status).toBe('down')
  })
})

describe('redis-cloud adapter: estimates', () => {
  beforeEach(() => ensureCoreProviders())

  it('estimate from recorded price answer: an Essentials plan is its plan price, exact', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /fixed\/plans\/5001$/, body: fx('fixed-plan') }
    ])
    const e = await spec(SUB).estimate?.(ctx, null, observedSub())
    expect(e).toMatchObject({
      basis: 'plan_price',
      confidence: 'exact',
      monthlyCents: 500,
      priceAsOf: '2026-11-26'
    })
    expect(e?.lines).toEqual([
      expect.objectContaining({ kind: 'base', unit: 'month', unitCents: 500, qty: 1 })
    ])
    expect(e?.note).toContain('$5 a month')
    expect(calls.some((c) => c.path.endsWith('/fixed/plans/5001'))).toBe(true)
  })

  it('a plan price that costs nothing is free; a plan that cannot be priced, a Pro subscription and a delete of an unknown are "No estimate"; never throws', async () => {
    const free = harness([
      { method: 'GET', path: /fixed\/plans\/5001$/, body: { ...fx('fixed-plan'), price: 0 } }
    ])
    expect(await spec(SUB).estimate?.(free.ctx, null, observedSub())).toMatchObject({
      basis: 'free',
      monthlyCents: 0
    })
    const missing = harness([])
    expect((await spec(SUB).estimate?.(missing.ctx, null, observedSub()))?.confidence).toBe(
      'unknown'
    )
    const hourly = harness([
      {
        method: 'GET',
        path: /fixed\/plans\/5001$/,
        body: { ...fx('fixed-plan'), pricePeriod: 'Hour' }
      }
    ])
    expect((await spec(SUB).estimate?.(hourly.ctx, null, observedSub()))?.confidence).toBe(
      'unknown'
    )
    expect(
      (await spec(SUB).estimate?.(missing.ctx, null, observedSub({ kind: 'pro', planId: null })))
        ?.confidence
    ).toBe('unknown')
    expect(
      (await spec(SUB).estimate?.(missing.ctx, desiredSub({ name: 'n' }), null))?.confidence
    ).toBe('unknown')
  })

  it('the create form prices the plan being chosen', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /fixed\/plans\/5001$/, body: fx('fixed-plan') }
    ])
    const e = await spec(SUB).estimate?.(ctx, desiredSub({ name: 'n', planId: 5001 }), null)
    expect(e?.monthlyCents).toBe(500)
  })

  it('every costed type carries an estimate', () => {
    expect(
      redisCloudAdapter.types.every((t) => t.costClass == null || typeof t.estimate === 'function')
    ).toBe(true)
  })
})
