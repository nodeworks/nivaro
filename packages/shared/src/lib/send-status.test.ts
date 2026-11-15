import { describe, expect, it } from 'vitest'
import { msUntilNoAnswer, plainDuration, type SendStatusFact, sendStatusWords } from './send-status'

const NOW = Date.parse('2026-11-14T15:50:00Z')
// A fixed clock reading keeps the sentences exact whatever the machine's time zone.
const time = (iso: string) =>
  ({
    '2026-11-14T15:42:00.000Z': '10:42 AM',
    '2026-11-14T15:43:00.000Z': '10:43 AM'
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

  it('accepted, with their reference', () => {
    expect(
      words({
        status: 'accepted',
        finished_at: '2026-11-14T15:43:00.000Z',
        external_ref: 'PO 12345'
      })
    ).toEqual({
      state: 'accepted',
      tone: 'ok',
      text: 'Ledger accepted it at 10:43 AM — reference PO 12345'
    })
  })

  it('accepted without a reference says no reference', () => {
    expect(words({ status: 'accepted', finished_at: '2026-11-14T15:43:00.000Z' }).text).toBe(
      'Ledger accepted it at 10:43 AM'
    )
  })

  it('refused: the reason in plain words and what to do', () => {
    expect(
      words({
        status: 'failed',
        finished_at: '2026-11-14T15:43:00.000Z',
        error_class: 'validation',
        reason: 'Submission failed — HTTP 400: {"message":"The project is closed."}'
      }).text
    ).toBe(
      'Ledger refused it at 10:43 AM: The project is closed — fix what it names, then send it again'
    )
  })

  it('refused sign-in: an administrator checks the connection', () => {
    expect(
      words({ status: 'failed', finished_at: '2026-11-14T15:43:00.000Z', error_class: 'auth' }).text
    ).toBe(
      "Ledger refused it at 10:43 AM: it did not accept this app's sign-in — an administrator needs to check the connection to Ledger"
    )
  })

  it('not taken: a call that did not get through is never called a refusal', () => {
    const w = words({
      status: 'failed',
      finished_at: '2026-11-14T15:43:00.000Z',
      error_class: 'transient',
      reason: 'Submission failed — Timed out after 120000ms'
    })
    expect(w.state).toBe('not_taken')
    expect(w.text).toBe(
      'Ledger could not take it at 10:43 AM: The other system took too long to answer — send it again in a few minutes'
    )
    expect(
      words({
        status: 'failed',
        finished_at: '2026-11-14T15:43:00.000Z',
        error_class: 'rate_limited'
      }).text
    ).toBe('Ledger was too busy to take it at 10:43 AM — send it again in a few minutes')
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

  it('msUntilNoAnswer: only for a send still in flight', () => {
    expect(msUntilNoAnswer(base, NOW)).toBe(5 * 60_000 + 500)
    expect(msUntilNoAnswer({ ...base, status: 'pending' }, NOW)).toBeNull()
    expect(msUntilNoAnswer({ ...base, answer_by: '2026-11-14T15:00:00.000Z' }, NOW)).toBeNull()
  })
})
