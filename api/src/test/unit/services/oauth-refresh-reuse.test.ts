import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeRefreshChecked,
  getGrant,
  issueTokens,
  REFRESH_REUSE_GRACE_S,
  upsertGrant
} from '../../../services/oauth-store.js'

// Security audit M18: a refresh token is spent on use; presenting a spent one again (after a
// short grace for a lost answer) means it leaked, and the whole connection is revoked.

function memRedis() {
  const kv = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  const r = {
    kv,
    get: async (k: string) => kv.get(k) ?? null,
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    getdel: async (k: string) => {
      const v = kv.get(k) ?? null
      kv.delete(k)
      return v
    },
    set: async (k: string, v: string) => {
      kv.set(k, v)
      return 'OK'
    },
    setex: async (k: string, _t: number, v: string) => {
      kv.set(k, v)
      return 'OK'
    },
    del: async (...ks: string[]) => ks.filter((k) => kv.delete(k)).length,
    exists: async (k: string) => (kv.has(k) ? 1 : 0),
    expire: async () => 1,
    sadd: async (k: string, v: string) => {
      const s = sets.get(k) ?? new Set<string>()
      s.add(v)
      sets.set(k, s)
      return 1
    },
    srem: async (k: string, v: string) => (sets.get(k)?.delete(v) ? 1 : 0),
    smembers: async (k: string) => [...(sets.get(k) ?? [])],
    multi: () => {
      const ops: Array<() => Promise<unknown>> = []
      const m: Record<string, (...a: never[]) => unknown> = {}
      for (const name of ['set', 'setex', 'del', 'sadd', 'srem', 'expire'] as const)
        m[name] = (...a: never[]) => {
          ops.push(() => (r[name] as (...x: never[]) => Promise<unknown>)(...a))
          return m
        }
      m.exec = async () => Promise.all(ops.map((o) => o()))
      return m
    }
  }
  return r
}

afterEach(() => vi.useRealTimers())

describe('refresh-token reuse detection', () => {
  it('rotates once; a replay after the grace window ends the connection', async () => {
    const redis = memRedis()
    const grant = await upsertGrant(redis as never, 'U1', {
      client_id: 'C1',
      client_name: 'App'
    } as never)
    const pair = await issueTokens(redis as never, {
      grant_id: grant.id,
      user_id: 'U1',
      client_id: 'C1',
      resource: null
    })

    const first = await consumeRefreshChecked(redis as never, pair.refresh_token)
    expect(first.ok).toBe(true)

    // Inside the grace window: refused, connection kept (a client retrying a lost answer).
    const retry = await consumeRefreshChecked(redis as never, pair.refresh_token)
    expect(retry).toEqual({ ok: false, reason: 'unknown' })
    expect(await getGrant(redis as never, grant.id)).not.toBe(null)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + (REFRESH_REUSE_GRACE_S + 5) * 1000)
    const replay = await consumeRefreshChecked(redis as never, pair.refresh_token)
    expect(replay).toEqual({ ok: false, reason: 'reused', user_id: 'U1', grant_id: grant.id })
    expect(await getGrant(redis as never, grant.id)).toBe(null)
  })

  it('an unknown token is just unknown', async () => {
    expect(await consumeRefreshChecked(memRedis() as never, 'nvr_nope')).toEqual({
      ok: false,
      reason: 'unknown'
    })
  })
})
