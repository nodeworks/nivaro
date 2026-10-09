import { describe, expect, it } from 'vitest'
import {
  AUDIO_EDIT_KEY,
  AUDIO_IMPROVE_DEFAULT,
  hashEdits,
  normalizeEdits
} from '../../../services/help-video-edits.js'
import { buildRenderArgs, IMPROVE_AUDIO_FILTER } from '../../../services/help-video-render-plan.js'
import { viewerMayPlaySource } from '../../../services/help-video-views.js'

// #1519 — "Improve audio": loudness levelling + noise reduction in the render.

const base = {
  width: 1280,
  height: 720,
  hasAudio: true,
  sourcePath: 'in.webm',
  sourceMime: 'video/webm',
  overlays: [],
  outputPath: 'out.mp4',
  threads: 2
}
const fc = (args: string[]) => args[args.indexOf('-filter_complex') + 1]

describe('the audio edit', () => {
  it('is off by default and stored only while on', () => {
    expect(AUDIO_EDIT_KEY).toBe('audio')
    expect(AUDIO_IMPROVE_DEFAULT).toBe(false)
    expect(normalizeEdits({}, 10_000)).not.toHaveProperty('audio')
    expect(normalizeEdits({ audio: { improve: false } }, 10_000)).not.toHaveProperty('audio')
    expect(normalizeEdits({ audio: { improve: 'yes' } }, 10_000)).not.toHaveProperty('audio')
    expect(normalizeEdits({ audio: { improve: true, extra: 1 } }, 10_000).audio).toEqual({
      improve: true
    })
  })
  it('leaves the hash of edits that never used it unchanged', () => {
    const before = normalizeEdits({}, 10_000)
    expect(hashEdits(normalizeEdits({ ...before, audio: { improve: false } }, 10_000))).toBe(
      hashEdits(before)
    )
    expect(hashEdits(normalizeEdits({ audio: { improve: true } }, 10_000))).not.toBe(
      hashEdits(before)
    )
  })
  it('makes viewers wait for the render', () => {
    expect(viewerMayPlaySource({}, 10_000)).toBe(true)
    expect(viewerMayPlaySource({ audio: { improve: true } }, 10_000)).toBe(false)
  })
})

describe('the render', () => {
  it('cleans the narration when on', () => {
    const g = fc(
      buildRenderArgs({ ...base, edits: normalizeEdits({ audio: { improve: true } }, 10_000) })
    )
    expect(g).toContain('afftdn=')
    expect(g).toContain('loudnorm=I=-16')
    expect(g).toContain(`[araw]${IMPROVE_AUDIO_FILTER}`)
    expect(g).toMatch(/\[araw\][^;]*\[aout\]/)
  })
  it('leaves the narration alone when off', () => {
    const g = fc(buildRenderArgs({ ...base, edits: normalizeEdits({}, 10_000) }))
    expect(g).not.toContain('loudnorm')
    expect(g).not.toContain('afftdn')
  })
  it('does nothing for a silent recording', () => {
    const g = fc(
      buildRenderArgs({
        ...base,
        hasAudio: false,
        edits: normalizeEdits({ audio: { improve: true } }, 10_000)
      })
    )
    expect(g).not.toContain('loudnorm')
  })
  it('cleans the narration before the music is ducked under it', () => {
    const edits = normalizeEdits(
      {
        audio: { improve: true },
        music: { enabled: true, source: 'library', track: 'calm', volume: 0.3, duck: true }
      },
      10_000
    )
    const g = fc(buildRenderArgs({ ...base, edits, music: { path: 'm.wav', mime: 'audio/wav' } }))
    const clean = g.indexOf(`[araw]${IMPROVE_AUDIO_FILTER}`)
    const split = g.indexOf('[anar]')
    expect(clean).toBeGreaterThan(-1)
    // The cleaned narration lands on [anar], which the sidechain split reads.
    expect(g).toMatch(/\[araw\][^;]*\[anar\]/)
    expect(g.indexOf('asplit=2[anarm][asc]')).toBeGreaterThan(split)
    expect(g).toContain('sidechaincompress')
  })
  it('cleans the whole narration when there are cards', () => {
    const edits = normalizeEdits(
      { audio: { improve: true }, intro: { enabled: true, duration_ms: 3000 } },
      10_000
    )
    const g = fc(
      buildRenderArgs({
        ...base,
        edits,
        intro: { path: 'i.png', sequence: false, frames: 1, duration_ms: 3000, over_frame: false }
      })
    )
    // The cards' concat writes the raw narration, then it is cleaned.
    expect(g).toMatch(/concat=n=2:v=1:a=1\[vout\]\[araw\]/)
    expect(g).toMatch(/\[araw\][^;]*loudnorm[^;]*\[aout\]/)
  })
})
