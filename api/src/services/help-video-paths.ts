import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import {
  fanOutToRoles,
  type HelpVideoDto,
  isAuthor,
  isUuid,
  requiredNotice,
  serializeVideo,
  sessionTag,
  type VideoRow,
  viewerMaySee
} from './help-videos.js'
import { getApp } from './io-holder.js'

// Learning paths (#1508): an ordered list of videos ("Getting started as a
// Workflow Creator") assigned to roles, with a New User switch for people who
// just got their account. Progress is derived from nivaro_help_video_views
// through each video's my_progress — there is no progress table — and a path
// is finished when every published video in it that the person may see is
// completed. A path marked required for a role joins the required list like
// a single required video (one entry per path, with the next video to watch).

export type PathStatus = 'draft' | 'published'

export type PathRow = Record<string, unknown> & {
  id: string
  title: string
  description: string | null
  status: string
  new_user: boolean | number | null
  created_at: string | Date
  updated_at: string | Date
}

export interface HelpVideoPathItemDto {
  video_id: string
  position: number
  title: string
  status: string
  duration_ms: number | null
}
export interface HelpVideoPathRoleDto {
  role_id: string
  required: boolean
}
/** A path as authors see it (GET /help-videos/paths). */
export interface HelpVideoPathDto {
  id: string
  title: string
  description: string | null
  status: PathStatus
  new_user: boolean
  items: HelpVideoPathItemDto[]
  roles: HelpVideoPathRoleDto[]
  created_at: string
  updated_at: string
}
export interface PathProgress {
  total: number
  completed: number
  percent: number
  finished: boolean
}
/** A path as the person it is for sees it (GET /help-videos/paths/mine). */
export interface MyLearningPathDto {
  id: string
  title: string
  description: string | null
  /** Required for THIS person's role. */
  required: boolean
  /** Shown because the person is new to the instance (not because of a role). */
  new_user: boolean
  /** In order; only the published videos this person may watch. */
  videos: HelpVideoDto[]
  progress: PathProgress
  /** The first unfinished video, or null once the path is finished. */
  next_video_id: string | null
}

const up = (v: unknown) => String(v ?? '').toUpperCase()
const low = (v: unknown) => String(v ?? '').toLowerCase()
function fail(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}

export const PATH_LIMITS = {
  title: 200,
  description: 2000,
  videos: 100,
  roles: 50
} as const

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** The details of a path from a request body. At create every field has a
 *  default (a title is still needed); on a patch only the keys given change.
 *  400 HELP_VIDEO_PATH_INVALID for anything out of shape. */
export function parsePathDetails(
  body: unknown,
  mode: 'create' | 'patch'
): Partial<{
  title: string
  description: string | null
  status: PathStatus
  new_user: boolean
}> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const out: ReturnType<typeof parsePathDetails> = {}
  if (b.title !== undefined || mode === 'create') {
    const title = String(b.title ?? '').trim()
    if (!title) throw fail(400, 'HELP_VIDEO_PATH_INVALID', 'A path needs a title')
    if (title.length > PATH_LIMITS.title) {
      throw fail(
        400,
        'HELP_VIDEO_PATH_INVALID',
        `The title can be at most ${PATH_LIMITS.title} characters`
      )
    }
    out.title = title
  }
  if (b.description !== undefined) {
    if (b.description !== null && typeof b.description !== 'string') {
      throw fail(400, 'HELP_VIDEO_PATH_INVALID', 'description must be text')
    }
    const d = b.description == null ? '' : b.description.trim()
    if (d.length > PATH_LIMITS.description) {
      throw fail(
        400,
        'HELP_VIDEO_PATH_INVALID',
        `The description can be at most ${PATH_LIMITS.description} characters`
      )
    }
    out.description = d || null
  } else if (mode === 'create') out.description = null
  if (b.status !== undefined) {
    if (b.status !== 'draft' && b.status !== 'published') {
      throw fail(400, 'HELP_VIDEO_PATH_INVALID', 'status must be draft or published')
    }
    out.status = b.status
  } else if (mode === 'create') out.status = 'draft'
  if (b.new_user !== undefined) {
    if (typeof b.new_user !== 'boolean') {
      throw fail(400, 'HELP_VIDEO_PATH_INVALID', 'new_user must be true or false')
    }
    out.new_user = b.new_user
  } else if (mode === 'create') out.new_user = false
  return out
}

/** The ordered video ids of a path: exact uuids only, each once, in the order
 *  given, at most PATH_LIMITS.videos. 400 when not a list. */
export function parseVideoIds(input: unknown): string[] {
  if (!Array.isArray(input)) throw fail(400, 'HELP_VIDEO_PATH_INVALID', 'video_ids must be a list')
  const out: string[] = []
  for (const raw of input) {
    if (!isUuid(raw)) continue
    const id = up(raw)
    if (!out.includes(id)) out.push(id)
  }
  if (out.length > PATH_LIMITS.videos) {
    throw fail(
      400,
      'HELP_VIDEO_PATH_INVALID',
      `A path can hold at most ${PATH_LIMITS.videos} videos`
    )
  }
  return out
}

/** The roles of a path: `[{ role_id, required }]` (a bare id reads as not
 *  required). Exact uuids only, each once (the first mention wins). */
export function parsePathRoles(input: unknown): HelpVideoPathRoleDto[] {
  if (!Array.isArray(input)) throw fail(400, 'HELP_VIDEO_PATH_INVALID', 'roles must be a list')
  const out: HelpVideoPathRoleDto[] = []
  for (const raw of input) {
    const id = typeof raw === 'string' ? raw : (raw as { role_id?: unknown })?.role_id
    if (!isUuid(id)) continue
    const role_id = up(id)
    if (out.some((r) => r.role_id === role_id)) continue
    const required =
      typeof raw === 'object' && raw !== null && (raw as { required?: unknown }).required === true
    out.push({ role_id, required })
  }
  if (out.length > PATH_LIMITS.roles) {
    throw fail(400, 'HELP_VIDEO_PATH_INVALID', `A path can name at most ${PATH_LIMITS.roles} roles`)
  }
  return out
}

/** How far along a person is: counts the videos given (the published ones
 *  they may see), finished when all of them are completed. No videos = not
 *  finished, nothing to do. */
export function pathProgress(videos: Array<{ completed: boolean }>): PathProgress {
  const total = videos.length
  const completed = videos.filter((v) => v.completed).length
  return {
    total,
    completed,
    percent: total ? Math.round((completed / total) * 100) : 0,
    finished: total > 0 && completed === total
  }
}

/** The first video in order that is not completed, or null. */
export function nextVideoId(videos: Array<{ id: string; completed: boolean }>): string | null {
  return videos.find((v) => !v.completed)?.id ?? null
}

/** Seven days, the same window the first-week guide (dashboard-feed
 *  onboardingState) uses to call an account new. */
export const NEW_ACCOUNT_WINDOW_MS = 7 * 86_400_000

/** A "New User": their role is the instance's provisional new-user role
 *  (nivaro_settings.new_user_role, the seat a first sign-in starts in), or
 *  the account was created in the last seven days. */
export function isNewAccount(
  user: { role: string | null; created_at: Date | string | null | undefined },
  newUserRole: string | null | undefined,
  now = Date.now()
): boolean {
  if (newUserRole && user.role && up(newUserRole) === up(user.role)) return true
  if (!user.created_at) return false
  const made = new Date(user.created_at as string).getTime()
  return Number.isFinite(made) && now - made <= NEW_ACCOUNT_WINDOW_MS
}

/** The required list: single required videos plus the required paths that
 *  are not finished. A video inside such a path is listed under the path only
 *  (one entry per path, with its next video), never twice. */
export function splitRequired<V extends { id: string }, P extends MyLearningPathDto>(
  videos: V[],
  paths: P[]
): { data: V[]; paths: P[] } {
  const due = paths.filter((p) => p.required && !p.progress.finished)
  const covered = new Set(due.flatMap((p) => p.videos.map((v) => low(v.id))))
  return { data: videos.filter((v) => !covered.has(low(v.id))), paths: due }
}

/** Unfinished paths first (required before the rest), then by title. */
export function sortMyPaths<P extends MyLearningPathDto>(paths: P[]): P[] {
  return [...paths].sort((a, b) => {
    if (a.progress.finished !== b.progress.finished) return a.progress.finished ? 1 : -1
    if (a.required !== b.required) return a.required ? -1 : 1
    return a.title.localeCompare(b.title)
  })
}

// ── Authoring ────────────────────────────────────────────────────────────────

function touch(user: User): Record<string, unknown> {
  return { updated_by: user.id, updated_at: new Date() }
}

export async function loadPath(id: string): Promise<PathRow> {
  if (!isUuid(id)) throw fail(404, 'HELP_VIDEO_PATH_NOT_FOUND', 'Learning path not found')
  const row = (await db('nivaro_help_video_paths').where({ id }).first()) as PathRow | undefined
  if (!row) throw fail(404, 'HELP_VIDEO_PATH_NOT_FOUND', 'Learning path not found')
  return row
}

async function itemsOf(pathIds: string[]): Promise<Map<string, HelpVideoPathItemDto[]>> {
  const out = new Map<string, HelpVideoPathItemDto[]>()
  if (!pathIds.length) return out
  const rows = (await db('nivaro_help_video_path_items as i')
    .join('nivaro_help_videos as v', 'v.id', 'i.video_id')
    .whereIn('i.path_id', pathIds)
    .orderBy([
      { column: 'i.path_id', order: 'asc' },
      { column: 'i.position', order: 'asc' }
    ])
    .select(
      'i.path_id',
      'i.video_id',
      'i.position',
      'v.title',
      'v.status',
      'v.duration_ms'
    )) as Array<Record<string, unknown>>
  for (const r of rows) {
    const key = up(r.path_id)
    const list = out.get(key) ?? []
    list.push({
      video_id: low(r.video_id),
      position: Number(r.position ?? list.length),
      title: String(r.title ?? ''),
      status: String(r.status ?? ''),
      duration_ms: r.duration_ms == null ? null : Number(r.duration_ms)
    })
    out.set(key, list)
  }
  return out
}

async function rolesOf(pathIds: string[]): Promise<Map<string, HelpVideoPathRoleDto[]>> {
  const out = new Map<string, HelpVideoPathRoleDto[]>()
  if (!pathIds.length) return out
  const rows = (await db('nivaro_help_video_path_roles')
    .whereIn('path_id', pathIds)
    .select('path_id', 'role_id', 'required')) as Array<Record<string, unknown>>
  for (const r of rows) {
    const key = up(r.path_id)
    const list = out.get(key) ?? []
    list.push({ role_id: up(r.role_id), required: !!r.required })
    out.set(key, list)
  }
  return out
}

function serializePathRow(
  row: PathRow,
  items: HelpVideoPathItemDto[],
  roles: HelpVideoPathRoleDto[]
): HelpVideoPathDto {
  return {
    id: low(row.id),
    title: String(row.title ?? ''),
    description: (row.description as string | null) ?? null,
    status: row.status === 'published' ? 'published' : 'draft',
    new_user: !!row.new_user,
    items,
    roles,
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString()
  }
}

export async function serializePath(row: PathRow): Promise<HelpVideoPathDto> {
  const key = up(row.id)
  const [items, roles] = await Promise.all([itemsOf([row.id]), rolesOf([row.id])])
  return serializePathRow(row, items.get(key) ?? [], roles.get(key) ?? [])
}

export async function listPaths(): Promise<HelpVideoPathDto[]> {
  const rows = (await db('nivaro_help_video_paths').orderBy('title', 'asc')) as PathRow[]
  const ids = rows.map((r) => r.id)
  const [items, roles] = await Promise.all([itemsOf(ids), rolesOf(ids)])
  return rows.map((r) => serializePathRow(r, items.get(up(r.id)) ?? [], roles.get(up(r.id)) ?? []))
}

export async function createPath(user: User, body: unknown): Promise<string> {
  const details = parsePathDetails(body, 'create')
  const id = randomUUID()
  const now = new Date()
  await db('nivaro_help_video_paths').insert({
    id,
    title: details.title,
    description: details.description ?? null,
    status: details.status ?? 'draft',
    new_user: details.new_user ?? false,
    created_by: user.id,
    updated_by: user.id,
    created_at: now,
    updated_at: now
  })
  await logActivity({
    action: 'help-video-path-create',
    user: user.id,
    collection: 'nivaro_help_video_paths',
    item: low(id),
    comment: String(details.title).slice(0, 100)
  })
  return id
}

/** Changes the details; answers the roles that became newly required by a
 *  draft → published change (the caller tells those people). */
export async function updatePath(
  row: PathRow,
  user: User,
  body: unknown
): Promise<{ published_now: boolean }> {
  const details = parsePathDetails(body, 'patch')
  await db('nivaro_help_video_paths')
    .where({ id: row.id })
    .update({ ...details, ...touch(user) })
  const publishedNow = details.status === 'published' && row.status !== 'published'
  await logActivity({
    action: 'help-video-path-update',
    user: user.id,
    collection: 'nivaro_help_video_paths',
    item: low(row.id),
    comment: publishedNow ? 'published' : Object.keys(details).join(', ')
  })
  return { published_now: publishedNow }
}

/** Replaces the ordered video list. Only videos that exist are kept, in the
 *  order given; an archived video stays listed (it simply does not count for
 *  anyone until it is published again). */
export async function replacePathItems(row: PathRow, user: User, input: unknown): Promise<void> {
  const wanted = parseVideoIds(input)
  const known = wanted.length
    ? new Set(
        (await db('nivaro_help_videos').whereIn('id', wanted).select('id')).map(
          (r: { id: unknown }) => up(r.id)
        )
      )
    : new Set<string>()
  const kept = wanted.filter((id) => known.has(id))
  await db.transaction(async (trx) => {
    await trx('nivaro_help_video_path_items').where({ path_id: row.id }).delete()
    if (kept.length) {
      await trx('nivaro_help_video_path_items').insert(
        kept.map((video_id, position) => ({ path_id: row.id, video_id, position }))
      )
    }
    await trx('nivaro_help_video_paths').where({ id: row.id }).update(touch(user))
  })
}

/** Replaces the roles; answers the roles that are required now and were not
 *  before (the caller notifies them when the path is published). Only roles
 *  that exist are kept. */
export async function replacePathRoles(
  row: PathRow,
  user: User,
  input: unknown
): Promise<{ added_required: string[] }> {
  const wanted = parsePathRoles(input)
  const known = wanted.length
    ? new Set(
        (
          await db('nivaro_roles')
            .whereIn(
              'id',
              wanted.map((r) => r.role_id)
            )
            .select('id')
        ).map((r: { id: unknown }) => up(r.id))
      )
    : new Set<string>()
  const kept = wanted.filter((r) => known.has(r.role_id))
  const before = (
    await db('nivaro_help_video_path_roles')
      .where({ path_id: row.id })
      .select('role_id', 'required')
  )
    .filter((r: { required: unknown }) => !!r.required)
    .map((r: { role_id: unknown }) => up(r.role_id))
  await db.transaction(async (trx) => {
    await trx('nivaro_help_video_path_roles').where({ path_id: row.id }).delete()
    if (kept.length) {
      await trx('nivaro_help_video_path_roles').insert(
        kept.map((r) => ({ path_id: row.id, role_id: r.role_id, required: r.required }))
      )
    }
    await trx('nivaro_help_video_paths').where({ id: row.id }).update(touch(user))
  })
  return {
    added_required: kept
      .filter((r) => r.required && !before.includes(r.role_id))
      .map((r) => r.role_id)
  }
}

export async function deletePath(row: PathRow, user: User): Promise<void> {
  await db.transaction(async (trx) => {
    await trx('nivaro_help_video_path_roles').where({ path_id: row.id }).delete()
    await trx('nivaro_help_video_path_items').where({ path_id: row.id }).delete()
    await trx('nivaro_help_video_paths').where({ id: row.id }).delete()
  })
  await logActivity({
    action: 'help-video-path-delete',
    user: user.id,
    collection: 'nivaro_help_video_paths',
    item: low(row.id),
    comment: String(row.title ?? '').slice(0, 100)
  })
}

/** The roles a published path requires right now (for notifications). */
export async function requiredRolesOf(pathId: string): Promise<string[]> {
  const rows = await db('nivaro_help_video_path_roles')
    .where({ path_id: pathId, required: true })
    .select('role_id')
  return rows.map((r: { role_id: unknown }) => up(r.role_id))
}

/** Tells everyone in the roles that this path is required for them. A
 *  failure is logged, never thrown (callers fire and forget). */
export async function notifyRequiredPathViewersSafely(
  pathId: string,
  title: string,
  roleIds: string[]
): Promise<number> {
  try {
    const text = requiredNotice(title || 'Untitled path', { path: true })
    return await fanOutToRoles(roleIds, text, {
      kind: 'help-video-path',
      label: (title || 'Untitled path').slice(0, 250),
      id: low(pathId)
    })
  } catch (err) {
    const app: any = getApp()
    app?.log?.warn?.({ err, pathId: low(pathId) }, 'help video path required notify failed')
    return 0
  }
}

// ── Watching ─────────────────────────────────────────────────────────────────

async function isNewUser(user: User): Promise<boolean> {
  const [settings, row] = await Promise.all([
    db('nivaro_settings')
      .where({ id: 1 })
      .first('new_user_role')
      .catch(() => null) as Promise<{ new_user_role?: string | null } | null>,
    db('nivaro_users')
      .where({ id: user.id })
      .first('created_at')
      .catch(() => null) as Promise<{ created_at?: Date | string | null } | null>
  ])
  return isNewAccount(
    { role: user.role ?? null, created_at: row?.created_at ?? null },
    settings?.new_user_role ?? null
  )
}

/**
 * The published paths for this person — those assigned to their role, plus
 * the New User paths while their account is new — each with only the
 * published videos they may watch, in order, with progress and the next
 * unfinished video. Unfinished paths first.
 */
export async function pathsForUser(req: FastifyRequest): Promise<MyLearningPathDto[]> {
  const user = req.user!
  const role = user.role ?? null
  const author = await isAuthor(user, !!req.isAdmin)
  const byRole = role
    ? ((await db('nivaro_help_video_path_roles')
        .where({ role_id: role })
        .select('path_id', 'required')) as Array<{ path_id: unknown; required: unknown }>)
    : []
  const requiredPaths = new Set(byRole.filter((r) => !!r.required).map((r) => up(r.path_id)))
  const rolePathIds = [...new Set(byRole.map((r) => up(r.path_id)))]
  const newUser = await isNewUser(user)
  const qb = db('nivaro_help_video_paths').where({ status: 'published' })
  if (newUser && rolePathIds.length) {
    qb.where((w) => w.whereIn('id', rolePathIds).orWhere({ new_user: true }))
  } else if (newUser) qb.where({ new_user: true })
  else if (rolePathIds.length) qb.whereIn('id', rolePathIds)
  else return []
  const rows = (await qb.select()) as PathRow[]
  if (!rows.length) return []
  const items = await itemsOf(rows.map((r) => r.id))
  const videoIds = [
    ...new Set([...items.values()].flatMap((list) => list.map((i) => up(i.video_id))))
  ]
  const videos = videoIds.length
    ? ((await db('nivaro_help_videos').whereIn('id', videoIds)) as VideoRow[])
    : []
  const visible = new Map<string, VideoRow>()
  for (const v of videos) {
    if (v.status === 'published' && viewerMaySee(v, role, author)) visible.set(up(v.id), v)
  }
  const dtos = new Map<string, HelpVideoDto>()
  const ctx = { author, userId: user.id, role, sidTag: sessionTag(req) }
  await Promise.all(
    [...visible.entries()].map(async ([key, v]) => {
      dtos.set(key, await serializeVideo(v, ctx))
    })
  )
  const out: MyLearningPathDto[] = rows.map((row) => {
    const key = up(row.id)
    const list = (items.get(key) ?? [])
      .map((i) => dtos.get(up(i.video_id)))
      .filter((v): v is HelpVideoDto => !!v)
    const marks = list.map((v) => ({ id: v.id, completed: !!v.my_progress?.completed }))
    return {
      id: low(row.id),
      title: String(row.title ?? ''),
      description: (row.description as string | null) ?? null,
      required: requiredPaths.has(key),
      new_user: !rolePathIds.includes(key) && !!row.new_user,
      videos: list,
      progress: pathProgress(marks),
      next_video_id: nextVideoId(marks)
    }
  })
  return sortMyPaths(out)
}
