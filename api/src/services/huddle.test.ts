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

import {
  formatHuddleDuration,
  type HuddleDeps,
  type HuddleRedis,
  huddlePeers,
  huddleRoomKind,
  registerHuddle,
  STALE_MS
} from './huddle.js'

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
    noteWriterRefusal: async () => null,
    postNote: async () => null,
    warn: () => {},
    ...over
  }
  return { d, lines }
}

const scope = {
  scopedRoom: async (r: string) => r,
  scopedRoomNow: (r: string) => r,
  tenantNow: () => ''
}

describe('huddleRoomKind', () => {
  it('allows channels, General and record rooms; refuses DMs and junk', () => {
    expect(huddleRoomKind('ch:ops')).toBe('ok')
    expect(huddleRoomKind('global')).toBe('ok')
    expect(huddleRoomKind('ord:ORD-1')).toBe('ok')
    expect(huddleRoomKind('dm:A:B')).toBe('dm')
    expect(huddleRoomKind('')).toBe('bad')
    expect(huddleRoomKind('x'.repeat(201))).toBe('bad')
  })
})

describe('huddlePeers', () => {
  it('prunes members that stopped pinging', async () => {
    const redis = fakeRedis()
    const now = 1_000_000
    await redis.zadd('nvr:huddle:-:ch:a', now - STALE_MS - 1, 'old')
    await redis.zadd('nvr:huddle:-:ch:a', now - 1000, 'fresh')
    await redis.hset('nvr:huddle:-:ch:a:m', 'old', JSON.stringify({ user: 'A', name: 'A' }))
    await redis.hset('nvr:huddle:-:ch:a:m', 'fresh', JSON.stringify({ user: 'B', name: 'B' }))
    const peers = await huddlePeers(redis, null, 'ch:a', now)
    expect(peers.map((p) => p.socket)).toEqual(['fresh'])
  })
})

describe('registerHuddle', () => {
  let redis: ReturnType<typeof fakeRedis>
  beforeEach(() => {
    redis = fakeRedis()
  })

  it('first join starts the huddle (system line), second join sees the first as a peer', async () => {
    const io = fakeIo()
    const { d, lines } = deps(redis)
    const a = fakeSocket('S1')
    const b = fakeSocket('S2')
    registerHuddle(io as never, a.socket as never, () => rob, scope, d)
    registerHuddle(io as never, b.socket as never, () => amy, scope, d)

    await a.fire('huddle:join', { room: 'ch:ops' })
    expect(a.emitted[0].event).toBe('huddle:joined')
    expect((a.emitted[0].payload as { peers: unknown[] }).peers).toEqual([])
    expect(a.joined.has('huddle:ch:ops')).toBe(true)
    expect(lines).toEqual([{ room: 'ch:ops', text: 'Rob Lee started a huddle' }])
    // Everyone with the room open hears who is in it.
    expect(io.sent.some((s) => s.to === 'chat:ch:ops' && s.event === 'huddle:peers')).toBe(true)

    await b.fire('huddle:join', { room: 'ch:ops' })
    const joined = b.emitted[0].payload as { self: string; peers: Array<{ socket: string }> }
    expect(joined.self).toBe('S2')
    expect(joined.peers.map((p) => p.socket)).toEqual(['S1'])
    expect(lines).toHaveLength(1)
  })

  it('refuses DMs, a disabled instance, a full huddle and a room the person cannot see', async () => {
    const io = fakeIo()
    const a = fakeSocket('S1')
    const { d } = deps(redis, {
      settings: async () => ({ enabled: true, max_participants: 2 }),
      canSeeRoom: async (_u, room) => room !== 'ch:secret'
    })
    registerHuddle(io as never, a.socket as never, () => rob, scope, d)
    await a.fire('huddle:join', { room: 'dm:A:B' })
    expect(a.emitted.at(-1)).toEqual({
      event: 'huddle:denied',
      payload: { room: 'dm:A:B', reason: 'no-dm' }
    })
    await a.fire('huddle:join', { room: 'ch:secret' })
    expect((a.emitted.at(-1)?.payload as { reason: string }).reason).toBe('no-access')

    for (const id of ['X1', 'X2']) {
      await redis.zadd('nvr:huddle:-:ch:full', Date.now(), id)
      await redis.hset('nvr:huddle:-:ch:full:m', id, JSON.stringify({ user: id, name: id }))
    }
    await a.fire('huddle:join', { room: 'ch:full' })
    expect((a.emitted.at(-1)?.payload as { reason: string }).reason).toBe('full')

    const off = fakeSocket('S9')
    const { d: d2 } = deps(redis, {
      settings: async () => ({ enabled: false, max_participants: 8 })
    })
    registerHuddle(io as never, off.socket as never, () => rob, scope, d2)
    await off.fire('huddle:join', { room: 'ch:ops' })
    expect((off.emitted.at(-1)?.payload as { reason: string }).reason).toBe('off')
  })

  it('relays a signal only to a peer in the same huddle, and re-checks access each time', async () => {
    const io = fakeIo()
    let allowed = true
    const { d } = deps(redis, { canSeeRoom: async () => allowed })
    const a = fakeSocket('S1')
    const b = fakeSocket('S2')
    registerHuddle(io as never, a.socket as never, () => rob, scope, d)
    registerHuddle(io as never, b.socket as never, () => amy, scope, d)
    await a.fire('huddle:join', { room: 'ch:ops' })
    await b.fire('huddle:join', { room: 'ch:ops' })
    io.sent.length = 0

    await a.fire('huddle:signal', { room: 'ch:ops', to: 'S2', data: { type: 'offer', sdp: 'v=0' } })
    expect(io.sent).toEqual([
      {
        to: 'S2',
        event: 'huddle:signal',
        payload: {
          room: 'ch:ops',
          from: 'S1',
          user: { id: 'U-ROB', name: 'Rob Lee' },
          data: { type: 'offer', sdp: 'v=0' }
        }
      }
    ])

    // A socket that is not in the huddle is never a target.
    io.sent.length = 0
    await a.fire('huddle:signal', { room: 'ch:ops', to: 'S404', data: { type: 'offer' } })
    expect(io.sent).toEqual([])

    // Not in that room's huddle yourself: dropped.
    await a.fire('huddle:signal', { room: 'ch:other', to: 'S2', data: { type: 'offer' } })
    expect(io.sent).toEqual([])

    // Access revoked mid-call: the signal is refused and the person is removed.
    allowed = false
    await a.fire('huddle:signal', { room: 'ch:ops', to: 'S2', data: { type: 'offer' } })
    expect(a.emitted.at(-1)?.event).toBe('huddle:denied')
    expect(a.socket.data.huddle).toBeUndefined()
    expect((await huddlePeers(redis, null, 'ch:ops')).map((p) => p.socket)).toEqual(['S2'])
  })

  it('ping and state re-check access: revoked mid-call drops the person', async () => {
    const io = fakeIo()
    let allowed = true
    const { d } = deps(redis, { canSeeRoom: async () => allowed })
    const a = fakeSocket('S1')
    const b = fakeSocket('S2')
    registerHuddle(io as never, a.socket as never, () => rob, scope, d)
    registerHuddle(io as never, b.socket as never, () => amy, scope, d)
    await a.fire('huddle:join', { room: 'ch:ops' })
    await b.fire('huddle:join', { room: 'ch:ops' })

    allowed = false
    await a.fire('huddle:ping', { room: 'ch:ops' })
    expect(a.emitted.at(-1)).toEqual({
      event: 'huddle:denied',
      payload: { room: 'ch:ops', reason: 'no-access' }
    })
    expect(a.socket.data.huddle).toBeUndefined()
    expect((await huddlePeers(redis, null, 'ch:ops')).map((p) => p.socket)).toEqual(['S2'])
    // Everyone with the room open saw the roster shrink.
    const last = io.sent.filter((s) => s.event === 'huddle:peers').at(-1)?.payload as {
      peers: Array<{ socket: string }>
    }
    expect(last.peers.map((p) => p.socket)).toEqual(['S2'])

    await b.fire('huddle:state', { room: 'ch:ops', muted: true })
    expect(b.emitted.at(-1)?.event).toBe('huddle:denied')
    expect((await huddlePeers(redis, null, 'ch:ops')).length).toBe(0)
  })

  it('a ping from a socket whose sign-in is gone removes it', async () => {
    const io = fakeIo()
    const { d } = deps(redis)
    let user: User | null = rob
    const a = fakeSocket('S1')
    registerHuddle(io as never, a.socket as never, () => user, scope, d)
    await a.fire('huddle:join', { room: 'ch:ops' })
    user = null
    await a.fire('huddle:ping', { room: 'ch:ops' })
    expect(a.socket.data.huddle).toBeUndefined()
    expect((await huddlePeers(redis, null, 'ch:ops')).length).toBe(0)
  })

  it('state updates ride the peer list; the last leave ends the huddle with its duration', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
    try {
      const io = fakeIo()
      const { d, lines } = deps(redis)
      const a = fakeSocket('S1')
      const b = fakeSocket('S2')
      registerHuddle(io as never, a.socket as never, () => rob, scope, d)
      registerHuddle(io as never, b.socket as never, () => amy, scope, d)
      await a.fire('huddle:join', { room: 'ch:ops' })
      await b.fire('huddle:join', { room: 'ch:ops' })

      await b.fire('huddle:state', { room: 'ch:ops', screen: true, muted: true })
      const last = io.sent.at(-1)?.payload as {
        peers: Array<{ socket: string; screen: boolean; muted: boolean }>
      }
      expect(last.peers.find((p) => p.socket === 'S2')).toMatchObject({ screen: true, muted: true })

      vi.setSystemTime(new Date('2026-10-21T12:12:30Z'))
      // A ping keeps a browser in the list; without one it falls out after STALE_MS.
      await b.fire('huddle:ping', { room: 'ch:ops' })
      await a.fire('huddle:leave', { room: 'ch:ops' })
      expect(lines).toHaveLength(1)
      await b.fire('disconnect')
      expect(lines[1]).toEqual({
        room: 'ch:ops',
        text: 'Huddle ended after 13 min · Rob Lee and Amy'
      })
      expect(redis.store.has('nvr:huddle:-:ch:ops:start')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('formatHuddleDuration', () => {
  it('reads like a person', () => {
    expect(formatHuddleDuration(20_000)).toBe('under a minute')
    expect(formatHuddleDuration(5 * 60_000)).toBe('5 min')
    expect(formatHuddleDuration(125 * 60_000)).toBe('2 h 5 min')
    expect(formatHuddleDuration(120 * 60_000)).toBe('2 h')
  })
})
