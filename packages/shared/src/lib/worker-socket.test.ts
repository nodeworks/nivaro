// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
