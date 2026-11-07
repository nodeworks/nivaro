import { describe, expect, it } from 'vitest'
import {
  overwrittenBySideEffect,
  ROW_WRITE_CONCURRENCY,
  runPooled
} from './requirement-side-effects'

// REVIEW-R5 M5: a Submit with 40–80 lines rehearsed (and wrote) every line at
// once — one transaction each on the main pool from one click.
describe('runPooled', () => {
  it('40 rows → at most 5 in flight, results in task order', async () => {
    let inFlight = 0
    let peak = 0
    const tasks = Array.from({ length: 40 }, (_, i) => async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1 + (i % 3)))
      inFlight--
      return i
    })
    const out = await runPooled(tasks)
    expect(ROW_WRITE_CONCURRENCY).toBe(5)
    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBe(5)
    expect(out).toEqual(Array.from({ length: 40 }, (_, i) => i))
  })

  it('handles no tasks and fewer tasks than the limit', async () => {
    expect(await runPooled([])).toEqual([])
    expect(await runPooled([async () => 'a', async () => 'b'])).toEqual(['a', 'b'])
  })
})

describe('overwrittenBySideEffect (army6 M2)', () => {
  const report = {
    ok: true,
    changes: [
      { field: 'changed', from: '2026-11-06T16:02:14.065Z', to: '2026-11-06T21:04:05.700Z' },
      { field: 'date_updated', from: '2026-11-06T16:02:14Z', to: '2026-11-06T21:04:05Z' },
      { field: 'internal_flag', from: 1, to: 2 },
      { field: 'price', from: 2, to: 1 },
      { field: 'category', from: 5, to: 6 }
    ]
  }

  it('never asks about the bookkeeping stamp, nor a column the dialog has no meta for', () => {
    const known = new Set(['price', 'category', 'quantity'])
    const out = overwrittenBySideEffect(report, { category: 6 }, (f) => known.has(f))
    expect(out.map((c) => c.field)).toEqual(['price'])
  })

  it('without a meta list it still skips audit columns', () => {
    const out = overwrittenBySideEffect(report, { category: 6 })
    expect(out.map((c) => c.field)).toEqual(['internal_flag', 'price'])
  })
})
