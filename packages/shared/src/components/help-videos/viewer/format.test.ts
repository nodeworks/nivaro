import { describe, expect, it } from 'vitest'
import { nextLibraryPage } from '../api'
import type { HelpVideoDto, VideoEdits } from '../types'
import {
  emptyCopy,
  formatDuration,
  isGettingReady,
  listMeta,
  progressLabel,
  showButton,
  showingLabel,
  visibleChapters
} from './format'

const edits = (over: Partial<VideoEdits> = {}): VideoEdits => ({
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
  captions: [],
  ...over
})

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(187_000)).toBe('3:07')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
    expect(formatDuration(null)).toBe('—')
  })
})

describe('progressLabel', () => {
  const v = (p: HelpVideoDto['my_progress'], required = false) =>
    ({ my_progress: p, required }) as HelpVideoDto
  it('describes where the person is', () => {
    expect(progressLabel(v(null))).toEqual({ text: 'Not watched', done: false })
    expect(progressLabel(v(null, true))).toEqual({ text: 'Required — not watched', done: false })
    expect(progressLabel(v({ position_ms: 4000, completed: false, percent: 35 }))).toEqual({
      text: '35% watched',
      done: false
    })
    expect(progressLabel(v({ position_ms: 0, completed: true, percent: 95 }))).toEqual({
      text: 'Watched',
      done: true
    })
  })
})

describe('isGettingReady / listMeta', () => {
  const v = (playable: boolean | undefined, over: Partial<HelpVideoDto> = {}) =>
    ({
      duration_ms: 187_000,
      required: true,
      my_progress: null,
      published: playable === undefined ? null : { playable },
      ...over
    }) as unknown as HelpVideoDto
  it('is true only for a published version that is not playable yet', () => {
    expect(isGettingReady(v(false))).toBe(true)
    expect(isGettingReady(v(true))).toBe(false)
    expect(isGettingReady(v(undefined))).toBe(false)
  })
  it('says Getting ready instead of a duration that will not play, and never blames', () => {
    expect(listMeta(v(false))).toEqual({ text: 'Getting ready', overdue: false })
    expect(listMeta(v(true))).toEqual({ text: '3:07 · Required — not watched', overdue: true })
  })
})

describe('visibleChapters', () => {
  it('drops chapters inside cuts and maps the rest to the edited clock', () => {
    const c = visibleChapters(
      edits({
        chapters: [
          { id: 'b', at_ms: 24_000, title: 'Second' },
          { id: 'a', at_ms: 0, title: 'First' },
          { id: 'x', at_ms: 15_000, title: 'Cut away' }
        ]
      })
    )
    expect(c.map((x) => [x.title, x.edited_ms])).toEqual([
      ['First', 0],
      ['Second', 12_000]
    ])
  })
})

describe('showButton', () => {
  it('hides the button when there is nothing to watch and nothing to record', () => {
    expect(showButton(0, false)).toBe(false)
    expect(showButton(0, true)).toBe(true)
    expect(showButton(2, false)).toBe(true)
  })
})

describe('library paging', () => {
  const page = (n: number, total: number) => ({ data: new Array(n).fill(null) as never[], total })
  it('asks for the next page until everything is loaded', () => {
    expect(nextLibraryPage([page(24, 61)])).toBe(2)
    expect(nextLibraryPage([page(24, 61), page(24, 61)])).toBe(3)
    expect(nextLibraryPage([page(24, 61), page(24, 61), page(13, 61)])).toBeUndefined()
    expect(nextLibraryPage([page(24, 24)])).toBeUndefined()
    // an empty page never loops
    expect(nextLibraryPage([page(24, 61), page(0, 61)])).toBeUndefined()
  })
  it('says how much is showing only when there is more', () => {
    expect(showingLabel(24, 61)).toBe('Showing 24 of 61')
    expect(showingLabel(61, 61)).toBeNull()
  })
})

describe('emptyCopy', () => {
  const f = { search: '', status: 'published' as const, canAuthor: true }
  it('fits the reason the list is empty', () => {
    expect(emptyCopy({ ...f, search: 'zzz' })).toEqual({
      text: 'No videos match that search.',
      offerRecord: false
    })
    expect(emptyCopy({ ...f, category: 'Orders' }).offerRecord).toBe(false)
    expect(emptyCopy({ ...f, category: 'Orders' }).text).toBe('No videos in Orders.')
    expect(emptyCopy({ ...f, status: 'draft' }).text).toMatch(/^No drafts/)
    expect(emptyCopy({ ...f, status: 'archived' })).toEqual({
      text: 'Nothing is archived.',
      offerRecord: false
    })
  })
  it('offers recording only to authors with nothing at all', () => {
    expect(emptyCopy(f).offerRecord).toBe(true)
    expect(emptyCopy({ ...f, canAuthor: false })).toEqual({
      text: 'No videos yet.',
      offerRecord: false
    })
  })
})
