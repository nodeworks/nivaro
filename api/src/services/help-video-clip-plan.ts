import { lockedInputArgs } from './ffmpeg.js'
import { introMs, type VideoEdits } from './help-video-edits.js'
import { blurPower, graphArgs, pixelRect, renderSizes } from './help-video-render-plan.js'

// Short clips and GIFs (#1562): the ffmpeg plan for one clip. A clip is a
// window of EDITED time. When the version's render is current it is cut
// straight from the rendered MP4 (every edit baked in). Otherwise it is cut
// from the original recording with the edit mapping: the kept pieces the
// window crosses, at their speeds, after the crop and the blurs — so a clip
// never shows what the edits hide. Callouts, zooms, cards and music are left
// to the render (the editor says so); an author who wants them renders first.

export const CLIP_LIMITS = {
  /** A clip is at most this long (edited time). */
  maxMs: 30_000,
  minMs: 500,
  /** Clips per video, failed ones not counted. */
  maxPerVideo: 20,
  /** Clips queued or being made across the whole instance. */
  maxQueued: 50,
  gifWidth: 640,
  gifFps: 12,
  mp4Width: 1280,
  labelMax: 120
} as const

export type ClipKind = 'mp4' | 'gif'
export const CLIP_KINDS: readonly ClipKind[] = ['mp4', 'gif']
export function isClipKind(v: unknown): v is ClipKind {
  return typeof v === 'string' && (CLIP_KINDS as readonly string[]).includes(v)
}

/** One kept piece of the recording a clip window crosses, in source time,
 *  with the speed it plays at. */
export interface ClipSpan {
  start_ms: number
  end_ms: number
  speed: number
}

/** The source spans an edited-time window covers (cards contribute none),
 *  each with its piece's speed. Like editedSpanToSource, plus the speed. */
export function clipSpans(e: VideoEdits, startMs: number, endMs: number): ClipSpan[] {
  const out: ClipSpan[] = []
  let acc = introMs(e)
  for (const s of e.segments) {
    const len = (s.end_ms - s.start_ms) / s.speed
    const a = Math.max(startMs, acc)
    const b = Math.min(endMs, acc + len)
    if (b > a) {
      const start = Math.round(s.start_ms + (a - acc) * s.speed)
      const end = Math.round(s.start_ms + (b - acc) * s.speed)
      if (end > start) out.push({ start_ms: start, end_ms: end, speed: s.speed })
    }
    acc += len
  }
  return out
}

export type ClipCut =
  | { from: 'rendered'; start_ms: number; end_ms: number }
  | { from: 'source'; spans: ClipSpan[]; edits: VideoEdits }

/** How long the finished clip plays. */
export function clipDurationMs(cut: ClipCut): number {
  if (cut.from === 'rendered') return Math.max(0, cut.end_ms - cut.start_ms)
  return Math.round(cut.spans.reduce((t, s) => t + (s.end_ms - s.start_ms) / s.speed, 0))
}

export interface ClipPlanInput {
  kind: ClipKind
  inputPath: string
  inputMime: string
  /** The input file's frame size. */
  width: number
  height: number
  hasAudio: boolean
  threads: number
  outputPath: string
  cut: ClipCut
  /** GIF only: where the palette is written (pass 'palette') and read (pass 'encode'). */
  palettePath?: string
  /** Where the caller writes the filter graph (buildClipPlan hands it back):
   *  the arguments then name it with -filter_complex_script. Without it the
   *  graph is one -filter_complex argument (tests). A clip cut from the
   *  source carries one branch per kept piece, which as one argument can
   *  pass the kernel's per-argument limit. */
  graphFile?: string
}

const sec = (ms: number) => (ms / 1000).toFixed(3)
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)

function atempo(speed: number): string {
  if (speed === 4) return 'atempo=2,atempo=2'
  if (speed === 1) return 'anull'
  return `atempo=${speed}`
}

/** The finished clip's frame size: the input, bounded by the kind's width cap. */
export function clipOutputSize(
  kind: ClipKind,
  input: { width: number; height: number },
  cut?: ClipCut
): { width: number; height: number } {
  let w = input.width
  let h = input.height
  if (cut?.from === 'source') {
    const out = renderSizes(input.width, input.height, cut.edits.crop).out
    w = out.width
    h = out.height
  }
  const cap = kind === 'gif' ? CLIP_LIMITS.gifWidth : CLIP_LIMITS.mp4Width
  if (w <= cap) return { width: even(w), height: even(h) }
  return { width: cap, height: even((h * cap) / w) }
}

/** The first moment of the input the clip needs: ffmpeg seeks there before
 *  decoding, so a clip near the end never decodes the whole recording. */
export function clipInputWindow(cut: ClipCut): { offset_ms: number; length_ms: number } {
  if (cut.from === 'rendered') {
    return { offset_ms: cut.start_ms, length_ms: Math.max(1, cut.end_ms - cut.start_ms) }
  }
  const first = cut.spans[0]?.start_ms ?? 0
  const last = cut.spans[cut.spans.length - 1]?.end_ms ?? first + 1
  return { offset_ms: first, length_ms: Math.max(1, last - first) }
}

/**
 * The ffmpeg arguments for a clip. An MP4 is one run (`pass` ignored); a GIF
 * is two: 'palette' builds a palette of the frames, 'encode' draws the GIF
 * with it (palettegen / paletteuse), so colours and dithering stay clean.
 */
export function buildClipArgs(input: ClipPlanInput, pass?: 'palette' | 'encode'): string[] {
  return buildClipPlan(input, pass).args
}

/** The arguments and the filter graph of one clip run. With `graphFile` the
 *  caller writes `graph` there before spawning ffmpeg. */
export function buildClipPlan(
  input: ClipPlanInput,
  pass?: 'palette' | 'encode'
): { args: string[]; graph: string } {
  const lock = lockedInputArgs(input.inputMime)
  if (!lock.includes('-f')) throw new Error(`Unsupported recording format: ${input.inputMime}`)
  const gif = input.kind === 'gif'
  if (gif && !pass) throw new Error('A GIF needs a pass')
  if (gif && !input.palettePath) throw new Error('A GIF needs a palette path')
  const window = clipInputWindow(input.cut)
  const off = window.offset_ms
  const parts: string[] = []
  const audio = !gif && input.hasAudio
  const cut = input.cut

  if (cut.from === 'rendered') {
    // The input window is the clip: timestamps start at 0 after the seek.
    parts.push(`[0:v]trim=end=${sec(window.length_ms)},setpts=PTS-STARTPTS[vcut]`)
    if (audio) parts.push(`[0:a]atrim=end=${sec(window.length_ms)},asetpts=PTS-STARTPTS[acut]`)
  } else {
    const e = cut.edits
    const sizes = renderSizes(input.width, input.height, e.crop)
    const work = sizes.work
    let label = 'v0'
    let n = 0
    const next = () => `v${++n}`
    parts.push(`[0:v]scale=${work.width}:${work.height},format=yuv420p,setsar=1[${label}]`)
    // Blurs exactly as the render draws them, in time shifted by the seek.
    for (const b of e.blurs) {
      if (b.end_ms <= off || b.start_ms >= off + window.length_ms) continue
      const pr = pixelRect(b.rect, work)
      const w = Math.min(Math.max(pr.w, 4), work.width)
      const h = Math.min(Math.max(pr.h, 4), work.height)
      const r = { x: Math.min(pr.x, work.width - w), y: Math.min(pr.y, work.height - h), w, h }
      const strength = Math.max(1, Math.min(b.strength, Math.floor(Math.min(r.w, r.h) / 4) - 1))
      const power = blurPower(b.strength, strength)
      const a = `${label}a`
      const c = `${label}b`
      const blurred = `bl${n}`
      const to = next()
      parts.push(`[${label}]split[${a}][${c}]`)
      parts.push(`[${c}]crop=${r.w}:${r.h}:${r.x}:${r.y},boxblur=${strength}:${power}[${blurred}]`)
      parts.push(
        `[${a}][${blurred}]overlay=${r.x}:${r.y}:enable='between(t,${sec(Math.max(0, b.start_ms - off))},${sec(b.end_ms - off)})'[${to}]`
      )
      label = to
    }
    if (sizes.crop) {
      const c = sizes.crop
      const to = next()
      parts.push(`[${label}]crop=${c.w}:${c.h}:${c.x}:${c.y},setsar=1[${to}]`)
      label = to
    }
    const spans = cut.spans
    if (!spans.length) throw new Error('The clip covers nothing of the recording')
    if (spans.length === 1) {
      const s = spans[0]
      parts.push(
        `[${label}]trim=start=${sec(s.start_ms - off)}:end=${sec(s.end_ms - off)},setpts=(PTS-STARTPTS)/${s.speed}[vcut]`
      )
      if (audio) {
        parts.push(
          `[0:a]atrim=start=${sec(s.start_ms - off)}:end=${sec(s.end_ms - off)},asetpts=PTS-STARTPTS,${atempo(s.speed)}[acut]`
        )
      }
    } else {
      const k = spans.length
      parts.push(`[${label}]split=${k}${spans.map((_, i) => `[s${i}]`).join('')}`)
      if (audio) parts.push(`[0:a]asplit=${k}${spans.map((_, i) => `[as${i}]`).join('')}`)
      spans.forEach((s, i) => {
        parts.push(
          `[s${i}]trim=start=${sec(s.start_ms - off)}:end=${sec(s.end_ms - off)},setpts=(PTS-STARTPTS)/${s.speed}[c${i}]`
        )
        if (audio) {
          parts.push(
            `[as${i}]atrim=start=${sec(s.start_ms - off)}:end=${sec(s.end_ms - off)},asetpts=PTS-STARTPTS,${atempo(s.speed)}[ca${i}]`
          )
        }
      })
      const ins = spans.map((_, i) => (audio ? `[c${i}][ca${i}]` : `[c${i}]`)).join('')
      parts.push(`${ins}concat=n=${k}:v=1:a=${audio ? 1 : 0}[vcut]${audio ? '[acut]' : ''}`)
    }
  }

  const size = clipOutputSize(input.kind, input, input.cut)
  const maps: string[] = []
  let tail: string[]
  if (gif) {
    const look = `fps=${CLIP_LIMITS.gifFps},scale=${size.width}:${size.height}:flags=lanczos`
    if (pass === 'palette') {
      parts.push(`[vcut]${look},palettegen=stats_mode=diff[pal]`)
      maps.push('-map', '[pal]')
      tail = ['-frames:v', '1', '-update', '1', input.palettePath as string]
    } else {
      parts.push(
        `[vcut]${look}[vg];[vg][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[gif]`
      )
      maps.push('-map', '[gif]')
      tail = ['-loop', '0', '-f', 'gif', input.outputPath]
    }
  } else {
    parts.push(`[vcut]scale=${size.width}:${size.height}:flags=lanczos,format=yuv420p[vout]`)
    maps.push('-map', '[vout]')
    if (audio) maps.push('-map', '[acut]')
    tail = [
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      input.outputPath
    ]
  }

  const graph = graphArgs(parts, input.graphFile)
  const args = [
    '-y',
    '-v',
    'error',
    '-threads',
    String(input.threads),
    '-filter_complex_threads',
    '1',
    // Seek to the window before decoding (accurate: the frames before the
    // exact start are decoded and dropped), read only its length.
    '-ss',
    sec(off),
    '-t',
    sec(window.length_ms),
    ...lock,
    '-i',
    input.inputPath,
    ...(gif && pass === 'encode'
      ? ['-protocol_whitelist', 'file', '-f', 'png_pipe', '-i', input.palettePath as string]
      : []),
    ...graph.args,
    ...maps,
    '-threads',
    String(input.threads),
    ...tail
  ]
  return { args, graph: graph.graph }
}
