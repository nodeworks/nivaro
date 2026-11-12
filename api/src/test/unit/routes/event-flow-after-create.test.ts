import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Production review 2026-11-12: creating an inventory request answered after
// 2.3 s on average, 1.5 s of it an "after" event flow's push to a partner. The
// flow editor calls that timing "async, post-save processing", and outside a
// create nobody waits for it; inside a create's unit of work the run was
// carried to its end before the create returned.

vi.mock('../../../middleware/authenticate.js', () => ({ requireAdmin: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
const flow = vi.hoisted(() => ({
  executeFlow: vi.fn(async (_ctx: { trigger: string }) => ({}) as Record<string, unknown>)
}))
vi.mock('../../../services/flow-executor.js', () => flow)
const FLOW_ID = 'F-AFTER'
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({
    where: vi.fn(async () => [
      {
        id: 'F-AFTER',
        name: 'Tell the partner',
        trigger: 'event',
        status: 'active',
        trigger_options: JSON.stringify({
          timing: 'after',
          types: ['create', 'update'],
          collections: ['requests']
        })
      }
    ])
  }))
}))

import type { FastifyInstance } from 'fastify'
import { hooks } from '../../../hooks/registry.js'
import { loadEventFlows } from '../../../routes/flows.js'
import { runUnit } from '../../../services/unit-of-work.js'

const app = {
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
} as unknown as FastifyInstance

const created = () =>
  hooks.trigger('after', {
    collection: 'requests',
    action: 'create',
    keys: [7],
    payload: { name: 'A request' },
    database: {} as never
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A partner call that stays out until released. */
function slowRun() {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  let finished = false
  flow.executeFlow.mockImplementation(async () => {
    await gate
    finished = true
    return {}
  })
  return { release, finished: () => finished }
}

beforeEach(async () => {
  flow.executeFlow.mockReset()
  await loadEventFlows(app)
})
afterEach(() => hooks.removeExtensionHooks(`flow-event:${FLOW_ID}`))

describe('an "after" event flow on a create', () => {
  it('starts once the create has landed and does not hold the answer', async () => {
    const run = slowRun()
    const unit = runUnit('create:requests', async () => {
      await created()
      // Held while the create is still being written.
      expect(flow.executeFlow).not.toHaveBeenCalled()
      return 'created'
    })

    const outcome = await Promise.race([unit, sleep(250).then(() => 'still waiting')])

    expect(outcome).toBe('created')
    expect(flow.executeFlow).toHaveBeenCalledTimes(1)
    expect(flow.executeFlow.mock.calls[0]?.[0]?.trigger).toBe('after:create')
    expect(run.finished()).toBe(false)
    run.release()
    await sleep(0)
    expect(run.finished()).toBe(true)
  })

  it('never runs for a create that is undone', async () => {
    await expect(
      runUnit('create:requests', async () => {
        await created()
        throw new Error('a line was refused')
      })
    ).rejects.toThrow('a line was refused')
    await sleep(0)

    expect(flow.executeFlow).not.toHaveBeenCalled()
  })

  it('a failed run is logged and never reaches the writer', async () => {
    flow.executeFlow.mockRejectedValue(new Error('partner said no'))

    await expect(runUnit('create:requests', () => created())).resolves.toBeUndefined()
    await sleep(0)

    expect(app.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: FLOW_ID }),
      'Event flow execution failed'
    )
  })
})
