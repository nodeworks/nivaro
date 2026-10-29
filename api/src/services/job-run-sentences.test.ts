import { afterEach, describe, expect, it } from 'vitest'
import {
  clearJobRunFormatters,
  createSkipList,
  describeJobRunRow,
  formatDuration,
  genericSentence,
  type JobRunFacts,
  jobRunSentence,
  progressJson,
  registerJobRunFormatter
} from './job-run-sentences.js'

const run = (over: Partial<JobRunFacts> = {}): JobRunFacts => ({
  id: 1,
  kind: 'cron',
  job_id: 'nightly-forecast',
  label: null,
  status: 'completed',
  duration_ms: 192_000,
  outcome: null,
  error: null,
  progress: null,
  ...over
})

afterEach(() => clearJobRunFormatters('test'))

describe('genericSentence', () => {
  it('counts, duration, skipped with the top reason', () => {
    expect(
      genericSentence(
        run({
          progress: {
            rows: 4210,
            skipped: [
              { id: 1, reason: 'missing project' },
              { id: 2, reason: 'missing project' }
            ]
          }
        })
      )
    ).toBe('Nightly forecast: 4,210 rows in 3m12s, 2 skipped (missing project)')
  })

  it('done of total, failed', () => {
    expect(genericSentence(run({ progress: { done: 90, total: 100, failed: 10 } }))).toBe(
      'Nightly forecast: 90 of 100 rows in 3m12s, 10 failed'
    )
  })

  it('falls back to the outcome when progress has nothing countable', () => {
    expect(
      genericSentence(
        run({ job_id: 'ext:efp-ops:po-sync', outcome: 'synced 12 POs', duration_ms: 850 })
      )
    ).toBe('Po sync: synced 12 POs (850ms)')
  })

  it('failed and running runs', () => {
    expect(
      genericSentence(
        run({ status: 'error', error: 'Timeout: Request failed\nstack', duration_ms: 12_000 })
      )
    ).toBe('Nightly forecast failed after 12s: Timeout: Request failed')
    expect(genericSentence(run({ status: 'running', progress: { done: 5, total: 20 } }))).toBe(
      'Nightly forecast: running, 5 of 20'
    )
  })
})

describe('registry', () => {
  it('a registered formatter wins; one that returns null or throws falls back', () => {
    registerJobRunFormatter('nightly-forecast', (r) => `Forecast for ${r.progress?.year}`, 'test')
    expect(jobRunSentence(run({ progress: { year: 2026 } }))).toBe('Forecast for 2026')
    registerJobRunFormatter('nightly-forecast', () => null, 'test')
    expect(jobRunSentence(run())).toBe('Nightly forecast: done in 3m12s')
    registerJobRunFormatter(
      /^ext:x:/,
      () => {
        throw new Error('bad')
      },
      'test'
    )
    expect(jobRunSentence(run({ job_id: 'ext:x:y' }))).toBe('Y: done in 3m12s')
  })

  it('core example: geocode backfill', () => {
    expect(
      jobRunSentence(
        run({
          job_id: 'geocode-backfill',
          duration_ms: 65_000,
          progress: {
            resolved: 40,
            missed: 2,
            skipped_total: 2,
            skipped: [{ id: 9, reason: 'address not found' }]
          }
        })
      )
    ).toBe('Address lookup: 40 placed on the map in 1m05s, 2 skipped (address not found)')
  })
})

describe('skips + progress JSON', () => {
  it('createSkipList caps at 200 and keeps the true total', () => {
    const s = createSkipList('projects')
    for (let i = 0; i < 250; i++) s.add(i, 'missing project')
    const p = s.progress() as { skipped: unknown[]; skipped_total: number }
    expect(p.skipped).toHaveLength(200)
    expect(p.skipped_total).toBe(250)
    expect(createSkipList().progress()).toEqual({})
  })

  it('progressJson stays valid JSON and keeps what fits', () => {
    const s = createSkipList('projects')
    for (let i = 0; i < 200; i++) s.add(`row-${i}`, 'x'.repeat(120))
    const text = progressJson({ done: 5, ...s.progress() })
    const back = JSON.parse(text) as { skipped: unknown[]; skipped_total: number; done: number }
    expect(text.length).toBeLessThanOrEqual(32_000)
    expect(back.skipped_total).toBe(200)
    expect(back.done).toBe(5)
    expect(back.skipped.length).toBeGreaterThan(0)
    const big = progressJson({ done: 1, blob: { a: 'y'.repeat(5000) } })
    expect(JSON.parse(big)).toEqual({ done: 1 })
  })

  it('describeJobRunRow reads a stored row', () => {
    const d = describeJobRunRow({
      id: 3,
      kind: 'backfill',
      job_id: 'find-replace',
      status: 'completed',
      duration_ms: 4200,
      progress: JSON.stringify({ done: 10, failed: 1, skipped: [{ id: '7', reason: 'Locked' }] })
    })
    expect(d.sentence).toBe('Find and replace: 10 records changed in 4.2s, 1 not changed (Locked)')
    expect(d.skipped_count).toBe(1)
    expect(d.skipped_ids).toBe(true)
  })

  it('formatDuration', () => {
    expect(formatDuration(3_725_000)).toBe('1h02m')
    expect(formatDuration(null)).toBeNull()
  })
})
