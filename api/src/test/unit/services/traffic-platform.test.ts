// api/src/test/unit/services/traffic-platform.test.ts — Traffic Map round 4 platform taps
// (#1173 ownership, #1175 queue cache, #1177 resolver time, #1185 tenant load).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const measure = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null),
  requestMeasure: vi.fn(() => measure.value)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
const source = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../../services/traffic-source.js', () => ({
  currentTrafficSource: () => (source.id ? { id: source.id, label: 'x', kind: 'cron' } : null)
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  advanceTo,
  noteOutbound,
  noteRequest,
  resetTrafficMap,
  setExtensionRoutes
} from '../../../services/traffic-map.js'
import {
  extensionOfDown,
  extensionOfSource,
  extOwnershipTap,
  ownershipFigures,
  splitRequest
} from '../../../services/traffic-taps/ext-ownership.js'
import {
  fieldPath,
  graphqlResolversTap,
  markResolverWatch,
  noteResolverTime,
  resolverDetail,
  resolverTimingOn,
  timedGate,
  timedResolver
} from '../../../services/traffic-taps/graphql-resolvers.js'
import {
  noteQueueLookup,
  noteQueueSync,
  queueCacheMemory
} from '../../../services/traffic-taps/queue-cache.js'
import {
  rankTenantRows,
  tenantLoadRanking,
  tenantLoadTap
} from '../../../services/traffic-taps/tenant-load.js'
import {
  registerTrafficTap,
  trafficTaps,
  unregisterTrafficTap
} from '../../../services/traffic-taps.js'

const T0 = 1_800_000_000
const req = (over: Partial<Parameters<typeof noteRequest>[0]> = {}) =>
  noteRequest({
    method: 'GET',
    path: '/api/items/workflows',
    status: 200,
    latencyMs: 100,
    authMethod: 'session',
    apiKeyId: null,
    userId: 'u1',
    graphqlOperation: null,
    graphqlKind: null,
    cacheHit: false,
    at: T0 * 1000,
    req: {},
    ...over
  })

beforeEach(() => {
  for (const t of trafficTaps()) unregisterTrafficTap(t.id)
  resetTrafficMap()
  advanceTo(T0)
  registerTrafficTap(extOwnershipTap)
  registerTrafficTap(graphqlResolversTap)
  registerTrafficTap(tenantLoadTap)
  measure.value = null
  source.id = null
})
afterEach(() => {
  for (const t of trafficTaps()) unregisterTrafficTap(t.id)
  setExtensionRoutes(new Map())
})

describe('#1173 extension ownership', () => {
  it('splits a request by extension hook time, capped at the total', () => {
    expect(splitRequest(100, null, null)).toEqual([['core', 100]])
    expect(splitRequest(100, 'efp-ops', new Map([['x', 5]]))).toEqual([['efp-ops', 100]])
    expect(splitRequest(100, null, new Map([['efp-ops', 30]]))).toEqual([
      ['efp-ops', 30],
      ['core', 70]
    ])
    // hooks that overlap past the total are scaled down; nothing left for core
    expect(
      splitRequest(
        100,
        null,
        new Map([
          ['a', 150],
          ['b', 50]
        ])
      )
    ).toEqual([
      ['a', 75],
      ['b', 25]
    ])
    expect(splitRequest(0, null, null)).toEqual([])
  })

  it('names the extension behind a cron source or a declared node', () => {
    expect(extensionOfSource('cron:ext:efp-ops:reforecasting')).toBe('efp-ops')
    expect(extensionOfSource('cron:rollup-drift-sweep')).toBeNull()
    expect(extensionOfSource('flow:abc')).toBeNull()
    expect(extensionOfDown('x:efp-ops.mwf')).toBe('efp-ops')
    expect(extensionOfDown('ext:4')).toBeNull()
  })

  it('accumulates per node and leaves core-only nodes out', () => {
    measure.value = { sqlMs: 0, queries: 0, extensionMs: new Map([['efp-ops', 40]]) }
    req()
    measure.value = null
    req({ path: '/api/items/regions' })
    const f = ownershipFigures(60, T0)
    expect(f.nodes['items/workflows']).toMatchObject({
      ms: { 'efp-ops': 40, core: 60 },
      total_ms: 100
    })
    expect(f.nodes['items/regions']).toBeUndefined()
    expect(ownershipFigures(60, T0, true).nodes['items/regions'].ms).toEqual({ core: 100 })
    expect(f.extensions).toEqual(['efp-ops'])
  })

  it('gives an extension route wholly to its extension', () => {
    setExtensionRoutes(new Map([['efp-ops', [{ method: 'GET', url: '/api/efp/thing' }]]]))
    req({ path: '/api/efp/thing', latencyMs: 30 })
    expect(ownershipFigures(60, T0).nodes['extension/efp-ops'].ms).toEqual({ 'efp-ops': 30 })
  })

  it('attributes a partner call to the extension cron that made it', () => {
    source.id = 'cron:ext:efp-ops:ping'
    noteOutbound({ apiId: 3, apiName: 'MDSi', status: 200, durationMs: 80, at: T0 * 1000 })
    source.id = null
    noteOutbound({ apiId: 3, apiName: 'MDSi', status: 200, durationMs: 20, at: T0 * 1000 })
    expect(ownershipFigures(60, T0).nodes['ext:3'].ms).toEqual({ 'efp-ops': 80, core: 20 })
  })
})

describe('#1177 resolver time', () => {
  it('drops list indexes from the field path and caps depth', () => {
    const path = { key: 'project', prev: { key: 0, prev: { key: 'workflows' } } }
    expect(fieldPath(path)).toBe('workflows.project')
    let deep: { key: string; prev?: unknown } = { key: 'a' }
    for (const k of ['b', 'c', 'd', 'e', 'f', 'g']) deep = { key: k, prev: deep }
    expect(fieldPath(deep as never)).toBe('a.b.c.d.e.f.…')
  })

  it('times only while the map is watched, and never changes the result', async () => {
    markResolverWatch(0)
    expect(resolverTimingOn()).toBe(false)
    const fakeReq: Record<string, unknown> = {}
    const wrapped = timedResolver(
      'm2o',
      async (_s: unknown, _a: unknown, _c: { req?: unknown }) => 7
    )
    const info = { path: { key: 'project', prev: { key: 'workflows' } } }
    expect(await wrapped(null, {}, { req: fakeReq }, info)).toBe(7)
    expect(fakeReq.__nvrResolverTimes).toBeUndefined()
    markResolverWatch()
    expect(await wrapped(null, {}, { req: fakeReq }, info)).toBe(7)
    expect(await timedGate({ req: fakeReq }, 'projects', async () => 'g')).toBe('g')
    const acc = fakeReq.__nvrResolverTimes as Map<string, { n: number; kind: string }>
    expect(acc.get('workflows.project')).toMatchObject({ n: 1, kind: 'm2o' })
    expect(acc.get('gate:projects')).toMatchObject({ n: 1, kind: 'gate' })
    const boom = timedResolver('o2m', () => {
      throw new Error('no')
    })
    expect(() => boom(null, {}, { req: fakeReq }, info)).toThrow('no')
  })

  it('folds a finished GraphQL request into its operation', () => {
    markResolverWatch()
    const fakeReq = {}
    noteResolverTime(fakeReq, 'workflows.project', 'm2o', 12)
    noteResolverTime(fakeReq, 'workflows.project', 'm2o', 30)
    req({
      path: '/api/graphql',
      method: 'POST',
      graphqlOperation: 'Lines',
      graphqlKind: 'query',
      req: fakeReq
    })
    const d = resolverDetail('graphql/Lines', 60, T0)
    expect(d?.timing).toBe(true)
    expect(d?.paths[0]).toMatchObject({
      path: 'workflows.project',
      calls: 2,
      total_ms: 42,
      avg_ms: 21,
      max_ms: 30
    })
    expect(resolverDetail('items/workflows', 60, T0)).toBeUndefined()
  })
})

describe('#1175 queue cache', () => {
  it('keeps resync cost per queue and the per-write lookup per collection', () => {
    noteQueueSync('a1', 'workflows', 10, false, T0 * 1000)
    noteQueueSync('A1', 'workflows', 30, true, T0 * 1000)
    vi.useFakeTimers()
    vi.setSystemTime(T0 * 1000)
    noteQueueLookup('workflows', 2, true)
    noteQueueLookup('regions', 1, false)
    vi.useRealTimers()
    const m = queueCacheMemory(60, T0)
    expect(m.queues.get('A1')).toMatchObject({
      syncs: 2,
      ms: 40,
      failed: 1,
      collections: ['workflows'],
      maxMs: 30
    })
    expect(m.lookups.map((l) => l.collection)).toEqual(['workflows', 'regions'])
    expect(m.lookups[0]).toMatchObject({ writes: 1, hits: 1 })
  })
})

describe('#1185 tenant load', () => {
  it('ranks by database time, then requests, then errors', () => {
    const row = (store: string, db_ms: number, requests: number, errors = 0) => ({
      store,
      tenant_id: store.slice(2),
      requests,
      errors,
      error_pct: 0,
      rps: 0,
      db_ms,
      db_share_pct: 0,
      avg_ms: null,
      queries: 0
    })
    const ranked = rankTenantRows([row('t:a', 10, 5), row('t:b', 90, 1), row('t:c', 10, 9)])
    expect(ranked.map((r) => r.store)).toEqual(['t:b', 't:c', 't:a'])
    expect(ranked[0].db_share_pct).toBe(81.8)
  })

  it('counts the store a request lands in', () => {
    measure.value = { sqlMs: 25, queries: 4, extensionMs: null }
    req({ status: 500 })
    req()
    const [r] = tenantLoadRanking(60, T0)
    expect(r).toMatchObject({ store: 'default', requests: 2, errors: 1, db_ms: 50, queries: 8 })
  })
})
