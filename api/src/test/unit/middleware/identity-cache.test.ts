import { beforeEach, describe, expect, it, vi } from 'vitest'

// The ≤5 s identity-row cache in authenticate (2026-10-27): only active rows are kept, every
// caller gets its own copy, a write to nivaro_users through an attached pool forgets them,
// and nothing is kept in a process that never attached the seam.

const state = vi.hoisted(() => ({ reads: 0, row: null as Record<string, unknown> | null }))

vi.mock('../../../db/index.js', () => {
  const builder = () => ({
    where: () => ({
      first: async () => {
        state.reads++
        return state.row ? { ...state.row } : undefined
      },
      update: () => Promise.resolve(1)
    })
  })
  return { db: Object.assign(builder, { raw: vi.fn() }) }
})
vi.mock('../../../services/session-policy.js', () => ({
  getSessionPolicy: async () => null,
  limitsFor: () => null,
  judgeSession: () => ({ ok: true })
}))
vi.mock('../../../services/traffic-breaker.js', () => ({ callerBreakerCheck: async () => {} }))

import {
  attachIdentitySeam,
  authenticate,
  forgetIdentityRows,
  isIdentityWrite
} from '../../../middleware/authenticate.js'
import { setStoredCacheConfigForTests } from '../../../services/cache-config.js'

function req(userId: string) {
  return {
    headers: {},
    session: { userId, destroy: vi.fn(async () => {}) },
    server: { redis: {} }
  } as never
}

describe('isIdentityWrite', () => {
  it('a write naming nivaro_users counts; the last_access touch and reads do not', () => {
    expect(isIdentityWrite('update [nivaro_users] set [status] = @p0 where [id] = @p1')).toBe(true)
    expect(isIdentityWrite('delete from [nivaro_users] where [id] = @p0')).toBe(true)
    expect(isIdentityWrite('update [nivaro_users] set [last_access] = @p0 where [id] = @p1')).toBe(
      false
    )
    expect(isIdentityWrite('select * from [nivaro_users] where [id] = @p0')).toBe(false)
    expect(isIdentityWrite('update [nivaro_roles] set [name] = @p0')).toBe(false)
  })
})

describe('identity rows', () => {
  beforeEach(() => {
    state.reads = 0
    state.row = { id: 'U1', role: null, status: 'active', first_name: 'A' }
    setStoredCacheConfigForTests(null)
    forgetIdentityRows()
  })

  it('without an attached seam every request reads the row', async () => {
    // (the seam is attached by the next test; module state carries over in order)
    const r1 = req('U1')
    await authenticate(r1, {} as never).catch(() => {})
    await authenticate(req('U1'), {} as never).catch(() => {})
    expect(state.reads).toBe(2)
  })

  it('with the seam: one read serves the next requests; copies; writes forget', async () => {
    let onQuery: ((q: unknown) => void) | undefined
    attachIdentitySeam({
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        if (ev === 'query') onQuery = fn as (q: unknown) => void
      }
    })
    const a = req('U1') as { user?: Record<string, unknown> }
    const b = req('U1') as { user?: Record<string, unknown> }
    await authenticate(a as never, {} as never).catch(() => {})
    await authenticate(b as never, {} as never).catch(() => {})
    expect(state.reads).toBe(1)
    expect(a.user).toBeDefined()
    expect(a.user).not.toBe(b.user)
    ;(a.user as Record<string, unknown>).api_key_sandbox = true
    expect(b.user?.api_key_sandbox).toBeUndefined()

    onQuery?.({ sql: 'update [nivaro_users] set [status] = @p0 where [id] = @p1' })
    state.row = null
    const c = req('U1') as { user?: unknown; session: { destroy: () => void } }
    await expect(authenticate(c as never, {} as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(state.reads).toBe(2)
  })

  it('IDENTITY_CACHE=off reads every time', async () => {
    process.env.IDENTITY_CACHE = 'off'
    try {
      await authenticate(req('U1'), {} as never).catch(() => {})
      await authenticate(req('U1'), {} as never).catch(() => {})
      expect(state.reads).toBe(2)
    } finally {
      delete process.env.IDENTITY_CACHE
    }
  })
})
