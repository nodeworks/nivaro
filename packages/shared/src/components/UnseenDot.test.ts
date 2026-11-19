import { describe, expect, it } from 'vitest'
import { unseenExtras, unseenHeadline } from './UnseenDot'

describe('unseen dot words', () => {
  it('names who and what in the popover title', () => {
    expect(
      unseenHeadline({ changed_at: '2026-11-19T15:20:00Z', by: 'Beth Ray', kinds: ['edit'] })
    ).toBe('Beth Ray edited this since you last opened it')
    expect(
      unseenHeadline({ changed_at: '', by: null, kinds: ['edit', 'transition', 'comment'] })
    ).toBe('Someone edited, moved and commented on this since you last opened it')
  })

  it('says what the field list cannot show', () => {
    expect(unseenExtras(['edit'])).toBeNull()
    expect(unseenExtras(['edit', 'transition'])).toBe('moved through its pipeline')
    expect(unseenExtras(['comment', 'transition'])).toBe(
      'moved through its pipeline · new comments'
    )
  })
})
