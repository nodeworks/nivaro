import { describe, expect, it } from 'vitest'
import { needsTransitionNote } from './transition-note'

describe('worklist moves that need a note', () => {
  it('only a required comment mode asks', () => {
    expect(needsTransitionNote({ comment_mode: 'required' })).toBe(true)
    expect(needsTransitionNote({ comment_mode: 'optional' })).toBe(false)
    expect(needsTransitionNote({})).toBe(false)
    expect(needsTransitionNote(null)).toBe(false)
  })
})
