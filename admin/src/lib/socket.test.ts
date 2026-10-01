import { beforeEach, describe, expect, it, vi } from 'vitest'

// The leader election is replaced by a harness: this tab is the leader, and "other tabs" are
// simulated by calling the leader's emit sink directly (that is what their BroadcastChannel
// messages turn into).
const fakeSocket = {
  connected: true,
  emit: vi.fn(),
  on: vi.fn(),
  onAny: vi.fn(),
  listeners: vi.fn(() => [])
}
vi.mock('socket.io-client', () => ({ io: vi.fn(() => fakeSocket) }))
const sink: { current: (event: string, payload: unknown) => void } = { current: () => {} }
vi.mock('@nivaro/shared', () => ({
  createLeaderSocket: (
    _key: string,
    cbs: {
      becomeLeader: (
        deliver: (e: string, p: unknown) => void,
        emit: { current: (e: string, p: unknown) => void }
      ) => void
    }
  ) => {
    cbs.becomeLeader(() => {}, sink)
    return {
      isLeader: () => true,
      onEvent: () => () => {},
      emit: (e: string, p: unknown) => sink.current(e, p),
      destroy: () => {}
    }
  }
}))

import { joinWatchRoom } from './socket'

const watchEmits = () =>
  fakeSocket.emit.mock.calls
    .filter((c) => c[0] === 'admin:join' || c[0] === 'admin:leave')
    .map((c) => `${c[0]} ${(c[1] as { room: string }).room}`)

describe('watch rooms are reference counted across tabs', () => {
  beforeEach(() => fakeSocket.emit.mockClear())

  it('a follower leaving does not take the room away from the tab still watching', () => {
    const leaveMine = joinWatchRoom('traffic-map')
    sink.current('__join_watch', 'traffic-map') // a follower tab opens the same page
    sink.current('__leave_watch', 'traffic-map') // ...and closes it
    expect(watchEmits()).toEqual(['admin:join traffic-map', 'admin:join traffic-map'])
    leaveMine()
    expect(watchEmits().at(-1)).toBe('admin:leave traffic-map')
  })

  it('a double cleanup does not drop another watcher', () => {
    const a = joinWatchRoom('traffic')
    const b = joinWatchRoom('traffic')
    a()
    a()
    expect(watchEmits()).not.toContain('admin:leave traffic')
    b()
    expect(watchEmits()).toContain('admin:leave traffic')
  })

  it('rooms are independent (Realtime traffic + firehose)', () => {
    const t = joinWatchRoom('traffic')
    const f = joinWatchRoom('firehose')
    t()
    expect(watchEmits()).toEqual([
      'admin:join traffic',
      'admin:join firehose',
      'admin:leave traffic'
    ])
    f()
    expect(watchEmits().at(-1)).toBe('admin:leave firehose')
  })
})
