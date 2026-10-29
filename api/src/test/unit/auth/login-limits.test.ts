import { describe, expect, it, vi } from 'vitest'
import {
  claimTotpCode,
  clearLoginFailures,
  LOGIN_LIMITS,
  LOGIN_WINDOW_S,
  loginBlockedFor,
  loginFailureKeys,
  noteLoginFailure
} from '../../../auth/login-limits.js'

// Security audit M12/H9: failed sign-ins are limited per address and per account.

function memRedis() {
  const kv = new Map<string, string>()
  const ttls = new Map<string, number>()
  return {
    kv,
    ttls,
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    get: async (k: string) => kv.get(k) ?? null,
    incr: async (k: string) => {
      const n = Number(kv.get(k) ?? 0) + 1
      kv.set(k, String(n))
      return n
    },
    ttl: async (k: string) => (kv.has(k) ? (ttls.get(k) ?? -1) : -2),
    expire: async (k: string, s: number) => {
      ttls.set(k, s)
      return 1
    },
    del: async (...ks: string[]) => ks.filter((k) => kv.delete(k)).length,
    set: async (k: string, v: string, ...opts: unknown[]) => {
      if (opts.includes('NX') && kv.has(k)) return null
      kv.set(k, v)
      return 'OK'
    }
  }
}

describe('login failure limits', () => {
  it('blocks an account after its limit, from any address, and tells how long', async () => {
    const r = memRedis()
    const n = LOGIN_LIMITS.password.perAccount
    for (let i = 0; i < n; i++)
      await noteLoginFailure(r as never, 'password', `10.0.0.${i}`, 'Ana@Example.com')
    expect(await loginBlockedFor(r as never, 'password', '10.9.9.9', 'ana@example.com')).toBe(
      LOGIN_WINDOW_S
    )
    // Another account from a fresh address is not affected.
    expect(await loginBlockedFor(r as never, 'password', '10.9.9.9', 'bo@example.com')).toBe(null)
  })

  it('blocks an address guessing many accounts', async () => {
    const r = memRedis()
    for (let i = 0; i < LOGIN_LIMITS.password.perIp; i++)
      await noteLoginFailure(r as never, 'password', '203.0.113.7', `user${i}@example.com`)
    expect(
      await loginBlockedFor(r as never, 'password', '203.0.113.7', 'new@example.com')
    ).not.toBe(null)
  })

  it('a success clears the account counter; every window has an expiry', async () => {
    const r = memRedis()
    await noteLoginFailure(r as never, 'token', '1.2.3.4', 'acct')
    for (const k of r.kv.keys()) expect(r.ttls.get(k)).toBe(LOGIN_WINDOW_S)
    await clearLoginFailures(r as never, 'token', 'acct')
    const { account } = loginFailureKeys('token', null, 'acct')
    expect(r.kv.has(account as string)).toBe(false)
  })

  it('never puts an email or token in a key', () => {
    const k = loginFailureKeys('password', '1.2.3.4', 'secret-person@example.com')
    expect(`${k.ip}${k.account}`).not.toContain('secret-person')
    expect(`${k.ip}${k.account}`).not.toContain('1.2.3.4')
  })

  it('lets attempts through when Redis is missing or failing', async () => {
    expect(await loginBlockedFor(null, 'password', '1.1.1.1', 'a')).toBe(null)
    const broken = { mget: async () => Promise.reject(new Error('down')) }
    expect(await loginBlockedFor(broken as never, 'password', '1.1.1.1', 'a')).toBe(null)
  })
})

describe('claimTotpCode', () => {
  it('accepts a code once per user', async () => {
    const r = memRedis()
    expect(await claimTotpCode(r as never, 'U1', '123456')).toBe(true)
    expect(await claimTotpCode(r as never, 'u1', '123456')).toBe(false)
    expect(await claimTotpCode(r as never, 'U2', '123456')).toBe(true)
  })

  it('fails open on a Redis error, and says so in the log without the code or user', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const broken = { set: async () => Promise.reject(new Error('down')) }
      expect(await claimTotpCode(broken as never, 'U9', '654321')).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
      const line = warn.mock.calls[0].join(' ')
      expect(line).toContain('TOTP replay check failed open')
      expect(line).not.toContain('654321')
      expect(line).not.toContain('U9')
    } finally {
      warn.mockRestore()
    }
  })
})
