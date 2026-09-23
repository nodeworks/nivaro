import { describe, expect, it } from 'vitest'
import { bannerLines } from '../obligation-banner'

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

  it('says when a partner was told', () => {
    const out = bannerLines([row({})], now)
    expect(out[0].text).toBe('told at 14:02')
    expect(out[0].tone).toBe('positive')
  })

  it('says a partner SHOULD have been told, with the reason', () => {
    const out = bannerLines(
      [row({ outcome: 'skipped', reason: 'guard unmet: is_on_hold = true' })],
      now
    )
    expect(out[0].text).toBe('should have been told at 14:02 — guard unmet: is_on_hold = true')
    expect(out[0].tone).toBe('warning')
  })

  it('ages a pending send so the wait is visible', () => {
    const out = bannerLines([row({ outcome: 'pending', resolved_at: null })], now)
    expect(out[0].text).toBe('sent at 14:02, awaiting acknowledgement (58 min)')
  })

  it('reads a failure as danger and carries its error', () => {
    const out = bannerLines([row({ outcome: 'failed', reason: 'HTTP 500' })], now)
    expect(out[0].tone).toBe('danger')
    expect(out[0].text).toBe('send failed at 14:02 — HTTP 500')
  })

  it('says plainly when a send never happened', () => {
    const out = bannerLines(
      [
        row({ outcome: 'missing', reason: 'no send was ever attempted — the trigger did not fire' })
      ],
      now
    )
    expect(out[0].text).toBe('never told — no send was ever attempted — the trigger did not fire')
    expect(out[0].tone).toBe('danger')
  })

  it('drops superseded rows rather than reporting stale history', () => {
    expect(bannerLines([row({ outcome: 'superseded' })], now)).toEqual([])
  })

  it('returns nothing for a record with no obligations', () => {
    expect(bannerLines([], now)).toEqual([])
  })
})
