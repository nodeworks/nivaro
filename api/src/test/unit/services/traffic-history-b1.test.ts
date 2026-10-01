// #1102 issues by stored route; #1139 rehearsals kept out of history write counts; #1099 codes.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { groupRefusals } from '../../../routes/traffic-map-extras/request-lenses.js'
import {
  type HistoryRow,
  isRehearsalRow,
  issueMatch,
  issueRouteLikes,
  summarizeHistory
} from '../../../services/traffic-history.js'

const NOW = new Date('2026-10-01T12:00:00Z')
const row = (over: Partial<HistoryRow>): HistoryRow => ({
  method: 'POST',
  path: '/api/items/workflows',
  status: 200,
  latency_ms: 10,
  auth: 'session',
  api_key_id: null,
  user: 'u1',
  graphql_operation: null,
  graphql_kind: null,
  created_at: new Date(NOW.getTime() - 60_000),
  query: null,
  ...over
})

/** Mirror of SQL LIKE with ESCAPE '\\' for the patterns we build. */
function like(value: string, pattern: string): boolean {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    else if (c === '%') re += '[\\s\\S]*'
    else if (c === '_') re += '.'
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${re}$`).test(value)
}
const matches = (details: string, lane: Parameters<typeof issueMatch>[0], entity: string) => {
  const m = issueMatch(lane, entity)
  const routeOk = m.routePrefixes.some((p) => issueRouteLikes(p).some((l) => like(details, l)))
  if (!routeOk) return false
  if (!m.urlLike) return true
  return m.urlLike.some((l) => like(details, l)) || !details.includes('Request context:')
}

describe('#1102 issues by stored route', () => {
  const issue = (route: string, url?: string) =>
    `Route: ${route}${url ? `\nRequest context: {"url":"${url}","query_keys":[]}` : ''}\n\nError: boom`
  it('pins items issues to the collection in the stored URL', () => {
    const wf = issue('PATCH /api/items/:collection/:id', '/api/items/workflows/12')
    expect(matches(wf, 'items', 'workflows')).toBe(true)
    expect(matches(wf, 'items', 'workflow_lines')).toBe(false)
    expect(
      matches(
        issue('GET /api/items/:collection', '/api/items/workflows_files'),
        'items',
        'workflows'
      )
    ).toBe(false)
  })
  it('an issue without a request context matches on its route alone', () => {
    expect(matches(issue('GET /api/items/:collection'), 'items', 'regions')).toBe(true)
  })
  it('never matches a different route family or a title mention', () => {
    expect(
      matches(
        issue('GET /api/custom-queries/:slug/execute', '/api/custom-queries/x/execute'),
        'items',
        'workflows'
      )
    ).toBe(false)
    expect(
      matches(
        issue('POST /api/custom-queries/:slug/execute', '/api/custom-queries/totals/execute'),
        'queries',
        'totals'
      )
    ).toBe(true)
    expect(matches('Title mentions /api/items/:collection', 'items', 'workflows')).toBe(false)
  })
})

describe('#1139 rehearsal rows', () => {
  it('knows dry runs, GraphQL dry runs and flow tests; reads never', () => {
    expect(isRehearsalRow(row({ query: 'dry_run=1' }))).toBe(true)
    expect(isRehearsalRow(row({ query: 'a=1&dry_run=true' }))).toBe(true)
    expect(isRehearsalRow(row({ query: 'dry_run=0' }))).toBe(false)
    expect(isRehearsalRow(row({ path: '/graphql', graphql_operation: 'create_x_dry_run' }))).toBe(
      true
    )
    expect(isRehearsalRow(row({ path: '/api/flows/f1/test' }))).toBe(true)
    expect(isRehearsalRow(row({ method: 'GET', query: 'dry_run=1' }))).toBe(false)
  })
  it('counts them apart from write requests', () => {
    const body = summarizeHistory(
      [row({}), row({ query: 'dry_run=1' }), row({ method: 'GET' })],
      'items',
      'workflows',
      1,
      NOW
    )
    expect(body.totals).toMatchObject({ req: 3, read: 1, write_requests: 1, rehearsal: 1 })
  })
})

describe('#1099 refusal grouping', () => {
  it('groups by status and reason code, busiest first', () => {
    expect(
      groupRefusals([
        { status: 403, error: '{"code":"API_KEY_SCOPE_MISSING"}' },
        { status: 403, error: '{"code":"API_KEY_SCOPE_MISSING"}' },
        { status: 429, error: null }
      ])
    ).toEqual([
      { status: 403, code: 'API_KEY_SCOPE_MISSING', n: 2 },
      { status: 429, code: 'RATE_LIMITED', n: 1 }
    ])
  })
})
