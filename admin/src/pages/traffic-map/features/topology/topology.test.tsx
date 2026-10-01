import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => ({ data: { data: {} } })) }
}))

import { TrafficMapContext, type TrafficMapContextValue } from '../../context'
import { callerLabel } from '../../EventTicker'
import { computeLayout } from '../../layout'
import { MapCanvas } from '../../MapCanvas'
import { defaultFilters, TrafficModel } from '../../model'
import { downKindOf, downLabel, setDownLabel, setSourceLabel } from '../../nodeKinds'
import { edgeStyleFor, nodeProviders, sideBadgeFor } from '../../registry/canvasLayers'
import { InspectorPanels } from '../../registry/inspectorPanels'
import type { TrafficSnapshot } from '../../types'
import './index'
import { dominantClass } from './canvas'
import { dependencyKeyOf, setTopology, type TopologyData, topologyKey } from './store'

const T0 = 1_800_000_000
const base: TrafficSnapshot = {
  instance: 'test-node',
  node_scope: 'this API process only',
  at: new Date(T0 * 1000).toISOString(),
  window_s: 60,
  uptime_s: 10,
  frame: 5,
  lanes: [{ id: 'items', label: 'Items', route_hint: '/api/items/:collection' }],
  entities: [
    {
      key: 'items/workflows',
      lane: 'items',
      entity: 'workflows',
      label: 'workflows',
      system: false,
      req: 60,
      read: 40,
      create: 0,
      update: 20,
      delete: 0,
      error: 0,
      p50: 100,
      p95: 300,
      series: Array.from({ length: 60 }, () => 1),
      routes: [],
      callers: [
        { key: 'uA', n: 40 },
        { key: 'cron:nightly-sync', n: 20 }
      ],
      down: { db: 60, 'ext:7': 6, mail: 3 },
      recent_errors: [],
      recent_writes: []
    }
  ],
  callers: [
    { key: 'uA', req: 40, error: 0 },
    { key: 'cron:nightly-sync', req: 20, error: 0 }
  ],
  down: [
    { id: 'db', label: 'SQL Server', kind: 'db', req: 60, error: 0, p95: 20 },
    { id: 'ext:7', label: 'MDSi', kind: 'partner', req: 6, error: 4, p95: 800 },
    { id: 'mail', label: 'Email', kind: 'channel', req: 3, error: 0, p95: 40 },
    { id: 'webhook:3', label: 'Webhook · Order sync', kind: 'webhook', req: 2, error: 1, p95: 90 }
  ],
  totals: {
    req: 60,
    read: 40,
    create: 0,
    update: 20,
    delete: 0,
    error: 0,
    p50: 100,
    p95: 300,
    outbound_req: 6,
    outbound_error: 4
  },
  sockets: { count: 1, users: 1 },
  journal_seq: null,
  sources: [{ id: 'cron:nightly-sync', label: 'nightly-sync', kind: 'cron', req: 20, error: 0 }]
}
const topology: TopologyData = {
  sources: {
    sources: {
      'cron:nightly-sync': {
        label: 'nightly-sync',
        kind: 'cron',
        runs: 3,
        errors: 1,
        p95_ms: 1200,
        last: { at: T0 * 1000, ms: 900, ok: false }
      }
    },
    sd: { 'cron:push-orders>ext:7': 6 },
    triggers: {},
    import: { current: null, last: null }
  },
  partners: {
    buckets: [100, 250, 500, 1000, 2500, 5000, 10000],
    downs: { 'ext:7': { classes: { rate_limited: 3, auth: 1 }, hist: [0, 0, 1, 4, 1, 0, 0, 0] } }
  },
  pool: {
    window_s: 300,
    acquires: 90,
    wait_p50_ms: 10,
    wait_p95_ms: 200,
    wait_max_ms: 300,
    saturated_pct: 31,
    peak_used: 25,
    peak_pending: 3,
    max: 25,
    level: 'warn'
  },
  redis: {
    commands: 120,
    cps: 2,
    families: [{ family: 'sessions', n: 100 }],
    top_commands: [{ name: 'get', n: 100 }]
  },
  channels: { mail: { sent: 2, failed: 0, dropped: 1, deferred: 0, redirected: 2 } }
}

function fakeContext() {
  const calls: Record<string, unknown[][]> = {}
  const target: Record<string, unknown> = { measureText: (t: string) => ({ width: t.length * 6 }) }
  return {
    calls,
    ctx: new Proxy(target, {
      get(obj, key: string) {
        if (key in obj) return obj[key]
        return (...args: unknown[]) => {
          if (!calls[key]) calls[key] = []
          calls[key].push(args)
        }
      },
      set(obj, key: string, v) {
        obj[key] = v
        return true
      }
    })
  }
}

describe('topology layout', () => {
  it('stacks sources under the callers with a caption, inside the height', () => {
    const l = computeLayout({
      width: 1000,
      callers: ['uA', 'uB'],
      sources: ['cron:a', 'flow:b'],
      lanes: [{ id: 'items', entities: ['workflows'] }],
      downs: ['db']
    })
    expect(l.sourceIds).toEqual(['cron:a', 'flow:b'])
    expect(l.callers.uA.y).toBe(22)
    expect(l.callers.uB.y).toBe(22 + 52)
    expect(l.sourcesCaptionY).toBe(22 + 104 + 12)
    expect(l.callers['cron:a'].y).toBe(22 + 104 + 20)
    expect(l.callers['flow:b'].h).toBe(40)
    expect(l.H).toBeGreaterThanOrEqual(l.callers['flow:b'].y + 40)
  })

  it('without sources keeps the old spread and no caption', () => {
    const l = computeLayout({ width: 1000, callers: ['uA'], lanes: [], downs: ['db'] })
    expect(l.sourceIds).toEqual([])
    expect(l.sourcesCaptionY).toBeNull()
  })
})

describe('node kinds', () => {
  it('names a source the catalog has never seen from the sources tap', () => {
    expect(callerLabel(null, 'flow:abc-123')).toBe('abc-123')
    setSourceLabel('flow:abc-123', 'Workflows — notify owners')
    setSourceLabel('k12', 'never a source')
    expect(callerLabel(null, 'flow:abc-123')).toBe('Workflows — notify owners')
    expect(callerLabel(null, 'k12')).toBe('API key 12')
  })
  it('names a declared partner node only a source has called', () => {
    const m = new TrafficModel()
    expect(downLabel(m, null, 'x:ops.orders-x')).toBe('orders-x')
    setDownLabel('x:ops.orders-x', 'Orders · warehouse')
    expect(downLabel(m, null, 'x:ops.orders-x')).toBe('Orders · warehouse')
  })

  it('reads kinds and labels off the snapshot, else the id', () => {
    const m = new TrafficModel()
    m.applySnapshot(base)
    expect(downKindOf(m, 'mail')).toBe('channel')
    expect(downKindOf(m, 'x:efp-ops.mdsi')).toBe('partner')
    expect(downKindOf(m, 'ai:anthropic')).toBe('ai')
    expect(downKindOf(m, 'webhook:9')).toBe('webhook')
    expect(downLabel(m, null, 'webhook:3')).toBe('Webhook · Order sync')
    expect(downLabel(m, null, 'push')).toBe('Web push')
    expect(downLabel(m, null, 'x:efp-ops.mdsi')).toBe('mdsi')
  })

  it('maps callers to the partner-dependency keys', () => {
    expect(dependencyKeyOf('k12')).toBe('key:12')
    expect(dependencyKeyOf('u0d6a1c4e-1111-2222-3333-444455556666')).toBe(
      'user:0D6A1C4E-1111-2222-3333-444455556666'
    )
    expect(dependencyKeyOf('cron')).toBeNull()
    expect(dependencyKeyOf('cron:x')).toBeNull()
  })
})

describe('topology canvas registrations', () => {
  beforeEach(() => setTopology(60, topology))
  afterEach(() => setTopology(60, null))

  it('colours a partner edge by its dominant error class and dashes source edges', () => {
    const m = new TrafficModel()
    expect(dominantClass({ rate_limited: 3, auth: 1 })).toBe('rate_limited')
    expect(edgeStyleFor({ dir: 'out', from: 'items', to: 'ext:7', rps: 1 }, m)).toEqual({
      tone: 'ecRateLimited'
    })
    expect(edgeStyleFor({ dir: 'out', from: 'items', to: 'db', rps: 1 }, m)).toBeNull()
    expect(edgeStyleFor({ dir: 'in', from: 'cron:x', to: 'items', rps: 1 }, m)).toMatchObject({
      dash: [5, 4]
    })
  })

  it('badges pool pressure, a partner error class, a failed job and channel test mode', () => {
    const m = new TrafficModel()
    expect(sideBadgeFor('down', 'db', m)).toEqual({ text: 'pool busy 31%', tone: 'warn' })
    expect(sideBadgeFor('down', 'ext:7', m)).toEqual({ text: 'rate limited 3', tone: 'warn' })
    expect(sideBadgeFor('caller', 'cron:nightly-sync', m)).toEqual({
      text: 'last run failed',
      tone: 'error'
    })
    expect(sideBadgeFor('down', 'mail', m)).toEqual({ text: 'test mode', tone: 'info' })
  })

  it('adds a partner-only source, a failing source and Redis as nodes', () => {
    const m = new TrafficModel()
    const p = nodeProviders.find((x) => x.id === 'topology')
    expect(p?.sources?.(m, 60, defaultFilters())).toEqual([
      { id: 'cron:push-orders', rps: 0.1 },
      { id: 'cron:nightly-sync', rps: 0.05 }
    ])
    expect(p?.downs?.(m, 60)).toEqual(['redis', 'ext:7'])
  })

  it('draws sources, channel/webhook downs and their badges on the canvas', () => {
    const fake = fakeContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => fake.ctx as unknown as CanvasRenderingContext2D
    )
    const realMatch = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduced-motion'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
    try {
      const m = new TrafficModel()
      m.applySnapshot(base)
      render(
        <MapCanvas
          model={m}
          filters={defaultFilters()}
          selection={null}
          onSelect={() => {}}
          catalog={null}
          tick={1}
          paused={false}
        />
      )
      const texts = (fake.calls.fillText ?? []).map((a) => String(a[0]))
      expect(texts).toContain('Sources')
      expect(texts).toContain('nightly-sync')
      expect(texts).toContain('push-orders')
      expect(texts).toContain('Email')
      expect(texts.some((t) => t.startsWith('Webhook · Ord'))).toBe(true) // ellipsized
      expect(texts).toContain('Redis')
      expect(texts).toContain('pool busy 31%')
      expect(texts).toContain('rate limited 3')
      expect(texts).toContain('webhook deliveries')
      expect(screen.getByRole('img').getAttribute('aria-label')).toContain('2 sources')
    } finally {
      vi.restoreAllMocks()
      window.matchMedia = realMatch
    }
  })
})

describe('topology inspector panels', () => {
  function renderPanels(sel: { kind: 'down' | 'caller'; id: string }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(topologyKey(60), topology)
    const model = new TrafficModel()
    model.applySnapshot(base)
    const ctx: TrafficMapContextValue = {
      model,
      filters: defaultFilters(),
      setFilters: () => {},
      selection: sel,
      setSelection: () => {},
      catalog: null,
      tick: 1,
      win: 60,
      paused: true,
      ready: true
    }
    const d = {
      name: 'x',
      type: 'x',
      route: '',
      rps: 0,
      p95: 0,
      errPct: 0,
      series: [],
      kinds: [0, 0, 0, 0, 0],
      routes: [],
      callers: [],
      errors: [],
      writes: []
    }
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <TrafficMapContext.Provider value={ctx}>
            <InspectorPanels sel={sel} d={d} mode='live' />
          </TrafficMapContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  it('shows pool pressure on SQL Server', () => {
    const { container } = renderPanels({ kind: 'down', id: 'db' })
    expect(container.querySelector('[data-tm-pool="warn"]')).not.toBeNull()
    expect(screen.getByText('31%')).toBeTruthy()
    expect(screen.getByText(/under pressure/)).toBeTruthy()
  })

  it('shows a partner’s error classes and latency histogram', () => {
    const { container } = renderPanels({ kind: 'down', id: 'ext:7' })
    expect(container.querySelector('[data-tm-error-class="rate_limited"]')).not.toBeNull()
    expect(container.querySelector('[data-tm-error-class="auth"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-tm-latency-hist] > div')).toHaveLength(8)
  })

  it('shows channel outcomes and a job’s last run', () => {
    const a = renderPanels({ kind: 'down', id: 'mail' })
    expect(a.container.querySelector('[data-tm-channel-outcomes]')?.textContent).toContain(
      'redirected'
    )
    a.unmount()
    const b = renderPanels({ kind: 'caller', id: 'cron:nightly-sync' })
    expect(b.container.querySelector('[data-tm-source-last]')?.textContent).toContain('failed')
  })
})
