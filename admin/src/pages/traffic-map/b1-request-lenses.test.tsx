import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.startsWith('/traffic-map/lens/auth-rejections'))
        return {
          data: {
            data: {
              callers: [
                {
                  key: 'k7',
                  n: 5,
                  codes: [{ status: 403, code: 'API_KEY_SCOPE_MISSING', n: 5 }],
                  series: [0, 5]
                }
              ]
            }
          }
        }
      if (url.startsWith('/traffic-map/caller-auth'))
        return {
          data: {
            data: {
              caller: 'k7',
              key: {
                id: 7,
                name: 'Partner',
                is_active: true,
                sandbox: false,
                expires_at: null,
                rate_limit_per_minute: 120,
                scopes: [{ collection: 'workflows', actions: ['read'] }],
                ip_allowlist: []
              },
              refusals_24h: []
            }
          }
        }
      return { data: { data: null } }
    })
  }
}))

import { TrafficMapContext, type TrafficMapContextValue } from './context'
import { machineLanes } from './features/auth-mix'
import { fmtBytes, liveEntityExt, recentCount } from './features/b1-shared'
import { cacheFigures } from './features/cache-ratio'
import { reasonText } from './features/rehearsal'
import { sizeOf } from './features/response-bytes'
import './features/b1-request-lenses'
import { describeSelection } from './Inspector'
import { defaultFilters, ENTITY_CALLERS_TAP, TrafficModel } from './model'
import { badgeFor } from './registry/canvasLayers'
import { InspectorPanels } from './registry/inspectorPanels'
import { PagePanels } from './registry/pagePanels'
import type { SnapshotEntity, TrafficFrame, TrafficSnapshot } from './types'

const T0 = 1_800_000_000
const entity = (over: Partial<SnapshotEntity>): SnapshotEntity => ({
  key: 'items/workflows',
  lane: 'items',
  entity: 'workflows',
  label: 'workflows',
  system: false,
  req: 60,
  read: 50,
  create: 0,
  update: 0,
  delete: 0,
  error: 10,
  p50: 100,
  p95: 400,
  series: Array.from({ length: 60 }, () => 1),
  routes: [],
  callers: [{ key: 'uA', n: 60 }],
  down: { db: 60 },
  recent_errors: [
    {
      at: new Date(T0 * 1000).toISOString(),
      status: 500,
      code: 'X',
      route: 'GET /x',
      caller: 'k7',
      record: null
    },
    {
      at: new Date(T0 * 1000).toISOString(),
      status: 500,
      code: 'Y',
      route: 'GET /y',
      caller: 'uA',
      record: null
    }
  ],
  recent_writes: [],
  ...over
})
const snap = (entities: SnapshotEntity[], ext?: Record<string, unknown>): TrafficSnapshot => ({
  instance: 'n',
  node_scope: 's',
  at: new Date(T0 * 1000).toISOString(),
  window_s: 60,
  uptime_s: 1,
  frame: 1,
  lanes: [],
  entities,
  callers: [
    { key: 'uA', req: 40, error: 0 },
    { key: 'k7', req: 30, error: 10 }
  ],
  down: [],
  totals: {
    req: 0,
    read: 0,
    create: 0,
    update: 0,
    delete: 0,
    error: 0,
    p50: 0,
    p95: 0,
    outbound_req: 0,
    outbound_error: 0
  },
  sockets: { count: 0, users: 0 },
  journal_seq: null,
  ...(ext ? { ext } : {})
})
const frame = (sec: number, ext: Record<string, unknown>, no = 2): TrafficFrame => ({
  v: 1,
  at: new Date(sec * 1000).toISOString(),
  instance: 'n',
  node_scope: 's',
  frame: no,
  window_s: 1,
  entities: {},
  callers: {},
  down: {},
  edges_in: {},
  edges_out: {},
  events: [],
  sockets: 0,
  journal_seq: null,
  ext
})

function seeded(): TrafficModel {
  const m = new TrafficModel()
  m.applySnapshot(
    snap([
      entity({
        ext: {
          [ENTITY_CALLERS_TAP]: { uA: [40, 40, 0, 0, 0, 0, 90], k7: [20, 10, 0, 0, 0, 10, 700] }
        }
      }),
      entity({
        key: 'items/regions',
        entity: 'regions',
        label: 'regions',
        req: 30,
        read: 30,
        error: 0,
        // the snapshot's top-callers list leaves k7 out; the exact counts know better
        callers: [{ key: 'uA', n: 20 }],
        ext: {
          [ENTITY_CALLERS_TAP]: { uA: [20, 20, 0, 0, 0, 0, 50], k7: [10, 10, 0, 0, 0, 0, 60] }
        }
      })
    ])
  )
  return m
}

describe('#1095/#1102 exact entity × caller', () => {
  it('the hot table caller filter uses the exact counts', () => {
    const m = seeded()
    expect(m.exactCallers).toBe(true)
    const f = { ...defaultFilters(), caller: 'k7' }
    const hot = m.hot(60, f, 10)
    expect(hot.map((r) => r.key).sort()).toEqual(['items/regions', 'items/workflows'])
    const wf = hot.find((r) => r.key === 'items/workflows')
    expect(Math.round((wf?.rps ?? 0) * 60)).toBe(20)
    expect(wf?.errPct).toBe(50)
    expect(wf?.p95).toBe(700)
    const t = m.totals(60, f)
    expect(Math.round(t.req)).toBe(30)
    expect(Math.round(t.error)).toBe(10)
  })

  it('a frame sets the caller second exactly', () => {
    const m = seeded()
    m.applyFrame(
      frame(T0 + 1, {
        [ENTITY_CALLERS_TAP]: { 'items/workflows': { k7: [5, 0, 0, 0, 0, 5, 900] } }
      })
    )
    expect(m.entityCallerSum('items/workflows', 'k7', 1)).toEqual([5, 0, 0, 0, 0, 5])
    expect(m.entityCallerP95('items/workflows', 'k7')).toBe(900)
    expect(m.entityCallerKeys('items/workflows', 60)[0].key).toBe('uA')
  })

  it('the inspector narrows figures and events to the picked caller', () => {
    const m = seeded()
    const d = describeSelection(
      m,
      { kind: 'entity', id: 'items/workflows', caller: 'k7' },
      defaultFilters(),
      null
    )
    expect(Math.round(d.rps * 60)).toBe(20)
    expect(d.errPct).toBe(50)
    expect(d.p95).toBe(700)
    expect(d.errors.map((e) => e.code)).toEqual(['X'])
    expect(d.focusCaller).toBe('k7')
    const all = describeSelection(
      m,
      { kind: 'entity', id: 'items/workflows' },
      defaultFilters(),
      null
    )
    expect(all.focusCaller).toBeUndefined()
    expect(all.errors).toHaveLength(2)
  })

  it('without exact data the caller filter stays the old approximation', () => {
    const m = new TrafficModel()
    m.applySnapshot(snap([entity({})]))
    expect(m.exactCallers).toBe(false)
    expect(m.hot(60, { ...defaultFilters(), caller: 'uA' }, 10)).toHaveLength(1)
  })
})

describe('b1 helpers', () => {
  it('liveEntityExt prefers a fresh frame value, recentCount sums frame seconds', () => {
    const m = seeded()
    m.applyFrame(
      frame(
        T0 + 1,
        {
          'response-bytes': { 'items/workflows': [100, 900] },
          duplicates: { 'items/workflows': 2 }
        },
        3
      )
    )
    expect(liveEntityExt(m, 'response-bytes', 'items/workflows')).toEqual([100, 900])
    m.applyFrame(frame(T0 + 2, { duplicates: { 'items/workflows': 1 } }, 4))
    expect(recentCount(m, 'duplicates', 'items/workflows')).toBe(3)
    expect(badgeFor('items/workflows', m)).toEqual({ text: '3× dup', tone: 'warn' })
  })
  it('formatters and parsers', () => {
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1536)).toBe('1.5 KB')
    expect(fmtBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(sizeOf([10, 20])).toEqual({ p50: 10, p95: 20 })
    expect(cacheFigures([3, 1])?.ratio).toBe(0.75)
    expect(reasonText({ dry_run: 2, flow_test: 5 })).toBe('5 flow test · 2 dry run')
    expect(machineLanes({ inbound: [0, 30, 10, 0, 0, 0], items: [90, 5, 0, 0, 0, 5] })).toEqual([
      { lane: 'inbound', share: 1, n: 40 }
    ])
  })
})

function Page({ children, m }: { children: ReactNode; m: TrafficModel }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ctx: TrafficMapContextValue = {
    model: m,
    filters: defaultFilters(),
    setFilters: () => {},
    selection: null,
    setSelection: () => {},
    catalog: null,
    tick: 1,
    win: 60,
    paused: false,
    ready: true
  }
  return (
    <QueryClientProvider client={qc}>
      <TrafficMapContext.Provider value={ctx}>{children}</TrafficMapContext.Provider>
    </QueryClientProvider>
  )
}

describe('#1099 rejected requests', () => {
  it('the page panel lists rejections by caller with their codes', async () => {
    render(
      <Page m={seeded()}>
        <PagePanels />
      </Page>
    )
    await waitFor(() => expect(screen.getByText('API_KEY_SCOPE_MISSING')).toBeTruthy())
    expect(document.querySelector('[data-tm-reject-caller="k7"]')).toBeTruthy()
  })
  it("the caller inspector shows the key's rate limit and scopes", async () => {
    const m = seeded()
    const d = describeSelection(m, { kind: 'caller', id: 'k7' }, defaultFilters(), null)
    render(
      <Page m={m}>
        <InspectorPanels sel={{ kind: 'caller', id: 'k7' }} d={d} mode='live' />
      </Page>
    )
    await waitFor(() =>
      expect(document.querySelector('[data-tm-key-rate]')?.textContent).toBe('120 per minute')
    )
    expect(document.querySelector('[data-tm-key-scopes]')?.textContent).toBe('workflows (read)')
  })
  it('renders nothing outside the page context', () => {
    const { container } = render(<PagePanels />)
    expect(container.querySelector('#tm-rejections')).toBeNull()
  })
})
