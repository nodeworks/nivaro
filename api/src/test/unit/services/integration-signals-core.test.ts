import { describe, expect, it } from 'vitest'
import type { SignalRow } from '../../../services/integration-signals.js'
import {
  ageWords,
  failureStreak,
  formatInboundCaller,
  isAuthFailure,
  uniqueByKey
} from '../../../services/integration-signals-core.js'

describe('failureStreak', () => {
  it('counts consecutive failures from the newest call and flags auth', () => {
    expect(
      failureStreak([
        { ok: false, status: 401, error: null },
        { ok: false, status: 500, error: null },
        { ok: true, status: 200, error: null },
        { ok: false, status: 500, error: null }
      ])
    ).toEqual({ streak: 2, auth: true })
  })
  it('is zero when the newest call succeeded', () => {
    expect(failureStreak([{ ok: true, status: 200, error: null }])).toEqual({
      streak: 0,
      auth: false
    })
  })
})

describe('isAuthFailure', () => {
  it('reads 401/403 and token-exchange errors', () => {
    expect(isAuthFailure(401, null)).toBe(true)
    expect(isAuthFailure(403, null)).toBe(true)
    expect(isAuthFailure(null, 'Token exchange failed (HTTP 401): invalid_client')).toBe(true)
    expect(isAuthFailure(500, 'boom')).toBe(false)
  })
})

describe('formatInboundCaller', () => {
  it('names the person over a bare uuid', () => {
    const names = new Map([['u1', 'Robert Lee']])
    expect(formatInboundCaller('u1', null, names, new Map())).toBe('Robert Lee')
  })

  it('falls back to the uuid when nobody resolved a name', () => {
    expect(formatInboundCaller('u1', null, new Map(), new Map())).toBe('User u1')
  })

  it('falls back to unknown with neither a user nor a key', () => {
    expect(formatInboundCaller(null, null, new Map(), new Map())).toBe('User unknown')
  })

  it('keeps the key number and adds its name when it has one', () => {
    const keys = new Map([[7, 'Partner service account']])
    expect(formatInboundCaller('u1', 7, new Map(), keys)).toBe(
      'API key #7 (Partner service account)'
    )
    expect(formatInboundCaller('u1', 9, new Map(), keys)).toBe('API key #9')
  })
})

describe('uniqueByKey', () => {
  const row = (key: string, title: string): SignalRow => ({ key, title, actions: [] })

  it('collapses duplicate keys to the first occurrence', () => {
    expect(
      uniqueByKey([row('a', 'newest attempt'), row('b', 'only one'), row('a', 'older attempt')])
    ).toEqual([row('a', 'newest attempt'), row('b', 'only one')])
  })

  it('is a no-op when every key is already unique', () => {
    const rows = [row('a', 'x'), row('b', 'y'), row('c', 'z')]
    expect(uniqueByKey(rows)).toEqual(rows)
  })

  it('handles an empty list', () => {
    expect(uniqueByKey([])).toEqual([])
  })
})

// Army 9 b14: "Invoices: no successful run in 12334 h".
describe('ageWords', () => {
  it('reads hours, days, months and years', () => {
    expect(ageWords(5.7)).toBe('5 h')
    expect(ageWords(48)).toBe('2 days')
    expect(ageWords(12334)).toBe('16 months')
    expect(ageWords(24 * 800)).toBe('2 years')
  })
})
