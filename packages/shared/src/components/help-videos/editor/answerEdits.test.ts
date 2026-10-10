import { describe, expect, it } from 'vitest'
import { EDIT_LIMITS } from '../edits'
import type { VideoEdits } from '../types'
import {
  addAnswerAsCaption,
  addAnswerAsChapter,
  captionTextFrom,
  chapterTitleFrom,
  sourceMomentOf
} from './answerEdits'

// Two kept pieces with a cut between: source 0–10 s and 20–30 s, the second
// at 2×. Edited time: 0–10 s is the first piece, 10–15 s the second.
const base: VideoEdits = {
  v: 1,
  segments: [
    { start_ms: 0, end_ms: 10_000, speed: 1 },
    { start_ms: 20_000, end_ms: 30_000, speed: 2 }
  ],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
}
const withIntro: VideoEdits = {
  ...base,
  intro: { enabled: true, duration_ms: 3000, show_chapters: false, title: '', subtitle: '' },
  outro: { enabled: true, duration_ms: 3000, text: '' }
}

describe('text from an answer', () => {
  it('a chapter title is the first non-empty line, cut to the limit', () => {
    expect(chapterTitleFrom('\n\n  Click Save  \nThen wait')).toBe('Click Save')
    expect(chapterTitleFrom('x'.repeat(200))).toHaveLength(EDIT_LIMITS.chapterTitle)
    expect(chapterTitleFrom('   ')).toBe('')
  })
  it('a caption collapses whitespace and is cut to the limit', () => {
    expect(captionTextFrom(' Click\n  Save,\tthen wait ')).toBe('Click Save, then wait')
    expect(captionTextFrom('y'.repeat(600))).toHaveLength(EDIT_LIMITS.text)
  })
})

describe('sourceMomentOf', () => {
  it('maps the viewer’s moment back through cuts and speeds', () => {
    expect(sourceMomentOf(base, 4000)).toBe(4000)
    expect(sourceMomentOf(base, 12_000)).toBe(24_000)
    expect(sourceMomentOf(withIntro, 3000 + 12_000)).toBe(24_000)
  })
  it('a moment on a card has no recording under it', () => {
    expect(sourceMomentOf(withIntro, 1000)).toBeNull()
    expect(sourceMomentOf(withIntro, 3000 + 15_000 + 500)).toBeNull()
  })
  it('the very end steps just inside the recording', () => {
    expect(sourceMomentOf(base, 15_000)).toBe(29_999)
  })
})

describe('addAnswerAsChapter', () => {
  it('adds a chapter at the moment, titled with the answer', () => {
    const r = addAnswerAsChapter(base, 12_000, 'Use the Save button\nTop right.')
    expect(r.refused).toBeUndefined()
    expect(r.edits.chapters).toEqual([
      { id: expect.any(String), at_ms: 24_000, title: 'Use the Save button' }
    ])
  })
  it('refuses an empty answer, a moment on a card, and a doubled chapter', () => {
    expect(addAnswerAsChapter(base, 1000, '  ').refused).toBe('Write the answer first')
    expect(addAnswerAsChapter(withIntro, 500, 'x').refused).toBe(
      'That moment is not in the finished video'
    )
    const once = addAnswerAsChapter(base, 4000, 'A').edits
    const twice = addAnswerAsChapter(once, 4300, 'B')
    expect(twice.refused).toBe('A chapter already starts here')
    expect(twice.edits).toBe(once)
  })
})

describe('addAnswerAsCaption', () => {
  it('adds a caption that reads the answer for as long as it takes', () => {
    const r = addAnswerAsCaption(base, 4000, 'Click Save, then wait for the green tick.', 30_000)
    expect(r.refused).toBeUndefined()
    expect(r.edits.captions).toHaveLength(1)
    expect(r.edits.captions[0]).toMatchObject({
      start_ms: 4000,
      text: 'Click Save, then wait for the green tick.'
    })
    expect(r.edits.captions[0].end_ms).toBeGreaterThan(4000)
  })
  it('refuses an empty answer or a moment on a card', () => {
    expect(addAnswerAsCaption(base, 4000, '\n').refused).toBe('Write the answer first')
    expect(addAnswerAsCaption(withIntro, 3000 + 15_500, 'x').refused).toBe(
      'That moment is not in the finished video'
    )
  })
})
