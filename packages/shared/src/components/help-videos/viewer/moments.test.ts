import { describe, expect, it } from 'vitest'
import { downloadChoices } from './DownloadMenu'
import {
  CAPTION_DEFAULTS,
  captionStyleFrom,
  captionStylePatch,
  momentFromParams,
  momentLink,
  parseMomentUrl,
  resolveMomentStart
} from './moments'

const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const chapters = [
  { id: 'c1', edited_ms: 0 },
  { id: 'c3', edited_ms: 42_000 }
]

describe('moment links (#1501)', () => {
  it('reads t as whole seconds and ignores junk', () => {
    expect(momentFromParams('42', 'c3')).toEqual({ atMs: 42_000, chapterId: 'c3' })
    expect(momentFromParams('4.5', '<x>')).toEqual({ atMs: null, chapterId: null })
    expect(momentFromParams(null, null)).toEqual({ atMs: null, chapterId: null })
  })
  it('a chapter that resolves wins over t; t stays inside the video', () => {
    expect(resolveMomentStart(chapters, 90_000, 10_000, 'c3')).toBe(42_000)
    expect(resolveMomentStart(chapters, 90_000, 10_000, 'gone')).toBe(10_000)
    expect(resolveMomentStart(chapters, 90_000, 500_000, null)).toBe(89_000)
    expect(resolveMomentStart(chapters, 90_000, null, null)).toBeNull()
  })
  it('builds links in the contract shape', () => {
    expect(momentLink('https://x.test', '/help-videos', ID, { atMs: 42_900 })).toBe(
      `https://x.test/help-videos?watch=${ID}&t=42`
    )
    expect(
      momentLink('https://x.test', '/help/videos', ID, { atMs: 42_000, chapterId: 'c3' })
    ).toBe(`https://x.test/help/videos?watch=${ID}&t=42&c=c3`)
    expect(momentLink('', '/help-videos', ID)).toBe(`/help-videos?watch=${ID}`)
  })
  it('recognises a pasted link from any app', () => {
    expect(parseMomentUrl(`https://other.test/help/videos?watch=${ID}&t=42&c=c3`)).toEqual({
      id: ID,
      search: `?watch=${ID}&t=42&c=c3`,
      atMs: 42_000,
      chapterId: 'c3'
    })
    expect(parseMomentUrl('https://other.test/help/videos?watch=nope')).toBeNull()
    expect(parseMomentUrl('https://youtube.test/watch?v=abc')).toBeNull()
  })
})

describe('caption settings (#1529)', () => {
  it('reads saved settings over the defaults, ignoring junk', () => {
    expect(captionStyleFrom(null)).toEqual(CAPTION_DEFAULTS)
    expect(
      captionStyleFrom({ help_video_captions: { size: 'xl', position: 'top', background: 'x' } })
    ).toEqual({ size: 'xl', background: 'shaded', position: 'top' })
  })
  it('stores only what differs from the defaults', () => {
    expect(captionStylePatch(CAPTION_DEFAULTS)).toBeNull()
    expect(captionStylePatch({ ...CAPTION_DEFAULTS, background: 'none' })).toEqual({
      background: 'none'
    })
  })
})

describe('transcript in the download menu (#1529)', () => {
  it('is offered even when the video downloads are off', () => {
    expect(downloadChoices(null, { transcript: '/t' }).map((c) => c.key)).toEqual(['transcript'])
  })
  it('follows the video choices otherwise', () => {
    const urls = { video: '/v', captions_vtt: null, captions_srt: null }
    expect(downloadChoices(urls, { transcript: '/t' }).map((c) => c.key)).toEqual([
      'video',
      'transcript'
    ])
  })
})
