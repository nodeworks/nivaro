import { describe, expect, it } from 'vitest'
import { applyFilters, defaultFilters, TrafficModel } from './model'
import type { TrafficFrame, TrafficSnapshot } from './types'

const T0 = 1_800_000_000
const snap = (over: Partial<TrafficSnapshot> = {}): TrafficSnapshot => ({
  instance: 'test-node',
  node_scope: 'this API process only',
  at: new Date(T0 * 1000).toISOString(),
  window_s: 60,
  uptime_s: 10,
  frame: 5,
  lanes: [{ id: 'items', label: 'Items', route_hint: '/api/items/:collection' }],
  entities: [
    {
      key: 'items/workflows',
      lane: 'items',
      entity: 'workflows',
      label: 'workflows',
      system: false,
      req: 120,
      read: 100,
      create: 2,
      update: 10,
      delete: 0,
      error: 8,
      p50: 100,
      p95: 500,
      series: Array.from({ length: 60 }, () => 2),
      routes: [{ route: 'GET /api/items/workflows', n: 90 }],
      callers: [
        { key: 'uA', n: 100 },
        { key: 'k7', n: 20 }
      ],
      down: { db: 120 },
      recent_errors: [],
      recent_writes: []
    }
  ],
  callers: [
    { key: 'uA', req: 100, error: 4 },
    { key: 'k7', req: 20, error: 4 }
  ],
  down: [{ id: 'db', label: 'SQL Server', kind: 'db', req: 120, error: 0, p95: 240 }],
  totals: {
    req: 120,
    read: 100,
    create: 2,
    update: 10,
    delete: 0,
    error: 8,
    p50: 100,
    p95: 500,
    outbound_req: 0,
    outbound_error: 0
  },
  sockets: { count: 3, users: 2 },
  journal_seq: 77,
  ...over
})
const frame = (sec: number, over: Partial<TrafficFrame> = {}): TrafficFrame => ({
  v: 1,
  at: new Date(sec * 1000).toISOString(),
  instance: 'test-node',
  node_scope: 'this API process only',
  frame: 6,
  window_s: 1,
  entities: { 'items/workflows': [3, 2, 0, 1, 0, 0, 510] },
  callers: { uA: [3, 0] },
  down: { db: [3, 0, 200] },
  edges_in: { 'uA>items': 3 },
  edges_out: { 'items>db': 3 },
  events: [
    {
      t: sec * 1000,
      lane: 'items',
      entity: 'workflows',
      kind: 'update',
      caller: 'uA',
      route: 'items write',
      record: '371407',
      fields: ['vendor']
    }
  ],
  sockets: 3,
  journal_seq: 78,
  ...over
})

describe('TrafficModel', () => {
  it('seeds rings from a snapshot and sums the window', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    expect(m.entitySum('items/workflows', 60)).toEqual([120, 100, 2, 10, 0, 8])
    expect(m.entitySeries('items/workflows', 60, 60)).toHaveLength(60)
    expect(m.instance).toBe('test-node')
    expect(m.callerSum('uA', 60)).toEqual([100, 4])
    expect(m.downSum('db', 60)[0]).toBe(120)
  })
  it('a frame adds one second, records the pulse and the event', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    m.applyFrame(frame(T0 + 1))
    expect(m.entitySum('items/workflows', 60)[0]).toBe(121)
    expect(m.entitySum('items/workflows', 60)[3]).toBe(11)
    expect(m.pulses.get('items/workflows')?.kind).toBe('update')
    expect(m.events[0].record).toBe('371407')
    expect(m.journalSeq).toBe(78)
    expect(m.entityMeta('items/workflows')?.p95).toBe(510)
  })
  it('skipping forward zeroes the gap; a 15-minute gap empties the window', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    m.applyFrame(frame(T0 + 1000))
    expect(m.entitySum('items/workflows', 60)[0]).toBe(3)
    expect(m.entitySum('items/workflows', 900)[0]).toBe(3)
  })
  it('snapshot after frames replaces rings — reconnect never double counts', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    m.applyFrame(frame(T0 + 1))
    m.applyFrame(frame(T0 + 2))
    m.applySnapshot(snap({ at: new Date((T0 + 2) * 1000).toISOString() }))
    expect(m.entitySum('items/workflows', 60)[0]).toBe(120)
    expect(m.events.length).toBeGreaterThan(0) // the ticker keeps what it had
  })
  it('filters drive edges, totals, hot and visible events', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    m.applyFrame(
      frame(T0 + 1, {
        events: [
          {
            t: 1,
            lane: 'items',
            entity: 'workflows',
            kind: 'read',
            caller: 'uA',
            route: 'GET /api/items/workflows',
            status: 200,
            ms: 5
          },
          {
            t: 2,
            lane: 'items',
            entity: 'workflows',
            kind: 'error',
            caller: 'k7',
            route: 'PATCH /api/items/workflows/:id',
            status: 422,
            ms: 5,
            code: 'X'
          }
        ]
      })
    )
    const f = defaultFilters()
    expect(m.totals(60, f).req).toBe(121)
    expect(m.hot(60, f, 5)[0]).toMatchObject({ key: 'items/workflows' })
    expect(m.edges(60, f).in.get('uA>items')).toBeGreaterThan(0)
    f.kinds.delete('read')
    expect(m.visibleEvents(f).every((e) => e.kind !== 'read')).toBe(true)
    f.caller = 'k7'
    expect(m.visibleEvents(f).map((e) => e.caller)).toEqual(['k7'])
    expect(m.edges(60, f).in.has('uA>items')).toBe(false)
    const g = defaultFilters()
    g.types.delete('items')
    expect(m.hot(60, g, 5)).toEqual([])
    expect(applyFilters(g, { lane: 'items' })).toBe(false)
    expect(applyFilters(defaultFilters(), { lane: 'system' })).toBe(false) // system off by default
  })
  it('the ticker is capped at 80 newest-first', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    for (let i = 1; i <= 10; i++)
      m.applyFrame(
        frame(T0 + i, {
          events: Array.from({ length: 10 }, (_, j) => ({
            t: (T0 + i) * 1000 + j,
            lane: 'items' as const,
            entity: 'workflows',
            kind: 'read' as const,
            caller: 'uA',
            route: 'r'
          }))
        })
      )
    expect(m.events).toHaveLength(80)
    expect(m.events[0].t).toBeGreaterThan(m.events[79].t)
  })
})

describe('rulings', () => {
  it('R14 seeded fractional counts survive', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    expect(m.entitySum('items/workflows', 60)[1]).toBe(100)
  })
  it('R16 seeded edges read as rate n/win', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    expect(m.edges(60, defaultFilters()).in.get('uA>items')).toBeCloseTo(100 / 60)
    expect(m.edges(60, defaultFilters()).out.get('items>db')).toBeCloseTo(120 / 60)
  })
  it('R24 lane other counts in totals even when its chip is off', () => {
    const m = new TrafficModel()
    m.applySnapshot(
      snap({
        entities: [{ ...snap().entities[0], key: 'other/misc', lane: 'other', entity: 'misc' }]
      })
    )
    const f = defaultFilters()
    expect(f.types.has('other')).toBe(false)
    expect(m.totals(60, f).req).toBe(120)
    expect(m.hot(60, f, 5)).toEqual([])
  })
})

describe('fix round 1', () => {
  const quiet = (sec: number, n = 2, over: Partial<TrafficFrame> = {}): TrafficFrame =>
    frame(sec, {
      frame: sec,
      entities: { 'items/workflows': [n, n, 0, 0, 0, 0, 100] },
      callers: { uA: [n, 0] },
      down: { db: [n, 0, 10] },
      edges_in: { 'uA>items': n },
      edges_out: { 'items>db': n },
      events: [],
      ...over
    })
  it('1 callers, down and edges seed spread so live frames do not stack', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    for (let i = 1; i <= 30; i++) m.applyFrame(quiet(T0 + i))
    expect(m.callerSum('uA', 60)[0]).toBe(110) // snapshot says uA made 100; 30 live s at 2 + 30 seeded s at 100/60
    expect(m.downSum('db', 60)[0]).toBe(120)
    expect(m.edges(60, defaultFilters()).out.get('items>db')).toBeCloseTo(2)
    expect(m.edges(60, defaultFilters()).in.get('uA>items')).toBeCloseTo(110 / 60)
  })
  it('2 duplicate frame is idempotent', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    m.applyFrame(quiet(T0 + 1, 5))
    const a = m.entitySum('items/workflows', 60)[0]
    m.applyFrame(quiet(T0 + 1, 5))
    expect(m.entitySum('items/workflows', 60)[0]).toBe(a)
    expect(m.events.length).toBe(0)
  })
  it('2 frame for an already-covered older second is ignored', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    m.applyFrame(quiet(T0 - 5, 50))
    expect(m.entitySum('items/workflows', 60)[0]).toBe(120)
  })
  it('2 a frame received before the snapshot but newer survives it', () => {
    const m = new TrafficModel()
    m.applyFrame(quiet(T0 + 1, 7))
    m.applySnapshot(snap())
    expect(m.entitySum('items/workflows', 60)[0]).toBe(120 - 2 + 7 - 0)
  })
  it('3 write-only entity with req 0 seeds its kind counts', () => {
    const m = new TrafficModel()
    const e = {
      ...snap().entities[0],
      req: 0,
      read: 0,
      create: 50,
      update: 0,
      error: 0,
      series: new Array(60).fill(0)
    }
    m.applySnapshot(snap({ entities: [e] }))
    expect(m.entitySum('items/workflows', 60)[2]).toBe(50)
  })
  it('4 caller filter drives totals and hot', () => {
    const m = new TrafficModel()
    const e2 = {
      ...snap().entities[0],
      key: 'items/other',
      entity: 'other',
      callers: [{ key: 'uZ', n: 5 }]
    }
    m.applySnapshot(snap({ entities: [snap().entities[0], e2] }))
    const f = defaultFilters()
    f.caller = 'k7'
    expect(m.totals(60, f).req).toBe(20)
    expect(m.totals(60, f).error).toBe(4)
    expect(m.hot(60, f, 5).map((r) => r.key)).toEqual(['items/workflows'])
    m.applyFrame(
      quiet(T0 + 1, 2, {
        events: [{ t: 1, lane: 'items', entity: 'other', kind: 'read', caller: 'k7', route: 'r' }]
      })
    )
    expect(
      m
        .hot(60, f, 5)
        .map((r) => r.key)
        .sort()
    ).toEqual(['items/other', 'items/workflows'])
  })
  it('5 stale add is ignored', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    m.applyFrame(quiet(T0 + 2000, 1))
    m.applyFrame(quiet(T0 + 1, 99))
    expect(m.entitySum('items/workflows', 900)[0]).toBe(1)
  })
  it('6 the snapshot object is never mutated', () => {
    const m = new TrafficModel()
    const s = snap()
    m.applySnapshot(s)
    m.applyFrame(
      quiet(T0 + 1, 2, {
        events: [
          {
            t: 1,
            lane: 'items',
            entity: 'workflows',
            kind: 'update',
            caller: 'uA',
            route: 'r',
            record: '1'
          }
        ]
      })
    )
    expect(s.entities[0].p95).toBe(500)
    expect(s.entities[0].recent_writes).toHaveLength(0)
    expect(m.entityMeta('items/workflows')?.recent_writes).toHaveLength(1)
  })
  it('7 p95 ignores zero and agrees between meta and ring', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    m.applyFrame(quiet(T0 + 1, 2, { entities: { 'items/workflows': [1, 1, 0, 0, 0, 0, 0] } }))
    expect(m.entityMeta('items/workflows')?.p95).toBe(500)
    expect(m.entityP95('items/workflows')).toBe(500)
  })
  it('8 snapshot totals p50/p95 are kept until frames move on', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    expect(m.snapshotTotals?.p95).toBe(500)
    expect(m.totals(60, defaultFilters()).p50).toBe(100)
    expect(m.totals(60, defaultFilters()).p95).toBe(500)
    m.applyFrame(quiet(T0 + 1))
    expect(m.totals(60, defaultFilters()).p95).toBeGreaterThan(0)
  })
  it('10 idle rings are pruned', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    for (let i = 0; i < 60; i++)
      m.applyFrame({
        ...quiet(T0 + 1000 + i),
        entities: { 'items/fresh': [1, 1, 0, 0, 0, 0, 5] },
        callers: {},
        down: {},
        edges_in: {},
        edges_out: {}
      })
    expect(m.entityKeys()).toEqual(['items/fresh'])
    expect(m.entityMeta('items/workflows')).toBeNull()
    expect(m.callerKeys()).toEqual([])
  })
})
