/**
 * Help videos: tutorial recordings with edits, versions, where they show,
 * required viewing and progress. Upload parts are raw octet-stream PUTs to
 * /help-videos/uploads/:id/parts/:n (see README); everything else is here.
 *
 * Error codes callers must handle (all JSON `{ error, code }`):
 * - 409 `HELP_VIDEO_PROCESSING`: a viewer's `stream_url` answers this while the
 *   video is still being rendered (check `published.playable` first).
 * - 409 `HELP_VIDEO_EDITS_CONFLICT`: `saveHelpVideoDraft` with a stale
 *   `base_hash`; the body also carries `current_hash`.
 * - 409 `UPLOAD_CLOSED`: the upload was already finalized or is finishing.
 * - 422 `UPLOAD_NOT_VIDEO`: a part is not a WebM or MP4 recording.
 * - 422 `UPLOAD_TOO_LONG`: the recording is over 30 minutes (finalize).
 * Also: 403 `HELP_VIDEO_AUTHOR_ONLY` on any authoring command by a non-author,
 * 404 `HELP_VIDEO_NOT_FOUND` for an unknown or invisible video.
 */
import { type Command, cmd } from '../command.js'

export type HelpVideoContext = {
  kind: 'collection' | 'page'
  key: string
  state_key: string | null
}
export type HelpVideoVisibility = { mode: 'everyone' | 'roles'; role_ids: string[] }
export interface HelpVideoVersion {
  id: string
  version: number
  edits: Record<string, unknown>
  edits_hash: string
  source_duration_ms: number | null
  width: number | null
  height: number | null
  render_status: 'none' | 'queued' | 'rendering' | 'ready' | 'failed' | 'unavailable'
  render_progress: number | null
  render_error: string | null
  rendered_current: boolean
  /** Published version only: false when a non-author would get a 409 HELP_VIDEO_PROCESSING. */
  playable?: boolean
  note: string | null
  created_at: string
  /** Draft, re-record and restore results only (recorder data). Clicks on the
   *  recorded tab: `t_ms` source time, `x`/`y` fractions (0–1) of the frame. */
  clicks?: Array<{ t_ms: number; x: number; y: number }> | null
  /** Microphone loudness 0–1, one value per 100 ms of source time. */
  levels?: number[] | null
}
export interface HelpVideoProgress {
  position_ms: number
  completed: boolean
  percent: number
}
export interface HelpVideo {
  id: string
  title: string
  description: string | null
  category: string | null
  status: 'draft' | 'published' | 'archived'
  duration_ms: number | null
  /** Ticketed URLs (`?st=`): play them as-is, do not rebuild them. */
  poster_url: string | null
  stream_url: string | null
  captions_url: string | null
  contexts: HelpVideoContext[]
  /** Required for THIS viewer's role (not for the video in general). */
  required: boolean
  published: HelpVideoVersion | null
  /** Authors only. */
  visibility?: HelpVideoVisibility
  required_role_ids?: string[]
  draft?: HelpVideoVersion | null
  /** Author-only: the draft is exactly the published version; publishing it
   *  answers 409 `HELP_VIDEO_NOTHING_TO_PUBLISH`. */
  draft_matches_published?: boolean
  draft_stream_url?: string | null
  draft_captions_url?: string | null
  created_by_name?: string | null
  updated_at: string
  my_progress: HelpVideoProgress | null
}
/** An upload session, as returned by open, each part PUT and "my uploads". */
export interface HelpVideoUploadSession {
  id: string
  mime: string
  bytes_received: number
  next_part: number
  /** `open` while parts arrive; `finalized` once uploaded (listed by
   *  `listMyHelpVideoUploads` only while no video uses it). */
  status: string
  /** Probed length of a finalized recording; null while open. */
  duration_ms: number | null
  created_at: string
  updated_at: string
}
export interface HelpVideoFinalizedUpload {
  file_id: string
  duration_ms: number | null
  width: number | null
  height: number | null
  has_audio: boolean
  clicks: unknown
  levels: unknown
}

export function listHelpVideos(params?: {
  search?: string
  category?: string
  status?: string
  page?: number
  limit?: number
}): Command<{ data: HelpVideo[]; total: number; categories: string[]; can_author: boolean }> {
  return cmd('GET', '/help-videos', params)
}
export function readHelpVideo(id: string): Command<{ data: HelpVideo }> {
  return cmd('GET', `/help-videos/${id}`)
}
export function helpVideosFor(params: {
  collection?: string
  item?: string | number
  state?: string
  page?: string
}): Command<{ data: HelpVideo[]; can_author: boolean; state: string | null }> {
  return cmd('GET', '/help-videos/for', params)
}
export function createHelpVideo(body: {
  upload_id: string
  title?: string
  contexts?: HelpVideoContext[]
}): Command<{ data: HelpVideo }> {
  return cmd('POST', '/help-videos', undefined, body)
}
export function updateHelpVideo(
  id: string,
  body: {
    title?: string
    description?: string | null
    category?: string | null
    visibility?: HelpVideoVisibility
  }
): Command<{ data: HelpVideo }> {
  return cmd('PATCH', `/help-videos/${id}`, undefined, body)
}
export function setHelpVideoContexts(
  id: string,
  contexts: HelpVideoContext[]
): Command<{ data: { ok: true } }> {
  return cmd('PUT', `/help-videos/${id}/contexts`, undefined, { contexts })
}
export function setHelpVideoRequirements(
  id: string,
  role_ids: string[]
): Command<{ data: { ok: true; added: string[] } }> {
  return cmd('PUT', `/help-videos/${id}/requirements`, undefined, { role_ids })
}
/** Archives the video; `purge: true` deletes it for good (administrators only). */
export function archiveHelpVideo(id: string, opts?: { purge?: boolean }): Command<void> {
  return cmd('DELETE', `/help-videos/${id}`, opts?.purge ? { purge: 1 } : undefined)
}
export function readHelpVideoDraft(id: string): Command<{ data: HelpVideoVersion }> {
  return cmd('GET', `/help-videos/${id}/draft/edits`)
}
/** 409 `HELP_VIDEO_EDITS_CONFLICT` (body carries `current_hash`) when `base_hash` is stale. */
export function saveHelpVideoDraft(
  id: string,
  edits: Record<string, unknown>,
  base_hash?: string
): Command<{ data: HelpVideoVersion }> {
  return cmd('PUT', `/help-videos/${id}/draft/edits`, undefined, { edits, base_hash })
}
/** 422 `HELP_VIDEO_NOT_READY` (body lists `missing`) or 409 `HELP_VIDEO_NOTHING_TO_PUBLISH`
 *  (no draft, or the draft equals what is published). With `watch_again` on an
 *  unchanged video someone must watch, the requirement is re-armed instead: no
 *  new version, no render. */
export function publishHelpVideo(
  id: string,
  opts?: { watch_again?: boolean }
): Command<{ data: HelpVideo }> {
  return cmd('POST', `/help-videos/${id}/publish`, undefined, opts ?? {})
}
export function rerecordHelpVideo(
  id: string,
  upload_id: string
): Command<{ data: HelpVideoVersion }> {
  return cmd('POST', `/help-videos/${id}/rerecord`, undefined, { upload_id })
}
export function listHelpVideoVersions(id: string): Command<{
  data: Array<
    HelpVideoVersion & { is_published: boolean; is_draft: boolean; created_by_name: string | null }
  >
}> {
  return cmd('GET', `/help-videos/${id}/versions`)
}
export function restoreHelpVideoVersion(
  id: string,
  versionId: string
): Command<{ data: HelpVideoVersion }> {
  return cmd('POST', `/help-videos/${id}/versions/${versionId}/restore`)
}
/** Re-queue the render of the published version (or the draft with `draft`).
 *  409 `HELP_VIDEO_NOTHING_TO_RENDER` when that version does not exist. */
export function rerenderHelpVideo(
  id: string,
  opts?: { draft?: boolean }
): Command<{ data: { ok: true } }> {
  return cmd('POST', `/help-videos/${id}/render`, opts?.draft ? { draft: 1 } : undefined)
}
/** `buckets` is a 20-character string of 0/1: the 5% sections watched so far.
 *  Resolves with no body (204) for a masquerade session, which is never tracked. */
export function recordHelpVideoProgress(
  id: string,
  body: { position_ms: number; watched_ms_delta: number; buckets: string; version_id?: string }
): Command<{ data: { completed: boolean } } | undefined> {
  return cmd('POST', `/help-videos/${id}/progress`, undefined, body)
}
export function readRequiredHelpVideos(): Command<{ data: HelpVideo[] }> {
  return cmd('GET', '/help-videos/required/mine')
}
export function readHelpVideoAnalytics(id: string): Command<{
  data: {
    views: number
    unique_viewers: number
    completion_rate: number
    drop_off: number[]
    watched_hours: number
  }
}> {
  return cmd('GET', `/help-videos/${id}/analytics`)
}
export function openHelpVideoUpload(mime: string): Command<{ data: HelpVideoUploadSession }> {
  return cmd('POST', '/help-videos/uploads', undefined, { mime })
}
/** 409 `UPLOAD_CLOSED`, 422 `UPLOAD_TOO_LONG`, 422 `UPLOAD_EMPTY`, 422 `UPLOAD_UNREADABLE`. */
export function finalizeHelpVideoUpload(
  id: string,
  meta?: { duration_ms?: number; clicks?: unknown; levels?: unknown }
): Command<{ data: HelpVideoFinalizedUpload }> {
  return cmd('POST', `/help-videos/uploads/${id}/finalize`, undefined, meta ?? {})
}
/** Your unfinished uploads and finished recordings never saved as a video
 *  (save one with `createHelpVideo` / `rerecordHelpVideo`, no finalize). */
export function listMyHelpVideoUploads(): Command<{ data: HelpVideoUploadSession[] }> {
  return cmd('GET', '/help-videos/uploads/mine')
}
/** Discards an open upload, or a finished recording no video uses (its file
 *  is deleted). 409 `UPLOAD_CLOSED` for anything else. */
export function abandonHelpVideoUpload(id: string): Command<void> {
  return cmd('DELETE', `/help-videos/uploads/${id}`)
}
export function listHelpVideoPages(): Command<{
  data: Array<{ key: string; label: string; app: string | null }>
}> {
  return cmd('GET', '/help-videos/pages')
}
export function registerHelpVideoPage(body: {
  key: string
  label: string
  app?: string
}): Command<void> {
  return cmd('POST', '/help-videos/pages', undefined, body)
}
