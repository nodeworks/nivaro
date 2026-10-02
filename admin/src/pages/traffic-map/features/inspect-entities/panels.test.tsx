import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getInspectSnapshot, resetInspectForTests } from '../../inspect/stack'
import type { InspectPanelProps } from '../../registry/inspectables'
import { following } from '../follow-person'
import { CallerPanel } from './CallerPanel'
import { QueryPanel, WidgetPanel } from './DefinitionPanels'
import { EntityPanel } from './EntityPanel'
import { DownPanel, PagePanel } from './PageDownPanels'

const routes = new Map<string, unknown>()
const fail404 = new Set<string>()

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (fail404.has(url)) {
        const err = new Error('Not found') as Error & { response: unknown }
        err.response = { status: 404, data: { error: 'Not found' } }
        throw err
      }
      if (!routes.has(url)) throw new Error(`unexpected ${url}`)
      return { data: { data: routes.get(url) } }
    })
  }
}))

const UUID = '7A0411F3-C687-40E5-ADF5-614157CF88EC'
const RID = '0f8fad5b-d9cb-469f-a165-70867728950e'

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}
const props = (kind: string, id: string): InspectPanelProps => ({
  inspectRef: { kind, id },
  open: () => {},
  anchor: null,
  windowSec: 300
})

beforeEach(() => {
  routes.clear()
  fail404.clear()
})
afterEach(() => {
  act(() => {
    resetInspectForTests()
    following.set(null)
  })
})

describe('CallerPanel', () => {
  it('shows a person with routes, drillable requests and Follow; no recording route = nothing', async () => {
    routes.set(`/traffic-map/inspect/caller/u${UUID}`, {
      key: `u${UUID}`,
      kind: 'person',
      label: 'Robert Lee',
      note: null,
      range: { from: 1, to: 2 },
      logged: true,
      truncated: false,
      summary: {
        total: 3,
        errors: 1,
        error_rate: 33.3,
        p95: 120,
        routes: [{ route: 'GET /api/items/workflows', status: 200, n: 2, p95: 90 }]
      },
      series: [0, 1, 2],
      auth_failures: [],
      recent: [
        {
          at: '2026-10-01T10:00:00Z',
          method: 'GET',
          path: '/api/items/workflows',
          status: 200,
          ms: 90,
          request_id: RID
        },
        {
          at: '2026-10-01T10:00:01Z',
          method: 'GET',
          path: '/api/x',
          status: 500,
          ms: 9,
          request_id: null
        }
      ],
      request_ids_logged: true,
      key_info: null,
      person: {
        id: UUID,
        name: 'Robert Lee',
        email: 'r@example.com',
        title: null,
        department: null,
        status: 'active',
        account_kind: null,
        role: 'Admin',
        last_access: null,
        out_of_office: false
      },
      runs: null,
      breakers: [],
      has_dependencies: true
    })
    fail404.add('/traffic-map/inspect/recording-for')
    render(wrap(<CallerPanel {...props('caller', `u${UUID}`)} />))
    await screen.findByText('GET /api/items/workflows', { selector: 'span' })
    expect(document.querySelector(`[data-tm-inspect-caller="u${UUID}"]`)).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-caller-recording]')).toBeNull()
    // a row with a request id drills into the request; one without says why it cannot
    const link = document.querySelector(`[data-tm-inspect-link="request:${RID}"]`) as HTMLElement
    expect(link).toBeTruthy()
    fireEvent.click(link)
    expect(getInspectSnapshot().levels.at(-1)).toMatchObject({ kind: 'request', id: RID })
    expect(screen.getByText('GET /api/x').getAttribute('data-tip')).toMatch(/No request id/)
    fireEvent.click(document.querySelector('[data-tm-inspect-caller-follow]') as HTMLElement)
    expect(following.get()).toEqual({ key: `u${UUID}`, name: 'Robert Lee' })
  })

  it('says why when the caller cannot be found', async () => {
    fail404.add('/traffic-map/inspect/caller/k99')
    render(wrap(<CallerPanel {...props('caller', 'k99')} />))
    await waitFor(() =>
      expect(document.querySelector('[data-tm-inspect-error="404"]')).toBeTruthy()
    )
  })
})

describe('EntityPanel', () => {
  it('lists callers, failed requests without ids honestly, and writes that open write + record', async () => {
    routes.set('/traffic-map/inspect/entity/items%2Fworkflows', {
      key: 'items/workflows',
      lane: 'items',
      entity: 'workflows',
      label: 'Workflows',
      related: null,
      range: { from: 1, to: 2 },
      map_window: 300,
      history: null,
      history_hours: 1,
      history_error: 'The API log could not be read right now.',
      history_note: null,
      history_anchor_note: null,
      callers: [{ key: 'k2', sums: [5, 5, 0, 0, 0, 0], p95: 30 }],
      error_groups: [],
      other_lenses: ['hot-records'],
      recent_errors: [
        {
          at: '2026-10-01T10:00:00Z',
          method: 'GET',
          path: '/api/items/workflows/9',
          status: 404,
          ms: 5,
          caller: 'k2',
          request_id: null
        }
      ],
      recent_writes: [
        {
          id: 77,
          action: 'update',
          item: '9',
          user: null,
          user_name: 'Beth',
          at: '2026-10-01T10:00:00Z',
          origin: 'person'
        }
      ],
      request_ids_logged: true
    })
    render(wrap(<EntityPanel {...props('entity', 'items/workflows')} />))
    await screen.findByText('Workflows')
    expect(document.querySelector('[data-tm-inspect-link="caller:k2"]')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-note="no-request-ids"]')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link="write:77"]')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link="record:workflows:9"]')).toBeTruthy()
    expect(screen.getByText('The API log could not be read right now.')).toBeTruthy()
  })
})

describe('PagePanel', () => {
  it('says plainly when page loads are not available', async () => {
    routes.set('/traffic-map/inspect/page/admin%20%2Ftraffic-map', {
      id: 'admin /traffic-map',
      app: 'admin',
      path: '/traffic-map',
      window_s: 300,
      fanout_limit: 60,
      screens: [],
      present: [],
      present_note: null,
      builds: []
    })
    fail404.add('/traffic-map/inspect/load-list')
    render(wrap(<PagePanel {...props('page', 'admin /traffic-map')} />))
    await screen.findByText('Page loads not available on this server yet.')
    expect(document.querySelector('[data-tm-inspect-note="no-calls"]')).toBeTruthy()
  })

  it('shows a load by the person’s name as text and links the caller by its key', async () => {
    routes.set('/traffic-map/inspect/page/admin%20%2Ftraffic-map', {
      id: 'admin /traffic-map',
      app: 'admin',
      path: '/traffic-map',
      window_s: 300,
      fanout_limit: 60,
      screens: [],
      present: [],
      present_note: null,
      builds: []
    })
    routes.set('/traffic-map/inspect/load-list', [
      { load: 'ld-aaaaaa', at: 1, calls: 12, ms: 420, user: 'Beth', caller: `u${UUID}` },
      { load: 'ld-bbbbbb', at: 2, calls: 3, ms: 90, user: null, caller: 'anon' }
    ])
    render(wrap(<PagePanel {...props('page', 'admin /traffic-map')} />))
    await screen.findByText('Beth')
    // the name is the load-list's display name, never a caller key run through the catalog
    expect(screen.queryByText('eth')).toBeNull()
    expect(screen.queryByText(/Caller Beth/)).toBeNull()
    expect(document.querySelector('[data-tm-inspect-link="load:ld-aaaaaa"]')).toBeTruthy()
    expect(document.querySelector(`[data-tm-inspect-link="caller:u${UUID}"]`)).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link="caller:anon"]')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-page-loads="2"]')).toBeTruthy()
  })
})

describe('QueryPanel', () => {
  it('shows the SQL, cache figures, dependents that open, and the plan slot', async () => {
    routes.set('/traffic-map/inspect/query/project-budgets', {
      id: 4,
      slug: 'project-budgets',
      name: 'Project budgets',
      description: null,
      sql_text: 'select * from projects',
      params: [{ name: 'year', type: 'number', required: true }],
      cache_ttl: 60,
      enabled: true,
      access: 'admin',
      warm_daily: false,
      updated_at: null,
      entity: 'queries/project-budgets',
      cache: {
        since: '2026-10-01T00:00:00Z',
        row: {
          hits: 8,
          misses: 2,
          bypasses: 0,
          uncached_runs: 0,
          runs: 10,
          hit_rate: 0.8,
          avg_exec_ms: 12,
          last_run_at: null,
          advice: null
        },
        last_error: { at: '2026-10-01T10:00:00Z', message: 'timeout' }
      },
      freshness: { ok: true, data_changed_at: null, sources: [] },
      plan: null,
      dependents: [
        { surface: 'Record widgets', id: 5, name: 'Budget table', detail: null },
        { surface: 'Other custom queries', id: 9, name: 'Rollup', detail: 'rollup' }
      ],
      recent_errors: []
    })
    render(wrap(<QueryPanel {...props('query', 'project-budgets')} />))
    await screen.findByText('Project budgets')
    expect(document.querySelector('[data-tm-inspect-query="project-budgets"]')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-query-sql]')?.textContent).toBe(
      'select * from projects'
    )
    expect(screen.getByText('80%')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-query-last-error]')?.textContent).toMatch(
      /timeout/
    )
    expect(document.querySelector('[data-tm-inspect-note="plan-none"]')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link="widget:5"]')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link="query:rollup"]')).toBeTruthy()
    expect(
      document.querySelector('[data-tm-inspect-link="entity:queries/project-budgets"]')
    ).toBeTruthy()
  })

  it('says why when the query cannot be found', async () => {
    fail404.add('/traffic-map/inspect/query/nope')
    render(wrap(<QueryPanel {...props('query', 'nope')} />))
    await waitFor(() =>
      expect(document.querySelector('[data-tm-inspect-error="404"]')).toBeTruthy()
    )
  })
})

describe('WidgetPanel', () => {
  it('shows the definition, the bound query that opens, and the raw config on demand', async () => {
    routes.set('/traffic-map/inspect/widget/5', {
      id: 5,
      name: 'Budget table',
      description: 'Budgets by project',
      type: 'table',
      active: true,
      inputs: null,
      config_lines: [{ label: 'Columns', value: '2' }],
      config_raw: '{"query_id":4}',
      query: {
        id: 4,
        slug: 'project-budgets',
        name: 'Project budgets',
        cache_ttl: 0,
        cache: null
      },
      entity: 'widgets/5',
      recent_errors: []
    })
    render(wrap(<WidgetPanel {...props('widget', '5')} />))
    await screen.findByText('Budget table')
    expect(document.querySelector('[data-tm-inspect-widget="5"]')).toBeTruthy()
    expect(screen.getByText('Columns')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link="query:project-budgets"]')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-note="cache-none"]')).toBeTruthy()
    expect(screen.queryByText('{"query_id":4}')).toBeNull()
    fireEvent.click(document.querySelector('[data-tm-inspect-widget-raw]') as HTMLElement)
    expect(screen.getByText('{"query_id":4}')).toBeTruthy()
  })

  it('says when the bound query is gone', async () => {
    routes.set('/traffic-map/inspect/widget/6', {
      id: 6,
      name: 'Orphan',
      description: null,
      type: 'table',
      active: false,
      inputs: null,
      config_lines: [],
      config_raw: '',
      query: { id: 99, missing: true },
      entity: 'widgets/6',
      recent_errors: []
    })
    render(wrap(<WidgetPanel {...props('widget', '6')} />))
    await screen.findByText(/custom query #99, which no longer exists/)
  })
})

describe('DownPanel', () => {
  it('shows a partner without secrets, its history, the anchor note and submissions that open', async () => {
    routes.set('/traffic-map/inspect/down/ext%3A3', {
      id: 'ext:3',
      label: 'MDSI',
      history_hours: 24,
      history: {
        series: [{ req: 2, error: 1 }],
        totals: { req: 2, error: 1 },
        status_codes: { '500': 1, '200': 1 },
        top_paths: [{ path: 'POST /orders/:id', n: 2 }],
        truncated: false
      },
      history_error: null,
      history_note: null,
      history_anchor_note:
        'The anchored time is older than 24 h — the history shows the last 24 h.',
      partner: {
        id: 3,
        name: 'MDSI',
        base_url: 'https://api.mdsi.example/v1',
        description: null,
        auth_type: 'bearer',
        enabled: true,
        integration_type: 'erp',
        owner_name: 'Rob',
        health: { ok: false, at: '2026-10-01T10:00:00Z', detail: 'timeout' },
        mocked_instances: ['sandbox']
      },
      partner_missing: false,
      submissions: [
        {
          id: 31,
          status: 'failed',
          collection: 'orders',
          item: '9',
          attempts: 2,
          error_class: 'http',
          last_error: 'HTTP 500',
          at: '2026-10-01T10:00:00Z'
        }
      ]
    })
    render(wrap(<DownPanel {...props('down', 'ext:3')} />))
    await screen.findByText('MDSI')
    expect(document.querySelector('[data-tm-inspect-down="ext:3"]')).toBeTruthy()
    expect(screen.getByText('https://api.mdsi.example/v1')).toBeTruthy()
    expect(screen.getByText(/on for sandbox/)).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-note="history-anchor"]')).toBeTruthy()
    expect(screen.getByText('POST /orders/:id')).toBeTruthy()
    const link = document.querySelector('[data-tm-inspect-link="submission:31"]') as HTMLElement
    expect(link).toBeTruthy()
    fireEvent.click(link)
    expect(getInspectSnapshot().levels.at(-1)).toMatchObject({ kind: 'submission', id: '31' })
  })

  it('says why when the node cannot be found', async () => {
    fail404.add('/traffic-map/inspect/down/zzz')
    render(wrap(<DownPanel {...props('down', 'zzz')} />))
    await waitFor(() =>
      expect(document.querySelector('[data-tm-inspect-error="404"]')).toBeTruthy()
    )
  })
})
