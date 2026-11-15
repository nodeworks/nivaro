import { describe, expect, it } from 'vitest'
import { mineAnswer } from '../../../routes/access-requests.js'
import { userRoomSpellings } from '../../../services/permission-live.js'

// rt4 #11 / #12 — a page that unlocked by itself says who granted it, and an approval reaches
// the person's socket whatever case the id was written in.

describe('mineAnswer (GET /access-requests/mine)', () => {
  it('names the administrator who decided, first name for the note', () => {
    expect(
      mineAnswer({
        status: 'granted',
        resolved_at: new Date('2026-11-14T15:00:00Z'),
        by_first: ' Beth ',
        by_last: 'Carter'
      })
    ).toEqual({
      status: 'granted',
      resolved_at: '2026-11-14T15:00:00.000Z',
      resolved_by_name: 'Beth Carter',
      resolved_by_first: 'Beth'
    })
  })

  it('a pending request names nobody; a missing first name falls back to the full name', () => {
    expect(mineAnswer({ status: 'pending' })).toEqual({
      status: 'pending',
      resolved_at: null,
      resolved_by_name: null,
      resolved_by_first: null
    })
    expect(
      mineAnswer({ status: 'granted', by_first: null, by_last: 'Carter' }).resolved_by_first
    ).toBe('Carter')
  })
})

describe('userRoomSpellings', () => {
  it('tells the id as given and in both cases, once each', () => {
    expect(userRoomSpellings(['abcDEF12-0000'])).toEqual([
      'abcDEF12-0000',
      'ABCDEF12-0000',
      'abcdef12-0000'
    ])
    expect(userRoomSpellings(['1111', '1111'])).toEqual(['1111'])
  })
})
