import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { TrafficMapContext, type TrafficMapContextValue } from '../../context'
import type { InspectorData } from '../../Inspector'
import { defaultFilters, TrafficModel } from '../../model'
import { nodeToneFor } from '../../registry/canvasLayers'
import { hotRowTransforms, transformHotRows } from '../../registry/hotColumns'
import { Sparkline } from '../../Sparkline'
import { alertName, edgeOfScope, scopeOptions } from '../node-alert'
import { heatTip } from './heatmap'
import './index'
import {
  type BandWire,
  type Baselines,
  healthScore,
  judgeNode,
  ratioText,
  scoreAgainstBaseline,
  scoreErrors,
  worstLevel
} from './score'
import { setBaselinesForTest } from './store'
import { plainName, setSummaryView, summaryViewOn } from './summary-view'
import { riseMetric } from './what-changed'

const empty: Baselines = {
  h: 0,
  at: new Date().toISOString(),
  weeks: 4,
  hours_wanted: 12,
  hours_known: 12,
  learning: false,
  nodes: {},
  callers: {},
  edges: {},
  downs: {},
  total: {},
  people: null
}

beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { data: empty } } as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  setBaselinesForTest(null)
  setSummaryView(false)
})

describe('scoring twin (#2145) — same vectors as the server test', () => {
  it('elevated at 2 spreads, high at 4, low only when it matters', () => {
    const b: BandWire = [100, 80, 120, 10, 12]
    expect(scoreAgainstBaseline(105, b).level).toBe('normal')
    expect(scoreAgainstBaseline(125, b)).toMatchObject({ level: 'elevated', z: 2.5, ratio: 1.25 })
    expect(scoreAgainstBaseline(145, b).level).toBe('high')
    expect(scoreAgainstBaseline(60, b).level).toBe('normal')
    expect(scoreAgainstBaseline(60, b, true).level).toBe('low')
    expect(scoreAgainstBaseline(60, null).level).toBe('unknown')
    expect(worstLevel(['normal', 'high', 'elevated'])).toBe('high')
  })
  it('does not judge an error rate on a handful of requests', () => {
    const b: BandWire = [1, 0, 2, 0.5, 12]
    expect(scoreErrors(3, 1, b).level).toBe('normal')
    expect(scoreErrors(100, 10, b).level).toBe('high')
  })
  it('judges a node and words a surge', () => {
    const j = judgeNode(
      { req: 600, errors: 60, windowS: 60, p95: 300 },
      { rpm: [100, 80, 120, 10, 12], err_pct: [1, 0, 2, 0.5, 12], p95: [280, 230, 330, 25, 12] }
    )
    expect(j.errors.level).toBe('high')
    expect(j.p95.level).toBe('normal')
    expect(j.worst).toBe('high')
    expect(ratioText(j.rpm)).toBe('6.0× usual')
  })
})

describe('health score (#2144)', () => {
  it('is 100 for a healthy node and spends each part up to its weight', () => {
    expect(healthScore({ req: 600, errors: 0, windowS: 60, p95: 120 }).score).toBe(100)
    const bad = healthScore({
      req: 600,
      errors: 300,
      windowS: 60,
      p95: 5000,
      bands: { err_pct: [1, 0, 2, 0.5, 12], p95: [200, 150, 250, 25, 12] },
      pool: 'error',
      loopP99: 400,
      findings: [
        { tone: 'error', text: 'N+1' },
        { tone: 'error', text: 'retry storm' },
        { tone: 'warn', text: 'duplicates' }
      ]
    })
    const by = Object.fromEntries(bad.parts.map((p) => [p.id, p.penalty]))
    expect(by).toEqual({ errors: 40, latency: 30, saturation: 20, findings: 20 })
    expect(bad.score).toBe(0)
    expect(bad.tone).toBe('bad')
  })
  it('scores errors and latency without a normal on absolute figures', () => {
    const h = healthScore({ req: 100, errors: 5, windowS: 60, p95: 1500 })
    expect(h.parts.find((p) => p.id === 'errors')?.penalty).toBe(20)
    expect(h.parts.find((p) => p.id === 'latency')?.penalty).toBe(10)
    expect(h.score).toBe(70)
    expect(h.tone).toBe('warn')
  })
  it('ignores a single failure on a quiet node', () => {
    expect(healthScore({ req: 2, errors: 1, windowS: 60, p95: 50 }).score).toBe(100)
  })
})

describe('what changed (#2148)', () => {
  it('explains errors first, then latency, and only when risen', () => {
    const bands = {
      err_pct: [1, 0, 2, 0.5, 12] as BandWire,
      p95: [200, 150, 250, 25, 12] as BandWire
    }
    expect(riseMetric({ req: 100, errors: 20, windowS: 60, p95: 200 }, bands)).toBe('errors')
    expect(riseMetric({ req: 100, errors: 1, windowS: 60, p95: 900 }, bands)).toBe('latency')
    expect(riseMetric({ req: 100, errors: 1, windowS: 60, p95: 210 }, bands)).toBeNull()
    // no normal yet: the fixed 5% rule
    expect(riseMetric({ req: 100, errors: 9, windowS: 60, p95: 210 }, undefined)).toBe('errors')
  })
})

describe('map tones, sparkline band, hot sort (#2145, #2144)', () => {
  it('colours a node by its own normal, and leaves it to the fixed rule without one', () => {
    const m = new TrafficModel()
    expect(nodeToneFor('items/workflows', m, 60)).toBeNull()
    setBaselinesForTest({
      ...empty,
      nodes: { 'items/workflows': { err_pct: [1, 0, 2, 0.5, 12], p95: [200, 150, 250, 25, 12] } }
    })
    // no traffic: judged and normal
    expect(nodeToneFor('items/workflows', m, 60)).toBe('normal')
  })
  it('draws the band behind the sparkline line', () => {
    const { container } = render(
      <Sparkline data={[1, 2, 3]} band={{ lo: 1, hi: 2 }} className='h-5 w-20' />
    )
    expect(container.querySelector('[data-tm-spark-band]')).not.toBeNull()
  })
  it('passes rows through until a health sort is on', () => {
    const m = new TrafficModel()
    const rows = [
      {
        key: 'items/a',
        lane: 'items' as const,
        entity: 'a',
        rps: 2,
        wpm: 0,
        p95: 0,
        errPct: 0,
        series: []
      },
      {
        key: 'items/b',
        lane: 'items' as const,
        entity: 'b',
        rps: 1,
        wpm: 0,
        p95: 0,
        errPct: 0,
        series: []
      }
    ]
    expect(transformHotRows(rows, m, 60)).toBe(rows)
    expect(hotRowTransforms.some((t) => t.id === 'health')).toBe(true)
  })
})

describe('heatmap, summary, alerts (#2137, #2244, #2222, #2247)', () => {
  it('words a heatmap cell', () => {
    expect(heatTip(1, 9, 120, 'req')).toBe('Tue 09:00 · 120 requests an hour on average')
    expect(heatTip(0, 0, null, 'req')).toBe('Mon 00:00 · no history yet')
  })
  it('names summary keys in words', () => {
    const cat = {
      collections: { workflows: { label: 'Workflows', system: false } },
      widgets: {},
      pages: {},
      queries: {},
      inbound: {},
      extensions: {},
      partners: { '9': 'Fusion' },
      callers: {},
      down: {}
    }
    expect(plainName('items/workflows', cat)).toBe('Workflows (Items)')
    expect(plainName('ext:9', cat)).toBe('Fusion')
  })
  it('turns the summary view on through its view param', () => {
    expect(summaryViewOn()).toBe(false)
    setSummaryView(true)
    expect(summaryViewOn()).toBe(true)
  })
  it('offers edges as alert scopes and names them', () => {
    const d = {
      name: 'workflows',
      callers: [
        { key: 'k12', n: 5 },
        { key: 'bad key', n: 1 }
      ]
    } as unknown as InspectorData
    const opts = scopeOptions(d, ['db', 'ext:9'], null)
    expect(opts.map((o) => o.value)).toEqual(['', 'from:k12', 'to:ext:9'])
    expect(edgeOfScope('from:k12')).toEqual({ from: 'k12' })
    expect(edgeOfScope('to:ext:9')).toEqual({ to: 'ext:9' })
    expect(edgeOfScope('')).toBeNull()
    expect(alertName('workflows', 'errors_per_min', 5, 300, 'from API key 12')).toBe(
      'workflows from API key 12 errors per minute > 5 over 5 min'
    )
  })
})

describe('normal-for-this-hour panel', () => {
  it('says it is still learning before bands exist', async () => {
    setBaselinesForTest({ ...empty, learning: true, hours_known: 3 })
    const m = new TrafficModel()
    const ctx = {
      model: m,
      filters: defaultFilters(),
      setFilters: () => {},
      selection: { kind: 'entity', id: 'items/workflows' },
      setSelection: () => {},
      catalog: null,
      tick: 0,
      win: 60,
      paused: false,
      ready: true
    } as unknown as TrafficMapContextValue
    const { inspectorPanels } = await import('../../registry/inspectorPanels')
    const panel = inspectorPanels.find((p) => p.id === 'baselines')
    expect(panel).toBeDefined()
    const P = panel?.Component as (p: { sel: never; d: InspectorData }) => ReactNode
    const qc = new QueryClient()
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <TrafficMapContext.Provider value={ctx}>
            <P
              sel={{ kind: 'entity', id: 'items/workflows' } as never}
              d={
                {
                  name: 'workflows',
                  rps: 1,
                  p95: 100,
                  errPct: 0,
                  callers: []
                } as unknown as InspectorData
              }
            />
          </TrafficMapContext.Provider>
        </QueryClientProvider>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText(/Still learning: 3 of 12/)).toBeTruthy())
    expect(document.querySelector('#tm-health')).not.toBeNull()
  })
})
