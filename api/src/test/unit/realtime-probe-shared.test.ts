import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The "live paths reach a realtime process" probe on a Hub shared deployment. A shared stack sets
 * no PUBLIC_URL, so the probe used to ask http://localhost:<PORT> — the web process itself, whose
 * tenant hook refuses the host `localhost` — and the realtime check failed for every app (preflight
 * 503, moves and upgrades blocked). It now asks the app's own origin. Two apps that are copies of
 * each other (same ids) each probe their own address.
 */

vi.hoisted(() => {
  for (const [k, v] of Object.entries({
    DB_HOST: 'localhost',
    DB_DATABASE: 'nivaro_test',
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    SESSION_SECRET: 'realtime-probe-shared-test-secret-0123456789',
    LOG_LEVEL: 'silent'
  }))
    process.env[k] ||= v
})

const checks = vi.hoisted(
  () => new Map<string, { run: () => Promise<{ status: string; detail: string }> }>()
)
vi.mock('../../services/readiness.js', () => ({
  registerReadinessCheck: (c: { id: string; run: () => Promise<never> }) => checks.set(c.id, c)
}))
// Two realtime processes of this deployment slot beat just now.
vi.mock('../../services/instance-roster.js', async (orig) => {
  const { instanceKey } = await import('../../services/instance-key.js')
  return {
    ...(await orig<object>()),
    listInstances: async () =>
      [1, 2].map((n) => ({
        role: 'realtime',
        instance: instanceKey(),
        beat_at: new Date().toISOString(),
        host: `rt-${n}`
      }))
  }
})
vi.mock('../../services/io-holder.js', async (orig) => ({
  ...(await orig<object>()),
  getApp: () => ({ redis: {} })
}))
vi.mock('../../db/tenant-context.js', async (orig) => ({
  ...(await orig<typeof import('../../db/tenant-context.js')>()),
  getOrCreateTenantPool: (conn: string) => ({ __conn: conn }) as never
}))

/** The proxy: the apps' public addresses route /api/events/stream to a realtime process; anything
 *  else (the web process itself at localhost) answers without the realtime stamp. */
const asked: string[] = []
const proxy = vi.fn(async (url: string | URL) => {
  const u = String(url)
  asked.push(u)
  const routed = /^https:\/\/(a|b)\.example\.com\//.test(u)
  return new Response(null, {
    status: 401,
    headers: routed ? { 'x-nivaro-role': 'realtime' } : {}
  })
})

const app = (id: string) => ({
  id,
  slug: id,
  dbClient: 'pg',
  dbConnection: `postgres://db-${id}`,
  poolMax: null
})

const saved = { ...process.env }
beforeEach(() => {
  asked.length = 0
  delete process.env.CLOUD_META_DB_URL
  delete process.env.PUBLIC_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-probe'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
  process.env.SOCKETS = 'off'
  process.env.NIVARO_ROLE = 'web'
  vi.stubGlobal('fetch', proxy)
})
afterEach(() => {
  vi.unstubAllGlobals()
  process.env = { ...saved }
})
afterAll(() => {
  process.env = { ...saved }
})

async function realtimeCheck() {
  const { registerDeployReadinessChecks } = await import('../../services/deploy-readiness.js')
  if (!checks.has('realtime-tier')) registerDeployReadinessChecks()
  const c = checks.get('realtime-tier')
  if (!c) throw new Error('realtime-tier check not registered')
  return c
}

describe('realtime routing probe on a Hub shared deployment', () => {
  it("probes each app's own origin, never the web process at localhost (copies, same ids)", async () => {
    const { withTenant } = await import('../../db/tenant-context.js')
    const c = await realtimeCheck()
    const a = await withTenant(app('app-a'), () => c.run(), 'https://a.example.com')
    const b = await withTenant(app('app-b'), () => c.run(), 'https://b.example.com')
    expect(asked).toEqual([
      'https://a.example.com/api/events/stream',
      'https://b.example.com/api/events/stream'
    ])
    expect(a.status).toBe('pass')
    expect(b.status).toBe('pass')
  })

  it("GET /api/preflight's realtime check probes the app's own origin too", async () => {
    const { withTenant } = await import('../../db/tenant-context.js')
    const { checkRealtime } = await import('../../routes/preflight.js')
    const fakeApp = { redis: {} } as never
    const a = await withTenant(app('app-a'), () => checkRealtime(fakeApp), 'https://a.example.com')
    const b = await withTenant(app('app-b'), () => checkRealtime(fakeApp), 'https://b.example.com')
    expect(asked).toEqual([
      'https://a.example.com/api/events/stream',
      'https://b.example.com/api/events/stream'
    ])
    expect(a.status).toBe('ok')
    expect(b.status).toBe('ok')
  })

  it('an app whose address the proxy does not route still fails', async () => {
    const { withTenant } = await import('../../db/tenant-context.js')
    const c = await realtimeCheck()
    const r = await withTenant(app('app-z'), () => c.run(), 'https://z.example.com')
    expect(asked).toEqual(['https://z.example.com/api/events/stream'])
    expect(r.status).toBe('fail')
    expect(r.detail).toMatch(/does not send \/api\/events\/stream/)
  })

  it('outside an app nothing is probed (cannot tell), and PUBLIC_URL is never asked', async () => {
    process.env.PUBLIC_URL = 'http://localhost:3055'
    const c = await realtimeCheck()
    const r = await c.run()
    expect(asked).toEqual([])
    expect(r.status).toBe('pass')
  })

  it('self-hosted: the probe asks PUBLIC_URL, as before', async () => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    const { realtimeProbeBase } = await import('../../services/process-role.js')
    expect(realtimeProbeBase('https://nivaro.example', 'https://ignored.example')).toBe(
      'https://nivaro.example'
    )
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-probe'
    expect(realtimeProbeBase('http://localhost:3055', 'https://a.example.com')).toBe(
      'https://a.example.com'
    )
    expect(realtimeProbeBase('http://localhost:3055', null)).toBeUndefined()
    // Nivaro Cloud: PUBLIC_URL (it serves its own sockets and never probes).
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    expect(realtimeProbeBase('https://cloud.example', 'https://t.example')).toBe(
      'https://cloud.example'
    )
  })
})
