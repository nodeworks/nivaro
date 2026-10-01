import { describe, expect, it } from 'vitest'
import { pairProblem, toLocalInput, windowPreset } from './compare-presets'
import { mergeFrames, NodeFeed, type TrafficFrame } from './node-merge'

const T0 = 1_800_000_000
const frame = (
  node: string | undefined,
  sec: number,
  over: Partial<TrafficFrame> = {}
): TrafficFrame => ({
  v: 1,
  at: new Date(sec * 1000).toISOString(),
  instance: 'staging',
  node_scope: 'x',
  frame: 1,
  window_s: 1,
  entities: {},
  callers: {},
  down: {},
  edges_in: {},
  edges_out: {},
  events: [],
  sockets: 1,
  journal_seq: 5,
  ...(node ? { node } : {}),
  ...over
})

describe('mergeFrames (#1098)', () => {
  it('sums per-second counts, keeps the worst latency, interleaves events', () => {
    const a = frame('a', T0, {
      entities: { 'items/w': [3, 2, 1, 0, 0, 0, 100] },
      callers: { uA: [3, 0] },
      down: { db: [3, 0, 20] },
      edges_in: { 'uA>items': 3 },
      events: [{ t: 2, lane: 'items', entity: 'w', kind: 'read', caller: 'uA', route: 'r' }],
      sockets: 2,
      journal_seq: 9
    })
    const b = frame('b', T0, {
      entities: { 'items/w': [1, 1, 0, 0, 0, 1, 300], 'items/x': [1, 1, 0, 0, 0, 0, 5] },
      callers: { uA: [1, 1] },
      down: { db: [1, 0, 10] },
      edges_in: { 'uA>items': 1 },
      events: [{ t: 1, lane: 'items', entity: 'x', kind: 'read', caller: 'uA', route: 'r' }],
      events_dropped: 2,
      sockets: 3,
      journal_seq: null
    })
    const m = mergeFrames([a, b], 42)
    expect(m.entities['items/w']).toEqual([4, 3, 1, 0, 0, 1, 300])
    expect(m.entities['items/x']).toEqual([1, 1, 0, 0, 0, 0, 5])
    expect(m.callers.uA).toEqual([4, 1])
    expect(m.down.db).toEqual([4, 0, 20])
    expect(m.edges_in['uA>items']).toBe(4)
    expect(m.events.map((e) => e.t)).toEqual([1, 2])
    expect(m.events_dropped).toBe(2)
    expect(m.sockets).toBe(5)
    expect(m.journal_seq).toBe(9)
    expect(m.frame).toBe(42)
    expect(m.node).toBe('all')
    expect(a.entities['items/w']).toEqual([3, 2, 1, 0, 0, 0, 100]) // inputs untouched
  })
})

describe('NodeFeed (#1098)', () => {
  const clock = () => {
    const c = { t: T0 * 1000 }
    return { c, now: () => c.t }
  }
  it('one node: frames pass straight through', () => {
    const { now } = clock()
    const f = new NodeFeed(now)
    f.noteSnapshot({ node: 'a' })
    const out: TrafficFrame[] = []
    f.accept(frame('a', T0), (x) => out.push(x))
    f.accept(frame(undefined, T0 + 1), (x) => out.push(x))
    expect(out).toHaveLength(2)
    expect(f.snapshotUrl(60)).toBe('/traffic-map/snapshot?window=60')
  })
  it('two nodes: one merged frame per second once both arrived; asks for a cluster snapshot', () => {
    const { now } = clock()
    const f = new NodeFeed(now)
    f.noteSnapshot({ node: 'a' }, 1)
    let reseeds = 0
    f.onReseed(() => reseeds++)
    const out: TrafficFrame[] = []
    const apply = (x: TrafficFrame) => out.push(x)
    f.accept(frame('a', T0, { entities: { 'items/w': [1, 1, 0, 0, 0, 0, 0] } }), apply)
    f.accept(frame('b', T0, { entities: { 'items/w': [2, 2, 0, 0, 0, 0, 0] } }), apply)
    expect(reseeds).toBe(1) // a second node appeared while the snapshot covered one
    expect(f.snapshotUrl(300)).toBe('/traffic-map/cluster-snapshot?window=300')
    expect(out).toHaveLength(1) // a's first second passed straight through (b was not known yet)
    f.accept(frame('a', T0 + 1, { entities: { 'items/w': [1, 0, 0, 0, 0, 0, 0] } }), apply)
    expect(out).toHaveLength(1) // waiting for b's second
    f.accept(frame('b', T0 + 1, { entities: { 'items/w': [5, 0, 0, 0, 0, 0, 0] } }), apply)
    expect(out).toHaveLength(2)
    expect(out[1].entities['items/w'][0]).toBe(6)
    f.dispose()
  })
  it('a late node re-applies the fuller sum with only its own events', async () => {
    const { now } = clock()
    const f = new NodeFeed(now, 10_000, 5)
    f.noteSnapshot({ node: 'a' }, 2)
    const out: TrafficFrame[] = []
    const apply = (x: TrafficFrame) => out.push(x)
    f.accept(frame('a', T0 - 1), apply) // both nodes become known
    f.accept(frame('b', T0 - 1), apply)
    f.accept(
      frame('a', T0, {
        entities: { 'items/w': [1, 0, 0, 0, 0, 0, 0] },
        events: [{ t: 8, lane: 'items', entity: 'w', kind: 'read', caller: 'uA', route: 'r' }]
      }),
      apply
    )
    await new Promise((r) => setTimeout(r, 30)) // b never came in time: a's second is applied alone
    const alone = out.find((x) => x.at === new Date(T0 * 1000).toISOString())
    expect(alone?.entities['items/w'][0]).toBe(1)
    out.length = 0
    f.accept(
      frame('b', T0, {
        entities: { 'items/w': [2, 0, 0, 0, 0, 0, 0] },
        events: [{ t: 9, lane: 'items', entity: 'w', kind: 'read', caller: 'uB', route: 'r' }]
      }),
      apply
    )
    expect(out).toHaveLength(1)
    expect(out[0].entities['items/w'][0]).toBe(3) // the second now holds both nodes
    expect(out[0].events.map((e) => e.caller)).toEqual(['uB']) // a's events are not repeated
    f.dispose()
  })
  it('per-node scope keeps one node and asks that node for its snapshot', () => {
    const { now } = clock()
    const f = new NodeFeed(now)
    f.noteSnapshot({ node: 'a' }, 2)
    let reseeds = 0
    f.onReseed(() => reseeds++)
    const out: TrafficFrame[] = []
    f.accept(frame('a', T0), (x) => out.push(x))
    f.accept(frame('b', T0), (x) => out.push(x))
    f.setScope({ mode: 'node', node: 'b' })
    expect(reseeds).toBe(1)
    expect(f.snapshotUrl(60)).toBe('/traffic-map/cluster-snapshot?window=60&node=b')
    out.length = 0
    f.accept(frame('a', T0 + 1), (x) => out.push(x))
    f.accept(frame('b', T0 + 1), (x) => out.push(x))
    expect(out.map((x) => x.node)).toEqual(['b'])
    f.setScope({ mode: 'node', node: 'a' })
    expect(f.snapshotUrl(60)).toBe('/traffic-map/snapshot?window=60')
  })
  it('nodes() lists live nodes, this one first, and forgets silent ones', () => {
    const { c, now } = clock()
    const f = new NodeFeed(now, 10_000)
    f.noteSnapshot({ node: 'b' })
    f.accept(frame('a', T0), () => {})
    f.accept(frame('b', T0), () => {})
    expect(f.nodes()).toEqual(['b', 'a'])
    c.t += 11_000
    expect(f.nodes()).toEqual(['b'])
    f.dispose()
  })
})

describe('compare presets (#1160)', () => {
  const now = new Date(2026, 9, 1, 15, 30) // 15:30 local
  it('morning vs afternoon today after noon; yesterday before noon', () => {
    const p = windowPreset('morning-vs-afternoon', now)
    expect([p.a.from.getHours(), p.a.to.getHours(), p.b.from.getHours()]).toEqual([8, 12, 12])
    expect(p.b.to).toBe(now)
    const early = new Date(2026, 9, 1, 9, 0)
    const y = windowPreset('morning-vs-afternoon', early)
    expect(y.a.from.getDate()).toBe(30)
    expect(y.b.to.getHours()).toBe(17)
    expect(y.a.label).toMatch(/^Yesterday/)
  })
  it('hour vs last week and today vs yesterday', () => {
    const p = windowPreset('hour-vs-last-week', now)
    expect(now.getTime() - p.a.to.getTime()).toBe(7 * 24 * 3600_000)
    expect(p.b.to.getTime() - p.b.from.getTime()).toBe(3600_000)
    const t = windowPreset('today-vs-yesterday', now)
    expect(t.b.from.getHours()).toBe(0)
    expect(t.b.to.getTime() - t.a.to.getTime()).toBe(24 * 3600_000)
    expect(pairProblem(t)).toBeNull()
  })
  it('pairProblem and toLocalInput', () => {
    const bad = { a: { from: now, to: now }, b: { from: now, to: new Date(now.getTime() + 1) } }
    expect(pairProblem(bad)).toMatch(/A ends before/)
    const long = {
      a: { from: new Date(0), to: new Date(25 * 3600_000) },
      b: { from: now, to: new Date(now.getTime() + 1) }
    }
    expect(pairProblem(long)).toMatch(/24 hours/)
    expect(toLocalInput(now)).toBe('2026-10-01T15:30')
  })
})
