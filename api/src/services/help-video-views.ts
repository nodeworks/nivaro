import { db } from '../db/index.js'
import type { User } from '../types.js'
import { EditsError, normalizeEdits, type VideoEdits } from './help-video-edits.js'
import type { VideoRow } from './help-videos.js'

// Who watched what and how far: one row per (video, person) with a 20-character
// map of the 5% sections seen. Completed = 18 of 20 sections. Required viewing
// = a role listed in nivaro_help_video_requirements, not completed since the
// video's required_since.

const EMPTY = '0'.repeat(20)

export function sanitizeBuckets(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : ''
  let out = ''
  for (let i = 0; i < 20; i++) out += s[i] === '1' ? '1' : '0'
  return out
}
export function mergeBuckets(a: string, b: string): string {
  const x = sanitizeBuckets(a)
  const y = sanitizeBuckets(b)
  let out = ''
  for (let i = 0; i < 20; i++) out += x[i] === '1' || y[i] === '1' ? '1' : '0'
  return out
}
export function countBuckets(b: string): number {
  return [...sanitizeBuckets(b)].filter((c) => c === '1').length
}
export function isComplete(b: string): boolean {
  return countBuckets(b) >= 18
}
export function dropOff(rows: string[]): number[] {
  const out = new Array(20).fill(0)
  if (!rows.length) return out
  for (const r of rows) {
    const b = sanitizeBuckets(r)
    for (let i = 0; i < 20; i++) if (b[i] === '1') out[i] += 1
  }
  return out.map((n) => Math.round((n / rows.length) * 1000) / 1000)
}

/** May a NON-author be handed the original recording? Only when the edits
 *  hide nothing: in live mode blurs are only CSS and cuts/trims are only
 *  player skips, so a download of the source would show what was blurred or
 *  cut away. Unreadable edits or an unknown source length count as "hides
 *  something", and so do callout and box annotations — the viewer then
 *  needs a current render. */
export function viewerMayPlaySource(rawEdits: unknown, sourceMs: unknown): boolean {
  const src = Math.round(Number(sourceMs))
  if (!Number.isFinite(src) || src <= 0) return false
  let parsed: unknown = rawEdits
  if (typeof rawEdits === 'string') {
    try {
      parsed = JSON.parse(rawEdits)
    } catch {
      return false
    }
  }
  if (parsed == null) return true // nothing stored = the whole recording, untouched
  let e: VideoEdits
  try {
    e = normalizeEdits(parsed, src)
  } catch (err) {
    if (err instanceof EditsError) return false
    throw err
  }
  if (e.blurs.length) return false
  // Intro / outro cards and chapter banners exist only in the render (or the
  // live player): the original recording alone would leave them out.
  if (e.intro || e.outro || e.chapter_banners) return false
  // A callout is an opaque filled panel: it hides what is under it, like a
  // blur. A box is an outline, but its label is drawn inside it and can cover
  // a small field, so it counts too (the conservative choice). Arrows,
  // ripples (translucent) and zooms only draw attention.
  if (e.annotations.some((a) => a.type === 'callout' || a.type === 'box')) return false
  const segs = e.segments
  if (!segs.length) return false
  if (segs[0].start_ms > 0 || segs[segs.length - 1].end_ms < src) return false // trimmed
  for (let i = 1; i < segs.length; i++) if (segs[i].start_ms > segs[i - 1].end_ms) return false // cut
  return true
}

export type StreamVersion = {
  source_file: unknown
  rendered_file: unknown
  rendered_hash: unknown
  edits_hash: unknown
  edits?: unknown
  source_duration_ms?: unknown
}

/** Which file a request gets. Authors: the source when asked (forceSource)
 *  or when the render is stale, else the render. Non-authors: the current
 *  render; else the source only when viewerMayPlaySource; else null (the
 *  route answers 409 "still being prepared"). forceSource is ignored for
 *  non-authors. */
export function pickStreamFile(
  version: StreamVersion,
  opts: { forceSource: boolean; author: boolean }
): { fileId: string; kind: 'rendered' | 'source' } | null {
  const renderCurrent = !!version.rendered_file && version.rendered_hash === version.edits_hash
  if (opts.author) {
    if (!opts.forceSource && renderCurrent) {
      return { fileId: String(version.rendered_file), kind: 'rendered' }
    }
    return { fileId: String(version.source_file), kind: 'source' }
  }
  if (renderCurrent) return { fileId: String(version.rendered_file), kind: 'rendered' }
  if (viewerMayPlaySource(version.edits ?? null, version.source_duration_ms)) {
    return { fileId: String(version.source_file), kind: 'source' }
  }
  return null
}

/** True when a non-author would get a file rather than the 409. */
export function viewerCanPlay(version: StreamVersion): boolean {
  return pickStreamFile(version, { forceSource: false, author: false }) !== null
}

const MAX_POSITION_MS = 2 ** 31 - 1
const FALLBACK_DURATION_MS = 31 * 60_000
const MAX_SPEED = 4 // the fastest speed-up the editor offers

/** MSSQL 2627 / 2601 (duplicate key), also when knex wraps it in an
 *  AggregateError whose own `.number` is unset. */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const isCode = (n: unknown) => n === 2627 || n === 2601
  const top = err as { number?: unknown; errors?: unknown }
  if (isCode(top.number)) return true
  return (
    Array.isArray(top.errors) && top.errors.some((e) => isCode((e as { number?: unknown })?.number))
  )
}

/** Keep every section already in `base` and at most `limit` of the sections
 *  that are new in `incoming`, lowest index first. */
export function limitNewBuckets(base: string, incoming: string, limit: number): string {
  const b = sanitizeBuckets(base)
  const inc = sanitizeBuckets(incoming)
  let left = Math.max(0, Math.floor(limit))
  let out = ''
  for (let i = 0; i < 20; i++) {
    if (b[i] === '1') out += '1'
    else if (inc[i] === '1' && left > 0) {
      out += '1'
      left--
    } else out += '0'
  }
  return out
}

export type ProgressInput = {
  position_ms?: number
  watched_ms_delta?: number
  buckets?: unknown
  version_id?: string
}

/** Record one progress beat. Progress is reported by the browser, so it is
 *  bounded CUMULATIVELY by the wall-clock time since the row's watch period
 *  began (first_viewed): total sections ≤ 1 + floor(elapsed × 4 / section
 *  length), total watched time ≤ elapsed × 4 + 5 s (4 = the fastest speed-up
 *  the editor offers). A first beat therefore gets one section and 5 s. When
 *  the video was (re)required after the person's last beat — or after their
 *  completion — the section map, watched time and period restart now. */
export async function recordProgress(
  user: User,
  video: VideoRow,
  input: ProgressInput,
  nowMs: number = Date.now()
): Promise<{ completed: boolean }> {
  const now = new Date(nowMs)
  const duration = Number(video.duration_ms) > 0 ? Number(video.duration_ms) : FALLBACK_DURATION_MS
  const position = Math.min(
    Math.max(0, Math.round(Number(input.position_ms) || 0)),
    Math.min(duration, MAX_POSITION_MS)
  )
  const askedDelta = Math.min(Math.max(0, Math.round(Number(input.watched_ms_delta) || 0)), 60_000)
  const incoming = sanitizeBuckets(input.buckets)
  // Only a version of THIS video is kept; anything else is stored as null.
  const asked = typeof input.version_id === 'string' ? input.version_id.toUpperCase() : ''
  const versionId =
    asked &&
    [video.published_version_id, video.draft_version_id].some(
      (v) => v != null && String(v).toUpperCase() === asked
    )
      ? (input.version_id as string)
      : null
  const where = { video_id: video.id, user: user.id }

  let row = await db('nivaro_help_video_views').where(where).first()
  if (!row) {
    const buckets = limitNewBuckets(EMPTY, incoming, 1)
    const done = isComplete(buckets)
    try {
      await db('nivaro_help_video_views').insert({
        ...where,
        version_id: versionId,
        first_viewed: now,
        last_viewed: now,
        watched_ms: Math.min(askedDelta, 5000),
        position_ms: position,
        buckets,
        completed_at: done ? now : null
      })
      return { completed: done }
    } catch (err) {
      // A parallel first beat inserted the row: take the update path so this
      // beat is not lost. Anything else is a real failure.
      if (!isUniqueViolation(err)) throw err
      row = await db('nivaro_help_video_views').where(where).first()
      if (!row) throw err
    }
  }

  const requiredSince = video.required_since
    ? new Date(video.required_since as string).getTime()
    : null
  const bucketMs = duration / 20

  // One read-modify-write, guarded by the last_viewed that was read: a
  // parallel beat that landed first makes this update touch 0 rows.
  async function apply(r: Record<string, unknown>): Promise<{ landed: boolean; done: boolean }> {
    const lastBeat = r.last_viewed ? new Date(r.last_viewed as string).getTime() : nowMs
    const completedAt = r.completed_at ? new Date(r.completed_at as string).getTime() : null
    // Re-armed: the video was (re)required after the person's last beat, or a
    // completion predates the requirement (a beat that raced the re-arm).
    const rearmed =
      requiredSince !== null &&
      (lastBeat < requiredSince || (completedAt !== null && completedAt < requiredSince))
    // The bound is cumulative from the start of the current watch period; a
    // re-arm starts a new period now (like a first beat).
    const start = rearmed
      ? nowMs
      : r.first_viewed
        ? new Date(r.first_viewed as string).getTime()
        : nowMs
    const elapsed = Math.max(0, nowMs - start)
    const base = rearmed ? EMPTY : sanitizeBuckets(String(r.buckets ?? EMPTY))
    const allowedTotal = 1 + Math.floor((elapsed * MAX_SPEED) / bucketMs)
    const buckets = limitNewBuckets(base, incoming, allowedTotal - countBuckets(base))
    const prevWatched = rearmed ? 0 : Number(r.watched_ms ?? 0)
    const watchedCap = elapsed * MAX_SPEED + 5000
    const watched = Math.max(prevWatched, Math.min(prevWatched + askedDelta, watchedCap))
    const done = isComplete(buckets)
    // A completion from before the re-arm no longer counts.
    const kept = rearmed ? null : (r.completed_at ?? null)
    const patch: Record<string, unknown> = {
      last_viewed: now,
      watched_ms: watched,
      position_ms: position,
      buckets,
      version_id: versionId ?? r.version_id ?? null,
      completed_at: kept ?? (done ? now : null)
    }
    if (rearmed) patch.first_viewed = now
    // Match the read last_viewed within ±5 ms, not exactly: the driver binds
    // JS dates as DATETIME (1/300 s) and the datetime2 column keeps that
    // rounding (.9266667), while the value read back is cut to .926 — an
    // exact compare would never match. Whatever slips through the window can
    // only under-count: the totals above are capped from first_viewed.
    const seen = r.last_viewed ? new Date(r.last_viewed as string).getTime() : null
    const q = db('nivaro_help_video_views').where({ id: r.id })
    if (seen === null) q.whereNull('last_viewed')
    else
      q.where('last_viewed', '>', new Date(seen - 5)).where('last_viewed', '<', new Date(seen + 5))
    const n = await q.update(patch)
    return { landed: Number(n) > 0, done }
  }

  let res = await apply(row)
  if (!res.landed) {
    // Re-read once and retry once; a beat that loses twice is dropped.
    const again = await db('nivaro_help_video_views').where(where).first()
    if (!again) return { completed: false }
    res = await apply(again)
    if (!res.landed) return { completed: !!again.completed_at }
  }
  return { completed: res.done }
}

export async function requiredForUser(user: User): Promise<string[]> {
  if (!user.role) return []
  const rows = await db('nivaro_help_video_requirements as r')
    .join('nivaro_help_videos as v', 'v.id', 'r.video_id')
    .leftJoin('nivaro_help_video_views as w', function () {
      this.on('w.video_id', '=', 'v.id').andOn('w.user', '=', db.raw('?', [user.id]))
    })
    .where('r.role_id', user.role)
    .where('v.status', 'published')
    .select('v.id', 'v.required_since', 'w.completed_at')
  return rows
    .filter(
      (r: { completed_at: unknown; required_since: unknown }) =>
        !r.completed_at ||
        (!!r.required_since &&
          new Date(r.completed_at as string) < new Date(r.required_since as string))
    )
    .map((r: { id: unknown }) => String(r.id).toUpperCase())
}

export async function videoAnalytics(video: VideoRow): Promise<{
  views: number
  unique_viewers: number
  completion_rate: number
  drop_off: number[]
  watched_hours: number
}> {
  const rows = await db('nivaro_help_video_views')
    .where({ video_id: video.id })
    .select('buckets', 'completed_at', 'watched_ms')
  const unique = rows.length
  const completed = rows.filter((r: { completed_at: unknown }) => r.completed_at).length
  const watched = rows.reduce(
    (t: number, r: { watched_ms: unknown }) => t + Number(r.watched_ms ?? 0),
    0
  )
  return {
    // One row per person in v1, so views = people who watched.
    views: unique,
    unique_viewers: unique,
    completion_rate: unique ? Math.round((completed / unique) * 1000) / 1000 : 0,
    drop_off: dropOff(rows.map((r: { buckets: unknown }) => String(r.buckets ?? ''))),
    watched_hours: Math.round((watched / 3_600_000) * 10) / 10
  }
}
