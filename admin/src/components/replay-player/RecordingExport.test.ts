import { describe, expect, it } from 'vitest'
import { parseClock } from './RecordingExport'

describe('parseClock (#1375 export window)', () => {
  it('reads m:ss, h:mm:ss and plain seconds', () => {
    expect(parseClock('1:23')).toBe(83_000)
    expect(parseClock('1:02:03')).toBe(3_723_000)
    expect(parseClock(' 90 ')).toBe(90_000)
  })

  it('is null when empty and NaN when not a time', () => {
    expect(parseClock('')).toBeNull()
    expect(parseClock('1m')).toBeNaN()
    expect(parseClock('1:2:3:4')).toBeNaN()
  })
})
