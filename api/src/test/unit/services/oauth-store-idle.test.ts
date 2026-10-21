import { describe, expect, it } from 'vitest'
import { hashToken } from '../../../lib/oauth.js'
import { enforceRateLimit } from '../../../middleware/authenticate.js'
import {
  getGrant,
  listAllGrants,
  listGrants,
  type OAuthGrant,
  resolveAccessToken,
  revokeGrant,
  setGrantIdleStamps
} from '../../../services/oauth-store.js'

// A Redis stand-in that keeps TTLs and honours SET's KEEPTTL / XX, so the tests can see a grant
// is never resurrected and never loses its expiry.
function ttlRedis() {
  const kv = new Map<string, string>()
  const ttl = new Map<string, number>()
  const sets = new Map<string, Set<string>>()
  const r = {
    kv,
    ttl,
    /** Pause point: runs between a read and the write that follows it (race tests). */
    onGet: null as null | ((k: string) => Promise<void>),
    get: async (k: string) => {
      const v = kv.get(k) ?? null
      if (r.onGet) await r.onGet(k)
      return v
    },
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    set: async (k: string, v: string, ...opts: string[]) => {
      if (opts.includes('XX') && !kv.has(k)) return null
      kv.set(k, v)
      if (!opts.includes('KEEPTTL')) ttl.delete(k)
      return 'OK'
    },
    setex: async (k: string, t: number, v: string) => {
      kv.set(k, v)
      ttl.set(k, t)
      return 'OK'
    },
    del: async (...ks: string[]) =>
      ks.filter((k) => kv.delete(k) && (ttl.delete(k) || true)).length,
    exists: async (k: string) => (kv.has(k) ? 1 : 0),
    expire: async (k: string, t: number) => {
      ttl.set(k, t)
      return 1
    },
    incrby: async (k: string, n: number) => {
      const v = Number(kv.get(k) ?? 0) + n
      kv.set(k, String(v))
      return v
    },
    smembers: async (k: string) => [...(sets.get(k) ?? [])],
    srem: async (k: string, m: string) => (sets.get(k)?.delete(m) ? 1 : 0),
    sadd: async (k: string, m: string) => {
      const s = sets.get(k) ?? new Set()
      s.add(m)
      sets.set(k, s)
      return 1
    },
    scan: async (_c: string, _m: string, pattern: string) => {
      const re = new RegExp(
        `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
      )
      return ['0', [...kv.keys()].filter((k) => re.test(k))]
    },
    multi() {
      const ops: Array<() => Promise<unknown>> = []
      const m = {
        set: (k: string, v: string, ...o: string[]) => (ops.push(() => r.set(k, v, ...o)), m),
        del: (k: string) => (ops.push(() => r.del(k)), m),
        srem: (k: string, v: string) => (ops.push(() => r.srem(k, v)), m),
        incrby: (k: string, n: number) => (ops.push(() => r.incrby(k, n)), m),
        expire: (k: string, t: number) => (ops.push(() => r.expire(k, t)), m),
        exec: async () => {
          const out: Array<[null, unknown]> = []
          for (const o of ops) out.push([null, await o()])
          return out
        }
      }
      return m
    }
  }
  return r
}

const P = 'nvr:oauth:'
const G = '0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b'
const grant = (over: Partial<OAuthGrant> = {}): OAuthGrant => ({
  id: G,
  user_id: 'U1',
  client_id: 'nvc_x',
  client_name: 'Claude',
  scope: 'nivaro',
  created_at: '2026-06-01T00:00:00.000Z',
  last_used_at: '2026-07-01T00:00:00.000Z',
  t: '',
  ...over
})
function seed(r: ReturnType<typeof ttlRedis>, g = grant()) {
  r.kv.set(`${P}grant:${g.id}`, JSON.stringify(g))
  r.ttl.set(`${P}grant:${g.id}`, 999)
  void r.sadd(`${P}user:${g.user_id}`, g.id)
}

describe('idle stamps (#2497)', () => {
  it('live in their own key and never rewrite the grant', async () => {
    const r = ttlRedis()
    seed(r)
    const before = r.kv.get(`${P}grant:${G}`)
    await setGrantIdleStamps(r as never, G, {
      idle_flagged_at: '2026-09-01T00:00:00Z',
      idle_notice_at: null
    })
    expect(r.kv.get(`${P}grant:${G}`)).toBe(before)
    expect(r.ttl.get(`${P}grant:${G}`)).toBe(999)
    expect(r.ttl.get(`${P}grant-idle:${G}`)).toBeGreaterThan(0)
    expect((await getGrant(r as never, G))?.idle_flagged_at).toBe('2026-09-01T00:00:00Z')
    expect((await listGrants(r as never, 'U1'))[0].idle_flagged_at).toBe('2026-09-01T00:00:00Z')
    // The idle key is not mistaken for a grant by the cross-person listing.
    const all = await listAllGrants(r as never)
    expect(all.map((g) => g.id)).toEqual([G])
    expect(all[0].idle_flagged_at).toBe('2026-09-01T00:00:00Z')
  })

  it('cannot resurrect a grant revoked while the review ran', async () => {
    const r = ttlRedis()
    seed(r)
    // The revoke lands between the review's read of the grant and its write.
    r.onGet = async (k) => {
      if (k === `${P}grant:${G}`) {
        r.onGet = null
        await revokeGrant(r as never, 'U1', G)
      }
    }
    await setGrantIdleStamps(r as never, G, { idle_flagged_at: 'x', idle_notice_at: 'y' })
    expect(r.kv.has(`${P}grant:${G}`)).toBe(false)
    expect(r.kv.has(`${P}grant-idle:${G}`)).toBe(false)
    expect(await getGrant(r as never, G)).toBeNull()
  })

  it('clears with both stamps null, and on revoke', async () => {
    const r = ttlRedis()
    seed(r)
    await setGrantIdleStamps(r as never, G, { idle_flagged_at: 'x', idle_notice_at: null })
    await setGrantIdleStamps(r as never, G, { idle_flagged_at: null, idle_notice_at: null })
    expect(r.kv.has(`${P}grant-idle:${G}`)).toBe(false)
    await setGrantIdleStamps(r as never, G, { idle_flagged_at: 'x', idle_notice_at: null })
    await revokeGrant(r as never, 'U1', G)
    expect(r.kv.has(`${P}grant-idle:${G}`)).toBe(false)
  })
})

describe('using a connection', () => {
  const token = 'nvo_test_token'
  const seedToken = (r: ReturnType<typeof ttlRedis>) =>
    r.kv.set(
      `${P}at:${hashToken(token)}`,
      JSON.stringify({ grant_id: G, user_id: 'U1', client_id: 'nvc_x', resource: null, t: '' })
    )

  it('touches last use with the grant TTL kept and clears the idle stamps', async () => {
    const r = ttlRedis()
    seed(r)
    seedToken(r)
    await setGrantIdleStamps(r as never, G, { idle_flagged_at: 'x', idle_notice_at: 'y' })
    const rec = await resolveAccessToken(r as never, token)
    expect(rec?.client_name).toBe('Claude')
    const stored = JSON.parse(r.kv.get(`${P}grant:${G}`) ?? '{}') as OAuthGrant
    expect(Date.parse(String(stored.last_used_at))).toBeGreaterThan(Date.parse('2026-07-02'))
    expect(r.ttl.get(`${P}grant:${G}`)).toBe(999)
    expect(r.kv.has(`${P}grant-idle:${G}`)).toBe(false)
  })

  it('does not recreate a grant revoked between the read and the touch', async () => {
    const r = ttlRedis()
    seed(r)
    seedToken(r)
    r.onGet = async (k) => {
      if (k === `${P}grant:${G}`) {
        r.onGet = null
        await revokeGrant(r as never, 'U1', G)
      }
    }
    await resolveAccessToken(r as never, token)
    expect(r.kv.has(`${P}grant:${G}`)).toBe(false)
  })
})

describe('enforceRateLimit cost (#2469)', () => {
  it('spends the whole batch at once and refuses when it goes over', async () => {
    const r = ttlRedis()
    const headers: Record<string, string> = {}
    const req = { server: { redis: r } } as never
    const reply: { header: (k: string, v: string) => unknown } = {
      header: (k: string, v: string) => {
        headers[k] = v
        return reply
      }
    }
    const opts = { bucket: 'mcp:k1', limit: 5, code: 'X', message: () => 'over' }
    await enforceRateLimit(req, reply as never, { ...opts, cost: 4 })
    expect(headers['X-RateLimit-Remaining']).toBe('1')
    await expect(enforceRateLimit(req, reply as never, { ...opts, cost: 2 })).rejects.toMatchObject(
      {
        statusCode: 429,
        code: 'X'
      }
    )
  })
})
