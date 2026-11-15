import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: Object.assign(vi.fn(), { schema: {} }) }))

import {
  mayReadField,
  openRevealsComments,
  type ReaderVerdicts,
  seenByForComment
} from '../../../services/comment-seen.js'
import {
  describeMention,
  emailOutcome,
  type MailLogRow,
  pickMentionRow
} from '../../../services/mention-delivery.js'

// Realtime round 7, items 15–16.

const at = (iso: string) => new Date(iso)
const viewers = [
  { id: 'u-beth', name: 'Beth Ames', viewedAt: at('2026-11-15T15:10:00Z') },
  { id: 'u-mark', name: 'Mark Ode', viewedAt: at('2026-11-15T15:05:00Z') },
  { id: 'u-old', name: 'Olga Old', viewedAt: at('2026-11-15T14:00:00Z') },
  { id: 'u-out', name: 'Out Sider', viewedAt: at('2026-11-15T15:20:00Z') },
  { id: 'u-author', name: 'Ann Author', viewedAt: at('2026-11-15T15:30:00Z') },
  { id: 'u-me', name: 'Me Reader', viewedAt: at('2026-11-15T15:30:00Z') }
]
const verdicts: ReaderVerdicts = {
  // u-out may NOT open the record.
  record: new Set(['U-BETH', 'U-MARK', 'U-OLD', 'U-AUTHOR', 'U-ME']),
  fields: new Map<string, string[] | null>([
    ['U-BETH', null],
    ['U-MARK', ['title']],
    ['U-OLD', null],
    ['U-AUTHOR', null],
    ['U-ME', null]
  ])
}
const comment = { id: 'c1', user: 'u-author', created_at: '2026-11-15T15:00:00Z', field: null }

describe('seen by', () => {
  it('names people who opened the record after the comment, newest first', () => {
    const out = seenByForComment(comment, viewers, verdicts, 'u-me')
    expect(out.map((p) => p.id)).toEqual(['u-beth', 'u-mark'])
  })

  it('never names the author, the reader, earlier opens or people who cannot open the record', () => {
    const ids = seenByForComment(comment, viewers, verdicts, 'u-me').map((p) => p.id)
    expect(ids).not.toContain('u-author')
    expect(ids).not.toContain('u-me')
    expect(ids).not.toContain('u-old')
    expect(ids).not.toContain('u-out')
  })

  it('a field comment names only people who may read that field', () => {
    const out = seenByForComment({ ...comment, field: 'amount' }, viewers, verdicts, 'u-me')
    expect(out.map((p) => p.id)).toEqual(['u-beth'])
    expect(mayReadField(['*'], 'amount')).toBe(true)
    expect(mayReadField(undefined, 'amount')).toBe(false)
    expect(mayReadField([], 'amount')).toBe(false)
  })

  it('a mention read through its notification counts, still behind the access verdict', () => {
    const mentionSeen = new Map([
      ['u-old', { name: 'Olga Old', at: '2026-11-15T15:01:00Z' }],
      ['u-out', { name: 'Out Sider', at: '2026-11-15T15:01:00Z' }]
    ])
    const ids = seenByForComment(comment, viewers, verdicts, 'u-me', mentionSeen).map((p) => p.id)
    expect(ids).toContain('u-old')
    expect(ids).not.toContain('u-out')
  })

  it('an open reveals comments only when someone else wrote one since the last open', () => {
    const cs = [{ user: 'u-a', created_at: '2026-11-15T15:00:00Z' }]
    expect(openRevealsComments(cs, 'u-b', '2026-11-15T14:00:00Z')).toBe(true)
    expect(openRevealsComments(cs, 'u-b', '2026-11-15T16:00:00Z')).toBe(false)
    expect(openRevealsComments(cs, 'U-A', null)).toBe(false)
    expect(openRevealsComments(cs, 'u-b', null)).toBe(true)
  })
})

describe('mention delivery', () => {
  const mail = new Map<number, MailLogRow>([
    [1, { id: 1, status: 'sent', error: null, created_at: '2026-11-15T15:42:00Z' }],
    [
      2,
      {
        id: 2,
        status: 'failed',
        error: '550 5.1.1 <x@y.test>: Recipient address rejected: User unknown',
        created_at: '2026-11-15T15:43:00Z'
      }
    ],
    [
      3,
      { id: 3, status: 'failed', error: 'connect ETIMEDOUT', created_at: '2026-11-15T15:44:00Z' }
    ],
    [4, { id: 4, status: 'dropped', error: 'skipped: mailbox not found', created_at: 'x' }]
  ])

  it('reads mail log rows: sent, hard bounce, failure, a suppressed (bounced) address', () => {
    expect(emailOutcome(mail.get(1))).toBe('sent')
    expect(emailOutcome(mail.get(2))).toBe('bounced')
    expect(emailOutcome(mail.get(3))).toBe('failed')
    expect(emailOutcome(mail.get(4))).toBe('bounced')
    expect(emailOutcome(undefined)).toBeNull()
  })

  it('seen beats in-inbox; push and escalation email become channels', () => {
    const p = describeMention({
      id: 'u1',
      name: 'Beth',
      row: {
        timestamp: '2026-11-15T15:00:01Z',
        delivery: {
          inapp: { status: 'delivered' },
          push: { status: 'sent', at: '2026-11-15T15:00:02Z' },
          escalation: { email_at: '2026-11-15T15:42:00Z', email_log_id: 2 }
        }
      },
      mail,
      seenAt: '2026-11-15T16:00:00Z',
      isAdmin: false
    })
    expect(p.headline).toBe('seen')
    expect(p.channels).toEqual([
      { key: 'push', status: 'sent', at: '2026-11-15T15:00:02.000Z' },
      { key: 'email', status: 'bounced', at: '2026-11-15T15:43:00.000Z' }
    ])
  })

  it('no row: muted when their rules silence it, else not told; the reason is for admins only', () => {
    const base = { id: 'u2', name: 'Mark', row: null, mail, seenAt: null }
    const silenced = { muted: true, reason: 'Notification rules: in-app is OFF' }
    expect(describeMention({ ...base, silenced, isAdmin: false })).toMatchObject({
      headline: 'muted',
      reason: null
    })
    expect(describeMention({ ...base, silenced, isAdmin: true }).reason).toBe(
      'Notification rules: in-app is OFF'
    )
    expect(describeMention({ ...base, silenced: null, isAdmin: false }).headline).toBe('not_told')
  })

  it('a row in the inbox and not yet seen', () => {
    const p = describeMention({
      id: 'u3',
      name: 'Kim',
      row: { timestamp: '2026-11-15T15:00:01Z', delivery: null },
      mail,
      seenAt: null,
      isAdmin: false
    })
    expect(p.headline).toBe('in_inbox')
    expect(p.channels).toEqual([])
  })

  it('picks the first row inside the window after the comment', () => {
    const c = at('2026-11-15T15:00:00Z')
    const rows = [
      { id: 1, timestamp: '2026-11-15T14:00:00Z' },
      { id: 2, timestamp: '2026-11-15T15:00:03Z' },
      { id: 3, timestamp: '2026-11-15T15:00:01Z' },
      { id: 4, timestamp: '2026-11-15T16:00:00Z' }
    ]
    expect(pickMentionRow(rows, c)?.id).toBe(3)
    expect(pickMentionRow([rows[0], rows[3]], c)).toBeNull()
  })
})
