import { describe, expect, it } from 'vitest'
import { teamsLockedMoveText } from './locked-move.js'

describe('Teams card move while someone edits (army 11 review)', () => {
  it('names the editor and offers no move anyway', () => {
    const t = teamsLockedMoveText('Bernard Kelly')
    expect(t).toBe(
      'Bernard Kelly is editing this record right now. Try again once they have saved, or open it in Nivaro.'
    )
    expect(t).not.toMatch(/anyway/i)
  })
  it('a holder with no name still reads as a person', () => {
    expect(teamsLockedMoveText(null)).toMatch(/^Someone else is editing/)
  })
})
