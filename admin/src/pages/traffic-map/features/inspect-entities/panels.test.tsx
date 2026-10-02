import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getInspectSnapshot, resetInspectForTests } from '../../inspect/stack'
import type { InspectPanelProps } from '../../registry/inspectables'
import { following } from '../follow-person'
import { CallerPanel } from './CallerPanel'
import { EntityPanel } from './EntityPanel'
import { PagePanel } from './PageDownPanels'

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
})
