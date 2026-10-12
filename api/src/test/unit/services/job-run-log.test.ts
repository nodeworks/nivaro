// api/src/test/unit/services/job-run-log.test.ts — #1974 job run logs stream
import { afterEach, describe, expect, it, vi } from 'vitest'

const ids = vi.hoisted(() => ({ next: 40 }))
const emitted = vi.hoisted(() => ({
  calls: [] as Array<{ room: string; event: string; payload: Record<string, unknown> }>
}))

vi.mock('../../../db/index.js', () => {
  const chain = {
    insert: vi.fn(() => chain),
    returning: vi.fn(async () => [{ id: ++ids.next }]),
    where: vi.fn(() => chain),
    update: vi.fn(async () => 1)
  }
  return { db: vi.fn(() => chain) }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))
vi.mock('../../../services/io-holder.js', () => ({
  getIo: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) =>
        emitted.calls.push({ room, event, payload })
    })
  }),
  getApp: () => ({})
}))

import { readJobLog, startJobRun } from '../../../services/job-runs.js'

afterEach(() => {
  emitted.calls.length = 0
})

const logEvents = () => emitted.calls.filter((c) => c.event === 'job:log')

describe('job run log', () => {
  it('writes lifecycle lines and streams each to the jobs watch room', async () => {
    const run = await startJobRun('backfill', 'geocode', { label: 'Geocode' })
    run.log('halfway there')
    await run.complete('done 10')
    const lines = await readJobLog(run.id as number)
    expect(lines.map((l) => l.line)).toEqual([
      'Started: Geocode',
      'halfway there',
      'Completed: done 10'
    ])
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3])
    expect(logEvents().every((c) => c.room === 'watch:jobs')).toBe(true)
    expect(logEvents()).toHaveLength(3)
  })

  it('reads only what the page has not seen', async () => {
    const run = await startJobRun('recalc', 'index-bulk')
    run.log('a')
    run.log('b')
    const after = await readJobLog(run.id as number, 2)
    expect(after.map((l) => l.line)).toEqual(['b'])
  })

  it('keeps one progress line per two seconds, but streams every progress report', async () => {
    const run = await startJobRun('bulk', 'bulk:items')
    run.progress({ done: 1, total: 10 })
    run.progress({ done: 2, total: 10 })
    run.progress({ done: 3, total: 10 })
    const lines = (await readJobLog(run.id as number)).filter((l) => l.line.startsWith('Progress'))
    expect(lines).toHaveLength(1)
    expect(lines[0].line).toBe('Progress: done 1, total 10')
    expect(
      emitted.calls.filter((c) => c.event === 'job:update' && c.payload.progress)
    ).toHaveLength(3)
  })

  it('a failure logs an error-level line', async () => {
    const run = await startJobRun('cron', 'sweep')
    await run.fail(new Error('boom'))
    const last = (await readJobLog(run.id as number)).at(-1)
    expect(last?.level).toBe('error')
    expect(last?.line).toContain('boom')
  })
})

describe('job run events are tenant scoped', () => {
  it('emits job:update and job:log to the run tenant room, never the global one', async () => {
    const tenantCtx = await import('../../../db/tenant-context.js')
    const run = await new Promise<Awaited<ReturnType<typeof startJobRun>>>((resolve) => {
      // biome-ignore lint/suspicious/noExplicitAny: stub tenant db
      tenantCtx.runWithTenantDb(
        {} as any,
        'acme',
        () => void startJobRun('cron', 'tenant-job', {}).then(resolve),
        'acme'
      )
    })
    run.log('hello')
    expect(emitted.calls.length).toBeGreaterThan(0)
    for (const c of emitted.calls) expect(c.room).toBe('t:acme:watch:jobs')
    expect(emitted.calls.some((c) => c.room === 'watch:jobs')).toBe(false)
  })
})
