import { describe, expect, it } from 'vitest'
import {
  escapeLike,
  historyNarrowing,
  issueRouteTemplates,
  summarizeHistory
} from '../../../services/traffic-history.js'

const now = new Date('2026-09-30T18:00:00.000Z')
const row = (over: Record<string, unknown>) => ({
  method: 'GET',
  path: '/api/items/workflows',
  status: 200,
  latency_ms: 100,
  auth: 'session',
  api_key_id: null,
  user: 'u1',
  graphql_operation: null,
  graphql_kind: null,
  created_at: new Date(now.getTime() - 5 * 60_000),
  ...over
})

describe('summarizeHistory', () => {
  it('buckets by hours, classifies rows the live way, and ranks routes and callers', () => {
    const rows = [
      row({}),
      row({ method: 'PATCH', path: '/api/items/workflows/371407', status: 422, latency_ms: 50 }),
      row({
        path: '/api/items/workflows/371407/resolve-paths',
        latency_ms: 900,
        created_at: new Date(now.getTime() - 50 * 60_000)
      }),
      row({ path: '/api/items/other_collection' })
    ]
    const h = summarizeHistory(rows, 'items', 'workflows', 1, now)
    expect(h.key).toBe('items/workflows')
    expect(h.bucket_s).toBe(60)
    expect(h.series).toHaveLength(60)
    // R11: the failed PATCH still counts as a write request.
    expect(h.totals).toMatchObject({ req: 3, read: 2, write_requests: 1, error: 1 })
    expect(h.status_codes).toEqual({ '200': 2, '422': 1 })
    expect(h.top_routes[0]).toEqual({ route: 'GET /api/items/workflows', n: 1 })
    expect(h.top_callers[0]).toEqual({ key: 'uU1', n: 3 })
    expect(h.totals.p95).toBeGreaterThanOrEqual(900)
    expect(summarizeHistory([], 'items', 'workflows', 6, now).bucket_s).toBe(300)
    expect(summarizeHistory([], 'items', 'workflows', 24, now).bucket_s).toBe(900)
  })
  it('counts a failed write as a write request even when it errored', () => {
    const h = summarizeHistory(
      [row({ method: 'DELETE', path: '/api/items/workflows/5', status: 500 })],
      'items',
      'workflows',
      1,
      now
    )
    expect(h.totals).toMatchObject({ req: 1, write_requests: 1, read: 0, error: 1 })
  })
})

describe('historyNarrowing', () => {
  it('narrows per lane', () => {
    expect(historyNarrowing('items', 'workflows')).toEqual({
      column: 'collection',
      equals: 'workflows',
      like: ['/api/pipelines/instance/workflows/%'],
      routePrefix: '/api/items/workflows'
    })
    expect(historyNarrowing('widgets', '5')).toEqual({
      like: ['/api/widgets-internal/5/%'],
      routePrefix: '/api/widgets-internal/5'
    })
    expect(historyNarrowing('queries', 'forecast-grid')).toEqual({
      like: ['/api/custom-queries/forecast-grid/execute'],
      routePrefix: '/api/custom-queries/forecast-grid'
    })
    expect(historyNarrowing('files', 'upload')).toEqual({
      like: ['/api/files%', '/files'],
      routePrefix: '/api/files'
    })
    expect(historyNarrowing('other', 'notifications')).toEqual({
      like: ['/api/notifications%'],
      routePrefix: '/api/notifications'
    })
  })
  it('R13: anonymous graphql needs a null operation on a graphql path', () => {
    expect(historyNarrowing('graphql', 'anonymous')).toEqual({
      column: 'graphql_operation',
      equals: null,
      pathIn: ['/graphql', '/api/graphql'],
      routePrefix: '/graphql'
    })
    expect(historyNarrowing('graphql', 'GetThing').equals).toBe('GetThing')
  })
  it('R13: extension history comes from that extension’s registered routes', () => {
    const n = historyNarrowing('extension', 'efp-ops', ['/api/efp/forecast/:id', '/api/mwf-x'])
    expect(n.like).toEqual(['/api/efp/forecast/%', '/api/mwf-x'])
    expect(historyNarrowing('extension', 'none', []).like).toEqual([])
  })
  it('escapes LIKE wildcards in entity names', () => {
    expect(escapeLike('a_b%c')).toBe('a\\_b\\%c')
    expect(historyNarrowing('widgets', 'a_b').like).toEqual(['/api/widgets-internal/a\\_b/%'])
  })
})

describe('issueRouteTemplates (R12)', () => {
  it('uses Fastify templates, not concrete urls', () => {
    expect(issueRouteTemplates('widgets', '5')).toEqual(['/api/widgets-internal/:id'])
    expect(issueRouteTemplates('items', 'workflows')).toContain('/api/items/:collection')
  })
})
