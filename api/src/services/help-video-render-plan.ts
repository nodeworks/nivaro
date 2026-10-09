import { lockedInputArgs } from './ffmpeg.js'
import {
  bodyDuration,
  editedDuration,
  introMs,
  musicShare,
  type Rect,
  sourceToEdited,
  type VideoEdits
} from './help-video-edits.js'

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
  outputPath: string
  threads: number
}

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
    const len = (s.end_ms - s.start_ms) / s.speed
    const share = musicShare(s.music)
    if (share !== 1) out.push({ start_ms: acc, end_ms: acc + len, share })
    acc += len
  }
  return out
}

/** The music's volume expression over the edited timeline: its base volume
 *  times each piece's share. */
export function musicVolumeExpr(e: VideoEdits): string {
  const terms = musicShareWindows(e).map(
    (w) =>
      `(${(w.share - 1).toFixed(2)})*between(t,${sec(w.start_ms)},${sec(Math.max(w.start_ms, w.end_ms - 1))})`
  )
  return terms.length ? `1+${terms.join('+')}` : '1'
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

  const banners = input.banners ?? []
  const bannerBase = input.overlays.length + 1
  // Banners go on after the cards are joined (in edited time); until then the
  // picture lands on finalV.
  const finalV = banners.length ? 'vcards' : 'vout'

  const segs = e.segments
  const untouched = segs.length === 1 && segs[0].start_ms === 0 && segs[0].speed === 1
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
  const nar = needsMix ? 'anar' : 'aout'
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
        const pick =
          edge === 'first'
            ? 'trim=end_frame=1'
            : `trim=start=${sec(Math.max(0, bodyDuration(e) - 50))},trim=end_frame=1`
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

  // Chapter banners over the finished picture, each from its edited start: a
  // held PNG or a frame sequence, offset so its first frame lands there.
  if (banners.length) {
    let cur = finalV
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
    // Annotation and card images are our own PNGs; pin them so nothing else is
    // probed. Order: annotations, banners, intro card, outro card (the graph's
    // indexes). A moving card or banner is a numbered sequence (image2).
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
    ...(withAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
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
