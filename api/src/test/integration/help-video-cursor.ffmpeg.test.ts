import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasFfmpeg, probeVideo, runFfmpeg } from '../../services/ffmpeg.js'
import { buildCursorAss } from '../../services/help-video-cursor.js'
import { normalizeEdits } from '../../services/help-video-edits.js'
import { buildRenderArgs, renderSizes } from '../../services/help-video-render-plan.js'

// A moving zoom (#1539) and the burned-in cursor (#1517) through real ffmpeg:
// the st/ld crop expressions and the libass filter must both be accepted.

describe('moving zoom and cursor through real ffmpeg', () => {
  it('renders a clip with a panning zoom and an ASS cursor', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const dir = mkdtempSync(join(tmpdir(), 'nvr-cursor-'))
    const src = join(dir, 'src.webm')
    await runFfmpeg([
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=15:duration=3',
      '-c:v',
      'libvpx',
      src
    ])
    const edits = normalizeEdits(
      {
        segments: [{ start_ms: 0, end_ms: 3000, speed: 1 }],
        zooms: [
          {
            start_ms: 500,
            end_ms: 2500,
            rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
            ease_ms: 200,
            keyframes: [
              { at_ms: 800, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } },
              { at_ms: 2000, rect: { x: 0.5, y: 0.4, w: 0.4, h: 0.4 } }
            ]
          }
        ],
        cursor: { show: true, shortcuts: true }
      },
      3000
    )
    const { out: size } = renderSizes(640, 360, edits.crop)
    const assPath = join(dir, 'cursor.ass')
    writeFileSync(
      assPath,
      buildCursorAss({
        pointer: {
          samples: Array.from({ length: 40 }, (_, i) => ({
            t_ms: i * 50,
            x: 0.2 + i * 0.01,
            y: 0.3 + (i % 5) * 0.01
          })),
          shortcuts: [{ t_ms: 1000, keys: 'Meta+S' }]
        },
        edits,
        out: size,
        durationMs: 3000,
        shortcuts: true
      })
    )
    const out = join(dir, 'out.mp4')
    await runFfmpeg(
      buildRenderArgs({
        edits,
        width: 640,
        height: 360,
        hasAudio: false,
        sourcePath: src,
        sourceMime: 'video/webm',
        overlays: [],
        cursor: { assPath },
        outputPath: out,
        threads: 2
      })
    )
    const p = await probeVideo(out, 'video/mp4')
    expect(p.width).toBe(640)
    expect(p.height).toBe(360)
    expect(p.duration_ms).toBeGreaterThan(2500)
  }, 180_000)
})
