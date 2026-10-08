import { describe, expect, it } from 'vitest'
import { waveformPath } from './waveform'

describe('waveformPath', () => {
  it('draws one bar per sample when samples are a pixel or more apart', () => {
    // 10 px per second → one sample (100 ms) per pixel; height 32 → 28 px of range.
    expect(waveformPath([0, 0.5, 1], 10, 32)).toBe('M0.5 30v-1M1.5 30v-14M2.5 30v-28')
  })
  it('keeps the loudest sample in each pixel column', () => {
    // 2 px per second → five samples per pixel; the sixth starts column 1.
    expect(waveformPath([0.1, 0.9, 0.2, 0.3, 0.4, 0.5], 2, 32)).toBe('M0.5 30v-25.2M1.5 30v-14')
  })
  it('clamps levels to 0–1 and treats bad values as silence', () => {
    expect(waveformPath([2, -1, Number.NaN], 10, 32)).toBe('M0.5 30v-28M1.5 30v-1M2.5 30v-1')
  })
  it('is empty without levels', () => {
    expect(waveformPath([], 10, 32)).toBe('')
  })
})
