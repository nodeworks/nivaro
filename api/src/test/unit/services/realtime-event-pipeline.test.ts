import { beforeEach, describe, expect, it, vi } from 'vitest'

// The durable table, the stream and the socket server are stand-ins: these
// tests pin the pure contracts and the journal's routing between them.
const store = vi.hoisted(() => ({
  replayFromTable: vi.fn(async () => ({ full: false, events: [] as unknown[] })),
  recordDurable: vi.fn(),
  flushDurable: vi.fn(async () => {}),
  maxDurableSeq: vi.fn(async () => null as number | null)
}))
const stream = vi.hoisted(() => ({
  active: false,
  publishToStream: vi.fn(async () => true)
}))
const emits = vi.hoisted(() => ({
  list: [] as Array<{ scope: string; room: string; event: string }>,
  payloads: [] as unknown[]
}))

vi.mock('../../../services/event-journal-store.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/event-journal-store.js')>()),
  replayFromTable: store.replayFromTable,
  recordDurable: store.recordDurable,
  flushDurable: store.flushDurable,
  maxDurableSeq: store.maxDurableSeq
}))
vi.mock('../../../services/event-stream.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/event-stream.js')>()),
  streamActive: () => stream.active,
  publishToStream: stream.publishToStream
}))
vi.mock('../../../services/io-holder.js', () => {
  const op = (scope: string) => ({
    to: (room: string) => ({
      emit: (event: string, payload?: unknown) => {
        emits.list.push({ scope, room, event })
        emits.payloads.push(payload)
      }
    })
  })
  // Two sockets sit in collection:orders on this process (the stamped-delivery count).
  const rooms = new Map([['collection:orders', new Set(['s1', 's2'])]])
  return {
    getIo: () => ({ ...op('adapter'), local: op('local'), of: () => ({ adapter: { rooms } }) })
  }
})

import { journaledEmit, replaySince, setJournalRedis } from '../../../services/event-journal.js'
import { fromDurableRow, toDurableRow } from '../../../services/event-journal-store.js'
import {
  decodeStreamEntry,
  encodeStreamEntry,
  shouldDeliver
} from '../../../services/event-stream.js'
import { planBroadcasts, rowsToAnnouncements } from '../../../services/raw-write-announcer.js'
import { _resetStampFloorForTests, shouldStamp } from '../../../services/realtime-ack-sample.js'
import { judgeProbe, parseEioFrame, runRealtimeProbe } from '../../../services/realtime-probe.js'

/** A Redis double holding one sorted-set journal. */
function fakeRedis(journal: Array<{ seq: number; entry: unknown }>, seq: number) {
  return {
    incr: vi.fn(async () => seq + 1),
    multi: () => {
      // #2462 — the sequence and the room counter come from one transaction.
      const results: Array<[null, number]> = []
      const m = {
        incr: () => {
          results.push([null, results.length === 0 ? seq + 1 : 1])
          return m
        },
        zadd: () => m,
        zremrangebyrank: () => m,
        expire: () => m,
        exec: async () => results
      }
      return m
    },
    zrange: vi.fn(async () =>
      journal.length ? [JSON.stringify(journal[0].entry), String(journal[0].seq)] : []
    ),
    zrangebyscore: vi.fn(async (_k: string, min: string) => {
      const after = Number(String(min).replace('(', ''))
      return journal.filter((j) => j.seq > after).map((j) => JSON.stringify(j.entry))
    }),
    get: vi.fn(async () => String(seq))
  }
}

beforeEach(() => {
  // The time floor stamps the first event a process sends; the routing tests pin 1 in N only.
  process.env.REALTIME_ACK_FLOOR_S = '0'
  _resetStampFloorForTests()
  emits.list = []
  emits.payloads = []
  stream.active = false
  store.replayFromTable.mockClear()
  store.recordDurable.mockClear()
  stream.publishToStream.mockClear()
})

describe('durable journal rows (#1673)', () => {
  it('keeps field names and small flags, never values', () => {
    const row = toDurableRow({
      seq: 42,
      room: 'collection:orders',
      event: 'collection:update',
      payload: {
        collection: 'orders',
        item: 7,
        action: 'update',
        changed_fields: ['status', 'total'],
        source: 'raw',
        bulk: 3,
        data: { secret: 'x' },
        _seq: 42
      }
    })
    expect(row).toMatchObject({
      seq: 42,
      collection: 'orders',
      item: '7',
      action: 'update',
      changed_fields: '["status","total"]'
    })
    expect(JSON.parse(String(row.extra))).toEqual({ source: 'raw', bulk: 3 })
  })

  it('round-trips into the journal entry the client replays', () => {
    const entry = fromDurableRow({
      seq: '9',
      room: 'collection:orders',
      event: 'collection:update',
      collection: 'orders',
      item: '7',
      action: 'update',
      changed_fields: '["status"]',
      extra: '{"source":"raw"}'
    })
    expect(entry).toEqual({
      seq: 9,
      room: 'collection:orders',
      event: 'collection:update',
      payload: {
        collection: 'orders',
        item: '7',
        action: 'update',
        changed_fields: ['status'],
        source: 'raw'
      }
    })
  })
})

describe('replaySince', () => {
  const ev = (seq: number, room = 'collection:orders') => ({
    seq,
    entry: { seq, room, event: 'collection:update', payload: { collection: 'orders', item: seq } }
  })

  it('answers from Redis inside its window', async () => {
    setJournalRedis(fakeRedis([ev(10), ev(11), ev(12)], 12) as never)
    const r = await replaySince(10, new Set(['collection:orders']))
    expect(r.full).toBe(false)
    expect(r.events.map((e) => e.seq)).toEqual([11, 12])
    expect(store.replayFromTable).not.toHaveBeenCalled()
  })

  it('falls back to the durable table when the cursor is older than Redis keeps', async () => {
    setJournalRedis(fakeRedis([ev(500)], 500) as never)
    store.replayFromTable.mockResolvedValueOnce({ full: false, events: [{ seq: 3 }] })
    const r = await replaySince(2, new Set(['collection:orders']))
    expect(store.replayFromTable).toHaveBeenCalledWith(2, new Set(['collection:orders']), 500)
    expect(r).toEqual({ full: false, events: [{ seq: 3 }] })
  })

  it('treats an expired Redis journal with newer sequences as a gap, not "nothing happened"', async () => {
    setJournalRedis(fakeRedis([], 80) as never)
    await replaySince(40, new Set(['collection:orders']))
    expect(store.replayFromTable).toHaveBeenCalledTimes(1)
  })

  it('an up-to-date cursor with an expired journal is simply caught up', async () => {
    setJournalRedis(fakeRedis([], 80) as never)
    const r = await replaySince(80, new Set(['collection:orders']))
    expect(r).toEqual({ full: false, events: [] })
    expect(store.replayFromTable).not.toHaveBeenCalled()
  })
})

describe('journaledEmit routing (#1737)', () => {
  it('stream on: local emit + stream append, no adapter publish', async () => {
    setJournalRedis(fakeRedis([], 0) as never)
    stream.active = true
    const r = await journaledEmit('collection:orders', 'collection:update', { item: 1 })
    expect(r).toEqual({ seq: 1, path: 'stream', room: 'collection:orders' })
    expect(emits.list).toEqual([
      { scope: 'local', room: 'collection:orders', event: 'collection:update' }
    ])
    expect(store.recordDurable).toHaveBeenCalledTimes(1)
  })

  it('a failed stream append falls back to the adapter', async () => {
    setJournalRedis(fakeRedis([], 0) as never)
    stream.active = true
    stream.publishToStream.mockResolvedValueOnce(false)
    const r = await journaledEmit('collection:orders', 'collection:update', { item: 1 })
    expect(r.path).toBe('adapter')
    expect(emits.list).toEqual([
      { scope: 'adapter', room: 'collection:orders', event: 'collection:update' }
    ])
  })

  it('the probe leaves its local delivery to the stream reader', async () => {
    setJournalRedis(fakeRedis([], 0) as never)
    stream.active = true
    await journaledEmit('probe:x', 'realtime:probe', { probe: 'x' }, { selfViaStream: true })
    expect(stream.publishToStream).toHaveBeenCalledWith(expect.anything(), { self: true })
    expect(emits.list).toEqual([])
  })
})

describe('delivery acknowledgement stamps (#2477)', () => {
  it('a sampled event keeps its stamp server-side and sends the same one over the stream', async () => {
    const sets: unknown[][] = []
    const redis = {
      multi: () => {
        // #2462 — the counters come from their own MULTI (global seq, the room's own counter).
        let counted = false
        const m = {
          incr: () => {
            counted = true
            return m
          },
          zadd: () => m,
          zremrangebyrank: () => m,
          expire: () => m,
          set: (...a: unknown[]) => {
            sets.push(a)
            return m
          },
          exec: async () =>
            counted
              ? [
                  [null, 50],
                  [null, 7],
                  [null, 1]
                ]
              : []
        }
        return m
      }
    }
    setJournalRedis(redis as never)
    stream.active = true
    stream.publishToStream.mockClear()
    await journaledEmit('collection:orders', 'collection:update', { item: 1 })
    expect(sets).toHaveLength(1)
    expect(sets[0][0]).toBe('nvr:rt:ack:st:50')
    const st = Number(sets[0][1])
    expect(st).toBeGreaterThan(0)
    expect(stream.publishToStream).toHaveBeenCalledWith(expect.anything(), {
      self: undefined,
      at: st,
      stamped: true
    })
  })

  it('an unsampled event keeps nothing', async () => {
    const sets: unknown[] = []
    setJournalRedis({
      multi: () => {
        // #2462 — the counters come from their own MULTI (global seq, the room's own counter).
        let counted = false
        const m = {
          incr: () => {
            counted = true
            return m
          },
          zadd: () => m,
          zremrangebyrank: () => m,
          expire: () => m,
          set: (...a: unknown[]) => {
            sets.push(a)
            return m
          },
          exec: async () =>
            counted
              ? [
                  [null, 51],
                  [null, 8],
                  [null, 1]
                ]
              : []
        }
        return m
      }
    } as never)
    await journaledEmit('collection:orders', 'collection:update', { item: 1 })
    expect(sets).toHaveLength(0)
  })
})

describe('delivery stamps: time floor and socket deliveries (staging demo 2026-10-26)', () => {
  /** A journal Redis whose global sequence is `seq`; records SETs and HINCRBYs. */
  function stampRedis(seq: number) {
    const sets: unknown[][] = []
    const incrs: Array<[string, string, number]> = []
    const redis = {
      multi: () => {
        let counted = false
        const m = {
          incr: () => {
            counted = true
            return m
          },
          zadd: () => m,
          zremrangebyrank: () => m,
          expire: () => m,
          set: (...a: unknown[]) => {
            sets.push(a)
            return m
          },
          hincrby: (k: string, f: string, n: number) => {
            incrs.push([k, f, n])
            return m
          },
          exec: async () =>
            counted
              ? [
                  [null, seq],
                  [null, 3],
                  [null, 1]
                ]
              : []
        }
        return m
      }
    }
    return { redis, sets, incrs }
  }

  it('stamps an off-grid event once the floor has passed, then waits out the floor', () => {
    const env = { REALTIME_ACK_FLOOR_S: '30' }
    expect(shouldStamp(51, { now: 100_000, env })).toBe(true)
    expect(shouldStamp(52, { now: 110_000, env })).toBe(false)
    // 1 in N still stamps inside the floor.
    expect(shouldStamp(100, { now: 111_000, env })).toBe(true)
    expect(shouldStamp(101, { now: 140_000, env })).toBe(false)
    expect(shouldStamp(102, { now: 141_000, env })).toBe(true)
    // Synthetic emits never take the floor; REALTIME_ACK_EVERY=0 turns stamping off.
    _resetStampFloorForTests()
    expect(shouldStamp(53, { now: 500_000, env, floor: false })).toBe(false)
    expect(shouldStamp(53, { now: 500_000, env: { ...env, REALTIME_ACK_EVERY: '0' } })).toBe(false)
    expect(shouldStamp(53, { now: 500_000, env: { REALTIME_ACK_FLOOR_S: '0' } })).toBe(false)
  })

  it('a quiet process stamps its next record event and counts the sockets it reached', async () => {
    process.env.REALTIME_ACK_FLOOR_S = '30'
    const { redis, sets, incrs } = stampRedis(51)
    setJournalRedis(redis as never)
    stream.active = true
    await journaledEmit('collection:orders', 'collection:update', { item: 1 })
    expect(sets.map((a) => a[0])).toEqual(['nvr:rt:ack:st:51'])
    const st = Number(sets[0][1])
    expect(emits.payloads[0]).toMatchObject({ item: 1, _seq: 51, _st: st })
    expect(stream.publishToStream).toHaveBeenCalledWith(expect.anything(), {
      self: undefined,
      at: st,
      stamped: true
    })
    await new Promise((r) => setImmediate(r))
    // One stamped event, two sockets in the room on this process.
    expect(incrs.map(([, f, n]) => [f.split('|')[0], n])).toEqual([
      ['e', 1],
      ['s', 2]
    ])
  })

  it('the probe never takes the floor, so its synthetic socket is never counted', async () => {
    process.env.REALTIME_ACK_FLOOR_S = '30'
    const { redis, sets, incrs } = stampRedis(51)
    setJournalRedis(redis as never)
    stream.active = true
    await journaledEmit('probe:x', 'realtime:probe', { probe: 'x' }, { selfViaStream: true })
    expect(sets).toEqual([])
    expect(incrs).toEqual([])
  })
})

describe('stream entries', () => {
  const entry = {
    seq: 5,
    room: 'collection:orders',
    event: 'collection:update',
    payload: { item: 1 }
  }

  it('round-trips through XADD fields', () => {
    const d = decodeStreamEntry(encodeStreamEntry(entry, { node: 'n1', at: 1000 }))
    expect(d).toEqual({ node: 'n1', self: false, at: 1000, entry })
  })

  it('carries the writer stamp flag, and reads entries from writers without it', () => {
    const d = decodeStreamEntry(encodeStreamEntry(entry, { node: 'n1', at: 1000, stamped: true }))
    expect(d).toEqual({ node: 'n1', self: false, at: 1000, entry, stamped: true })
    expect(encodeStreamEntry(entry, { node: 'n1', at: 1000 })).not.toContain('k')
  })

  it('rejects malformed entries', () => {
    expect(decodeStreamEntry(['n', 'n1', 'e', 'not json'])).toBeNull()
    expect(decodeStreamEntry(['n', 'n1', 'e', '{"room":1}'])).toBeNull()
    expect(decodeStreamEntry(['n', 'n1'])).toBeNull()
  })

  it('a replica skips its own entries unless asked to deliver them', () => {
    const own = decodeStreamEntry(encodeStreamEntry(entry, { node: 'me' }))!
    const self = decodeStreamEntry(encodeStreamEntry(entry, { node: 'me', self: true }))!
    const other = decodeStreamEntry(encodeStreamEntry(entry, { node: 'them' }))!
    expect(shouldDeliver(own, 'me')).toBe(false)
    expect(shouldDeliver(self, 'me')).toBe(true)
    expect(shouldDeliver(other, 'me')).toBe(true)
  })
})

describe('raw write announcements (#1875)', () => {
  it('coalesces per collection and action, uniting ids and field names', () => {
    const out = planBroadcasts([
      { collection: 'orders', ids: [1, 2], action: 'update', changed_fields: ['status'] },
      { collection: 'orders', ids: [2, 3], action: 'update', changed_fields: ['total'] },
      { collection: 'orders', ids: [9], action: 'delete' }
    ])
    expect(out).toEqual([
      { collection: 'orders', action: 'update', changed_fields: ['status', 'total'], item: '1' },
      { collection: 'orders', action: 'update', changed_fields: ['status', 'total'], item: '2' },
      { collection: 'orders', action: 'update', changed_fields: ['status', 'total'], item: '3' },
      { collection: 'orders', action: 'delete', item: '9' }
    ])
  })

  it('folds a large batch, or one with no ids, into a single collection-wide event', () => {
    const ids = Array.from({ length: 5 }, (_, i) => i + 1)
    expect(planBroadcasts([{ collection: 'orders', ids, action: 'update' }], 3)).toEqual([
      { collection: 'orders', action: 'update', item: '*', bulk: 5 }
    ])
    expect(planBroadcasts([{ collection: 'orders', ids: null }])).toEqual([
      { collection: 'orders', item: '*' }
    ])
  })

  it('drops bad collection and field names', () => {
    expect(planBroadcasts([{ collection: 'orders; drop', ids: [1] }])).toEqual([])
    expect(
      planBroadcasts([{ collection: 'orders', ids: [1], changed_fields: ['ok', 'no way', ''] }])
    ).toEqual([{ collection: 'orders', item: '1', changed_fields: ['ok'] }])
  })

  it('reads inbox rows written by procedures (comma field lists, null item)', () => {
    const list = rowsToAnnouncements([
      { collection: 'forecasts', item: '12', action: 'update', changed_fields: 'status, amount' },
      { collection: 'forecasts', item: null, action: 'bogus', changed_fields: null, source: 'p' }
    ])
    expect(list).toEqual([
      {
        collection: 'forecasts',
        ids: ['12'],
        action: 'update',
        changed_fields: ['status', 'amount'],
        source: undefined
      },
      { collection: 'forecasts', ids: null, action: undefined, changed_fields: [], source: 'p' }
    ])
  })
})

describe('delivery probe (#1682)', () => {
  it('parses engine.io frames', () => {
    expect(parseEioFrame('0{"sid":"a"}')).toEqual({ kind: 'open' })
    expect(parseEioFrame('2')).toEqual({ kind: 'ping' })
    expect(parseEioFrame('40{"sid":"abc"}')).toEqual({ kind: 'connected', sid: 'abc' })
    expect(parseEioFrame('42["realtime:probe",{"probe":"p"}]')).toEqual({
      kind: 'event',
      name: 'realtime:probe',
      data: { probe: 'p' }
    })
    expect(parseEioFrame('42garbage')).toEqual({ kind: 'other' })
  })

  it('skips on a SOCKETS=off process rather than record a delivery that could never arrive', async () => {
    const saved = { sockets: process.env.SOCKETS, role: process.env.NIVARO_ROLE }
    process.env.SOCKETS = 'off'
    process.env.NIVARO_ROLE = 'worker'
    try {
      const app = { server: { address: () => ({ port: 3055 }) } }
      const r = await runRealtimeProbe(app as never)
      expect(r).toMatchObject({ skipped: true, arrived: false, path: 'none' })
      expect(r.detail).toMatch(/SOCKETS=off/)
    } finally {
      if (saved.sockets === undefined) delete process.env.SOCKETS
      else process.env.SOCKETS = saved.sockets
      if (saved.role === undefined) delete process.env.NIVARO_ROLE
      else process.env.NIVARO_ROLE = saved.role
    }
  })

  it('judges missing, slow, unjournaled and good deliveries', () => {
    expect(judgeProbe(false, null, 2000, false).ok).toBe(false)
    expect(judgeProbe(true, 2500, 2000, true)).toEqual({
      ok: false,
      detail: 'Delivery took 2500ms (threshold 2000ms)'
    })
    expect(judgeProbe(true, 40, 2000, false).ok).toBe(false)
    expect(judgeProbe(true, 40, 2000, true)).toEqual({ ok: true, detail: 'Delivered in 40ms' })
  })
})
