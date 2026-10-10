// The pure half of the thumbnails and waveform (#1560): sheet geometry,
// ffmpeg arguments and the peaks maths. Kept free of database and storage
// imports so it can be unit-tested and run against ffmpeg alone; the job
// that uses it lives in help-video-extras.ts.
import { lockedInputArgs } from './ffmpeg.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const SPRITE_TILE_W = 160
export const SPRITE_MAX_TILES = 200
export const SPRITE_COLS = 10
/** No sprite above this frame size (a 4K recording decodes too slowly to be
 *  worth a thumbnail strip): the timeline simply shows no frames. */
export const SPRITE_MAX_PIXELS = 4096 * 2304
export const PEAK_WINDOW_MS = 100
/** The sample rate the sound is read at for peaks (mono 16-bit). */
export const PEAK_PCM_RATE = 4000
/** The longest input read (matches the upload length cap plus slack). */
const MAX_INPUT_SECONDS = 31 * 60 + 1
const MAX_PEAKS = Math.ceil((MAX_INPUT_SECONDS * 1000) / PEAK_WINDOW_MS)

/** The stored sprite descriptor (the `sprite` column). */
export interface SpriteSheet {
  file_id: string
  tile_w: number
  tile_h: number
  cols: number
  count: number
  interval_ms: number
}

export interface SpriteGeometry {
  tile_w: number
  tile_h: number
  cols: number
  rows: number
  count: number
  interval_ms: number
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** How a sprite sheet is laid out for a recording of this length and size, or
 *  null when none should be built (no length, unknown size, too large). */
export function spriteGeometry(
  durationMs: number | null | undefined,
  width: number | null | undefined,
  height: number | null | undefined
): SpriteGeometry | null {
  const dur = Number(durationMs)
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(dur) || dur <= 0) return null
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16) return null
  if (w * h > SPRITE_MAX_PIXELS) return null
  const seconds = dur / 1000
  // One frame every N whole seconds, N the smallest that keeps the sheet
  // within SPRITE_MAX_TILES (a 30-minute recording: every 9 s).
  const interval = Math.max(1, Math.ceil(seconds / SPRITE_MAX_TILES))
  // ffmpeg's fps=1/N emits frames at 0, N, 2N… inside the recording.
  const count = Math.max(
    1,
    Math.min(SPRITE_MAX_TILES, Math.floor((dur - 1) / (interval * 1000)) + 1)
  )
  const cols = Math.min(SPRITE_COLS, count)
  return {
    tile_w: SPRITE_TILE_W,
    tile_h: even((SPRITE_TILE_W * h) / w),
    cols,
    rows: Math.ceil(count / cols),
    count,
    interval_ms: interval * 1000
  }
}

function threads(): number {
  const n = Number(process.env.VIDEO_RENDER_THREADS)
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 2
}

/** ffmpeg arguments for the sprite sheet: one JPEG, one frame per interval,
 *  scaled to the tile size and tiled `cols` to a row. */
export function buildSpriteArgs(
  input: { path: string; mime: string; threads?: number },
  g: SpriteGeometry,
  outPath: string
): string[] {
  const lock = lockedInputArgs(input.mime)
  if (!lock.includes('-f')) throw new Error(`Unsupported recording format: ${input.mime}`)
  return [
    '-y',
    '-v',
    'error',
    '-threads',
    String(input.threads ?? threads()),
    '-t',
    String(MAX_INPUT_SECONDS),
    ...lock,
    '-i',
    input.path,
    '-an',
    '-sn',
    '-vf',
    `fps=1/${g.interval_ms / 1000},scale=${g.tile_w}:${g.tile_h}:flags=area,tile=${g.cols}x${g.rows}`,
    '-frames:v',
    '1',
    '-q:v',
    '4',
    outPath
  ]
}

/** ffmpeg arguments that write the sound as mono 16-bit PCM at PEAK_PCM_RATE
 *  (a 30-minute recording is about 14 MB), read back by peaksFromPcm. */
export function buildPeaksArgs(input: { path: string; mime: string }, outPath: string): string[] {
  const lock = lockedInputArgs(input.mime)
  if (!lock.includes('-f')) throw new Error(`Unsupported recording format: ${input.mime}`)
  return [
    '-y',
    '-v',
    'error',
    '-threads',
    '1',
    '-t',
    String(MAX_INPUT_SECONDS),
    ...lock,
    '-i',
    input.path,
    '-vn',
    '-sn',
    '-ac',
    '1',
    '-ar',
    String(PEAK_PCM_RATE),
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    outPath
  ]
}

/** The loudest sample (0–1, two decimals) in every window of raw signed
 *  16-bit little-endian mono PCM; a last partial window counts. */
export function peaksFromPcm(
  pcm: Buffer,
  rate = PEAK_PCM_RATE,
  windowMs = PEAK_WINDOW_MS
): number[] {
  const perWindow = Math.max(1, Math.round((rate * windowMs) / 1000))
  const samples = Math.floor(pcm.length / 2)
  const out: number[] = []
  for (let i = 0; i < samples && out.length < MAX_PEAKS; i += perWindow) {
    let peak = 0
    const end = Math.min(samples, i + perWindow)
    for (let j = i; j < end; j++) {
      const v = Math.abs(pcm.readInt16LE(j * 2))
      if (v > peak) peak = v
    }
    out.push(Math.round((peak / 32768) * 100) / 100)
  }
  return out
}

/** The stored descriptor, checked: null for anything that is not one. */
export function parseSprite(raw: unknown): SpriteSheet | null {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  const int = (x: unknown) => (Number.isInteger(x) && (x as number) > 0 ? (x as number) : null)
  const tile_w = int(s.tile_w)
  const tile_h = int(s.tile_h)
  const cols = int(s.cols)
  const count = int(s.count)
  const interval_ms = int(s.interval_ms)
  if (
    typeof s.file_id !== 'string' ||
    !UUID_RE.test(s.file_id) ||
    !tile_w ||
    !tile_h ||
    !cols ||
    !count ||
    !interval_ms
  )
    return null
  return { file_id: String(s.file_id).toLowerCase(), tile_w, tile_h, cols, count, interval_ms }
}

/** Peaks as stored (JSON text) or given, bounded and clamped; null when there are none. */
export function parsePeaks(raw: unknown): number[] | null {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!Array.isArray(v) || !v.length) return null
  return v.slice(0, MAX_PEAKS).map((x) => {
    const n = Number(x)
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
  })
}
