import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #2759 — a slow read handed to the server is the SAME request replayed as its caller: the
// route decides access, the run belongs to its starter, progress goes to their Jobs tray.
const who = (h: Record<string, unknown>) =>
  typeof h.authorization === 'string' ? h.authorization.replace(/^Bearer /, '') : null
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: any, reply: any) => {
    const id = who(req.headers)
    if (!id) return reply.code(401).send({ error: 'Unauthorized' })
    req.user = { id }
  })
}))
const tray = vi.hoisted(() => ({ events: [] as Array<{ user: string; ev: any }> }))
vi.mock('../../../services/live-progress.js', () => ({
  emitJobProgress: vi.fn((user: string, ev: unknown) => tray.events.push({ user, ev }))
}))
const pool = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../../db/pool-context.js', async (orig) => {
  const real = (await orig()) as { runInBackgroundPool: (fn: () => unknown) => unknown }
  return {
    ...real,
    runInBackgroundPool: (fn: () => unknown) => {
      pool.calls++
      return real.runInBackgroundPool(fn)
    }
  }
})

import { inBackgroundPool } from '../../../db/pool-context.js'
import { backgroundRunsRoutes } from '../../../routes/background-runs.js'
import {
  __resetBackgroundRuns,
  claimRunSlot,
  estimateRead,
  matchReplayable,
  noteReadDuration,
  recordReadDuration,
  releaseRunSlot
} from '../../../services/background-runs.js'
import { markCacheHit } from '../../../services/traffic-map.js'

const route = vi.hoisted(() => ({
  gate: null as null | Promise<void>,
  release: () => {},
  seen: [] as Array<{ user: string | null; body: unknown; background: boolean; run: unknown }>,
  status: 200,
  hit: false
}))

async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(
    async (api) => {
      api.addHook('onResponse', noteReadDuration(api))
      // Stand-in for POST /custom-queries/:slug/execute: only 'alice' may run 'secret'.
      api.post('/custom-queries/:slug/execute', async (req, reply) => {
        const user = who(req.headers)
        route.seen.push({
          user,
          body: req.body,
          background: inBackgroundPool(),
          run: req.headers['x-nivaro-background-run']
        })
        if (route.gate) await route.gate
        if ((req.params as { slug: string }).slug === 'secret' && user !== 'alice')
          return reply.code(403).send({ error: 'Forbidden' })
        if (route.status !== 200) return reply.code(route.status).send({ error: 'proc failed' })
        if (route.hit) markCacheHit(req)
        return { data: [{ total: 7, for: user }], cached: false }
      })
      api.get('/dashboards/widgets/:widgetId/data', async () => ({ data: { value: 1 } }))
      await api.register(backgroundRunsRoutes, { prefix: '/background-runs' })
    },
    { prefix: '/api' }
  )
  await app.ready()
  return app
}

function hold() {
  route.gate = new Promise<void>((r) => {
    route.release = () => {
      route.gate = null
      r()
    }
  })
}

async function settle(app: FastifyInstance, id: string, user = 'alice') {
  for (let i = 0; i < 50; i++) {
    const r = await app.inject({
      method: 'GET',
      url: `/api/background-runs/${id}`,
      headers: { authorization: `Bearer ${user}` }
    })
    const run = r.json().data
    if (run.status !== 'running') return run
    await new Promise((res) => setTimeout(res, 5))
  }
  throw new Error('run never finished')
}

let app: FastifyInstance
beforeEach(async () => {
  __resetBackgroundRuns()
  tray.events = []
  route.seen = []
  route.status = 200
  route.hit = false
  route.gate = null
  pool.calls = 0
  app = await build()
})
afterEach(async () => {
  route.release()
  await app.close()
})

const start = (user: string, body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/background-runs',
    headers: { authorization: `Bearer ${user}` },
    payload: body
  })

describe('matchReplayable', () => {
  it('accepts only the listed reads, with or without the /api prefix', () => {
    expect(matchReplayable('POST', '/custom-queries/pub-health/execute')).toMatchObject({
      kind: 'custom-query',
      subject: 'pub-health',
      url: '/api/custom-queries/pub-health/execute'
    })
    expect(matchReplayable('post', '/api/widgets-internal/12/render')?.kind).toBe('widget')
    expect(matchReplayable('POST', '/api/report-studio/r-1/widgets/w-2/data')?.subject).toBe('w-2')
    expect(
      matchReplayable('GET', '/api/dashboards/widgets/abc/data?extra_filters=%5B%5D')?.url
    ).toBe('/api/dashboards/widgets/abc/data?extra_filters=%5B%5D')
  })

  it('refuses writes, other routes, other origins and traversal', () => {
    expect(matchReplayable('GET', '/api/custom-queries/x/execute')).toBeNull()
    expect(matchReplayable('POST', '/api/items/projects')).toBeNull()
    expect(matchReplayable('DELETE', '/api/dashboards/widgets/abc/data')).toBeNull()
    expect(matchReplayable('POST', 'https://evil.example/api/custom-queries/x/execute')).toBeNull()
    expect(matchReplayable('POST', '//evil.example/custom-queries/x/execute')).toBeNull()
    expect(matchReplayable('POST', '/api/custom-queries/../users/execute')).toBeNull()
    expect(matchReplayable('POST', '/api/widgets-internal/12/action')).toBeNull()
  })
})

describe('estimate', () => {
  it('learns from uncached successful reads only', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/custom-queries/q1/execute',
      headers: { authorization: 'Bearer alice' },
      payload: {}
    })
    expect((await estimateRead('custom-query', 'q1')).runs).toBe(1)
    route.hit = true
    await app.inject({
      method: 'POST',
      url: '/api/custom-queries/q1/execute',
      headers: { authorization: 'Bearer alice' },
      payload: {}
    })
    expect((await estimateRead('custom-query', 'q1')).runs).toBe(1)
    route.hit = false
    route.status = 400
    await app.inject({
      method: 'POST',
      url: '/api/custom-queries/q1/execute',
      headers: { authorization: 'Bearer alice' },
      payload: {}
    })
    expect((await estimateRead('custom-query', 'q1')).runs).toBe(1)
  })

  it('calls a read slow once its typical run passes the threshold', async () => {
    recordReadDuration('custom-query', 'big', 9000)
    recordReadDuration('custom-query', 'big', 7000)
    const r = await app.inject({
      method: 'GET',
      url: '/api/background-runs/estimate?method=POST&url=/custom-queries/big/execute',
      headers: { authorization: 'Bearer bob' }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ typical_ms: 8400, runs: 2, slow: true })
    const fast = await app.inject({
      method: 'GET',
      url: '/api/background-runs/estimate?method=POST&url=/custom-queries/new/execute',
      headers: { authorization: 'Bearer bob' }
    })
    expect(fast.json().data).toMatchObject({ typical_ms: null, slow: false })
  })

  it('needs a signed-in caller and a replayable read', async () => {
    const anon = await app.inject({
      method: 'GET',
      url: '/api/background-runs/estimate?url=/custom-queries/big/execute'
    })
    expect(anon.statusCode).toBe(401)
    const bad = await app.inject({
      method: 'GET',
      url: '/api/background-runs/estimate?method=POST&url=/items/projects',
      headers: { authorization: 'Bearer bob' }
    })
    expect(bad.statusCode).toBe(400)
  })
})

describe('runs', () => {
  it('replays the read as its caller on the background pool and keeps the result', async () => {
    hold()
    const r = await start('alice', {
      method: 'POST',
      url: '/custom-queries/pub-health/execute',
      body: { params: { year: 2026 } },
      label: 'PUB health',
      href: '/dashboards/7'
    })
    expect(r.statusCode).toBe(202)
    const run = r.json().data
    expect(run).toMatchObject({ status: 'running', label: 'PUB health', href: '/dashboards/7' })
    expect(run.user).toBeUndefined()
    expect(run.fingerprint).toBeUndefined()
    const early = await app.inject({
      method: 'GET',
      url: `/api/background-runs/${run.id}/result`,
      headers: { authorization: 'Bearer alice' }
    })
    expect(early.statusCode).toBe(409)
    await new Promise((res) => setTimeout(res, 10))
    route.release()
    const done = await settle(app, run.id)
    expect(done.status).toBe('completed')
    expect(route.seen[0]).toMatchObject({
      user: 'alice',
      body: { params: { year: 2026 } },
      background: true,
      run: run.id
    })
    expect(pool.calls).toBe(1)
    const res = await app.inject({
      method: 'GET',
      url: `/api/background-runs/${run.id}/result`,
      headers: { authorization: 'Bearer alice' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [{ total: 7, for: 'alice' }], cached: false })
    // The tray heard running, then completed — only on alice's own sockets.
    expect(tray.events.map((e) => [e.user, e.ev.key, e.ev.status])).toEqual([
      ['alice', `bgrun:${run.id}`, 'running'],
      ['alice', `bgrun:${run.id}`, 'completed']
    ])
    expect(tray.events[1].ev.href).toBe('/dashboards/7')
  })

  it('another person never sees the run or its result', async () => {
    const r = await start('alice', { method: 'POST', url: '/custom-queries/q/execute', body: {} })
    const id = r.json().data.id
    await settle(app, id)
    for (const url of [`/api/background-runs/${id}`, `/api/background-runs/${id}/result`]) {
      const other = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer mallory' }
      })
      expect(other.statusCode).toBe(404)
    }
    const list = await app.inject({
      method: 'GET',
      url: '/api/background-runs',
      headers: { authorization: 'Bearer mallory' }
    })
    expect(list.json().data).toEqual([])
  })

  it('access is the route’s: a caller who may not run the read gets its refusal', async () => {
    const r = await start('bob', {
      method: 'POST',
      url: '/custom-queries/secret/execute',
      body: {}
    })
    const done = await settle(app, r.json().data.id, 'bob')
    expect(done).toMatchObject({ status: 'error', http_status: 403, error: 'Forbidden' })
    const res = await app.inject({
      method: 'GET',
      url: `/api/background-runs/${done.id}/result`,
      headers: { authorization: 'Bearer bob' }
    })
    expect(res.statusCode).toBe(422)
  })

  it('the same question twice joins the first run; at most three run at once', async () => {
    hold()
    const a = await start('alice', {
      method: 'POST',
      url: '/custom-queries/q/execute',
      body: { x: 1 }
    })
    const b = await start('alice', {
      method: 'POST',
      url: '/custom-queries/q/execute',
      body: { x: 1 }
    })
    expect(b.statusCode).toBe(200)
    expect(b.json().data).toMatchObject({ id: a.json().data.id, joined: true })
    await start('alice', { method: 'POST', url: '/custom-queries/q/execute', body: { x: 2 } })
    await start('alice', { method: 'POST', url: '/custom-queries/q/execute', body: { x: 3 } })
    const fourth = await start('alice', {
      method: 'POST',
      url: '/custom-queries/q/execute',
      body: { x: 4 }
    })
    expect(fourth.statusCode).toBe(429)
    // Someone else is not held by alice's runs.
    const bob = await start('bob', {
      method: 'POST',
      url: '/custom-queries/q/execute',
      body: { x: 4 }
    })
    expect(bob.statusCode).toBe(202)
  })

  it('parallel starts cannot pass the cap together; an ended run frees its slot', async () => {
    hold()
    const all = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        start('alice', { method: 'POST', url: '/custom-queries/q/execute', body: { p: i } })
      )
    )
    const codes = all.map((r) => r.statusCode)
    expect(codes.filter((c) => c === 202)).toHaveLength(3)
    expect(codes.filter((c) => c === 429)).toHaveLength(5)
    route.release()
    for (const r of all.filter((x) => x.statusCode === 202)) await settle(app, r.json().data.id)
    await new Promise((res) => setTimeout(res, 5))
    const again = await start('alice', {
      method: 'POST',
      url: '/custom-queries/q/execute',
      body: { p: 'after' }
    })
    expect(again.statusCode).toBe(202)
  })

  it('refuses reads that are not replayable and links that leave the app', async () => {
    const bad = await start('alice', { method: 'POST', url: '/items/projects', body: {} })
    expect(bad.statusCode).toBe(400)
    const r = await start('alice', {
      method: 'GET',
      url: '/dashboards/widgets/w1/data',
      href: 'https://evil.example/phish'
    })
    expect(r.statusCode).toBe(202)
    expect(r.json().data.href).toBeNull()
    const anon = await app.inject({
      method: 'POST',
      url: '/api/background-runs',
      payload: { method: 'POST', url: '/custom-queries/q/execute' }
    })
    expect(anon.statusCode).toBe(401)
  })
})

describe('run slots (atomic cap)', () => {
  // A Redis stand-in whose SET NX is atomic, as Redis is.
  function fakeRedis() {
    const store = new Map<string, string>()
    return {
      store,
      set: vi.fn(async (k: string, v: string, _ex: string, _ttl: number, _nx: string) => {
        if (store.has(k)) return null
        store.set(k, v)
        return 'OK'
      }),
      eval: vi.fn(async (_script: string, _n: number, k: string, v: string) => {
        if (store.get(k) !== v) return 0
        store.delete(k)
        return 1
      })
    }
  }

  it('hands out three slots per person across replicas, then none', async () => {
    const redis = fakeRedis() as never
    const got = await Promise.all(
      ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => claimRunSlot(redis, 'alice', id))
    )
    expect(got.filter((n) => n != null).sort()).toEqual([0, 1, 2])
    expect(got.filter((n) => n == null)).toHaveLength(2)
    expect(await claimRunSlot(redis, 'bob', 'b1')).toBe(0)
  })

  it('a release frees only the slot the run still holds', async () => {
    const r = fakeRedis()
    const redis = r as never
    const slot = (await claimRunSlot(redis, 'alice', 'r1')) as number
    await releaseRunSlot(redis, 'alice', slot, 'someone-else')
    expect(r.store.size).toBe(1)
    await releaseRunSlot(redis, 'alice', slot, 'r1')
    expect(r.store.size).toBe(0)
  })

  it('without Redis (or with it down) the process’s own slots still cap', async () => {
    const down = {
      set: vi.fn(async () => {
        throw new Error('down')
      }),
      eval: vi.fn(async () => {
        throw new Error('down')
      })
    } as never
    const got = await Promise.all(['a', 'b', 'c', 'd'].map((id) => claimRunSlot(down, 'carol', id)))
    expect(got.filter((n) => n == null)).toHaveLength(1)
    const got2 = await Promise.all(['e', 'f', 'g', 'h'].map((id) => claimRunSlot(null, 'dan', id)))
    expect(got2.filter((n) => n == null)).toHaveLength(1)
  })
})
