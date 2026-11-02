import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeRefreshChecked,
  createDeviceGrant,
  DEVICE_REPLAY_WINDOW_S,
  getGrant,
  issueTokens,
  REFRESH_REUSE_GRACE_S,
  rememberDeviceRotation,
  upsertGrant
} from '../../../services/oauth-store.js'

// Security audit M18: a refresh token is spent on use; presenting a spent one again (after a
// short grace for a lost answer) means it leaked, and the whole connection is revoked.

function memRedis() {
  const kv = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  const r = {
    kv,
    /** The commands of every MULTI, in order (`<command> <key>`). */
    multis: [] as string[][],
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
      const names: string[] = []
      r.multis.push(names)
      for (const name of [
        'set',
        'setex',
        'del',
        'sadd',
        'srem',
        'smembers',
        'expire',
        'getdel'
      ] as const)
        m[name] = (...a: never[]) => {
          names.push(`${name} ${String(a[0])}`)
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
    expect(replay).toEqual({
      ok: false,
      reason: 'reused',
      user_id: 'U1',
      grant_id: grant.id,
      // What was stored, so a phone's push rows can go with it.
      grant: expect.objectContaining({ id: grant.id, kind: 'mcp' })
    })
    expect(await getGrant(redis as never, grant.id)).toBe(null)
  })

  it('an unknown token is just unknown', async () => {
    expect(await consumeRefreshChecked(memRedis() as never, 'nvr_nope')).toEqual({
      ok: false,
      reason: 'unknown'
    })
  })
})

describe('a phone refresh retried inside the grace window', () => {
  const mobile = { client_id: 'nivaro-mobile', client_name: 'Nivaro' }
  /** A phone signed in, its refresh token rotated once (the app lost the answer). */
  async function rotated(redis: ReturnType<typeof memRedis>, user = 'U1', installId?: string) {
    const grant = await createDeviceGrant(redis as never, user, mobile, { device_name: 'P' })
    const rec = { grant_id: grant.id, user_id: user, client_id: mobile.client_id, resource: null }
    const first = await issueTokens(redis as never, rec, 'device')
    const spent = await consumeRefreshChecked(redis as never, first.refresh_token)
    expect(spent.ok).toBe(true)
    const next = await issueTokens(redis as never, rec, 'device')
    await rememberDeviceRotation(
      redis as never,
      first.refresh_token,
      grant.id,
      rec,
      next,
      installId
    )
    return { grant, first, next }
  }

  it('reuse at +5 s answers the SAME new pair, and the connection stays', async () => {
    const redis = memRedis()
    const { grant, first, next } = await rotated(redis)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 5000)
    const again = await consumeRefreshChecked(redis as never, first.refresh_token)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.replayed?.access_token).toBe(next.access_token)
    expect(again.replayed?.refresh_token).toBe(next.refresh_token)
    expect(again.replayed?.expires_in).toBeLessThanOrEqual(next.expires_in)
    expect(again.rec).toMatchObject({ grant_id: grant.id, kind: 'device' })
    expect(await getGrant(redis as never, grant.id)).not.toBe(null)
  })

  it('the pair is stored encrypted, only for the 10 s replay window', async () => {
    const redis = memRedis()
    const ttls: number[] = []
    const setex = redis.setex
    redis.setex = async (k: string, t: number, v: string) => {
      if (k.includes(':rt-replay:')) ttls.push(t)
      return setex(k, t, v)
    }
    const { next } = await rotated(redis)
    const stored = [...redis.kv].filter(([k]) => k.includes(':rt-replay:'))
    expect(stored).toHaveLength(1)
    expect(stored[0][1]).not.toContain(next.access_token)
    expect(stored[0][1]).not.toContain(next.refresh_token)
    expect(ttls).toEqual([DEVICE_REPLAY_WINDOW_S])
    expect(DEVICE_REPLAY_WINDOW_S).toBe(10)
  })

  it('after the 10 s replay window (still inside the grace): refused, connection kept', async () => {
    const redis = memRedis()
    const { grant, first } = await rotated(redis)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + (DEVICE_REPLAY_WINDOW_S + 2) * 1000)
    expect(await consumeRefreshChecked(redis as never, first.refresh_token)).toEqual({
      ok: false,
      reason: 'unknown'
    })
    expect(await getGrant(redis as never, grant.id)).not.toBe(null)
  })

  it('bound to the install: the same install_id gets the pair', async () => {
    const redis = memRedis()
    const { first, next } = await rotated(redis, 'U1', 'install-AAA')
    const same = await consumeRefreshChecked(redis as never, first.refresh_token, {
      installId: 'install-AAA'
    })
    expect(same.ok && same.replayed?.refresh_token).toBe(next.refresh_token)
  })

  for (const [label, installId] of [
    ['no install_id', undefined],
    ['another install_id', 'install-BBB']
  ] as const) {
    it(`a replay with ${label} (the original sent one) is token theft: the grant ends`, async () => {
      const redis = memRedis()
      const { grant, first } = await rotated(redis, 'U1', 'install-AAA')
      const out = await consumeRefreshChecked(redis as never, first.refresh_token, { installId })
      expect(out).toMatchObject({ ok: false, reason: 'reused', user_id: 'U1', grant_id: grant.id })
      expect(await getGrant(redis as never, grant.id)).toBe(null)
    })
  }

  it('reuse after the grace window keeps today’s rule: refused, connection ended', async () => {
    const redis = memRedis()
    const { grant, first } = await rotated(redis)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + (REFRESH_REUSE_GRACE_S + 5) * 1000)
    const late = await consumeRefreshChecked(redis as never, first.refresh_token)
    expect(late).toMatchObject({ ok: false, reason: 'reused', grant_id: grant.id })
    expect(await getGrant(redis as never, grant.id)).toBe(null)
  })

  it('a reuse of another grant’s token never gets this grant’s pair', async () => {
    const redis = memRedis()
    const a = await rotated(redis, 'U1')
    // Grant B rotated with no remembered answer (or another person's): its reuse gets its own
    // refusal, never A's pair.
    const b = await createDeviceGrant(redis as never, 'U2', mobile, { device_name: 'Q' })
    const brec = { grant_id: b.id, user_id: 'U2', client_id: mobile.client_id, resource: null }
    const bFirst = await issueTokens(redis as never, brec, 'device')
    expect((await consumeRefreshChecked(redis as never, bFirst.refresh_token)).ok).toBe(true)
    const bAgain = await consumeRefreshChecked(redis as never, bFirst.refresh_token)
    expect(bAgain).toEqual({ ok: false, reason: 'unknown' })
    // A's remembered answer filed under B's token (a forged entry) does not open either.
    const aKey = [...redis.kv.keys()].find((k) => k.includes(':rt-replay:')) as string
    const { hashToken } = await import('../../../lib/oauth.js')
    redis.kv.set(
      aKey.replace(/rt-replay:.*$/, `rt-replay:${hashToken(bFirst.refresh_token)}`),
      redis.kv.get(aKey) as string
    )
    const forged = await consumeRefreshChecked(redis as never, bFirst.refresh_token)
    expect(forged).toEqual({ ok: false, reason: 'unknown' })
    expect(JSON.stringify(forged)).not.toContain(a.next.access_token)
  })

  it('a pair rotated again since is not handed out again', async () => {
    const redis = memRedis()
    const { first, next } = await rotated(redis)
    expect((await consumeRefreshChecked(redis as never, next.refresh_token)).ok).toBe(true)
    expect(await consumeRefreshChecked(redis as never, first.refresh_token)).toEqual({
      ok: false,
      reason: 'unknown'
    })
  })

  it('an MCP refresh is never replayed (nothing is remembered for it)', async () => {
    const redis = memRedis()
    const grant = await upsertGrant(redis as never, 'U1', {
      client_id: 'C1',
      client_name: 'App'
    } as never)
    const rec = { grant_id: grant.id, user_id: 'U1', client_id: 'C1', resource: null }
    const pair = await issueTokens(redis as never, rec)
    await consumeRefreshChecked(redis as never, pair.refresh_token)
    await rememberDeviceRotation(
      redis as never,
      pair.refresh_token,
      grant.id,
      rec,
      await issueTokens(redis as never, rec)
    )
    expect([...redis.kv.keys()].some((k) => k.includes(':rt-replay:'))).toBe(false)
  })

  it('spending a refresh token and stamping it spent is one MULTI (no gap a check could see)', async () => {
    const redis = memRedis()
    const grant = await createDeviceGrant(redis as never, 'U1', mobile, { device_name: 'P' })
    const rec = { grant_id: grant.id, user_id: 'U1', client_id: mobile.client_id, resource: null }
    const pair = await issueTokens(redis as never, rec, 'device')
    const getdels: string[] = []
    const plain = redis.getdel
    redis.getdel = async (k: string) => {
      getdels.push(k)
      return plain(k)
    }
    redis.multis.length = 0
    expect((await consumeRefreshChecked(redis as never, pair.refresh_token)).ok).toBe(true)
    const spend = redis.multis.find((ops) => ops.some((o) => o.startsWith('getdel ')))
    expect(spend).toBeDefined()
    expect(spend?.some((o) => o.startsWith('setex ') && o.includes(':rt-spent:'))).toBe(true)
    // Not a plain GETDEL outside the transaction.
    expect(getdels.filter((k) => !spend?.includes(`getdel ${k}`))).toEqual([])
  })
})
