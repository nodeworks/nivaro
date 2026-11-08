import { describe, expect, it } from 'vitest'
import {
  lockedAfterMoveText,
  movedNoticeId,
  movedNoticeText,
  namedMovedNoticeRecent,
  noteNamedMovedNotice
} from './moved-notice'

describe('moved-while-editing notice (army 11 f4 M4)', () => {
  it('names who moved it and where, and says whether the edits can still be saved', () => {
    expect(
      movedNoticeText({
        by_name: 'Sudharsan Kanniappan',
        state_label: 'Waiting on Level 1 Approval',
        still_editable: false
      })
    ).toBe(
      'Sudharsan Kanniappan moved this record to Waiting on Level 1 Approval while you were editing. What you haven’t saved can no longer be saved here — it stays on this page so you can copy it.'
    )
    expect(movedNoticeText({ by_name: 'Ann', still_editable: true })).toBe(
      'Ann moved this record while you were editing. You can still save your changes.'
    )
    expect(movedNoticeText({})).toMatch(/^Someone moved this record/)
  })

  it('the named notice keeps the generic one quiet for a while, per record', () => {
    noteNamedMovedNotice('workflows', 1, 1000)
    expect(namedMovedNoticeRecent('workflows', '1', 2000)).toBe(true)
    expect(namedMovedNoticeRecent('workflows', 2, 2000)).toBe(false)
    expect(namedMovedNoticeRecent('workflows', 1, 1000 + 16_000)).toBe(false)
    expect(movedNoticeId('workflows', 1)).toBe(movedNoticeId('workflows', '1'))
  })

  it('the generic text follows the step message', () => {
    expect(
      lockedAfterMoveText(
        'This record is at Waiting on Level 1 Approval — only its creator can change it.'
      )
    ).toBe(
      'This record is at Waiting on Level 1 Approval — only its creator can change it. What you haven’t saved can no longer be saved here — it stays on this page so you can copy it.'
    )
  })
})
