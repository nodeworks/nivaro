// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetJobsTray,
  __trayJobs,
  applyJobUpdate,
  dismissFinishedJobs,
  dismissJob,
  seedJobs
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
})
