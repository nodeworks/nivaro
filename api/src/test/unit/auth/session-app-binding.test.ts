import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Ruling P5-16 (security): on a Hub shared deployment one process, one Redis and one
// SESSION_SECRET serve many apps, and the apps are copies of each other (dev, staging and
// production share user ids). A session signed in on app A, replayed with app B's host (or a
// forged X-Forwarded-Host), used to sign in on B as the same user id. Now a session carries its
// app and is never read, written, listed or revoked by another app; X-Forwarded-Host counts on
// a shared deployment only from a trusted proxy (TRUST_PROXY). Cloud and self-hosted unchanged.

vi.mock('../../../db/index.js', () => ({
  db: () => ({
    where: () => ({ first: async () => ({ id: 'u1', status: 'active', role: null }) })
  })
}))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))
vi.mock('../../../services/session-policy.js', () => ({
  getSessionPolicy: async () => null,
  limitsFor: () => ({}),
  judgeSession: () => ({ ok: true })
}))
vi.mock('../../../db/tenant-context.js', async (orig) => ({
  ...(await orig<object>()),
  getOrCreateTenantPool: () => ({})
}))
const trust = vi.hoisted(() => ({ value: false as boolean | number | string[] }))
vi.mock('../../../lib/trust-proxy.js', async (orig) => {
  const real = await orig<typeof import('../../../lib/trust-proxy.js')>()
  return {
    ...real,
    trustProxyFromEnv: () => ({ value: trust.value, warning: null }),
    peerIsTrustedProxy: (a: string | null | undefined, v = trust.value) =>
      real.peerIsTrustedProxy(a, v),
    trustedRequestHost: (
      h: Parameters<typeof real.trustedRequestHost>[0],
      p: string | null | undefined,
      v = trust.value
    ) => real.trustedRequestHost(h, p, v)
  }
})

const {
  regenerateForSignIn,
  registerSession,
  REVOKED_PREFIX,
  SESSION_COOKIE,
  sessionIdsForUser,
  stampSessionApp
} = await import('../../../auth/session.js')
const { tenantHook } = await import('../../../middleware/tenant.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
const { socketTenantHost } = await import('../../../services/socket-tenant.js')
const { handshakeSessionUser } = await import('../../../services/socket-handshake-session.js')
const { peerIsTrustedProxy } = await import('../../../lib/trust-proxy.js')

function fakeRedis() {
  const kv = new Map<string, string>()
  return {
    kv,
    async mget(...keys: string[]) {
      return keys.map((k) => kv.get(k) ?? null)
    },
    async get(k: string) {
      return kv.get(k) ?? null
    },
    async eval(_s: string, _n: number, key: string, revoked: string, _t: number, v: string) {
      if (kv.has(revoked)) return 0
      kv.set(key, v)
      return 1
    },
    async scan(_c: string) {
      return ['0', [...kv.keys()].filter((k) => k.startsWith('sess:'))] as [string, string[]]
    },
    multi() {
      const ops: Array<() => void> = []
      const m = {
        del: (k: string) => {
          ops.push(() => kv.delete(k))
          return m
        },
        setex: (k: string, _t: number, v: string) => {
          ops.push(() => kv.set(k, v))
          return m
        },
        exec: async () => {
          for (const op of ops) op()
          return []
        }
      }
      return m
    }
  }
}

const APPS: Record<string, string> = { 'alpha.localhost': 'alpha', 'beta.localhost': 'beta' }
const registry = (source: 'hub' | 'cloud-meta') => ({
  source,
  async resolve(host: string) {
    const id = APPS[host.split(':')[0]]
    return id
      ? {
          tenant: {
            id,
            slug: id,
            name: id,
            status: 'active',
            dbClient: 'pg',
            dbConnection: `postgres://${id}`,
            poolMax: null,
            hostnames: [`${id}.localhost`]
          },
          origin: `http://${id}.localhost`
        }
      : null
  },
  async listActive() {
    return []
  },
  status: () => ({ source, count: 2, loadedAt: 'x', stale: false, lastError: null })
})

let redis: ReturnType<typeof fakeRedis>
async function build(opts: {
  tenantHook: boolean
  trustProxy?: boolean
}): Promise<FastifyInstance> {
  const app = Fastify(opts.trustProxy ? { trustProxy: true } : {})
  app.decorate('redis', redis as never)
  if (opts.tenantHook) app.addHook('onRequest', tenantHook)
  await registerSession(app)
  // What routes/auth.ts signInSession does with the session.
  app.post('/api/signin', async (req) => {
    await regenerateForSignIn(req, redis as never)
    req.session.userId = 'u1'
    stampSessionApp(req.session)
    return { ok: true }
  })
  app.get('/api/me', async (req) => ({ userId: req.session.userId ?? null }))
  app.get('/api/start', async (req) => {
    req.session.returnTo = '/x' // pre-sign-in state (the OIDC start)
    return { ok: true }
  })
  return app
}

const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE)
  if (!c) throw new Error('no session cookie')
  return `${SESSION_COOKIE}=${c.value}`
}
const storedBlobs = () =>
  [...redis.kv.entries()]
    .filter(([k]) => k.startsWith('sess:') && !k.startsWith(REVOKED_PREFIX))
    .map(([, v]) => JSON.parse(v) as Record<string, unknown>)

const savedEnv = { ...process.env }
beforeEach(() => {
  redis = fakeRedis()
  trust.value = false
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
})
afterEach(() => {
  process.env = { ...savedEnv }
  setTenantRegistryForTests(null)
})

function shared() {
  process.env.HUB_SHARED_DEPLOYMENT = 'demo'
  setTenantRegistryForTests(registry('hub') as never)
}
function cloud() {
  process.env.CLOUD_META_DB_URL = 'postgres://meta'
  setTenantRegistryForTests(registry('cloud-meta') as never)
}

describe('Hub shared deployment: a session belongs to one app', () => {
  it('a cookie minted in app A replayed against app B is refused, and A keeps it', async () => {
    shared()
    const app = await build({ tenantHook: true })
    const signin = await app.inject({
      method: 'POST',
      url: '/api/signin',
      headers: { host: 'alpha.localhost' }
    })
    const cookie = cookieOf(signin)
    expect(storedBlobs()).toEqual([expect.objectContaining({ userId: 'u1', tenantId: 'alpha' })])
    const revoked = () => [...redis.kv.keys()].filter((k) => k.startsWith(REVOKED_PREFIX)).length
    const revokedBefore = revoked()

    const onB = await app.inject({ url: '/api/me', headers: { host: 'beta.localhost', cookie } })
    expect(onB.json()).toEqual({ userId: null })
    // never written or revoked from B: the stored session is A's, unchanged
    expect(storedBlobs()).toEqual([expect.objectContaining({ userId: 'u1', tenantId: 'alpha' })])
    expect(revoked()).toBe(revokedBefore)

    const onA = await app.inject({ url: '/api/me', headers: { host: 'alpha.localhost', cookie } })
    expect(onA.json()).toEqual({ userId: 'u1' })
    await app.close()
  })

  it('a session with no app stamp is not a sign-in on a shared deployment', async () => {
    shared()
    const app = await build({ tenantHook: true })
    const cookie = cookieOf(
      await app.inject({ method: 'POST', url: '/api/signin', headers: { host: 'alpha.localhost' } })
    )
    for (const [k, v] of redis.kv) {
      const blob = JSON.parse(v) as Record<string, unknown>
      delete blob.tenantId
      redis.kv.set(k, JSON.stringify(blob))
    }
    const res = await app.inject({ url: '/api/me', headers: { host: 'alpha.localhost', cookie } })
    expect(res.json()).toEqual({ userId: null })
    await app.close()
  })

  it('pre-sign-in state is stamped too (the OIDC callback finds it on the same app only)', async () => {
    shared()
    const app = await build({ tenantHook: true })
    const start = await app.inject({ url: '/api/start', headers: { host: 'beta.localhost' } })
    expect(storedBlobs()).toEqual([expect.objectContaining({ returnTo: '/x', tenantId: 'beta' })])
    const cookie = cookieOf(start)
    const onA = await app.inject({ url: '/api/me', headers: { host: 'alpha.localhost', cookie } })
    expect(onA.statusCode).toBe(200)
    expect(storedBlobs()).toEqual([expect.objectContaining({ returnTo: '/x', tenantId: 'beta' })])
    await app.close()
  })

  it('a forged X-Forwarded-Host from an untrusted client is ignored: Host decides', async () => {
    shared()
    const app = await build({ tenantHook: true })
    const cookie = cookieOf(
      await app.inject({ method: 'POST', url: '/api/signin', headers: { host: 'alpha.localhost' } })
    )
    // A dev admin with a dev cookie asks production's host to read it as dev.
    const forged = await app.inject({
      url: '/api/me',
      headers: { host: 'beta.localhost', 'x-forwarded-host': 'alpha.localhost', cookie }
    })
    expect(forged.json()).toEqual({ userId: null })
    // and the other way round: Host names A, a forged header names an unknown app → still A
    const viaHost = await app.inject({
      url: '/api/me',
      headers: { host: 'alpha.localhost', 'x-forwarded-host': 'nope.localhost', cookie }
    })
    expect(viaHost.json()).toEqual({ userId: 'u1' })
    await app.close()
  })

  it('X-Forwarded-Host is honoured from a trusted proxy (the TRUST_PROXY rule)', async () => {
    shared()
    trust.value = true
    const app = await build({ tenantHook: true, trustProxy: true })
    const cookie = cookieOf(
      await app.inject({ method: 'POST', url: '/api/signin', headers: { host: 'alpha.localhost' } })
    )
    const res = await app.inject({
      url: '/api/me',
      headers: { host: 'internal:3055', 'x-forwarded-host': 'alpha.localhost', cookie }
    })
    expect(res.json()).toEqual({ userId: 'u1' })
    await app.close()
  })

  it('a multi-valued X-Forwarded-Host: HTTP and socket resolve the same (last) entry', async () => {
    // A client puts a forged host in front; the trusted proxy appends the real one at the end.
    shared()
    const app = await build({ tenantHook: true })
    const cookie = cookieOf(
      await app.inject({ method: 'POST', url: '/api/signin', headers: { host: 'alpha.localhost' } })
    )
    const xfh = 'beta.localhost, alpha.localhost'
    const http = () =>
      app
        .inject({
          url: '/api/me',
          remoteAddress: '10.0.0.5',
          headers: { host: 'internal:3055', 'x-forwarded-host': xfh, cookie }
        })
        .then((r) => r.json())
    const sock = () =>
      socketTenantHost({
        handshake: {
          headers: { host: 'internal:3055', 'x-forwarded-host': xfh },
          address: '10.0.0.5'
        }
      })
    // from a trusted proxy: both take the last entry (alpha)
    trust.value = ['10.0.0.0/8']
    expect(await http()).toEqual({ userId: 'u1' })
    expect(sock()).toBe('alpha.localhost')
    // the forged first entry never wins: the same session read with the entries swapped
    const swapped = await app.inject({
      url: '/api/me',
      remoteAddress: '10.0.0.5',
      headers: {
        host: 'internal:3055',
        'x-forwarded-host': 'alpha.localhost, beta.localhost',
        cookie
      }
    })
    expect(swapped.json()).toEqual({ userId: null })
    // from an untrusted peer: the header is ignored on both, Host decides (no app there)
    trust.value = false
    expect((await http()).userId ?? null).toBeNull()
    expect(sock()).toBe('internal')
    await app.close()
  })

  it("'sign out everywhere' and session lists see only this app's sessions", async () => {
    shared()
    redis.kv.set('sess:a1', JSON.stringify({ userId: 'u1', tenantId: 'alpha' }))
    redis.kv.set('sess:b1', JSON.stringify({ userId: 'u1', tenantId: 'beta' }))
    redis.kv.set('sess:n1', JSON.stringify({ userId: 'u1' }))
    const inApp = (id: string) =>
      new Promise<string[]>((resolve) =>
        runWithTenantDb(
          {} as never,
          id,
          () => void sessionIdsForUser(redis as never, 'u1').then(resolve),
          id
        )
      )
    expect(await inApp('alpha')).toEqual(['a1'])
    expect(await inApp('beta')).toEqual(['b1'])
  })

  it('socket.io: a handshake cookie of another app signs nothing in', async () => {
    shared()
    const app = await build({ tenantHook: true })
    const res = await app.inject({
      method: 'POST',
      url: '/api/signin',
      headers: { host: 'alpha.localhost' }
    })
    const cookie = cookieOf(res)
    const socket = { handshake: { headers: { host: 'beta.localhost', cookie } } }
    const inApp = (id: string) =>
      new Promise<unknown>((resolve) =>
        runWithTenantDb(
          {} as never,
          id,
          () => void handshakeSessionUser(socket, redis as never).then(resolve),
          id
        )
      )
    expect(await inApp('beta')).toBeNull()
    expect(await inApp('alpha')).toMatchObject({ user: { id: 'u1' } })
    await app.close()
  })

  it('sockets and graphql-ws: X-Forwarded-Host only from a trusted peer', () => {
    shared()
    const sock = (address: string) => ({
      handshake: {
        headers: { host: 'beta.localhost', 'x-forwarded-host': 'alpha.localhost' },
        address
      }
    })
    expect(socketTenantHost(sock('203.0.113.9'))).toBe('beta.localhost')
    trust.value = ['10.0.0.0/8']
    expect(socketTenantHost(sock('203.0.113.9'))).toBe('beta.localhost')
    expect(socketTenantHost(sock('::ffff:10.1.2.3'))).toBe('alpha.localhost')
    trust.value = 1
    expect(socketTenantHost(sock('203.0.113.9'))).toBe('alpha.localhost')
  })
})

describe('peerIsTrustedProxy follows TRUST_PROXY', () => {
  it('unset trusts nobody, true everyone, a list its addresses and named ranges', () => {
    expect(peerIsTrustedProxy('10.0.0.1', false)).toBe(false)
    expect(peerIsTrustedProxy('203.0.113.1', true)).toBe(true)
    expect(peerIsTrustedProxy('203.0.113.1', 1)).toBe(true)
    expect(peerIsTrustedProxy('203.0.113.1', 0)).toBe(false)
    expect(peerIsTrustedProxy('10.9.9.9', ['10.0.0.0/8'])).toBe(true)
    expect(peerIsTrustedProxy('11.0.0.1', ['10.0.0.0/8'])).toBe(false)
    expect(peerIsTrustedProxy('192.0.2.7', ['192.0.2.7'])).toBe(true)
    expect(peerIsTrustedProxy('127.0.0.1', ['loopback'])).toBe(true)
    expect(peerIsTrustedProxy('::1', ['loopback'])).toBe(true)
    expect(peerIsTrustedProxy('172.20.0.5', ['uniquelocal'])).toBe(true)
    expect(peerIsTrustedProxy(undefined, ['loopback'])).toBe(false)
    expect(peerIsTrustedProxy('not-an-ip', ['loopback'])).toBe(false)
  })
})

describe('cloud and self-hosted are unchanged', () => {
  it('cloud: no app stamp is written, and X-Forwarded-Host still decides without a proxy rule', async () => {
    cloud()
    const app = await build({ tenantHook: true })
    const cookie = cookieOf(
      await app.inject({ method: 'POST', url: '/api/signin', headers: { host: 'alpha.localhost' } })
    )
    expect(storedBlobs()).toEqual([expect.not.objectContaining({ tenantId: expect.anything() })])
    expect(storedBlobs()[0]).toMatchObject({ userId: 'u1' })
    const onA = await app.inject({ url: '/api/me', headers: { host: 'alpha.localhost', cookie } })
    expect(onA.json()).toEqual({ userId: 'u1' })
    // the edge rule: X-Forwarded-Host over Host, no TRUST_PROXY needed (as before)
    const xfh = await app.inject({
      url: '/api/me',
      headers: { host: 'nope.localhost', 'x-forwarded-host': 'alpha.localhost', cookie }
    })
    expect(xfh.json()).toEqual({ userId: 'u1' })
    expect(
      socketTenantHost({
        handshake: {
          headers: { host: 'beta.localhost', 'x-forwarded-host': 'alpha.localhost' },
          address: '203.0.113.9'
        }
      })
    ).toBe('alpha.localhost')
    await app.close()
  })

  it('self-hosted: no stamp, the session reads on any host, every session is listed', async () => {
    const app = await build({ tenantHook: false })
    const cookie = cookieOf(
      await app.inject({ method: 'POST', url: '/api/signin', headers: { host: 'a.example' } })
    )
    expect(storedBlobs()).toEqual([expect.not.objectContaining({ tenantId: expect.anything() })])
    const res = await app.inject({ url: '/api/me', headers: { host: 'b.example', cookie } })
    expect(res.json()).toEqual({ userId: 'u1' })
    redis.kv.set('sess:x1', JSON.stringify({ userId: 'u1', tenantId: 'whatever' }))
    expect((await sessionIdsForUser(redis as never, 'u1')).sort()).toHaveLength(2)
    await app.close()
  })
})
