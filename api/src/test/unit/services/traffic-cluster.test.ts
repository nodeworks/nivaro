// api/src/test/unit/services/traffic-cluster.test.ts — #1098 relay + snapshot merge
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

import {
  ANNOUNCE_EVERY_MS,
  type ClusterMessage,
  TrafficClusterRelay,
  WATCH_TTL_MS
} from '../../../services/traffic-cluster.js'
import type { FrameWire, SnapshotEntity, TrafficSnapshot } from '../../../services/traffic-map.js'
import { diffInstances, mergeSnapshots } from '../../../services/traffic-merge.js'
import { currentStoreId } from '../../../services/traffic-taps.js'

function ent(key: string, over: Partial<SnapshotEntity> = {}): SnapshotEntity {
  const [lane, entity] = key.split('/') as [SnapshotEntity['lane'], string]
  return {
    key,
    lane,
    entity,
    label: entity,
    system: false,
    req: 0,
    read: 0,
    create: 0,
    update: 0,
    delete: 0,
    error: 0,
    p50: 0,
    p95: 0,
    series: [0, 0, 0],
    routes: [],
    callers: [],
    down: {},
    recent_errors: [],
    recent_writes: [],
    ...over
  }
}
function snap(over: Partial<TrafficSnapshot> = {}): TrafficSnapshot {
  return {
    instance: 'staging',
    node_scope: 'this API process only',
    at: '2026-10-01T10:00:00.000Z',
    window_s: 60,
    uptime_s: 10,
    frame: 5,
    lanes: [],
    entities: [],
    callers: [],
    down: [],
    totals: {
      req: 0,
      read: 0,
      create: 0,
      update: 0,
      delete: 0,
      error: 0,
      p50: 0,
      p95: 0,
      outbound_req: 0,
      outbound_error: 0
    },
    sockets: { count: 1, users: 1 },
    journal_seq: null,
    ...over
  }
}

describe('mergeSnapshots', () => {
  it('adds counts, keeps the worst p95, merges routes/callers/recent lists', () => {
    const a = snap({
      entities: [
        ent('items/workflows', {
          req: 10,
          read: 8,
          error: 2,
          p50: 100,
          p95: 300,
          series: [1, 2, 3],
          routes: [{ route: 'GET /x', n: 10 }],
          callers: [{ key: 'u1', n: 10 }],
          down: { db: 10 },
          recent_errors: [
            {
              at: '2026-10-01T09:59:00Z',
              status: 500,
              code: null,
              route: 'r',
              caller: 'u1',
              record: null
            }
          ]
        })
      ],
      callers: [{ key: 'u1', req: 10, error: 2 }],
      down: [{ id: 'db', label: 'SQL Server', kind: 'db', req: 10, error: 0, p95: 20 }],
      totals: { ...snap().totals, req: 10, read: 8, error: 2, p50: 100, p95: 300 },
      sockets: { count: 2, users: 2 },
      journal_seq: 40
    })
    const b = snap({
      at: '2026-10-01T10:00:01.000Z',
      entities: [
        ent('items/workflows', {
          req: 30,
          read: 30,
          p50: 200,
          p95: 250,
          series: [3, 3, 3],
          routes: [
            { route: 'GET /x', n: 20 },
            { route: 'GET /y', n: 10 }
          ],
          callers: [{ key: 'u2', n: 30 }],
          down: { db: 30 },
          recent_errors: [
            {
              at: '2026-10-01T10:00:00Z',
              status: 404,
              code: null,
              route: 'r',
              caller: 'u2',
              record: null
            }
          ]
        }),
        ent('graphql/Q', { req: 5, read: 5 })
      ],
      callers: [
        { key: 'u1', req: 1, error: 0 },
        { key: 'u2', req: 30, error: 0 }
      ],
      down: [{ id: 'db', label: 'SQL Server', kind: 'db', req: 30, error: 1, p95: 50 }],
      totals: { ...snap().totals, req: 35, read: 35, p50: 200, p95: 250 },
      sockets: { count: 3, users: 1 },
      journal_seq: 41
    })
    const m = mergeSnapshots([a, b])
    const wf = m.entities.find((e) => e.key === 'items/workflows') as SnapshotEntity
    expect(wf.req).toBe(40)
    expect(wf.error).toBe(2)
    expect(wf.p95).toBe(300)
    expect(wf.p50).toBe(175) // (100*10 + 200*30) / 40
    expect(wf.series).toEqual([4, 5, 6])
    expect(wf.routes[0]).toEqual({ route: 'GET /x', n: 30 })
    expect(wf.down).toEqual({ db: 40 })
    expect(wf.recent_errors.map((e) => e.status)).toEqual([404, 500])
    expect(m.entities[0].key).toBe('items/workflows') // busiest first
    expect(m.callers).toEqual([
      { key: 'u2', req: 30, error: 0 },
      { key: 'u1', req: 11, error: 2 }
    ])
    expect(m.down[0]).toMatchObject({ req: 40, error: 1, p95: 50 })
    expect(m.totals.req).toBe(45)
    expect(m.totals.p95).toBe(300)
    expect(m.sockets).toEqual({ count: 5, users: 2 })
    expect(m.journal_seq).toBe(41)
    expect(m.at).toBe('2026-10-01T10:00:01.000Z')
    expect(m.node_scope).toBe('all 2 API processes')
  })
  it('one snapshot passes through; none throws', () => {
    const one = snap()
    expect(mergeSnapshots([one])).toBe(one)
    expect(() => mergeSnapshots([])).toThrow()
  })
})

describe('diffInstances', () => {
  it('lines entities up and flags the ones only one side has', () => {
    const here = snap({ entities: [ent('items/a', { req: 5 }), ent('items/b', { req: 1 })] })
    const there = snap({ entities: [ent('items/b', { req: 9 }), ent('items/c', { req: 2 })] })
    const rows = diffInstances(here, there)
    expect(rows.map((r) => [r.key, r.only])).toEqual([
      ['items/b', null],
      ['items/a', 'here'],
      ['items/c', 'there']
    ])
    expect(rows[0].here.req).toBe(1)
    expect(rows[0].there.req).toBe(9)
  })
})

describe('TrafficClusterRelay', () => {
  const frame = { v: 1, at: 'x', entities: {} } as unknown as FrameWire
  function mk(node: string, rooms = new Map<string, Set<string>>(), now = { t: 0 }) {
    const sent: ClusterMessage[] = []
    const emitted: Array<{ room: string; payload: unknown }> = []
    const io = {
      sockets: { adapter: { rooms } },
      to: () => ({ emit: () => {} }),
      local: {
        to: (room: string) => ({
          emit: (_e: string, p: unknown) => void emitted.push({ room, payload: p })
        })
      }
    }
    const r = new TrafficClusterRelay(
      node,
      (m) => void sent.push(m),
      () => io,
      () => snap({ instance: `inst-${node}`, uptime_s: currentStoreId() === 't:acme' ? 7 : 1 }),
      { list: async () => ['n1', 'n2'] },
      () => now.t
    )
    return { r, sent, emitted, now }
  }

  it('announces at most every 2 s and treats an announcement as a 5 s watch', () => {
    const a = mk('n1')
    a.r.announce('default')
    a.r.announce('default')
    expect(a.sent).toHaveLength(1)
    a.now.t = ANNOUNCE_EVERY_MS
    a.r.announce('default')
    expect(a.sent).toHaveLength(2)

    const b = mk('n2')
    expect(b.r.watched('default')).toBe(false)
    b.r.receive(a.sent[0])
    expect(b.r.watched('default')).toBe(true)
    expect(b.r.watched('t:other')).toBe(false)
    b.now.t = WATCH_TTL_MS + 1
    expect(b.r.watched('default')).toBe(false)
  })
  it('ignores its own messages', () => {
    const a = mk('n1')
    a.r.receive({ t: 'watch', node: 'n1', store: 'default' })
    expect(a.r.watched('default')).toBe(false)
  })
  it("re-emits another node's frame to the local room, only when someone here watches", () => {
    const rooms = new Map<string, Set<string>>()
    const b = mk('n2', rooms)
    b.r.receive({ t: 'frame', node: 'n1', store: 'default', frame })
    expect(b.emitted).toHaveLength(0)
    rooms.set('watch:traffic-map', new Set(['s']))
    b.r.receive({ t: 'frame', node: 'n1', store: 'default', frame })
    rooms.set('watch:traffic-map:t:acme', new Set(['s']))
    b.r.receive({ t: 'frame', node: 'n1', store: 't:acme', frame })
    expect(b.emitted.map((e) => e.room)).toEqual(['watch:traffic-map', 'watch:traffic-map:t:acme'])
  })
  it('collects every node snapshot through request/response, in the right store', async () => {
    const a = mk('n1')
    const b = mk('n2')
    const p = a.r.collect('t:acme', 60, 500)
    await new Promise((r) => setTimeout(r, 0))
    const reqMsg = a.sent.find((m) => m.t === 'snap-req') as ClusterMessage
    expect(reqMsg).toBeTruthy()
    b.r.receive(reqMsg)
    const res = b.sent.find((m) => m.t === 'snap-res') as ClusterMessage
    expect(res).toMatchObject({ to: 'n1', node: 'n2' })
    a.r.receive(res)
    const all = await p
    expect([...all.keys()].sort()).toEqual(['n1', 'n2'])
    // each node built its snapshot inside the tenant store
    expect(all.get('n2')?.uptime_s).toBe(7)
    expect(all.get('n1')?.uptime_s).toBe(7)
  })
  it('a node that never answers is left out after the timeout', async () => {
    const a = mk('n1')
    const all = await a.r.collect('default', 60, 20)
    expect([...all.keys()]).toEqual(['n1'])
  })
  it('a snapshot request for a bad window is ignored', () => {
    const b = mk('n2')
    b.r.receive({ t: 'snap-req', id: 'x', node: 'n1', store: 'default', window: 61 })
    expect(b.sent).toHaveLength(0)
  })
})
