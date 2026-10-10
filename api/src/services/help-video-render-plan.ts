import { devNull } from 'node:os'
import { lockedInputArgs } from './ffmpeg.js'
import {
  bodyDuration,
  cropOf,
  editedDuration,
  holdsIn,
  introMs,
  musicShare,
  pieceEditedMs,
  type Rect,
  type Speed,
  sourceToEdited,
  type VideoEdits,
  type Zoom,
  zoomInView
} from './help-video-edits.js'
import { DEFAULT_VIDEO_ARGS, type VideoEncodePlan } from './help-video-encoder.js'

// Builds the single ffmpeg pass that bakes a help video's edits into an MP4.
// Everything is applied in SOURCE time — blur, annotation overlays, crop, zoom
// — and the cut/speed step runs last, so every timed item can use the times
// stored in the edits unchanged. Blurs and annotations are drawn on the whole
// recorded frame (their rects are fractions of it); the crop (#1544) then cuts
// the picture down to what viewers see, and zooms move inside the cropped
// picture. Cards and banners are full frames of the cropped output size. Expressions are single-quoted inside the graph so
// commas and colons stay literal. The graph is written to a file in the
// render's scratch directory and named with -filter_complex_script: as one
// argument it can pass Linux's 128 KiB per-argument limit (fifty moving zooms
// with their stops alone come to about 110 KB) and ffmpeg never starts.

export interface RenderInput {
  edits: VideoEdits
  width: number
  height: number
  hasAudio: boolean
  sourcePath: string
  /** Mime of the uploaded recording; pins the demuxer so the plan fails closed. */
  sourceMime: string
  /** `fade_ms`: the overlay fades in and out over that long (#1553). */
  overlays: Array<{ path: string; start_ms: number; end_ms: number; fade_ms?: number }>
  /** Chapter banners: full-frame transparent overlays laid over the finished
   *  picture (after the cards are joined) in EDITED time, so their motion
   *  plays at its own speed on a sped-up piece. */
  banners?: Array<CardInput & { start_ms: number; end_ms: number }>
  /** Full-frame cards played before / after the kept recording. With
   *  `over_frame` the card sits over the recording's first (intro) or last
   *  (end card) frame, which shows through its transition. */
  intro?: (CardInput & { duration_ms: number; over_frame: boolean }) | null
  outro?: (CardInput & { duration_ms: number; over_frame: boolean }) | null
  /** Background music (#1547): looped under the whole edited timeline. */
  music?: { path: string; mime: string } | null
  /** The recorded cursor and shortcut badges (#1517): an ASS file written by
   *  help-video-cursor.ts, burned in over the finished picture in SOURCE time. */
  cursor?: { assPath: string } | null
  outputPath: string
  threads: number
  /** How the picture is encoded (#1561). Absent = libx264 veryfast / CRF 23. */
  video?: Pick<VideoEncodePlan, 'inputArgs' | 'hwFilter' | 'videoArgs'>
  /** One pass of a two-pass encode: pass 1 writes only the log (no file). */
  pass?: { n: 1 | 2; logfile: string }
  /** Where the caller writes the filter graph (buildRenderPlan hands it
   *  back): the arguments then name it with -filter_complex_script. Without
   *  it the graph is one -filter_complex argument (tests). */
  graphFile?: string
}

/** A filter graph is refused above this: a file has no argument limit, so
 *  this is only a sanity bound (every cap in EDIT_LIMITS together stays well
 *  under 1 MB). */
export const MAX_GRAPH_BYTES = 4 * 1024 * 1024

/** The finished graph and the arguments that hand it to ffmpeg: by file
 *  (`-filter_complex_script`) when the plan names one, else inline. */
export function graphArgs(
  parts: string[],
  graphFile: string | undefined
): { graph: string; args: string[] } {
  const graph = parts.join(';')
  const bytes = Buffer.byteLength(graph)
  if (bytes > MAX_GRAPH_BYTES) {
    throw new Error(
      `The filter graph is too large to render (${Math.round(bytes / 1024)} KB; the limit is ${MAX_GRAPH_BYTES / 1024} KB)`
    )
  }
  return {
    graph,
    args: graphFile ? ['-filter_complex_script', graphFile] : ['-filter_complex', graph]
  }
}

/** The narration cleanup (#1519): spectral noise reduction, then loudness
 *  levelling to about -16 LUFS (single-pass loudnorm), back at 48 kHz
 *  (loudnorm works at 192 kHz). Applied to the whole narration, cards'
 *  silence included, before the music is ducked under it. */
export const IMPROVE_AUDIO_TARGET_LUFS = -16
export const IMPROVE_AUDIO_FILTER = `afftdn=nr=12:nf=-50:tn=1,loudnorm=I=${IMPROVE_AUDIO_TARGET_LUFS}:TP=-1.5:LRA=11,aresample=48000`

/** One card or banner as captured: one PNG (`sequence` false) or an image2
 *  pattern of `frames` numbered PNGs. */
export interface CardInput {
  path: string
  sequence: boolean
  frames: number
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
const sec = (ms: number) => (ms / 1000).toFixed(3)
/** Frame rate of the intro / outro card clips. */
export const CARD_FPS = 30
/** Every piece's sound is brought to this before the cards' silence joins it. */
const AUDIO_FORMAT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'

export function outputSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 1920 / width, 1080 / height)
  return { width: even(width * scale), height: even(height * scale) }
}

/** The frame the edits are drawn on (`work`: blurs, annotations) and the
 *  finished file (`out`: the cropped picture, cards, banners). Without a crop
 *  both are outputSize. With one, the recording is scaled so the cropped part
 *  comes out at most 1920x1080 and never enlarged; `crop` is that part in
 *  `work` pixels and `out` is exactly its size. */
export function renderSizes(
  width: number,
  height: number,
  crop: Rect | null | undefined
): {
  work: { width: number; height: number }
  out: { width: number; height: number }
  crop: { x: number; y: number; w: number; h: number } | null
} {
  if (!crop) {
    const o = outputSize(width, height)
    return { work: o, out: o, crop: null }
  }
  const scale = Math.min(1, 1920 / (crop.w * width), 1080 / (crop.h * height))
  const work = { width: even(width * scale), height: even(height * scale) }
  const px = pixelRect(crop, work)
  return { work, out: { width: px.w, height: px.h }, crop: px }
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
  // atempo keeps the pitch; one stage takes 0.5–2 (slow motion is 0.5 itself).
  if (speed === 4) return 'atempo=2,atempo=2'
  if (speed === 1) return 'anull'
  return `atempo=${speed}`
}

// The soft tick a click ripple makes: the shared player's rippleSound.ts
// (RIPPLE_TICK_TONES / RIPPLE_TICK_SECONDS / RIPPLE_TICK_MERGE_MS) — keep the
// two in step. Each tone is a·e^(−k·t)·sin(2πf·t).
const RIPPLE_TICK_TONES: ReadonlyArray<readonly [number, number, number]> = [
  [1800, 0.12, 140],
  [600, 0.06, 60]
]
const RIPPLE_TICK_SECONDS = 0.06
const RIPPLE_TICK_MERGE_MS = 80
/** More ripples than this still tick, but only the first this many. */
const RIPPLE_TICK_MAX = 200

/** The EDITED moments the finished video ticks at: each ripple's start that
 *  viewers see (cut-out ones dropped), merged when closer than the merge gap. */
export function rippleTickEditedTimes(e: VideoEdits): number[] {
  const at = e.annotations
    .filter((a) => a.type === 'ripple')
    .map((a) => sourceToEdited(e, a.start_ms))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)
  const out: number[] = []
  for (const t of at)
    if (!out.length || t - out[out.length - 1] >= RIPPLE_TICK_MERGE_MS) out.push(t)
  return out.slice(0, RIPPLE_TICK_MAX)
}

function tickExpr(): string {
  const one = RIPPLE_TICK_TONES.map(([f, a, k]) => `${a}*exp(-${k}*t)*sin(2*PI*${f}*t)`).join('+')
  return `'${one}|${one}'`
}

// Background music (#1547). The shared player's musicMix.ts holds the live
// twin of these (MUSIC_FADE_IN_S / MUSIC_FADE_OUT_S) — keep them in step.
export const MUSIC_FADE_IN_S = 1
export const MUSIC_FADE_OUT_S = 1.5
/** Narration louder than this (sidechain level) lowers the music. */
const MUSIC_DUCK_THRESHOLD = 0.03
const MUSIC_DUCK_RATIO = 8
const MUSIC_DUCK_ATTACK_MS = 30
const MUSIC_DUCK_RELEASE_MS = 400

/** Each kept piece's music share in EDITED time: one window per piece whose
 *  share is not 1. Cards always carry the music at its full volume. */
export function musicShareWindows(
  e: VideoEdits
): Array<{ start_ms: number; end_ms: number; share: number }> {
  const out: Array<{ start_ms: number; end_ms: number; share: number }> = []
  let acc = introMs(e)
  for (const s of e.segments) {
    const len = pieceEditedMs(e, s)
    const share = musicShare(s.music)
    if (share !== 1) out.push({ start_ms: acc, end_ms: acc + len, share })
    acc += len
  }
  return out
}

/** What the render concatenates, in order: each kept piece split around its
 *  held frames (#1537) into played stretches and holds. A hold is the source
 *  frame at `at_ms`, held for `hold_ms`; the stretch after it starts at that
 *  same moment, so no frame is skipped or shown twice. */
export type RenderPiece =
  | { kind: 'play'; start_ms: number; end_ms: number; speed: Speed }
  | { kind: 'hold'; at_ms: number; hold_ms: number }
export function renderPieces(e: VideoEdits): RenderPiece[] {
  const out: RenderPiece[] = []
  for (const s of e.segments) {
    let cur = s.start_ms
    for (const h of holdsIn(e, s)) {
      if (h.at_ms > cur) out.push({ kind: 'play', start_ms: cur, end_ms: h.at_ms, speed: s.speed })
      out.push({ kind: 'hold', at_ms: h.at_ms, hold_ms: h.hold_ms })
      cur = h.at_ms
    }
    if (s.end_ms > cur) out.push({ kind: 'play', start_ms: cur, end_ms: s.end_ms, speed: s.speed })
  }
  return out
}
/** A held frame is found this far around its moment (the recording may skip
 *  frames while the screen is still, and its picture may end before its
 *  sound does: the branch is padded with its last frame first). */
const HOLD_REACH_MS = 100

/** The music's volume expression over the edited timeline: its base volume
 *  times each piece's share. */
export function musicVolumeExpr(e: VideoEdits): string {
  const terms = musicShareWindows(e).map(
    (w) =>
      `(${(w.share - 1).toFixed(2)})*between(t,${sec(w.start_ms)},${sec(Math.max(w.start_ms, w.end_ms - 1))})`
  )
  return terms.length ? `1+${terms.join('+')}` : '1'
}

const f4 = (n: number) => n.toFixed(4)

/** A value that changes straight-line between stops, as an expression in t:
 *  `if(lt(t,…))` pieces, the first value before the first stop and the last
 *  after the last; one constant when every stop has the same value. */
export function lerpChain(stops: Array<{ t_ms: number; v: number }>): string {
  if (stops.every((s) => s.v === stops[0].v)) return f4(stops[0].v)
  let expr = f4(stops[stops.length - 1].v)
  for (let i = stops.length - 2; i >= 0; i--) {
    const a = stops[i]
    const b = stops[i + 1]
    expr = `if(lt(t,${sec(b.t_ms)}),${f4(a.v)}+(${f4(b.v - a.v)})*(t-${sec(a.t_ms)})/${sec(b.t_ms - a.t_ms)},${expr})`
  }
  return `if(lt(t,${sec(stops[0].t_ms)}),${f4(stops[0].v)},${expr})`
}

/** A zoom's magnification and centre over its span, as expressions in t
 *  less their resting values (mag − 1, cx − 0.5, cy − 0.5), ready to be
 *  scaled by the ease ramp. A still zoom gives three constants (the graph a
 *  video without moving zooms always had). A moving zoom (#1539) blends its
 *  area straight-line between its stops (zoomRectAt): the centre is then a
 *  chain of straight pieces and the magnification follows the blended side. */
export function zoomMotionExprs(e: VideoEdits, z: Zoom): { mag: string; cx: string; cy: string } {
  const k = z.keyframes
  if (!k || k.length < 2) {
    const v = zoomInView(e, z.rect)
    return { mag: f4(v.mag - 1), cx: f4(v.cx - 0.5), cy: f4(v.cy - 0.5) }
  }
  const views = k.map((s) => ({ t_ms: s.at_ms, v: zoomInView(e, s.rect), side: s.rect.w }))
  const c = cropOf(e)
  const sides = lerpChain(views.map((s) => ({ t_ms: s.t_ms, v: s.side })))
  const mag = views.every((s) => s.side === views[0].side)
    ? f4(views[0].v.mag - 1)
    : `max(1,${f4(Math.min(c.w, c.h))}/(${sides}))-1`
  const centre = (pick: (v: { cx: number; cy: number }) => number) => {
    const chain = lerpChain(views.map((s) => ({ t_ms: s.t_ms, v: pick(s.v) })))
    return chain.startsWith('if(') ? `${chain}-0.5` : f4(Number(chain) - 0.5)
  }
  return { mag, cx: centre((v) => v.cx), cy: centre((v) => v.cy) }
}

/** A file path as a filter option inside the graph: escaped once for the
 *  option parser (`\`, `'` and `:`) and once more for the graph parser
 *  (`\`, `'`, `[`, `]`, `,` and `;`), the way ffmpeg's own docs show. */
export function graphPath(path: string): string {
  return path.replace(/([\\':])/g, '\\$1').replace(/([\\'[\],;])/g, '\\$1')
}

/** Passes beyond which a small blurred field is already uniform. */
const MAX_BLUR_POWER = 50

/** boxblur passes for a radius capped below the one asked for, so the blur is
 *  still at least as strong: a radius-r box blur has variance r(r+1)/3 and
 *  repeated passes add up, so ceil(R(R+1) / r(r+1)) passes of radius r spread
 *  as far as one of radius R. Bounded: the capped field is at most ~4r+4
 *  pixels on its short side, so it is near-uniform long before the bound. */
export function blurPower(requested: number, radius: number): number {
  if (radius >= requested) return 1
  return Math.min(
    MAX_BLUR_POWER,
    Math.ceil((requested * (requested + 1)) / (radius * (radius + 1)))
  )
}

export function buildRenderArgs(input: RenderInput): string[] {
  return buildRenderPlan(input).args
}

/** The arguments and the filter graph of one render pass. With `graphFile`
 *  the caller writes `graph` there before spawning ffmpeg. */
export function buildRenderPlan(input: RenderInput): { args: string[]; graph: string } {
  // An unmapped mime yields no pinned demuxer; refuse rather than let ffmpeg probe.
  const sourceLock = lockedInputArgs(input.sourceMime)
  if (!sourceLock.includes('-f')) {
    throw new Error(`Unsupported recording format: ${input.sourceMime}`)
  }
  const e = input.edits
  const sizes = renderSizes(input.width, input.height, e.crop)
  const work = sizes.work
  const out = sizes.out
  const parts: string[] = []
  let label = 'v0'
  let n = 0
  const next = () => `v${++n}`
  parts.push(`[0:v]scale=${work.width}:${work.height},format=yuv420p,setsar=1[${label}]`)

  for (const b of e.blurs) {
    const pr = pixelRect(b.rect, work)
    // Chroma planes are half size and need room for a radius-1 box blur, so
    // a blur box is never smaller than 4x4 pixels (ffmpeg fails below that).
    const w = Math.min(Math.max(pr.w, 4), work.width)
    const h = Math.min(Math.max(pr.h, 4), work.height)
    const r = { x: Math.min(pr.x, work.width - w), y: Math.min(pr.y, work.height - h), w, h }
    // boxblur's radius applies to the half-size chroma planes too, so it is
    // bounded by a quarter of the smaller side; more passes make up for it.
    const strength = Math.max(1, Math.min(b.strength, Math.floor(Math.min(r.w, r.h) / 4) - 1))
    const power = blurPower(b.strength, strength)
    const a = `${label}a`
    const c = `${label}b`
    const blurred = `bl${n}`
    const to = next()
    parts.push(`[${label}]split[${a}][${c}]`)
    parts.push(`[${c}]crop=${r.w}:${r.h}:${r.x}:${r.y},boxblur=${strength}:${power}[${blurred}]`)
    parts.push(
      `[${a}][${blurred}]overlay=${r.x}:${r.y}:enable='between(t,${sec(b.start_ms)},${sec(b.end_ms)})'[${to}]`
    )
    label = to
  }

  input.overlays.forEach((o, i) => {
    const to = next()
    const fade = Math.max(0, Math.min(o.fade_ms ?? 0, (o.end_ms - o.start_ms) / 2))
    if (fade >= 20) {
      // One image held over its span (timestamps in source time), its alpha
      // ramped in and out, so the callout fades instead of popping.
      const frames = Math.max(1, Math.ceil(((o.end_ms - o.start_ms) / 1000) * CARD_FPS) + 1)
      const ov = `ov${i}`
      parts.push(
        `[${i + 1}:v]format=rgba,loop=loop=${frames - 1}:size=1:start=0,setpts=N/(${CARD_FPS}*TB)+${sec(o.start_ms)}/TB,` +
          `fade=t=in:st=${sec(o.start_ms)}:d=${sec(fade)}:alpha=1,fade=t=out:st=${sec(o.end_ms - fade)}:d=${sec(fade)}:alpha=1[${ov}]`
      )
      parts.push(
        `[${label}][${ov}]overlay=0:0:eof_action=pass:enable='between(t,${sec(o.start_ms)},${sec(o.end_ms)})'[${to}]`
      )
    } else {
      parts.push(
        `[${label}][${i + 1}:v]overlay=0:0:enable='between(t,${sec(o.start_ms)},${sec(o.end_ms)})'[${to}]`
      )
    }
    label = to
  })

  // The crop: what viewers see of the recording, already in `out` pixels.
  if (sizes.crop) {
    const c = sizes.crop
    const to = next()
    parts.push(`[${label}]crop=${c.w}:${c.h}:${c.x}:${c.y},setsar=1[${to}]`)
    label = to
  }

  if (e.zooms.length) {
    const p = (a: number, b: number, ease: number) =>
      ease > 0
        ? `clip(min((t-${sec(a)})/${sec(ease)},(${sec(b)}-t)/${sec(ease)}),0,1)`
        : `between(t,${sec(a)},${sec(b)})`
    // Zoom rects are fractions of the whole recorded frame; inside a crop
    // they are re-expressed in the cropped picture (zoomInView). A moving
    // zoom's magnification and centre follow its stops (zoomMotionExprs).
    const views = e.zooms.map((z) => ({ z, m: zoomMotionExprs(e, z) }))
    const zTerms = views.map(({ z, m }) => `(${m.mag})*${p(z.start_ms, z.end_ms, z.ease_ms)}`)
    const cxTerms = views.map(({ z, m }) => `(${m.cx})*${p(z.start_ms, z.end_ms, z.ease_ms)}`)
    const cyTerms = views.map(({ z, m }) => `(${m.cy})*${p(z.start_ms, z.end_ms, z.ease_ms)}`)
    const Z = `(1+${zTerms.join('+')})`
    const CX = `(0.5+${cxTerms.join('+')})`
    const CY = `(0.5+${cyTerms.join('+')})`
    // A moving zoom's Z is a chain of pieces: the crop offsets store it once
    // (st/ld; `;` sequences the two, and the quotes keep it one option).
    const moving = e.zooms.some((z) => z.keyframes)
    const Zx = moving ? 'ld(0)' : Z
    const pre = moving ? `st(0,${Z});` : ''
    const to = next()
    parts.push(
      `[${label}]scale=w='trunc(${out.width}*${Z}/2)*2':h='trunc(${out.height}*${Z}/2)*2':eval=frame,` +
        // crop's iw/ih are the size the graph was configured with (the unzoomed
        // frame), not the per-frame scaled size, so use the zoomed size explicitly.
        `crop=${out.width}:${out.height}:` +
        `x='${pre}max(0,min(${CX}*(${out.width}*${Zx})-${out.width}/2,${out.width}*${Zx}-${out.width}))':` +
        `y='${pre}max(0,min(${CY}*(${out.height}*${Zx})-${out.height}/2,${out.height}*${Zx}-${out.height}))'[${to}]`
    )
    label = to
  }

  // The recorded cursor and shortcut badges (#1517), burned in from an ASS
  // file in SOURCE time over the finished picture (crop and zoom applied), so
  // cuts and speed changes carry the cursor with the frames it was on.
  if (input.cursor) {
    const to = next()
    parts.push(`[${label}]ass=filename=${graphPath(input.cursor.assPath)}[${to}]`)
    label = to
  }

  const banners = input.banners ?? []
  const bannerBase = input.overlays.length + 1
  // Banners go on after the cards are joined (in edited time); until then the
  // picture lands on finalV.
  const finalV = banners.length ? 'vcards' : 'vout'

  const segs = e.segments
  const pieces = renderPieces(e)
  const holds = pieces.some((p) => p.kind === 'hold')
  const untouched = segs.length === 1 && segs[0].start_ms === 0 && segs[0].speed === 1 && !holds
  const maps: string[] = ['-map', '[vout]']
  // The finished sound is built in steps: the edits' narration lands on
  // [anar], ripple ticks are mixed over it, then background music (lowered
  // under the narration) is mixed over that, giving [aout]. With nothing to
  // mix, the narration IS [aout]. A silent recording gets a silent track to
  // carry ticks or music.
  const ticks = rippleTickEditedTimes(e)
  const music = e.music && input.music ? { ...e.music, ...input.music } : null
  if (music && !lockedInputArgs(music.mime).includes('-f')) {
    throw new Error(`Unsupported music format: ${music.mime}`)
  }
  const needsMix = ticks.length > 0 || !!music
  const narOut = needsMix ? 'anar' : 'aout'
  // With the narration cleanup on, the edited narration lands on [araw] and
  // is cleaned onto narOut before anything is mixed over it.
  const improve = !!e.audio?.improve && input.hasAudio
  const nar = improve ? 'araw' : narOut
  const withAudio = input.hasAudio || needsMix
  // With a card the kept recording is one piece of a final concat.
  const cards = [input.intro, input.outro].filter(Boolean).length > 0
  const vb = cards ? 'vbody' : finalV
  const ab = cards ? 'abody' : nar
  if (untouched) {
    // A single full piece still bounds the end, so a recording whose header
    // claims a little more time than the edits keep never runs past them.
    parts.push(`[${label}]trim=end=${sec(segs[0].end_ms)},setpts=PTS-STARTPTS[${vb}]`)
    if (input.hasAudio) {
      parts.push(`[0:a]atrim=end=${sec(segs[0].end_ms)},asetpts=PTS-STARTPTS[${ab}]`)
    }
  } else {
    const k = pieces.length
    const played = pieces.map((p, i) => (p.kind === 'play' ? i : -1)).filter((i) => i >= 0)
    parts.push(`[${label}]split=${k}${pieces.map((_, i) => `[s${i}]`).join('')}`)
    if (input.hasAudio && played.length)
      parts.push(`[0:a]asplit=${played.length}${played.map((i) => `[as${i}]`).join('')}`)
    pieces.forEach((p, i) => {
      if (p.kind === 'play') {
        parts.push(
          `[s${i}]trim=start=${sec(p.start_ms)}:end=${sec(p.end_ms)},setpts=(PTS-STARTPTS)/${p.speed}[c${i}]`
        )
        if (input.hasAudio) {
          // Next to a hold's silence the pieces' sound has to match it exactly.
          parts.push(
            `[as${i}]atrim=start=${sec(p.start_ms)}:end=${sec(p.end_ms)},asetpts=PTS-STARTPTS,${atempo(p.speed)}${holds ? `,${AUDIO_FORMAT}` : ''}[ca${i}]`
          )
        }
        return
      }
      // The held frame (#1537): the picture is made steady (fps) and padded
      // with its last frame, so a frame exists at the moment even when the
      // recording skipped frames there or its picture ended early; that one
      // frame is picked and looped for the hold's length, over silence.
      const frames = Math.max(1, Math.round((p.hold_ms / 1000) * CARD_FPS))
      parts.push(
        `[s${i}]fps=${CARD_FPS},tpad=stop_mode=clone:stop_duration=${sec(p.at_ms + HOLD_REACH_MS)},` +
          `trim=start=${sec(p.at_ms)}:end=${sec(p.at_ms + HOLD_REACH_MS)},setpts=PTS-STARTPTS,trim=end_frame=1,` +
          `loop=loop=${frames - 1}:size=1:start=0,setpts=N/(${CARD_FPS}*TB)[c${i}]`
      )
      if (input.hasAudio) {
        parts.push(
          `anullsrc=r=48000:cl=stereo,atrim=duration=${sec((frames / CARD_FPS) * 1000)},${AUDIO_FORMAT}[ca${i}]`
        )
      }
    })
    const ins = pieces.map((_, i) => (input.hasAudio ? `[c${i}][ca${i}]` : `[c${i}]`)).join('')
    parts.push(
      `${ins}concat=n=${k}:v=1:a=${input.hasAudio ? 1 : 0}[${vb}]${input.hasAudio ? `[${ab}]` : ''}`
    )
  }
  if (withAudio) maps.push('-map', '[aout]')

  if (cards) {
    // Each card is held (one PNG) or played (a frame sequence) for its length
    // at CARD_FPS, with silence when the recording has sound; then card +
    // recording + card play in order. A card with a transition sits over the
    // recording's first (intro) or last (end card) frame, held for its length:
    // the body is split, one frame picked off it and looped.
    const needIntroBg = !!input.intro?.over_frame
    const needOutroBg = !!input.outro?.over_frame
    const extra = (needIntroBg ? 1 : 0) + (needOutroBg ? 1 : 0)
    let bodyLabel = 'vbody'
    if (extra) {
      parts.push(
        `[vbody]split=${extra + 1}[vbodym]${needIntroBg ? '[cisrc]' : ''}${needOutroBg ? '[cosrc]' : ''}`
      )
      bodyLabel = 'vbodym'
    }
    let idx = bannerBase + banners.length
    const pieces: string[] = []
    const card = (
      c: NonNullable<RenderInput['intro']>,
      name: 'ci' | 'co',
      edge: 'first' | 'last'
    ) => {
      const frames = Math.max(1, Math.round((c.duration_ms / 1000) * CARD_FPS))
      const k = idx++
      const held = c.sequence ? '' : `loop=loop=${frames - 1}:size=1:start=0,`
      if (!c.over_frame) {
        parts.push(
          `[${k}:v]scale=${out.width}:${out.height},format=yuv420p,setsar=1,${held}setpts=N/(${CARD_FPS}*TB)[${name}v]`
        )
      } else {
        // The picture can end before the edit does (a narrated recording's
        // sound runs on past its last frame), so the last frame is cloned on
        // before it is picked; otherwise the pick finds nothing and the end
        // card vanishes.
        const pick =
          edge === 'first'
            ? 'trim=end_frame=1'
            : `fps=${CARD_FPS},tpad=stop_mode=clone:stop_duration=${sec(bodyDuration(e))},` +
              `trim=start=${sec(Math.max(0, bodyDuration(e) - 50))},trim=end_frame=1`
        parts.push(
          `[${name}src]${pick},setpts=PTS-STARTPTS,loop=loop=${frames - 1}:size=1:start=0,setpts=N/(${CARD_FPS}*TB)[${name}bg]`
        )
        parts.push(
          `[${k}:v]scale=${out.width}:${out.height},format=rgba,${held}setpts=N/(${CARD_FPS}*TB)[${name}fr]`
        )
        parts.push(`[${name}bg][${name}fr]overlay=0:0:shortest=1,format=yuv420p,setsar=1[${name}v]`)
      }
      if (input.hasAudio) {
        parts.push(
          `anullsrc=r=48000:cl=stereo,atrim=duration=${sec((frames / CARD_FPS) * 1000)},${AUDIO_FORMAT}[${name}a]`
        )
        pieces.push(`[${name}v][${name}a]`)
      } else pieces.push(`[${name}v]`)
    }
    if (input.intro) card(input.intro, 'ci', 'first')
    if (input.hasAudio) {
      parts.push(`[abody]${AUDIO_FORMAT}[abodyf]`)
      pieces.push(`[${bodyLabel}][abodyf]`)
    } else pieces.push(`[${bodyLabel}]`)
    if (input.outro) card(input.outro, 'co', 'last')
    parts.push(
      `${pieces.join('')}concat=n=${pieces.length}:v=1:a=${input.hasAudio ? 1 : 0}[${finalV}]${input.hasAudio ? `[${nar}]` : ''}`
    )
  }

  if (improve) parts.push(`[araw]${IMPROVE_AUDIO_FILTER},${AUDIO_FORMAT}[${narOut}]`)

  // Chapter banners over the finished picture, each from its edited start: a
  // held PNG or a frame sequence, offset so its first frame lands there.
  if (banners.length) {
    let cur = finalV
    // Overlay only draws when the picture has a frame, and a recording has
    // gaps (and 4x pieces run faster): a moving banner gets a steady 30 fps
    // to play on, so its entrance plays as smoothly as in the live player.
    if (banners.some((b) => b.sequence)) {
      parts.push(`[${finalV}]fps=${CARD_FPS}[${finalV}r]`)
      cur = `${finalV}r`
    }
    banners.forEach((b, i) => {
      const k = bannerBase + i
      const to = i === banners.length - 1 ? 'vout' : `vbn${i}`
      const frames = Math.max(1, Math.round(((b.end_ms - b.start_ms) / 1000) * CARD_FPS))
      parts.push(
        b.sequence
          ? `[${k}:v]format=rgba,setpts=PTS-STARTPTS+${sec(b.start_ms)}/TB[bn${i}]`
          : `[${k}:v]format=rgba,loop=loop=${frames - 1}:size=1:start=0,setpts=N/(${CARD_FPS}*TB)+${sec(b.start_ms)}/TB[bn${i}]`
      )
      parts.push(
        `[${cur}][bn${i}]overlay=0:0:eof_action=pass:enable='between(t,${sec(b.start_ms)},${sec(b.end_ms)})'[${to}]`
      )
      cur = to
    })
  }

  if (needsMix) {
    if (!input.hasAudio) {
      parts.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${sec(editedDuration(e))},${AUDIO_FORMAT}[anar]`
      )
    }
    // The music is lowered by the narration alone (never by the ticks).
    const duck = !!music && music.duck && input.hasAudio
    let cur = 'anar'
    if (duck) {
      parts.push(`[anar]${AUDIO_FORMAT},asplit=2[anarm][asc]`)
      cur = 'anarm'
    }
    if (ticks.length) {
      const n = ticks.length
      const to = music ? 'atk' : 'aout'
      parts.push(
        `aevalsrc=exprs=${tickExpr()}:s=48000:d=${RIPPLE_TICK_SECONDS},${AUDIO_FORMAT}${n > 1 ? `,asplit=${n}` : ''}${ticks.map((_, i) => `[tk${i}]`).join('')}`
      )
      ticks.forEach((t, i) => {
        parts.push(`[tk${i}]adelay=delays=${Math.round(t)}:all=1[td${i}]`)
      })
      parts.push(
        `[${cur}]${AUDIO_FORMAT}[amainf];[amainf]${ticks.map((_, i) => `[td${i}]`).join('')}amix=inputs=${n + 1}:duration=first:dropout_transition=0:normalize=0[${to}]`
      )
      cur = to
    }
    if (music) {
      const total = editedDuration(e)
      const outAt = Math.max(0, total / 1000 - MUSIC_FADE_OUT_S)
      const mi = bannerBase + banners.length + (input.intro ? 1 : 0) + (input.outro ? 1 : 0)
      parts.push(
        `[${mi}:a]${AUDIO_FORMAT},atrim=duration=${sec(total)},asetpts=PTS-STARTPTS,` +
          `volume=${music.volume.toFixed(2)},volume='${musicVolumeExpr(e)}':eval=frame,` +
          `afade=t=in:d=${MUSIC_FADE_IN_S},afade=t=out:st=${outAt.toFixed(3)}:d=${MUSIC_FADE_OUT_S}[mus]`
      )
      let bed = 'mus'
      if (duck) {
        parts.push(
          `[asc]${AUDIO_FORMAT}[ascf];[mus][ascf]sidechaincompress=threshold=${MUSIC_DUCK_THRESHOLD}:ratio=${MUSIC_DUCK_RATIO}:attack=${MUSIC_DUCK_ATTACK_MS}:release=${MUSIC_DUCK_RELEASE_MS}[mduck]`
        )
        bed = 'mduck'
      }
      parts.push(
        `[${cur}]${AUDIO_FORMAT}[amixin];[amixin][${bed}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
      )
    }
  }

  // A hardware encoder takes the finished picture on its device.
  const hwFilter = input.video?.hwFilter
  if (hwFilter) {
    parts.push(`[vout]${hwFilter}[vhw]`)
    maps[1] = '[vhw]'
  }
  const pass = input.pass
  const passArgs = pass ? ['-pass', String(pass.n), '-passlogfile', pass.logfile] : []
  const output =
    pass?.n === 1 ? ['-f', 'null', devNull] : ['-movflags', '+faststart', input.outputPath]
  const graph = graphArgs(parts, input.graphFile)

  const args = [
    '-y',
    '-v',
    'error',
    '-threads',
    String(input.threads),
    '-filter_complex_threads',
    '1',
    ...(input.video?.inputArgs ?? []),
    ...sourceLock,
    '-i',
    input.sourcePath,
    // Annotation and card images are our own PNGs; pin them so nothing else is
    // probed. Order: annotations, banners, intro card, outro card (the graph's
    // indexes). A moving card or banner is a numbered sequence (image2).
    // Chromium writes opaque frames as rgb24 and see-through ones as rgba, so
    // a sequence switches format mid-stream; -reinit_filter 0 keeps the graph
    // (a rebuild restarts every frame counter and the timeline jumps back).
    ...input.overlays.flatMap((o) => [
      '-protocol_whitelist',
      'file',
      '-f',
      'png_pipe',
      '-i',
      o.path
    ]),
    ...[
      ...banners,
      ...(input.intro ? [input.intro] : []),
      ...(input.outro ? [input.outro] : [])
    ].flatMap((c) =>
      c.sequence
        ? [
            '-reinit_filter',
            '0',
            '-protocol_whitelist',
            'file',
            '-f',
            'image2',
            '-framerate',
            String(CARD_FPS),
            '-start_number',
            '1',
            '-i',
            c.path
          ]
        : ['-protocol_whitelist', 'file', '-f', 'png_pipe', '-i', c.path]
    ),
    // Music last, looped for as long as the graph reads it (atrim bounds it).
    ...(music ? ['-stream_loop', '-1', ...lockedInputArgs(music.mime), '-i', music.path] : []),
    ...graph.args,
    ...maps,
    ...(input.video?.videoArgs ?? DEFAULT_VIDEO_ARGS),
    ...passArgs,
    '-threads',
    String(input.threads),
    ...(withAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
    ...output
  ]
  return { args, graph: graph.graph }
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
