import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { chunkArray } from './db-batch.js'
import {
  type HelpVideoDto,
  isAuthor,
  serializeVideo,
  sessionTag,
  type VideoRow,
  viewerMaySee
} from './help-videos.js'

// "Watched next" (#1530): which video people in the viewer's role started
// after this one. Computed nightly from nivaro_help_video_views into
// nivaro_help_video_next (one row per video → next video, per role and for
// any role), read at watch time and topped up with videos for the same
// screen. Never a video the viewer has finished.

/** Two views are a "watched next" pair when the second started within this
 *  long of the first. */
export const NEXT_WINDOW_MS = 2 * 3_600_000
/** How many suggestions a viewer gets. */
export const NEXT_LIMIT = 5
/** Views read per nightly run (newest first); more than this and the oldest
 *  are left out. */
const VIEWS_CAP = 200_000
const INSERT_CHUNK = 200

const up = (v: unknown) => String(v ?? '').toUpperCase()

export type ViewSample = {
  user: string
  role: string | null
  video_id: string
  first_viewed: Date | string | number
}
export type NextRow = {
  video_id: string
  next_video_id: string
  role_id: string | null
  /** How many people in that role (or in any role) went on to the next video. */
  score: number
}

/**
 * Successor pairs: for each person, views in first_viewed order; every view
 * followed by a different video started within `windowMs` counts one for
 * (video, next, that person's role) and one for (video, next, any role). A
 * person's first view of a video is the only one the table holds, so a
 * person counts at most once per pair. Pairs with the same video on both
 * sides are skipped.
 */
export function successorPairs(views: ViewSample[], windowMs = NEXT_WINDOW_MS): NextRow[] {
  const byUser = new Map<string, Array<{ video: string; role: string | null; at: number }>>()
  for (const v of views) {
    const at = new Date(v.first_viewed as string).getTime()
    if (!Number.isFinite(at)) continue
    const key = up(v.user)
    const list = byUser.get(key) ?? []
    list.push({ video: up(v.video_id), role: v.role ? up(v.role) : null, at })
    byUser.set(key, list)
  }
  const counts = new Map<string, NextRow>()
  const bump = (video: string, next: string, role: string | null) => {
    const key = `${video}|${next}|${role ?? ''}`
    const row = counts.get(key)
    if (row) row.score += 1
    else counts.set(key, { video_id: video, next_video_id: next, role_id: role, score: 1 })
  }
  for (const list of byUser.values()) {
    list.sort((a, b) => a.at - b.at)
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i]
      const b = list[i + 1]
      if (a.video === b.video || b.at - a.at > windowMs) continue
      if (a.role) bump(a.video, b.video, a.role)
      bump(a.video, b.video, null)
    }
  }
  return [...counts.values()].sort(
    (x, y) =>
      y.score - x.score ||
      x.video_id.localeCompare(y.video_id) ||
      x.next_video_id.localeCompare(y.next_video_id) ||
      (x.role_id ?? '').localeCompare(y.role_id ?? '')
  )
}

/** The nightly job: recompute the whole table from published videos' views. */
export async function computeNextTable(now: Date = new Date()): Promise<string> {
  const views = (await db('nivaro_help_video_views as w')
    .join('nivaro_help_videos as v', 'v.id', 'w.video_id')
    .leftJoin('nivaro_users as u', 'u.id', 'w.user')
    .where('v.status', 'published')
    .orderBy('w.first_viewed', 'desc')
    .limit(VIEWS_CAP)
    .select('w.user', 'w.video_id', 'w.first_viewed', 'u.role')) as ViewSample[]
  const rows = successorPairs(views)
  await db('nivaro_help_video_next').delete()
  for (const chunk of chunkArray(rows, INSERT_CHUNK)) {
    await db('nivaro_help_video_next').insert(
      chunk.map((r) => ({
        video_id: r.video_id,
        next_video_id: r.next_video_id,
        role_id: r.role_id,
        score: r.score,
        computed_at: now
      }))
    )
  }
  return `${rows.length} pairs from ${views.length} views`
}

export type NextCandidate = {
  id: string
  /** 0 = watched next by this role, 1 = by anyone, 2 = same screen. */
  tier: 0 | 1 | 2
  score: number
}

/**
 * Orders candidates: role rows first (best score first), then role-less rows,
 * then same-screen videos; a video appears once, under its best tier; the
 * video itself, finished videos and invisible ones are left out.
 */
export function rankNext(
  candidates: NextCandidate[],
  opts: {
    videoId: string
    finished: Set<string>
    visible: (id: string) => boolean
    limit?: number
  }
): string[] {
  const best = new Map<string, NextCandidate>()
  for (const c of candidates) {
    const id = up(c.id)
    if (id === up(opts.videoId) || opts.finished.has(id) || !opts.visible(id)) continue
    const prev = best.get(id)
    if (!prev || c.tier < prev.tier || (c.tier === prev.tier && c.score > prev.score)) {
      best.set(id, { ...c, id })
    }
  }
  return [...best.values()]
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, opts.limit ?? NEXT_LIMIT)
    .map((c) => c.id)
}

/** Up to NEXT_LIMIT published videos this viewer may watch and has not
 *  finished, in rankNext order, serialized as the viewer sees them. */
export async function nextForViewer(req: FastifyRequest, video: VideoRow): Promise<HelpVideoDto[]> {
  const user = req.user!
  const role = user.role ?? null
  const author = await isAuthor(user, !!req.isAdmin)
  const learned = (await db('nivaro_help_video_next')
    .where({ video_id: video.id })
    .where((w) => {
      w.whereNull('role_id')
      if (role) w.orWhere({ role_id: role })
    })
    .select('next_video_id', 'role_id', 'score')) as Array<{
    next_video_id: unknown
    role_id: unknown
    score: unknown
  }>
  const candidates: NextCandidate[] = learned.map((r) => ({
    id: up(r.next_video_id),
    tier: r.role_id ? 0 : 1,
    score: Number(r.score ?? 0)
  }))
  // Same screen: videos sharing a where-it-shows context with this one, the
  // more shared contexts the better.
  const mine = (await db('nivaro_help_video_contexts')
    .where({ video_id: video.id })
    .select('kind', 'key')) as Array<{ kind: string; key: string }>
  if (mine.length) {
    const shared = (await db('nivaro_help_video_contexts')
      .where((w) => {
        for (const c of mine) w.orWhere({ kind: c.kind, key: c.key })
      })
      .whereNot({ video_id: video.id })
      .select('video_id')) as Array<{ video_id: unknown }>
    const n = new Map<string, number>()
    for (const r of shared) n.set(up(r.video_id), (n.get(up(r.video_id)) ?? 0) + 1)
    for (const [id, score] of n) candidates.push({ id, tier: 2, score })
  }
  const ids = [...new Set(candidates.map((c) => c.id))].filter((id) => id !== up(video.id))
  if (!ids.length) return []
  const [videos, views] = await Promise.all([
    db('nivaro_help_videos').whereIn('id', ids) as Promise<VideoRow[]>,
    db('nivaro_help_video_views')
      .where({ user: user.id })
      .whereIn('video_id', ids)
      .whereNotNull('completed_at')
      .select('video_id') as Promise<Array<{ video_id: unknown }>>
  ])
  const byId = new Map(videos.map((v) => [up(v.id), v]))
  const finished = new Set(views.map((v) => up(v.video_id)))
  const picked = rankNext(candidates, {
    videoId: String(video.id),
    finished,
    visible: (id) => {
      const v = byId.get(id)
      return (
        !!v && v.status === 'published' && !!v.published_version_id && viewerMaySee(v, role, author)
      )
    }
  })
  const ctx = { author, userId: user.id, role, sidTag: sessionTag(req) }
  return Promise.all(picked.map((id) => serializeVideo(byId.get(id) as VideoRow, ctx)))
}
