import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../types.js'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))
vi.mock('./chat.js', () => ({
  canSeeRoom: async () => true,
  parseRoom: (room: string) => {
    if (room === 'global') return { kind: 'global', room }
    if (room.startsWith('dm:')) return { kind: 'dm', room }
    if (room.startsWith('ch:')) return { kind: 'channel', room }
    if (room.includes(':')) return { kind: 'entity', room }
    return { kind: 'unknown', room }
  }
}))
vi.mock('./huddle-settings.js', () => ({ getHuddleSettings: async () => ({}) }))
vi.mock('./socket-tenant.js', () => ({
  inSocketTenant: (_s: unknown, h: (...a: unknown[]) => unknown) => h
}))

import { type HuddleDeps, type HuddleRedis, huddlePeers, registerHuddle } from './huddle.js'
import { HUDDLE_REACTIONS, stageFieldsFrom, stagePatch } from './huddle-stage.js'

/** An in-memory ioredis slice: sorted sets, hashes, strings. */
function fakeRedis(): HuddleRedis & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  const z = (k: string) => (store.get(k) as Map<string, number>) ?? new Map<string, number>()
  const h = (k: string) => (store.get(k) as Map<string, string>) ?? new Map<string, string>()
  return {
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
}

type Handler = (...args: any[]) => Promise<void> | void

function fakeSocket(id: string) {
  const handlers = new Map<string, Handler>()
  const emitted: Array<{ event: string; payload: unknown }> = []
  const joined = new Set<string>()
  const socket = {
    id,
    data: {} as Record<string, unknown>,
    on: (ev: string, h: Handler) => {
      handlers.set(ev, h)
    },
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload })
    },
    join: (r: string) => {
      joined.add(r)
    },
    leave: (r: string) => {
      joined.delete(r)
    }
  }
  const fire = (ev: string, ...args: unknown[]) => handlers.get(ev)?.(...args)
  return { socket, emitted, joined, fire }
}

function fakeIo() {
  const sent: Array<{ to: string; event: string; payload: unknown }> = []
  return {
    sent,
    to: (to: string) => ({
      emit: (event: string, payload: unknown) => {
        sent.push({ to, event, payload })
      }
    })
  }
}

const rob = { id: 'U-ROB', first_name: 'Rob', last_name: 'Lee', email: 'rob@x' } as User
const amy = { id: 'U-AMY', first_name: 'Amy', last_name: null, email: 'amy@x' } as User

function deps(redis: HuddleRedis, over: Partial<HuddleDeps> = {}) {
  const lines: Array<{ room: string; text: string }> = []
  const d: HuddleDeps = {
    redis,
    canSeeRoom: async () => true,
    settings: async () => ({ enabled: true, max_participants: 8 }),
    postLine: async (room, text) => {
      lines.push({ room, text })
    },
    warn: () => {},
    // #2854 (huddle notes) made these required.
    noteWriterRefusal: async () => null,
    postNote: async () => null,
    ...over
  }
  return { d, lines }
}

const scope = {
  scopedRoom: async (r: string) => r,
  scopedRoomNow: (r: string) => r,
  tenantNow: () => ''
}

describe('stagePatch', () => {
  it('raises a hand once (keeps the first time), lowers it, and leaves it alone otherwise', () => {
    const up = stagePatch({ hand: true }, {}, 100)
    expect(up.hand_at).toBe(100)
    expect(stagePatch({ hand: true }, up, 200).hand_at).toBe(100)
    expect(stagePatch({}, up, 300).hand_at).toBe(100)
    expect(stagePatch({ hand: false }, up, 400).hand_at).toBeNull()
  })

  it('records the camera stream id with the time it went on; junk ids are ignored', () => {
    const on = stagePatch({ camera: '{abc-123}' }, {}, 50)
    expect(on).toMatchObject({ cam: '{abc-123}', cam_at: 50 })
    // A new track on the same camera session keeps its place in line.
    expect(stagePatch({ camera: 'def' }, on, 90)).toMatchObject({ cam: 'def', cam_at: 50 })
    expect(stagePatch({ camera: 'bad id; drop' }, {}, 60)).toMatchObject({ cam: null })
    expect(stagePatch({ camera: null }, on, 70)).toMatchObject({ cam: null, cam_at: null })
  })

  it('reads old meta rows (no stage fields) as nothing raised and no camera', () => {
    expect(stageFieldsFrom({})).toEqual({ hand_at: null, cam: null, cam_at: null })
    expect(stageFieldsFrom({ hand_at: 'x', cam: 7 })).toEqual({
      hand_at: null,
      cam: null,
      cam_at: null
    })
  })
})

describe('huddle stage events', () => {
  let redis: ReturnType<typeof fakeRedis>
  beforeEach(() => {
    redis = fakeRedis()
  })

  async function two(over: Partial<HuddleDeps> = {}) {
    const io = fakeIo()
    const { d } = deps(redis, over)
    const a = fakeSocket('S1')
    const b = fakeSocket('S2')
    registerHuddle(io as never, a.socket as never, () => rob, scope, d)
    registerHuddle(io as never, b.socket as never, () => amy, scope, d)
    await a.fire('huddle:join', { room: 'ch:ops' })
    await b.fire('huddle:join', { room: 'ch:ops' })
    io.sent.length = 0
    return { io, a, b }
  }

  it('a reaction reaches the huddle with ids + emoji only, at most one a second', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
    try {
      const { io, a } = await two()
      await a.fire('huddle:react', { room: 'ch:ops', emoji: HUDDLE_REACTIONS[0], text: 'x' })
      expect(io.sent).toEqual([
        {
          to: 'huddle:ch:ops',
          event: 'huddle:react',
          payload: { room: 'ch:ops', from: 'S1', user: 'U-ROB', emoji: HUDDLE_REACTIONS[0] }
        }
      ])
      await a.fire('huddle:react', { room: 'ch:ops', emoji: HUDDLE_REACTIONS[1] })
      expect(io.sent).toHaveLength(1)
      vi.setSystemTime(new Date('2026-10-21T12:00:01.100Z'))
      await a.fire('huddle:react', { room: 'ch:ops', emoji: HUDDLE_REACTIONS[1] })
      expect(io.sent).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops other emoji, rooms you are not talking in, and people who lost access', async () => {
    let allowed = true
    const { io, a } = await two({ canSeeRoom: async () => allowed })
    await a.fire('huddle:react', { room: 'ch:ops', emoji: '💩' })
    await a.fire('huddle:react', { room: 'ch:other', emoji: HUDDLE_REACTIONS[0] })
    expect(io.sent).toEqual([])
    allowed = false
    await a.fire('huddle:react', { room: 'ch:ops', emoji: HUDDLE_REACTIONS[0] })
    expect(io.sent.some((s) => s.event === 'huddle:react')).toBe(false)
    expect(a.emitted.at(-1)?.event).toBe('huddle:denied')
    expect(a.socket.data.huddle).toBeUndefined()
  })

  it('raised hands ride the roster in raise order; anyone may lower them all', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
    try {
      const { a, b } = await two()
      await b.fire('huddle:state', { room: 'ch:ops', hand: true })
      vi.setSystemTime(new Date('2026-10-21T12:00:02Z'))
      await a.fire('huddle:state', { room: 'ch:ops', hand: true, camera: 'cam-1' })
      let peers = await huddlePeers(redis, null, 'ch:ops')
      const raised = peers
        .filter((p) => p.hand_at)
        .sort((x, y) => (x.hand_at ?? 0) - (y.hand_at ?? 0))
      expect(raised.map((p) => p.socket)).toEqual(['S2', 'S1'])
      expect(peers.find((p) => p.socket === 'S1')).toMatchObject({ cam: 'cam-1', muted: false })

      await b.fire('huddle:hands_down', { room: 'ch:ops' })
      peers = await huddlePeers(redis, null, 'ch:ops')
      expect(peers.every((p) => p.hand_at === null)).toBe(true)
      // The camera is not touched by lowering hands.
      expect(peers.find((p) => p.socket === 'S1')?.cam).toBe('cam-1')
    } finally {
      vi.useRealTimers()
    }
  })
})
