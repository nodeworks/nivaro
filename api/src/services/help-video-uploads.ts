import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, rm, stat, truncate } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import {
  hasFfmpeg,
  lockedInputArgs,
  probeStreams,
  probeVideo,
  remuxToFile,
  runFfmpeg
} from './ffmpeg.js'
import { deleteFile, getFile, uploadFileFromPath } from './files.js'
import { normalizeMarks, normalizeScript, type RecordedMark } from './help-video-script.js'
import {
  buildUploadArgs,
  planUploadedVideo,
  sniffContainer,
  type UploadContainer
} from './help-video-upload-media.js'
import {
  type ActivitySpan,
  normalizeActivity,
  normalizeClicks,
  normalizeLevels
} from './help-video-walk.js'
import { deleteStoredObject } from './storage-drivers.js'

// The host name, not the per-boot INSTANCE_ID: a restarted container keeps its
// temp files and must keep accepting parts for uploads it opened before.
const HOST = hostname().slice(0, 200)

// Recording uploads arrive as numbered parts every few seconds so a long
// recording never meets a request-size limit and a closed tab loses nothing.
// Parts append to a temp file on the process that opened the session (its
// instance is stored); finalize moves the file into storage as nivaro_files.

export const MAX_PART_BYTES = 8 * 1024 * 1024
export const MAX_UPLOAD_BYTES = Math.round(1.2 * 1024 * 1024 * 1024)
export const ALLOWED_MIME = ['video/webm', 'video/mp4']
const STALE_HOURS = 24
/** A recording uploaded but never saved as a video is kept this long. */
const UNUSED_RECORDING_DAYS = 7
const FINALIZING_STALE_MS = 3_600_000 // a 1.2 GB remux finishes well inside this
export const MAX_DURATION_MS = 31 * 60_000 // 30 minutes + 1 minute slack
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface UploadSession {
  id: string
  mime: string
  bytes_received: number
  next_part: number
  status: string
  /** Probed length of a finalized recording; null while open. */
  duration_ms: number | null
  created_at: string
  updated_at: string
  /** 'recording' from the browser recorder, 'upload' for a file someone picked. */
  source: 'recording' | 'upload'
  /** Uploaded files only: the picked file's name and size (resume matches them). */
  name?: string | null
  size?: number | null
  /** Uploaded files while finishing: 'checking' | 'converting' | 'saving'. */
  phase?: string | null
  /** Uploaded files while converting: 0-100. */
  progress?: number | null
  /** Why an uploaded file could not be kept (status `abandoned` = final,
   *  `open` = finalize can be tried again). */
  error?: string | null
  error_code?: string | null
}

/** What `meta` holds for an uploaded file (recordings hold {clicks, levels}). */
interface UploadMeta {
  source?: 'upload'
  name?: string | null
  size?: number | null
  phase?: string | null
  progress?: number | null
  error?: string | null
  error_code?: string | null
  clicks?: unknown
  levels?: unknown
}

/** The meta of an uploaded file. A recording's meta (up to 2 MB of clicks and
 *  levels) is never parsed here: `source` is always written first, so its head
 *  says which kind the row is. */
const UPLOAD_META_HEAD = '{"source":"upload"'
function uploadMeta(row: Record<string, unknown>): UploadMeta | null {
  const raw = row.meta == null ? '' : String(row.meta)
  if (!raw.startsWith(UPLOAD_META_HEAD)) return null
  try {
    return JSON.parse(raw) as UploadMeta
  } catch {
    return null
  }
}
function metaJson(m: UploadMeta): string {
  // `source` first: uploadMeta() reads the head only.
  return JSON.stringify({ source: 'upload', ...m })
}
export interface FinalizedUpload {
  file_id: string
  duration_ms: number | null
  width: number | null
  height: number | null
  has_audio: boolean
  clicks: unknown
  levels: unknown
  /** Script mode (#1491): the steps written before recording and where each
   *  one was marked, in source time. Null for recordings made without a
   *  script and for every uploaded file. */
  script: string[] | null
  marks: RecordedMark[] | null
}

function fail(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}

export function videoWorkDir(): string {
  return process.env.VIDEO_WORK_DIR || join(tmpdir(), 'nivaro-video')
}
// SQL Server compares a string to a uniqueidentifier after truncating it, so
// a caller id like '<uuid>/../x' would still match a row. Reject anything that
// is not exactly a uuid BEFORE querying, and build every path from the row's id.
function assertId(id: string): string {
  if (typeof id !== 'string' || !UPLOAD_ID_RE.test(id)) {
    throw fail(404, 'UPLOAD_NOT_FOUND', 'Upload not found')
  }
  return id.toLowerCase()
}
function partPath(id: string): string {
  return join(videoWorkDir(), 'uploads', `${assertId(id)}.part`)
}

// Per-upload serialization: uploads are pinned to one host, so an in-process
// promise chain is enough to make read -> decide -> append -> update atomic.
const locks = new Map<string, Promise<unknown>>()
async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(id, tail)
  try {
    return await run
  } finally {
    if (locks.get(id) === tail) locks.delete(id)
  }
}

/** Does the first part look like the container the client declared? */
export function looksLikeVideo(mime: string, head: Buffer): boolean {
  if (mime === 'video/webm') {
    return (
      head.length >= 4 &&
      head[0] === 0x1a &&
      head[1] === 0x45 &&
      head[2] === 0xdf &&
      head[3] === 0xa3
    )
  }
  if (mime === 'video/mp4') {
    return head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp'
  }
  return false
}

export function decidePart(
  session: { next_part: number; last_part_bytes: number | null; bytes_received: number },
  n: number,
  size: number
): 'append' | 'duplicate' | { error: string; status: number } {
  if (size <= 0) return { error: 'The part is empty', status: 400 }
  if (size > MAX_PART_BYTES) return { error: 'A part may be at most 8 MB', status: 413 }
  if (n === session.next_part - 1) {
    return size === session.last_part_bytes
      ? 'duplicate'
      : { error: `Part ${n} was already received with another size`, status: 409 }
  }
  if (n !== session.next_part)
    return { error: `Expected part ${session.next_part}, got ${n}`, status: 409 }
  if (session.bytes_received + size > MAX_UPLOAD_BYTES)
    return { error: 'Videos may be at most 1.2 GB', status: 413 }
  return 'append'
}

function shape(r: Record<string, unknown>): UploadSession {
  const m = uploadMeta(r)
  return {
    source: m ? 'upload' : 'recording',
    ...(m
      ? {
          name: m.name ?? null,
          size: m.size ?? null,
          phase: m.phase ?? null,
          progress: m.progress ?? null,
          error: m.error ?? null,
          error_code: m.error_code ?? null
        }
      : {}),
    id: String(r.id).toLowerCase(),
    mime: String(r.mime),
    bytes_received: Number(r.bytes_received),
    next_part: Number(r.next_part),
    status: String(r.status),
    duration_ms: r.duration_ms == null ? null : Number(r.duration_ms),
    created_at: new Date(r.created_at as string).toISOString(),
    updated_at: new Date(r.updated_at as string).toISOString()
  }
}

async function own(
  user: User,
  id: string,
  opts: { anyHost?: boolean } = {}
): Promise<Record<string, unknown>> {
  id = assertId(id)
  const row = await db('nivaro_help_video_uploads').where({ id }).first()
  if (!row || String(row.user).toLowerCase() !== user.id.toLowerCase())
    throw fail(404, 'UPLOAD_NOT_FOUND', 'Upload not found')
  if (!opts.anyHost && row.instance && row.instance !== HOST) {
    throw fail(409, 'UPLOAD_ELSEWHERE', 'This upload is held by another server — retry shortly')
  }
  return row
}

export async function openUpload(
  user: User,
  mime: string,
  opts: { source?: string; name?: unknown; size?: unknown } = {}
): Promise<UploadSession> {
  const isFile = opts.source === 'upload'
  let base = mime.split(';')[0].trim().toLowerCase()
  let meta: string | null = null
  if (isFile) {
    // A picked file: what the browser says it is means nothing. The first part
    // decides the container (sniffContainer) and finalize probes the streams,
    // which needs ffmpeg.
    if (!(await hasFfmpeg())) {
      throw fail(
        503,
        'UPLOAD_NO_FFMPEG',
        'This server cannot read uploaded videos (ffmpeg is not installed)'
      )
    }
    const size = Number(opts.size)
    if (Number.isFinite(size) && size > MAX_UPLOAD_BYTES) {
      throw fail(413, 'UPLOAD_TOO_BIG', 'Videos may be at most 1.2 GB')
    }
    base = 'video/mp4' // a placeholder until the first part shows what it is
    meta = metaJson({
      name: String(opts.name ?? '').slice(0, 200) || null,
      size: Number.isFinite(size) && size > 0 ? Math.round(size) : null
    })
  } else if (!ALLOWED_MIME.includes(base)) {
    throw fail(400, 'UPLOAD_MIME', 'Only WebM or MP4 recordings can be uploaded')
  }
  const id = randomUUID()
  const now = new Date()
  await mkdir(join(videoWorkDir(), 'uploads'), { recursive: true })
  await db('nivaro_help_video_uploads').insert({
    id,
    user: user.id,
    mime: base,
    bytes_received: 0,
    next_part: 0,
    last_part_bytes: null,
    status: 'open',
    instance: HOST,
    meta,
    created_at: now,
    updated_at: now
  })
  return shape(
    (await db('nivaro_help_video_uploads').where({ id }).first()) as Record<string, unknown>
  )
}

export async function appendPart(
  user: User,
  id: string,
  n: number,
  body: Buffer
): Promise<UploadSession> {
  const rid = assertId(id)
  return withLock(rid, async () => {
    const row = await own(user, rid)
    if (row.status !== 'open') throw fail(409, 'UPLOAD_CLOSED', 'This upload is already finished')
    const decision = decidePart(
      {
        next_part: Number(row.next_part),
        last_part_bytes: row.last_part_bytes == null ? null : Number(row.last_part_bytes),
        bytes_received: Number(row.bytes_received)
      },
      n,
      body.length
    )
    if (decision === 'duplicate') return shape(row)
    if (typeof decision === 'object') throw fail(decision.status, 'UPLOAD_PART', decision.error)
    const isFile = !!uploadMeta(row)
    let sniffed: UploadContainer | null = null
    if (n === 0 && isFile) {
      sniffed = sniffContainer(body)
      if (!sniffed) {
        throw fail(422, 'UPLOAD_NOT_VIDEO', "That file isn't an MP4, WebM or MOV video")
      }
    } else if (n === 0 && !looksLikeVideo(String(row.mime), body)) {
      throw fail(422, 'UPLOAD_NOT_VIDEO', 'That does not look like a WebM or MP4 recording')
    }
    const path = partPath(String(row.id))
    await appendFile(path, body)
    const updated = await db('nivaro_help_video_uploads')
      .where({ id: row.id, next_part: n })
      .update({
        next_part: n + 1,
        last_part_bytes: body.length,
        bytes_received: Number(row.bytes_received) + body.length,
        ...(sniffed ? { mime: sniffed } : {}),
        updated_at: new Date()
      })
    if (!updated) {
      await truncate(path, Number(row.bytes_received)).catch(() => undefined)
      throw fail(409, 'UPLOAD_PART', 'Another request wrote this part first')
    }
    return shape(
      (await db('nivaro_help_video_uploads').where({ id: row.id }).first()) as Record<
        string,
        unknown
      >
    )
  })
}

export async function finalizeUpload(
  user: User,
  id: string,
  meta: {
    duration_ms?: number
    clicks?: unknown
    levels?: unknown
    activity?: unknown
    script?: unknown
    marks?: unknown
  }
): Promise<FinalizedUpload | ProcessingUpload> {
  const rid = assertId(id)
  const clicks = normalizeClicks(meta.clicks)
  const levels = normalizeLevels(meta.levels)
  const activity = normalizeActivity(meta.activity)
  // Script mode (#1491): marks mean nothing without the script they index.
  const script = normalizeScript(meta.script)
  const marks = script ? (normalizeMarks(meta.marks) ?? []) : null
  // Claim: only one finalize can flip open -> finalizing; appends are serialized
  // on the same lock so none is mid-write when the claim lands.
  const row = await withLock(rid, async () => {
    const r = await own(user, rid)
    let claimed: number
    if (r.status === 'finalizing') {
      // A finalize that died mid-flight leaves the row here; re-claim it once
      // its claim is older than the window (age measured from the claim stamp).
      const cutoff = new Date(Date.now() - FINALIZING_STALE_MS)
      claimed = await db('nivaro_help_video_uploads')
        .where({ id: r.id, status: 'finalizing' })
        .where('updated_at', '<', cutoff)
        .update({ updated_at: new Date() })
      if (!claimed) throw fail(409, 'UPLOAD_CLOSED', 'This upload is already finishing')
    } else {
      if (r.status !== 'open') throw fail(409, 'UPLOAD_CLOSED', 'This upload is already finished')
      claimed = await db('nivaro_help_video_uploads')
        .where({ id: r.id, status: 'open' })
        .update({ status: 'finalizing', updated_at: new Date() })
      if (!claimed) throw fail(409, 'UPLOAD_CLOSED', 'This upload is already finishing')
    }
    return r
  })
  const fileMeta = uploadMeta(row)
  if (fileMeta) {
    // A picked file is checked (and maybe converted) in the background: a
    // conversion can outlast any proxy's request timeout. The caller polls
    // GET /uploads/:id until it is finalized (or says why it was refused).
    startFileProcessing(user, row, fileMeta)
    return { processing: true, id: String(row.id).toLowerCase() }
  }
  const dbId = row.id
  const reopen = () =>
    db('nivaro_help_video_uploads')
      .where({ id: dbId, status: 'finalizing' })
      .update({ status: 'open', updated_at: new Date() })
  const raw = partPath(String(dbId))
  const ext = row.mime === 'video/mp4' ? '.mp4' : '.webm'
  const fixed = join(videoWorkDir(), 'uploads', `${String(dbId).toLowerCase()}.fixed${ext}`)
  // The new file row is listable (nothing guards it yet) until the upload row
  // names it, so every failure between the two must delete it again.
  let createdFile: string | null = null
  let recorded = false
  try {
    const size = await stat(raw)
      .then((s) => s.size)
      .catch(() => 0)
    if (!size) throw fail(422, 'UPLOAD_EMPTY', 'Nothing was recorded')
    let path = raw
    let probe = {
      duration_ms: null as number | null,
      width: null as number | null,
      height: null as number | null,
      has_audio: true
    }
    if (await hasFfmpeg()) {
      try {
        await remuxToFile(raw, fixed, String(row.mime))
        path = fixed
        probe = await probeVideo(fixed, String(row.mime))
      } catch (err) {
        console.warn(`help-video upload ${String(dbId)}: ffmpeg failed: ${(err as Error).message}`)
        throw fail(422, 'UPLOAD_UNREADABLE', 'The recording could not be read')
      }
    }
    if (probe.duration_ms != null && probe.duration_ms > MAX_DURATION_MS) {
      throw fail(422, 'UPLOAD_TOO_LONG', 'Recordings can be up to 30 minutes')
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const file = await uploadFileFromPath(user, path, `recording-${stamp}${ext}`, String(row.mime))
    createdFile = String(file.id)
    const clientMs = Number(meta.duration_ms)
    const durationMs =
      probe.duration_ms ??
      (Number.isFinite(clientMs) && clientMs > 0
        ? Math.min(Math.round(clientMs), 30 * 60_000)
        : null)
    const done = await db('nivaro_help_video_uploads')
      .where({ id: dbId, status: 'finalizing' })
      .update({
        status: 'finalized',
        file_id: file.id,
        duration_ms: durationMs,
        width: probe.width,
        height: probe.height,
        has_audio: probe.has_audio,
        // Bounded by the normalizers (≈1.5 MB at most), so never cut mid-JSON.
        // Activity (#1518) is read back by activityOfFile: the version table
        // has no column for it, the upload row stays for as long as the video.
        // The script and its marks (#1491) ride along until the video is made.
        meta: JSON.stringify({ clicks, levels, activity, ...(script ? { script, marks } : {}) }),
        updated_at: new Date()
      })
    if (!done) throw fail(409, 'UPLOAD_CLOSED', 'This upload is no longer finishing')
    recorded = true
    // The recording is stored and recorded: only now is the temp file expendable.
    await rm(raw, { force: true })
    return {
      file_id: String(file.id),
      duration_ms: durationMs,
      width: probe.width,
      height: probe.height,
      has_audio: probe.has_audio,
      clicks,
      levels,
      script,
      marks
    }
  } catch (err) {
    if (createdFile && !recorded) {
      // The upload row never named the file: delete it (bytes and row). If that
      // fails too, park the id on an abandoned row so the purge retries it, and
      // leave the upload closed rather than reopening it.
      if (!(await discardFile(user, createdFile))) {
        await db('nivaro_help_video_uploads')
          .where({ id: dbId })
          .update({ status: 'abandoned', updated_at: new Date() })
          .catch(() => undefined)
        throw err
      }
    }
    await reopen().catch(() => undefined)
    throw err
  } finally {
    await rm(fixed, { force: true })
  }
}

export interface ProcessingUpload {
  processing: true
  id: string
}

/** Uploaded files being checked or converted on this process, by upload id. */
const processing = new Map<string, AbortController>()

function uploadThreads(): number {
  const n = Number(process.env.VIDEO_RENDER_THREADS)
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 2
}

/** Conversions run one at a time per process: each is a full-CPU ffmpeg
 *  encode, and an author starting several must not starve renders and
 *  requests. Copies (no re-encode) do not wait for the slot. */
let conversionTail: Promise<void> = Promise.resolve()
async function withConversionSlot<T>(
  onWait: () => Promise<unknown>,
  work: () => Promise<T>
): Promise<T> {
  const prev = conversionTail
  let release!: () => void
  conversionTail = new Promise<void>((r) => {
    release = r
  })
  let waiting = true
  const refresh = setInterval(() => {
    // Keep the finalizing claim fresh while queued so it is never reclaimed.
    if (waiting) void onWait().catch(() => undefined)
  }, 300_000)
  refresh.unref?.()
  try {
    await onWait().catch(() => undefined)
    await prev
    waiting = false
    return await work()
  } finally {
    clearInterval(refresh)
    release()
  }
}

/** The longest an output may run, in seconds (just past the duration cap, so
 *  an over-long file still fails the length check after the bounded run). */
const MAX_OUTPUT_SECONDS = Math.ceil(MAX_DURATION_MS / 1000) + 1
/** The largest output file ffmpeg may write. */
const MAX_OUTPUT_BYTES = MAX_UPLOAD_BYTES * 2

const UNREADABLE =
  "That video could not be read. It may be damaged, or saved in a format this server can't open."

function startFileProcessing(user: User, row: Record<string, unknown>, m: UploadMeta): void {
  const id = String(row.id).toLowerCase()
  const ctl = new AbortController()
  processing.set(id, ctl)
  void processFile(user, row, m, ctl.signal)
    .catch((err) => console.warn(`help-video upload ${id}: ${(err as Error).message}`))
    .finally(() => processing.delete(id))
}

/** Writes an uploaded file's meta while it is still finishing (also keeps the
 *  finalizing claim fresh, so a long conversion is never reclaimed). */
function setFileMeta(dbId: unknown, m: UploadMeta) {
  return db('nivaro_help_video_uploads')
    .where({ id: dbId, status: 'finalizing' })
    .update({ meta: metaJson(m), updated_at: new Date() })
}

/**
 * Turns an uploaded file into a stored source the player can play anywhere
 * (rules in help-video-upload-media.ts): probe the streams with the sniffed
 * container pinned, refuse what cannot be kept (422: the upload is abandoned
 * with the reason in its meta), copy or convert into a temp file, probe that,
 * store it and mark the upload finalized. A storage or database failure
 * reopens the upload (with the reason) so finalize can be tried again.
 * Exported for tests; production calls it through finalizeUpload.
 */
export async function processFile(
  user: User,
  row: Record<string, unknown>,
  base: UploadMeta,
  signal: AbortSignal
): Promise<void> {
  const dbId = row.id
  const mime = String(row.mime) as UploadContainer
  const raw = partPath(String(dbId))
  const keep: UploadMeta = { name: base.name ?? null, size: base.size ?? null }
  let out: string | null = null
  let createdFile: string | null = null
  let recorded = false
  try {
    const size = await stat(raw)
      .then((x) => x.size)
      .catch(() => 0)
    if (!size) throw fail(422, 'UPLOAD_EMPTY', 'The file was empty')
    await setFileMeta(dbId, { ...keep, phase: 'checking' })
    const probed = await probeStreams(raw, mime).catch(() => {
      throw fail(422, 'UPLOAD_UNREADABLE', UNREADABLE)
    })
    if (probed.duration_ms != null && probed.duration_ms > MAX_DURATION_MS) {
      throw fail(422, 'UPLOAD_TOO_LONG', 'Videos can be up to 30 minutes')
    }
    const plan = planUploadedVideo(probed)
    if ('error' in plan) throw fail(422, plan.error.code, plan.error.message)
    const ext = plan.container === 'video/mp4' ? '.mp4' : '.webm'
    out = join(videoWorkDir(), 'uploads', `${String(dbId).toLowerCase()}.fixed${ext}`)
    const converting = plan.kind !== 'copy'
    await setFileMeta(dbId, {
      ...keep,
      phase: converting ? 'waiting' : 'checking',
      progress: null
    })
    const total = probed.duration_ms
    let beat = 0
    const encode = () =>
      runFfmpeg(
        buildUploadArgs(
          plan,
          { path: raw, inputLock: lockedInputArgs(mime) },
          out as string,
          uploadThreads(),
          { maxSeconds: MAX_OUTPUT_SECONDS, maxBytes: MAX_OUTPUT_BYTES }
        ),
        converting && total
          ? (ms) => {
              const now = Date.now()
              if (now - beat < 1500) return
              beat = now
              const progress = Math.max(0, Math.min(99, Math.round((ms / total) * 100)))
              void setFileMeta(dbId, { ...keep, phase: 'converting', progress }).catch(
                () => undefined
              )
            }
          : undefined,
        signal,
        { lowPriority: converting }
      )
    try {
      if (converting) {
        await withConversionSlot(
          () => setFileMeta(dbId, { ...keep, phase: 'waiting', progress: null }),
          async () => {
            if (signal.aborted) throw new Error('cancelled while waiting')
            await setFileMeta(dbId, { ...keep, phase: 'converting', progress: 0 })
            await encode()
          }
        )
      } else {
        await encode()
      }
    } catch (err) {
      if (signal.aborted) throw fail(409, 'UPLOAD_CANCELLED', 'The upload was cancelled')
      console.warn(
        `help-video upload ${String(dbId).toLowerCase()}: ffmpeg (${plan.kind}) failed: ${(err as Error).message}`
      )
      throw fail(422, 'UPLOAD_UNREADABLE', UNREADABLE)
    }
    const outBytes = await stat(out)
      .then((x) => x.size)
      .catch(() => 0)
    if (outBytes >= MAX_OUTPUT_BYTES * 0.99) {
      // ffmpeg stopped at the size bound: the result would be cut short.
      throw fail(422, 'UPLOAD_TOO_BIG', 'That video is too large once converted')
    }
    const probe = await probeVideo(out, plan.container).catch(() => null)
    if (!probe?.width) throw fail(422, 'UPLOAD_UNREADABLE', UNREADABLE)
    if (probe.duration_ms != null && probe.duration_ms > MAX_DURATION_MS) {
      throw fail(422, 'UPLOAD_TOO_LONG', 'Videos can be up to 30 minutes')
    }
    await setFileMeta(dbId, { ...keep, phase: 'saving' })
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const file = await uploadFileFromPath(user, out, `upload-${stamp}${ext}`, plan.container)
    createdFile = String(file.id)
    const done = await db('nivaro_help_video_uploads')
      .where({ id: dbId, status: 'finalizing' })
      .update({
        status: 'finalized',
        mime: plan.container,
        file_id: file.id,
        duration_ms: probe.duration_ms,
        width: probe.width,
        height: probe.height,
        has_audio: probe.has_audio,
        meta: metaJson({ ...keep, clicks: null, levels: null }),
        updated_at: new Date()
      })
    if (!done) throw fail(409, 'UPLOAD_CLOSED', 'This upload is no longer finishing')
    recorded = true
    await rm(raw, { force: true })
  } catch (err) {
    const e = err as Error & { statusCode?: number; code?: string }
    if (createdFile && !recorded && !(await discardFile(user, createdFile))) {
      // Parked for the purge (same rule as a recording's finalize).
      await db('nivaro_help_video_uploads')
        .where({ id: dbId })
        .update({ status: 'abandoned', updated_at: new Date() })
        .catch(() => undefined)
    } else if (e.statusCode === 422) {
      // The file itself is the problem: trying again cannot help.
      await db('nivaro_help_video_uploads')
        .where({ id: dbId, status: 'finalizing' })
        .update({
          status: 'abandoned',
          meta: metaJson({ ...keep, error: e.message, error_code: e.code ?? null }),
          updated_at: new Date()
        })
        .catch(() => undefined)
    } else {
      await db('nivaro_help_video_uploads')
        .where({ id: dbId, status: 'finalizing' })
        .update({
          status: 'open',
          meta: metaJson({
            ...keep,
            error: 'The video could not be saved. Try again in a moment.',
            error_code: 'UPLOAD_SAVE_FAILED'
          }),
          updated_at: new Date()
        })
        .catch(() => undefined)
    }
    // Abandoned (refused, cancelled, parked): the parts on this disk can go.
    const now = await db('nivaro_help_video_uploads')
      .where({ id: dbId })
      .first()
      .catch(() => null)
    if (now?.status === 'abandoned') await rm(raw, { force: true })
    if (e.code !== 'UPLOAD_CANCELLED' && e.statusCode !== 422) throw err
  } finally {
    if (out) await rm(out, { force: true })
  }
}

/** One upload as its owner sees it (any host): the upload dialog polls this
 *  while an uploaded file is checked or converted. */
export async function uploadStatus(user: User, id: string): Promise<UploadSession> {
  return shape(await own(user, id, { anyHost: true }))
}

/** 'upload' when a version's source file came from a picked file, else
 *  'recording' (the editor words a few things differently). */
export async function sourceKindOfFile(fileId: unknown): Promise<'recording' | 'upload'> {
  if (!fileId) return 'recording'
  const row = await db('nivaro_help_video_uploads')
    .where({ file_id: fileId })
    .first(db.raw('LEFT(meta, 20) as meta'))
    .catch(() => null)
  return String((row as { meta?: unknown } | null)?.meta ?? '').startsWith(UPLOAD_META_HEAD)
    ? 'upload'
    : 'recording'
}

/** The typing and idle spans the recorder logged for a version's source file
 *  (#1518), read from the upload row that produced it. Null for an uploaded
 *  file, a recording made before #1518 or of another window, and a recording
 *  that arrived in a package (its upload row lives on the other instance). */
export async function activityOfFile(fileId: unknown): Promise<ActivitySpan[] | null> {
  if (!fileId) return null
  const row = (await db('nivaro_help_video_uploads')
    .where({ file_id: fileId })
    .whereIn('status', ['used', 'finalized'])
    .first('meta')
    .catch(() => null)) as { meta?: unknown } | null | undefined
  const raw = row?.meta == null ? '' : String(row.meta)
  if (!raw || raw.startsWith(UPLOAD_META_HEAD) || !raw.includes('"activity"')) return null
  try {
    return normalizeActivity((JSON.parse(raw) as { activity?: unknown }).activity)
  } catch {
    return null
  }
}

/** Deletes a file nothing references (bytes and row). When the delete fails the
 *  file would stay listable, so its id is parked on an abandoned upload row
 *  (a column the files guard covers) and purgeStaleUploads retries it. */
export async function discardFile(owner: { id: string }, fileId: string): Promise<boolean> {
  try {
    await deleteFile(fileId)
    return true
  } catch (err) {
    console.warn(
      `help-video: could not delete file ${fileId}, left for the purge: ${(err as Error).message}`
    )
    const now = new Date()
    await db('nivaro_help_video_uploads')
      .insert({
        id: randomUUID(),
        user: owner.id,
        mime: 'application/octet-stream',
        bytes_received: 0,
        next_part: 0,
        status: 'abandoned',
        file_id: fileId,
        created_at: now,
        updated_at: now
      })
      .catch(() => undefined)
    return false
  }
}

/** Puts a taken upload back to finalized-unused (the video was never created),
 *  so its author sees the recording again and the purge can collect it. */
export async function releaseFinalizedUpload(uploadId: string): Promise<void> {
  await db('nivaro_help_video_uploads')
    .where({ id: assertId(uploadId), status: 'used' })
    .update({ status: 'finalized', updated_at: new Date() })
}

export async function takeFinalizedUpload(user: User, uploadId: string): Promise<FinalizedUpload> {
  uploadId = assertId(uploadId)
  const row = await db('nivaro_help_video_uploads').where({ id: uploadId }).first()
  if (
    !row ||
    String(row.user).toLowerCase() !== user.id.toLowerCase() ||
    row.status !== 'finalized' ||
    !row.file_id
  ) {
    throw fail(404, 'UPLOAD_NOT_FOUND', 'That recording is not ready — finish the upload first')
  }
  const taken = await db('nivaro_help_video_uploads')
    .where({ id: uploadId, status: 'finalized' })
    .update({ status: 'used', updated_at: new Date() })
  if (!taken) throw fail(409, 'UPLOAD_USED', 'That recording was already used')
  let meta: { clicks?: unknown; levels?: unknown; script?: unknown; marks?: unknown } = {}
  try {
    meta = JSON.parse(String(row.meta ?? '{}'))
  } catch {
    meta = {}
  }
  const script = normalizeScript(meta.script)
  return {
    file_id: String(row.file_id),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    has_audio: row.has_audio !== false && row.has_audio !== 0,
    clicks: meta.clicks ?? null,
    levels: meta.levels ?? null,
    script,
    marks: script ? (normalizeMarks(meta.marks) ?? []) : null
  }
}

/** A finalized upload whose recording no video version uses: the recorder
 *  finished uploading but the video was never created (a closed tab, a
 *  failed create). Narrows a nivaro_help_video_uploads query. */
function whereRecordingUnused(q: ReturnType<typeof db>): ReturnType<typeof db> {
  return q
    .where('nivaro_help_video_uploads.status', 'finalized')
    .whereNotNull('nivaro_help_video_uploads.file_id')
    .whereNotExists(function () {
      this.select(db.raw('1'))
        .from('nivaro_help_video_versions')
        .whereRaw('nivaro_help_video_versions.source_file = nivaro_help_video_uploads.file_id')
    })
    .whereNotExists(function () {
      this.select(db.raw('1'))
        .from('nivaro_help_videos')
        .whereRaw('nivaro_help_videos.poster_file = nivaro_help_video_uploads.file_id')
    })
}

/** This person's unfinished uploads (status `open`) and finished recordings
 *  that were never saved as a video (status `finalized`), newest first. */
export async function listOpenUploads(user: User): Promise<UploadSession[]> {
  const [open, finished] = await Promise.all([
    db('nivaro_help_video_uploads').where({ user: user.id, status: 'open' }),
    whereRecordingUnused(
      db('nivaro_help_video_uploads').where('nivaro_help_video_uploads.user', user.id)
    )
  ])
  return [...open, ...finished]
    .map((r) => shape(r as Record<string, unknown>))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/** Deletes a finished recording's file. The stored bytes go first, while the
 *  upload row still names the file (so the files API keeps hiding it); then
 *  the row lets go and the file row is deleted. On a failure the row keeps
 *  (or gets back) the file id, and purgeStaleUploads tries again. */
async function deleteRecording(uploadId: unknown, fileId: string): Promise<boolean> {
  try {
    const file = await getFile(fileId)
    if (file?.filename_disk) await deleteStoredObject(file.filename_disk)
    await db('nivaro_help_video_uploads')
      .where({ id: uploadId })
      .update({ file_id: null, updated_at: new Date() })
    await deleteFile(fileId)
    return true
  } catch (err) {
    await db('nivaro_help_video_uploads')
      .where({ id: uploadId })
      .whereNull('file_id')
      .update({ file_id: fileId })
      .catch(() => undefined)
    console.warn(
      `help-video upload ${String(uploadId).toLowerCase()}: could not delete recording ${fileId}: ${(err as Error).message}`
    )
    return false
  }
}

/** Discards an open upload, or a finished recording no video uses. Anything
 *  else (finishing, used, already discarded) is refused with 409. */
export async function abandonUpload(user: User, id: string): Promise<void> {
  const row = await own(user, id, { anyHost: true })
  if (row.status === 'finalizing' && uploadMeta(row)) {
    // An uploaded file still being checked or converted: cancel it. The
    // conversion notices (its claim is gone) and deletes anything it stored.
    const done = await db('nivaro_help_video_uploads')
      .where({ id: row.id, status: 'finalizing' })
      .update({ status: 'abandoned', updated_at: new Date() })
    if (done) {
      processing.get(String(row.id).toLowerCase())?.abort()
      await rm(partPath(String(row.id)), { force: true })
      return
    }
  }
  if (row.status === 'open') {
    if (row.instance && row.instance !== HOST) {
      throw fail(409, 'UPLOAD_ELSEWHERE', 'This upload is held by another server — retry shortly')
    }
    const done = await db('nivaro_help_video_uploads')
      .where({ id: row.id, status: 'open' })
      .update({ status: 'abandoned', updated_at: new Date() })
    if (!done) throw fail(409, 'UPLOAD_CLOSED', 'This upload is already finished')
    await rm(partPath(String(row.id)), { force: true })
    return
  }
  if (row.status === 'finalized' && row.file_id) {
    // Claimed first (finalized -> abandoned) so a save racing this discard
    // can't take the recording while its file is being deleted.
    const claimed = await whereRecordingUnused(
      db('nivaro_help_video_uploads').where('nivaro_help_video_uploads.id', String(row.id))
    ).update({ status: 'abandoned', updated_at: new Date() })
    if (claimed) {
      await deleteRecording(row.id, String(row.file_id))
      return
    }
  }
  throw fail(409, 'UPLOAD_CLOSED', 'This upload is already finished')
}

export async function purgeStaleUploads(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_HOURS * 3_600_000)
  const rows = await db('nivaro_help_video_uploads')
    .whereIn('status', ['open', 'finalizing'])
    .where('updated_at', '<', cutoff)
    .select('id')
  for (const r of rows) await rm(partPath(String(r.id)), { force: true })
  if (rows.length) {
    await db('nivaro_help_video_uploads')
      .whereIn(
        'id',
        rows.map((r) => r.id)
      )
      .update({ status: 'abandoned', updated_at: new Date() })
  }
  // Finished recordings never saved as a video: kept a week, then deleted.
  const oldCutoff = new Date(Date.now() - UNUSED_RECORDING_DAYS * 86_400_000)
  const unused = await whereRecordingUnused(db('nivaro_help_video_uploads'))
    .where('nivaro_help_video_uploads.updated_at', '<', oldCutoff)
    .select('nivaro_help_video_uploads.id', 'nivaro_help_video_uploads.file_id')
  let recordings = 0
  for (const r of unused) {
    const claimed = await whereRecordingUnused(
      db('nivaro_help_video_uploads').where('nivaro_help_video_uploads.id', r.id)
    ).update({ status: 'abandoned', updated_at: new Date() })
    if (claimed && (await deleteRecording(r.id, String(r.file_id)))) recordings++
  }
  // A discard whose file delete failed left the file id on the row: retry.
  const retry = await db('nivaro_help_video_uploads')
    .where({ status: 'abandoned' })
    .whereNotNull('file_id')
    .select('id', 'file_id')
  for (const r of retry) if (await deleteRecording(r.id, String(r.file_id))) recordings++
  await purgeTempFiles()
  return rows.length + recordings
}

/** Remux output (`<id>.fixed.<ext>`) left behind by a finalize that died. A
 *  live finalize finishes well inside FINALIZING_STALE_MS, so only older
 *  files go. */
export async function purgeTempFiles(now = Date.now()): Promise<number> {
  const dir = join(videoWorkDir(), 'uploads')
  const names = await readdir(dir).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.fixed\.(webm|mp4)$/i.test(name)) continue
    const path = join(dir, name)
    const s = await stat(path).catch(() => null)
    if (s && now - s.mtimeMs > FINALIZING_STALE_MS) {
      await rm(path, { force: true })
      removed++
    }
  }
  return removed
}
