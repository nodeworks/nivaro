import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// One fake socket; its handlers are captured so the test can play the server's side.
const handlers = new Map<string, Array<(...a: unknown[]) => void>>()
const fakeSocket = {
  connected: false,
  emit: vi.fn(),
  on: vi.fn((ev: string, cb: (...a: unknown[]) => void) => {
    handlers.set(ev, [...(handlers.get(ev) ?? []), cb])
  }),
  once: vi.fn(),
  onAny: vi.fn(),
  connect: vi.fn(),
  listeners: vi.fn(() => []),
  io: { engine: { transport: { name: 'polling' }, once: vi.fn() } }
}
const fire = (ev: string, ...a: unknown[]) => {
  for (const cb of handlers.get(ev) ?? []) cb(...a)
}
vi.mock('socket.io-client', () => ({ io: vi.fn(() => fakeSocket) }))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(async () => ({ data: { token: 'ws1' } })) } }))
const { stopMasquerade, setServerClockOffset, readMasquerade } = vi.hoisted(() => ({
  stopMasquerade: vi.fn(async () => {}),
  setServerClockOffset: vi.fn(),
  readMasquerade: vi.fn((): { user_id: string } | null => null)
}))
vi.mock('@/lib/masquerade', () => ({ readMasquerade, stopMasquerade }))
vi.mock('@/lib/page-context', () => ({ clientVersion: () => ({}) }))
vi.mock('@nivaro/shared', () => ({
  // #2462 — the room gap tracker is exercised in packages/shared (room-gaps.test.ts).
  createRoomGapTracker: () => ({
    observe: () => {},
    replayed: () => {},
    reset: () => {},
    stats: () => ({ gaps: 0, missed: 0, replayed: 0, refetched: 0 })
  }),
  refetchEventsFor: () => [],
  // #2476 — the replay socket tap is exercised in packages/shared (replay-socket.test.ts).
  tapReplaySocket: () => {},
  createLeaderSocket: (
    _key: string,
    cbs: { becomeLeader: (deliver: unknown, emit: { current: unknown }) => void }
  ) => {
    cbs.becomeLeader(() => {}, { current: () => {} })
    return { isLeader: () => true, onEvent: () => () => {}, emit: () => {}, destroy: () => {} }
  },
  measureClockOffset: () => 120_000,
  setServerClockOffset
}))

import { adminRealtime, getSocket } from './socket'

class FakeEventSource {
  static last: FakeEventSource | null = null
  url: string
  listeners = new Map<string, (e: unknown) => void>()
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(url: string) {
    this.url = url
    FakeEventSource.last = this
  }
  addEventListener(ev: string, cb: (e: unknown) => void) {
    this.listeners.set(ev, cb)
  }
  close() {
    this.closed = true
  }
}

beforeAll(() => {
  vi.stubGlobal('EventSource', FakeEventSource)
  getSocket()
})
afterEach(() => vi.unstubAllGlobals())

describe('admin socket lifecycle', () => {
  it('opts into coalesced bursts and reports its transport (#1681, #1672)', () => {
    fire('auth:ok')
    const hello = fakeSocket.emit.mock.calls.find((c) => c[0] === 'client:hello')?.[1]
    expect(hello).toMatchObject({ app: 'admin', features: ['coalesce'], transport: 'polling' })
    expect(adminRealtime.status?.()).toMatchObject({ state: 'live', transport: 'polling' })
  })

  it('measures the server clock on sign-in (#2132)', async () => {
    const sync = fakeSocket.emit.mock.calls.find((c) => c[0] === 'time:sync')
    expect(sync?.[1]).toHaveProperty('c')
    // Answer the three round trips.
    for (let i = 0; i < 3; i++) {
      const call = fakeSocket.emit.mock.calls.filter((c) => c[0] === 'time:sync')[i]
      ;(call?.[2] as (r: { s: number }) => void)?.({ s: Date.now() + 120_000 })
      await Promise.resolve()
      await Promise.resolve()
    }
    await vi.waitFor(() => expect(setServerClockOffset).toHaveBeenCalledWith(120_000))
  })

  it('reports reconnecting while down and says what a full catch-up reloaded (#1725)', () => {
    const seen: string[] = []
    const off = adminRealtime.onStatus?.((s) => seen.push(s.state))
    fire('disconnect', 'transport close')
    expect(adminRealtime.status?.().state).toBe('reconnecting')
    fire('catchup:full')
    expect(adminRealtime.status?.()).toMatchObject({ state: 'live' })
    expect(adminRealtime.status?.().refreshed).toMatch(/reloaded/)
    expect(seen).toEqual(['reconnecting', 'live'])
    off?.()
  })

  it('falls back to the SSE stream when the API answers but no socket gets through', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }))
    )
    adminRealtime.subscribeCollections(['orders'], () => {})
    fire('connect_error', new Error('websocket error'))
    fire('connect_error', new Error('xhr poll error'))
    await vi.waitFor(() => expect(FakeEventSource.last?.url).toContain('collections=orders'))
    FakeEventSource.last?.onopen?.()
    expect(adminRealtime.status?.()).toMatchObject({ state: 'live', transport: 'sse' })
    // The socket coming back closes the stream.
    const stream = FakeEventSource.last
    fire('connect')
    expect(stream?.closed).toBe(true)
  })

  it('a View-as tab never falls back to the SSE stream (H9)', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const fetchSpy = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchSpy)
    readMasquerade.mockReturnValue({ user_id: 'BOB' })
    FakeEventSource.last = null
    fire('connect_error', new Error('websocket error'))
    fire('connect_error', new Error('xhr poll error'))
    await new Promise((r) => setTimeout(r, 20))
    expect(FakeEventSource.last).toBeNull()
    readMasquerade.mockReturnValue(null)
  })

  it('reconnects instead of signing out when the browser already holds a newer sign-in (#1719)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }))
    )
    fakeSocket.connected = false
    fire('session:ended', { reason: 'signed_out' })
    await vi.waitFor(() => expect(fakeSocket.connect).toHaveBeenCalled())
  })

  it('returns to sign-in when the session really ended (#1719)', async () => {
    const location = { pathname: '/collections/orders', search: '?x=1', href: '' }
    vi.stubGlobal('location', location)
    Object.defineProperty(window, 'location', { value: location, configurable: true })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }))
    )
    fire('session:ended', { reason: 'expired' })
    await vi.waitFor(() => expect(location.href).toContain('/login?redirect='))
    expect(location.href).toContain('error=session_expired')
  })
})
