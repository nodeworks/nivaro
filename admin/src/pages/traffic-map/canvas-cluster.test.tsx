// Canvas cluster: #2185 edge weight modes, #2279 viewport drawing + renderer choice, #2142 image
// export. (#2278 worker layout and the WebGL scene are in render/render.test.ts.)
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { edgeWidthByMetric, fmtWeight, getCanvasView, setCanvasView } from './canvasView'
import { computeLayout, TOKEN_FALLBACK } from './layout'
import { MapCanvas } from './MapCanvas'
import {
  buildMapSvg,
  describeView,
  exportFileName,
  getMapExportSource,
  pngScale
} from './mapExport'
import { defaultFilters, EDGE_WEIGHTS_TAP, TrafficModel } from './model'
import { viewParams } from './registry/viewParams'
import type { TrafficFrame, TrafficSnapshot } from './types'
import './features/view-links'

const T0 = 1_800_000_000
const snapshot: TrafficSnapshot = {
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
      req: 120,
      read: 100,
      create: 2,
      update: 10,
      delete: 0,
      error: 8,
      p50: 100,
      p95: 500,
      series: Array.from({ length: 60 }, () => 2),
      routes: [],
      callers: [
        { key: 'uA', n: 60 },
        { key: 'uB', n: 60 }
      ],
      down: { db: 120 },
      recent_errors: [],
      recent_writes: []
    }
  ],
  callers: [
    { key: 'uA', req: 60, error: 8 },
    { key: 'uB', req: 60, error: 0 }
  ],
  down: [{ id: 'db', label: 'SQL Server', kind: 'db', req: 120, error: 0, p95: 240 }],
  totals: {
    req: 120,
    read: 100,
    create: 2,
    update: 10,
    delete: 0,
    error: 8,
    p50: 100,
    p95: 500,
    outbound_req: 0,
    outbound_error: 0
  },
  sockets: { count: 1, users: 1 },
  journal_seq: null,
  ext: {
    [EDGE_WEIGHTS_TAP]: {
      i: { 'uA>items': [60 * 2048, 6000, 8], 'uB>items': [60 * 1024, 3000, 0] },
      o: { 'items>db': [120 * 1536, 9000, 0] }
    }
  }
}

describe('#2185 model edge weights', () => {
  it('seeds weights from the snapshot and reads them per second in each measure', () => {
    const m = new TrafficModel()
    m.applySnapshot(snapshot)
    const f = defaultFilters()
    expect(m.edgeWeights(60, f, 'requests').in.get('uA>items')).toBeCloseTo(1)
    expect(m.edgeWeights(60, f, 'bytes').in.get('uA>items')).toBeCloseTo(2048)
    expect(m.edgeWeights(60, f, 'time').in.get('uB>items')).toBeCloseTo(50)
    expect(m.edgeWeights(60, f, 'errors').in.get('uB>items')).toBe(0)
    expect(m.edgeWeights(60, f, 'bytes').out.get('items>db')).toBeCloseTo(3072)
  })
  it('a frame sets its second exactly', () => {
    const m = new TrafficModel()
    m.applySnapshot({ ...snapshot, ext: {} })
    const frame: TrafficFrame = {
      v: 1,
      at: new Date((T0 + 1) * 1000).toISOString(),
      instance: 'test-node',
      node_scope: '',
      frame: 6,
      window_s: 1,
      entities: { 'items/workflows': [1, 1, 0, 0, 0, 0, 0] },
      callers: { uA: [1, 0] },
      down: {},
      edges_in: { 'uA>items': 1 },
      edges_out: {},
      events: [],
      sockets: 1,
      journal_seq: null,
      ext: { [EDGE_WEIGHTS_TAP]: { i: { 'uA>items': [600, 30, 1] } } }
    }
    m.applyFrame(frame)
    const w = m.edgeWeights(60, defaultFilters(), 'errors').in.get('uA>items') ?? 0
    expect(w * 60).toBeCloseTo(1)
  })
})

describe('#2185 widths and numbers', () => {
  it('requests keep absolute widths; other measures are relative to the heaviest edge', () => {
    expect(edgeWidthByMetric(4, 'requests', 'sqrt')).toBeCloseTo(1 + 2 * 2.2)
    expect(edgeWidthByMetric(500, 'bytes', 'linear', 1000)).toBeCloseTo(6)
    expect(edgeWidthByMetric(1000, 'time', 'sqrt', 1000)).toBe(11)
    expect(edgeWidthByMetric(0, 'errors', 'sqrt', 3)).toBe(0)
  })
  it('formats each measure in its unit', () => {
    expect(fmtWeight(3.24, 'requests')).toBe('3.2/s')
    expect(fmtWeight(512, 'bytes')).toBe('512 B/s')
    expect(fmtWeight(14 * 1024, 'bytes')).toBe('14 KB/s')
    expect(fmtWeight(3.5 * 1024 * 1024, 'bytes')).toBe('3.5 MB/s')
    expect(fmtWeight(340, 'time')).toBe('340 ms/s')
    expect(fmtWeight(1500, 'time')).toBe('1.5 s/s')
    expect(fmtWeight(0.2, 'errors')).toBe('0.2 err/s')
  })
  it('the measure, every node and a forced renderer ride whole-view links', () => {
    const p = (id: string) => viewParams.find((v) => v.param === id)
    p('weight')?.set('bytes')
    expect(getCanvasView().weight).toBe('bytes')
    expect(p('weight')?.get()).toBe('bytes')
    p('weight')?.set('nonsense')
    expect(p('weight')?.get()).toBeNull()
    p('nodes')?.set('all')
    expect(p('nodes')?.get()).toBe('all')
    p('nodes')?.set(null)
    p('renderer')?.set('gl')
    expect(p('renderer')?.get()).toBe('gl')
    p('renderer')?.set(null)
    expect(getCanvasView().renderer).toBe('auto')
  })
})

/** A 2D context whose every method is a no-op spy (jsdom has no canvas). */
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

describe('MapCanvas: measures, viewport drawing, export source', () => {
  let fake: ReturnType<typeof fakeContext>
  const realMatchMedia = window.matchMedia
  beforeEach(() => {
    fake = fakeContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => fake.ctx as unknown as CanvasRenderingContext2D
    )
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduced-motion'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
  })
  afterEach(() => {
    vi.restoreAllMocks()
    window.matchMedia = realMatchMedia
    setCanvasView({ weight: 'requests', labels: false, density: 'top', renderer: 'auto' })
  })
  const texts = () => (fake.calls.fillText ?? []).map((a) => String(a[0]))
  const props = (m: TrafficModel) => ({
    model: m,
    filters: defaultFilters(),
    selection: null,
    onSelect: () => {},
    catalog: null,
    tick: 1,
    paused: false
  })

  it('numbers on edges follow the chosen measure, and the header says what width means', () => {
    const m = new TrafficModel()
    m.applySnapshot(snapshot)
    setCanvasView({ weight: 'bytes', labels: true })
    render(<MapCanvas {...props(m)} />)
    expect(texts()).toContain('2.0 KB/s')
    expect(texts()).toContain('3.0 KB/s')
    expect(screen.getByText(/edge width = response bytes\/s/)).toBeTruthy()
    expect(document.querySelector('[data-tm-weight="bytes"]')?.getAttribute('aria-pressed')).toBe(
      'true'
    )
    // jsdom has no WebGL: the 2D canvas draws, the layout runs inline
    const root = document.getElementById('tm-map')
    expect(root?.getAttribute('data-tm-renderer')).toBe('2d')
    expect(root?.getAttribute('data-tm-layout')).toBe('inline')
  })

  it('a tall map draws only its visible part: the box scrolls, the canvas stays its size', () => {
    const m = new TrafficModel()
    const callers = Array.from({ length: 60 }, (_, i) => ({ key: `uUser${i}`, req: 60, error: 0 }))
    // a 1000 x 500 box (jsdom lays nothing out)
    const proto = HTMLElement.prototype
    const cw = Object.getOwnPropertyDescriptor(proto, 'clientWidth')
    const ch = Object.getOwnPropertyDescriptor(proto, 'clientHeight')
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 1000 })
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 500 })
    try {
      m.applySnapshot({
        ...snapshot,
        ext: {},
        callers,
        entities: [
          { ...snapshot.entities[0], callers: callers.map((c) => ({ key: c.key, n: 60 })) }
        ]
      })
      setCanvasView({ density: 'all' })
      render(<MapCanvas {...props(m)} />)
      const box = document.querySelector('[data-tm-viewport]') as HTMLElement
      expect(box).toBeTruthy()
      // 60 callers stacked at 44 px: far taller than the viewport threshold
      const sizer = box.firstElementChild as HTMLElement
      expect(Number.parseInt(sizer.style.height, 10)).toBeGreaterThan(1600)
      // painted through a translated transform, culled to the view (only the top callers drawn)
      const drawn = () => [...new Set(texts().filter((t) => /^User\d+$/.test(t)))]
      expect(drawn().length).toBeGreaterThan(0)
      expect(drawn().length).toBeLessThan(30)
      expect(drawn()).toContain('User0')
      // scrolled down: the canvas repaints what is now in view (reduced motion paints at once)
      fake.calls.fillText = []
      act(() => {
        Object.defineProperty(box, 'scrollTop', { value: 2000, configurable: true })
        box.dispatchEvent(new Event('scroll'))
      })
      expect(drawn()).not.toContain('User0')
      expect(drawn().length).toBeGreaterThan(0)
    } finally {
      if (cw) Object.defineProperty(proto, 'clientWidth', cw)
      else delete (proto as unknown as Record<string, unknown>).clientWidth
      if (ch) Object.defineProperty(proto, 'clientHeight', ch)
      else delete (proto as unknown as Record<string, unknown>).clientHeight
    }
  })

  it('registers what it draws for the image export', () => {
    const m = new TrafficModel()
    m.applySnapshot(snapshot)
    render(<MapCanvas {...props(m)} />)
    const src = getMapExportSource()
    expect(src?.data.lanes[0].id).toBe('items')
    expect(src?.layout.lanes.items).toBeTruthy()
  })
})

describe('#2142 image export', () => {
  it('prints the window, filters, environment and a legend on an SVG of the whole map', () => {
    const m = new TrafficModel()
    m.applySnapshot(snapshot)
    const layout = computeLayout({
      width: 1000,
      callers: ['uA'],
      lanes: [{ id: 'items', entities: ['workflows'] }],
      downs: ['db']
    })
    const data = {
      callers: [
        { id: 'uA', label: 'Ann <admin>', sub: 'signed-in person', rps: 1, partner: false }
      ],
      sources: [],
      lanes: [
        {
          id: 'items' as const,
          rps: 2,
          entities: [
            {
              key: 'items/workflows',
              entity: 'workflows',
              label: 'workflows',
              rps: 2,
              kinds: [2, 0, 0, 0, 0],
              errFrac: 0
            }
          ]
        }
      ],
      downs: [{ id: 'db', label: 'SQL Server', sub: 'reads', rps: 2, partner: false, kind: 'db' }],
      edgesIn: [{ from: 'uA', to: 'items' as const, rps: 1, w: 2048 }],
      edgesOut: [{ from: 'items' as const, to: 'db', rps: 2, w: 3072 }],
      laneOut: new Map(),
      entityDowns: new Map(),
      edgesEnt: [],
      callerNode: new Map(),
      maxIn: 2048,
      maxOut: 3072,
      loaded: true,
      empty: false,
      winLabel: '1 min',
      summary: ''
    }
    const view = { ...getCanvasView(), weight: 'bytes' as const, labels: true }
    const filters = { ...defaultFilters(), caller: 'uA', win: 300 as const }
    const { svg, width, height } = buildMapSvg(
      {
        data,
        layout,
        tokens: TOKEN_FALLBACK,
        fonts: { sans: 'DM Sans', mono: 'Mono' },
        view,
        filters,
        model: m
      },
      { environment: 'Acme · admin.example.com · api test-node', callerLabel: () => 'Ann' }
    )
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(width).toBe(1000)
    expect(height).toBeGreaterThan(layout.H)
    expect(svg).toContain('Acme · admin.example.com · api test-node')
    expect(svg).toContain('Last 5 min to')
    expect(svg).toContain('Caller: Ann')
    expect(svg).toContain('Edge width: response bytes/s')
    expect(svg).toContain('2.0 KB/s') // the edge number in the chosen measure
    expect(svg).toContain('Edge width = response bytes/s')
    expect(svg).toContain('Ann &lt;admin&gt;') // text is escaped
    expect(svg).not.toContain('var(--')
  })
  it('names the view choices, says when nothing is filtered, and sizes PNGs to the canvas limits', () => {
    const v = {
      zoom: 1 as const,
      weight: 'requests' as const,
      scale: 'sqrt' as const,
      density: 'top' as const,
      groupApps: false
    }
    expect(describeView(defaultFilters(), v)[0]).toBe('No filters')
    expect(describeView({ ...defaultFilters(), kinds: new Set(['error']) }, v)[0]).toBe(
      'Kinds: error'
    )
    expect(pngScale(1000, 800)).toBe(2)
    expect(pngScale(1000, 40_000)).toBeLessThan(1)
    expect(exportFileName('png', new Date(2026, 9, 17, 14, 3, 9))).toBe(
      'traffic-map-2026-10-17-140309.png'
    )
  })
})
