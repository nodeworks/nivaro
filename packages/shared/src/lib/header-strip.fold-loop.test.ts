// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { headerChangedCells, headerFoldedCells } from './header-strip'

// jsdom has no layout: widths come from the fixture. getBoundingClientRect
// reads W (a cell's rendered dense width), scrollWidth reads SW (a label's or
// a value's text width).
const W = new WeakMap<Element, number>()
const SW = new WeakMap<Element, number>()
const saved = {
  rect: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect'),
  scroll: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth')
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

/** One label · value pair; its dense width is label + value + 36 (pl-4, pr-3, gap-x-2). */
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
// five-figure "Project Budget" widget (PUB budget health), 952px dense.
const DENSE = [172, 190, 952, 125, 110, 196, 173, 105, 161, 309, 90, 150]
const EMPTY = new Set([0, 4, 5, 8, 10])
const MONEY = new Set([0, 1, 2])
// The widget's five figures. Values for null figures render "needs …"
// (AwaitingValue), so they are wider than a dash; label + value + 36 per
// figure sums to the measured 952.
const FIGURES: Array<[string, string, number, number]> = [
  ["PUB'd", 'needs PUB', 34, 120],
  ['Fusion Remaining', 'needs Fusion', 98, 56],
  ['EFP Committed', '$0.00', 84, 70],
  ['Total Remaining', '—', 92, 62],
  ['Total Remaining %', '—', 104, 52]
]

function tile(i: number): HTMLElement {
  if (i === 2) {
    const t = document.createElement('div')
    t.setAttribute('data-header-money', '')
    t.append(...FIGURES.map(([l, v, lw, vw]) => pair(l, v, lw, vw)))
    return t
  }
  const t = pair(`Field ${i}`, EMPTY.has(i) ? '—' : 'value', DENSE[i] - 76, 40)
  if (EMPTY.has(i)) t.setAttribute('data-empty', 'true')
  if (MONEY.has(i)) t.setAttribute('data-header-money', '')
  return t
}

/** The band as HeaderTiles renders it for a fold set: a folded tile stays in
 *  place, marked `data-header-folded`, and is never measured. */
function band(folded: number[], opts: { keyed?: boolean; marker?: boolean } = {}): HTMLElement {
  const group = document.createElement('div')
  Object.defineProperty(group, 'clientWidth', { value: 1006 })
  DENSE.forEach((_, i) => {
    const t = tile(i)
    if (opts.keyed) t.setAttribute('data-header-cell', `f${i}`)
    if (folded.includes(i)) t.setAttribute('data-header-folded', '')
    else W.set(t, DENSE[i])
    group.append(t)
  })
  if (folded.length) {
    const chip = document.createElement('button')
    chip.setAttribute('data-header-more', '')
    W.set(chip, 90)
    group.append(chip)
    if (opts.marker) {
      // PopoverContent's hidden marker span lands beside the chip.
      const marker = document.createElement('span')
      marker.hidden = true
      marker.setAttribute('data-nvr-popover-marker', '')
      group.append(marker)
    }
  }
  return group
}

describe('headerFoldedCells — the fold decision is a fixed point', () => {
  it('re-deciding a folded band after the cache is cleared keeps the same fold', () => {
    const first = headerFoldedCells(band([]), true, new Map()).map((c) => c.index)
    expect(first).toContain(2) // the widget must fold at this width
    // A folded cell's width can only be estimated. Costing the widget by its
    // first figure (~190 of 952) unfolded everything, which refolded it,
    // forever ("Maximum update depth exceeded").
    const second = headerFoldedCells(band(first), true, new Map()).map((c) => c.index)
    expect(second).toEqual(first)
  })

  it('keys remembered widths by the tile key (data-header-cell), not the position', () => {
    const cache = new Map<string | number, number>()
    const first = headerFoldedCells(band([], { keyed: true }), true, cache)
    expect(cache.get('f2')).toBe(952)
    expect(first.map((c) => c.index)).toContain(2)
  })

  it('counts only tagged tiles: the popover marker beside the chip is not a cell', () => {
    const cache = new Map<string | number, number>()
    const first = headerFoldedCells(band([], { keyed: true }), true, cache).map((c) => c.index)
    const again = headerFoldedCells(band(first, { keyed: true, marker: true }), true, cache)
    expect(again.map((c) => c.index)).toEqual(first)
    expect(again.every((c) => c.index < DENSE.length)).toBe(true)
  })
})

describe('headerChangedCells — which remembered widths a mutation makes stale', () => {
  it('names a visible cell whose content changed, by its tile key', () => {
    const g = band([], { keyed: true })
    const value = g.children[1].querySelector('[data-header-value]') as HTMLElement
    const records = [
      { target: value.firstChild, type: 'characterData' }
    ] as unknown as MutationRecord[]
    expect(headerChangedCells(g, records)).toEqual(['f1'])
  })

  it('ignores changes inside a folded cell, the chip, and the group itself', () => {
    const g = band([2, 9], { keyed: true })
    const inWidget = g.children[2].querySelector('[data-header-value]') as HTMLElement
    const chip = g.querySelector('[data-header-more]') as HTMLElement
    const records = [
      { target: inWidget, type: 'childList' },
      { target: chip, type: 'childList' },
      { target: g, type: 'childList' }
    ] as unknown as MutationRecord[]
    expect(headerChangedCells(g, records)).toEqual([])
  })
})
