import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../types.js'

// Security review 2026-10-21, finding 1: ring flood + join/leave churn.

vi.mock('../db/index.js', () => ({ db: () => ({}) }))
vi.mock('./chat.js', () => ({
  canSeeRoom: async () => true,
  parseRoom: (room: string) => {
    if (room.startsWith('dm:')) return { kind: 'dm', room }
    if (room.startsWith('ch:')) return { kind: 'channel', room }
    return { kind: 'unknown', room }
  }
}))
vi.mock('./huddle-settings.js', () => ({ getHuddleSettings: async () => ({}) }))
vi.mock('./socket-tenant.js', () => ({
  inSocketTenant: (_s: unknown, h: (...a: unknown[]) => unknown) => h
}))

import { type HuddleDeps, type HuddleRedis, registerHuddle } from './huddle.js'
import {
  CHURN_REUSE_S,
  noteHuddleEnded,
  RING_CALLS_PER_MIN,
  RING_COOLDOWN_S,
  RING_PAIR_MAX,
  ROOM_LINES_MAX,
  resumeRecentHuddle,
  ringGuardKeys,
  ringPairRefusal,
  ringRateRefusal,
  roomLineAllowed,
  startRingCooldown
} from './huddle-flood-guard.js'
import {
  answerRing,
  cancelRing,
  clearRingTimersForTests,
  type RingDeps,
  ringUsers,
  timeOut
} from './huddle-ring.js'

/** An in-memory ioredis slice; `counters` adds INCR/PEXPIRE/PTTL like the real client. */
function fakeRedis(counters = false) {
  const store = new Map<string, unknown>()
  const ttl = new Map<string, number>()
  const z = (k: string) => (store.get(k) as Map<string, number>) ?? new Map<string, number>()
  const h = (k: string) => (store.get(k) as Map<string, string>) ?? new Map<string, string>()
  const base: HuddleRedis & { store: Map<string, unknown> } = {
    store,
    async zadd(k, score, m) {
      const s = z(k)
      s.set(m, score)
      store.set(k, s)
    },
    async zrem(k, m) {
      z(k).delete(m)
    },
    async zremrangebyscore(k, _min, max) {
      const s = z(k)
      for (const [m, sc] of s) if (sc <= Number(max)) s.delete(m)
    },
    async zrange(k) {
      return [...z(k).entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m)
    },
    async zcard(k) {
      return z(k).size
    },
    async hset(k, f, v) {
      const m = h(k)
      m.set(f, v)
      store.set(k, m)
    },
    async hget(k, f) {
      return h(k).get(f) ?? null
    },
    async hdel(k, f) {
      h(k).delete(f)
    },
    async hgetall(k) {
      return Object.fromEntries(h(k))
    },
    async expire() {},
    async set(k, v) {
      store.set(k, v)
    },
    async get(k) {
      const v = store.get(k)
      return typeof v === 'string' ? v : null
    },
    async del(...ks) {
      for (const k of ks) store.delete(k)
    }
  }
  if (!counters) return base
  // Expiry by the (possibly fake) clock, like the real server: a lapsed window starts over.
  const lapse = (k: string) => {
    const at = ttl.get(k)
    if (at != null && at <= Date.now()) {
      store.delete(k)
      ttl.delete(k)
    }
  }
  return Object.assign(base, {
    async incr(k: string) {
      lapse(k)
      const n = Number(store.get(k) ?? 0) + 1
      store.set(k, String(n))
      return n
    },
    async pexpire(k: string, ms: number) {
      ttl.set(k, Date.now() + ms)
    },
    async pttl(k: string) {
      lapse(k)
      const at = ttl.get(k)
      return at == null ? -1 : at - Date.now()
    }
  })
}

const rob = { id: 'U-ROB', first_name: 'Rob', last_name: 'Lee', email: 'rob@x', status: 'active' }
const amy = { id: 'U-AMY', first_name: 'Amy', last_name: null, email: 'amy@x', status: 'active' }
const AMY = 'aaaaaaaa-0000-0000-0000-000000000001'
const BEN = 'aaaaaaaa-0000-0000-0000-000000000002'

function ringDeps(redis: HuddleRedis) {
  const sent: Array<{ to: string; event: string; payload: any }> = []
  const notices: string[] = []
  const deps: RingDeps = {
    io: {
      to: (to: string) => ({
        emit: (event: string, payload: unknown) => {
          sent.push({ to, event, payload })
        }
      })
    } as never,
    redis,
    canSeeRoom: async () => true,
    postLine: async () => {},
    users: async (ids) =>
      new Map(
        ids.map((id) => [id, { ...amy, id, first_name: id === BEN.toUpperCase() ? 'Ben' : 'Amy' }])
      ) as never,
    notify: async (id) => {
      notices.push(id)
    },
    warn: () => {},
    timeoutMs: 60_000
  }
  return { deps, sent, notices }
}

afterEach(() => {
  clearRingTimersForTests()
  vi.useRealTimers()
})

describe('guard counters', () => {
  it.each([false, true])('the pair cap holds with counters=%s', async (counters) => {
    const redis = fakeRedis(counters)
    const now = 1_000_000
    for (let i = 0; i < RING_PAIR_MAX; i++) {
      expect(await ringPairRefusal(redis, 't1', 'U-ROB', AMY, now)).toBeNull()
    }
    expect(await ringPairRefusal(redis, 't1', 'U-ROB', AMY, now)).toMatchObject({
      reason: 'limit'
    })
    // Another tenant, another callee: separate counts.
    expect(await ringPairRefusal(redis, 't2', 'U-ROB', AMY, now)).toBeNull()
    expect(await ringPairRefusal(redis, 't1', 'U-ROB', BEN, now)).toBeNull()
  })

  it('without INCR the window resets once it has passed', async () => {
    const redis = fakeRedis()
    const now = 1_000_000
    for (let i = 0; i < RING_CALLS_PER_MIN; i++) {
      expect(await ringRateRefusal(redis, null, 'U-ROB', now)).toBeNull()
    }
    expect(await ringRateRefusal(redis, null, 'U-ROB', now + 15_000)).toBe(45)
    expect(await ringRateRefusal(redis, null, 'U-ROB', now + 60_001)).toBeNull()
  })

  it('the cooldown says how long is left; keys carry the tenant', async () => {
    const redis = fakeRedis()
    await startRingCooldown(redis, 't1', 'u-rob', AMY, 1_000_000)
    expect(redis.store.has(ringGuardKeys.cooldown('t1', 'U-ROB', AMY))).toBe(true)
    expect(ringGuardKeys.cooldown('t1', 'U-ROB', AMY)).toContain(':t1:')
    expect(await ringPairRefusal(redis, 't1', 'U-ROB', AMY, 1_005_000)).toEqual({
      reason: 'cooldown',
      retry_in: RING_COOLDOWN_S - 5
    })
    expect(
      await ringPairRefusal(redis, 't1', 'U-ROB', AMY, 1_000_000 + RING_COOLDOWN_S * 1000)
    ).toBeNull()
  })
})

describe('ringUsers with the guards', () => {
  it('a declined, cancelled or missed call cannot be re-rung at once; the caller is told', async () => {
    const redis = fakeRedis(true)
    const { deps, sent, notices } = ringDeps(redis)
    const from = rob as unknown as User
    await ringUsers(deps, { tenant: null, room: 'ch:a', from, users: [AMY, BEN] })
    expect(notices).toHaveLength(2)

    await answerRing(deps, {
      tenant: null,
      room: 'ch:a',
      user: { ...amy, id: AMY } as unknown as User,
      accept: false
    })
    // Amy declined (cooldown); Ben is still ringing (one ring, one timer).
    const again = await ringUsers(deps, { tenant: null, room: 'ch:a', from, users: [AMY, BEN] })
    expect(again).toEqual([])
    const refused = sent.filter((s) => s.event === 'huddle:ring-refused')
    expect(refused).toHaveLength(1)
    expect(refused[0].to).toBe('user:U-ROB')
    expect(refused[0].payload.users).toEqual([
      { id: AMY.toUpperCase(), name: 'Amy', reason: 'cooldown', retry_in: RING_COOLDOWN_S }
    ])
    expect(notices).toHaveLength(2)

    // Hanging up on Ben starts his cooldown too; a time-out does the same.
    await cancelRing(deps, { tenant: null, room: 'ch:a', by: from })
    expect(redis.store.has(ringGuardKeys.cooldown(null, 'U-ROB', BEN))).toBe(true)
    await ringUsers(deps, { tenant: null, room: 'ch:b', from: amy as never, users: [BEN] })
    await timeOut(deps, null, 'ch:b')
    expect(redis.store.has(ringGuardKeys.cooldown(null, 'U-AMY', BEN))).toBe(true)
  })

  it('past the per-minute cap the whole request is refused with a wait', async () => {
    const redis = fakeRedis(true)
    const { deps, sent } = ringDeps(redis)
    for (let i = 0; i < RING_CALLS_PER_MIN; i++) {
      await ringUsers(deps, { tenant: null, room: `ch:${i}`, from: rob as never, users: [AMY] })
    }
    const r = await ringUsers(deps, {
      tenant: null,
      room: 'ch:x',
      from: rob as never,
      users: [BEN]
    })
    expect(r).toEqual([])
    expect(sent.at(-1)).toMatchObject({
      to: 'user:U-ROB',
      event: 'huddle:ring-refused',
      payload: { room: 'ch:x', reason: 'rate', retry_in: 60, users: [] }
    })
  })

  it('a scheduled huddle starting rings its invitees regardless (capped where it is made)', async () => {
    const redis = fakeRedis(true)
    const { deps } = ringDeps(redis)
    await startRingCooldown(redis, null, 'U-ROB', AMY)
    const r = await ringUsers(deps, {
      tenant: null,
      room: 'ch:s',
      from: rob as never,
      users: [AMY],
      scheduled: 7
    })
    expect(r.map((x) => x.id)).toEqual([AMY.toUpperCase()])
  })
})

describe('join / leave churn', () => {
  it('restart within the window resumes; a quick end of that restart is quiet', async () => {
    const redis = fakeRedis()
    expect(await resumeRecentHuddle(redis, null, 'ch:a', 1000)).toBeNull()
    expect(await noteHuddleEnded(redis, null, 'ch:a', 500, 1000)).toBe(false)
    expect(await resumeRecentHuddle(redis, null, 'ch:a', 1000 + CHURN_REUSE_S * 1000)).toBeNull()
    await noteHuddleEnded(redis, null, 'ch:a', 500, 2000)
    expect(await resumeRecentHuddle(redis, null, 'ch:a', 5000)).toEqual({ start: 500 })
    expect(await noteHuddleEnded(redis, null, 'ch:a', 500, 6000)).toBe(true)
    // Resumed and then lived past the window: its end line is posted.
    await resumeRecentHuddle(redis, null, 'ch:a', 7000)
    expect(await noteHuddleEnded(redis, null, 'ch:a', 500, 7000 + CHURN_REUSE_S * 1000)).toBe(false)
  })

  it('caps start/end lines per room', async () => {
    const redis = fakeRedis(true)
    for (let i = 0; i < ROOM_LINES_MAX; i++)
      expect(await roomLineAllowed(redis, 't', 'ch:a')).toBe(true)
    expect(await roomLineAllowed(redis, 't', 'ch:a')).toBe(false)
    expect(await roomLineAllowed(redis, 't', 'ch:b')).toBe(true)
  })

  it('a DM huddle joined and left in a loop rings once and posts one start and one end', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
    const redis = fakeRedis(true)
    const { deps: ring, notices } = ringDeps(redis)
    const lines: string[] = []
    const d: HuddleDeps = {
      redis,
      canSeeRoom: async () => true,
      settings: async () => ({ enabled: true, max_participants: 8 }),
      postLine: async (_room, text) => {
        lines.push(text)
      },
      noteWriterRefusal: async () => null,
      postNote: async () => null,
      warn: () => {},
      directMembers: async () => [AMY],
      ring
    }
    const handlers = new Map<string, (...a: any[]) => any>()
    const socket = {
      id: 'S1',
      data: {} as Record<string, unknown>,
      on: (ev: string, h: (...a: any[]) => any) => handlers.set(ev, h),
      emit: () => {},
      join: () => {},
      leave: () => {}
    }
    const io = { to: () => ({ emit: () => {} }) }
    const scope = {
      scopedRoom: async (r: string) => r,
      scopedRoomNow: (r: string) => r,
      tenantNow: () => ''
    }
    registerHuddle(io as never, socket as never, () => rob as unknown as User, scope, d)
    const room = `dm:U-ROB:${AMY}`
    for (let i = 0; i < 10; i++) {
      await handlers.get('huddle:join')?.({ room })
      vi.advanceTimersByTime(1000)
      await handlers.get('huddle:leave')?.({ room })
      vi.advanceTimersByTime(1000)
    }
    expect(notices).toEqual([AMY.toUpperCase()])
    expect(lines.filter((l) => l.includes('started a huddle'))).toHaveLength(1)
    expect(lines.filter((l) => l.startsWith('Huddle ended'))).toHaveLength(1)

    // Back after the window: a new huddle (a start line); Amy is past her cooldown too.
    vi.advanceTimersByTime((CHURN_REUSE_S + RING_COOLDOWN_S) * 1000)
    await handlers.get('huddle:join')?.({ room })
    expect(lines.filter((l) => l.includes('started a huddle'))).toHaveLength(2)
    expect(notices).toHaveLength(2)
  })
})

describe('calls in a direct message', () => {
  function dmHarness(redis: HuddleRedis, ring: RingDeps, members: string[]) {
    const lines: string[] = []
    const d: HuddleDeps = {
      redis,
      canSeeRoom: async () => true,
      settings: async () => ({ enabled: true, max_participants: 8 }),
      postLine: async (_room, text) => {
        lines.push(text)
      },
      noteWriterRefusal: async () => null,
      postNote: async () => null,
      warn: () => {},
      directMembers: async () => members,
      ring
    }
    const io = { to: () => ({ emit: () => {} }) }
    const scope = {
      scopedRoom: async (r: string) => r,
      scopedRoomNow: (r: string) => r,
      tenantNow: () => ''
    }
    const sock = (id: string, user: Record<string, unknown>) => {
      const handlers = new Map<string, (...a: any[]) => any>()
      const socket = {
        id,
        data: {} as Record<string, unknown>,
        on: (ev: string, h: (...a: any[]) => any) => handlers.set(ev, h),
        emit: () => {},
        join: () => {},
        leave: () => {}
      }
      registerHuddle(io as never, socket as never, () => user as unknown as User, scope, d)
      return (ev: string, payload?: unknown) => handlers.get(ev)?.(payload)
    }
    return { lines, sock }
  }

  it('joining the huddle you are being rung into answers the call (no "No answer", no cooldown)', async () => {
    const redis = fakeRedis(true)
    const { deps: ring, sent } = ringDeps(redis)
    const room = `dm:U-ROB:${AMY}`
    const { lines, sock } = dmHarness(redis, ring, ['U-ROB', AMY.toUpperCase()])
    const robS = sock('S1', rob)
    const amyS = sock('S2', { ...amy, id: AMY })
    await robS('huddle:join', { room })
    expect(
      sent.some((s) => s.event === 'huddle:ring' && s.to === `user:${AMY.toUpperCase()}`)
    ).toBe(true)
    // Amy uses the Join button (or another window) instead of the call card.
    await amyS('huddle:join', { room })
    expect(sent).toContainEqual({
      to: 'user:U-ROB',
      event: 'huddle:ring-result',
      payload: { room, user: AMY, name: 'Amy', accept: true }
    })
    // Every other window of Amy's closes its call card.
    expect(sent).toContainEqual({
      to: `user:${AMY.toUpperCase()}`,
      event: 'huddle:ring-cancel',
      payload: { room, reason: 'answered' }
    })
    await timeOut(ring, null, room)
    expect(lines.some((l) => l.startsWith('No answer'))).toBe(false)
    expect(redis.store.has(ringGuardKeys.cooldown(null, 'U-ROB', AMY))).toBe(false)
  })

  it('the other person restarting a just-ended huddle still calls you', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
    const redis = fakeRedis(true)
    const { deps: ring, notices } = ringDeps(redis)
    const ROB = 'aaaaaaaa-0000-0000-0000-00000000000f'
    const room = `dm:${ROB}:${AMY}`
    const { lines, sock } = dmHarness(redis, ring, [ROB.toUpperCase(), AMY.toUpperCase()])
    const robS = sock('S1', { ...rob, id: ROB })
    const amyS = sock('S2', { ...amy, id: AMY })
    await robS('huddle:join', { room })
    await amyS('huddle:join', { room })
    vi.advanceTimersByTime(60_000)
    await robS('huddle:leave', { room })
    await amyS('huddle:leave', { room })
    expect(lines.filter((l) => l.startsWith('Huddle ended'))).toHaveLength(1)
    notices.length = 0

    // Amy calls back seconds later: the same huddle resumes (no new start line)…
    vi.advanceTimersByTime(3000)
    await amyS('huddle:join', { room })
    expect(lines.filter((l) => l.includes('started a huddle'))).toHaveLength(1)
    // …but Rob is rung.
    expect(notices).toEqual([ROB.toUpperCase()])
  })
})

beforeEach(() => {
  clearRingTimersForTests()
})
