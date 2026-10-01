// api/src/test/unit/services/traffic-view.test.ts — Traffic Map group D (canvas & view)
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null),
  currentTraceWorkspace: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../../../plugins/socketio.js', () => ({
  socketUserOf: vi.fn(() => ({ id: 'U1', name: 'Ada' }))
}))

import { currentTraceWorkspace } from '../../../services/request-trace.js'
import { correlate, pearson, spikes } from '../../../services/traffic-correlation.js'
import {
  advanceTo,
  buildFrame,
  buildSnapshot,
  drainEvents,
  entityRequestSeries,
  noteRequest,
  noteWrite,
  resetTrafficMap
} from '../../../services/traffic-map.js'
import {
  attachTrafficPresence,
  cleanSelection,
  trafficRoomOf
} from '../../../services/traffic-map-presence.js'
import {
  cleanPrompt,
  cleanVocabulary,
  validateNlFilter
} from '../../../services/traffic-nl-filter.js'
import { CALLER_APPS_TAP, dominantApps } from '../../../services/traffic-taps/caller-apps.js'
import { WORKSPACE_SCOPE_TAP } from '../../../services/traffic-taps/workspace-scope.js'

const T0 = 1_800_000_000
type ReqArg = Parameters<typeof noteRequest>[0]
const req = (over: Partial<ReqArg> = {}) =>
  noteRequest({
    method: 'GET',
    path: '/api/items/workflows',
    status: 200,
    latencyMs: 100,
    authMethod: 'session',
    apiKeyId: null,
    userId: 'aaaa',
    graphqlOperation: null,
    graphqlKind: null,
    cacheHit: false,
    at: T0 * 1000,
    ...over
  })
const frame = (sec = T0) => buildFrame(sec, { sockets: 0, journalSeq: null })
const snap = (w: 60 | 300 | 900 = 60) =>
  buildSnapshot(w, { sockets: 0, users: 0, journalSeq: null })

beforeEach(() => {
  resetTrafficMap()
  advanceTo(T0)
  vi.mocked(currentTraceWorkspace).mockReturnValue(null)
})

describe('#1149 correlated spikes', () => {
  const wave = (offset: number, n = 60) =>
    Array.from({ length: n }, (_, i) => ((i + offset) % 10 === 0 ? 20 : 1))
  it('pearson is 1 for identical series and 0 for a flat one', () => {
    expect(pearson([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1)
    expect(pearson([1, 2, 3, 4], [5, 5, 5, 5])).toBe(0)
  })
  it('finds spikes above mean + 1 sd', () => {
    expect(spikes([1, 1, 1, 20, 1, 1])).toEqual([3])
    expect(spikes([2, 2, 2])).toEqual([])
  })
  it('pairs entities that rise together and skips unrelated ones', () => {
    const rows = [
      { key: 'pages/home', total: 100, series: wave(0) },
      { key: 'widgets/7', total: 90, series: wave(0) },
      { key: 'items/x', total: 80, series: wave(5) }
    ]
    const pairs = correlate(rows)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ a: 'pages/home', b: 'widgets/7', leads: null })
    expect(pairs[0].r).toBeGreaterThan(0.9)
    expect(pairs[0].co_spikes).toBeGreaterThanOrEqual(3)
  })
  it('says which one moved first when B trails A by one bucket', () => {
    const pairs = correlate(
      [
        { key: 'a/a', total: 1, series: wave(0) },
        { key: 'b/b', total: 1, series: wave(9) }
      ],
      { minR: -1 }
    )
    expect(pairs[0]?.leads).toBe('a')
  })
  it('reads per-entity request series off the map', () => {
    req()
    req({ path: '/api/items/regions' })
    req()
    const rows = entityRequestSeries(60, 12, 5)
    expect(rows.map((r) => [r.key, r.total])).toEqual([
      ['items/workflows', 2],
      ['items/regions', 1]
    ])
    expect(rows[0].series).toHaveLength(12)
  })
})

describe('#1133 natural-language filter', () => {
  const vocab = cleanVocabulary({
    callers: [
      { key: 'k12', label: 'LinX', kind: 'key' },
      { key: 'bad key with spaces', label: 'x', kind: 'key' }
    ],
    entities: [{ key: 'items/forecasts', label: 'Forecasts' }]
  })
  it('keeps only well-formed vocabulary', () => {
    expect(vocab.callers.map((c) => c.key)).toEqual(['k12'])
  })
  it('validates the model output against the enums and the page lists', () => {
    const f = validateNlFilter(
      {
        lanes: ['items', 'nope'],
        kinds: '["create","update","delete"]',
        caller: 'k99',
        caller_kind: 'machine',
        window: 300,
        entity: 'items/forecasts',
        summary: 'Writes by integrations to forecasts'
      },
      vocab
    )
    expect(f).toEqual({
      lanes: ['items'],
      kinds: ['create', 'update', 'delete'],
      caller: null,
      caller_kind: 'machine',
      window: 300,
      entity: 'items/forecasts',
      summary: 'Writes by integrations to forecasts'
    })
  })
  it('drops an invented entity and a window the map does not have', () => {
    const f = validateNlFilter({ entity: 'items/secrets', window: 7200, summary: '' }, vocab)
    expect(f.entity).toBeNull()
    expect(f.window).toBeNull()
  })
  it('cleans the prompt', () => {
    expect(cleanPrompt('   ')).toBeNull()
    expect(cleanPrompt(`a  ${'b'.repeat(600)}`)?.length).toBe(400)
  })
})

describe('#1154 whole-map workspace scope', () => {
  it('records nothing until a second workspace is seen', () => {
    req({ req: { workspaceId: 'ws-a' } })
    expect(frame().ext?.[WORKSPACE_SCOPE_TAP]).toBeUndefined()
  })
  it('splits entity, caller and edge counts by workspace once two are seen', () => {
    req({ req: { workspaceId: 'ws-a' } })
    req({ req: { workspaceId: 'ws-b' } })
    req({ req: { workspaceId: 'ws-b' }, status: 500 })
    const f = frame().ext?.[WORKSPACE_SCOPE_TAP] as {
      e: Record<string, Record<string, number[]>>
      c: Record<string, Record<string, number[]>>
      i: Record<string, Record<string, number>>
    }
    expect(f.e['WS-B']['items/workflows']).toEqual([2, 1, 0, 0, 0, 1])
    expect(f.c['WS-B'].uAAAA ?? Object.values(f.c['WS-B'])[0]).toEqual([2, 1])
    expect(Object.values(f.i['WS-B'])[0]).toBe(2)
    const s = snap()
    const e = s.entities.find((x) => x.key === 'items/workflows')
    expect((e?.ext?.[WORKSPACE_SCOPE_TAP] as Record<string, number[]>)['WS-B'][0]).toBe(2)
  })
  it('tags ticker events with the workspace (requests and writes)', () => {
    req({ req: { workspaceId: 'ws-a' }, status: 500 })
    vi.mocked(currentTraceWorkspace).mockReturnValue('ws-a')
    noteWrite({
      collection: 'workflows',
      item: 1,
      action: 'update',
      changedFields: ['name'],
      at: T0 * 1000
    })
    const evs = drainEvents()
    expect(evs.length).toBeGreaterThanOrEqual(2)
    for (const e of evs) expect(e.extra?.ws).toBe('WS-A')
  })
})

describe('#1163 caller apps', () => {
  it('picks the app a caller used most', () => {
    const m = dominantApps([
      ['uA|admin', 3],
      ['uA|efp-new', 9],
      ['k1|zapier', 1]
    ])
    expect(m.get('uA')).toBe('efp-new')
    expect(m.get('k1')).toBe('zapier')
  })
  it('reads the x-nivaro-app header into frames and the snapshot', () => {
    req({ req: { headers: { 'x-nivaro-app': 'efp-new' } } })
    const f = frame().ext?.[CALLER_APPS_TAP] as Record<string, string>
    expect(Object.values(f)).toEqual(['efp-new'])
    expect(frame(T0 + 1).ext?.[CALLER_APPS_TAP]).toBeUndefined()
    expect(Object.values(snap().ext?.[CALLER_APPS_TAP] as Record<string, string>)).toEqual([
      'efp-new'
    ])
  })
})

describe('#1164 presence', () => {
  it('finds the traffic map watch room (self-hosted and per tenant)', () => {
    expect(trafficRoomOf(['sid', 'watch:traffic-map'])).toBe('watch:traffic-map')
    expect(trafficRoomOf(['watch:traffic-map:t:abc'])).toBe('watch:traffic-map:t:abc')
    expect(trafficRoomOf(['watch:traffic', 'user:x'])).toBeNull()
  })
  it('accepts only a well-formed selection', () => {
    expect(cleanSelection({ kind: 'entity', id: 'items/x' })).toEqual({
      kind: 'entity',
      id: 'items/x'
    })
    expect(cleanSelection({ kind: 'secret', id: 'x' })).toBeNull()
    expect(cleanSelection({ kind: 'lane', id: 'x'.repeat(300) })).toBeNull()
  })
  it('stamps the speaker server-side and only speaks into the joined room', () => {
    const handlers = new Map<string, (p: unknown) => void>()
    const emitted: Array<{ room: string; ev: string; p: Record<string, unknown> }> = []
    let rooms = new Set(['s1'])
    const socket = {
      id: 's1',
      get rooms() {
        return rooms
      },
      on: (ev: string, fn: (p: unknown) => void) => handlers.set(ev, fn)
    }
    const io = {
      on: (_ev: string, fn: (s: unknown) => void) => fn(socket),
      to: (room: string) => ({
        emit: (ev: string, p: Record<string, unknown>) => emitted.push({ room, ev, p })
      })
    }
    attachTrafficPresence(io as never)
    const say = handlers.get('traffic-map:presence')
    say?.({ tab: 'tab-1', selection: { kind: 'entity', id: 'items/a' }, user: { id: 'evil' } })
    expect(emitted).toHaveLength(0) // not in the watch room
    rooms = new Set(['s1', 'watch:traffic-map:t:9'])
    say?.({ tab: 'tab-1', selection: { kind: 'entity', id: 'items/a' }, user: { id: 'evil' } })
    expect(emitted[0]).toMatchObject({
      room: 'watch:traffic-map:t:9',
      ev: 'traffic-map:viewer',
      p: { sid: 's1', tab: 'tab-1', user: { id: 'U1', name: 'Ada' } }
    })
    handlers.get('disconnecting')?.(undefined)
    expect(emitted[1].p).toMatchObject({ sid: 's1', gone: true })
  })
})
