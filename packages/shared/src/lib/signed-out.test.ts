import type { Command, NivaroClient } from '@nivaro/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withGetCoalescing } from './request-gate'
import {
  __resetSignedOutGate,
  claimIdentityCall,
  guardIdentityCall,
  isSignedOut,
  isSignedOutError,
  noteCredentialChanged,
  noteSignedIn,
  noteUnauthorized,
  onSignedIn,
  SIGNED_OUT_MAX_MS,
  signedOutBackoff
} from './signed-out'

const refused = (code?: string) =>
  Object.assign(new Error('Unauthorized'), { status: 401, response: code ? { code } : {} })

beforeEach(() => {
  __resetSignedOutGate()
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => vi.useRealTimers())

describe('signedOutBackoff', () => {
  it('doubles from 1 s and never passes 5 min, jittered ±25%', () => {
    const mid = () => 0.5
    expect([1, 2, 3, 4, 9, 10, 30].map((n) => signedOutBackoff(n, mid))).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      256_000,
      SIGNED_OUT_MAX_MS,
      SIGNED_OUT_MAX_MS
    ])
    expect(signedOutBackoff(1, () => 0)).toBe(750)
    expect(signedOutBackoff(1, () => 1)).toBe(1_250)
    for (let i = 0; i < 50; i++) expect(signedOutBackoff(40)).toBeLessThanOrEqual(SIGNED_OUT_MAX_MS)
    expect(signedOutBackoff(40, () => 0)).toBe(SIGNED_OUT_MAX_MS * 0.75)
  })
})

describe('isSignedOutError', () => {
  it('reads the status and code off SDK and axios errors; View-as refusals never count', () => {
    expect(isSignedOutError(refused('NOT_SIGNED_IN'))).toBe(true)
    expect(isSignedOutError({ response: { status: 401, data: { code: 'SESSION_EXPIRED' } } })).toBe(
      true
    )
    expect(isSignedOutError(refused('MASQUERADE_EXPIRED'), true)).toBe(false)
    expect(isSignedOutError(refused('KEY_SIM_EXPIRED'), true)).toBe(false)
    // Any other 401 counts only from an identity call (a public form's wrong password does not).
    expect(isSignedOutError(refused('PASSWORD_REQUIRED'))).toBe(false)
    expect(isSignedOutError(refused(), true)).toBe(true)
    expect(isSignedOutError({ status: 403, response: { code: 'NOT_SIGNED_IN' } })).toBe(false)
  })
})

describe('the gate', () => {
  it('lets one probe through per backoff window while signed out', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(claimIdentityCall()).toBe(true)
    noteUnauthorized()
    expect(isSignedOut()).toBe(true)
    expect(claimIdentityCall()).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(claimIdentityCall()).toBe(true) // the probe
    expect(claimIdentityCall()).toBe(false) // everyone else waits
    noteUnauthorized()
    vi.advanceTimersByTime(1_999)
    expect(claimIdentityCall()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(claimIdentityCall()).toBe(true)
  })

  it('an ordinary refusal closes an open gate but never lengthens the wait', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    noteUnauthorized(false)
    noteUnauthorized(false)
    noteUnauthorized(false)
    vi.advanceTimersByTime(1_000)
    expect(claimIdentityCall()).toBe(true)
  })

  it('a sign-in reopens at once and tells listeners; a credential change reopens too', () => {
    const heard = vi.fn()
    const off = onSignedIn(heard)
    noteUnauthorized()
    noteSignedIn()
    expect(isSignedOut()).toBe(false)
    expect(claimIdentityCall()).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
    // already signed in: no second event
    noteSignedIn()
    expect(heard).toHaveBeenCalledTimes(1)
    noteUnauthorized()
    noteCredentialChanged()
    expect(isSignedOut()).toBe(false)
    expect(heard).toHaveBeenCalledTimes(2)
    off()
    noteUnauthorized()
    noteSignedIn()
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('guardIdentityCall answers locally while signed out and learns from each answer', async () => {
    const call = vi.fn(async () => {
      throw refused('NOT_SIGNED_IN')
    })
    await expect(guardIdentityCall(call, () => null)).rejects.toThrow()
    expect(call).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) expect(await guardIdentityCall(call, () => null)).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SIGNED_OUT_MAX_MS)
    call.mockResolvedValueOnce('tok' as never)
    expect(await guardIdentityCall(call, () => null)).toBe('tok')
    expect(isSignedOut()).toBe(false)
  })
})

describe('withGetCoalescing + the gate', () => {
  function client(handler: (path: string) => unknown) {
    const request = vi.fn(async (cmd: Command<unknown>) => {
      const c = cmd as unknown as { _path: string }
      const out = handler(c._path)
      if (out instanceof Error) throw out
      return out
    })
    const setToken = vi.fn()
    const base = { request, setToken, getToken: () => undefined } as unknown as NivaroClient
    return { wrapped: withGetCoalescing(base), request, setToken }
  }
  const get = (path: string) => ({ _method: 'GET', _path: path }) as unknown as Command<unknown>

  it('stops asking /auth/me and /users/me after a 401 until a sign-in, other reads still go', async () => {
    let signedIn = false
    const { wrapped, request } = client((path) =>
      signedIn || path === '/collections' ? { data: { path } } : refused('NOT_SIGNED_IN')
    )
    await expect(wrapped.request(get('/auth/me'))).rejects.toMatchObject({ status: 401 })
    for (let i = 0; i < 10; i++) {
      await expect(wrapped.request(get('/auth/me'))).rejects.toMatchObject({ status: 401 })
      await expect(wrapped.request(get('/users/me'))).rejects.toMatchObject({ status: 401 })
    }
    expect(request).toHaveBeenCalledTimes(1)
    await wrapped.request(get('/collections'))
    expect(request).toHaveBeenCalledTimes(2)

    // another tab signed in (or the host said so): asking resumes at once
    signedIn = true
    noteSignedIn()
    await expect(wrapped.request(get('/users/me'))).resolves.toEqual({
      data: { path: '/users/me' }
    })
  })

  it('a new bearer token reopens the gate', async () => {
    const { wrapped, request, setToken } = client(() => refused('TOKEN_INVALID'))
    await expect(wrapped.request(get('/auth/me'))).rejects.toBeTruthy()
    wrapped.setToken('fresh')
    expect(setToken).toHaveBeenCalledWith('fresh')
    await expect(wrapped.request(get('/auth/me'))).rejects.toBeTruthy()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('a View-as refusal never closes the gate', async () => {
    const { wrapped, request } = client(() => refused('MASQUERADE_EXPIRED'))
    await expect(wrapped.request(get('/auth/me'))).rejects.toBeTruthy()
    await expect(wrapped.request(get('/auth/me'))).rejects.toBeTruthy()
    expect(request).toHaveBeenCalledTimes(2)
    expect(isSignedOut()).toBe(false)
  })
})
