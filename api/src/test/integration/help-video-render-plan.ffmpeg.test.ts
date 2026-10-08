import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasFfmpeg, probeVideo, runFfmpeg } from '../../services/ffmpeg.js'
import { normalizeEdits } from '../../services/help-video-edits.js'
import { buildPosterArgs, buildRenderArgs } from '../../services/help-video-render-plan.js'

describe('render plan through real ffmpeg', () => {
  it('cuts, speeds up, blurs, zooms and overlays a test clip', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip() // reported as skipped, never as a silent pass
    const dir = mkdtempSync(join(tmpdir(), 'nvr-render-'))
    const src = join(dir, 'src.webm')
    await runFfmpeg([
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=15:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-c:v',
      'libvpx',
      '-c:a',
      'libopus',
      src
    ])
    const png = join(dir, 'a.png')
    await runFfmpeg([
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red@0.5:s=640x360,format=rgba',
      '-frames:v',
      '1',
      png
    ])
    const edits = normalizeEdits(
      {
        segments: [
          { start_ms: 0, end_ms: 1000, speed: 1 },
          { start_ms: 2000, end_ms: 4000, speed: 2 }
        ],
        blurs: [
          { start_ms: 0, end_ms: 4000, rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, strength: 8 }
        ],
        zooms: [
          { start_ms: 2000, end_ms: 4000, rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, ease_ms: 300 }
        ]
      },
      4000
    )
    const out = join(dir, 'out.mp4')
    await runFfmpeg(
      buildRenderArgs({
        edits,
        width: 640,
        height: 360,
        hasAudio: true,
        sourcePath: src,
        sourceMime: 'video/webm',
        overlays: [{ path: png, start_ms: 500, end_ms: 1500 }],
        outputPath: out,
        threads: 2
      })
    )
    const p = await probeVideo(out, 'video/mp4')
    expect(p.width).toBe(640)
    expect(p.height).toBe(360)
    expect(p.has_audio).toBe(true)
    expect(p.duration_ms).toBeGreaterThan(1700) // 1 s + 2 s at 2× = 2 s
    expect(p.duration_ms).toBeLessThan(2400)

    const poster = join(dir, 'p.jpg')
    await runFfmpeg(buildPosterArgs(out, 500, poster))
    const pj = await probeVideo(poster)
    expect(pj.width).toBe(640)
  }, 120_000)
})
