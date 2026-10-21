import { describe, expect, it } from 'vitest'
import { clipFileName, clipInfo, clipTags, formatClipLength } from './ScreenClip'

describe('clip tags', () => {
  it("round-trips poster + duration through a file row's tags", () => {
    const tags = clipTags('11111111-2222-3333-4444-555555555555', 12_345.6)
    expect(tags).toEqual([
      'chat-clip',
      'duration:12346',
      'poster:11111111-2222-3333-4444-555555555555'
    ])
    expect(clipInfo(tags, 'video/webm')).toEqual({
      poster: '11111111-2222-3333-4444-555555555555',
      durationMs: 12_346
    })
  })

  it('is not a clip without the tag, with a non-video type, or with a bad poster id', () => {
    expect(clipInfo(['other'], 'video/webm')).toBeNull()
    expect(clipInfo(['chat-clip'], 'image/png')).toBeNull()
    expect(clipInfo(['chat-clip', 'poster:nope'], 'video/webm')).toEqual({
      poster: null,
      durationMs: null
    })
    expect(clipInfo(null, null)).toBeNull()
  })

  it('names the file by the clock and prints a length people read', () => {
    expect(clipFileName(new Date(2026, 9, 21, 9, 5, 7))).toBe(
      'Screen clip 2026-10-21 09.05.07.webm'
    )
    expect(formatClipLength(null)).toBe('')
    expect(formatClipLength(400)).toBe('1 s')
    expect(formatClipLength(59_400)).toBe('59 s')
    expect(formatClipLength(60_000)).toBe('1:00')
  })
})
