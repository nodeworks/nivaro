import { afterEach, describe, expect, it } from 'vitest'
import { annotationOverlayFrames } from '../../../services/help-video-annotations.js'
import {
  friendlyRenderError,
  renderingAllowed,
  renderThreads
} from '../../../services/help-video-render.js'

afterEach(() => {
  delete process.env.VIDEO_RENDER
  delete process.env.NIVARO_ROLE
  delete process.env.VIDEO_RENDER_THREADS
})

describe('renderingAllowed', () => {
  it('renders by default', () => expect(renderingAllowed()).toBe(true))
  it('can be switched off', () => {
    process.env.VIDEO_RENDER = 'off'
    expect(renderingAllowed()).toBe(false)
  })
  it('never renders on a web-role process', () => {
    process.env.NIVARO_ROLE = 'web'
    expect(renderingAllowed()).toBe(false)
  })
})

describe('renderThreads', () => {
  it('defaults to 2', () => expect(renderThreads()).toBe(2))
  it('reads and clamps the env', () => {
    process.env.VIDEO_RENDER_THREADS = '64'
    expect(renderThreads()).toBe(8)
    process.env.VIDEO_RENDER_THREADS = 'x'
    expect(renderThreads()).toBe(2)
  })
})

describe('annotationOverlayFrames', () => {
  const base = {
    id: 'a',
    rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
    to: null,
    text: '',
    tone: 'accent' as const
  }
  it('is one frame for a box', () =>
    expect(annotationOverlayFrames({ ...base, type: 'box', start_ms: 0, end_ms: 900 })).toEqual([
      { start_ms: 0, end_ms: 900, scale: 1 }
    ]))
  it('grows a ripple over three frames', () =>
    expect(annotationOverlayFrames({ ...base, type: 'ripple', start_ms: 0, end_ms: 900 })).toEqual([
      { start_ms: 0, end_ms: 300, scale: 0.6 },
      { start_ms: 300, end_ms: 600, scale: 0.85 },
      { start_ms: 600, end_ms: 900, scale: 1 }
    ]))
})

describe('friendlyRenderError', () => {
  it('explains a missing original', () =>
    expect(friendlyRenderError(new Error('in.webm: No such file or directory'))).toBe(
      'The original recording is missing from storage'
    ))
  it('explains a recording format ffmpeg may not read', () =>
    expect(friendlyRenderError(new Error('Unsupported recording format: video/quicktime'))).toBe(
      "This recording's format can't be processed. Try recording it again."
    ))
  it('keeps a short reason otherwise', () =>
    expect(friendlyRenderError(new Error('Invalid data found when processing input'))).toBe(
      'The video could not be rendered: Invalid data found when processing input'
    ))
})
