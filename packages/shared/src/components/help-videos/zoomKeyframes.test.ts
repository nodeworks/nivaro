import { describe, expect, it } from 'vitest'
import { viewersWaitForRender } from './editor/publish'
import { reshapeItemAt, shapeRectAt } from './editor/tools'
import {
  EDIT_LIMITS,
  normalizeZoomKeyframes,
  removeZoomKeyframe,
  setCursor,
  setZoomKeyframe,
  upsertItemChecked,
  zoomRectAt
} from './edits'
import { viewAt, zoomAt } from './playerMath'
import type { VideoEdits, Zoom } from './types'

// Moving zooms (#1539) in the client twin of the server rules, and the
// cursor switches (#1517).

const sq = (x: number, y: number, w = 0.5) => ({ x, y, w, h: w })
const base: VideoEdits = {
  v: 1,
  segments: [{ start_ms: 0, end_ms: 20_000, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
}
const still: Zoom = { id: 'z', start_ms: 1000, end_ms: 5000, rect: sq(0, 0), ease_ms: 0 }
const moving: Zoom = {
  ...still,
  keyframes: [
    { at_ms: 2000, rect: sq(0, 0) },
    { at_ms: 4000, rect: sq(0.4, 0.2) }
  ]
}

describe('normalizeZoomKeyframes (client)', () => {
  it('sorts, clamps into the span, squares, de-duplicates and caps', () => {
    expect(
      normalizeZoomKeyframes(
        [
          { at_ms: 9000, rect: { x: 0, y: 0, w: 0.4, h: 0.2 } },
          { at_ms: 500, rect: sq(0.9, 0.9, 0.1) },
          { at_ms: 500, rect: sq(0.1, 0.1) }
        ],
        { start_ms: 1000, end_ms: 5000 }
      )
    ).toEqual([
      { at_ms: 1000, rect: sq(0.75, 0.75, 0.25) },
      { at_ms: 5000, rect: sq(0, 0, 0.4) }
    ])
    const many = Array.from({ length: 100 }, (_, i) => ({ at_ms: i, rect: sq(0, 0) }))
    expect(normalizeZoomKeyframes(many, { start_ms: 0, end_ms: 100 })).toHaveLength(
      EDIT_LIMITS.zoomKeyframes
    )
    expect(
      normalizeZoomKeyframes([{ at_ms: 1, rect: sq(0, 0) }], { start_ms: 0, end_ms: 1 })
    ).toBeNull()
  })
  it('upsertItemChecked stores the stops and makes the area the first stop', () => {
    const e = upsertItemChecked(base, 'zooms', { ...moving, rect: sq(0.3, 0.3) }).edits
    expect(e.zooms[0].rect).toEqual(sq(0, 0))
    expect(e.zooms[0].keyframes).toEqual(moving.keyframes)
    const one = upsertItemChecked(base, 'zooms', {
      ...still,
      keyframes: [{ at_ms: 3000, rect: sq(0.2, 0.2) }]
    }).edits
    expect(one.zooms[0].keyframes).toBeUndefined()
    expect('keyframes' in one.zooms[0]).toBe(false)
  })
})

describe('zoomRectAt', () => {
  it('blends between stops and holds outside them', () => {
    expect(zoomRectAt(still, 3000)).toBe(still.rect)
    expect(zoomRectAt(moving, 1500)).toEqual(sq(0, 0))
    expect(zoomRectAt(moving, 3000)).toEqual(sq(0.2, 0.1))
    expect(zoomRectAt(moving, 4999)).toEqual(sq(0.4, 0.2))
  })
  it('drives the player view (zoomAt / viewAt)', () => {
    const e = { ...base, zooms: [moving] }
    const v = zoomAt(e, 3000)
    expect(v.z).toBeCloseTo(2)
    expect(v.tx).toBeCloseTo(0.5 - 0.45 * 2)
    expect(viewAt(e, 500)).toEqual({ z: 1, sx: 1, sy: 1, ox: 0, oy: 0 })
  })
})

describe('setZoomKeyframe / removeZoomKeyframe', () => {
  it('a still zoom moved at its start just moves', () => {
    const z = setZoomKeyframe(still, 1000, sq(0.3, 0.3))
    expect(z.rect).toEqual(sq(0.3, 0.3))
    expect(z.keyframes).toBeUndefined()
  })
  it('a still zoom moved later gets two stops: its old area, then the new one', () => {
    const z = setZoomKeyframe(still, 3000, sq(0.3, 0.3))
    expect(z.keyframes).toEqual([
      { at_ms: 1000, rect: sq(0, 0) },
      { at_ms: 3000, rect: sq(0.3, 0.3) }
    ])
  })
  it('a moving zoom replaces the stop at that moment or gains one, area = first', () => {
    const replaced = setZoomKeyframe(moving, 2000, sq(0.1, 0.1))
    expect(replaced.keyframes).toEqual([
      { at_ms: 2000, rect: sq(0.1, 0.1) },
      { at_ms: 4000, rect: sq(0.4, 0.2) }
    ])
    expect(replaced.rect).toEqual(sq(0.1, 0.1))
    const added = setZoomKeyframe(moving, 3000, sq(0.2, 0.2))
    expect(added.keyframes?.map((k) => k.at_ms)).toEqual([2000, 3000, 4000])
    // Outside the span the moment is clamped to it.
    expect(setZoomKeyframe(moving, 99_000, sq(0, 0)).keyframes?.map((k) => k.at_ms)).toEqual([
      2000, 4000, 5000
    ])
  })
  it('removing down to one stop leaves a still zoom showing that area', () => {
    const z = removeZoomKeyframe(moving, 2000)
    expect(z.keyframes).toBeUndefined()
    expect(z.rect).toEqual(sq(0.4, 0.2))
    expect(removeZoomKeyframe(moving, 1234)).toBe(moving)
    const three = setZoomKeyframe(moving, 3000, sq(0.2, 0.2))
    expect(removeZoomKeyframe(three, 3000).keyframes).toEqual(moving.keyframes)
  })
})

describe('reshapeItemAt / shapeRectAt', () => {
  it('shows and moves a moving zoom at the playhead as a stop', () => {
    expect(shapeRectAt(moving, 'zooms', 3000)).toEqual(sq(0.2, 0.1))
    const z = reshapeItemAt(moving, 'zooms', 'move', 0.1, 0, 3000)
    expect(z.keyframes?.map((k) => k.at_ms)).toEqual([2000, 3000, 4000])
    expect(z.keyframes?.[1].rect).toEqual(sq(0.3, 0.1))
  })
  it('a still zoom moved at its start stays still; a blur just moves', () => {
    expect(reshapeItemAt(still, 'zooms', 'move', 0.1, 0.1, 1000)).toEqual({
      ...still,
      rect: sq(0.1, 0.1)
    })
    const blur = {
      id: 'b',
      start_ms: 0,
      end_ms: 1000,
      rect: { x: 0, y: 0, w: 0.2, h: 0.1 },
      strength: 8
    }
    expect(reshapeItemAt(blur, 'blurs', 'move', 0.1, 0, 500).rect).toEqual({
      x: 0.1,
      y: 0,
      w: 0.2,
      h: 0.1
    })
  })
})

describe('setCursor', () => {
  it('stores only the on switches, shortcuts never without the cursor', () => {
    expect(setCursor(base, { show: true })).toEqual({ ...base, cursor: { show: true } })
    const both = setCursor(setCursor(base, { show: true }), { shortcuts: true })
    expect(both.cursor).toEqual({ show: true, shortcuts: true })
    expect(setCursor(both, { shortcuts: false }).cursor).toEqual({ show: true })
    expect('cursor' in setCursor(both, { show: false })).toBe(false)
    expect('cursor' in setCursor(base, { shortcuts: true })).toBe(false)
  })
  it('makes viewers wait for the render', () => {
    expect(viewersWaitForRender(base, 20_000)).toBe(false)
    expect(viewersWaitForRender(setCursor(base, { show: true }), 20_000)).toBe(true)
  })
})
