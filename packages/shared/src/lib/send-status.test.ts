import { describe, expect, it } from 'vitest'
import {
  msUntilNoAnswer,
  msUntilRetryTick,
  plainDuration,
  retryCountdown,
  type SendStatusFact,
  sendStatusWords
} from './send-status'

const NOW = Date.parse('2026-11-14T15:50:00Z')
// A fixed clock reading keeps the sentences exact whatever the machine's time zone.
const time = (iso: string) =>
  ({
    '2026-11-14T15:42:00.000Z': '10:42 AM',
    '2026-11-14T15:43:00.000Z': '10:43 AM',
    '2026-11-14T15:45:00.000Z': '10:45 AM',
    '2026-11-14T16:00:00.000Z': '11:00 AM'
  })[iso] ?? iso

const base: SendStatusFact = {
  id: 7,
  api: 'Ledger',
  status: 'sending',
  started_at: '2026-11-14T15:42:00.000Z',
  finished_at: null,
  external_ref: null,
  error_class: null,
  reason: null,
  answer_by: '2026-11-14T15:55:00.000Z',
  usual_answer_ms: null
}
const words = (f: Partial<SendStatusFact>) => sendStatusWords({ ...base, ...f }, { now: NOW, time })

describe('sendStatusWords', () => {
  it('sending: in flight, with when it started', () => {
    expect(words({})).toEqual({
      state: 'sending',
      tone: 'busy',
      text: 'Sending to Ledger now (started 10:42 AM)'
    })
  })

  it('no answer: a send past its own deadline is held, never repeated', () => {
    const w = words({ answer_by: '2026-11-14T15:45:00.000Z' })
    expect(w.state).toBe('no_answer')
    expect(w.text).toBe(
      'No answer from Ledger after 8 minutes — the send is held and will not be repeated automatically'
    )
  })

  it("waiting: sent, the partner's answer not in yet", () => {
    expect(words({ status: 'pending', finished_at: '2026-11-14T15:42:00.000Z' }).text).toBe(
      "Sent to Ledger at 10:42 AM — waiting for Ledger's answer"
    )
  })

  it('waiting: the usual answer time only when there is history behind it', () => {
    expect(
      words({
        status: 'pending',
        finished_at: '2026-11-14T15:42:00.000Z',
        usual_answer_ms: 4 * 60_000
      }).text
    ).toBe(
      "Sent to Ledger at 10:42 AM — waiting for Ledger's answer · usually answers within 4 minutes"
    )
  })

  it('accepted, with the reference under the label the partner uses', () => {
    expect(
      words({
        status: 'accepted',
        finished_at: '2026-11-14T15:43:00.000Z',
        external_ref: '12345',
        ref_label: 'PO'
      })
    ).toEqual({
      state: 'accepted',
      tone: 'ok',
      text: 'Ledger accepted it at 10:43 AM — PO 12345'
    })
    expect(
      words({
        status: 'accepted',
        finished_at: '2026-11-14T15:43:00.000Z',
        external_ref: 'REQ-9'
      }).text
    ).toBe('Ledger accepted it at 10:43 AM — reference REQ-9')
  })

  it('accepted without a reference says no reference', () => {
    expect(words({ status: 'accepted', finished_at: '2026-11-14T15:43:00.000Z' }).text).toBe(
      'Ledger accepted it at 10:43 AM'
    )
  })

  it('refused: the reason in plain words and what to do', () => {
    const w = words({
      status: 'failed',
      finished_at: '2026-11-14T15:43:00.000Z',
      error_class: 'validation',
      reason: 'Submission failed — HTTP 400: {"message":"The project is closed."}',
      no_retry: 'sending the same thing again cannot fix it'
    })
    expect(w.text).toBe(
      'Ledger refused it at 10:43 AM: The project is closed. Fix what it names, then send it again.'
    )
    expect(w.detail).toBe('Will not retry — sending the same thing again cannot fix it')
  })

  it('refused sign-in: an administrator checks the connection', () => {
    expect(
      words({ status: 'failed', finished_at: '2026-11-14T15:43:00.000Z', error_class: 'auth' }).text
    ).toBe(
      "Ledger refused it at 10:43 AM: it did not accept this app's sign-in. An administrator needs to check the connection to Ledger."
    )
  })

  it("couldn't reach: nothing was sent, never called a refusal", () => {
    const w = words({
      status: 'failed',
      finished_at: '2026-11-14T15:43:00.000Z',
      error_class: 'transient',
      reason: 'Submission failed — Timed out after 120000ms',
      no_retry: 'automatic retries are not set up for Ledger'
    })
    expect(w.state).toBe('not_taken')
    expect(w.tone).toBe('problem')
    expect(w.text).toBe("Couldn't reach Ledger — nothing was sent. Try again or ask an admin.")
    expect(w.detail).toBe('Will not retry — automatic retries are not set up for Ledger')
    expect(
      words({
        status: 'failed',
        finished_at: '2026-11-14T15:43:00.000Z',
        error_class: 'rate_limited'
      }).text
    ).toBe(
      'Ledger was too busy to take it at 10:43 AM — nothing was sent. Try again in a few minutes.'
    )
  })

  it("couldn't reach, retrying by itself: when, and which attempt", () => {
    const w = words({
      status: 'failed',
      finished_at: '2026-11-14T15:43:00.000Z',
      error_class: 'transient',
      retry: { at: '2026-11-14T16:00:00.000Z', attempt: 2, of: 5 }
    })
    expect(w).toEqual({
      state: 'not_taken',
      tone: 'waiting',
      text: "Couldn't reach Ledger — nothing was sent. Retrying at 11:00 AM (attempt 2 of 5)",
      retry_at: '2026-11-14T16:00:00.000Z'
    })
    // Past its time, the sweep is on it.
    expect(
      words({
        status: 'failed',
        error_class: 'transient',
        retry: { at: '2026-11-14T15:45:00.000Z', attempt: 3, of: 5 }
      }).text
    ).toBe("Couldn't reach Ledger — nothing was sent. Retrying now (attempt 3 of 5)")
  })

  it('a refusal a sweep will retry says so instead of what to fix', () => {
    expect(
      words({
        status: 'failed',
        finished_at: '2026-11-14T15:43:00.000Z',
        error_class: 'unknown',
        reason: 'Submission failed — HTTP 409: {"message":"Try later"}',
        retry: { at: '2026-11-14T16:00:00.000Z', attempt: 2, of: 4 }
      }).text
    ).toBe('Ledger refused it at 10:43 AM: Try later. Retrying at 11:00 AM (attempt 2 of 4)')
  })

  it('never says queued: there is no queue in front of a send', () => {
    for (const status of ['sending', 'pending', 'accepted', 'failed', 'rejected'])
      expect(words({ status }).text).not.toMatch(/queue|before this one/i)
  })
})

describe('helpers', () => {
  it('plainDuration', () => {
    expect(plainDuration(20_000)).toBe('less than a minute')
    expect(plainDuration(60_000)).toBe('1 minute')
    expect(plainDuration(25 * 60_000)).toBe('25 minutes')
    expect(plainDuration(3 * 3_600_000)).toBe('3 hours')
    expect(plainDuration(3 * 86_400_000)).toBe('3 days')
  })

  it('retryCountdown: whole minutes, rounded up, gone once due', () => {
    expect(retryCountdown('2026-11-14T16:00:00.000Z', NOW)).toBe('in 10 minutes')
    expect(retryCountdown('2026-11-14T15:50:30.000Z', NOW)).toBe('in 1 minute')
    expect(retryCountdown('2026-11-14T18:00:00.000Z', NOW)).toBe('in 2 hours')
    expect(retryCountdown('2026-11-14T15:45:00.000Z', NOW)).toBeNull()
    expect(retryCountdown(null, NOW)).toBeNull()
  })

  it('msUntilRetryTick: the next minute boundary of the countdown', () => {
    const f = {
      ...base,
      status: 'failed',
      retry: { at: '2026-11-14T16:00:30.000Z', attempt: 2, of: 5 }
    }
    expect(msUntilRetryTick(f, NOW)).toBe(30_000 + 250)
    expect(msUntilRetryTick({ ...f, retry: null }, NOW)).toBeNull()
  })

  it('msUntilNoAnswer: only for a send still in flight', () => {
    expect(msUntilNoAnswer(base, NOW)).toBe(5 * 60_000 + 500)
    expect(msUntilNoAnswer({ ...base, status: 'pending' }, NOW)).toBeNull()
    expect(msUntilNoAnswer({ ...base, answer_by: '2026-11-14T15:00:00.000Z' }, NOW)).toBeNull()
  })
})
