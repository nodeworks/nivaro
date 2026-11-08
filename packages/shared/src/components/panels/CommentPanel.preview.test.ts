import { describe, expect, it } from 'vitest'
import { notePreviewText } from './CommentPanel'

// Army 11 a1 F-5: a Send Back reason typed with angle brackets lost words in
// the Notes preview (the comment tag strip ran over plain-text notes too).
describe('notePreviewText', () => {
  it('keeps a recorded note exactly as typed', () => {
    expect(
      notePreviewText({
        kind: 'related',
        note: { text: 'add the 2026 forecast <b>first</b> & recheck qty <5 per site>' }
      })
    ).toBe('add the 2026 forecast <b>first</b> & recheck qty <5 per site>')
  })
  it("flattens a comment's markup and mention tokens", () => {
    expect(notePreviewText({ kind: 'comment', comment: { text: '<p>hi @[Lee Herzog]</p>' } })).toBe(
      'hi @Lee Herzog'
    )
  })
})
