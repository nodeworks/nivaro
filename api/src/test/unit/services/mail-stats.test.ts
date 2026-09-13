import { describe, expect, it } from 'vitest'
import { aggregateMailStats, normalizeError, UNTEMPLATED } from '../../../services/mail-stats.js'

const now = new Date('2026-09-13T12:00:00Z')
const at = (daysAgo: number, h = 10) =>
  new Date(now.getTime() - daysAgo * 86_400_000 + (h - 12) * 3_600_000)

describe('aggregateMailStats', () => {
  it('rolls up totals, a dense day series, templates, recipients, failures and bounces', () => {
    const rows = [
      {
        to: 'a@x.com',
        status: 'sent',
        template: 'workflow_transition',
        error: null,
        created_at: at(0)
      },
      { to: 'a@x.com, b@x.com', status: 'sent', template: null, error: null, created_at: at(1) },
      {
        to: 'b@x.com',
        status: 'failed',
        template: 'workflow_transition',
        error: '550 5.1.1 <b@x.com>: Recipient address rejected',
        created_at: at(1, 14)
      },
      {
        to: 'c@x.com',
        status: 'failed',
        template: 'alert',
        error: '550 5.1.1 <c@x.com>: Recipient address rejected',
        created_at: at(2)
      },
      { to: 'c@x.com', status: 'sent', template: 'alert', error: null, created_at: at(2, 15) },
      { to: 'd@x.com', status: 'dropped', template: 'alert', error: null, created_at: at(6) },
      {
        to: 'e@x.com',
        status: 'deferred',
        template: 'daily_digest',
        error: null,
        created_at: at(9)
      }
    ]
    const s = aggregateMailStats(rows, {
      days: 7,
      now,
      labelFor: (t) => (t === 'workflow_transition' ? 'Workflow state change' : null)
    })
    expect(s.totals).toEqual({
      sent: 3,
      failed: 2,
      dropped: 1,
      deferred: 1,
      total: 7,
      success_rate: 60
    })
    // 7 buckets, oldest first, the day-9 row outside the series (still in totals).
    expect(s.series).toHaveLength(7)
    expect(s.series[6]).toEqual({ day: '2026-09-13', sent: 1, failed: 0, dropped: 0, deferred: 0 })
    expect(s.series[5]).toMatchObject({ day: '2026-09-12', sent: 1, failed: 1 })
    expect(s.series[0]).toMatchObject({ day: '2026-09-07', sent: 0, dropped: 1 })

    const wt = s.by_template.find((t) => t.template === 'workflow_transition')
    expect(wt).toMatchObject({
      label: 'Workflow state change',
      sent: 1,
      failed: 1,
      total: 2,
      failure_rate: 50
    })
    expect(wt?.last_error).toContain('Recipient address rejected')
    expect(s.by_template.find((t) => t.template === UNTEMPLATED)).toMatchObject({
      label: null,
      sent: 1
    })
    expect(s.by_template[0].template).toBe('alert') // 3 rows → first

    // List sends count once per address; sort by volume then email.
    expect(s.top_recipients.slice(0, 3)).toEqual([
      { email: 'a@x.com', total: 2, failed: 0 },
      { email: 'b@x.com', total: 2, failed: 1 },
      { email: 'c@x.com', total: 2, failed: 1 }
    ])
    // One error bucket for both 550s (addresses normalized away).
    expect(s.failures).toHaveLength(1)
    expect(s.failures[0]).toMatchObject({ count: 2, recipients: ['b@x.com', 'c@x.com'] })
    expect(s.failures[0].error).toBe('550 5.1.1 <address>: Recipient address rejected')
    // b's LATEST attempt failed → bounce; c's latest attempt sent → not a bounce.
    expect(s.bounces.map((b) => b.email)).toEqual(['b@x.com'])
  })

  it('reports a null success rate when nothing was attempted', () => {
    const s = aggregateMailStats([], { days: 3, now })
    expect(s.totals.success_rate).toBeNull()
    expect(s.series).toHaveLength(3)
    expect(s.by_template).toEqual([])
  })
})

describe('normalizeError', () => {
  it('strips addresses, ids and long numbers, caps length', () => {
    expect(
      normalizeError(
        'Mailbox <x@y.com> full for user 1234567 (id 1b2c3d4e-1111-2222-3333-444444444444)'
      )
    ).toBe('Mailbox <address> full for user <n> (id <id>)')
    expect(
      normalizeError(
        'Data command failed: 421-4.3.0 Temporary System Problem. Try again later. For more information, go to\n421 4.3.0  https://support.google.com/mail/?p=x a9-20020a05sm1234567gsmtp'
      )
    ).toBe(
      normalizeError(
        'Data command failed: 421-4.3.0 Temporary System Problem. Try again later. For more information, go to\n421 4.3.0  https://support.google.com/mail/?p=y b7-20020a05sm7654321gsmtp'
      )
    )
    expect(normalizeError(null)).toBe('(no error text)')
    expect(normalizeError('a'.repeat(500))).toHaveLength(160)
  })
})
