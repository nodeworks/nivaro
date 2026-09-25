import { describe, expect, it } from 'vitest'
import { headerFoldedCells, headerNeedsDense } from '../header-strip'

// A tiny DOM stand-in: the packer only reads children, a few attributes,
// getBoundingClientRect().width, clientWidth and label/value text.
type FakeCell = {
  width: number
  label: string
  value?: string
  empty?: boolean
  money?: boolean
  attrs?: string[]
}

function el(cell: FakeCell) {
  const attrs = new Set(cell.attrs ?? [])
  if (cell.empty) attrs.add('data-empty')
  if (cell.money) attrs.add('data-header-money')
  const label = { textContent: cell.label, scrollWidth: cell.label.length * 6 }
  const value = { textContent: cell.value ?? '—', scrollWidth: (cell.value ?? '—').length * 7 }
  const node = {
    hasAttribute: (a: string) => attrs.has(a),
    matches: (sel: string) => (sel.includes('data-empty') ? cell.empty === true : false),
    getBoundingClientRect: () => ({ width: cell.width }),
    querySelector: (sel: string) => {
      if (sel.includes('data-header-label')) return label
      if (sel.includes('data-header-value')) return value
      if (sel.includes('data-empty')) return cell.empty ? node : null
      if (sel.includes('data-header-money')) return null
      return null
    },
    querySelectorAll: (sel: string) =>
      sel.includes('data-header-value') ? [value] : sel.includes('data-header-label') ? [label] : []
  }
  return node
}

function group(cells: FakeCell[], clientWidth: number) {
  const children = cells.map(el)
  return {
    children,
    clientWidth,
    querySelector: (sel: string) =>
      sel.includes('data-header-tail')
        ? (children.find((c) => c.hasAttribute('data-header-tail')) ?? null)
        : null
  } as unknown as HTMLElement
}

describe('headerFoldedCells — the two-row cap', () => {
  it('folds nothing when two rows hold everything', () => {
    const g = group(
      [
        { width: 300, label: 'A', value: '1' },
        { width: 300, label: 'B', value: '2' },
        { width: 300, label: 'C', value: '3' }
      ],
      600
    )
    expect(headerFoldedCells(g, true, new Map())).toEqual([])
  })

  it('folds empties first, right to left, before any populated cell', () => {
    const g = group(
      [
        { width: 200, label: 'Requisition', value: '$1', money: true },
        { width: 200, label: 'LinX ID', empty: true },
        { width: 200, label: 'Status', value: 'Open' },
        { width: 200, label: 'MWF ID', empty: true },
        { width: 200, label: 'Unallocated', value: '$2', money: true }
      ],
      450
    )
    // 5 × 200 needs 3 rows of 450; chip ≈ 96. Folding both empties leaves
    // 3 cells + chip = 696 → two rows.
    const folded = headerFoldedCells(g, true, new Map())
    expect(folded.map((c) => c.label)).toEqual(['LinX ID', 'MWF ID'])
    expect(folded.every((c) => c.empty)).toBe(true)
  })

  it('then folds text before money', () => {
    const g = group(
      [
        { width: 300, label: 'Requisition', value: '$1', money: true },
        { width: 300, label: 'Status', value: 'Open' },
        { width: 300, label: 'Creator', value: 'Ann' },
        { width: 300, label: 'Unallocated', value: '$2', money: true }
      ],
      320
    )
    // One cell per row: two rows = one cell + chip row … fold until two rows.
    const folded = headerFoldedCells(g, true, new Map())
    const labels = folded.map((c) => c.label)
    expect(labels).not.toContain('Requisition')
    expect(labels.indexOf('Creator')).toBeGreaterThanOrEqual(0)
    expect(labels.indexOf('Status')).toBeGreaterThanOrEqual(0)
  })

  it('remembers a shown cell width so folding it does not change the decision', () => {
    const cache = new Map<number, number>()
    const cells: FakeCell[] = [
      { width: 240, label: 'A', value: '1' },
      { width: 240, label: 'B', value: '2' },
      { width: 240, label: 'C', value: '3' },
      { width: 240, label: 'D', value: '4' },
      { width: 240, label: 'E', value: '5' }
    ]
    // Two per row: A B / C D / E → fold E, then D so the chip fits row 2.
    const first = headerFoldedCells(group(cells, 500), true, cache)
    expect(first.map((c) => c.index)).toEqual([3, 4])
    // Now D and E are folded: their wrappers measure 0, but the cache still says 240.
    const again = headerFoldedCells(
      group(
        cells.map((c, i) => (i >= 3 ? { ...c, width: 0, attrs: ['data-header-folded'] } : c)),
        500
      ),
      true,
      cache
    )
    expect(again.map((c) => c.index)).toEqual([3, 4])
  })
})

describe('headerNeedsDense', () => {
  it('measures the rendered stacked tiles and flips when they exceed the row', () => {
    const cache = new Map<number, number>()
    const wide = group(
      [
        { width: 300, label: 'A', value: '1' },
        { width: 300, label: 'B', value: '2' }
      ],
      500
    )
    expect(headerNeedsDense(wide, false, cache)).toBe(true)
    expect(cache.get(0)).toBe(300)
    // Dense now: remembered stacked widths decide, not the (narrower) dense cells.
    const dense = group(
      [
        { width: 200, label: 'A', value: '1' },
        { width: 200, label: 'B', value: '2' }
      ],
      500
    )
    expect(headerNeedsDense(dense, true, cache)).toBe(true)
    // Enough room again (with hysteresis) → back to stacked.
    expect(
      headerNeedsDense(group([{ width: 200, label: 'A', value: '1' }], 500), true, cache)
    ).toBe(false)
  })
})
