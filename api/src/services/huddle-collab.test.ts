import { describe, expect, it, vi } from 'vitest'
import type { User } from '../types.js'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))
vi.mock('./chat.js', () => ({
  canSeeRoom: async () => true,
  parseRoom: (room: string) => {
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
import {
  attendeeList,
  cleanKey,
  type HuddleCollabDeps,
  huddleEndLine,
  huddleNotesMessage,
  NOTE_MAX_BYTES,
  registerHuddleCollab
} from './huddle-collab.js'

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
  const handlers = new Map<string, Handler[]>()
  const emitted: Array<{ event: string; payload: any }> = []
  const socket = {
    id,
    data: {} as Record<string, unknown>,
    on: (ev: string, h: Handler) => {
      handlers.set(ev, [...(handlers.get(ev) ?? []), h])
    },
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload })
    },
    join: () => {},
    leave: () => {}
  }
  const fire = async (ev: string, ...args: unknown[]) => {
    for (const h of handlers.get(ev) ?? []) await h(...args)
  }
  return { socket, emitted, fire }
}

function fakeIo() {
  const sent: Array<{ to: string; event: string; payload: any }> = []
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

const scope = {
  scopedRoom: async (r: string) => r,
  scopedRoomNow: (r: string) => r,
  tenantNow: () => ''
}

function setup(over: { allowed?: () => boolean; record?: boolean } = {}) {
  const redis = fakeRedis()
  const io = fakeIo()
  const lines: Array<{ room: string; text: string }> = []
  const canSeeRoom = async () => (over.allowed ? over.allowed() : true)
  const hd: HuddleDeps = {
    redis,
    canSeeRoom,
    settings: async () => ({ enabled: true, max_participants: 8 }),
    postLine: async (room, text) => {
      lines.push({ room, text })
    },
    warn: () => {}
  }
  const cd: HuddleCollabDeps = {
    redis,
    canSeeRoom,
    roomRecord: async () => (over.record === false ? null : { collection: 'orders', id: '42' }),
    peerSockets: async (tenant, room) =>
      (await huddlePeers(redis, tenant, room)).map((p) => p.socket),
    warn: () => {}
  }
  const connect = (id: string, user: User) => {
    const s = fakeSocket(id)
    registerHuddle(io as never, s.socket as never, () => user, scope, hd)
    registerHuddleCollab(io as never, s.socket as never, () => user, scope, cd)
    return s
  }
  return { redis, io, lines, connect }
}

describe('huddle notes (#2854)', () => {
  it('syncs edits last-writer-wins with a rising rev, to the huddle only', async () => {
    const { io, connect } = setup()
    const a = connect('S1', rob)
    const b = connect('S2', amy)
    await a.fire('huddle:join', { room: 'ch:ops' })
    await b.fire('huddle:join', { room: 'ch:ops' })
    io.sent.length = 0

    await a.fire('huddle:note', { room: 'ch:ops', text: 'Agenda', rev: 0 })
    await b.fire('huddle:note', { room: 'ch:ops', text: 'Agenda\n- budgets', rev: 0 })
    const notes = io.sent.filter((s) => s.event === 'huddle:note')
    expect(notes.map((n) => n.to)).toEqual(['huddle:ch:ops', 'huddle:ch:ops'])
    expect(notes.map((n) => n.payload.rev)).toEqual([1, 2])
    expect(notes[1].payload).toMatchObject({
      text: 'Agenda\n- budgets',
      by: { id: 'U-AMY', name: 'Amy' },
      from: 'S2'
    })

    // A late joiner gets the current note on sync.
    const c = connect('S3', rob)
    await c.fire('huddle:join', { room: 'ch:ops' })
    await c.fire('huddle:collab:sync', { room: 'ch:ops' })
    expect(c.emitted.find((e) => e.event === 'huddle:note')?.payload).toMatchObject({
      text: 'Agenda\n- budgets',
      rev: 2
    })
  })

  it('refuses a note from outside the huddle, past 20 KB, or without access', async () => {
    let allowed = true
    const { io, connect } = setup({ allowed: () => allowed })
    const a = connect('S1', rob)
    await a.fire('huddle:note', { room: 'ch:ops', text: 'not in it', rev: 0 })
    expect(io.sent.filter((s) => s.event === 'huddle:note')).toEqual([])

    await a.fire('huddle:join', { room: 'ch:ops' })
    await a.fire('huddle:note', { room: 'ch:ops', text: 'x'.repeat(NOTE_MAX_BYTES + 1), rev: 0 })
    expect(a.emitted.at(-1)).toEqual({
      event: 'huddle:note:denied',
      payload: { room: 'ch:ops', reason: 'too-long' }
    })
    allowed = false
    await a.fire('huddle:note', { room: 'ch:ops', text: 'secret', rev: 0 })
    expect(a.emitted.at(-1)?.payload.reason).toBe('no-access')
    expect(io.sent.filter((s) => s.event === 'huddle:note')).toEqual([])
  })

  it('the end posts the duration + attendees, then the note as one message', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
    try {
      const { redis, lines, connect } = setup()
      const a = connect('S1', rob)
      const b = connect('S2', amy)
      await a.fire('huddle:join', { room: 'ch:ops' })
      await b.fire('huddle:join', { room: 'ch:ops' })
      await b.fire('huddle:leave', { room: 'ch:ops' })
      vi.setSystemTime(new Date('2026-10-21T12:24:00Z'))
      await a.fire('huddle:note', { room: 'ch:ops', text: '  Ship Friday  ', rev: 0 })
      await a.fire('huddle:leave', { room: 'ch:ops' })
      expect(lines.slice(1)).toEqual([
        { room: 'ch:ops', text: 'Huddle ended after 24 min · Rob Lee and Amy' },
        { room: 'ch:ops', text: '**Huddle notes · 24 min · Rob Lee, Amy**\n\nShip Friday' }
      ])
      expect(redis.store.has('nvr:huddle:-:ch:ops:note')).toBe(false)
      expect(redis.store.has('nvr:huddle:-:ch:ops:who')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an empty note posts nothing beyond the end line', async () => {
    const { lines, connect } = setup()
    const a = connect('S1', rob)
    await a.fire('huddle:join', { room: 'ch:ops' })
    await a.fire('huddle:note', { room: 'ch:ops', text: '   ', rev: 0 })
    await a.fire('huddle:leave', { room: 'ch:ops' })
    expect(lines.map((l) => l.text)).toEqual([
      'Rob Lee started a huddle',
      'Huddle ended after under a minute · Rob Lee'
    ])
  })
})

describe('Follow me (#2855)', () => {
  const room = 'ord:ORD-42'

  it('start names the room record from the server, moves follow, stop ends it', async () => {
    const { io, connect } = setup()
    const a = connect('S1', rob)
    const b = connect('S2', amy)
    await a.fire('huddle:join', { room })
    await b.fire('huddle:join', { room })
    io.sent.length = 0

    await a.fire('huddle:follow', { room, action: 'start', step: 'lines', section: 'budget' })
    expect(io.sent.at(-1)).toEqual({
      to: `huddle:${room}`,
      event: 'huddle:follow',
      payload: {
        room,
        action: 'start',
        presenter: { socket: 'S1', user: 'U-ROB', name: 'Rob Lee' },
        collection: 'orders',
        id: '42',
        step: 'lines',
        section: 'budget'
      }
    })
    await a.fire('huddle:follow', { room, action: 'move', step: 'files', section: null })
    expect(io.sent.at(-1)?.payload).toMatchObject({ action: 'move', step: 'files', section: null })

    // A late joiner learns who presents.
    const c = connect('S3', rob)
    await c.fire('huddle:join', { room })
    await c.fire('huddle:collab:sync', { room })
    expect(c.emitted.find((e) => e.event === 'huddle:follow')?.payload).toMatchObject({
      action: 'state',
      step: 'files'
    })

    await a.fire('huddle:follow', { room, action: 'stop' })
    expect(io.sent.at(-1)?.payload).toMatchObject({ action: 'stop' })
  })

  it('one presenter at a time: another asks, the presenter hands over or declines', async () => {
    const { io, connect } = setup()
    const a = connect('S1', rob)
    const b = connect('S2', amy)
    await a.fire('huddle:join', { room })
    await b.fire('huddle:join', { room })
    await a.fire('huddle:follow', { room, action: 'start' })

    await b.fire('huddle:follow', { room, action: 'start' })
    expect(b.emitted.at(-1)).toEqual({
      event: 'huddle:follow:denied',
      payload: {
        room,
        reason: 'busy',
        presenter: { socket: 'S1', user: 'U-ROB', name: 'Rob Lee' }
      }
    })
    // A move from someone who is not presenting is ignored.
    io.sent.length = 0
    await b.fire('huddle:follow', { room, action: 'move', step: 'x' })
    expect(io.sent).toEqual([])

    await b.fire('huddle:follow', { room, action: 'request' })
    expect(io.sent.at(-1)).toMatchObject({
      to: 'S1',
      payload: { action: 'request', from: { socket: 'S2', name: 'Amy' } }
    })
    await a.fire('huddle:follow', { room, action: 'decline', to: 'S2' })
    expect(io.sent.at(-1)).toMatchObject({ to: 'S2', payload: { action: 'declined' } })

    await a.fire('huddle:follow', { room, action: 'handover', to: 'S2' })
    expect(io.sent.at(-1)).toMatchObject({ to: 'S2', payload: { action: 'granted' } })
    await b.fire('huddle:follow', { room, action: 'start' })
    expect(io.sent.at(-1)?.payload).toMatchObject({
      action: 'start',
      presenter: { socket: 'S2' }
    })
  })

  it('the presenter leaving ends following for everyone', async () => {
    const { io, connect } = setup()
    const a = connect('S1', rob)
    const b = connect('S2', amy)
    await a.fire('huddle:join', { room })
    await b.fire('huddle:join', { room })
    await a.fire('huddle:follow', { room, action: 'start' })
    io.sent.length = 0
    await a.fire('huddle:leave', { room })
    expect(io.sent.find((s) => s.event === 'huddle:follow')?.payload).toMatchObject({
      action: 'stop',
      presenter: { socket: 'S1' }
    })
  })

  it('refuses channels, rooms with no readable record, revoked access and floods', async () => {
    let allowed = true
    const { io, connect } = setup({ allowed: () => allowed })
    const a = connect('S1', rob)
    await a.fire('huddle:join', { room: 'ch:ops' })
    await a.fire('huddle:follow', { room: 'ch:ops', action: 'start' })
    expect(a.emitted.at(-1)?.payload.reason).toBe('not-record')

    const none = setup({ record: false })
    const n = none.connect('S9', rob)
    await n.fire('huddle:join', { room })
    await n.fire('huddle:follow', { room, action: 'start' })
    expect(n.emitted.at(-1)?.payload.reason).toBe('no-record')

    await a.fire('huddle:join', { room })
    await a.fire('huddle:follow', { room, action: 'start' })
    for (let i = 0; i < 6; i++)
      await a.fire('huddle:follow', { room, action: 'move', step: `s${i}` })
    expect(a.emitted.at(-1)?.payload.reason).toBe('rate')
    expect(io.sent.filter((s) => s.event === 'huddle:follow').length).toBeLessThanOrEqual(4)

    allowed = false
    await new Promise((r) => setTimeout(r, 1010))
    await a.fire('huddle:follow', { room, action: 'move', step: 'z' })
    expect(a.emitted.at(-1)?.payload.reason).toBe('no-access')
  })
})

describe('helpers', () => {
  it('lists people and builds the lines', () => {
    expect(attendeeList([])).toBe('')
    expect(attendeeList(['Ana'])).toBe('Ana')
    expect(attendeeList(['Ana', 'Ben', 'Chris'])).toBe('Ana, Ben and Chris')
    expect(huddleEndLine('24 min', [])).toBe('Huddle ended after 24 min')
    expect(huddleNotesMessage('24 min', ['Ana', 'Ben'], 'x')).toBe(
      '**Huddle notes · 24 min · Ana, Ben**\n\nx'
    )
    expect(cleanKey('  lines ')).toBe('lines')
    expect(cleanKey('a\nb')).toBeNull()
    expect(cleanKey('x'.repeat(121))).toBeNull()
    expect(cleanKey(3)).toBeNull()
  })
})
