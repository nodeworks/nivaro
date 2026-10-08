import { describe, expect, it } from 'vitest'
import { buildReportTree, treeRatio } from './report-tree'

const cfg = { levels: ['group', 'item'], pct: { num: 'remaining', den: 'budget' } }

describe('buildReportTree', () => {
  it('reads null, not zero, when no row carries the figures', () => {
    const rows = [
      { group: 'A', item: 'one', budget: 100, remaining: null },
      { group: 'A', item: 'two', budget: 50, remaining: null }
    ]
    const [a] = buildReportTree(rows, cfg, ['budget', 'remaining'])
    expect(a.sums.budget).toBe(150)
    expect(a.sums.remaining).toBeNull()
    expect(a.pct).toBeNull()
    expect(a.children.every((c) => c.pct === null)).toBe(true)
  })

  it('weights the ratio over the rows carrying both operands only', () => {
    const rows = [
      { group: 'A', item: 'one', budget: 100, remaining: 40 },
      { group: 'A', item: 'two', budget: 300, remaining: 60 },
      // no remaining figure: must not dilute the denominator
      { group: 'A', item: 'three', budget: 1000, remaining: null }
    ]
    const [a] = buildReportTree(rows, cfg, ['remaining', 'budget'])
    expect(a.pct).toBe(25)
    expect(a.sums.budget).toBe(1400)
    expect(a.sums.remaining).toBe(100)
    const three = a.children.find((c) => c.label === 'three')
    expect(three?.pct).toBeNull()
    // a group without the leading figure sorts last
    expect(a.children.map((c) => c.label)).toEqual(['two', 'one', 'three'])
  })

  it('keeps a negative remaining figure negative', () => {
    const rows = [
      { group: 'A', item: 'one', budget: 200, remaining: -50 },
      { group: 'A', item: 'two', budget: 200, remaining: 10 }
    ]
    const [a] = buildReportTree(rows, cfg, ['remaining'])
    expect(a.sums.remaining).toBe(-40)
    expect(a.pct).toBe(-10)
  })

  it('reads string figures and ignores blanks', () => {
    expect(
      treeRatio(
        [
          { remaining: '25', budget: '100' },
          { remaining: '', budget: '900' }
        ],
        cfg.pct
      )
    ).toBe(25)
  })

  it('reads null for a zero denominator', () => {
    expect(treeRatio([{ remaining: 5, budget: 0 }], cfg.pct)).toBeNull()
  })
})
