// The "System busy" pill refreshes on job:update. Production runs ~1,100 job runs an hour
// (one cron alone ticks every 10 s), and every start or finish made each open admin tab ask
// GET /job-runs/busy again: 76,000 calls in four days from three people. The event now says
// whether the run is one the pill counts, so a tab re-reads only for those.
import { afterEach, describe, expect, it, vi } from 'vitest'

const ids = vi.hoisted(() => ({ next: 900 }))
const emitted = vi.hoisted(() => ({
  calls: [] as Array<{ event: string; payload: Record<string, unknown> }>
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
    to: () => ({
      emit: (event: string, payload: Record<string, unknown>) =>
        emitted.calls.push({ event, payload })
    })
  }),
  // The cron registry as job-runs reads it: one heavy job, the rest light.
  getApp: () => ({ cron: { isHeavy: (id: string) => id === 'nightly-reforecast' } })
}))

import { BUSY_KINDS, countsAsBusy } from '../../../services/job-busy.js'
import { startJobRun } from '../../../services/job-runs.js'

afterEach(() => {
  emitted.calls.length = 0
})

const updates = () => emitted.calls.filter((c) => c.event === 'job:update').map((c) => c.payload)

describe('countsAsBusy', () => {
  const heavy = (id: string) => id === 'nightly-reforecast'

  it('counts the long-running kinds and heavy cron jobs only', () => {
    for (const kind of BUSY_KINDS) expect(countsAsBusy(kind, 'anything', heavy)).toBe(true)
    expect(countsAsBusy('cron', 'nightly-reforecast', heavy)).toBe(true)
    expect(countsAsBusy('cron', 'staged-imports', heavy)).toBe(false)
    expect(countsAsBusy('monitor', 'event_loop:Server freezes', heavy)).toBe(false)
  })
})

describe('job:update says whether the run counts as busy', () => {
  it('a light cron tick carries no busy flag on its start or its finish', async () => {
    const run = await startJobRun('cron', 'staged-imports')
    await run.complete()
    expect(updates()).toHaveLength(2)
    expect(updates().some((p) => 'busy' in p)).toBe(false)
  })

  it('a heavy cron job is flagged when it starts, finishes or fails', async () => {
    const ok = await startJobRun('cron', 'nightly-reforecast')
    await ok.complete('done')
    const bad = await startJobRun('cron', 'nightly-reforecast')
    await bad.fail(new Error('boom'))
    expect(updates().map((p) => [p.status, p.busy])).toEqual([
      ['running', true],
      ['completed', true],
      ['running', true],
      ['error', true]
    ])
  })

  it('a long-running kind is flagged whatever its job id', async () => {
    const run = await startJobRun('backfill', 'geocode')
    await run.complete()
    expect(updates().every((p) => p.busy === true)).toBe(true)
  })

  it('a registry that cannot answer never breaks the run', async () => {
    const run = await startJobRun('cron', 'x')
    expect(run.id).not.toBeNull()
  })
})
