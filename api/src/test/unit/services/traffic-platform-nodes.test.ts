// api/src/test/unit/services/traffic-platform-nodes.test.ts — Traffic Map platform nodes:
// #2158 heap trend, #2164 storage node, #2265 database server resources, #2157 work queues,
// #2267 missed runs, #2271 bulk runs, #2199 tuning proposals
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['where', 'select', 'limit', 'orderBy', 'leftJoin', 'whereIn', 'count', 'min'])
    chain[m] = vi.fn(() => chain)
  const db = Object.assign(
    vi.fn(() => chain),
    { raw: vi.fn(async () => []), client: { on: vi.fn(), config: { client: 'mssql' } } }
  )
  return { db, _staticDb: db, dbRead: db }
})

import {
  currentMissedCrons,
  registerMissedCronProbe,
  resetMissedCronProbe
} from '../../../services/cron-misses.js'
import { instrumentStorage } from '../../../services/storage/instrument.js'
import {
  cpuFromRows,
  serverLevel,
  THRESHOLDS,
  type WaitTotals,
  waitRates
} from '../../../services/traffic-taps/db-server.js'
import {
  HEAP_MIN_POINTS,
  type HeapPoint,
  heapTrend
} from '../../../services/traffic-taps/node-health.js'
import {
  bulkRunFigures,
  depthTrend,
  queueFigures,
  queueVisible,
  tuningFigures,
  tuningTarget
} from '../../../services/traffic-taps/platform-nodes.js'
import {
  isMissingObject,
  noteStorageCall,
  STORAGE_SLOW_MS,
  scrubReason,
  storageLevel,
  storageNodeId,
  storageSnapshot
} from '../../../services/traffic-taps/storage.js'
import { resetTapState } from '../../../services/traffic-taps.js'

const climb = (n: number, startMb: number, perMin: number, gapS = 60): HeapPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    at: 1_000_000 + i * gapS,
    mb: startMb + (i * gapS * perMin) / 60
  }))

describe('#2158 heapTrend', () => {
  it('flags a steady climb', () => {
    const t = heapTrend(climb(12, 200, 2), 4000)
    expect(t.growing).toBe(true)
    expect(t.slope_mb_per_min).toBeCloseTo(2, 1)
    expect(t.r2).toBeGreaterThan(0.99)
    expect(t.minutes_to_limit).toBeGreaterThan(0)
  })
  it('does not flag a flat or sawtooth heap', () => {
    expect(heapTrend(climb(12, 200, 0), 4000).growing).toBe(false)
    const saw = Array.from({ length: 12 }, (_, i) => ({
      at: 1_000_000 + i * 60,
      mb: 200 + (i % 2 ? 40 : 0)
    }))
    expect(heapTrend(saw, 4000).growing).toBe(false)
  })
  it('needs enough points and enough time', () => {
    expect(heapTrend(climb(HEAP_MIN_POINTS - 1, 200, 5), 4000).growing).toBe(false)
    expect(heapTrend(climb(8, 200, 5, 10), 4000).growing).toBe(false) // 70 s only
    expect(heapTrend([], null).growing).toBe(false)
  })
  it('ignores a tiny slow drift', () => {
    expect(heapTrend(climb(12, 200, 0.1), 4000).growing).toBe(false)
  })
})

describe('#2265 database server resources', () => {
  const t0: WaitTotals = {
    data_io: 1000,
    log_io: 100,
    other_io: 0,
    locks: 50,
    signal: 10,
    total: 5000
  }
  it('turns cumulative waits into per-second rates', () => {
    const r = waitRates(t0, { ...t0, data_io: 3000, total: 9000 }, 10_000)
    expect(r?.data_io).toBe(200)
    expect(r?.total).toBe(400)
    expect(r?.log_io).toBe(0)
  })
  it('refuses a comparison across a restart or with no time', () => {
    expect(waitRates(t0, { ...t0, data_io: 5 }, 10_000)).toBeNull()
    expect(waitRates(t0, t0, 0)).toBeNull()
  })
  it('reads the CPU rows newest first', () => {
    const cpu = cpuFromRows([
      { sql_cpu: 80, idle: 10 },
      { sql_cpu: 40, idle: 50 }
    ])
    expect(cpu?.sql_pct).toBe(80)
    expect(cpu?.other_pct).toBe(10)
    expect(cpu?.series).toEqual([40, 80])
    expect(cpuFromRows([])).toBeNull()
  })
  it('judges the level with reasons', () => {
    expect(serverLevel({ cpu: null, waits: null, memory: null, tempdb: null }).level).toBe('ok')
    const hot = serverLevel({
      cpu: { sql_pct: THRESHOLDS.cpu_error, other_pct: 0, series: [] },
      waits: null,
      memory: null,
      tempdb: null
    })
    expect(hot.level).toBe('error')
    expect(hot.reasons[0]).toMatch(/CPU/)
    const mem = serverLevel({
      cpu: null,
      waits: null,
      memory: {
        grants_held: 3,
        grants_waiting: 1,
        granted_mb: 100,
        requested_mb: 200,
        max_wait_ms: 500,
        sql_used_mb: null,
        machine_total_mb: null,
        machine_free_mb: null
      },
      tempdb: {
        total_mb: 1000,
        user_mb: 0,
        internal_mb: 0,
        version_mb: 0,
        free_mb: 250,
        used_pct: 75
      }
    })
    expect(mem.level).toBe('warn')
    expect(mem.reasons).toHaveLength(2)
  })
})

describe('#2164 storage node', () => {
  beforeEach(() => resetTapState())

  it('counts calls, bytes, failures and missing objects per driver', () => {
    noteStorageCall({ driver: 's3', op: 'write', bytes: 1000, ms: 40, ok: true })
    noteStorageCall({
      driver: 'azure-blob',
      op: 'read',
      bytes: 500,
      ms: STORAGE_SLOW_MS + 1,
      ok: true
    })
    noteStorageCall({ driver: 'azure', op: 'read', ms: 30, ok: false, missing: true })
    noteStorageCall({ driver: 's3', op: 'write', ms: 90, ok: false, reason: 'timeout' })
    const sec = Math.floor(Date.now() / 1000)
    const snap = storageSnapshot(60, sec)
    expect(snap?.drivers.s3.ops.write).toMatchObject({ n: 2, failed: 1, bytes: 1000 })
    expect(snap?.drivers.s3.last_failure?.reason).toBe('timeout')
    expect(snap?.drivers.azure.ops.read).toMatchObject({ n: 2, failed: 0, missing: 1, slow: 1 })
    expect(snap?.drivers.local).toBeUndefined()
    expect(storageLevel(snap!.drivers.s3)).toBe('error')
    expect(storageNodeId('azure-blob')).toBe('storage:azure')
  })

  it('knows a missing object from a broken backend', () => {
    expect(isMissingObject(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true)
    expect(isMissingObject(new Error('Azure GET a/b failed: 404 nope'))).toBe(true)
    expect(isMissingObject(new Error('connect ETIMEDOUT'))).toBe(false)
    expect(scrubReason(new Error('failed reading secret/key.png here'), 'secret/key.png')).toBe(
      'failed reading … here'
    )
  })

  it('instrumentStorage passes results and errors through unchanged', async () => {
    resetTapState()
    const inner = {
      root: 'r',
      put: vi.fn(async (_k: string, _b: Buffer, _m: string) => undefined),
      get: vi.fn(async (k: string) => {
        if (k === 'gone') throw Object.assign(new Error('nope'), { code: 'ENOENT' })
        return Buffer.from('hello')
      }),
      getUrl: (k: string) => `/raw/${k}`,
      who() {
        return this.root
      }
    }
    const s = instrumentStorage(inner, 'local')
    expect(s.getUrl('a')).toBe('/raw/a')
    expect(s.who()).toBe('r')
    expect((await s.get('a')).toString()).toBe('hello')
    await expect(s.get('gone')).rejects.toThrow('nope')
    await s.put('k', Buffer.alloc(7), 'text/plain')
    const snap = storageSnapshot(60, Math.floor(Date.now() / 1000))
    expect(snap?.drivers.local.ops.read).toMatchObject({ n: 2, failed: 0, missing: 1, bytes: 5 })
    expect(snap?.drivers.local.ops.write).toMatchObject({ n: 1, bytes: 7 })
  })
})

describe('#2157 work queues', () => {
  const now = Date.UTC(2026, 9, 17, 12, 0, 0)
  it('computes age, drain rate and time to empty', () => {
    const q = queueFigures(
      'import',
      { depth: 30, oldest_at: now - 120_000, finished: 15 },
      'flat',
      now
    )
    expect(q.oldest_age_s).toBe(120)
    expect(q.drain_per_min).toBe(1)
    expect(q.eta_s).toBe(1800)
    expect(q.level).toBe('ok')
  })
  it('goes amber then red as the oldest item ages, or when nothing drains', () => {
    const base = { depth: 4, finished: 30 }
    expect(queueFigures('outbox', { ...base, oldest_at: now - 400_000 }, 'flat', now).level).toBe(
      'warn'
    )
    expect(queueFigures('outbox', { ...base, oldest_at: now - 2_000_000 }, 'flat', now).level).toBe(
      'error'
    )
    expect(
      queueFigures('outbox', { depth: 4, finished: 0, oldest_at: now - 400_000 }, 'flat', now).level
    ).toBe('error')
    expect(queueFigures('outbox', { ...base, oldest_at: now - 5_000 }, 'growing', now).level).toBe(
      'warn'
    )
  })
  it('an empty queue is ok with no age', () => {
    const q = queueFigures('flows', { depth: 0, oldest_at: null, finished: 0 }, 'flat', now)
    expect(q).toMatchObject({ level: 'ok', oldest_age_s: null, eta_s: null })
    expect(queueVisible(q)).toBe(false)
    expect(queueVisible({ depth: 0, drain_per_min: 2 })).toBe(true)
  })
  it('reads a growing or draining backlog from the depth history', () => {
    const h = (...d: number[]) =>
      d.map((depth, i) => ({ at: now - (d.length - 1 - i) * 60_000, depth }))
    expect(depthTrend(h(2, 5, 12), now)).toBe('growing')
    expect(depthTrend(h(40, 25, 5), now)).toBe('draining')
    expect(depthTrend(h(10, 11, 10), now)).toBe('flat')
    expect(depthTrend(h(3), now)).toBe('flat')
  })
})

describe('#2271 bulk runs', () => {
  it('reads progress, rate, refusals and who started it', () => {
    const now = Date.UTC(2026, 9, 17, 12, 0, 20)
    const r = bulkRunFigures(
      {
        id: 7,
        job_id: 'bulk:orders',
        label: '500 rows into orders',
        started_at: new Date(Date.UTC(2026, 9, 17, 12, 0, 0)),
        progress: JSON.stringify({ done: 180, failed: 20, total: 500 }),
        first_name: 'Ada',
        last_name: 'Lovelace'
      },
      now
    )
    expect(r).toMatchObject({
      id: 7,
      collection: 'orders',
      done: 180,
      failed: 20,
      total: 500,
      by: 'Ada Lovelace'
    })
    expect(r.per_s).toBe(10)
    expect(r.pct).toBe(40)
  })
  it('copes with no progress yet and no user', () => {
    const r = bulkRunFigures({
      id: 1,
      job_id: 'import-revert:9',
      started_at: new Date(),
      progress: 'oops'
    })
    expect(r).toMatchObject({
      done: 0,
      failed: 0,
      total: null,
      per_s: null,
      by: null,
      collection: null
    })
  })
})

describe('#2199 tuning proposals', () => {
  it('maps a proposal to the node it would speed up', () => {
    expect(tuningTarget('query_cache', 'monthly-spend')).toEqual({
      entity: 'queries/monthly-spend',
      table: null
    })
    expect(tuningTarget('index_create', 'orders.customer_id')).toEqual({
      entity: 'items/orders',
      table: 'orders'
    })
    expect(tuningTarget('rollup_store', 'nivaro_tasks.open_count')).toEqual({
      entity: 'system/nivaro_tasks',
      table: 'nivaro_tasks'
    })
    expect(tuningTarget('proc_rewrite', 'usp_x')).toEqual({ entity: null, table: null })
  })
  it('folds pending proposals per entity, biggest saving first', () => {
    const f = tuningFigures([
      {
        id: 'a',
        kind: 'index_create',
        target: 'orders.a',
        title: 'A',
        estimate_ms_per_day: 5000,
        risk: 'reversible'
      },
      {
        id: 'b',
        kind: 'index_create',
        target: 'orders.b',
        title: 'B',
        estimate_ms_per_day: 9000,
        risk: 'reversible'
      },
      {
        id: 'c',
        kind: 'proc_rewrite',
        target: 'usp_x',
        title: 'C',
        estimate_ms_per_day: 100,
        risk: 'review'
      }
    ])
    expect(f.total).toBe(3)
    expect(f.proposals[0].id).toBe('b')
    expect(f.by_entity['items/orders']).toEqual({ count: 2, saving_ms_per_day: 14000, id: 'b' })
    expect(f.by_entity['items/usp_x']).toBeUndefined()
    expect(f.saving_ms_per_day).toBe(14100)
  })
})

describe('#2267 missed runs probe', () => {
  beforeEach(() => resetMissedCronProbe())
  it('reports not ready before the detector registers', async () => {
    const prev = process.env.CRON_TICKS
    process.env.CRON_TICKS = 'on'
    try {
      expect(await currentMissedCrons()).toMatchObject({ ticking: true, ready: false, misses: [] })
      registerMissedCronProbe(async () => [
        { id: 'sweep', expected_at: '2026-10-17T10:00:00.000Z', last_run_at: null, grace_min: 5 }
      ])
      expect((await currentMissedCrons()).misses).toHaveLength(1)
    } finally {
      if (prev === undefined) delete process.env.CRON_TICKS
      else process.env.CRON_TICKS = prev
    }
  })
  it('reports nothing missed where jobs do not tick', async () => {
    const prev = process.env.CRON_TICKS
    process.env.CRON_TICKS = 'off'
    try {
      registerMissedCronProbe(async () => [
        { id: 'sweep', expected_at: 'x', last_run_at: null, grace_min: 5 }
      ])
      expect(await currentMissedCrons()).toMatchObject({ ticking: false, misses: [] })
    } finally {
      if (prev === undefined) delete process.env.CRON_TICKS
      else process.env.CRON_TICKS = prev
    }
  })
})
