import { lockedInputArgs } from './ffmpeg.js'
import type { Rect, VideoEdits } from './help-video-edits.js'

// Builds the single ffmpeg pass that bakes a help video's edits into an MP4.
// Everything is applied in SOURCE time — blur, annotation overlays, zoom — and
// the cut/speed step runs last, so every timed item can use the times stored
// in the edits unchanged. Expressions are single-quoted inside the graph so
// commas and colons stay literal; ffmpeg receives the graph as one argument.

export interface RenderInput {
  edits: VideoEdits
  width: number
  height: number
  hasAudio: boolean
  sourcePath: string
  /** Mime of the uploaded recording; pins the demuxer so the plan fails closed. */
  sourceMime: string
  overlays: Array<{ path: string; start_ms: number; end_ms: number }>
  outputPath: string
  threads: number
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
const sec = (ms: number) => (ms / 1000).toFixed(3)

export function outputSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 1920 / width, 1080 / height)
  return { width: even(width * scale), height: even(height * scale) }
}

export function pixelRect(
  r: Rect,
  size: { width: number; height: number }
): { x: number; y: number; w: number; h: number } {
  const w = Math.min(even(r.w * size.width), size.width)
  const h = Math.min(even(r.h * size.height), size.height)
  const x = Math.max(0, Math.min(Math.floor((r.x * size.width) / 2) * 2, size.width - w))
  const y = Math.max(0, Math.min(Math.floor((r.y * size.height) / 2) * 2, size.height - h))
  return { x, y, w, h }
}

function atempo(speed: number): string {
  if (speed === 4) return 'atempo=2,atempo=2'
  if (speed === 1) return 'anull'
  return `atempo=${speed}`
}

export function buildRenderArgs(input: RenderInput): string[] {
  // An unmapped mime yields no pinned demuxer; refuse rather than let ffmpeg probe.
  const sourceLock = lockedInputArgs(input.sourceMime)
  if (!sourceLock.includes('-f')) {
    throw new Error(`Unsupported recording format: ${input.sourceMime}`)
  }
  const out = outputSize(input.width, input.height)
  const e = input.edits
  const parts: string[] = []
  let label = 'v0'
  let n = 0
  const next = () => `v${++n}`
  parts.push(`[0:v]scale=${out.width}:${out.height},format=yuv420p,setsar=1[${label}]`)

  for (const b of e.blurs) {
    const pr = pixelRect(b.rect, out)
    // Chroma planes are half size and need room for a radius-1 box blur, so
    // a blur box is never smaller than 4x4 pixels (ffmpeg fails below that).
    const w = Math.min(Math.max(pr.w, 4), out.width)
    const h = Math.min(Math.max(pr.h, 4), out.height)
    const r = { x: Math.min(pr.x, out.width - w), y: Math.min(pr.y, out.height - h), w, h }
    // boxblur's radius applies to the half-size chroma planes too, so it is
    // bounded by a quarter of the smaller side.
    const strength = Math.max(1, Math.min(b.strength, Math.floor(Math.min(r.w, r.h) / 4) - 1))
    const a = `${label}a`
    const c = `${label}b`
    const blurred = `bl${n}`
    const to = next()
    parts.push(`[${label}]split[${a}][${c}]`)
    parts.push(`[${c}]crop=${r.w}:${r.h}:${r.x}:${r.y},boxblur=${strength}:1[${blurred}]`)
    parts.push(
      `[${a}][${blurred}]overlay=${r.x}:${r.y}:enable='between(t,${sec(b.start_ms)},${sec(b.end_ms)})'[${to}]`
    )
    label = to
  }

  input.overlays.forEach((o, i) => {
    const to = next()
    parts.push(
      `[${label}][${i + 1}:v]overlay=0:0:enable='between(t,${sec(o.start_ms)},${sec(o.end_ms)})'[${to}]`
    )
    label = to
  })

  if (e.zooms.length) {
    const p = (a: number, b: number, ease: number) =>
      ease > 0
        ? `clip(min((t-${sec(a)})/${sec(ease)},(${sec(b)}-t)/${sec(ease)}),0,1)`
        : `between(t,${sec(a)},${sec(b)})`
    const zTerms = e.zooms.map(
      (z) => `(${(1 / z.rect.w - 1).toFixed(4)})*${p(z.start_ms, z.end_ms, z.ease_ms)}`
    )
    const cxTerms = e.zooms.map(
      (z) => `(${(z.rect.x + z.rect.w / 2 - 0.5).toFixed(4)})*${p(z.start_ms, z.end_ms, z.ease_ms)}`
    )
    const cyTerms = e.zooms.map(
      (z) => `(${(z.rect.y + z.rect.h / 2 - 0.5).toFixed(4)})*${p(z.start_ms, z.end_ms, z.ease_ms)}`
    )
    const Z = `(1+${zTerms.join('+')})`
    const CX = `(0.5+${cxTerms.join('+')})`
    const CY = `(0.5+${cyTerms.join('+')})`
    const to = next()
    parts.push(
      `[${label}]scale=w='trunc(${out.width}*${Z}/2)*2':h='trunc(${out.height}*${Z}/2)*2':eval=frame,` +
        // crop's iw/ih are the size the graph was configured with (the unzoomed
        // frame), not the per-frame scaled size, so use the zoomed size explicitly.
        `crop=${out.width}:${out.height}:` +
        `x='max(0,min(${CX}*(${out.width}*${Z})-${out.width}/2,${out.width}*${Z}-${out.width}))':` +
        `y='max(0,min(${CY}*(${out.height}*${Z})-${out.height}/2,${out.height}*${Z}-${out.height}))'[${to}]`
    )
    label = to
  }

  const segs = e.segments
  const untouched = segs.length === 1 && segs[0].start_ms === 0 && segs[0].speed === 1
  const maps: string[] = ['-map', '[vout]']
  if (untouched) {
    // A single full piece still bounds the end, so a recording whose header
    // claims a little more time than the edits keep never runs past them.
    parts.push(`[${label}]trim=end=${sec(segs[0].end_ms)},setpts=PTS-STARTPTS[vout]`)
    if (input.hasAudio) {
      parts.push(`[0:a]atrim=end=${sec(segs[0].end_ms)},asetpts=PTS-STARTPTS[aout]`)
      maps.push('-map', '[aout]')
    }
  } else {
    const k = segs.length
    parts.push(`[${label}]split=${k}${segs.map((_, i) => `[s${i}]`).join('')}`)
    if (input.hasAudio) parts.push(`[0:a]asplit=${k}${segs.map((_, i) => `[as${i}]`).join('')}`)
    segs.forEach((s, i) => {
      parts.push(
        `[s${i}]trim=start=${sec(s.start_ms)}:end=${sec(s.end_ms)},setpts=(PTS-STARTPTS)/${s.speed}[c${i}]`
      )
      if (input.hasAudio) {
        parts.push(
          `[as${i}]atrim=start=${sec(s.start_ms)}:end=${sec(s.end_ms)},asetpts=PTS-STARTPTS,${atempo(s.speed)}[ca${i}]`
        )
      }
    })
    const ins = segs.map((_, i) => (input.hasAudio ? `[c${i}][ca${i}]` : `[c${i}]`)).join('')
    parts.push(
      `${ins}concat=n=${k}:v=1:a=${input.hasAudio ? 1 : 0}[vout]${input.hasAudio ? '[aout]' : ''}`
    )
    if (input.hasAudio) maps.push('-map', '[aout]')
  }

  return [
    '-y',
    '-v',
    'error',
    '-threads',
    String(input.threads),
    '-filter_complex_threads',
    '1',
    ...sourceLock,
    '-i',
    input.sourcePath,
    // Annotation images are our own PNGs; pin them so nothing else is probed.
    ...input.overlays.flatMap((o) => [
      '-protocol_whitelist',
      'file',
      '-f',
      'png_pipe',
      '-i',
      o.path
    ]),
    '-filter_complex',
    parts.join(';'),
    ...maps,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    String(input.threads),
    ...(input.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
    '-movflags',
    '+faststart',
    input.outputPath
  ]
}

export function buildPosterArgs(renderedPath: string, editedMs: number, outPath: string): string[] {
  return [
    '-y',
    '-v',
    'error',
    '-ss',
    sec(editedMs),
    ...lockedInputArgs('video/mp4'),
    '-i',
    renderedPath,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    outPath
  ]
}
