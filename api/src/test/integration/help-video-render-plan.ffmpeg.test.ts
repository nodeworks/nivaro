import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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

  it('accepts the smallest blur box at full strength and a single sped-up segment', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
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
    const edits = normalizeEdits(
      {
        segments: [{ start_ms: 1000, end_ms: 4000, speed: 2 }],
        blurs: [
          { start_ms: 0, end_ms: 4000, rect: { x: 0.5, y: 0.5, w: 0.01, h: 0.01 }, strength: 40 }
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
        overlays: [],
        outputPath: out,
        threads: 2
      })
    )
    const p = await probeVideo(out, 'video/mp4')
    expect(p.has_audio).toBe(true)
    expect(p.duration_ms).toBeGreaterThan(1200) // 3 s at 2x = 1.5 s
    expect(p.duration_ms).toBeLessThan(1900)
  }, 120_000)

  // Four solid quadrants: TL red, TR green, BL blue, BR yellow. Any sampled
  // pixel then says which part of the source the render landed on.
  const QUADS = { tl: [255, 0, 0], tr: [0, 255, 0], bl: [0, 0, 255], br: [255, 255, 0] } as const
  type Rgb = readonly number[]
  const near = (px: Rgb, want: Rgb) => px.every((v, i) => Math.abs(v - want[i]) < 40)

  async function quadrantClip(dir: string): Promise<string> {
    const src = join(dir, 'quad.webm')
    await runFfmpeg([
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=640x360:r=15:d=4,' +
        'drawbox=x=320:y=0:w=320:h=180:color=lime:t=fill,' +
        'drawbox=x=0:y=180:w=320:h=180:color=blue:t=fill,' +
        'drawbox=x=320:y=180:w=320:h=180:color=yellow:t=fill',
      '-c:v',
      'libvpx',
      src
    ])
    return src
  }

  async function renderZoom(
    dir: string,
    src: string,
    zooms: Array<{
      start_ms: number
      end_ms: number
      rect: { x: number; y: number; w: number; h: number }
      ease_ms: number
    }>
  ): Promise<string> {
    const out = join(dir, `zoom-${zooms.length}-${Math.random().toString(36).slice(2)}.mp4`)
    await runFfmpeg(
      buildRenderArgs({
        edits: normalizeEdits({ zooms }, 4000),
        width: 640,
        height: 360,
        hasAudio: false,
        sourcePath: src,
        sourceMime: 'video/webm',
        overlays: [],
        outputPath: out,
        threads: 2
      })
    )
    return out
  }

  async function pixel(file: string, atSec: number, x: number, y: number): Promise<Rgb> {
    const { stdout } = await promisify(execFile)(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(atSec),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `format=rgb24,crop=1:1:${x}:${y}`,
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        '-'
      ],
      { encoding: 'buffer' }
    )
    return [...stdout]
  }

  // Inset sample points, so codec blur at the frame edge cannot matter.
  const CORNERS: Array<[number, number]> = [
    [8, 8],
    [630, 8],
    [8, 350],
    [630, 350],
    [320, 180]
  ]

  // The zoom must start after t=0: crop configures its iw/ih from the first
  // (unzoomed) frame, which is what exposed the top-left bug.
  it('lands a zoom on the bottom-right quadrant, not the top-left corner', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const dir = mkdtempSync(join(tmpdir(), 'nvr-render-'))
    const src = await quadrantClip(dir)
    const out = await renderZoom(dir, src, [
      { start_ms: 1000, end_ms: 4000, rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, ease_ms: 0 }
    ])
    for (const [x, y] of CORNERS) {
      expect(near(await pixel(out, 2, x, y), QUADS.br), `pixel ${x},${y}`).toBe(true)
    }
  }, 120_000)

  it('clamps a zoom in a corner inside the frame', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const dir = mkdtempSync(join(tmpdir(), 'nvr-render-'))
    const src = await quadrantClip(dir)
    // Centre 0.9/0.9 with a 0.4 window would reach past the edge: clamps to the
    // bottom-right 40% of the frame, which is all yellow.
    const br = await renderZoom(dir, src, [
      { start_ms: 1000, end_ms: 4000, rect: { x: 0.7, y: 0.7, w: 0.3, h: 0.3 }, ease_ms: 0 }
    ])
    for (const [x, y] of CORNERS) {
      expect(near(await pixel(br, 2, x, y), QUADS.br), `br ${x},${y}`).toBe(true)
    }
    const tl = await renderZoom(dir, src, [
      { start_ms: 1000, end_ms: 4000, rect: { x: 0, y: 0, w: 0.3, h: 0.3 }, ease_ms: 0 }
    ])
    for (const [x, y] of CORNERS) {
      expect(near(await pixel(tl, 2, x, y), QUADS.tl), `tl ${x},${y}`).toBe(true)
    }
  }, 120_000)

  it('eases a time-varying zoom in and back out', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const dir = mkdtempSync(join(tmpdir(), 'nvr-render-'))
    const src = await quadrantClip(dir)
    const out = await renderZoom(dir, src, [
      { start_ms: 1000, end_ms: 3000, rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, ease_ms: 500 }
    ])
    // Before the zoom: the untouched frame.
    expect(near(await pixel(out, 0.3, 8, 8), QUADS.tl)).toBe(true)
    expect(near(await pixel(out, 0.3, 630, 350), QUADS.br)).toBe(true)
    // Fully eased in: bottom-right quadrant fills the frame.
    for (const [x, y] of CORNERS) {
      expect(near(await pixel(out, 2, x, y), QUADS.br), `mid ${x},${y}`).toBe(true)
    }
    // Eased back out: untouched again.
    expect(near(await pixel(out, 3.6, 8, 8), QUADS.tl)).toBe(true)
  }, 120_000)
  // M4: a blur on a small field gets its radius capped (ffmpeg's chroma
  // limit). Extra passes keep it at least as strong as asked. Measured on a
  // fine 2-px checkerboard (text-like detail): the variance left in the
  // blurred field, one pass at the capped radius (before) vs the planned
  // passes (after).
  async function regionVariance(file: string, w: number, h: number, x: number, y: number) {
    const { stdout } = await promisify(execFile)(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        '1',
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `format=gray,crop=${w}:${h}:${x}:${y}`,
        '-f',
        'rawvideo',
        '-'
      ],
      { encoding: 'buffer', maxBuffer: 1 << 20 }
    )
    const px = [...stdout]
    const mean = px.reduce((a, b) => a + b, 0) / px.length
    return px.reduce((a, b) => a + (b - mean) ** 2, 0) / px.length
  }

  it('a capped blur still smooths fine detail at least as strongly as asked', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const dir = mkdtempSync(join(tmpdir(), 'nvr-render-'))
    const src = join(dir, 'checker.webm')
    await runFfmpeg([
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      "color=c=black:s=640x360:r=15:d=2,format=gray,geq=lum='255*mod(floor(X/2)+floor(Y/2),2)',format=yuv420p",
      '-c:v',
      'libvpx',
      '-b:v',
      '8M',
      src
    ])
    // A 24x16 field at (96,72): the radius asked for (20) caps at
    // floor(16/4)-1 = 3, so the plan asks for ceil(20*21 / (3*4)) = 35 passes.
    const args = buildRenderArgs({
      edits: normalizeEdits(
        {
          blurs: [
            {
              start_ms: 0,
              end_ms: 2000,
              rect: { x: 96 / 640, y: 72 / 360, w: 24 / 640, h: 16 / 360 },
              strength: 20
            }
          ]
        },
        2000
      ),
      width: 640,
      height: 360,
      hasAudio: false,
      sourcePath: src,
      sourceMime: 'video/webm',
      overlays: [],
      outputPath: join(dir, 'after.mp4'),
      threads: 2
    })
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('crop=24:16:96:72,boxblur=3:35')
    await runFfmpeg(args)
    const before = args.map((a) =>
      a === graph
        ? graph.replace('boxblur=3:35', 'boxblur=3:1')
        : a === join(dir, 'after.mp4')
          ? join(dir, 'before.mp4')
          : a
    )
    await runFfmpeg(before)
    // Inset 2 px from the field's edge; the source region for scale.
    const region = [20, 12, 98, 74] as const
    const raw = await regionVariance(src, ...region)
    const one = await regionVariance(join(dir, 'before.mp4'), ...region)
    const planned = await regionVariance(join(dir, 'after.mp4'), ...region)
    expect(raw).toBeGreaterThan(1000) // the pattern is really there
    expect(planned).toBeLessThan(one / 4)
    expect(planned).toBeLessThan(raw / 100)
  }, 120_000)
})
