// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetSignedOutGate, noteSignedIn, noteUnauthorized } from './signed-out'
import { createSocketRealtime } from './socket-realtime'
import {
  createWorkerSocket,
  shouldUseWorkerSocket,
  WORKER_SOCKET_PREF_KEY,
  WORKER_SOCKET_PROTO,
  type WorkerSocketOptions
} from './worker-socket'

/** The worker's side of the port: what the tab posted, and a way to answer. */
class FakePort {
  posted: Array<Record<string, any>> = []
  onmessage: ((ev: MessageEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  closed = false
  postMessage(msg: Record<string, any>) {
    this.posted.push(msg)
  }
  start() {}
  close() {
    this.closed = true
  }
  answer(msg: Record<string, any>) {
    this.onmessage?.({ data: msg } as MessageEvent)
  }
  sent(t: string) {
    return this.posted.filter((m) => m.t === t)
  }
}

const ports: FakePort[] = []
class FakeSharedWorker {
  port = new FakePort()
  onerror: (() => void) | null = null
  constructor(
    public url: string,
    public opts?: { name?: string }
  ) {
    ports.push(this.port)
  }
}

function fakeReal() {
  const handlers = new Map<string, Set<(...a: any[]) => void>>()
  const sent: Array<[string, unknown]> = []
  return {
    connected: true,
    sent,
    handlers,
    on(event: string, cb: (...a: any[]) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)?.add(cb)
    },
    off(event: string, cb?: (...a: any[]) => void) {
      if (cb) handlers.get(event)?.delete(cb)
      else handlers.delete(event)
    },
    emit(event: string, payload?: unknown) {
      sent.push([event, payload])
    },
    onAny: vi.fn(),
    io: { engine: { transport: { name: 'polling' } } },
    serverSends(event: string, payload?: unknown) {
      for (const h of [...(handlers.get(event) ?? [])]) h(payload)
    }
  }
}

function make(over: Partial<WorkerSocketOptions> = {}) {
  const real = fakeReal()
  const modes: Array<[string, string]> = []
  const socket = createWorkerSocket({
    url: '/api/realtime/worker.js',
    app: 'admin',
    version: { build: '9' },
    authToken: async () => 'ws-token',
    fallback: () => real,
    onMode: (m, r) => modes.push([m, r]),
    ...over
  })
  return { socket, real, modes, port: ports[ports.length - 1] }
}

describe('createWorkerSocket (#2475)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ports.length = 0
    ;(window as any).SharedWorker = FakeSharedWorker
    localStorage.removeItem(WORKER_SOCKET_PREF_KEY)
  })
  afterEach(() => {
    vi.useRealTimers()
    ;(window as any).SharedWorker = undefined
  })

  it('attaches to the worker, says hello and mirrors its socket to listeners', async () => {
    const { socket, port, modes } = make()
    expect(socket.mode()).toBe('pending')
    port.answer({ t: 'ready', proto: WORKER_SOCKET_PROTO })
    expect(socket.mode()).toBe('worker')
    expect(modes).toEqual([['worker', 'ready']])
    const hello = port.sent('hello')[0]
    expect(hello.app).toBe('admin')
    expect(hello.version).toEqual({ build: '9' })
    const onAuth = vi.fn()
    const onUpdate = vi.fn()
    socket.on('auth:ok', onAuth)
    socket.on('collection:update', onUpdate)
    port.answer({ t: 'ev', event: 'connect', args: [] })
    expect(socket.connected).toBe(true)
    port.answer({ t: 'ev', event: 'auth:ok', args: [] })
    port.answer({ t: 'ev', event: 'collection:update', args: [{ collection: 'orders', item: 1 }] })
    expect(onAuth).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith({ collection: 'orders', item: 1 })
    // emits go to the worker; acks come back by id
    const ack = vi.fn()
    socket.emit('collection:join', { collection: 'orders' })
    socket.emit('time:sync', { c: 1 }, ack)
    const emits = port.sent('emit')
    expect(emits[0]).toEqual({
      t: 'emit',
      event: 'collection:join',
      payload: { collection: 'orders' }
    })
    expect(emits[1].ack).toBeTypeOf('number')
    port.answer({ t: 'ack', id: emits[1].ack, args: [{ s: 5 }] })
    expect(ack).toHaveBeenCalledWith({ s: 5 })
    // the worker asks for a token; the tab mints one
    port.answer({ t: 'need-token', req: 2 })
    await vi.advanceTimersByTimeAsync(0)
    expect(port.sent('token')).toEqual([{ t: 'token', req: 2, token: 'ws-token' }])
    // pings are answered; transport reaches io.engine
    port.answer({ t: 'ping' })
    expect(port.sent('pong').length).toBe(1)
    port.answer({ t: 'status', connected: true, authed: true, transport: 'websocket' })
    expect(socket.io.engine.transport.name).toBe('websocket')
  })

  it('falls back to the host socket when the worker never greets, keeping the listeners', () => {
    const { socket, real, modes } = make()
    const onUpdate = vi.fn()
    socket.on('collection:update', onUpdate)
    vi.advanceTimersByTime(15_100)
    expect(socket.mode()).toBe('fallback')
    expect(modes).toEqual([['fallback', 'no-greeting']])
    real.serverSends('collection:update', { collection: 'x', item: 1 })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    socket.emit('collection:join', { collection: 'x' })
    expect(real.sent).toEqual([['collection:join', { collection: 'x' }]])
    // later listeners land on the real socket too
    const later = vi.fn()
    socket.on('notification:new', later)
    real.serverSends('notification:new', { id: 1 })
    expect(later).toHaveBeenCalledTimes(1)
    expect(socket.connected).toBe(true)
  })

  it('falls back on a protocol mismatch, on the worker asking for it, and when it goes silent', () => {
    const a = make()
    a.port.answer({ t: 'ready', proto: WORKER_SOCKET_PROTO + 1 })
    expect(a.socket.mode()).toBe('fallback')
    expect(a.modes[0][1]).toBe(`proto-${WORKER_SOCKET_PROTO + 1}`)

    const b = make()
    b.port.answer({ t: 'ready', proto: WORKER_SOCKET_PROTO })
    const onDisconnect = vi.fn()
    b.socket.on('disconnect', onDisconnect)
    b.port.answer({ t: 'ev', event: 'connect', args: [] })
    b.port.answer({ t: 'fallback', reason: 'socket-blocked' })
    expect(b.socket.mode()).toBe('fallback')
    expect(onDisconnect).toHaveBeenCalledWith('worker-fallback')
    expect(b.port.closed).toBe(true)

    const c = make()
    c.port.answer({ t: 'ready', proto: WORKER_SOCKET_PROTO })
    vi.advanceTimersByTime(26_000)
    expect(c.socket.mode()).toBe('fallback')
    expect(c.modes[1]).toEqual(['fallback', 'worker-silent'])
  })

  it('takes the host socket straight away without SharedWorker, off by preference, or cross-origin', () => {
    ;(window as any).SharedWorker = undefined
    expect(shouldUseWorkerSocket('/api/realtime/worker.js')).toBe(false)
    expect(make().socket.mode()).toBe('fallback')
    ;(window as any).SharedWorker = FakeSharedWorker
    expect(shouldUseWorkerSocket('/api/realtime/worker.js')).toBe(true)
    expect(shouldUseWorkerSocket('https://api.elsewhere.test/api/realtime/worker.js')).toBe(false)
    localStorage.setItem(WORKER_SOCKET_PREF_KEY, 'off')
    expect(shouldUseWorkerSocket('/api/realtime/worker.js')).toBe(false)
  })

  it('serves createSocketRealtime like a real socket', () => {
    const { socket, port } = make()
    port.answer({ t: 'ready', proto: WORKER_SOCKET_PROTO })
    const realtime = createSocketRealtime({ socket })
    const cb = vi.fn()
    const off = realtime.subscribeCollections(['orders'], cb)
    port.answer({ t: 'ev', event: 'connect', args: [] })
    port.answer({ t: 'ev', event: 'auth:ok', args: [] })
    // the adapter re-joins on auth:ok (the worker de-duplicates server joins)
    expect(port.sent('emit').filter((m) => m.event === 'collection:join').length).toBe(1)
    port.answer({ t: 'ev', event: 'collection:update', args: [{ collection: 'orders', item: 3 }] })
    expect(cb).toHaveBeenCalledTimes(1)
    port.answer({ t: 'ev', event: 'catchup:events', args: [{ events: [] }] })
    expect(realtime.status().state).toBe('live')
    off()
    expect(port.sent('emit').some((m) => m.event === 'collection:leave')).toBe(true)
  })
})

describe('createWorkerSocket: signed-out tabs stop minting ws tokens (staging 2026-10-23)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    __resetSignedOutGate()
    ports.length = 0
    ;(window as any).SharedWorker = FakeSharedWorker
    localStorage.removeItem(WORKER_SOCKET_PREF_KEY)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    ;(window as any).SharedWorker = undefined
  })

  it('backs off after a null token (1 s doubling, 5 min cap) without calling the host', async () => {
    const authToken = vi.fn(async () => null)
    const { port } = make({ authToken })
    port.answer({ t: 'ready', proto: WORKER_SOCKET_PROTO })
    let req = 0
    const ask = async () => {
      port.answer({ t: 'need-token', req: ++req })
      await vi.advanceTimersByTimeAsync(0)
    }
    await ask()
    expect(authToken).toHaveBeenCalledTimes(1)
    // the worker asks again and again (an old worker on focus): the tab answers null at once
    for (let i = 0; i < 20; i++) await ask()
    expect(authToken).toHaveBeenCalledTimes(1)
    expect(port.sent('token').length).toBe(21)
    expect(port.sent('token').every((m) => m.token === null)).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    await ask()
    expect(authToken).toHaveBeenCalledTimes(2)
    // after many refusals the wait sits at the 5 min cap
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(300_000)
      await ask()
    }
    const calls = authToken.mock.calls.length
    await vi.advanceTimersByTimeAsync(299_000)
    await ask()
    expect(authToken).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(1_000)
    await ask()
    expect(authToken).toHaveBeenCalledTimes(calls + 1)
  })

  it('tells the worker it is signed out, and resumes at once on sign-in', async () => {
    let token: string | null = null
    const authToken = vi.fn(async () => token)
    const { port } = make({ authToken })
    port.answer({ t: 'ready', proto: WORKER_SOCKET_PROTO })
    // a transient failure: a bare null (the worker only backs off)
    port.answer({ t: 'need-token', req: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(port.sent('token').at(-1)).toEqual({ t: 'token', req: 1, token: null, signedOut: false })
    // the tab learned it is signed out: the worker may park
    noteUnauthorized()
    await vi.advanceTimersByTimeAsync(1_000)
    port.answer({ t: 'need-token', req: 2 })
    await vi.advanceTimersByTimeAsync(0)
    expect(port.sent('token').at(-1)).toEqual({ t: 'token', req: 2, token: null, signedOut: true })
    const asked = authToken.mock.calls.length
    // signed in (here, or another tab via the gate's channel): the worker hears it now
    token = 'ws-new'
    noteSignedIn()
    expect(port.sent('signed-in').length).toBe(1)
    port.answer({ t: 'need-token', req: 3 })
    await vi.advanceTimersByTimeAsync(0)
    expect(authToken).toHaveBeenCalledTimes(asked + 1)
    expect(port.sent('token').at(-1)).toEqual({ t: 'token', req: 3, token: 'ws-new' })
  })

  it('stops listening for sign-ins once disconnected', () => {
    const { socket, port } = make()
    port.answer({ t: 'ready', proto: WORKER_SOCKET_PROTO })
    socket.disconnect()
    noteUnauthorized()
    noteSignedIn()
    expect(port.sent('signed-in').length).toBe(0)
  })
})
