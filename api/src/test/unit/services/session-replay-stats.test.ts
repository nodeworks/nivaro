import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #1358 — active time folded chunk by chunk: gaps between input / mutation
 * events, each capped at 5 s, continued across chunk boundaries via the row.
 */

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  fail: false
}))

vi.mock('../../../db/index.js', () => {
  const db = vi.fn(() => {
    const chain: Record<string, unknown> = {}
    chain.where = vi.fn(() => chain)
    chain.first = vi.fn(async () => {
      if (h.fail) throw new Error('Invalid column name active_ms')
      return h.row
    })
    chain.update = vi.fn(async (patch: Record<string, unknown>) => {
      h.updates.push(patch)
      return 1
    })
    return chain
  })
  return { db }
})

import {
  foldActiveTime,
  isActivityEvent,
  recordChunkStats
} from '../../../services/session-replay-stats.js'

const mutation = (t: number) => ({ type: 3, timestamp: t, data: { source: 0 } })
const input = (t: number) => ({ type: 3, timestamp: t, data: { source: 5 } })
const canvas = (t: number) => ({ type: 3, timestamp: t, data: { source: 9 } })
const custom = (t: number) => ({ type: 5, timestamp: t, data: { tag: 'console' } })

beforeEach(() => {
  h.row = { active_ms: null, active_last_ts: null }
  h.updates = []
  h.fail = false
})

describe('isActivityEvent', () => {
  it('counts mutations, input and snapshots; not canvas churn or custom events', () => {
    expect(isActivityEvent(mutation(1))).toBe(true)
    expect(isActivityEvent(input(1))).toBe(true)
    expect(isActivityEvent({ type: 2, timestamp: 1 })).toBe(true)
    expect(isActivityEvent(canvas(1))).toBe(false)
    expect(isActivityEvent(custom(1))).toBe(false)
    expect(isActivityEvent(null)).toBe(false)
    expect(isActivityEvent({ type: 3, data: { source: 0 } })).toBe(false)
  })
})

describe('foldActiveTime', () => {
  it('sums gaps and caps each at 5 s', () => {
    const s = foldActiveTime({ activeMs: 0, lastTs: null }, [
      mutation(1_000),
      input(3_000), // +2 s
      input(63_000), // +5 s (60 s idle, capped)
      mutation(64_000) // +1 s
    ])
    expect(s).toEqual({ activeMs: 8_000, lastTs: 64_000 })
  })

  it('ignores non-activity events and sorts out-of-order ones', () => {
    const s = foldActiveTime({ activeMs: 0, lastTs: null }, [
      input(4_000),
      canvas(2_000),
      custom(2_500),
      mutation(1_000)
    ])
    expect(s).toEqual({ activeMs: 3_000, lastTs: 4_000 })
  })

  it('continues across chunks from the stored last timestamp', () => {
    const a = foldActiveTime({ activeMs: 0, lastTs: null }, [mutation(0), mutation(2_000)])
    const b = foldActiveTime(a, [input(3_000), input(30_000)])
    expect(b).toEqual({ activeMs: 2_000 + 1_000 + 5_000, lastTs: 30_000 })
    // A retried / overlapping event at or before lastTs adds nothing.
    expect(foldActiveTime(b, [input(29_000)])).toEqual(b)
  })
})

describe('recordChunkStats', () => {
  it('writes the folded state back onto the row', async () => {
    h.row = { active_ms: 1_000, active_last_ts: '10000' } // bigint arrives as a string
    await recordChunkStats('R1', [input(12_000), input(20_000)])
    expect(h.updates).toEqual([{ active_ms: 1_000 + 2_000 + 5_000, active_last_ts: 20_000 }])
  })

  it('never throws — a missing column only loses the stat', async () => {
    h.fail = true
    await expect(recordChunkStats('R1', [input(1)])).resolves.toBeUndefined()
    expect(h.updates).toEqual([])
  })

  it('does nothing for a recording that is gone', async () => {
    h.row = null
    await recordChunkStats('R1', [input(1)])
    expect(h.updates).toEqual([])
  })
})
