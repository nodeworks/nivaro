import { describe, expect, it } from 'vitest'
import { notesOnServerChange } from './notes-sync'

describe('notesOnServerChange (R4 — resolution notes mid-typing)', () => {
  it('follows the saved copy when the box holds no unsaved typing', () => {
    expect(notesOnServerChange('old', 'old', 'new', null)).toEqual({ draft: 'new', theirs: null })
  })

  it('keeps the typing and offers theirs when another save lands mid-typing', () => {
    expect(notesOnServerChange('my words', 'old', 'their words', null)).toEqual({
      draft: 'my words',
      theirs: 'their words'
    })
  })

  it('never asks when the saved text already matches the typing', () => {
    expect(notesOnServerChange('same', 'old', 'same', null)).toEqual({
      draft: 'same',
      theirs: null
    })
  })

  it('never asks about its own save landing while the person typed on', () => {
    expect(notesOnServerChange('sent and more', 'old', 'sent', 'sent')).toEqual({
      draft: 'sent and more',
      theirs: null
    })
  })
})
