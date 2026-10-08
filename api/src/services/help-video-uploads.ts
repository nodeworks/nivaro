import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, rm, stat } from 'node:fs/promises'
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
function partPath(id: string): string {
  return join(videoWorkDir(), 'uploads', `${id.toLowerCase()}.part`)
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
  const row = await own(user, id)
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
  await appendFile(partPath(id), body)
  const updated = await db('nivaro_help_video_uploads')
    .where({ id, next_part: n })
    .update({
      next_part: n + 1,
      last_part_bytes: body.length,
      bytes_received: Number(row.bytes_received) + body.length,
      updated_at: new Date()
    })
  if (!updated) throw fail(409, 'UPLOAD_PART', 'Another request wrote this part first')
  return shape(
    (await db('nivaro_help_video_uploads').where({ id }).first()) as Record<string, unknown>
  )
}

export async function finalizeUpload(
  user: User,
  id: string,
  meta: { duration_ms?: number; clicks?: unknown; levels?: unknown }
): Promise<FinalizedUpload> {
  const row = await own(user, id)
  if (row.status !== 'open') throw fail(409, 'UPLOAD_CLOSED', 'This upload is already finished')
  const raw = partPath(id)
  const size = await stat(raw)
    .then((s) => s.size)
    .catch(() => 0)
  if (!size) throw fail(422, 'UPLOAD_EMPTY', 'Nothing was recorded')
  const ext = row.mime === 'video/mp4' ? '.mp4' : '.webm'
  let path = raw
  let probe = {
    duration_ms: null as number | null,
    width: null as number | null,
    height: null as number | null,
    has_audio: true
  }
  if (await hasFfmpeg()) {
    const fixed = join(videoWorkDir(), 'uploads', `${id.toLowerCase()}.fixed${ext}`)
    try {
      await remuxToFile(raw, fixed)
      path = fixed
      probe = await probeVideo(fixed)
    } catch (err) {
      await rm(fixed, { force: true })
      throw fail(
        422,
        'UPLOAD_UNREADABLE',
        `The recording could not be read: ${(err as Error).message}`
      )
    }
  }
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const file = await uploadFileFromPath(user, path, `recording-${stamp}${ext}`, String(row.mime))
    const clientMs = Number(meta.duration_ms)
    const durationMs =
      probe.duration_ms ??
      (Number.isFinite(clientMs) && clientMs > 0
        ? Math.min(Math.round(clientMs), 30 * 60_000)
        : null)
    await db('nivaro_help_video_uploads')
      .where({ id })
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
    return {
      file_id: String(file.id),
      duration_ms: durationMs,
      width: probe.width,
      height: probe.height,
      has_audio: probe.has_audio,
      clicks: meta.clicks ?? null,
      levels: meta.levels ?? null
    }
  } finally {
    await rm(raw, { force: true })
    if (path !== raw) await rm(path, { force: true })
  }
}

export async function takeFinalizedUpload(user: User, uploadId: string): Promise<FinalizedUpload> {
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
  await own(user, id)
  await db('nivaro_help_video_uploads')
    .where({ id })
    .update({ status: 'abandoned', updated_at: new Date() })
  await rm(partPath(id), { force: true })
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
