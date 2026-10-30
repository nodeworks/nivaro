import { afterEach, describe, expect, it } from 'vitest'
import { acquireReadSlot, resetReadGate } from './read-gate.js'
import { beginTrace, clearTrace } from './request-trace.js'
import {
  inflightEnd,
  inflightNoteWait,
  inflightStart,
  inflightWaitFor,
  resetInflight
} from './traffic-inflight.js'
import { listCollectionOf, matchPeerSnapshot, pickWait, waitPath } from './wait-reasons.js'

afterEach(() => {
  resetInflight()
  clearTrace()
  resetReadGate()
})

function fakeReq(url: string, userId = 'u1', method = 'GET') {
  return { method, url, raw: { url }, user: { id: userId } } as never
}

describe('waitPath', () => {
  it('normalises client urls to the in-flight path', () => {
    expect(waitPath('/items/invoices?limit=50')).toBe('/api/items/invoices')
    expect(waitPath('/api/custom-queries/pub-health/execute')).toBe(
      '/api/custom-queries/pub-health/execute'
    )
    expect(waitPath('/queues/4/items/')).toBe('/api/queues/4/items')
    expect(waitPath('https://x.test/api/items')).toBeNull()
    expect(waitPath('/items/<script>')).toBeNull()
  })

  it('knows an items list path from a record path', () => {
    expect(listCollectionOf('/api/items/invoices')).toBe('invoices')
    expect(listCollectionOf('/api/items/invoices/4')).toBeNull()
    expect(listCollectionOf('/api/items/nivaro_users')).toBeNull()
  })
})

describe('pickWait', () => {
  const snap = (over: Record<string, unknown> = {}) =>
    ({
      id: 't',
      user_id: 'u1',
      method: 'GET',
      path: '/api/items/invoices',
      age_ms: 4000,
      phase: 'handler',
      rows: 0,
      queries: 2,
      statement_ms: 0,
      waits: [],
      ...over
    }) as Parameters<typeof pickWait>[0]

  it('nothing in flight = not found', () => {
    expect(pickWait(null)).toEqual({ found: false })
  })

  it('a queued slot beats everything else', () => {
    const a = pickWait(
      snap({
        waits: [
          { kind: 'query', subject: 'pub', shared: false, since_ms: 1, position: null, of: null },
          { kind: 'slot', subject: null, shared: false, since_ms: 1, position: 2, of: 5 }
        ]
      })
    )
    expect(a.kind).toBe('slot')
    expect(a.position).toBe(2)
    expect(a.of).toBe(5)
  })

  it('external beats a running query; a running statement reads as database', () => {
    expect(
      pickWait(
        snap({
          waits: [
            { kind: 'query', subject: 'q', shared: false, since_ms: 1, position: null, of: null },
            {
              kind: 'external',
              subject: 'fusion',
              shared: false,
              since_ms: 1,
              position: null,
              of: null
            }
          ]
        })
      ).subject
    ).toBe('fusion')
    const db = pickWait(snap({ phase: 'sql', statement_ms: 3000 }))
    expect(db.kind).toBe('database')
    expect(db.collection).toBe('invoices')
  })
})

describe('in-flight wait notes', () => {
  it('a note on the current request is found by its owner only, and withdrawn', () => {
    const req = fakeReq('/api/custom-queries/pub/execute', 'u1', 'POST')
    beginTrace('/api/custom-queries/pub/execute', req)
    inflightStart(req)
    const end = inflightNoteWait({ kind: 'query', subject: 'pub' })
    const mine = inflightWaitFor('u1', 'POST', '/api/custom-queries/pub/execute')
    expect(mine?.waits.map((w) => w.kind)).toEqual(['query'])
    expect(inflightWaitFor('u2', 'POST', '/api/custom-queries/pub/execute')).toBeNull()
    end()
    expect(inflightWaitFor('u1', 'POST', '/api/custom-queries/pub/execute')?.waits).toEqual([])
    inflightEnd(req)
    expect(inflightWaitFor('u1', 'POST', '/api/custom-queries/pub/execute')).toBeNull()
  })

  it('a read-gate waiter notes its queue position until it gets a slot', async () => {
    resetReadGate({ global: 1, perUser: 1, maxWaitMs: 60_000 })
    const first = await acquireReadSlot('someone-else')
    const req = fakeReq('/api/items/invoices')
    beginTrace('/api/items/invoices', req)
    inflightStart(req)
    const waiting = acquireReadSlot('u1')
    const snap = inflightWaitFor('u1', 'GET', '/api/items/invoices')
    expect(pickWait(snap)).toMatchObject({ kind: 'slot', position: 1, of: 1 })
    first.release()
    const slot = await waiting
    expect(pickWait(inflightWaitFor('u1', 'GET', '/api/items/invoices')).kind).not.toBe('slot')
    slot.release()
  })
})

describe('matchPeerSnapshot', () => {
  it('matches the caller on a fresh peer payload and ages it', () => {
    const row = {
      id: 'x',
      user_id: 'u1',
      method: 'GET',
      path: '/api/items/a',
      age_ms: 3000,
      phase: 'sql' as const,
      rows: 0,
      queries: 1,
      statement_ms: 2900,
      waits: []
    }
    const now = 10_000
    expect(
      matchPeerSnapshot(
        [{ node: 'peer', at: now - 1000, rows: [row] }],
        'u1',
        'GET',
        '/api/items/a',
        now
      )?.age_ms
    ).toBe(4000)
    expect(
      matchPeerSnapshot(
        [{ node: 'peer', at: now - 1000, rows: [row] }],
        'u2',
        'GET',
        '/api/items/a',
        now
      )
    ).toBeNull()
    expect(
      matchPeerSnapshot(
        [{ node: 'peer', at: now - 60_000, rows: [row] }],
        'u1',
        'GET',
        '/api/items/a',
        now
      )
    ).toBeNull()
  })
})
