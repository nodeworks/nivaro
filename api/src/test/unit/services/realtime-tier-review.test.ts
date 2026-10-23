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
      return [...(z.get(k) ?? new Map<string, number>())]
        .filter(([, s]) => s >= min)
        .map(([m]) => m)
    },
    async zremrangebyscore() {
      calls.push('zremrangebyscore')
      return 0
    },
    async pexpire() {
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

describe('realtime board registry (second review)', () => {
  afterEach(() => resetBoard())

  it('finds publishers through the registry (no SCAN) and withdraws on a graceful stop', async () => {
    const redis = memRedis()
    startBoardPublisher(redis as never, () => empty)
    await vi.waitFor(() => expect(redis.kv.size).toBe(2))
    startBoardReader(redis as never)
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
