import { describe, expect, it } from 'vitest'
import { EDIT_LIMITS, upsertItemChecked } from './edits'
import { FOLLOW_STEP_MS, followPointerKeyframes } from './followPointer'
import type { PointerSample, VideoEdits, Zoom } from './types'

// "Follow the pointer" (#1540): stops made from the recorded pointer path.

const zoom: Zoom = {
  id: 'z',
  start_ms: 2000,
  end_ms: 4000,
  rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
  ease_ms: 300
}
/** A pointer sweeping from (0.2,0.5) to (0.8,0.5) over 2–4 s, 20 Hz. */
const sweep: PointerSample[] = Array.from({ length: 41 }, (_, i) => ({
  t_ms: 2000 + i * 50,
  x: 0.2 + (0.6 * i) / 40,
  y: 0.5
}))

describe('followPointerKeyframes', () => {
  it('needs a path and a pointer seen during the zoom', () => {
    expect(followPointerKeyframes(zoom, null)).toBeNull()
    expect(followPointerKeyframes(zoom, [])).toBeNull()
    // Seen only after the zoom: never inside it.
    expect(followPointerKeyframes(zoom, [{ t_ms: 9000, x: 0.5, y: 0.5 }])).toBeNull()
  })
  it('makes a stop every half second, the zoom size centred on the pointer, inside the frame', () => {
    const k = followPointerKeyframes(zoom, sweep)
    expect(k?.map((s) => s.at_ms)).toEqual([2000, 2500, 3000, 3500, 4000])
    expect(k?.every((s) => s.rect.w === 0.5 && s.rect.h === 0.5)).toBe(true)
    // The middle stop is centred near x 0.5: rect.x ≈ 0.25; the first is
    // clamped at the frame's edge (centre 0.2 − 0.25 < 0).
    expect(k?.[2].rect.x).toBeCloseTo(0.25, 1)
    expect(k?.[0].rect.x).toBe(0)
    expect(k?.[4].rect.x).toBe(0.5) // centre 0.8 → 0.55, clamped to 1 − 0.5
    expect(k?.every((s) => s.rect.y === 0.25)).toBe(true)
  })
  it('leaves out the stops inside a still stretch, keeping its two ends', () => {
    const stillThenMove: PointerSample[] = [
      { t_ms: 1000, x: 0.5, y: 0.5 },
      { t_ms: 3500, x: 0.5, y: 0.5 },
      { t_ms: 3550, x: 0.9, y: 0.9 }
    ]
    const k = followPointerKeyframes(zoom, stillThenMove)
    // 2000 and 2500 and 3000 sit in the still stretch (2500 is interior).
    expect(k?.map((s) => s.at_ms)).toEqual([2000, 3000, 3500, 4000])
    expect(k?.[0].rect).toEqual(k?.[1].rect)
  })
  it('uses fewer, wider steps for a long zoom so the stops fit the cap', () => {
    const long: Zoom = { ...zoom, start_ms: 0, end_ms: 60_000 }
    const path = Array.from({ length: 1200 }, (_, i) => ({
      t_ms: i * 50,
      x: (i % 100) / 100,
      y: 0.5
    }))
    const k = followPointerKeyframes(long, path)
    expect(k?.length).toBeLessThanOrEqual(EDIT_LIMITS.zoomKeyframes)
    expect(k?.[0].at_ms).toBe(0)
    expect(k?.[k.length - 1].at_ms).toBe(60_000)
    expect(k![1].at_ms - k![0].at_ms).toBeGreaterThan(FOLLOW_STEP_MS)
  })
  it('stores through upsertItemChecked as it is: the area is the first stop', () => {
    const base: VideoEdits = {
      v: 1,
      segments: [{ start_ms: 0, end_ms: 20_000, speed: 1 }],
      poster_ms: 0,
      chapters: [],
      annotations: [],
      zooms: [zoom],
      blurs: [],
      captions: []
    }
    const keyframes = followPointerKeyframes(zoom, sweep)!
    const e = upsertItemChecked(base, 'zooms', { ...zoom, keyframes }).edits
    expect(e.zooms[0].keyframes).toEqual(keyframes)
    expect(e.zooms[0].rect).toEqual(keyframes[0].rect)
  })
})
