import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  checks: [] as Array<{
    id: string
    run: () => Promise<{ status: string; detail?: string; blockers?: string[] }>
  }>
}))

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/readiness.js', () => ({
  registerReadinessCheck: (c: (typeof state.checks)[number]) => state.checks.push(c)
}))

import { blockedPage } from '../../../services/tenancy/blocked-page.js'
import {
  HUB_TENANTS_PATH,
  type HubTenantWire,
  parseHubTenants
} from '../../../services/tenancy/hub-contract.js'
import {
  getHubTenantSource,
  HUB_BODY_MAX_BYTES,
  hubCacheKey,
  resetHubTenantSourceForTests,
  startHubTenantSource,
  stopHubTenantSource
} from '../../../services/tenancy/hub-source.js'
import { judgeTenantRegistry } from '../../../services/tenancy/readiness.js'
import { getTenantRegistry, setTenantRegistryForTests } from '../../../services/tenancy/registry.js'

const TOKEN = `hubtok-${'q'.repeat(40)}`
const KEY = 'a'.repeat(64)
const DEPLOYMENT = 'shared-a'
const CONN_A = 'postgres://app-a-user:pa55-SECRET@db.internal/app_a'
const CONN_B = 'mssql://sa:Other-SECRET@db.internal/app_b'

function tenant(over: Partial<HubTenantWire> = {}): HubTenantWire {
  const id = over.id ?? 'app-a-prod'
  return {
    id,
    app_key: 'app-a',
    env_key: 'prod',
    name: 'App A',
    status: 'active',
    hostnames: ['a.example.com', 'www.a.example.com'],
    // every app its own database unless a test says otherwise (a shared one drops both)
    db: { client: 'pg', connection: id === 'app-a-prod' ? CONN_A : `${CONN_A}?app=${id}` },
    ...over
  }
}

function body(tenants: unknown[], deployment = DEPLOYMENT) {
  return { data: { deployment, generated_at: '2026-11-21T00:00:00Z', tenants } }
}

const json = (b: unknown, status = 200, etag?: string) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) }
  })

type Answer = Response | Error | (() => Response | Error)
function fakeFetch(answers: Answer[]) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    let a = answers[Math.min(i++, answers.length - 1)]
    if (typeof a === 'function') a = a()
    if (a instanceof Error) throw a
    return a.clone()
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

function fakeRedis() {
  const m = new Map<string, string>()
  return {
    m,
    redis: {
      get: vi.fn(async (k: string) => m.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        m.set(k, v)
        return 'OK'
      })
    } as unknown as import('ioredis').Redis
  }
}

const timeoutError = () => Object.assign(new Error(`timed out ${TOKEN}`), { name: 'TimeoutError' })

const goodList = () =>
  body([
    tenant(),
    tenant({
      id: 'app-b-test',
      app_key: 'app-b',
      env_key: 'test',
      name: 'App B',
      hostnames: ['B.Example.com', 'app-b.localhost:3121'],
      db: { client: 'mssql', connection: CONN_B },
      pool_max: 12
    })
  ])

let clock = 1_000_000
const now = () => clock
let warn: ReturnType<typeof vi.spyOn>
let logSpies: Array<ReturnType<typeof vi.spyOn>>

const savedEnv = { ...process.env }

beforeEach(() => {
  clock = 1_000_000
  process.env.HUB_SHARED_DEPLOYMENT = DEPLOYMENT
  process.env.HUB_URL = 'https://hub.example/'
  process.env.HUB_DEPLOYMENT_TOKEN = TOKEN
  process.env.ENCRYPTION_KEY = KEY
  delete process.env.CLOUD_META_DB_URL
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  logSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {})
  ]
})

afterEach(() => {
  resetHubTenantSourceForTests()
  setTenantRegistryForTests(null)
  process.env = { ...savedEnv }
  vi.restoreAllMocks()
})

function logged(): string {
  return [warn, ...logSpies].flatMap((s) => s.mock.calls.flat().map(String)).join('\n')
}

function start(fetchFn: typeof fetch, redis: import('ioredis').Redis | null = fakeRedis().redis) {
  return startHubTenantSource({ redis, fetch: fetchFn, now, refreshMs: 600_000 })
}

describe('parseHubTenants', () => {
  it('maps a good list to tenant records', () => {
    const r = parseHubTenants(goodList(), DEPLOYMENT)!
    expect(r.dropped).toEqual([])
    expect(r.tenants).toHaveLength(2)
    expect(r.tenants[1]).toMatchObject({
      id: 'app-b-test',
      slug: 'app-b',
      name: 'App B',
      status: 'active',
      dbClient: 'mssql',
      dbConnection: CONN_B,
      poolMax: 12,
      hostnames: ['b.example.com', 'app-b.localhost']
    })
    expect(r.tenants[0].poolMax).toBeNull()
  })

  it('drops tenants it cannot serve and names each', () => {
    const r = parseHubTenants(
      body([
        tenant({ id: 'Bad_Id' }),
        tenant({ id: 'unknown-client', db: { client: 'oracle' as never, connection: CONN_A } }),
        tenant({ id: 'lite', db: { client: 'sqlite' as never, connection: 'file:x' } }),
        tenant({ id: 'no-hosts', hostnames: [] }),
        tenant({ id: 'bad-hosts', hostnames: ['not a host!'] }),
        tenant({ id: 'pool-zero', pool_max: 0 }),
        tenant({ id: 'pool-big', pool_max: 21 }),
        tenant({ id: 'kept', hostnames: ['kept.example.com'] })
      ]),
      DEPLOYMENT
    )!
    expect(r.tenants.map((t) => t.id)).toEqual(['kept'])
    const why = Object.fromEntries(r.dropped.map((d) => [d.id, d.why]))
    expect(Object.keys(why)).toEqual([
      '#1',
      'unknown-client',
      'lite',
      'no-hosts',
      'bad-hosts',
      'pool-zero',
      'pool-big'
    ])
    expect(why.lite).toMatch(/sqlite/i)
    expect(why['pool-big']).toMatch(/pool_max/)
    expect(JSON.stringify(r.dropped)).not.toContain('SECRET')
  })

  it('a wrong deployment drops every tenant', () => {
    const r = parseHubTenants(goodList(), 'shared-b')!
    expect(r.tenants).toEqual([])
    expect(r.dropped.map((d) => d.id)).toEqual(['app-a-prod', 'app-b-test'])
  })

  it('a hostname claimed by two tenants drops both', () => {
    const r = parseHubTenants(
      body([
        tenant({ id: 'one', hostnames: ['same.example.com', 'one.example.com'] }),
        tenant({ id: 'two', hostnames: ['SAME.example.com'] }),
        tenant({ id: 'three', hostnames: ['three.example.com'] })
      ]),
      DEPLOYMENT
    )!
    expect(r.tenants.map((t) => t.id)).toEqual(['three'])
    expect(r.dropped.map((d) => d.id).sort()).toEqual(['one', 'two'])
  })

  it('hostnames are normalised: lower case, no port; default ports clash with bare names', () => {
    const r = parseHubTenants(
      body([
        tenant({ id: 'one', hostnames: ['ONE.example.com:443', 'one.example.com'] }),
        tenant({ id: 'two', hostnames: ['shared.example.com:443'] }),
        tenant({ id: 'three', hostnames: ['shared.example.com:80'] }),
        tenant({ id: 'four', hostnames: ['four.example.com:8443'] })
      ]),
      DEPLOYMENT
    )!
    expect(r.tenants.map((t) => [t.id, t.hostnames])).toEqual([
      ['one', ['one.example.com']],
      ['four', ['four.example.com']]
    ])
    expect(r.dropped.map((d) => d.id).sort()).toEqual(['three', 'two'])
  })

  it('a claim from a tenant dropped for another reason still clashes', () => {
    const r = parseHubTenants(
      body([
        tenant({ id: 'broken', pool_max: 99, hostnames: ['a.example.com'] }),
        tenant({ id: 'fine', hostnames: ['a.example.com', 'fine.example.com'] }),
        tenant({ id: 'Bad_Id', hostnames: ['x.example.com'] }),
        tenant({
          id: 'other',
          hostnames: ['x.example.com:443'],
          db: { client: 'pg', connection: CONN_B }
        })
      ]),
      DEPLOYMENT
    )!
    expect(r.tenants).toEqual([])
    const why = Object.fromEntries(r.dropped.map((d) => [d.id, d.why]))
    expect(why.broken).toMatch(/pool_max/)
    expect(why.fine).toBe('hostname a.example.com also claimed by broken')
    expect(why.other).toBe('hostname x.example.com also claimed by #3')
  })

  it('two tenants on one database are both dropped; the why never shows the connection', () => {
    const r = parseHubTenants(
      body([
        tenant({
          id: 'one',
          hostnames: ['one.example.com'],
          db: { client: 'pg', connection: CONN_A }
        }),
        tenant({
          id: 'two',
          hostnames: ['two.example.com'],
          db: { client: 'pg', connection: ` ${CONN_A} ` }
        }),
        tenant({
          id: 'three',
          hostnames: ['three.example.com'],
          db: { client: 'mssql', connection: CONN_B }
        })
      ]),
      DEPLOYMENT
    )!
    expect(r.tenants.map((t) => t.id)).toEqual(['three'])
    expect(r.dropped).toEqual([
      { id: 'one', why: 'shares its database with two' },
      { id: 'two', why: 'shares its database with one' }
    ])
    expect(JSON.stringify(r.dropped)).not.toContain('SECRET')
  })

  it('the app key (slug) uses the id character set', () => {
    for (const app_key of ['App_A', 'a b', '', 'x'.repeat(65), '../x'])
      expect(parseHubTenants(body([tenant({ app_key })]), DEPLOYMENT)!.dropped).toEqual([
        { id: 'app-a-prod', why: 'invalid app key' }
      ])
  })

  it('null for a body that is not a tenant list', () => {
    for (const b of [null, {}, { data: {} }, { data: { deployment: DEPLOYMENT } }, 'x', []])
      expect(parseHubTenants(b, DEPLOYMENT)).toBeNull()
  })

  it('the contract path', () => {
    expect(HUB_TENANTS_PATH('shared-a')).toBe('/api/hub/shared/shared-a/tenants')
  })
})

describe('Hub tenant source', () => {
  it('a good list resolves by every hostname', async () => {
    const f = fakeFetch([json(goodList(), 200, '"v1"')])
    const reg = await start(f.fn)
    expect(f.calls[0].url).toBe(`https://hub.example${HUB_TENANTS_PATH(DEPLOYMENT)}`)
    for (const h of ['a.example.com', 'WWW.a.example.com', 'a.example.com:443']) {
      const r = await reg.resolve(h)
      expect(r?.tenant.id).toBe('app-a-prod')
      expect(r?.tenant.slug).toBe('app-a')
    }
    expect((await reg.resolve('a.example.com'))?.origin).toBe('https://a.example.com')
    expect((await reg.resolve('b.example.com'))?.tenant.id).toBe('app-b-test')
    const local = await reg.resolve('app-b.localhost:3121')
    expect(local?.origin).toBe('http://app-b.localhost:3121')
    expect(reg.status()).toMatchObject({ source: 'hub', count: 2, stale: false, lastError: null })
    expect((await reg.listActive()).map((t) => t.id)).toEqual(['app-a-prod', 'app-b-test'])
  })

  it('getTenantRegistry answers the running Hub source on a shared deployment', async () => {
    expect(getTenantRegistry()).toBeNull() // not started yet
    const reg = await start(fakeFetch([json(goodList())]).fn)
    expect(getTenantRegistry()).toBe(reg)
    expect(getHubTenantSource()).toBe(reg)
  })

  it('a 304 keeps the list and sends If-None-Match', async () => {
    const f = fakeFetch([json(goodList(), 200, '"v1"'), new Response(null, { status: 304 })])
    const reg = (await start(f.fn)) as ReturnType<typeof getHubTenantSource> & object
    clock += 60_000
    await reg.refresh()
    expect((f.calls[1].init.headers as Record<string, string>)['If-None-Match']).toBe('"v1"')
    expect((await reg.resolve('a.example.com'))?.tenant.id).toBe('app-a-prod')
    expect(reg.status().count).toBe(2)
    expect(reg.details().confirmedAt).toBe(clock)
  })

  for (const [label, answer, text] of [
    ['500', () => json({ error: 'x' }, 500), /answered 500/],
    ['a timeout', timeoutError, /did not answer/],
    ['401 (token revoked)', () => json({ error: 'nope' }, 401), /refused/],
    ['a malformed body ({})', () => json({}), /not a tenant list/],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 }), /not a tenant list/],
    [
      'an answer for another deployment',
      () => json(body([tenant()], 'shared-b')),
      /another deployment/
    ],
    [
      'an empty answer for another deployment',
      () => json(body([], 'shared-b')),
      /another deployment/
    ]
  ] as const) {
    it(`${label} keeps the last list and sets lastError`, async () => {
      const f = fakeFetch([json(goodList()), answer as () => Response | Error])
      const reg = (await start(f.fn)) as NonNullable<ReturnType<typeof getHubTenantSource>>
      await reg.refresh()
      expect((await reg.resolve('a.example.com'))?.tenant.id).toBe('app-a-prod')
      expect((await reg.listActive()).length).toBe(2)
      const s = reg.status()
      expect(s.lastError).toMatch(text)
      expect(s.stale).toBe(true)
      expect(s.lastError).not.toContain(TOKEN)
      expect(s.lastError).not.toContain('SECRET')
    })
  }

  it('a request or socket host with any port resolves the listed host', async () => {
    const reg = await start(
      fakeFetch([json(body([tenant({ hostnames: ['a.example.com:443'] })]))]).fn
    )
    for (const h of ['a.example.com', 'a.example.com:443', 'A.EXAMPLE.COM:8443'])
      expect((await reg.resolve(h))?.origin).toBe('https://a.example.com')
  })

  it('the origin keeps a non-default port the Hub listed; routing uses the bare host', async () => {
    const reg = await start(
      fakeFetch([
        json(
          body([
            tenant({ hostnames: ['a.example.com:8443', 'www.a.example.com:443'] }),
            tenant({ id: 'local', app_key: 'local', hostnames: ['app.localhost:3121'] })
          ])
        )
      ]).fn
    )
    for (const h of ['a.example.com', 'a.example.com:8443', 'a.example.com:9000'])
      expect((await reg.resolve(h))?.origin).toBe('https://a.example.com:8443')
    expect((await reg.resolve('www.a.example.com:8443'))?.origin).toBe('https://www.a.example.com')
    expect((await reg.resolve('app.localhost:3125'))?.origin).toBe('http://app.localhost:3125')
  })

  it('a sealed copy without a time reads "at an unknown time"', async () => {
    const r = fakeRedis()
    const { encryptValue } = await import('../../../services/encryption.js')
    const copy = parseHubTenants(goodList(), DEPLOYMENT)!
    r.m.set(hubCacheKey(DEPLOYMENT), encryptValue(JSON.stringify({ tenants: copy.tenants })))
    const reg = (await start(fakeFetch([() => json({}, 503)]).fn, r.redis)) as NonNullable<
      ReturnType<typeof getHubTenantSource>
    >
    expect((await reg.resolve('a.example.com'))?.tenant.id).toBe('app-a-prod')
    expect(reg.status().loadedAt).not.toBeNull()
    const res = judgeTenantRegistry(reg.details(), clock)
    expect(res.status).toBe('warn')
    expect(res.detail).toMatch(/at an unknown time/)
  })

  it('a body over 2 MB is refused before parsing and keeps the list', async () => {
    const big = JSON.stringify(body([tenant({ name: 'x'.repeat(HUB_BODY_MAX_BYTES) })]))
    const streamed = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(big))
            c.close()
          }
        }),
        { status: 200 }
      )
    const declared = () =>
      new Response('{}', { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } })
    for (const answer of [streamed, declared]) {
      const reg = (await start(fakeFetch([json(goodList()), answer]).fn)) as NonNullable<
        ReturnType<typeof getHubTenantSource>
      >
      await reg.refresh()
      expect(reg.status().lastError).toMatch(/more than 2 MB/)
      expect(reg.status().count).toBe(2)
    }
  })

  it('stop ends the refresh timer but keeps the list for shutdown work', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const f = fakeFetch([json(goodList())])
      const reg = await startHubTenantSource({ redis: null, fetch: f.fn, now, refreshMs: 5_000 })
      vi.advanceTimersByTime(5_000)
      expect(f.calls).toHaveLength(2)
      stopHubTenantSource()
      vi.advanceTimersByTime(60_000)
      expect(f.calls).toHaveLength(2)
      expect(getHubTenantSource()).toBe(reg)
      expect((await reg.resolve('a.example.com'))?.tenant.id).toBe('app-a-prod')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a body that lists no apps is a real answer: the list empties', async () => {
    const f = fakeFetch([json(goodList()), json(body([]))])
    const reg = (await start(f.fn)) as NonNullable<ReturnType<typeof getHubTenantSource>>
    await reg.refresh()
    expect(reg.status()).toMatchObject({ count: 0, lastError: null })
  })

  it('a duplicate hostname drops both tenants; the others still resolve', async () => {
    const f = fakeFetch([
      json(
        body([
          tenant({ id: 'one', hostnames: ['same.example.com'] }),
          tenant({ id: 'two', hostnames: ['same.example.com', 'two.example.com'] }),
          tenant({ id: 'three', hostnames: ['three.example.com'] })
        ])
      )
    ])
    const reg = await start(f.fn)
    expect(await reg.resolve('same.example.com')).toBeNull()
    expect(await reg.resolve('two.example.com')).toBeNull()
    expect((await reg.resolve('three.example.com'))?.tenant.id).toBe('three')
    const err = reg.status().lastError ?? ''
    expect(err).toContain('one')
    expect(err).toContain('two')
  })

  it('the Redis copy is sealed, and a boot with the Hub down serves from it', async () => {
    const r = fakeRedis()
    await start(fakeFetch([json(goodList(), 200, '"v1"')]).fn, r.redis)
    const value = r.m.get(hubCacheKey(DEPLOYMENT))!
    expect(value).toBeTruthy()
    expect(value.startsWith('enc:v1:')).toBe(true)
    expect(value.includes(CONN_A)).toBe(false)
    expect(value.includes(CONN_B)).toBe(false)
    expect(value.includes('a.example.com')).toBe(false)
    stopHubTenantSource()

    // A new process: the Hub is down.
    const down = fakeFetch([() => json({}, 503)])
    const reg = await start(down.fn, r.redis)
    expect((await reg.resolve('a.example.com'))?.tenant.dbConnection).toBe(CONN_A)
    expect(reg.status().lastError).toMatch(/503/)
    // the copy's etag rides the next ask
    expect((down.calls[0].init.headers as Record<string, string>)['If-None-Match']).toBe('"v1"')
  })

  it('a plaintext value under the key is never trusted', async () => {
    const r = fakeRedis()
    r.m.set(
      hubCacheKey(DEPLOYMENT),
      JSON.stringify({ tenants: [{ id: 'evil', hostnames: ['a.example.com'] }] })
    )
    const reg = await start(fakeFetch([() => json({}, 500)]).fn, r.redis)
    expect(await reg.resolve('a.example.com')).toBeNull()
  })

  it('no ENCRYPTION_KEY: no Redis write, readiness warns', async () => {
    delete process.env.ENCRYPTION_KEY
    const r = fakeRedis()
    const reg = (await start(fakeFetch([json(goodList())]).fn, r.redis)) as NonNullable<
      ReturnType<typeof getHubTenantSource>
    >
    expect(r.redis.set).not.toHaveBeenCalled()
    expect(r.redis.get).not.toHaveBeenCalled()
    const res = judgeTenantRegistry(reg.details(), clock)
    expect(res.status).toBe('warn')
    expect(res.detail).toMatch(/memory only/)
  })

  it('a failed Redis write warns until the next good write', async () => {
    const r = fakeRedis()
    ;(r.redis.set as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'))
    const reg = (await start(fakeFetch([json(goodList())]).fn, r.redis)) as NonNullable<
      ReturnType<typeof getHubTenantSource>
    >
    expect(reg.details().sealedCopy).toBe(false)
    expect(judgeTenantRegistry(reg.details(), clock).status).toBe('warn')
    await reg.refresh()
    expect(reg.details().sealedCopy).toBe(true)
    expect(judgeTenantRegistry(reg.details(), clock).status).toBe('pass')
  })

  it('every fetch sends redirect: error, a timeout signal and the bearer; the token is never shown', async () => {
    const f = fakeFetch([
      json(goodList()),
      timeoutError,
      () => json({ error: TOKEN }, 401),
      () => json({ token: TOKEN }),
      () => new Error(`connect ECONNREFUSED ${TOKEN}`)
    ])
    const reg = (await start(f.fn)) as NonNullable<ReturnType<typeof getHubTenantSource>>
    const texts: string[] = []
    for (let i = 0; i < 4; i++) {
      await reg.refresh()
      texts.push(reg.status().lastError ?? '')
      clock += 10 * 60_000
      const res = judgeTenantRegistry(reg.details(), clock)
      texts.push(res.detail ?? '', ...(res.blockers ?? []))
    }
    expect(f.calls).toHaveLength(5)
    for (const c of f.calls) {
      expect(c.init.redirect).toBe('error')
      expect(c.init.signal).toBeInstanceOf(AbortSignal)
      expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    }
    const all = `${texts.join('\n')}\n${logged()}`
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain('SECRET')
    expect(texts.some((t) => /did not answer/.test(t))).toBe(true)
  })

  it('an unknown host forces one refresh at most once per 5 s', async () => {
    const f = fakeFetch([json(goodList())])
    const reg = await start(f.fn)
    expect(f.calls).toHaveLength(1)
    expect(await reg.resolve('new.example.com')).toBeNull()
    expect(f.calls).toHaveLength(2)
    clock += 4_000
    expect(await reg.resolve('new.example.com')).toBeNull()
    expect(await reg.resolve('other.example.com')).toBeNull()
    expect(f.calls).toHaveLength(2)
    clock += 1_000
    expect(await reg.resolve('new.example.com')).toBeNull()
    expect(f.calls).toHaveLength(3)
    // a known host never fetches; an empty host never fetches
    clock += 60_000
    await reg.resolve('a.example.com')
    await reg.resolve('')
    expect(f.calls).toHaveLength(3)
  })

  it('a forced refresh finds an app the Hub just added', async () => {
    const added = body([tenant(), tenant({ id: 'fresh', hostnames: ['fresh.example.com'] })])
    const f = fakeFetch([json(goodList()), json(added)])
    const reg = await start(f.fn)
    expect((await reg.resolve('fresh.example.com'))?.tenant.id).toBe('fresh')
  })
})

describe('readiness tenant-registry', () => {
  it('registers once and skips outside a Hub shared deployment', async () => {
    clock = Date.now() // the registered check judges against the real clock
    await start(fakeFetch([json(goodList())]).fn)
    const check = state.checks.find((c) => c.id === 'tenant-registry')!
    expect(check).toBeTruthy()
    expect((await check.run()).status).toBe('pass')
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    delete process.env.HUB_SHARED_DEPLOYMENT
    expect((await check.run()).status).toBe('skip')
    delete process.env.CLOUD_META_DB_URL
    expect((await check.run()).status).toBe('skip')
  })

  it('fail when never loaded, warn after 5 min stale or with dropped apps, pass when current', async () => {
    const down = await start(fakeFetch([() => json({}, 500)]).fn, null)
    const never = judgeTenantRegistry(
      (down as NonNullable<ReturnType<typeof getHubTenantSource>>).details(),
      clock
    )
    expect(never.status).toBe('fail')
    expect(judgeTenantRegistry(null, clock).status).toBe('fail')
    stopHubTenantSource()

    const f = fakeFetch([json(goodList()), () => json({}, 500)])
    const reg = (await start(f.fn)) as NonNullable<ReturnType<typeof getHubTenantSource>>
    expect(judgeTenantRegistry(reg.details(), clock).status).toBe('pass')
    await reg.refresh() // fails; still within 5 min
    expect(judgeTenantRegistry(reg.details(), clock + 4 * 60_000).status).toBe('pass')
    const stale = judgeTenantRegistry(reg.details(), clock + 6 * 60_000)
    expect(stale.status).toBe('warn')
    expect(stale.detail).toMatch(/6 min ago/)
    stopHubTenantSource()

    const dup = await start(
      fakeFetch([
        json(
          body([
            tenant({ id: 'one', hostnames: ['same.example.com'] }),
            tenant({ id: 'two', hostnames: ['same.example.com'] })
          ])
        )
      ]).fn
    )
    const res = judgeTenantRegistry(
      (dup as NonNullable<ReturnType<typeof getHubTenantSource>>).details(),
      clock
    )
    expect(res.status).toBe('warn')
    expect(res.blockers?.join(' ')).toMatch(/2 apps/)
    // readiness is read by app admins: it names no other app
    expect(`${res.detail} ${res.blockers?.join(' ')}`).not.toMatch(/\bone\b|\btwo\b|same\.example/)
  })
})

describe('readiness on an empty list', () => {
  it('warns when the loaded list has no app', async () => {
    const reg = (await start(fakeFetch([json(body([]))]).fn)) as NonNullable<
      ReturnType<typeof getHubTenantSource>
    >
    const res = judgeTenantRegistry(reg.details(), clock)
    expect(res.status).toBe('warn')
    expect(res.detail).toMatch(/lists no app/)
  })
})

describe('blockedPage', () => {
  it('escapes the name and links to no billing page', () => {
    for (const kind of ['suspended', 'provisioning'] as const) {
      const html = blockedPage('<script>alert(1)</script> & Co', kind)
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co')
      expect(html).not.toContain('<script>')
      expect(html.toLowerCase()).not.toContain('billing')
      expect(html).not.toContain('nivaro.dev')
      expect(html).not.toMatch(/https?:\/\//)
    }
  })
})
