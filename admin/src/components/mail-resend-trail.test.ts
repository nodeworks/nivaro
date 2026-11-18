import { describe, expect, it } from 'vitest'
import { resenderLabel, retryNoteKind, retryTimeLabel } from './mail-resend-trail'

// Migration 536: the Mail log names automatic retries and says when the next one goes.

describe('resenderLabel', () => {
  it('a resend nobody pressed is an automatic retry', () => {
    expect(resenderLabel(null, null)).toBe('Automatic retry')
    expect(resenderLabel('u1', 'Dana Ray')).toBe('Dana Ray')
    expect(resenderLabel('u1', null)).toBeNull()
  })
})

describe('retryNoteKind', () => {
  const base = { status: 'failed', retryAt: null, retryCount: 0, lastResendStatus: null }
  it('a pending retry', () => {
    expect(retryNoteKind({ ...base, retryAt: '2026-11-18T21:15:00Z', retryCount: 1 })).toBe(
      'pending'
    )
  })
  it('gave up only when the newest resend failed too', () => {
    expect(retryNoteKind({ ...base, retryCount: 4, lastResendStatus: 'failed' })).toBe('exhausted')
    // A later resend went through (or test mode held it): never "still did not take it".
    expect(retryNoteKind({ ...base, retryCount: 4, lastResendStatus: 'sent' })).toBeNull()
    expect(retryNoteKind({ ...base, retryCount: 4, lastResendStatus: 'dropped' })).toBeNull()
  })
  it('nothing to say otherwise', () => {
    expect(retryNoteKind({ ...base, retryCount: 2 })).toBeNull()
    expect(
      retryNoteKind({ ...base, status: 'sent', retryCount: 4, lastResendStatus: 'failed' })
    ).toBeNull()
  })
})

describe('retryTimeLabel', () => {
  it('12-hour time today, with the date on another day', () => {
    const now = new Date(2026, 10, 18, 16, 0)
    expect(retryTimeLabel(new Date(2026, 10, 18, 16, 15).toISOString(), now)).toBe('4:15 PM')
    expect(retryTimeLabel(new Date(2026, 10, 19, 9, 5).toISOString(), now)).toBe('Nov 19, 9:05 AM')
    expect(retryTimeLabel('nope', now)).toBe('—')
  })
})
