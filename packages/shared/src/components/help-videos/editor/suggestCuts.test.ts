import { describe, expect, it } from 'vitest'
import type { VideoEdits } from '../types'
import { suggestCuts } from './suggestCuts'

const edits: VideoEdits = {
  v: 1,
  segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
}
// Recorder levels: loudness 0–1, one value per 100 ms.
const levels = (pattern: Array<[number, number]>) =>
  pattern.flatMap(([v, n]) => new Array(n).fill(v))

describe('suggestCuts', () => {
  it('finds a long silence and pads it', () => {
    // 1 s talking, 4 s silence, 5 s talking (100 ms samples)
    expect(
      suggestCuts(
        levels([
          [0.4, 10],
          [0.01, 40],
          [0.4, 50]
        ]),
        edits
      )
    ).toEqual([{ start_ms: 1300, end_ms: 4700 }])
  })
  it('ignores short pauses and missing levels', () => {
    expect(
      suggestCuts(
        levels([
          [0.4, 10],
          [0.01, 20],
          [0.4, 70]
        ]),
        edits
      )
    ).toEqual([])
    expect(suggestCuts(null, edits)).toEqual([])
  })
  it('only suggests silence inside kept pieces', () => {
    const cut = {
      ...edits,
      segments: [
        { start_ms: 0, end_ms: 1000, speed: 1 as const },
        { start_ms: 5000, end_ms: 10_000, speed: 1 as const }
      ]
    }
    expect(
      suggestCuts(
        levels([
          [0.4, 10],
          [0.01, 40],
          [0.4, 50]
        ]),
        cut
      )
    ).toEqual([])
  })
  it('drops a silence the author already sped up', () => {
    const sped = {
      ...edits,
      segments: [
        { start_ms: 0, end_ms: 1300, speed: 1 as const },
        { start_ms: 1300, end_ms: 4700, speed: 4 as const },
        { start_ms: 4700, end_ms: 10_000, speed: 1 as const }
      ]
    }
    expect(
      suggestCuts(
        levels([
          [0.4, 10],
          [0.01, 40],
          [0.4, 50]
        ]),
        sped
      )
    ).toEqual([])
  })
  it('treats quiet room noise below 0.06 as silence', () => {
    expect(
      suggestCuts(
        levels([
          [0.4, 10],
          [0.05, 40],
          [0.4, 50]
        ]),
        edits
      )
    ).toEqual([{ start_ms: 1300, end_ms: 4700 }])
    expect(
      suggestCuts(
        levels([
          [0.4, 10],
          [0.08, 40],
          [0.4, 50]
        ]),
        edits
      )
    ).toEqual([])
  })
})
