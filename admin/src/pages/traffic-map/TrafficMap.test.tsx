import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    render(<TrafficMap />)
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
    render(<TrafficMap />)
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
    render(<TrafficMap />)
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
    render(<TrafficMap />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/boom/))
    mockApi()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    await waitFor(() => expect(screen.getByTestId('tm-strip-rps').textContent).toBe('2.0'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
