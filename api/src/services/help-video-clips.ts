import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { hasFfmpeg, lockedInputArgs, probeVideo, runFfmpeg } from './ffmpeg.js'
import { getFile, uploadFileFromPath } from './files.js'
import {
  buildClipArgs,
  CLIP_LIMITS,
  type ClipCut,
  type ClipKind,
  clipDurationMs,
  clipOutputSize,
  clipSpans,
  isClipKind
} from './help-video-clip-plan.js'
import { editedDuration, normalizeEdits, type VideoEdits } from './help-video-edits.js'
import { isUuid } from './help-video-files.js'
import { discardFile, videoWorkDir } from './help-video-uploads.js'
import { getApp } from './io-holder.js'
import { startJobRun } from './job-runs.js'
import { openStoredObject } from './stored-object-stream.js'

// Short clips and GIFs (#1562). An author picks a window of a version (a
// chapter, a selected piece, a range) and a kind; the server cuts it in the
// background (help-video-clip-plan.ts says how), stores the file as a
// nivaro_files row the files API hides, and keeps a row in
// nivaro_help_video_clips (migration 412). Clips are served through the
// ticketed media routes and are visible to exactly the people who can watch
// the video; deleting the video purges them. One clip renders at a time per
// process, inside the cron heavy slot like a render, recorded as a job run.

const CLIPS = 'nivaro_help_video_clips'
const VERSIONS = 'nivaro_help_video_versions'
/** A clip still 'rendering' after this long belongs to a process that died. */
const STALE_RENDERING_MS = 60 * 60_000
/** The whole ffmpeg work for one clip (download aside) may take this long. */
const CLIP_TIMEOUT_MS = 10 * 60_000
export const CLIP_STATUSES = ['queued', 'rendering', 'ready', 'failed'] as const
export type ClipStatus = (typeof CLIP_STATUSES)[number]

export interface ClipDto {
  id: string
  video_id: string
  version_id: string | null
  kind: ClipKind
  status: ClipStatus
  progress: number | null
  error: string | null
  /** Edited time of the version the clip was cut from. */
  start_ms: number
  end_ms: number
  label: string | null
  bytes: number | null
  width: number | null
  height: number | null
  /** The ticketed file (`/api/help-videos/:id/clips/:clipId?st=`) once
   *  ready; `&download=1` makes it an attachment. Null until then. */
  url: string | null
  created_by: string | null
  created_at: string
}

function fail(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}
const low = (v: unknown) => String(v ?? '').toLowerCase()

function renderThreads(): number {
  const n = Number(process.env.VIDEO_RENDER_THREADS)
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 2
}

/** Migration 412 ran (the clips table exists). */
export async function clipsMigrated(): Promise<boolean> {
  try {
    return await hasColumn(CLIPS, 'id')
  } catch {
    return false
  }
}

export function clipUrl(videoId: string, clipId: string, ticket: string): string {
  return `/api/help-videos/${low(videoId)}/clips/${low(clipId)}?st=${ticket}`
}

/** The clip as the API answers it; `ticket` is the asking person's media
 *  ticket for the video (null = no URL, e.g. a create answer). */
export function serializeClip(row: Record<string, unknown>, ticket: string | null): ClipDto {
  const status = String(row.status ?? 'queued') as ClipStatus
  const id = low(row.id)
  const videoId = low(row.video_id)
  return {
    id,
    video_id: videoId,
    version_id: row.version_id ? low(row.version_id) : null,
    kind: (isClipKind(row.kind) ? row.kind : 'mp4') as ClipKind,
    status: (CLIP_STATUSES as readonly string[]).includes(status) ? status : 'failed',
    progress: row.progress == null ? null : Number(row.progress),
    error: row.error == null ? null : String(row.error),
    start_ms: Number(row.start_ms ?? 0),
    end_ms: Number(row.end_ms ?? 0),
    label: row.label == null || row.label === '' ? null : String(row.label),
    bytes: row.bytes == null ? null : Number(row.bytes),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    url: status === 'ready' && row.file_id && ticket ? clipUrl(videoId, id, ticket) : null,
    created_by: row.created_by ? low(row.created_by) : null,
    created_at: new Date(row.created_at as string).toISOString()
  }
}

/** A video's clips, newest first. None before migration 412. */
export async function listClips(videoId: string): Promise<Array<Record<string, unknown>>> {
  if (!(await clipsMigrated())) return []
  return (await db(CLIPS)
    .where({ video_id: videoId })
    .orderBy('created_at', 'desc')
    .limit(100)) as Array<Record<string, unknown>>
}

/** One clip row, only when it belongs to this video (and is an exact uuid). */
export async function clipRow(
  videoId: string,
  clipId: string
): Promise<Record<string, unknown> | null> {
  if (!isUuid(clipId)) return null
  if (!(await clipsMigrated())) return null
  return ((await db(CLIPS).where({ id: clipId, video_id: videoId }).first()) ?? null) as Record<
    string,
    unknown
  > | null
}

/** The label as stored: trimmed, one line, at most CLIP_LIMITS.labelMax; null when blank. */
export function cleanClipLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.replace(/\s+/g, ' ').trim().slice(0, CLIP_LIMITS.labelMax)
  return t || null
}

/** The clip window, checked against the version's edited length. Throws the
 *  422 the route answers with. */
export function checkClipRange(
  start: unknown,
  end: unknown,
  totalMs: number
): { start_ms: number; end_ms: number } {
  const a = Math.round(Number(start))
  const b = Math.round(Number(end))
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a) {
    throw fail(422, 'HELP_VIDEO_CLIP_RANGE', 'Give the clip a start and an end, start first')
  }
  if (b > totalMs) {
    throw fail(422, 'HELP_VIDEO_CLIP_RANGE', 'The clip ends after the video does')
  }
  if (b - a < CLIP_LIMITS.minMs) {
    throw fail(422, 'HELP_VIDEO_CLIP_RANGE', 'A clip is at least half a second long')
  }
  if (b - a > CLIP_LIMITS.maxMs) {
    throw fail(
      422,
      'HELP_VIDEO_CLIP_RANGE',
      `A clip is at most ${CLIP_LIMITS.maxMs / 1000} seconds long`
    )
  }
  return { start_ms: a, end_ms: b }
}

export interface CreateClipBody {
  kind?: unknown
  start_ms?: unknown
  end_ms?: unknown
  label?: unknown
  /** Cut the draft (authors in the editor) instead of the published version. */
  draft?: unknown
}

/** Queues a clip of this video. Authors only (the route checks). */
export async function createClip(
  video: { id: string; published_version_id: string | null; draft_version_id: string | null },
  user: User,
  body: CreateClipBody
): Promise<Record<string, unknown>> {
  if (!(await clipsMigrated())) {
    throw fail(
      409,
      'HELP_VIDEO_CLIPS_MIGRATION_PENDING',
      'Clips need a database migration this server has not run yet'
    )
  }
  if (!(await hasFfmpeg())) {
    throw fail(
      503,
      'HELP_VIDEO_CLIP_NO_FFMPEG',
      'This server cannot cut videos (ffmpeg is not installed)'
    )
  }
  if (!isClipKind(body.kind)) {
    throw fail(400, 'HELP_VIDEO_CLIP_INVALID', 'kind must be mp4 or gif')
  }
  const wantDraft = body.draft === true || body.draft === 1 || body.draft === '1'
  const versionId = wantDraft
    ? video.draft_version_id
    : (video.published_version_id ?? video.draft_version_id)
  const version = versionId ? await db(VERSIONS).where({ id: versionId }).first() : null
  if (!version) throw fail(409, 'HELP_VIDEO_NO_VERSION', 'This video has no recording yet')
  const edits = readEdits(version)
  const range = checkClipRange(body.start_ms, body.end_ms, editedDuration(edits))
  const count = Number(
    (
      (await db(CLIPS)
        .where({ video_id: video.id })
        .whereNot({ status: 'failed' })
        .count({ n: '*' })
        .first()) as { n?: unknown } | undefined
    )?.n ?? 0
  )
  if (count >= CLIP_LIMITS.maxPerVideo) {
    throw fail(
      409,
      'HELP_VIDEO_CLIP_LIMIT',
      `A video can have at most ${CLIP_LIMITS.maxPerVideo} clips. Delete one to make another.`
    )
  }
  const id = randomUUID()
  const now = new Date()
  await db(CLIPS).insert({
    id,
    video_id: video.id,
    version_id: version.id,
    file_id: null,
    kind: body.kind,
    status: 'queued',
    progress: 0,
    error: null,
    start_ms: range.start_ms,
    end_ms: range.end_ms,
    label: cleanClipLabel(body.label),
    bytes: null,
    width: null,
    height: null,
    created_by: user.id,
    created_at: now,
    updated_at: now
  })
  enqueueClip(id)
  return (await db(CLIPS).where({ id }).first()) as Record<string, unknown>
}

/** Deletes a clip (row and file). A clip rendering here is stopped. */
export async function deleteClip(user: User, videoId: string, clipId: string): Promise<void> {
  const row = await clipRow(videoId, clipId)
  if (!row) throw fail(404, 'HELP_VIDEO_CLIP_NOT_FOUND', 'Clip not found')
  active.get(low(row.id))?.abort()
  await db(CLIPS).where({ id: row.id }).delete()
  if (row.file_id) await discardFile(user, String(row.file_id))
}

/** Deletes every clip row of a video and hands back their file ids (purge). */
export async function takeVideoClipFiles(videoId: string): Promise<string[]> {
  if (!(await clipsMigrated())) return []
  const rows = (await db(CLIPS).where({ video_id: videoId }).select('id', 'file_id')) as Array<{
    id: unknown
    file_id: unknown
  }>
  if (!rows.length) return []
  for (const r of rows) active.get(low(r.id))?.abort()
  await db(CLIPS)
    .whereIn(
      'id',
      rows.map((r) => r.id as string)
    )
    .delete()
  return rows.flatMap((r) => (r.file_id ? [String(r.file_id)] : []))
}

function readEdits(version: Record<string, unknown>): VideoEdits {
  const sourceMs = Number(version.source_duration_ms ?? 30 * 60_000)
  let raw: unknown = {}
  try {
    raw = typeof version.edits === 'string' ? JSON.parse(version.edits) : version.edits
  } catch {
    raw = {}
  }
  return normalizeEdits(raw, sourceMs)
}

// ── The queue ───────────────────────────────────────────────────────────────
// Clips of this process, one after another; each inside the heavy slot when
// the app offers one. Nothing is shared between processes: a clip is made by
// the process that took the request (every process can read storage).

let chain: Promise<void> = Promise.resolve()
const active = new Map<string, AbortController>()

export function enqueueClip(id: string): void {
  const run = async () => {
    const work = () => renderClip(id).catch((err) => warn(`clip ${id} failed: ${String(err)}`))
    const app = getApp()
    if (app?.cron?.withHeavySlot) await app.cron.withHeavySlot('help-video clip', work)
    else await work()
  }
  chain = chain.then(run, run)
}

/** Resolves once every queued clip of this process is done (tests). */
export function whenClipsIdle(): Promise<void> {
  return chain
}

function warn(msg: string): void {
  console.warn(`[help-videos] ${msg}`)
}

export function friendlyClipError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/No such file|ENOENT|Stored object not found/i.test(msg)) {
    return 'The recording is missing from storage'
  }
  if (/cancelled|aborted|AbortError/i.test(msg)) return 'The clip was cancelled'
  return `The clip could not be made: ${msg.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? 'unknown error'}`
}

/** Cuts one queued clip. Exported for tests. */
export async function renderClip(id: string): Promise<'ready' | 'failed' | 'skipped'> {
  const claimed = Number(
    await db(CLIPS)
      .where({ id, status: 'queued' })
      .update({ status: 'rendering', progress: 0, updated_at: new Date() })
  )
  if (!claimed) return 'skipped'
  const row = (await db(CLIPS).where({ id }).first()) as Record<string, unknown> | undefined
  if (!row) return 'skipped'
  const key = low(id)
  const abort = new AbortController()
  active.set(key, abort)
  const timeout = setTimeout(() => abort.abort(), CLIP_TIMEOUT_MS)
  timeout.unref?.()
  const run = await startJobRun('render', `help-video-clip:${key}`, {
    label: 'Make a help video clip'
  })
  const dir = join(videoWorkDir(), 'clips', `${key}-${randomUUID().slice(0, 8)}`)
  const owner = { id: String(row.created_by ?? '') } as User
  const kind = (isClipKind(row.kind) ? row.kind : 'mp4') as ClipKind
  let lastWrite = 0
  const progress = (from: number, share: number, total: number) => (ms: number) => {
    const pct = Math.min(
      99,
      Math.round((from + share * Math.min(1, ms / Math.max(1, total))) * 100)
    )
    run.progress({ percent: pct, kind })
    if (Date.now() - lastWrite > 1500) {
      lastWrite = Date.now()
      void db(CLIPS)
        .where({ id, status: 'rendering' })
        .update({ progress: pct, updated_at: new Date() })
        .then((n) => {
          if (!Number(n)) abort.abort() // deleted meanwhile
        })
        .catch(() => null)
    }
  }
  try {
    const version = (await db(VERSIONS).where({ id: row.version_id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!version) throw new Error('The version this clip was cut from is gone')
    const edits = readEdits(version)
    const startMs = Number(row.start_ms)
    const endMs = Number(row.end_ms)
    const renderCurrent =
      !!version.rendered_file && String(version.rendered_hash) === String(version.edits_hash)
    const fileId = String(renderCurrent ? version.rendered_file : version.source_file)
    const stored = await getFile(fileId)
    if (!stored?.filename_disk) throw new Error('Stored object not found')
    const inputMime = renderCurrent ? 'video/mp4' : String(stored.type)
    if (!lockedInputArgs(inputMime).includes('-f')) {
      throw new Error(`Unsupported recording format: ${inputMime}`)
    }
    const cut: ClipCut = renderCurrent
      ? { from: 'rendered', start_ms: startMs, end_ms: endMs }
      : { from: 'source', spans: clipSpans(edits, startMs, endMs), edits }
    if (cut.from === 'source' && !cut.spans.length) {
      throw new Error('That part of the video is only a card: pick a part of the recording')
    }
    await mkdir(dir, { recursive: true })
    const ext = inputMime.includes('mp4') ? '.mp4' : '.webm'
    const inputPath = join(dir, `input${ext}`)
    const opened = await openStoredObject(String(stored.filename_disk))
    await pipeline(opened.stream, createWriteStream(inputPath))
    if (abort.signal.aborted) throw new Error('The clip was cancelled')
    const probe = await probeVideo(inputPath, inputMime)
    const width = probe.width ?? Number(version.width ?? 1280)
    const height = probe.height ?? Number(version.height ?? 720)
    const total = clipDurationMs(cut)
    const outputPath = join(dir, kind === 'gif' ? 'clip.gif' : 'clip.mp4')
    const plan = {
      kind,
      inputPath,
      inputMime,
      width,
      height,
      hasAudio: probe.has_audio,
      threads: renderThreads(),
      outputPath,
      cut,
      palettePath: join(dir, 'palette.png')
    }
    if (kind === 'gif') {
      await runFfmpeg(buildClipArgs(plan, 'palette'), undefined, abort.signal, {
        lowPriority: true
      })
      progress(0, 0.5, 1)(1)
      await runFfmpeg(buildClipArgs(plan, 'encode'), progress(0.5, 0.5, total), abort.signal, {
        lowPriority: true
      })
    } else {
      await runFfmpeg(buildClipArgs(plan), progress(0, 1, total), abort.signal, {
        lowPriority: true
      })
    }
    const bytes = (await stat(outputPath)).size
    if (!bytes) throw new Error('ffmpeg wrote nothing')
    const size = clipOutputSize(kind, { width, height }, cut)
    const file = await uploadFileFromPath(
      owner,
      outputPath,
      `help-video-clip-${key}.${kind}`,
      kind === 'gif' ? 'image/gif' : 'video/mp4'
    )
    let updated = 0
    try {
      updated = Number(
        await db(CLIPS).where({ id, status: 'rendering' }).update({
          status: 'ready',
          progress: 100,
          error: null,
          file_id: file.id,
          bytes,
          width: size.width,
          height: size.height,
          updated_at: new Date()
        })
      )
    } catch (err) {
      await discardFile(owner, String(file.id))
      throw err
    }
    if (!updated) {
      // Deleted while it was being made: nothing names the file.
      await discardFile(owner, String(file.id))
      await run.complete('discarded: the clip was deleted while it was being made')
      return 'skipped'
    }
    await run.complete(`${kind} · ${Math.round(total / 1000)} s · ${Math.round(bytes / 1024)} KB`)
    return 'ready'
  } catch (err) {
    const message = friendlyClipError(err)
    await db(CLIPS)
      .where({ id, status: 'rendering' })
      .update({ status: 'failed', progress: null, error: message, updated_at: new Date() })
      .catch(() => null)
    await run.fail(err)
    return 'failed'
  } finally {
    clearTimeout(timeout)
    active.delete(key)
    await rm(dir, { recursive: true, force: true }).catch(() => null)
  }
}

/** Marks clips whose process died mid-cut as failed (the render sweep calls
 *  this). A queued clip of a dead process is re-queued by nobody: it is
 *  failed too once old enough, so the author can try again. */
export async function failStaleClips(now = Date.now()): Promise<number> {
  if (!(await clipsMigrated())) return 0
  const cutoff = new Date(now - STALE_RENDERING_MS)
  const rows = (await db(CLIPS)
    .whereIn('status', ['queued', 'rendering'])
    .where('updated_at', '<', cutoff)
    .select('id')) as Array<{ id: unknown }>
  let n = 0
  for (const r of rows) {
    if (active.has(low(r.id))) continue
    n += Number(
      await db(CLIPS).where({ id: r.id }).whereIn('status', ['queued', 'rendering']).update({
        status: 'failed',
        progress: null,
        error: 'The server stopped while making this clip. Make it again.',
        updated_at: new Date()
      })
    )
  }
  return n
}
