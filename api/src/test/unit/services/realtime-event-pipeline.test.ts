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
  list: [] as Array<{ scope: string; room: string; event: string }>
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
      emit: (event: string) => {
        emits.list.push({ scope, room, event })
      }
    })
  })
  return { getIo: () => ({ ...op('adapter'), local: op('local') }) }
})

import { journaledEmit, replaySince, setJournalRedis } from '../../../services/event-journal.js'
import { fromDurableRow, toDurableRow } from '../../../services/event-journal-store.js'
import {
  decodeStreamEntry,
  encodeStreamEntry,
  shouldDeliver
} from '../../../services/event-stream.js'
import { planBroadcasts, rowsToAnnouncements } from '../../../services/raw-write-announcer.js'
import { judgeProbe, parseEioFrame } from '../../../services/realtime-probe.js'

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
  emits.list = []
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
