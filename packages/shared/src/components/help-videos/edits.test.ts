import { describe, expect, it } from 'vitest'
import {
  addHoldAt,
  bodyDuration,
  EDIT_LIMITS,
  editedDuration,
  editedToSource,
  heldAtMoment,
  holdAtEdited,
  holdAtSource,
  holdsIn,
  pieceEditedMs,
  removeItem,
  removeSegment,
  segmentIndexAt,
  setBannerAnimation,
  setChapterBanners,
  setIntro,
  setOutro,
  setSpeed,
  sourceToEdited,
  splitAt,
  trimSegment,
  upsertItem,
  upsertItemChecked
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
      zoomMinSide: 0.25,
      zoomKeyframes: 40,
      zoomKeyframesTotal: 300,
      cardMinMs: 2000,
      cardMaxMs: 6000,
      cardDefaultMs: 3000,
      introTitle: 120,
      introSubtitle: 200,
      outroText: 200,
      cardBrand: 60,
      bannerMs: 2500,
      musicName: 120,
      musicMinVolume: 0.05,
      musicDefaultVolume: 0.25,
      fadeMs: 200,
      cropMinSide: 0.2,
      holds: 50,
      holdMinMs: 200,
      holdMaxMs: 10_000,
      holdDefaultMs: 3000
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

// Expected values below are what api/src/services/help-video-edits.ts
// normalizeEdits stores for the same input (checked by a parity script).
describe('upsertItem follows normalizeEdits', () => {
  const ann = (over: Partial<Annotation>): Annotation => ({
    id: 'a',
    type: 'callout',
    start_ms: 0,
    end_ms: 1000,
    rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
    to: null,
    text: 'Hi',
    tone: 'accent',
    ...over
  })
  const zr = { rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, ease_ms: 0 }
  it('refuses an item shorter than 200 ms, with the reason', () => {
    const r = upsertItemChecked(base, 'blurs', {
      id: 'b',
      start_ms: 1000,
      end_ms: 1150,
      rect: { x: 0, y: 0, w: 0.2, h: 0.2 },
      strength: 12
    })
    expect(r.edits).toBe(base)
    expect(r.refused).toBe('Make it at least 0.2 seconds long')
  })
  it('refuses a zoom that overlaps another, but lets a zoom move over its own old place', () => {
    const one = upsertItem(base, 'zooms', { id: 'z1', start_ms: 1000, end_ms: 3000, ...zr })
    const r = upsertItemChecked(one, 'zooms', { id: 'z2', start_ms: 2500, end_ms: 4000, ...zr })
    expect(r.edits).toBe(one)
    expect(r.refused).toBe('Zooms can’t overlap. Move it clear of the other zoom.')
    const moved = upsertItem(one, 'zooms', { id: 'z1', start_ms: 2000, end_ms: 3500, ...zr })
    expect(moved.zooms[0].start_ms).toBe(2000)
    const touching = upsertItem(one, 'zooms', { id: 'z2', start_ms: 3000, end_ms: 4000, ...zr })
    expect(touching.zooms).toHaveLength(2)
  })
  it('clamps annotation and blur rects like rect()', () => {
    const a = upsertItem(
      base,
      'annotations',
      ann({ rect: { x: 0.995, y: -0.2, w: 0.005, h: 1.4 } })
    )
    expect(a.annotations[0].rect).toEqual({ x: 0.99, y: 0, w: 0.01, h: 1 })
    const b = upsertItem(base, 'blurs', {
      id: 'b',
      start_ms: 0,
      end_ms: 1000,
      rect: { x: 0.9, y: 0.95, w: 0.3, h: 0.3 },
      strength: 12
    })
    expect(b.blurs[0].rect).toEqual({ x: 0.7, y: 0.7, w: 0.3, h: 0.3 })
  })
  it('keeps text only on callouts and boxes, and a target only on arrows', () => {
    const ripple = upsertItem(base, 'annotations', ann({ type: 'ripple', to: { x: 1, y: 1 } }))
    expect(ripple.annotations[0]).toMatchObject({ text: '', to: null })
    const arrow = upsertItem(base, 'annotations', ann({ type: 'arrow', to: { x: 1.4, y: -1 } }))
    expect(arrow.annotations[0]).toMatchObject({ text: '', to: { x: 1, y: 0 } })
    const bare = upsertItem(base, 'annotations', ann({ type: 'arrow', to: null }))
    expect(bare.annotations[0].to).toEqual({ x: 0.5, y: 0.5 })
    expect(upsertItem(base, 'annotations', ann({ type: 'box' })).annotations[0].text).toBe('Hi')
  })
  it('sorts chapters, captions and zooms by start, and keeps annotation order', () => {
    let e = upsertItem(base, 'chapters', { id: 'c2', at_ms: 5000, title: 'Later' })
    e = upsertItem(e, 'chapters', { id: 'c1', at_ms: 1000, title: 'Sooner' })
    expect(e.chapters.map((c) => c.id)).toEqual(['c1', 'c2'])
    e = upsertItem(e, 'captions', { id: 'k2', start_ms: 4000, end_ms: 5000, text: 'B' })
    e = upsertItem(e, 'captions', { id: 'k1', start_ms: 1000, end_ms: 2000, text: 'A' })
    expect(e.captions.map((c) => c.id)).toEqual(['k1', 'k2'])
    e = upsertItem(e, 'zooms', { id: 'z2', start_ms: 6000, end_ms: 7000, ...zr })
    e = upsertItem(e, 'zooms', { id: 'z1', start_ms: 1000, end_ms: 2000, ...zr })
    expect(e.zooms.map((x) => x.id)).toEqual(['z1', 'z2'])
    e = upsertItem(e, 'annotations', ann({ id: 'a2', start_ms: 5000, end_ms: 6000 }))
    e = upsertItem(e, 'annotations', ann({ id: 'a1' }))
    expect(e.annotations.map((x) => x.id)).toEqual(['a2', 'a1'])
  })
  it('rounds times and never goes below zero', () => {
    const e = upsertItem(base, 'captions', { id: 'k', start_ms: -40.4, end_ms: 999.6, text: 'A' })
    expect(e.captions[0]).toMatchObject({ start_ms: 0, end_ms: 1000 })
  })
  it('does not trim a chapter title while it is being typed', () => {
    const e = upsertItem(base, 'chapters', { id: 'c', at_ms: 0, title: 'Intro ' })
    expect(e.chapters[0].title).toBe('Intro ')
  })
  it('says why a new item past the cap is refused', () => {
    const chapters = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, at_ms: i, title: 'T' }))
    const r = upsertItemChecked({ ...base, chapters }, 'chapters', {
      id: 'n',
      at_ms: 0,
      title: 'T'
    })
    expect(r.refused).toBe('There can be at most 100 of these')
  })
})

describe('card motion setters', () => {
  it('starts a new card subtle with a fade', () => {
    const e = setIntro(base, {})
    expect(e.intro).toMatchObject({ animation: 'subtle', transition: 'fade' })
  })
  it('keeps an old card without motion when another field changes', () => {
    const old = {
      ...base,
      intro: {
        enabled: true as const,
        duration_ms: 3000,
        show_chapters: false,
        title: '',
        subtitle: ''
      }
    }
    const e = setIntro(old, { title: 'x' })
    expect('animation' in (e.intro ?? {})).toBe(false)
    expect('transition' in (e.intro ?? {})).toBe(false)
  })
  it('stores none / cut as absent', () => {
    const e = setOutro(setOutro(base, {}), { animation: 'none', transition: 'cut' })
    expect('animation' in (e.outro ?? {})).toBe(false)
    expect('transition' in (e.outro ?? {})).toBe(false)
  })
  it('turns banner animation on with banners and drops it with them', () => {
    const on = setChapterBanners(base, true)
    expect(on.banner_animation).toBe('subtle')
    expect(setBannerAnimation(on, 'lively').banner_animation).toBe('lively')
    expect('banner_animation' in setBannerAnimation(on, 'none')).toBe(false)
    expect('banner_animation' in setChapterBanners(on, false)).toBe(false)
  })
})

describe('held frames (#1537)', () => {
  const e: VideoEdits = {
    ...base,
    segments: [
      { start_ms: 0, end_ms: 10_000, speed: 1 },
      { start_ms: 20_000, end_ms: 40_000, speed: 2 }
    ],
    holds: [
      { id: 'h2', at_ms: 30_000, hold_ms: 1000 },
      { id: 'h1', at_ms: 5000, hold_ms: 2000 },
      { id: 'hx', at_ms: 15_000, hold_ms: 9000 } // inside the cut: counts for nothing
    ]
  }
  it('adds edited time with no source advance, like slow motion', () => {
    expect(bodyDuration(e)).toBe(23_000)
    expect(editedDuration(e)).toBe(23_000)
    expect(pieceEditedMs(e, e.segments[0])).toBe(12_000)
    expect(holdsIn(e, e.segments[1]).map((h) => h.id)).toEqual(['h2'])
  })
  it('maps source to edited time past each hold', () => {
    expect(sourceToEdited(e, 4000)).toBe(4000)
    expect(sourceToEdited(e, 5000)).toBe(5000) // the hold's own start
    expect(sourceToEdited(e, 6000)).toBe(8000)
    expect(sourceToEdited(e, 30_000)).toBe(17_000)
    expect(sourceToEdited(e, 32_000)).toBe(19_000)
    expect(sourceToEdited(e, 15_000)).toBeNull()
  })
  it('maps edited time back: the held frame itself through the hold', () => {
    expect(editedToSource(e, 4000)).toBe(4000)
    expect(editedToSource(e, 5000)).toBe(5000)
    expect(editedToSource(e, 6999)).toBe(5000)
    expect(editedToSource(e, 7000)).toBe(5000)
    expect(editedToSource(e, 8000)).toBe(6000)
    expect(editedToSource(e, 17_500)).toBe(30_000)
    expect(editedToSource(e, 19_000)).toBe(32_000)
  })
  it('knows which hold an edited moment is frozen in', () => {
    expect(holdAtEdited(e, 6500)).toEqual({
      hold: { id: 'h1', at_ms: 5000, hold_ms: 2000 },
      start_ms: 5000,
      at: 1500
    })
    expect(holdAtEdited(e, 7000)).toBeNull()
    expect(holdAtEdited(e, 4000)).toBeNull()
    expect(holdAtEdited(e, 17_200)?.hold.id).toBe('h2')
    expect(holdAtSource(e, 5000)?.id).toBe('h1')
    expect(holdAtSource(e, 15_000)).toBeNull()
    expect(heldAtMoment(e, 5000)).toBe(2000)
    expect(heldAtMoment(e, 5001)).toBe(0)
  })
  it('adds a hold at the playhead, on a kept piece only, once per spot', () => {
    const r = addHoldAt(base, 3000)
    expect(r.refused).toBeUndefined()
    expect(r.edits.holds).toEqual([{ id: r.id, at_ms: 3000, hold_ms: 3000 }])
    const again = addHoldAt(r.edits, 3200)
    expect(again.refused).toBe('A hold already sits here')
    expect(again.id).toBe(r.id)
    expect(again.edits).toBe(r.edits)
    expect(addHoldAt(e, 15_000).refused).toMatch(/part viewers see/)
    // The very end of a piece holds its last frame.
    expect(addHoldAt(base, 10_000).edits.holds?.[0].at_ms).toBe(9999)
  })
  it('stores holds normalised and sorted, and refuses one off the kept pieces', () => {
    const r = upsertItemChecked(base, 'holds', { id: 'a', at_ms: 8000.4, hold_ms: 99_000 })
    expect(r.edits.holds).toEqual([{ id: 'a', at_ms: 8000, hold_ms: EDIT_LIMITS.holdMaxMs }])
    const r2 = upsertItemChecked(r.edits, 'holds', { id: 'b', at_ms: 1000, hold_ms: 10 })
    expect(r2.edits.holds?.map((h) => [h.id, h.hold_ms])).toEqual([
      ['b', EDIT_LIMITS.holdMinMs],
      ['a', EDIT_LIMITS.holdMaxMs]
    ])
    const off = upsertItemChecked(r2.edits, 'holds', { id: 'c', at_ms: 10_000, hold_ms: 500 })
    expect(off.refused).toBe('A hold has to sit on a part viewers see')
    expect(off.edits).toBe(r2.edits)
  })
  it('removing the last hold removes the key, so the edits are as they were', () => {
    const r = upsertItem(base, 'holds', { id: 'a', at_ms: 8000, hold_ms: 1000 })
    expect(removeItem(r, 'holds', 'a')).toEqual(base)
    expect('holds' in removeItem(r, 'holds', 'a')).toBe(false)
  })
  it('mirrors the server hold limits', () => {
    expect(EDIT_LIMITS.holds).toBe(50)
    expect(EDIT_LIMITS.holdMinMs).toBe(200)
    expect(EDIT_LIMITS.holdMaxMs).toBe(10_000)
    expect(EDIT_LIMITS.holdDefaultMs).toBe(3000)
  })
})
