import { describe, expect, it } from 'vitest'
import { railOverflow } from './OverflowRail'

const items = [
  { key: 'refresh', priority: 60 },
  { key: 'copy', priority: 25 },
  { key: 'group', priority: 52 },
  { key: 'columns', priority: 62 },
  { key: 'export', priority: 65 }
]
const widths = new Map([
  ['refresh', 32],
  ['copy', 32],
  ['group', 70],
  ['columns', 80],
  ['export', 70]
])

describe('railOverflow', () => {
  it('keeps everything on the line when it fits (each item + one gap)', () => {
    // 32+32+70+80+70 = 284, + 5 gaps of 8 = 324
    expect([...railOverflow(items, widths, 324, 8)]).toEqual([])
  })

  it('moves the lowest priority out first, making room for the ⋯ button', () => {
    // 323 is one short: drop copy (40) → 284, + ⋯ (32 + 8) = 324 > 323 → also drop group (78)
    expect([...railOverflow(items, widths, 323, 8)].sort()).toEqual(['copy', 'group'])
  })

  it('collapses everything when there is almost no room', () => {
    expect(railOverflow(items, widths, 40, 8).size).toBe(5)
  })

  it('never moves an item that renders nothing (width 0)', () => {
    const w = new Map(widths)
    w.set('copy', 0)
    const out = railOverflow(items, w, 100, 8)
    expect(out.has('copy')).toBe(false)
  })

  it('assumes a width for an item never measured', () => {
    const out = railOverflow([{ key: 'new', priority: 1 }], new Map(), 50, 8)
    expect(out.has('new')).toBe(true)
  })
})
