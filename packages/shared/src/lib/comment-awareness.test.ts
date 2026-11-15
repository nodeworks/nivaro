import { describe, expect, it } from 'vitest'
import {
  deliverySummary,
  type MentionDelivery,
  mentionChannelText,
  mentionHeadline,
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
  it('first names, folded past two', () => {
    expect(seenByText([])).toBeNull()
    expect(seenByText([p('Beth Ames')])).toBe('Seen by Beth')
    expect(seenByText([p('Beth Ames'), p('Mark Ode')])).toBe('Seen by Beth and Mark')
    expect(seenByText([p('Beth'), p('Mark'), p('Kim'), p('Jo')], 'Also seen by')).toBe(
      'Also seen by Beth, Mark and 2 others'
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
    expect(mentionHeadline({ ...base, headline: 'muted' }).text).toBe('Muted — won’t be told')
    expect(mentionHeadline({ ...base, headline: 'not_told' }).tone).toBe('muted')
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
    ).toBe('1 seen · 1 not seen yet · 1 not told · 1 bounced')
  })
})
