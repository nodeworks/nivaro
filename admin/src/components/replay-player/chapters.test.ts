import { describe, expect, it } from 'vitest'
import { buildChapters, chapterIndexAt, chapterJump, chapterPath } from './chapters'

describe('chapterPath', () => {
  it('drops query string, hash and the rail label suffix', () => {
    expect(chapterPath('/items/orders?page=2#top')).toBe('/items/orders')
    expect(chapterPath('/items/orders · 12 s on page')).toBe('/items/orders')
    expect(chapterPath('')).toBe('')
  })
})

describe('buildChapters', () => {
  it('splits at every change of page from the recorder stamps', () => {
    const ch = buildChapters(
      [
        { offset: 40, text: '/home' },
        { offset: 5_000, text: '/home?tab=2' }, // same page — no new chapter
        { offset: 10_000, text: '/items/orders' },
        { offset: 70_000, text: '/home' }
      ],
      [],
      100_000
    )
    expect(ch).toEqual([
      { start: 0, end: 10_000, label: '/home' },
      { start: 10_000, end: 70_000, label: '/items/orders' },
      { start: 70_000, end: 100_000, label: '/home' }
    ])
  })

  it('merges page-trail rows with the stamps for the same navigation', () => {
    const ch = buildChapters(
      [
        { offset: 0, text: '/home' },
        { offset: 10_000, text: '/items/orders' }
      ],
      [
        { offset: -800, text: '/home · 10 s on page' },
        { offset: 11_200, text: '/items/orders · 30 s on page' }, // skewed copy
        { offset: 40_000, text: '/settings · 5 s on page' } // only the trail saw it
      ],
      60_000
    )
    expect(ch.map((c) => [c.start, c.label])).toEqual([
      [0, '/home'],
      [10_000, '/items/orders'],
      [40_000, '/settings']
    ])
  })

  it('names a chapter after where a redirect landed', () => {
    const ch = buildChapters(
      [
        { offset: 0, text: '/' },
        { offset: 200, text: '/home' },
        { offset: 20_000, text: '/login' },
        { offset: 20_300, text: '/home' } // bounced straight back
      ],
      [],
      30_000
    )
    expect(ch).toEqual([{ start: 0, end: 30_000, label: '/home' }])
  })

  it('works from the page trail alone (older recordings)', () => {
    const ch = buildChapters([], [{ offset: 3_000, text: '/a · 2 s on page' }], 10_000)
    expect(ch).toEqual([{ start: 0, end: 10_000, label: '/a' }])
  })

  it('is empty without a length or routes', () => {
    expect(buildChapters([{ offset: 0, text: '/a' }], [], 0)).toEqual([])
    expect(buildChapters([], [], 10_000)).toEqual([])
  })
})

describe('chapter navigation', () => {
  const ch = [
    { start: 0, end: 10_000, label: '/a' },
    { start: 10_000, end: 30_000, label: '/b' },
    { start: 30_000, end: 50_000, label: '/c' }
  ]

  it('finds the chapter under the playhead', () => {
    expect(chapterIndexAt(ch, 0)).toBe(0)
    expect(chapterIndexAt(ch, 9_999)).toBe(0)
    expect(chapterIndexAt(ch, 10_000)).toBe(1)
    expect(chapterIndexAt(ch, 49_000)).toBe(2)
    expect(chapterIndexAt([], 5)).toBe(-1)
  })

  it('. goes to the next chapter, and nowhere from the last', () => {
    expect(chapterJump(ch, 5_000, 'next')).toBe(10_000)
    expect(chapterJump(ch, 31_000, 'next')).toBeNull()
  })

  it(', goes back to this chapter’s start, or the one before when just started', () => {
    expect(chapterJump(ch, 20_000, 'prev')).toBe(10_000)
    expect(chapterJump(ch, 11_000, 'prev')).toBe(0)
    expect(chapterJump(ch, 500, 'prev')).toBe(0)
    expect(chapterJump([], 500, 'prev')).toBeNull()
  })
})
