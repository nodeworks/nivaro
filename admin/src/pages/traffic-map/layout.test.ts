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
    { id: 'items' as const, entities: ['items/workflows', 'items/forecasts'] },
    { id: 'widgets' as const, entities: ['widgets/1'] }
  ],
  downs: ['db', 'ext:3']
}

describe('computeLayout', () => {
  it('lays callers left, lanes centred with one row per entity, downs right; never narrower than 860', () => {
    const l = computeLayout(input)
    expect(l.W).toBe(1000)
    expect(computeLayout({ ...input, width: 400 }).W).toBe(860)
    expect(l.callers.uA.x).toBe(14)
    expect(l.downs.db.x).toBe(1000 - 178)
    expect(l.lanes.items.h).toBe(24 + 2 * 20 + 8)
    expect(l.lanes.widgets.y).toBeGreaterThan(l.lanes.items.y + l.lanes.items.h)
    expect(l.ents['items/forecasts'].y).toBe(l.ents['items/workflows'].y + 20)
    expect(l.H).toBeGreaterThan(l.lanes.widgets.y + l.lanes.widgets.h)
    expect(l.callers.k7.y + 44).toBeLessThanOrEqual(l.H)
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
})
