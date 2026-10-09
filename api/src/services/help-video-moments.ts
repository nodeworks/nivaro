import type { FastifyRequest } from 'fastify'
import { readEdits } from './help-video-changes.js'
import { editedDuration, sourceToEdited } from './help-video-edits.js'
import { isUuid, loadVersion, loadVideoForUser, mediaTicket, sessionTag } from './help-videos.js'

// Links to a moment in a help video (#1501). The contract every host follows:
//   <app path to the videos page>?watch=<video id>&t=<whole seconds>[&c=<chapter id>]
// A chapter (`c`) that resolves wins over `t`. The path differs per host app,
// so a link is recognised by its query alone.

export interface MomentParams {
  id: string
  t: number | null
  c: string | null
}

const CHAPTER_RE = /^[A-Za-z0-9_-]{1,40}$/

/** The moment a link names, or null when it is not a help-video link. */
export function parseMomentLink(raw: string): MomentParams | null {
  let url: URL
  try {
    url = new URL(raw, 'http://app.local')
  } catch {
    return null
  }
  const id = url.searchParams.get('watch')
  if (!id || !isUuid(id)) return null
  const tRaw = url.searchParams.get('t')
  const tNum = tRaw != null && /^\d{1,6}$/.test(tRaw) ? Number(tRaw) : null
  const cRaw = url.searchParams.get('c')
  return { id: id.toLowerCase(), t: tNum, c: cRaw && CHAPTER_RE.test(cRaw) ? cRaw : null }
}

export interface HelpVideoCard {
  kind: 'help-video'
  id: string
  title: string
  duration_ms: number | null
  poster_url: string | null
  /** Where the link starts (edited time); 0 = from the start. */
  start_ms: number
  chapter: { id: string; title: string } | null
}

/**
 * The chat card for a moment link, built for the READER: the same visibility
 * check as watching (loadVideoForUser), published videos only. Anyone who may
 * not watch it gets null (the plain link stays). Nothing comes from the sender.
 */
export async function helpVideoCardFor(
  req: FastifyRequest,
  link: MomentParams
): Promise<HelpVideoCard | null> {
  let video: Awaited<ReturnType<typeof loadVideoForUser>>['video']
  try {
    ;({ video } = await loadVideoForUser(req, link.id))
  } catch {
    return null
  }
  if (video.status !== 'published' || !video.published_version_id) return null
  const version = await loadVersion(video.published_version_id)
  if (!version) return null
  const edits = readEdits(version.edits, version.source_duration_ms)
  const total = edits ? editedDuration(edits) : Number(video.duration_ms ?? 0)
  let start = 0
  let chapter: HelpVideoCard['chapter'] = null
  const hit = link.c && edits ? edits.chapters.find((c) => c.id === link.c) : undefined
  const at = hit && edits ? sourceToEdited(edits, hit.at_ms) : null
  if (hit && at !== null) {
    start = at
    chapter = { id: hit.id, title: hit.title }
  } else if (link.t != null) {
    start = Math.min(link.t * 1000, Math.max(0, total - 1000))
  }
  const id = String(video.id).toLowerCase()
  const ticket = mediaTicket(id, req.user!.id, 'p', Date.now(), sessionTag(req))
  return {
    kind: 'help-video',
    id,
    title: String(video.title ?? ''),
    duration_ms: video.duration_ms == null ? null : Number(video.duration_ms),
    poster_url: video.poster_file
      ? `/api/help-videos/${id}/poster?st=${ticket}&v=${String(video.poster_file).slice(0, 8).toLowerCase()}`
      : null,
    start_ms: Math.max(0, Math.round(start)),
    chapter
  }
}
