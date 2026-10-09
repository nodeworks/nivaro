import { describe, expect, it } from 'vitest'
import { renderLabel, viewersWaitForRender } from './editor/publish'
import { AUDIO_EDIT_KEY, AUDIO_IMPROVE_DEFAULT, setImproveAudio } from './edits'
import type { VersionDto, VideoEdits } from './types'

// #1519 — the client twin of the server's audio edit (help-video-edits.ts
// normalizeAudio, help-video-views.ts viewerMayPlaySource).

const base: VideoEdits = {
  v: 1,
  segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
}

describe('setImproveAudio', () => {
  it('mirrors the server key and default', () => {
    expect(AUDIO_EDIT_KEY).toBe('audio')
    expect(AUDIO_IMPROVE_DEFAULT).toBe(false)
  })
  it('stores { improve: true } only while on, as the server does', () => {
    const on = setImproveAudio(base, true)
    expect(on.audio).toEqual({ improve: true })
    const off = setImproveAudio(on, false)
    expect(off).not.toHaveProperty('audio')
    expect(off).toEqual(base)
  })
})

describe('viewersWaitForRender', () => {
  it('waits for the render when the narration is cleaned', () => {
    expect(viewersWaitForRender(base, 10_000)).toBe(false)
    expect(viewersWaitForRender(setImproveAudio(base, true), 10_000)).toBe(true)
  })
})

describe('renderLabel', () => {
  const v = (extra: Partial<VersionDto>) => ({ render_status: 'failed', ...extra }) as VersionDto
  it('shows a cancel as a cancel, not a failure', () => {
    expect(renderLabel(v({ render_error: 'Cancelled by Rob Lee. It plays…' }))).toEqual({
      text: 'Cancelled by Rob Lee. It plays…',
      tone: 'neutral'
    })
    expect(renderLabel(v({ render_error: 'boom' })).tone).toBe('bad')
  })
})
