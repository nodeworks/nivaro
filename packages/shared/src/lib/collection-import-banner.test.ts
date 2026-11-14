import { describe, expect, it } from 'vitest'
import {
  type CollectionImportRun,
  formatElapsed,
  importBannerState,
  rowsText,
  runningTitle
} from './collection-import-banner'

// #1826 — procedure-mode imports have no row-level progress: the banner shows indeterminate
// progress with the time since the run started, then the outcome and the rows it reported.

const NOW = Date.parse('2026-11-13T15:00:00Z')
const run = (over: Partial<CollectionImportRun>): CollectionImportRun => ({
  run_id: '1',
  label: 'PO lines',
  status: 'running',
  started_at: new Date(NOW - 95_000).toISOString(),
  finished_at: null,
  rows: null,
  ...over
})

describe('importBannerState', () => {
  it('shows nothing without runs', () => {
    expect(importBannerState([], NOW)).toBeNull()
    expect(importBannerState(undefined, NOW)).toBeNull()
  })

  it('prefers running runs and times the longest one', () => {
    const s = importBannerState(
      [
        run({ run_id: '3', status: 'completed', finished_at: new Date(NOW).toISOString() }),
        run({ run_id: '2' }),
        run({ run_id: '4', started_at: new Date(NOW - 10_000).toISOString() })
      ],
      NOW
    )
    expect(s?.kind).toBe('running')
    if (s?.kind !== 'running') return
    expect(s.runs.map((r) => r.run_id)).toEqual(['2', '4'])
    expect(s.elapsedSeconds).toBe(95)
    expect(runningTitle(s.runs)).toBe('2 imports are running')
  })

  it('then the newest ended run the viewer has not dismissed', () => {
    const ended = [
      run({ run_id: '7', status: 'error', finished_at: new Date(NOW - 60_000).toISOString() }),
      run({
        run_id: '8',
        status: 'completed',
        rows: 1200,
        finished_at: new Date(NOW - 5_000).toISOString()
      })
    ]
    expect(importBannerState(ended, NOW)).toMatchObject({ kind: 'completed', run: { run_id: '8' } })
    expect(importBannerState(ended, NOW, new Set(['8']))).toMatchObject({
      kind: 'error',
      run: { run_id: '7' }
    })
    expect(importBannerState(ended, NOW, new Set(['7', '8']))).toBeNull()
  })

  it('has no elapsed time when the start is unknown', () => {
    expect(importBannerState([run({ started_at: null })], NOW)).toMatchObject({
      kind: 'running',
      elapsedSeconds: null
    })
  })
})

describe('wording helpers', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(45.9)).toBe('45 s')
    expect(formatElapsed(185)).toBe('3 min 05 s')
    expect(formatElapsed(4320)).toBe('1 h 12 min')
  })

  it('names one running import and the rows a finished run reported', () => {
    expect(runningTitle([run({})])).toBe('PO lines import is running')
    expect(rowsText(1200)).toBe('1,200 rows reported by the run')
    expect(rowsText(1)).toBe('1 row reported by the run')
    expect(rowsText(null)).toBeNull()
  })
})
