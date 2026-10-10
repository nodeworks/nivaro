import { describe, expect, it } from 'vitest'
import {
  bodyDuration,
  captionsToVtt,
  chapterBannerWindows,
  EDIT_LIMITS,
  EditsError,
  editedDuration,
  editedSpanToSource,
  editedToSource,
  hashEdits,
  heldAtMoment,
  holdAtEdited,
  isHiddenByCuts,
  normalizeEdits,
  normalizeHolds,
  pieceEditedMs,
  posterEditedMs,
  sourceToEdited,
  type VideoEdits
} from '../../../services/help-video-edits.js'

const SRC = 60_000

describe('zoom magnification limit', () => {
  it('raises a tiny zoom rect to the minimum side (at most 4x)', () => {
    const e = normalizeEdits(
      { zooms: [{ start_ms: 0, end_ms: 4000, rect: { x: 0.9, y: 0.9, w: 0.1, h: 0.1 } }] },
      SRC
    )
    expect(e.zooms[0].rect.w).toBe(EDIT_LIMITS.zoomMinSide)
    expect(e.zooms[0].rect.w).toBe(0.25)
    expect(e.zooms[0].rect.x).toBe(0.75)
  })
})

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
  // Hand-built objects: deliberately NOT passed through normalizeEdits, which
  // would rebuild keys in a fixed order and hide a missing sort.
  const a = {
    v: 1,
    segments: [{ start_ms: 0, end_ms: 5000, speed: 1 }],
    poster_ms: 0,
    chapters: [],
    annotations: [],
    zooms: [
      { id: 'z1', start_ms: 0, end_ms: 2000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, ease_ms: 100 }
    ],
    blurs: [],
    captions: []
  } as unknown as VideoEdits
  const b = {
    captions: [],
    blurs: [],
    zooms: [
      { ease_ms: 100, rect: { h: 0.5, w: 0.5, y: 0, x: 0 }, end_ms: 2000, start_ms: 0, id: 'z1' }
    ],
    annotations: [],
    chapters: [],
    poster_ms: 0,
    segments: [{ speed: 1, end_ms: 5000, start_ms: 0 }],
    v: 1
  } as unknown as VideoEdits
  it('ignores key order, top-level and nested', () => {
    expect(hashEdits(a)).toBe(hashEdits(b))
  })
  it('changes when a value changes', () => {
    const c = { ...b, poster_ms: 1 } as VideoEdits
    expect(hashEdits(c)).not.toBe(hashEdits(a))
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

describe('card motion settings', () => {
  const SRC = 10_000
  it('keeps chosen motion and drops none / cut / junk', () => {
    const e = normalizeEdits(
      {
        intro: { enabled: true, duration_ms: 3000, animation: 'lively', transition: 'wipe' },
        outro: { enabled: true, duration_ms: 3000, animation: 'none', transition: 'cut' },
        chapter_banners: true,
        banner_animation: 'subtle'
      },
      SRC
    )
    expect(e.intro).toMatchObject({ animation: 'lively', transition: 'wipe' })
    expect('animation' in (e.outro ?? {})).toBe(false)
    expect('transition' in (e.outro ?? {})).toBe(false)
    expect(e.banner_animation).toBe('subtle')
    const junk = normalizeEdits(
      { intro: { enabled: true, animation: 'spin', transition: 'iris' } },
      SRC
    )
    expect('animation' in (junk.intro ?? {})).toBe(false)
    expect('transition' in (junk.intro ?? {})).toBe(false)
  })
  it('drops banner_animation while banners are off', () => {
    expect('banner_animation' in normalizeEdits({ banner_animation: 'lively' }, SRC)).toBe(false)
  })
  it('hashes old edits exactly as before', () => {
    const old = normalizeEdits(
      { intro: { enabled: true, duration_ms: 3000 }, chapter_banners: true },
      SRC
    )
    expect(JSON.stringify(old)).not.toMatch(/animation|transition/)
    // The literal hash pins the stored shape: record it from main before this change.
    expect(hashEdits(old)).toBe('8ffba52fe95cab2f2f6ce11e2c970342fa48375b')
  })
})

describe('held frames (#1537)', () => {
  const segments = [
    { start_ms: 0, end_ms: 10_000, speed: 1 },
    { start_ms: 20_000, end_ms: 40_000, speed: 2 }
  ]
  it('stores holds sorted, clamped, inside kept pieces, one per moment, at most 50', () => {
    const e = normalizeEdits(
      {
        segments,
        holds: [
          { id: 'b', at_ms: 30_000, hold_ms: 1000 },
          { id: 'a', at_ms: 5000.4, hold_ms: 99_000 },
          { id: 'cut', at_ms: 15_000, hold_ms: 1000 },
          { id: 'end', at_ms: 40_000, hold_ms: 1000 },
          { id: 'dup', at_ms: 5000, hold_ms: 500 },
          { id: 'short', at_ms: 1000, hold_ms: 10 },
          { id: 'bad', at_ms: 'x', hold_ms: 'y' },
          'junk'
        ]
      },
      SRC
    )
    expect(e.holds).toEqual([
      { id: 'bad', at_ms: 0, hold_ms: EDIT_LIMITS.holdDefaultMs },
      { id: 'short', at_ms: 1000, hold_ms: EDIT_LIMITS.holdMinMs },
      { id: 'a', at_ms: 5000, hold_ms: EDIT_LIMITS.holdMaxMs },
      { id: 'b', at_ms: 30_000, hold_ms: 1000 }
    ])
    const many = normalizeEdits(
      { holds: Array.from({ length: 60 }, (_, i) => ({ at_ms: i * 100, hold_ms: 500 })) },
      SRC
    )
    expect(many.holds).toHaveLength(EDIT_LIMITS.holds)
    expect(normalizeHolds([{ at_ms: 5, hold_ms: 5 }], [], SRC)).toEqual([])
  })
  it('stores no key without holds, so a video without them keeps its hash', () => {
    const plain = normalizeEdits({ segments }, SRC)
    expect('holds' in plain).toBe(false)
    expect(hashEdits(normalizeEdits({ segments, holds: [] }, SRC))).toBe(hashEdits(plain))
    expect(hashEdits(normalizeEdits({ segments, holds: [{ at_ms: 15_000 }] }, SRC))).toBe(
      hashEdits(plain)
    )
    expect(hashEdits(normalizeEdits({ segments, holds: [{ at_ms: 5000 }] }, SRC))).not.toBe(
      hashEdits(plain)
    )
  })
  const e = normalizeEdits(
    {
      segments,
      holds: [
        { id: 'h1', at_ms: 5000, hold_ms: 2000 },
        { id: 'h2', at_ms: 30_000, hold_ms: 1000 }
      ],
      captions: [
        { id: 'k1', start_ms: 4000, end_ms: 5000, text: 'ends on the held frame' },
        { id: 'k2', start_ms: 4500, end_ms: 6000, text: 'spans the hold' },
        { id: 'k3', start_ms: 29_000, end_ms: 32_000, text: 'at double speed' }
      ]
    },
    SRC
  )
  it('adds edited time with no source advance, like slow motion', () => {
    expect(bodyDuration(e)).toBe(23_000)
    expect(editedDuration(e)).toBe(23_000)
    expect(pieceEditedMs(e, e.segments[1])).toBe(11_000)
  })
  it('maps source to edited time past each hold, and back through the held frame', () => {
    expect(sourceToEdited(e, 5000)).toBe(5000)
    expect(sourceToEdited(e, 6000)).toBe(8000)
    expect(sourceToEdited(e, 30_000)).toBe(17_000)
    expect(sourceToEdited(e, 32_000)).toBe(19_000)
    expect(editedToSource(e, 6999)).toBe(5000)
    expect(editedToSource(e, 7000)).toBe(5000)
    expect(editedToSource(e, 8000)).toBe(6000)
    expect(editedToSource(e, 17_500)).toBe(30_000)
    expect(editedToSource(e, 19_000)).toBe(32_000)
    expect(holdAtEdited(e, 6500)).toEqual({ hold: e.holds?.[0], start_ms: 5000, at: 1500 })
    expect(holdAtEdited(e, 7000)).toBeNull()
    expect(heldAtMoment(e, 5000)).toBe(2000)
    expect(heldAtMoment(e, 5001)).toBe(0)
    expect(editedSpanToSource(e, 4000, 8000)).toEqual([{ start_ms: 4000, end_ms: 6000 }])
    expect(posterEditedMs({ ...e, poster_ms: 6000 })).toBe(8000)
  })
  it('keeps captions up through a hold, in edited time', () => {
    const vtt = captionsToVtt(e)
    expect(vtt).toContain('00:00:04.000 --> 00:00:07.000\nends on the held frame')
    expect(vtt).toContain('00:00:04.500 --> 00:00:08.000\nspans the hold')
    expect(vtt).toContain('00:00:16.500 --> 00:00:19.000\nat double speed')
  })
  it('banners land after a hold', () => {
    const b = normalizeEdits(
      {
        ...e,
        chapter_banners: true,
        chapters: [{ id: 'c', at_ms: 6000, title: 'After' }]
      },
      SRC
    )
    expect(chapterBannerWindows(b)).toEqual([
      { id: 'c', title: 'After', start_ms: 8000, end_ms: 10_500 }
    ])
  })
})
