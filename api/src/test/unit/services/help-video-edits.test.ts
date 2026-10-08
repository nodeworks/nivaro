import { describe, expect, it } from 'vitest'
import {
  captionsToVtt,
  EditsError,
  editedDuration,
  editedToSource,
  emptyEdits,
  hashEdits,
  isHiddenByCuts,
  normalizeEdits,
  sourceToEdited
} from '../../../services/help-video-edits.js'

const SRC = 60_000

describe('normalizeEdits', () => {
  it('defaults to one full segment', () => {
    const e = normalizeEdits({}, SRC)
    expect(e.segments).toEqual([{ start_ms: 0, end_ms: SRC, speed: 1 }])
    expect(e.v).toBe(1)
  })
  it('sorts, clamps and de-overlaps segments and snaps speeds', () => {
    const e = normalizeEdits(
      {
        segments: [
          { start_ms: 30_000, end_ms: 90_000, speed: 3 },
          { start_ms: -5, end_ms: 10_000, speed: 2 },
          { start_ms: 8_000, end_ms: 12_000, speed: 1.5 }
        ]
      },
      SRC
    )
    expect(e.segments).toEqual([
      { start_ms: 0, end_ms: 10_000, speed: 2 },
      { start_ms: 10_000, end_ms: 12_000, speed: 1.5 },
      { start_ms: 30_000, end_ms: SRC, speed: 1 }
    ])
  })
  it('refuses edits that keep less than one second', () => {
    expect(() =>
      normalizeEdits({ segments: [{ start_ms: 0, end_ms: 500, speed: 1 }] }, SRC)
    ).toThrow(EditsError)
    expect(() => normalizeEdits({ segments: [] }, SRC)).toThrow(
      'Keep at least one second of the recording'
    )
  })
  it('clamps rects into the frame and keeps zoom square in frame fractions', () => {
    const e = normalizeEdits(
      {
        annotations: [
          { type: 'box', start_ms: 0, end_ms: 1000, rect: { x: 0.9, y: -1, w: 0.5, h: 0.2 } }
        ],
        zooms: [
          { start_ms: 0, end_ms: 4000, rect: { x: 0.2, y: 0.2, w: 0.5, h: 0.3 }, ease_ms: 9999 }
        ]
      },
      SRC
    )
    expect(e.annotations[0].rect).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.2 })
    expect(e.zooms[0].rect.w).toBe(e.zooms[0].rect.h)
    expect(e.zooms[0].ease_ms).toBe(2000) // at most half the zoom's length
  })
  it('drops overlapping zooms after the first', () => {
    const e = normalizeEdits(
      {
        zooms: [
          { start_ms: 0, end_ms: 5000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } },
          { start_ms: 4000, end_ms: 9000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }
        ]
      },
      SRC
    )
    expect(e.zooms).toHaveLength(1)
  })
  it('caps text length and item counts, drops unknown keys and bad types', () => {
    const long = 'x'.repeat(900)
    const e = normalizeEdits(
      {
        junk: true,
        captions: Array.from({ length: 1200 }, (_, i) => ({
          start_ms: i * 10,
          end_ms: i * 10 + 300,
          text: long
        })),
        annotations: [
          { type: 'laser', start_ms: 0, end_ms: 1000, rect: { x: 0, y: 0, w: 0.1, h: 0.1 } }
        ]
      },
      SRC
    )
    expect(e.captions).toHaveLength(1000)
    expect(e.captions[0].text).toHaveLength(500)
    expect(e.annotations).toHaveLength(0)
    expect((e as unknown as Record<string, unknown>).junk).toBeUndefined()
  })
  it('keeps given ids and generates missing ones', () => {
    const e = normalizeEdits(
      {
        chapters: [
          { id: 'c-1', at_ms: 0, title: 'Start' },
          { at_ms: 5000, title: 'Next' }
        ]
      },
      SRC
    )
    expect(e.chapters[0].id).toBe('c-1')
    expect(e.chapters[1].id).toMatch(/^[A-Za-z0-9_-]{6,40}$/)
  })
})

describe('time mapping', () => {
  const e = normalizeEdits(
    {
      segments: [
        { start_ms: 0, end_ms: 10_000, speed: 1 },
        { start_ms: 20_000, end_ms: 40_000, speed: 2 }
      ]
    },
    SRC
  )
  it('measures the edited length', () => expect(editedDuration(e)).toBe(20_000))
  it('maps source to edited time', () => {
    expect(sourceToEdited(e, 5_000)).toBe(5_000)
    expect(sourceToEdited(e, 15_000)).toBeNull()
    expect(sourceToEdited(e, 30_000)).toBe(15_000)
  })
  it('maps edited to source time', () => {
    expect(editedToSource(e, 5_000)).toBe(5_000)
    expect(editedToSource(e, 15_000)).toBe(30_000)
    expect(editedToSource(e, 99_999)).toBe(40_000)
  })
  it('flags items that sit entirely inside a cut', () => {
    expect(isHiddenByCuts(e, 11_000, 19_000)).toBe(true)
    expect(isHiddenByCuts(e, 9_000, 19_000)).toBe(false)
  })
})

describe('hashEdits', () => {
  it('ignores key order', () => {
    const a = emptyEdits(SRC)
    // Same content, top-level keys in reverse order (a replacer ARRAY would
    // also filter nested keys, emptying every segment — don't use one here).
    const b = Object.fromEntries(Object.entries(a).reverse())
    expect(hashEdits(a)).toBe(hashEdits(normalizeEdits(b, SRC)))
  })
})

describe('captionsToVtt', () => {
  it('writes captions in edited time and drops those inside cuts', () => {
    const e = normalizeEdits(
      {
        segments: [
          { start_ms: 0, end_ms: 10_000, speed: 1 },
          { start_ms: 20_000, end_ms: 40_000, speed: 2 }
        ],
        captions: [
          { start_ms: 1_000, end_ms: 2_500, text: 'Open the record' },
          { start_ms: 12_000, end_ms: 14_000, text: 'cut away' },
          { start_ms: 22_000, end_ms: 26_000, text: 'Faster now' }
        ]
      },
      SRC
    )
    expect(captionsToVtt(e)).toBe(
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nOpen the record\n\n2\n00:00:11.000 --> 00:00:13.000\nFaster now\n'
    )
  })
})
