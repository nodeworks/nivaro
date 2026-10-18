// api/src/test/unit/services/traffic-edge-weights.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

import {
  advanceTo,
  buildFrame,
  buildSnapshot,
  noteOutbound,
  noteRequest,
  resetTrafficMap
} from '../../../services/traffic-map.js'
import {
  addMinute,
  EDGE_CAP,
  EDGE_WEIGHTS_TAP,
  newMinuteSums,
  noteEdgeWeight,
  sumMinutes
} from '../../../services/traffic-taps/edge-weights.js'

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
    responseBytes: 1000,
    ...over
  })
type W = { i?: Record<string, number[]>; o?: Record<string, number[]> }
const frame = (sec = T0) =>
  buildFrame(sec, { sockets: 0, journalSeq: null }).ext?.[EDGE_WEIGHTS_TAP] as W | undefined

beforeEach(() => {
  resetTrafficMap()
  advanceTo(T0)
})

describe('#2185 edge weights', () => {
  it('adds bytes, time and errors on the same edge keys the map counts', () => {
    req()
    req({ status: 500, latencyMs: 300, responseBytes: 200 })
    const f = buildFrame(T0, { sockets: 0, journalSeq: null })
    const w = f.ext?.[EDGE_WEIGHTS_TAP] as W
    const inKey = Object.keys(f.edges_in)[0]
    expect(w.i?.[inKey]).toEqual([1200, 400, 1])
    // the request reached the database: bytes and time ride that edge too, errors do not
    expect(Object.keys(f.edges_out)).toContain('items>db')
    expect(w.o?.['items>db']).toEqual([1200, 400, 0])
  })

  it('counts a failed partner call on the downstream edge', () => {
    noteOutbound({ apiId: 3, apiName: 'Partner', status: 503, durationMs: 80, at: T0 * 1000 })
    const w = frame()
    const key = Object.keys(w?.o ?? {}).find((k) => k.endsWith('>ext:3'))
    expect(key).toBeTruthy()
    expect(w?.o?.[key as string]).toEqual([0, 80, 1])
  })

  it('drains per frame and seeds the snapshot from the minute sums', () => {
    req()
    expect(frame()).toBeTruthy()
    advanceTo(T0 + 1)
    expect(frame(T0 + 1)).toBeUndefined()
    const snap = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null })
    const s = snap.ext?.[EDGE_WEIGHTS_TAP] as W
    expect(Object.values(s.i ?? {})[0]).toEqual([1000, 100, 0])
  })

  it('drops an undrained backlog older than two seconds (nobody watched)', () => {
    noteEdgeWeight('in', 'uX>items', T0, 10, 10, false)
    noteEdgeWeight('in', 'uX>items', T0 + 5, 5, 5, false)
    expect(frame(T0 + 5)?.i?.['uX>items']).toEqual([5, 5, 0])
  })

  it('stays bounded: past the cap new edges are not kept', () => {
    for (let i = 0; i < EDGE_CAP + 10; i++) noteEdgeWeight('in', `u${i}>items`, T0, 1, 1, false)
    const snap = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null })
    expect(Object.keys((snap.ext?.[EDGE_WEIGHTS_TAP] as W).i ?? {}).length).toBe(EDGE_CAP)
  })

  it('minute sums never read a wrapped slot', () => {
    const s = newMinuteSums()
    addMinute(s, T0, [1, 2, 3])
    addMinute(s, T0 + 15 * 60, [4, 5, 6])
    expect(sumMinutes(s, 60, T0 + 15 * 60)).toEqual([4, 5, 6])
    expect(sumMinutes(s, 900, T0 + 60)).toEqual([0, 0, 0])
  })
})
