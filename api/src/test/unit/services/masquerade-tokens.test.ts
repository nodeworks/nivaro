import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/socket-access.js', () => ({ endMasqueradeSockets: vi.fn() }))

import {
  endAdminMasquerades,
  forgetMasqueradeToken,
  MASQ_TTL_S,
  masqByAdminKey,
  noteMasqueradeToken
} from '../../../services/masquerade-tokens.js'
import { endMasqueradeSockets } from '../../../services/socket-access.js'

// A tiny in-memory Redis: strings + sets, enough for the View-as token index.
function fakeRedis() {
  const strings = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  const ttl = new Map<string, number>()
  const redis = {
    strings,
    sets,
    ttl,
    sadd: vi.fn(async (k: string, v: string) => {
      if (!sets.has(k)) sets.set(k, new Set())
      sets.get(k)!.add(v)
      return 1
    }),
    srem: vi.fn(async (k: string, v: string) => (sets.get(k)?.delete(v) ? 1 : 0)),
    smembers: vi.fn(async (k: string) => [...(sets.get(k) ?? [])]),
    expire: vi.fn(async (k: string, s: number) => {
      ttl.set(k, s)
      return 1
    }),
    del: vi.fn(async (k: string) => {
      const had = strings.delete(k) || sets.delete(k)
      return had ? 1 : 0
    })
  }
  return redis
}

describe('View-as token index', () => {
  it('remembers each token an admin starts, with the token lifetime', async () => {
    const r = fakeRedis()
    await noteMasqueradeToken(r as never, 'admin-1', 'nvm_a')
    await noteMasqueradeToken(r as never, 'admin-1', 'nvm_b')
    expect([...r.sets.get(masqByAdminKey('admin-1'))!]).toEqual(['nvm_a', 'nvm_b'])
    expect(r.ttl.get(masqByAdminKey('admin-1'))).toBe(MASQ_TTL_S)
  })

  it('keys the index by admin id regardless of case', () => {
    expect(masqByAdminKey('abc-DEF')).toBe(masqByAdminKey('ABC-def'))
  })

  it('sign-out ends every View-as the admin started and closes their sockets', async () => {
    const r = fakeRedis()
    r.strings.set('masq:nvm_a', '{}')
    r.strings.set('masq:nvm_b', '{}')
    r.strings.set('masq:nvm_other', '{}')
    await noteMasqueradeToken(r as never, 'admin-1', 'nvm_a')
    await noteMasqueradeToken(r as never, 'admin-1', 'nvm_b')
    await noteMasqueradeToken(r as never, 'admin-2', 'nvm_other')

    expect(await endAdminMasquerades(r as never, 'admin-1')).toBe(2)
    expect(r.strings.has('masq:nvm_a')).toBe(false)
    expect(r.strings.has('masq:nvm_b')).toBe(false)
    expect(r.sets.has(masqByAdminKey('admin-1'))).toBe(false)
    expect(endMasqueradeSockets).toHaveBeenCalledWith('nvm_a')
    expect(endMasqueradeSockets).toHaveBeenCalledWith('nvm_b')
    // Another admin's View-as is untouched.
    expect(r.strings.has('masq:nvm_other')).toBe(true)
  })

  it('a stopped View-as drops out of the index', async () => {
    const r = fakeRedis()
    await noteMasqueradeToken(r as never, 'admin-1', 'nvm_a')
    forgetMasqueradeToken(r as never, 'admin-1', 'nvm_a')
    await vi.waitFor(() => expect(r.srem).toHaveBeenCalled())
    expect(r.sets.get(masqByAdminKey('admin-1'))?.size).toBe(0)
  })

  it('never throws when Redis fails', async () => {
    const broken = {
      sadd: vi.fn().mockRejectedValue(new Error('down')),
      smembers: vi.fn().mockRejectedValue(new Error('down')),
      srem: vi.fn().mockRejectedValue(new Error('down'))
    }
    await expect(noteMasqueradeToken(broken as never, 'a', 'nvm_x')).resolves.toBeUndefined()
    await expect(endAdminMasquerades(broken as never, 'a')).resolves.toBe(0)
    expect(() => forgetMasqueradeToken(broken as never, 'a', 'nvm_x')).not.toThrow()
  })
})
