// api/src/test/unit/services/traffic-map.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

import { currentTraceCaller, currentTraceMeta } from '../../../services/request-trace.js'
import {
  advanceTo,
  buildFrame,
  buildSnapshot,
  drainEvents,
  errorCode,
  LANE_ENTITY_CAP,
  matchExtensionRoute,
  noteOutbound,
  noteRequest,
  noteWrite,
  resetTrafficMap,
  setExtensionRoutes
} from '../../../services/traffic-map.js'

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
