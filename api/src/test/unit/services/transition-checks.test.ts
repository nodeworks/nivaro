import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const c: Record<string, unknown> = {}
    c.where = vi.fn((w: { id: string }) => {
      c.id = w.id
      return c
    })
    c.first = vi.fn(async () => ({ key: `key-of-${c.id}` }))
    return c
  })
}))

import {
  clearTransitionChecks,
  registeredTransitionRefusal,
  registerTransitionCheck
} from '../../../services/transition-checks.js'

const ask = () =>
  registeredTransitionRefusal({
    collection: 'orders',
    item: '1',
    transitionId: 't1',
    fromState: 's-a',
    toState: 's-b',
    user: { id: 'u1', role: 'r1' },
    isAdmin: false
  })

describe('transition checks', () => {
  beforeEach(() => {
    clearTransitionChecks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('no checks -> null', async () => {
    expect(await ask()).toBeNull()
  })

  it('passes a refusal through and hands checks state keys', async () => {
    const fn = vi.fn(async () => ({ status: 422, error: 'No', code: 'NOPE' }))
    registerTransitionCheck('ext', fn)
    expect(await ask()).toEqual({ status: 422, body: { error: 'No', code: 'NOPE' } })
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ fromState: 'key-of-s-a', toState: 'key-of-s-b' })
    )
  })

  it('first refusal wins', async () => {
    const second = vi.fn(async () => ({ status: 409, error: 'B', code: 'B' }))
    registerTransitionCheck('a', async () => ({ status: 422, error: 'A', code: 'A' }))
    registerTransitionCheck('b', second)
    expect((await ask())?.body.code).toBe('A')
    expect(second).not.toHaveBeenCalled()
  })

  it('a throwing check -> 503 TRANSITION_CHECK_FAILED', async () => {
    registerTransitionCheck('boom', async () => {
      throw new Error('x')
    })
    const r = await ask()
    expect(r?.status).toBe(503)
    expect(r?.body.code).toBe('TRANSITION_CHECK_FAILED')
    expect(console.warn).toHaveBeenCalled()
  })

  it('a state lookup failure -> 503 TRANSITION_CHECK_FAILED', async () => {
    registerTransitionCheck('ext', async () => null)
    const { db } = await import('../../../db/index.js')
    vi.mocked(db).mockImplementationOnce((() => {
      throw new Error('db down')
    }) as never)
    const r = await ask()
    expect(r?.status).toBe(503)
    expect(r?.body.code).toBe('TRANSITION_CHECK_FAILED')
  })

  it('same owner re-register replaces', async () => {
    registerTransitionCheck('ext', async () => ({ status: 422, error: 'old', code: 'OLD' }))
    registerTransitionCheck('ext', async () => null)
    expect(await ask()).toBeNull()
  })
})
