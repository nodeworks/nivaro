import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  currentRuleValues,
  nextMetricCatchUp,
  overdueMetricCheckJobs,
  resetCurrentRuleValues
} from '../../../services/metric-alerts.js'

const viewer = { user: { id: 'u-virginia' } as never, isAdmin: false }
const source = JSON.stringify({ type: 'custom_query', slug: 'efp-alert-invoices-past-due' })

// Army 8 b16 / b11: an open alert showed the all-zones reading from its first
// fire to a zone-restricted person, 18 hours later.
describe('currentRuleValues', () => {
  afterEach(() => resetCurrentRuleValues())

  it('reads each open rule AS the viewer, with the rule’s own filters', async () => {
    const resolve = vi.fn(async () => 140)
    const out = await currentRuleValues(
      [{ rule_id: 5, metric_source: source, filters: '{"divisions":["Zone 1"]}' }],
      viewer,
      { resolve: resolve as never }
    )
    expect(out.get(5)).toBe(140)
    expect(resolve).toHaveBeenCalledWith(
      { type: 'custom_query', slug: 'efp-alert-invoices-past-due' },
      { divisions: ['Zone 1'] },
      viewer
    )
  })

  it('reuses a reading for five minutes per person (longer than the 2-minute poll), then reads again', async () => {
    const resolve = vi.fn(async () => 140)
    const rule = [{ rule_id: 5, metric_source: source, filters: null }]
    await currentRuleValues(rule, viewer, { resolve: resolve as never, now: 1_000 })
    await currentRuleValues(rule, viewer, { resolve: resolve as never, now: 60_000 })
    expect(resolve).toHaveBeenCalledTimes(1)
    await currentRuleValues(
      rule,
      { ...viewer, user: { id: 'u-other' } as never },
      {
        resolve: resolve as never,
        now: 60_000
      }
    )
    expect(resolve).toHaveBeenCalledTimes(2)
    // The widget's next poll (2 min later) is still answered from the cache.
    await currentRuleValues(rule, viewer, { resolve: resolve as never, now: 200_000 })
    expect(resolve).toHaveBeenCalledTimes(2)
    await currentRuleValues(rule, viewer, { resolve: resolve as never, now: 400_000 })
    expect(resolve).toHaveBeenCalledTimes(3)
  })

  it('answers null when the source is unreadable or the read fails — never the stored value', async () => {
    const out = await currentRuleValues(
      [
        { rule_id: 1, metric_source: 'not json', filters: null },
        { rule_id: 2, metric_source: source, filters: null }
      ],
      viewer,
      { resolve: (async () => Promise.reject(new Error('403'))) as never }
    )
    expect(out.get(1)).toBeNull()
    expect(out.get(2)).toBeNull()
  })
})

// Army 8 review M6: up to 10 custom queries ran one after another, ungated, on every poll.
describe('currentRuleValues — bounded and budgeted', () => {
  afterEach(() => resetCurrentRuleValues())
  const rules = Array.from({ length: 6 }, (_, i) => ({
    rule_id: i + 1,
    metric_source: source,
    filters: null
  }))

  it('resolves misses concurrently, never more than `concurrency` at once', async () => {
    let running = 0
    let peak = 0
    const resolve = vi.fn(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return 7
    })
    const out = await currentRuleValues(rules, viewer, {
      resolve: resolve as never,
      concurrency: 3
    })
    expect(resolve).toHaveBeenCalledTimes(6)
    expect(peak).toBe(3)
    expect([...out.values()]).toEqual([7, 7, 7, 7, 7, 7])
  })

  it('past the budget a rule answers null; a late reading still fills the cache', async () => {
    let release: (v: number) => void = () => {}
    const slow = new Promise<number>((r) => {
      release = r
    })
    const resolve = vi.fn(async (_s: unknown, _f: unknown) => slow)
    const rule = [{ rule_id: 9, metric_source: source, filters: null }]
    const out = await currentRuleValues(rule, viewer, {
      resolve: resolve as never,
      budgetMs: 10,
      now: 1_000
    })
    expect(out.get(9)).toBeNull()
    release(42)
    await slow
    await new Promise((r) => setTimeout(r, 0))
    const again = await currentRuleValues(rule, viewer, {
      resolve: resolve as never,
      now: 2_000
    })
    expect(again.get(9)).toBe(42)
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})

describe('overdueMetricCheckJobs', () => {
  const now = Date.parse('2026-11-07T19:05:00Z')
  it('a daily check with no run in 25 hours is overdue; a recent one is not', () => {
    expect(
      overdueMetricCheckJobs(
        new Map([
          ['metric-alerts-daily', '2026-11-06T19:00:00Z'],
          ['metric-alerts-weekly', '2026-11-02T11:35:00Z']
        ]),
        now
      )
    ).toEqual([])
    expect(
      overdueMetricCheckJobs(
        new Map([
          ['metric-alerts-daily', '2026-11-05T11:35:00Z'],
          ['metric-alerts-weekly', '2026-11-02T11:35:00Z']
        ]),
        now
      )
    ).toEqual(['daily'])
  })
  it('a job that never ran is overdue', () => {
    expect(overdueMetricCheckJobs(new Map(), now)).toEqual(['daily', 'weekly'])
  })
  it('a weekly check is overdue a week and an hour after its last run', () => {
    expect(
      overdueMetricCheckJobs(
        new Map([
          ['metric-alerts-daily', '2026-11-07T11:35:00Z'],
          ['metric-alerts-weekly', '2026-10-31T11:35:00Z']
        ]),
        now
      )
    ).toEqual(['weekly'])
  })
})

// Army 8 review: a failing daily check was retried by every hourly tick (24 a day), and the
// first tick after a deploy with no history ran the daily AND weekly checks together.
describe('nextMetricCatchUp', () => {
  const now = Date.parse('2026-11-07T19:05:00Z')
  const daily = 'metric-alerts-daily'
  const weekly = 'metric-alerts-weekly'
  it('no history at all: one catch-up per tick, daily first', () => {
    expect(nextMetricCatchUp(new Map(), new Map(), now)).toBe('daily')
    expect(
      nextMetricCatchUp(
        new Map([[daily, '2026-11-07T18:05:00Z']]),
        new Map([[daily, '2026-11-07T18:05:00Z']]),
        now
      )
    ).toBe('weekly')
  })
  it('a failed attempt is not retried for six hours', () => {
    const completed = new Map([
      [daily, '2026-11-05T11:35:00Z'],
      [weekly, '2026-11-02T11:35:00Z']
    ])
    expect(nextMetricCatchUp(completed, new Map([[daily, '2026-11-07T15:05:00Z']]), now)).toBeNull()
    expect(nextMetricCatchUp(completed, new Map([[daily, '2026-11-07T12:00:00Z']]), now)).toBe(
      'daily'
    )
  })
  it('backoff never hides a fresh success, and nothing is overdue when both are recent', () => {
    expect(
      overdueMetricCheckJobs(
        new Map([
          [daily, '2026-11-07T11:35:00Z'],
          [weekly, '2026-11-02T11:35:00Z']
        ]),
        now,
        new Map([[daily, '2026-11-07T11:35:00Z']])
      )
    ).toEqual([])
  })
})
