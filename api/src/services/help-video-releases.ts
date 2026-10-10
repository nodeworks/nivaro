import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { type MomentCard, momentCard, parseMomentMs } from './help-video-moments.js'
import {
  isAuthor,
  isUuid,
  mediaTicket,
  sessionTag,
  type VideoRow,
  viewerMaySee
} from './help-videos.js'

// A video per release on the changelog (#1528b). The changelog itself is
// generated from git tags at build time and is not editable, so the video
// lives in its own small table keyed by version (migration 416).

export const VERSION_RE = /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][A-Za-z0-9.-]{1,20})?$/

export interface ReleaseVideoDto {
  version: string
  video: MomentCard & { poster_url: string | null }
}

function fail(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}

/** A release version as stored: the tag's form without a leading v. */
export function normalizeVersion(raw: unknown): string {
  const v = String(raw ?? '').trim()
  if (!VERSION_RE.test(v) || v.length > 40) {
    throw fail(400, 'HELP_VIDEO_RELEASE_INVALID', 'That is not a release version')
  }
  return v.replace(/^v/, '')
}

/** Attaches a published video (and a moment in it) to a release. */
export async function setReleaseVideo(
  user: User,
  versionRaw: unknown,
  body: unknown
): Promise<{ version: string; video_id: string; t_ms: number | null }> {
  const version = normalizeVersion(versionRaw)
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (!isUuid(b.video_id)) throw fail(404, 'HELP_VIDEO_NOT_FOUND', 'Video not found')
  const video = (await db('nivaro_help_videos').where({ id: b.video_id }).first()) as
    | VideoRow
    | undefined
  if (video?.status !== 'published') {
    throw fail(404, 'HELP_VIDEO_NOT_FOUND', 'Video not found')
  }
  const t_ms = parseMomentMs(b.t_ms)
  const now = new Date()
  const existing = await db('nivaro_help_video_release_videos').where({ version }).first('version')
  if (existing) {
    await db('nivaro_help_video_release_videos')
      .where({ version })
      .update({ video_id: video.id, t_ms, updated_by: user.id, updated_at: now })
  } else {
    await db('nivaro_help_video_release_videos').insert({
      version,
      video_id: video.id,
      t_ms,
      created_by: user.id,
      updated_by: user.id,
      created_at: now,
      updated_at: now
    })
  }
  await logActivity({
    action: 'help-video-release-set',
    user: user.id,
    collection: 'nivaro_help_videos',
    item: String(video.id).toLowerCase(),
    comment: `release ${version}`
  })
  return { version, video_id: String(video.id).toLowerCase(), t_ms }
}

export async function deleteReleaseVideo(user: User, versionRaw: unknown): Promise<boolean> {
  const version = normalizeVersion(versionRaw)
  const n = await db('nivaro_help_video_release_videos').where({ version }).delete()
  if (Number(n) > 0) {
    await logActivity({
      action: 'help-video-release-clear',
      user: user.id,
      collection: 'nivaro_help_video_release_videos',
      item: version
    })
  }
  return Number(n) > 0
}

/** Every release video THIS reader may watch (published, visible to their
 *  role); the rest are left out, so the changelog shows nothing for them. */
export async function releaseVideosFor(req: FastifyRequest): Promise<ReleaseVideoDto[]> {
  const rows = (await db('nivaro_help_video_release_videos')
    .select('version', 'video_id', 't_ms')
    .catch(() => [])) as Array<{ version: string; video_id: string; t_ms: number | null }>
  if (!rows.length) return []
  const author = await isAuthor(req.user!, !!req.isAdmin)
  const ids = [...new Set(rows.map((r) => String(r.video_id).toUpperCase()))]
  const videos = (await db('nivaro_help_videos').whereIn('id', ids)) as VideoRow[]
  const byId = new Map(videos.map((v) => [String(v.id).toUpperCase(), v]))
  const out: ReleaseVideoDto[] = []
  for (const r of rows) {
    const v = byId.get(String(r.video_id).toUpperCase())
    if (v?.status !== 'published' || !viewerMaySee(v, req.user!.role ?? null, author)) continue
    const card = momentCard(v, r.t_ms == null ? null : Number(r.t_ms))
    const ticket = mediaTicket(card.id, req.user!.id, 'p', Date.now(), sessionTag(req))
    out.push({
      version: String(r.version),
      video: {
        ...card,
        poster_url: v.poster_file
          ? `/api/help-videos/${card.id}/poster?st=${ticket}&v=${String(v.poster_file).slice(0, 8).toLowerCase()}`
          : null
      }
    })
  }
  return out
}
