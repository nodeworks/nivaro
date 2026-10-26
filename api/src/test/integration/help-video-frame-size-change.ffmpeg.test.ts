import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { hasFfmpeg, probeVideo, remuxToFileLocal, runFfmpeg } from '../../services/ffmpeg.js'
import { clipSpans } from '../../services/help-video-clip-plan.js'
import { emptyEdits, normalizeEdits } from '../../services/help-video-edits.js'
import { buildSpriteArgs, spriteGeometry } from '../../services/help-video-extras-plan.js'
import { probeImage, runClipPlan, runRenderPlan } from './help-video-graph-file.js'

// A recording whose frame size changes part-way (element fullscreen in the
// recorded tab — a huddle's "View the shared screen full size" — resizes the
// tab capture). The render used to stop at the change: ffmpeg rebuilt the
// filter graph for the new size, every trim restarted, and the published
// video ended there (22 s of 36 on staging). Built here the way the browser
// writes it: one WebM stream, 640x360 for 2 s, then 720x900 (another aspect).

const run = promisify(execFile)
const dir = mkdtempSync(join(tmpdir(), 'nvr-frame-size-'))

async function resizingRecording(): Promise<string> {
  const seg = async (name: string, size: string) => {
    const out = join(dir, name)
    await runFfmpeg([
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${size}:rate=15:duration=2`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'libvpx',
      '-c:a',
      'libopus',
      out
    ])
    return out
  }
  const a = await seg('a.webm', '640x360')
  const b = await seg('b.webm', '720x900')
  const list = join(dir, 'list.txt')
  await writeFile(list, `file '${a}'\nfile '${b}'\n`)
  const joined = join(dir, 'joined.webm')
  await runFfmpeg([
    '-y',
    '-v',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-c',
    'copy',
    joined
  ])
  // What finalize stores: the recording remuxed as is.
  const src = join(dir, 'src.webm')
  await remuxToFileLocal(joined, src, 'video/webm')
  return src
}

async function frameSizes(file: string): Promise<string[]> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v',
    '-show_entries',
    'frame=width,height',
    '-of',
    'csv=p=0',
    file
  ])
  return [
    ...new Set(
      stdout
        .trim()
        .split('\n')
        .map((l) => l.replace(/,+$/, ''))
    )
  ]
}

describe('a recording whose frame size changes mid-stream', () => {
  it('renders at full length, at one size, letterboxing the other aspect', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const src = await resizingRecording()
    expect(await frameSizes(src)).toEqual(['640,360', '720,900'])
    const out = join(dir, 'out.mp4')
    await runRenderPlan({
      edits: emptyEdits(4000),
      width: 640,
      height: 360,
      hasAudio: true,
      sourcePath: src,
      sourceMime: 'video/webm',
      overlays: [],
      outputPath: out,
      threads: 2
    })
    const p = await probeVideo(out, 'video/mp4')
    expect(p.duration_ms).toBeGreaterThan(3800)
    expect(await frameSizes(out)).toEqual(['640,360'])
    // After the change the 720x900 picture sits in the middle, black at the sides.
    const { stdout } = await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        '3',
        '-i',
        out,
        '-frames:v',
        '1',
        '-vf',
        'crop=8:8:0:176',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-'
      ],
      { encoding: 'buffer' }
    )
    expect(Math.max(...(stdout as unknown as Buffer))).toBeLessThan(40)
  }, 120_000)

  it('a cut after the change still lands (the trims are not restarted)', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const src = await resizingRecording()
    const out = join(dir, 'cut.mp4')
    await runRenderPlan({
      edits: normalizeEdits(
        {
          segments: [
            { start_ms: 0, end_ms: 1000, speed: 1 },
            { start_ms: 2500, end_ms: 4000, speed: 1 }
          ]
        },
        4000
      ),
      width: 640,
      height: 360,
      hasAudio: true,
      sourcePath: src,
      sourceMime: 'video/webm',
      overlays: [],
      outputPath: out,
      threads: 2
    })
    const p = await probeVideo(out, 'video/mp4')
    expect(p.duration_ms).toBeGreaterThan(2300) // 1 s + 1.5 s
    expect(p.duration_ms).toBeLessThan(2800)
  }, 120_000)

  it('a clip from the source spans the change', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const src = await resizingRecording()
    const out = join(dir, 'clip.mp4')
    const edits = emptyEdits(4000)
    await runClipPlan({
      kind: 'mp4',
      inputPath: src,
      inputMime: 'video/webm',
      width: 640,
      height: 360,
      hasAudio: true,
      cut: { from: 'source', spans: clipSpans(edits, 1000, 3500), edits },
      outputPath: out,
      threads: 1
    })
    const p = await probeVideo(out, 'video/mp4')
    expect(p.duration_ms).toBeGreaterThan(2300)
  }, 120_000)

  it('the thumbnail sheet covers both halves', async (ctx) => {
    if (!(await hasFfmpeg())) ctx.skip()
    const src = await resizingRecording()
    const g = spriteGeometry(4000, 640, 360) as NonNullable<ReturnType<typeof spriteGeometry>>
    const sheet = join(dir, 'sprite.jpg')
    await runFfmpeg(buildSpriteArgs({ path: src, mime: 'video/webm' }, g, sheet))
    const img = await probeImage(sheet)
    expect(img.width).toBe(g.cols * g.tile_w)
    // Every tile has a picture: the first (before the change) and the last
    // (after it). The sheet used to restart at the change and leave tiles black.
    const tile = async (i: number) => {
      const x = (i % g.cols) * g.tile_w
      const y = Math.floor(i / g.cols) * g.tile_h
      const { stdout } = await run(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          sheet,
          '-vf',
          `crop=${g.tile_w}:${g.tile_h}:${x}:${y}`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'gray',
          '-'
        ],
        { encoding: 'buffer' }
      )
      return Math.max(...(stdout as unknown as Buffer))
    }
    expect(await tile(0)).toBeGreaterThan(100)
    expect(await tile(g.count - 1)).toBeGreaterThan(100)
  }, 120_000)
})
