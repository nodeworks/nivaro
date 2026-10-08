import { db } from '../db/index.js'
import type { User } from '../types.js'
import { isUuid, type VideoRow } from './help-videos.js'

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

export function pickStreamFile(
  version: {
    source_file: unknown
    rendered_file: unknown
    rendered_hash: unknown
    edits_hash: unknown
  },
  opts: { forceSource: boolean }
): { fileId: string; kind: 'rendered' | 'source' } {
  if (!opts.forceSource && version.rendered_file && version.rendered_hash === version.edits_hash) {
    return { fileId: String(version.rendered_file), kind: 'rendered' }
  }
  return { fileId: String(version.source_file), kind: 'source' }
}

export async function recordProgress(
  user: User,
  video: VideoRow,
  input: {
    position_ms?: number
    watched_ms_delta?: number
    buckets?: unknown
    version_id?: string
  }
): Promise<{ completed: boolean }> {
  const now = new Date()
  const position = Math.max(0, Math.round(Number(input.position_ms) || 0))
  const delta = Math.min(Math.max(0, Math.round(Number(input.watched_ms_delta) || 0)), 60_000)
  const incoming = sanitizeBuckets(input.buckets)
  // The client's version id is only kept when it is an exact uuid; anything
  // else falls back to the published version (never reaches the column raw).
  const versionId = isUuid(input.version_id) ? input.version_id : null
  const row = await db('nivaro_help_video_views')
    .where({ video_id: video.id, user: user.id })
    .first()
  if (!row) {
    const done = isComplete(incoming)
    await db('nivaro_help_video_views')
      .insert({
        video_id: video.id,
        user: user.id,
        version_id: versionId ?? video.published_version_id,
        first_viewed: now,
        last_viewed: now,
        watched_ms: delta,
        position_ms: position,
        buckets: incoming,
        completed_at: done ? now : null
      })
      .catch(() => {
        // a parallel first beat inserted it — the next beat takes the update path
      })
    return { completed: done }
  }
  const buckets = mergeBuckets(String(row.buckets ?? EMPTY), incoming)
  const requiredSince = video.required_since ? new Date(video.required_since as string) : null
  const stale = !!row.completed_at && !!requiredSince && new Date(row.completed_at) < requiredSince
  // A completion from before the video became required (again) does not count:
  // start the section map over from this beat.
  const kept = stale ? incoming : buckets
  const done = isComplete(kept)
  await db('nivaro_help_video_views')
    .where({ id: row.id })
    .update({
      last_viewed: now,
      watched_ms: Number(row.watched_ms ?? 0) + delta,
      position_ms: position,
      buckets: kept,
      version_id: versionId ?? row.version_id,
      completed_at: done && (!row.completed_at || stale) ? now : stale ? null : row.completed_at
    })
  return { completed: done }
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
