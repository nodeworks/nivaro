import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type EngineConnLike,
  type HealthSnapshot,
  HIST_BOUNDS,
  histQuantile,
  instrumentHandlers,
  localSnapshots,
  mergeHealth,
  noteHandler,
  noteRoomGap,
  resetSocketHealth,
  sampleGrowth,
  socketBufferState,
  trackSocket
} from '../../../services/socket-health.js'
import { encodeEvent, livePayload, mergeUpdates } from '../../../services/socket-transport.js'

/** An engine.io socket stand-in: packetCreate/flush events and a websocket bufferedAmount. */
function fakeConn(ws = 0) {
  const ee = new EventEmitter() as EventEmitter & EngineConnLike
  ee.transport = { name: 'websocket', socket: { bufferedAmount: ws } }
  return ee
}

function track(conn: ReturnType<typeof fakeConn>, over: Record<string, unknown> = {}) {
  const sent: string[] = []
  const drop = vi.fn()
  const onHardLimit = vi.fn()
  const buf = trackSocket({
    id: 's1',
    conn,
    tenant: () => null,
    info: () => ({
      user: 'Ada',
      app: 'admin',
      transport: 'websocket',
      rooms: ['s1', 'collection:a']
    }),
    sendRaw: (e) => sent.push(e),
    drop,
    onHardLimit,
    limits: { soft: 1000, hard: 5000 },
    tickMs: 10,
    ...over
  })
  return { buf, sent, drop, onHardLimit }
}

beforeEach(() => resetSocketHealth())
afterEach(() => vi.useRealTimers())

describe('slow consumers (#2460) and write buffers (#2488)', () => {
  it('counts engine.io write-buffer bytes plus the websocket backlog', () => {
    const conn = fakeConn(300)
    const { buf } = track(conn)
    conn.emit('packetCreate', { data: 'x'.repeat(200) })
    conn.emit('packetCreate', { data: 'y'.repeat(100) })
    expect(buf.waiting()).toBe(600)
    conn.emit('flush', [{ data: 'x'.repeat(200) }])
    expect(buf.waiting()).toBe(400)
    expect(buf.state().peak).toBe(600)
  })

  it('holds room broadcasts over the soft limit and names the rooms once it caught up', async () => {
    vi.useFakeTimers()
    const conn = fakeConn(0)
    const { buf, sent } = track(conn)
    const update = encodeEvent('collection:update', { collection: 'a', item: 1 })
    expect(buf.intercept(update, 'collection:a', false)).toBe(false)
    conn.emit('packetCreate', { data: 'z'.repeat(1500) })
    buf.check()
    expect(buf.state().mode).toBe('soft')
    // Room broadcasts are held; control events, personal rooms and direct emits still go.
    expect(buf.intercept(update, 'collection:a', false)).toBe(true)
    expect(buf.intercept(update, 't:T1:record:a:7', false)).toBe(true)
    expect(buf.intercept(encodeEvent('access:changed', {}), 'collection:a', false)).toBe(false)
    expect(buf.intercept(encodeEvent('notification:new', {}), 'user:U1', false)).toBe(false)
    expect(buf.intercept(encodeEvent('catchup:events', {}), null, false)).toBe(false)
    expect(buf.state().held_rooms).toBe(2)
    // Drained below half the soft limit: one realtime:stale, normal delivery again.
    conn.emit('flush', [{ data: 'z'.repeat(1500) }])
    await vi.advanceTimersByTimeAsync(20)
    expect(buf.state().mode).toBe('ok')
    expect(sent).toHaveLength(1)
    const [, payload] = JSON.parse(sent[0].slice(1))
    expect(payload).toEqual({ rooms: ['collection:a', 'record:a:7'], reason: 'slow-consumer' })
    expect(buf.intercept(update, 'collection:a', false)).toBe(false)
    buf.dispose()
  })

  it('closes the socket past the hard limit and counts it', () => {
    const conn = fakeConn(6000)
    const { buf, drop, onHardLimit } = track(conn)
    buf.check()
    expect(drop).toHaveBeenCalledTimes(1)
    expect(onHardLimit).toHaveBeenCalledWith(6000)
    buf.check()
    expect(drop).toHaveBeenCalledTimes(1)
    const snap = localSnapshots().get('')
    expect(snap?.counters.hard_disconnects).toBe(1)
    expect(snap?.disconnects[0]).toMatchObject({ user: 'Ada', app: 'admin', waiting: 6000 })
  })

  it('reports the sockets with the most waiting and the biggest rooms, per tenant', () => {
    const a = fakeConn(900)
    track(a)
    const b = fakeConn(50)
    trackSocket({
      id: 's2',
      conn: b,
      tenant: () => 'T2',
      info: () => ({ user: 'Bo', app: null, transport: 'polling', rooms: ['t:T2:collection:x'] }),
      sendRaw: () => {},
      drop: () => {},
      limits: { soft: 1000, hard: 5000 }
    })
    const snaps = localSnapshots()
    expect(snaps.get('')?.top.map((s) => s.id)).toEqual(['s1'])
    expect(snaps.get('')?.rooms).toEqual([{ room: 'collection:a', size: 1 }])
    // A tenant sees its own sockets, tenant prefix off — never another tenant's.
    expect(snaps.get('T2')?.top.map((s) => s.user)).toEqual(['Bo'])
    expect(snaps.get('T2')?.rooms).toEqual([{ room: 'collection:x', size: 1 }])
    expect(socketBufferState('s2', null)).toBeNull()
    expect(socketBufferState('s2', 'T2')?.waiting).toBe(50)
    sampleGrowth(100_000)
    expect(localSnapshots().get('')?.growth).toEqual([{ t: 100_000, total: 900, max: 900 }])
  })
})

describe('handler timings (#2779)', () => {
  it('times sync and async handlers and keeps off() working', async () => {
    const ee = new EventEmitter() as EventEmitter & { id: string }
    ee.id = 's1'
    const calls: Array<[string, number]> = []
    instrumentHandlers(
      ee,
      () => null,
      (h, ms) => calls.push([h, ms])
    )
    const sync = vi.fn()
    ee.on('presence:idle', sync)
    let release: () => void = () => {}
    ee.on('record:join', () => new Promise<void>((r) => (release = r)))
    ee.emit('presence:idle', 1)
    ee.emit('record:join')
    expect(sync).toHaveBeenCalledWith(1)
    expect(calls.map((c) => c[0])).toEqual(['presence:idle'])
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.map((c) => c[0])).toEqual(['presence:idle', 'record:join'])
    ee.off('presence:idle', sync)
    ee.emit('presence:idle', 2)
    expect(sync).toHaveBeenCalledTimes(1)
    const merged = mergeHealth([localSnapshots().get('') as HealthSnapshot])
    expect(merged.handlers.map((h) => h.handler).sort()).toEqual(['presence:idle', 'record:join'])
  })

  it('reads percentiles from merged histograms', () => {
    const hist = new Array(HIST_BOUNDS.length + 1).fill(0)
    hist[2] = 90 // ≤ 2 ms
    hist[8] = 10 // ≤ 250 ms
    expect(histQuantile(hist, 0.5, 240)).toBeLessThanOrEqual(2)
    expect(histQuantile(hist, 0.95, 240)).toBeGreaterThan(100)
    expect(histQuantile(hist, 0.95, 240)).toBeLessThanOrEqual(240)
    expect(histQuantile(new Array(hist.length).fill(0), 0.5, 0)).toBe(0)
  })

  it('merges replicas: sums counters, aligns growth, keeps the slowest calls', () => {
    noteHandler(null, 'auth', 30, 2, 1_000_000)
    noteRoomGap(null, 'collection:a', 3, 'replayed')
    const mine = localSnapshots(1_000_000).get('') as HealthSnapshot
    const other: HealthSnapshot = {
      ...mine,
      instance: 'other',
      sockets: 4,
      counters: { soft_entered: 2, hard_disconnects: 1, stale_sent: 2, suppressed: 9 },
      growth: [{ t: 10_000, total: 5, max: 5 }],
      slowest: [{ handler: 'chat:join', ms: 900, sync_ms: 1, at: new Date().toISOString() }],
      gaps: {
        reports: 1,
        missed: 2,
        replayed: 0,
        full: 1,
        by_kind: { 'collection:a': { reports: 1, missed: 2 } }
      }
    }
    const m = mergeHealth([{ ...mine, growth: [{ t: 10_000, total: 7, max: 7 }] }, other])
    expect(m.replicas).toBe(2)
    expect(m.counters.hard_disconnects).toBe(1)
    expect(m.growth).toEqual([{ t: 10_000, total: 12, max: 7 }])
    expect(m.slowest[0]).toMatchObject({ handler: 'chat:join', instance: 'other' })
    expect(m.handlers.find((h) => h.handler === 'auth')?.count).toBe(2)
    expect(m.gaps).toMatchObject({ reports: 2, missed: 5, replayed: 1, full: 1 })
    expect(m.gaps.by_kind).toEqual([{ kind: 'collection:a', reports: 2, missed: 5 }])
  })
})

describe('room sequence on the wire (#2462)', () => {
  it('adds the room position and the room as the client joined it', () => {
    expect(
      livePayload({ seq: 9, room: 't:T1:collection:a', payload: { collection: 'a' }, rseq: 4 })
    ).toEqual({ collection: 'a', _seq: 9, _rseq: 4, _room: 'collection:a' })
    expect(livePayload({ seq: 9, room: 'collection:a', payload: { x: 1 } })).toEqual({
      x: 1,
      _seq: 9
    })
  })

  it('a merged burst carries the room range it covers', () => {
    const m = mergeUpdates('a', [
      { collection: 'a', item: 1, _seq: 10, _rseq: 4, _room: 'collection:a' },
      { collection: 'a', item: 2, _seq: 12, _rseq: 5, _room: 'collection:a' }
    ])
    expect(m).toMatchObject({ _seq: 12, _rseq: 5, _rseq_min: 4, _room: 'collection:a' })
  })
})
