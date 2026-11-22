import { describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7, Task 7: the app's side of the Hub app link — sign-in reports (at most once
// per person per 6 h, never throwing into sign-in) and the switcher question (POST with the
// person in the body, cached 5 min, failures never cached, non-https links dropped).

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { fetchSwitcher, pushKey, pushSignInEvent, PUSH_EVERY_S, SWITCHER_CACHE_S, switcherKey } =
  await import('../../../services/hub-signin/link-client.js')

const TOKEN = `hubt_${'t'.repeat(40)}`
const HUB = 'https://hub.example.com'
const ENV = { NODE_ENV: 'test', HUB_URL: HUB, HUB_TOKEN: TOKEN } as NodeJS.ProcessEnv
const OID = '99999999-8888-7777-6666-555555555555'
const TID = '11111111-2222-3333-4444-555555555555'
const EMAIL = 'pat@example.com'
const ROW = { email: EMAIL, entra_oid: OID, entra_tid: TID }

/** A Redis with SET NX / EX and GET, recording every call. */
function fakeRedis() {
  const store = new Map<string, { v: string; ttl?: number }>()
  const calls: unknown[][] = []
  return {
    store,
    calls,
    async set(key: string, value: string, ...args: unknown[]) {
      calls.push(['set', key, value, ...args])
      if (args.includes('NX') && store.has(key)) return null
      const ex = args.indexOf('EX')
      store.set(key, { v: value, ttl: ex >= 0 ? Number(args[ex + 1]) : undefined })
      return 'OK'
    },
    async get(key: string) {
      calls.push(['get', key])
      return store.get(key)?.v ?? null
    }
  }
}

type Call = { url: string; init: RequestInit }

function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return answer()
  })
  return { calls, fetchImpl }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const app = (over: Record<string, unknown> = {}) => ({
  app_key: 'ops',
  app_name: 'Ops desk',
  environment_key: 'production',
  url: 'https://ops.example.com/',
  signin_url: 'https://ops.example.com/api/auth/login?returnTo=%2F',
  current: false,
  ...over
})

describe('pushSignInEvent', () => {
  it('does nothing without HUB_URL and HUB_TOKEN (no Redis, no call)', async () => {
    const redis = fakeRedis()
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }))
    for (const env of [
      {},
      { HUB_URL: HUB },
      { HUB_TOKEN: TOKEN },
      { HUB_URL: HUB, HUB_TOKEN: 'short' },
      { ...ENV, CLOUD_META_DB_URL: 'x' }
    ])
      await pushSignInEvent(redis, { id: 'u1', email: EMAIL }, { env: env as any, fetchImpl })
    expect(redis.calls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('two sign-ins within 6 h push once (SET NX EX 21600 first)', async () => {
    const redis = fakeRedis()
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }))
    const deps = { env: ENV, fetchImpl, readUser: async () => ROW }
    await pushSignInEvent(redis, { id: 'u1', email: null }, deps)
    await pushSignInEvent(redis, { id: 'u1', email: null }, deps)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(PUSH_EVERY_S).toBe(21600)
    expect(redis.calls[0]).toEqual(['set', pushKey('u1'), '1', 'EX', 21600, 'NX'])
    expect(pushKey('u1')).toBe('nvr:hub-signin-push:u1')
    // Another person is their own window.
    await pushSignInEvent(redis, { id: 'u2', email: null }, deps)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('POSTs oid/tid/email (from the account row) in the body, redirect: error, a timeout', async () => {
    const redis = fakeRedis()
    const { calls, fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }))
    await pushSignInEvent(
      redis,
      { id: 'u1', email: null },
      {
        env: ENV,
        fetchImpl,
        readUser: async () => ROW
      }
    )
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(url).toBe(`${HUB}/api/hub/app-link/signins`)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(String(init.body))).toEqual({ oid: OID, tid: TID, email: EMAIL })
    expect(url).not.toContain('?')
  })

  it('what the caller passed wins; oid without tid is never sent', async () => {
    const redis = fakeRedis()
    const { calls, fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }))
    await pushSignInEvent(
      redis,
      { id: 'u1', email: 'given@example.com', entra_oid: OID },
      {
        env: ENV,
        fetchImpl,
        readUser: async () => ({ email: 'row@example.com', entra_oid: null, entra_tid: null })
      }
    )
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: 'given@example.com' })
  })

  it('a Hub 500, a network failure or a Redis failure never throws; logs name no token or email', async () => {
    const lines: string[] = []
    const log = (l: string) => lines.push(l)
    const failing = [
      fakeFetch(() => json(500, { error: 'boom' })).fetchImpl,
      fakeFetch(() => Promise.reject(Object.assign(new TypeError('fetch failed'), {}))).fetchImpl,
      fakeFetch(() => {
        throw new DOMException('timed out', 'TimeoutError')
      }).fetchImpl
    ]
    for (const fetchImpl of failing)
      await expect(
        pushSignInEvent(
          fakeRedis(),
          { id: 'u1', email: EMAIL },
          {
            env: ENV,
            fetchImpl,
            readUser: async () => ROW,
            log
          }
        )
      ).resolves.toBeUndefined()
    const broken = {
      set: async () => {
        throw new Error(`redis down ${TOKEN} ${EMAIL}`)
      },
      get: async () => null
    }
    await expect(
      pushSignInEvent(broken, { id: 'u1', email: EMAIL }, { env: ENV, log })
    ).resolves.toBeUndefined()
    expect(lines.length).toBe(4)
    for (const l of lines) {
      expect(l).not.toContain(TOKEN)
      expect(l).not.toContain('@')
    }
  })

  it('a person with no usable identity sends nothing', async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }))
    await pushSignInEvent(
      fakeRedis(),
      { id: 'u1', email: null },
      {
        env: ENV,
        fetchImpl,
        readUser: async () => null
      }
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('fetchSwitcher', () => {
  const deps = (fetchImpl: any, env = ENV) => ({
    env,
    fetchImpl,
    readUser: async () => ROW,
    log: () => {}
  })

  it('not set up → empty, available, nothing asked', async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { data: { apps: [app()] } }))
    expect(
      await fetchSwitcher(fakeRedis(), { id: 'u1', email: EMAIL }, deps(fetchImpl, {} as any))
    ).toEqual({ apps: [], unavailable: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('POSTs the person in the body (never the URL) and passes the answer through unchanged', async () => {
    const apps = [app({ current: true, app_key: 'efp', app_name: 'EFP' }), app()]
    const { calls, fetchImpl } = fakeFetch(() => json(200, { data: { apps } }))
    const out = await fetchSwitcher(fakeRedis(), { id: 'u1', email: null }, deps(fetchImpl))
    expect(out).toEqual({ apps, unavailable: false })
    const { url, init } = calls[0]
    expect(url).toBe(`${HUB}/api/hub/app-link/switcher`)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init.body))).toEqual({ oid: OID, tid: TID, email: EMAIL })
    expect(url).not.toMatch(/[?@]/)
  })

  it('cached 5 min per person: the second ask is answered from Redis', async () => {
    const redis = fakeRedis()
    const { fetchImpl } = fakeFetch(() => json(200, { data: { apps: [app()] } }))
    await fetchSwitcher(redis, { id: 'u1', email: EMAIL }, deps(fetchImpl))
    const again = await fetchSwitcher(redis, { id: 'u1', email: EMAIL }, deps(fetchImpl))
    expect(again).toEqual({ apps: [app()], unavailable: false })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(switcherKey('u1')).toBe('nvr:hub-switcher:u1')
    expect(redis.store.get('nvr:hub-switcher:u1')?.ttl).toBe(SWITCHER_CACHE_S)
    expect(SWITCHER_CACHE_S).toBe(300)
  })

  it('a failure answers unavailable and is not cached', async () => {
    for (const answer of [
      () => json(500, { error: 'x' }),
      () => json(503, { code: 'HUB_LINK_UNAVAILABLE' }),
      () => new Response('<html>portal</html>', { status: 200 }),
      () => json(200, { data: {} }),
      (): Response => {
        throw new DOMException('timed out', 'TimeoutError')
      }
    ]) {
      const redis = fakeRedis()
      const { fetchImpl } = fakeFetch(answer)
      expect(await fetchSwitcher(redis, { id: 'u1', email: EMAIL }, deps(fetchImpl))).toEqual({
        apps: [],
        unavailable: true
      })
      expect(redis.store.size).toBe(0)
    }
  })

  it('drops entries whose url or signin_url is not https; loopback http only outside production', async () => {
    const good = app()
    const loop = app({
      app_key: 'dev',
      url: 'http://localhost:3056/',
      signin_url: 'http://localhost:3056/api/auth/login?returnTo=%2F'
    })
    const apps = [
      good,
      app({ app_key: 'plain', url: 'http://ops.example.com/' }),
      app({ app_key: 'js', signin_url: 'javascript:alert(1)' }),
      app({ app_key: 'creds', url: 'https://u:p@ops.example.com/' }),
      app({ app_key: 'bad', url: 'not a url' }),
      { app_key: 'partial' },
      null,
      loop
    ]
    const { fetchImpl } = fakeFetch(() => json(200, { data: { apps } }))
    expect(
      (await fetchSwitcher(fakeRedis(), { id: 'u1', email: EMAIL }, deps(fetchImpl))).apps
    ).toEqual([good, loop])
    const prod = { ...ENV, NODE_ENV: 'production' } as NodeJS.ProcessEnv
    expect(
      (await fetchSwitcher(fakeRedis(), { id: 'u1', email: EMAIL }, deps(fetchImpl, prod))).apps
    ).toEqual([good])
  })
})
