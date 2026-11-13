import { describe, expect, it } from 'vitest'
import { bannerLines } from '../obligation-banner'
import { setDisplayTimezone } from '../utils'

// Pin the viewer's display timezone so `hhmm()`'s output is deterministic
// regardless of the machine running this suite — vitest's default `node`
// environment isolates each test file's module registry, so this never
// leaks into a sibling test file's own assertions.
setDisplayTimezone('UTC')

const now = new Date('2026-09-22T15:00:00Z')
const row = (over: Partial<Parameters<typeof bannerLines>[0][number]>) => ({
  id: 1,
  api: 'Partner',
  kind: 'wf.state',
  outcome: 'sent',
  reason: null,
  due_at: '2026-09-22T14:02:00Z',
  resolved_at: '2026-09-22T14:02:00Z',
  ...over
})

describe('bannerLines', () => {
  it('shows one line per api — the newest row wins', () => {
    const out = bannerLines(
      [
        row({
          id: 2,
          api: 'Partner',
          outcome: 'skipped',
          reason: 'guard unmet: is_on_hold = true'
        }),
        row({ id: 1, api: 'Partner', outcome: 'sent' }),
        row({ id: 3, api: 'Other', outcome: 'pending', resolved_at: null })
      ],
      now
    )
    expect(out).toHaveLength(2)
    expect(out.find((l) => l.api === 'Partner')?.obligation_id).toBe(2)
  })

  it('says when a partner was told, and how long ago', () => {
    const out = bannerLines([row({})], now)
    expect(out[0].text).toBe('told 58m ago (2:02 PM)')
    expect(out[0].tone).toBe('positive')
  })

  it('says a partner SHOULD have been told, with the reason', () => {
    const out = bannerLines(
      [row({ outcome: 'skipped', reason: 'guard unmet: is_on_hold = true' })],
      now
    )
    expect(out[0].text).toBe(
      'should have been told 58m ago (2:02 PM) — its send condition was not met (is_on_hold = true)'
    )
    expect(out[0].tone).toBe('warning')
  })

  it('words a stored skip reason for people, never the ledger code', () => {
    const out = bannerLines(
      [row({ outcome: 'skipped', reason: 'skip_when_empty: nuvolo_id empty' })],
      now
    )
    expect(out[0].text).toContain('— this record has no Nuvolo ID yet')
  })

  it('ages a pending send so the wait is visible', () => {
    const out = bannerLines([row({ outcome: 'pending', resolved_at: null })], now)
    expect(out[0].text).toBe('sent 58m ago (2:02 PM), awaiting acknowledgement (58 min)')
  })

  it('reads a failure as danger and carries its error', () => {
    const out = bannerLines([row({ outcome: 'failed', reason: 'HTTP 500' })], now)
    expect(out[0].tone).toBe('danger')
    // What the status means about the other system, never the status line itself.
    expect(out[0].text).toBe(
      'send failed 58m ago (2:02 PM) — The other system ran into a problem of its own.'
    )
  })

  it('says plainly when a send never happened', () => {
    const out = bannerLines(
      [
        row({ outcome: 'missing', reason: 'no send was ever attempted — the trigger did not fire' })
      ],
      now
    )
    expect(out[0].text).toBe('never told — nothing was sent when this changed')
    expect(out[0].tone).toBe('danger')
  })

  it('drops superseded rows rather than reporting stale history', () => {
    expect(bannerLines([row({ outcome: 'superseded' })], now)).toEqual([])
  })

  it('returns nothing for a record with no obligations', () => {
    expect(bannerLines([], now)).toEqual([])
  })

  it('names the transition-triggered kind in context, but only for a transition trigger', () => {
    const withTransition = bannerLines([row({ trigger: 'transition', kind: 'wf.state' })], now)
    expect(withTransition[0].text).toBe('told 58m ago (2:02 PM) · Wf State')

    const withHook = bannerLines([row({ trigger: 'hook', kind: 'wf.state' })], now)
    expect(withHook[0].text).toBe('told 58m ago (2:02 PM)')
  })

  it("prefers the kind's real label over the humanized key, for any trigger", () => {
    const out = bannerLines(
      [
        row({
          trigger: 'hook',
          kind: 'ir.fusion_order_submit',
          label: 'Fusion — transfer order submitted',
          outcome: 'failed',
          reason: 'LOV'
        })
      ],
      now
    )
    expect(out[0].text).toBe(
      'send failed 58m ago (2:02 PM) · Fusion — transfer order submitted — LOV'
    )
  })
})

// Design review (2026-11-12): after a failed move's toast goes, this line is the only words
// left on the record. It read the stored status line as it was (`— HTTP 401: ""`).
describe('bannerLines — a failed send says what the other system answered', () => {
  const failed = (reason: string) => bannerLines([row({ outcome: 'failed', reason })], now)[0].text

  it('the other system’s own sentence, without the status line', () => {
    expect(failed('HTTP 400: "The project is not valid"')).toBe(
      'send failed 58m ago (2:02 PM) — The project is not valid'
    )
  })

  it('what the failure means when the answer holds no sentence', () => {
    expect(failed('HTTP 401: ""')).toBe(
      'send failed 58m ago (2:02 PM) — The other system did not accept this app’s sign-in. An administrator needs to check the connection.'
    )
    expect(failed('fetch failed (after 2 retries)')).toBe(
      'send failed 58m ago (2:02 PM) — The other system could not be reached.'
    )
  })

  it('a reason that is not a partner call’s failure reads as before', () => {
    const skipped = bannerLines(
      [row({ outcome: 'skipped', reason: 'this record has no Project yet' })],
      now
    )[0].text
    expect(skipped).toContain('this record has no Project yet')
    expect(failed('Partner responded with status: ERROR')).toContain(
      'Partner responded with status: ERROR'
    )
  })
})
