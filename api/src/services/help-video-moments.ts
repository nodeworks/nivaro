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

// ── A video moment carried by something else (#1528) ─────────────────────────
// Broadcasts and release notes point at a moment: `/help-videos?watch=<id>
// &t=<seconds>`, the same link people copy from the player. The poster is
// served through a ticketed, session-bound URL, so an email cannot show the
// image itself: the email card is the title, length and where it starts.

/** The in-app path of a moment (relative to the app; hosts put their origin in front). */
export function momentPath(id: string, tMs: number | null | undefined): string {
  const q = new URLSearchParams({ watch: id.toLowerCase() })
  const secs = tMs != null && tMs > 0 ? Math.floor(tMs / 1000) : 0
  if (secs > 0) q.set('t', String(secs))
  return `/help-videos?${q.toString()}`
}

/** A start time from a request: whole milliseconds, 0..24 h, else null. */
export function parseMomentMs(raw: unknown): number | null {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(n, 24 * 3_600_000)
}

export function formatMomentDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(Number(ms))) return null
  const total = Math.max(0, Math.round(Number(ms) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export interface MomentCard {
  id: string
  title: string
  duration_ms: number | null
  start_ms: number
  /** In-app path (`/help-videos?watch=…&t=…`). */
  path: string
}

/** The card for a moment of a video row (already checked to be visible to
 *  the reader and published). `start_ms` stays inside the video. */
export function momentCard(
  video: { id: unknown; title: unknown; duration_ms?: unknown },
  tMs: number | null | undefined
): MomentCard {
  const id = String(video.id).toLowerCase()
  const total = video.duration_ms == null ? null : Number(video.duration_ms)
  let start = tMs != null && tMs > 0 ? Math.round(tMs) : 0
  if (total != null && total > 0) start = Math.min(start, Math.max(0, total - 1000))
  return {
    id,
    title: String(video.title ?? '') || 'Untitled video',
    duration_ms: total,
    start_ms: Math.max(0, start),
    path: momentPath(id, start)
  }
}

/** One plain-text line for an in-app message or SMS. */
export function momentLine(card: MomentCard, origin: string): string {
  const len = formatMomentDuration(card.duration_ms)
  const from = card.start_ms > 0 ? ` from ${formatMomentDuration(card.start_ms)}` : ''
  return `Watch the video${from}: ${card.title}${len ? ` (${len})` : ''} ${origin}${card.path}`
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The email card: a bordered block with a play mark, title, length and the
 *  moment link. No image — the poster needs the reader's session. */
export function momentEmailHtml(card: MomentCard, origin: string): string {
  const len = formatMomentDuration(card.duration_ms)
  const from = card.start_ms > 0 ? `Starts at ${formatMomentDuration(card.start_ms)}` : null
  const meta = [len ? `Video · ${len}` : 'Video', from].filter(Boolean).join(' · ')
  const href = `${origin}${card.path}`
  return (
    '<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 12px;border:1px solid #cbd5e1;border-radius:8px;">' +
    '<tr><td style="padding:10px 12px;font-family:sans-serif;font-size:13px;">' +
    `<div style="font-weight:600;color:#0f172a;">&#9654; ${esc(card.title)}</div>` +
    `<div style="color:#64748b;font-size:12px;margin-top:2px;">${esc(meta)}</div>` +
    `<div style="margin-top:6px;"><a href="${esc(href)}" style="color:#0369a1;">Watch the video</a></div>` +
    '</td></tr></table>'
  )
}
