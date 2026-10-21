import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))
vi.mock('./chat.js', () => ({
  channels: async () => new Map(),
  parseRoom: (room: string) => {
    if (room === 'global') return { kind: 'global', room }
    if (room.startsWith('dm:')) return { kind: 'dm', room }
    if (room.startsWith('ch:')) return { kind: 'channel', room, channelKey: room.slice(3) }
    return { kind: 'entity', room }
  }
}))

import {
  clampQuality,
  computeHuddleAnalytics,
  createSessionRecorder,
  type HuddleSessionRow,
  type SessionRedis,
  type SessionStore
} from './huddle-sessions.js'

function fakeRedis(): SessionRedis {
  const h = new Map<string, Map<string, string>>()
  const sets = new Map<string, Set<string>>()
  const hm = (k: string) => h.get(k) ?? h.set(k, new Map()).get(k)!
  return {
    async get() {
      return null
    },
    async set() {},
    async del(...ks) {
      for (const k of ks) h.delete(k)
    },
    async hset(k, f, v) {
      hm(k).set(f, v)
    },
    async hget(k, f) {
      return h.get(k)?.get(f) ?? null
    },
    async hgetall(k) {
      return Object.fromEntries(h.get(k) ?? [])
    },
    async hincrby(k, f, n) {
      hm(k).set(f, String((Number(hm(k).get(f)) || 0) + n))
    },
    async expire() {},
    async sadd(k, ...m) {
      const s = sets.get(k) ?? sets.set(k, new Set()).get(k)!
      for (const x of m) s.add(x)
    },
    async srem(k, ...m) {
      let n = 0
      for (const x of m) if (sets.get(k)?.delete(x)) n++
      return n
    },
    async smembers(k) {
      return [...(sets.get(k) ?? [])]
    },
    async lpush() {},
    async ltrim() {},
    async lrange() {
      return []
    }
  }
}

describe('clampQuality', () => {
  it('clamps out-of-range numbers and drops junk', () => {
    expect(clampQuality({ relay_share: 7, ice_failed: -3, avg_loss: 2, avg_rtt: 99999 })).toEqual({
      relay_share: 1,
      ice_failed: 0,
      avg_loss: 1,
      avg_rtt: 10000
    })
    expect(clampQuality({ relay_share: 'x', avg_loss: null })).toBeNull()
    expect(clampQuality(null)).toBeNull()
    expect(clampQuality({ ice_failed: 500 })?.ice_failed).toBe(64)
  })
})

describe('session recorder', () => {
  let written: HuddleSessionRow[]
  let store: SessionStore
  let t: number
  beforeEach(() => {
    written = []
    t = Date.parse('2026-10-21T12:00:00Z')
    store = {
      async write(_t, r) {
        written.push(r)
      },
      async read() {
        return written
      },
      async prune() {
        return 0
      }
    }
  })

  it('tallies a huddle and writes one session at the end', async () => {
    const rec = createSessionRecorder({
      redis: fakeRedis(),
      store,
      kindOf: async () => 'channel',
      now: () => t
    })
    await rec.joined(null, 'ch:ops', 'u1', 1)
    t += 60_000
    await rec.joined(null, 'ch:ops', 'u2', 2)
    await rec.screenShared(null, 'ch:ops')
    await rec.quality(null, 'ch:ops', {
      relay_share: 0.5,
      ice_failed: 1,
      avg_loss: 0.02,
      avg_rtt: 80
    })
    await rec.quality(null, 'ch:ops', {
      relay_share: 0,
      ice_failed: 0,
      avg_loss: null,
      avg_rtt: 40
    })
    t += 120_000
    const row = await rec.end(null, 'ch:ops')
    expect(row).toMatchObject({
      room: 'ch:ops',
      kind: 'channel',
      duration_s: 180,
      participants: 2,
      peak: 2,
      screen_shared: true,
      quality_reports: 2,
      ice_failed: 1,
      avg_rtt_ms: 60
    })
    expect(row?.relay_share).toBeCloseTo(0.25)
    expect(row?.avg_loss).toBeCloseTo(0.02)
    expect(written).toHaveLength(1)
    // Ending twice writes nothing more.
    expect(await rec.end(null, 'ch:ops')).toBeNull()
  })

  it('stores no room key for direct or group sessions', async () => {
    const rec = createSessionRecorder({
      redis: fakeRedis(),
      store,
      kindOf: async () => 'dm',
      now: () => t
    })
    await rec.joined(null, 'dm:A:B', 'A', 1)
    const row = await rec.end(null, 'dm:A:B')
    expect(row?.room).toBeNull()
    expect(row?.kind).toBe('dm')
  })

  it('sweep closes only the rooms that are empty', async () => {
    const rec = createSessionRecorder({
      redis: fakeRedis(),
      store,
      kindOf: async () => 'channel',
      now: () => t
    })
    await rec.joined(null, 'ch:a', 'u1', 1)
    await rec.joined(null, 'ch:b', 'u2', 1)
    expect(await rec.sweep(null, async (room) => room === 'ch:a')).toBe(1)
    expect(await rec.liveRooms(null)).toEqual(['ch:b'])
  })

  it('a new huddle over an unclosed one writes the old session first', async () => {
    const rec = createSessionRecorder({
      redis: fakeRedis(),
      store,
      kindOf: async () => 'channel',
      now: () => t
    })
    await rec.joined(null, 'ch:a', 'u1', 1)
    t += 60_000
    await rec.joined(null, 'ch:a', 'u2', 1)
    expect(written).toHaveLength(1)
  })

  it('caps quality reports per session', async () => {
    const redis = fakeRedis()
    const rec = createSessionRecorder({ redis, store, kindOf: async () => 'channel', now: () => t })
    await rec.joined(null, 'ch:a', 'u1', 1)
    for (let i = 0; i < 80; i++) {
      await rec.quality(null, 'ch:a', { relay_share: 0, ice_failed: 0, avg_loss: 0, avg_rtt: 1 })
    }
    expect((await rec.end(null, 'ch:a'))?.quality_reports).toBe(64)
  })
})

describe('computeHuddleAnalytics', () => {
  const row = (over: Partial<HuddleSessionRow>): HuddleSessionRow => ({
    room: 'ch:ops',
    kind: 'channel',
    started_at: '2026-10-20T10:00:00Z',
    ended_at: '2026-10-20T10:10:00Z',
    duration_s: 600,
    participants: 3,
    peak: 3,
    screen_shared: false,
    quality_reports: 0,
    relay_share: null,
    ice_failed: 0,
    avg_loss: null,
    avg_rtt_ms: null,
    ...over
  })
  const opts = {
    days: 7,
    from: new Date('2026-10-15T00:00:00Z'),
    to: new Date('2026-10-21T12:00:00Z'),
    timeZone: 'UTC',
    source: 'table' as const,
    live: { huddles: 1, people: 2 },
    labelOf: (r: string) => r.toUpperCase()
  }

  it('summarises totals, quality and busiest rooms (channels and records only)', () => {
    const a = computeHuddleAnalytics(
      [
        row({
          quality_reports: 2,
          relay_share: 0.5,
          avg_loss: 0.02,
          avg_rtt_ms: 100,
          ice_failed: 1
        }),
        row({ duration_s: 1200, screen_shared: true, room: 'ch:ops' }),
        row({ room: null, kind: 'dm', duration_s: 60 }),
        row({ room: 'tasks:9', kind: 'record', duration_s: 300 })
      ],
      opts
    )
    expect(a.totals.huddles).toBe(4)
    expect(a.totals.median_minutes).toBe(7.5)
    expect(a.totals.turn_pct).toBe(50)
    expect(a.totals.avg_loss_pct).toBe(2)
    expect(a.totals.ice_failures).toBe(1)
    expect(a.totals.screen_share_pct).toBe(25)
    expect(a.busiest_rooms.map((r) => r.room)).toEqual(['ch:ops', 'tasks:9'])
    expect(a.busiest_rooms[0]).toMatchObject({ huddles: 2, minutes: 30 })
    expect(a.per_day.find((d) => d.day === '2026-10-20')).toEqual({
      day: '2026-10-20',
      huddles: 4,
      minutes: 36
    })
    expect(a.live).toEqual({ huddles: 1, people: 2 })
  })

  it('has null figures when nothing happened', () => {
    const a = computeHuddleAnalytics([], opts)
    expect(a.totals.huddles).toBe(0)
    expect(a.totals.median_minutes).toBeNull()
    expect(a.totals.turn_pct).toBeNull()
  })
})
