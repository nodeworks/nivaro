import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { TrafficMapContext, type TrafficMapContextValue } from '../../context'
import { defaultFilters, TrafficModel } from '../../model'
import type { Selection } from '../../types'
import {
  breakdownSegments,
  collectionOfKey,
  nPlusOneBadge,
  recordHref,
  tripsFor,
  typeIsCollection
} from './logic'
import { GraphqlFieldsPanel, HotRecordsPanel, RequestCostPanel, TripsCell } from './panels'

const detail = {
  'request-cost': {
    n: 12,
    avg_trips: 48.5,
    avg_sql_ms: 60,
    sql_share: 0.6,
    n_plus_one: true,
    window_s: 60,
    threshold: 40,
    min_requests: 3,
    avg_ms: 100,
    breakdown: { auth: 5, metadata: 15, sql: 60, hooks: 10, serialization: 2, other: 8 },
    access: { avg_ms: 4, share: 0.04, checked: 12 },
    repeat: { requests: 6, share: 0.5, sql: 'select * from x where id = @p0', n: 25 },
    amplification: null
  },
  'hot-records': {
    window_s: 60,
    collection: 'workflows',
    rows: [
      {
        id: '7',
        label: 'WF-7',
        writes: 3,
        conflicts: 1,
        lock_acquires: 0,
        locked_by: 'Beth Smith',
        queue: 2
      }
    ]
  },
  'graphql-fields': {
    window_s: 60,
    unused_window_s: 900,
    fields: [{ field: 'workflows.id', n: 4, callers: [{ key: 'k1', n: 4 }] }],
    types: [{ type: 'workflows', selected: 1, total: 3, unused: ['legacy', 'notes'] }]
  }
}

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => ({ data: { data: detail } })) }
}))

function wrap(model: TrafficModel, children: ReactNode) {
  const value: TrafficMapContextValue = {
    model,
    filters: defaultFilters(),
    setFilters: () => {},
    selection: null,
    setSelection: () => {},
    catalog: null,
    tick: 0,
    win: 60,
    paused: true,
    ready: true
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <TrafficMapContext.Provider value={value}>{children}</TrafficMapContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('deep measurement logic', () => {
  it('badges N+1 from the live frame, else from the snapshot', () => {
    const m = new TrafficModel()
    m.frameExt = {
      'request-cost': { trips: { 'items/a': 52.4, 'items/b': 3 }, n1: ['items/a'], threshold: 40 }
    }
    expect(nPlusOneBadge('items/a', m)).toEqual({ text: 'N+1 · 52', tone: 'warn' })
    expect(nPlusOneBadge('items/b', m)).toBeNull()
    expect(tripsFor(m, 'items/b')).toBe(3)
    const empty = new TrafficModel()
    expect(nPlusOneBadge('items/a', empty)).toBeNull()
    expect(tripsFor(empty, 'items/a')).toBeNull()
  })

  it('splits a breakdown into shares that add to 100', () => {
    const segs = breakdownSegments({
      auth: 5,
      metadata: 15,
      sql: 60,
      hooks: 10,
      serialization: 2,
      other: 8
    })
    expect(segs.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(100)
    expect(segs.find((s) => s.id === 'sql')?.pct).toBeCloseTo(60)
    expect(
      breakdownSegments({
        auth: 0,
        metadata: 0,
        sql: 0,
        hooks: 0,
        serialization: 0,
        other: 0
      }).every((s) => s.pct === 0)
    ).toBe(true)
  })

  it('names collections and record links', () => {
    expect(collectionOfKey('items/workflows')).toBe('workflows')
    expect(collectionOfKey('graphql/op')).toBeNull()
    expect(recordHref('workflows', 'a b')).toBe('/collections/workflows/a%20b')
    expect(typeIsCollection('workflows')).toBe(true)
    expect(typeIsCollection('Query')).toBe(false)
    expect(typeIsCollection('workflows_regions_m2m')).toBe(false)
  })
})

describe('deep measurement panels', () => {
  const sel: Selection = { kind: 'entity', id: 'items/workflows' }

  it('shows round trips, the N+1 note, the stacked bar and the repeated statement', async () => {
    render(wrap(new TrafficModel(), <RequestCostPanel sel={sel} />))
    expect(await screen.findByText('49 / req')).toBeTruthy()
    expect(document.querySelector('[data-tm-n-plus-one]')).toBeTruthy()
    expect(document.querySelectorAll('[data-tm-breakdown-seg]').length).toBe(6)
    expect(document.querySelector('[data-tm-repeat] code')?.textContent).toContain('@p0')
    expect(document.querySelector('[data-tm-access]')?.textContent).toContain('4 ms')
  })

  it('lists hot records as links to the record', async () => {
    render(wrap(new TrafficModel(), <HotRecordsPanel sel={sel} />))
    const link = await screen.findByText('WF-7')
    expect(link.closest('a')?.getAttribute('href')).toBe('/collections/workflows/7')
    expect(document.querySelector('[data-tm-hot-record="7"]')?.textContent).toContain('Beth +2')
  })

  it('lists unused GraphQL fields as candidates', async () => {
    render(
      wrap(new TrafficModel(), <GraphqlFieldsPanel sel={{ kind: 'entity', id: 'graphql/op' }} />)
    )
    expect(await screen.findByText('legacy, notes')).toBeTruthy()
    expect(screen.getByText('workflows').closest('a')?.getAttribute('href')).toBe(
      '/data-model/workflows'
    )
  })

  it('the Trips cell reads softly outside the page', () => {
    render(<TripsCell k='items/x' />)
    expect(document.querySelector('[data-tm-trips]')?.textContent).toBe('—')
  })
})
