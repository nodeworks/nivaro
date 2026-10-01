// api/src/test/unit/services/traffic-people-lenses.test.ts
// Traffic Map round 4 — callers and people (#1172 #1178 #1179 #1181 #1182 #1183).
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

import {
  entityPathPattern,
  groupExports,
  keyVerdicts,
  parseCallerKey,
  rowsFromComment,
  tokenStreaks
} from '../../../routes/traffic-map-extras/people-lenses.js'
import {
  advanceTo,
  buildSnapshot,
  drainEvents,
  noteRequest,
  resetTrafficMap
} from '../../../services/traffic-map.js'
import { crashOf } from '../../../services/traffic-taps/client-crashes.js'
import { egressReaders, LARGE_ROWS, rowsOf } from '../../../services/traffic-taps/egress.js'
import {
  personTrail,
  pushStep,
  type TrailStep,
  visitsOf
} from '../../../services/traffic-taps/person-trail.js'
import { ROLES_TAP, roleBucket } from '../../../services/traffic-taps/roles.js'

const T0 = 1_800_000_000
const UID = 'ABCDEF01-2345-6789-ABCD-EF0123456789'
type ReqArg = Parameters<typeof noteRequest>[0]
const req = (over: Partial<ReqArg> = {}) =>
  noteRequest({
    method: 'GET',
    path: '/api/items/workflows',
    status: 200,
    latencyMs: 40,
    authMethod: 'session',
    apiKeyId: null,
    userId: UID,
    graphqlOperation: null,
    graphqlKind: null,
    cacheHit: false,
    at: T0 * 1000,
    ...over
  })

beforeEach(() => {
  resetTrafficMap()
  advanceTo(T0)
})

describe('#1172 credentials', () => {
  const NOW = Date.parse('2026-10-01T12:00:00Z')
  it('flags keys expiring within 7 days and keys near their limit, skipping inactive ones', () => {
    const v = keyVerdicts(
      [
        {
          id: 1,
          name: 'Soon',
          expires_at: new Date(NOW + 3 * 86_400_000),
          rate_limit_per_minute: null,
          is_active: true
        },
        {
          id: 2,
          name: 'Later',
          expires_at: new Date(NOW + 30 * 86_400_000),
          rate_limit_per_minute: 100,
          is_active: 1
        },
        { id: 3, name: 'Hot', expires_at: null, rate_limit_per_minute: 100, is_active: true },
        {
          id: 4,
          name: 'Off',
          expires_at: new Date(NOW + 86_400_000),
          rate_limit_per_minute: null,
          is_active: false
        },
        {
          id: 5,
          name: 'Gone',
          expires_at: new Date(NOW - 3 * 86_400_000),
          rate_limit_per_minute: null,
          is_active: true
        }
      ],
      new Map([
        [2, 40],
        [3, 92]
      ]),
      NOW
    )
    expect(Object.keys(v).sort()).toEqual(['k1', 'k3'])
    expect(v.k1.expires_in_days).toBe(3)
    expect(v.k3).toMatchObject({ limit: 100, used: 92, pct: 92, expires_in_days: null })
  })

  it('a partner keeps failing after two failed exchanges in a row; a success breaks the streak', () => {
    const at = (m: number) => new Date(NOW - m * 60_000)
    const s = tokenStreaks([
      { api_id: 9, ok: 0, status: 401, error: 'invalid_client', created_at: at(1) },
      { api_id: 9, ok: 0, status: 401, error: 'invalid_client', created_at: at(2) },
      { api_id: 9, ok: 1, status: 200, error: null, created_at: at(3) },
      { api_id: 7, ok: 0, status: 500, error: 'boom', created_at: at(1) },
      { api_id: 7, ok: 1, status: 200, error: null, created_at: at(2) }
    ])
    expect(Object.keys(s)).toEqual(['ext:9'])
    expect(s['ext:9']).toMatchObject({ streak: 2, last_status: 401, last_error: 'invalid_client' })
    expect(s['ext:9'].last_ok_at).toBe(at(3).toISOString())
  })
})

describe('#1178 follow one person', () => {
  it('keeps the newest steps with the screen pattern, never an id', () => {
    req({
      req: {
        headers: { 'x-nivaro-page': '/collections/workflows/371367', 'x-nivaro-app': 'admin' }
      }
    })
    req({ path: '/api/items/projects', req: { headers: { 'x-nivaro-page': '/my-work' } } })
    const t = personTrail(`u${UID}`)
    expect(t.steps).toHaveLength(2)
    expect(t.steps[0]).toMatchObject({ page: '/collections/workflows/:id', app: 'admin' })
    expect(t.steps[1].key).toBe('items/projects')
    // only people
    req({ authMethod: 'api_key', apiKeyId: 12, userId: null })
    expect(personTrail('k12').steps).toHaveLength(0)
  })

  it('folds consecutive steps on one screen into a visit, newest first', () => {
    const steps: TrailStep[] = []
    const s = (t: number, page: string, status = 200): TrailStep => ({
      t,
      key: 'items/workflows',
      route: 'GET /api/items/workflows',
      status,
      ms: 10,
      page,
      app: 'admin'
    })
    for (const x of [s(1, '/a'), s(2, '/a', 500), s(3, '/b')]) pushStep(steps, x, 2)
    expect(steps.map((x) => x.t)).toEqual([2, 3])
    const v = visitsOf([s(1, '/a'), s(2, '/a', 500), s(3, '/b')])
    expect(v.map((x) => [x.page, x.n, x.errors])).toEqual([
      ['/b', 1, 0],
      ['/a', 2, 1]
    ])
  })
})

describe('#1179 data egress', () => {
  it('ranks callers by rows returned, counting large reads; only GET', () => {
    req({ req: { __nvrRows: 30 } })
    req({ req: { __nvrRows: LARGE_ROWS } })
    req({ method: 'POST', req: { __nvrRows: 9000 } })
    req({
      authMethod: 'api_key',
      apiKeyId: 4,
      userId: null,
      path: '/api/items/projects',
      req: { __nvrRows: 10 }
    })
    const r = egressReaders(60, T0)
    expect(r.map((x) => [x.caller, x.rows, x.reads, x.large])).toEqual([
      [`u${UID}`, 30 + LARGE_ROWS, 2, 1],
      ['k4', 10, 1, 0]
    ])
    expect(r[0].top[0]).toEqual({ key: 'items/workflows', rows: 30 + LARGE_ROWS })
    expect(rowsOf('GET', { __nvrRows: 'x' })).toBe(0)
  })

  it('reads rows out of export activity comments and groups them per person', () => {
    expect(rowsFromComment('csv · 1,200 rows · filters: {}')).toBe(1200)
    expect(rowsFromComment('"Monthly": 40 rows (xlsx)')).toBe(40)
    expect(rowsFromComment('business tables')).toBeNull()
    const g = groupExports([
      {
        user: 'aa',
        action: 'export',
        collection: 'workflows',
        comment: 'csv · 10 rows',
        timestamp: new Date(1000)
      },
      {
        user: 'aa',
        action: 'pdf-render',
        collection: 'workflows',
        comment: 'Invoice',
        timestamp: new Date(2000)
      },
      {
        user: 'bb',
        action: 'export',
        collection: 'projects',
        comment: 'xlsx · 900 rows',
        timestamp: new Date(3000)
      }
    ])
    expect(g.map((x) => [x.caller, x.exports, x.rows])).toEqual([
      ['uBB', 1, 900],
      ['uAA', 2, 10]
    ])
    expect(g[1].by.map((b) => b.label)).toEqual(['Export', 'PDF'])
  })
})

describe('#1181 client crash on the ticker', () => {
  it('pushes one tagged error event carrying the verified replay link', () => {
    drainEvents()
    const crash = {
      issue_id: 42,
      recording_id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
      offset_ms: 1234,
      message: 'Cannot read x'
    }
    req({
      method: 'POST',
      path: '/api/issues/client',
      status: 204,
      req: { __nvrClientCrash: crash }
    })
    const ev = drainEvents().find((e) => e.tags?.includes('client crash'))
    expect(ev?.kind).toBe('error')
    expect(ev?.extra?.client_crash).toEqual(crash)
    expect(crashOf('GET', '/api/issues/client', { __nvrClientCrash: crash })).toBeNull()
    expect(
      crashOf('POST', '/api/issues/client', {
        __nvrClientCrash: { ...crash, recording_id: 'nope' }
      })
    ).toMatchObject({ recording_id: null, offset_ms: null })
  })
})

describe('#1182 role split', () => {
  it('buckets people by role, keys and machine accounts as integration', () => {
    expect(roleBucket({ authMethod: 'api_key', user: { role: 'R1' } })).toBe('integration')
    expect(roleBucket({ authMethod: 'session', user: { role: 'r1', account_kind: 'bot' } })).toBe(
      'integration'
    )
    expect(roleBucket({ authMethod: 'session', user: { role: 'r1' } })).toBe('R1')
    expect(roleBucket({ authMethod: null, user: null })).toBe('anonymous')
    req({ req: { user: { role: 'abc' } } })
    req({ req: { user: { role: 'abc' } } })
    req({ authMethod: 'api_key', apiKeyId: 2, userId: null, req: { user: { role: 'abc' } } })
    const e = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null }).entities.find(
      (x) => x.key === 'items/workflows'
    )
    expect(e?.ext?.[ROLES_TAP]).toEqual({ ABC: 2, integration: 1 })
  })
})

describe('#1183 payload peek', () => {
  it('accepts key and person callers only, and escapes LIKE wildcards', () => {
    expect(parseCallerKey('k12')).toEqual({ keyId: 12 })
    expect(parseCallerKey(`u${UID.toLowerCase()}`)).toEqual({ userId: UID })
    expect(parseCallerKey('anon')).toBeNull()
    expect(entityPathPattern('work_flows%')).toBe('%/work\\_flows\\%%')
  })
})
