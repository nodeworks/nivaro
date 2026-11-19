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
/** What the leader hands to every tab's feed (follower tabs and its own shared hooks). */
const delivered: Array<[string, unknown]> = []
vi.mock('@nivaro/shared', async () => ({
  // Record-room holds are exercised in packages/shared (record-room-holds.test.ts).
  createRecordRoomHolds: (await import('../../../packages/shared/src/lib/record-room-holds'))
    .createRecordRoomHolds,
  // #2840 — browser chaos is exercised in packages/shared (client-chaos.test.ts).
  bindClientChaosSocket: () => {},
  clientChaosAxiosInterceptor: () => (config: unknown) => config,
  // #2462 — the room gap tracker is exercised in packages/shared (room-gaps.test.ts).
  createRoomGapTracker: () => ({
    observe: () => {},
    replayed: () => {},
    reset: () => {},
    stats: () => ({ gaps: 0, missed: 0, replayed: 0, refetched: 0 })
  }),
  refetchEventsFor: () => [],
  // Realtime 23 — the per-record gap tracker is exercised in packages/shared (record-gaps.test.ts).
  createRecordGapTracker: () => ({
    observe: () => {},
    forget: () => {},
    stats: () => ({ gaps: 0, missed: 0, refetched: 0, tracked: 0 })
  }),
  recordRefetchEvent: () => null,
  // Realtime 24 — socket self-repair is exercised in packages/shared (socket-liveness.test.ts).
  attachSocketLiveness: () => null,
  // Live updates setting (Normal/Calm/Off): these tests run as Normal.
  liveCollectionEventPasses: () => true,
  liveEventQuiet: () => false,
  noteWriteToScreenEvent: () => {},
  // Reload reactions run at once here (the 0–3 s spread is exercised in packages/shared).
  createJitteredReaction: () => (_key: string, fn: () => void) => fn(),
  // #2476 — the replay socket tap is exercised in packages/shared (replay-socket.test.ts).
  tapReplaySocket: () => {},
  // #2477 — no event here is sampled for a delivery ack.
  deliveryAckFor: () => null,
  // #2475 — these tests exercise the per-tab socket and the leader relay, not the worker.
  shouldUseWorkerSocket: () => false,
  createLeaderSocket: (
    _key: string,
    cbs: {
      becomeLeader: (
        deliver: (e: string, p: unknown) => void,
        emit: { current: (e: string, p: unknown) => void }
      ) => void
    }
  ) => {
    cbs.becomeLeader((e, p) => delivered.push([e, p]), sink)
    return {
      isLeader: () => true,
      onEvent: () => () => {},
      emit: (e: string, p: unknown) => sink.current(e, p),
      destroy: () => {}
    }
  },
  // Sign-out notes are exercised in packages/shared (sign-out-note) and the security route tests.
  SIGN_OUT_NOTE_EVENT: 'session:signed-out-note',
  parseSignOutNote: () => null,
  saveSignOutNote: () => {}
}))

import { adminRealtime, emitRecordRoom, joinWatchRoom } from './socket'

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

describe('leader relay (C1)', () => {
  it('hands notification:retired to every tab so the bell re-reads its counts', () => {
    joinWatchRoom('relay-probe')() // make sure the leader is up and its onAny is bound
    const onAny = fakeSocket.onAny.mock.calls.at(-1)?.[0] as
      | ((event: string, payload: unknown) => void)
      | undefined
    expect(onAny).toBeTypeOf('function')
    delivered.length = 0
    onAny?.('notification:retired', { ids: ['n1'], resolved: true })
    onAny?.('not-a-relayed-event', {})
    expect(delivered.map(([e]) => e)).toEqual(['notification:retired'])
  })
})

describe('record rooms per holder (realtime audit, efp L1)', () => {
  beforeEach(() => fakeSocket.emit.mockClear())
  const recordEmits = () =>
    fakeSocket.emit.mock.calls
      .filter((c) => c[0] === 'record:join' || c[0] === 'record:leave')
      .map((c) => [c[0], c[1]])

  it('a sheet closing on the record the page shows keeps the page in the room', () => {
    emitRecordRoom('record:join', { collection: 'workflows', item: '5', holder: 'page1' })
    // The shared presence hook of a drill-down sheet goes through the adapter.
    adminRealtime.emit('record:join', { collection: 'workflows', item: '5', holder: 'p1' })
    adminRealtime.emit('record:leave', { collection: 'workflows', item: '5', holder: 'p1' })
    expect(recordEmits()).toEqual([
      ['record:join', { collection: 'workflows', item: '5' }],
      ['record:join', { collection: 'workflows', item: '5' }]
    ])
    emitRecordRoom('record:leave', { collection: 'workflows', item: '5', holder: 'page1' })
    expect(recordEmits().at(-1)).toEqual(['record:leave', { collection: 'workflows', item: '5' }])
  })
})
