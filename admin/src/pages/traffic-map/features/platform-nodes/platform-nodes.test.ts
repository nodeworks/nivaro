import { describe, expect, it } from 'vitest'
import {
  bulkNodeId,
  bulkOf,
  fmtAge,
  fmtSaving,
  heapWarning,
  importSizeVerdict,
  missFor,
  type PlatformNodes,
  platformDownIds,
  queueBadgeText,
  queueNodeId,
  queueOf,
  storageLevel,
  tuningFor,
  tuningForTables
} from './logic'

const q = (over: Partial<PlatformNodes['work_queues'][number]> = {}) => ({
  id: 'import' as const,
  label: 'Staged import queue',
  link: '/imports',
  depth: 4,
  oldest_age_s: 400,
  drain_per_min: 1,
  eta_s: 240,
  retrying: 0,
  trend: 'flat' as const,
  level: 'warn' as const,
  reason: null,
  ...over
})
const data = (over: Partial<PlatformNodes> = {}): PlatformNodes => ({
  at: 0,
  work_queues: [q(), q({ id: 'outbox', depth: 0, drain_per_min: null })],
  bulk_runs: [
    {
      id: 9,
      job: 'bulk:orders',
      label: 'x',
      collection: 'orders',
      started_at: '2026-10-17T10:00:00Z',
      by: null,
      done: 1,
      failed: 0,
      total: null,
      per_s: null,
      pct: null
    }
  ],
  tuning: {
    total: 2,
    saving_ms_per_day: 9000,
    proposals: [
      {
        id: 'a',
        kind: 'index_create',
        target: 'orders.a',
        title: 'A',
        saving_ms_per_day: 9000,
        risk: 'reversible',
        entity: 'items/orders',
        table: 'orders'
      },
      {
        id: 'b',
        kind: 'proc_rewrite',
        target: 'usp',
        title: 'B',
        saving_ms_per_day: 0,
        risk: 'review',
        entity: null,
        table: null
      }
    ],
    by_entity: { 'items/orders': { count: 1, saving_ms_per_day: 9000, id: 'a' } }
  },
  cron_misses: {
    ticking: true,
    ready: true,
    misses: [{ id: 'sweep', expected_at: '2026-10-17T10:00:00Z', last_run_at: null, grace_min: 5 }]
  },
  ...over
})

describe('platform nodes — node ids and visibility', () => {
  it('draws a queue only when something waits or moved, and every running bulk action', () => {
    expect(platformDownIds(data())).toEqual([queueNodeId('import'), bulkNodeId(9)])
    expect(platformDownIds(null)).toEqual([])
  })
  it('finds the figures behind a node id', () => {
    expect(queueOf(data(), 'queue:import')?.depth).toBe(4)
    expect(queueOf(data(), 'queue:flows')).toBeNull()
    expect(queueOf(data(), 'db')).toBeNull()
    expect(bulkOf(data(), 'bulk:9')?.collection).toBe('orders')
    expect(bulkOf(data(), 'bulk:10')).toBeNull()
  })
})

describe('platform nodes — badges', () => {
  it('names a queue by what waits and whether it grows', () => {
    expect(queueBadgeText(q({ depth: 0 }))).toBe('drained')
    expect(queueBadgeText(q({ oldest_age_s: 30 }))).toBe('4 waiting')
    expect(queueBadgeText(q({ oldest_age_s: 400 }))).toBe('4 waiting · 7 min')
    expect(queueBadgeText(q({ trend: 'growing' }))).toBe('4 waiting · growing')
  })
  it('flags a missed run only where jobs tick', () => {
    expect(missFor(data(), 'cron:sweep')?.grace_min).toBe(5)
    expect(missFor(data(), 'cron:other')).toBeNull()
    expect(missFor(data(), 'flow:1')).toBeNull()
    expect(
      missFor(data({ cron_misses: { ticking: false, ready: true, misses: [] } }), 'cron:sweep')
    ).toBeNull()
  })
  it('finds tuning proposals by entity and by statement tables', () => {
    expect(tuningFor(data(), 'items/orders')?.count).toBe(1)
    expect(tuningFor(data(), 'items/other')).toBeNull()
    expect(tuningForTables(data(), ['[dbo].[Orders]']).map((p) => p.id)).toEqual(['a'])
    expect(tuningForTables(data(), ['customers'])).toEqual([])
    expect(tuningForTables(data(), [])).toEqual([])
  })
  it('rates a storage driver', () => {
    const ok = { n: 10, failed: 0, missing: 0, slow: 0, bytes: 0, p50_ms: 1, p95_ms: 2 }
    expect(storageLevel({ ops: { read: ok } })).toBe('ok')
    expect(storageLevel({ ops: { read: { ...ok, slow: 2 } } })).toBe('warn')
    expect(storageLevel({ ops: { read: { ...ok, failed: 1 } } })).toBe('error')
    expect(storageLevel({ ops: {} })).toBe('ok')
  })
})

describe('platform nodes — wording', () => {
  it('formats ages and savings', () => {
    expect(fmtAge(40)).toBe('40 s')
    expect(fmtAge(720)).toBe('12 min')
    expect(fmtAge(11_100)).toBe('3 h 05 min')
    expect(fmtAge(null)).toBe('—')
    expect(fmtSaving(30_000)).toBe('about 30 s a day')
    expect(fmtSaving(240_000)).toBe('about 4.0 min a day')
    expect(fmtSaving(0)).toBe('a small saving')
  })
  it('warns about a climbing heap only when it climbs', () => {
    const base = { points: 12, span_s: 900, slope_mb_per_min: 2.1, r2: 0.97, minutes_to_limit: 180 }
    expect(heapWarning({ ...base, growing: true })).toBe(
      'Growing 2.1 MB/min — about 3 h to the limit'
    )
    expect(heapWarning({ ...base, growing: true, minutes_to_limit: 45 })).toBe(
      'Growing 2.1 MB/min — about 45 min to the limit'
    )
    expect(heapWarning({ ...base, growing: false })).toBeNull()
    expect(heapWarning(undefined)).toBeNull()
  })
})

describe('platform nodes — import size', () => {
  const MB = 1024 * 1024
  it('says a slower run was a bigger file', () => {
    const v = importSizeVerdict([
      { bytes: 30 * MB, rows: 300_000, seconds: 300 },
      { bytes: 10 * MB, rows: 100_000, seconds: 100 },
      { bytes: 11 * MB, rows: 110_000, seconds: 112 },
      { bytes: 9 * MB, rows: 90_000, seconds: 90 }
    ])
    expect(v?.bigger).toBe(true)
    expect(v?.text).toMatch(/bigger file/)
  })
  it('says nothing when the file is the usual size, and flags a genuinely slow run', () => {
    const usual = [
      { bytes: 10 * MB, rows: 1, seconds: 100 },
      { bytes: 10 * MB, rows: 1, seconds: 100 },
      { bytes: 10 * MB, rows: 1, seconds: 100 }
    ]
    expect(
      importSizeVerdict([{ bytes: 10 * MB, rows: 1, seconds: 100 }, ...usual.slice(1)])
    ).toBeNull()
    const slow = importSizeVerdict([{ bytes: 10 * MB, rows: 1, seconds: 300 }, ...usual])
    expect(slow?.bigger).toBe(false)
    expect(importSizeVerdict([{ bytes: 10 * MB, rows: 1, seconds: 100 }])).toBeNull()
  })
})
