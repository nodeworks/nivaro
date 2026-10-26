import { describe, expect, it, vi } from 'vitest'

vi.mock('./chat.js', () => ({
  channels: async () => new Map([['ops', { name: 'Ops' }]]),
  channelByKey: async (key: string) => (key === 'ops' ? { name: 'Ops' } : undefined),
  parseRoom: (room: string) =>
    room.startsWith('ch:')
      ? { kind: 'channel', room, channelKey: room.slice(3) }
      : { kind: 'entity', room }
}))
vi.mock('./socket-tenant.js', () => ({
  inSocketTenant: (_s: unknown, h: (...a: unknown[]) => unknown) => h
}))

import { liveSnapshotFor, pokeHuddleLive } from './huddle-live.js'

const user = { id: 'U1' } as never

describe('liveSnapshotFor', () => {
  it('keeps only rooms the viewer can see and never lists an empty huddle', async () => {
    const rooms = await liveSnapshotFor(user, null, {
      sessions: { liveRooms: async () => ['ch:ops', 'ch:secret', 'ch:empty'] },
      peers: async (r) =>
        r === 'ch:empty' ? [] : r === 'ch:ops' ? [{ user: 'a' }, { user: 'b' }] : [{ user: 'c' }],
      canSeeRoom: async (_u, r) => r !== 'ch:secret',
      warn: () => undefined
    })
    expect(rooms).toEqual([{ room: 'ch:ops', label: 'Ops', count: 2, users: ['a', 'b'] }])
    expect(JSON.stringify(rooms)).not.toContain('secret')
  })

  it('is empty with no recorder', async () => {
    expect(
      await liveSnapshotFor(user, null, {
        peers: async () => [],
        canSeeRoom: async () => true,
        warn: () => undefined
      })
    ).toEqual([])
  })
})

describe('pokeHuddleLive', () => {
  it('coalesces a burst into one payload-free poke', async () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const io = { to: vi.fn(() => ({ emit })) }
    pokeHuddleLive(io as never, 'huddle-live')
    pokeHuddleLive(io as never, 'huddle-live')
    pokeHuddleLive(io as never, 'huddle-live')
    vi.advanceTimersByTime(1000)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('huddle:live-poke')
    vi.useRealTimers()
  })
})
