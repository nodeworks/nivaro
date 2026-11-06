import { describe, expect, it } from 'vitest'
import { ROW_WRITE_CONCURRENCY, runPooled } from './requirement-side-effects'

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
