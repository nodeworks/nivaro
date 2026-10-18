import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeLayout,
  edgeEnds,
  ROUTE_SEGS,
  routeEdges,
  routeKey,
  TOKEN_FALLBACK
} from '../layout'
import type { MapData } from '../MapCanvas'
import { makeColorParser, parseCssColor } from './color'
import { buildGlScene, FADED, particleRects, polyline, RECT_FLOATS, SEG_FLOATS } from './glScene'
import { layoutInline, layoutItems, useMapLayout, WORKER_MIN_ITEMS } from './useMapLayout'

const input = {
  width: 1000,
  callers: ['uA', 'k7'],
  lanes: [{ id: 'items' as const, entities: ['workflows', 'forecasts'] }],
  downs: ['db', 'ext:3']
}
const layout = computeLayout(input)

function data(over: Partial<MapData> = {}): MapData {
  return {
    callers: [
      { id: 'uA', label: 'Ann', sub: 'person', rps: 2, partner: false },
      { id: 'k7', label: 'Key 7', sub: 'API key', rps: 1, partner: false }
    ],
    sources: [],
    lanes: [
      {
        id: 'items',
        rps: 3,
        entities: [
          {
            key: 'items/workflows',
            entity: 'workflows',
            label: 'workflows',
            rps: 2,
            kinds: [2, 0, 0, 0, 0],
            errFrac: 0
          },
          {
            key: 'items/forecasts',
            entity: 'forecasts',
            label: 'forecasts',
            rps: 1,
            kinds: [1, 0, 0, 0, 0],
            errFrac: 0.5
          }
        ]
      }
    ],
    downs: [
      { id: 'db', label: 'SQL Server', sub: 'reads', rps: 3, partner: false, kind: 'db' },
      { id: 'ext:3', label: 'Partner', sub: 'calls', rps: 1, partner: true, kind: 'partner' }
    ],
    edgesIn: [
      { from: 'uA', to: 'items', rps: 2, w: 2 },
      { from: 'k7', to: 'items', rps: 1, w: 1 }
    ],
    edgesOut: [
      { from: 'items', to: 'db', rps: 3, w: 3 },
      { from: 'items', to: 'ext:3', rps: 1, w: 1 }
    ],
    laneOut: new Map(),
    entityDowns: new Map(),
    edgesEnt: [],
    callerNode: new Map(),
    maxIn: 2,
    maxOut: 3,
    loaded: true,
    empty: false,
    winLabel: '1 min',
    summary: '',
    ...over
  }
}

describe('#2279 colours for WebGL', () => {
  it('parses hex and rgb()/rgba() in both syntaxes', () => {
    expect(parseCssColor('#00ceff')).toEqual([0, 206 / 255, 1, 1])
    expect(parseCssColor('#fff')).toEqual([1, 1, 1, 1])
    expect(parseCssColor('rgba(220, 38, 38, 0.10)')?.[3]).toBeCloseTo(0.1)
    expect(parseCssColor('rgb(0 206 255 / 50%)')?.[3]).toBeCloseTo(0.5)
    expect(parseCssColor('transparent')).toEqual([0, 0, 0, 0])
    expect(parseCssColor('oklch(0.7 0.1 200)')).toBeNull()
  })
  it('falls back to opaque black for a colour it cannot read (no canvas under jsdom)', () => {
    const parse = makeColorParser()
    expect(parse('#000000')).toEqual([0, 0, 0, 1])
    expect(parse('not-a-colour').length).toBe(4)
  })
})

describe('#2278 edge routing', () => {
  it('flattens every laid-out edge into SEGS + 1 points between the same anchors the canvas uses', () => {
    const r = routeEdges(layout, {
      in: [
        ['uA', 'items'],
        ['nobody', 'items']
      ],
      ent: [['uA', 'items/workflows']],
      out: [['items', 'db']]
    })
    expect(r.index.size).toBe(3) // `nobody` is not laid out
    const per = (ROUTE_SEGS + 1) * 2
    expect(r.points.length).toBe(3 * per)
    const slot = r.index.get(routeKey('out', 'items', 'db')) as number
    const ends = edgeEnds(layout, 'out', 'items', 'db')
    expect(r.points[slot * per]).toBeCloseTo(ends?.[0].x ?? 0)
    expect(r.points[slot * per + per - 1]).toBeCloseTo(ends?.[1].y ?? 0)
  })
  it('polyline() reads a routed edge and flattens an unrouted one itself', () => {
    const r = routeEdges(layout, { in: [['uA', 'items']], ent: [], out: [] })
    expect(polyline(layout, r, 'in', 'uA', 'items')?.length).toBe((ROUTE_SEGS + 1) * 2)
    expect(polyline(layout, r, 'out', 'items', 'db')?.length).toBe((ROUTE_SEGS + 1) * 2)
    expect(polyline(layout, null, 'out', 'items', 'nope')).toBeNull()
  })
})

describe('#2279 WebGL scene', () => {
  const base = {
    layout,
    routes: null,
    tokens: TOKEN_FALLBACK,
    color: makeColorParser(),
    scale: 'sqrt' as const,
    metric: 'requests' as const,
    active: null,
    trace: null
  }
  it('one segment instance per curve segment, one rect per box, dot and bar part', () => {
    const s = buildGlScene({ ...base, data: data() })
    expect(s.segCount).toBe(4 * ROUTE_SEGS)
    expect(s.segs.length).toBe(s.segCount * SEG_FLOATS)
    expect(s.accentCount).toBe(0)
    // 2 callers + lane + 2 x (dot + bar background + 1 kind segment) + 2 downs
    expect(s.rectCount).toBe(2 + 1 + 2 * 3 + 2)
    expect(s.rects.length).toBe(s.rectCount * RECT_FLOATS)
  })
  it('a partner box has no stroke (the 2D pass draws its dashes); an erroring row dot is red', () => {
    const s = buildGlScene({ ...base, data: data() })
    const rect = (i: number) => s.rects.subarray(i * RECT_FLOATS, (i + 1) * RECT_FLOATS)
    const partner = rect(s.rectCount - 1)
    expect(partner[5]).toBe(0)
    const red = parseCssColor(TOKEN_FALLBACK.error) ?? [0, 0, 0, 0]
    // lane, then row 1 (dot, bar, kind), then row 2's dot
    const dot2 = rect(2 + 1 + 3)
    expect(dot2[6]).toBeCloseTo(red[0])
  })
  it('highlights the selected caller in the accent batch, and fades off-path edges while tracing', () => {
    const sel = buildGlScene({ ...base, data: data(), active: { kind: 'caller', id: 'uA' } })
    expect(sel.accentCount).toBe(ROUTE_SEGS)
    const tr = buildGlScene({
      ...base,
      data: data(),
      trace: { caller: 'uA', lanes: new Set(['items']), ents: new Set(), downs: new Set(['db']) }
    })
    expect(tr.accentCount).toBe(0)
    const alphaOf = (i: number) => tr.segs[i * SEG_FLOATS + 12]
    const edgeAlpha = parseCssColor(TOKEN_FALLBACK.edge)?.[3] ?? 1
    expect(alphaOf(0)).toBeCloseTo(edgeAlpha) // uA → items: on the path
    expect(alphaOf(ROUTE_SEGS)).toBeCloseTo(edgeAlpha * FADED) // k7 → items: off it
  })
  it('errors mode: an edge with traffic but no errors stays as a hairline', () => {
    const d = data({
      edgesIn: [
        { from: 'uA', to: 'items', rps: 2, w: 0.5 },
        { from: 'k7', to: 'items', rps: 1, w: 0 }
      ],
      maxIn: 0.5
    })
    const s = buildGlScene({ ...base, data: d, metric: 'errors' })
    const half = (i: number) => s.segs[i * SEG_FLOATS + 8]
    expect(half(0)).toBeCloseTo(11 / 2) // the heaviest edge is full width
    expect(half(ROUTE_SEGS)).toBeCloseTo(0.75 / 2)
  })
  it('particles: a dot each, plus a ring round an error', () => {
    const c = makeColorParser()('#ff0000')
    const kc = { read: c, create: c, update: c, delete: c, error: c }
    const p = particleRects(
      [
        { x: 1, y: 1, kind: 'read' },
        { x: 2, y: 2, kind: 'error' }
      ],
      kc
    )
    expect(p.count).toBe(3)
  })
})

describe('#2278 layout off the main thread', () => {
  const realWorker = globalThis.Worker
  afterEach(() => {
    globalThis.Worker = realWorker
  })
  it('counts nodes + edges and lays a small map out inline', () => {
    expect(layoutItems(input, null)).toBe(2 + 2 + 1 + 2)
    const { result } = renderHook(() => useMapLayout(input, null))
    expect(result.current.via).toBe('inline')
    expect(result.current.layout.W).toBe(1000)
  })
  it('posts a big map to the worker, shows an inline layout meanwhile, then the reply', async () => {
    const posted: unknown[] = []
    let onmessage: ((e: { data: unknown }) => void) | null = null
    class FakeWorker {
      set onmessage(fn: (e: { data: unknown }) => void) {
        onmessage = fn
      }
      onerror: (() => void) | null = null
      postMessage(m: unknown) {
        posted.push(m)
      }
      terminate = vi.fn()
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker
    const big = {
      ...input,
      callers: Array.from({ length: WORKER_MIN_ITEMS }, (_, i) => `u${i}`)
    }
    const { result } = renderHook(() => useMapLayout(big, null))
    expect(result.current.via).toBe('inline')
    expect(posted).toHaveLength(1)
    const job = posted[0] as { seq: number }
    const reply = layoutInline(big, null)
    await act(async () => {
      onmessage?.({ data: { seq: job.seq, layout: reply.layout, routes: null } })
    })
    expect(result.current.via).toBe('worker')
    expect(Object.keys(result.current.layout.callers)).toHaveLength(WORKER_MIN_ITEMS)
  })
  it('falls back inline when the worker reports an error', async () => {
    let onmessage: ((e: { data: unknown }) => void) | null = null
    class FakeWorker {
      set onmessage(fn: (e: { data: unknown }) => void) {
        onmessage = fn
      }
      onerror: (() => void) | null = null
      postMessage() {}
      terminate() {}
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker
    const big = { ...input, callers: Array.from({ length: WORKER_MIN_ITEMS }, (_, i) => `u${i}`) }
    const { result } = renderHook(() => useMapLayout(big, null))
    await act(async () => {
      onmessage?.({ data: { seq: 1, error: 'boom' } })
    })
    expect(result.current.via).toBe('inline')
  })
})
