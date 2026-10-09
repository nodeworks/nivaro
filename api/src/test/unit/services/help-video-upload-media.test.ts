import { describe, expect, it } from 'vitest'
import {
  buildUploadArgs,
  type ProbedStream,
  planUploadedVideo,
  sniffContainer,
  type UploadPlan
} from '../../../services/help-video-upload-media.js'

const v = (p: Partial<ProbedStream>): ProbedStream => ({
  index: 0,
  codec_type: 'video',
  codec_name: 'h264',
  profile: 'High',
  pix_fmt: 'yuv420p',
  width: 1280,
  height: 720,
  ...p
})
const a = (codec: string, index = 1): ProbedStream => ({
  index,
  codec_type: 'audio',
  codec_name: codec
})
const plan = (...streams: ProbedStream[]) => planUploadedVideo({ duration_ms: 5000, streams })
const ok = (r: ReturnType<typeof planUploadedVideo>): UploadPlan => {
  if ('error' in r) throw new Error(r.error.code)
  return r
}

describe('sniffContainer', () => {
  it('reads EBML as WebM and ISO-BMFF / QuickTime atoms as MP4', () => {
    expect(sniffContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe('video/webm')
    expect(sniffContainer(Buffer.from('\0\0\0\x18ftypmp42', 'latin1'))).toBe('video/mp4')
    expect(sniffContainer(Buffer.from('\0\0\0\x14ftypqt  ', 'latin1'))).toBe('video/mp4')
    expect(sniffContainer(Buffer.from('\0\0\0\x08wide\0\0', 'latin1'))).toBe('video/mp4')
    expect(sniffContainer(Buffer.from('\0\0\0\x08moov\0\0', 'latin1'))).toBe('video/mp4')
  })
  it('refuses anything else, whatever the file was called', () => {
    expect(sniffContainer(Buffer.from('hello this is text'))).toBeNull()
    expect(sniffContainer(Buffer.from('%PDF-1.7 something'))).toBeNull()
    expect(sniffContainer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBeNull()
    expect(sniffContainer(Buffer.alloc(3))).toBeNull()
  })
})

describe('planUploadedVideo', () => {
  it('keeps H.264 + AAC as MP4 with both streams copied', () => {
    expect(ok(plan(v({}), a('aac')))).toEqual({
      container: 'video/mp4',
      video: { index: 0, mode: 'copy' },
      audio: { index: 1, mode: 'copy' },
      kind: 'copy'
    })
  })
  it('keeps H.264 without sound, and yuvj420p, as a copy', () => {
    expect(ok(plan(v({ pix_fmt: 'yuvj420p' }))).kind).toBe('copy')
    expect(ok(plan(v({}))).audio).toBeNull()
  })
  it('converts only the sound when MOV audio is PCM', () => {
    const p = ok(plan(v({}), a('pcm_s16le')))
    expect(p.video.mode).toBe('copy')
    expect(p.audio?.mode).toBe('encode')
    expect(p.kind).toBe('audio')
  })
  it('keeps VP8/VP9 + Opus/Vorbis as WebM', () => {
    expect(ok(plan(v({ codec_name: 'vp9', profile: 'Profile 0' }), a('opus'))).container).toBe(
      'video/webm'
    )
    expect(ok(plan(v({ codec_name: 'vp8' }), a('vorbis'))).kind).toBe('copy')
  })
  it('converts VP9 with sound WebM cannot carry to an H.264 MP4', () => {
    const p = ok(plan(v({ codec_name: 'vp9' }), a('aac')))
    expect(p).toMatchObject({ container: 'video/mp4', kind: 'convert' })
    expect(p.video.mode).toBe('encode')
  })
  it('converts what browsers cannot play everywhere', () => {
    for (const s of [
      v({ codec_name: 'hevc', profile: 'Main' }),
      v({ codec_name: 'prores', profile: 'HQ', pix_fmt: 'yuv422p10le' }),
      v({ codec_name: 'av1', profile: 'Main' }),
      v({ profile: 'High 10', pix_fmt: 'yuv420p10le' }),
      v({ profile: 'High 4:4:4 Predictive', pix_fmt: 'yuv444p' }),
      v({ codec_name: 'vp9', pix_fmt: 'yuv420p10le', profile: 'Profile 2' }),
      v({ codec_name: 'mpeg4', profile: 'Simple Profile' })
    ]) {
      const p = ok(plan(s, a('aac')))
      expect(p, s.codec_name).toMatchObject({ container: 'video/mp4', kind: 'convert' })
      expect(p.audio?.mode).toBe('encode')
    }
  })
  it('skips cover art and maps the real video stream', () => {
    const p = ok(
      plan(
        { ...v({ codec_name: 'mjpeg', index: 0 }), attached_pic: true },
        v({ index: 1 }),
        a('aac', 2)
      )
    )
    expect(p.video.index).toBe(1)
    expect(p.audio?.index).toBe(2)
  })
  it('refuses a file with no video (an audio file, cover art only)', () => {
    expect(plan(a('mp3', 0))).toEqual({
      error: { code: 'UPLOAD_NO_VIDEO', message: 'That file has no video in it' }
    })
    expect('error' in plan({ ...v({ codec_name: 'png' }), attached_pic: true }, a('aac'))).toBe(
      true
    )
  })
})

describe('buildUploadArgs', () => {
  const lock = ['-protocol_whitelist', 'file', '-f', 'mov,mp4', '-format_whitelist', 'mov,mp4']
  it('copies with faststart, maps only the chosen streams and pins the input', () => {
    const args = buildUploadArgs(ok(plan(v({}), a('aac'))), { path: 'in', inputLock: lock }, 'o', 2)
    expect(args.slice(0, 3)).toEqual(['-y', '-v', 'error'])
    expect(args.indexOf('-f')).toBeLessThan(args.indexOf('-i'))
    expect(args).toEqual(expect.arrayContaining(['-map', '0:0', '0:1', '-c:v', 'copy', '-c:a']))
    expect(args.join(' ')).toContain('-movflags +faststart -f mp4 o')
    expect(args).not.toContain('libx264')
  })
  it('converts to H.264 + AAC with even sizes and a thread cap', () => {
    const args = buildUploadArgs(
      ok(plan(v({ codec_name: 'hevc' }), a('aac'))),
      { path: 'in', inputLock: lock },
      'o',
      3
    )
    expect(args).toEqual(expect.arrayContaining(['libx264', 'yuv420p', 'aac', '-threads', '3']))
    expect(args[args.indexOf('-vf') + 1]).toMatch(/trunc\(min\(2560,iw\)\/2\)\*2/)
  })
  it('writes WebM for a VP9 copy', () => {
    const args = buildUploadArgs(
      ok(plan(v({ codec_name: 'vp9' }), a('opus'))),
      { path: 'in', inputLock: lock },
      'o',
      2
    )
    expect(args.slice(-3)).toEqual(['-f', 'webm', 'o'])
    expect(args).not.toContain('-movflags')
  })
  it('bounds the output length and size after the input when limits are given', () => {
    const args = buildUploadArgs(
      ok(plan(v({ codec_name: 'hevc' }), a('aac'))),
      { path: 'in', inputLock: lock },
      'o',
      2,
      { maxSeconds: 1861, maxBytes: 2_000_000 }
    )
    const i = args.indexOf('-i')
    expect(args.indexOf('-t')).toBeGreaterThan(i)
    expect(args[args.indexOf('-t') + 1]).toBe('1861')
    expect(args[args.indexOf('-fs') + 1]).toBe('2000000')
    expect(args.at(-1)).toBe('o')
  })
})
