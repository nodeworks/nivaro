import { afterEach, describe, expect, it, vi } from 'vitest'

const runs: string[] = []
let release: (() => void) | null = null
// Read through a function so TypeScript does not narrow the module variable.
const releaseRun = () => (release as (() => void) | null)?.()

vi.mock('../../../db/index.js', () => ({
  // The queue lookup answers "no such queue", so a run is just the
  // bookkeeping — held open until the test releases it.
  db: vi.fn(() => ({
    where: () => ({
      first: () =>
        new Promise((r) => {
          release = () => r(undefined)
        })
    })
  }))
}))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: vi.fn(async (_k: string, id: string) => {
    runs.push(id)
    return { id: runs.length, progress: vi.fn(), complete: vi.fn(), fail: vi.fn() }
  })
}))

import { enqueueQueueMaterializationBackfill } from '../../../functions/queue-materialization-jobs.js'

const tick = () => new Promise((r) => setTimeout(r, 5))
async function until(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++) await tick()
}

afterEach(() => {
  runs.length = 0
  release = null
})

describe('queue backfill runner (Inngest replacement)', () => {
  it('runs one backfill per queue at a time and one more pass for requests made meanwhile', async () => {
    await enqueueQueueMaterializationBackfill('q1')
    await until(() => runs.length === 1 && release !== null)
    expect(runs).toEqual(['q1'])
    // Three more requests while the first runs collapse into ONE extra pass.
    await enqueueQueueMaterializationBackfill('q1')
    await enqueueQueueMaterializationBackfill('q1')
    await enqueueQueueMaterializationBackfill('q1')
    await tick()
    expect(runs).toEqual(['q1'])
    const first = release
    release = null
    first?.()
    await until(() => runs.length === 2 && release !== null)
    expect(runs).toEqual(['q1', 'q1'])
    releaseRun()
    for (let i = 0; i < 20; i++) await tick()
    expect(runs).toEqual(['q1', 'q1'])
  })
})
