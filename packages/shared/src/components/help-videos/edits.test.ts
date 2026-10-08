import { describe, expect, it } from 'vitest'
import {
  EDIT_LIMITS,
  editedDuration,
  editedToSource,
  removeItem,
  removeSegment,
  segmentIndexAt,
  setSpeed,
  sourceToEdited,
  splitAt,
  trimSegment,
  upsertItem
} from './edits'
import type { Annotation, VideoEdits } from './types'

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

describe('splitAt', () => {
  it('splits the piece under the playhead', () => {
    const e = splitAt(base, 4000)
    expect(e.segments).toEqual([
      { start_ms: 0, end_ms: 4000, speed: 1 },
      { start_ms: 4000, end_ms: 10_000, speed: 1 }
    ])
  })
  it('does nothing within 100 ms of an edge or inside a cut', () => {
    expect(splitAt(base, 50).segments).toHaveLength(1)
    const cut = {
      ...base,
      segments: [
        { start_ms: 0, end_ms: 3000, speed: 1 as const },
        { start_ms: 5000, end_ms: 10_000, speed: 1 as const }
      ]
    }
    expect(splitAt(cut, 4000).segments).toHaveLength(2)
  })
})

describe('removeSegment', () => {
  it('cuts a piece out', () => {
    const e = removeSegment(splitAt(base, 4000), 0)
    expect(e.edits.segments).toEqual([{ start_ms: 4000, end_ms: 10_000, speed: 1 }])
    expect(editedDuration(e.edits)).toBe(6000)
  })
  it('refuses to remove the last second', () => {
    const r = removeSegment(base, 0)
    expect(r.refused).toBe('Keep at least one second of the recording')
    expect(r.edits).toBe(base)
  })
})

describe('setSpeed / trimSegment', () => {
  it('speeds a piece up', () => expect(editedDuration(setSpeed(base, 0, 2))).toBe(5000))
  it('trims within the source and neighbours', () => {
    const two = splitAt(base, 4000)
    expect(trimSegment(two, 1, { start_ms: 2000 }, 10_000).segments[1].start_ms).toBe(4000)
    expect(trimSegment(two, 1, { start_ms: 6000 }, 10_000).segments[1].start_ms).toBe(6000)
    expect(trimSegment(two, 1, { end_ms: 99_000 }, 10_000).segments[1].end_ms).toBe(10_000)
  })
})

describe('time mapping', () => {
  const e: VideoEdits = {
    ...base,
    segments: [
      { start_ms: 0, end_ms: 2000, speed: 1 },
      { start_ms: 4000, end_ms: 8000, speed: 2 }
    ]
  }
  it('maps both ways', () => {
    expect(sourceToEdited(e, 6000)).toBe(3000)
    expect(editedToSource(e, 3000)).toBe(6000)
    expect(segmentIndexAt(e, 3000)).toBe(-1)
    expect(segmentIndexAt(e, 7999)).toBe(1)
  })
})

describe('list items', () => {
  it('adds, replaces and removes by id', () => {
    let e = upsertItem(base, 'chapters', { id: 'c1', at_ms: 0, title: 'Start' })
    e = upsertItem(e, 'chapters', { id: 'c1', at_ms: 0, title: 'Begin' })
    expect(e.chapters).toEqual([{ id: 'c1', at_ms: 0, title: 'Begin' }])
    expect(removeItem(e, 'chapters', 'c1').chapters).toEqual([])
  })
})

// The server's normalizeEdits (api/src/services/help-video-edits.ts) is the
// source of truth; these keep the editor's working copy identical to it.
describe('mirrors the server EDIT_LIMITS', () => {
  it('uses the server values', () => {
    expect(EDIT_LIMITS).toEqual({
      annotations: 200,
      zooms: 50,
      blurs: 50,
      chapters: 100,
      captions: 1000,
      text: 500,
      chapterTitle: 120,
      minKeptMs: 1000,
      minItemMs: 200,
      minSegmentMs: 100,
      zoomMinSide: 0.25
    })
  })
  it('squares a zoom rect and clamps its side to at least 0.25', () => {
    const e = upsertItem(base, 'zooms', {
      id: 'z1',
      start_ms: 0,
      end_ms: 4000,
      rect: { x: 0.9, y: 0.05, w: 0.1, h: 0.05 },
      ease_ms: 400
    })
    expect(e.zooms[0].rect).toEqual({ x: 0.75, y: 0.05, w: 0.25, h: 0.25 })
  })
  it('keeps a zoom square on its longer side and inside the frame', () => {
    const e = upsertItem(base, 'zooms', {
      id: 'z1',
      start_ms: 0,
      end_ms: 4000,
      rect: { x: 0.7, y: 0.6, w: 0.3, h: 0.5 },
      ease_ms: 400
    })
    expect(e.zooms[0].rect).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  })
  it('caps a zoom ease at half its length', () => {
    const e = upsertItem(base, 'zooms', {
      id: 'z1',
      start_ms: 0,
      end_ms: 500,
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      ease_ms: 400
    })
    expect(e.zooms[0].ease_ms).toBe(250)
  })
  it('cuts text and chapter titles to the server lengths', () => {
    const long = 'x'.repeat(900)
    const a: Annotation = {
      id: 'a1',
      type: 'callout',
      start_ms: 0,
      end_ms: 1000,
      rect: { x: 0, y: 0, w: 0.2, h: 0.1 },
      to: null,
      text: long,
      tone: 'accent'
    }
    expect(upsertItem(base, 'annotations', a).annotations[0].text).toHaveLength(500)
    expect(
      upsertItem(base, 'chapters', { id: 'c', at_ms: 0, title: long }).chapters[0].title
    ).toHaveLength(120)
  })
  it('clamps blur strength to 2–40', () => {
    const b = { id: 'b', start_ms: 0, end_ms: 1000, rect: { x: 0, y: 0, w: 0.2, h: 0.1 } }
    expect(upsertItem(base, 'blurs', { ...b, strength: 90 }).blurs[0].strength).toBe(40)
    expect(upsertItem(base, 'blurs', { ...b, strength: 0 }).blurs[0].strength).toBe(2)
  })
  it('refuses a new item past the list cap but still replaces existing ones', () => {
    const chapters = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, at_ms: i, title: 'T' }))
    const full = { ...base, chapters }
    expect(upsertItem(full, 'chapters', { id: 'new', at_ms: 0, title: 'T' })).toBe(full)
    const e = upsertItem(full, 'chapters', { id: 'c3', at_ms: 3, title: 'Renamed' })
    expect(e.chapters[3].title).toBe('Renamed')
  })
})
