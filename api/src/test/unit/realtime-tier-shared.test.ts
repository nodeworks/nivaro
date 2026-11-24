import { readFileSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

/**
 * The realtime tier on a Hub shared deployment: a realtime process (NIVARO_ROLE=realtime) that
 * serves every app the Hub lists, beside a web process with SOCKETS=off. Two apps that are copies
 * of each other (same user ids, same collection and row ids) prove isolation: a stream or socket
 * resolves its app by host, an unknown host is refused, and app A's record changes reach app A's
 * sockets, streams and subscriptions only. Redis is an in-memory pub/sub bus shared by every fake
 * client (as in realtime-tier.test.ts), so the Socket.io Redis adapter really carries the web
 * process's emits to the realtime process's sockets.
 */

// config.ts validates these at import; db/index.ts reads the deployment mode at import (the
// database itself is mocked, test/setup.ts).
vi.hoisted(() => {
  for (const [k, v] of Object.entries({
    DB_HOST: 'localhost',
    DB_DATABASE: 'nivaro_test',
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    SESSION_SECRET: 'realtime-shared-test-secret-0123456789abcdef',
    LOG_LEVEL: 'silent'
  }))
    process.env[k] ||= v
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-rt'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
  process.env.REDIS_CHANNEL_PREFIX = 'rt-shared-test:'
})

const bus = vi.hoisted(() => {
  const { EventEmitter } = require('node:events') as typeof import('node:events')
  const clients = new Set<any>()
  /** One key space for every client (string values only; TTLs are not modelled). */
  const kv = new Map<string, string>()
  const zsets = new Map<string, Map<string, number>>()
  const hashes = new Map<string, Map<string, number>>()
  /** Anything not modelled: a chainable, awaitable no-op (resolves to null). */
  const noop: any = new Proxy(() => {}, {
    get: (_t, k) =>
      k === 'then'
        ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(null).then(res, rej)
        : noop,
    apply: () => noop
  })
  /** Absent on the fake: node-redis v4 / cluster probes (so the adapter takes its ioredis path)
   *  and `getter`/`setter` (Fastify's decorate would read a function there as an accessor). */
  const ABSENT = new Set([
    'getter',
    'setter',
    'pSubscribe',
    'pUnsubscribe',
    'sSubscribe',
    'sendCommand',
    'isCluster',
    'nodes'
  ])
  class BusClient extends EventEmitter {
    options: Record<string, unknown>
    status = 'ready'
    patterns = new Set<string>()
    channels = new Set<string>()
    constructor(opts?: Record<string, unknown>) {
      super()
      this.options = { ...(opts ?? {}) }
      clients.add(this)
    }
    duplicate() {
      return new FakeRedis(this.options)
    }
    async psubscribe(...p: Array<string | string[]>) {
      for (const x of p.flat()) this.patterns.add(x)
      return p.flat().length
    }
    async subscribe(...c: Array<string | string[]>) {
      for (const x of c.flat()) if (typeof x === 'string') this.channels.add(x)
      return c.flat().length
    }
    async punsubscribe(...p: string[]) {
      if (p.length === 0) this.patterns.clear()
      for (const x of p) this.patterns.delete(x)
    }
    async unsubscribe(...c: string[]) {
      if (c.length === 0) this.channels.clear()
      for (const x of c) this.channels.delete(x)
    }
    async set(key: string, value: string) {
      kv.set(key, value)
      return 'OK'
    }
    async del(...keys: string[]) {
      for (const k of keys) {
        kv.delete(k)
        zsets.delete(k)
      }
      return keys.length
    }
    async mget(...keys: Array<string | string[]>) {
      return keys.flat().map((k) => kv.get(k) ?? null)
    }
    async zadd(key: string, score: number, member: string) {
      const z = zsets.get(key) ?? new Map<string, number>()
      z.set(member, Number(score))
      zsets.set(key, z)
      return 1
    }
    async zrem(key: string, member: string) {
      return zsets.get(key)?.delete(member) ? 1 : 0
    }
    async zrangebyscore(key: string, min: number | string, max: number | string) {
      const lo = min === '-inf' ? -Infinity : Number(min)
      const hi = max === '+inf' ? Infinity : Number(max)
      return [...(zsets.get(key) ?? new Map<string, number>())]
        .filter(([, sc]) => sc >= lo && sc <= hi)
        .map(([m]) => m)
    }
    async zremrangebyscore(key: string, min: number | string, max: number | string) {
      const gone = await this.zrangebyscore(key, min, max)
      for (const m of gone) zsets.get(key)?.delete(m)
      return gone.length
    }
    async pexpire() {
      return 1
    }
    async get(key: string) {
      return kv.get(key) ?? null
    }
    async getdel(key: string) {
      const v = kv.get(key) ?? null
      kv.delete(key)
      return v
    }
    async setex(key: string, _ttl: number, value: string) {
      kv.set(key, value)
      return 'OK'
    }
    async incr(key: string) {
      const n = Number(kv.get(key) ?? 0) + 1
      kv.set(key, String(n))
      return n
    }
    async hincrby(key: string, field: string, by: number) {
      const h = hashes.get(key) ?? new Map<string, number>()
      h.set(field, (h.get(field) ?? 0) + Number(by))
      hashes.set(key, h)
      return h.get(field)
    }
    async hgetall(key: string) {
      return Object.fromEntries(
        [...(hashes.get(key) ?? new Map<string, number>())].map(([f, n]) => [f, String(n)])
      )
    }
    /** MULTI / pipeline: the modelled commands run in order at exec; the rest answer null. */
    multi() {
      const queued: Array<() => Promise<unknown>> = []
      const self = this as any
      const chain: any = new Proxy(
        {},
        {
          get: (_t, k) => {
            if (k === 'exec')
              return async () => {
                const out: Array<[null, unknown]> = []
                for (const q of queued) out.push([null, await q()])
                return out
              }
            if (k === 'then') return undefined
            return (...args: unknown[]) => {
              const fn = typeof k === 'string' ? self[k] : undefined
              queued.push(async () =>
                typeof fn === 'function' && k !== 'multi' && k !== 'pipeline'
                  ? fn.apply(self, args)
                  : null
              )
              return chain
            }
          }
        }
      )
      return chain
    }
    pipeline() {
      return this.multi()
    }
    async publish(channel: string, msg: string | Buffer) {
      const m = Buffer.isBuffer(msg) ? msg : Buffer.from(msg)
      let n = 0
      for (const c of clients) {
        for (const p of c.patterns as Set<string>) {
          if (p.endsWith('*') && channel.startsWith(p.slice(0, -1))) {
            n++
            setImmediate(() => c.emit('pmessageBuffer', Buffer.from(p), Buffer.from(channel), m))
          }
        }
        if ((c.channels as Set<string>).has(channel)) {
          n++
          setImmediate(() => c.emit('messageBuffer', Buffer.from(channel), m))
          // ioredis's string form too (item events and the journal fallback listen on it).
          setImmediate(() => c.emit('message', channel, m.toString()))
        }
      }
      return n
    }
    /** PUBSUB NUMSUB, as the adapter's serverCount() asks it (callback style). */
    send_command(_cmd: string, args: string[], cb?: (err: unknown, res: unknown) => void) {
      const channel = args[1]
      let n = 0
      for (const c of clients) if ((c.channels as Set<string>).has(channel)) n++
      cb?.(null, [channel, n])
      return Promise.resolve([channel, n])
    }
    async ping() {
      return 'PONG'
    }
    async quit() {
      clients.delete(this)
      return 'OK'
    }
    disconnect() {
      clients.delete(this)
    }
  }
  /** `new FakeRedis()` — a bus client whose unmodelled commands are no-ops. */
  const FakeRedis = function FakeRedis(opts?: Record<string, unknown>) {
    return new Proxy(new BusClient(opts), {
      get(t, k, r) {
        if (k in t) return Reflect.get(t, k, r)
        if (typeof k === 'string' && ABSENT.has(k)) return undefined
        return noop
      }
    })
  } as unknown as new (
    opts?: Record<string, unknown>
  ) => any
  return { FakeRedis, clients, kv, hashes, zsets }
})

vi.mock('ioredis', () => ({ Redis: bus.FakeRedis, default: bus.FakeRedis }))
vi.mock('../../plugins/redis.js', async () => {
  const fp = (await import('fastify-plugin')).default
  return {
    redisPlugin: fp(async (app: FastifyInstance) => {
      app.decorate('redis', new bus.FakeRedis({ db: 9 }) as never)
    })
  }
})

/** What ran inside which app (the tenant context at the call). */
const seen = vi.hoisted(() => ({ calls: [] as Array<[string, string | null]> }))
const hub = vi.hoisted(() => ({ started: 0, stopped: 0 }))

// The Hub's list: the test registry below (setTenantRegistryForTests); no Hub is called.
vi.mock('../../services/tenancy/hub-source.js', async (orig) => ({
  ...(await orig<typeof import('../../services/tenancy/hub-source.js')>()),
  startHubTenantSource: vi.fn(async () => {
    hub.started++
  }),
  stopHubTenantSource: vi.fn(() => {
    hub.stopped++
  }),
  getHubTenantSource: () => null
}))
// Each app's pool: a tagged object (no driver); the request context still carries it.
vi.mock('../../db/tenant-context.js', async (orig) => ({
  ...(await orig<typeof import('../../db/tenant-context.js')>()),
  getOrCreateTenantPool: (conn: string) => ({ __conn: conn }) as never
}))
// The identity behind a stream ticket, read inside the app the request resolved to.
vi.mock('../../services/socket-access.js', async (orig) => {
  const { getTenantId } = await import('../../db/tenant-context.js')
  return {
    ...(await orig<typeof import('../../services/socket-access.js')>()),
    checkBind: vi.fn(async () => {
      seen.calls.push(['checkBind', getTenantId() ?? null])
      return null
    })
  }
})
vi.mock('../../services/stream-ticket.js', async (orig) => {
  const { getTenantId } = await import('../../db/tenant-context.js')
  const real = await orig<typeof import('../../services/stream-ticket.js')>()
  const identity = { user: { id: 'u-1', role: null } as never, isAdmin: true }
  return {
    ...real,
    loadStreamIdentity: vi.fn(async () => {
      seen.calls.push(['identity', getTenantId() ?? null])
      return identity
    }),
    recheckStreamIdentity: vi.fn(async () => ({ identity, reason: null }))
  }
})
vi.mock('../../services/permissions.js', async (orig) => {
  const { getTenantId } = await import('../../db/tenant-context.js')
  return {
    ...(await orig<typeof import('../../services/permissions.js')>()),
    can: vi.fn(async () => {
      seen.calls.push(['can', getTenantId() ?? null])
      return true
    })
  }
})
// Background loops that would spin against the fake (stream reads, pollers, probes).
vi.mock('../../services/event-stream.js', async (orig) => ({
  ...(await orig<typeof import('../../services/event-stream.js')>()),
  initEventStream: vi.fn(async () => {}),
  closeEventStream: vi.fn(async () => {})
}))
vi.mock('../../services/event-journal.js', async (orig) => ({
  ...(await orig<typeof import('../../services/event-journal.js')>()),
  alignJournalSequence: vi.fn(async () => {}),
  flushJournal: vi.fn(async () => {})
}))
vi.mock('../../services/traffic-map.js', async (orig) => ({
  ...(await orig<typeof import('../../services/traffic-map.js')>()),
  startTrafficMapEmitter: vi.fn(() => () => {})
}))
vi.mock('../../services/runtime-monitor.js', async (orig) => ({
  ...(await orig<typeof import('../../services/runtime-monitor.js')>()),
  startRuntimeMonitor: vi.fn()
}))
vi.mock('../../db/config-epoch.js', async (orig) => ({
  ...(await orig<typeof import('../../db/config-epoch.js')>()),
  startEpochWatch: vi.fn(),
  stopEpochWatch: vi.fn()
}))
vi.mock('../../services/instance-roster.js', async (orig) => ({
  ...(await orig<typeof import('../../services/instance-roster.js')>()),
  startInstanceRoster: vi.fn()
}))
vi.mock('../../services/pool-attribution.js', async (orig) => ({
  ...(await orig<typeof import('../../services/pool-attribution.js')>()),
  startPoolAttribution: vi.fn()
}))
vi.mock('../../services/db-health.js', async (orig) => ({
  ...(await orig<typeof import('../../services/db-health.js')>()),
  startDbHealthProbe: vi.fn(),
  isDbHealthy: () => true
}))
vi.mock('../../services/socket-health.js', async (orig) => ({
  ...(await orig<typeof import('../../services/socket-health.js')>()),
  startSocketHealth: vi.fn()
}))
// The GraphQL schema the subscriptions run on is built per app on first use (never at boot here).
const schemaBuilds = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../services/schema-builder.js', async (orig) => ({
  ...(await orig<typeof import('../../services/schema-builder.js')>()),
  schemaInputsFingerprint: vi.fn(async () => {
    schemaBuilds.n++
    return 'x'
  })
}))

import type { TenantRecord, TenantRegistry } from '../../services/tenancy/types.js'

const rec = (id: string, host: string, over: Partial<TenantRecord> = {}): TenantRecord => ({
  id,
  slug: id,
  name: `App ${id}`,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://db-${id}`,
  poolMax: null,
  hostnames: [host],
  ...over
})

/** Two copies (same user and row ids), one not migrated yet, one in the Hub's maintenance. */
const APPS: TenantRecord[] = [
  rec('app-a', 'a.example.com'),
  rec('app-b', 'b.example.com'),
  rec('app-c', 'c.example.com'),
  rec('app-m', 'm.example.com', { status: 'maintenance', name: 'Moving App' })
]
const registry: TenantRegistry = {
  source: 'hub',
  async resolve(host) {
    const t = APPS.find((a) => a.hostnames.includes(host.split(':')[0]))
    return t ? { tenant: t, origin: `https://${t.hostnames[0]}` } : null
  },
  async listActive() {
    return APPS.filter((a) => a.status === 'active')
  },
  async listAll() {
    return APPS
  },
  status: () => ({
    source: 'hub',
    count: APPS.length,
    loadedAt: '2026-11-23T00:00:00.000Z',
    stale: false,
    lastError: null
  })
}

/** Open an engine.io v4 websocket as `host` and connect to the main namespace. */
function connect(
  port: number,
  host: string
): Promise<{ ws: WebSocket; events: Array<[string, unknown]> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, {
      headers: { host }
    })
    const events: Array<[string, unknown]> = []
    const timer = setTimeout(() => reject(new Error('socket.io handshake timed out')), 5000)
    ws.on('error', reject)
    ws.on('message', (raw) => {
      const msg = raw.toString()
      if (msg.startsWith('0')) ws.send('40')
      else if (msg === '2') ws.send('3')
      else if (msg.startsWith('40')) {
        clearTimeout(timer)
        resolve({ ws, events })
      } else if (msg.startsWith('42')) events.push(JSON.parse(msg.slice(2)) as [string, unknown])
    })
  })
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** An SSE stream opened as `host`: its status and everything it wrote so far. */
function openStream(
  port: number,
  host: string,
  path: string
): Promise<{ status: number; body: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    let text = ''
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host, accept: 'text/event-stream' }
      },
      (res: IncomingMessage) => {
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          text += c
        })
        res.on('error', () => {})
        resolve({ status: res.statusCode ?? 0, body: () => text, close: () => req.destroy() })
      }
    )
    req.on('error', (err) => {
      if ((err as { code?: string }).code !== 'ECONNRESET') reject(err)
    })
    req.end()
  })
}

/** A one-shot stream ticket as GET /api/events/ticket mints it, in app `tenant`. */
function putTicket(tenant: string): string {
  const id = crypto.randomUUID()
  bus.kv.set(
    `sse:ticket:${id}`,
    JSON.stringify({ u: 'u-1', b: { kind: 'session', sid: `s-${tenant}` }, t: tenant })
  )
  return id
}

describe('realtime tier on a Hub shared deployment (NIVARO_ROLE=realtime, many apps)', () => {
  let realtime: FastifyInstance
  let web: FastifyInstance
  let realtimePort = 0
  const saved = { role: process.env.NIVARO_ROLE, sockets: process.env.SOCKETS }

  beforeAll(async () => {
    const { setTenantRegistryForTests } = await import('../../services/tenancy/registry.js')
    setTenantRegistryForTests(registry)
    // The migrating web / worker processes stored A and B as migrated at this version; C is not.
    const { appConnFingerprint, appSchemaKey } = await import(
      '../../services/tenancy/app-migrations.js'
    )
    const { NIVARO_VERSION } = await import('../../version.js')
    for (const t of APPS.filter((a) => a.id !== 'app-c'))
      bus.kv.set(
        appSchemaKey(t.id),
        JSON.stringify({
          version: NIVARO_VERSION,
          state: 'ok',
          at: '2026-11-23T00:00:00.000Z',
          error: null,
          conn: appConnFingerprint(t)
        })
      )

    process.env.NIVARO_ROLE = 'realtime'
    delete process.env.SOCKETS
    const { buildRealtimeServer } = await import('../../realtime-server.js')
    realtime = await buildRealtimeServer()
    await realtime.listen({ port: 0, host: '127.0.0.1' })
    realtimePort = (realtime.server.address() as AddressInfo).port
    const { markBootReady } = await import('../../services/boot-phases.js')
    markBootReady()
    const { appReadyForRequests } = await import('../../services/tenancy/app-migrations.js')
    await waitFor(() => appReadyForRequests('app-a') && appReadyForRequests('app-b'))

    // A web process of the same shared deployment with SOCKETS=off (the large stack's web role).
    process.env.NIVARO_ROLE = 'web'
    process.env.SOCKETS = 'off'
    const { socketioPlugin } = await import('../../plugins/socketio.js')
    web = fastify({ logger: false })
    web.decorate('redis', new bus.FakeRedis({ db: 9 }) as never)
    await web.register(socketioPlugin)
    await web.listen({ port: 0, host: '127.0.0.1' })
  }, 30_000)

  afterAll(async () => {
    await web?.close()
    await realtime?.close()
    const { setTenantRegistryForTests } = await import('../../services/tenancy/registry.js')
    setTenantRegistryForTests(null)
    if (saved.role === undefined) delete process.env.NIVARO_ROLE
    else process.env.NIVARO_ROLE = saved.role
    if (saved.sockets === undefined) delete process.env.SOCKETS
    else process.env.SOCKETS = saved.sockets
  })

  it('boots on a shared deployment: the Hub list, the realtime routes only, the board, no schema poll', async () => {
    const { servedRealtimeRoutes } = await import('../../realtime-server.js')
    const { REALTIME_HTTP_ROUTES } = await import('../../services/process-role.js')
    expect([...servedRealtimeRoutes()].sort()).toEqual([...REALTIME_HTTP_ROUTES].sort())
    expect(hub.started).toBe(1)
    // The realtime board runs (the SOCKETS=off web processes' emit gates read its room counts),
    // in a slot that names the shared deployment.
    await waitFor(() =>
      [...bus.zsets.keys()].some((k) => k.startsWith('nvr:rt:board:') && k.includes('@shared-rt:'))
    )
    // No schema fingerprint against a default database that does not exist.
    expect(schemaBuilds.n).toBe(0)
    // The process migrates nothing: the app that is not migrated stays not ready.
    const { appReadyForRequests, appSchemaStatus } = await import(
      '../../services/tenancy/app-migrations.js'
    )
    expect(appReadyForRequests('app-c')).toBe(false)
    expect(appSchemaStatus('app-c').state).toBe('pending')
  })

  it('answers /api/ready about the process, with no app and no default database', async () => {
    const res = await realtime.inject({ method: 'GET', url: '/api/ready' })
    expect(res.statusCode).toBe(200)
    const db = (res.json().checks as Array<{ id: string; ok: boolean; summary: string }>).find(
      (c) => c.id === 'database'
    )
    expect(db).toMatchObject({ ok: true })
    expect(db?.summary).toMatch(/each app brings its own database/i)
  })

  it('resolves the app per request host: A is A, B is B, an unknown host is refused', async () => {
    const a = await realtime.inject({ url: '/api/version', headers: { host: 'a.example.com' } })
    const b = await realtime.inject({ url: '/api/version', headers: { host: 'b.example.com' } })
    expect(a.statusCode).toBe(200)
    expect(a.json()).toMatchObject({
      role: 'realtime',
      tenant: 'app-a',
      shared_deployment: 'shared-rt'
    })
    expect(b.json()).toMatchObject({ tenant: 'app-b' })
    expect(a.headers['x-nivaro-role']).toBe('realtime')
    for (const url of ['/api/version', '/api/events/ticket', '/api/events/stream']) {
      const nope = await realtime.inject({ url, headers: { host: 'nope.example.com' } })
      expect(nope.statusCode).toBe(404)
      expect(nope.json()).toMatchObject({ message: 'No app is served at this address.' })
    }
    // A known app: the stream ticket asks for a sign-in inside that app.
    const ticket = await realtime.inject({
      url: '/api/events/ticket',
      headers: { host: 'a.example.com' }
    })
    expect(ticket.statusCode).toBe(401)
  })

  it('answers "getting ready" and "being updated" for an app not migrated or in maintenance', async () => {
    const c = await realtime.inject({
      url: '/api/events/stream',
      headers: { host: 'c.example.com' }
    })
    expect(c.statusCode).toBe(503)
    expect(c.json()).toMatchObject({ code: 'APP_NOT_READY' })
    const m = await realtime.inject({
      url: '/api/events/ticket',
      headers: { host: 'm.example.com' }
    })
    expect(m.statusCode).toBe(503)
    expect(m.json()).toMatchObject({ code: 'APP_MAINTENANCE' })
    // Once the migrating processes store C as migrated, this process follows.
    const { appConnFingerprint, appSchemaKey, appReadyForRequests } = await import(
      '../../services/tenancy/app-migrations.js'
    )
    const { NIVARO_VERSION } = await import('../../version.js')
    const appC = APPS[2]
    bus.kv.set(
      appSchemaKey(appC.id),
      JSON.stringify({
        version: NIVARO_VERSION,
        state: 'ok',
        at: null,
        conn: appConnFingerprint(appC)
      })
    )
    await realtime.inject({ url: '/api/events/stream', headers: { host: 'c.example.com' } })
    await waitFor(() => appReadyForRequests('app-c'), 3000)
    const ready = await realtime.inject({ url: '/api/version', headers: { host: 'c.example.com' } })
    expect(ready.json()).toMatchObject({ tenant: 'app-c' })
    bus.kv.delete(appSchemaKey(appC.id))
  })

  it('a stream ticket opens a stream only on the app it was minted in', async () => {
    seen.calls.length = 0
    // Minted in A, presented on B's host: refused (and spent).
    const crossed = await realtime.inject({
      url: `/api/events/stream?ticket=${putTicket('app-a')}`,
      headers: { host: 'b.example.com' }
    })
    expect(crossed.statusCode).toBe(401)
    expect(seen.calls.filter(([k]) => k === 'identity')).toEqual([])
    // Minted in A, presented on A's host: the stream opens, its identity read inside A.
    const s = await openStream(
      realtimePort,
      'a.example.com',
      `/api/events/stream?ticket=${putTicket('app-a')}`
    )
    try {
      expect(s.status).toBe(200)
      await waitFor(() => s.body().includes(': connected'))
      expect(seen.calls).toContainEqual(['identity', 'app-a'])
      expect(seen.calls).toContainEqual(['checkBind', 'app-a'])
    } finally {
      s.close()
    }
  })

  it("delivers app A's record changes to A's SSE streams only (copies with the same ids)", async () => {
    const { receiveJournalFallback } = await import('../../services/event-journal.js')
    const sa = await openStream(
      realtimePort,
      'a.example.com',
      `/api/events/stream?ticket=${putTicket('app-a')}`
    )
    const sb = await openStream(
      realtimePort,
      'b.example.com',
      `/api/events/stream?ticket=${putTicket('app-b')}`
    )
    try {
      await waitFor(() => sa.body().includes(': connected') && sb.body().includes(': connected'))
      seen.calls.length = 0
      // A web process of app A wrote orders/7; the journal entry reaches this process remotely.
      const entry = (tenant: string, n: number) =>
        JSON.stringify({
          node: 'web-1',
          at: Date.now(),
          entry: {
            seq: n,
            room: `t:${tenant}:collection:orders`,
            event: 'collection:update',
            payload: { collection: 'orders', item: 7, action: 'update', changed_fields: [`f${n}`] }
          }
        })
      receiveJournalFallback(entry('app-a', 1))
      await waitFor(() => sa.body().includes('"changed_fields":["f1"]'))
      await sleep(100)
      expect(sb.body()).not.toContain('f1')
      // The permission check ran inside A (the stream's own app), never B.
      expect(seen.calls.filter(([k]) => k === 'can').map(([, t]) => t)).toEqual(['app-a'])
      // B's write of the same row id reaches B only.
      receiveJournalFallback(entry('app-b', 2))
      await waitFor(() => sb.body().includes('"changed_fields":["f2"]'))
      await sleep(100)
      expect(sa.body()).not.toContain('f2')
    } finally {
      sa.close()
      sb.close()
    }
  })

  it("delivers app A's emits from a SOCKETS=off web process to A's sockets only", async () => {
    const { setIo } = await import('../../services/io-holder.js')
    const { journaledEmit, setJournalRedis } = await import('../../services/event-journal.js')
    const { runWithTenantDb } = await import('../../db/tenant-context.js')
    const { tenantScopedRoom } = await import('../../services/tenant-rooms.js')
    // The web process serves no /socket.io on a shared deployment with SOCKETS=off.
    const w = await fetch(
      `http://127.0.0.1:${(web.server.address() as AddressInfo).port}/socket.io/?EIO=4&transport=polling`
    )
    expect(w.status).toBe(404)

    const before = new Set(realtime.io.sockets.sockets.keys())
    const A = await connect(realtimePort, 'a.example.com')
    const B = await connect(realtimePort, 'b.example.com')
    const X = await connect(realtimePort, 'nope.example.com')
    const C = await connect(realtimePort, 'm.example.com')
    try {
      await waitFor(() => realtime.io.sockets.sockets.size >= before.size + 4)
      const mine = [...realtime.io.sockets.sockets.values()].filter((s) => !before.has(s.id))
      await waitFor(() => mine.filter((s) => typeof s.data.nvrTenantKey === 'string').length >= 2)
      await sleep(100)
      // Each socket resolved its own app from the handshake host; unknown / blocked: none.
      const keys = mine.map((s) => s.data.nvrTenantKey ?? null).sort()
      expect(keys).toEqual([null, null, 'app-a', 'app-b'].sort())
      // Signed in (as the auth handler leaves it) and watching orders, each under its own app —
      // the room the socket plugin's subscribe joins (scopedRoom).
      for (const s of mine) {
        s.data.nvrAccess = { user: () => ({ id: 'u-1' }), applyUser() {}, leaveRoom() {} }
        const key = s.data.nvrTenantKey
        if (typeof key === 'string') s.join(tenantScopedRoom('collection:orders', key))
      }
      setIo(web.io as never)
      setJournalRedis(web.redis as never)
      const emitIn = (tenant: string, n: number) =>
        new Promise<void>((resolve, reject) =>
          runWithTenantDb(
            {} as never,
            tenant,
            () => {
              journaledEmit('collection:orders', 'collection:update', {
                collection: 'orders',
                item: 7,
                changed_fields: [`g${n}`]
              }).then(() => resolve(), reject)
            },
            tenant
          )
        )
      await emitIn('app-a', 1)
      const got = (e: Array<[string, unknown]>, n: number) =>
        e.some(([ev, p]) => ev === 'collection:update' && JSON.stringify(p).includes(`"g${n}"`))
      await waitFor(() => got(A.events, 1))
      await emitIn('app-b', 2)
      await waitFor(() => got(B.events, 2))
      await sleep(150)
      expect(got(B.events, 1)).toBe(false)
      expect(got(A.events, 2)).toBe(false)
      for (const other of [X, C]) {
        expect(got(other.events, 1)).toBe(false)
        expect(got(other.events, 2)).toBe(false)
      }
    } finally {
      setIo(realtime.io as never)
      for (const s of [A, B, X, C]) s.ws.close()
    }
  })

  it("carries app-scoped room counts on the board: A's watchers wake A's emits only (copies)", async () => {
    const board = await import('../../services/realtime-board.js')
    const sock = await import('../../plugins/socketio.js')
    const { setIo } = await import('../../services/io-holder.js')
    const { withTenant } = await import('../../db/tenant-context.js')
    const { tenantScopedRoom } = await import('../../services/tenant-rooms.js')
    const { emitAiCallLive } = await import('../../services/ai-quality.js')
    const inApp = <T>(id: string, fn: () => T | Promise<T>) =>
      withTenant(
        { id, slug: id, dbClient: 'pg', dbConnection: `postgres://db-${id}`, poolMax: null },
        async () => fn()
      )
    const before = new Set(realtime.io.sockets.sockets.keys())
    const A = await connect(realtimePort, 'a.example.com')
    const B = await connect(realtimePort, 'b.example.com')
    try {
      await waitFor(() => realtime.io.sockets.sockets.size >= before.size + 2)
      const mine = [...realtime.io.sockets.sockets.values()].filter((s) => !before.has(s.id))
      await waitFor(() => mine.every((s) => typeof s.data.nvrTenantKey === 'string'))
      const sa = mine.find((s) => s.data.nvrTenantKey === 'app-a')
      const sb = mine.find((s) => s.data.nvrTenantKey === 'app-b')
      if (!sa || !sb) throw new Error('sockets did not resolve their apps')
      // The same person (copies share user ids) on a different page in each app; an admin of A
      // watches the live AI calls; each app has a different collection open.
      for (const [s, app, path, coll] of [
        [sa, 'app-a', '/collections/orders', 'orders'],
        [sb, 'app-b', '/users', 'invoices']
      ] as const) {
        s.data[board.PAGE_AT_KEY] = {
          user: { id: 'u-1', name: 'Ada' },
          path,
          since: 1000,
          app: 'admin',
          tenant: app
        }
        s.join(tenantScopedRoom(`collection:${coll}`, app))
      }
      sa.join(tenantScopedRoom('watch:ai-calls', 'app-a'))

      // The realtime process publishes; the SOCKETS=off web process reads (one test process).
      board.startBoardPublisher(realtime.redis as never, sock.localBoardCollector(realtime.io))
      board.startBoardReader(web.redis as never, { includeOwn: true })
      await waitFor(() => board.boardFresh() && board.boardStats().length > 0)

      // Emit gates: A's watch room has a listener, B's (same name in its own app) none.
      expect(board.roomListeners(web.io, 't:app-a:watch:ai-calls')).toBeGreaterThanOrEqual(1)
      expect(board.roomListeners(web.io, 't:app-b:watch:ai-calls')).toBe(0)
      // ...so a call made in A reaches A's watcher from the web process; one in B is dropped.
      setIo(web.io as never)
      const call = (feature: string) => ({
        id: feature,
        at: new Date().toISOString(),
        feature,
        model: 'm',
        provider: 'p',
        user: null,
        status: 'ok' as const,
        latency_ms: 1,
        cost_usd: null,
        input_tokens: null,
        output_tokens: null
      })
      await inApp('app-a', () => emitAiCallLive(call('in-a') as never))
      await inApp('app-b', () => emitAiCallLive(call('in-b') as never))
      const heard = (e: Array<[string, unknown]>, f: string) =>
        e.some(([ev, p]) => ev === 'ai:call' && (p as { feature?: string }).feature === f)
      await waitFor(() => heard(A.events, 'in-a'))
      await sleep(150)
      expect(heard(A.events, 'in-b')).toBe(false)
      expect(heard(B.events, 'in-a')).toBe(false)
      expect(heard(B.events, 'in-b')).toBe(false)

      // Page presence and live collections per app, never the copy's.
      expect(await inApp('app-a', () => sock.usersOnPath('/collections/orders'))).toHaveLength(1)
      expect(await inApp('app-a', () => sock.usersOnPath('/users'))).toEqual([])
      expect(await inApp('app-b', () => sock.usersOnPath('/users'))).toHaveLength(1)
      expect([...(sock.getLiveCollectionNames('app-a') ?? [])]).toEqual(['orders'])
      expect([...(sock.getLiveCollectionNames('app-b') ?? [])]).toEqual(['invoices'])
      // No app named on a shared deployment: "cannot tell", never every app's collections.
      expect(sock.getLiveCollectionNames()).toBeNull()

      // The socket list and rooms from the board: the caller's app only; none outside an app.
      const statsA = await inApp('app-a', () => sock.getRealtimeStats())
      expect(statsA.sockets.map((s) => s.id)).toContain(sa.id)
      expect(statsA.sockets.map((s) => s.id)).not.toContain(sb.id)
      expect(statsA.rooms.every((r) => r.room.startsWith('t:app-a:'))).toBe(true)
      expect(sock.getRealtimeStats().sockets).toEqual([])

      // Answers keyed by a user id alone stay off: copies share u-1.
      expect(board.boardHasUser('u-1')).toBe(false)
      expect(await inApp('app-a', () => sock.isUserConnected('u-1'))).toBeNull()
    } finally {
      setIo(realtime.io as never)
      board.resetBoard()
      for (const s of [A, B]) s.ws.close()
    }
  })

  it('starts the board on every process of a shared deployment, never on Nivaro Cloud', async () => {
    const { realtimeBoardRuns } = await import('../../services/process-role.js')
    expect(realtimeBoardRuns()).toBe(true)
    expect(realtimeBoardRuns({ HUB_SHARED_DEPLOYMENT: 'shared-rt' })).toBe(true)
    expect(realtimeBoardRuns({})).toBe(true)
    expect(realtimeBoardRuns({ CLOUD_META_DB_URL: 'postgres://meta' })).toBe(false)
    // The web / worker processes (server.ts) start it on the same predicate.
    const src = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), '../../server.ts'),
      'utf8'
    )
    expect(src).toMatch(/if \(realtimeBoardRuns\(\) && app\.redis\) \{\s*const \{ startBoard \}/)
  })

  it('publishes no bare user ids on a shared deployment, and reads none', async () => {
    const board = await import('../../services/realtime-board.js')
    const sock = await import('../../plugins/socketio.js')
    try {
      expect(sock.localBoardCollector(realtime.io).live().users).toEqual([])
      // An entry that carries some (an older or misconfigured publisher) is not believed.
      board.setBoardsForTests([
        {
          node: 'other',
          at: Date.now(),
          sockets: 1,
          users: ['u-1'],
          viewers: {},
          pages: []
        }
      ])
      expect(board.boardAnswersUsers()).toBe(false)
      expect(board.boardHasUser('u-1')).toBe(false)
      expect(board.boardConcurrency({ sockets: 0, users: [] })).toEqual({ sockets: 1, users: 0 })
      // Self-hosted the same entry answers, as before.
      const key = process.env.HUB_SHARED_DEPLOYMENT
      delete process.env.HUB_SHARED_DEPLOYMENT
      try {
        expect(board.boardHasUser('u-1')).toBe(true)
        expect(board.boardConcurrency({ sockets: 0, users: [] })).toEqual({ sockets: 1, users: 1 })
      } finally {
        process.env.HUB_SHARED_DEPLOYMENT = key
      }
    } finally {
      board.resetBoard()
    }
  })

  it("delivers app A's record events to A's GraphQL subscriptions only", async () => {
    const { pubsub, topics } = await import('../../graphql/pubsub.js')
    const heard: string[] = []
    const offA = pubsub.on(topics.itemMutated('orders', '*', 'app-a'), () => heard.push('a'))
    const offB = pubsub.on(topics.itemMutated('orders', '*', 'app-b'), () => heard.push('b'))
    try {
      // A web process of app A wrote orders/7: its item event arrives on the Redis channel.
      await new bus.FakeRedis().publish(
        'rt-shared-test:nvr:item-events',
        JSON.stringify({
          node: 'web-1',
          ev: {
            collection: 'orders',
            item: '7',
            action: 'update',
            changed_fields: ['x'],
            at: new Date().toISOString(),
            tenant: 'app-a'
          }
        })
      )
      await waitFor(() => heard.length > 0)
      await sleep(50)
      expect(heard).toEqual(['a'])
    } finally {
      offA()
      offB()
    }
  })

  it('refuses NIVARO_ROLE=realtime on Nivaro Cloud only (realtime-server and index.ts)', async () => {
    const { buildRealtimeServer } = await import('../../realtime-server.js')
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    try {
      await expect(buildRealtimeServer()).rejects.toThrow(/not available on Nivaro Cloud/)
    } finally {
      delete process.env.CLOUD_META_DB_URL
    }
    // index.ts refuses with the same predicate, and no longer on any multi-tenant deployment.
    const src = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), '../../index.ts'),
      'utf8'
    )
    expect(src).toMatch(/const realtimeProblem = realtime \? realtimeRoleProblem\(\) : null/)
    expect(src).not.toMatch(/realtime && isMultiTenant\(\)/)
  })
})
