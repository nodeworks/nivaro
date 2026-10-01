// api/src/test/unit/services/traffic-inspector-a.test.ts
// Traffic Map follow-ups, group A server logic (#1090 #1092 #1107 #1115 #1121 #1124 #1150 #1155 #1158).
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const issueRows: Array<Record<string, unknown>> = []
vi.mock('../../../db/index.js', () => {
  const chain = () => {
    const q: Record<string, unknown> = {}
    for (const m of [
      'whereIn',
      'whereNot',
      'orderBy',
      'where',
      'limit',
      'leftJoin',
      'whereNotNull'
    ])
      q[m] = () => q
    q.select = () => Promise.resolve(issueRows)
    return q
  }
  return { db: Object.assign(() => chain(), { raw: vi.fn() }) }
})
vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null),
  listTraces: vi.fn(() => []),
  unaccountedMs: vi.fn(() => 5),
  span: (_n: string, fn: () => unknown) => fn()
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

import {
  probePath,
  runbooksFromNotes
} from '../../../routes/traffic-map-extras/inspector-actions.js'
import { startChain } from '../../../services/chain.js'
import { issueFingerprint, issueMessage } from '../../../services/error-tracking.js'
import {
  advanceTo,
  currentTrafficSec,
  drainEvents,
  noteRequest,
  noteWrite,
  resetTrafficMap
} from '../../../services/traffic-map.js'
import {
  evalTraffic,
  normalizeTrafficConfig,
  trafficMetricValue
} from '../../../services/traffic-monitor.js'
import {
  ERROR_GROUPS_TAP,
  groupOf,
  messageOfBody
} from '../../../services/traffic-taps/error-groups.js'
import {
  CLIENT_EXPERIENCE_TAP,
  HOOK_COST_TAP,
  hookCostFor,
  rumRoutesFor,
  SLOW_TAIL_TAP,
  slowTracesFor,
  summarizeRum
} from '../../../services/traffic-taps/inspector-detail.js'
import { trafficTaps } from '../../../services/traffic-taps.js'

const T0 = 1_800_000_000
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
  issueRows.length = 0
})

describe('issue fingerprint rule (#1150)', () => {
  it('matches the sha256 trackError always used', () => {
    const expected = createHash('sha256').update('server|GET /api/x|boom').digest('hex')
    expect(issueFingerprint('server', 'GET /api/x', 'boom')).toBe(expected)
    expect(issueMessage('')).toBe('Unknown error')
    expect(issueMessage('x'.repeat(500))).toHaveLength(400)
  })
})

describe('error groups (#1150)', () => {
  it('reads the message off a response body', () => {
    expect(
      messageOfBody('{"statusCode":500,"error":"Internal Server Error","message":"db down"}')
    ).toBe('db down')
    expect(messageOfBody('{"error":"Not found"}')).toBe('Not found')
    expect(messageOfBody('{"errors":[{"message":"bad query"}]}')).toBe('bad query')
    expect(messageOfBody('plain  text')).toBe('plain text')
    expect(messageOfBody(null)).toBe('')
  })
  it('keys a 5xx by the issue fingerprint and a 4xx without one', () => {
    const g5 = groupOf({
      method: 'get',
      routeUrl: '/api/items/:collection',
      path: '/api/items/workflows',
      route: 'GET /api/items/workflows',
      status: 500,
      code: null,
      body: '{"message":"db down"}'
    })
    expect(g5.meta.routeKey).toBe('GET /api/items/:collection')
    expect(g5.meta.fingerprint).toBe(
      issueFingerprint('server', 'GET /api/items/:collection', 'db down')
    )
    const g4 = groupOf({
      method: 'PATCH',
      routeUrl: null,
      path: '/api/items/workflows/1',
      route: 'PATCH /api/items/workflows/:id',
      status: 422,
      code: 'CHANGE_REASON_REQUIRED',
      body: null
    })
    expect(g4.meta.fingerprint).toBeNull()
    expect(g4.meta.message).toBe('CHANGE_REASON_REQUIRED')
  })
  it('groups an entity’s errors and links issues by fingerprint', async () => {
    const r = { routeOptions: { url: '/api/items/:collection' }, __nvrErr: '{"message":"db down"}' }
    req({ status: 500, req: r })
    req({ status: 500, req: r })
    req({ status: 404, req: { __nvrErr: '{"error":"gone"}' } })
    const fp = issueFingerprint('server', 'GET /api/items/:collection', 'db down')
    issueRows.push({ id: 42, fingerprint: fp, status: 'open', occurrence_count: 9 })
    const tap = trafficTaps().find((t) => t.id === ERROR_GROUPS_TAP)
    const d = (await tap?.entityDetail?.('items/workflows', 60, currentTrafficSec())) as {
      groups: Array<{ n: number; status: number; message: string; issue: { id: number } | null }>
    }
    expect(d.groups[0]).toMatchObject({ n: 2, status: 500, message: 'db down', issue: { id: 42 } })
    expect(d.groups[1]).toMatchObject({ n: 1, status: 404, message: 'gone', issue: null })
  })
})

describe('chain id on events (#1092)', () => {
  it('rides error events from the request and write events from the chain store', () => {
    req({ status: 500, req: { chainId: 'chain-abc' } })
    startChain(
      'request:x',
      () =>
        noteWrite({
          collection: 'workflows',
          item: 7,
          action: 'update',
          changedFields: ['name'],
          at: T0 * 1000
        }),
      'chain-write'
    )
    const evs = drainEvents()
    expect(evs.find((e) => e.kind === 'error')?.chain).toBe('chain-abc')
    expect(evs.find((e) => e.kind === 'update')?.chain).toBe('chain-write')
  })
})

describe('inspector detail taps (#1107 #1115 #1121)', () => {
  it('registers the three detail taps', () => {
    const ids = trafficTaps().map((t) => t.id)
    expect(ids).toEqual(
      expect.arrayContaining([HOOK_COST_TAP, CLIENT_EXPERIENCE_TAP, SLOW_TAIL_TAP])
    )
  })
  it('lists the hooks a collection runs, slowest first, with `*` hooks', () => {
    const base = {
      timing: 'after' as const,
      action: 'create',
      name: null,
      runs: 3,
      errors: 0,
      p50_ms: 1,
      max_ms: 9
    }
    const rows = hookCostFor('workflows', [
      { ...base, collection: 'workflows', owner: 'core:activity.ts', p95_ms: 12 },
      { ...base, collection: '*', owner: 'efp-ops', p95_ms: 293 },
      { ...base, collection: 'regions', owner: 'core', p95_ms: 999 },
      { ...base, collection: 'workflows', owner: 'never-ran', p95_ms: null, runs: 0 }
    ])
    expect(rows.map((r) => r.owner)).toEqual(['efp-ops', 'core:activity.ts'])
  })
  it('summarises RUM p75s per app and route, ignoring rage rows', () => {
    expect(rumRoutesFor('budget')).toEqual(['%/p/budget', '%/pages/budget'])
    const rows = summarizeRum([
      { route: '/p/budget', kind: 'load', lcp_ms: 800, duration_ms: 1200, app: 'admin' },
      { route: '/p/budget', kind: 'load', lcp_ms: 1600, duration_ms: 2000, app: 'admin' },
      { route: '/p/budget', kind: 'route', lcp_ms: null, duration_ms: 300, app: 'admin' },
      { route: '/p/budget :: button', kind: 'rage', lcp_ms: null, duration_ms: 3, app: null }
    ])
    expect(rows).toEqual([
      {
        app: 'admin',
        route: '/p/budget',
        samples: 3,
        lcp_p75: 1600,
        load_p75: 2000,
        route_p75: 300
      }
    ])
  })
  it('keeps the slow traces that classify to the entity, slowest first', () => {
    const t = (id: string, url: string, ms: number) => ({
      id,
      method: 'GET',
      route: url,
      url,
      status: 200,
      user: null,
      total_ms: ms,
      spans: [{ seq: 1, phase: 'items:read', ms: ms - 10, at: 0 }],
      ts: new Date(T0 * 1000).toISOString(),
      queries: 3,
      sql_ms: 50,
      top_sql: [],
      wide: []
    })
    const out = slowTracesFor('items', 'workflows', [
      t('a', '/api/items/workflows?limit=50', 1200),
      t('b', '/api/items/regions', 3000),
      t('c', '/api/items/workflows/12', 2500)
    ])
    expect(out.map((x) => x.id)).toEqual(['c', 'a'])
    expect(out[0]).toMatchObject({ slowest_phase: 'items:read', unaccounted_ms: 5 })
  })
})

describe('traffic monitor (#1124)', () => {
  it('reads metrics per minute and validates the config', () => {
    const row = { req: 600, error: 30, p95: 410 }
    expect(trafficMetricValue('errors_per_min', row, 300)).toBe(6)
    expect(trafficMetricValue('requests_per_min', row, 300)).toBe(120)
    expect(trafficMetricValue('p95_ms', row, 300)).toBe(410)
    expect(trafficMetricValue('error_pct', row, 300)).toBe(5)
    expect(trafficMetricValue('errors_per_min', null, 60)).toBe(0)
    expect(
      normalizeTrafficConfig({ entity: 'items/workflows', metric: 'errors_per_min', threshold: 5 })
    ).toEqual({ entity: 'items/workflows', metric: 'errors_per_min', threshold: 5, window_s: 300 })
    expect(
      normalizeTrafficConfig({ entity: 'nope', metric: 'errors_per_min', threshold: 5 })
    ).toBeNull()
    expect(
      normalizeTrafficConfig({ entity: 'items/x', metric: 'bogus' as never, threshold: 5 })
    ).toBeNull()
  })
  it('fails when the live figure passes the threshold', async () => {
    for (let i = 0; i < 6; i++) req({ status: 500 })
    const bad = await evalTraffic({
      entity: 'items/workflows',
      metric: 'errors_per_min',
      threshold: 5,
      window_s: 60
    })
    expect(bad.status).toBe('failing')
    expect(bad.metric).toBe(6)
    const ok = await evalTraffic({
      entity: 'items/workflows',
      metric: 'errors_per_min',
      threshold: 10,
      window_s: 60
    })
    expect(ok.status).toBe('ok')
    expect((await evalTraffic({})).status).toBe('unknown')
  })
})

describe('probe target (#1155)', () => {
  it('only offers a GET that lands on the entity itself', () => {
    expect(probePath('items', 'workflows')).toBe('/api/items/workflows?limit=1')
    expect(probePath('system', 'nivaro_users')).toBe('/api/items/nivaro_users?limit=1')
    expect(probePath('pages', 'budget-overview')).toBe('/api/pages/budget-overview')
    expect(probePath('items', 'Bad Name')).toBeNull()
    expect(probePath('system', 'workflows')).toBeNull()
    expect(probePath('widgets', '5')).toBeNull()
    expect(probePath('graphql', 'getWorkflows')).toBeNull()
  })
})

describe('runbook notes (#1158)', () => {
  it('parses `runbook:` and `runbook <node>:` lines, http(s) or in-app only', () => {
    const out = runbooksFromNotes({
      name: 'MDSi',
      environment: 'Production',
      notes:
        'Partner API\nrunbook: https://wiki/mdsi\nrunbook items/workflows: /docs#wf\nrunbook k7: javascript:alert(1)'
    })
    expect(out).toEqual([
      {
        match: ['mdsi'],
        label: 'MDSi runbook',
        url: 'https://wiki/mdsi',
        source: 'environment',
        detail: 'Production · MDSi'
      },
      {
        match: ['items/workflows'],
        label: 'Runbook for items/workflows',
        url: '/docs#wf',
        source: 'environment',
        detail: 'Production · MDSi'
      }
    ])
  })
})
