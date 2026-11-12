import { describe, expect, it, vi } from 'vitest'
import {
  attachConnectRetry,
  isLoginRefused,
  openWithLoginRetry
} from '../../../db/connect-retry.js'

/** What tedious raises when the server answers a login with an error (token/handler.js). */
const loginRefused = () =>
  Object.assign(new Error("Login failed for user 'app_rw'."), { code: 'ELOGIN' })

/** A clock the fake `sleep` moves, so no test waits for real time. */
function fakeTime() {
  let t = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    }
  }
}

// Production 2026-11-12 16:24 UTC: an ALTER DATABASE ... WITH ROLLBACK IMMEDIATE closed every
// pooled connection and refused new logins for a few seconds; 26 requests answered 500
// "Login failed for user" although the database was back before they would have given up waiting.
describe('openWithLoginRetry', () => {
  it('opens once when the login is accepted', async () => {
    const time = fakeTime()
    const open = vi.fn(async () => 'conn')
    await expect(openWithLoginRetry(open, time)).resolves.toBe('conn')
    expect(open).toHaveBeenCalledTimes(1)
    expect(time.sleeps).toEqual([])
  })

  it('tries again while the server refuses the login, then hands over the connection', async () => {
    const time = fakeTime()
    const open = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(loginRefused())
      .mockRejectedValueOnce(loginRefused())
      .mockResolvedValueOnce('conn')
    const onRetry = vi.fn()
    await expect(openWithLoginRetry(open, { ...time, onRetry })).resolves.toBe('conn')
    expect(open).toHaveBeenCalledTimes(3)
    expect(time.sleeps).toEqual([250, 500])
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('gives up inside its time budget and throws the login error unchanged', async () => {
    const time = fakeTime()
    const err = loginRefused()
    const open = vi.fn(async () => {
      throw err
    })
    await expect(openWithLoginRetry(open, time)).rejects.toBe(err)
    // A real outage still surfaces as itself, and before a waiting request gives up (10 s).
    expect(open.mock.calls.length).toBeGreaterThan(1)
    expect(open.mock.calls.length).toBeLessThanOrEqual(6)
    expect(time.now()).toBeLessThanOrEqual(7000)
  })

  it('counts slow login attempts against the budget', async () => {
    const time = fakeTime()
    const open = vi.fn(async () => {
      time.advance(3000) // each refused login took three seconds to come back
      throw loginRefused()
    })
    await expect(openWithLoginRetry(open, time)).rejects.toMatchObject({ code: 'ELOGIN' })
    expect(open).toHaveBeenCalledTimes(3)
    expect(time.now()).toBeLessThanOrEqual(10_000)
  })

  it('does not retry anything but a refused login', async () => {
    for (const err of [
      Object.assign(new Error('Failed to connect to db:1433 - connect ECONNREFUSED'), {
        code: 'ESOCKET'
      }),
      Object.assign(new Error('Failed to connect to db:1433 in 15000ms'), { code: 'ETIMEOUT' }),
      new Error('boom')
    ]) {
      const time = fakeTime()
      const open = vi.fn(async () => {
        throw err
      })
      await expect(openWithLoginRetry(open, time)).rejects.toBe(err)
      expect(open).toHaveBeenCalledTimes(1)
      expect(time.sleeps).toEqual([])
    }
  })
})

describe('isLoginRefused', () => {
  it('is the driver’s login error only', () => {
    expect(isLoginRefused(loginRefused())).toBe(true)
    expect(isLoginRefused({ code: 'ESOCKET' })).toBe(false)
    expect(isLoginRefused(new Error("Login failed for user 'x'."))).toBe(false)
    expect(isLoginRefused(null)).toBe(false)
  })
})

describe('attachConnectRetry', () => {
  class FakeClient {
    opens = 0
    failFirst = 1
    async acquireRawConnection(): Promise<{ owner: FakeClient }> {
      this.opens++
      if (this.opens <= this.failFirst) throw loginRefused()
      return { owner: this }
    }
  }

  it('wraps that pool’s connection open and leaves other pools of the same driver alone', async () => {
    const time = fakeTime()
    const requests = new FakeClient()
    const probe = new FakeClient()
    attachConnectRetry({ client: requests }, time)

    const conn = await requests.acquireRawConnection()
    expect(conn.owner).toBe(requests)
    expect(requests.opens).toBe(2)
    expect(time.sleeps).toEqual([250])

    // The health probe's pool (same driver class) must still fail at once: it is what tells
    // a real outage from a moment's refusal.
    await expect(probe.acquireRawConnection()).rejects.toMatchObject({ code: 'ELOGIN' })
    expect(probe.opens).toBe(1)
  })

  it('wraps once however often it is attached', async () => {
    const time = fakeTime()
    const client = new FakeClient()
    client.failFirst = 99
    attachConnectRetry({ client }, time)
    attachConnectRetry({ client }, time)
    await expect(client.acquireRawConnection()).rejects.toMatchObject({ code: 'ELOGIN' })
    expect(client.opens).toBeLessThanOrEqual(6)
  })

  it('ignores an instance with no driver (cloud placeholder)', () => {
    expect(() => attachConnectRetry({})).not.toThrow()
    expect(() => attachConnectRetry({ client: {} })).not.toThrow()
  })
})
