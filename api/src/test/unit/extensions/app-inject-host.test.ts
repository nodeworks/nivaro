import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A Hub shared deployment: an in-process call made inside an app — an extension's ctx.app.inject,
// core's callAsCaller through req.server.inject, any Fastify instance's .inject — reaches that
// app. The tenant hook resolves the app from Host; light-my-request sends localhost:80 when the
// caller names none, which reached no app or, where an app is served at localhost, ANOTHER app.

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))
vi.mock('../../../db/tenant-context.js', async (orig) => ({
  ...(await orig<object>()),
  getOrCreateTenantPool: () => ({})
}))

import { getTenantId, runWithTenantDb } from '../../../db/tenant-context.js'
import { tenantHook } from '../../../middleware/tenant.js'
import { appInject, installAppInject, withAppHost } from '../../../services/app-inject-host.js'
import { callAsCallerFor } from '../../../services/caller-inject.js'
import { setTenantRegistryForTests } from '../../../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../../../services/tenancy/types.js'

const rec = (id: string, host: string): TenantRecord => ({
  id,
  slug: id,
  name: id,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://${id}`,
  poolMax: null,
  hostnames: [host]
})
/** Two apps; the second is served at localhost (a dev harness, a misconfigured name). */
const APPS: Record<string, TenantRecord> = {
  'efp-a.example': rec('app-a', 'efp-a.example'),
  localhost: rec('app-b', 'localhost')
}
const registry: TenantRegistry = {
  source: 'hub',
  async resolve(host) {
    const t = APPS[host.split(':')[0] as string]
    return t ? { tenant: t, origin: `https://${t.hostnames[0]}` } : null
  },
  async listActive() {
    return Object.values(APPS)
  },
  async byId(id) {
    return Object.values(APPS).find((t) => t.id === id) ?? null
  },
  status: () => ({ source: 'hub', count: 2, loadedAt: 'now', stale: false, lastError: null })
}

const inApp = <T>(id: string, origin: string | undefined, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runWithTenantDb({} as never, id, () => void fn().then(resolve, reject), id, origin)
  )

const saved = { ...process.env }
function hub() {
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
}
beforeEach(() => {
  hub()
  setTenantRegistryForTests(registry)
})
afterEach(() => {
  process.env = { ...saved }
  setTenantRegistryForTests(null)
})

/** A shared-deployment API: tenant hook, the root wrapper, a "push" that calls back in-process
 *  as the caller (like an item action) and a child scope that injects with a callback. */
async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  installAppInject(app)
  app.addHook('onRequest', tenantHook)
  app.get('/api/who', async () => ({ app: getTenantId() ?? null }))
  app.post('/api/push', async (req) => {
    const res = await callAsCallerFor(req)({ method: 'GET', url: '/api/who' })
    return { inner: res.statusCode === 200 ? (res.json() as { app: string }).app : res.statusCode }
  })
  await app.register(async (child) => {
    child.post('/api/push-callback', (req, reply) => {
      req.server.inject({ method: 'GET', url: '/api/who' }, (err, res) => {
        if (err || !res) return reply.code(500).send({ inner: 'error' })
        reply.send({ inner: (res.json() as { app: string }).app })
      })
    })
  })
  return app
}

describe('in-process calls on a Hub shared deployment', () => {
  it("callAsCaller (req.server.inject) inside app A reaches app A, never localhost's app B", async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/push',
      headers: { host: 'efp-a.example', authorization: 'Bearer shared-static-token' }
    })
    expect(res.json()).toEqual({ inner: 'app-a' })
    await app.close()
  })

  it('a callback-form inject from a child scope reaches its own app too', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/push-callback',
      headers: { host: 'efp-a.example' }
    })
    expect(res.json()).toEqual({ inner: 'app-a' })
    await app.close()
  })

  it('app B (served at localhost) still reaches itself', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/push',
      headers: { host: 'localhost' }
    })
    expect(res.json()).toEqual({ inner: 'app-b' })
    await app.close()
  })

  it('without the wrapper the same call lands in app B — the cross-app write this prevents', async () => {
    const app = Fastify()
    app.addHook('onRequest', tenantHook)
    app.get('/api/who', async () => ({ app: getTenantId() ?? null }))
    app.post('/api/push', async (req) => {
      const res = await callAsCallerFor(req)({ method: 'GET', url: '/api/who' })
      return { inner: (res.json() as { app: string }).app }
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/push',
      headers: { host: 'efp-a.example' }
    })
    expect(res.json()).toEqual({ inner: 'app-b' })
    await app.close()
  })
})

describe('withAppHost', () => {
  it('adds the current app host when the call names none', async () => {
    const out = (await inApp('app-a', 'https://efp-a.example', () =>
      withAppHost({ method: 'GET', url: '/api/x', headers: { authorization: 'Bearer t' } })
    )) as { headers: Record<string, string> }
    expect(out.headers).toEqual({ authorization: 'Bearer t', host: 'efp-a.example' })
  })

  it('never overrides a Host, an authority or an absolute URL the caller set', async () => {
    const cases = [
      { url: '/api/x', headers: { Host: 'other.example' } },
      { url: '/api/x', authority: 'other.example' },
      { url: 'http://other.example/api/x' },
      { url: '//other.example/api/x' },
      { url: { pathname: '/api/x', hostname: 'other.example' } }
    ]
    for (const c of cases)
      expect(await inApp('app-a', 'https://efp-a.example', () => withAppHost(c))).toBe(c)
  })

  it('falls back to the listed hostname when the context carries no origin', async () => {
    const out = (await inApp('app-b', undefined, () => withAppHost('/api/x'))) as {
      headers: Record<string, string>
    }
    expect(out).toEqual({ url: '/api/x', headers: { host: 'localhost' } })
  })

  it('leaves a call outside any app alone, synchronously', () => {
    const seen: unknown[][] = []
    const inject = appInject((...a: unknown[]) => {
      seen.push(a)
      return 'chain'
    })
    expect(inject({ url: '/api/x' } as never)).toBe('chain')
    expect(seen).toEqual([[{ url: '/api/x' }]])
  })
})

describe('self-hosted and Nivaro Cloud: nothing installed', () => {
  it('self-hosted: inject is the very same function', () => {
    process.env = { ...saved }
    delete process.env.HUB_SHARED_DEPLOYMENT
    delete process.env.CLOUD_META_DB_URL
    const app = Fastify()
    const before = app.inject
    installAppInject(app)
    expect(app.inject).toBe(before)
  })

  it('Nivaro Cloud: inject is the very same function (Cloud forwards its own tenant host)', () => {
    process.env = { ...saved }
    delete process.env.HUB_SHARED_DEPLOYMENT
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    const app = Fastify()
    const before = app.inject
    installAppInject(app)
    expect(app.inject).toBe(before)
  })
})
