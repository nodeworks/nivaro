// api/src/test/unit/services/traffic-map.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

import { INSTANCE_ID } from '../../../services/instance-roster.js'
import { currentTraceCaller, currentTraceMeta } from '../../../services/request-trace.js'
import {
  advanceTo,
  buildFrame,
  buildSnapshot,
  drainEvents,
  EVENT_BUFFER_CAP,
  errorCode,
  LANE_ENTITY_CAP,
  matchExtensionRoute,
  noteOutbound,
  noteRequest,
  noteWrite,
  resetTrafficMap,
  seenCallerKeys,
  setExtensionRoutes,
  sweepIdle
} from '../../../services/traffic-map.js'
import { withTrafficSource } from '../../../services/traffic-source.js'

const T0 = 1_800_000_000 // epoch seconds
const req = (over: Partial<Parameters<typeof noteRequest>[0]> = {}) =>
  noteRequest({
    method: 'GET',
    path: '/api/items/workflows',
    status: 200,
    latencyMs: 120,
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
  resetTrafficMap()
  advanceTo(T0)
  vi.mocked(currentTraceCaller).mockReturnValue(null)
  vi.mocked(currentTraceMeta).mockReturnValue(null)
})

describe('noteRequest', () => {
  it('counts req + read for a GET and req + error for a 4xx, never a write', () => {
    req()
    req({ method: 'PATCH', path: '/api/items/workflows/1', status: 200 })
    req({ method: 'PATCH', path: '/api/items/workflows/2', status: 422 })
    const snap = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null })
    const wf = snap.entities.find((e) => e.key === 'items/workflows')
    expect(wf).toMatchObject({ req: 3, read: 1, create: 0, update: 0, delete: 0, error: 1 })
    expect(wf?.routes[0]).toEqual({ route: 'PATCH /api/items/workflows/:id', n: 2 })
    expect(wf?.callers[0]).toEqual({ key: 'uU1', n: 3 })
    expect(wf?.down).toEqual({ db: 3 })
    expect(snap.totals.req).toBe(3)
    expect(snap.instance).toBe('test-node')
    expect(snap.node_scope).toMatch(/this API process only/)
  })
  it('a cache hit attributes the request to redis, not db', () => {
    req({ method: 'POST', path: '/api/custom-queries/forecast-grid/execute', cacheHit: true })
    const e = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null }).entities.find(
      (x) => x.key === 'queries/forecast-grid'
    )
    expect(e?.down).toEqual({ redis: 1 })
  })
  it('skips untracked paths without throwing', () => {
    req({ path: '/api/health' })
    req({ path: '' })
    expect(buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null }).entities).toEqual([])
  })
  it('anonymous graphql is one entity however many unnamed documents arrive', () => {
    for (let i = 0; i < 50; i++) req({ method: 'POST', path: '/graphql', graphqlOperation: null })
    const snap = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null })
    const gq = snap.entities.filter((e) => e.lane === 'graphql')
    expect(gq).toHaveLength(1)
    expect(gq[0]).toMatchObject({ entity: 'anonymous', req: 50 })
  })
})

describe('noteWrite', () => {
  it('counts writes by action on the collection entity with the request caller', () => {
    vi.mocked(currentTraceCaller).mockReturnValue({ auth: 'api_key', apiKeyId: 7 })
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'r1',
      urlHint: '/api/inbound/mwf-shipments',
      userId: null
    })
    noteWrite({
      collection: 'inventory_request',
      item: 32841,
      action: 'update',
      changedFields: ['mdsi_status', 'order_number'],
      at: T0 * 1000
    })
    const e = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null }).entities.find(
      (x) => x.key === 'items/inventory_request'
    )
    expect(e).toMatchObject({ update: 1, req: 0 })
    expect(e?.recent_writes[0]).toMatchObject({
      action: 'update',
      record: '32841',
      fields: ['mdsi_status', 'order_number'],
      caller: 'k7',
      via: 'inbound'
    })
  })
  it('cron writes: a write with no request lands under caller cron', () => {
    noteWrite({
      collection: 'forecasts',
      item: 9,
      action: 'create',
      changedFields: [],
      at: T0 * 1000
    })
    const snap = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null })
    expect(snap.entities.find((x) => x.key === 'items/forecasts')?.recent_writes[0]?.caller).toBe(
      'cron'
    )
    expect(snap.callers.find((c) => c.key === 'cron')?.req).toBe(1)
  })
  it('system collections land in the system lane and never carry values', () => {
    noteWrite({
      collection: 'nivaro_notifications',
      item: 1,
      action: 'create',
      changedFields: ['subject'],
      at: T0 * 1000
    })
    const e = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null }).entities[0]
    expect(e.lane).toBe('system')
    expect(JSON.stringify(e)).not.toContain('Hello')
  })
})

describe('noteOutbound', () => {
  it('counts the partner down node and attributes the call to the originating entity', () => {
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'r1',
      urlHint: '/api/pipelines/instance/inventory_request/5/transition',
      userId: 'u1'
    })
    noteOutbound({ apiId: 3, apiName: 'MDSi', status: 200, durationMs: 1830, at: T0 * 1000 })
    noteOutbound({ apiId: 3, apiName: 'MDSi', status: null, durationMs: 30000, at: T0 * 1000 })
    const snap = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null })
    expect(snap.down.find((d) => d.id === 'ext:3')).toMatchObject({
      label: 'MDSi',
      req: 2,
      error: 1
    })
    expect(snap.entities.find((e) => e.key === 'items/inventory_request')?.down['ext:3']).toBe(2)
    expect(snap.totals.outbound_req).toBe(2)
  })
})

describe('rings, windows and caps', () => {
  it('a quiet period reads as zeros and the window sums only its seconds', () => {
    req()
    advanceTo(T0 + 100)
    req({ at: (T0 + 100) * 1000 })
    const s60 = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null })
    const s300 = buildSnapshot(300, { sockets: 0, users: 0, journalSeq: null })
    expect(s60.entities[0].req).toBe(1)
    expect(s300.entities[0].req).toBe(2)
    expect(s60.entities[0].series).toHaveLength(60)
    advanceTo(T0 + 2000)
    expect(buildSnapshot(900, { sockets: 0, users: 0, journalSeq: null }).entities).toEqual([])
  })
  it('lane cap folds into __other__', () => {
    for (let i = 0; i < LANE_ENTITY_CAP + 25; i++) req({ path: `/api/items/c${i}` })
    const snap = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null })
    const items = snap.entities.filter((e) => e.lane === 'items')
    expect(items).toHaveLength(LANE_ENTITY_CAP + 1)
    expect(items.find((e) => e.entity === '__other__')?.req).toBe(25)
    expect(snap.totals.req).toBe(LANE_ENTITY_CAP + 25)
  })
  it('p95 comes from the latency reservoir', () => {
    for (let i = 1; i <= 100; i++) req({ latencyMs: i * 10 })
    const e = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null }).entities[0]
    expect(e.p95).toBeGreaterThanOrEqual(940)
    expect(e.p50).toBeGreaterThanOrEqual(490)
  })
})

describe('frames', () => {
  it('buildFrame names the partner nodes it carries (down_labels), never the data stores', () => {
    noteOutbound({ apiId: 9, apiName: 'LinX', status: 200, durationMs: 40, at: T0 * 1000 })
    const f = buildFrame(T0, { sockets: 0, journalSeq: null })
    expect(f.down['ext:9']).toBeDefined()
    expect(f.down_labels).toEqual({ 'ext:9': 'LinX' })
  })

  it('buildFrame carries this second only, drains events, and prioritises errors and writes', () => {
    for (let i = 0; i < 60; i++) req()
    req({ method: 'PATCH', path: '/api/items/workflows/3', status: 422 })
    noteWrite({
      collection: 'workflows',
      item: 3,
      action: 'update',
      changedFields: ['vendor'],
      at: T0 * 1000
    })
    const f = buildFrame(T0, { sockets: 4, journalSeq: 99 })
    expect(f.v).toBe(1)
    expect(f.instance).toBe('test-node')
    expect(f.entities['items/workflows']).toEqual([61, 60, 0, 1, 0, 1, expect.any(Number)])
    expect(f.edges_in['uU1>items']).toBe(61)
    expect(f.edges_out['items>db']).toBe(61)
    expect(f.events).toHaveLength(40)
    expect(f.events[0].kind).toBe('error')
    expect(f.events[1].kind).toBe('update')
    expect(f.events_dropped).toBe(22)
    expect(f.sockets).toBe(4)
    expect(f.journal_seq).toBe(99)
    expect(drainEvents()).toEqual([])
    expect(JSON.stringify(f)).not.toContain('Hello')
  })
})

describe('extension route matching', () => {
  it('matches :param segments and reports the extension id', () => {
    setExtensionRoutes(
      new Map([['efp-ops', [{ method: 'GET', url: '/api/efp/warehouse-order/:irId' }]]])
    )
    expect(matchExtensionRoute('GET', '/api/efp/warehouse-order/32841')).toBe('efp-ops')
    expect(matchExtensionRoute('POST', '/api/efp/warehouse-order/32841')).toBeNull()
    expect(matchExtensionRoute('GET', '/api/items/workflows')).toBeNull()
    req({ path: '/api/efp/warehouse-order/32841' })
    expect(buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null }).entities[0].key).toBe(
      'extension/efp-ops'
    )
  })
})

describe('controller rulings', () => {
  const snap = () => buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null })
  it('R2: an outbound-only entity appears with its down hit', () => {
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'r',
      urlHint: '/api/items/forecasts',
      userId: null
    })
    noteOutbound({ apiId: 5, apiName: 'LinX', status: 200, durationMs: 10, at: T0 * 1000 })
    const e = snap().entities.find((x) => x.key === 'items/forecasts')
    expect(e?.req).toBe(0)
    expect(e?.down['ext:5']).toBe(1)
  })
  it('R4: a write inside a request does not add a caller req; cron does', () => {
    req()
    vi.mocked(currentTraceCaller).mockReturnValue({ auth: 'session', apiKeyId: null })
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'r',
      urlHint: '/api/items/workflows/1',
      userId: 'u1'
    })
    noteWrite({
      collection: 'workflows',
      item: 1,
      action: 'update',
      changedFields: [],
      at: T0 * 1000
    })
    expect(snap().callers.find((c) => c.key === 'uU1')?.req).toBe(1)
  })
  it('R5: outbound from an extension route lands in the extension lane', () => {
    setExtensionRoutes(new Map([['efp-ops', [{ method: 'POST', url: '/api/efp/push/:id' }]]]))
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'r',
      urlHint: '/api/efp/push/9',
      userId: null
    })
    noteOutbound({ apiId: 2, apiName: 'MWF', status: 200, durationMs: 5, at: T0 * 1000 })
    expect(snap().entities.find((x) => x.key === 'extension/efp-ops')?.down['ext:2']).toBe(1)
  })
  it('R27: matcher recompiles when the live map grows; optional params and * work', () => {
    const live = new Map<string, Array<{ method: string; url: string }>>([['a', []]])
    setExtensionRoutes(live)
    expect(matchExtensionRoute('GET', '/api/x/1')).toBeNull()
    live
      .get('a')
      ?.push({ method: 'GET', url: '/api/x/:id?' }, { method: 'GET', url: '/api/files-ext/*' })
    expect(matchExtensionRoute('GET', '/api/x/1')).toBe('a')
    expect(matchExtensionRoute('GET', '/api/x')).toBe('a')
    expect(matchExtensionRoute('GET', '/api/files-ext/a/b')).toBe('a')
    expect(matchExtensionRoute(null, '/api/x/1')).toBe('a')
  })
  it('R29a: error code from JSON code, else first SHOUTY token, else null', () => {
    expect(errorCode('{"code":"NOT_FOUND","error":"x"}')).toBe('NOT_FOUND')
    expect(errorCode('CHANGE_REASON_REQUIRED for field')).toBe('CHANGE_REASON_REQUIRED')
    expect(errorCode('oops')).toBeNull()
    req({
      path: '/api/items/workflows/7',
      status: 422,
      errorCode: '{"code":"VALIDATION"}'
    } as never)
    expect(snap().entities[0].recent_errors[0].code).toBe('VALIDATION')
  })
  it('R29b: error events carry the record id from the path', () => {
    req({ path: '/api/items/workflows/42', status: 500 })
    expect(snap().entities[0].recent_errors[0].record).toBe('42')
    expect(drainEvents()[0]).toMatchObject({ kind: 'error', record: '42' })
  })
  it('R29c: write route comes from the trace url hint (no method) else "<via> write"', () => {
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'r',
      urlHint: '/api/items/workflows/12',
      userId: 'u1'
    })
    noteWrite({
      collection: 'workflows',
      item: 12,
      action: 'update',
      changedFields: [],
      at: T0 * 1000
    })
    expect(drainEvents()[0].route).toBe('/api/items/workflows/:id')
    vi.mocked(currentTraceMeta).mockReturnValue(null)
    noteWrite({
      collection: 'workflows',
      item: 12,
      action: 'update',
      changedFields: [],
      at: T0 * 1000
    })
    expect(drainEvents()[0].route).toBe('other write')
  })
})

describe('fix round 1', () => {
  const snap = (w: 60 | 300 | 900 = 60) =>
    buildSnapshot(w, { sockets: 0, users: 0, journalSeq: null })
  it('1: the event buffer is capped, keeps errors, and reports the overflow as dropped', () => {
    req({ path: '/api/items/workflows/1', status: 500 })
    for (let i = 0; i < 50_000; i++) req()
    const f = buildFrame(T0, { sockets: 0, journalSeq: null })
    expect(f.events).toHaveLength(40)
    expect(f.events[0].kind).toBe('error')
    expect(f.events_dropped).toBe(50_001 - 40)
    expect(EVENT_BUFFER_CAP).toBeLessThanOrEqual(200)
    for (let i = 0; i < 1000; i++) req()
    expect(drainEvents().length).toBeLessThanOrEqual(EVENT_BUFFER_CAP)
  })
  it('2: idle callers and partner nodes are swept, db/redis/store kept', () => {
    req()
    vi.mocked(currentTraceMeta).mockReturnValue(null)
    noteOutbound({ apiId: 8, apiName: 'X', status: 200, durationMs: 1, at: T0 * 1000 })
    advanceTo(T0 + 1000)
    sweepIdle(T0 + 1000)
    expect(seenCallerKeys()).toEqual([])
    const ids = snap(900).down.map((d) => d.id)
    expect(ids).not.toContain('ext:8')
  })
  it('3: a stale top-key is evicted so the 21st key gets its own row', () => {
    for (let i = 0; i < 20; i++) req({ userId: `u${i}` })
    advanceTo(T0 + 1000)
    req({ userId: 'new', at: (T0 + 1000) * 1000 })
    expect(snap(60).entities[0].callers[0].key).toBe('uNEW')
  })
  it('4: cron writes and trace-less outbound calls count for caller cron with edges', () => {
    noteWrite({
      collection: 'forecasts',
      item: 1,
      action: 'update',
      changedFields: [],
      at: T0 * 1000
    })
    noteOutbound({ apiId: 1, apiName: 'A', status: null, durationMs: 5, at: T0 * 1000 })
    const f = buildFrame(T0, { sockets: 0, journalSeq: null })
    expect(f.edges_in['cron>items']).toBe(1)
    expect(f.edges_in['cron>other']).toBe(1)
    const cron = snap().callers.find((c) => c.key === 'cron')
    expect(cron).toMatchObject({ req: 2, error: 1 })
  })
  it('5: events use the entity the counts landed on', () => {
    for (let i = 0; i < LANE_ENTITY_CAP; i++) req({ path: `/api/items/c${i}` })
    drainEvents()
    req({ path: '/api/items/overflow_one' })
    expect(drainEvents()[0].entity).toBe('__other__')
  })
  it('6: the 60s window includes the previous minute bucket', () => {
    req({ at: (T0 + 30) * 1000 })
    advanceTo(T0 + 65)
    expect(snap(60).entities[0].routes[0].n).toBe(1)
  })
  it('7: an outbound-only entity stays alive while active', () => {
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'r',
      urlHint: '/api/items/forecasts',
      userId: null
    })
    advanceTo(T0 + 500)
    noteOutbound({ apiId: 5, apiName: 'L', status: 200, durationMs: 1, at: (T0 + 500) * 1000 })
    advanceTo(T0 + 1000)
    noteOutbound({ apiId: 5, apiName: 'L', status: 200, durationMs: 1, at: (T0 + 1000) * 1000 })
    sweepIdle(T0 + 1500)
    expect(snap(900).entities.some((e) => e.key === 'items/forecasts')).toBe(true)
  })
  it('8: an event older than the ring is dropped', () => {
    advanceTo(T0 + 2000)
    req({ at: T0 * 1000 })
    expect(snap(900).entities).toEqual([])
  })
  it('9: a JSON code that is not a token falls back to the regex', () => {
    expect(errorCode('{"code":"x1","error":"BAD_THING"}')).toBe('BAD_THING')
  })
  it('10: write routes never carry a token', () => {
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'r',
      urlHint: `/api/submission-forms/public/${'a1'.repeat(24)}`,
      userId: null
    })
    noteWrite({
      collection: 'nivaro_submissions',
      item: 1,
      action: 'create',
      changedFields: [],
      at: T0 * 1000
    })
    expect(drainEvents()[0].route).toBe('/api/submission-forms/public/:id')
  })
  it('11: outbound from a GET pages route lands on pages/<slug>', () => {
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'r',
      urlHint: '/api/pages/home',
      userId: 'u1'
    })
    noteOutbound({ apiId: 4, apiName: 'P', status: 200, durationMs: 1, at: T0 * 1000 })
    expect(snap().entities.some((e) => e.key === 'pages/home')).toBe(true)
  })
})

import { startTrafficMapEmitter } from '../../../services/traffic-map.js'

describe('emitter', () => {
  it('emits only while watched, one frame per tick, drains events and edges either way', async () => {
    const emitted: Array<{
      frame: number
      entities: Record<string, number[]>
      edges_in: Record<string, number>
    }> = []
    const rooms = new Map<string, Set<string>>()
    const io = {
      sockets: { adapter: { rooms } },
      to: () => ({ emit: () => {} }),
      local: {
        to: (room: string) => ({
          emit: (ev: string, payload: unknown) => {
            if (room === 'watch:traffic-map' && ev === 'traffic-map:frame')
              emitted.push(payload as never)
          }
        })
      }
    }
    let clock = T0
    const stop = startTrafficMapEmitter({ intervalMs: 5, io: () => io, now: () => clock * 1000 })
    req()
    clock += 1
    await new Promise((r) => setTimeout(r, 20))
    expect(emitted).toHaveLength(0)
    expect(drainEvents()).toEqual([]) // drained by the unwatched tick
    rooms.set('watch:traffic-map', new Set(['s1']))
    req({ at: clock * 1000 })
    clock += 1
    await new Promise((r) => setTimeout(r, 20))
    stop()
    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted.some((f) => f.entities['items/workflows']?.[0] === 1)).toBe(true)
    // R3: the idle-second request's edge never rides the first watched frame
    expect(emitted[0].edges_in['uU1>items']).toBe(1)
    const nos = emitted.map((f) => f.frame)
    expect(new Set(nos).size).toBe(nos.length)
  })
})

describe('emitter frames', () => {
  const mk = () => {
    const emitted: Array<{ at: string; entities: Record<string, number[]> }> = []
    const rooms = new Map<string, Set<string>>([['watch:traffic-map', new Set(['s'])]])
    const io = {
      sockets: { adapter: { rooms } },
      to: (_r: string) => ({ emit: (_e: string, p: unknown) => void emitted.push(p as never) })
    }
    return { emitted, io }
  }
  it("sends a busy entity's previous second even when it was hit again this second", async () => {
    const { emitted, io } = mk()
    let clock = T0
    const stop = startTrafficMapEmitter({ intervalMs: 5, io: () => io, now: () => clock * 1000 })
    await new Promise((r) => setTimeout(r, 15))
    advanceTo(T0 + 1)
    req({ at: (T0 + 1) * 1000 })
    advanceTo(T0 + 2)
    req({ at: (T0 + 2) * 1000 })
    clock = T0 + 2
    await new Promise((r) => setTimeout(r, 15))
    stop()
    const f = emitted.find((x) => x.at === new Date((T0 + 1) * 1000).toISOString())
    expect(f?.entities['items/workflows']?.[0]).toBe(1)
  })
  it('catches up a skipped second', async () => {
    const { emitted, io } = mk()
    let clock = T0
    const stop = startTrafficMapEmitter({ intervalMs: 5, io: () => io, now: () => clock * 1000 })
    await new Promise((r) => setTimeout(r, 15))
    advanceTo(T0 + 1)
    req({ at: (T0 + 1) * 1000 })
    clock = T0 + 3 // jumped two seconds
    await new Promise((r) => setTimeout(r, 15))
    stop()
    const ats = emitted.map((x) => x.at)
    expect(ats).toContain(new Date((T0 + 1) * 1000).toISOString())
    expect(emitted.find((x) => x.at === ats[0])).toBeTruthy()
    expect(
      emitted.some(
        (x) => x.at === new Date((T0 + 1) * 1000).toISOString() && x.entities['items/workflows']
      )
    ).toBe(true)
  })
})

describe('final-review fixes', () => {
  const snap = () => buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null })
  it('cloud mode: note* calls record nothing (no emitter runs there)', () => {
    const prev = process.env.CLOUD_META_DB_URL
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    try {
      req()
      noteWrite({
        collection: 'workflows',
        item: 1,
        action: 'update',
        changedFields: [],
        at: T0 * 1000
      })
      noteOutbound({ apiId: 1, apiName: 'A', status: 200, durationMs: 5, at: T0 * 1000 })
      expect(seenCallerKeys()).toEqual([])
      expect(drainEvents()).toEqual([])
      expect(snap().entities).toEqual([])
      expect(snap().down).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.CLOUD_META_DB_URL
      else process.env.CLOUD_META_DB_URL = prev
    }
    req()
    expect(seenCallerKeys()).toEqual(['uU1'])
  })
  it('R36: a trace-less partner call lands on other/__background__, apart from /api/cron', () => {
    noteOutbound({ apiId: 3, apiName: 'P', status: 200, durationMs: 5, at: T0 * 1000 })
    req({ path: '/api/cron/foo/run', method: 'POST' })
    const s = snap()
    const bg = s.entities.find((e) => e.key === 'other/__background__')
    expect(bg?.label).toBe('Background jobs')
    expect(bg?.down['ext:3']).toBe(1)
    expect(s.entities.find((e) => e.key === 'other/cron')?.req).toBe(1)
    expect(s.entities.find((e) => e.key === 'other/cron')?.down['ext:3']).toBeUndefined()
  })
  it('the extension matcher only runs for requests that fall through to other', () => {
    const live = new Map<string, Array<{ method: string; url: string }>>([
      // A greedy extension route that would swallow /api/items/... if it were matched first.
      ['greedy', [{ method: 'GET', url: '/api/*' }]]
    ])
    setExtensionRoutes(live)
    req({ path: '/api/items/workflows' })
    req({ path: '/api/efp/anything' })
    const keys = snap().entities.map((e) => e.key)
    expect(keys).toContain('items/workflows')
    expect(keys).toContain('extension/greedy')
  })
  it('a reloaded extension (new route array, same length) recompiles the matcher', () => {
    const live = new Map<string, Array<{ method: string; url: string }>>([
      ['a', [{ method: 'GET', url: '/api/old/:id' }]]
    ])
    setExtensionRoutes(live)
    expect(matchExtensionRoute('GET', '/api/old/1')).toBe('a')
    live.set('a', [{ method: 'GET', url: '/api/new/:id' }])
    expect(matchExtensionRoute('GET', '/api/old/1')).toBeNull()
    expect(matchExtensionRoute('GET', '/api/new/1')).toBe('a')
  })
})

describe('event ids (drill-down Wave 0)', () => {
  afterEach(() => {
    vi.mocked(currentTraceMeta).mockReturnValue(null)
  })
  const RID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const fastifyReq = {
    requestId: RID,
    headers: {
      'x-nivaro-client': 'build=b42; api=0.2.15; tab=tab_9; loaded=1800000000000',
      'x-nivaro-app': 'Admin',
      'x-nivaro-page': '/collections/workflows/371367?tab=lines',
      'x-nivaro-load': 'load_abc123'
    }
  }
  it('a request event carries the request id, this node and the parsed client facts', () => {
    req({ method: 'PATCH', path: '/api/items/workflows/1', status: 422, req: fastifyReq })
    req({ req: fastifyReq })
    const [err, read] = drainEvents()
    for (const ev of [err, read]) {
      expect(ev).toMatchObject({
        rid: RID,
        node: INSTANCE_ID,
        tab: 'tab_9',
        build: 'b42',
        app: 'admin',
        page: '/collections/workflows/:id',
        load: 'load_abc123'
      })
    }
    expect(err.kind).toBe('error')
    expect(read.kind).toBe('read')
  })
  it('missing or junk headers leave the facts out rather than sending them empty', () => {
    req({
      req: { requestId: RID, headers: { 'x-nivaro-app': 'Not a slug!', 'x-nivaro-load': 'x' } }
    })
    const [ev] = drainEvents()
    expect(ev.rid).toBe(RID)
    for (const k of ['app', 'load', 'tab', 'build', 'page'])
      expect(Object.keys(ev)).not.toContain(k)
  })
  it('a write takes the request id from the trace and the owning source as run', () => {
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: RID,
      urlHint: '/api/items/workflows/1',
      userId: 'u1',
      request: true
    })
    noteWrite({
      collection: 'workflows',
      item: 1,
      action: 'update',
      changedFields: [],
      at: T0 * 1000
    })
    const [w] = drainEvents()
    expect(w).toMatchObject({ rid: RID, node: INSTANCE_ID })
    expect(w.tab).toBeUndefined()

    // A background job's own trace id is not a request id — no rid, but the run that owns it.
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'bg-trace',
      urlHint: 'job',
      userId: null,
      request: false
    })
    withTrafficSource({ id: 'cron:nightly', label: 'Nightly', kind: 'cron' }, () =>
      noteWrite({
        collection: 'forecasts',
        item: 2,
        action: 'create',
        changedFields: [],
        at: T0 * 1000
      })
    )
    const [bg] = drainEvents()
    expect(bg.rid).toBeUndefined()
    expect(bg.run).toBe('cron:nightly')
  })
})
