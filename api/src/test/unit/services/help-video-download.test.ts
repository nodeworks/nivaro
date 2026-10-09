import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  captionsVtt,
  contentDisposition,
  downloadsAllowed,
  hasCaptions,
  isDownloadFile,
  pickDownloadFile,
  safeDownloadName,
  startsDownload,
  videoExtension,
  vttToSrt,
  withDownloads
} from '../../../services/help-video-download.js'

const edits = (over: Record<string, unknown> = {}) => ({
  v: 1,
  segments: [{ start_ms: 0, end_ms: 20000, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: [],
  ...over
})

describe('safeDownloadName', () => {
  it('keeps a readable title and adds the extension', () => {
    expect(safeDownloadName('Approve a workflow', 'mp4')).toBe('Approve a workflow.mp4')
  })
  it('strips separators, control characters and reserved characters', () => {
    expect(safeDownloadName('../../etc/passwd', 'mp4')).toBe('etc passwd.mp4')
    expect(safeDownloadName('a\\b:c*d?"e<f>g|h\u0000i\nj', 'vtt')).toBe('a b c d e f g h i j.vtt')
  })
  it('never yields a dot file or an empty name', () => {
    expect(safeDownloadName('...', 'mp4')).toBe('help-video.mp4')
    expect(safeDownloadName('', 'mp4')).toBe('help-video.mp4')
    expect(safeDownloadName(null, 'srt')).toBe('help-video.srt')
    expect(safeDownloadName('  .hidden  ', 'mp4')).toBe('hidden.mp4')
  })
  it('caps long titles and cleans the extension', () => {
    expect(safeDownloadName('x'.repeat(500), 'm/p4')).toBe(`${'x'.repeat(120)}.mp4`)
  })
})

describe('contentDisposition', () => {
  it('is an attachment with an ASCII fallback and a UTF-8 name', () => {
    const h = contentDisposition('Café — résumé.mp4')
    expect(h.startsWith('attachment; filename="Cafe _ resume.mp4"')).toBe(true)
    expect(h).toContain("filename*=UTF-8''Caf%C3%A9%20%E2%80%94%20r%C3%A9sum%C3%A9.mp4")
  })
  it('cannot break out of the quoted name', () => {
    const h = contentDisposition('a"b\\c%d.mp4')
    expect(h).toMatch(/^attachment; filename="a_b_c_d\.mp4"; filename\*=UTF-8''/)
    expect(h.split('"').length).toBe(3)
  })
})

describe('the Allow downloads switch', () => {
  it('is on unless the visibility says downloads: false', () => {
    expect(downloadsAllowed(null)).toBe(true)
    expect(downloadsAllowed('{"mode":"everyone","role_ids":[]}')).toBe(true)
    expect(downloadsAllowed('{"mode":"roles","role_ids":[],"downloads":false}')).toBe(false)
    expect(downloadsAllowed('not json')).toBe(true)
  })
  it('keeps every other visibility key when switched', () => {
    const off = withDownloads('{"mode":"roles","role_ids":["R1"]}', false)
    expect(JSON.parse(off)).toEqual({ mode: 'roles', role_ids: ['R1'], downloads: false })
    expect(JSON.parse(withDownloads(off, true))).toEqual({ mode: 'roles', role_ids: ['R1'] })
    expect(JSON.parse(withDownloads(null, false))).toEqual({
      mode: 'everyone',
      role_ids: [],
      downloads: false
    })
  })
})

describe('pickDownloadFile', () => {
  const rendered = {
    source_file: 'S',
    rendered_file: 'R',
    rendered_hash: 'h',
    edits_hash: 'h',
    edits: JSON.stringify(edits()),
    source_duration_ms: 20000
  }
  it('gives a viewer the current render', () => {
    expect(pickDownloadFile(rendered, { author: false, source: true })).toEqual({
      fileId: 'R',
      kind: 'rendered'
    })
  })
  it('gives a viewer the original only when the edits hide nothing', () => {
    const stale = { ...rendered, rendered_hash: 'old' }
    expect(pickDownloadFile(stale, { author: false, source: false })?.kind).toBe('source')
    const blur = { id: 'b', start_ms: 0, end_ms: 1000, rect: { x: 0, y: 0, w: 0.1, h: 0.1 } }
    const blurred = {
      ...stale,
      edits: JSON.stringify(edits({ blurs: [{ ...blur, strength: 12 }] }))
    }
    expect(pickDownloadFile(blurred, { author: false, source: false })).toBeNull()
  })
  it('lets an author ask for the original', () => {
    expect(pickDownloadFile(rendered, { author: true, source: true })?.kind).toBe('source')
    expect(pickDownloadFile(rendered, { author: true, source: false })?.kind).toBe('rendered')
  })
})

describe('captions', () => {
  const version = {
    source_file: 'S',
    rendered_file: null,
    rendered_hash: null,
    edits_hash: 'h',
    source_duration_ms: 20000,
    edits: JSON.stringify(
      edits({
        segments: [
          { start_ms: 0, end_ms: 5000, speed: 1 },
          { start_ms: 10000, end_ms: 20000, speed: 1 }
        ],
        captions: [{ id: 't1', start_ms: 12000, end_ms: 14000, text: 'Click Approve' }]
      })
    )
  }
  it('knows when a video has captions', () => {
    expect(hasCaptions(version)).toBe(true)
    expect(hasCaptions({ ...version, edits: JSON.stringify(edits()) })).toBe(false)
  })
  it('follows the timeline of the downloaded file', () => {
    expect(captionsVtt(version, 'edited')).toContain('00:00:07.000 --> 00:00:09.000')
    expect(captionsVtt(version, 'source')).toContain('00:00:12.000 --> 00:00:14.000')
  })
  it('converts to SubRip', () => {
    expect(vttToSrt(captionsVtt(version, 'source'))).toBe(
      '1\n00:00:12,000 --> 00:00:14,000\nClick Approve\n'
    )
    expect(vttToSrt('WEBVTT\n\n00:01.500 --> 00:02.000\nHi\n')).toBe(
      '1\n00:00:01,500 --> 00:00:02,000\nHi\n'
    )
  })
})

describe('helpers', () => {
  it('counts only the first request of a download', () => {
    expect(startsDownload(undefined)).toBe(true)
    expect(startsDownload('bytes=0-')).toBe(true)
    expect(startsDownload('bytes=1000-')).toBe(false)
  })
  it('knows the files and extensions', () => {
    expect(isDownloadFile('video')).toBe(true)
    expect(isDownloadFile('captions.srt')).toBe(true)
    expect(isDownloadFile('../x')).toBe(false)
    expect(videoExtension('rendered', 'video/webm')).toBe('mp4')
    expect(videoExtension('source', 'video/webm')).toBe('webm')
    expect(videoExtension('source', 'video/mp4')).toBe('mp4')
  })
})
