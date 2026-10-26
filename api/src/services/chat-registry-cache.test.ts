import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The chat channel registry is cached per process. A channel or group DM made on ANOTHER
 * replica (or a change to one) must be seen at once — staging, 2026-10-26: the first message
 * to a brand-new group failed with "not available to you" for up to 30 s.
 */

const state = vi.hoisted(() => ({
  channels: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<{ user: string; room: string }>,
  fullReads: 0,
  keyReads: 0,
  tenant: '',
  touched: [] as string[],
  touchListeners: [] as Array<(collection: string, tenant: string) => void>
}))

vi.mock('../db/index.js', () => ({
  db: (table: string) => {
    if (table === 'nivaro_chat_channels') {
      let where: Record<string, unknown> | null = null
      let keys: string[] | null = null
      const q: any = {
        where: (col: string | Record<string, unknown>, val?: unknown) => {
          where = typeof col === 'string' ? { [col]: val } : col
          return q
        },
        whereIn: (_col: string, vals: string[]) => {
          keys = vals
          return q
        },
        first: async () => {
          const [k, v] = Object.entries(where ?? {})[0] ?? []
          return state.channels.find((c) => String(c[k as string]) === String(v))
        },
        // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          let out: Array<Record<string, unknown>>
          if (keys) {
            state.keyReads++
            out = state.channels.filter((c) => keys!.includes(String(c.key)))
          } else {
            state.fullReads++
            out = [...state.channels]
          }
          return Promise.resolve(out.map((c) => ({ ...c }))).then(res, rej)
        }
      }
      return q
    }
    if (table === 'nivaro_chat_memberships') {
      let where: { user?: string; room?: string } = {}
      const q: any = {
        where: (w: { user?: string; room?: string }) => {
          where = w
          return q
        },
        first: async () =>
          state.memberships.find((m) => m.user === where.user && m.room === where.room)
      }
      return q
    }
    throw new Error(`unexpected table ${table}`)
  }
}))
vi.mock('./items.js', () => ({ readItems: vi.fn() }))
vi.mock('./permissions.js', () => ({ can: vi.fn() }))
vi.mock('./tenant-rooms.js', () => ({ currentTenantKey: () => state.tenant }))
vi.mock('./item-events.js', () => ({
  publishCollectionTouched: (c: string) => state.touched.push(c),
  onCollectionTouched: (fn: (collection: string, tenant: string) => void) => {
    state.touchListeners.push(fn)
    return () => {}
  }
}))

import {
  canSeeRoom,
  channelByKey,
  channels,
  chatParamRefusal,
  clearChatCaches,
  findChannelRow,
  wireChatRegistryRelay
} from './chat.js'

const alice = { id: 'AAAAAAAA-0000-0000-0000-000000000001', role: 'R1' } as any
const group = (key: string, extra: Record<string, unknown> = {}) => ({
  id: state.channels.length + 1,
  key,
  name: key,
  visibility: 'private',
  is_direct: true,
  is_archived: false,
  ...extra
})

beforeAll(async () => {
  await wireChatRegistryRelay()
})

beforeEach(() => {
  state.channels = []
  state.memberships = []
  state.fullReads = 0
  state.keyReads = 0
  state.tenant = ''
  state.touched = []
  clearChatCaches()
  state.touched = []
})

describe('chat channel registry across replicas', () => {
  it('finds a group made on another replica after this one cached the list', async () => {
    await channels() // this replica loads (and caches) the registry
    // Another replica creates the group and its memberships.
    state.channels.push(group('grp-new'))
    state.memberships.push({ user: alice.id, room: 'ch:grp-new' })

    expect(await canSeeRoom(alice, 'ch:grp-new')).toBe(true)
    expect(state.fullReads).toBe(1)
    expect(state.keyReads).toBe(1)
    // …and keeps it: the next lookup is a cache hit.
    expect(await channelByKey('grp-new')).toBeTruthy()
    expect(state.keyReads).toBe(1)
  })

  it('remembers a key that does not exist for a moment (no read per lookup)', async () => {
    await channels()
    expect(await channelByKey('nope')).toBeUndefined()
    expect(await channelByKey('nope')).toBeUndefined()
    expect(state.keyReads).toBe(1)
  })

  it('tells the other replicas when it clears, and clears when they do', async () => {
    state.channels.push(group('grp-a'))
    state.memberships.push({ user: alice.id, room: 'ch:grp-a' })
    expect(await canSeeRoom(alice, 'ch:grp-a')).toBe(true)

    clearChatCaches()
    expect(state.touched).toEqual(['nivaro_chat_channels'])

    // Another replica archives it and says so.
    await channels()
    state.channels[0].is_archived = true
    for (const fn of state.touchListeners) fn('nivaro_chat_channels', '')
    expect(await canSeeRoom(alice, 'ch:grp-a')).toBe(false)
  })

  it('keeps tenants apart', async () => {
    state.tenant = 't1'
    state.channels.push(group('grp-t1'))
    expect((await channels()).has('grp-t1')).toBe(true)
    // Tenant t2 has its own database: the t1 cache must never answer for it.
    state.tenant = 't2'
    state.channels = []
    expect((await channels()).has('grp-t1')).toBe(false)
    // A clear heard for t2 leaves t1's cache alone.
    for (const fn of state.touchListeners) fn('nivaro_chat_channels', 't2')
    state.tenant = 't1'
    const reads = state.fullReads
    expect((await channels()).has('grp-t1')).toBe(true)
    expect(state.fullReads).toBe(reads)
  })
})

describe('channel references in routes', () => {
  it('resolves a channel by id, key or ch:key', async () => {
    state.channels.push(group('team-x'))
    expect((await findChannelRow('1'))?.key).toBe('team-x')
    expect((await findChannelRow('team-x'))?.id).toBe(1)
    expect((await findChannelRow('ch:team-x'))?.id).toBe(1)
    expect(await findChannelRow('missing')).toBeNull()
    expect(await findChannelRow("x' or 1=1")).toBeNull()
  })

  it('refuses malformed ids before they reach an int / uuid column', () => {
    expect(chatParamRefusal('/api/chat/channels/:id/members', { id: 'grp-1a2b' })).toBeNull()
    expect(chatParamRefusal('/api/chat/channels/:id/members', { id: '12' })).toBeNull()
    expect(chatParamRefusal('/api/chat/channels/:id', { id: 'a b' })).toBe('Not found')
    expect(chatParamRefusal('/api/chat/messages/:id', { id: 'abc' })).toBe('Not found')
    expect(chatParamRefusal('/api/chat/messages/:id', { id: '99999999999' })).toBe('Not found')
    expect(chatParamRefusal('/api/chat/messages/:id', { id: '42' })).toBeNull()
    expect(chatParamRefusal('/api/chat/bot/streams/:id/stop', { id: 'abc-def' })).toBeNull()
    expect(
      chatParamRefusal('/api/chat/channels/:id/members/:userId', { id: '1', userId: 'bob' })
    ).toBe('Not found')
    expect(chatParamRefusal('/api/chat/rooms/:room/read', { room: 'dm:a:b' })).toBeNull()
  })
})
