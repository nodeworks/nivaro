// api/src/test/unit/services/traffic-map-batch.test.ts — post-mortem 3.1: batched, delta frames
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

// taps whose per-second figures ride every frame (`ext`)
import '../../../services/traffic-taps/auth-mix.js'
import '../../../services/traffic-taps/caller-apps.js'
import '../../../services/traffic-taps/edge-weights.js'
import '../../../services/traffic-taps/entity-callers.js'
import '../../../services/traffic-taps/metadata-cache.js'
import { TrafficClusterRelay } from '../../../services/traffic-cluster.js'
import {
  advanceTo,
  buildFrame,
  type FrameWire,
  noteRequest,
  resetTrafficMap,
  startTrafficMapEmitter,
  type TrafficEventWire,
  trafficStoreOfRoom
} from '../../../services/traffic-map.js'
import {
  BATCH_EVENTS_CAP,
  BatchEncoder,
  capBatchEvents,
  type FrameBatchWire,
  KEY_EVERY_S,
  queueBatchFrame,
  requestBatchKey,
  roomMembers,
  takeBatch
} from '../../../services/traffic-map-batch.js'
import { withTrafficStore } from '../../../services/traffic-taps.js'

const T0 = 1_800_000_000

/** The page's decoder (admin features/frame-batch.ts), minimal: copy `same` / `ext_same`. */
function decoder() {
  const last = new Map<string, Record<string, unknown>>()
  let missing = false
  return {
    get missing() {
      return missing
    },
    decode(b: FrameBatchWire): Record<string, unknown>[] {
      if (b.key) last.clear()
      return b.frames.map((d) => {
        const { same, ext_same: extSame, ...rest } = d
        const base = last.get(d.node ?? '')
        const f: Record<string, unknown> = { ...rest }
        for (const k of same ?? []) {
          if (base?.[k] === undefined) missing = true
          else f[k] = base[k]
        }
        const ext: Record<string, unknown> = { ...(d.ext ?? {}) }
        for (const id of extSame ?? []) {
          const be = base?.ext as Record<string, unknown> | undefined
          if (be?.[id] === undefined) missing = true
          else ext[id] = be[id]
        }
        if (Object.keys(ext).length) f.ext = ext
        else delete f.ext
        let prev: Record<string, unknown> | null = null
        f.events = (d.events as unknown as Record<string, unknown>[]).map((p) => {
          const { _x, ...rest } = p as Record<string, unknown> & { _x?: string[] }
          const e: Record<string, unknown> = prev ? { ...prev, ...rest } : { ...rest }
          for (const k of _x ?? []) delete e[k]
          prev = e
          return e
        })
        last.set(d.node ?? '', f)
        return f
      })
    }
  }
}

function frame(over: Partial<FrameWire> = {}): FrameWire {
  return {
    v: 1,
    at: new Date(T0 * 1000).toISOString(),
    instance: 'inst-a',
    node_scope: 'this API process (instance inst-a)',
    frame: 1,
    window_s: 1,
    entities: { 'items/a': [1, 1, 0, 0, 0, 0, 20] },
    callers: {},
    down: {},
    edges_in: {},
    edges_out: {},
    events: [],
    sockets: 3,
    journal_seq: null,
    node: 'n1',
    ...over
  }
}
const ev = (kind: TrafficEventWire['kind'], t: number): TrafficEventWire => ({
  t,
  lane: 'items',
  entity: 'a',
  kind,
  caller: 'uU1',
  route: 'GET /items/a'
})

beforeEach(() => {
  resetTrafficMap()
  advanceTo(T0)
})

describe('BatchEncoder', () => {
  it('sends sticky fields and tap figures once, then names them as unchanged', () => {
    const enc = new BatchEncoder()
    const a = frame({ ext: { 'auth-mix': { session: 4 }, apps: { x: 'y' } } })
    const b = frame({
      frame: 2,
      at: new Date((T0 + 1) * 1000).toISOString(),
      ext: { 'auth-mix': { session: 5 }, apps: { x: 'y' } }
    })
    const first = enc.encode([a], true)
    expect(first.key).toBe(true)
    expect(first.frames[0]).toMatchObject({ instance: 'inst-a', ext: a.ext })
    expect(first.frames[0].same).toBeUndefined()
    const second = enc.encode([b], false)
    const d = second.frames[0]
    expect(second.key).toBeUndefined()
    expect(d.instance).toBeUndefined()
    expect(d.node_scope).toBeUndefined()
    expect(d.same).toEqual(expect.arrayContaining(['v', 'instance', 'node_scope', 'window_s']))
    expect(d.ext).toEqual({ 'auth-mix': { session: 5 } }) // changed → sent
    expect(d.ext_same).toEqual(['apps'])
    expect(d.entities).toEqual(b.entities) // per-second counts always travel
    // the page rebuilds both frames exactly
    const dec = decoder()
    const out = [...dec.decode(first), ...dec.decode(second)]
    expect(out).toEqual([a, b])
    expect(dec.missing).toBe(false)
  })

  it('keeps a base per node and a tap that skipped a second is sent again in full', () => {
    const enc = new BatchEncoder()
    const n1 = frame({ ext: { t: 1 } })
    const n2 = frame({ node: 'n2', instance: 'inst-b', ext: { t: 1 } })
    const n1b = frame({ frame: 2 }) // no tap figure this second
    const n1c = frame({ frame: 3, ext: { t: 1 } })
    enc.encode([n1, n2], true)
    const b2 = enc.encode([n1b], false)
    expect(b2.frames[0].ext).toBeUndefined()
    expect(b2.frames[0].ext_same).toBeUndefined()
    const b3 = enc.encode([n1c], false)
    expect(b3.frames[0].ext).toEqual({ t: 1 })
  })

  it('a page without the base reports it (and asks for a key batch)', () => {
    const enc = new BatchEncoder()
    enc.encode([frame({ ext: { t: 1 } })], true)
    const dec = decoder()
    dec.decode(enc.encode([frame({ frame: 2, ext: { t: 1 } })], false))
    expect(dec.missing).toBe(true)
  })
})

describe('capBatchEvents', () => {
  it('keeps errors and writes first across frames and counts the rest as dropped', () => {
    const reads = Array.from({ length: BATCH_EVENTS_CAP }, (_, i) => ev('read', T0 * 1000 + i))
    const a = frame({ events: [ev('error', T0 * 1000 + 999), ...reads.slice(0, 20)] })
    const b = frame({ node: 'n2', events: [ev('update', T0 * 1000 + 5), ...reads.slice(20)] })
    const [ca, cb] = capBatchEvents([a, b])
    expect(ca.events.length + cb.events.length).toBe(BATCH_EVENTS_CAP)
    expect(ca.events.some((e) => e.kind === 'error')).toBe(true)
    expect(cb.events.some((e) => e.kind === 'update')).toBe(true)
    expect((ca.events_dropped ?? 0) + (cb.events_dropped ?? 0)).toBe(2)
    expect(a.events).toHaveLength(21) // input untouched (the per-frame pages got it as is)
  })
})

describe('takeBatch', () => {
  it('key on a new socket, deltas after, key again on resync and every KEY_EVERY_S', () => {
    const t = (sec: number) => takeBatch('default', ['s1'], [frame({ frame: sec })], T0 + sec)
    expect(t(1)?.key).toBe(true)
    expect(t(2)?.key).toBeUndefined()
    expect(takeBatch('default', ['s1', 's2'], [frame({ frame: 3 })], T0 + 3)?.key).toBe(true)
    expect(takeBatch('default', ['s1', 's2'], [frame({ frame: 4 })], T0 + 4)?.key).toBeUndefined()
    requestBatchKey('default', 10_000)
    expect(takeBatch('default', ['s1', 's2'], [frame({ frame: 5 })], T0 + 5)?.key).toBe(true)
    requestBatchKey('default', 10_500) // inside the 2 s gap: ignored
    expect(takeBatch('default', ['s1', 's2'], [frame({ frame: 6 })], T0 + 6)?.key).toBeUndefined()
    const late = takeBatch('default', ['s1', 's2'], [frame({ frame: 7 })], T0 + 5 + KEY_EVERY_S)
    expect(late?.key).toBe(true)
  })
  it('carries the relayed frames held since the last tick, oldest second first', () => {
    takeBatch('default', ['s1'], [], T0)
    queueBatchFrame('default', frame({ node: 'n2', at: new Date((T0 - 1) * 1000).toISOString() }))
    const b = takeBatch('default', ['s1'], [frame()], T0 + 1)
    expect(b?.frames.map((f) => f.node)).toEqual(['n2', 'n1'])
    expect(takeBatch('default', ['s1'], [], T0 + 2)).toBeNull()
  })
})

describe('rooms', () => {
  it('splits members by the join flag and maps rooms back to stores', () => {
    const io = {
      sockets: {
        adapter: { rooms: new Map([['watch:traffic-map', new Set(['a', 'b'])]]) },
        sockets: new Map([
          ['a', { data: { trafficMapBatch: true } }],
          ['b', { data: {} }]
        ])
      }
    }
    expect(roomMembers(io, 'watch:traffic-map')).toEqual({ all: 2, batch: ['a'], legacy: ['b'] })
    expect(roomMembers(io, 'watch:traffic-map:t:x').all).toBe(0)
    expect(trafficStoreOfRoom('watch:traffic-map')).toBe('default')
    expect(trafficStoreOfRoom('watch:traffic-map:t:acme')).toBe('t:acme')
    expect(trafficStoreOfRoom('watch:traffic')).toBeNull()
  })
})

describe('emitter with batch pages', () => {
  let stop: (() => void) | null = null
  afterEach(() => stop?.())

  function mkIo(members: Record<string, boolean>) {
    const sent: Array<{ to: string | string[]; ev: string; payload: unknown }> = []
    const rooms = new Map<string, Set<string>>([
      ['watch:traffic-map', new Set(Object.keys(members))]
    ])
    const sockets = new Map(
      Object.entries(members).map(([sid, batch]) => [sid, { data: { trafficMapBatch: batch } }])
    )
    const target = (to: string | string[]) => ({
      emit: (e: string, payload: unknown) => void sent.push({ to, ev: e, payload })
    })
    return {
      sent,
      rooms,
      io: { sockets: { adapter: { rooms }, sockets }, to: target, local: { to: target } }
    }
  }
  const req = (at: number) =>
    noteRequest({
      method: 'GET',
      path: '/api/items/workflows',
      status: 200,
      latencyMs: 50,
      authMethod: 'session',
      apiKeyId: null,
      userId: 'u1',
      graphqlOperation: null,
      graphqlKind: null,
      cacheHit: false,
      at
    })

  it('one batch per tick to batch pages, frames to per-frame pages, relayed frames ride the batch', async () => {
    const { sent, io } = mkIo({ b1: true, l1: false })
    let clock = T0
    stop = startTrafficMapEmitter({
      intervalMs: 5,
      io: () => io,
      now: () => clock * 1000,
      node: 'n1'
    })
    const relay = new TrafficClusterRelay(
      'n1',
      () => {},
      () => io,
      () => ({}) as never,
      { list: async () => [] }
    )
    await new Promise((r) => setTimeout(r, 15))
    req(clock * 1000)
    relay.receive({ t: 'frame', node: 'n2', store: 'default', frame: frame({ node: 'n2' }) })
    clock += 1
    await new Promise((r) => setTimeout(r, 20))
    const batches = sent.filter((s) => s.ev === 'traffic-map:batch')
    const frames = sent.filter((s) => s.ev === 'traffic-map:frame')
    expect(batches.length).toBeGreaterThanOrEqual(1)
    expect(batches.every((b) => JSON.stringify(b.to) === '["b1"]')).toBe(true)
    expect(frames.every((f) => JSON.stringify(f.to) === '["l1"]')).toBe(true)
    // the relayed frame went to the per-frame page at once and into the next batch
    expect(frames.some((f) => (f.payload as FrameWire).node === 'n2')).toBe(true)
    const nodes = batches.flatMap((b) => (b.payload as FrameBatchWire).frames.map((f) => f.node))
    expect(nodes).toEqual(expect.arrayContaining(['n1', 'n2']))
    expect((batches[0].payload as FrameBatchWire).key).toBe(true)
  })

  it('nothing is built or sent once the room is empty (a hidden tab left it)', async () => {
    const { sent, io, rooms } = mkIo({ b1: true })
    let clock = T0
    stop = startTrafficMapEmitter({ intervalMs: 5, io: () => io, now: () => clock * 1000 })
    await new Promise((r) => setTimeout(r, 15))
    rooms.delete('watch:traffic-map')
    const before = sent.length
    for (let i = 0; i < 3; i++) {
      req(clock * 1000)
      clock += 1
      await new Promise((r) => setTimeout(r, 15))
    }
    expect(sent.length).toBe(before)
  })
})

/**
 * The demo's shape (2026-10-23): one viewer, three API processes (2 web + worker), ~44 req/s.
 * Per-frame pages got 3 frames a second (their node's + 2 relayed); a batch page gets one
 * batch. Events carry request ids and the node id, as in production.
 */
describe('bytes per minute, simulated load', () => {
  it('cuts broadcasts and bytes for one viewer', () => {
    const NODES = [
      { id: 'web-1-6b1c0f2e', rps: 22 },
      { id: 'web-2-91aa77d3', rps: 20 },
      { id: 'worker-1-3e55a0c9', rps: 2 }
    ]
    const users = Array.from(
      { length: 44 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    )
    const paths = [
      '/api/presence/online',
      '/api/presence/online',
      '/api/presence/online',
      '/api/items/user_presence/7',
      '/api/items/workflows',
      '/api/notifications',
      '/api/efp/vendor-360/1229'
    ]
    let legacyBytes = 0
    let legacyCasts = 0
    let batchBytes = 0
    let batchCasts = 0
    let keyBatches = 0
    let legacyWire = 0
    let batchWire = 0
    const dec = decoder()
    let n = 0
    for (let s = 1; s <= 60; s++) {
      const sec = T0 + s
      const built: FrameWire[] = []
      for (const node of NODES) {
        const f = withTrafficStore(node.id, () => {
          advanceTo(sec)
          for (let i = 0; i < node.rps; i++) {
            const path = paths[n++ % paths.length]
            noteRequest({
              method: path.includes('user_presence') ? 'PATCH' : 'GET',
              path,
              status: 200,
              latencyMs: 120 + (n % 200),
              authMethod: 'session',
              apiKeyId: null,
              userId: users[n % users.length],
              graphqlOperation: null,
              graphqlKind: null,
              cacheHit: false,
              at: sec * 1000 + i * 20
            })
          }
          const fr = buildFrame(sec, { sockets: 17, journalSeq: 1000 + s })
          fr.node = node.id
          for (const e of fr.events) {
            e.rid = `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-${String(e.t).slice(-12)}`
            e.node = node.id
          }
          return fr
        })
        built.push(f)
      }
      // per-frame page: its own node's frame + two relayed, each a broadcast
      for (const f of built) {
        legacyBytes += JSON.stringify(f).length
        legacyWire += deflateRawSync(JSON.stringify(f)).length
        legacyCasts++
      }
      // batch page: the remote frames are queued by the relay, the tick sends one batch
      for (const f of built.slice(1)) queueBatchFrame('default', f)
      const b = takeBatch('default', ['viewer'], [built[0]], sec)
      if (b) {
        batchBytes += JSON.stringify(b).length
        batchWire += deflateRawSync(JSON.stringify(b)).length
        batchCasts++
        if (b.key) keyBatches++
        const out = dec.decode(b)
        expect(out).toHaveLength(3)
      }
    }
    expect(dec.missing).toBe(false)
    // biome-ignore lint/suspicious/noConsole: the measured numbers are what this test reports
    console.info(
      `[traffic-map 3.1] per-frame: ${legacyCasts} broadcasts/min, ${(legacyBytes / 1024).toFixed(1)} KB/min · ` +
        `batch: ${batchCasts} broadcasts/min, ${(batchBytes / 1024).toFixed(1)} KB/min (${keyBatches} key) · ` +
        `hidden tab: 0 broadcasts, 0 KB · deflated per message: ${(legacyWire / 1024).toFixed(1)} → ${(batchWire / 1024).toFixed(1)} KB/min`
    )
    expect(legacyCasts).toBe(180)
    expect(batchCasts).toBe(60)
    // The per-second figures (per-person callers, edges, tap maps) are real content: a visible
    // viewer's JSON shrinks a little (envelope, unchanged taps, packed events), the compressed
    // wire a lot (one message a second deflates better than three); a hidden tab gets nothing.
    expect(batchBytes).toBeLessThan(legacyBytes * 0.95)
    expect(batchWire).toBeLessThan(legacyWire * 0.75)
  })
})
