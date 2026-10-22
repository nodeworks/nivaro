import { describe, expect, it } from 'vitest'
import { postmortemMarkdown } from './postmortem.js'
import {
  baselineBand,
  buildRunReport,
  insideBand,
  noteMark,
  runFigures,
  sampleBreach,
  sampleValues
} from './report.js'
import type { ChaosRun, ChaosRunEvent } from './runs.js'

const T0 = Date.parse('2026-10-21T14:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

function run(over: Partial<ChaosRun> = {}): ChaosRun {
  return {
    id: 'run-1',
    kind: 'drill',
    status: 'completed',
    fault_key: 'redis_pause',
    label: 'Redis unreachable',
    target: { kind: 'all' },
    params: {},
    hypothesis: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }],
    verdict: 'held',
    verdict_detail: null,
    baseline: { samplers: { 'http.5xx_pct': { mean: 0.1, min: 0, max: 0.2 } } },
    started_by: 'u1',
    started_at: at(0),
    ends_at: at(60),
    ended_at: at(60),
    preset_id: null,
    gameday_id: null,
    meta: { started_by_name: 'Pat Doe' },
    created_at: at(0),
    ...over
  }
}

let nextId = 1
function ev(
  kind: ChaosRunEvent['kind'],
  s: number,
  data: Record<string, unknown> = {},
  actor: string | null = null
): ChaosRunEvent {
  return { id: nextId++, run_id: 'run-1', at: at(s), kind, actor, data }
}

describe('event readers', () => {
  it('reads sample values and nested or flat breaches', () => {
    expect(sampleValues({ s: { a: 1, b: '2', c: null } })).toEqual({ a: 1, b: 2, c: null })
    expect(sampleBreach({ breach: { sampler: 'a', value: 3, op: '<', limit: 1 } })).toEqual({
      sampler: 'a',
      value: 3,
      op: '<',
      limit: 1
    })
    expect(sampleBreach({ breach: true, sampler: 'a', value: 3, op: '<', limit: 1 })?.sampler).toBe(
      'a'
    )
    expect(sampleBreach({ s: { a: 1 } })).toBeNull()
  })

  it('normalises scribe marks', () => {
    expect(noteMark({ mark: 'Found cause' })).toBe('found_cause')
    expect(noteMark({ preset: 'noticed' })).toBe('noticed')
    expect(noteMark({ mark: 'Declared incident' })).toBe('declared')
    expect(noteMark({ text: 'free text' })).toBeNull()
  })

  it('reads baseline bands in every stored shape, else the samples before arm', () => {
    expect(baselineBand({ samplers: { a: { min: 1, max: 3, mean: 2 } } }, 'a')).toEqual({
      lo: 1,
      hi: 3,
      mean: 2
    })
    expect(baselineBand({ a: { mean: 10, sd: 2 } }, 'a')).toEqual({ lo: 6, hi: 14, mean: 10 })
    expect(baselineBand({ s: { a: 5 } }, 'a')).toEqual({ lo: 5, hi: 5, mean: 5 })
    expect(baselineBand(null, 'a', [2, 4])).toEqual({ lo: 2, hi: 4, mean: 3 })
    expect(baselineBand(null, 'a')).toBeNull()
    // The steady-state watcher's own shape: one figure per sampler.
    expect(baselineBand({ samplers: { a: { value: 200 } } }, 'a')).toEqual({
      lo: 200,
      hi: 200,
      mean: 200
    })
  })

  it('judges inside the band with slack', () => {
    const band = { lo: 0, hi: 0.2, mean: 0.1 }
    expect(insideBand(0.25, band)).toBe(true) // slack 0.1 (10% of scale 1)
    expect(insideBand(0.5, band)).toBe(false)
    expect(insideBand(0.5, band, 0.5)).toBe(true)
    const point = { lo: 200, hi: 200, mean: 200 }
    expect(insideBand(245, point)).toBe(true) // 25% slack around a single figure
    expect(insideBand(260, point)).toBe(false)
  })
})

describe('buildRunReport', () => {
  it('splits samples into before / during / after and finds time to recover', () => {
    const r = buildRunReport(run(), [
      ev('sample', -10, { s: { 'http.5xx_pct': 0.1 } }),
      ev('armed', 0, { fault_key: 'redis_pause' }),
      ev('sample', 5, { s: { 'http.5xx_pct': 4 } }),
      ev('sample', 30, { s: { 'http.5xx_pct': 6 } }),
      ev('disarmed', 60, { reason: 'window ended', verdict: 'held' }),
      ev('sample', 65, { s: { 'http.5xx_pct': 3 } }),
      ev('sample', 75, { s: { 'http.5xx_pct': 0.15 } }),
      ev('sample', 80, { s: { 'http.5xx_pct': 0.1 } })
    ])
    const s = r.series[0]
    expect(s.key).toBe('http.5xx_pct')
    expect(s.points.map((p) => p.phase)).toEqual([
      'before',
      'during',
      'during',
      'after',
      'after',
      'after'
    ])
    expect(s.band).toEqual({ lo: 0, hi: 0.2, mean: 0.1 })
    expect(r.ttr_s).toBe(15)
    expect(r.ttr_state).toBe('recovered')
    expect(r.markers.map((m) => m.kind)).toEqual(['armed', 'disarmed'])
  })

  it('says not recovered when every sample after the fault stays outside', () => {
    const r = buildRunReport(run(), [
      ev('armed', 0),
      ev('disarmed', 60),
      ev('sample', 65, { s: { 'http.5xx_pct': 3 } }),
      ev('sample', 70, { s: { 'http.5xx_pct': 2.5 } })
    ])
    expect(r.ttr_s).toBeNull()
    expect(r.ttr_state).toBe('not_recovered')
  })

  it('says no data without samples after the fault', () => {
    const r = buildRunReport(run(), [
      ev('armed', 0),
      ev('sample', 10, { s: { 'http.5xx_pct': 2 } }),
      ev('disarmed', 60)
    ])
    expect(r.ttr_state).toBe('no_data')
  })

  it('time to detect = the first alert or noticed / declared mark after arm', () => {
    const r = buildRunReport(run(), [
      ev('alert', -5, { label: 'before arm — ignored' }),
      ev('armed', 0),
      ev('note', 40, { mark: 'noticed', text: 'banner up' }, 'u2'),
      ev('alert', 25, { label: 'Redis errors', source: 'ops-console', severity: 'warning' }),
      ev('note', 50, { mark: 'fixed' }, 'u2'),
      ev('disarmed', 60)
    ])
    expect(r.ttd_s).toBe(25)
    expect(r.ttd_source).toBe('alert')
    expect(r.ttf_s).toBe(50)
    expect(r.alerts).toHaveLength(2)
    expect(r.alerts[1]).toMatchObject({ label: 'Redis errors', after_s: 25 })
    expect(r.notes.map((n) => n.mark)).toEqual(['noticed', 'fixed'])
    expect(r.notes[1].text).toBe('Fixed')
  })

  it('a declared incident detects; bookkeeping notes are not participants notes', () => {
    const r = buildRunReport(run(), [
      ev('armed', 0),
      ev('note', 5, { refusal: 'nope' }),
      ev('note', 12, { mark: 'declared' }, 'u3'),
      ev('disarmed', 60)
    ])
    expect(r.ttd_s).toBe(12)
    expect(r.ttd_source).toBe('declared')
    expect(r.notes).toHaveLength(1)
    expect(r.markers.some((m) => m.kind === 'declared')).toBe(true)
  })

  it('names the sampler that broke it, from the verdict detail or the first breach', () => {
    const broke = buildRunReport(
      run({
        verdict: 'aborted',
        status: 'aborted',
        verdict_detail: { breaches: [{ sampler: 'http.p95_ms', value: 900, op: '<', limit: 500 }] }
      }),
      [ev('armed', 0), ev('abort', 20)]
    )
    expect(broke.broke_by).toEqual({ sampler: 'http.p95_ms', value: 900, op: '<', limit: 500 })
    const seen = buildRunReport(run({ verdict: 'broke' }), [
      ev('armed', 0),
      ev('sample', 10, {
        s: { 'http.5xx_pct': 5 },
        breach: { sampler: 'http.5xx_pct', value: 5, op: '<', limit: 1 }
      }),
      ev('disarmed', 60)
    ])
    expect(seen.broke_by?.sampler).toBe('http.5xx_pct')
    expect(seen.series[0].breached).toBe(true)
    const held = buildRunReport(run(), [ev('armed', 0), ev('disarmed', 60)])
    expect(held.broke_by).toBeNull()
  })

  it('recorded runs keep their own timings', () => {
    const r = buildRunReport(run({ kind: 'ci', verdict_detail: { ttd_s: 7, ttr_s: 30 } }), [])
    expect(r.ttd_s).toBe(7)
    expect(r.ttd_source).toBe('recorded')
    expect(r.ttr_s).toBe(30)
    expect(runFigures(r)).toEqual({ v: 1, ttd_s: 7, ttr_s: 30, ttr_state: 'recovered', alerts: 0 })
  })

  it('the postmortem carries timings, notes and route templates, never record data', () => {
    const report = buildRunReport(run(), [
      ev('armed', 0),
      ev('alert', 25, { label: 'Redis errors' }),
      ev('note', 40, { mark: 'noticed', text: 'banner up' }, 'u2'),
      ev('disarmed', 60)
    ])
    const md = postmortemMarkdown({
      run: run(),
      report,
      errors: {
        server: [{ route: 'GET /api/items/:id', count: 3 }],
        server_total: 3,
        people: 2,
        client_errors: 1,
        rage_clicks: 0,
        dead_clicks: 0,
        available: true
      },
      names: { u2: 'Sam Lee' },
      link: 'https://x.test/chaos/runs/run-1'
    })
    expect(md).toContain('# Chaos drill postmortem: Redis unreachable')
    expect(md).toContain('| Time to detect | 25s (alert) |')
    expect(md).toContain('Sam Lee [Noticed]: banner up')
    expect(md).toContain('| GET /api/items/:id | 3 |')
    expect(md).toContain('3 server error(s) reached 2 person(s)')
  })
})
