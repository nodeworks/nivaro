import { describe, expect, it } from 'vitest'
import { canonRow, canonRows, multisetDiff } from '../../../../services/db-tuning/canon.js'

describe('canon', () => {
  it('is column-order independent and normalises numerics', () => {
    expect(canonRow({ b: '2.5000', a: 1 })).toBe(canonRow({ a: 1.0, b: 2.5 }))
  })
  it('drops elapsed-time style columns', () => {
    expect(canonRow({ id: 1, elapsed_ms: 40 })).toBe(canonRow({ id: 1, elapsed_ms: 9999 }))
    expect(canonRow({ id: 1, age_days: 3 })).toBe(canonRow({ id: 1, age_days: 4 }))
  })
  it('keeps dates as ISO and treats null and undefined alike', () => {
    expect(canonRow({ d: new Date('2026-01-02T03:04:05Z'), x: null })).toBe(
      canonRow({ d: '2026-01-02T03:04:05.000Z', x: undefined })
    )
  })
  it('multiset diff counts duplicates', () => {
    const a = canonRows([{ k: 1 }, { k: 1 }, { k: 2 }])
    const b = canonRows([{ k: 1 }, { k: 2 }, { k: 3 }])
    const d = multisetDiff(a, b)
    expect(d.removed).toEqual([canonRow({ k: 1 })])
    expect(d.added).toEqual([canonRow({ k: 3 })])
  })
  it('identical multisets diff empty', () => {
    const a = canonRows([{ k: 1 }, { k: 2 }])
    expect(multisetDiff(a, [...a].reverse())).toEqual({ added: [], removed: [] })
  })
})
