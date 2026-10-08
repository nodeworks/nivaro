import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import type { InstanceIdentity } from './branch-instances.js'
import {
  editedDuration,
  emptyEdits,
  hashEdits,
  normalizeEdits,
  type VideoEdits
} from './help-video-edits.js'
import { queueRender } from './help-video-render.js'
import { takeFinalizedUpload } from './help-video-uploads.js'

// Help videos: who may author and watch, and the video/version lifecycle.
// A video has one published version (what viewers get) and at most one draft
// (what authors edit). Viewers never see the draft — serializeVideo omits it
// and every playback route reads published_version_id.

export type Visibility = { mode: 'everyone' | 'roles'; role_ids: string[] }
export type VideoRow = Record<string, unknown> & {
  id: string
  title: string
  status: string
  visibility: string | null
  published_version_id: string | null
  draft_version_id: string | null
}
export type VersionRow = Record<string, unknown> & {
  id: string
  video_id: string
  edits: string
  edits_hash: string
}
export interface ContextInput {
  kind: 'collection' | 'page'
  key: string
  state_key: string | null
}

export interface VersionDto {
  id: string
  version: number
  edits: VideoEdits
  edits_hash: string
  source_duration_ms: number | null
  width: number | null
  height: number | null
  render_status: 'none' | 'queued' | 'rendering' | 'ready' | 'failed' | 'unavailable'
  render_progress: number | null
  render_error: string | null
  rendered_current: boolean
  note: string | null
  created_at: string
  clicks?: Array<{ t_ms: number; x: number; y: number }> | null
  levels?: number[] | null
}
export interface HelpVideoDto {
  id: string
  title: string
  description: string | null
  category: string | null
  status: 'draft' | 'published' | 'archived'
  duration_ms: number | null
  poster_url: string | null
  stream_url: string | null
  captions_url: string | null
  contexts: Array<{ kind: 'collection' | 'page'; key: string; state_key: string | null }>
  required: boolean
  published: VersionDto | null
  // author-only
  visibility?: Visibility
  required_role_ids?: string[]
  draft?: VersionDto | null
  created_by_name?: string | null
  updated_at: string
  my_progress: { position_ms: number; completed: boolean; percent: number } | null
}

function fail(
  statusCode: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {}
): Error {
  return Object.assign(new Error(message), { statusCode, code, ...extra })
}
const up = (v: unknown) => String(v ?? '').toUpperCase()
const low = (v: unknown) => String(v ?? '').toLowerCase()
function json<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// SQL Server compares a string to a uniqueidentifier after truncating it, so
// '<uuid>/../x' would still match a row. Every id from a caller must be an
// exact uuid before it reaches a query (same rule as the upload ids).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

export function parseVisibility(raw: unknown): Visibility {
  const v = json<Record<string, unknown> | null>(raw, null)
  const ids = Array.isArray(v?.role_ids) ? (v?.role_ids as unknown[]).map(up).filter(Boolean) : []
  if (v?.mode === 'roles' && ids.length) return { mode: 'roles', role_ids: [...new Set(ids)] }
  return { mode: 'everyone', role_ids: [] }
}

let authorCache: { at: number; ids: string[] } | null = null
export function bustAuthorRoleCache(): void {
  authorCache = null
}
export async function authorRoleIds(): Promise<string[]> {
  if (authorCache && Date.now() - authorCache.at < 30_000) return authorCache.ids
  const row = await db('nivaro_settings')
    .where({ id: 1 })
    .first('help_video_author_roles')
    .catch(() => null)
  const ids = json<unknown[]>(row?.help_video_author_roles, []).map(up).filter(Boolean)
  authorCache = { at: Date.now(), ids }
  return ids
}
export async function isAuthor(user: User, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true
  if (!user.role) return false
  return (await authorRoleIds()).includes(up(user.role))
}

export function viewerMaySee(
  video: { status: string; visibility: unknown },
  role: string | null,
  author: boolean
): boolean {
  if (author) return true
  if (video.status !== 'published') return false
  const vis = parseVisibility(video.visibility)
  return vis.mode === 'everyone' || (!!role && vis.role_ids.includes(up(role)))
}

const KEY_RE = /^[A-Za-z0-9_.:-]{1,100}$/
export function validateContexts(input: unknown): ContextInput[] {
  if (!Array.isArray(input)) throw fail(400, 'HELP_VIDEO_CONTEXTS', 'contexts must be a list')
  if (input.length > 50) {
    throw fail(400, 'HELP_VIDEO_CONTEXTS', 'A video can show on at most 50 screens')
  }
  const out: ContextInput[] = []
  const seen = new Set<string>()
  for (const raw of input as Array<Record<string, unknown>>) {
    const kind = raw?.kind
    const key = String(raw?.key ?? '')
    if (kind !== 'collection' && kind !== 'page') {
      throw fail(400, 'HELP_VIDEO_CONTEXTS', `Unknown context kind: ${String(kind)}`)
    }
    if (!KEY_RE.test(key)) throw fail(400, 'HELP_VIDEO_CONTEXTS', `Invalid key: ${key}`)
    const stateRaw = kind === 'collection' && raw.state_key ? String(raw.state_key) : null
    if (stateRaw !== null && !KEY_RE.test(stateRaw)) {
      throw fail(400, 'HELP_VIDEO_CONTEXTS', `Invalid state: ${stateRaw}`)
    }
    const sig = `${kind}|${key}|${stateRaw ?? ''}`
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push({ kind, key, state_key: stateRaw })
  }
  return out
}

export function publishChecklist(video: { title: string }, contextCount: number): string[] {
  const missing: string[] = []
  if (!String(video.title ?? '').trim()) missing.push('title')
  if (contextCount < 1) missing.push('where')
  return missing
}

export function serializeVersion(v: VersionRow, opts: { withRecorderData: boolean }): VersionDto {
  const edits = json<VideoEdits>(v.edits, emptyEdits(Number(v.source_duration_ms ?? 0)))
  const dto: VersionDto = {
    id: low(v.id),
    version: Number(v.version),
    edits,
    edits_hash: String(v.edits_hash),
    source_duration_ms: v.source_duration_ms == null ? null : Number(v.source_duration_ms),
    width: v.width == null ? null : Number(v.width),
    height: v.height == null ? null : Number(v.height),
    render_status: String(v.render_status ?? 'none') as VersionDto['render_status'],
    render_progress: v.render_progress == null ? null : Number(v.render_progress),
    render_error: (v.render_error as string | null) ?? null,
    rendered_current: !!v.rendered_file && v.rendered_hash === v.edits_hash,
    note: (v.note as string | null) ?? null,
    created_at: new Date(v.created_at as string).toISOString()
  }
  if (opts.withRecorderData) {
    dto.clicks = json(v.clicks, null)
    dto.levels = json(v.levels, null)
  }
  return dto
}

export async function loadVersion(id: string | null | undefined): Promise<VersionRow | undefined> {
  if (!id) return undefined
  return db('nivaro_help_video_versions').where({ id }).first()
}

export async function loadVideoForUser(
  req: FastifyRequest,
  id: string
): Promise<{ video: VideoRow; author: boolean }> {
  if (!isUuid(id)) throw fail(404, 'HELP_VIDEO_NOT_FOUND', 'Video not found')
  const author = await isAuthor(req.user!, !!req.isAdmin)
  const video = (await db('nivaro_help_videos').where({ id }).first()) as VideoRow | undefined
  if (!video || !viewerMaySee(video, req.user!.role, author)) {
    throw fail(404, 'HELP_VIDEO_NOT_FOUND', 'Video not found')
  }
  return { video, author }
}

/** A video is required for THIS viewer only when one of its requirement rows
 *  names the viewer's own role — someone outside those roles never sees
 *  "Required" on it. */
export function requiredForRole(roleIds: unknown[], role: string | null): boolean {
  if (!role) return false
  const mine = up(role)
  return roleIds.some((r) => up(r) === mine)
}

export async function serializeVideo(
  video: VideoRow,
  ctx: { author: boolean; userId: string; role: string | null }
): Promise<HelpVideoDto> {
  const id = low(video.id)
  const [published, draft, contexts, reqs, view, creator] = await Promise.all([
    loadVersion(video.published_version_id),
    ctx.author ? loadVersion(video.draft_version_id) : Promise.resolve(undefined),
    db('nivaro_help_video_contexts')
      .where({ video_id: video.id })
      .select('kind', 'key', 'state_key'),
    db('nivaro_help_video_requirements').where({ video_id: video.id }).select('role_id'),
    db('nivaro_help_video_views').where({ video_id: video.id, user: ctx.userId }).first(),
    ctx.author && video.created_by
      ? db('nivaro_users').where({ id: video.created_by }).first('first_name', 'last_name')
      : Promise.resolve(undefined)
  ])
  const base = `/api/help-videos/${id}`
  const buckets = String(view?.buckets ?? '')
  const seen = [...buckets].filter((c) => c === '1').length
  const requiredSince = video.required_since ? new Date(video.required_since as string) : null
  const completedAt = view?.completed_at ? new Date(view.completed_at) : null
  const dto: HelpVideoDto = {
    id,
    title: String(video.title ?? ''),
    description: (video.description as string | null) ?? null,
    category: (video.category as string | null) ?? null,
    status: video.status as HelpVideoDto['status'],
    duration_ms: video.duration_ms == null ? null : Number(video.duration_ms),
    poster_url: video.poster_file ? `${base}/poster` : null,
    stream_url: published ? `${base}/stream` : null,
    captions_url: published ? `${base}/captions.vtt` : null,
    contexts: contexts.map(
      (c: { kind: ContextInput['kind']; key: string; state_key: string | null }) => ({
        kind: c.kind,
        key: c.key,
        state_key: c.state_key ?? null
      })
    ),
    required: requiredForRole(
      reqs.map((r: { role_id: unknown }) => r.role_id),
      ctx.role
    ),
    published: published ? serializeVersion(published, { withRecorderData: false }) : null,
    updated_at: new Date(video.updated_at as string).toISOString(),
    my_progress: view
      ? {
          position_ms: Number(view.position_ms ?? 0),
          completed: !!completedAt && (!requiredSince || completedAt >= requiredSince),
          percent: Math.round((seen / 20) * 100)
        }
      : null
  }
  if (ctx.author) {
    dto.visibility = parseVisibility(video.visibility)
    dto.required_role_ids = reqs.map((r: { role_id: unknown }) => up(r.role_id))
    dto.draft = draft ? serializeVersion(draft, { withRecorderData: true }) : null
    dto.created_by_name = creator
      ? `${creator.first_name ?? ''} ${creator.last_name ?? ''}`.trim() || null
      : null
  }
  return dto
}

async function nextVersionNumber(videoId: string): Promise<number> {
  const row = await db('nivaro_help_video_versions')
    .where({ video_id: videoId })
    .max('version as m')
    .first()
  return Number(row?.m ?? 0) + 1
}

async function insertVersion(
  videoId: string,
  user: User,
  data: {
    source_file: string
    source_duration_ms: number | null
    width: number | null
    height: number | null
    clicks: unknown
    levels: unknown
    edits: VideoEdits
    note?: string | null
  }
): Promise<string> {
  const id = randomUUID()
  await db('nivaro_help_video_versions').insert({
    id,
    video_id: videoId,
    version: await nextVersionNumber(videoId),
    source_file: data.source_file,
    source_duration_ms: data.source_duration_ms,
    width: data.width,
    height: data.height,
    clicks: data.clicks == null ? null : JSON.stringify(data.clicks),
    levels: data.levels == null ? null : JSON.stringify(data.levels),
    edits: JSON.stringify(data.edits),
    edits_hash: hashEdits(data.edits),
    render_status: 'none',
    note: data.note ?? null,
    created_by: user.id,
    created_at: new Date()
  })
  return id
}

function touch(user: User): Record<string, unknown> {
  return { updated_by: user.id, updated_at: new Date() }
}

export async function createVideo(
  user: User,
  body: { upload_id?: string; title?: string; contexts?: unknown }
): Promise<string> {
  if (!body.upload_id) throw fail(400, 'HELP_VIDEO_UPLOAD', 'upload_id is required')
  const contexts = body.contexts === undefined ? [] : validateContexts(body.contexts)
  const upload = await takeFinalizedUpload(user, body.upload_id)
  const id = randomUUID()
  const now = new Date()
  await db('nivaro_help_videos').insert({
    id,
    title: String(body.title ?? '').slice(0, 200),
    status: 'draft',
    visibility: JSON.stringify({ mode: 'everyone', role_ids: [] }),
    created_by: user.id,
    updated_by: user.id,
    created_at: now,
    updated_at: now
  })
  const versionId = await insertVersion(id, user, {
    source_file: upload.file_id,
    source_duration_ms: upload.duration_ms,
    width: upload.width,
    height: upload.height,
    clicks: upload.clicks,
    levels: upload.levels,
    edits: emptyEdits(upload.duration_ms ?? 0)
  })
  await db('nivaro_help_videos').where({ id }).update({ draft_version_id: versionId })
  if (contexts.length) await replaceContexts(id, user, contexts)
  await logActivity({
    action: 'help-video-create',
    user: user.id,
    collection: 'nivaro_help_videos',
    item: id
  })
  return id
}

export async function updateDetails(
  videoId: string,
  user: User,
  body: Record<string, unknown>
): Promise<void> {
  const patch: Record<string, unknown> = {}
  if ('title' in body) patch.title = String(body.title ?? '').slice(0, 200)
  if ('description' in body) {
    patch.description = body.description == null ? null : String(body.description).slice(0, 4000)
  }
  if ('category' in body)
    patch.category = body.category ? String(body.category).slice(0, 100) : null
  if ('visibility' in body) patch.visibility = JSON.stringify(parseVisibility(body.visibility))
  if (!Object.keys(patch).length) return
  await db('nivaro_help_videos')
    .where({ id: videoId })
    .update({ ...patch, ...touch(user) })
  await logActivity({
    action: 'help-video-update',
    user: user.id,
    collection: 'nivaro_help_videos',
    item: low(videoId),
    comment: Object.keys(patch).join(', ')
  })
}

export async function replaceContexts(
  videoId: string,
  user: User,
  contexts: ContextInput[]
): Promise<void> {
  await db.transaction(async (trx) => {
    await trx('nivaro_help_video_contexts').where({ video_id: videoId }).delete()
    if (contexts.length) {
      await trx('nivaro_help_video_contexts').insert(
        contexts.map((c) => ({ video_id: videoId, ...c }))
      )
    }
    await trx('nivaro_help_videos').where({ id: videoId }).update(touch(user))
  })
}

export async function replaceRequirements(
  videoId: string,
  user: User,
  roleIds: unknown
): Promise<{ added: string[] }> {
  if (!Array.isArray(roleIds)) throw fail(400, 'HELP_VIDEO_REQUIRED', 'role_ids must be a list')
  // Only exact uuids reach the roles lookup (a truncated match would be wrong);
  // anything else, like an unknown role, is simply not kept.
  const wanted = [...new Set(roleIds.filter(isUuid).map(up))].slice(0, 50)
  const known = wanted.length
    ? (await db('nivaro_roles').whereIn('id', wanted).select('id')).map((r: { id: unknown }) =>
        up(r.id)
      )
    : []
  const before = (
    await db('nivaro_help_video_requirements').where({ video_id: videoId }).select('role_id')
  ).map((r: { role_id: unknown }) => up(r.role_id))
  await db.transaction(async (trx) => {
    await trx('nivaro_help_video_requirements').where({ video_id: videoId }).delete()
    if (known.length) {
      await trx('nivaro_help_video_requirements').insert(
        known.map((role_id: string) => ({ video_id: videoId, role_id }))
      )
    }
    await trx('nivaro_help_videos').where({ id: videoId }).update(touch(user))
  })
  return { added: known.filter((r: string) => !before.includes(r)) }
}

/** The draft authors edit; created from the published version on first edit. */
export async function ensureDraft(video: VideoRow, user: User): Promise<VersionRow> {
  const existing = await loadVersion(video.draft_version_id)
  if (existing) return existing
  const pub = await loadVersion(video.published_version_id)
  if (!pub) throw fail(409, 'HELP_VIDEO_NO_VERSION', 'This video has no recording yet')
  const id = await insertVersion(video.id, user, {
    source_file: String(pub.source_file),
    source_duration_ms: pub.source_duration_ms == null ? null : Number(pub.source_duration_ms),
    width: pub.width == null ? null : Number(pub.width),
    height: pub.height == null ? null : Number(pub.height),
    clicks: json(pub.clicks, null),
    levels: json(pub.levels, null),
    edits: json<VideoEdits>(pub.edits, emptyEdits(Number(pub.source_duration_ms ?? 0)))
  })
  await db('nivaro_help_videos').where({ id: video.id }).update({ draft_version_id: id })
  return (await loadVersion(id)) as VersionRow
}

const UNKNOWN_DURATION_MS = 30 * 60_000

export async function saveDraftEdits(
  video: VideoRow,
  user: User,
  input: unknown,
  baseHash?: string
): Promise<VersionDto> {
  const draft = await ensureDraft(video, user)
  if (baseHash && baseHash !== draft.edits_hash) {
    throw fail(
      409,
      'HELP_VIDEO_EDITS_CONFLICT',
      'These edits changed in another tab — reload to continue',
      { current_hash: draft.edits_hash }
    )
  }
  const edits = normalizeEdits(input, Number(draft.source_duration_ms ?? UNKNOWN_DURATION_MS))
  const hash = hashEdits(edits)
  // Conditional write: only if nobody saved since we read it (same hash) AND it
  // is still the video's draft — a save that lands after Publish moved this
  // version to published_version_id must never rewrite the published edits.
  const updated = await db('nivaro_help_video_versions')
    .where({ id: draft.id, edits_hash: draft.edits_hash })
    .whereIn('id', db('nivaro_help_videos').where({ id: video.id }).select('draft_version_id'))
    .update({ edits: JSON.stringify(edits), edits_hash: hash })
  if (!Number(updated)) {
    const fresh = await db('nivaro_help_videos').where({ id: video.id }).first('draft_version_id')
    const current = await loadVersion(fresh?.draft_version_id as string | null | undefined)
    throw fail(
      409,
      'HELP_VIDEO_EDITS_CONFLICT',
      'These edits changed in another tab — reload to continue',
      { current_hash: current?.edits_hash ?? null }
    )
  }
  await db('nivaro_help_videos').where({ id: video.id }).update(touch(user))
  return serializeVersion(
    { ...draft, edits: JSON.stringify(edits), edits_hash: hash },
    { withRecorderData: true }
  )
}

export async function publishVideo(
  video: VideoRow,
  user: User,
  opts: { watch_again?: boolean }
): Promise<string> {
  const draft = await loadVersion(video.draft_version_id)
  if (!draft) throw fail(409, 'HELP_VIDEO_NOTHING_TO_PUBLISH', 'There are no unpublished changes')
  const contextCount = Number(
    (await db('nivaro_help_video_contexts').where({ video_id: video.id }).count('* as n').first())
      ?.n ?? 0
  )
  const missing = publishChecklist(video, contextCount)
  if (missing.length) {
    throw fail(422, 'HELP_VIDEO_NOT_READY', 'Finish the checklist before publishing', { missing })
  }
  const edits = json<VideoEdits>(draft.edits, emptyEdits(0))
  const now = new Date()
  await db('nivaro_help_videos')
    .where({ id: video.id })
    .update({
      status: 'published',
      published_version_id: draft.id,
      draft_version_id: null,
      duration_ms: editedDuration(edits),
      ...(opts.watch_again ? { required_since: now } : {}),
      ...touch(user)
    })
  await queueRender(String(draft.id))
  await logActivity({
    action: 'help-video-publish',
    user: user.id,
    collection: 'nivaro_help_videos',
    item: low(video.id),
    comment: `version ${draft.version}${opts.watch_again ? ' · asked everyone to watch again' : ''}`
  })
  return String(draft.id)
}

export async function rerecordVideo(
  video: VideoRow,
  user: User,
  uploadId: string
): Promise<VersionDto> {
  const upload = await takeFinalizedUpload(user, uploadId)
  const id = await insertVersion(video.id, user, {
    source_file: upload.file_id,
    source_duration_ms: upload.duration_ms,
    width: upload.width,
    height: upload.height,
    clicks: upload.clicks,
    levels: upload.levels,
    edits: emptyEdits(upload.duration_ms ?? 0),
    note: 'Re-recorded'
  })
  await db('nivaro_help_videos')
    .where({ id: video.id })
    .update({ draft_version_id: id, ...touch(user) })
  await logActivity({
    action: 'help-video-rerecord',
    user: user.id,
    collection: 'nivaro_help_videos',
    item: low(video.id)
  })
  return serializeVersion((await loadVersion(id)) as VersionRow, { withRecorderData: true })
}

export async function restoreVersion(
  video: VideoRow,
  user: User,
  versionId: string
): Promise<VersionDto> {
  if (!isUuid(versionId)) throw fail(404, 'HELP_VIDEO_VERSION_NOT_FOUND', 'Version not found')
  const src = await db('nivaro_help_video_versions')
    .where({ id: versionId, video_id: video.id })
    .first()
  if (!src) throw fail(404, 'HELP_VIDEO_VERSION_NOT_FOUND', 'Version not found')
  const id = await insertVersion(video.id, user, {
    source_file: String(src.source_file),
    source_duration_ms: src.source_duration_ms == null ? null : Number(src.source_duration_ms),
    width: src.width == null ? null : Number(src.width),
    height: src.height == null ? null : Number(src.height),
    clicks: json(src.clicks, null),
    levels: json(src.levels, null),
    edits: json<VideoEdits>(src.edits, emptyEdits(0)),
    note: `Restored from version ${src.version}`
  })
  await db('nivaro_help_videos')
    .where({ id: video.id })
    .update({ draft_version_id: id, ...touch(user) })
  await logActivity({
    action: 'help-video-restore',
    user: user.id,
    collection: 'nivaro_help_videos',
    item: low(video.id),
    comment: `version ${src.version}`
  })
  return serializeVersion((await loadVersion(id)) as VersionRow, { withRecorderData: true })
}

export async function listVersions(
  video: VideoRow
): Promise<
  Array<VersionDto & { is_published: boolean; is_draft: boolean; created_by_name: string | null }>
> {
  const rows = await db('nivaro_help_video_versions as v')
    .leftJoin('nivaro_users as u', 'u.id', 'v.created_by')
    .where('v.video_id', video.id)
    .orderBy('v.version', 'desc')
    .select('v.*', 'u.first_name', 'u.last_name')
  return rows.map((r: Record<string, unknown>) => ({
    ...serializeVersion(r as VersionRow, { withRecorderData: false }),
    is_published: low(r.id) === low(video.published_version_id),
    is_draft: low(r.id) === low(video.draft_version_id),
    created_by_name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || null
  }))
}

export async function archiveVideo(video: VideoRow, user: User): Promise<void> {
  await db('nivaro_help_videos')
    .where({ id: video.id })
    .update({ status: 'archived', ...touch(user) })
  await logActivity({
    action: 'help-video-archive',
    user: user.id,
    collection: 'nivaro_help_videos',
    item: low(video.id)
  })
}

/** Admin-only hard delete: the video, its versions and every stored file. */
export async function purgeVideo(video: VideoRow, user: User): Promise<void> {
  const { deleteFile } = await import('./files.js')
  const versions = await db('nivaro_help_video_versions').where({ video_id: video.id })
  const fileIds = new Set<string>()
  if (video.poster_file) fileIds.add(String(video.poster_file))
  for (const v of versions) {
    for (const k of ['source_file', 'rendered_file', 'captions_file', 'poster_file']) {
      if (v[k]) fileIds.add(String(v[k]))
    }
  }
  await db('nivaro_help_videos')
    .where({ id: video.id })
    .update({ poster_file: null, published_version_id: null, draft_version_id: null })
  await db('nivaro_help_videos').where({ id: video.id }).delete()
  // The upload rows that produced these recordings still reference the files
  // (nivaro_help_video_uploads.file_id, status 'used'); drop them first or the
  // nivaro_files delete fails on that foreign key.
  if (fileIds.size) {
    await db('nivaro_help_video_uploads')
      .whereIn('file_id', [...fileIds])
      .delete()
  }
  for (const f of fileIds) {
    await deleteFile(f).catch((err: unknown) => {
      console.warn(
        `[help-videos] purge of ${low(video.id)} could not delete file ${f}:`,
        err instanceof Error ? err.message : err
      )
    })
  }
  await logActivity({
    action: 'help-video-delete',
    user: user.id,
    collection: 'nivaro_help_videos',
    item: low(video.id)
  })
}

export function rankForContext(
  rows: Array<{ video_id: string; kind: string; key: string; state_key: string | null }>,
  q: { collection?: string; state?: string | null; page?: string }
): string[] {
  const best = new Map<string, { rank: number; order: number }>()
  rows.forEach((r, order) => {
    let rank: number | null = null
    if (r.kind === 'collection' && q.collection && r.key === q.collection) {
      if (r.state_key) rank = q.state && r.state_key === q.state ? 0 : null
      else rank = 1
    } else if (r.kind === 'page' && q.page && r.key === q.page) {
      rank = 2
    }
    if (rank === null) return
    const id = low(r.video_id)
    const prev = best.get(id)
    if (!prev || rank < prev.rank)
      best.set(id, { rank, order: prev ? Math.min(prev.order, order) : order })
  })
  return [...best.entries()]
    .sort((a, b) => a[1].rank - b[1].rank || a[1].order - b[1].order)
    .map(([id]) => id.toUpperCase())
}

export async function videosForContext(
  req: FastifyRequest,
  q: { collection?: string; item?: string; state?: string; page?: string }
): Promise<{ data: HelpVideoDto[]; can_author: boolean; state: string | null }> {
  const author = await isAuthor(req.user!, !!req.isAdmin)
  let state = q.state ?? null
  if (!state && q.collection && q.item) {
    // A record's pipeline state is record data: read the record AS THE CALLER
    // first (RBAC, row filter, user scopes). readOne answers null — not an
    // error — for a row the caller cannot see; unreadable = no state, so only
    // the collection-wide and page videos match.
    const { readOne } = await import('./items.js')
    const visible = await readOne(req.user!, q.collection, q.item, req.workspaceId ?? undefined, [
      'id'
    ]).catch(() => null)
    if (visible) {
      const { findRecordInstance } = await import('./branch-instances.js')
      type WithState = InstanceIdentity & { current_state: string | null }
      const inst = await findRecordInstance<WithState>(q.collection, q.item).catch(() => undefined)
      if (inst?.current_state) {
        const s = await db('nivaro_workflow_states').where({ id: inst.current_state }).first('key')
        state = s?.key ?? null
      }
    }
  }
  if (!q.collection && !q.page) return { data: [], can_author: author, state }
  const qb = db('nivaro_help_video_contexts').select('video_id', 'kind', 'key', 'state_key')
  qb.where((w) => {
    if (q.collection) w.orWhere((x) => x.where({ kind: 'collection', key: q.collection }))
    if (q.page) w.orWhere((x) => x.where({ kind: 'page', key: q.page }))
  })
  const ids = rankForContext(await qb, { collection: q.collection, state, page: q.page })
  if (!ids.length) return { data: [], can_author: author, state }
  const videos = (await db('nivaro_help_videos').whereIn('id', ids)) as VideoRow[]
  const byId = new Map(videos.map((v) => [up(v.id), v]))
  const shown = ids
    .map((id) => byId.get(id))
    .filter(
      (v): v is VideoRow =>
        !!v && v.status === 'published' && viewerMaySee(v, req.user!.role, false)
    )
  const data = await Promise.all(
    shown.map((v) =>
      serializeVideo(v, { author: false, userId: req.user!.id, role: req.user!.role ?? null })
    )
  )
  return { data, can_author: author, state }
}

export async function listVideos(
  req: FastifyRequest,
  q: { search?: string; category?: string; status?: string; page?: number; limit?: number }
): Promise<{ data: HelpVideoDto[]; total: number; categories: string[]; can_author: boolean }> {
  const author = await isAuthor(req.user!, !!req.isAdmin)
  const limit = Math.min(Math.max(Number(q.limit) || 24, 1), 100)
  const page = Math.max(Number(q.page) || 1, 1)
  const status =
    author && ['draft', 'published', 'archived'].includes(String(q.status))
      ? String(q.status)
      : 'published'
  const base = db('nivaro_help_videos').where({ status })
  if (q.category) base.where({ category: String(q.category) })
  if (q.search) {
    const s = `%${String(q.search).replace(/[%_[]/g, (c) => `[${c}]`)}%`
    base.where((w) => w.where('title', 'like', s).orWhere('description', 'like', s))
  }
  const rows = (await base.clone().orderBy('title', 'asc')) as VideoRow[]
  const visible = rows.filter((v) => viewerMaySee(v, req.user!.role, author))
  const pageRows = visible.slice((page - 1) * limit, page * limit)
  const data = await Promise.all(
    pageRows.map((v) =>
      serializeVideo(v, { author, userId: req.user!.id, role: req.user!.role ?? null })
    )
  )
  const cats = await db('nivaro_help_videos')
    .where({ status: 'published' })
    .whereNotNull('category')
    .select('category')
  const categories = [...new Set(cats.map((c) => String(c.category)))].sort()
  return { data, total: visible.length, categories, can_author: author }
}

const pageWrites = new Map<string, number>()
export async function registerPage(key: string, label: string, app: string | null): Promise<void> {
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(key)) throw fail(400, 'HELP_VIDEO_PAGE', 'Invalid page key')
  const last = pageWrites.get(key) ?? 0
  if (Date.now() - last < 10 * 60_000) return
  pageWrites.set(key, Date.now())
  const row = {
    label: String(label || key).slice(0, 200),
    app: app ? String(app).slice(0, 50) : null,
    last_seen: new Date()
  }
  const updated = await db('nivaro_help_video_pages').where({ key }).update(row)
  if (!updated)
    await db('nivaro_help_video_pages')
      .insert({ key, ...row })
      .catch(() => null)
}

export async function listPages(): Promise<
  Array<{ key: string; label: string; app: string | null }>
> {
  return db('nivaro_help_video_pages').orderBy('label', 'asc').select('key', 'label', 'app')
}
