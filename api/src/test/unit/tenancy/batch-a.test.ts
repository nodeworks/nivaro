import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAuth: vi.fn(async () => {}),
  requireAdmin: vi.fn(async () => {}),
  cidrMatch: vi.fn(() => true),
  checkApiKeyScope: vi.fn(() => true)
}))

// The three deployments every pick runs under (Hub phase 5, batch A).
const SELF_HOSTED: Record<string, string> = {}
const CLOUD: Record<string, string> = { CLOUD_META_DB_URL: 'postgres://meta/x' }
const SHARED: Record<string, string> = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
}
const KEYS = [
  'CLOUD_META_DB_URL',
  'HUB_SHARED_DEPLOYMENT',
  'HUB_URL',
  'HUB_DEPLOYMENT_TOKEN',
  'SSRF_ALLOW_HOSTS'
]

function setEnv(env: Record<string, string>) {
  for (const k of KEYS) vi.stubEnv(k, '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  // an empty string reads as unset for every flag above
}

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.doUnmock('../../../config.js')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('/api/health reports cloud and multi_tenant', () => {
  async function health(env: Record<string, string>) {
    setEnv(env)
    vi.doMock('../../../config.js', () => ({
      config: { NODE_ENV: 'test', DB_DATABASE: 'd', DB_HOST: 'h', REDIS_URL: 'redis://localhost' }
    }))
    const { db } = await import('../../../db/index.js')
    ;(db as unknown as { raw: unknown }).raw = vi.fn().mockResolvedValue([])
    const { healthRoutes } = await import('../../../routes/health.js')
    const app = Fastify({ logger: false })
    // @ts-expect-error partial redis
    app.decorate('redis', { ping: async () => 'PONG' })
    app.register(healthRoutes)
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/health' })
    await app.close()
    return JSON.parse(res.body) as Record<string, unknown>
  }

  it.each([
    ['self-hosted', SELF_HOSTED, false, false],
    ['cloud', CLOUD, true, true],
    ['shared', SHARED, false, true]
  ])('%s', async (_n, env, cloud, multi) => {
    const body = await health(env)
    expect(body.cloud).toBe(cloud)
    expect(body.multi_tenant).toBe(multi)
  })
})

describe('config relaxes DB_* when tenants bring their connections', () => {
  async function loadConfig(env: Record<string, string>) {
    setEnv(env)
    for (const k of ['DB_HOST', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD', 'DB_URL'])
      vi.stubEnv(k, '')
    vi.stubEnv('DB_CLIENT', 'mssql')
    vi.stubEnv('SESSION_SECRET', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8')
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit')
    }) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await import('../../../config.js')
      return exit.mock.calls.length === 0
    } catch {
      return false
    }
  }

  it('self-hosted still requires them', async () => {
    expect(await loadConfig(SELF_HOSTED)).toBe(false)
  })
  it('cloud does not', async () => {
    expect(await loadConfig(CLOUD)).toBe(true)
  })
  it('shared does not', async () => {
    expect(await loadConfig(SHARED)).toBe(true)
  })
})

describe('SSRF_ALLOW_HOSTS', () => {
  async function refused(env: Record<string, string>) {
    setEnv({ ...env, SSRF_ALLOW_HOSTS: '10.0.0.0/8' })
    const { assertSafeUrl } = await import('../../../lib/ssrf.js')
    return assertSafeUrl('http://10.1.2.3/').then(
      () => false,
      () => true
    )
  }
  it('honoured self-hosted', async () => expect(await refused(SELF_HOSTED)).toBe(false))
  it('ignored in cloud', async () => expect(await refused(CLOUD)).toBe(true))
  it('honoured on shared (untrusted-customer strictness is Nivaro Cloud only)', async () =>
    expect(await refused(SHARED)).toBe(false))
})

describe('fetchGuardedInCloud (P5-5: guarded in every multi-tenant process)', () => {
  async function outcome(env: Record<string, string>) {
    setEnv(env)
    const plain = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', plain)
    const { fetchGuardedInCloud } = await import('../../../lib/ssrf.js')
    const refused = await fetchGuardedInCloud('http://10.1.2.3/').then(
      () => false,
      () => true
    )
    vi.unstubAllGlobals()
    return { refused, plainFetchUsed: plain.mock.calls.length > 0 }
  }
  it('self-hosted: plain fetch', async () =>
    expect(await outcome(SELF_HOSTED)).toEqual({ refused: false, plainFetchUsed: true }))
  it('cloud: safeFetch refuses a private address', async () =>
    expect(await outcome(CLOUD)).toEqual({ refused: true, plainFetchUsed: false }))
  it('shared: safeFetch refuses a private address', async () =>
    expect(await outcome(SHARED)).toEqual({ refused: true, plainFetchUsed: false }))
})

describe('realtime-server refuses in a multi-tenant process', () => {
  async function build(env: Record<string, string>) {
    setEnv(env)
    const { buildRealtimeServer } = await import('../../../realtime-server.js')
    return buildRealtimeServer().then(
      async (app) => {
        await app.close()
        return 'built'
      },
      (e: Error) => e.message
    )
  }
  it('refuses in cloud', async () => expect(await build(CLOUD)).toMatch(/self-hosted only/))
  it('refuses on shared', async () => expect(await build(SHARED)).toMatch(/self-hosted only/))
})

describe('server.ts: tenant hook vs operator routes (split block)', () => {
  const src = readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), '../../../server.ts'),
    'utf8'
  )
  const hook = src.indexOf("app.addHook('onRequest', tenantHook)")
  const provision = src.indexOf('await app.register(adminProvisionRoutes)')
  const guardOf = () => /if \((isMultiTenant|isNivaroCloud)\(\)\) \{/g
  const lastGuard = (at: number) => {
    const found = [...src.slice(0, at).matchAll(guardOf())]
    return found[found.length - 1]?.[1]
  }

  it('the tenant hook sits under isMultiTenant, the provision and traffic-tenant routes under isNivaroCloud', () => {
    expect(hook).toBeGreaterThan(0)
    expect(lastGuard(hook)).toBe('isMultiTenant')
    expect(lastGuard(provision)).toBe('isNivaroCloud')
    expect(lastGuard(src.indexOf('await app.register(adminTrafficTenantRoutes)'))).toBe(
      'isNivaroCloud'
    )
  })

  it('evaluated per deployment: shared registers the hook and not the operator routes', async () => {
    const { isMultiTenant, isNivaroCloud } = await import('../../../services/deployment-mode.js')
    const reg = (env: Record<string, string>) => ({
      hook: isMultiTenant(env),
      provision: isNivaroCloud(env)
    })
    expect(reg(SELF_HOSTED)).toEqual({ hook: false, provision: false })
    expect(reg(CLOUD)).toEqual({ hook: true, provision: true })
    expect(reg(SHARED)).toEqual({ hook: true, provision: false })
  })
})
