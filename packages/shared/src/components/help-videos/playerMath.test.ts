import { describe, expect, it } from 'vitest'
import {
  activeAt,
  bucketIndex,
  fitFrame,
  liveBlurPx,
  liveStep,
  renderSize,
  resolveDurationMs,
  zoomAt
} from './playerMath'
import type { VideoEdits } from './types'

const e: VideoEdits = {
  v: 1,
  segments: [
    { start_ms: 0, end_ms: 2000, speed: 1 },
    { start_ms: 4000, end_ms: 8000, speed: 2 }
  ],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  blurs: [],
  captions: [],
  zooms: [
    { id: 'z', start_ms: 5000, end_ms: 7000, rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, ease_ms: 0 }
  ]
}

describe('fitFrame', () => {
  it('letterboxes a wide video in a tall box', () =>
    expect(fitFrame(400, 400, 1600, 900)).toEqual({ left: 0, top: 87.5, width: 400, height: 225 }))
  it('pillarboxes a tall video in a wide box', () =>
    expect(fitFrame(800, 400, 900, 1600)).toEqual({ left: 287.5, top: 0, width: 225, height: 400 }))
})

describe('liveStep', () => {
  it('plays at the piece speed', () =>
    expect(liveStep(e, 5000)).toEqual({ action: 'play', rate: 2 }))
  it('jumps over a cut', () =>
    expect(liveStep(e, 2990)).toEqual({ action: 'seek', toMs: 4000, rate: 2 }))
  it('jumps when sitting inside a cut', () =>
    expect(liveStep(e, 3000)).toEqual({ action: 'seek', toMs: 4000, rate: 2 }))
  it('ends after the last piece', () => expect(liveStep(e, 7990)).toEqual({ action: 'end' }))
})

describe('zoomAt', () => {
  it('is identity outside zooms', () => expect(zoomAt(e, 1000)).toEqual({ z: 1, tx: 0, ty: 0 }))
  it('matches the ffmpeg crop inside a zoom', () => {
    // rect centre 0.75, z = 2 → offset clamp(0.5 - 1.5, 1 - 2, 0) = -1
    expect(zoomAt(e, 6000)).toEqual({ z: 2, tx: -1, ty: -1 })
  })
})

describe('resolveDurationMs', () => {
  it('uses a finite browser duration', () => expect(resolveDurationMs(12.5, 99_000)).toBe(12_500))
  it('falls back when the browser says Infinity or NaN', () => {
    expect(resolveDurationMs(Number.POSITIVE_INFINITY, 99_000)).toBe(99_000)
    expect(resolveDurationMs(Number.NaN, null)).toBe(0)
  })
})

describe('bucketIndex / activeAt', () => {
  it('maps edited time to a 5% section', () => {
    expect(bucketIndex(0, 10_000)).toBe(0)
    expect(bucketIndex(9_999, 10_000)).toBe(19)
    expect(bucketIndex(5_000, 0)).toBe(0)
  })
  it('lists items covering a moment', () =>
    expect(
      activeAt(
        [
          { start_ms: 0, end_ms: 100 },
          { start_ms: 50, end_ms: 60 }
        ],
        55
      )
    ).toHaveLength(2))
})

describe('renderSize', () => {
  it('matches the server output size (fit 1920x1080, even sides)', () => {
    expect(renderSize(3840, 2160)).toEqual({ width: 1920, height: 1080 })
    expect(renderSize(1280, 720)).toEqual({ width: 1280, height: 720 })
    expect(renderSize(1001, 501)).toEqual({ width: 1000, height: 500 })
    expect(renderSize(1080, 2400)).toEqual({ width: 486, height: 1080 })
  })
})

describe('liveBlurPx', () => {
  const canvas = { width: 1280, height: 720 }
  it('scales the render radius to the frame and softens it to match boxblur', () =>
    expect(liveBlurPx(17, { w: 0.5, h: 0.5 }, canvas, 640)).toBe(5))
  it('caps the radius by the box size like the render plan', () =>
    // 0.05 × 720 = 36 px → at most 36 / 4 − 1 = 8
    expect(liveBlurPx(40, { w: 0.5, h: 0.05 }, canvas, 1280)).toBeCloseTo(8 / 1.7))
  it('never goes below radius 1', () =>
    expect(liveBlurPx(12, { w: 0.001, h: 0.001 }, canvas, 1280)).toBeCloseTo(1 / 1.7))
})
