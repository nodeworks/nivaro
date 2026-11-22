import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 7: the optional contract fields (origin, encryption_key), the version and
// instance headers on the tenants call, byId/listAll, and the refresh kick channel.

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))

import { INSTANCE_ID } from '../../../services/instance-roster.js'
import {
  DEPLOYMENT_LINK_LABEL,
  deploymentLinkBearer,
  type HubTenantWire,
  parseHubTenants
} from '../../../services/tenancy/hub-contract.js'
import {
  getHubTenantSource,
  resetHubTenantSourceForTests,
  startHubTenantSource
} from '../../../services/tenancy/hub-source.js'
import { NIVARO_VERSION } from '../../../version.js'

const DEPLOYMENT = 'shared-a'
const TOKEN = `hubtok-${'q'.repeat(40)}`
const KEY = 'AB'.repeat(32)

function tenant(over: Partial<HubTenantWire> & Record<string, unknown> = {}): HubTenantWire {
  const id = (over.id as string) ?? 'app-a-e1'
  return {
    id,
    app_key: 'app-a',
    env_key: 'prod',
    name: 'App A',
    status: 'active',
    hostnames: [`${id}.example.com`],
    db: { client: 'pg', connection: `postgres://u:p@db/${id}` },
    ...over
  } as HubTenantWire
}
const body = (tenants: unknown[]) => ({
  data: { deployment: DEPLOYMENT, generated_at: '2026-11-22T00:00:00Z', tenants }
})

describe('parseHubTenants: phase 6 fields', () => {
  it('origin and encryption_key round-trip into the TenantRecord', () => {
    const out = parseHubTenants(
      body([tenant({ origin: 'https://app-a.example.com:8443/some/path', encryption_key: KEY })]),
      DEPLOYMENT
    )
    expect(out?.dropped).toEqual([])
    expect(out?.tenants[0].origin).toBe('https://app-a.example.com:8443')
    expect(out?.tenants[0].encryptionKey).toBe(KEY.toLowerCase())
  })

  it("a bad key drops the tenant with 'bad encryption key'", () => {
    const out = parseHubTenants(
      body([
        tenant({ encryption_key: 'xyz' }),
        tenant({ id: 'app-b-e2', encryption_key: 7 as never })
      ]),
      DEPLOYMENT
    )
    expect(out?.tenants).toEqual([])
    expect(out?.dropped).toEqual([
      { id: 'app-a-e1', why: 'bad encryption key' },
      { id: 'app-b-e2', why: 'bad encryption key' }
    ])
    // the why never holds the key
    expect(JSON.stringify(out)).not.toContain('xyz')
  })

  it('an origin that is not http(s) drops the field only, never the tenant (M19)', () => {
    for (const origin of ['ftp://x.example.com', 'javascript:alert(1)', 'not a url', 42]) {
      const out = parseHubTenants(body([tenant({ origin } as never)]), DEPLOYMENT)
      expect(out?.tenants).toHaveLength(1)
      expect(out?.tenants[0].origin).toBeUndefined()
    }
  })

  it('an old body without the fields still parses unchanged', () => {
    const out = parseHubTenants(body([tenant()]), DEPLOYMENT)
    expect(out?.dropped).toEqual([])
    expect(out?.tenants[0]).not.toHaveProperty('origin')
    expect(out?.tenants[0]).not.toHaveProperty('encryptionKey')
  })
})

describe('deploymentLinkBearer (R7)', () => {
  it('is the hex HMAC-SHA256 of the label keyed by the token, never the token', () => {
    const want = createHmac('sha256', TOKEN).update(DEPLOYMENT_LINK_LABEL).digest('hex')
    expect(DEPLOYMENT_LINK_LABEL).toBe('nivaro-deployment-link')
    expect(deploymentLinkBearer(TOKEN)).toBe(want)
    expect(deploymentLinkBearer(TOKEN)).not.toContain(TOKEN)
  })
})

// ─── the source ────────────────────────────────────────────────────────────────────────────

const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

function fakeFetch(list: () => unknown) {
  const calls: RequestInit[] = []
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {})
    return json(list())
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

/** A Redis whose duplicate() is a subscriber we can push messages into. */
function kickableRedis() {
  const sub = Object.assign(new EventEmitter(), {
    channels: [] as string[],
    subscribe: vi.fn(async (c: string) => {
      sub.channels.push(c)
      return 1
    }),
    quit: vi.fn(async () => 'OK')
  })
  const redis = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    duplicate: vi.fn(() => sub)
  } as unknown as import('ioredis').Redis
  return { redis, sub }
}

const savedEnv = { ...process.env }
let clock = 1_000_000

beforeEach(() => {
  clock = 1_000_000
  process.env.HUB_SHARED_DEPLOYMENT = DEPLOYMENT
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = TOKEN
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
  process.env.REDIS_CHANNEL_PREFIX = 'pfx:'
  delete process.env.CLOUD_META_DB_URL
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  resetHubTenantSourceForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
  process.env = { ...savedEnv }
})

describe('the Hub source, phase 6', () => {
  it('sends X-Nivaro-Version and the per-process X-Nivaro-Instance (B4)', async () => {
    const f = fakeFetch(() => body([tenant()]))
    await startHubTenantSource({ redis: null, fetch: f.fn, now: () => clock })
    const headers = f.calls[0].headers as Record<string, string>
    expect(headers['X-Nivaro-Version']).toBe(NIVARO_VERSION)
    expect(headers['X-Nivaro-Instance']).toBe(INSTANCE_ID)
  })

  it('byId and listAll see every listed app, provisioning and suspended included', async () => {
    const f = fakeFetch(() =>
      body([
        tenant({ encryption_key: KEY }),
        tenant({ id: 'app-b-e2', status: 'provisioning' }),
        tenant({ id: 'app-c-e3', status: 'suspended' })
      ])
    )
    await startHubTenantSource({ redis: null, fetch: f.fn, now: () => clock })
    const src = getHubTenantSource()!
    expect((await src.listAll()).map((t) => t.id)).toEqual(['app-a-e1', 'app-b-e2', 'app-c-e3'])
    expect((await src.listActive()).map((t) => t.id)).toEqual(['app-a-e1'])
    expect((await src.byId('app-b-e2'))?.status).toBe('provisioning')
    expect((await src.byId('app-a-e1'))?.encryptionKey).toBe(KEY.toLowerCase())
    expect(await src.byId('nope')).toBeNull()
  })

  it('a refresh message triggers one fetch; two within 1 s fold into one, then one trailing', async () => {
    vi.useFakeTimers()
    const f = fakeFetch(() => body([tenant()]))
    const { redis, sub } = kickableRedis()
    await startHubTenantSource({ redis, fetch: f.fn, now: () => clock, refreshMs: 3_600_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(sub.channels).toEqual(['pfx:nvr:tenancy:refresh:shared-a'])
    expect(f.fn).toHaveBeenCalledTimes(1) // the boot fetch

    clock += 5_000
    sub.emit('message', 'pfx:nvr:tenancy:refresh:shared-a', '1')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.fn).toHaveBeenCalledTimes(2)

    // a message on another channel is ignored
    sub.emit('message', 'pfx:nvr:other', '1')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.fn).toHaveBeenCalledTimes(2)

    // two more inside the second: nothing at once, ONE refresh at the end of the gap
    clock += 200
    sub.emit('message', 'pfx:nvr:tenancy:refresh:shared-a', '2')
    clock += 100
    sub.emit('message', 'pfx:nvr:tenancy:refresh:shared-a', '3')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.fn).toHaveBeenCalledTimes(2)
    // the gap ends 1 s after the last refresh (800 ms after the first of the two)
    clock += 400
    await vi.advanceTimersByTimeAsync(799)
    expect(f.fn).toHaveBeenCalledTimes(2)
    clock += 400
    await vi.advanceTimersByTimeAsync(1)
    expect(f.fn).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.fn).toHaveBeenCalledTimes(3)
  })

  it('kick() without Redis folds the same way: one at once, one trailing', async () => {
    vi.useFakeTimers()
    const f = fakeFetch(() => body([tenant()]))
    await startHubTenantSource({ redis: null, fetch: f.fn, now: () => clock, refreshMs: 3_600_000 })
    await vi.advanceTimersByTimeAsync(0)
    const src = getHubTenantSource()!
    clock += 5_000
    src.kick()
    src.kick()
    src.kick()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.fn).toHaveBeenCalledTimes(2)
    clock += 1_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.fn).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.fn).toHaveBeenCalledTimes(3)
  })

  it('a kick that meets a fetch already in flight fetches once more after it', async () => {
    let release!: () => void
    let n = 0
    const fn = vi.fn(async () => {
      n++
      if (n === 2) await new Promise<void>((r) => (release = r))
      return json(body([tenant()]))
    }) as unknown as typeof fetch
    await startHubTenantSource({ redis: null, fetch: fn, now: () => clock, refreshMs: 3_600_000 })
    const src = getHubTenantSource()!
    // a timer/unknown-host fetch starts and hangs (it may predate the Hub's change)
    const older = src.refresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(fn).toHaveBeenCalledTimes(2)
    clock += 5_000
    src.kick()
    await new Promise((r) => setTimeout(r, 0))
    expect(fn).toHaveBeenCalledTimes(2) // joined, nothing new yet
    release()
    await older
    await new Promise((r) => setTimeout(r, 0))
    expect(fn).toHaveBeenCalledTimes(3) // one more, started after the kick
    // a second kick while that follow-up was pending did not add another
  })

  it('warns once when the subscriber cannot subscribe', async () => {
    const f = fakeFetch(() => body([tenant()]))
    const { redis, sub } = kickableRedis()
    sub.subscribe.mockRejectedValueOnce(new Error('NOPERM'))
    await startHubTenantSource({ redis, fetch: f.fn, now: () => clock })
    await new Promise((r) => setTimeout(r, 0))
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]))
    expect(warned.filter((w) => w.includes('refresh kicks')).length).toBe(1)
  })

  it('stopping the source closes the subscriber connection', async () => {
    const f = fakeFetch(() => body([tenant()]))
    const { redis, sub } = kickableRedis()
    await startHubTenantSource({ redis, fetch: f.fn, now: () => clock })
    resetHubTenantSourceForTests()
    await new Promise((r) => setTimeout(r, 0))
    expect(sub.quit).toHaveBeenCalledTimes(1)
    clock += 5_000
    sub.emit('message', 'pfx:nvr:tenancy:refresh:shared-a', '1')
    await new Promise((r) => setTimeout(r, 0))
    expect(f.fn).toHaveBeenCalledTimes(1)
  })

  it('details() names the ETag held', async () => {
    const f = {
      fn: vi.fn(
        async () =>
          new Response(JSON.stringify(body([tenant()])), {
            status: 200,
            headers: { etag: '"v7"' }
          })
      ) as unknown as typeof fetch
    }
    await startHubTenantSource({ redis: null, fetch: f.fn, now: () => clock })
    expect(getHubTenantSource()!.details().etag).toBe('"v7"')
  })
})
