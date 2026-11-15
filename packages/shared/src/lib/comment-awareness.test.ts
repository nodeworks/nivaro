import { describe, expect, it } from 'vitest'
import {
  deliverySummary,
  type MentionDelivery,
  mentionChannelText,
  mentionHeadline,
  mentionReceiptLine,
  mentionReceiptSummary,
  newRepliesSince,
  repliesWhileTypingText,
  seenByText
} from './comment-awareness'

const c = (id: string, user: string, created_at: string, deleted = false) => ({
  id,
  user: { id: user },
  created_at,
  deleted
})

describe('replies while typing', () => {
  const thread = [
    c('a', 'beth', '2026-11-15T10:00:00Z'),
    c('b', 'me', '2026-11-15T10:01:00Z'),
    c('c', 'mark', '2026-11-15T10:03:00Z'),
    c('d', 'beth', '2026-11-15T10:02:00Z'),
    c('e', 'kim', '2026-11-15T10:04:00Z', true)
  ]
  it('names others’ comments not in the baseline, oldest first; never mine or deleted', () => {
    expect(newRepliesSince(new Set(['a']), thread, 'ME').map((r) => r.id)).toEqual(['d', 'c'])
  })
  it('nothing without a baseline (not typing) or a thread', () => {
    expect(newRepliesSince(null, thread, 'me')).toEqual([])
    expect(newRepliesSince(new Set(), null, 'me')).toEqual([])
  })
  it('says it plainly', () => {
    expect(repliesWhileTypingText(1)).toBe('1 new reply since you started typing')
    expect(repliesWhileTypingText(2)).toBe('2 new replies since you started typing')
  })
})

describe('seen by', () => {
  const p = (name: string) => ({ id: name, name, seen_at: '2026-11-15T10:00:00Z' })
  it('full names: three listed in full, more as two and +N', () => {
    expect(seenByText([])).toBeNull()
    expect(seenByText([p('Beth Ames')])).toBe('Seen by Beth Ames')
    expect(seenByText([p('Beth Ames'), p('Mark Ode'), p('Jo Park')])).toBe(
      'Seen by Beth Ames, Mark Ode and Jo Park'
    )
    expect(seenByText([p('Beth'), p('Mark'), p('Kim'), p('Jo')], 'Also seen by')).toBe(
      'Also seen by Beth, Mark +2'
    )
  })
})

describe('mention delivery wording', () => {
  const base: MentionDelivery = {
    id: 'u',
    name: 'Beth',
    headline: 'in_inbox',
    seen_at: null,
    delivered_at: null,
    channels: [],
    reason: null
  }
  it('headlines', () => {
    expect(mentionHeadline(base).text).toBe('In their notifications, not seen yet')
    expect(
      mentionHeadline({
        ...base,
        headline: 'muted',
        reason: 'turned off in-app alerts for Mentions'
      }).text
    ).toBe('Muted — turned off in-app alerts for Mentions')
    expect(mentionHeadline({ ...base, headline: 'not_told' })).toEqual({
      text: 'Won’t be told',
      tone: 'warn'
    })
    expect(
      mentionHeadline({ ...base, headline: 'seen', seen_at: '2026-11-15T10:00:00Z' }).text
    ).toMatch(/^Seen in app /)
  })
  it('channels', () => {
    expect(mentionChannelText({ key: 'email', status: 'bounced', at: null })).toBe('Email bounced')
    expect(mentionChannelText({ key: 'push', status: 'sent', at: null })).toBe(
      'Phone or browser alert sent'
    )
    expect(mentionChannelText({ key: 'email', status: 'sent', at: null })).toBe('Emailed')
  })
  it('summary', () => {
    expect(
      deliverySummary([
        { ...base, headline: 'seen' },
        base,
        { ...base, headline: 'muted', channels: [{ key: 'email', status: 'bounced', at: null }] }
      ])
    ).toBe('1 won’t be told · 1 bounced · 1 seen · 1 not seen yet')
  })
})

describe('mention receipts agree with Delivery', () => {
  const rel = () => '5m ago'
  const m = (extra: Record<string, unknown>) => ({
    id: 'u',
    first_name: 'Kim',
    last_name: 'Lowe',
    ...extra
  })
  it('uses the server status when the reader may see delivery', () => {
    expect(mentionReceiptLine(m({ seen_at: '2026-11-15T10:00:00Z', status: 'seen' }), rel)).toEqual(
      {
        text: 'Kim Lowe saw this 5m ago',
        tone: 'ok'
      }
    )
    expect(mentionReceiptLine(m({ status: 'in_inbox' }), rel).text).toBe(
      'Kim Lowe has not seen this yet'
    )
    expect(mentionReceiptLine(m({ status: 'not_told' }), rel)).toEqual({
      text: 'Kim Lowe won’t be told',
      tone: 'warn'
    })
    expect(
      mentionReceiptLine(
        m({ status: 'muted', reason: 'turned off in-app alerts for Mentions' }),
        rel
      ).text
    ).toBe('Kim Lowe: muted — turned off in-app alerts for Mentions')
  })
  it('promises nothing about delivery to other readers', () => {
    expect(mentionReceiptLine(m({}), rel)).toEqual({
      text: 'Kim Lowe · not seen yet',
      tone: 'neutral'
    })
  })
  it('Calm summarises', () => {
    expect(
      mentionReceiptSummary([
        m({ status: 'seen', seen_at: 'x' }),
        m({ status: 'in_inbox' }),
        m({ status: 'not_told' })
      ])
    ).toEqual({ text: '3 mentioned · 1 seen · 1 won’t be told', tone: 'warn' })
    expect(mentionReceiptSummary([m({}), m({ seen_at: 'x' })]).text).toBe('2 mentioned · 1 seen')
  })
})
