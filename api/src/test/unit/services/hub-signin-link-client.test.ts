import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7, Task 7: the app's side of the Hub app link — sign-in reports (at most once
// per person per 6 h, never throwing into sign-in) and the switcher question (POST with the
// person in the body, cached 5 min, failures never cached, non-https links dropped).

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const {
  _resetLinkClientForTests,
  fetchSwitcher,
  LINK_DOWN_MS,
  linkTag,
  PUSH_EVERY_S,
  PUSH_RETRY_S,
  pushKey,
  pushSignInEvent,
  SWITCHER_CACHE_S,
  switcherKey
} = await import('../../../services/hub-signin/link-client.js')

beforeEach(() => _resetLinkClientForTests())

const TOKEN = `hubt_${'t'.repeat(40)}`
const HUB = 'https://hub.example.com'
const ENV = { NODE_ENV: 'test', HUB_URL: HUB, HUB_TOKEN: TOKEN } as NodeJS.ProcessEnv
const OID = '99999999-8888-7777-6666-555555555555'
const TID = '11111111-2222-3333-4444-555555555555'
const EMAIL = 'pat@example.com'
const ROW = { email: EMAIL, entra_oid: OID, entra_tid: TID }

/** A Redis with SET NX / EX, GET and EXPIRE on a settable clock, recording every call. */
function fakeRedis() {
  const store = new Map<string, { v: string; ttl?: number; at: number }>()
  const calls: unknown[][] = []
  const clock = { ms: 0 }
  const live = (key: string) => {
    const e = store.get(key)
    if (e?.ttl != null && clock.ms >= e.at + e.ttl * 1000) store.delete(key)
    return store.get(key)
  }
  return {
    store,
    calls,
    clock,
    ttl: (key: string) => live(key)?.ttl,
    async set(key: string, value: string, ...args: unknown[]) {
      calls.push(['set', key, value, ...args])
      if (args.includes('NX') && live(key)) return null
      const ex = args.indexOf('EX')
      store.set(key, { v: value, ttl: ex >= 0 ? Number(args[ex + 1]) : undefined, at: clock.ms })
      return 'OK'
    },
    async get(key: string) {
      calls.push(['get', key])
      return live(key)?.v ?? null
    },
    async expire(key: string, seconds: number) {
      calls.push(['expire', key, seconds])
      const e = live(key)
      if (!e) return 0
      store.set(key, { ...e, ttl: seconds, at: clock.ms })
      return 1
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
      { ...ENV, CLOUD_META_DB_URL: 'x' },
      // a Hub shared deployment always has HUB_URL (its tenant list): still nothing pushed
      { ...ENV, HUB_SHARED_DEPLOYMENT: 'shared-1' }
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
    expect(redis.calls[0]).toEqual(['set', pushKey('u1', TOKEN), '1', 'EX', 21600, 'NX'])
    expect(pushKey('u1', TOKEN)).toBe(`nvr:hub-signin-push:${linkTag(TOKEN)}:u1`)
    expect(linkTag(TOKEN)).toMatch(/^[0-9a-f]{10}$/)
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
      get: async () => null,
      expire: async () => 0
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
    expect(switcherKey('u1', TOKEN)).toBe(`nvr:hub-switcher:${linkTag(TOKEN)}:u1`)
    expect(redis.store.get(switcherKey('u1', TOKEN))?.ttl).toBe(SWITCHER_CACHE_S)
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
      _resetLinkClientForTests()
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
    _resetLinkClientForTests()
    const prod = { ...ENV, NODE_ENV: 'production' } as NodeJS.ProcessEnv
    expect(
      (await fetchSwitcher(fakeRedis(), { id: 'u1', email: EMAIL }, deps(fetchImpl, prod))).apps
    ).toEqual([good])
  })
})

describe('fix round 1', () => {
  const ok = () => new Response(null, { status: 204 })
  const push = (redis: ReturnType<typeof fakeRedis>, fetchImpl: any, over: object = {}) =>
    pushSignInEvent(
      redis,
      { id: 'u1', email: null },
      {
        env: ENV,
        fetchImpl,
        readUser: async () => ROW,
        log: () => {},
        ...over
      }
    )

  it('P7-12: a 500 leaves the slot at 600 s; a 204 keeps 21600 s', async () => {
    expect(PUSH_RETRY_S).toBe(600)
    const failed = fakeRedis()
    await push(failed, fakeFetch(() => json(500, {})).fetchImpl)
    expect(failed.ttl(pushKey('u1', TOKEN))).toBe(600)
    const landed = fakeRedis()
    await push(landed, fakeFetch(ok).fetchImpl)
    expect(landed.ttl(pushKey('u1', TOKEN))).toBe(21600)
  })

  it('P7-12: 429, network errors, timeouts and an unreadable account all shorten the slot', async () => {
    const cases: Array<[string, any, object]> = [
      ['429', fakeFetch(() => json(429, { code: 'HUB_LINK_BUSY' })).fetchImpl, {}],
      ['503', fakeFetch(() => json(503, {})).fetchImpl, {}],
      ['network', fakeFetch(() => Promise.reject(new TypeError('fetch failed'))).fetchImpl, {}],
      [
        'timeout',
        fakeFetch(() => Promise.reject(new DOMException('t', 'TimeoutError'))).fetchImpl,
        {}
      ],
      [
        'row',
        fakeFetch(ok).fetchImpl,
        {
          readUser: async () => {
            throw new Error('db down')
          }
        }
      ]
    ]
    for (const [name, fetchImpl, over] of cases) {
      const redis = fakeRedis()
      await push(redis, fetchImpl, over)
      expect({ name, ttl: redis.ttl(pushKey('u1', TOKEN)) }).toEqual({ name, ttl: 600 })
    }
  })

  it('P7-12: after the short slot runs out, a new sign-in pushes again', async () => {
    const redis = fakeRedis()
    let status = 500
    const { fetchImpl } = fakeFetch(() =>
      status === 204 ? new Response(null, { status }) : json(status, {})
    )
    await push(redis, fetchImpl)
    redis.clock.ms += 599_000
    await push(redis, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    redis.clock.ms += 2_000
    status = 204
    await push(redis, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(redis.ttl(pushKey('u1', TOKEN))).toBe(21600)
  })

  it('a non-success answer body is cancelled', async () => {
    const cancel = vi.fn()
    const body = () => new Response(new ReadableStream({ cancel, pull: () => {} }), { status: 500 })
    await push(fakeRedis(), fakeFetch(body).fetchImpl)
    await fetchSwitcher(
      fakeRedis(),
      { id: 'u1', email: EMAIL },
      {
        env: ENV,
        fetchImpl: fakeFetch(body).fetchImpl,
        readUser: async () => ROW,
        log: () => {}
      }
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('keys carry a tag of HUB_TOKEN: two environments on one Redis share no slot or cache', async () => {
    const other = `hubt_${'o'.repeat(40)}`
    const envB = { ...ENV, HUB_TOKEN: other } as NodeJS.ProcessEnv
    expect(linkTag(other)).not.toBe(linkTag(TOKEN))
    const redis = fakeRedis()
    const { fetchImpl } = fakeFetch(ok)
    await push(redis, fetchImpl)
    await push(redis, fetchImpl, { env: envB })
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const a = fakeFetch(() => json(200, { data: { apps: [app()] } }))
    const b = fakeFetch(() => json(200, { data: { apps: [] } }))
    const deps = (env: NodeJS.ProcessEnv, f: any) => ({
      env,
      fetchImpl: f,
      readUser: async () => ROW,
      log: () => {}
    })
    await fetchSwitcher(redis, { id: 'u1', email: EMAIL }, deps(ENV, a.fetchImpl))
    const fromB = await fetchSwitcher(redis, { id: 'u1', email: EMAIL }, deps(envB, b.fetchImpl))
    expect(fromB.apps).toEqual([])
    expect(b.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a failed switcher call marks the link down for 30 s: no call, unavailable', async () => {
    expect(LINK_DOWN_MS).toBe(30_000)
    let t = 1_000_000
    let fail = true
    const { fetchImpl } = fakeFetch(() =>
      fail ? json(500, {}) : json(200, { data: { apps: [app()] } })
    )
    const deps = { env: ENV, fetchImpl, readUser: async () => ROW, log: () => {}, now: () => t }
    const redis = fakeRedis()
    expect((await fetchSwitcher(redis, { id: 'u1', email: EMAIL }, deps)).unavailable).toBe(true)
    fail = false
    t += 29_000
    expect(await fetchSwitcher(redis, { id: 'u2', email: EMAIL }, deps)).toEqual({
      apps: [],
      unavailable: true
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    t += 2_000
    expect(await fetchSwitcher(redis, { id: 'u2', email: EMAIL }, deps)).toEqual({
      apps: [app()],
      unavailable: false
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('an answer over 64 KB (declared or streamed) is refused unread', async () => {
    const big = JSON.stringify({ data: { apps: [app({ app_name: 'x'.repeat(70_000) })] } })
    const declared = () =>
      new Response('{}', { status: 200, headers: { 'content-length': String(200_000) } })
    const streamed = () => {
      const bytes = new TextEncoder().encode(big)
      return new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < bytes.length; i += 8192) c.enqueue(bytes.slice(i, i + 8192))
            c.close()
          }
        }),
        { status: 200 }
      )
    }
    for (const answer of [declared, streamed]) {
      _resetLinkClientForTests()
      const out = await fetchSwitcher(
        fakeRedis(),
        { id: 'u1', email: EMAIL },
        {
          env: ENV,
          fetchImpl: fakeFetch(answer).fetchImpl,
          readUser: async () => ROW,
          log: () => {}
        }
      )
      expect(out).toEqual({ apps: [], unavailable: true })
    }
  })

  it('links must be exactly <origin>/ and <same origin>/api/auth/login?returnTo=%2F; names capped', async () => {
    const good = app()
    const apps = [
      good,
      app({ app_key: 'path', url: 'https://ops.example.com/x' }),
      app({ app_key: 'noslash', url: 'https://ops.example.com' }),
      app({ app_key: 'query', url: 'https://ops.example.com/?a=1' }),
      app({
        app_key: 'other',
        signin_url: 'https://evil.example.com/api/auth/login?returnTo=%2F'
      }),
      app({ app_key: 'ret', signin_url: 'https://ops.example.com/api/auth/login?returnTo=%2Fx' }),
      app({ app_key: 'more', signin_url: 'https://ops.example.com/api/auth/login?returnTo=%2F&a' }),
      app({ app_name: 'n'.repeat(201) }),
      app({ app_key: 'k'.repeat(65) }),
      app({ environment_key: 'e'.repeat(65) }),
      app({ app_key: '' }),
      app({ app_key: 'max', app_name: 'n'.repeat(200), environment_key: 'e'.repeat(64) })
    ]
    const out = await fetchSwitcher(
      fakeRedis(),
      { id: 'u1', email: EMAIL },
      {
        env: ENV,
        fetchImpl: fakeFetch(() => json(200, { data: { apps } })).fetchImpl,
        readUser: async () => ROW,
        log: () => {}
      }
    )
    expect(out.apps.map((a) => a.app_key)).toEqual(['ops', 'max'])
    expect(out.apps[0]).toEqual(good)
  })
})
