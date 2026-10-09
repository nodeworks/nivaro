import { describe, expect, it } from 'vitest'
import { bannerAt, cardAccent, firstLine, introContent, outroContent } from './cards'
import {
  bodyDuration,
  cardPhaseAt,
  chapterBannerWindows,
  editedDuration,
  editedToSource,
  OUTRO_DEFAULT_TEXT,
  setChapterBanners,
  setIntro,
  setOutro,
  sourceToEdited
} from './edits'
import { bucketIndex } from './playerMath'
import type { VideoEdits } from './types'
import { visibleChapters } from './viewer/format'

const base: VideoEdits = {
  v: 1,
  segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
}

// The same timeline as the server's help-video-cards.test.ts, with the same
// expected values: the two twins must agree.
const e: VideoEdits = {
  ...base,
  segments: [
    { start_ms: 0, end_ms: 4000, speed: 1 },
    { start_ms: 10_000, end_ms: 18_000, speed: 2 }
  ],
  intro: { enabled: true, duration_ms: 3000, show_chapters: true, title: '', subtitle: '' },
  outro: { enabled: true, duration_ms: 2000, text: '' },
  chapters: [
    { id: 'a', at_ms: 0, title: 'Start' },
    { id: 'b', at_ms: 1000, title: 'Close by' },
    { id: 'c', at_ms: 6000, title: 'Cut away' },
    { id: 'd', at_ms: 16_000, title: 'Late' }
  ],
  chapter_banners: true
}

describe('time mapping with cards (twin of the server)', () => {
  it('adds the card lengths to the edited duration', () => {
    expect(bodyDuration(e)).toBe(8000)
    expect(editedDuration(e)).toBe(13_000)
    expect(editedDuration(base)).toBe(10_000)
  })
  it('shifts source moments by the intro and pins cards to the ends', () => {
    expect(sourceToEdited(e, 0)).toBe(3000)
    expect(sourceToEdited(e, 12_000)).toBe(8000)
    expect(sourceToEdited(e, 6000)).toBeNull()
    expect(editedToSource(e, 1500)).toBe(0)
    expect(editedToSource(e, 8000)).toBe(12_000)
    expect(editedToSource(e, 12_500)).toBe(18_000)
  })
  it('names the part of the timeline', () => {
    expect(cardPhaseAt(e, 0)).toEqual({ phase: 'intro', at: 0 })
    expect(cardPhaseAt(e, 3000)).toEqual({ phase: 'body', at: 0 })
    expect(cardPhaseAt(e, 10_999)).toEqual({ phase: 'body', at: 7999 })
    expect(cardPhaseAt(e, 11_000)).toEqual({ phase: 'outro', at: 0 })
    expect(cardPhaseAt(base, 10_000)).toEqual({ phase: 'body', at: 10_000 })
  })
  it('places banners at visible chapters only', () => {
    expect(chapterBannerWindows(e)).toEqual([
      { id: 'a', title: 'Start', start_ms: 3000, end_ms: 4000 },
      { id: 'b', title: 'Close by', start_ms: 4000, end_ms: 6500 },
      { id: 'd', title: 'Late', start_ms: 10_000, end_ms: 11_000 }
    ])
    expect(bannerAt(e, 5000)).toEqual({ id: 'b', title: 'Close by' })
    expect(bannerAt(e, 7000)).toBeNull()
    expect(bannerAt({ ...e, chapter_banners: undefined }, 5000)).toBeNull()
  })
  it('chapter ticks and the list land after the intro', () => {
    expect(visibleChapters(e).map((c) => c.edited_ms)).toEqual([3000, 4000, 10_000])
  })
  it('progress sections span the cards too', () => {
    expect(bucketIndex(0, editedDuration(e))).toBe(0)
    expect(bucketIndex(12_999, editedDuration(e))).toBe(19)
  })
})

describe('switching cards on and off', () => {
  it('stores nothing while off, so untouched videos keep their edits', () => {
    const on = setIntro(base, {})
    expect(on.intro).toEqual({
      enabled: true,
      duration_ms: 3000,
      show_chapters: false,
      title: '',
      subtitle: ''
    })
    const off = setIntro(on, null)
    expect('intro' in off).toBe(false)
    expect(Object.keys(off).sort()).toEqual(Object.keys(base).sort())
    expect('chapter_banners' in setChapterBanners(setChapterBanners(base, true), false)).toBe(false)
    expect('outro' in setOutro(setOutro(base, {}), null)).toBe(false)
  })
  it('clamps lengths and keeps the other fields', () => {
    const a = setIntro(setIntro(base, { title: 'Hi' }), { duration_ms: 99_000 })
    expect(a.intro).toMatchObject({ title: 'Hi', duration_ms: 6000 })
    expect(setOutro(base, { duration_ms: 500 }).outro?.duration_ms).toBe(2000)
  })
})

describe('card content', () => {
  it('falls back to the title, the first description line and the default outro', () => {
    const c = introContent(e, { title: 'Approve', description: '\n  First line \nSecond' })
    expect(c).toEqual({
      title: 'Approve',
      subtitle: 'First line',
      chapters: ['Start', 'Close by', 'Late'],
      more: 0
    })
    expect(outroContent(e)).toBe(OUTRO_DEFAULT_TEXT)
    const own = setOutro(setIntro(e, { title: 'Own', show_chapters: false }), { text: 'Bye' })
    expect(introContent(own, { title: 'Approve', description: null }).title).toBe('Own')
    expect(introContent(own, { title: 'Approve', description: null }).chapters).toEqual([])
    expect(outroContent(own)).toBe('Bye')
  })
  it('lists at most six chapters', () => {
    const many = {
      ...e,
      segments: [{ start_ms: 0, end_ms: 20_000, speed: 1 as const }],
      chapters: Array.from({ length: 9 }, (_, i) => ({
        id: `c${i}`,
        at_ms: i * 100,
        title: `S${i}`
      }))
    }
    const c = introContent(many, { title: 'T', description: null })
    expect(c.chapters).toHaveLength(6)
    expect(c.more).toBe(3)
  })
  it('keeps the accent a #rrggbb colour', () => {
    expect(cardAccent('#AB12CD')).toBe('#ab12cd')
    expect(cardAccent('nope')).toBe('#00ceff')
    expect(firstLine(undefined)).toBe('')
  })
})
