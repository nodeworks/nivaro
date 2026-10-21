import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/io-holder.js', () => ({ getIo: () => null, getApp: () => null }))

import {
  _resetLeakAuditForTests,
  auditableRoom,
  checkLeak,
  envAuditRate,
  type LeakCheckDeps,
  leakSubjectOf
} from '../../../services/realtime-leak-audit.js'

const user = { id: 'u-1', role: 'r-1' } as any

function deps(over: Partial<LeakCheckDeps> = {}): LeakCheckDeps {
  return {
    isAdmin: async () => false,
    canRead: async () => true,
    canSeeRecord: async () => true,
    readableFields: async () => null,
    ...over
  }
}

const pkt = (event: string, payload: unknown) => `2${JSON.stringify([event, payload])}`

describe('realtime leak auditor (#2760)', () => {
  beforeEach(() => _resetLeakAuditForTests())

  it('reads what a packet claims: collection, ids, field names (aspects and * skipped)', () => {
    expect(
      leakSubjectOf(
        pkt('collection:update', {
          collection: 'orders',
          item: 7,
          action: 'update',
          changed_fields: ['total', '$state'],
          _seq: 3
        })
      )
    ).toEqual({
      event: 'collection:update',
      collection: 'orders',
      items: ['7'],
      fields: ['total'],
      action: 'update'
    })
    expect(
      leakSubjectOf(pkt('collection:update', { collection: 'orders', items: [1, 2, 2] }))?.items
    ).toEqual(['1', '2'])
    expect(
      leakSubjectOf(pkt('collection:update', { collection: 'orders', item: '*' }))?.items
    ).toEqual([])
    expect(leakSubjectOf(pkt('presence:update', { users: [] }))).toBeNull()
    expect(leakSubjectOf(pkt('x', { collection: 'bad name;' }))).toBeNull()
    // Socket.io acks / namespaces put digits before the array.
    expect(
      leakSubjectOf(`21${JSON.stringify(['record:x', { collection: 'a', item: 1 }])}`)?.event
    ).toBe('record:x')
    expect(leakSubjectOf('3')).toBeNull()
  })

  it('never audits the probe or replay mirror rooms', () => {
    expect(auditableRoom('probe:1')).toBe(false)
    expect(auditableRoom('t:x:rtreplay:abc:collection:a')).toBe(false)
    expect(auditableRoom('collection:a')).toBe(true)
    expect(auditableRoom(null)).toBe(true)
  })

  it('finds a collection, a record and field names the recipient cannot read', async () => {
    const s = leakSubjectOf(
      pkt('collection:update', {
        collection: 'orders',
        items: [1, 2],
        changed_fields: ['total', 'secret_margin', 'id']
      })
    )!
    expect(
      await checkLeak(user, s, 'collection:orders', deps({ canRead: async () => false }))
    ).toMatchObject([
      { kind: 'collection', collection: 'orders', room: 'collection:orders', user_id: 'u-1' }
    ])
    const found = await checkLeak(
      user,
      s,
      't:ten:collection:orders',
      deps({
        canSeeRecord: async (_u, _c, id) => id !== '2',
        readableFields: async () => ['id', 'total']
      })
    )
    expect(found.map((f) => [f.kind, f.items ?? f.fields])).toEqual([
      ['record', ['2']],
      ['field', ['secret_margin']]
    ])
    expect(found[0].room).toBe('collection:orders')
  })

  it('skips administrators, deletes and unrestricted fields', async () => {
    const s = leakSubjectOf(
      pkt('collection:update', {
        collection: 'orders',
        item: 1,
        action: 'delete',
        changed_fields: ['x']
      })
    )!
    expect(
      await checkLeak(
        user,
        s,
        null,
        deps({ isAdmin: async () => true, canRead: async () => false })
      )
    ).toEqual([])
    expect(
      await checkLeak(
        user,
        s,
        null,
        deps({ canSeeRecord: async () => false, readableFields: async () => ['*'] })
      )
    ).toEqual([])
  })

  it('is off unless a rate is set', () => {
    expect(envAuditRate({})).toBe(0)
    expect(envAuditRate({ REALTIME_LEAK_AUDIT_RATE: '0.05' })).toBe(0.05)
    expect(envAuditRate({ REALTIME_LEAK_AUDIT_RATE: '7' })).toBe(1)
    expect(envAuditRate({ REALTIME_LEAK_AUDIT_RATE: 'abc' })).toBe(0)
  })
})
