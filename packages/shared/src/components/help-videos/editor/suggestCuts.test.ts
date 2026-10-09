import { describe, expect, it } from 'vitest'
import type { ActivitySpan, VideoEdits } from '../types'
import { suggestCuts, suggestEdits } from './suggestCuts'

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

describe('suggestEdits', () => {
  const long: VideoEdits = { ...edits, segments: [{ start_ms: 0, end_ms: 30_000, speed: 1 }] }
  const span = (kind: ActivitySpan['kind'], s: number, e: number): ActivitySpan => ({
    kind,
    start_ms: s,
    end_ms: e
  })

  it('offers idle stretches as cuts and typing as 4× without microphone levels', () => {
    expect(
      suggestEdits(null, [span('idle', 2000, 7000), span('typing', 8000, 11_000)], long)
    ).toEqual([
      { start_ms: 2300, end_ms: 6700, kind: 'idle', action: 'cut' },
      { start_ms: 8000, end_ms: 11_000, kind: 'typing', action: 'speed' }
    ])
  })
  it('keeps the silence suggestions it always made', () => {
    expect(
      suggestEdits(
        levels([
          [0.4, 10],
          [0.01, 40],
          [0.4, 50]
        ]),
        null,
        long
      )
    ).toEqual([{ start_ms: 1300, end_ms: 4700, kind: 'silence', action: 'cut' }])
  })
  it('merges an idle stretch into the silence it overlaps and never touches speech', () => {
    // 0–1 s talking, 1–6 s quiet, 6–10 s talking.
    const lv = levels([
      [0.4, 10],
      [0.01, 50],
      [0.4, 40]
    ])
    expect(suggestEdits(lv, [span('idle', 500, 5500), span('typing', 5000, 12_000)], long)).toEqual(
      [
        // silence 1.3–5.7 s + idle 1.0–5.2 s (its talking part dropped) → one cut
        { start_ms: 1000, end_ms: 5700, kind: 'idle', action: 'cut' },
        // typing minus the narration (6–10 s) and minus the cut
        { start_ms: 10_000, end_ms: 12_000, kind: 'typing', action: 'speed' }
      ]
    )
  })
  it('a cut beats a speed-up where they overlap', () => {
    const lv = levels([[0.01, 100]])
    expect(suggestEdits(lv, [span('typing', 2000, 9000)], long)).toEqual([
      { start_ms: 300, end_ms: 9700, kind: 'silence', action: 'cut' }
    ])
  })
  it('only offers what is still inside a kept piece at 1×', () => {
    const split: VideoEdits = {
      ...edits,
      segments: [
        { start_ms: 0, end_ms: 5000, speed: 1 },
        { start_ms: 5000, end_ms: 10_000, speed: 4 }
      ]
    }
    expect(suggestEdits(null, [span('typing', 3000, 8000)], split)).toEqual([
      { start_ms: 3000, end_ms: 5000, kind: 'typing', action: 'speed' }
    ])
    expect(suggestEdits(null, [span('typing', 6000, 9000)], split)).toEqual([])
    expect(suggestEdits(null, [span('typing', 3500, 6000)], split)).toEqual([])
  })
  it('has nothing to say without levels or activity', () => {
    expect(suggestEdits(null, null, long)).toEqual([])
    expect(suggestEdits([], [], long)).toEqual([])
  })
})
