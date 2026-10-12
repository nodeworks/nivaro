import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COALESCE_WINDOW_MS,
  collectionUpdateOf,
  createCoalescer,
  encodeEvent,
  eventNameOf,
  mergeUpdates,
  noteCoalesced,
  noteTenantSocket,
  recordOutbound,
  resetTenantRealtime,
  resetTransportStats,
  roomKind,
  scopeRealtimeStats,
  tenantRealtimeRanking,
  transportStats
} from '../../../services/socket-transport.js'

describe('roomKind (#1730) folds ids away so the table stays small', () => {
  it('groups record rooms per collection and private rooms per kind', () => {
    expect(roomKind('record:workflows:42')).toBe('record:workflows:*')
    expect(roomKind('user:ABC')).toBe('user:*')
    expect(roomKind('session:s1')).toBe('session:*')
    expect(roomKind('chat:dm:a:b')).toBe('chat:dm:*')
    expect(roomKind('chat:global')).toBe('chat:global')
    expect(roomKind('chat:channel:7')).toBe('chat:channel:*')
    expect(roomKind('collection:workflows')).toBe('collection:workflows')
    expect(roomKind(null)).toBe('direct')
  })
})

describe('packet helpers', () => {
  it('reads the event name of plain and acked event packets', () => {
    expect(eventNameOf(encodeEvent('collection:update', { a: 1 }))).toBe('collection:update')
    expect(eventNameOf('212["time:sync",{}]')).toBe('time:sync')
    expect(eventNameOf('3[]')).toBeNull()
    expect(eventNameOf('2/admin,["x"]')).toBeNull()
  })
  it('extracts a collection:update payload and nothing else', () => {
    const p = { collection: 'orders', item: 5, action: 'update' }
    expect(collectionUpdateOf(encodeEvent('collection:update', p))).toEqual(p)
    expect(collectionUpdateOf(encodeEvent('chat:message', p))).toBeNull()
    expect(collectionUpdateOf('2["collection:update",{bad')).toBeNull()
  })
})

describe('byte accounting (#1730) is kept per tenant scope', () => {
  beforeEach(() => {
    resetTransportStats()
    resetTransportStats('t1')
    resetTransportStats('t2')
  })

  it('counts bytes per event type and room kind, heaviest first', () => {
    recordOutbound('collection:update', 'collection:orders', 100, null)
    recordOutbound('collection:update', 'collection:orders', 100, null)
    recordOutbound('chat:message', 'chat:dm:a:b', 500, null)
    noteCoalesced(5)
    const s = transportStats()
    expect(s.events).toBe(3)
    expect(s.bytes).toBe(700)
    expect(s.by_event[0]).toEqual({ event: 'chat:message', count: 1, bytes: 500 })
    expect(s.by_room.map((r) => r.room)).toEqual(['chat:dm:*', 'collection:orders'])
    expect(s.coalesced).toEqual({ bursts: 1, messages_saved: 4 })
  })

  it("never shows one tenant another tenant's rooms", () => {
    recordOutbound('collection:update', 'collection:secret_a', 10, 't1')
    recordOutbound('collection:update', 'collection:secret_b', 10, 't2')
    expect(transportStats(15, 't1').by_room.map((r) => r.room)).toEqual(['collection:secret_a'])
    expect(transportStats(15, 't2').by_room.map((r) => r.room)).toEqual(['collection:secret_b'])
    expect(transportStats().events).toBe(0)
  })
})

describe('tenant ranking (#1732)', () => {
  beforeEach(() => resetTenantRealtime())

  it('puts the noisiest tenant of the last minute first', () => {
    noteTenantSocket('quiet', 1, 'quiet-co')
    noteTenantSocket('loud', 1)
    noteTenantSocket('loud', 1)
    recordOutbound('collection:update', 'collection:x', 50, 'quiet')
    for (let i = 0; i < 10; i++) recordOutbound('collection:update', 'collection:x', 900, 'loud')
    const rows = tenantRealtimeRanking()
    expect(rows.map((r) => r.tenant)).toEqual(['loud', 'quiet'])
    expect(rows[0]).toMatchObject({ sockets: 2, events: 10, bytes: 9000, events_last_minute: 10 })
    expect(rows[1].label).toBe('quiet-co')
  })

  it('never counts sockets below zero', () => {
    noteTenantSocket('t', -1)
    expect(tenantRealtimeRanking()[0].sockets).toBe(0)
  })
})

describe('mergeUpdates (#1681)', () => {
  it('lists distinct ids, keeps one action, unions fields and the highest seq', () => {
    const m = mergeUpdates('orders', [
      { collection: 'orders', item: 1, action: 'update', changed_fields: ['a'], _seq: 4 },
      { collection: 'orders', item: 2, action: 'update', changed_fields: ['b'], _seq: 9 },
      { collection: 'orders', item: 1, action: 'update', changed_fields: ['a'], _seq: 6 }
    ])
    expect(m).toEqual({
      collection: 'orders',
      item: null,
      items: [1, 2],
      many: false,
      count: 2,
      coalesced: true,
      action: 'update',
      changed_fields: ['a', 'b'],
      _seq: 9
    })
  })
  it('says "many" past the cap and leaves the field list open when one event had none', () => {
    const list = Array.from({ length: 5 }, (_, i) => ({
      collection: 'o',
      item: i,
      action: 'create'
    }))
    list.push({ collection: 'o', item: 99, action: 'delete' })
    const m = mergeUpdates('o', list, 3)
    expect(m.many).toBe(true)
    expect(m.items).toBeNull()
    expect(m.count).toBe(6)
    expect(m.action).toBeUndefined()
    expect(m.changed_fields).toBeUndefined()
  })
})

describe('createCoalescer (#1681)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends the first event at once and a burst as one message per window', () => {
    const sent: Array<Record<string, unknown>> = []
    const collapsed: number[] = []
    const c = createCoalescer({ send: (p) => sent.push(p), onCollapse: (n) => collapsed.push(n) })
    for (let i = 0; i < 1000; i++) c.push({ collection: 'orders', item: i, action: 'create' })
    expect(sent).toHaveLength(1)
    expect(sent[0].item).toBe(0)
    vi.advanceTimersByTime(COALESCE_WINDOW_MS)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ coalesced: true, many: true, count: 999 })
    expect(collapsed).toEqual([999])
    // The window closed empty: the next lone event goes straight out.
    vi.advanceTimersByTime(COALESCE_WINDOW_MS)
    c.push({ collection: 'orders', item: 'x' })
    expect(sent).toHaveLength(3)
    expect(sent[2].item).toBe('x')
  })

  it('keeps collections apart and sends a single held event as it was', () => {
    const sent: Array<Record<string, unknown>> = []
    const c = createCoalescer({ send: (p) => sent.push(p) })
    c.push({ collection: 'a', item: 1 })
    c.push({ collection: 'b', item: 1 })
    c.push({ collection: 'a', item: 2 })
    vi.advanceTimersByTime(COALESCE_WINDOW_MS)
    expect(sent).toEqual([
      { collection: 'a', item: 1 },
      { collection: 'b', item: 1 },
      { collection: 'a', item: 2 }
    ])
  })

  it('drops what is held once disposed', () => {
    const sent: unknown[] = []
    const c = createCoalescer({ send: (p) => sent.push(p) })
    c.push({ collection: 'a', item: 1 })
    c.push({ collection: 'a', item: 2 })
    c.dispose()
    vi.advanceTimersByTime(COALESCE_WINDOW_MS * 2)
    c.push({ collection: 'a', item: 3 })
    expect(sent).toHaveLength(1)
  })
})

describe('scopeRealtimeStats (H2)', () => {
  const stats = {
    sockets: [
      { id: 'a1', tenant: 'A', rooms: ['user:ANA', 'session:sidA', 't:A:record:orders:7'] },
      { id: 'b1', tenant: 'B', rooms: ['user:BOB', 'masq:abc', 't:B:record:orders:7'] }
    ],
    rooms: [
      { room: 't:A:record:orders:7', size: 1 },
      { room: 't:B:record:orders:7', size: 1 },
      { room: 'session:sidA', size: 1 }
    ]
  }

  it("shows a tenant only its own sockets and rooms, without another tenant's names", () => {
    const a = scopeRealtimeStats(stats, 'A')
    expect(a.sockets.map((s) => s.id)).toEqual(['a1'])
    expect(a.sockets[0].rooms).toEqual(['user:ANA', 'record:orders:7'])
    expect(a.rooms.map((r) => r.room).sort()).toEqual(['record:orders:7', 'user:ANA'])
    expect(JSON.stringify(a)).not.toContain('BOB')
  })

  it('never lists sign-in rooms, self-hosted included', () => {
    const all = scopeRealtimeStats(stats, null)
    expect(all.sockets).toHaveLength(2)
    const names = JSON.stringify(all)
    expect(names).not.toContain('session:')
    expect(names).not.toContain('masq:')
  })
})
