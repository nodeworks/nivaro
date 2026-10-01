import { describe, expect, it } from 'vitest'
import {
  bezierPoint,
  computeLayout,
  edgeWidth,
  hitTest,
  readTokens,
  TOKEN_FALLBACK
} from './layout'

const input = {
  width: 1000,
  callers: ['uA', 'k7'],
  lanes: [
    { id: 'items' as const, entities: ['workflows', 'forecasts'] },
    { id: 'widgets' as const, entities: ['1'] }
  ],
  downs: ['db', 'ext:3']
}

describe('computeLayout', () => {
  it('lays callers left, lanes centred with one row per entity, downs right; never narrower than 720', () => {
    const l = computeLayout(input)
    expect(l.W).toBe(1000)
    expect(computeLayout({ ...input, width: 400 }).W).toBe(720)
    expect(l.callers.uA.x).toBe(14)
    expect(l.downs.db.x).toBe(1000 - 178)
    expect(l.lanes.items.h).toBe(24 + 2 * 20 + 8)
    expect(l.lanes.widgets.y).toBeGreaterThan(l.lanes.items.y + l.lanes.items.h)
    expect(l.ents['items/forecasts'].y).toBe(l.ents['items/workflows'].y + 20)
    expect(l.H).toBeGreaterThan(l.lanes.widgets.y + l.lanes.widgets.h)
    expect(l.callers.k7.y + 44).toBeLessThanOrEqual(l.H)
  })
  it('fills narrow boxes (720–860) without overlap or overflow (R34)', () => {
    for (const width of [720, 756, 796, 859, 860]) {
      const l = computeLayout({ ...input, width })
      expect(l.W).toBe(width)
      const lane = l.lanes.items
      for (const r of [...Object.values(l.callers), ...Object.values(l.downs), lane]) {
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(width)
      }
      expect(l.callers.uA.x + l.callers.uA.w).toBeLessThan(lane.x - 24)
      expect(lane.x + lane.w).toBeLessThan(l.downs.db.x - 24)
    }
    expect(computeLayout({ ...input, width: 720 }).callers.uA.w).toBeLessThan(164)
    expect(computeLayout({ ...input, width: 860 }).callers.uA.w).toBe(164)
  })
  it('hitTest resolves entity, lane, caller, down and nothing', () => {
    const l = computeLayout(input)
    const e = l.ents['items/workflows']
    expect(hitTest(l, e.x + 5, e.y + 5)).toEqual({ kind: 'entity', id: 'items/workflows' })
    const lane = l.lanes.items
    expect(hitTest(l, lane.x + 5, lane.y + 5)).toEqual({ kind: 'lane', id: 'items' })
    const c = l.callers.k7
    expect(hitTest(l, c.x + 1, c.y + 1)).toEqual({ kind: 'caller', id: 'k7' })
    const d = l.downs['ext:3']
    expect(hitTest(l, d.x + 1, d.y + 1)).toEqual({ kind: 'down', id: 'ext:3' })
    expect(hitTest(l, 2, 2)).toBeNull()
  })
  it('bezierPoint ends where it should and edgeWidth is bounded', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 100, y: 50 }
    expect(bezierPoint(a, b, 0)).toEqual({ x: 0, y: 0 })
    expect(bezierPoint(a, b, 1)).toEqual({ x: 100, y: 50 })
    expect(bezierPoint(a, b, 0.5).x).toBeCloseTo(50)
    expect(edgeWidth(0)).toBe(0)
    expect(edgeWidth(0.25)).toBeCloseTo(2.1)
    expect(edgeWidth(1000)).toBe(11)
  })
  it('readTokens falls back: empty computed values never produce an empty colour', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const t = readTokens(el)
    expect(t.accent).toBe(TOKEN_FALLBACK.accent)
    expect(Object.values(t).every((v) => typeof v === 'string' && v.length > 0)).toBe(true)
    el.style.setProperty('--tm-accent', '#ff00aa')
    expect(readTokens(el).accent).toBe('#ff00aa')
  })
  it('grows H to fit many downs/callers without overlap', () => {
    const downs = Array.from({ length: 8 }, (_, i) => `d${i}`)
    const l = computeLayout({
      width: 1000,
      callers: ['a'],
      lanes: [{ id: 'items', entities: ['x'] }],
      downs
    })
    const rects = downs.map((d) => l.downs[d]).sort((a, b) => a.y - b.y)
    for (const r of rects) expect(r.y + r.h).toBeLessThanOrEqual(l.H)
    for (let i = 1; i < rects.length; i++)
      expect(rects[i].y).toBeGreaterThanOrEqual(rects[i - 1].y + 40)
  })
  it('non-finite width falls back to 720', () => {
    expect(computeLayout({ ...input, width: Number.NaN }).W).toBe(720)
    expect(computeLayout({ ...input, width: undefined as unknown as number }).W).toBe(720)
  })
  it('same entity id in two lanes stays distinct', () => {
    const l = computeLayout({
      width: 1000,
      callers: [],
      lanes: [
        { id: 'pages', entities: ['budget'] },
        { id: 'queries', entities: ['budget'] }
      ],
      downs: []
    })
    const a = l.ents['pages/budget']
    const b = l.ents['queries/budget']
    expect(a).not.toEqual(b)
    expect(hitTest(l, a.x + 2, a.y + 2)).toEqual({ kind: 'entity', id: 'pages/budget' })
    expect(hitTest(l, b.x + 2, b.y + 2)).toEqual({ kind: 'entity', id: 'queries/budget' })
  })
  it('empty input has no NaN or negative heights', () => {
    const l = computeLayout({ width: 1000, callers: [], lanes: [], downs: [] })
    expect(Number.isFinite(l.W) && Number.isFinite(l.H)).toBe(true)
    expect(l.H).toBeGreaterThan(0)
    expect(
      Object.keys(l.callers).length + Object.keys(l.lanes).length + Object.keys(l.downs).length
    ).toBe(0)
  })
})
