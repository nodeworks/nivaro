import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'

const handlers = new Map<string, (p: unknown) => void>()
const socketHandlers = new Map<string, () => void>()
vi.mock('@/lib/socket', () => ({
  joinWatchRoom: vi.fn(() => vi.fn()),
  adminRealtime: {
    on: vi.fn((event: string, cb: (p: unknown) => void) => {
      handlers.set(event, cb)
      return () => handlers.delete(event)
    }),
    emit: vi.fn(),
    subscribeCollections: vi.fn(() => vi.fn())
  },
  getSocket: vi.fn(() => ({
    connected: true,
    on: vi.fn((event: string, cb: () => void) => socketHandlers.set(event, cb)),
    off: vi.fn((event: string) => socketHandlers.delete(event))
  }))
}))
vi.mock('./MapCanvas', () => ({ MapCanvas: () => <div data-testid='map-canvas' /> }))

import { HotEntities } from './HotEntities'
import { SummaryStrip } from './SummaryStrip'
import TrafficMap from './TrafficMap'

const T0 = 1_800_000_000
const snapshot = {
  instance: 'test-node',
  node_scope: 'this API process only',
  at: new Date(T0 * 1000).toISOString(),
  window_s: 60,
  uptime_s: 1,
  frame: 1,
  lanes: [{ id: 'items', label: 'Items', route_hint: '/api/items/:collection' }],
  entities: [
    {
      key: 'items/workflows',
      lane: 'items',
      entity: 'workflows',
      label: 'workflows',
      system: false,
      req: 120,
      read: 100,
      create: 2,
      update: 10,
      delete: 0,
      error: 8,
      p50: 100,
      p95: 558,
      series: Array.from({ length: 60 }, () => 2),
      routes: [{ route: 'GET /api/items/workflows', n: 90 }],
      callers: [{ key: 'uA', n: 100 }],
      down: { db: 120 },
      recent_errors: [
        {
          at: new Date(T0 * 1000).toISOString(),
          status: 422,
          code: 'CHANGE_REASON_REQUIRED',
          route: 'PATCH /api/items/workflows/:id',
          caller: 'uA',
          record: '371407'
        }
      ],
      recent_writes: [
        {
          at: new Date(T0 * 1000).toISOString(),
          action: 'update',
          record: 'PW26-80323',
          fields: ['vendor'],
          caller: 'uA',
          via: 'items'
        }
      ]
    }
  ],
  callers: [{ key: 'uA', req: 100, error: 4 }],
  down: [{ id: 'db', label: 'SQL Server', kind: 'db', req: 120, error: 0, p95: 240 }],
  totals: {
    req: 120,
    read: 100,
    create: 2,
    update: 10,
    delete: 0,
    error: 8,
    p50: 100,
    p95: 558,
    outbound_req: 0,
    outbound_error: 0
  },
  sockets: { count: 3, users: 2 },
  journal_seq: 77
}
const catalog = {
  collections: { workflows: { label: 'Workflows', system: false } },
  widgets: {},
  pages: {},
  queries: {},
  inbound: {},
  extensions: {},
  partners: {},
  callers: {
    uA: { label: 'Robert Lee', kind: 'person' },
    cron: { label: 'Crons & flows', kind: 'cron' },
    anon: { label: 'Unauthenticated', kind: 'anon' }
  },
  down: { db: 'SQL Server', redis: 'Redis', store: 'File storage' }
}

/** R25: the inspector renders <Link>s and reads history through react-query. */
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TrafficMap />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

// R21: the setup file mocks `api.get`; cast so admin tsc (which includes tests) accepts the shape.
const getMock = api.get as unknown as ReturnType<typeof vi.fn>
function mockApi() {
  getMock.mockImplementation(async (url: string) => {
    if (url.includes('/traffic-map/snapshot')) return { data: { data: snapshot } }
    if (url.includes('/traffic-map/catalog')) return { data: { data: catalog } }
    return { data: { data: {} } }
  })
}
const emptyFrame = (sec: number, frame: number, sockets: number) => ({
  v: 1,
  at: new Date(sec * 1000).toISOString(),
  instance: 'test-node',
  node_scope: 'x',
  frame,
  window_s: 1,
  entities: {},
  callers: {},
  down: {},
  edges_in: {},
  edges_out: {},
  events: [],
  sockets,
  journal_seq: 78
})

describe('TrafficMap page', () => {
  beforeEach(() => {
    handlers.clear()
    socketHandlers.clear()
    getMock.mockReset()
  })

  it('seeds from the snapshot, selects the busiest entity, and applies a frame', async () => {
    mockApi()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('tm-strip-rps').textContent).toBe('2.0'))
    expect(screen.getByTestId('tm-instance').textContent).toBe('test-node')
    expect(screen.getByTestId('tm-strip-sockets').textContent).toBe('3')
    // R22: people comes from the snapshot's users, never a ratio
    expect(screen.getAllByText(/2 people/).length).toBeGreaterThan(0)
    expect(screen.getByTestId('tm-inspector-name').textContent).toBe('workflows')
    expect(screen.getAllByText('CHANGE_REASON_REQUIRED', { exact: false }).length).toBeGreaterThan(
      0
    )
    expect(screen.getAllByTestId('tm-hot-row')).toHaveLength(1)
    const onFrame = handlers.get('traffic-map:frame')
    expect(onFrame).toBeTypeOf('function')
    act(() => {
      onFrame?.({
        ...emptyFrame(T0 + 1, 2, 4),
        entities: { 'items/workflows': [3, 2, 0, 1, 0, 0, 510] },
        callers: { uA: [3, 0] },
        down: { db: [3, 0, 200] },
        edges_in: { 'uA>items': 3 },
        edges_out: { 'items>db': 3 },
        events: [
          {
            t: (T0 + 1) * 1000,
            lane: 'items',
            entity: 'workflows',
            kind: 'update',
            caller: 'uA',
            route: 'items write',
            record: '371407',
            fields: ['vendor', 'objective']
          }
        ]
      })
    })
    await waitFor(() => expect(screen.getByTestId('tm-strip-sockets').textContent).toBe('4'))
    expect(screen.getAllByText(/371407/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/vendor, objective/).length).toBeGreaterThan(0)
    expect(document.querySelector('[data-tm-event="update"]')).not.toBeNull()
  })

  it('the kind chips filter the ticker and the pause button stops applying frames', async () => {
    mockApi()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('tm-strip-rps').textContent).toBe('2.0'))
    act(() => {
      handlers.get('traffic-map:frame')?.({
        ...emptyFrame(T0 + 1, 2, 3),
        events: [
          {
            t: (T0 + 1) * 1000,
            lane: 'items',
            entity: 'workflows',
            kind: 'update',
            caller: 'uA',
            route: 'items write',
            record: 'PW26-1',
            fields: ['vendor']
          }
        ]
      })
    })
    await waitFor(() => expect(document.querySelector('[data-tm-event="update"]')).not.toBeNull())
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'update' }))
    })
    expect(document.querySelector('[data-tm-event="update"]')).toBeNull()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^pause$/i }))
    })
    act(() => {
      handlers.get('traffic-map:frame')?.(emptyFrame(T0 + 2, 3, 9))
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByTestId('tm-strip-sockets').textContent).toBe('3')
    expect(screen.getByRole('button', { name: /^resume$/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('refetches the snapshot when the socket re-authenticates (R23)', async () => {
    mockApi()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('tm-strip-rps').textContent).toBe('2.0'))
    const snapshotCalls = () =>
      getMock.mock.calls.filter((c) => String(c[0]).includes('/snapshot')).length
    expect(snapshotCalls()).toBe(1)
    act(() => {
      socketHandlers.get('auth:ok')?.()
    })
    await waitFor(() => expect(snapshotCalls()).toBe(2))
  })

  it('shows an inline error with Retry when the snapshot fails', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (url.includes('/snapshot')) throw new Error('boom')
      return { data: { data: catalog } }
    })
    renderPage()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/boom/))
    mockApi()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    await waitFor(() => expect(screen.getByTestId('tm-strip-rps').textContent).toBe('2.0'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders counts and rates as whole or fixed numbers, never raw floats (D8)', async () => {
    const odd = {
      ...snapshot,
      entities: [
        {
          ...snapshot.entities[0],
          req: 7,
          read: 3,
          create: 1,
          update: 2,
          delete: 1,
          error: 1,
          series: Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 3 : i % 3))
        },
        {
          ...snapshot.entities[0],
          key: 'items/regions',
          entity: 'regions',
          label: 'regions',
          req: 13,
          read: 9,
          create: 1,
          update: 1,
          delete: 1,
          error: 1,
          series: Array.from({ length: 60 }, (_, i) => (i % 5) / 3)
        }
      ],
      totals: { ...snapshot.totals, req: 20, read: 12, create: 2, update: 3, delete: 2, error: 2 }
    }
    getMock.mockImplementation(async (url: string) => ({
      data: { data: url.includes('catalog') ? catalog : odd }
    }))
    renderPage()
    await waitFor(() => expect(screen.getAllByTestId('tm-hot-row')).toHaveLength(2))
    act(() => {
      handlers.get('traffic-map:frame')?.({
        ...emptyFrame(T0 + 1, 2, 3),
        entities: { 'items/regions': [1, 0, 1, 0, 0, 0, 300] }
      })
    })
    expect(screen.getByTestId('tm-strip-rps').textContent).toMatch(/^\d+\.\d$/)
    expect(screen.getByText(/ created · /).textContent).toMatch(
      /^\d+ created · \d+ updated · \d+ deleted$/
    )
    const strip = within(document.getElementById('tm-strip') as HTMLElement)
    expect(strip.getByText(/^[\d.,]+ in window/).textContent).toMatch(/^\d+ in window/)
    for (const row of screen.getAllByTestId('tm-hot-row')) {
      const cells = row.querySelectorAll('td')
      expect(cells[1].textContent).toMatch(/^\d+(\.\d)?$/)
      expect(cells[2].textContent).toMatch(/^\d+$/)
    }
    // no float artefacts like 9.999999999999998 anywhere on the page
    const texts: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) texts.push(walker.currentNode.textContent ?? '')
    expect(texts.filter((x) => /\d\.\d{3,}|NaN|Infinity/.test(x))).toEqual([])
  })

  it('announces only the selection, not every frame (no live region on the inspector)', async () => {
    mockApi()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('tm-inspector-name')).toBeInTheDocument())
    expect(document.getElementById('tm-inspector')?.getAttribute('aria-live')).toBeNull()
    expect(document.getElementById('tm-inspector-announce')?.textContent).toBe(
      'Inspecting workflows'
    )
  })

  it('drops frames while the tab is hidden and re-seeds on return (visibilitychange)', async () => {
    let hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    try {
      mockApi()
      renderPage()
      await waitFor(() => expect(screen.getByTestId('tm-strip-rps').textContent).toBe('2.0'))
      const snapshotCalls = () =>
        getMock.mock.calls.filter((c) => String(c[0]).includes('/snapshot')).length
      hidden = true
      act(() => {
        handlers.get('traffic-map:frame')?.(emptyFrame(T0 + 1, 2, 9))
      })
      expect(screen.getByTestId('tm-strip-sockets').textContent).toBe('3')
      expect(snapshotCalls()).toBe(1)
      hidden = false
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await waitFor(() => expect(snapshotCalls()).toBe(2))
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden
    }
  })

  it('the empty ticker names the selected window', async () => {
    mockApi()
    renderPage()
    await waitFor(() => expect(screen.getByText(/No traffic in the last 60 s/)).toBeInTheDocument())
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '5m' }))
    })
    await waitFor(() =>
      expect(screen.getByText(/No traffic in the last 5 min/)).toBeInTheDocument()
    )
  })

  it('fades only newly arrived events, not older rows revealed by a filter', async () => {
    mockApi()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('tm-strip-rps').textContent).toBe('2.0'))
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'read' }))
    })
    const ev = (t: number, kind: string, record?: string) => ({
      t,
      lane: 'items',
      entity: 'workflows',
      kind,
      caller: 'uA',
      route: 'GET /api/items/workflows',
      record
    })
    act(() => {
      handlers.get('traffic-map:frame')?.({
        ...emptyFrame(T0 + 1, 2, 3),
        events: [ev((T0 + 1) * 1000, 'read')]
      })
    })
    expect(document.querySelector('[data-tm-event="read"]')).toBeNull()
    act(() => {
      handlers.get('traffic-map:frame')?.({
        ...emptyFrame(T0 + 2, 3, 3),
        events: [ev((T0 + 2) * 1000, 'update', 'PW26-9')]
      })
    })
    expect(document.querySelector('[data-tm-event="update"]')?.className).toMatch(/tm-ev-fresh/)
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'read' }))
    })
    const read = document.querySelector('[data-tm-event="read"]')
    expect(read).not.toBeNull()
    expect(read?.className).not.toMatch(/tm-ev-fresh/)
  })

  it('strip and hot table round fractional inputs (seeded counts are spread as fractions)', () => {
    const f = 9.999999999999998
    render(
      <>
        <SummaryStrip
          d={{
            rps: 1.4000000000000012,
            series: [1, 2],
            p95: 557.6,
            p50: 99.4,
            req: 120.00000000000001,
            errN: f,
            lastError: null,
            writesPerMin: 12.000000000000002,
            writesMix: { create: 1.4000000000000012, update: f, delete: 0.6000000000000001 },
            outboundPerMin: 2.3333333333333335,
            outboundErr: 1.0000000000000002,
            partners: ['MDSi'],
            sockets: 3,
            users: 2.0000000000000004,
            peak: 3
          }}
        />
        <HotEntities
          rows={[
            {
              key: 'items/workflows',
              lane: 'items',
              entity: 'workflows',
              rps: 0.23333333333333334,
              wpm: 1.4000000000000012,
              p95: 558.3,
              errPct: 2.857142857142857,
              series: [1]
            }
          ]}
          catalog={null}
          selectedKey={null}
          onSelect={() => {}}
          loading={false}
        />
      </>
    )
    expect(screen.getByTestId('tm-strip-rps').textContent).toBe('1.4')
    expect(screen.getByText(/ created · /).textContent).toBe('1 created · 10 updated · 1 deleted')
    expect(screen.getByText(/^[\d.,]+ in window/).textContent).toBe('10 in window')
    expect(screen.getByText(/failed/).textContent).toBe('1 failed')
    expect(screen.getByTestId('tm-strip-writes').textContent).toBe('12')
    const cells = screen.getByTestId('tm-hot-row').querySelectorAll('td')
    expect(cells[1].textContent).toBe('0.2')
    expect(cells[2].textContent).toBe('1')
    expect(cells[3].textContent).toBe('558 ms')
    expect(cells[4].textContent).toBe('2.9%')
  })
})

const historyBody = {
  key: 'items/workflows',
  hours: 6,
  bucket_s: 300,
  series: Array.from({ length: 72 }, (_, i) => ({
    t: new Date(T0 * 1000 + i * 300_000).toISOString(),
    req: 10,
    error: i === 71 ? 2 : 0,
    p95: 400
  })),
  totals: { req: 720, read: 600, write_requests: 100, error: 20, p50: 150, p95: 610 },
  status_codes: { '200': 700, '422': 20 },
  top_routes: [{ route: 'GET /api/items/workflows', n: 500 }],
  top_callers: [{ key: 'uA', n: 700 }],
  issues: [
    {
      id: 9120,
      title: '[server] GET /api/items/workflows: KnexTimeoutError',
      severity: 'high',
      status: 'open',
      occurrence_count: 4,
      last_seen_at: new Date(T0 * 1000).toISOString()
    }
  ],
  slow_traces: [
    {
      id: 't1',
      route: '/api/items/workflows',
      total_ms: 4120,
      ts: new Date(T0 * 1000).toISOString()
    }
  ],
  truncated: true
}

describe('inspector history', () => {
  beforeEach(() => {
    handlers.clear()
    socketHandlers.clear()
    getMock.mockReset()
  })

  it('switching to 6h fetches the entity history and shows issues and slow traces', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (url.includes('/traffic-map/snapshot')) return { data: { data: snapshot } }
      if (url.includes('/traffic-map/catalog')) return { data: { data: catalog } }
      if (url.includes('/traffic-map/entity/items/workflows?hours=6'))
        return { data: { data: historyBody } }
      return { data: { data: {} } }
    })
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId('tm-inspector-name').textContent).toBe('workflows')
    )
    expect(screen.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true')
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '6h' }))
    })
    await waitFor(() => expect(screen.getByText(/KnexTimeoutError/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '6h' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('tm-inspector-req').textContent).toBe('720')
    expect(screen.getByRole('link', { name: /KnexTimeoutError/ })).toHaveAttribute(
      'href',
      '/issues/9120'
    )
    expect(screen.getByText(/4\.1 s/).closest('a')).toHaveAttribute('href', '/api-analytics')
    expect(screen.getByText('422')).toBeInTheDocument()
    expect(screen.getByText(/Requests per 5 minutes · last 6 hours/)).toBeInTheDocument()
    expect(document.getElementById('tm-history-truncated')).not.toBeNull()
    // live-only sections are replaced while a range is chosen
    expect(screen.queryByText('Recent writes')).toBeNull()
    expect(document.getElementById('tm-inspector-announce')?.textContent).toBe(
      'Inspecting workflows, last 6 hours'
    )
    // back to Live restores the ring view
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Live' }))
    })
    expect(screen.getByText('Recent writes')).toBeInTheDocument()
    expect(screen.queryByText(/KnexTimeoutError/)).toBeNull()
  })

  it('shows an inline error with Retry, and a store node shows its note instead of a chart', async () => {
    let fail = true
    getMock.mockImplementation(async (url: string) => {
      if (url.includes('/traffic-map/snapshot')) return { data: { data: snapshot } }
      if (url.includes('/traffic-map/catalog')) return { data: { data: catalog } }
      if (url.includes('/traffic-map/entity/items/workflows?hours=1')) {
        if (fail) throw new Error('boom')
        return { data: { data: { ...historyBody, hours: 1, bucket_s: 60 } } }
      }
      return { data: { data: {} } }
    })
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId('tm-inspector-name').textContent).toBe('workflows')
    )
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '1h' }))
    })
    await waitFor(() => expect(document.getElementById('tm-history-error')).not.toBeNull())
    expect(screen.getByRole('alert').textContent).toMatch(/boom/)
    fail = false
    act(() => {
      fireEvent.click(document.getElementById('tm-history-retry') as HTMLElement)
    })
    await waitFor(() => expect(screen.getByTestId('tm-inspector-req').textContent).toBe('720'))
    expect(screen.getByText(/Requests per minute · last hour/)).toBeInTheDocument()
  })
})

describe('history helpers', () => {
  it('builds entity and down urls and only offers history for entities and down nodes', async () => {
    const { historyAvailable, historyUrl } = await import('./Inspector')
    expect(historyUrl({ kind: 'entity', id: 'graphql/getWorkflow.v2' }, 24)).toBe(
      '/traffic-map/entity/graphql/getWorkflow.v2?hours=24'
    )
    expect(historyUrl({ kind: 'down', id: 'ext:12' }, 1)).toBe('/traffic-map/down/ext%3A12?hours=1')
    expect(historyAvailable({ kind: 'lane', id: 'items' })).toBe(false)
    expect(historyAvailable({ kind: 'caller', id: 'uA' })).toBe(false)
    expect(historyAvailable({ kind: 'entity', id: 'items/__other__' })).toBe(false)
    expect(historyAvailable({ kind: 'down', id: 'db' })).toBe(true)
  })
})
