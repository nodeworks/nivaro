import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The db is only reached when a refresh runs; the schedule is what is tested here.
const refresh = vi.fn(async () => 0)
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../db/pool-context.js', () => ({
  runInBackgroundPool: (fn: () => unknown) => fn()
}))

const mod = await import('../../../services/queue-owner-refresh.js')
const { ownersChanged } = await import('../../../db/owner-signal.js')

describe('materialized owner refresh — scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    refresh.mockClear()
    vi.spyOn(mod, 'refreshMaterializedOwners').mockImplementation(refresh)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('a transition (records) never schedules a refresh', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    ownersChanged('records')
    expect(spy).not.toHaveBeenCalled()
  })

  it('waits for 30 s of quiet, and never more than 2 min after the first change', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    mod.scheduleMaterializedOwnerRefresh()
    expect(spy.mock.calls.at(-1)?.[1]).toBe(30_000)
    // A change every 20 s keeps the burst open…
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20_000)
      mod.scheduleMaterializedOwnerRefresh()
    }
    // …100 s in, only 20 s of the 2 min cap remain.
    expect(spy.mock.calls.at(-1)?.[1]).toBe(20_000)
  })
})
