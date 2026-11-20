import { describe, expect, it } from 'vitest'
import { autoSweepWidth, runWithWidth } from '../../../services/auto-sweep-width.js'

describe('auto-sweep width (AUTO_SWEEP_CONCURRENCY)', () => {
  it('is 1 unless set, and stays within 1–6', () => {
    expect(autoSweepWidth({})).toBe(1)
    expect(autoSweepWidth({ AUTO_SWEEP_CONCURRENCY: '' })).toBe(1)
    expect(autoSweepWidth({ AUTO_SWEEP_CONCURRENCY: '3' })).toBe(3)
    expect(autoSweepWidth({ AUTO_SWEEP_CONCURRENCY: '2.7' })).toBe(2)
    expect(autoSweepWidth({ AUTO_SWEEP_CONCURRENCY: '0' })).toBe(1)
    expect(autoSweepWidth({ AUTO_SWEEP_CONCURRENCY: 'many' })).toBe(1)
    expect(autoSweepWidth({ AUTO_SWEEP_CONCURRENCY: '50' })).toBe(6)
  })
})

describe('runWithWidth', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5))

  it('never runs more than the width at once and covers every item in order', async () => {
    let running = 0
    let peak = 0
    const started: number[] = []
    await runWithWidth([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      started.push(n)
      running++
      peak = Math.max(peak, running)
      await tick()
      running--
    })
    expect(peak).toBe(3)
    expect(started).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('width 1 is one at a time, as the sweep always ran', async () => {
    let running = 0
    let peak = 0
    await runWithWidth([1, 2, 3], 1, async () => {
      running++
      peak = Math.max(peak, running)
      await tick()
      running--
    })
    expect(peak).toBe(1)
  })

  it('a failing item is reported and the rest still run', async () => {
    const done: number[] = []
    const failed: number[] = []
    await runWithWidth(
      [1, 2, 3, 4],
      2,
      async (n) => {
        if (n === 2) throw new Error('partner refused')
        done.push(n)
      },
      (_err, n) => failed.push(n)
    )
    expect(done.sort()).toEqual([1, 3, 4])
    expect(failed).toEqual([2])
  })

  it('an empty list does nothing', async () => {
    let calls = 0
    await runWithWidth([], 3, async () => {
      calls++
    })
    expect(calls).toBe(0)
  })
})
