import { describe, expect, it } from 'vitest'
import { downloadChoices } from './DownloadMenu'

const urls = {
  video: '/api/help-videos/v/download?st=t&file=video',
  captions_vtt: '/api/help-videos/v/download?st=t&file=captions.vtt',
  captions_srt: '/api/help-videos/v/download?st=t&file=captions.srt'
}

describe('downloadChoices', () => {
  it('offers the video, then captions in both formats', () => {
    expect(downloadChoices(urls).map((c) => c.key)).toEqual(['video', 'vtt', 'srt'])
  })
  it('offers only the video when there are no captions', () => {
    const c = downloadChoices({ ...urls, captions_vtt: null, captions_srt: null })
    expect(c.map((x) => x.key)).toEqual(['video'])
  })
  it('adds the original recording for authors', () => {
    const c = downloadChoices(urls, { original: true })
    expect(c[1]).toMatchObject({ key: 'original', href: `${urls.video}&source=1` })
  })
})
