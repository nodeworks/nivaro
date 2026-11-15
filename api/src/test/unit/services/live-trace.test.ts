import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))
vi.mock('../../../services/collection-live-mode.js', () => ({
  liveModeOf: vi.fn(async () => 'on')
}))
vi.mock('../../../services/event-journal-store.js', () => ({
  DURABLE_RETENTION_HOURS: 24,
  flushDurable: vi.fn(async () => {})
}))
vi.mock('../../../services/realtime-ack-sample.js', () => ({ ackEvery: () => 50 }))
vi.mock('../../../services/realtime-delivery-slo.js', () => ({
  ackedByForSeqs: vi.fn(async () => new Map())
}))

import {
  assembleTrace,
  eventFromRow,
  matchWrites,
  resolveWindow,
  type TraceEvent,
  type TraceWrite,
  validCollectionName
} from '../../../services/live-trace.js'
import { personOf, subscribersOf } from '../../../services/live-trace-source.js'

const T0 = Date.parse('2026-11-14T15:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

function ev(seq: number, s: number, over: Partial<TraceEvent> = {}): TraceEvent {
  return {
    seq,
    at: at(s),
    room: 'collection:workflows',
    event: 'collection:update',
    action: 'update',
    item: '7',
    fields: ['status'],
    source: null,
    bulk: null,
    acked_by: [],
    ...over
  }
}
function wr(s: number, over: Partial<TraceWrite> = {}): TraceWrite {
  return {
    kind: 'activity',
    at: at(s),
    action: 'update',
    item: '7',
    by: 'u1',
    fields: [],
    activity_id: 1,
    announced: false,
    matched_seq: null,
    ...over
  }
}
const base = {
  mode: 'record' as const,
  from: new Date(T0 - 3_600_000),
  to: new Date(T0 + 600_000),
  collection: 'workflows',
  item: '7',
  liveMode: 'on' as const,
  journalAvailable: true,
  journalTruncated: false,
  retentionHours: 24,
  events: [] as TraceEvent[],
  writes: [] as TraceWrite[],
  subscribers: [] as Array<{
    user_id: string | null
    name: string
    sockets: number
    via: Array<'record' | 'collection'>
    apps: string[]
  }>,
  person: null,
  rooms: [],
  ackEvery: 50,
  now: new Date(T0 + 300_000)
}

describe('matchWrites', () => {
  it('pairs a write with the nearest event on the same record inside the window', () => {
    const out = matchWrites([wr(0)], [ev(10, 5), ev(11, 2)])
    expect(out[0].announced).toBe(true)
    expect(out[0].matched_seq).toBe(11)
  })

  it('does not pair across records or beyond the match window', () => {
    expect(matchWrites([wr(0)], [ev(10, 5, { item: '8' })])[0].announced).toBe(false)
    expect(matchWrites([wr(0)], [ev(10, 60)])[0].announced).toBe(false)
  })

  it('a bulk event on the collection covers the write', () => {
    expect(matchWrites([wr(0)], [ev(10, 3, { item: '*', bulk: 400 })])[0].announced).toBe(true)
  })

  it('one event covers a burst of writes', () => {
    const out = matchWrites([wr(0), wr(1), wr(2)], [ev(10, 1)])
    expect(out.every((w) => w.announced)).toBe(true)
  })

  it('a queued raw-write announcement is never counted as announced', () => {
    const out = matchWrites([wr(0, { kind: 'raw-pending', activity_id: null })], [ev(10, 0)])
    expect(out[0].announced).toBe(false)
  })
})

describe('assembleTrace findings', () => {
  it('says so when a write produced no event at all', () => {
    const t = assembleTrace({ ...base, writes: [wr(0)], events: [] })
    expect(t.findings.some((f) => f.includes('no live event for it was sent'))).toBe(true)
    expect(t.writes[0].announced).toBe(false)
  })

  it('separates writes with no matching event from row changes with no activity entry', () => {
    const t = assembleTrace({
      ...base,
      events: [ev(1, 400)],
      writes: [wr(0), wr(30, { kind: 'row-timestamp', activity_id: null })]
    })
    const f = t.findings.join(' ')
    expect(f).toContain('1 saved write with no matching live event')
    expect(f).toContain('did not announce it')
  })

  it('flags a raw-write announcement stuck in the inbox, and one that is only queued', () => {
    const stuck = assembleTrace({
      ...base,
      writes: [wr(-1000, { kind: 'raw-pending', activity_id: null, by: 'procedure:reforecast' })],
      now: new Date(T0)
    })
    expect(stuck.findings.join(' ')).toContain('procedure:reforecast has been waiting')
    const fresh = assembleTrace({
      ...base,
      writes: [wr(-10, { kind: 'raw-pending', activity_id: null })],
      now: new Date(T0)
    })
    expect(fresh.findings.join(' ')).toContain('queued and goes out within seconds')
  })

  it('explains live mode off and batched', () => {
    expect(assembleTrace({ ...base, liveMode: 'off' }).findings.join(' ')).toContain('switched off')
    expect(assembleTrace({ ...base, liveMode: 'batched' }).findings.join(' ')).toContain('batched')
  })

  it('says when nobody is subscribed', () => {
    const t = assembleTrace({ ...base, events: [ev(1, 0)], writes: [wr(0)] })
    expect(t.findings.join(' ')).toContain('Nobody has this record open')
  })

  it('does not call a missing acknowledgement a miss', () => {
    const t = assembleTrace({
      ...base,
      events: [ev(1, 0)],
      writes: [wr(0)],
      subscribers: [{ user_id: 'u2', name: 'Beth', sockets: 1, via: ['record'], apps: ['portal'] }]
    })
    const f = t.findings.join(' ')
    expect(f).toContain('none was acknowledged')
    expect(f).toContain('does not mean it was missed')
  })

  it('names the subscribers who acknowledged nothing while others did', () => {
    const t = assembleTrace({
      ...base,
      events: [ev(1, 0, { acked_by: ['U2'] })],
      writes: [wr(0)],
      subscribers: [
        { user_id: 'u2', name: 'Beth', sockets: 1, via: ['record'], apps: [] },
        { user_id: 'u3', name: 'Carl', sockets: 2, via: ['collection'], apps: [] }
      ]
    })
    expect(t.subscribers.find((s) => s.name === 'Beth')?.acked).toBe(true)
    expect(t.subscribers.find((s) => s.name === 'Carl')?.acked).toBe(false)
    expect(t.findings.join(' ')).toContain('1 of 2 subscribed people did not acknowledge')
    expect(t.findings.join(' ')).toContain('Carl')
  })

  it('a clean window has no findings beyond the empty note', () => {
    const t = assembleTrace({
      ...base,
      events: [ev(1, 1, { acked_by: ['u2'] })],
      writes: [wr(0)],
      subscribers: [{ user_id: 'u2', name: 'Beth', sockets: 1, via: ['record'], apps: [] }]
    })
    expect(t.findings).toEqual([])
    expect(t.ack.acked_events).toBe(1)
  })

  it('reports an unavailable journal instead of calling it a miss', () => {
    const t = assembleTrace({ ...base, journalAvailable: false, writes: [wr(0)] })
    expect(t.findings[0]).toContain('event journal is not available')
    expect(t.findings.join(' ')).not.toContain('no live event for it was sent')
  })

  it('person mode: no connection means nothing is pushed', () => {
    const t = assembleTrace({
      ...base,
      mode: 'person',
      collection: null,
      item: null,
      person: { user_id: 'u9', name: null, sockets: [] }
    })
    expect(t.findings.join(' ')).toContain('no live connection')
  })

  it('carries ids, field names and times only — no value-shaped keys', () => {
    const t = assembleTrace({ ...base, events: [ev(1, 0)], writes: [wr(0)] })
    const json = JSON.stringify(t)
    expect(json).not.toMatch(/"(value|values|data|payload|body)"/)
  })
})

describe('eventFromRow', () => {
  it('reads the journal row: field names, source, bulk and who acknowledged', () => {
    const e = eventFromRow(
      {
        seq: '12',
        at: new Date(T0),
        room: 'collection:workflows',
        event: 'collection:update',
        action: 'update',
        item: '*',
        changed_fields: JSON.stringify(['status', 'amount']),
        extra: JSON.stringify({ source: 'raw', bulk: 40 })
      },
      new Map([[12, ['u1']]])
    )
    expect(e).toMatchObject({
      seq: 12,
      fields: ['status', 'amount'],
      source: 'raw',
      bulk: 40,
      acked_by: ['u1']
    })
  })

  it('survives junk columns', () => {
    const e = eventFromRow(
      { seq: 1, at: new Date(T0), room: 'r', event: 'e', changed_fields: '{nope', extra: 'x' },
      new Map()
    )
    expect(e.source).toBeNull()
    expect(Array.isArray(e.fields)).toBe(true)
  })
})

describe('resolveWindow', () => {
  const now = new Date(T0)
  it('defaults to the last 30 minutes', () => {
    const w = resolveWindow(undefined, undefined, now)
    expect('error' in w).toBe(false)
    if (!('error' in w)) expect(w.to.getTime() - w.from.getTime()).toBe(30 * 60_000)
  })
  it('refuses a backwards, bad or over-long window', () => {
    expect(resolveWindow(at(10), at(0), new Date(T0 + 60_000))).toHaveProperty('error')
    expect(resolveWindow('nope', undefined, now)).toHaveProperty('error')
    expect(
      resolveWindow(new Date(T0 - 25 * 3_600_000).toISOString(), undefined, now)
    ).toHaveProperty('error')
  })
  it('never looks into the future', () => {
    const w = resolveWindow(at(-60), at(5000), now)
    if (!('error' in w)) expect(w.to.getTime()).toBe(T0)
  })
})

describe('validCollectionName', () => {
  it('accepts identifiers only', () => {
    expect(validCollectionName('workflows')).toBe(true)
    expect(validCollectionName('nivaro_users')).toBe(true)
    expect(validCollectionName('a; drop table x')).toBe(false)
    expect(validCollectionName('')).toBe(false)
    expect(validCollectionName(5)).toBe(false)
  })
})

describe('roster helpers', () => {
  const sockets = [
    {
      id: 'aaaaaaaa1111',
      user: { id: 'u2', name: 'Beth' },
      app: 'portal',
      transport: 'websocket',
      connectedAt: T0,
      rooms: ['record:workflows:7', 'collection:workflows', 'user:u2']
    },
    {
      id: 'bbbbbbbb2222',
      user: { id: 'U2', name: 'Beth' },
      app: 'admin',
      transport: 'polling',
      connectedAt: T0,
      rooms: ['collection:workflows']
    },
    {
      id: 'cccccccc3333',
      user: { id: 'u3', name: 'Carl' },
      app: 'portal',
      transport: 'websocket',
      connectedAt: T0,
      rooms: ['collection:invoices']
    }
  ]
  it('groups sockets by person and says how each is listening', () => {
    const subs = subscribersOf(sockets, 'workflows', '7')
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ name: 'Beth', sockets: 2, via: ['record', 'collection'] })
    expect(subs[0].apps.sort()).toEqual(['admin', 'portal'])
  })
  it('reads a cloud tenant-prefixed room as the same room', () => {
    const subs = subscribersOf(
      [{ ...sockets[0], rooms: ['t:acme:record:workflows:7'] }],
      'workflows',
      '7'
    )
    expect(subs[0].via).toEqual(['record'])
  })
  it("a person's trace lists their connections with short ids and capped rooms", () => {
    const p = personOf(sockets, 'u2')
    expect(p.sockets).toHaveLength(2)
    expect(p.sockets[0].id).toHaveLength(8)
    expect(personOf(sockets, 'nobody').sockets).toEqual([])
  })
})
