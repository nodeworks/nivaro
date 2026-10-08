import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, rm, stat, truncate } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { hasFfmpeg, probeVideo, remuxToFile } from './ffmpeg.js'
import { uploadFileFromPath } from './files.js'

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
export const MAX_DURATION_MS = 31 * 60_000 // 30 minutes + 1 minute slack
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface UploadSession {
  id: string
  mime: string
  bytes_received: number
  next_part: number
  status: string
  created_at: string
  updated_at: string
}
export interface FinalizedUpload {
  file_id: string
  duration_ms: number | null
  width: number | null
  height: number | null
  has_audio: boolean
  clicks: unknown
  levels: unknown
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
    return { error: 'Recordings may be at most 1.2 GB', status: 413 }
  return 'append'
}

function shape(r: Record<string, unknown>): UploadSession {
  return {
    id: String(r.id).toLowerCase(),
    mime: String(r.mime),
    bytes_received: Number(r.bytes_received),
    next_part: Number(r.next_part),
    status: String(r.status),
    created_at: new Date(r.created_at as string).toISOString(),
    updated_at: new Date(r.updated_at as string).toISOString()
  }
}

async function own(user: User, id: string): Promise<Record<string, unknown>> {
  id = assertId(id)
  const row = await db('nivaro_help_video_uploads').where({ id }).first()
  if (!row || String(row.user).toLowerCase() !== user.id.toLowerCase())
    throw fail(404, 'UPLOAD_NOT_FOUND', 'Upload not found')
  if (row.instance && row.instance !== HOST) {
    throw fail(409, 'UPLOAD_ELSEWHERE', 'This upload is held by another server — retry shortly')
  }
  return row
}

export async function openUpload(user: User, mime: string): Promise<UploadSession> {
  const base = mime.split(';')[0].trim().toLowerCase()
  if (!ALLOWED_MIME.includes(base))
    throw fail(400, 'UPLOAD_MIME', 'Only WebM or MP4 recordings can be uploaded')
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
    if (n === 0 && !looksLikeVideo(String(row.mime), body)) {
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
  meta: { duration_ms?: number; clicks?: unknown; levels?: unknown }
): Promise<FinalizedUpload> {
  const rid = assertId(id)
  // Claim: only one finalize can flip open -> finalizing; appends are serialized
  // on the same lock so none is mid-write when the claim lands.
  const row = await withLock(rid, async () => {
    const r = await own(user, rid)
    if (r.status !== 'open') throw fail(409, 'UPLOAD_CLOSED', 'This upload is already finished')
    const claimed = await db('nivaro_help_video_uploads')
      .where({ id: r.id, status: 'open' })
      .update({ status: 'finalizing', updated_at: new Date() })
    if (!claimed) throw fail(409, 'UPLOAD_CLOSED', 'This upload is already finishing')
    return r
  })
  const dbId = row.id
  const reopen = () =>
    db('nivaro_help_video_uploads')
      .where({ id: dbId, status: 'finalizing' })
      .update({ status: 'open', updated_at: new Date() })
  const raw = partPath(String(dbId))
  const ext = row.mime === 'video/mp4' ? '.mp4' : '.webm'
  const fixed = join(videoWorkDir(), 'uploads', `${String(dbId).toLowerCase()}.fixed${ext}`)
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
        meta: JSON.stringify({ clicks: meta.clicks ?? null, levels: meta.levels ?? null }).slice(
          0,
          2_000_000
        ),
        updated_at: new Date()
      })
    if (!done) throw fail(409, 'UPLOAD_CLOSED', 'This upload is no longer finishing')
    // The recording is stored and recorded: only now is the temp file expendable.
    await rm(raw, { force: true })
    return {
      file_id: String(file.id),
      duration_ms: durationMs,
      width: probe.width,
      height: probe.height,
      has_audio: probe.has_audio,
      clicks: meta.clicks ?? null,
      levels: meta.levels ?? null
    }
  } catch (err) {
    await reopen().catch(() => undefined)
    throw err
  } finally {
    await rm(fixed, { force: true })
  }
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
  let meta: { clicks?: unknown; levels?: unknown } = {}
  try {
    meta = JSON.parse(String(row.meta ?? '{}'))
  } catch {
    meta = {}
  }
  return {
    file_id: String(row.file_id),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    has_audio: row.has_audio !== false && row.has_audio !== 0,
    clicks: meta.clicks ?? null,
    levels: meta.levels ?? null
  }
}

export async function listOpenUploads(user: User): Promise<UploadSession[]> {
  const rows = await db('nivaro_help_video_uploads')
    .where({ user: user.id, status: 'open' })
    .orderBy('created_at', 'desc')
  return rows.map((r) => shape(r as Record<string, unknown>))
}

export async function abandonUpload(user: User, id: string): Promise<void> {
  const row = await own(user, id)
  await db('nivaro_help_video_uploads')
    .where({ id: row.id })
    .update({ status: 'abandoned', updated_at: new Date() })
  await rm(partPath(String(row.id)), { force: true })
}

export async function purgeStaleUploads(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_HOURS * 3_600_000)
  const rows = await db('nivaro_help_video_uploads')
    .where({ status: 'open' })
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
  return rows.length
}
