import { describe, expect, it } from 'vitest'
import {
  editsForPreview,
  isAutoLength,
  markAutoLength,
  newItemFor,
  shortForText,
  withTypedText
} from './editor/tools'
import {
  ALLOWED_SPEEDS,
  editedDuration,
  normalizeCrop,
  STEP_STYLE_DEFAULTS,
  setCrop,
  setSpeed,
  setStepStyle,
  stepNumbers,
  textDurationMs,
  zoomInView
} from './edits'
import { renderSizes, viewAt, zoomAt } from './playerMath'
import type { Annotation, VideoEdits } from './types'

// Slow motion (#1538), crop (#1544), steps (#1524) and length from text
// (#1554) on the client side. The server twin's tests
// (api help-video-crop-steps.test.ts) pin the same numbers.

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
const step = (id: string, start: number, y = 0.1): Annotation => ({
  id,
  type: 'step',
  start_ms: start,
  end_ms: start + 1000,
  rect: { x: 0.1, y, w: 0.2, h: 0.1 },
  to: null,
  text: '',
  tone: 'accent'
})

describe('slow motion', () => {
  it('offers 0.5x and doubles the piece', () => {
    expect(ALLOWED_SPEEDS).toEqual([0.5, 1, 1.5, 2, 4])
    expect(editedDuration(setSpeed(base, 0, 0.5))).toBe(20_000)
  })
})

describe('crop', () => {
  it('stores nothing for the whole frame, the server rule otherwise', () => {
    expect(setCrop(base, { x: 0, y: 0, w: 1, h: 1 })).toEqual(base)
    expect(normalizeCrop({ x: 0.95, y: -1, w: 0.05, h: 0.5 })).toEqual({
      x: 0.8,
      y: 0,
      w: 0.2,
      h: 0.5
    })
    const c = setCrop(base, { x: 0.2, y: 0, w: 0.8, h: 1 })
    expect(c.crop).toEqual({ x: 0.2, y: 0, w: 0.8, h: 1 })
    expect(setCrop(c, null)).toEqual(base)
  })
  it('sizes the picture like the render', () => {
    expect(renderSizes(1280, 720, undefined)).toEqual({
      work: { width: 1280, height: 720 },
      out: { width: 1280, height: 720 }
    })
    expect(renderSizes(2560, 1440, { x: 0.25, y: 0, w: 0.75, h: 1 })).toEqual({
      work: { width: 1920, height: 1080 },
      out: { width: 1440, height: 1080 }
    })
  })
  it('maps whole-frame fractions through crop then zoom', () => {
    const c = setCrop(base, { x: 0.5, y: 0, w: 0.5, h: 1 })
    const v = viewAt(c, 0)
    // the crop's left edge lands on the picture's left edge, its right on the right
    expect(0.5 * v.sx + v.ox).toBeCloseTo(0)
    expect(1 * v.sx + v.ox).toBeCloseTo(1)
    expect(v.sy).toBe(1)
    const zooms = [
      { id: 'z', start_ms: 0, end_ms: 2000, rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, ease_ms: 0 }
    ]
    expect(zoomInView({ ...c, zooms }, zooms[0].rect)).toEqual({ mag: 1, cx: 0.5, cy: 0.75 })
    // without a crop zoomAt is what it always was
    const plain = { ...base, zooms }
    expect(zoomAt(plain, 1000)).toEqual({ z: 2, tx: -1, ty: -1 })
    expect(viewAt(plain, 1000)).toEqual({ z: 2, sx: 2, sy: 2, ox: -1, oy: -1 })
  })
  it('shows the whole frame, unzoomed, while the crop tool is up', () => {
    const c = setCrop(base, { x: 0.5, y: 0, w: 0.5, h: 1 })
    expect(editsForPreview(c, null, 'crop').crop).toBeUndefined()
    expect(editsForPreview(c, null, 'callout')).toBe(c)
  })
})

describe('steps', () => {
  it('numbers steps in timeline order and renumbers when one moves', () => {
    const e = {
      ...base,
      annotations: [step('b', 3000), step('a', 1000, 0.5), step('c', 1000, 0.2)]
    }
    expect([...stepNumbers(e)]).toEqual([
      ['c', 1],
      ['a', 2],
      ['b', 3]
    ])
    const moved = {
      ...e,
      annotations: e.annotations.map((x) => (x.id === 'b' ? { ...x, start_ms: 0, end_ms: 900 } : x))
    }
    expect(stepNumbers(moved).get('b')).toBe(1)
  })
  it('stores the badge style only when it is not the default', () => {
    expect(setStepStyle(base, STEP_STYLE_DEFAULTS)).toEqual(base)
    const sq = setStepStyle(base, { shape: 'square' })
    expect(sq.step_style).toEqual({ shape: 'square', size: 'medium' })
    expect(setStepStyle(sq, { shape: 'circle' })).toEqual(base)
  })
})

describe('length from text', () => {
  it('reads about 3 words a second, never under 2 seconds', () => {
    expect(textDurationMs('')).toBe(2000)
    expect(textDurationMs('Click here')).toBe(2000)
    expect(textDurationMs('one two three four five six seven eight nine')).toBe(3000)
    expect(textDurationMs('a b c d e f g h i j')).toBe(3400)
  })
  it('follows the text of a new callout until its length is set by hand', () => {
    const { item } = newItemFor('callout', { x: 0, y: 0, w: 0.2, h: 0.1 }, 1000, 20_000)
    expect(item.end_ms - item.start_ms).toBe(2000)
    const longer = withTypedText(item, 'one two three four five six seven eight nine ten', 20_000)
    expect(longer.end_ms - longer.start_ms).toBe(3400)
    // set by hand: typing no longer moves it
    const byHand = { ...longer, end_ms: longer.start_ms + 2500 }
    expect(withTypedText(byHand, 'short', 20_000).end_ms).toBe(byHand.end_ms)
    expect(isAutoLength(byHand)).toBe(false)
  })
  it('never moves an item from an earlier session, nor past maxEnd', () => {
    const old = { id: 'old', start_ms: 0, end_ms: 3000, text: '' }
    expect(withTypedText(old, 'a b c d e f g h i j k l', 20_000).end_ms).toBe(3000)
    const fresh = { id: 'fresh', start_ms: 1000, end_ms: 3000, text: '' }
    markAutoLength(fresh)
    expect(withTypedText(fresh, 'a b c d e f g h i j k l', 4000).end_ms).toBe(4000)
  })
  it('says when an item is short for its text', () => {
    expect(shortForText({ start_ms: 0, end_ms: 2000, text: 'a b c d e f g h i j' })).toBe(3400)
    expect(shortForText({ start_ms: 0, end_ms: 4000, text: 'a b c d e f g h i j' })).toBeNull()
    expect(shortForText({ start_ms: 0, end_ms: 200, text: '  ' })).toBeNull()
  })
})
