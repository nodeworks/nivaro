import { afterEach, describe, expect, it, vi } from 'vitest'

// The Redis reads that sign a request in carry a time limit: a Redis that stops answering
// (the shared ioredis client has no command timeout) fails the request with 503 instead of
// holding it open with no end. An answer inside the limit is unchanged.

vi.mock('../../../services/socket-access.js', () => ({ endSessionSockets: vi.fn() }))

import { buildRedisStore } from '../../../auth/session.js'
import { AUTH_READ_TIMEOUT_MS, withAuthDeadline } from '../../../services/auth-deadline.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('withAuthDeadline', () => {
  it('passes an answer through unchanged', async () => {
    await expect(withAuthDeadline(Promise.resolve('v'), 'x')).resolves.toBe('v')
    await expect(withAuthDeadline(Promise.reject(new Error('boom')), 'x')).rejects.toThrow('boom')
  })

  it('fails with 503 AUTH_BACKEND_TIMEOUT once the limit passes', async () => {
    vi.useFakeTimers()
    const p = withAuthDeadline(new Promise(() => {}), 'the session store')
    const caught = p.catch((e) => e)
    await vi.advanceTimersByTimeAsync(AUTH_READ_TIMEOUT_MS)
    const err = (await caught) as Error
    expect(err).toMatchObject({ statusCode: 503, code: 'AUTH_BACKEND_TIMEOUT' })
    expect(String(err.message)).toContain('the session store')
  })

  it('leaves no timer behind when the answer comes first', async () => {
    vi.useFakeTimers()
    await withAuthDeadline(Promise.resolve(1), 'x')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('swallows a late failure after the deadline won', async () => {
    vi.useFakeTimers()
    let fail: (e: Error) => void = () => {}
    const work = new Promise((_, reject) => {
      fail = reject
    })
    const caught = withAuthDeadline(work, 'x', 10).catch((e) => e)
    await vi.advanceTimersByTimeAsync(10)
    expect(await caught).toMatchObject({ code: 'AUTH_BACKEND_TIMEOUT' })
    fail(new Error('late')) // must not surface as an unhandled rejection
    await vi.advanceTimersByTimeAsync(1)
  })
})

describe('session store get', () => {
  it('answers the stored session as before', async () => {
    const redis = {
      mget: vi.fn(async () => [JSON.stringify({ userId: 'u1' }), null])
    }
    const store = buildRedisStore(redis as never)
    const got = await new Promise<[unknown, unknown]>((resolve) =>
      store.get('sid', (err, s) => resolve([err, s]))
    )
    expect(got).toEqual([null, { userId: 'u1' }])
  })

  it('fails with 503 instead of hanging when Redis does not answer', async () => {
    vi.useFakeTimers()
    const redis = { mget: vi.fn(() => new Promise(() => {})) }
    const store = buildRedisStore(redis as never)
    const got = new Promise<[unknown, unknown]>((resolve) =>
      store.get('sid', (err, s) => resolve([err, s]))
    )
    await vi.advanceTimersByTimeAsync(AUTH_READ_TIMEOUT_MS)
    const [err, session] = await got
    expect(err).toMatchObject({ statusCode: 503, code: 'AUTH_BACKEND_TIMEOUT' })
    expect(session).toBeNull()
  })
})
