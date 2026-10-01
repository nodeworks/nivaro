// api/src/test/unit/services/traffic-taps.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

import {
  advanceTo,
  buildFrame,
  buildSnapshot,
  drainEvents,
  noteDown,
  noteOutbound,
  noteRequest,
  noteSource,
  noteWrite,
  pushTrafficEvent,
  resetTrafficMap,
  seenCallerKeys,
  seenSources,
  sweepIdle
} from '../../../services/traffic-map.js'
import { MinuteCounter, RING_SECONDS, SecondRing } from '../../../services/traffic-ring.js'
import {
  currentStoreId,
  registerTrafficTap,
  type TapOutboundCtx,
  type TapRequestCtx,
  type TapWriteCtx,
  tapState,
  trafficTaps,
  unregisterTrafficTap
} from '../../../services/traffic-taps.js'

const T0 = 1_800_000_000
const snapOpts = { sockets: 0, users: 0, journalSeq: null }
const req = (over: Partial<Parameters<typeof noteRequest>[0]> = {}) =>
  noteRequest({
    method: 'GET',
    path: '/api/items/workflows',
    status: 200,
    latencyMs: 40,
    authMethod: 'session',
    apiKeyId: null,
    userId: 'u1',
    graphqlOperation: null,
    graphqlKind: null,
    cacheHit: false,
    at: T0 * 1000,
    ...over
  })

beforeEach(() => {
  for (const t of trafficTaps()) unregisterTrafficTap(t.id)
  resetTrafficMap()
  advanceTo(T0)
})
afterEach(() => {
  for (const t of trafficTaps()) unregisterTrafficTap(t.id)
  delete process.env.CLOUD_META_DB_URL
})

describe('tap registry', () => {
  it('hands each tap the classified request, write and outbound contexts', () => {
    const seen: { r: TapRequestCtx[]; w: TapWriteCtx[]; o: TapOutboundCtx[] } = {
      r: [],
      w: [],
      o: []
    }
    registerTrafficTap({
      id: 'probe',
      onRequest: (c) => seen.r.push(c),
      onWrite: (c) => seen.w.push(c),
      onOutbound: (c) => seen.o.push(c)
    })
    const fakeReq = { headers: {} }
    req({ status: 422, errorCode: '{"code":"VALIDATION_FAILED"}', req: fakeReq, responseBytes: 12 })
    noteWrite({
      collection: 'workflows',
      item: 9,
      action: 'update',
      changedFields: ['a'],
      at: T0 * 1000
    })
    noteOutbound({ apiId: 3, apiName: 'MDSi', status: 500, durationMs: 80, at: T0 * 1000 })
    expect(seen.r[0]).toMatchObject({
      lane: 'items',
      entity: 'workflows',
      entityKey: 'items/workflows',
      kind: 'read',
      caller: 'uU1',
      route: 'GET /api/items/workflows',
      isError: true,
      code: 'VALIDATION_FAILED',
      sec: T0
    })
    expect(seen.r[0].ev.req).toBe(fakeReq)
    expect(seen.r[0].ev.responseBytes).toBe(12)
    expect(seen.w[0]).toMatchObject({
      lane: 'items',
      entityKey: 'items/workflows',
      caller: 'cron',
      sec: T0
    })
    expect(seen.o[0]).toMatchObject({
      downId: 'ext:3',
      entityKey: 'other/__background__',
      failed: true
    })
  })
  it('a throwing tap affects neither the map nor the next tap; replace by id', () => {
    const calls: string[] = []
    registerTrafficTap({
      id: 'bad',
      onRequest: () => {
        throw new Error('boom')
      },
      frame: () => {
        throw new Error('boom')
      }
    })
    registerTrafficTap({ id: 'good', onRequest: () => calls.push('first') })
    registerTrafficTap({ id: 'good', onRequest: () => calls.push('second') })
    req()
    expect(calls).toEqual(['second'])
    expect(trafficTaps().map((t) => t.id)).toEqual(['bad', 'good'])
    expect(buildSnapshot(60, snapOpts).entities[0]).toMatchObject({
      key: 'items/workflows',
      req: 1
    })
    expect(buildFrame(T0, { sockets: 0, journalSeq: null }).ext).toBeUndefined()
  })
  it('cloud mode: taps never run', () => {
    const fn = vi.fn()
    registerTrafficTap({ id: 't', onRequest: fn, onWrite: fn })
    process.env.CLOUD_META_DB_URL = 'x'
    req()
    noteWrite({ collection: 'w', item: 1, action: 'create', changedFields: [], at: T0 * 1000 })
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('frame and snapshot ext', () => {
  it('frames and snapshots carry no ext without taps (shape unchanged)', () => {
    req()
    const f = buildFrame(T0, { sockets: 0, journalSeq: null })
    expect('ext' in f).toBe(false)
    const s = buildSnapshot(60, snapOpts)
    expect('ext' in s).toBe(false)
    expect('sources' in s).toBe(false)
    expect('ext' in s.entities[0]).toBe(false)
  })
  it('collects frame / snapshot / entity values by tap id, skipping undefined', () => {
    registerTrafficTap({
      id: 'bytes',
      onRequest: (c) => {
        const st = tapState('bytes', () => new Map<string, number>())
        st.set(c.entityKey, (st.get(c.entityKey) ?? 0) + (c.ev.responseBytes ?? 0))
      },
      frame: (sec) => ({ sec }),
      snapshot: () => ({ total: 1 }),
      entitySnapshot: (key) => tapState('bytes', () => new Map<string, number>()).get(key)
    })
    registerTrafficTap({ id: 'quiet', frame: () => undefined, snapshot: () => undefined })
    req({ responseBytes: 100 })
    req({ responseBytes: 50 })
    expect(buildFrame(T0, { sockets: 0, journalSeq: null }).ext).toEqual({ bytes: { sec: T0 } })
    const s = buildSnapshot(60, snapOpts)
    expect(s.ext).toEqual({ bytes: { total: 1 } })
    expect(s.entities[0].ext).toEqual({ bytes: 150 })
  })
})

describe('tap state', () => {
  it('is per store, created once, and cleared (with tap.reset) by resetTrafficMap', () => {
    const reset = vi.fn()
    registerTrafficTap({ id: 's', reset })
    const a = tapState('s', () => ({ n: 1 }))
    a.n = 5
    expect(tapState('s', () => ({ n: 1 })).n).toBe(5)
    expect(currentStoreId()).toBe('default')
    resetTrafficMap()
    expect(reset).toHaveBeenCalledOnce()
    expect(tapState('s', () => ({ n: 1 })).n).toBe(1)
  })
  it('sweepIdle calls each tap sweep with the second', () => {
    const sweep = vi.fn()
    registerTrafficTap({ id: 's', sweep })
    sweepIdle(T0 + 5)
    expect(sweep).toHaveBeenCalledWith(T0 + 5)
  })
})

describe('pushTrafficEvent', () => {
  it('rides the same buffer as the map events, with tags and extra', () => {
    pushTrafficEvent({
      t: T0 * 1000,
      lane: 'items',
      entity: 'workflows',
      kind: 'error',
      caller: 'k7',
      route: 'GET /api/items/workflows',
      tags: ['retry storm'],
      extra: { n: 12 }
    })
    const ev = drainEvents()
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ tags: ['retry storm'], extra: { n: 12 } })
  })
})

describe('noteDown', () => {
  it('records an arbitrary down node with label and kind, attributed to an entity', () => {
    req()
    noteDown({
      id: 'mail',
      label: 'Mail',
      kind: 'channel',
      ok: true,
      ms: 30,
      at: T0 * 1000,
      entityKey: 'items/workflows'
    })
    noteDown({ id: 'mail', ok: false, at: T0 * 1000, entityKey: 'items/workflows' })
    const s = buildSnapshot(60, snapOpts)
    expect(s.down.find((d) => d.id === 'mail')).toEqual({
      id: 'mail',
      label: 'Mail',
      kind: 'channel',
      req: 2,
      error: 1,
      p95: 30
    })
    expect(s.entities.find((e) => e.key === 'items/workflows')?.down).toMatchObject({ mail: 2 })
    // a non-partner down never counts as an outbound partner call
    expect(s.totals.outbound_req).toBe(0)
    const f = buildFrame(T0, { sockets: 0, journalSeq: null })
    expect(f.down.mail).toEqual([2, 1, 30])
    expect(f.edges_out['items>mail']).toBe(2)
  })
  it('without an entity it lands on other/__background__; default kind service', () => {
    noteDown({ id: 'ai:gateway', ok: true, at: T0 * 1000 })
    const s = buildSnapshot(60, snapOpts)
    expect(s.down.find((d) => d.id === 'ai:gateway')?.kind).toBe('service')
    expect(s.entities.find((e) => e.key === 'other/__background__')?.down).toEqual({
      'ai:gateway': 1
    })
    expect(s.callers).toEqual([]) // noteDown never counts a caller
  })
  it("the map's own down kinds are unchanged", () => {
    req()
    noteOutbound({ apiId: 4, apiName: 'LinX', status: 200, durationMs: 9, at: T0 * 1000 })
    const kinds = Object.fromEntries(buildSnapshot(60, snapOpts).down.map((d) => [d.id, d.kind]))
    expect(kinds).toEqual({ db: 'db', 'ext:4': 'partner' })
  })
})

describe('noteSource', () => {
  it('records a source into the callers ring with an edge, apart from request callers', () => {
    req()
    noteSource({
      id: 'cron:rollup-drift',
      label: 'Rollup drift sweep',
      kind: 'cron',
      at: T0 * 1000,
      entityKey: 'items/workflows'
    })
    noteSource({ id: 'cron:rollup-drift', ok: false, at: T0 * 1000 })
    const s = buildSnapshot(60, snapOpts)
    expect(s.callers.find((c) => c.key === 'cron:rollup-drift')).toEqual({
      key: 'cron:rollup-drift',
      req: 2,
      error: 1
    })
    expect(s.sources).toEqual([
      { id: 'cron:rollup-drift', label: 'Rollup drift sweep', kind: 'cron', req: 2, error: 1 }
    ])
    expect(s.entities[0].callers.map((c) => c.key)).toContain('cron:rollup-drift')
    expect(seenCallerKeys()).toEqual(['uU1'])
    expect(seenSources()).toEqual([
      { id: 'cron:rollup-drift', label: 'Rollup drift sweep', kind: 'cron' }
    ])
    const f = buildFrame(T0, { sockets: 0, journalSeq: null })
    expect(f.callers['cron:rollup-drift']).toEqual([2, 1])
    expect(f.edges_in['cron:rollup-drift>items']).toBe(1)
    // the plain `cron` caller is untouched
    expect(f.callers.cron).toBeUndefined()
  })
  it('an idle source is swept with its label', () => {
    noteSource({ id: 'import:42', at: T0 * 1000 })
    sweepIdle(T0 + RING_SECONDS)
    expect(seenSources()).toEqual([])
  })
})

describe('ring primitives', () => {
  it('SecondRing sums a window, zeroes gaps and folds a series', () => {
    const r = new SecondRing(2, T0)
    r.bump(T0, 0, 3)
    r.bump(T0, 1)
    r.bump(T0 + 5, 0)
    expect(r.sum(60, T0 + 5)).toEqual([4, 1])
    expect(r.sum(3, T0 + 5)).toEqual([1, 0])
    expect(r.second(T0)).toEqual([3, 1])
    expect(r.series(6, T0 + 5, 2)).toEqual([3, 1])
    expect(r.sum(60, T0 + RING_SECONDS + 10)).toEqual([0, 0])
    expect(r.idle(T0 + 5 + RING_SECONDS)).toBe(true)
  })
  it('MinuteCounter caps keys into __other__ and sweeps idle keys', () => {
    const m = new MinuteCounter(2)
    m.bump('a', T0, 2)
    m.bump('b', T0)
    m.bump('c', T0)
    expect(m.top(60, T0)).toEqual([
      ['a', 2],
      ['b', 1]
    ])
    // no key was idle, so 'c' landed on the overflow row
    expect(m.sum('__other__', 60, T0)).toBe(1)
    expect(m.keys()).toEqual(['a', 'b', '__other__'])
    expect(m.sweep(T0 + 15 * 60)).toBe(3)
    expect(m.size).toBe(0)
  })
})
