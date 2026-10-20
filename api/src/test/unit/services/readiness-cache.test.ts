import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The readiness result cache (2026-10-19): a plain read answers from stored
 * results, refreshes what is due once in the background, and `fresh` runs
 * every check live. Keyed by tenant + version, shared through Redis.
 */

const m = vi.hoisted(() => ({ tenant: '', emits: [] as Array<Record<string, unknown>> }))
vi.mock('../../../services/ops-live.js', () => ({
  emitOps: (_topic: string, detail: Record<string, unknown>) => m.emits.push(detail)
}))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => m.tenant }))

import type { ReadinessCheck } from '@nivaro/extension-kit'
import {
  _readinessRefreshesForTests,
  _resetReadinessForTests,
  assembleReadinessReport,
  type CachedReadinessResult,
  READINESS_HEAVY_TTL_MS,
  READINESS_REFRESH_LANES,
  READINESS_TTL_MS,
  readinessTtlMs,
  readReadiness,
  registerReadinessCheck,
  runReadinessChecks,
  setReadinessRedis
} from '../../../services/readiness.js'

/** Just enough of ioredis for the store and the lock. */
function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>()
  const strings = new Map<string, string>()
  return {
    hashes,
    strings,
    async hgetall(k: string) {
      return Object.fromEntries(hashes.get(k) ?? [])
    },
    async hset(k: string, f: string, v: string) {
      if (!hashes.has(k)) hashes.set(k, new Map())
      hashes.get(k)!.set(f, v)
      return 1
    },
    async pexpire() {
      return 1
    },
    async set(k: string, v: string, _px: string, _ms: number, nx: string) {
      if (nx === 'NX' && strings.has(k)) return null
      strings.set(k, v)
      return 'OK'
    },
    async get(k: string) {
      return strings.get(k) ?? null
    },
    async del(k: string) {
      return strings.delete(k) ? 1 : 0
    }
  }
}

function counted(
  id: string,
  status: 'pass' | 'warn' | 'fail' = 'pass',
  extra: Partial<ReadinessCheck> = {}
) {
  const calls = { n: 0 }
  const check: ReadinessCheck = {
    id,
    label: id,
    run: async () => {
      calls.n++
      return { status, detail: `${id} run ${calls.n}` }
    },
    ...extra
  }
  return { check, calls }
}

let redis: ReturnType<typeof fakeRedis>

beforeEach(() => {
  _resetReadinessForTests()
  m.tenant = ''
  m.emits.length = 0
  redis = fakeRedis()
  setReadinessRedis(redis as never)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('cold read', () => {
  it('answers at once with pending checks and no score, then fills in the background', async () => {
    const a = counted('a')
    const b = counted('b', 'warn')
    registerReadinessCheck(a.check)
    registerReadinessCheck(b.check)

    const first = await readReadiness()
    expect(first.checks.map((c) => c.status)).toEqual(['pending', 'pending'])
    expect(first.score).toBeNull()
    expect(first.counts.pending).toBe(2)
    expect(first.stale).toBe(true)
    expect(first.refreshing).toBe(true)
    expect(first.computed_at).toBeNull()

    await _readinessRefreshesForTests()
    expect(a.calls.n).toBe(1)
    expect(b.calls.n).toBe(1)
    // The finished scorecard is broadcast for open pages to take as data.
    expect((m.emits.at(-1)?.report as { score: number }).score).toBe(75)

    const second = await readReadiness()
    expect(second.checks.map((c) => c.status)).toEqual(['pass', 'warn'])
    expect(second.score).toBe(75)
    expect(second.stale).toBe(false)
    expect(second.refreshing).toBe(false)
    expect(second.computed_at).toBe('2026-10-19T12:00:00.000Z')
    expect(second.checks[0].computed_at).toBe('2026-10-19T12:00:00.000Z')
  })
})

describe('cached read', () => {
  it('never re-runs a check inside its TTL', async () => {
    const a = counted('a')
    registerReadinessCheck(a.check)
    await runReadinessChecks()
    vi.setSystemTime(new Date(Date.now() + READINESS_TTL_MS - 1_000))
    for (let i = 0; i < 5; i++) await readReadiness()
    await _readinessRefreshesForTests()
    expect(a.calls.n).toBe(1)
  })

  it('serves the stale copy immediately and refreshes it once, however many read', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let n = 0
    registerReadinessCheck({
      id: 'slow',
      label: 'slow',
      run: async () => {
        n++
        if (n > 1) await gate
        return { status: n > 1 ? 'fail' : 'pass', detail: `run ${n}` }
      }
    })
    await runReadinessChecks()
    vi.setSystemTime(new Date(Date.now() + READINESS_TTL_MS + 1_000))

    const reads = await Promise.all([readReadiness(), readReadiness(), readReadiness()])
    for (const r of reads) {
      expect(r.checks[0].status).toBe('pass') // the old result, honestly flagged
      expect(r.checks[0].stale).toBe(true)
      expect(r.stale).toBe(true)
      expect(r.refreshing).toBe(true)
    }
    release()
    await _readinessRefreshesForTests()
    expect(n).toBe(2)
    const after = await readReadiness()
    expect(after.checks[0].status).toBe('fail')
    expect(after.stale).toBe(false)
  })

  it('leaves the refresh to the replica holding the cluster lock', async () => {
    const a = counted('a')
    registerReadinessCheck(a.check)
    redis.strings.set('nvr:readiness:lock:|' + (await versionOf()), 'other-replica')
    await readReadiness()
    await _readinessRefreshesForTests()
    expect(a.calls.n).toBe(0)
  })

  it("a second process reads the first one's results from Redis without running anything", async () => {
    const a = counted('a')
    registerReadinessCheck(a.check)
    await runReadinessChecks()
    expect(a.calls.n).toBe(1)

    // A fresh process: no in-process copy, same Redis.
    _resetReadinessForTests()
    setReadinessRedis(redis as never)
    const again = counted('a')
    registerReadinessCheck(again.check)
    const r = await readReadiness()
    expect(r.checks[0].status).toBe('pass')
    expect(r.stale).toBe(false)
    await _readinessRefreshesForTests()
    expect(again.calls.n).toBe(0)
  })

  it('falls back to the in-process copy when Redis fails', async () => {
    const a = counted('a')
    registerReadinessCheck(a.check)
    await runReadinessChecks()
    redis.hgetall = async () => {
      throw new Error('down')
    }
    const r = await readReadiness()
    expect(r.checks[0].status).toBe('pass')
    expect(r.stale).toBe(false)
  })

  it('keeps tenants apart', async () => {
    const a = counted('a')
    registerReadinessCheck(a.check)
    m.tenant = 'tenant-a'
    await runReadinessChecks()
    m.tenant = 'tenant-b'
    const r = await readReadiness()
    expect(r.checks[0].status).toBe('pending')
  })

  it('a background refresh runs a few checks at a time', async () => {
    let running = 0
    let peak = 0
    for (let i = 0; i < 15; i++) {
      registerReadinessCheck({
        id: `c${i}`,
        label: `c${i}`,
        run: async () => {
          running++
          peak = Math.max(peak, running)
          await new Promise((r) => setTimeout(r, 1))
          running--
          return { status: 'pass' }
        }
      })
    }
    await readReadiness()
    await _readinessRefreshesForTests()
    expect(peak).toBe(READINESS_REFRESH_LANES)
    expect((await readReadiness()).counts.pass).toBe(15)
  })
})

describe('fresh', () => {
  it('runs every check live, single-flight, and reuses an evaluation that just finished', async () => {
    const a = counted('a')
    registerReadinessCheck(a.check)
    const [x, y] = await Promise.all([runReadinessChecks(), readReadiness({ fresh: true })])
    expect(a.calls.n).toBe(1)
    expect(x).toBe(y)
    expect(x.fresh).toBe(true)
    expect(x.stale).toBe(false)

    vi.setSystemTime(new Date(Date.now() + 5_000))
    await readReadiness({ fresh: true })
    expect(a.calls.n).toBe(1) // 5 s old: reused

    vi.setSystemTime(new Date(Date.now() + 30_000))
    const z = await readReadiness({ fresh: true })
    expect(a.calls.n).toBe(2)
    expect(z.checks[0].detail).toBe('a run 2')
  })

  it('reuses a long live run that has just finished, judged by when it finished', async () => {
    let n = 0
    registerReadinessCheck({
      id: 'long',
      label: 'long',
      run: async () => {
        n++
        vi.setSystemTime(new Date(Date.now() + 40_000)) // a 40 s check
        return { status: 'pass' }
      }
    })
    registerReadinessCheck(counted('quick').check)
    await readReadiness({ fresh: true })
    vi.setSystemTime(new Date(Date.now() + 2_000))
    const again = await readReadiness({ fresh: true })
    expect(n).toBe(1)
    expect(again.fresh).toBe(true)
  })

  it('a fresh run ignores TTLs and stores what it found for plain reads', async () => {
    const a = counted('a', 'pass', { ttlMs: 60 * 60_000 })
    registerReadinessCheck(a.check)
    await readReadiness({ fresh: true })
    vi.setSystemTime(new Date(Date.now() + 20_000))
    await readReadiness({ fresh: true })
    expect(a.calls.n).toBe(2)
    const plain = await readReadiness()
    expect(plain.checks[0].detail).toBe('a run 2')
  })

  it('a check that throws is an error result, never a failed read', async () => {
    registerReadinessCheck({
      id: 'boom',
      label: 'boom',
      run: async () => {
        throw new Error('no table')
      }
    })
    const r = await runReadinessChecks()
    expect(r.checks[0].status).toBe('error')
    expect(r.checks[0].detail).toBe('no table')
    expect(r.score).toBe(0)
  })
})

describe('per-check TTL', () => {
  const base: ReadinessCheck = { id: 'x', label: 'x', run: async () => ({ status: 'pass' }) }

  it('honours ttlMs, then cost, then the last run time', () => {
    expect(readinessTtlMs(base)).toBe(READINESS_TTL_MS)
    expect(readinessTtlMs({ ...base, ttlMs: 42_000 })).toBe(42_000)
    expect(readinessTtlMs({ ...base, cost: 'heavy' })).toBe(READINESS_HEAVY_TTL_MS)
    expect(readinessTtlMs(base, 13_186)).toBe(READINESS_HEAVY_TTL_MS)
    expect(readinessTtlMs({ ...base, ttlMs: 42_000 }, 13_186)).toBe(42_000)
  })

  it('marks only the checks past their own TTL as due', () => {
    const now = Date.parse('2026-10-19T12:00:00Z')
    const tenMinAgo = now - 10 * 60_000
    const store = new Map<string, CachedReadinessResult>([
      ['light', { status: 'pass', duration_ms: 50, computed_at: tenMinAgo }],
      ['slow', { status: 'fail', duration_ms: 13_000, computed_at: tenMinAgo }],
      ['declared', { status: 'pass', duration_ms: 50, computed_at: tenMinAgo }]
    ])
    const { report, due } = assembleReadinessReport(
      [
        { ...base, id: 'light' },
        { ...base, id: 'slow' },
        { ...base, id: 'declared', cost: 'heavy' },
        { ...base, id: 'new' }
      ],
      store,
      now
    )
    expect(due).toEqual(['light', 'new'])
    expect(report.checks.map((c) => [c.id, c.status, c.stale])).toEqual([
      ['light', 'pass', true],
      ['slow', 'fail', false],
      ['declared', 'pass', false],
      ['new', 'pending', true]
    ])
    expect(report.score).toBeNull()
    expect(report.computed_at).toBe(new Date(tenMinAgo).toISOString())
  })

  it('does not serve a result older than a day', () => {
    const now = Date.now()
    const store = new Map<string, CachedReadinessResult>([
      ['x', { status: 'pass', duration_ms: 5, computed_at: now - 25 * 3_600_000 }]
    ])
    const { report, due } = assembleReadinessReport([base], store, now)
    expect(report.checks[0].status).toBe('pending')
    expect(due).toEqual(['x'])
  })
})

async function versionOf(): Promise<string> {
  const { NIVARO_VERSION } = await import('../../../version.js')
  return NIVARO_VERSION
}
