import { describe, expect, it } from 'vitest'
import { draftFor, withTicketDraft } from './TicketDetailSheet'

// R5 (realtime gaps 2026-11-17): a half-written reply on ticket A appeared in
// ticket B's box (the sheet stays mounted between tickets) and could be sent
// to the wrong requester.
describe('reply drafts per ticket', () => {
  it('a draft stays with its own ticket', () => {
    let d = withTicketDraft({}, 1, 'Hi Ann, about your laptop')
    expect(draftFor(d, 1)).toBe('Hi Ann, about your laptop')
    expect(draftFor(d, 2)).toBe('')
    d = withTicketDraft(d, 2, 'Bob:')
    expect(draftFor(d, 1)).toBe('Hi Ann, about your laptop')
    expect(draftFor(d, 2)).toBe('Bob:')
  })

  it('sending clears only that ticket; no ticket open holds nothing', () => {
    const d = withTicketDraft(withTicketDraft({}, 1, 'a'), 2, 'b')
    expect(withTicketDraft(d, 1, '')).toEqual({ '2': 'b' })
    expect(draftFor(d, null)).toBe('')
    expect(withTicketDraft(d, null, 'x')).toBe(d)
  })
})
