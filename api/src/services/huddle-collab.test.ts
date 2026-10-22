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
const ben = { id: 'U-BEN', first_name: 'Ben', last_name: null, email: 'ben@x' } as User

const scope = {
  scopedRoom: async (r: string) => r,
  scopedRoomNow: (r: string) => r,
  tenantNow: () => ''
}

function setup(
  over: {
    allowed?: () => boolean
    record?: boolean
    /** Writers (by user id) the room refuses, with the reason. */
    refuseWriters?: Record<string, string>
  } = {}
) {
  const redis = fakeRedis()
  const io = fakeIo()
  const lines: Array<{ room: string; text: string }> = []
  const notes: Array<{ room: string; author: string; text: string }> = []
  const checked: string[] = []
  const canSeeRoom = async () => (over.allowed ? over.allowed() : true)
  const hd: HuddleDeps = {
    redis,
    canSeeRoom,
    settings: async () => ({ enabled: true, max_participants: 8 }),
    postLine: async (room, text) => {
      lines.push({ room, text })
    },
    noteWriterRefusal: async (_room, w) => {
      checked.push(w.id)
      return over.refuseWriters?.[w.id] ?? null
    },
    postNote: async (room, author, text) => {
      notes.push({ room, author, text })
      return null
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
  return { redis, io, lines, notes, checked, connect }
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

  it('the end posts the note AS ITS LAST EDITOR, then the fixed end line', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
    try {
      const { redis, lines, notes, checked, connect } = setup()
      const a = connect('S1', rob)
      const b = connect('S2', amy)
      await a.fire('huddle:join', { room: 'ch:ops' })
      await b.fire('huddle:join', { room: 'ch:ops' })
      await a.fire('huddle:note', { room: 'ch:ops', text: 'Ship', rev: 0 })
      await b.fire('huddle:note', { room: 'ch:ops', text: '  Ship Friday  ', rev: 1 })
      await b.fire('huddle:leave', { room: 'ch:ops' })
      vi.setSystemTime(new Date('2026-10-21T12:24:00Z'))
      await a.fire('huddle:leave', { room: 'ch:ops' })
      // Every writer was checked; the note goes out as Amy (the last editor), naming both
      // writers — never through the system line.
      expect(checked).toEqual(['U-ROB', 'U-AMY'])
      expect(notes).toEqual([
        {
          room: 'ch:ops',
          author: 'U-AMY',
          text: '**Huddle notes · 24 min · written by Rob Lee and Amy**\n\nShip Friday'
        }
      ])
      expect(lines.slice(1)).toEqual([
        { room: 'ch:ops', text: 'Huddle ended after 24 min · Rob Lee and Amy' }
      ])
      expect(redis.store.has('nvr:huddle:-:ch:ops:note')).toBe(false)
      expect(redis.store.has('nvr:huddle:-:ch:ops:who')).toBe(false)
      expect(redis.store.has('nvr:huddle:-:ch:ops:writers')).toBe(false)
      expect(redis.store.has('nvr:huddle:-:ch:ops:note:ended')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('one writer who may not post blocks the post — even when an owner edits last', async () => {
    const reason = 'Rob Lee cannot post in this announcement channel'
    const { redis, io, lines, notes, connect } = setup({ refuseWriters: { 'U-ROB': reason } })
    const a = connect('S1', rob)
    const b = connect('S2', amy)
    await a.fire('huddle:join', { room: 'ch:news' })
    await b.fire('huddle:join', { room: 'ch:news' })
    await a.fire('huddle:note', { room: 'ch:news', text: 'Rob’s words', rev: 0 })
    // Amy (the channel owner) makes the final edit: Rob's words still never go out as hers.
    await b.fire('huddle:note', { room: 'ch:news', text: 'Rob’s words.', rev: 1 })
    await b.fire('huddle:leave', { room: 'ch:news' })
    await a.fire('huddle:leave', { room: 'ch:news' })
    expect(notes).toEqual([])
    expect(lines.at(-1)?.text).toBe(
      `Huddle ended after under a minute · Rob Lee and Amy · notes were not posted: ${reason}`
    )
    expect(a.emitted.at(-1)).toEqual({
      event: 'huddle:note:unposted',
      payload: { room: 'ch:news', reason }
    })
    // Frozen apart from the live keys; nothing of it reached the room's viewers.
    expect(redis.store.has('nvr:huddle:-:ch:news:note')).toBe(false)
    expect(redis.store.has('nvr:huddle:-:ch:news:note:ended')).toBe(true)
    expect(
      io.sent.filter((s) => s.to === 'chat:ch:news' && s.event.startsWith('huddle:note'))
    ).toEqual([])

    // An attendee fetches it back; someone who was not in that huddle cannot.
    await a.fire('huddle:note:fetch', { room: 'ch:news' })
    expect(a.emitted.at(-1)).toEqual({
      event: 'huddle:note:kept',
      payload: { room: 'ch:news', text: 'Rob’s words.' }
    })
    const cara = { id: 'U-CARA', first_name: 'Cara', last_name: null, email: 'c@x' } as User
    const stranger = connect('S7', cara)
    await stranger.fire('huddle:note:fetch', { room: 'ch:news' })
    expect(stranger.emitted).toEqual([])
  })

  it('a new huddle in the room starts empty and never hands out the last one’s note', async () => {
    const { connect } = setup({ refuseWriters: { 'U-ROB': 'Rob Lee cannot post in this room' } })
    const a = connect('S1', rob)
    await a.fire('huddle:join', { room: 'ch:news' })
    await a.fire('huddle:note', { room: 'ch:news', text: 'Old session', rev: 0 })
    await a.fire('huddle:leave', { room: 'ch:news' })

    const cara = { id: 'U-CARA', first_name: 'Cara', last_name: null, email: 'c@x' } as User
    const c = connect('S3', cara)
    await c.fire('huddle:join', { room: 'ch:news' })
    await c.fire('huddle:collab:sync', { room: 'ch:news' })
    expect(c.emitted.filter((e) => e.event === 'huddle:note')).toEqual([])
    await c.fire('huddle:note:fetch', { room: 'ch:news' })
    expect(c.emitted.filter((e) => e.event === 'huddle:note:kept')).toEqual([])
    // The new session's first edit starts again at rev 1.
    await c.fire('huddle:note', { room: 'ch:news', text: 'New session', rev: 0 })
    expect(c.emitted.filter((e) => e.event === 'huddle:note:denied')).toEqual([])
    // Rob attended the old one: he can still fetch it.
    await a.fire('huddle:note:fetch', { room: 'ch:news' })
    expect(a.emitted.at(-1)?.payload).toEqual({ room: 'ch:news', text: 'Old session' })
  })

  it('only the server moves the rev: huge, fractional and negative revs are refused', async () => {
    const { io, connect } = setup()
    const a = connect('S1', rob)
    await a.fire('huddle:join', { room: 'ch:ops' })
    for (const rev of [Number.MAX_SAFE_INTEGER, 1e300, 0.5, -1, 1]) {
      await a.fire('huddle:note', { room: 'ch:ops', text: `rev ${rev}`, rev })
      expect(a.emitted.at(-1)).toEqual({
        event: 'huddle:note:denied',
        payload: { room: 'ch:ops', reason: 'bad-rev', rev: 0 }
      })
    }
    expect(io.sent.filter((s) => s.event === 'huddle:note')).toEqual([])
    await new Promise((r) => setTimeout(r, 1010))

    await a.fire('huddle:note', { room: 'ch:ops', text: 'one', rev: 0 })
    await a.fire('huddle:note', { room: 'ch:ops', text: 'two', rev: 1 })
    // A stale copy (rev 0 while the server is at 2) still wins — last writer — at rev 3.
    await a.fire('huddle:note', { room: 'ch:ops', text: 'three', rev: 0 })
    const sent = io.sent.filter((s) => s.event === 'huddle:note').map((s) => s.payload)
    expect(sent.map((p) => [p.text, p.rev])).toEqual([
      ['one', 1],
      ['two', 2],
      ['three', 3]
    ])
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
    const c = connect('S3', ben)
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
      '**Huddle notes · 24 min · written by Ana and Ben**\n\nx'
    )
    expect(cleanKey('  lines ')).toBe('lines')
    expect(cleanKey('a\nb')).toBeNull()
    expect(cleanKey('x'.repeat(121))).toBeNull()
    expect(cleanKey(3)).toBeNull()
  })
})
