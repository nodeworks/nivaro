import { afterEach, describe, expect, it, vi } from 'vitest'

// Issue 1351 (prod 2026-11-20): a job that keeps reporting progress is busy, not hung — its
// watchdog restarts on each noteCronProgress(); one that stops reporting still raises.
vi.mock('../../../services/security.js', () => ({
  maintenanceState: async () => ({ on: false, message: null, display: 'page', until: null })
}))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: async () => ({
    id: 1,
    complete: async () => {},
    fail: async () => {},
    progress: () => {}
  })
}))

const { CronManager } = await import('../../../plugins/cron.js')
const { noteCronProgress } = await import('../../../services/cron-progress.js')

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function manager(issues: string[]) {
  return new CronManager({
    ticksEnabled: () => true,
    onIssue: (message) => void issues.push(message)
  })
}

describe('cron watchdog follows progress (issue 1351)', () => {
  const made: Array<InstanceType<typeof CronManager>> = []
  afterEach(() => {
    for (const m of made.splice(0)) m.unschedule('long-job')
  })

  it('stays quiet while the job keeps reporting, past its whole budget', async () => {
    const issues: string[] = []
    const m = manager(issues)
    made.push(m)
    let done = false
    m.schedule(
      'long-job',
      '* * * * * *',
      async () => {
        if (done) return
        done = true
        for (let i = 0; i < 9; i++) {
          await wait(100)
          noteCronProgress()
        }
      },
      { watchdogMs: 300 }
    )
    await wait(3_000)
    expect(done).toBe(true)
    expect(issues.filter((t) => t.includes('likely hung'))).toEqual([])
  })

  it('raises once a job that reported progress goes quiet past its budget', async () => {
    const issues: string[] = []
    const m = manager(issues)
    made.push(m)
    let done = false
    m.schedule(
      'long-job',
      '* * * * * *',
      async () => {
        if (done) return
        done = true
        noteCronProgress()
        await wait(700)
      },
      { watchdogMs: 300 }
    )
    await wait(3_000)
    expect(done).toBe(true)
    expect(issues.some((t) => t.includes('has made no progress for over'))).toBe(true)
  })

  it('outside a scheduled tick, noteCronProgress does nothing', () => {
    expect(() => noteCronProgress()).not.toThrow()
  })
})
