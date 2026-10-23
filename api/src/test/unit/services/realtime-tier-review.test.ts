import { afterEach, describe, expect, it, vi } from 'vitest'
import { emitterOnlyAdapter } from '../../../services/process-role.js'
import {
  boardIsViewing,
  resetBoard,
  setBoardsForTests,
  startBoardPublisher,
  startBoardReader,
  withdrawBoard
} from '../../../services/realtime-board.js'
import { createSchemaWatcher } from '../../../services/schema-watch.js'

/** A tiny in-memory Redis with the commands the board uses. */
function memRedis() {
  const kv = new Map<string, string>()
  const z = new Map<string, Map<string, number>>()
  const calls: string[] = []
  const r = {
    calls,
    kv,
    z,
    /** Set to make every registry read fail (Redis away). */
    down: false,
    /** Delay before zadd resolves (an in-flight tick). */
    zaddDelayMs: 0,
    async set(k: string, v: string) {
      calls.push('set')
      kv.set(k, v)
      return 'OK'
    },
    async mget(...keys: Array<string | string[]>) {
      calls.push('mget')
      return keys.flat().map((k) => kv.get(k) ?? null)
    },
    async del(...keys: string[]) {
      calls.push('del')
      for (const k of keys) kv.delete(k)
      return keys.length
    },
    async zadd(k: string, score: number, m: string) {
      calls.push('zadd')
      if (r.zaddDelayMs) await new Promise((res) => setTimeout(res, r.zaddDelayMs))
      const s = z.get(k) ?? new Map<string, number>()
      s.set(m, score)
      z.set(k, s)
      return 1
    },
    async zrem(k: string, m: string) {
      calls.push('zrem')
      return z.get(k)?.delete(m) ? 1 : 0
    },
    async zrangebyscore(k: string, min: number) {
      calls.push('zrangebyscore')
      if (r.down) throw new Error('ECONNREFUSED')
      return [...(z.get(k) ?? new Map<string, number>())]
        .filter(([, s]) => s >= min)
        .map(([m]) => m)
    },
    async zremrangebyscore() {
      calls.push('zremrangebyscore')
      return 0
    },
    async pexpire() {
      calls.push('pexpire')
      return 1
    },
    async scan() {
      calls.push('scan')
      return ['0', []]
    }
  }
  return r
}

const empty = {
  live: { sockets: 1, users: ['u'], viewers: {}, pages: [] },
  stats: { sockets: [], rooms: [] }
}
const collector = { live: () => empty.live, stats: () => empty.stats }

describe('realtime board registry (second review)', () => {
  afterEach(() => resetBoard())

  it('finds publishers through the registry (no SCAN) and withdraws on a graceful stop', async () => {
    const redis = memRedis()
    startBoardPublisher(redis as never, collector)
    await vi.waitFor(() => expect(redis.kv.size).toBe(2))
    startBoardReader(redis as never, { includeOwn: true })
    const { boardLive } = await import('../../../services/realtime-board.js')
    await vi.waitFor(() => expect(boardLive().length).toBe(1))
    expect(redis.calls).not.toContain('scan')
    await withdrawBoard()
    expect(redis.kv.size).toBe(0)
    expect(redis.calls).toContain('zrem')
  })

  it('skips a notification only on a board entry younger than 3 s', () => {
    const now = Date.now()
    const live = (at: number) => ({
      node: 'rt',
      at,
      sockets: 1,
      users: ['u-1'],
      viewers: { 'record:projects:1': [{ socket: 's', id: 'u-1', name: 'Ada' }] },
      pages: []
    })
    setBoardsForTests([live(now - 1_000)])
    expect(boardIsViewing('record:projects:1', 'u-1', 3_000, now)).toBe(true)
    setBoardsForTests([live(now - 5_000)])
    expect(boardIsViewing('record:projects:1', 'u-1', 3_000, now)).toBe(false)
  })
})

describe('emitter-only adapter (second review)', () => {
  const adapter = () => ({
    channel: 'socket.io#/#',
    requestChannel: 'socket.io-request#/#',
    serverCount: async () => 3
  })

  it('counts itself only once the request channel was left', async () => {
    const a = adapter()
    const ok = await emitterOnlyAdapter(a, {
      punsubscribe: async () => 1,
      unsubscribe: async () => 1
    })
    expect(ok).toBe(true)
    expect(await a.serverCount()).toBe(4)
  })

  it('stays in the quorum, uncounted, and says so when the unsubscribe fails', async () => {
    const a = adapter()
    const warn = vi.fn()
    const ok = await emitterOnlyAdapter(
      a,
      {
        punsubscribe: async () => 1,
        unsubscribe: async () => {
          throw new Error('connection lost')
        }
      },
      warn
    )
    expect(ok).toBe(false)
    expect(await a.serverCount()).toBe(3)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/request channel/), expect.any(Error))
  })
})

describe('GraphQL schema watcher (second review)', () => {
  it('rebuilds only when the schema inputs changed, one check at a time', async () => {
    let print = 'a'
    let fingerprints = 0
    const rebuild = vi.fn(async () => {})
    const w = createSchemaWatcher({
      fingerprint: async () => {
        fingerprints++
        await new Promise((r) => setTimeout(r, 5))
        return print
      },
      rebuild,
      debounceMs: 1
    })
    await w.baseline()
    expect(rebuild).not.toHaveBeenCalled()
    // A layout autosave: the inputs did not change.
    w.moved()
    await new Promise((r) => setTimeout(r, 20))
    await w.idle()
    expect(rebuild).not.toHaveBeenCalled()
    // A field change.
    print = 'b'
    w.moved()
    await new Promise((r) => setTimeout(r, 20))
    await w.idle()
    expect(rebuild).toHaveBeenCalledTimes(1)
    // Moves during a check fold into one more check, not one each.
    const before = fingerprints
    w.moved()
    await new Promise((r) => setTimeout(r, 3))
    w.moved()
    w.moved()
    await new Promise((r) => setTimeout(r, 30))
    await w.idle()
    expect(fingerprints - before).toBeLessThanOrEqual(2)
    w.stop()
  })

  it('rebuilds at the baseline when a move came before it', async () => {
    const rebuild = vi.fn(async () => {})
    const w = createSchemaWatcher({ fingerprint: async () => 'x', rebuild, debounceMs: 10_000 })
    w.moved()
    await w.baseline()
    expect(rebuild).toHaveBeenCalledTimes(1)
    w.stop()
  })
})

describe('peer board changes re-tell viewer lists (harness parity)', () => {
  afterEach(() => resetBoard())

  const board = (node: string, viewers: Record<string, string[]>, topics = {}) => ({
    node,
    at: Date.now(),
    sockets: 1,
    users: [],
    viewers: Object.fromEntries(
      Object.entries(viewers).map(([room, ids]) => [
        room,
        ids.map((id) => ({ socket: `s-${id}`, id, name: id }))
      ])
    ),
    pages: [],
    topics
  })

  it('names the rooms whose other-process viewers changed', async () => {
    const { changedPeerRooms } = await import('../../../services/realtime-board.js')
    const a = [board('rt-b', { 'record:projects:1': ['alice'], 'record:projects:2': ['bob'] })]
    // alice left record 1; record 2 unchanged; a topic room appeared.
    const b = [
      board(
        'rt-b',
        { 'record:projects:2': ['bob'] },
        { 'ops:issue-view:7': [{ socket: 's9', id: 'cy', name: 'cy' }] }
      )
    ]
    expect(changedPeerRooms(a, b).sort()).toEqual(['ops:issue-view:7', 'record:projects:1'])
    expect(changedPeerRooms(b, b)).toEqual([])
  })

  it('a realtime peer reader reports the change after a read', async () => {
    const { onPeerBoardChange } = await import('../../../services/realtime-board.js')
    const redis = memRedis()
    const seen: string[][] = []
    onPeerBoardChange((rooms) => seen.push(rooms))
    // Another process publishes a viewer; this one reads as a peer.
    redis.kv.set(
      'nvr:rt:board:test:rt-b:live',
      JSON.stringify(board('rt-b', { 'record:projects:1': ['alice'] }))
    )
    await redis.zadd('nvr:rt:board:test:nodes', Date.now(), 'rt-b')
    startBoardReader(redis as never, { peers: true })
    await vi.waitFor(() => expect(seen).toEqual([['record:projects:1']]))
    onPeerBoardChange(null)
  })
})

describe('the board with several socket-serving replicas (single role)', () => {
  afterEach(() => resetBoard())

  it('a lone process only registers; it publishes and reads once another one shows up', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      const { startBoard, boardMergeOn } = await import('../../../services/realtime-board.js')
      const redis = memRedis()
      const stop = startBoard(redis as never, { serves: true, collect: collector })
      await vi.advanceTimersByTimeAsync(10)
      expect(redis.calls).toContain('zadd')
      expect([...redis.kv.keys()]).toEqual([])
      expect(boardMergeOn()).toBe(false)
      // A second replica registers.
      await redis.zadd('nvr:rt:board:test:nodes', Date.now(), 'web-2')
      await vi.advanceTimersByTimeAsync(5_100)
      expect([...redis.kv.keys()].some((k) => k.endsWith(':live'))).toBe(true)
      expect(boardMergeOn()).toBe(true)
      await stop()
      expect([...redis.kv.keys()]).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges the other replicas with this one: viewing, pages, viewer lists, concurrency', async () => {
    const { setPeerBoardsForTests } = await import('../../../services/realtime-board.js')
    const sock = await import('../../../plugins/socketio.js')
    expect(sock.isUserViewing('projects', '5', 'bob')).toBe(false)
    setPeerBoardsForTests([
      {
        node: 'web-2',
        at: Date.now(),
        sockets: 2,
        users: ['bob', 'cy'],
        viewers: { 'record:projects:5': [{ socket: 's-bob', id: 'bob', name: 'Bob' }] },
        pages: [
          {
            socket: 's-cy',
            user: { id: 'cy', name: 'Cy' },
            path: '/journeys',
            since: 10,
            app: 'admin',
            tenant: ''
          }
        ]
      }
    ])
    expect(sock.isUserViewing('projects', '5', 'bob')).toBe(true)
    expect(sock.getRecordViewerSnapshot()).toEqual([
      { collection: 'projects', item: '5', viewers: [{ id: 'bob', name: 'Bob' }] }
    ])
    expect(sock.usersOnPath('/journeys')).toEqual([{ id: 'cy', name: 'Cy', since: 10 }])
    expect(sock.usersOnPathPrefix(['/journeys'])).toEqual(['cy'])
    expect(sock.getLocalConcurrency()).toEqual({ sockets: 2, users: 2 })
    // A peer keeps its own socket list for the console (per process), unlike a SOCKETS=off reader.
    expect(sock.getRealtimeStats().sockets).toEqual([])
  })
})

describe('admin /api/stream hears the other processes (journal)', () => {
  it('turns journaled record changes into stream events, one per record', async () => {
    const { streamEventsOf } = await import('../../../routes/stream.js')
    const one = streamEventsOf({
      seq: 1,
      room: 'collection:projects',
      event: 'collection:update',
      payload: { collection: 'projects', item: 7, action: 'update' }
    })
    expect(one.map(({ type, collection, id }) => ({ type, collection, id }))).toEqual([
      { type: 'update', collection: 'projects', id: '7' }
    ])
    const batch = streamEventsOf({
      seq: 2,
      room: 'collection:readings',
      event: 'collection:update',
      payload: {
        collection: 'readings',
        item: null,
        items: [1, 2],
        action: 'create',
        batched: true
      }
    })
    expect(batch.map((e) => e.id)).toEqual(['1', '2'])
    // A raw bulk write (no action, `*`) and other events: nothing, as on the writing process.
    expect(
      streamEventsOf({
        seq: 3,
        room: 'collection:x',
        event: 'collection:update',
        payload: { collection: 'x', item: '*', bulk: 40 }
      })
    ).toEqual([])
    expect(
      streamEventsOf({ seq: 4, room: 'user:1', event: 'notification:new', payload: {} })
    ).toEqual([])
  })

  it('registering the stream listens to the journal', async () => {
    const { journalListenerCount } = await import('../../../services/journal-listeners.js')
    const before = journalListenerCount()
    const { streamRoutes } = await import('../../../routes/stream.js')
    const Fastify = (await import('fastify')).default
    const app = Fastify()
    await app.register(streamRoutes)
    expect(journalListenerCount()).toBe(before + 1)
    await app.close()
  })
})

describe('third review: Redis trouble, stop, registry hygiene, rows', () => {
  afterEach(() => resetBoard())
  const other = (at = Date.now()) => ({
    node: 'web-2',
    at,
    sockets: 3,
    users: ['bob'],
    viewers: { 'record:projects:5': [{ socket: 's-bob', id: 'bob', name: 'Bob' }] },
    pages: [
      {
        socket: 's-bob',
        user: { id: 'bob', name: 'Bob' },
        path: '/p',
        since: 1,
        app: null,
        tenant: ''
      }
    ]
  })

  it('degrades to this process only when the last good read is too old, or an entry is', async () => {
    const board = await import('../../../services/realtime-board.js')
    const sock = await import('../../../plugins/socketio.js')
    board.setBoardsForTests([other()], [], Date.now())
    expect(sock.usersOnPath('/p')).toHaveLength(1)
    // Last good read 7 s ago (Redis away): nothing from the board — no ghost viewers.
    board.setBoardsForTests([other()], [], Date.now() - 7_000)
    expect(sock.usersOnPath('/p')).toEqual([])
    expect(sock.isUserViewing('projects', '5', 'bob')).toBe(false)
    expect(sock.getRecordViewerSnapshot()).toEqual([])
    expect(sock.getLocalConcurrency().sockets).toBe(0)
    expect(board.roomListeners(null, 'watch:traffic')).toBe(0)
    // A fresh read but an entry its publisher wrote 12 s ago (TTL 10 s): ignored too.
    board.setBoardsForTests([other(Date.now() - 12_000)], [], Date.now())
    expect(sock.usersOnPath('/p')).toEqual([])
  })

  it('a peer that loses Redis drops the old read and re-tells the rooms it named', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      const board = await import('../../../services/realtime-board.js')
      const redis = memRedis()
      redis.kv.set('nvr:rt:board:test:web-2:live', JSON.stringify(other()))
      await redis.zadd('nvr:rt:board:test:nodes', Date.now(), 'web-2')
      const told: string[][] = []
      board.onPeerBoardChange((rooms) => told.push(rooms))
      board.startBoardReader(redis as never, { peers: true })
      await vi.advanceTimersByTimeAsync(10)
      expect(told).toEqual([['record:projects:5']])
      redis.down = true
      await vi.advanceTimersByTimeAsync(8_000)
      expect(board.boardLive()).toEqual([])
      expect(told.at(-1)).toEqual(['record:projects:5'])
      board.onPeerBoardChange(null)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stop during an in-flight tick never starts publishing afterwards', async () => {
    const { startBoard, boardMergeOn } = await import('../../../services/realtime-board.js')
    const redis = memRedis()
    await redis.zadd('nvr:rt:board:test:nodes', Date.now(), 'web-2')
    redis.zaddDelayMs = 30
    const stop = startBoard(redis as never, { serves: true, collect: collector })
    await stop()
    await new Promise((r) => setTimeout(r, 80))
    expect([...redis.kv.keys()]).toEqual([])
    expect(boardMergeOn()).toBe(false)
  })

  it('a lone process trims and expires the registry on its heartbeat', async () => {
    const { startBoard } = await import('../../../services/realtime-board.js')
    const redis = memRedis()
    const stop = startBoard(redis as never, { serves: true, collect: collector })
    await vi.waitFor(() => expect(redis.calls).toContain('pexpire'))
    expect(redis.calls).toContain('zremrangebyscore')
    await stop()
  })

  it('development throwaways on other ports get their own slot', async () => {
    const { startBoard } = await import('../../../services/realtime-board.js')
    const env = { NODE_ENV: process.env.NODE_ENV, PORT: process.env.PORT }
    process.env.NODE_ENV = 'development'
    process.env.PORT = '3099'
    try {
      const redis = memRedis()
      const stop = startBoard(redis as never, { serves: true, collect: collector })
      await vi.waitFor(() =>
        expect([...redis.z.keys()]).toEqual(['nvr:rt:board:development-3099:nodes'])
      )
      await stop()
    } finally {
      process.env.NODE_ENV = env.NODE_ENV
      if (env.PORT === undefined) delete process.env.PORT
      else process.env.PORT = env.PORT
    }
  })

  it('re-tells presence:rows where only list pages watch the row', async () => {
    const { peerChangeTargets } = await import('../../../plugins/socketio.js')
    const { rowsRoomName } = await import('../../../services/presence-rows.js')
    const rows = rowsRoomName('record:projects:5')
    expect(peerChangeTargets(['record:projects:5'], (r) => r === rows)).toEqual([
      { kind: 'record', room: 'record:projects:5' }
    ])
    expect(peerChangeTargets(['record:projects:5', 'ops:ticket:3'], () => false)).toEqual([])
    expect(peerChangeTargets(['ops:ticket:3'], (r) => r === 'ops:ticket:3')).toEqual([
      { kind: 'ops', room: 'ops:ticket:3', topic: 'ticket:3' }
    ])
  })
})
