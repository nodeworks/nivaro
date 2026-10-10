import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #1399 — watch a replay together over replay:<key> rooms. A tiny in-memory
 * io: rooms are sets of sockets, fetchSockets reads them, emits are recorded.
 */

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  cleanState,
  type ReplayWatchDeps,
  registerReplayWatch,
  rosterFrom
} from '../../../services/replay-watch.js'
import type { User } from '../../../types.js'

type Emitted = { to: string; event: string; payload: unknown }

class FakeSocket {
  data: Record<string, unknown> = {}
  rooms = new Set<string>()
  handlers = new Map<string, (p?: unknown) => unknown>()
  constructor(
    public id: string,
    private hub: Hub
  ) {}
  on(ev: string, fn: (p?: unknown) => unknown) {
    this.handlers.set(ev, fn)
  }
  emit(event: string, payload: unknown) {
    this.hub.log.push({ to: this.id, event, payload })
    return true
  }
  join(room: string) {
    this.rooms.add(room)
  }
  leave(room: string) {
    this.rooms.delete(room)
  }
  to(room: string) {
    return {
      emit: (event: string, payload: unknown) =>
        this.hub.log.push({ to: `${room} -${this.id}`, event, payload })
    }
  }
  async fire(ev: string, payload?: unknown) {
    await this.handlers.get(ev)?.(payload)
  }
}

class Hub {
  log: Emitted[] = []
  sockets: FakeSocket[] = []
  io = {
    in: (room: string) => ({
      fetchSockets: async () => this.sockets.filter((s) => s.rooms.has(room))
    }),
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => this.log.push({ to: room, event, payload })
    })
  }
  connect(id: string, user: User | null, deps: ReplayWatchDeps) {
    const s = new FakeSocket(id, this)
    this.sockets.push(s)
    registerReplayWatch(this.io as never, s as never, () => user, deps)
    return s
  }
  events(event: string) {
    return this.log.filter((e) => e.event === event)
  }
}

const user = (id: string, first: string, role = 'admin'): User =>
  ({ id, first_name: first, last_name: null, email: `${id}@x.dev`, role }) as User

const REC = '6f1c2b3a-1234-4abc-9def-0123456789ab'
const KEY = 'k3yAbcdef12'

let hub: Hub
let deps: ReplayWatchDeps
beforeEach(() => {
  hub = new Hub()
  deps = {
    isAdmin: vi.fn(async (u: User) => u.role === 'admin'),
    recordingExists: vi.fn(async (id: string) => id === REC)
  }
})

describe('replay:join', () => {
  it('the sharer leads; a joiner follows and asks the leader for the playhead', async () => {
    const ann = hub.connect('s1', user('U1', 'Ann'), deps)
    await ann.fire('replay:join', { key: KEY, recording: REC, lead: true })
    expect(ann.rooms.has(`replay:${KEY}`)).toBe(true)
    expect(hub.events('replay:joined')[0]).toMatchObject({
      to: 's1',
      payload: { key: KEY, recording: REC, leader: true }
    })

    const bob = hub.connect('s2', user('U2', 'Bob'), deps)
    await bob.fire('replay:join', { key: KEY, recording: REC })
    expect(hub.events('replay:joined')[1].payload).toMatchObject({ leader: false })
    expect(hub.events('replay:need-state')).toEqual([
      { to: `replay:${KEY}`, event: 'replay:need-state', payload: { key: KEY } }
    ])
    const roster = hub.events('replay:roster').at(-1)?.payload as { viewers: unknown[] }
    expect(roster.viewers).toEqual([
      { id: 'U1', name: 'Ann', leader: true },
      { id: 'U2', name: 'Bob', leader: false }
    ])
  })

  it('a second would-be leader follows while the room has one', async () => {
    const ann = hub.connect('s1', user('U1', 'Ann'), deps)
    await ann.fire('replay:join', { key: KEY, recording: REC, lead: true })
    const bob = hub.connect('s2', user('U2', 'Bob'), deps)
    await bob.fire('replay:join', { key: KEY, recording: REC, lead: true })
    expect(hub.events('replay:joined')[1].payload).toMatchObject({ leader: false })
  })

  it('refuses non-admins, bad keys, unknown recordings and a different recording', async () => {
    const eve = hub.connect('s9', user('U9', 'Eve', 'staff'), deps)
    await eve.fire('replay:join', { key: KEY, recording: REC })
    const anon = hub.connect('s8', null, deps)
    await anon.fire('replay:join', { key: KEY, recording: REC })
    const ann = hub.connect('s1', user('U1', 'Ann'), deps)
    await ann.fire('replay:join', { key: 'x', recording: REC })
    await ann.fire('replay:join', { key: KEY, recording: '00000000-0000-0000-0000-000000000000' })
    await ann.fire('replay:join', { key: KEY, recording: REC, lead: true })
    const bob = hub.connect('s2', user('U2', 'Bob'), deps)
    ;(deps.recordingExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    await bob.fire('replay:join', { key: KEY, recording: '11111111-2222-3333-4444-555555555555' })
    expect(
      hub.events('replay:denied').map((e) => (e.payload as { reason: string }).reason)
    ).toEqual(['admins-only', 'not-signed-in', 'bad-key', 'no-recording', 'other-recording'])
    expect(eve.rooms.size + anon.rooms.size + bob.rooms.size).toBe(0)
  })
})

describe('replay:state', () => {
  it('relays the leader’s playhead to the others, and nobody else’s', async () => {
    const ann = hub.connect('s1', user('U1', 'Ann'), deps)
    await ann.fire('replay:join', { key: KEY, recording: REC, lead: true })
    const bob = hub.connect('s2', user('U2', 'Bob'), deps)
    await bob.fire('replay:join', { key: KEY, recording: REC })

    await ann.fire('replay:state', { key: KEY, playing: true, time: 12_345.6, speed: 2 })
    await bob.fire('replay:state', { key: KEY, playing: false, time: 0, speed: 1 })
    await ann.fire('replay:state', { key: 'other-key-1', playing: true, time: 1, speed: 1 })
    expect(hub.events('replay:state')).toEqual([
      {
        to: `replay:${KEY} -s1`,
        event: 'replay:state',
        payload: { key: KEY, playing: true, time: 12_346, speed: 2, by: 'Ann' }
      }
    ])
  })
})

describe('leaving', () => {
  it('replay:leave and disconnect update the roster', async () => {
    const ann = hub.connect('s1', user('U1', 'Ann'), deps)
    await ann.fire('replay:join', { key: KEY, recording: REC, lead: true })
    const bob = hub.connect('s2', user('U2', 'Bob'), deps)
    await bob.fire('replay:join', { key: KEY, recording: REC })

    await bob.fire('replay:leave', { key: KEY })
    await new Promise((r) => setTimeout(r, 0))
    expect(bob.rooms.size).toBe(0)
    let roster = hub.events('replay:roster').at(-1)?.payload as { viewers: Array<{ id: string }> }
    expect(roster.viewers.map((v) => v.id)).toEqual(['U1'])

    // Disconnect: socket.io has already taken the socket out of its rooms.
    ann.rooms.clear()
    await ann.fire('disconnect')
    await new Promise((r) => setTimeout(r, 0))
    roster = hub.events('replay:roster').at(-1)?.payload as { viewers: Array<{ id: string }> }
    expect(roster.viewers).toEqual([])
  })
})

describe('helpers', () => {
  it('rosterFrom merges an admin’s tabs and lists the leader first', () => {
    const d = (id: string, name: string, leader: boolean, key = KEY) => ({
      key,
      recording: REC,
      user: { id, name },
      leader
    })
    expect(
      rosterFrom(
        [
          d('U2', 'Bob', false),
          d('U1', 'Ann', false),
          d('U1', 'Ann', true),
          undefined,
          d('U3', 'Cy', false, 'x')
        ],
        KEY
      )
    ).toEqual([
      { id: 'U1', name: 'Ann', leader: true },
      { id: 'U2', name: 'Bob', leader: false }
    ])
  })

  it('cleanState clamps what a leader sends', () => {
    expect(cleanState({ playing: true, time: 10.4, speed: 99 })).toEqual({
      playing: true,
      time: 10,
      speed: 1
    })
    expect(cleanState({ time: -1 })).toBeNull()
    expect(cleanState({ time: 'x' })).toBeNull()
    expect(cleanState(null)).toBeNull()
  })
})
