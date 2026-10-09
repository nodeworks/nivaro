import { describe, expect, it } from 'vitest'
import { median, remainingFor } from '../../../services/help-video-render-queue.js'

describe('median', () => {
  it('is null without history', () => expect(median([])).toBeNull())
  it('takes the middle, or the mean of the two middles', () => {
    expect(median([30, 10, 20])).toBe(20)
    expect(median([40, 10, 20, 30])).toBe(25)
  })
})

describe('remainingFor', () => {
  it("uses the render's own pace once it is 5 % in", () =>
    expect(remainingFor(999_999, 25, 10_000)).toBe(30_000))
  it('uses the estimate less the time run before that', () =>
    expect(remainingFor(60_000, 2, 10_000)).toBe(50_000))
  it('never goes below zero', () => expect(remainingFor(5_000, 0, 10_000)).toBe(0))
  it('is unknown without an estimate or a pace', () =>
    expect(remainingFor(null, 0, 1000)).toBeNull())
})
