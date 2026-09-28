import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  creatorColumnFor,
  daysBetween,
  isSendBackEdge,
  pickUnavailable
} from '../../../services/dashboard-feed.js'

describe('isSendBackEdge', () => {
  it('is a send-back when the destination sorts before the origin', () => {
    expect(isSendBackEdge(5, 2, 'Approve')).toBe(true)
  })

  it('is not a send-back on a forward or same-sort move with an ordinary label', () => {
    expect(isSendBackEdge(2, 5, 'Approve')).toBe(false)
    expect(isSendBackEdge(3, 3, 'Submit')).toBe(false)
  })

  it('counts a transition whose label says send back / sent back, whatever the sorts', () => {
    expect(isSendBackEdge(2, 5, 'Send Back')).toBe(true)
    expect(isSendBackEdge(2, 5, 'sent back to creator')).toBe(true)
    expect(isSendBackEdge(2, 5, 'SendBack')).toBe(true)
    expect(isSendBackEdge(2, 5, 'Send-back')).toBe(true)
  })

  it('treats missing sorts as unknown, falling back to the label', () => {
    expect(isSendBackEdge(null, null, 'Approve')).toBe(false)
    expect(isSendBackEdge(null, 1, 'Send back')).toBe(true)
  })
})

describe('daysBetween', () => {
  it('counts whole days, flooring partial ones', () => {
    expect(daysBetween('2026-09-01T00:00:00Z', '2026-09-04T12:00:00Z')).toBe(3)
  })

  it('is never negative and reads Date objects too', () => {
    expect(daysBetween(new Date('2026-09-04T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))).toBe(0)
  })

  it('answers 0 for an unreadable date', () => {
    expect(daysBetween('not a date', '2026-09-04T00:00:00Z')).toBe(0)
  })
})

describe('creatorColumnFor', () => {
  it('prefers a field flagged user-created (JSON array special) that physically exists', () => {
    const fields = [
      { field: 'owner_person', special: '["user-created"]' },
      { field: 'user_created', special: null }
    ]
    expect(creatorColumnFor(fields, ['id', 'owner_person', 'user_created'])).toBe('owner_person')
  })

  it('reads a bare or comma-list special', () => {
    expect(creatorColumnFor([{ field: 'made_by', special: 'm2o,user-created' }], ['made_by'])).toBe(
      'made_by'
    )
  })

  it('ignores a flagged field that has no physical column', () => {
    expect(creatorColumnFor([{ field: 'ghost', special: 'user-created' }], ['id', 'creator'])).toBe(
      'creator'
    )
  })

  it('falls back to user_created, then creator, then created_by (case-insensitive)', () => {
    expect(creatorColumnFor([], ['id', 'created_by', 'creator'])).toBe('creator')
    expect(creatorColumnFor([], ['id', 'CREATED_BY'])).toBe('CREATED_BY')
    expect(creatorColumnFor([], ['id', 'user_created', 'creator'])).toBe('user_created')
  })

  it('answers null when nothing names a creator', () => {
    expect(creatorColumnFor([], ['id', 'name'])).toBeNull()
  })
})

describe('pickUnavailable', () => {
  const base = {
    first_name: 'Pat',
    last_name: 'Lee',
    email: 'pat@example.com',
    status: 'active',
    is_redacted: false,
    is_out_of_office: false,
    delegate_id: null,
    delegate_expires_at: null
  }

  it('lists a suspended owner', () => {
    const out = pickUnavailable([{ id: 'A' }], [{ ...base, id: 'A', status: 'suspended' }])
    expect(out).toEqual([{ id: 'A', name: 'Pat Lee', reason: 'suspended', delegate: null }])
  })

  it('lists a redacted owner as redacted', () => {
    const out = pickUnavailable([{ id: 'A' }], [{ ...base, id: 'A', is_redacted: 1 }])
    expect(out[0]?.reason).toBe('redacted')
  })

  it('an out-of-office owner whose delegation expired is out with no delegate', () => {
    const out = pickUnavailable(
      [{ id: 'A' }],
      [
        {
          ...base,
          id: 'A',
          is_out_of_office: true,
          delegate_id: 'X',
          delegate_expires_at: new Date('2020-01-01T00:00:00Z')
        },
        { ...base, id: 'X', first_name: 'Kim' }
      ]
    )
    expect(out).toEqual([{ id: 'A', name: 'Pat Lee', reason: 'out', delegate: null }])
  })

  it('an out-of-office owner with a working delegate names the delegate', () => {
    const out = pickUnavailable(
      [{ id: 'a' }],
      [
        { ...base, id: 'A', is_out_of_office: 1, delegate_id: 'x', delegate_expires_at: null },
        { ...base, id: 'X', first_name: 'Kim', last_name: 'Diaz' }
      ]
    )
    expect(out).toEqual([
      {
        id: 'a',
        name: 'Pat Lee',
        reason: 'out',
        delegate: { id: 'X', name: 'Kim Diaz', expires_at: null }
      }
    ])
  })

  it('an active owner is not listed', () => {
    expect(pickUnavailable([{ id: 'A' }], [{ ...base, id: 'A' }])).toEqual([])
  })
})
