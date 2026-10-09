import { describe, expect, it } from 'vitest'
import { annotationOpacity, musicShare, setMusic, setPieceMusic } from './edits'
import { MUSIC_DUCK_GAIN, musicGainAt, musicTrackPath, speakingAt } from './musicMix'
import type { VideoEdits } from './types'

const base: VideoEdits = {
  v: 1,
  segments: [
    { start_ms: 0, end_ms: 4000, speed: 1 },
    { start_ms: 4000, end_ms: 8000, speed: 1 }
  ],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
}
const withMusic = setMusic(base, { source: 'library', track: 'calm', name: 'Calm', volume: 0.4 })

describe('setMusic', () => {
  it('stores the server shape, defaults ducking on, and clamps the volume', () => {
    expect(withMusic.music).toEqual({
      enabled: true,
      source: 'library',
      track: 'calm',
      name: 'Calm',
      volume: 0.4,
      duck: true
    })
    expect(setMusic(withMusic, { volume: 0 }).music?.volume).toBe(0.05)
    expect(setMusic(withMusic, { duck: false }).music?.duck).toBe(false)
  })
  it('turning it off drops every piece share too', () => {
    const e = setPieceMusic(withMusic, 1, 0)
    expect(e.segments[1].music).toBe(0)
    const off = setMusic(e, null)
    expect('music' in off).toBe(false)
    expect('music' in off.segments[1]).toBe(false)
  })
  it('a share of 1 is not stored', () => {
    const e = setPieceMusic(setPieceMusic(withMusic, 0, 0.5), 0, 1)
    expect('music' in e.segments[0]).toBe(false)
    expect(musicShare(undefined)).toBe(1)
    expect(musicShare(0.33)).toBe(0.35)
  })
})

describe('musicGainAt', () => {
  const body = (srcMs: number, levels?: number[]) =>
    musicGainAt(setPieceMusic(withMusic, 1, 0.5), {
      editedMs: srcMs,
      srcMs,
      phase: 'body',
      levels
    })
  it('fades in over the first second and out over the last 1.5', () => {
    expect(body(0)).toBe(0)
    expect(body(500)).toBeCloseTo(0.2)
    expect(body(2000)).toBeCloseTo(0.4)
    expect(body(8000)).toBe(0)
  })
  it("follows each piece's share", () => {
    expect(body(5000)).toBeCloseTo(0.2)
  })
  it('ducks while the microphone hears someone', () => {
    const levels = Array.from({ length: 80 }, (_, i) => (i >= 20 && i < 30 ? 0.4 : 0))
    expect(body(2500, levels)).toBeCloseTo(0.4 * MUSIC_DUCK_GAIN)
    expect(body(3500, levels)).toBeCloseTo(0.4)
    expect(speakingAt(levels, 1950)).toBe(true)
    expect(speakingAt(null, 2500)).toBe(false)
  })
  it('is 0 without music', () => {
    expect(musicGainAt(base, { editedMs: 2000, srcMs: 2000, phase: 'body' })).toBe(0)
  })
})

describe('musicTrackPath', () => {
  it('names library tracks and a video’s own files', () => {
    expect(musicTrackPath('v1', { source: 'library', track: 'calm' })).toBe(
      '/help-videos/music/calm'
    )
    expect(musicTrackPath('v1', { source: 'upload', track: 'abc' })).toBe(
      '/help-videos/v1/music/abc'
    )
  })
})

describe('annotationOpacity', () => {
  const a = { type: 'callout', start_ms: 1000, end_ms: 3000 }
  it('fades a callout in and out over 200 ms', () => {
    expect(annotationOpacity(a, 1000)).toBe(0)
    expect(annotationOpacity(a, 1100)).toBeCloseTo(0.5)
    expect(annotationOpacity(a, 2000)).toBe(1)
    expect(annotationOpacity(a, 2950)).toBeCloseTo(0.25)
  })
  it('leaves a ripple alone', () => {
    expect(annotationOpacity({ ...a, type: 'ripple' }, 1000)).toBe(1)
  })
})
