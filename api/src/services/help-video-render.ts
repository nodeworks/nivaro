import { createWriteStream } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { hasFfmpeg, lockedInputArgs, probeVideo, runFfmpeg } from './ffmpeg.js'
import { deleteFile, getFile, uploadFileFromPath } from './files.js'
import { rasterizeAnnotations } from './help-video-annotations.js'
import {
  captionsToVtt,
  editedDuration,
  normalizeEdits,
  sourceToEdited,
  type VideoEdits
} from './help-video-edits.js'
import { buildPosterArgs, buildRenderArgs, outputSize } from './help-video-render-plan.js'
import { videoWorkDir } from './help-video-uploads.js'
import { getApp } from './io-holder.js'
import { isCancelled } from './job-cancel.js'
import { startJobRun } from './job-runs.js'
import { openStoredObject } from './stored-object-stream.js'

// Bakes a published help video's edits into an MP4 + WebVTT + poster.
// Protecting the app while it runs (renders share the API server):
//   - ffmpeg is capped to VIDEO_RENDER_THREADS threads (default 2) and runs at
//     the lowest OS priority, so it only uses CPU requests leave idle;
//   - one render per process at a time, inside the cron heavy slot;
//   - VIDEO_RENDER=off or NIVARO_ROLE=web keeps a process from rendering —
//     queued renders wait for a process that may.
// Viewers never wait: until a render matches the edits, the player plays the
// original with the edits applied live.

const STUCK_MS = 2 * 3_600_000
let running = false

export function renderingAllowed(): boolean {
  if ((process.env.VIDEO_RENDER ?? '').toLowerCase() === 'off') return false
  if ((process.env.NIVARO_ROLE ?? '').trim().toLowerCase() === 'web') return false
  return true
}

export function renderThreads(): number {
  const n = Number(process.env.VIDEO_RENDER_THREADS)
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 2
}

export function friendlyRenderError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/No such file|ENOENT|Stored object not found/i.test(msg))
    return 'The original recording is missing from storage'
  if (/^Unsupported recording format/i.test(msg))
    return "This recording's format can't be processed. Try recording it again."
  return `The video could not be rendered: ${msg.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? 'unknown error'}`
}

export async function queueRender(versionId: string): Promise<void> {
  await db('nivaro_help_video_versions')
    .where({ id: versionId })
    .update({ render_status: 'queued', render_progress: 0, render_error: null })
  kickRenderer()
}

export function kickRenderer(): void {
  if (running || !renderingAllowed()) return
  running = true
  void drain()
    .catch((err: unknown) => {
      console.warn('[help-videos] render queue stopped:', err instanceof Error ? err.message : err)
    })
    .finally(() => {
      running = false
    })
}

async function hasQueued(): Promise<boolean> {
  const row = await db('nivaro_help_video_versions').where({ render_status: 'queued' }).first('id')
  return !!row
}

async function claimNext(): Promise<string | null> {
  const row = await db('nivaro_help_video_versions')
    .where({ render_status: 'queued' })
    .orderBy('created_at', 'asc')
    .first('id')
  if (!row) return null
  const claimed = await db('nivaro_help_video_versions')
    .where({ id: row.id, render_status: 'queued' })
    .update({ render_status: 'rendering', render_started_at: new Date(), render_progress: 0 })
  return claimed ? String(row.id) : null
}

async function drain(): Promise<void> {
  for (;;) {
    // Peek before taking the heavy slot, and claim only once holding it: a
    // render never sits in 'rendering' while it waits for the slot, so the
    // stuck-render sweep cannot hand it to a second process meanwhile.
    if (!(await hasQueued().catch(() => false))) return
    let claimed: string | null = null
    const work = async () => {
      claimed = await claimNext().catch(() => null)
      if (claimed) await renderOne(claimed)
    }
    const app = getApp()
    if (app?.cron?.withHeavySlot) await app.cron.withHeavySlot('help-video render', work)
    else await work()
    if (!claimed) return
  }
}

export async function renderOne(
  versionId: string
): Promise<'ready' | 'failed' | 'unavailable' | 'skipped'> {
  const v = await db('nivaro_help_video_versions').where({ id: versionId }).first()
  if (!v) return 'skipped'
  if (!(await hasFfmpeg())) {
    await db('nivaro_help_video_versions')
      .where({ id: versionId })
      .update({ render_status: 'unavailable', render_progress: null })
    return 'unavailable'
  }
  const run = await startJobRun('render', `help-video:${String(versionId).toLowerCase()}`, {
    label: 'Render help video'
  })
  const dir = join(videoWorkDir(), 'render', String(versionId).toLowerCase())
  const abort = new AbortController()
  try {
    await mkdir(dir, { recursive: true })
    const edits: VideoEdits = normalizeEdits(
      JSON.parse(String(v.edits)),
      Number(v.source_duration_ms ?? 30 * 60_000)
    )
    // The hash of the edits this render bakes in; viewers get the render only
    // while it still equals the version's edits_hash.
    const renderedHash = String(v.edits_hash)
    const source = await getFile(String(v.source_file))
    if (!source?.filename_disk) throw new Error('Stored object not found')
    const sourceMime = String(source.type)
    // Never let ffprobe/ffmpeg guess the format of a recording: refuse a mime
    // with no pinned demuxer before either one opens the file.
    if (!lockedInputArgs(sourceMime).includes('-f'))
      throw new Error(`Unsupported recording format: ${sourceMime}`)
    const ext = sourceMime.includes('mp4') ? '.mp4' : '.webm'
    const sourcePath = join(dir, `source${ext}`)
    const opened = await openStoredObject(String(source.filename_disk))
    await pipeline(opened.stream, createWriteStream(sourcePath))
    const probe = await probeVideo(sourcePath, sourceMime)
    const width = probe.width ?? Number(v.width ?? 1280)
    const height = probe.height ?? Number(v.height ?? 720)
    const size = outputSize(width, height)
    const overlays = await rasterizeAnnotations(edits.annotations, size, dir)
    const total = Math.max(1, editedDuration(edits))
    let lastWrite = 0
    const out = join(dir, 'video.mp4')
    await runFfmpeg(
      buildRenderArgs({
        edits,
        width,
        height,
        hasAudio: probe.has_audio,
        sourcePath,
        sourceMime,
        overlays,
        outputPath: out,
        threads: renderThreads()
      }),
      (ms) => {
        if (run.id !== null && isCancelled(run.id)) abort.abort()
        const pct = Math.min(99, Math.round((ms / total) * 100))
        run.progress({ percent: pct })
        if (Date.now() - lastWrite > 2000) {
          lastWrite = Date.now()
          void db('nivaro_help_video_versions')
            .where({ id: versionId })
            .update({ render_progress: pct })
            .catch(() => null)
        }
      },
      abort.signal,
      { lowPriority: true }
    )
    const vttPath = join(dir, 'captions.vtt')
    await writeFile(vttPath, captionsToVtt(edits))
    const posterPath = join(dir, 'poster.jpg')
    const posterEdited = sourceToEdited(edits, edits.poster_ms) ?? 0
    await runFfmpeg(
      buildPosterArgs(out, Math.max(0, Math.min(posterEdited, total - 100)), posterPath),
      undefined,
      abort.signal,
      { lowPriority: true }
    )

    const owner = { id: String(v.created_by) } as User
    const [mp4, vtt, poster] = await Promise.all([
      uploadFileFromPath(owner, out, `help-video-${versionId}.mp4`.toLowerCase(), 'video/mp4'),
      uploadFileFromPath(owner, vttPath, `help-video-${versionId}.vtt`.toLowerCase(), 'text/vtt'),
      uploadFileFromPath(
        owner,
        posterPath,
        `help-video-${versionId}.jpg`.toLowerCase(),
        'image/jpeg'
      )
    ])
    const old = [v.rendered_file, v.captions_file, v.poster_file].filter(Boolean).map(String)
    const updated = await db('nivaro_help_video_versions').where({ id: versionId }).update({
      render_status: 'ready',
      render_progress: 100,
      render_error: null,
      rendered_hash: renderedHash,
      rendered_file: mp4.id,
      captions_file: vtt.id,
      poster_file: poster.id,
      render_run_id: run.id
    })
    if (!Number(updated)) {
      // The video was purged while it rendered: nothing points at the new files.
      for (const f of [mp4.id, vtt.id, poster.id]) await deleteFile(String(f)).catch(() => null)
      await run.complete('video deleted while rendering')
      return 'skipped'
    }
    await db('nivaro_help_videos')
      .where({ published_version_id: versionId })
      .update({ poster_file: poster.id })
    for (const f of old) await deleteFile(f).catch(() => null)
    await run.complete(`rendered ${Math.round(total / 1000)} s`)
    return 'ready'
  } catch (err) {
    const reason = abort.signal.aborted ? 'The render was cancelled' : friendlyRenderError(err)
    await db('nivaro_help_video_versions')
      .where({ id: versionId })
      .update({ render_status: 'failed', render_error: reason, render_progress: null })
      .catch(() => null)
    await run.fail(err)
    return 'failed'
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Re-queue renders stuck in 'rendering' (a process died mid-render) and kick. */
export async function sweepRenders(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_MS)
  const n = await db('nivaro_help_video_versions')
    .where({ render_status: 'rendering' })
    .where('render_started_at', '<', cutoff)
    .update({ render_status: 'queued', render_progress: 0 })
  kickRenderer()
  return Number(n) || 0
}

/** Renders of versions that are neither published nor draft go after 30 days;
 *  the source and edits stay, so they can be rendered again. */
export async function pruneOldRenders(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000)
  const rows = await db('nivaro_help_video_versions as v')
    .join('nivaro_help_videos as h', 'h.id', 'v.video_id')
    .whereNotNull('v.rendered_file')
    .where('v.created_at', '<', cutoff)
    .whereRaw('(h.published_version_id IS NULL OR h.published_version_id <> v.id)')
    .whereRaw('(h.draft_version_id IS NULL OR h.draft_version_id <> v.id)')
    .select('v.id', 'v.rendered_file', 'v.captions_file', 'v.poster_file')
  for (const r of rows) {
    // Unlink first: the version's foreign keys would refuse the file deletes.
    await db('nivaro_help_video_versions').where({ id: r.id }).update({
      rendered_file: null,
      captions_file: null,
      poster_file: null,
      rendered_hash: null,
      render_status: 'none'
    })
    // A poster the video row still shows stays (its delete is refused).
    for (const f of [r.rendered_file, r.captions_file, r.poster_file])
      if (f) await deleteFile(String(f)).catch(() => null)
  }
  return rows.length
}
