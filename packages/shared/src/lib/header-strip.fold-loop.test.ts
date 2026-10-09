// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { headerChangedCells, headerEstimateDenseWidth, headerFoldedCells } from './header-strip'

// jsdom has no layout: widths come from the fixture. getBoundingClientRect
// reads W (a cell's rendered dense width), scrollWidth reads SW (a label's or
// a value's text width).
const W = new WeakMap<Element, number>()
const SW = new WeakMap<Element, number>()
const saved = {
  rect: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
}
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const width = W.get(this) ?? 0
      return { width, height: 34, top: 0, left: 0, right: width, bottom: 34, x: 0, y: 0 }
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return SW.get(this) ?? 0
    }
  })
})
afterAll(() => {
  if (saved.rect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', saved.rect)
  else delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
  delete (HTMLElement.prototype as { scrollWidth?: unknown }).scrollWidth
})

/** One label · value pair (StripCell / a field tile: label and value are siblings). */
function pair(label: string, value: string, lw: number, vw: number) {
  const box = document.createElement('div')
  const l = document.createElement('span')
  l.setAttribute('data-header-label', '')
  l.textContent = label
  const v = document.createElement('span')
  v.setAttribute('data-header-value', '')
  v.textContent = value
  SW.set(l, lw)
  SW.set(v, vw)
  box.append(l, v)
  return box
}

// Layout 2's eleven header tiles + the lines summary at a 1400px viewport
// (band 1006px), the dense widths the investigation measured. Cell 2 is the
// five-figure "Project Budget" widget (PUB budget health), 952px rendered.
const DENSE = [172, 190, 952, 125, 110, 196, 173, 105, 161, 309, 90, 150]
const EMPTY = new Set([0, 4, 5, 8, 10])
const MONEY = new Set([0, 1, 2])
// The widget's five figures on 284212: null figures render a dash (no
// `awaiting` in the render response), EFP Committed is $0.00. Text widths
// as the investigation's sketch had them. The text-based estimate of the
// widget (658, below) is well short of its rendered 952 — which is why a
// folded cell's measured width must never be thrown away.
const FIGURES: Array<[string, string, number, number]> = [
  ["PUB'd", '—', 34, 8],
  ['Fusion Remaining', '—', 98, 8],
  ['EFP Committed', '$0.00', 84, 34],
  ['Total Remaining', '—', 92, 8],
  ['Total Remaining %', '—', 104, 8]
]

function widget(): HTMLElement {
  const t = document.createElement('div')
  t.setAttribute('data-header-money', '')
  t.append(...FIGURES.map(([l, v, lw, vw]) => pair(l, v, lw, vw)))
  return t
}

function tile(i: number): HTMLElement {
  if (i === 2) return widget()
  const t = pair(`Field ${i}`, EMPTY.has(i) ? '—' : 'value', DENSE[i] - 76, 40)
  if (EMPTY.has(i)) t.setAttribute('data-empty', 'true')
  if (MONEY.has(i)) t.setAttribute('data-header-money', '')
  return t
}

/** The band as HeaderTiles renders it for a fold set: every tile tagged with
 *  its key, a folded tile in place, marked `data-header-folded`, never
 *  measured; PopoverContent's hidden marker span beside the chip. */
function band(folded: Array<string | number>): HTMLElement {
  const group = document.createElement('div')
  Object.defineProperty(group, 'clientWidth', { value: 1006 })
  DENSE.forEach((_, i) => {
    const t = tile(i)
    t.setAttribute('data-header-cell', `f${i}`)
    if (folded.includes(`f${i}`)) t.setAttribute('data-header-folded', '')
    else W.set(t, DENSE[i])
    group.append(t)
  })
  if (folded.length) {
    const chip = document.createElement('button')
    chip.setAttribute('data-header-more', '')
    W.set(chip, 90)
    const marker = document.createElement('span')
    marker.hidden = true
    marker.setAttribute('data-nvr-popover-marker', '')
    group.append(chip, marker)
  }
  return group
}

describe('headerFoldedCells — the fold decision is a fixed point', () => {
  it('re-deciding a folded band with the cache the first decision filled keeps the same fold', () => {
    // As useHeaderBand does: one cache for the band's life; a fold or a
    // change inside a folded cell never empties it.
    const cache = new Map<string | number, number>()
    const first = headerFoldedCells(band([]), true, cache).map((c) => c.key)
    expect(first).toContain('f2') // the widget must fold at this width
    const second = headerFoldedCells(band(first), true, cache)
    expect(second.map((c) => c.key)).toEqual(first)
    // The popover marker beside the chip is not a cell.
    expect(second.every((c) => c.index < DENSE.length)).toBe(true)
  })

  it('folds by tile key, and a repeated key never shares a cache entry', () => {
    const group = document.createElement('div')
    Object.defineProperty(group, 'clientWidth', { value: 1000 })
    for (const [key, w] of [
      ['dup', 300],
      ['dup', 500]
    ] as const) {
      const t = pair('Label', 'value', 50, 40)
      t.setAttribute('data-header-cell', key)
      W.set(t, w)
      group.append(t)
    }
    const cache = new Map<string | number, number>()
    headerFoldedCells(group, true, cache)
    expect(cache.get('dup')).toBe(300)
    expect(cache.get('dup#1')).toBe(500)
  })
})

describe('headerEstimateDenseWidth — a folded cell never measured', () => {
  it('costs every label · value pair in the cell, not just the first', () => {
    // Σ (label + value + gap-x-2 8 + pl-4 16 + pr-3 12):
    // (34+8) + (98+8) + (84+34) + (92+8) + (104+8) + 5 × 36 = 478 + 180
    expect(headerEstimateDenseWidth(widget())).toBe(658)
  })
})

describe('headerChangedCells — which remembered widths a mutation makes stale', () => {
  it('names a shown cell whose content changed, by its tile key', () => {
    const g = band([])
    const value = g.children[1].querySelector('[data-header-value]') as HTMLElement
    const records = [
      { target: value.firstChild, type: 'characterData' }
    ] as unknown as MutationRecord[]
    expect(headerChangedCells(g, records)).toEqual({ shown: ['f1'], folded: [] })
  })

  it('reports a folded cell apart (its dense width is kept), and ignores the chip and the group', () => {
    const g = band(['f2', 'f9'])
    const inWidget = g.children[2].querySelector('[data-header-value]') as HTMLElement
    const chip = g.querySelector('[data-header-more]') as HTMLElement
    const records = [
      { target: inWidget, type: 'childList' },
      { target: chip, type: 'childList' },
      { target: g, type: 'childList' }
    ] as unknown as MutationRecord[]
    expect(headerChangedCells(g, records)).toEqual({ shown: [], folded: ['f2'] })
  })
})
