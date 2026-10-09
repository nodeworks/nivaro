import { describe, expect, it } from 'vitest'
import { EDIT_LIMITS, upsertItemChecked } from '../edits'
import type { Annotation, VideoEdits, Zoom } from '../types'
import {
  arrowTailFor,
  clickRect,
  clicksToRipples,
  editsForPreview,
  newItemFor,
  rectFromPoints,
  reshapeItem,
  squareRect,
  typeAlongCaption,
  typeAlongCaptionChecked
} from './tools'

const empty: VideoEdits = {
  v: 1,
  segments: [{ start_ms: 0, end_ms: 20_000, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
}

describe('rectFromPoints / squareRect', () => {
  it('normalizes any drag direction', () =>
    expect(rectFromPoints({ x: 0.6, y: 0.5 }, { x: 0.2, y: 0.1 })).toEqual({
      x: 0.2,
      y: 0.1,
      w: 0.4,
      h: 0.4
    }))
  it('keeps a click-sized drag usable', () =>
    expect(rectFromPoints({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })).toEqual({
      x: 0.5,
      y: 0.5,
      w: 0.02,
      h: 0.02
    }))
  it('squares and keeps inside the frame', () =>
    expect(squareRect({ x: 0.9, y: 0.1, w: 0.3, h: 0.1 })).toEqual({
      x: 0.7,
      y: 0.1,
      w: 0.3,
      h: 0.3
    }))
  it('never squares below the smallest zoom the server keeps', () => {
    const r = squareRect({ x: 0.95, y: 0.9, w: 0.02, h: 0.05 })
    expect(r.w).toBe(EDIT_LIMITS.zoomMinSide)
    expect(r.h).toBe(EDIT_LIMITS.zoomMinSide)
    expect(r.x + r.w).toBeLessThanOrEqual(1)
    expect(r.y + r.h).toBeLessThanOrEqual(1)
  })
})

describe('newItemFor', () => {
  it('makes a 3-second callout at the playhead', () => {
    const r = newItemFor('callout', { x: 0, y: 0, w: 0.2, h: 0.1 }, 5000, 20_000)
    expect(r.key).toBe('annotations')
    expect(r.item).toMatchObject({
      type: 'callout',
      start_ms: 5000,
      end_ms: 8000,
      text: 'Click here',
      tone: 'accent'
    })
  })
  it('clamps to the end of the recording and squares zooms', () => {
    const r = newItemFor('zoom', { x: 0.1, y: 0.1, w: 0.4, h: 0.2 }, 19_000, 20_000)
    expect(r.item).toMatchObject({ start_ms: 19_000, end_ms: 20_000, rect: { w: 0.4, h: 0.4 } })
  })
  it('draws a small zoom at the smallest side, so saving never resizes it', () => {
    for (const rect of [
      { x: 0.5, y: 0.5, w: 0.02, h: 0.02 },
      { x: 0.98, y: 0.98, w: 0.02, h: 0.02 },
      { x: 0, y: 0.9, w: 0.1, h: 0.05 }
    ]) {
      const { key, item } = newItemFor('zoom', rect, 1000, 20_000)
      const z = item as Zoom
      expect(z.rect.w).toBeGreaterThanOrEqual(EDIT_LIMITS.zoomMinSide)
      expect(z.rect.w).toBe(z.rect.h)
      expect(z.rect.x + z.rect.w).toBeLessThanOrEqual(1)
      expect(z.rect.y + z.rect.h).toBeLessThanOrEqual(1)
      // What the editor stores is exactly what was drawn.
      const stored = upsertItemChecked(empty, key as 'zooms', z)
      expect(stored.refused).toBeUndefined()
      expect(stored.edits.zooms[0]).toEqual(z)
    }
  })
  it('makes a short ripple and an arrow that points where it was dragged', () => {
    const ripple = newItemFor('ripple', { x: 0.4, y: 0.4, w: 0.05, h: 0.05 }, 1000, 20_000)
    expect(ripple.item).toMatchObject({ type: 'ripple', start_ms: 1000, end_ms: 1900, text: '' })
    const arrow = newItemFor('arrow', { x: 0.1, y: 0.1, w: 0.02, h: 0.02 }, 0, 20_000, {
      x: 0.5,
      y: 0.6
    })
    expect(arrow.item).toMatchObject({ type: 'arrow', to: { x: 0.5, y: 0.6 } })
  })
})

describe('clickRect / arrowTailFor', () => {
  it('centres a usable default shape on a click, inside the frame', () => {
    expect(clickRect('callout', { x: 0.5, y: 0.5 })).toEqual({ x: 0.39, y: 0.46, w: 0.22, h: 0.08 })
    const corner = clickRect('blur', { x: 1, y: 1 })
    expect(corner.x + corner.w).toBeLessThanOrEqual(1)
    expect(corner.y + corner.h).toBeLessThanOrEqual(1)
    const zoom = clickRect('zoom', { x: 0.5, y: 0.5 })
    expect(zoom.w).toBe(zoom.h)
    expect(zoom.w).toBeGreaterThanOrEqual(EDIT_LIMITS.zoomMinSide)
  })
  it('starts a clicked arrow toward the middle of the frame', () => {
    const tail = arrowTailFor({ x: 0.9, y: 0.9 })
    expect(tail.x).toBeLessThan(0.9)
    expect(tail.y).toBeLessThan(0.9)
    const fromMiddle = arrowTailFor({ x: 0.5, y: 0.5 })
    expect(fromMiddle.x).toBeLessThan(0.5)
  })
})

describe('clicksToRipples', () => {
  it('turns clicks into ripples centred on them, skipping duplicates', () => {
    const out = clicksToRipples(
      [
        { t_ms: 1000, x: 0.5, y: 0.5 },
        { t_ms: 5000, x: 0.1, y: 0.2 }
      ],
      [
        {
          id: 'r',
          type: 'ripple',
          start_ms: 4900,
          end_ms: 5800,
          rect: { x: 0, y: 0, w: 0.05, h: 0.05 },
          to: null,
          text: '',
          tone: 'accent'
        }
      ]
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'ripple',
      start_ms: 1000,
      end_ms: 1900,
      rect: { x: 0.475, y: 0.475, w: 0.05, h: 0.05 }
    })
  })
  it('handles no clicks', () => expect(clicksToRipples(null, [])).toEqual([]))
  it('handles clicks captured but none made', () => expect(clicksToRipples([], [])).toEqual([]))
  it('keeps ripples inside the recording', () => {
    const out = clicksToRipples(
      [
        { t_ms: 19_500, x: 0.5, y: 0.5 },
        { t_ms: 19_900, x: 0.5, y: 0.5 }
      ],
      [],
      20_000
    )
    // The second would be 0.1 s long: too short to keep.
    expect(out.map((a: Annotation) => [a.start_ms, a.end_ms])).toEqual([[19_500, 20_000]])
  })
})

describe('typeAlongCaption', () => {
  it('closes the open caption at the playhead and starts the next', () => {
    let e = typeAlongCaption(empty, 1000, 'First')
    e = typeAlongCaption(e, 2500, 'Second')
    expect(e.captions.map((c) => [c.start_ms, c.end_ms, c.text])).toEqual([
      [1000, 2500, 'First'],
      [2500, 5500, 'Second']
    ])
  })
  it('stops a new caption where the next one starts and at the end of the recording', () => {
    let e = typeAlongCaption(empty, 5000, 'Later')
    e = typeAlongCaption(e, 3000, 'Earlier')
    expect(e.captions.map((c) => [c.start_ms, c.end_ms])).toEqual([
      [3000, 5000],
      [5000, 8000]
    ])
    const end = typeAlongCaptionChecked(empty, 19_000, 'Last', 20_000)
    expect(end.edits.captions[0]).toMatchObject({ start_ms: 19_000, end_ms: 20_000 })
  })
  it('closes every caption open at the playhead, or refuses when one would be too short', () => {
    const two: VideoEdits = {
      ...empty,
      captions: [
        { id: 'k1', start_ms: 1000, end_ms: 6000, text: 'One' },
        { id: 'k2', start_ms: 2000, end_ms: 7000, text: 'Two' }
      ]
    }
    const e = typeAlongCaption(two, 4000, 'Three')
    expect(
      e.captions.map((c) => [c.id === 'k1' || c.id === 'k2' ? c.id : 'new', c.start_ms, c.end_ms])
    ).toEqual([
      ['k1', 1000, 4000],
      ['k2', 2000, 4000],
      ['new', 4000, 7000]
    ])
    const tooSoon = typeAlongCaptionChecked(two, 2100, 'Three')
    expect(tooSoon.refused).toMatch(/0\.2 seconds/)
    expect(tooSoon.edits).toBe(two)
  })
  it('refuses, with the reason, when there is no room', () => {
    const e = typeAlongCaption(empty, 1000, 'First')
    const tooSoon = typeAlongCaptionChecked(e, 1100, 'Second')
    expect(tooSoon.refused).toMatch(/0\.2 seconds/)
    expect(tooSoon.edits).toBe(e)
    const crowded = typeAlongCaptionChecked(typeAlongCaption(empty, 2000, 'Next'), 1900, 'Here')
    expect(crowded.refused).toMatch(/next caption/)
  })
})

describe('editsForPreview', () => {
  const zoomed: VideoEdits = {
    ...empty,
    zooms: [
      { id: 'z', start_ms: 0, end_ms: 3000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, ease_ms: 0 }
    ]
  }
  it('shows the whole picture while a zoom is selected, so it can be placed', () => {
    expect(editsForPreview(zoomed, { lane: 'zooms', id: 'z' }).zooms).toEqual([])
    expect(editsForPreview(zoomed, null)).toBe(zoomed)
    expect(editsForPreview(zoomed, { lane: 'annotations', id: 'z' })).toBe(zoomed)
  })
})

describe('reshapeItem', () => {
  const box = { id: 'b', start_ms: 0, end_ms: 1000, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }
  it('moves a shape and keeps it inside the frame', () => {
    expect(reshapeItem(box, 'blurs', 'move', 0.1, 0.05).rect).toEqual({
      x: 0.2,
      y: 0.15,
      w: 0.2,
      h: 0.2
    })
    expect(reshapeItem(box, 'blurs', 'move', 2, -2).rect).toEqual({ x: 0.8, y: 0, w: 0.2, h: 0.2 })
  })
  it('resizes from the corner, never below 0.02 or past the edge', () => {
    expect(reshapeItem(box, 'annotations', 'resize', -1, 0.1).rect).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.02,
      h: 0.3
    })
    expect(reshapeItem(box, 'annotations', 'resize', 5, 5).rect).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.9,
      h: 0.9
    })
  })
  it('keeps a zoom square and at least the smallest zoom', () => {
    const z = reshapeItem(
      { ...box, rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 } },
      'zooms',
      'resize',
      -0.3,
      0
    )
    expect(z.rect).toEqual({
      x: 0.1,
      y: 0.1,
      w: EDIT_LIMITS.zoomMinSide,
      h: EDIT_LIMITS.zoomMinSide
    })
  })
  it('moves an arrow whole, or just its tail or tip', () => {
    const arrow = { ...box, rect: { x: 0.2, y: 0.2, w: 0.02, h: 0.02 }, to: { x: 0.9, y: 0.5 } }
    const moved = reshapeItem(arrow, 'annotations', 'move', 0.3, 0)
    // The tip stops at the edge, and the arrow keeps its shape.
    expect(moved.rect.x).toBeCloseTo(0.3)
    expect(moved.to).toEqual({ x: 1, y: 0.5 })
    expect(reshapeItem(arrow, 'annotations', 'tip', -0.1, 0.1).to).toEqual({ x: 0.8, y: 0.6 })
    const tail = reshapeItem(arrow, 'annotations', 'tail', 0.1, 0)
    expect(tail.rect.x).toBeCloseTo(0.3)
    expect(tail.to).toEqual(arrow.to)
  })
})
