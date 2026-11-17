// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  HEADER_MORE_ROW_KEY,
  headerChangedCells,
  headerEstimateDenseWidth,
  headerFoldedCells,
  headerFoldPlan,
  headerPackRows
} from './header-strip'

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

/** Four 300px money tiles then the widget, in a 1006px band: rows pack
 *  A B C | D, and the widget (952 measured) fits no row, so it folds — but
 *  costed at its text estimate (658) it WOULD fit beside D. A fold that lost
 *  the measured width unfolds, refolds, and loops. */
function budgetBand(folded: Array<string | number>): HTMLElement {
  const group = document.createElement('div')
  Object.defineProperty(group, 'clientWidth', { value: 1006 })
  for (const k of ['a', 'b', 'c', 'd']) {
    const t = pair(k, '$1.00', 200, 40)
    t.setAttribute('data-header-money', '')
    t.setAttribute('data-header-cell', k)
    W.set(t, 300)
    group.append(t)
  }
  const w = widget()
  w.setAttribute('data-header-cell', 'budget')
  if (folded.includes('budget')) w.setAttribute('data-header-folded', '')
  else W.set(w, 952)
  group.append(w)
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
    const first = headerFoldedCells(budgetBand([]), true, cache).map((c) => c.key)
    expect(first).toEqual(['budget']) // the widget must fold at this width
    const second = headerFoldedCells(budgetBand(first), true, cache)
    expect(second.map((c) => c.key)).toEqual(first)
    // The popover marker beside the chip is not a cell.
    expect(second.every((c) => c.index < 5)).toBe(true)
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

describe('headerPackRows — first fit fills the room a wide tile leaves', () => {
  it('in order, a wide tile that misses row one strands the room beside it', () => {
    // The staging demo record: two tiles, the 980px budget widget, then narrow ones.
    const widths = [250, 215, 980, 190, 160, 150]
    expect(headerPackRows(widths, 1440, 96, 0, false).count).toBe(3)
    const ff = headerPackRows(widths, 1440, 96, 0, true)
    expect(ff.count).toBe(2)
    // Unallocated (190) and the rest go up beside the first two.
    expect(ff.rowOf).toEqual([0, 0, 1, 0, 0, 0])
  })

  it('the inline dock always ends the last row', () => {
    const r = headerPackRows([600, 600], 1000, 96, 300, true)
    expect(r.count).toBe(2)
    expect(headerPackRows([600, 600], 1000, 96, 500, true).count).toBe(3)
  })
})

describe('headerFoldPlan — first fit folds less, and never a pinned cell', () => {
  /** The demo record at 1440px: 2 tiles, the widget, then 9 text tiles. */
  function demoBand(width = 1440, budget = 980): HTMLElement {
    const group = document.createElement('div')
    Object.defineProperty(group, 'clientWidth', { value: width })
    const add = (key: string, w: number, money = false) => {
      const t = pair(key, 'value', w - 76, 40)
      t.setAttribute('data-header-cell', key)
      if (money) t.setAttribute('data-header-money', '')
      W.set(t, w)
      group.append(t)
      return t
    }
    add('requisition', 250, true)
    add('left', 215, true)
    add('budget', budget, true)
    add('unallocated', 190, true)
    for (let i = 0; i < 7; i++) add(`text${i}`, 160)
    add('__owners__', 170).setAttribute('data-header-pin', '')
    return group
  }

  it('packs later tiles beside the first two instead of folding them', () => {
    const plan = headerFoldPlan(demoBand(), true, new Map())
    // In order: requisition, left | budget, unallocated, … — 8 folded.
    // First fit: everything that fits beside requisition + left goes up.
    expect(plan.folded.length).toBeLessThanOrEqual(2)
    expect(plan.rows?.requisition).toBe(0)
    expect(plan.rows?.budget).toBe(1)
    expect(plan.rows?.unallocated).toBe(0)
    if (plan.folded.length) expect(plan.rows?.[HEADER_MORE_ROW_KEY]).toBeGreaterThanOrEqual(0)
  })

  it('a pinned cell never folds', () => {
    const plan = headerFoldPlan(demoBand(700), true, new Map())
    expect(plan.folded.length).toBeGreaterThan(0)
    expect(plan.folded.map((c) => c.key)).not.toContain('__owners__')
  })

  it('folds a cell wider than the band instead of clipping it on a row of its own', () => {
    // PW26-71393 at 1250px (2026-11-16, measured): the band is 774px beside
    // the lg dock and the five-figure budget widget renders 985px. Given a
    // row to itself it was cut at the band's edge ("$320,012.4"): no row
    // can show it whole, so it folds, money or not.
    const group = document.createElement('div')
    Object.defineProperty(group, 'clientWidth', { value: 774 })
    const add = (key: string, w: number, money = false) => {
      const t = pair(key, 'value', w - 76, 40)
      t.setAttribute('data-header-cell', key)
      if (money) t.setAttribute('data-header-money', '')
      W.set(t, w)
      group.append(t)
      return t
    }
    add('requisition_amount', 270, true)
    add('forecast_left', 199, true)
    add('__widget_1__', 985, true)
    add('__owners__', 96).setAttribute('data-header-pin', '')
    for (const [k, w] of [
      ['nuvolo_id', 208],
      ['nuvolo_payment_status', 283],
      ['forecast_status_label', 224],
      ['purchase_orders', 247],
      ['creator', 227],
      ['__summary__workflow_lines', 216]
    ] as const)
      add(k, w)
    const plan = headerFoldPlan(group, true, new Map())
    expect(plan.folded.map((c) => c.key)).toContain('__widget_1__')
    // Every cell still shown fits its row whole, chip included.
    const shown = new Map(
      [
        'requisition_amount',
        'forecast_left',
        '__owners__',
        'nuvolo_id',
        'nuvolo_payment_status',
        'forecast_status_label',
        'purchase_orders',
        'creator',
        '__summary__workflow_lines'
      ].map((k) => [k, W.get(group.querySelector(`[data-header-cell="${k}"]`) as Element) ?? 0])
    )
    const used: number[] = []
    for (const [k, r] of Object.entries(plan.rows ?? {})) {
      if (plan.folded.some((c) => c.key === k)) continue
      used[r] = (used[r] ?? 0) + (k === HEADER_MORE_ROW_KEY ? 96 : (shown.get(k) ?? 0))
    }
    expect(used.length).toBeLessThanOrEqual(2)
    for (const u of used) expect(u).toBeLessThanOrEqual(774)
    // Folding the widget frees room: the text tiles go up instead of folding.
    expect(plan.folded.length).toBeLessThan(6)
    // A fixed point: re-deciding with the widget folded keeps it folded.
    const cache = new Map<string | number, number>()
    headerFoldPlan(group, true, cache)
    group.querySelector('[data-header-cell="__widget_1__"]')?.setAttribute('data-header-folded', '')
    expect(headerFoldPlan(group, true, cache).folded.map((c) => c.key)).toContain('__widget_1__')
  })

  it('a band where only an over-wide cell overflows keeps layout order', () => {
    const group = document.createElement('div')
    Object.defineProperty(group, 'clientWidth', { value: 774 })
    for (const [k, w] of [
      ['a', 270],
      ['wide', 985],
      ['b', 199]
    ] as const) {
      const t = pair(k, '$1.00', w - 76, 40)
      t.setAttribute('data-header-cell', k)
      W.set(t, w)
      group.append(t)
    }
    const plan = headerFoldPlan(group, true, new Map())
    expect(plan.folded.map((c) => c.key)).toEqual(['wide'])
    expect(plan.rows).toBeNull()
  })

  it('keeps layout order (no rows) when the band fits in order', () => {
    const plan = headerFoldPlan(demoBand(2400, 300), true, new Map())
    expect(plan).toEqual({ folded: [], rows: null })
  })
})

describe('foldedListOrder', () => {
  it('lists money first, then filled fields, empty ones last, layout order within each', async () => {
    const { foldedListOrder } = await import('./header-strip')
    const cells = [
      { index: 3, key: 'priority', label: 'Priority', empty: true },
      { index: 4, key: 'mwf', label: 'MWF ID', empty: true },
      { index: 5, key: 'budget', label: 'Budget', empty: false, money: true },
      { index: 6, key: 'creator', label: 'Creator', empty: false },
      { index: 7, key: 'unalloc', label: 'Unallocated', empty: false, money: true }
    ]
    expect(foldedListOrder(cells).map((c) => c.key)).toEqual([
      'budget',
      'unalloc',
      'creator',
      'priority',
      'mwf'
    ])
  })
})
