import { describe, expect, it } from 'vitest'
import { firstAtOrAfter, pruneWindow } from '../../../services/pool-attribution.js'

describe('pool wait window prune', () => {
  it('drops exactly the entries before the cutoff', () => {
    const list = [1, 2, 3, 4, 5].map((at) => ({ at }))
    expect(firstAtOrAfter(list, 3)).toBe(2)
    pruneWindow(list, 3, 100)
    expect(list.map((x) => x.at)).toEqual([3, 4, 5])
    pruneWindow(list, 0, 100)
    expect(list).toHaveLength(3)
    pruneWindow(list, 99, 100)
    expect(list).toHaveLength(0)
  })

  it('keeps only the newest `max` entries', () => {
    const list = Array.from({ length: 10 }, (_, i) => ({ at: i }))
    pruneWindow(list, 0, 4)
    expect(list.map((x) => x.at)).toEqual([6, 7, 8, 9])
  })

  it('prunes a post-import backlog fast (the shift() loop froze the worker)', () => {
    const list = Array.from({ length: 300_000 }, (_, i) => ({ at: i, ms: 1 }))
    const t0 = performance.now()
    for (let cut = 0; cut <= 300_000; cut += 5_000) pruneWindow(list, cut, Number.MAX_SAFE_INTEGER)
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect(list).toHaveLength(0)
  })
})
