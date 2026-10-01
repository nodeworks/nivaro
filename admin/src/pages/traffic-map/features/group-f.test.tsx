import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'

vi.mock('@/lib/socket', () => ({
  joinWatchRoom: vi.fn(() => vi.fn()),
  adminRealtime: {
    on: vi.fn(() => () => {}),
    emit: vi.fn(),
    subscribeCollections: vi.fn(() => vi.fn())
  },
  getSocket: vi.fn(() => ({ connected: true, on: vi.fn(), off: vi.fn() }))
}))
vi.mock('../MapCanvas', () => ({ MapCanvas: () => <div data-testid='map-canvas' /> }))

import { joinWatchRoom } from '@/lib/socket'
import TrafficMap from '../TrafficMap'
import { instanceSentences } from './compare'
import { filtersFromJson, filtersToJson } from './snapshots'

const T0 = 1_800_000_000
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const snapshot = {
  instance: 'staging',
  node: 'node-a',
  node_scope: 'this API process only',
  at: new Date(T0 * 1000).toISOString(),
  window_s: 300,
  uptime_s: 1,
  frame: 1,
  lanes: [],
  entities: [
    {
      key: 'items/forecasts',
      lane: 'items',
      entity: 'forecasts',
      label: 'forecasts',
      system: false,
      req: 600,
      read: 590,
      create: 0,
      update: 10,
      delete: 0,
      error: 0,
      p50: 40,
      p95: 90,
      series: Array.from({ length: 60 }, () => 10),
      routes: [],
      callers: [{ key: 'k7', n: 600 }],
      down: {},
      recent_errors: [],
      recent_writes: []
    }
  ],
  callers: [{ key: 'k7', req: 600, error: 0 }],
  down: [],
  totals: {
    req: 600,
    read: 590,
    create: 0,
    update: 10,
    delete: 0,
    error: 0,
    p50: 40,
    p95: 90,
    outbound_req: 0,
    outbound_error: 0
  },
  sockets: { count: 1, users: 1 },
  journal_seq: 3
}
const catalog = {
  collections: { forecasts: { label: 'Forecasts', system: false } },
  widgets: {},
  pages: {},
  queries: {},
  inbound: {},
  extensions: {},
  partners: {},
  callers: { k7: { label: 'Fusion IIP', kind: 'key' } },
  down: {}
}

const getMock = api.get as unknown as ReturnType<typeof vi.fn>
const postMock = api.post as unknown as ReturnType<typeof vi.fn>
const patchMock = api.patch as unknown as ReturnType<typeof vi.fn>

function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <TrafficMap />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  getMock.mockReset()
  postMock.mockReset()
  patchMock.mockReset()
  vi.mocked(joinWatchRoom).mockClear()
  getMock.mockImplementation(async (url: string) => {
    if (url.startsWith(`/traffic-map/snapshots/${ID}`))
      return {
        data: {
          data: {
            id: ID,
            name: 'Forecast spike',
            note: 'After the 10:00 import',
            window_s: 300,
            scope: 'node',
            node: 'node-a',
            created_at: new Date(T0 * 1000).toISOString(),
            created_by_name: 'Robert Lee',
            filters: { win: 300, types: ['items'], kinds: ['read', 'update'], caller: '' },
            selection: { kind: 'entity', id: 'items/forecasts' },
            catalog,
            snapshot
          }
        }
      }
    if (url.includes('/traffic-map/snapshots')) return { data: { data: [] } }
    if (url.includes('/traffic-map/snapshot')) return { data: { data: snapshot } }
    if (url.includes('/traffic-map/catalog')) return { data: { data: catalog } }
    if (url.includes('/traffic-map/compare/windows'))
      return {
        data: {
          data: {
            a: {
              from: new Date(0).toISOString(),
              to: new Date(3600_000).toISOString(),
              rows: 10,
              truncated: false,
              totals: { req: 60, read: 60, write: 0, error: 0, p95: 30 },
              callers: []
            },
            b: {
              from: new Date(0).toISOString(),
              to: new Date(3600_000).toISOString(),
              rows: 20,
              truncated: false,
              totals: { req: 120, read: 120, write: 0, error: 1, p95: 40 },
              callers: []
            },
            rows: [
              {
                key: 'items/forecasts',
                lane: 'items',
                entity: 'forecasts',
                a: { req: 60, error: 0, p95: 30 },
                b: { req: 120, error: 1, p95: 40 },
                a_rpm: 1,
                b_rpm: 2,
                delta_rpm: 1,
                delta_pct: 100,
                only: null
              }
            ]
          }
        }
      }
    return { data: { data: [] } }
  })
})

describe('frozen snapshot view (#1097)', () => {
  it('opens read-only: banner, stored labels and selection, no live room, no Share', async () => {
    renderAt(`/traffic-map?snapshot=${ID}`)
    await waitFor(() => expect(screen.getByText('Snapshot: Forecast spike')).toBeTruthy())
    expect(screen.getByText('After the 10:00 import')).toBeTruthy()
    expect(joinWatchRoom).not.toHaveBeenCalled()
    expect(document.getElementById('tm-share')).toBeNull()
    expect((document.getElementById('tm-pause') as HTMLButtonElement).hidden).toBe(true)
    expect(document.getElementById('tm-compare')).toBeNull()
    expect(getMock.mock.calls.some(([u]) => String(u).includes('/traffic-map/catalog'))).toBe(false)
    expect(screen.getByTestId('tm-inspector-name').textContent).toBe('forecasts')
    expect(document.getElementById('tm-win-300')?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('live page extras', () => {
  it('Share freezes the view and shows the link', async () => {
    postMock.mockResolvedValue({
      data: { data: { id: ID, name: 'Traffic now', url: `/traffic-map?snapshot=${ID}` } }
    })
    renderAt('/traffic-map')
    await waitFor(() => expect(document.getElementById('tm-share')).toBeTruthy())
    expect(joinWatchRoom).toHaveBeenCalledWith('traffic-map')
    fireEvent.click(document.getElementById('tm-share') as HTMLElement)
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Spike' } })
    fireEvent.click(document.querySelector('[data-tm-share-create]') as HTMLElement)
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    const [url, body] = postMock.mock.calls[0]
    expect(url).toBe('/traffic-map/snapshots')
    expect(body).toMatchObject({ window: 60, name: 'Spike', scope: 'node' })
    expect(body.filters.types.length).toBeGreaterThan(0)
    await waitFor(() => expect(document.querySelector(`[data-tm-share-made="${ID}"]`)).toBeTruthy())
  })
  it('Compare two windows reads the log and lines entities up', async () => {
    renderAt('/traffic-map')
    await waitFor(() => expect(document.getElementById('tm-cmp-run')).toBeTruthy())
    fireEvent.click(document.getElementById('tm-cmp-run') as HTMLElement)
    await waitFor(() =>
      expect(document.querySelector('[data-tm-compare-row="items/forecasts"]')).toBeTruthy()
    )
    expect(
      getMock.mock.calls.some(([u]) => String(u).startsWith('/traffic-map/compare/windows?a_from='))
    ).toBe(true)
    expect(screen.getByText(/\+1\.0 \(\+100%\)/)).toBeTruthy()
  })
  it('the daily summary toggle saves the preference', async () => {
    patchMock.mockResolvedValue({ data: {} })
    renderAt('/traffic-map')
    await waitFor(() => expect(document.getElementById('tm-digest')).toBeTruthy())
    fireEvent.click(document.getElementById('tm-digest') as HTMLElement)
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/users/me/preferences', { traffic_digest: true })
    )
  })
})

describe('helpers', () => {
  it('instanceSentences names what only one side handles', () => {
    const rows = [
      {
        key: 'items/a',
        label: 'Invoices',
        here: { req: 4, error: 0, p95: 0 },
        there: { req: 0, error: 0, p95: 0 },
        only: 'here' as const
      },
      {
        key: 'items/b',
        label: 'Units',
        here: { req: 0, error: 0, p95: 0 },
        there: { req: 2, error: 0, p95: 0 },
        only: 'there' as const
      }
    ]
    expect(instanceSentences(rows, 'staging', 'production')).toEqual([
      'staging handles Invoices that production does not.',
      'production handles Units that staging does not.'
    ])
  })
  it('filters round-trip through JSON', () => {
    const f = {
      win: 300 as const,
      types: new Set(['items' as const]),
      kinds: new Set(['read' as const]),
      caller: 'k7'
    }
    const back = filtersFromJson(
      { win: 60, types: new Set(), kinds: new Set(), caller: '' },
      filtersToJson(f) as never
    )
    expect(back.win).toBe(300)
    expect([...back.types]).toEqual(['items'])
    expect(back.caller).toBe('k7')
  })
})
