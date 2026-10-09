import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasFfmpeg,
  lockedInputArgs,
  probeStreams,
  probeVideo,
  runFfmpeg
} from '../../services/ffmpeg.js'
import {
  buildUploadArgs,
  planUploadedVideo,
  sniffContainer,
  type UploadPlan
} from '../../services/help-video-upload-media.js'

// Each fixture goes the way an uploaded file does: sniff the first bytes,
// probe with that container pinned, plan, run ffmpeg, probe the result.
const dir = mkdtempSync(join(tmpdir(), 'nvr-upload-'))

async function make(name: string, video: string[], audio: string[] | null, size = '640x360') {
  const out = join(dir, name)
  await runFfmpeg([
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=15:duration=3`,
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'] : []),
    ...video,
    ...(audio ?? ['-an']),
    out
  ])
  return out
}

type Kept = {
  plan: UploadPlan
  result: Awaited<ReturnType<typeof probeStreams>>
  probe: Awaited<ReturnType<typeof probeVideo>>
  moovFirst: boolean | null
}
async function keep(path: string): Promise<{ refused: string } | Kept> {
  const mime = sniffContainer(readFileSync(path).subarray(0, 16))
  if (!mime) return { refused: 'sniff' as const }
  const probed = await probeStreams(path, mime)
  const plan = planUploadedVideo(probed)
  if ('error' in plan) return { refused: plan.error.code }
  const out = join(dir, `${Math.random().toString(36).slice(2)}.out`)
  await runFfmpeg(buildUploadArgs(plan, { path, inputLock: lockedInputArgs(mime) }, out, 2))
  const result = await probeStreams(out, plan.container)
  const head = readFileSync(out).subarray(0, 64).toString('latin1')
  return {
    plan,
    result,
    probe: await probeVideo(out, plan.container),
    // faststart: the moov atom sits before mdat
    moovFirst: plan.container === 'video/mp4' ? head.includes('moov') || moovBeforeMdat(out) : null
  }
}
function moovBeforeMdat(path: string): boolean {
  const s = readFileSync(path).toString('latin1')
  return s.indexOf('moov') < s.indexOf('mdat')
}

describe('uploaded files through real ffmpeg', { timeout: 60_000 }, () => {
  it('keeps an H.264 + AAC MP4 as a copy with faststart', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const f = await make('a.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], ['-c:a', 'aac'])
    const r = await keep(f)
    expect(r).toMatchObject({ plan: { kind: 'copy', container: 'video/mp4' }, moovFirst: true })
    if ('refused' in r) throw new Error('refused')
    expect(r.result.streams.map((s) => s.codec_name)).toEqual(['h264', 'aac'])
    expect(r.probe.has_audio).toBe(true)
    expect(r.probe.duration_ms).toBeGreaterThan(2500)
  })

  it('keeps a VP9 + Opus WebM as a copy', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const f = await make(
      'b.webm',
      ['-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8'],
      ['-c:a', 'libopus']
    )
    const r = await keep(f)
    expect(r).toMatchObject({ plan: { kind: 'copy', container: 'video/webm' } })
    if ('refused' in r) throw new Error('refused')
    expect(r.result.streams.map((s) => s.codec_name)).toEqual(['vp9', 'opus'])
  })

  it('converts an HEVC MOV to H.264 + AAC', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    let f: string
    try {
      f = await make('c.mov', ['-c:v', 'libx265', '-tag:v', 'hvc1'], ['-c:a', 'aac'])
    } catch {
      ctx.skip() // this ffmpeg has no HEVC encoder to make the fixture
      return
    }
    const r = await keep(f)
    expect(r).toMatchObject({ plan: { kind: 'convert', container: 'video/mp4' } })
    if ('refused' in r) throw new Error('refused')
    expect(r.result.streams.map((s) => s.codec_name)).toEqual(['h264', 'aac'])
    expect(r.result.streams[0].pix_fmt).toBe('yuv420p')
  })

  it('converts only the sound of an H.264 MOV with PCM audio', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const f = await make('d.mov', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], ['-c:a', 'pcm_s16le'])
    const r = await keep(f)
    expect(r).toMatchObject({ plan: { kind: 'audio' } })
    if ('refused' in r) throw new Error('refused')
    expect(r.result.streams.map((s) => s.codec_name)).toEqual(['h264', 'aac'])
  })

  it('keeps a silent clip silent', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const f = await make('e.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], null)
    const r = await keep(f)
    if ('refused' in r) throw new Error('refused')
    expect(r.probe.has_audio).toBe(false)
  })

  it('refuses text and random bytes named .mp4', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const text = join(dir, 'text.mp4')
    writeFileSync(text, 'hello, not a video')
    expect(await keep(text)).toEqual({ refused: 'sniff' })
    // An ftyp header over garbage passes the sniff; the probe is what refuses it.
    const fake = join(dir, 'fake.mp4')
    writeFileSync(
      fake,
      Buffer.concat([
        Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0mp42isom', 'latin1'),
        Buffer.alloc(4096, 7)
      ])
    )
    const outcome = await keep(fake).then(
      (r) => ('refused' in r ? r.refused : 'kept'),
      () => 'probe-failed'
    )
    expect(['probe-failed', 'UPLOAD_NO_VIDEO']).toContain(outcome)
  })
})
