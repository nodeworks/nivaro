import { describe, expect, it } from 'vitest'
import type { ClipDto, VideoEdits } from '../types'
import {
  clampClipRange,
  clipClock,
  clipLink,
  clipMeta,
  clipRangeAround,
  clipRangeForChapter,
  clipRangeForSelection,
  defaultClipLabel,
  formatBytes
} from './clips'

// #1562: choosing a clip's range (edited time) from chapters and the selection.

const edits: VideoEdits = {
  v: 1,
  segments: [
    { start_ms: 0, end_ms: 10_000, speed: 1 },
    { start_ms: 20_000, end_ms: 30_000, speed: 2 },
    { start_ms: 40_000, end_ms: 100_000, speed: 1 }
  ],
  poster_ms: 0,
  chapters: [
    { id: 'c1', at_ms: 0, title: 'Open the form' },
    { id: 'c2', at_ms: 15_000, title: 'Cut out' },
    { id: 'c3', at_ms: 22_000, title: 'Fill it in' },
    { id: 'c4', at_ms: 45_000, title: 'Approve' }
  ],
  annotations: [
    {
      id: 'a1',
      type: 'callout',
      start_ms: 8000,
      end_ms: 24_000,
      rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
      to: null,
      text: '',
      tone: 'accent'
    }
  ],
  zooms: [],
  blurs: [
    {
      id: 'b1',
      start_ms: 12_000,
      end_ms: 18_000,
      rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
      strength: 10
    }
  ],
  captions: []
}
// Edited: piece 1 = 0–10 s, piece 2 = 10–15 s (2x), piece 3 = 15–75 s.

describe('clampClipRange', () => {
  it('holds a range to the video and to 30 seconds', () => {
    expect(clampClipRange({ start_ms: -5, end_ms: 50_000 }, 75_000)).toEqual({
      start_ms: 0,
      end_ms: 30_000
    })
    expect(clampClipRange({ start_ms: 70_000, end_ms: 90_000 }, 75_000)).toEqual({
      start_ms: 70_000,
      end_ms: 75_000
    })
  })
  it('is null when under half a second is left', () => {
    expect(clampClipRange({ start_ms: 74_800, end_ms: 90_000 }, 75_000)).toBeNull()
  })
})

describe('clipRangeForChapter', () => {
  it('runs from the chapter to the next one viewers see, at most 30 s', () => {
    expect(clipRangeForChapter(edits, 'c1')).toEqual({ start_ms: 0, end_ms: 11_000 })
    expect(clipRangeForChapter(edits, 'c3')).toEqual({ start_ms: 11_000, end_ms: 20_000 })
    expect(clipRangeForChapter(edits, 'c4')).toEqual({ start_ms: 20_000, end_ms: 50_000 })
  })
  it('is null for a chapter inside a cut or an unknown one', () => {
    expect(clipRangeForChapter(edits, 'c2')).toBeNull()
    expect(clipRangeForChapter(edits, 'nope')).toBeNull()
  })
})

describe('clipRangeForSelection', () => {
  it('takes a piece at its speed', () => {
    expect(clipRangeForSelection(edits, { lane: 'cuts', index: 1 })).toEqual({
      start_ms: 10_000,
      end_ms: 15_000
    })
    expect(clipRangeForSelection(edits, { lane: 'cuts', index: 2 })).toEqual({
      start_ms: 15_000,
      end_ms: 45_000
    })
  })
  it('takes the kept part of a timed item, across a cut', () => {
    // The callout spans 8–24 s of source: 8–10 s kept (edited 8–10), 20–24 s at 2x (edited 10–12).
    expect(clipRangeForSelection(edits, { lane: 'annotations', id: 'a1' })).toEqual({
      start_ms: 8000,
      end_ms: 12_000
    })
  })
  it('is null for an item entirely cut out, a chapter in a cut, or nothing', () => {
    expect(clipRangeForSelection(edits, { lane: 'blurs', id: 'b1' })).toBeNull()
    expect(clipRangeForSelection(edits, { lane: 'chapters', id: 'c2' })).toBeNull()
    expect(clipRangeForSelection(edits, null)).toBeNull()
    expect(clipRangeForSelection(edits, { lane: 'cuts', index: 9 })).toBeNull()
  })
  it('takes a chapter through the chapter lane', () => {
    expect(clipRangeForSelection(edits, { lane: 'chapters', id: 'c3' })).toEqual({
      start_ms: 11_000,
      end_ms: 20_000
    })
  })
})

describe('clipRangeAround / defaultClipLabel', () => {
  it('centres ten seconds on the playhead, held to the video', () => {
    expect(clipRangeAround(30_000, 75_000)).toEqual({ start_ms: 25_000, end_ms: 35_000 })
    expect(clipRangeAround(2000, 75_000)).toEqual({ start_ms: 0, end_ms: 10_000 })
    expect(clipRangeAround(74_000, 75_000)).toEqual({ start_ms: 69_000, end_ms: 75_000 })
  })
  it('names a clip after the chapter it starts in, else its times', () => {
    expect(defaultClipLabel(edits, { start_ms: 20_000, end_ms: 25_000 })).toBe('Approve')
    expect(defaultClipLabel(edits, { start_ms: 12_000, end_ms: 14_000 })).toBe('Fill it in')
    expect(defaultClipLabel({ ...edits, chapters: [] }, { start_ms: 12_000, end_ms: 14_500 })).toBe(
      '0:12.0–0:14.5'
    )
    expect(clipClock(65_250)).toBe('1:05.3')
  })
})

describe('clipMeta / formatBytes / clipLink', () => {
  const base: ClipDto = {
    id: 'c',
    video_id: 'v',
    version_id: null,
    kind: 'gif',
    status: 'ready',
    progress: 100,
    error: null,
    start_ms: 1000,
    end_ms: 4500,
    label: null,
    bytes: 700_000,
    width: 640,
    height: 360,
    url: '/api/help-videos/v/clips/c?st=t',
    created_by: null,
    created_at: '2026-10-10T00:00:00Z'
  }
  it('says the kind, length and size, or the state', () => {
    expect(clipMeta(base)).toBe('GIF · 3.5 s · 684 KB')
    expect(clipMeta({ ...base, status: 'rendering', progress: 40 })).toBe('GIF · Making… 40%')
    expect(clipMeta({ ...base, status: 'queued' })).toBe('GIF · Waiting to be made')
    expect(clipMeta({ ...base, status: 'failed', error: 'No ffmpeg' })).toBe('GIF · No ffmpeg')
    expect(formatBytes(2_621_440)).toBe('2.5 MB')
    expect(formatBytes(null)).toBe('')
  })
  it('makes an absolute link from the API origin, else the page origin', () => {
    expect(clipLink('https://api.example.com/api', base.url as string, 'https://app')).toBe(
      'https://api.example.com/api/help-videos/v/clips/c?st=t'
    )
    expect(clipLink('/api', base.url as string, 'https://app')).toBe(
      'https://app/api/help-videos/v/clips/c?st=t'
    )
  })
})
