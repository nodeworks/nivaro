import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { hasFfmpeg, lockedInputArgs, probeVideo, runFfmpeg } from './ffmpeg.js'
import { getFile, uploadFileFromPath } from './files.js'
import { type MusicBed, normalizeMusic } from './help-video-edits.js'
import { isUuid } from './help-video-files.js'
import { discardFile, videoWorkDir } from './help-video-uploads.js'
import { openStoredObject } from './stored-object-stream.js'

// Background music for help videos (#1547). Three tracks are generated here as
// seamless 32-second loops (plain synthesizer chords: nothing to license). An
// administrator can add real tracks by placing audio files and a music.json in
// HELP_VIDEO_MUSIC_DIR. An author's own file is converted to AAC and kept as a
// nivaro_help_video_uploads row with status 'music' (its file id is therefore
// hidden from /api/files like every help-video file); the row's meta names
// the video it belongs to, so a draft can only use music uploaded to it.

export interface MusicTrack {
  key: string
  title: string
  description: string
  duration_ms: number
  kind: 'generated' | 'file'
}
export interface UploadedMusic {
  id: string
  name: string
  duration_ms: number
}

const RATE = 32_000
const LOOP_S = 32
/** Bumped whenever the synth changes, so a cached WAV is never stale. */
const SYNTH_VERSION = 1
export const MUSIC_MAX_BYTES = 40 * 1024 * 1024
const UPLOAD_MAX_BYTES = MUSIC_MAX_BYTES
const UPLOAD_MAX_MS = 20 * 60_000
const MANIFEST_TTL_MS = 60_000

type Generated = { key: string; title: string; description: string; synth: (t: number) => number }

// ── The generated set ────────────────────────────────────────────────────────

const chordsCalm = [
  [130.81, 164.81, 196.0, 246.94], // Cmaj7
  [110.0, 130.81, 164.81, 196.0], // Am7
  [87.31, 110.0, 130.81, 164.81], // Fmaj7
  [98.0, 123.47, 146.83, 196.0] // G
]
const CHORD_S = 8
const XFADE_S = 2

/** Raised-cosine window: 0 → 1 over `fade`, flat, 1 → 0 over the last `fade`. */
function windowAt(u: number, len: number, fade: number): number {
  if (u < 0 || u > len) return 0
  if (u < fade) return 0.5 - 0.5 * Math.cos((Math.PI * u) / fade)
  if (u > len - fade) return 0.5 - 0.5 * Math.cos((Math.PI * (len - u)) / fade)
  return 1
}

/** The chord pad at loop time t: each chord sounds for CHORD_S plus a
 *  crossfade either side; phases run on the chord's own clock, so the loop
 *  joins without a click. */
function pad(t: number, chords: number[][], octave: number, detune: number): number {
  let v = 0
  const n = chords.length
  const loop = n * CHORD_S
  for (let k = 0; k < n; k++) {
    const u = (((t - k * CHORD_S + XFADE_S) % loop) + loop) % loop
    const w = windowAt(u, CHORD_S + 2 * XFADE_S, XFADE_S)
    if (w === 0) continue
    let c = 0
    for (const f0 of chords[k]) {
      const f = f0 * octave
      c +=
        Math.sin(2 * Math.PI * f * u) +
        0.6 * Math.sin(2 * Math.PI * f * (1 + detune) * u) +
        0.18 * Math.sin(4 * Math.PI * f * u)
    }
    v += (w * c) / chords[k].length
  }
  return v
}

/** Plucked notes on a fixed grid: note-local time keeps the loop seamless. */
function plucks(t: number, chords: number[][], step: number): number {
  const loop = chords.length * CHORD_S
  const tt = ((t % loop) + loop) % loop
  const idx = Math.floor(tt / step)
  const u = tt - idx * step
  const chord = chords[Math.floor((idx * step) / CHORD_S) % chords.length]
  const pattern = [0, 2, 1, 3, 2, 1]
  const f = chord[pattern[idx % pattern.length] % chord.length] * 4
  const env = Math.exp(-5 * u) * (1 - Math.exp(-300 * u))
  return env * (Math.sin(2 * Math.PI * f * u) + 0.25 * Math.sin(4 * Math.PI * f * u))
}

const GENERATED: Generated[] = [
  {
    key: 'calm',
    title: 'Calm',
    description: 'Slow, soft chords.',
    synth: (t) => pad(t, chordsCalm, 1, 0.003) * (0.85 + 0.15 * Math.sin((2 * Math.PI * t) / 8))
  },
  {
    key: 'bright',
    title: 'Bright',
    description: 'Light plucks over soft chords.',
    synth: (t) => 0.55 * pad(t, chordsCalm, 2, 0.004) + 0.5 * plucks(t, chordsCalm, 0.5)
  },
  {
    key: 'focus',
    title: 'Focus',
    description: 'A low, steady pulse.',
    synth: (t) => {
      // Root changes every 16 s (A, then F); the pulse repeats every 2 s.
      const roots = [55, 43.65]
      let v = 0
      for (let k = 0; k < 2; k++) {
        const u = (((t - k * 16 + XFADE_S) % LOOP_S) + LOOP_S) % LOOP_S
        const w = windowAt(u, 16 + 2 * XFADE_S, XFADE_S)
        if (!w) continue
        const f = roots[k]
        v +=
          w *
          (Math.sin(2 * Math.PI * f * u) +
            0.5 * Math.sin(2 * Math.PI * f * 2 * u) +
            0.35 * Math.sin(2 * Math.PI * f * 3 * u) +
            0.25 * Math.sin(2 * Math.PI * f * 1.5 * 2 * u))
      }
      const pulse = 0.55 + 0.45 * Math.sin((Math.PI * t) / 2) ** 2
      return v * pulse
    }
  }
]

/** 16-bit mono PCM WAV of one generated track, peak-normalised to 0.7. */
export function synthesizeTrack(key: string): Buffer | null {
  const g = GENERATED.find((x) => x.key === key)
  if (!g) return null
  const n = RATE * LOOP_S
  const samples = new Float32Array(n)
  let peak = 0
  for (let i = 0; i < n; i++) {
    const v = g.synth(i / RATE)
    samples[i] = v
    const a = Math.abs(v)
    if (a > peak) peak = a
  }
  const k = peak > 0 ? 0.7 / peak : 0
  const out = Buffer.alloc(44 + n * 2)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + n * 2, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(1, 22) // mono
  out.writeUInt32LE(RATE, 24)
  out.writeUInt32LE(RATE * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * k)) * 32767), 44 + i * 2)
  }
  return out
}

const generatedCache = new Map<string, Promise<string>>()

/** A generated track's WAV on local disk (built once per process version). */
function generatedPath(key: string): Promise<string> {
  let p = generatedCache.get(key)
  if (!p) {
    p = (async () => {
      const dir = join(videoWorkDir(), 'music')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${key}-v${SYNTH_VERSION}.wav`)
      const have = await stat(path).catch(() => null)
      if (!have?.size) {
        const buf = synthesizeTrack(key)
        if (!buf) throw new Error(`Unknown music track ${key}`)
        const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
        await writeFile(tmp, buf)
        await rename(tmp, path)
      }
      return path
    })()
    p.catch(() => generatedCache.delete(key))
    generatedCache.set(key, p)
  }
  return p
}

// ── Tracks an administrator adds (HELP_VIDEO_MUSIC_DIR) ─────────────────────

const AUDIO_MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac'
}
type FolderTrack = MusicTrack & { path: string; mime: string }
let manifest: { at: number; tracks: Promise<FolderTrack[]> } | null = null

function musicDir(): string | null {
  const d = process.env.HELP_VIDEO_MUSIC_DIR?.trim()
  return d ? d : null
}

async function readFolder(dir: string): Promise<FolderTrack[]> {
  const raw = await readFile(join(dir, 'music.json'), 'utf8').catch(() => null)
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn('[help-videos] HELP_VIDEO_MUSIC_DIR/music.json is not valid JSON')
    return []
  }
  const list = Array.isArray((parsed as { tracks?: unknown })?.tracks)
    ? ((parsed as { tracks: unknown[] }).tracks as Array<Record<string, unknown>>)
    : []
  const out: FolderTrack[] = []
  const taken = new Set(GENERATED.map((g) => g.key))
  for (const t of list.slice(0, 50)) {
    const key = String(t.key ?? '')
      .trim()
      .toLowerCase()
    const file = String(t.file ?? '')
    // A plain file name inside the folder: never a path out of it.
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(key) || taken.has(key)) continue
    if (!file || basename(file) !== file || file.startsWith('.')) continue
    const mime = AUDIO_MIME[extname(file).toLowerCase()]
    if (!mime) continue
    const path = join(dir, file)
    const s = await stat(path).catch(() => null)
    if (!s?.isFile()) continue
    const probe = await probeVideo(path, mime).catch(() => null)
    if (!probe?.has_audio || !probe.duration_ms) continue
    taken.add(key)
    out.push({
      key,
      title: String(t.title ?? key).slice(0, 80),
      description: String(t.description ?? '').slice(0, 200),
      duration_ms: probe.duration_ms,
      kind: 'file',
      path,
      mime
    })
  }
  return out
}

function folderTracks(): Promise<FolderTrack[]> {
  const dir = musicDir()
  if (!dir) return Promise.resolve([])
  if (!manifest || Date.now() - manifest.at > MANIFEST_TTL_MS) {
    manifest = { at: Date.now(), tracks: readFolder(dir).catch(() => []) }
  }
  return manifest.tracks
}

/** Every library track: the generated ones, then an administrator's. */
export async function musicLibrary(): Promise<MusicTrack[]> {
  const files = await folderTracks()
  return [
    ...GENERATED.map((g) => ({
      key: g.key,
      title: g.title,
      description: g.description,
      duration_ms: LOOP_S * 1000,
      kind: 'generated' as const
    })),
    ...files.map(({ path: _p, mime: _m, ...t }) => t)
  ]
}

/** A library track on local disk, with the mime that pins its demuxer. */
export async function libraryTrackFile(
  key: string
): Promise<{ path: string; mime: string } | null> {
  const k = key.toLowerCase()
  if (GENERATED.some((g) => g.key === k)) return { path: await generatedPath(k), mime: 'audio/wav' }
  const t = (await folderTracks()).find((x) => x.key === k)
  return t ? { path: t.path, mime: t.mime } : null
}

// ── Uploaded music ──────────────────────────────────────────────────────────

const MUSIC_STATUS = 'music'
const metaPrefix = (videoId: string) =>
  `{"source":"music","video_id":"${String(videoId).toLowerCase()}"`

/** The meta a music row carries: video first, so a row is found by prefix. */
export function musicRowMeta(videoId: string, name: string): string {
  return `${metaPrefix(videoId)},"name":${JSON.stringify(String(name).slice(0, 120))}}`
}

function musicError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}

/** The container a file's first bytes announce, as a pinned-demuxer mime. */
export function sniffAudio(head: Buffer): string | null {
  if (head.length < 12) return null
  const s = (a: number, b: number) => head.subarray(a, b).toString('latin1')
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'audio/wav'
  if (s(0, 4) === 'OggS') return 'audio/ogg'
  if (s(0, 4) === 'fLaC') return 'audio/flac'
  if (s(4, 8) === 'ftyp') return 'audio/mp4'
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return 'audio/webm'
  }
  if (s(0, 3) === 'ID3') return 'audio/mpeg'
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  return null
}

/** Converts an author's audio file to AAC and keeps it for this video. */
export async function uploadMusic(
  user: User,
  videoId: string,
  file: { filename: string; stream: Readable; truncated?: () => boolean }
): Promise<UploadedMusic> {
  if (!(await hasFfmpeg())) {
    throw musicError(503, 'MUSIC_NO_FFMPEG', 'Music needs ffmpeg on the server')
  }
  const dir = join(videoWorkDir(), 'music-in', randomUUID())
  await mkdir(dir, { recursive: true })
  try {
    const raw = join(dir, 'in.bin')
    await pipeline(file.stream, createWriteStream(raw))
    const s = await stat(raw)
    if (file.truncated?.() || s.size > UPLOAD_MAX_BYTES) {
      throw musicError(413, 'MUSIC_TOO_LARGE', 'A music file may be at most 40 MB')
    }
    if (!s.size) throw musicError(422, 'MUSIC_EMPTY', 'The file is empty')
    const fh = await open(raw, 'r')
    const head = Buffer.alloc(16)
    await fh.read(head, 0, 16, 0)
    await fh.close()
    const mime = sniffAudio(head)
    if (!mime) {
      throw musicError(422, 'MUSIC_NOT_AUDIO', 'That is not an audio file we can read')
    }
    const probe = await probeVideo(raw, mime).catch(() => null)
    if (!probe?.has_audio) {
      throw musicError(422, 'MUSIC_NOT_AUDIO', 'That file has no sound we can read')
    }
    if (probe.duration_ms && probe.duration_ms > UPLOAD_MAX_MS) {
      throw musicError(422, 'MUSIC_TOO_LONG', 'Music may be at most 20 minutes long')
    }
    const out = join(dir, 'music.m4a')
    await runFfmpeg(
      [
        '-y',
        '-v',
        'error',
        ...lockedInputArgs(mime),
        '-i',
        raw,
        '-map',
        '0:a:0',
        '-vn',
        '-t',
        String(UPLOAD_MAX_MS / 1000),
        '-ac',
        '2',
        '-ar',
        '44100',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-fs',
        String(30 * 1024 * 1024),
        '-movflags',
        '+faststart',
        out
      ],
      undefined,
      undefined,
      { lowPriority: true }
    )
    const done = await probeVideo(out, 'audio/mp4').catch(() => null)
    if (!done?.has_audio || !done.duration_ms) {
      throw musicError(422, 'MUSIC_NOT_AUDIO', 'That file has no sound we can read')
    }
    const name =
      basename(String(file.filename || 'Music'))
        .replace(/\.[^.]+$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'Music'
    const stored = await uploadFileFromPath(user, out, `${name}.m4a`, 'audio/mp4')
    const id = randomUUID()
    try {
      await db('nivaro_help_video_uploads').insert({
        id,
        user: user.id,
        mime: 'audio/mp4',
        bytes_received: s.size,
        next_part: 0,
        status: MUSIC_STATUS,
        file_id: stored.id,
        duration_ms: done.duration_ms,
        has_audio: true,
        meta: musicRowMeta(videoId, name),
        created_at: new Date(),
        updated_at: new Date()
      })
    } catch (err) {
      await discardFile(user, String(stored.id))
      throw err
    }
    return { id, name, duration_ms: done.duration_ms }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function rowToMusic(r: Record<string, unknown>): UploadedMusic {
  let name = 'Music'
  try {
    name = String(JSON.parse(String(r.meta)).name ?? 'Music')
  } catch {
    /* keep the default */
  }
  return { id: String(r.id).toLowerCase(), name, duration_ms: Number(r.duration_ms ?? 0) }
}

function musicRows(videoId: string) {
  return db('nivaro_help_video_uploads')
    .where({ status: MUSIC_STATUS })
    .where('meta', 'like', `${metaPrefix(videoId)}%`)
}

/** Music uploaded to this video, newest first. */
export async function listVideoMusic(videoId: string): Promise<UploadedMusic[]> {
  const rows = await musicRows(videoId).orderBy('created_at', 'desc').limit(50)
  return rows.map(rowToMusic)
}

/** The music row, only when it belongs to this video. */
export async function videoMusicRow(
  videoId: string,
  musicId: string
): Promise<Record<string, unknown> | null> {
  if (!isUuid(musicId)) return null
  return (await musicRows(videoId).where({ id: musicId }).first()) ?? null
}

/** Throws an edits error when a draft names music that is not this video's. */
export async function assertMusicBelongs(videoId: string, music: MusicBed | undefined) {
  if (!music) return
  if (music.source === 'upload') {
    if (!(await videoMusicRow(videoId, music.track))) {
      throw Object.assign(new Error('That music file is not part of this video'), {
        statusCode: 422,
        code: 'HELP_VIDEO_EDITS_INVALID'
      })
    }
  } else if (!(await libraryTrackFile(music.track))) {
    throw Object.assign(new Error('That music track is not in the library'), {
      statusCode: 422,
      code: 'HELP_VIDEO_EDITS_INVALID'
    })
  }
}

/** Removes an uploaded music file. Refused while any version uses it. */
export async function deleteVideoMusic(user: User, videoId: string, musicId: string) {
  const row = await videoMusicRow(videoId, musicId)
  if (!row) throw musicError(404, 'HELP_VIDEO_NOT_FOUND', 'Music not found')
  const versions = await db('nivaro_help_video_versions')
    .where({ video_id: videoId })
    .where('edits', 'like', `%${String(musicId).toLowerCase()}%`)
    .first('id')
  if (versions) {
    throw musicError(409, 'MUSIC_IN_USE', 'A version of this video still uses this music')
  }
  await db('nivaro_help_video_uploads').where({ id: row.id }).delete()
  if (row.file_id) await discardFile(user, String(row.file_id))
}

/** Every music file of a video (for a permanent delete), rows removed. */
export async function takeVideoMusicFiles(videoId: string): Promise<string[]> {
  const rows = await musicRows(videoId).select('id', 'file_id')
  if (!rows.length) return []
  await db('nivaro_help_video_uploads')
    .whereIn(
      'id',
      rows.map((r) => r.id)
    )
    .delete()
  return rows.flatMap((r) => (r.file_id ? [String(r.file_id)] : []))
}

/** The music a version's edits name, as a local file for the render
 *  (copied into `dir`). Null when the edits have no music. Throws when the
 *  music is gone, so the render fails with a reason instead of dropping it. */
export async function musicForRender(
  videoId: string,
  rawMusic: unknown,
  dir: string
): Promise<{ path: string; mime: string } | null> {
  const music = normalizeMusic(rawMusic)
  if (!music) return null
  if (music.source === 'library') {
    const t = await libraryTrackFile(music.track)
    if (!t)
      throw new Error(`The music track "${music.name || music.track}" is no longer in the library`)
    return t
  }
  const row = await videoMusicRow(videoId, music.track)
  const file = row?.file_id ? await getFile(String(row.file_id)) : null
  if (!file?.filename_disk) throw new Error('The music file for this video is missing')
  const path = join(dir, 'music.m4a')
  const opened = await openStoredObject(String(file.filename_disk))
  await pipeline(opened.stream, createWriteStream(path))
  return { path, mime: 'audio/mp4' }
}
