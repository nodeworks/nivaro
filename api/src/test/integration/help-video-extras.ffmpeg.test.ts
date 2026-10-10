import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasFfmpeg, probeVideo, runFfmpeg } from '../../services/ffmpeg.js'
import { type ClipPlanInput, clipSpans } from '../../services/help-video-clip-plan.js'
import { emptyEdits, type VideoEdits } from '../../services/help-video-edits.js'
import {
  buildPeaksArgs,
  buildSpriteArgs,
  peaksFromPcm,
  spriteGeometry
} from '../../services/help-video-extras-plan.js'
import { runClipPlan } from './help-video-graph-file.js'

// #1560 / #1562 against the real ffmpeg: a 6-second test pattern with a tone
// gets a sprite sheet and peaks; a clip of it comes out as an MP4 and a GIF.

const dir = mkdtempSync(join(tmpdir(), 'nvr-extras-'))

async function source(): Promise<string> {
  const out = join(dir, 'src.mp4')
  await runFfmpeg([
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=15:duration=6',
    '-f',
    'lavfi',
    // Silence for 2 s, then a tone: the peaks must show the change.
    '-i',
    "sine=frequency=440:duration=6,volume='if(lt(t,2),0,1)':eval=frame",
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    out
  ])
  return out
}

describe('sprite sheet and peaks', () => {
  it('tiles one frame a second and reads peaks that follow the sound', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const src = await source()
    const probe = await probeVideo(src, 'video/mp4')
    const g = spriteGeometry(probe.duration_ms, probe.width, probe.height)
    expect(g).toMatchObject({ tile_w: 160, tile_h: 90, interval_ms: 1000, cols: 6, rows: 1 })
    const sheet = join(dir, 'sprite.jpg')
    await runFfmpeg(buildSpriteArgs({ path: src, mime: 'video/mp4', threads: 1 }, g!, sheet))
    const jpg = await probeVideo(sheet)
    expect(jpg.width).toBe(160 * 6)
    expect(jpg.height).toBe(90)
    expect(readFileSync(sheet).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))

    const pcm = join(dir, 'peaks.pcm')
    await runFfmpeg(buildPeaksArgs({ path: src, mime: 'video/mp4' }, pcm))
    const peaks = peaksFromPcm(readFileSync(pcm))
    expect(peaks.length).toBeGreaterThanOrEqual(58)
    expect(peaks.length).toBeLessThanOrEqual(62)
    // lavfi's sine is a quiet tone (about -18 dBFS): the peaks must still
    // read as silence first, then a steady level several times louder.
    const quiet = Math.max(...peaks.slice(0, 15))
    const loud = Math.min(...peaks.slice(25, 55))
    expect(quiet).toBeLessThan(0.03)
    expect(loud).toBeGreaterThan(0.08)
    expect(loud).toBeGreaterThan(quiet * 3)
  }, 60_000)
})

describe('clips', () => {
  it('cuts an MP4 from the original with the edit mapping, and a GIF', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const src = await source()
    const edits: VideoEdits = {
      ...emptyEdits(6000),
      segments: [
        { start_ms: 0, end_ms: 2000, speed: 1 },
        { start_ms: 3000, end_ms: 5000, speed: 2 }
      ]
    }
    // Edited 1–3 s: 1 s of piece 1, then 1 s (2 source s) of the 2x piece.
    const cut = { from: 'source' as const, spans: clipSpans(edits, 1000, 3000), edits }
    const base: ClipPlanInput = {
      kind: 'mp4',
      inputPath: src,
      inputMime: 'video/mp4',
      width: 640,
      height: 360,
      hasAudio: true,
      threads: 1,
      outputPath: join(dir, 'clip.mp4'),
      cut,
      palettePath: join(dir, 'palette.png')
    }
    await runClipPlan(base)
    const mp4 = await probeVideo(base.outputPath, 'video/mp4')
    expect(mp4.width).toBe(640)
    expect(mp4.has_audio).toBe(true)
    expect(mp4.duration_ms).toBeGreaterThan(1700)
    expect(mp4.duration_ms).toBeLessThan(2400)

    const gif = { ...base, kind: 'gif' as const, outputPath: join(dir, 'clip.gif') }
    await runClipPlan(gif, 'palette')
    expect(statSync(gif.palettePath as string).size).toBeGreaterThan(0)
    await runClipPlan(gif, 'encode')
    const bytes = readFileSync(gif.outputPath)
    expect(bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a')
    expect(bytes.length).toBeGreaterThan(1000)
  }, 90_000)

  it('cuts a window straight out of a rendered file', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const src = await source()
    const out = join(dir, 'rendered-clip.mp4')
    await runClipPlan({
      kind: 'mp4',
      inputPath: src,
      inputMime: 'video/mp4',
      width: 640,
      height: 360,
      hasAudio: true,
      threads: 1,
      outputPath: out,
      cut: { from: 'rendered', start_ms: 4000, end_ms: 5500 }
    })
    const probe = await probeVideo(out, 'video/mp4')
    expect(probe.duration_ms).toBeGreaterThan(1300)
    expect(probe.duration_ms).toBeLessThan(1800)
  }, 60_000)
})
