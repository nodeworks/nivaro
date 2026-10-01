// Traffic Map group D (canvas & view): model rewind / workspace / caller groups, canvas view
// helpers, layout zoom.
import { describe, expect, it } from 'vitest'
import { appGroupOf, edgeWidthFor } from './canvasView'
import { computeLayout } from './layout'
import { CALLER_APPS_TAP, defaultFilters, TrafficModel, WORKSPACE_SCOPE_TAP } from './model'
import type { TrafficFrame, TrafficSnapshot } from './types'

const T0 = 1_800_000_000
const snap = (over: Partial<TrafficSnapshot> = {}): TrafficSnapshot => ({
  instance: 'n',
  node_scope: 'this API process only',
  at: new Date(T0 * 1000).toISOString(),
  window_s: 60,
  uptime_s: 10,
  frame: 1,
  lanes: [],
  entities: [
    {
      key: 'items/workflows',
      lane: 'items',
      entity: 'workflows',
      label: 'workflows',
      system: false,
      req: 120,
      read: 120,
      create: 0,
      update: 0,
      delete: 0,
      error: 0,
      p50: 10,
      p95: 20,
      series: [],
      routes: [],
      callers: [
        { key: 'uA', n: 100 },
        { key: 'k7', n: 20 }
      ],
      down: {},
      recent_errors: [],
      recent_writes: [],
      ext: { [WORKSPACE_SCOPE_TAP]: { 'WS-A': [60, 60, 0, 0, 0, 0] } }
    }
  ],
  callers: [
    { key: 'uA', req: 100, error: 0 },
    { key: 'k7', req: 20, error: 2 }
  ],
  down: [],
  totals: {
    req: 120,
    read: 120,
    create: 0,
    update: 0,
    delete: 0,
    error: 0,
    p50: 10,
    p95: 20,
    outbound_req: 0,
    outbound_error: 0
  },
  sockets: { count: 0, users: 0 },
  journal_seq: null,
  ext: {
    [CALLER_APPS_TAP]: { uA: 'efp-new' },
    [WORKSPACE_SCOPE_TAP]: { c: { 'WS-A': { uA: [60, 0] } }, i: { 'WS-A': { 'uA>items': 60 } } }
  },
  ...over
})
const frame = (sec: number, n: number, over: Partial<TrafficFrame> = {}): TrafficFrame => ({
  v: 1,
  at: new Date(sec * 1000).toISOString(),
  instance: 'n',
  node_scope: '',
  frame: sec,
  window_s: 1,
  entities: { 'items/workflows': [n, n, 0, 0, 0, 0, 20] },
  callers: { uA: [n, 0] },
  down: {},
  edges_in: { 'uA>items': n },
  edges_out: {},
  events: [
    { t: sec * 1000, lane: 'items', entity: 'workflows', kind: 'read', caller: 'uA', route: 'r' }
  ],
  sockets: 0,
  journal_seq: null,
  ...over
})

describe('#1100 rewind', () => {
  it('reads every figure as of the viewed second, then returns to live', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    for (let i = 1; i <= 10; i++) m.applyFrame(frame(T0 + i, 100))
    expect(m.entitySum('items/workflows', 10)[0]).toBe(1000)
    m.setView(T0)
    expect(m.rewound).toBe(true)
    expect(m.at).toBe(T0)
    expect(m.entitySum('items/workflows', 10)[0]).toBe(20) // the snapshot's 2 per second
    expect(m.visibleEvents(defaultFilters())).toHaveLength(0) // no event that early
    m.setView(T0 + 5)
    expect(m.visibleEvents(defaultFilters()).map((e) => e.t)).toEqual(
      [5, 4, 3, 2, 1].map((i) => (T0 + i) * 1000)
    )
    m.setView(null)
    expect(m.rewound).toBe(false)
    expect(m.entitySum('items/workflows', 10)[0]).toBe(1000)
  })
  it('clamps the view to what the ring holds and never reads a recycled slot', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    m.applyFrame(frame(T0 + 1000, 7))
    expect(m.rewindRange(60)).toEqual({ min: T0 + 1000 - 900 + 60, max: T0 + 1000 })
    m.setView(0)
    expect(m.at).toBe(T0 + 1000 - 900 + 60)
    // the 60 s before the clamped second: the ring was zeroed by the skip, the new second is not in it
    expect(m.entitySum('items/workflows', 60)[0]).toBe(0)
  })
})

describe('#1154 workspace scope', () => {
  it('scopes totals, hot rows, edges, callers and the ticker to one workspace', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    const f = { ...defaultFilters(), workspace: 'WS-A' }
    expect(m.totals(60, f).req).toBe(60)
    expect(m.hot(60, f, 5)[0].rps).toBe(1)
    expect(m.edges(60, f).in.get('uA>items')).toBe(1)
    m.applyFrame(
      frame(T0 + 1, 4, {
        events: [
          {
            t: 1,
            lane: 'items',
            entity: 'workflows',
            kind: 'read',
            caller: 'uA',
            route: 'r',
            extra: { ws: 'WS-A' }
          },
          { t: 2, lane: 'items', entity: 'workflows', kind: 'read', caller: 'uA', route: 'r' }
        ],
        ext: { [WORKSPACE_SCOPE_TAP]: { e: { 'WS-A': { 'items/workflows': [4, 4, 0, 0, 0, 0] } } } }
      })
    )
    expect(m.visibleEvents(f).map((e) => e.t)).toEqual([1])
    expect(m.workspaceEntitySum('WS-A', 'items/workflows', 60)[0]).toBe(63) // 59 seeded + 4
  })
})

describe('#1133 caller groups', () => {
  it('sums several callers (approximate data: their own rings)', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    const f = { ...defaultFilters(), callers: ['uA', 'k7'] }
    expect(m.totals(60, f).req).toBe(120)
    expect(m.totals(60, f).error).toBe(2)
    expect(m.totals(60, { ...defaultFilters(), callers: ['k7'] }).req).toBe(20)
  })
})

describe('#1163 caller apps', () => {
  it('reads the snapshot map and merges frame updates', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap())
    expect(m.callerApps.get('uA')).toBe('efp-new')
    m.applyFrame(frame(T0 + 1, 1, { ext: { [CALLER_APPS_TAP]: { k7: 'admin' } } }))
    expect(m.callerApps.get('k7')).toBe('admin')
  })
  it('groups by app header, then by kind', () => {
    const apps = new Map([['uA', 'admin']])
    expect(appGroupOf('uA', apps, 'person', false)).toBe('app:admin')
    expect(appGroupOf('uB', apps, 'person', false)).toBe('app:people')
    expect(appGroupOf('k1', apps, 'key', false)).toBe('app:integrations')
    expect(appGroupOf('cron:nightly', apps, 'source', true)).toBe('app:cron')
    expect(appGroupOf('anon', apps, 'anon', false)).toBe('app:anon')
  })
})

describe('#1162 edge thickness', () => {
  it('square root by default, log flatter, linear proportional to the busiest edge', () => {
    expect(edgeWidthFor(0, 'sqrt')).toBe(0)
    expect(edgeWidthFor(4, 'sqrt')).toBeCloseTo(5.4)
    expect(edgeWidthFor(9, 'log')).toBeCloseTo(4.6)
    expect(edgeWidthFor(5, 'linear', 10)).toBe(6)
    expect(edgeWidthFor(1000, 'sqrt')).toBe(11)
  })
})

describe('#1161 semantic zoom layout', () => {
  const input = {
    width: 1000,
    callers: ['uA'],
    lanes: [{ id: 'items' as const, entities: ['workflows', 'regions'] }],
    downs: ['db']
  }
  it('lanes only when zoomed out, taller rows when zoomed in', () => {
    const out = computeLayout({ ...input, zoom: 0 })
    expect(Object.keys(out.ents)).toEqual([])
    expect(out.lanes.items.h).toBe(26)
    const mid = computeLayout(input)
    expect(mid.ents['items/workflows'].h).toBe(20)
    const det = computeLayout({ ...input, zoom: 2 })
    expect(det.ents['items/workflows'].h).toBe(34)
    expect(det.rowH).toBe(34)
  })
})
