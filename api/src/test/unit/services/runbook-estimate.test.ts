import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STALL_SECS,
  historyRunFinished,
  liveEstimate,
  median,
  parseElapsed,
  parsePhaseSummary,
  parseSubSteps,
  planEstimate,
  runDirTime,
  stallAfterSecs,
  type TimingRow,
  typicalSecs
} from '../../../services/runbook-estimate.js'

const PHASES = [
  { key: 'refresh', label: 'Refresh' },
  { key: 'migrate', label: 'Migrate' },
  { key: 'promote', label: 'Promote' },
  { key: 'schema', label: 'Schema' },
  { key: 'convert', label: 'Convert' }
]

const day = (n: number) => new Date(Date.UTC(2026, 8, n)).toISOString()
const rows: TimingRow[] = [
  // refresh: 8 go passes, newest 7 → median 600 (the 2000 outlier ages out)
  ...[2000, 600, 590, 610, 620, 580, 600, 605].map((secs, i) => ({
    step: 'refresh',
    parent_step: null,
    mode: 'go' as const,
    secs,
    finished_at: day(i + 1)
  })),
  { step: 'migrate', parent_step: null, mode: 'go', secs: 30, finished_at: day(9) },
  {
    step: 'promote',
    parent_step: null,
    mode: 'go',
    secs: 120,
    max_quiet_secs: 400,
    finished_at: day(9)
  },
  {
    step: 'promote',
    parent_step: null,
    mode: 'go',
    secs: 100,
    max_quiet_secs: 900,
    finished_at: day(8)
  },
  { step: 'convert', parent_step: null, mode: 'go', secs: 3600, finished_at: day(9) },
  { step: 'convert', parent_step: null, mode: 'dry', secs: 900, finished_at: day(9) },
  { step: 'state-views', parent_step: 'convert', mode: 'go', secs: 12, finished_at: day(9) }
]

describe('runbook estimates', () => {
  it('median of the last 7 passes, same mode first, else any mode', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(3)
    expect(typicalSecs(rows, 'refresh', 'go')).toBe(600)
    expect(typicalSecs(rows, 'convert', 'dry')).toBe(900)
    // No dry history of refresh: falls back to the go passes.
    expect(typicalSecs(rows, 'refresh', 'dry')).toBe(600)
    expect(typicalSecs(rows, 'schema', 'go')).toBeNull()
    // Sub-steps are kept apart from phases.
    expect(typicalSecs(rows, 'state-views', 'go')).toBeNull()
    expect(typicalSecs(rows, 'state-views', 'go', 'convert')).toBe(12)
  })

  it('plans a full run and a run from any phase', () => {
    const p = planEstimate(PHASES, rows, 'go')
    expect(p.phases.map((x) => x.secs)).toEqual([600, 30, 110, null, 3600])
    expect(p.from.refresh).toBe(600 + 30 + 110 + 3600)
    expect(p.from.convert).toBe(3600)
    expect(p.unknown_from.refresh).toBe(1)
    expect(p.unknown_from.convert).toBe(0)
  })

  it('live: remaining = rest of the running phase + phases ahead; an over-run never goes negative', () => {
    const start = Date.parse('2026-10-06T00:00:00Z')
    const events = [
      { step: 'promote', status: 'start' as const, at: '2026-10-06T00:00:00Z' },
      { step: 'promote', status: 'ok' as const, at: '2026-10-06T00:02:00Z', secs: 120 },
      { step: 'schema', status: 'start' as const, at: '2026-10-06T00:02:00Z' },
      { step: 'schema', status: 'ok' as const, at: '2026-10-06T00:03:00Z', secs: 60 },
      { step: 'convert', status: 'start' as const, at: '2026-10-06T00:03:00Z' }
    ]
    const mk = (nowSecs: number) =>
      liveEstimate({
        phases: PHASES,
        from: 'promote',
        events,
        rows,
        mode: 'go',
        startedAt: '2026-10-06T00:00:00Z',
        now: start + nowSecs * 1000
      })
    const early = mk(180 + 600) // 10 minutes into convert
    expect(early.current).toBe('convert')
    expect(early.phases.map((p) => p.key)).toEqual(['promote', 'schema', 'convert'])
    expect(early.remaining_secs).toBe(3000)
    expect(early.total_secs).toBe(780 + 3000)
    expect(early.percent).toBe(Math.round((780 / 3780) * 100))
    expect(early.over_typical).toBe(false)
    expect(early.phases[0]).toMatchObject({ status: 'done', actual_secs: 120, typical_secs: 110 })
    const late = mk(180 + 4000) // convert past its typical 3600
    expect(late.over_typical).toBe(true)
    expect(late.remaining_secs).toBe(0)
    expect(late.percent).toBeLessThanOrEqual(99)
  })

  it('stall threshold = the longest silence history saw in that phase, else 10 minutes', () => {
    expect(stallAfterSecs(rows, 'promote')).toBe(900)
    expect(stallAfterSecs(rows, 'convert')).toBe(DEFAULT_STALL_SECS)
  })
})

describe('nightly history logs', () => {
  // Lines exactly as golive-nightly.sh's say() and run-golive-conversions write them.
  const summary = [
    'golive-nightly → EFP_Staging  (2026-10-05 00:15:03)  logs: /var/efp/nivaro-golive/logs/nightly/2026-10-05_0015',
    '=== 1-refresh START 00:15:03 ===',
    '=== 1-refresh END 00:28:41 exit=0 elapsed=13m38s ===',
    '=== 2-migrate START 00:28:41 ===',
    '=== 2-migrate END 00:29:20 exit=0 elapsed=0m39s ===',
    '=== 3-promote START 00:29:20 ===',
    '=== 3-promote END 00:31:02 exit=0 elapsed=1m42s ===',
    '=== 4-schema START 00:31:02 ===',
    '=== 4-schema END 00:33:10 exit=0 elapsed=2m8s ===',
    '=== 5-convert START 00:33:10 ===',
    '=== 5-convert END 07:12:55 exit=0 elapsed=399m45s ===',
    'NIGHTLY COMPLETE total=6h57m',
    '',
    '═══ all conversions complete in 400m ═══',
    '  legacy-users                     45s',
    '  legacy-history                   221m04s'
  ].join('\n')
  const convertLog = [
    '─── legacy-users ─── 00:33:12',
    'synced 43 users',
    '─── legacy-users done in 45s ───',
    '',
    '─── legacy-history ─── 00:33:58',
    '─── legacy-history done in 221m04s ───',
    '✗ forecast exited 1 after 12m00s — fix and re-run (all steps are re-runnable)'
  ].join('\n')

  it('reads successful phases with their seconds', () => {
    expect(parsePhaseSummary(summary)).toEqual([
      { step: 'refresh', n: 1, secs: 818 },
      { step: 'migrate', n: 2, secs: 39 },
      { step: 'promote', n: 3, secs: 102 },
      { step: 'schema', n: 4, secs: 128 },
      { step: 'convert', n: 5, secs: 23985 }
    ])
    const failed =
      '=== 3-promote END 00:31:02 exit=1 elapsed=1m42s ===\nPHASE FAILED: 3-promote — resume with: x --from 3\nNIGHTLY ABORTED'
    expect(parsePhaseSummary(failed)).toEqual([])
    expect(historyRunFinished(failed)).toBe(true)
    expect(historyRunFinished('=== 1-refresh START 00:15:03 ===')).toBe(false)
    expect(historyRunFinished(summary)).toBe(true)
  })

  it('reads sub-steps of a phase log, never a failed one', () => {
    expect(parseSubSteps(convertLog)).toEqual([
      { step: 'legacy-users', secs: 45 },
      { step: 'legacy-history', secs: 13264 }
    ])
  })

  it('elapsed formats and run-directory names', () => {
    expect(parseElapsed('7m8s')).toBe(428)
    expect(parseElapsed('12m05s')).toBe(725)
    expect(parseElapsed('45s')).toBe(45)
    expect(parseElapsed('1h2m')).toBe(3720)
    expect(parseElapsed('soon')).toBeNull()
    expect(runDirTime('2026-10-05_0015')?.getHours()).toBe(0)
    expect(runDirTime('latest')).toBeNull()
  })
})
