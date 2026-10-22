// #2841 Simulate down: picking a dependency, the inspector panel's states and the canvas layer.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, type vi } from 'vitest'
import { api } from '@/lib/api'
import { TrafficMapContext, type TrafficMapContextValue } from '../../context'
import type { InspectorData } from '../../Inspector'
import { defaultFilters, TrafficModel } from '../../model'
import { InspectorPanels } from '../../registry/inspectorPanels'
import { ToolbarItems } from '../../registry/toolbarItems'
import type { Selection } from '../../types'
import { shadedRects, simulation, startSimulation, stopSimulation } from './index'
import { overlayFrom, type SimResult } from './overlay'

const getMock = api.get as unknown as ReturnType<typeof vi.fn>
const d = { name: 'Redis', routes: [], callers: [] } as unknown as InspectorData

const answer: SimResult = {
  node: 'redis',
  label: 'Redis',
  kind: 'cache',
  window: '24h',
  window_h: 24,
  from: '2026-10-20T12:00:00Z',
  to: '2026-10-21T12:00:00Z',
  routes: [
    {
      route: 'GET /api/items/orders/:id',
      entity: 'items/orders',
      calls: 3500,
      per_min: 2.43,
      errors: 0,
      strength: 'direct',
      why: 'signed in by browser session',
      share: 0.875
    }
  ],
  entities: [{ key: 'items/orders', strength: 'direct', calls: 3500 }],
  screens: [{ screen: 'admin /collections/:c', calls: 50, entities: ['items/orders'] }],
  jobs: [
    {
      id: 'digest',
      strength: 'direct',
      why: 'stops firing on the clock',
      runs: 24,
      failed: 0,
      calls: 0
    }
  ],
  callers: [],
  downstream: [],
  claims: {
    fails: [
      {
        effect: 'fails',
        area: 'session',
        text: 'Browser sign-in sessions are stored in Redis.',
        source: 'api/src/auth/session.ts'
      }
    ],
    degrades: [
      {
        effect: 'degrades',
        area: 'feature',
        text: 'Rate limits fail open.',
        source: 'api/src/plugins/rate-limit.ts'
      }
    ],
    keeps: []
  },
  totals: {
    routes: 1,
    calls: 3500,
    per_min: 2.43,
    share_of_calls: 0.35,
    screens: 1,
    jobs: 1,
    channels: 0,
    entities: 1
  },
  sources: ['request log', 'job runs'],
  notes: [],
  truncated: false,
  computed_at: '2026-10-21T12:00:00Z'
}

function Harness({ sel, children }: { sel: Selection; children?: ReactNode }) {
  const value: TrafficMapContextValue = {
    model: new TrafficModel(),
    filters: defaultFilters(),
    setFilters: () => {},
    selection: sel,
    setSelection: () => {},
    catalog: null,
    tick: 0,
    win: 60,
    paused: false,
    ready: true
  }
  return <TrafficMapContext.Provider value={value}>{children}</TrafficMapContext.Provider>
}

function renderMap(sel: Selection) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Harness sel={sel}>
          <ToolbarItems slot='actions' />
          <InspectorPanels sel={sel} d={d} mode='live' />
        </Harness>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  getMock.mockReset()
  getMock.mockResolvedValue({ data: { data: answer } })
})
afterEach(() => act(() => stopSimulation()))

describe('Simulate down UI', () => {
  it('reads the simulated node once and lists what breaks', async () => {
    renderMap({ kind: 'down', id: 'redis' })
    act(() => startSimulation('redis'))
    await waitFor(() => expect(document.getElementById('tm-simulate-panel')).not.toBeNull())
    await screen.findByText('GET /api/items/orders/:id')
    expect(getMock).toHaveBeenCalledWith('/traffic-map/blast-radius', {
      params: { node: 'redis', window: '24h' }
    })
    expect(screen.getByText('Browser sign-in sessions are stored in Redis.')).toBeTruthy()
    expect(screen.getByText('Rate limits fail open.')).toBeTruthy()
    expect(screen.getByText('digest')).toBeTruthy()
    expect(screen.getByText('35%')).toBeTruthy()
    expect(document.getElementById('tm-simulating')?.textContent).toContain('Simulating Redis down')
  })

  it('a new window re-reads; Stop ends the simulation', async () => {
    renderMap({ kind: 'down', id: 'redis' })
    act(() => startSimulation('redis'))
    await screen.findByText('GET /api/items/orders/:id')
    fireEvent.click(
      document.querySelector('#tm-simulate-panel-window [data-tm-seg="7d"]') as HTMLElement
    )
    await waitFor(() =>
      expect(getMock).toHaveBeenLastCalledWith('/traffic-map/blast-radius', {
        params: { node: 'redis', window: '7d' }
      })
    )
    fireEvent.click(document.getElementById('tm-simulate-stop') as HTMLElement)
    expect(simulation.get()).toBeNull()
    await waitFor(() => expect(document.getElementById('tm-simulate-panel')).toBeNull())
    expect(document.getElementById('tm-simulate')).not.toBeNull()
  })

  it('shows the server refusal with a retry', async () => {
    getMock.mockRejectedValue({ response: { data: { error: 'window must be one of 1h' } } })
    renderMap({ kind: 'down', id: 'db' })
    act(() => startSimulation('db'))
    await screen.findByText(/window must be one of 1h/)
    expect(screen.getByText('Try again')).toBeTruthy()
  })

  it('stays out of the inspector for another node', () => {
    renderMap({ kind: 'down', id: 'db' })
    act(() => startSimulation('redis'))
    expect(document.getElementById('tm-simulate-panel')).toBeNull()
  })
})

describe('canvas rects', () => {
  it('maps the overlay onto drawn nodes (grouped callers once)', () => {
    const ov = overlayFrom('redis', answer, null)
    ov.callers.set('k1', 'indirect')
    ov.callers.set('k2', 'indirect')
    const r = { x: 0, y: 0, w: 10, h: 10 }
    const rects = shadedRects(
      ov,
      {
        ents: { 'items/orders': r },
        lanes: { items: r },
        callers: { 'group:acme': r },
        downs: { redis: r }
      },
      new Map([
        ['k1', 'group:acme'],
        ['k2', 'group:acme']
      ])
    )
    expect(rects.map((x) => `${x.kind}:${x.s}`)).toEqual([
      'ent:direct',
      'lane:direct',
      'caller:indirect',
      'down:target'
    ])
  })
})
