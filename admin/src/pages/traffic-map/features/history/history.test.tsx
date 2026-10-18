// tm-history UI: the History panel (time-lapse #2183 + people line #2249, search #2175), the
// route-duration histogram (#2193) and the what-if popover (#2151).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { TrafficMapContext, type TrafficMapContextValue } from '../../context'
import { HistoryPanel } from './HistoryPanel'
import { Histogram } from './RouteLatency'
import { historyStore, momentHref, nodeKeyLabel } from './shared'
import { WhatIfButton } from './WhatIf'

const NOW = Date.now()
const STEP = 300
const FROM = Math.ceil(NOW / (STEP * 1000)) * STEP * 1000 - 86_400_000
const timelapse = {
  range: '24h',
  source: 'log',
  from: FROM,
  to: FROM + 86_400_000,
  step_s: STEP,
  nodes: [
    { key: 'e:items/workflows', n: 50, e: 2 },
    { key: 'c:k7', n: 50, e: 2 }
  ],
  frames: Array.from({ length: 288 }, (_, i) => ({
    t: FROM + i * STEP * 1000,
    req: i === 287 ? 50 : 0,
    err: i === 287 ? 2 : 0,
    nodes:
      i === 287
        ? ([
            [0, 50, 2, 120],
            [1, 50, 2, 120]
          ] as Array<[number, number, number, number]>)
        : []
  })),
  people: { online: new Array(288).fill(3), active: new Array(288).fill(1), sampled: true },
  markers: [
    { kind: 'deploy', at: FROM + 287 * STEP * 1000, label: 'Deployed 0.2.52 (was 0.2.51)' }
  ],
  minutes: { enabled: false, first: null }
}

function wrap(ui: ReactNode, setSelection = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ctx = {
    model: { downLabels: new Map() },
    filters: {},
    setFilters: vi.fn(),
    selection: null,
    setSelection,
    catalog: {
      collections: { workflows: { label: 'Workflows', system: false } },
      widgets: {},
      pages: {},
      queries: {},
      inbound: {},
      extensions: {},
      partners: {},
      callers: { k7: { label: 'ERP key', kind: 'key' } },
      down: {}
    },
    tick: 0,
    win: 60,
    paused: false,
    ready: true
  } as unknown as TrafficMapContextValue
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <TrafficMapContext.Provider value={ctx}>{ui}</TrafficMapContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  historyStore.set({ tab: null, range: '24h', at: null })
})

describe('History panel', () => {
  it('loads nothing until a tab is picked, then plays back the day with people and markers', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/history/settings'))
        return {
          data: {
            data: {
              settings: { enabled: false, retention_days: 30, edges: true },
              coverage: { table: true, first: null, last: null },
              cloud: false
            }
          }
        } as never
      if (url.endsWith('/history/timelapse')) return { data: { data: timelapse } } as never
      throw new Error(`unexpected ${url}`)
    })
    const setSelection = vi.fn()
    const { container } = wrap(<HistoryPanel />, setSelection)
    expect(screen.getByText(/Pick a view to load it/)).toBeTruthy()
    await waitFor(() =>
      expect(container.querySelector('[data-tm-minute-history="off"]')).toBeTruthy()
    )
    expect(get.mock.calls.some(([u]) => String(u).endsWith('/timelapse'))).toBe(false)
    fireEvent.click(screen.getByRole('tab', { name: 'Time-lapse' }))
    await waitFor(() => expect(container.querySelector('[data-tm-history-curve]')).toBeTruthy())
    expect(
      container.querySelector('[data-tm-history-marker="deploy"]')?.getAttribute('data-tip')
    ).toMatch(/Deployed 0\.2\.52/)
    expect(screen.getByText('People online')).toBeTruthy()
    expect(screen.getByText(/3 online · 1 people making requests/)).toBeTruthy()
    const row = container.querySelector(
      '[data-tm-timelapse-node="e:items/workflows"]'
    ) as HTMLElement
    expect(row.textContent).toMatch(/Workflows/)
    fireEvent.click(row)
    expect(setSelection).toHaveBeenCalledWith({ kind: 'entity', id: 'items/workflows' })
    // Scrubbing pauses on a moment and stores it (the `tl` view param).
    fireEvent.change(container.querySelector('[data-tm-history-scrub]') as HTMLInputElement, {
      target: { value: '10' }
    })
    expect(historyStore.get().at).toBe(FROM + 10 * STEP * 1000)
  })

  it('searches with the structured fields and links the answer to its moment', async () => {
    vi.spyOn(api, 'get').mockImplementation(
      async (url: string, cfg?: { params?: Record<string, string> }) => {
        if (url.endsWith('/history/settings')) return { data: { data: null } } as never
        if (url.endsWith('/history/search')) {
          expect(cfg?.params).toEqual({ kind: 'last_hit', days: '7', caller: 'k7' })
          return {
            data: {
              data: {
                kind: 'last_hit',
                count: 4,
                more: [],
                hit: {
                  at: FROM,
                  route: 'GET /api/items/workflows/:id',
                  status: 200,
                  latency_ms: 40,
                  caller: 'k7'
                }
              }
            }
          } as never
        }
        throw new Error(`unexpected ${url}`)
      }
    )
    const { container } = wrap(<HistoryPanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Search' }))
    fireEvent.change(screen.getByLabelText('Caller'), { target: { value: 'k7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(container.querySelector('[data-tm-search-hit]')).toBeTruthy())
    expect(screen.getByText(/by ERP key/)).toBeTruthy()
    fireEvent.click(screen.getByText('Open this moment'))
    expect(historyStore.get()).toMatchObject({ tab: 'timelapse', range: '24h', at: FROM })
  })
})

describe('history helpers', () => {
  it('labels node keys and links moments', () => {
    const cat = {
      collections: {},
      callers: {},
      widgets: {},
      pages: {},
      queries: {},
      inbound: {},
      extensions: {},
      partners: { '3': 'Fusion' },
      down: {}
    } as never
    expect(nodeKeyLabel('c:anon', cat).label).toBe('Unauthenticated')
    expect(nodeKeyLabel('e:other/__overflow__', cat).label).toBe('everything else')
    expect(nodeKeyLabel('d:ext:3', cat, { downLabels: new Map() } as never)).toEqual({
      label: 'Fusion',
      kind: 'down',
      id: 'ext:3'
    })
    expect(momentHref(Date.now() - 60_000)).toMatch(/^\/traffic-map\?at=\d+$/)
    expect(momentHref(Date.now() - 3600_000)).toMatch(/^\/traffic-map\?tl=\d+$/)
  })
  it('names two groups of durations', () => {
    render(
      <Histogram
        d={{
          total: 100,
          bins: [
            { lo: 10, hi: 17.8, n: 60 },
            { lo: 17.8, hi: 31.6, n: 0 },
            { lo: 1000, hi: 1778, n: 40 }
          ],
          p50: 15,
          p95: 1500,
          p99: 1700,
          max: 1700,
          modes: [
            { lo: 0, hi: 31.6, n: 60, share: 0.6, median: 15 },
            { lo: 1000, hi: 1778, n: 40, share: 0.4, median: 1400 }
          ],
          bimodal: true,
          hours: 24,
          truncated: false
        }}
      />
    )
    expect(screen.getByText(/Two groups: 60% around 15 ms, 40% around 1\.4 s/)).toBeTruthy()
  })
})

describe('What if', () => {
  it('projects a scenario from the headroom tile', async () => {
    const fig = (rps: number, pct: number) => ({
      rps_per_replica: rps,
      headroom_pct: pct,
      pool_used: 2,
      pool_pct: 20,
      loop_p99_ms: 12,
      saturated: false
    })
    const get = vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/history/jobs'))
        return { data: { data: { curve: [], peak_level: 0, jobs: [], source: 'x' } } } as never
      if (url.endsWith('/capacity/what-if'))
        return {
          data: {
            data: {
              now: fig(10, 20),
              projected: fig(15, 30),
              replicas: { now: 1, projected: 1 },
              notes: []
            }
          }
        } as never
      throw new Error(`unexpected ${url}`)
    })
    const { baseElement } = wrap(<WhatIfButton />)
    fireEvent.click(screen.getByRole('button', { name: 'What if…' }))
    await waitFor(() => expect(baseElement.querySelector('[data-tm-what-if-table]')).toBeTruthy())
    expect(baseElement.querySelector('[data-tm-what-if-table]')?.textContent).toMatch(/30%/)
    fireEvent.click(baseElement.querySelector('#tm-what-if-replicas-1') as HTMLElement)
    await waitFor(() =>
      expect(
        get.mock.calls.some(
          ([u, c]) =>
            String(u).endsWith('/what-if') &&
            (c as { params?: { add_replicas?: number } })?.params?.add_replicas === 1
        )
      ).toBe(true)
    )
  })
})
