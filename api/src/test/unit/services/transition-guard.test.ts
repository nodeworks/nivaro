import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = { settings: null as number | null, twin: null as Record<string, unknown> | null }

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    const q: Record<string, unknown> = {}
    const chain = () => q
    for (const m of ['where', 'leftJoin', 'orderBy']) q[m] = chain
    q.first = () => {
      const row =
        table === 'nivaro_settings'
          ? { transition_guard_seconds: state.settings }
          : (state.twin ?? undefined)
      return Object.assign(Promise.resolve(row), { catch: () => Promise.resolve(row) })
    }
    return q
  }
  return { db }
})

const guard = await import('../../../services/transition-guard.js')

function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    set: vi.fn(async (k: string, v: string, ...flags: unknown[]) => {
      if (flags.includes('NX') && store.has(k)) return null
      store.set(k, v)
      return 'OK'
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0))
  }
}

describe('transition double-fire guard', () => {
  beforeEach(() => {
    state.settings = null
    state.twin = null
    guard.bustTransitionGuardCache()
    guard.setTransitionGuardRedis(null)
  })

  it('lets the first through and refuses its twin', async () => {
    const redis = fakeRedis()
    // biome-ignore lint/suspicious/noExplicitAny: Redis double
    guard.setTransitionGuardRedis(redis as any)
    await guard.claimTransition({ instanceId: 'i1', transitionId: 't1', label: 'Approve' })
    await expect(
      guard.claimTransition({ instanceId: 'i1', transitionId: 't1', label: 'Approve' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'TRANSITION_DUPLICATE' })
  })

  it('cites the first history row when it has been written', async () => {
    const redis = fakeRedis()
    // biome-ignore lint/suspicious/noExplicitAny: Redis double
    guard.setTransitionGuardRedis(redis as any)
    await guard.claimTransition({ instanceId: 'i1', transitionId: 't1' })
    state.twin = {
      id: 41,
      timestamp: new Date(Date.now() - 3000),
      user: 'u1',
      first_name: 'Kim',
      last_name: 'Lee'
    }
    const err = await guard
      .claimTransition({ instanceId: 'i1', transitionId: 't1', label: 'Approve' })
      .catch((e) => e)
    expect(err.first.history_id).toBe(41)
    expect(err.first.user_name).toBe('Kim Lee')
    expect(err.message).toContain('"Approve" was already made')
    expect(err.message).toContain('Kim Lee')
  })

  it('keeps other records and other transitions apart', async () => {
    const redis = fakeRedis()
    // biome-ignore lint/suspicious/noExplicitAny: Redis double
    guard.setTransitionGuardRedis(redis as any)
    await guard.claimTransition({ instanceId: 'i1', transitionId: 't1' })
    await guard.claimTransition({ instanceId: 'i2', transitionId: 't1' })
    await guard.claimTransition({ instanceId: 'i1', transitionId: 't2' })
    expect(redis.store.size).toBe(3)
  })

  it('allows an immediate retry after a release', async () => {
    const redis = fakeRedis()
    // biome-ignore lint/suspicious/noExplicitAny: Redis double
    guard.setTransitionGuardRedis(redis as any)
    const claim = await guard.claimTransition({ instanceId: 'i1', transitionId: 't1' })
    await claim.release()
    await guard.claimTransition({ instanceId: 'i1', transitionId: 't1' })
  })

  it('is off at zero seconds', async () => {
    state.settings = 0
    const redis = fakeRedis()
    // biome-ignore lint/suspicious/noExplicitAny: Redis double
    guard.setTransitionGuardRedis(redis as any)
    await guard.claimTransition({ instanceId: 'i1', transitionId: 't1' })
    await guard.claimTransition({ instanceId: 'i1', transitionId: 't1' })
    expect(redis.store.size).toBe(0)
  })

  it('falls back to the history row without Redis', async () => {
    await guard.claimTransition({ instanceId: 'i1', transitionId: 't1' })
    state.twin = {
      id: 5,
      timestamp: new Date(),
      user: null,
      first_name: null,
      last_name: null
    }
    await expect(
      guard.claimTransition({ instanceId: 'i1', transitionId: 't1' })
    ).rejects.toMatchObject({ code: 'TRANSITION_DUPLICATE' })
  })
})
