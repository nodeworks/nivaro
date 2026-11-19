import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => 't1' }))

import {
  aiToolLaneStats,
  holdsAiToolSlot,
  resetAiToolLane,
  withAiToolLane
} from '../../../services/ai-tool-lane.js'

/** A body that stays running until released. */
function held() {
  let release!: () => void
  const done = new Promise<void>((r) => {
    release = r
  })
  return { release, body: () => done }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  resetAiToolLane()
  process.env.AI_TOOL_CONCURRENCY = '3'
  process.env.AI_TOOL_PER_USER = '2'
  process.env.AI_TOOL_MAX_WAIT_MS = '60000'
})
afterEach(() => {
  delete process.env.AI_TOOL_CONCURRENCY
  delete process.env.AI_TOOL_PER_USER
  delete process.env.AI_TOOL_MAX_WAIT_MS
})

describe('Ask AI tool lane', () => {
  it('one person gets at most their share; the third run waits', async () => {
    const a = held()
    const b = held()
    const c = held()
    const p1 = withAiToolLane('ann', a.body)
    const p2 = withAiToolLane('ann', b.body)
    let thirdStarted = false
    const p3 = withAiToolLane('ann', async () => {
      thirdStarted = true
      await c.body()
    })
    await tick()
    expect(thirdStarted).toBe(false)
    expect(aiToolLaneStats().lanes[0]).toMatchObject({ active: 2, waiting: 1 })
    a.release()
    await p1
    await tick()
    expect(thirdStarted).toBe(true)
    b.release()
    c.release()
    await Promise.all([p2, p3])
    expect(aiToolLaneStats().lanes[0]).toMatchObject({ active: 0, waiting: 0 })
  })

  it('another person is not stuck behind someone at their share', async () => {
    const a = held()
    const b = held()
    const p1 = withAiToolLane('ann', a.body)
    const p2 = withAiToolLane('ann', b.body)
    const queued = withAiToolLane('ann', async () => {})
    let bobRan = false
    await withAiToolLane('bob', async () => {
      bobRan = true
    })
    expect(bobRan).toBe(true)
    a.release()
    b.release()
    await Promise.all([p1, p2, queued])
  })

  it('the process total holds across people', async () => {
    const hs = [held(), held(), held()]
    const ps = [
      withAiToolLane('ann', hs[0].body),
      withAiToolLane('bob', hs[1].body),
      withAiToolLane('cy', hs[2].body)
    ]
    let dan = false
    const pd = withAiToolLane('dan', async () => {
      dan = true
    })
    await tick()
    expect(dan).toBe(false)
    hs[0].release()
    await pd
    expect(dan).toBe(true)
    for (const h of hs) h.release()
    await Promise.all(ps)
  })

  it('a slot is given back when the tool throws', async () => {
    await expect(
      withAiToolLane('ann', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(aiToolLaneStats().lanes[0].active).toBe(0)
  })

  it('waits at most the max wait, then runs anyway (fail open)', async () => {
    process.env.AI_TOOL_MAX_WAIT_MS = '20'
    const a = held()
    const b = held()
    const p1 = withAiToolLane('ann', a.body)
    const p2 = withAiToolLane('ann', b.body)
    let ran = false
    await withAiToolLane('ann', async () => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(aiToolLaneStats().lanes[0].failOpen).toBe(1)
    a.release()
    b.release()
    await Promise.all([p1, p2])
    expect(aiToolLaneStats().lanes[0].active).toBe(0)
  })

  it('a nested tool run does not take a second slot', async () => {
    process.env.AI_TOOL_PER_USER = '1'
    let inner = false
    await withAiToolLane('ann', async () => {
      expect(holdsAiToolSlot()).toBe(true)
      await withAiToolLane('ann', async () => {
        inner = true
      })
    })
    expect(inner).toBe(true)
  })

  it('a cancelled waiter leaves the queue', async () => {
    const a = held()
    const b = held()
    const p1 = withAiToolLane('ann', a.body)
    const p2 = withAiToolLane('ann', b.body)
    const ac = new AbortController()
    const p3 = withAiToolLane('ann', async () => {}, { signal: ac.signal })
    await tick()
    ac.abort()
    await expect(p3).rejects.toMatchObject({ name: 'AbortError' })
    expect(aiToolLaneStats().lanes[0].waiting).toBe(0)
    a.release()
    b.release()
    await Promise.all([p1, p2])
  })
})
