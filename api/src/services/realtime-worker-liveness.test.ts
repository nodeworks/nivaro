import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REALTIME_WORKER_SOURCE } from './realtime-worker-source.js'

/**
 * Silent self-repair in the shared worker (realtime 24; twin of packages/shared
 * socket-liveness.ts). The worker runs in a vm whose timers are this test's fake timers, so the
 * watch ticks, probe timeouts and repair windows run as they would in a browser.
 */

type Handler = (...a: unknown[]) => void

class FakeSocket {
  connected = false
  handlers = new Map<string, Handler[]>()
  manager = new Map<string, Handler[]>()
  emitted: Array<[string, unknown, unknown?]> = []
  /** When false, probes (`time:sync`) go unanswered: the connection is dead. */
  alive = true
  connects = 0
  disconnects = 0
  io = {
    on: (ev: string, cb: Handler) => this.manager.set(ev, [...(this.manager.get(ev) ?? []), cb]),
    engine: { transport: { name: 'websocket' }, on: vi.fn() }
  }
  on(ev: string, cb: Handler) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb])
  }
  onAny() {}
  emit(ev: string, payload?: unknown, ack?: unknown) {
    this.emitted.push([ev, payload, ack])
    if (ev === 'time:sync' && this.alive && typeof ack === 'function')
      setTimeout(() => (ack as Handler)({ s: Date.now() }), 20)
  }
  connect() {
    this.connects++
    this.connected = true
    this.fire('connect')
  }
  disconnect() {
    this.disconnects++
    this.connected = false
    this.fire('disconnect', 'io client disconnect')
  }
  drop(reason: string) {
    this.connected = false
    this.fire('disconnect', reason)
  }
  heartbeat() {
    for (const cb of this.manager.get('ping') ?? []) cb()
  }
  fire(ev: string, ...args: unknown[]) {
    for (const cb of this.handlers.get(ev) ?? []) cb(...args)
  }
  probes() {
    return this.emitted.filter((e) => e[0] === 'time:sync').length
  }
}

class FakePort {
  received: Array<Record<string, unknown>> = []
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage(msg: Record<string, unknown>) {
    this.received.push(msg)
  }
  start() {}
  close() {}
  send(msg: Record<string, unknown>) {
    this.onmessage?.({ data: msg })
  }
  repairs() {
    return this.received.filter((m) => m.t === 'repair')
  }
}

function boot() {
  const socket = new FakeSocket()
  const scope: Record<string, unknown> = {
    location: { origin: 'https://nivaro.test' },
    importScripts: vi.fn(),
    io: vi.fn(() => socket),
    fetch: vi.fn(async () => ({ ok: true })),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    Date,
    console
  }
  scope.self = scope
  vm.createContext(scope)
  vm.runInContext(REALTIME_WORKER_SOURCE, scope)
  const port = new FakePort()
  ;(scope.onconnect as (e: { ports: FakePort[] }) => void)({ ports: [port] })
  port.send({ t: 'hello', app: 'admin' })
  socket.connect()
  const req = port.received.find((m) => m.t === 'need-token')?.req
  port.send({ t: 'token', req, token: 'ws-1' })
  socket.fire('auth:ok')
  const attach = () => {
    const p = new FakePort()
    ;(scope.onconnect as (e: { ports: FakePort[] }) => void)({ ports: [p] })
    return p
  }
  return { socket, port, attach }
}

/** Keep the tab answering the worker's pings so it is not dropped as gone. */
function advance(port: FakePort, ms: number, step = 5000) {
  for (let t = 0; t < ms; t += step) {
    vi.advanceTimersByTime(Math.min(step, ms - t))
    port.send({ t: 'pong' })
  }
}

describe('shared worker silent self-repair (realtime 24)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a connection that keeps its heartbeat is left alone', () => {
    const { socket, port } = boot()
    for (let i = 0; i < 8; i++) {
      advance(port, 25_000)
      socket.heartbeat()
    }
    expect(socket.probes()).toBe(0)
    expect(socket.disconnects).toBe(0)
  })

  it('silence → probe; no answer → quiet reconnect; signed in again → repaired', () => {
    const { socket, port } = boot()
    socket.alive = false
    advance(port, 45_000)
    expect(socket.probes()).toBe(1)
    advance(port, 5000)
    expect(socket.disconnects).toBe(1)
    expect(socket.connects).toBe(2)
    expect(port.repairs()).toEqual([{ t: 'repair', on: true }])
    // the tab hears the repair BEFORE the drop it causes
    const order = port.received.map((m) => (m.t === 'ev' ? `ev:${m.event}` : m.t))
    expect(order.indexOf('repair')).toBeLessThan(order.lastIndexOf('ev:disconnect'))
    socket.alive = true
    socket.fire('auth:ok')
    expect(port.repairs().at(-1)).toEqual({ t: 'repair', on: false, outcome: 'repaired' })
  })

  it('a tab wake probes at once; an answer changes nothing', () => {
    const { socket, port } = boot()
    port.send({ t: 'wake', reason: 'online' })
    expect(socket.probes()).toBe(1)
    advance(port, 6000)
    expect(socket.disconnects).toBe(0)
    expect(port.repairs()).toEqual([])
  })

  it('a heartbeat timeout reconnects now; two failed repairs let the banner show', () => {
    const { socket, port } = boot()
    socket.connect = () => {
      socket.connects++ // the server stays unreachable: no connect event
    }
    socket.drop('ping timeout')
    expect(socket.connects).toBe(2)
    expect(port.repairs()).toEqual([{ t: 'repair', on: true }])
    advance(port, 12_000)
    expect(socket.connects).toBe(3)
    advance(port, 12_000)
    expect(port.repairs().at(-1)).toEqual({ t: 'repair', on: false, outcome: 'gave-up' })
    expect(socket.connects).toBe(3)
  })

  it('never repairs a socket the server sent away', () => {
    const { socket, port } = boot()
    socket.drop('io server disconnect')
    port.send({ t: 'wake', reason: 'online' })
    advance(port, 30_000)
    expect(port.repairs()).toEqual([])
  })

  it('a new tab during a repair hears that it is quiet', () => {
    const { socket, port, attach } = boot()
    socket.alive = false
    socket.connect = () => {
      socket.connects++ // still reconnecting when the new tab arrives
    }
    advance(port, 50_000)
    expect(port.repairs()).toEqual([{ t: 'repair', on: true }])
    const b = attach()
    b.send({ t: 'hello', app: 'admin' })
    expect(b.repairs()).toEqual([{ t: 'repair', on: true }])
  })
})
