import { describe, expect, it, vi } from 'vitest'
import {
  attachConnectRetry,
  isLoginRefused,
  isRetriableLoginRefusal,
  openWithLoginRetry,
  retryWarnLine
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

// Security review of the retry (2026-11-12): tedious says ELOGIN for EVERY refused login and
// carries no error number. A login the server refuses because of the ACCOUNT will be refused
// again, and each further attempt counts against a lockout policy.
describe('a login refused because of the account is not tried again', () => {
  const refusedWith = (message: string) => Object.assign(new Error(message), { code: 'ELOGIN' })
  const ACCOUNT_FAULTS = [
    // SQL Server 18486
    "Login failed for user 'app_rw' because the account is currently locked out. The system administrator can unlock it.",
    // 18487
    "Login failed for user 'app_rw'.  Reason: The password of the account has expired.",
    // 18488
    "Login failed for user 'app_rw'.  Reason: The password of the account must be changed.",
    // 18470
    "Login failed for user 'app_rw'. Reason: The account is disabled.",
    // the same wordings, however the server cases them
    "LOGIN FAILED FOR USER 'APP_RW' BECAUSE THE ACCOUNT IS CURRENTLY LOCKED OUT.",
    'Login failed. The Account Is Disabled.'
  ]

  it('opens once and throws the refusal unchanged', async () => {
    for (const message of ACCOUNT_FAULTS) {
      const time = fakeTime()
      const err = refusedWith(message)
      const open = vi.fn(async () => {
        throw err
      })
      const onRetry = vi.fn()
      await expect(openWithLoginRetry(open, { ...time, onRetry }), message).rejects.toBe(err)
      expect(open, message).toHaveBeenCalledTimes(1)
      expect(time.sleeps, message).toEqual([])
      expect(onRetry, message).not.toHaveBeenCalled()
    }
  })

  it('reads the account fault from the message, and from the error number when one is there', () => {
    for (const message of ACCOUNT_FAULTS)
      expect(isRetriableLoginRefusal(refusedWith(message)), message).toBe(false)
    for (const number of [18486, 18487, 18488, 18470])
      expect(
        isRetriableLoginRefusal(Object.assign(refusedWith('Login failed.'), { number })),
        String(number)
      ).toBe(false)
  })

  it('still retries the plain refusal a database that is briefly not taking logins gives', () => {
    for (const message of [
      "Login failed for user 'app_rw'.",
      'Login failed.',
      // 4060 then 18456: the database is offline or mid-restore for a moment
      'Cannot open database "app" requested by the login. The login failed.',
      // 18401: the server is still starting after a restart
      "Login failed for user 'app_rw'. Reason: Server is in script upgrade mode. Only administrator can connect at this time."
    ])
      expect(isRetriableLoginRefusal(refusedWith(message)), message).toBe(true)
    expect(isRetriableLoginRefusal({ code: 'ESOCKET' })).toBe(false)
    expect(isRetriableLoginRefusal(new Error("Login failed for user 'x'."))).toBe(false)
  })
})

describe('the retry warning', () => {
  it('never names the database login or the server it was opening', () => {
    const line = retryWarnLine(
      2,
      Object.assign(new Error("Login failed for user 'app_rw'."), { code: 'ELOGIN' })
    )
    expect(line).toContain('attempt 2')
    expect(line).toContain('Login failed.')
    expect(line).not.toMatch(/app_rw|for user/)

    const addressed = retryWarnLine(
      1,
      new Error(
        "Login failed for user 'CORP\\svc-app'. Failed to connect to sql01.corp.example:1433 - connect ECONNREFUSED 10.0.0.5:1433"
      )
    )
    expect(addressed).not.toMatch(/svc-app|sql01|corp\.example|10\.0\.0\.5|1433/)
    expect(addressed).toContain('ECONNREFUSED')
  })

  it('keeps the rest of the reason', () => {
    expect(
      retryWarnLine(
        1,
        new Error('Cannot open database "app" requested by the login. The login failed.')
      )
    ).toContain('Cannot open database "app" requested by the login. The login failed.')
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
