import { beforeEach, describe, expect, it } from 'vitest'
import type { FaultDefinition } from './catalog.js'
import {
  _resetClaimsForTests,
  claimStatuses,
  claimsReadiness,
  listClaims,
  registerClaim
} from './claims.js'
import { buildMatrix, kindFromWords, placeRun } from './matrix.js'
import type { ChaosRun } from './runs.js'
import { buildTrends, etDay, lastMonths, median } from './trends.js'

const NOW = Date.parse('2026-10-21T16:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

let n = 0
function run(
  fault_key: string,
  verdict: ChaosRun['verdict'],
  ago: number,
  over: Partial<ChaosRun> = {}
): ChaosRun {
  n++
  return {
    id: `r${n}`,
    kind: 'drill',
    status: verdict === 'aborted' ? 'aborted' : 'completed',
    fault_key,
    label: fault_key,
    target: { kind: 'all' },
    params: {},
    hypothesis: [],
    verdict,
    verdict_detail: null,
    baseline: null,
    started_by: null,
    started_at: daysAgo(ago),
    ends_at: daysAgo(ago),
    ended_at: daysAgo(ago),
    preset_id: null,
    gameday_id: null,
    meta: {},
    created_at: daysAgo(ago),
    ...over
  }
}

const fault = (key: string, over: Partial<FaultDefinition> = {}): FaultDefinition => ({
  key,
  label: key,
  proves: '',
  claim_keys: [],
  targets: ['all'],
  params: {},
  max_seconds: 60,
  points: [],
  ...over
})

const CATALOG = [
  fault('redis_pause', { claim_keys: ['redis.fails_open'], area: 'http' }),
  fault('mail_down', { claim_keys: ['mail.fails_clean'] }),
  fault('socket_drill', { claim_keys: ['sockets.reconnect_catchup'], area: 'socket' })
]

beforeEach(() => _resetClaimsForTests())

describe('claim status', () => {
  const status = (runs: ChaosRun[], key: string) =>
    claimStatuses(runs, { now: NOW, catalog: CATALOG }).find((c) => c.key === key)

  it('proven when the newest proving run held inside its window', () => {
    const c = status(
      [run('redis_pause', 'broke', 20), run('redis_pause', 'held', 3)],
      'redis.fails_open'
    )
    expect(c?.status).toBe('proven')
    expect(c?.last_run?.age_days).toBe(3)
  })

  it('broke when the newest run broke or aborted, whatever came before', () => {
    expect(
      status([run('redis_pause', 'held', 9), run('redis_pause', 'broke', 2)], 'redis.fails_open')
        ?.status
    ).toBe('broke')
    expect(status([run('mail_down', 'aborted', 1)], 'mail.fails_clean')?.status).toBe('broke')
  })

  it('stale past max age, never without a finished run', () => {
    expect(status([run('redis_pause', 'held', 45)], 'redis.fails_open')?.status).toBe('stale')
    const never = status(
      [run('redis_pause', 'held', 1, { status: 'running', verdict: null })],
      'redis.fails_open'
    )
    expect(never?.status).toBe('never')
    expect(never?.provable).toBe(true)
  })

  it('a catalog fault naming the claim proves it; unknown faults leave it unprovable', () => {
    registerClaim({ key: 'x.claim', area: 'x', statement: 'X', proving: ['not_built'] })
    const cat = [...CATALOG, fault('x_new', { claim_keys: ['x.claim'] })]
    const views = claimStatuses([run('x_new', 'held', 1)], { now: NOW, catalog: cat })
    expect(views.find((c) => c.key === 'x.claim')?.status).toBe('proven')
    expect(views.find((c) => c.key === 'files.share_503')?.provable).toBe(false)
  })

  it('seeds the degradation claims Nivaro makes', () => {
    const keys = listClaims().map((c) => c.key)
    for (const k of [
      'redis.fails_open',
      'mail.fails_clean',
      'readgate.fails_open',
      'sockets.reconnect_catchup',
      'cron.lease_pause',
      'pools.isolated',
      'files.share_503',
      'ai.unavailable_503'
    ])
      expect(keys).toContain(k)
    expect(listClaims().every((c) => c.max_age_days === 30)).toBe(true)
  })

  it('readiness warns on stale or broken claims only', () => {
    const fresh = claimStatuses([run('redis_pause', 'held', 1)], { now: NOW, catalog: CATALOG })
    expect(claimsReadiness(fresh).status).toBe('pass')
    expect(claimsReadiness(fresh).detail).toMatch(/never proven/)
    const bad = claimStatuses([run('redis_pause', 'held', 40), run('mail_down', 'broke', 1)], {
      now: NOW,
      catalog: CATALOG
    })
    const r = claimsReadiness(bad)
    expect(r.status).toBe('warn')
    expect(r.blockers?.length).toBe(3) // mail broke; redis.fails_open + cron.lease_pause stale
  })
})

describe('matrix', () => {
  it('places runs by table, by params, and by words for faults it has not met', () => {
    expect(placeRun({ fault_key: 'redis_pause', params: {} })).toEqual([
      { dependency: 'redis', kind: 'down' }
    ])
    expect(
      placeRun({
        fault_key: 'socket_drill',
        params: { latency_ms: 500, drop_pct: 10, disconnect: 'none' }
      })
    ).toEqual([
      { dependency: 'sockets', kind: 'slow' },
      { dependency: 'sockets', kind: 'errors' }
    ])
    expect(
      placeRun({ fault_key: 'storage_fault', params: { mode: 'enospc' } }, { area: 'storage' })
    ).toEqual([{ dependency: 'files', kind: 'errors' }])
    expect(
      placeRun({ fault_key: 'ai_gateway_fault', params: { mode: 'timeout' } }, { area: 'outbound' })
    ).toEqual([{ dependency: 'ai', kind: 'down' }])
    expect(kindFromWords('latency')).toBe('slow')
    expect(placeRun({ fault_key: 'redis_partition', params: {} })).toEqual([
      { dependency: 'redis', kind: 'partitioned' },
      { dependency: 'sockets', kind: 'partitioned' }
    ])
    expect(
      placeRun({ fault_key: 'oidc_down', params: { mode: 'slow' } }, { area: 'outbound' })
    ).toEqual([{ dependency: 'sign-in', kind: 'slow' }])
    expect(
      placeRun(
        { fault_key: 'ai_gateway_fault', params: { mode: 'model_refused' } },
        { area: 'outbound' }
      )
    ).toEqual([{ dependency: 'ai', kind: 'errors' }])
    expect(
      placeRun({ fault_key: 'graph_down', params: { mode: 'down' } }, { area: 'outbound' })
    ).toEqual([])
  })

  it('places the database, storage and partner faults as c-fdb registers them', () => {
    expect(placeRun({ fault_key: 'pool_hold', params: { pool: 'main' } }, { area: 'db' })).toEqual([
      { dependency: 'database', kind: 'down' }
    ])
    expect(
      placeRun({ fault_key: 'db_errors', params: { error: 'timeout' } }, { area: 'db' })
    ).toEqual([{ dependency: 'database', kind: 'errors' }])
    expect(
      placeRun({ fault_key: 'storage_faults', params: { mode: 'read_only' } }, { area: 'storage' })
    ).toEqual([{ dependency: 'files', kind: 'errors' }])
    expect(
      placeRun({ fault_key: 'storage_faults', params: { mode: 'slow' } }, { area: 'storage' })
    ).toEqual([{ dependency: 'files', kind: 'slow' }])
    const m = buildMatrix(
      [run('partner_faults', 'broke', 1, { params: { api: 'Fusion', mode: 'rate_limited_429' } })],
      [
        fault('partner_faults', {
          area: 'outbound',
          params: {
            api: { type: 'string', label: 'API' },
            mode: {
              type: 'enum',
              label: 'Mode',
              options: ['latency', 'error_500'],
              default: 'latency'
            }
          }
        })
      ],
      [{ id: '7', name: 'Fusion' }],
      NOW
    )
    expect(
      m.cells.find((c) => c.dependency === 'partner:7' && c.kind === 'errors')?.last?.verdict
    ).toBe('broke')
    expect(m.cells.find((c) => c.dependency === 'partner:7' && c.kind === 'slow')?.rerun).toEqual({
      fault_key: 'partner_faults',
      params: { mode: 'latency', api: '7' }
    })
  })

  it('colours each cell by its newest verdict and offers a re-run', () => {
    const cat = [
      ...CATALOG,
      fault('partner_fault', {
        area: 'partner',
        params: {
          api_id: { type: 'string', label: 'API' },
          mode: {
            type: 'enum',
            label: 'Mode',
            options: ['latency', 'error_500'],
            default: 'latency'
          }
        }
      })
    ]
    const m = buildMatrix(
      [
        run('redis_pause', 'broke', 10),
        run('redis_pause', 'held', 2),
        run('partner_fault', 'held', 1, { params: { api_id: '7', mode: 'error_500' } })
      ],
      cat,
      [{ id: '7', name: 'Fusion' }],
      NOW
    )
    const cell = (dep: string, kind: string) =>
      m.cells.find((c) => c.dependency === dep && c.kind === kind)
    expect(cell('redis', 'down')?.last?.verdict).toBe('held')
    expect(cell('redis', 'down')?.runs).toBe(2)
    expect(cell('redis', 'down')?.rerun).toEqual({ fault_key: 'redis_pause', params: {} })
    expect(cell('partner:7', 'errors')?.last?.verdict).toBe('held')
    expect(cell('partner:7', 'slow')?.rerun).toEqual({
      fault_key: 'partner_fault',
      params: { mode: 'latency', api_id: '7' }
    })
    expect(cell('database', 'slow')?.last).toBeNull()
    expect(m.rows.map((r) => r.id)).toContain('partner:7')
  })
})

describe('trends', () => {
  it('months, medians, calendar days and never-proven claims', () => {
    expect(lastMonths(3, NOW)).toEqual(['2026-08', '2026-09', '2026-10'])
    expect(median([5, 1, 3])).toBe(3)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(etDay(Date.parse('2026-10-21T02:00:00Z'))).toBe('2026-10-20') // still the 20th in Eastern
    const runs = [
      run('redis_pause', 'held', 1),
      run('redis_pause', 'broke', 1),
      run('mail_down', 'held', 40)
    ]
    const figures = new Map([
      [
        runs[0].id,
        { v: 1 as const, ttd_s: 10, ttr_s: 30, ttr_state: 'recovered' as const, alerts: 1 }
      ],
      [
        runs[1].id,
        { v: 1 as const, ttd_s: 20, ttr_s: null, ttr_state: 'not_recovered' as const, alerts: 0 }
      ]
    ])
    const t = buildTrends({
      runs,
      figures,
      claims: claimStatuses(runs, { now: NOW, catalog: CATALOG }),
      catalog: CATALOG,
      months: 3,
      now: NOW
    })
    const oct = t.months.find((m) => m.period === '2026-10')
    expect(oct).toMatchObject({ runs: 2, held: 1, broke: 1, ttd_median_s: 15, ttr_median_s: 30 })
    expect(t.quarters.map((q) => q.period)).toEqual(['2026-Q3', '2026-Q4'])
    expect(t.days.reduce((a, d) => a + d.runs, 0)).toBe(3)
    expect(t.dependencies.find((d) => d.dependency === 'redis')?.months.at(-1)).toMatchObject({
      held: 1,
      broke: 1
    })
    expect(t.never_proven.map((c) => c.key)).toContain('files.share_503')
    expect(t.recovery).toMatchObject({ ttr_median_s: 30, not_recovered: 1, runs: 3 })
    expect(t.pending).toBe(1)
  })
})
