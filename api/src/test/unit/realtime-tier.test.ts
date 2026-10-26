import type { AddressInfo } from 'node:net'
import fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

/**
 * Post-mortem 3.3 — the realtime tier. Two processes in one test: a realtime server
 * (NIVARO_ROLE=realtime, listening) and a web process with SOCKETS=off. Redis is an in-memory
 * pub/sub bus shared by every fake client, so the Socket.io Redis adapter really carries the web
 * process's emits to the realtime process's sockets.
 */

// config.ts validates these at import; the database itself is mocked (test/setup.ts).
vi.hoisted(() => {
  for (const [k, v] of Object.entries({
    DB_HOST: 'localhost',
    DB_DATABASE: 'nivaro_test',
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    SESSION_SECRET: 'realtime-tier-test-secret-0123456789abcdef',
    LOG_LEVEL: 'silent'
  }))
    process.env[k] ||= v
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
  return { FakeRedis, clients, kv, hashes }
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
// Background loops that would spin against the fake (stream reads, pollers, probes).
vi.mock('../../services/event-stream.js', async (orig) => ({
  ...(await orig<typeof import('../../services/event-stream.js')>()),
  initEventStream: vi.fn(async () => {}),
  closeEventStream: vi.fn(async () => {})
}))
vi.mock('../../services/item-events.js', async (orig) => ({
  ...(await orig<typeof import('../../services/item-events.js')>()),
  initItemEvents: vi.fn(async () => {}),
  closeItemEvents: vi.fn(async () => {})
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

/** Open an engine.io v4 websocket and connect to the main namespace; collect event frames. */
function connect(port: number): Promise<{ ws: WebSocket; events: Array<[string, unknown]> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`)
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

describe('realtime tier (NIVARO_ROLE=realtime + SOCKETS=off)', () => {
  let realtime: FastifyInstance
  let web: FastifyInstance
  let realtimePort = 0
  let webPort = 0
  const saved = { role: process.env.NIVARO_ROLE, sockets: process.env.SOCKETS }

  beforeAll(async () => {
    process.env.REDIS_CHANNEL_PREFIX = 'rt-test:'
    process.env.NIVARO_ROLE = 'realtime'
    delete process.env.SOCKETS
    const { buildRealtimeServer } = await import('../../realtime-server.js')
    realtime = await buildRealtimeServer()
    await realtime.listen({ port: 0, host: '127.0.0.1' })
    realtimePort = (realtime.server.address() as AddressInfo).port

    process.env.NIVARO_ROLE = 'web'
    process.env.SOCKETS = 'off'
    const { socketioPlugin } = await import('../../plugins/socketio.js')
    web = fastify({ logger: false })
    web.decorate('redis', new bus.FakeRedis({ db: 9 }) as never)
    await web.register(socketioPlugin)
    await web.listen({ port: 0, host: '127.0.0.1' })
    webPort = (web.server.address() as AddressInfo).port
  }, 30_000)

  afterAll(async () => {
    await web?.close()
    await realtime?.close()
    if (saved.role === undefined) delete process.env.NIVARO_ROLE
    else process.env.NIVARO_ROLE = saved.role
    if (saved.sockets === undefined) delete process.env.SOCKETS
    else process.env.SOCKETS = saved.sockets
    delete process.env.REDIS_CHANNEL_PREFIX
  })

  it('registers no HTTP route beyond the realtime allowlist', async () => {
    const { servedRealtimeRoutes } = await import('../../realtime-server.js')
    const { REALTIME_HTTP_ROUTES } = await import('../../services/process-role.js')
    expect([...servedRealtimeRoutes()].sort()).toEqual([...REALTIME_HTTP_ROUTES].sort())
  })

  it('answers anything else with a 404 that says where to route it', async () => {
    for (const url of ['/api/items/projects', '/api/auth/me', '/api/stream', '/api/graphql']) {
      const res = await realtime.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(404)
      expect(res.json().message).toMatch(/not served by a realtime process/)
    }
    const post = await realtime.inject({ method: 'POST', url: '/api/graphql', payload: {} })
    expect(post.statusCode).toBe(404)
  })

  it('says it is the realtime role on /api/version and on every response', async () => {
    const res = await realtime.inject({ method: 'GET', url: '/api/version' })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('realtime')
    expect(res.headers['x-nivaro-role']).toBe('realtime')
  })

  it('serves /socket.io on the realtime process and not on a SOCKETS=off web process', async () => {
    const rt = await fetch(`http://127.0.0.1:${realtimePort}/socket.io/?EIO=4&transport=polling`)
    expect(rt.status).toBe(200)
    expect(await rt.text()).toMatch(/^0\{"sid"/)
    const w = await fetch(`http://127.0.0.1:${webPort}/socket.io/?EIO=4&transport=polling`)
    expect(w.status).toBe(404)
    expect(web.io.engine.clientsCount).toBe(0)
  })

  it('delivers what the SOCKETS=off web process emits to the realtime process sockets', async () => {
    const { ws, events } = await connect(realtimePort)
    try {
      web.io.emit('rt:probe', { n: 1 })
      await waitFor(() => events.some(([e]) => e === 'rt:probe'))
      expect(events.find(([e]) => e === 'rt:probe')?.[1]).toEqual({ n: 1 })
      // fetchSockets across the adapter: the web process sees the realtime process's socket.
      const all = await web.io.fetchSockets()
      expect(all.length).toBeGreaterThanOrEqual(1)
    } finally {
      ws.close()
    }
  })

  it('carries what the realtime sockets know to the SOCKETS=off process on the board', async () => {
    const board = await import('../../services/realtime-board.js')
    const sock = await import('../../plugins/socketio.js')
    const { ws } = await connect(realtimePort)
    try {
      await waitFor(() => realtime.io.sockets.sockets.size > 0)
      const held = [...realtime.io.sockets.sockets.values()].at(-1)
      if (!held) throw new Error('no socket')
      // What the socket plugin writes on a page ping, and an admin watching the traffic feed.
      held.data[board.PAGE_AT_KEY] = {
        user: { id: 'u-1', name: 'Ada' },
        path: '/collections/projects',
        since: 1000,
        app: 'admin',
        tenant: ''
      }
      held.join('watch:traffic')

      // Before the reader runs: the historic, local answers (this test process holds no pages).
      expect(sock.usersOnPath('/collections/projects')).toEqual([])

      // The realtime process publishes; the SOCKETS=off process reads.
      board.startBoardPublisher(realtime.redis as never, sock.localBoardCollector(realtime.io))
      board.startBoardReader(web.redis as never, { includeOwn: true })
      await waitFor(
        () => board.boardFresh() && sock.usersOnPath('/collections/projects').length > 0
      )
      await waitFor(() => sock.getRealtimeStats().sockets.length > 0)

      expect(sock.usersOnPath('/collections/projects')).toEqual([
        { id: 'u-1', name: 'Ada', since: 1000 }
      ])
      expect(sock.usersOnPath('/users')).toEqual([])
      expect(sock.usersOnPathPrefix(['/collections'])).toEqual(['u-1'])
      expect(sock.getRealtimeStats().sockets.some((x) => x.id === held.id)).toBe(true)
      expect(sock.getLocalConcurrency().sockets).toBeGreaterThanOrEqual(1)
      // "Is anyone watching?" gates in front of an emit see the realtime process's watchers.
      expect(board.roomListeners(web.io, 'watch:traffic')).toBeGreaterThanOrEqual(1)
      expect(board.roomListeners(web.io, 'watch:jobs')).toBe(0)
    } finally {
      ws.close()
      board.resetBoard()
    }
  })

  it('answers record viewers from the board, per tenant, and locally without it', async () => {
    const board = await import('../../services/realtime-board.js')
    const sock = await import('../../plugins/socketio.js')
    expect(sock.isUserViewing('projects', '42', 'u-1')).toBe(false)
    board.setBoardsForTests([
      {
        node: 'rt-a',
        at: Date.now(),
        sockets: 2,
        users: ['u-1', 'u-2'],
        viewers: {
          'record:projects:42': [{ socket: 's1', id: 'u-1', name: 'Ada' }],
          't:acme:record:projects:42': [{ socket: 's2', id: 'u-2', name: 'Bo' }]
        },
        pages: []
      },
      {
        node: 'rt-b',
        at: Date.now(),
        sockets: 1,
        users: ['u-3'],
        viewers: { 'record:projects:42': [{ socket: 's3', id: 'u-3', name: 'Cy' }] },
        pages: []
      }
    ])
    try {
      expect(sock.isUserViewing('projects', '42', 'u-1')).toBe(true)
      expect(sock.isUserViewing('projects', '42', 'u-3')).toBe(true)
      // Another tenant's viewer never shows in this (self-hosted '') tenant's answers.
      expect(sock.isUserViewing('projects', '42', 'u-2')).toBe(false)
      expect(sock.getRecordViewerSnapshot()).toEqual([
        {
          collection: 'projects',
          item: '42',
          viewers: [
            { id: 'u-1', name: 'Ada' },
            { id: 'u-3', name: 'Cy' }
          ]
        }
      ])
      expect(sock.getLocalConcurrency()).toEqual({ sockets: 3, users: 3 })
      // A realtime process merges the OTHER processes' viewers into its own broadcasts.
      const { INSTANCE_ID } = await import('../../services/instance-roster.js')
      board.setBoardsForTests([
        {
          node: INSTANCE_ID,
          at: Date.now(),
          sockets: 1,
          users: ['me'],
          viewers: { 'record:projects:42': [{ socket: 's0', id: 'me', name: 'Me' }] },
          pages: []
        },
        {
          node: 'rt-b',
          at: Date.now(),
          sockets: 1,
          users: ['u-3'],
          viewers: { 'record:projects:42': [{ socket: 's3', id: 'u-3', name: 'Cy' }] },
          pages: []
        }
      ])
      expect(board.boardPeerViewers('record:projects:42').map((v) => v.id)).toEqual(['u-3'])
      // Ops topic viewers (issue / ticket / layout pages) merge the same way.
      const topics = await import('../../services/presence-topics.js')
      topics.addTopicViewer('ops:issue-view:7', 'local-1', { id: 'me', name: 'Me' })
      board.setBoardsForTests([
        {
          node: 'rt-b',
          at: Date.now(),
          sockets: 2,
          users: ['u-3', 'me'],
          viewers: {},
          pages: [],
          topics: {
            'ops:issue-view:7': [
              { socket: 's3', id: 'u-3', name: 'Cy' },
              { socket: 's4', id: 'ME', name: 'Me' }
            ]
          }
        }
      ])
      expect(topics.topicViewers('ops:issue-view:7').map((v) => v.id)).toEqual(['me', 'u-3'])
      topics.removeTopicViewer('ops:issue-view:7', 'local-1')
    } finally {
      board.resetBoard()
    }
    expect(sock.isUserViewing('projects', '42', 'u-1')).toBe(false)
  })

  it('force refresh and the minimum-build preview from a SOCKETS=off process reach realtime tabs', async () => {
    const { CLIENT_DATA_KEY } = await import('../../services/client-versions-cluster.js')
    const sock = await import('../../plugins/socketio.js')
    const { ws, events } = await connect(realtimePort)
    try {
      await waitFor(() => realtime.io.sockets.sockets.size > 0)
      const held = [...realtime.io.sockets.sockets.values()].at(-1)
      if (!held) throw new Error('no socket')
      held.data[CLIENT_DATA_KEY] = {
        app: 'admin',
        version: { build: 'b-old', api: null, tab: 't1', loaded: Date.now() },
        user: { id: 'u-9', name: 'Tab Owner' },
        node: 'rt'
      }
      // The emit side used by POST /realtime/force-refresh and the sticky/min-build routes.
      const sent = await sock.emitForceRefresh(
        { match: (c) => c.id === held.id },
        { seconds: 5, message: 'Update ready', reason: 'min-build' }
      )
      expect(sent.sockets).toBe(1)
      await waitFor(() => events.some(([e]) => e === 'client:force-refresh'))
      // GET /realtime/min-build/preview counts tabs from the same cluster read.
      const v = await sock.getClusterClientVersionGroups(null)
      expect(JSON.stringify(v.groups)).toContain('b-old')
    } finally {
      ws.close()
    }
  })

  it('a sampled event from a SOCKETS=off process is acknowledged on the realtime process (#2477)', async () => {
    const { setIo } = await import('../../services/io-holder.js')
    const { journaledEmit, setJournalRedis } = await import('../../services/event-journal.js')
    const { _resetStampFloorForTests } = await import('../../services/realtime-ack-sample.js')
    const { ackSilenceRecent } = await import('../../services/realtime-delivery-slo.js')
    const { ws, events } = await connect(realtimePort)
    const savedFloor = process.env.REALTIME_ACK_FLOOR_S
    try {
      await waitFor(() => realtime.io.sockets.sockets.size > 0)
      const held = [...realtime.io.sockets.sockets.values()].at(-1)
      if (!held) throw new Error('no socket')
      // Signed in, as the auth handler leaves it for socket-verify, and watching the collection.
      held.data.nvrAccess = { user: () => ({ id: 'u-ack' }), applyUser() {}, leaveRoom() {} }
      held.join('collection:orders')
      // The web process writes: its io (emitter only) and Redis. The time floor stamps its
      // first event whatever the sequence — a quiet morning still gets measured.
      setIo(web.io as never)
      setJournalRedis(web.redis as never)
      process.env.REALTIME_ACK_FLOOR_S = '30'
      _resetStampFloorForTests()
      const r = await journaledEmit('collection:orders', 'collection:update', {
        collection: 'orders',
        item: 7
      })
      expect(r.seq).toBeGreaterThan(0)
      await waitFor(() => events.some(([e]) => e === 'collection:update'))
      const payload = events.find(([e]) => e === 'collection:update')?.[1] as {
        _seq: number
        _st: number
      }
      expect(payload._seq).toBe(r.seq)
      expect(typeof payload._st).toBe('number')
      // The tab answers on its socket: the realtime process checks the stamp the web process
      // kept and records a client sample in the shared Redis.
      ws.send(
        `42${JSON.stringify(['rt:ack', { seq: payload._seq, st: payload._st, rx: Date.now() }])}`
      )
      const clientSamples = async () =>
        (await ackSilenceRecent(15, { redis: web.redis as never }))?.client_samples ?? 0
      const until = Date.now() + 3000
      while ((await clientSamples()) === 0 && Date.now() < until)
        await new Promise((res) => setTimeout(res, 20))
      expect(await clientSamples()).toBe(1)
    } finally {
      setIo(realtime.io as never)
      if (savedFloor === undefined) delete process.env.REALTIME_ACK_FLOOR_S
      else process.env.REALTIME_ACK_FLOOR_S = savedFloor
      ws.close()
    }
  })

  it('keeps the SOCKETS=off process out of the adapter quorum and off the broadcast feed', async () => {
    const adapter = web.io.of('/').adapter as unknown as {
      requestChannel: string
      channel: string
      serverCount(): Promise<number>
    }
    const subscribed = (c: string) =>
      [...bus.clients].filter((x: any) => (x.channels as Set<string>).has(c)).length
    const patterned = (p: string) =>
      [...bus.clients].filter((x: any) => (x.patterns as Set<string>).has(p)).length
    // Only the realtime process answers requests and decodes broadcasts.
    expect(subscribed(adapter.requestChannel)).toBe(1)
    expect(patterned(`${adapter.channel}*`)).toBe(1)
    // The web process still counts itself when it asks (the adapter subtracts the requester).
    expect(await adapter.serverCount()).toBe(2)
    // The realtime process asks nobody but itself: no waiting on a busy web process.
    const t0 = Date.now()
    await realtime.io.fetchSockets()
    expect(Date.now() - t0).toBeLessThan(200)
  })
})
