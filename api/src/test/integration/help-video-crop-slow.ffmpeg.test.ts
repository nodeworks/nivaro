import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasFfmpeg, probeVideo, runFfmpeg } from '../../services/ffmpeg.js'
import { normalizeEdits } from '../../services/help-video-edits.js'
import { buildRenderArgs } from '../../services/help-video-render-plan.js'

// Slow motion (#1538) and the video crop (#1544) through real ffmpeg.
describe('crop and slow motion through real ffmpeg', () => {
  it('crops to the chosen part and plays a 0.5x piece at half speed', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const dir = mkdtempSync(join(tmpdir(), 'nvr-crop-'))
    const src = join(dir, 'src.webm')
    await runFfmpeg([
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=15:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libvpx',
      '-c:a',
      'libopus',
      src
    ])
    const edits = normalizeEdits(
      {
        crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
        segments: [
          { start_ms: 0, end_ms: 1000, speed: 1 },
          { start_ms: 1000, end_ms: 3000, speed: 0.5 }
        ],
        zooms: [
          { start_ms: 0, end_ms: 1000, rect: { x: 0.25, y: 0, w: 0.5, h: 0.5 }, ease_ms: 200 }
        ]
      },
      3000
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
        overlays: [],
        outputPath: out,
        threads: 2
      })
    )
    const p = await probeVideo(out, 'video/mp4')
    expect(p.width).toBe(320)
    expect(p.height).toBe(360)
    // 1 s + 2 s at 0.5x = 5 s
    expect(p.duration_ms).toBeGreaterThan(4700)
    expect(p.duration_ms).toBeLessThan(5400)
  }, 120_000)
})
