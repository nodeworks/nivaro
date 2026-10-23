import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REALTIME_WORKER_PROTO, REALTIME_WORKER_SOURCE } from './realtime-worker-source.js'

/**
 * The worker runs in a vm with a fake SharedWorker scope and a fake socket.io client: what
 * tabs send over their ports, what reaches the server, and what each tab hears back.
 */

type Handler = (...a: unknown[]) => void

class FakeSocket {
  connected = false
  handlers = new Map<string, Handler[]>()
  anyHandlers: Handler[] = []
  emitted: Array<[string, unknown, unknown?]> = []
  io = { on: vi.fn(), engine: { transport: { name: 'websocket' }, on: vi.fn() } }
  on(ev: string, cb: Handler) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb])
  }
  onAny(cb: Handler) {
    this.anyHandlers.push(cb)
  }
  emit(ev: string, payload?: unknown, ack?: unknown) {
    this.emitted.push([ev, payload, ack])
  }
  connect() {
    this.connected = true
    this.fire('connect')
  }
  disconnect() {
    this.connected = false
    this.fire('disconnect', 'io client disconnect')
  }
  /** The server drops the socket (the zombie reaper does this to an unauthenticated one). */
  serverDrop() {
    this.connected = false
    this.fire('disconnect', 'io server disconnect')
  }
  /** The server's side: fire an event into the worker's listeners (and onAny). */
  fire(ev: string, ...args: unknown[]) {
    for (const cb of this.handlers.get(ev) ?? []) cb(...args)
    for (const cb of this.anyHandlers) cb(ev, ...args)
  }
  sent(ev: string) {
    return this.emitted.filter((e) => e[0] === ev).map((e) => e[1])
  }
}

class FakePort {
  received: Array<Record<string, unknown>> = []
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onmessageerror: (() => void) | null = null
  closed = false
  postMessage(msg: Record<string, unknown>) {
    this.received.push(msg)
  }
  start() {}
  close() {
    this.closed = true
  }
  /** The tab's side: send a message into the worker. */
  send(msg: Record<string, unknown>) {
    this.onmessage?.({ data: msg })
  }
  events(name?: string) {
    return this.received
      .filter((m) => m.t === 'ev' && (!name || m.event === name))
      .map((m) => ({ event: m.event as string, args: m.args as unknown[] }))
  }
}

function boot() {
  const socket = new FakeSocket()
  const scope: Record<string, unknown> = {
    location: { origin: 'https://nivaro.test' },
    importScripts: vi.fn(),
    io: vi.fn(() => socket),
    fetch: vi.fn(async () => ({ ok: true })),
    setInterval: vi.fn(() => 1),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
    // the test realm's Date, so vi.setSystemTime moves the worker's clock (the watchdogs)
    Date,
    console
  }
  scope.self = scope
  vm.createContext(scope)
  vm.runInContext(REALTIME_WORKER_SOURCE, scope)
  const attach = () => {
    const port = new FakePort()
    ;(scope.onconnect as (e: { ports: FakePort[] }) => void)({ ports: [port] })
    return port
  }
  return { socket, scope, attach }
}

describe('realtime shared worker source (#2475)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('parses as a script and greets every port with the protocol', () => {
    const { attach, scope } = boot()
    expect(scope.importScripts).toHaveBeenCalledWith(
      'https://nivaro.test/socket.io/socket.io.min.js'
    )
    const a = attach()
    expect(a.received[0]).toEqual({ t: 'ready', proto: REALTIME_WORKER_PROTO })
  })

  it('opens ONE socket for many tabs and asks a tab for the token', () => {
    const { socket, scope, attach } = boot()
    const a = attach()
    const b = attach()
    a.send({ t: 'hello', app: 'admin', version: { build: '1.2.3' } })
    b.send({ t: 'hello', app: 'admin' })
    expect(scope.io).toHaveBeenCalledTimes(1)
    socket.connect()
    // both tabs hear connect; one tab is asked for a token
    expect(a.events('connect').length).toBe(1)
    expect(b.events('connect').length).toBe(1)
    const asked = [a, b].filter((p) => p.received.some((m) => m.t === 'need-token'))
    expect(asked.length).toBe(1)
    const req = asked[0].received.find((m) => m.t === 'need-token')?.req
    asked[0].send({ t: 'token', req, token: 'ws-1' })
    expect(socket.sent('auth')).toEqual([{ token: 'ws-1' }])
    socket.fire('auth:ok')
    // one client:hello, carrying the app, the coalesce feature and the build
    const hello = socket.sent('client:hello') as Array<Record<string, unknown>>
    expect(hello.length).toBe(1)
    expect(hello[0].app).toBe('admin')
    expect(hello[0].features).toContain('coalesce')
    expect(hello[0].build).toBe('1.2.3')
    expect(hello[0].shared_worker).toBe(true)
    expect(a.events('auth:ok').length).toBe(1)
    expect(b.events('auth:ok').length).toBe(1)
  })

  it('backs off when a tab has no token; focus never restarts the asking', () => {
    const { socket, scope, attach } = boot()
    const a = attach()
    a.send({ t: 'hello', app: 'admin' })
    socket.connect()
    const setTimeoutMock = scope.setTimeout as ReturnType<typeof vi.fn>
    const lastAsk = () => a.received.filter((m) => m.t === 'need-token').at(-1)?.req
    const asks = () => a.received.filter((m) => m.t === 'need-token').length
    const answerEmpty = () => {
      a.send({ t: 'token', req: lastAsk(), token: null })
      return setTimeoutMock.mock.calls.at(-1) as [() => void, number]
    }
    const waits: number[] = []
    for (let i = 0; i < 11; i++) {
      const [retry, ms] = answerEmpty()
      waits.push(ms)
      retry()
    }
    expect(waits).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000
    ])
    // the tab comes to the front: no ask, the wait does not start over (staging 2026-10-23)
    const before = asks()
    a.send({ t: 'active' })
    expect(asks()).toBe(before)
    // a tab that heard a sign-in: ask now, and the wait starts over
    a.send({ t: 'signed-in' })
    expect(asks()).toBe(before + 1)
    expect(answerEmpty()[1]).toBe(1000)
    // a token signs the socket in
    a.send({ t: 'token', req: lastAsk(), token: 'ws-9' })
    expect(socket.sent('auth')).toEqual([{ token: 'ws-9' }])
  })

  it('parks when a tab says it is signed out: closes the socket, asks nothing, no watchdog', () => {
    const { socket, scope, attach } = boot()
    const a = attach()
    a.send({ t: 'hello', app: 'admin' })
    socket.connect()
    const asks = () => a.received.filter((m) => m.t === 'need-token')
    a.send({ t: 'token', req: asks().at(-1)?.req, token: null, signedOut: true })
    expect(socket.connected).toBe(false)
    // nothing revives it: not focus, not the stall watchdog, not the token timer
    a.send({ t: 'active' })
    const intervals = (scope.setInterval as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as () => void
    )
    vi.setSystemTime(Date.now() + 120_000)
    a.send({ t: 'pong' }) // the tab is alive (it answers pings)
    for (const tick of intervals) tick()
    expect(socket.connected).toBe(false)
    expect(asks().length).toBe(1)
    // a tab signs in: connect again and ask
    a.send({ t: 'signed-in' })
    expect(socket.connected).toBe(true)
    expect(asks().length).toBe(2)
    a.send({ t: 'token', req: asks().at(-1)?.req, token: 'ws-2' })
    expect(socket.sent('auth')).toEqual([{ token: 'ws-2' }])
  })

  it('a new tab wakes a parked worker once (a fresh page may be signed in)', () => {
    const { socket, attach } = boot()
    const a = attach()
    a.send({ t: 'hello', app: 'admin' })
    socket.connect()
    const asked = (p: FakePort) => p.received.filter((m) => m.t === 'need-token')
    a.send({ t: 'token', req: asked(a).at(-1)?.req, token: null, signedOut: true })
    expect(socket.connected).toBe(false)
    const b = attach()
    b.send({ t: 'hello', app: 'admin' })
    expect(socket.connected).toBe(true)
    expect(asked(a).length + asked(b).length).toBe(2)
  })

  it('an unauthenticated socket the server drops waits for the backoff, not the watchdog', () => {
    const { socket, scope, attach } = boot()
    const a = attach()
    a.send({ t: 'hello', app: 'admin' })
    socket.connect()
    const setTimeoutMock = scope.setTimeout as ReturnType<typeof vi.fn>
    const asks = () => a.received.filter((m) => m.t === 'need-token')
    // an older tab: a bare null (no signedOut flag) — the worker backs off
    a.send({ t: 'token', req: asks().at(-1)?.req, token: null })
    const [retry, wait] = setTimeoutMock.mock.calls.at(-1) as [() => void, number]
    expect(wait).toBe(1000)
    // the zombie reaper drops the socket; the stall watchdog must not reconnect it
    socket.serverDrop()
    const intervals = (scope.setInterval as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as () => void
    )
    vi.setSystemTime(Date.now() + 120_000)
    a.send({ t: 'pong' }) // the tab is alive (it answers pings)
    for (const tick of intervals) tick()
    expect(socket.connected).toBe(false)
    // the backoff timer brings it back, and the connect asks once
    retry()
    expect(socket.connected).toBe(true)
    expect(asks().length).toBe(2)
  })

  it('joins a collection room once for two tabs and routes updates to the holders only', () => {
    const { socket, attach } = boot()
    const a = attach()
    const b = attach()
    const c = attach()
    a.send({ t: 'hello', app: 'admin' })
    socket.connect()
    socket.fire('auth:ok')
    a.send({ t: 'emit', event: 'collection:join', payload: { collection: 'orders' } })
    b.send({ t: 'emit', event: 'collection:join', payload: { collection: 'orders' } })
    c.send({ t: 'emit', event: 'collection:join', payload: { collection: 'invoices' } })
    expect(socket.sent('collection:join')).toEqual([
      { collection: 'orders' },
      { collection: 'invoices' }
    ])
    socket.fire('collection:update', { collection: 'orders', item: 7, _seq: 41 })
    expect(a.events('collection:update').length).toBe(1)
    expect(b.events('collection:update').length).toBe(1)
    expect(c.events('collection:update').length).toBe(0)
    // the first tab leaving keeps the room; the last one leaving leaves the server room
    a.send({ t: 'emit', event: 'collection:leave', payload: { collection: 'orders' } })
    expect(socket.sent('collection:leave')).toEqual([])
    b.send({ t: 'bye' })
    expect(socket.sent('collection:leave')).toEqual([{ collection: 'orders' }])
    expect(b.closed).toBe(true)
  })

  it('re-joins every held room after a reconnect and runs ONE catch-up with the shared cursor', () => {
    const { socket, attach } = boot()
    const a = attach()
    a.send({ t: 'hello', app: 'admin' })
    socket.connect()
    socket.fire('auth:ok')
    a.send({ t: 'emit', event: 'collection:join', payload: { collection: 'orders' } })
    a.send({ t: 'emit', event: 'admin:join', payload: { room: 'jobs' } })
    a.send({ t: 'emit', event: 'presence:watch', payload: { collection: 'orders', items: [1, 2] } })
    // a tab's own catch-up is swallowed: the worker owns the cursor
    a.send({ t: 'emit', event: 'catchup', payload: { cursor: 5 } })
    socket.fire('collection:update', { collection: 'orders', item: 1, _seq: 90 })
    socket.emitted.length = 0
    socket.fire('disconnect', 'transport close')
    expect(a.events('disconnect').length).toBe(1)
    socket.connect()
    socket.fire('auth:ok')
    expect(socket.sent('collection:join')).toEqual([{ collection: 'orders' }])
    expect(socket.sent('admin:join')).toEqual([{ room: 'jobs' }])
    expect(socket.sent('presence:watch')).toEqual([{ collection: 'orders', items: ['1', '2'] }])
    expect(socket.sent('catchup')).toEqual([{ cursor: 90 }])
    // replayed events arrive like live ones, then every tab hears the (empty) settle message
    socket.fire('catchup:events', {
      events: [{ seq: 91, event: 'collection:update', payload: { collection: 'orders', item: 2 } }]
    })
    const updates = a.events('collection:update')
    expect(updates.length).toBe(2)
    expect((updates[1].args[0] as { _seq: number })._seq).toBe(91)
    expect(a.events('catchup:events')).toEqual([
      { event: 'catchup:events', args: [{ events: [] }] }
    ])
  })

  it('routes record-room and row-presence events to the tabs that hold them', () => {
    const { socket, attach } = boot()
    const a = attach()
    const b = attach()
    a.send({ t: 'hello', app: 'efp' })
    socket.connect()
    socket.fire('auth:ok')
    a.send({ t: 'emit', event: 'record:join', payload: { collection: 'orders', item: '7' } })
    b.send({ t: 'emit', event: 'presence:watch', payload: { collection: 'orders', items: ['7'] } })
    socket.fire('field:editing', {
      collection: 'orders',
      item: '7',
      field: 'total',
      user: { id: 'u' }
    })
    socket.fire('presence:rows', { collection: 'orders', item: '7', user_ids: ['u'] })
    expect(a.events('field:editing').length).toBe(1)
    expect(b.events('field:editing').length).toBe(0)
    expect(a.events('presence:rows').length).toBe(0)
    expect(b.events('presence:rows').length).toBe(1)
    // an old server names no record on field events: every tab holding any record hears it
    socket.fire('field:editing', { field: 'total', user: null })
    expect(a.events('field:editing').length).toBe(2)
    expect(b.events('field:editing').length).toBe(0)
    // user-level notices reach everyone
    socket.fire('notification:new', { id: 1 })
    expect(a.events('notification:new').length).toBe(1)
    expect(b.events('notification:new').length).toBe(1)
  })

  it('forwards page:at for the active tab only and answers acks', () => {
    const { socket, attach } = boot()
    const a = attach()
    const b = attach()
    a.send({ t: 'hello', app: 'admin', active: true })
    socket.connect()
    socket.fire('auth:ok')
    a.send({ t: 'emit', event: 'page:at', payload: { path: '/a' } })
    b.send({ t: 'emit', event: 'page:at', payload: { path: '/b' } })
    expect(socket.sent('page:at')).toEqual([{ path: '/a' }])
    b.send({ t: 'active' })
    expect(socket.sent('page:at')).toEqual([{ path: '/a' }, { path: '/b' }])
    a.send({ t: 'emit', event: 'time:sync', payload: { c: 1 }, ack: 3 })
    const call = socket.emitted.find((e) => e[0] === 'time:sync')
    ;(call?.[2] as (r: unknown) => void)({ s: 2 })
    expect(a.received.find((m) => m.t === 'ack')).toEqual({ t: 'ack', id: 3, args: [{ s: 2 }] })
    // the ping answer never reaches tabs; nvr:pong goes back to the server
    socket.fire('nvr:ping', { t: 5 })
    expect(socket.sent('nvr:pong')).toEqual([{ t: 5 }])
    expect(a.events('nvr:ping').length).toBe(0)
  })

  it('tells tabs to run their own socket when the API answers HTTP but no transport connects', async () => {
    const { socket, scope, attach } = boot()
    const a = attach()
    a.send({ t: 'hello', app: 'admin' })
    socket.fire('connect_error', new Error('websocket error'))
    socket.fire('connect_error', new Error('xhr poll error'))
    await Promise.resolve()
    await Promise.resolve()
    expect(scope.fetch).toHaveBeenCalledTimes(1)
    expect(a.received.some((m) => m.t === 'fallback' && m.reason === 'socket-blocked')).toBe(true)
  })
})
