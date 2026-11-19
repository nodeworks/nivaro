// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RealtimeStatus } from './realtime'
import { type LivenessHandle, type RepairOutcome, registerLiveness } from './socket-liveness'
import { createSocketRealtime, type SocketLike } from './socket-realtime'

/** A minimal socket.io-client stand-in: local listeners, an onAny tap and a log of emits. */
function fakeSocket(connected = true) {
  const handlers = new Map<string, Set<(...a: any[]) => void>>()
  const anyTaps: Array<(event: string, ...a: any[]) => void> = []
  const sent: Array<[string, unknown]> = []
  const s: SocketLike & {
    sent: typeof sent
    serverSends: (event: string, payload?: unknown) => void
  } = {
    connected,
    sent,
    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)?.add(cb)
      return s
    },
    off(event, cb) {
      if (cb) handlers.get(event)?.delete(cb)
      else handlers.delete(event)
      return s
    },
    emit(event, payload) {
      sent.push([event, payload])
      return s
    },
    onAny(cb) {
      anyTaps.push(cb)
      return s
    },
    listeners(event) {
      return [...(handlers.get(event) ?? [])]
    },
    serverSends(event, payload) {
      for (const t of anyTaps) t(event, payload)
      for (const h of [...(handlers.get(event) ?? [])]) h(payload)
    }
  }
  return s
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createSocketRealtime', () => {
  it('joins a collection once for several holders and leaves after the last', () => {
    const s = fakeSocket()
    const rt = createSocketRealtime({ socket: s })
    const a = rt.subscribeCollections(['orders'], () => {})
    const b = rt.subscribeCollections(['orders'], () => {})
    expect(s.sent.filter(([e]) => e === 'collection:join')).toEqual([
      ['collection:join', { collection: 'orders' }]
    ])
    a()
    a() // a double cleanup must not release the other holder
    expect(s.sent.some(([e]) => e === 'collection:leave')).toBe(false)
    b()
    expect(s.sent.at(-1)).toEqual(['collection:leave', { collection: 'orders' }])
    expect(rt.held().collections).toEqual([])
  })

  it('delivers only the subscribed collections', () => {
    const s = fakeSocket()
    const rt = createSocketRealtime({ socket: s })
    const got: unknown[] = []
    rt.subscribeCollections(['orders'], (ev) => got.push(ev.item))
    s.serverSends('collection:update', { collection: 'orders', item: 1 })
    s.serverSends('collection:update', { collection: 'invoices', item: 2 })
    expect(got).toEqual([1])
  })

  it('rejoins every held room after auth:ok (a reconnect is a new server socket)', () => {
    const s = fakeSocket(false)
    const rt = createSocketRealtime({ socket: () => s })
    rt.subscribeCollections(['orders'], () => {})
    rt.joinWatch('jobs')
    rt.emit('ops:join', { topic: 'support' })
    rt.emit('ops:join', { topic: 'support' })
    // Not connected yet: nothing is sent until the socket authenticates.
    expect(s.sent).toEqual([])
    s.connected = true
    s.serverSends('auth:ok')
    expect(s.sent).toEqual([
      ['collection:join', { collection: 'orders' }],
      ['admin:join', { room: 'jobs' }],
      ['ops:join', { topic: 'support' }]
    ])
    // One ops:leave per join; the room is left only with the last.
    rt.emit('ops:leave', { topic: 'support' })
    expect(s.sent.some(([e]) => e === 'ops:leave')).toBe(false)
    rt.emit('ops:leave', { topic: 'support' })
    expect(s.sent.at(-1)).toEqual(['ops:leave', { topic: 'support' }])
  })

  it('passes other events straight through', () => {
    const s = fakeSocket()
    const rt = createSocketRealtime({ socket: s })
    const seen: unknown[] = []
    const off = rt.on('notification:new', (p) => seen.push(p))
    s.serverSends('notification:new', { id: 7 })
    off()
    s.serverSends('notification:new', { id: 8 })
    expect(seen).toEqual([{ id: 7 }])
    rt.emit('page:at', { path: '/x', app: 'portal' })
    expect(s.sent.at(-1)).toEqual(['page:at', { path: '/x', app: 'portal' }])
  })

  it('asks for the missed events after a reconnect and replays them into the listeners', () => {
    const s = fakeSocket()
    const rt = createSocketRealtime({ socket: s })
    const got: unknown[] = []
    rt.subscribeCollections(['orders'], (ev) => got.push(ev.item))
    const states: string[] = []
    rt.onStatus((st) => states.push(st.state))
    s.serverSends('auth:ok')
    s.serverSends('collection:update', { collection: 'orders', item: 1, _seq: 41 })
    s.serverSends('disconnect')
    expect(rt.status().state).toBe('reconnecting')
    s.serverSends('auth:ok')
    expect(s.sent.at(-1)).toEqual(['catchup', { cursor: 41 }])
    s.serverSends('catchup:events', {
      events: [{ seq: 42, event: 'collection:update', payload: { collection: 'orders', item: 2 } }]
    })
    expect(got).toEqual([1, 2])
    expect(rt.status().state).toBe('live')
    expect(states).toEqual(['reconnecting', 'live'])
  })

  it('turns catchup:full, access:changed, config:update and force-refresh into window events', () => {
    const s = fakeSocket()
    createSocketRealtime({
      socket: s,
      windowEvents: { forceRefresh: false },
      reactionJitterMs: 0
    }).on('x', () => {})
    const seen: string[] = []
    for (const n of [
      'nvr:catchup-full',
      'nvr:access-changed',
      'nvr:config-update',
      'nvr:force-refresh'
    ])
      window.addEventListener(n, () => seen.push(n))
    s.serverSends('catchup:full')
    s.serverSends('access:changed', { rooms_left: [] })
    s.serverSends('access:changed', { rooms_left: ['collection:orders'] })
    s.serverSends('config:update', { surface: 'layout' })
    s.serverSends('client:force-refresh', { seconds: 5 })
    expect(seen).toEqual(['nvr:catchup-full', 'nvr:access-changed', 'nvr:config-update'])
  })

  it('spreads catchup:full and access:changed reactions over a random delay, merged', () => {
    vi.useFakeTimers()
    const s = fakeSocket()
    createSocketRealtime({ socket: s, reactionJitterMs: 3000 }).on('x', () => {})
    const full: unknown[] = []
    const access: Array<{ rooms_left?: string[] }> = []
    const onFull = () => full.push(1)
    const onAccess = (e: Event) => access.push((e as CustomEvent).detail)
    window.addEventListener('nvr:catchup-full', onFull)
    window.addEventListener('nvr:access-changed', onAccess)
    try {
      s.serverSends('catchup:full')
      s.serverSends('catchup:full')
      s.serverSends('access:changed', { rooms_left: ['collection:a'] })
      s.serverSends('access:changed', { rooms_left: ['collection:b'] })
      expect(full).toEqual([])
      expect(access).toEqual([])
      vi.advanceTimersByTime(3000)
      expect(full).toEqual([1])
      expect(access).toEqual([{ rooms_left: ['collection:a', 'collection:b'] }])
    } finally {
      window.removeEventListener('nvr:catchup-full', onFull)
      window.removeEventListener('nvr:access-changed', onAccess)
    }
  })

  it('counts as live again when a catch-up never answers', () => {
    vi.useFakeTimers()
    const s = fakeSocket()
    const rt = createSocketRealtime({ socket: s, catchupTimeoutMs: 1000 })
    rt.on('x', () => {})
    s.serverSends('auth:ok')
    s.serverSends('collection:update', { collection: 'orders', item: 1, _seq: 3 })
    s.serverSends('disconnect')
    s.serverSends('auth:ok')
    expect(rt.status().state).toBe('reconnecting')
    vi.advanceTimersByTime(1000)
    expect(rt.status().state).toBe('live')
    expect(rt.status().resumed).toBe('unverified')
  })

  it('says how each reconnect resumed (#2450)', () => {
    const s = fakeSocket(false)
    const rt = createSocketRealtime({ socket: s })
    rt.on('x', () => {})
    s.connected = true
    s.serverSends('auth:ok')
    expect(rt.status().resumed ?? null).toBe(null)
    s.serverSends('collection:update', { collection: 'orders', item: 1, _seq: 5 })
    s.serverSends('disconnect')
    s.serverSends('auth:ok')
    s.serverSends('catchup:events', { events: [] })
    expect(rt.status().resumed).toBe('replayed')
    s.serverSends('disconnect')
    s.serverSends('auth:ok')
    s.serverSends('catchup:full')
    expect(rt.status().resumed).toBe('reloaded')
  })

  it('a quiet socket replays from the sign-in cursor; one that never got it is unverified', () => {
    const s = fakeSocket()
    const rt = createSocketRealtime({ socket: s })
    rt.on('x', () => {})
    s.serverSends('auth:ok')
    s.serverSends('catchup:cursor', { seq: 900 })
    s.serverSends('disconnect')
    s.serverSends('auth:ok')
    expect(s.sent.at(-1)).toEqual(['catchup', { cursor: 900 }])

    const q = fakeSocket(false)
    const rt2 = createSocketRealtime({ socket: q })
    rt2.on('x', () => {})
    q.connected = true
    q.serverSends('auth:ok')
    q.serverSends('disconnect')
    q.serverSends('auth:ok')
    expect(q.sent.some(([e]) => e === 'catchup')).toBe(false)
    expect(rt2.status()).toMatchObject({ state: 'live', resumed: 'unverified' })
  })

  it('never moves its own cursor back to the sign-in cursor', () => {
    const s = fakeSocket()
    const rt = createSocketRealtime({ socket: s })
    rt.on('x', () => {})
    s.serverSends('auth:ok')
    s.serverSends('collection:update', { collection: 'orders', item: 1, _seq: 950 })
    s.serverSends('catchup:cursor', { seq: 900 })
    s.serverSends('disconnect')
    s.serverSends('auth:ok')
    expect(s.sent.at(-1)).toEqual(['catchup', { cursor: 950 }])
  })

  it('re-reads just the record whose own counter skipped (realtime 23)', () => {
    vi.useFakeTimers()
    const s = fakeSocket()
    const rt = createSocketRealtime({ socket: s })
    const got: unknown[] = []
    rt.subscribeCollections(['orders'], (ev) => got.push(ev))
    s.serverSends('collection:update', { collection: 'orders', item: 7, _iseq: 1 })
    s.serverSends('collection:update', { collection: 'orders', item: 7, _iseq: 3 })
    expect(got).toHaveLength(2)
    vi.advanceTimersByTime(4000)
    expect(got.at(-1)).toEqual({ collection: 'orders', item: '7' })
    // a counter that keeps going is quiet
    s.serverSends('collection:update', { collection: 'orders', item: 7, _iseq: 4 })
    vi.advanceTimersByTime(10_000)
    expect(got).toHaveLength(4)
  })

  it('a replayed catch-up event fills a record gap (no extra read)', () => {
    vi.useFakeTimers()
    const s = fakeSocket()
    const rt = createSocketRealtime({ socket: s })
    const got: unknown[] = []
    rt.subscribeCollections(['orders'], (ev) => got.push(ev))
    s.serverSends('collection:update', { collection: 'orders', item: 7, _iseq: 1 })
    s.serverSends('collection:update', { collection: 'orders', item: 7, _iseq: 3 })
    s.serverSends('catchup:events', {
      events: [
        { seq: 10, event: 'collection:update', payload: { collection: 'orders', item: 7 }, iseq: 2 }
      ]
    })
    expect(got.at(-1)).toMatchObject({ item: 7, _seq: 10, _iseq: 2 })
    vi.advanceTimersByTime(10_000)
    expect(got).toHaveLength(3)
  })

  it('a quiet repair keeps the status quiet through its catch-up (realtime 24)', () => {
    const s = fakeSocket()
    let on = false
    const subs = new Set<(on: boolean, outcome?: RepairOutcome) => void>()
    const handle: LivenessHandle = {
      repairing: () => on,
      onRepairing: (cb) => {
        subs.add(cb)
        return () => subs.delete(cb)
      },
      stats: () => ({ probes: 0, failedProbes: 0, repairs: 0, repaired: 0, gaveUp: 0 })
    }
    const set = (next: boolean, outcome?: RepairOutcome) => {
      on = next
      for (const cb of subs) cb(next, outcome)
    }
    registerLiveness(s, handle)
    const rt = createSocketRealtime({ socket: s, reactionJitterMs: 0 })
    const seen: RealtimeStatus[] = []
    rt.onStatus((st) => seen.push(st))
    s.serverSends('catchup:cursor', { seq: 5 })
    set(true)
    s.serverSends('disconnect', 'io client disconnect')
    expect(rt.status()).toMatchObject({ state: 'reconnecting', repair: 'silent' })
    set(false, 'repaired')
    s.serverSends('auth:ok')
    expect(rt.status().repair).toBe('silent') // still waiting for the catch-up
    s.serverSends('catchup:full', {})
    // the "reloaded" line and the quiet flag arrive together, then the flag clears
    expect(seen.some((st) => st.refreshed && st.repair === 'silent')).toBe(true)
    expect(rt.status()).toMatchObject({ state: 'live', repair: null })
  })

  it('a repair that gives up clears the quiet flag at once', () => {
    const s = fakeSocket()
    let on = false
    const subs = new Set<(on: boolean, outcome?: RepairOutcome) => void>()
    registerLiveness(s, {
      repairing: () => on,
      onRepairing: (cb) => {
        subs.add(cb)
        return () => subs.delete(cb)
      },
      stats: () => ({ probes: 0, failedProbes: 0, repairs: 0, repaired: 0, gaveUp: 0 })
    })
    const rt = createSocketRealtime({ socket: s })
    rt.subscribeCollections(['orders'], () => {})
    on = true
    for (const cb of subs) cb(true)
    s.serverSends('disconnect', 'io client disconnect')
    on = false
    for (const cb of subs) cb(false, 'gave-up')
    expect(rt.status()).toMatchObject({ state: 'reconnecting', repair: null })
  })
})

describe('record rooms per holder (realtime audit, efp L1)', () => {
  it('a peek closing on the record the page shows sends no record:leave', () => {
    const s = fakeSocket()
    const rt = createSocketRealtime({ socket: s })
    const recordSent = () => s.sent.filter(([e]) => e.startsWith('record:'))
    rt.emit('record:join', { collection: 'workflows', item: '5', holder: 'page' })
    rt.emit('record:join', { collection: 'workflows', item: '5', holder: 'peek' })
    rt.emit('record:leave', { collection: 'workflows', item: '5', holder: 'peek' })
    // The holder never reaches the server; both joins do (the server join is idempotent).
    expect(recordSent()).toEqual([
      ['record:join', { collection: 'workflows', item: '5' }],
      ['record:join', { collection: 'workflows', item: '5' }]
    ])
    rt.emit('record:leave', { collection: 'workflows', item: '5', holder: 'page' })
    expect(recordSent().at(-1)).toEqual(['record:leave', { collection: 'workflows', item: '5' }])
  })
})
