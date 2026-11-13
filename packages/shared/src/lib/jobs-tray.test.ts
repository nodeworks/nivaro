// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetJobsTray,
  __trayJobs,
  applyJobUpdate,
  dismissFinishedJobs,
  dismissJob,
  seedJobs,
  type TrayJob,
  trayHeadline
} from './jobs-tray'

describe('jobs tray model', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetJobsTray()
  })

  it('updates one entry in place as a job runs and finishes', () => {
    applyJobUpdate({ key: 'job:1', kind: 'bulk', label: '40 rows', status: 'running' })
    applyJobUpdate({ key: 'job:1', status: 'running', progress: { done: 10, total: 40 } })
    expect(__trayJobs()).toHaveLength(1)
    expect(__trayJobs()[0].label).toBe('40 rows')
    expect(__trayJobs()[0].progress).toEqual({ done: 10, total: 40 })
    applyJobUpdate({ key: 'job:1', status: 'completed', outcome: '40/40 written' })
    expect(__trayJobs()[0]).toMatchObject({ status: 'completed', outcome: '40/40 written' })
  })

  it('does not drag a finished job back to running on a late tick', () => {
    applyJobUpdate({ key: 'job:2', kind: 'export', label: 'Export', status: 'completed' })
    applyJobUpdate({ key: 'job:2', status: 'running', progress: { done: 1, total: 2 } })
    expect(__trayJobs()[0].status).toBe('completed')
  })

  it('keeps a download chip across the finish', () => {
    applyJobUpdate({
      key: 'job:3',
      kind: 'export',
      label: 'Export',
      status: 'completed',
      file_id: 'F1'
    })
    expect(__trayJobs()[0].file_id).toBe('F1')
  })

  it('a dismissed finished job stays gone when the server list seeds it again', () => {
    applyJobUpdate({ key: 'job:4', kind: 'bulk', label: 'x', status: 'completed' })
    dismissJob('job:4')
    seedJobs([{ key: 'job:4', kind: 'bulk', label: 'x', status: 'completed' }])
    expect(__trayJobs()).toHaveLength(0)
  })

  it('clear finished leaves what is still running', () => {
    applyJobUpdate({ key: 'job:5', kind: 'bulk', label: 'a', status: 'running' })
    applyJobUpdate({ key: 'job:6', kind: 'bulk', label: 'b', status: 'error', error: 'boom' })
    dismissFinishedJobs()
    expect(__trayJobs().map((j) => j.key)).toEqual(['job:5'])
  })

  it('a re-queued import shows again after being dismissed', () => {
    applyJobUpdate({ key: 'import:9', kind: 'import', label: 'po', status: 'error', error: 'x' })
    dismissJob('import:9')
    applyJobUpdate({ key: 'import:9', kind: 'import', label: 'po', status: 'queued', position: 2 })
    expect(__trayJobs()[0]).toMatchObject({ status: 'queued', position: 2 })
  })

  it('keeps a running job cancellable across progress ticks and drops Cancel once it ends (#2456)', () => {
    applyJobUpdate({
      key: 'job:7',
      kind: 'ai',
      label: 'Ask AI: aging',
      status: 'running',
      cancel_path: '/ai/research/7/cancel'
    })
    applyJobUpdate({ key: 'job:7', status: 'running', progress: { phase: 'Reading…', done: 1 } })
    expect(__trayJobs()[0].cancel_path).toBe('/ai/research/7/cancel')
    applyJobUpdate({ key: 'job:7', status: 'canceled', outcome: 'Cancelled' })
    expect(__trayJobs()[0]).toMatchObject({ status: 'canceled', cancel_path: null })
  })
})

// Go-live week review (2026-11-12): the header showed a green check and "1 job finished" for a
// job that failed. It says what happened, and mixed results say each part.
describe('trayHeadline', () => {
  const job = (status: TrayJob['status'], key = Math.random().toString()): TrayJob => ({
    key,
    kind: 'bulk',
    label: 'x',
    status,
    at: 0
  })
  const of = (...s: TrayJob['status'][]) => trayHeadline(s.map((x) => job(x)))

  it('a run that worked reads as finished', () => {
    expect(of('completed')).toEqual({ tone: 'done', text: '1 job finished', note: null })
    expect(of('completed', 'completed')).toMatchObject({ tone: 'done', text: '2 jobs finished' })
  })

  it('a failed run reads as failed, never finished', () => {
    expect(of('error')).toEqual({ tone: 'failed', text: '1 job failed', note: null })
    expect(of('error', 'error')).toMatchObject({ tone: 'failed', text: '2 jobs failed' })
  })

  it('mixed results name each part, the failure first', () => {
    expect(of('completed', 'error', 'completed')).toMatchObject({
      tone: 'failed',
      text: '1 job failed, 2 done'
    })
    expect(of('error', 'canceled', 'completed')).toMatchObject({
      tone: 'failed',
      text: '1 job failed, 1 done, 1 cancelled'
    })
  })

  it('a cancelled run is neither done nor failed', () => {
    expect(of('canceled')).toEqual({ tone: 'cancelled', text: '1 job cancelled', note: null })
    expect(of('completed', 'canceled')).toMatchObject({
      tone: 'done',
      text: '1 job done, 1 cancelled'
    })
  })

  it('while something runs it leads, and a failure beside it is still said', () => {
    expect(of('running', 'queued')).toEqual({ tone: 'running', text: '2 jobs running', note: null })
    expect(of('running', 'error', 'completed')).toEqual({
      tone: 'running',
      text: '1 job running',
      note: '1 failed'
    })
  })
})
