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
  huddleMode,
  huddlePeers,
  huddleRoomKind,
  huddleSession,
  registerHuddle,
  STALE_MS,
  setHuddleStaleEvictor,
  staleEvictorFor
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
const ben = { id: 'U-BEN', first_name: 'Ben', last_name: null, email: 'ben@x' } as User

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
  it('allows channels, General, record rooms and DMs (#2843); refuses junk', () => {
    expect(huddleRoomKind('ch:ops')).toBe('ok')
    expect(huddleRoomKind('global')).toBe('ok')
    expect(huddleRoomKind('ord:ORD-1')).toBe('ok')
    expect(huddleRoomKind('dm:A:B')).toBe('ok')
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

  it('huddle:mark recipients drop a socket the moment it leaves or is pruned (#2856)', async () => {
    const io = fakeIo()
    const { d } = deps(redis)
    const [a, b, c] = ['S1', 'S2', 'S3'].map(fakeSocket)
    for (const [s, u] of [
      [a, rob],
      [b, amy],
      [c, ben]
    ] as const)
      registerHuddle(io as never, s.socket as never, () => u, scope, d)
    for (const s of [a, b, c]) await s.fire('huddle:join', { room: 'ch:ops' })
    const mark = async () => {
      io.sent.length = 0
      await a.fire('huddle:mark', { room: 'ch:ops', t: 'pt', s: 'S2', x: 0.5, y: 0.5 })
      return io.sent.find((x) => x.event === 'huddle:mark')?.to
    }
    expect(await mark()).toEqual(['S2', 'S3'])
    await c.fire('huddle:leave', { room: 'ch:ops' })
    expect(await mark()).toEqual(['S2'])
    // B stops pinging: the next roster read prunes it, and marks stop reaching it at once.
    await redis.zadd('nvr:huddle:-:ch:ops', 1, 'S2')
    await huddlePeers(redis, '', 'ch:ops')
    expect(await mark()).toBeUndefined()
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

  it('one seat per person: joining from another socket moves them there, the huddle carries on', async () => {
    const io = fakeIo()
    const { d, lines } = deps(redis)
    const a = fakeSocket('S1')
    const b = fakeSocket('S2')
    const a2 = fakeSocket('S3')
    registerHuddle(io as never, a.socket as never, () => rob, scope, d)
    registerHuddle(io as never, b.socket as never, () => amy, scope, d)
    registerHuddle(
      io as never,
      a2.socket as never,
      () => ({ ...rob, id: 'u-rob' }) as User,
      scope,
      d
    )
    await a.fire('huddle:join', { room: 'ch:ops' })
    await b.fire('huddle:join', { room: 'ch:ops' })
    const start = redis.store.get('nvr:huddle:-:ch:ops:start')

    // Rob again from a second socket (another window, or a reconnect whose old socket the
    // server has not noticed yet): the old seat goes and its socket is told why.
    await a2.fire('huddle:join', { room: 'ch:ops' })
    expect((await huddlePeers(redis, null, 'ch:ops')).map((p) => p.socket)).toEqual(['S2', 'S3'])
    expect(io.sent).toContainEqual({
      to: 'S1',
      event: 'huddle:denied',
      payload: { room: 'ch:ops', reason: 'moved' }
    })
    const joined = a2.emitted[0].payload as { peers: Array<{ socket: string }> }
    expect(joined.peers.map((p) => p.socket)).toEqual(['S2'])
    const last = io.sent.filter((s) => s.event === 'huddle:peers').at(-1)?.payload as {
      peers: Array<{ socket: string }>
    }
    expect(last.peers.map((p) => p.socket)).toEqual(['S2', 'S3'])

    // The old socket going away later changes nothing for the seat that replaced it.
    await a.fire('disconnect')
    expect((await huddlePeers(redis, null, 'ch:ops')).map((p) => p.socket)).toEqual(['S2', 'S3'])
    expect(lines).toEqual([{ room: 'ch:ops', text: 'Rob Lee started a huddle' }])
    expect(redis.store.get('nvr:huddle:-:ch:ops:start')).toBe(start)
  })

  it('the only person rejoining from a new socket keeps the same huddle (no restart, no line)', async () => {
    const io = fakeIo()
    const { d, lines } = deps(redis)
    const a = fakeSocket('S1')
    const a2 = fakeSocket('S2')
    registerHuddle(io as never, a.socket as never, () => rob, scope, d)
    registerHuddle(io as never, a2.socket as never, () => rob, scope, d)
    await a.fire('huddle:join', { room: 'ch:ops' })
    const session = await huddleSession(redis, null, 'ch:ops')
    await a2.fire('huddle:join', { room: 'ch:ops' })
    expect((await huddlePeers(redis, null, 'ch:ops')).map((p) => p.socket)).toEqual(['S2'])
    expect(await huddleSession(redis, null, 'ch:ops')).toBe(session)
    expect(lines).toHaveLength(1)
    // The replaced socket's late leave neither ends the huddle nor touches the new seat.
    await a.fire('huddle:leave', { room: 'ch:ops' })
    expect((await huddlePeers(redis, null, 'ch:ops')).map((p) => p.socket)).toEqual(['S2'])
    expect(lines).toHaveLength(1)
  })

  it('refuses junk rooms, a disabled instance, a full huddle and a room the person cannot see', async () => {
    const io = fakeIo()
    const a = fakeSocket('S1')
    const { d } = deps(redis, {
      settings: async () => ({ enabled: true, max_participants: 2 }),
      canSeeRoom: async (_u, room) => room !== 'ch:secret'
    })
    registerHuddle(io as never, a.socket as never, () => rob, scope, d)
    await a.fire('huddle:join', { room: 'nonsense' })
    expect(a.emitted.at(-1)).toEqual({
      event: 'huddle:denied',
      payload: { room: 'nonsense', reason: 'bad-room' }
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

describe('large huddles (#2859): the mode switch', () => {
  it('the join that exceeds switch_at moves the huddle to the SFU, once, until it ends', async () => {
    const redis = fakeRedis()
    const io = fakeIo()
    const { d } = deps(redis, {
      settings: async () => ({ enabled: true, max_participants: 25, sfu: true, switch_at: 2 })
    })
    const socks = ['S1', 'S2', 'S3'].map((id) => fakeSocket(id))
    const people = [rob, amy, ben]
    for (const [i, s] of socks.entries()) {
      registerHuddle(io as never, s.socket as never, () => people[i], scope, d)
    }

    await socks[0].fire('huddle:join', { room: 'ch:ops' })
    await socks[1].fire('huddle:join', { room: 'ch:ops' })
    expect((socks[1].emitted[0].payload as { mode: string }).mode).toBe('mesh')
    expect(io.sent.some((s) => s.event === 'huddle:mode')).toBe(false)
    expect(await huddleMode(redis, null, 'ch:ops')).toBe('mesh')

    // Third person: 3 > 2 → everyone in the huddle hears huddle:mode, the joiner lands in sfu.
    await socks[2].fire('huddle:join', { room: 'ch:ops' })
    expect((socks[2].emitted[0].payload as { mode: string }).mode).toBe('sfu')
    expect(io.sent.filter((s) => s.event === 'huddle:mode')).toEqual([
      { to: 'huddle:ch:ops', event: 'huddle:mode', payload: { room: 'ch:ops', mode: 'sfu' } }
    ])
    expect(await huddleMode(redis, null, 'ch:ops')).toBe('sfu')
    const peers = io.sent.filter((s) => s.event === 'huddle:peers').at(-1)?.payload as {
      mode: string
    }
    expect(peers.mode).toBe('sfu')

    // People leaving never flips it back…
    await socks[2].fire('huddle:leave', { room: 'ch:ops' })
    await socks[1].fire('huddle:leave', { room: 'ch:ops' })
    expect(await huddleMode(redis, null, 'ch:ops')).toBe('sfu')
    expect(io.sent.filter((s) => s.event === 'huddle:mode')).toHaveLength(1)
    // …a rejoin lands straight in sfu, and only the last leave resets the room.
    await socks[1].fire('huddle:join', { room: 'ch:ops' })
    expect((socks[1].emitted.at(-1)?.payload as { mode: string }).mode).toBe('sfu')
    await socks[1].fire('huddle:leave', { room: 'ch:ops' })
    await socks[0].fire('huddle:leave', { room: 'ch:ops' })
    expect(redis.store.has('nvr:huddle:-:ch:ops:mode')).toBe(false)
    expect(await huddleMode(redis, null, 'ch:ops')).toBe('mesh')
  })

  it('a session id names each huddle; evictions reach the SFU on leave, access loss, stale prune and end', async () => {
    const redis = fakeRedis()
    const io = fakeIo()
    let allowed = true
    const evicted: Array<{ session: string; identity: string | null }> = []
    const { d } = deps(redis, {
      settings: async () => ({ enabled: true, max_participants: 25, sfu: true, switch_at: 1 }),
      canSeeRoom: async () => allowed,
      sfuEvict: async ({ session, identity }) => {
        evicted.push({ session, identity })
      }
    })
    const a = fakeSocket('S1')
    const b = fakeSocket('S2')
    registerHuddle(io as never, a.socket as never, () => rob, scope, d)
    registerHuddle(io as never, b.socket as never, () => amy, scope, d)

    await a.fire('huddle:join', { room: 'ch:ops' })
    const session1 = await huddleSession(redis, null, 'ch:ops')
    expect(session1).toMatch(/^[A-Za-z0-9_-]{16}$/)
    await b.fire('huddle:join', { room: 'ch:ops' })
    expect(await huddleMode(redis, null, 'ch:ops')).toBe('sfu')
    expect(await huddleSession(redis, null, 'ch:ops')).toBe(session1)

    // A third browser whose heartbeat stopped: pruned from the roster AND dropped from LiveKit.
    await redis.zadd('nvr:huddle:-:ch:ops', Date.now() - STALE_MS - 1, 'S3')
    await redis.hset('nvr:huddle:-:ch:ops:m', 'S3', JSON.stringify({ user: 'U-GONE', name: 'x' }))
    await b.fire('huddle:ping', { room: 'ch:ops' })
    await b.fire('huddle:state', { room: 'ch:ops', muted: true })
    await new Promise((r) => setImmediate(r))
    expect(evicted).toContainEqual({ session: session1, identity: 'U-GONE#S3' })

    // Membership revoked mid-call → the mesh denial AND the SFU eviction.
    allowed = false
    await b.fire('huddle:ping', { room: 'ch:ops' })
    expect(b.emitted.at(-1)?.event).toBe('huddle:denied')
    expect(evicted).toContainEqual({ session: session1, identity: 'U-AMY#S2' })
    allowed = true

    // The last leave closes the LiveKit room and forgets the session.
    await a.fire('huddle:leave', { room: 'ch:ops' })
    expect(evicted.at(-2)).toEqual({ session: session1, identity: 'U-ROB#S1' })
    expect(evicted.at(-1)).toEqual({ session: session1, identity: null })
    expect(await huddleSession(redis, null, 'ch:ops')).toBeNull()
    expect(redis.store.has('nvr:huddle:-:ch:ops:mode')).toBe(false)

    // The next huddle in the same room is a new session (a new LiveKit room).
    await a.fire('huddle:join', { room: 'ch:ops' })
    const session2 = await huddleSession(redis, null, 'ch:ops')
    expect(session2).not.toBe(session1)
    expect(await huddleMode(redis, null, 'ch:ops')).toBe('mesh')
    // Leaving a mesh huddle talks to no SFU.
    const before = evicted.length
    await a.fire('huddle:leave', { room: 'ch:ops' })
    expect(evicted.length).toBe(before)
  })

  it('a REST-path roster read (no socket handler involved) evicts the stale browsers it prunes', async () => {
    const redis = fakeRedis()
    const evicted: Array<{ session: string; identity: string | null }> = []
    const warned: string[] = []
    const { d } = deps(redis, {
      sfuEvict: async ({ session, identity }) => {
        if (identity === 'U-BAD#S4') throw new Error('boom')
        evicted.push({ session, identity })
      },
      warn: (_o, msg) => {
        warned.push(msg)
      }
    })
    setHuddleStaleEvictor(staleEvictorFor(d))
    // An SFU huddle whose session is known, with one live and two stale browsers.
    await redis.set('nvr:huddle:-:ch:ops:mode', 'sfu', 'EX', 1)
    await redis.set('nvr:huddle:-:ch:ops:s', 'sessX', 'EX', 1)
    const now = Date.now()
    await redis.zadd('nvr:huddle:-:ch:ops', now, 'S1')
    await redis.zadd('nvr:huddle:-:ch:ops', now - STALE_MS - 1, 'S3')
    await redis.zadd('nvr:huddle:-:ch:ops', now - STALE_MS - 1, 'S4')
    for (const [sock, user] of [
      ['S1', 'U-ROB'],
      ['S3', 'U-GONE'],
      ['S4', 'U-BAD']
    ]) {
      await redis.hset('nvr:huddle:-:ch:ops:m', sock, JSON.stringify({ user, name: user }))
    }
    // The same call GET /chat/huddle/presence and the token route make.
    const peers = await huddlePeers(redis, null, 'ch:ops', now)
    expect(peers.map((p) => p.socket)).toEqual(['S1'])
    await new Promise((r) => setImmediate(r))
    expect(evicted).toEqual([{ session: 'sessX', identity: 'U-GONE#S3' }])
    expect(warned).toEqual(['huddle: SFU eviction failed'])

    // A mesh huddle tells no SFU; without an installed evictor the prune is just a prune.
    await redis.set('nvr:huddle:-:ch:ops:mode', 'mesh', 'EX', 1)
    await redis.zadd('nvr:huddle:-:ch:ops', now - STALE_MS - 1, 'S5')
    await redis.hset('nvr:huddle:-:ch:ops:m', 'S5', JSON.stringify({ user: 'U-5', name: '5' }))
    await huddlePeers(redis, null, 'ch:ops', now)
    await new Promise((r) => setImmediate(r))
    expect(evicted).toHaveLength(1)
    setHuddleStaleEvictor(null)
    await redis.set('nvr:huddle:-:ch:ops:mode', 'sfu', 'EX', 1)
    await redis.zadd('nvr:huddle:-:ch:ops', now - STALE_MS - 1, 'S6')
    await redis.hset('nvr:huddle:-:ch:ops:m', 'S6', JSON.stringify({ user: 'U-6', name: '6' }))
    expect((await huddlePeers(redis, null, 'ch:ops', now)).map((p) => p.socket)).toEqual(['S1'])
    await new Promise((r) => setImmediate(r))
    expect(evicted).toHaveLength(1)
  })

  it('an eviction that fails is logged, never thrown into the socket handler', async () => {
    const redis = fakeRedis()
    const io = fakeIo()
    const warned: string[] = []
    const { d, lines } = deps(redis, {
      settings: async () => ({ enabled: true, max_participants: 25, sfu: true, switch_at: 1 }),
      sfuEvict: async () => {
        throw new Error('ECONNREFUSED')
      },
      warn: (_o, msg) => {
        warned.push(msg)
      }
    })
    const a = fakeSocket('S1')
    const b = fakeSocket('S2')
    registerHuddle(io as never, a.socket as never, () => rob, scope, d)
    registerHuddle(io as never, b.socket as never, () => amy, scope, d)
    await a.fire('huddle:join', { room: 'ch:ops' })
    await b.fire('huddle:join', { room: 'ch:ops' })
    await b.fire('huddle:leave', { room: 'ch:ops' })
    await a.fire('huddle:leave', { room: 'ch:ops' })
    expect(warned).toContain('huddle: SFU eviction failed')
    expect(lines.at(-1)?.text).toMatch(/^Huddle ended/)
    expect((await huddlePeers(redis, null, 'ch:ops')).length).toBe(0)
  })

  it('without an SFU the mesh carries on past switch_at', async () => {
    const redis = fakeRedis()
    const io = fakeIo()
    const { d } = deps(redis, {
      settings: async () => ({ enabled: true, max_participants: 8, sfu: false, switch_at: 1 })
    })
    const a = fakeSocket('S1')
    const b = fakeSocket('S2')
    registerHuddle(io as never, a.socket as never, () => rob, scope, d)
    registerHuddle(io as never, b.socket as never, () => amy, scope, d)
    await a.fire('huddle:join', { room: 'ch:ops' })
    await b.fire('huddle:join', { room: 'ch:ops' })
    expect((b.emitted[0].payload as { mode: string }).mode).toBe('mesh')
    expect(io.sent.some((s) => s.event === 'huddle:mode')).toBe(false)
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
