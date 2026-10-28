import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The one-step journaled emit (review 2026-10-27): sequence numbers, journal entry, ack stamp
 * and stream append in ONE Lua script. The fake-Redis half checks what is sent and the
 * fallbacks; the real-Redis half (REALTIME_REDIS_IT=1, REALTIME_REDIS_IT_URL — a throwaway
 * Redis, never db 0 of a shared one) runs the script itself.
 */

const emits: Array<{ scope: string; room: string; event: string; payload: unknown }> = []
const stream = { active: true }

vi.mock('../../../services/io-holder.js', () => {
  const op = (scope: string) => ({
    to: (room: string) => ({
      emit: (event: string, payload?: unknown) => emits.push({ scope, room, event, payload })
    })
  })
  return { getIo: () => ({ ...op('all'), local: op('local'), of: () => ({ adapter: {} }) }) }
})
vi.mock('../../../services/event-journal-store.js', () => ({
  recordDurable: vi.fn(),
  flushDurable: vi.fn(async () => {}),
  maxDurableSeq: vi.fn(async () => null),
  replayFromTable: vi.fn(async () => ({ full: true, events: [] }))
}))
vi.mock('../../../services/event-stream.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/event-stream.js')>()),
  streamActive: () => stream.active,
  publishToStream: vi.fn(async () => true),
  streamNodeId: () => 'node-test'
}))

import {
  _resetEmitScriptForTests,
  EMIT_SCRIPT,
  journaledEmit,
  replayReadStats,
  replaySince,
  setJournalRedis
} from '../../../services/event-journal.js'
import { _resetStampFloorForTests } from '../../../services/realtime-ack-sample.js'

const saved = { ...process.env }
beforeEach(() => {
  emits.length = 0
  stream.active = true
  _resetEmitScriptForTests()
  _resetStampFloorForTests()
  process.env.REALTIME_ACK_FLOOR_S = '0'
  process.env.REALTIME_ACK_EVERY = '50'
})
afterEach(() => {
  process.env = { ...saved }
})

describe('one-step emit (fake Redis)', () => {
  it('sends one script call with the keys and args the script reads, and emits locally', async () => {
    const calls: unknown[][] = []
    const redis = {
      evalsha: vi.fn(async () => {
        throw new Error('NOSCRIPT No matching script')
      }),
      eval: vi.fn(async (...args: unknown[]) => {
        calls.push(args)
        return [100, 7, 1, 1]
      }),
      multi: vi.fn()
    }
    setJournalRedis(redis as never)
    const r = await journaledEmit('collection:orders', 'collection:update', { item: 1 })
    expect(r).toMatchObject({ seq: 100, path: 'stream' })
    expect(redis.multi).not.toHaveBeenCalled()
    const [script, nKeys, ...rest] = calls[0] as [string, number, ...string[]]
    expect(script).toBe(EMIT_SCRIPT)
    expect(nKeys).toBe(4)
    expect(rest.slice(0, 4)).toEqual([
      'nvr:ev:seq',
      'nvr:ev:rseq:collection:orders',
      'nvr:ev:journal',
      'nvr:ev:stream'
    ])
    const args = rest.slice(4)
    expect(args[0]).toBe('collection:orders')
    expect(JSON.parse(args[2])).toEqual({ item: 1 })
    expect(args[3]).toBe('5000') // journal max
    expect(args[9]).toBe('1') // stream on
    expect(args[11]).toBe('node-test')
    expect(args[13]).toBe('nvr:rt:ack:st:')
    // Stream path: this process emits to its own sockets only, with the sequence and stamp.
    expect(emits).toHaveLength(1)
    expect(emits[0]).toMatchObject({ scope: 'local', room: 'collection:orders' })
    expect(emits[0].payload).toMatchObject({ _seq: 100, _rseq: 7 })
    expect(typeof (emits[0].payload as { _st?: unknown })._st).toBe('number')
  })

  it('a refused XADD inside the script goes out on the adapter, still journaled', async () => {
    setJournalRedis({ evalsha: async () => [5, 1, 0, 0], eval: async () => null } as never)
    const r = await journaledEmit('collection:orders', 'collection:update', { item: 2 })
    expect(r).toMatchObject({ seq: 5, path: 'adapter' })
    expect(emits[0]).toMatchObject({ scope: 'all' })
  })

  it('falls back to the plain steps when the script answers nothing usable', async () => {
    const m: Record<string, unknown> = {}
    let n = 0
    for (const k of ['incr', 'expire', 'zadd', 'zremrangebyrank', 'set']) m[k] = () => m
    // An odd exec answers the counters, an even one the journal write.
    m.exec = async () =>
      ++n % 2 === 1
        ? [
            [null, 9 + n],
            [null, 1]
          ]
        : []
    setJournalRedis({ evalsha: async () => 'OK', eval: async () => 'OK', multi: () => m } as never)
    stream.active = false
    const r = await journaledEmit('collection:orders', 'collection:update', { item: 3 })
    expect(r.seq).toBe(10)
  })

  it('REALTIME_ATOMIC_EMIT=off keeps the plain steps', async () => {
    process.env.REALTIME_ATOMIC_EMIT = 'off'
    const evalsha = vi.fn()
    const m: Record<string, unknown> = {}
    for (const k of ['incr', 'expire', 'zadd', 'zremrangebyrank', 'set']) m[k] = () => m
    let n = 0
    m.exec = async () =>
      ++n % 2 === 1
        ? [
            [null, 41],
            [null, 2]
          ]
        : []
    setJournalRedis({ evalsha, eval: evalsha, multi: () => m } as never)
    stream.active = false
    const r = await journaledEmit('collection:orders', 'collection:update', { item: 4 })
    expect(r.seq).toBe(41)
    expect(evalsha).not.toHaveBeenCalled()
  })
})

describe('shared catch-up reads', () => {
  it('catch-ups in one cursor bucket share one journal read, each with its own rooms', async () => {
    const entry = (seq: number, room: string) =>
      JSON.stringify({ seq, room, event: 'collection:update', payload: { item: seq } })
    const zrangebyscore = vi.fn(async () => [
      entry(11, 'collection:a'),
      entry(12, 'collection:b'),
      entry(13, 'collection:a')
    ])
    setJournalRedis({
      zrange: async () => ['x', '10'],
      get: async () => '13',
      zrangebyscore
    } as never)
    const before = replayReadStats()
    const [one, two] = await Promise.all([
      replaySince(10, new Set(['collection:a'])),
      replaySince(11, new Set(['collection:a', 'collection:b']))
    ])
    expect(zrangebyscore).toHaveBeenCalledTimes(1)
    expect(replayReadStats().reads - before.reads).toBe(1)
    expect(one.events.map((e) => e.seq)).toEqual([11, 13])
    expect(two.events.map((e) => e.seq)).toEqual([12, 13])
  })
})

const IT = process.env.REALTIME_REDIS_IT === '1'
describe.skipIf(!IT)('one-step emit (real Redis)', async () => {
  const { Redis } = await import('ioredis')
  const redis = new Redis(process.env.REALTIME_REDIS_IT_URL ?? 'redis://127.0.0.1:6379/9')
  afterAll(async () => {
    await redis.flushdb()
    await redis.quit()
  })

  it('journals, stamps and appends to the stream in sequence order', async () => {
    await redis.flushdb()
    setJournalRedis(redis as never)
    process.env.REALTIME_ACK_EVERY = '2'
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        journaledEmit('collection:o/r"d', 'collection:update', { item: i, s: 'ü/"' })
      )
    )
    expect(results.every((r) => r.path === 'stream')).toBe(true)
    const seqs = results.map((r) => r.seq as number).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    // Stream order is sequence order, and every stream entry is the journal entry.
    const entries = (await redis.xrange('nvr:ev:stream', '-', '+')) as Array<[string, string[]]>
    const streamSeqs = entries.map(([, f]) => JSON.parse(f[f.indexOf('e') + 1]).seq)
    expect(streamSeqs).toEqual(seqs)
    const journal = await redis.zrange('nvr:ev:journal', 0, -1)
    const parsed = journal.map((j) => JSON.parse(j))
    expect(parsed[0]).toEqual({
      seq: 1,
      room: 'collection:o/r"d',
      event: 'collection:update',
      payload: expect.objectContaining({ s: 'ü/"' }),
      rseq: 1
    })
    // 1 in 2 by sequence carries a stamp key and the stream's `k` flag.
    expect(await redis.get('nvr:rt:ack:st:2')).not.toBeNull()
    expect(await redis.get('nvr:rt:ack:st:3')).toBeNull()
    const second = entries.find(([, f]) => JSON.parse(f[f.indexOf('e') + 1]).seq === 2)?.[1]
    expect(second).toContain('k')
    expect(await redis.ttl('nvr:ev:rseq:collection:o/r"d')).toBeGreaterThan(0)
    const replay = await replaySince(15, new Set(['collection:o/r"d']))
    expect(replay.events.map((e) => e.seq)).toEqual([16, 17, 18, 19, 20])
  })

  it('trims the journal to REALTIME_JOURNAL_MAX', async () => {
    await redis.flushdb()
    setJournalRedis(redis as never)
    process.env.REALTIME_JOURNAL_MAX = '1000'
    for (let i = 0; i < 1005; i++) await journaledEmit('collection:t', 'collection:update', { i })
    expect(await redis.zcard('nvr:ev:journal')).toBe(1000)
  })
})
