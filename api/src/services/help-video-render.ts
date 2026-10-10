import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { cronTicksEnabled } from './cron-ticks.js'
import { hasFfmpeg, lockedInputArgs, probeVideo, runFfmpeg } from './ffmpeg.js'
import { deleteFile, getFile, type StoredFile, uploadFileFromPath } from './files.js'
import { rasterizeAnnotations } from './help-video-annotations.js'
import {
  type CapturedCards,
  captureCards,
  cardText,
  loadCardBrand,
  shownBrand
} from './help-video-cards.js'
import { buildCursorAss } from './help-video-cursor.js'
import {
  CALLOUT_TEXT_SCALE,
  calloutTextOf,
  captionsToVtt,
  editedDuration,
  normalizeEdits,
  posterEditedMs,
  stepNumbers,
  stepStyleOf,
  type VideoEdits
} from './help-video-edits.js'
import {
  markHardwareFailed,
  planVideoEncode,
  softwarePlan,
  type VideoEncodePlan
} from './help-video-encoder.js'
import { musicForRender } from './help-video-music.js'
import {
  buildPosterArgs,
  buildRenderPlan,
  type RenderInput,
  renderSizes
} from './help-video-render-plan.js'
import { ENCODER_DEFAULTS, renderEncoderSettings } from './help-video-settings.js'
import { discardFile, pointerOfFile, videoWorkDir } from './help-video-uploads.js'
import { getApp } from './io-holder.js'
import { isCancelled, requestCancel } from './job-cancel.js'
import { startJobRun } from './job-runs.js'
import { openStoredObject } from './stored-object-stream.js'

// Bakes a published help video's edits into an MP4 + WebVTT + poster.
// Protecting the app while it runs (renders share the API server):
//   - ffmpeg is capped to VIDEO_RENDER_THREADS threads (default 2) and runs at
//     the lowest OS priority, so it only uses CPU requests leave idle;
//   - one render per process at a time, inside the cron heavy slot;
//   - VIDEO_RENDER=off or NIVARO_ROLE=web keeps a process from rendering —
//     queued renders wait for a process that may.
// Who renders what: a process that ticks crons (or sets VIDEO_RENDER=on) owns
// the queue and drains it; any other process renders only the versions it
// published itself. A dev laptop shares its database with staging but not its
// disk, so it must never take staging's renders (it could not read their
// sources, and staging could not serve what it wrote).
// A claim is the row's render_started_at as stored: every later write from that
// render requires it, so a render whose row was re-queued or purged meanwhile
// changes nothing and discards its own files.
// Viewers never wait: until a render matches the edits, the player plays the
// original with the edits applied live.

const VERSIONS = 'nivaro_help_video_versions'
const STUCK_HARD_MS = 6 * 3_600_000
/** A claim with no job run after this long belongs to a process that died
 *  between claiming and starting its run. */
const NO_RUN_GRACE_MS = 10 * 60_000
const SCRATCH_MAX_AGE_MS = 24 * 3_600_000
let running = false
let again = false
let idle: Promise<void> = Promise.resolve()
let scratchCleaned = false
/** Versions this (non-owner) process published and still has to render. */
const pending = new Set<string>()
/** Renders running in this process, by version key: Cancel aborts them. */
const active = new Map<string, { abort: AbortController; runId: number | null }>()
/** How often a running render checks for a cancel (flag) and for its claim
 *  (a cancel from another process, or a purge, takes the row away). */
const CANCEL_POLL_MS = 1000
const CLAIM_POLL_MS = 5000

type Outcome = 'ready' | 'failed' | 'unavailable' | 'skipped'

export function renderingAllowed(): boolean {
  if ((process.env.VIDEO_RENDER ?? '').toLowerCase() === 'off') return false
  if ((process.env.NIVARO_ROLE ?? '').trim().toLowerCase() === 'web') return false
  return true
}

/** Whether this process drains the whole queue (boot kick, sweep, any kick). */
export function ownsRenderQueue(): boolean {
  if (!renderingAllowed()) return false
  return cronTicksEnabled() || (process.env.VIDEO_RENDER ?? '').trim().toLowerCase() === 'on'
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

function warn(msg: string, err?: unknown): void {
  getApp()?.log?.warn({ err }, `[help-videos] ${msg}`)
}

export async function queueRender(versionId: string): Promise<void> {
  await db(VERSIONS)
    .where({ id: versionId })
    .update({ render_status: 'queued', render_progress: 0, render_error: null })
  if (ownsRenderQueue()) kickRenderer()
  else if (renderingAllowed()) {
    pending.add(String(versionId).toLowerCase())
    startPump()
  }
}

/** Drain the queue — only on a process that owns it. */
export function kickRenderer(): void {
  if (ownsRenderQueue()) startPump()
}

/** Resolves once the renderer has nothing left to do (tests, shutdown). */
export function whenRendererIdle(): Promise<void> {
  return idle
}

function startPump(): void {
  if (running) {
    again = true // a kick during a render is picked up when it finishes
    return
  }
  running = true
  again = false
  if (!scratchCleaned) {
    scratchCleaned = true
    void cleanRenderScratch()
  }
  idle = pump()
    .catch((err: unknown) => warn('render queue stopped', err))
    .finally(() => {
      running = false
      if (again || pending.size) startPump()
    })
}

async function pump(): Promise<void> {
  // A process with no ffmpeg never takes a row. An owner says so on the rows
  // (the player keeps playing the original); anyone else leaves them queued.
  if (!(await hasFfmpeg())) {
    pending.clear()
    if (ownsRenderQueue()) {
      await db(VERSIONS)
        .where({ render_status: 'queued' })
        .update({ render_status: 'unavailable', render_progress: null })
    }
    return
  }
  for (;;) {
    again = false
    const target = pending.values().next().value as string | undefined
    if (target !== undefined) pending.delete(target)
    else if (!ownsRenderQueue() || !(await hasQueued())) return
    // Peek outside the heavy slot, claim inside it: a render never sits in
    // 'rendering' while it waits its turn. A lost claim race (another process
    // took the row) just moves on to the next one.
    let outcome = null as Outcome | null // set inside the slot callback
    const work = async () => {
      const id = target ?? (await nextQueuedId())
      if (id) outcome = await renderOne(id)
    }
    const app = getApp()
    if (app?.cron?.withHeavySlot) await app.cron.withHeavySlot('help-video render', work)
    else await work()
    // 'unavailable' leaves the row untouched; never spin on it.
    if (outcome === 'unavailable') return
  }
}

async function hasQueued(): Promise<boolean> {
  return !!(await db(VERSIONS).where({ render_status: 'queued' }).first('id'))
}

async function nextQueuedId(): Promise<string | null> {
  const row = await db(VERSIONS)
    .where({ render_status: 'queued' })
    .orderBy('created_at', 'asc')
    .first('id')
  return row ? String(row.id) : null
}

/** Claim a queued version; returns the claim token (render_started_at as
 *  stored) or null when the row is not queued any more. */
async function claimById(versionId: string): Promise<Date | null> {
  const n = await db(VERSIONS)
    .where({ id: versionId, render_status: 'queued' })
    .update({ render_status: 'rendering', render_started_at: new Date(), render_progress: 0 })
  if (!Number(n)) return null
  const row = await db(VERSIONS).where({ id: versionId }).first('render_started_at')
  return row?.render_started_at ? new Date(row.render_started_at as string) : null
}

/** The version row, only while it is still this render's claim. The stored
 *  time is matched within ±5 ms, not exactly: the driver binds JS dates as
 *  DATETIME (1/300 s), so the value read back never equals the stored one. */
function claimed(versionId: string, token: Date) {
  const t = token.getTime()
  return db(VERSIONS)
    .where({ id: versionId, render_status: 'rendering' })
    .where('render_started_at', '>', new Date(t - 5))
    .where('render_started_at', '<', new Date(t + 5))
}

/** Claim one queued version and render it. 'skipped' = not queued any more
 *  (another process took it, or it was purged). */
export async function renderOne(versionId: string): Promise<Outcome> {
  if (!(await hasFfmpeg())) return 'unavailable'
  const token = await claimById(versionId)
  if (!token) return 'skipped'
  return renderClaimed(versionId, token)
}

async function renderClaimed(versionId: string, token: Date): Promise<Outcome> {
  const v = await db(VERSIONS).where({ id: versionId }).first()
  if (!v) return 'skipped'
  const key = String(versionId).toLowerCase()
  const run = await startJobRun('render', `help-video:${key}`, { label: 'Render help video' })
  const dir = join(videoWorkDir(), 'render', `${key}-${randomUUID().slice(0, 8)}`)
  const abort = new AbortController()
  active.set(key, { abort, runId: run.id })
  // Cancel (#1532): this process's flag every second; the claim every few
  // seconds, so a cancel made on another process (it fails the row) or a
  // purge stops this render too, instead of encoding to the end.
  let lastClaimCheck = Date.now()
  const watch = setInterval(() => {
    if (abort.signal.aborted) return
    if (run.id !== null && isCancelled(run.id)) abort.abort()
    else if (Date.now() - lastClaimCheck >= CLAIM_POLL_MS) {
      lastClaimCheck = Date.now()
      void claimed(versionId, token)
        .first('id')
        .then((row) => {
          if (!row) abort.abort()
        })
        .catch(() => null)
    }
  }, CANCEL_POLL_MS)
  watch.unref?.()
  const stopIfCancelled = () => {
    if (abort.signal.aborted) throw new Error('The render was cancelled')
  }
  let encoderNote = ''
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
    // Blurs and annotations are drawn on the whole recorded frame (`work`);
    // the finished file, its cards and banners are the cropped size (`size`).
    const { work, out: size } = renderSizes(width, height, edits.crop)
    const overlays = await rasterizeAnnotations(edits.annotations, work, dir, {
      steps: stepNumbers(edits),
      stepStyle: stepStyleOf(edits),
      textScale: CALLOUT_TEXT_SCALE[calloutTextOf(edits)]
    })
    stopIfCancelled()
    // Intro / outro cards and chapter banners, in the instance brand. The
    // card text falls back to the video's title and description as they are
    // now, at render time.
    const wantsCards = !!(edits.intro || edits.outro || edits.chapter_banners)
    const text = cardText(
      edits,
      ((wantsCards
        ? await db('nivaro_help_videos').where({ id: v.video_id }).first('title', 'description')
        : null) ?? {}) as { title: unknown; description: unknown }
    )
    const hasCards = !!(text.intro || text.outro || text.banners.length)
    const captured: CapturedCards = hasCards
      ? await captureCards(
          text,
          shownBrand(await loadCardBrand(), edits),
          size,
          dir,
          edits,
          abort.signal
        )
      : { intro: null, outro: null, banners: [] }
    stopIfCancelled()
    // Banners are timed in edited time, over the finished picture.
    const banners = text.banners.map((b, i) => ({
      ...captured.banners[i],
      start_ms: b.start_ms,
      end_ms: b.end_ms
    }))
    // Background music (#1547): a library track or the video's own file.
    const music = edits.music ? await musicForRender(String(v.video_id), edits.music, dir) : null
    // The recorded cursor and shortcut badges (#1517): an ASS file burned in
    // over the picture. A recording without a pointer path draws nothing.
    let cursor: RenderInput['cursor'] = null
    if (edits.cursor?.show) {
      const pointer = await pointerOfFile(v.source_file)
      if (pointer) {
        const assPath = join(dir, 'cursor.ass')
        await writeFile(
          assPath,
          buildCursorAss({
            pointer,
            edits,
            out: size,
            durationMs: Number(v.source_duration_ms ?? probe.duration_ms ?? 0),
            shortcuts: !!edits.cursor.shortcuts
          })
        )
        cursor = { assPath }
      }
    }
    const total = Math.max(1, editedDuration(edits))
    let lastWrite = 0
    const out = join(dir, 'video.mp4')
    stopIfCancelled()
    const base: RenderInput = {
      edits,
      width,
      height,
      hasAudio: probe.has_audio,
      sourcePath,
      sourceMime,
      overlays,
      banners,
      // A card with a transition sits over the recording's edge frame.
      intro:
        captured.intro && edits.intro
          ? {
              ...captured.intro,
              duration_ms: edits.intro.duration_ms,
              over_frame: !!edits.intro.transition
            }
          : null,
      outro:
        captured.outro && edits.outro
          ? {
              ...captured.outro,
              duration_ms: edits.outro.duration_ms,
              over_frame: !!edits.outro.transition
            }
          : null,
      music,
      cursor,
      outputPath: out,
      threads: renderThreads(),
      // The filter graph goes by file: as one argument it can pass the
      // kernel's per-argument limit and ffmpeg never starts (E2BIG).
      graphFile: join(dir, 'filters.txt')
    }
    // The encoder (#1561): the settings' choice, hardware when allowed and
    // working here. A hardware encode that fails is retried once in software.
    const settings = await renderEncoderSettings().catch(() => ENCODER_DEFAULTS)
    let plan = await planVideoEncode(settings, size, total)
    // Progress over the whole encode: a two-pass encode reports its first
    // pass as 0-50 % and its second as 50-99 %.
    const progress = (from: number, share: number) => (ms: number) => {
      if (run.id !== null && isCancelled(run.id)) abort.abort()
      const pct = Math.min(99, Math.round((from + share * Math.min(1, ms / total)) * 100))
      run.progress({ percent: pct, encoder: plan.label })
      if (Date.now() - lastWrite > 2000) {
        lastWrite = Date.now()
        // Guarded by the claim, so a late write never lands after the
        // final update or on someone else's render. Nothing updated = the
        // claim is gone (cancelled elsewhere, purged): stop.
        void claimed(versionId, token)
          .update({ render_progress: pct })
          .then((n) => {
            if (!Number(n)) abort.abort()
          })
          .catch(() => null)
      }
    }
    // One ffmpeg pass: the graph is written to its file, then ffmpeg runs.
    const pass = async (input: RenderInput, onProgress: (ms: number) => void) => {
      const plan = buildRenderPlan(input)
      await writeFile(String(input.graphFile), plan.graph)
      await runFfmpeg(plan.args, onProgress, abort.signal, { lowPriority: true })
    }
    const encode = async (p: VideoEncodePlan) => {
      if (p.twoPass) {
        const logfile = join(dir, 'x264-pass')
        await pass({ ...base, video: p, pass: { n: 1, logfile } }, progress(0, 0.5))
        stopIfCancelled()
        await pass({ ...base, video: p, pass: { n: 2, logfile } }, progress(0.5, 0.5))
      } else {
        await pass({ ...base, video: p }, progress(0, 1))
      }
    }
    try {
      await encode(plan)
    } catch (err) {
      if (abort.signal.aborted || plan.kind === 'libx264') throw err
      warn(`hardware encoder ${plan.kind} failed rendering ${key}; retrying in software`, err)
      markHardwareFailed(plan.kind)
      const failedKind = plan.kind
      plan = softwarePlan(settings, size, total)
      encoderNote = ` (${failedKind} failed; encoded in software)`
      await rm(out, { force: true }).catch(() => null)
      await encode(plan)
    }
    encoderNote = ` · ${plan.label}${encoderNote}`
    const vttPath = join(dir, 'captions.vtt')
    await writeFile(vttPath, captionsToVtt(edits))
    const posterPath = join(dir, 'poster.jpg')
    // A chosen card, else the poster frame; one inside a cut falls back to
    // the recording's first frame (after any intro).
    const posterEdited = posterEditedMs(edits)
    await runFfmpeg(
      buildPosterArgs(out, Math.max(0, Math.min(posterEdited, total - 100)), posterPath),
      undefined,
      abort.signal,
      { lowPriority: true }
    )

    const owner = { id: String(v.created_by) } as User
    // Until the claim update names them, the new files are listable and
    // nothing references them: any failure from here to that update deletes
    // them again (one of the three uploads failing included).
    const uploads = await Promise.allSettled([
      uploadFileFromPath(owner, out, `help-video-${key}.mp4`, 'video/mp4'),
      uploadFileFromPath(owner, vttPath, `help-video-${key}.vtt`, 'text/vtt'),
      uploadFileFromPath(owner, posterPath, `help-video-${key}.jpg`, 'image/jpeg')
    ])
    const created = uploads.flatMap((u) => (u.status === 'fulfilled' ? [String(u.value.id)] : []))
    const discardCreated = async () => {
      for (const f of created) await discardFile(owner, f)
    }
    const failedUpload = uploads.find((u) => u.status === 'rejected')
    if (failedUpload) {
      await discardCreated()
      throw (failedUpload as PromiseRejectedResult).reason
    }
    const [mp4, vtt, poster] = uploads.map((u) => (u as PromiseFulfilledResult<StoredFile>).value)
    const old = [v.rendered_file, v.captions_file, v.poster_file].filter(Boolean).map(String)
    let updated: unknown
    try {
      updated = await claimed(versionId, token).update({
        render_status: 'ready',
        render_progress: 100,
        render_error: null,
        rendered_hash: renderedHash,
        rendered_file: mp4.id,
        captions_file: vtt.id,
        poster_file: poster.id,
        render_run_id: run.id
      })
    } catch (err) {
      await discardCreated()
      throw err
    }
    if (!Number(updated)) {
      // The row is not this render's any more (purged, or re-queued and
      // claimed again): nothing points at the new files.
      warn(`render of ${key} lost its claim; discarding its files`)
      await discardCreated()
      await run.complete('discarded: the version changed hands while rendering')
      return 'skipped'
    }
    await db('nivaro_help_videos')
      .where({ published_version_id: versionId })
      .update({ poster_file: poster.id })
    // An old file that will not delete is no longer referenced, so it would be
    // listable: discardFile parks it where the guard covers and the purge retries.
    for (const f of old) await discardFile(owner, f)
    await run.complete(`rendered ${Math.round(total / 1000)} s${encoderNote}`)
    return 'ready'
  } catch (err) {
    if (abort.signal.aborted) {
      // A cancel from the queue has already failed the row with its reason
      // (then this update changes nothing); one from Background Jobs has not.
      await claimed(versionId, token)
        .update({ render_status: 'failed', render_error: CANCELLED_REASON, render_progress: null })
        .catch(() => null)
      await run.complete('cancelled: the version plays with its edits applied live')
      if (run.id !== null) {
        await db('nivaro_job_runs')
          .where('id', run.id)
          .update({ status: 'cancelled' })
          .catch(() => null)
      }
      return 'failed'
    }
    await claimed(versionId, token)
      .update({
        render_status: 'failed',
        render_error: friendlyRenderError(err),
        render_progress: null
      })
      .catch(() => null)
    await run.fail(err)
    return 'failed'
  } finally {
    clearInterval(watch)
    active.delete(key)
    await rm(dir, { recursive: true, force: true }).catch(() => null)
  }
}

/** What a cancelled version says (the editor's render status). Starts with
 *  "Cancelled": the editor reads that prefix as a cancel, not a failure. */
export const CANCELLED_REASON =
  'Cancelled. It plays with its edits applied live until it is rendered again.'

/** Cancel a queued or running render (#1532). The row goes to 'failed' with a
 *  cancel reason: viewers keep live playback, and nothing re-queues it (the
 *  sweep only re-queues rows still 'rendering'). An author queues it again
 *  with Render again in the editor (POST /help-videos/:id/render). A render
 *  running in this process is aborted at once (ffmpeg and the card page are
 *  killed; the heavy slot is released as the render returns); one running on
 *  another process stops at its next claim check (within about 5 s). */
export async function cancelRender(
  versionId: string,
  byName: string | null
): Promise<{ cancelled: boolean; was: string | null }> {
  const key = String(versionId).toLowerCase()
  const row = (await db(VERSIONS).where({ id: versionId }).first('render_status')) as
    | { render_status?: string }
    | undefined
  const was = row?.render_status ? String(row.render_status) : null
  const who = byName?.trim().slice(0, 120)
  const reason = who
    ? `Cancelled by ${who}. It plays with its edits applied live until it is rendered again.`
    : CANCELLED_REASON
  const n = await db(VERSIONS)
    .where({ id: versionId })
    .whereIn('render_status', ['queued', 'rendering'])
    .update({ render_status: 'failed', render_error: reason, render_progress: null })
  pending.delete(key)
  const local = active.get(key)
  if (local) {
    if (local.runId !== null) requestCancel(local.runId)
    local.abort.abort()
  }
  return { cancelled: Number(n) > 0, was }
}

/** The version keys rendering in this process right now. */
export function activeRenderKeys(): string[] {
  return [...active.keys()]
}

/** Re-queue renders whose process died mid-render, then kick (owners only).
 *  A render is dead when its newest job run since the claim is not running
 *  (boot and shutdown mark a dead process's runs 'interrupted'), when no run
 *  ever started, or — the hard cap — when it has been rendering for 6 hours. */
export async function sweepRenders(): Promise<number> {
  const rows = (await db(VERSIONS)
    .where({ render_status: 'rendering' })
    .select('id', 'render_started_at')) as Array<{ id: string; render_started_at: unknown }>
  let n = 0
  for (const r of rows) {
    if (!r.render_started_at) continue
    const started = new Date(r.render_started_at as string)
    const age = Date.now() - started.getTime()
    let dead = age > STUCK_HARD_MS
    if (!dead) {
      const runRow = await db('nivaro_job_runs')
        .where({ kind: 'render', job_id: `help-video:${String(r.id).toLowerCase()}` })
        .where('started_at', '>=', new Date(started.getTime() - 1000))
        .orderBy('id', 'desc')
        .first('status')
      dead = runRow ? runRow.status !== 'running' : age > NO_RUN_GRACE_MS
    }
    if (!dead) continue
    n += Number(
      await claimed(String(r.id), started).update({ render_status: 'queued', render_progress: 0 })
    )
  }
  kickRenderer()
  return n
}

/** A scratch directory name: `<id>-<8 hex>` (the id of the version, clip or
 *  upload the work was for), or the earlier `<id>` layout. */
const SCRATCH_NAME_RE = /^[0-9a-f-]{36}(-[0-9a-f]{8})?$/i
/** The work directory's scratch areas: renders, clips (#1562), caption jobs
 *  (#1520) and upload extras (sprite sheets, peaks). */
export const SCRATCH_DIRS = ['render', 'clips', 'captions', 'extras'] as const

/** Remove scratch directories older than 24 h (a crash leaves source copies
 *  of up to 1.2 GB behind) under every scratch area. Never touches a younger
 *  one, a name that is not a scratch name, or anything reached through a
 *  symlink. */
export async function cleanRenderScratch(maxAgeMs = SCRATCH_MAX_AGE_MS): Promise<number> {
  let removed = 0
  for (const area of SCRATCH_DIRS) {
    const base = join(videoWorkDir(), area)
    const baseStat = await lstat(base).catch(() => null)
    if (!baseStat?.isDirectory()) continue // missing, a symlink, or not a directory
    const names = await readdir(base).catch(() => [] as string[])
    for (const name of names) {
      if (!SCRATCH_NAME_RE.test(name)) continue
      const path = join(base, name)
      const st = await lstat(path).catch(() => null)
      if (!st?.isDirectory() || Date.now() - st.mtimeMs < maxAgeMs) continue
      await rm(path, { recursive: true, force: true })
        .then(() => removed++)
        .catch(() => null)
    }
  }
  return removed
}

/** Renders of versions that are neither published nor draft go after 30 days;
 *  the source and edits stay, so they can be rendered again. */
export async function pruneOldRenders(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000)
  const rows = await db(`${VERSIONS} as v`)
    .join('nivaro_help_videos as h', 'h.id', 'v.video_id')
    .whereNotNull('v.rendered_file')
    .where('v.created_at', '<', cutoff)
    .whereRaw('(h.published_version_id IS NULL OR h.published_version_id <> v.id)')
    .whereRaw('(h.draft_version_id IS NULL OR h.draft_version_id <> v.id)')
    .select('v.id', 'v.rendered_file', 'v.captions_file', 'v.poster_file')
  for (const r of rows) {
    // Unlink first: the version's foreign keys would refuse the file deletes.
    await db(VERSIONS).where({ id: r.id }).update({
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
