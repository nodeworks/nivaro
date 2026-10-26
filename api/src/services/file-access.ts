import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { extractFileIds } from './config-review/pure.js'
import {
  adminAuthors,
  type FileAttribution,
  fileAttributions,
  recordSite
} from './file-attribution.js'
import { getFileRefColumns } from './file-usage.js'
import { viewerMaySeeFile } from './private-files.js'
import { isSystemCollection } from './system-collections.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Who may read or change a stored file (army 2026-10-25: any signed-in user
 * could replace, rename or delete any of the 145k files, and download any
 * record's attachment).
 *
 * A file attached to business records follows those records. Reading it needs
 * ONE of them readable as the caller (readOne: row filter, User Scopes, tree
 * permission); renaming, replacing or deleting it needs EVERY one of them
 * updatable by the caller (canUpdateItem) and not edit-locked (the approval
 * edit lock covers a record's file links). The uploader reads their own file;
 * administrators pass. A file no FK-linked record grants is judged by where
 * it is used without a foreign key (file-attribution.ts): a chat attachment by
 * its room, a ticket attachment by its ticket, an addendum attachment, a
 * comment link or a rich-text image by its record, a clip poster by its clip,
 * an avatar or configuration image by anyone signed in — each use counting
 * only when its author uploaded the file or is an administrator, and only for
 * a file with no FK reference at all. A file used nowhere —
 * an upload whose record is not saved yet — reads for its uploader and
 * administrators only, and only they change it.
 *
 * "References" = the FK sites file-usage.ts finds (sys.foreign_keys into
 * nivaro_files) on registered, non-system collections. A junction leg
 * (nivaro_relations row with junction_field) stands for its parent record.
 */

export interface FileRecordRef {
  collection: string
  id: string
}

interface RefSite {
  table: string
  column: string
  /** The collection a matching row stands for, and the column holding its id. */
  record: string
  recordColumn: string
}

/** One record collection can hold the same file many times; past this many
 *  references a non-admin is refused a change rather than judged row by row. */
const MAX_REFS = 50
const SITE_TTL_MS = 60_000
const siteCache = new Map<string, { at: number; sites: RefSite[] }>()

async function refSites(): Promise<RefSite[]> {
  const key = currentTenantKey()
  const hit = siteCache.get(key)
  if (hit && Date.now() - hit.at < SITE_TTL_MS) return hit.sites
  const refs = (await getFileRefColumns()).filter((r) => !isSystemCollection(r.table))
  const sites: RefSite[] = []
  for (const ref of refs) {
    const site = await recordSite(ref.table, ref.column)
    if (site) sites.push({ ...ref, ...site })
  }
  siteCache.set(key, { at: Date.now(), sites })
  return sites
}

/** fileRecordRefs' answer: `failed` = some reference site could not be read,
 *  so a file listed with no refs may still have some (callers deny on it). */
export type FileRecordRefMap = Map<string, FileRecordRef[]> & { failed: boolean }

/** The business records that reference each file (lower-cased file id → refs). */
export async function fileRecordRefs(fileIds: string[]): Promise<FileRecordRefMap> {
  const out: FileRecordRefMap = Object.assign(new Map<string, FileRecordRef[]>(), {
    failed: false
  })
  const ids = [...new Set(fileIds.map((i) => String(i)))]
  if (ids.length === 0) return out
  let sites: RefSite[] = []
  try {
    sites = await refSites()
  } catch {
    out.failed = true
    return out
  }
  for (const site of sites) {
    let rows: Array<{ f: unknown; r: unknown }> = []
    try {
      rows = (await db(site.table)
        .whereIn(site.column, ids)
        .whereNotNull(site.recordColumn)
        .select({ f: site.column, r: site.recordColumn })
        .limit(MAX_REFS * ids.length)) as Array<{ f: unknown; r: unknown }>
    } catch {
      out.failed = true
      continue
    }
    for (const row of rows) {
      const k = String(row.f).toLowerCase()
      const list = out.get(k) ?? []
      if (!list.some((x) => x.collection === site.record && x.id === String(row.r)))
        list.push({ collection: site.record, id: String(row.r) })
      out.set(k, list)
    }
  }
  return out
}

type FileRow = { id: unknown; uploaded_by?: unknown; uploaded_on?: unknown }
type Caller = Pick<FastifyRequest, 'user' | 'isAdmin' | 'workspaceId'>

function isUploader(file: FileRow, user: User | null | undefined): boolean {
  return (
    !!user?.id &&
    !!file.uploaded_by &&
    String(file.uploaded_by).toLowerCase() === String(user.id).toLowerCase()
  )
}

/** May the caller read this file's bytes and metadata? */
export async function mayReadFile(file: FileRow, req: Caller): Promise<boolean> {
  if (req.isAdmin) return (await adminReadable([file], req, 0)).size > 0
  const user = req.user
  if (!user) return false
  if (isUploader(file, user)) return true
  const found = await fileRecordRefs([String(file.id)])
  const refs = found.get(String(file.id).toLowerCase()) ?? []
  const { readOne } = await import('./items.js')
  for (const ref of refs.slice(0, MAX_REFS)) {
    const row = await readOne(user, ref.collection, ref.id, req.workspaceId ?? undefined, [
      'id'
    ]).catch(() => null)
    if (row) return true
  }
  // A file with any FK reference is judged by those records alone: a pasted id
  // elsewhere never widens it.
  // Unknown whether it has FK refs: deny rather than judge it as unreferenced.
  if (refs.length > 0 || found.failed) return false
  return (await grantedWithoutFk([file], req, 0)).size > 0
}

/** The lower-cased ids (of those given) the caller may read — the batch form
 *  of mayReadFile for lists and per-page lookups. */
export async function readableFileIds(files: FileRow[], req: Caller): Promise<Set<string>> {
  return readableSet(files, req, 0)
}

async function readableSet(files: FileRow[], req: Caller, depth: number): Promise<Set<string>> {
  const out = new Set<string>()
  if (req.isAdmin) return adminReadable(files, req, depth)
  const user = req.user
  if (!user) return out
  const refs = await fileRecordRefs(files.map((f) => String(f.id)))
  const pending: Array<{ file: string; refs: FileRecordRef[] }> = []
  for (const f of files) {
    const k = String(f.id).toLowerCase()
    const list = refs.get(k) ?? []
    if (isUploader(f, user)) out.add(k)
    else if (list.length > 0) pending.push({ file: k, refs: list })
  }
  const visible = await visibleRefs(
    user,
    pending.flatMap((p) => p.refs)
  )
  for (const p of pending) {
    if (p.refs.some((r) => visible.has(refKey(r)))) out.add(p.file)
  }
  // Only files with no FK reference at all are judged by where else they are named.
  const rest = refs.failed
    ? []
    : files.filter((f) => {
        const k = String(f.id).toLowerCase()
        return !out.has(k) && !refs.get(k)?.length
      })
  for (const id of await grantedWithoutFk(rest, req, depth)) out.add(id)
  return out
}

const refKey = (r: FileRecordRef) => `${r.collection}\u0001${r.id.toLowerCase()}`

/** The refs (keyed by refKey) the caller may open: one gate compile + one
 *  batched read per collection. */
async function visibleRefs(user: User, refs: FileRecordRef[]): Promise<Set<string>> {
  const visible = new Set<string>()
  if (refs.length === 0) return visible
  const byCollection = new Map<string, Set<string>>()
  for (const r of refs) {
    const set = byCollection.get(r.collection) ?? new Set<string>()
    set.add(r.id)
    byCollection.set(r.collection, set)
  }
  const { visibleRecordIds } = await import('./socket-access.js')
  for (const [collection, ids] of byCollection) {
    for (const id of await visibleRecordIds(user, collection, [...ids], false))
      visible.add(refKey({ collection, id: String(id) }))
  }
  return visible
}

/**
 * The lower-cased ids (of these files, none granted by an FK-linked record)
 * the caller may read through where they are used without a foreign key. A
 * file used nowhere is granted to no one here.
 */
async function grantedWithoutFk(
  files: FileRow[],
  req: Caller,
  depth: number
): Promise<Set<string>> {
  // A failed lookup grants nothing (deny, never 500, never allow).
  return grantedWithoutFkInner(files, req, depth).catch(() => new Set<string>())
}

async function grantedWithoutFkInner(
  files: FileRow[],
  req: Caller,
  depth: number
): Promise<Set<string>> {
  const out = new Set<string>()
  const user = req.user
  if (!user || files.length === 0) return out
  const { counted: attrs } = await countedAttributions(files)
  if (attrs.size === 0) return out
  const all = [...attrs.values()].flat()
  const of = <K extends FileAttribution['kind']>(kind: K) =>
    all.filter((a): a is Extract<FileAttribution, { kind: K }> => a.kind === kind)

  const records = await visibleRefs(
    user,
    of('record').map((a) => ({ collection: a.collection, id: a.id }))
  )
  const rooms = new Set<string>()
  const roomList = [...new Set(of('room').map((a) => a.room))]
  if (roomList.length > 0) {
    const { canSeeRoom, newRoomVisibilityCache } = await import('./chat.js')
    const cache = newRoomVisibilityCache()
    for (const room of roomList)
      if (await canSeeRoom(user, room, cache).catch(() => false)) rooms.add(room)
  }
  const tickets = new Set<number>()
  const ticketIds = [...new Set(of('ticket').map((a) => a.id))].filter(Number.isSafeInteger)
  if (ticketIds.length > 0) {
    const { canSeeTicket } = await import('./support-tickets.js')
    const rows = (await db('nivaro_tasks')
      .whereIn('id', ticketIds)
      .select('id', 'created_by', 'assignee', 'team_id')
      .catch(() => [])) as Array<Parameters<typeof canSeeTicket>[1]>
    const viewer = { id: String(user.id).toUpperCase(), isAdmin: false }
    for (const t of rows)
      if (await canSeeTicket(viewer, t).catch(() => false)) tickets.add(Number(t.id))
  }
  // A clip's poster reads with the clip (one level: a poster of a poster is not followed).
  const clips =
    depth === 0 && of('poster').length > 0
      ? await readableFileIdList([...new Set(of('poster').map((a) => a.of))], req, depth + 1)
      : new Set<string>()

  const grants = (a: FileAttribution): boolean => {
    switch (a.kind) {
      case 'shared':
        return true
      case 'record':
        return records.has(refKey(a))
      case 'room':
        return rooms.has(a.room)
      case 'ticket':
        return tickets.has(a.id)
      case 'poster':
        return clips.has(a.of.toLowerCase())
    }
  }
  for (const f of files) {
    const list = attrs.get(String(f.id).toUpperCase()) ?? []
    if (list.some(grants)) out.add(String(f.id).toLowerCase())
  }
  return out
}

/** Does this use of a file count? `table` = an admin-only table; otherwise its
 *  last writer (`by`) uploaded the file, or — `author` only — every writer in
 *  `adminIf` is an administrator. An unknown writer never counts. */
export function attributionCounts(
  a: Pick<FileAttribution, 'by' | 'trust' | 'adminIf'>,
  uploader: string | null,
  admins: Set<string>
): boolean {
  if (a.trust === 'table') return true
  if (!a.by) return false
  if (uploader && a.by === uploader.toUpperCase()) return true
  return a.trust === 'author' && !!a.adminIf?.length && a.adminIf.every((x) => admins.has(x))
}

/** Every use of these files (upper-cased id → uses), and the ones that count. */
async function countedAttributions(files: FileRow[]): Promise<{
  all: Map<string, FileAttribution[]>
  counted: Map<string, FileAttribution[]>
  /** Sources that could not be read: what they would say is unknown. */
  incomplete: Set<string>
}> {
  const all = await fileAttributions(files)
  const incomplete = all.incomplete ?? new Set<string>()
  const counted = new Map<string, FileAttribution[]>()
  if (all.size === 0) return { all, counted, incomplete }
  // A use counts only as far as whoever wrote it could share the file.
  const uploaderOf = new Map(
    files.map((f) => [
      String(f.id).toUpperCase(),
      f.uploaded_by ? String(f.uploaded_by).toUpperCase() : null
    ])
  )
  const writers = [...all.values()].flat().flatMap((a) => a.adminIf ?? [])
  const admins = writers.length > 0 ? await adminAuthors(writers) : new Set<string>()
  for (const [id, list] of all) {
    const uploader = uploaderOf.get(id) ?? null
    const kept = list.filter((a) => attributionCounts(a, uploader, admins))
    if (kept.length > 0) counted.set(id, kept)
  }
  return { all, counted, incomplete }
}

/** A DM or a private channel (incl. group DMs): rooms admin access does not open. */
async function isPrivateRoom(room: string): Promise<boolean> {
  const { parseRoom, channelByKey } = await import('./chat.js')
  const parsed = parseRoom(room)
  if (parsed.kind === 'dm') return true
  if (parsed.kind !== 'channel') return false
  const channel = await channelByKey(parsed.channelKey ?? '').catch(() => undefined)
  return !channel || channel.visibility === 'private' || !!channel.is_direct
}

/**
 * Administrators read every file — except one used only in DMs or private
 * channels they are not in (gotchas: admin access doesn't open other people's
 * conversations; the logged chat compliance view reads those through
 * chatComplianceRead). A record attachment (any FK reference), a file the
 * admin uploaded, a file used nowhere, or one with any counted use outside a
 * private room stays readable.
 */
async function adminReadable(files: FileRow[], req: Caller, depth: number): Promise<Set<string>> {
  const out = new Set(files.map((f) => String(f.id).toLowerCase()))
  const user = req.user
  if (!user) return out
  const candidates = files.filter((f) => !isUploader(f, user))
  if (candidates.length === 0) return out
  try {
    await closeAdminRooms(candidates, req, depth, out)
  } catch {
    // Could not tell whether these files live in closed rooms: deny them.
    for (const f of candidates) out.delete(String(f.id).toLowerCase())
  }
  return out
}

/** Sources whose loss leaves "is this a DM / private-channel file?" unknown. */
const ROOM_SOURCES = ['chat', 'posters', 'index']

async function closeAdminRooms(
  candidates: FileRow[],
  req: Caller,
  depth: number,
  out: Set<string>
): Promise<void> {
  const user = req.user as User
  const refs = await fileRecordRefs(candidates.map((f) => String(f.id)))
  // With the FK lookup failed, no file counts as a record attachment.
  const loose = candidates.filter(
    (f) => refs.failed || !refs.get(String(f.id).toLowerCase())?.length
  )
  if (loose.length === 0) return
  const { all, counted, incomplete } = await countedAttributions(loose)
  if (ROOM_SOURCES.some((s) => incomplete.has(s))) {
    // The chat (or clip) source could not be read: any of these may be a DM file.
    for (const f of loose) out.delete(String(f.id).toLowerCase())
    return
  }
  const { canSeeRoom, newRoomVisibilityCache } = await import('./chat.js')
  const cache = newRoomVisibilityCache()
  const closed = async (room: string) =>
    (await isPrivateRoom(room)) && !(await canSeeRoom(user, room, cache).catch(() => false))
  for (const f of loose) {
    const k = String(f.id).toUpperCase()
    const uses = all.get(k) ?? []
    const privateRooms: string[] = []
    for (const a of uses) if (a.kind === 'room' && (await closed(a.room))) privateRooms.push(a.room)
    if (privateRooms.length === 0) continue
    // Still readable when a counted use lies outside the closed rooms.
    let open = false
    for (const a of counted.get(k) ?? []) {
      if (a.kind === 'room' && privateRooms.includes(a.room)) continue
      if (a.kind === 'poster' && depth === 0) {
        open = (await readableFileIdList([a.of], req, depth + 1)).has(a.of.toLowerCase())
      } else open = true
      if (open) break
    }
    if (!open) out.delete(k.toLowerCase())
  }
  // A poster of a clip that only lives in a closed room follows its clip.
  if (depth === 0) {
    for (const f of loose) {
      const k = String(f.id).toUpperCase()
      if (!out.has(k.toLowerCase())) continue
      const posters = (counted.get(k) ?? []).filter((a) => a.kind === 'poster')
      const others = (counted.get(k) ?? []).filter((a) => a.kind !== 'poster')
      if (posters.length === 0 || others.length > 0) continue
      const clips = await readableFileIdList(
        posters.map((a) => (a as Extract<FileAttribution, { kind: 'poster' }>).of),
        req,
        depth + 1
      )
      if (clips.size === 0) out.delete(k.toLowerCase())
    }
  }
}

/**
 * The logged chat compliance view (Chat Analytics → Messages): an
 * administrator opens an attachment of the message they are reading, even in
 * a DM or private channel. True only when that message (or a preserved
 * version of it) carries the file; each read is logged as chat-admin-read.
 */
export async function chatComplianceRead(
  file: FileRow,
  messageId: unknown,
  req: FastifyRequest
): Promise<boolean> {
  if (!req.isAdmin || !req.user) return false
  const id = Number(messageId)
  if (!Number.isSafeInteger(id) || id <= 0) return false
  const want = String(file.id).toUpperCase()
  const carries = (v: unknown) => [...extractFileIds(v)].includes(want)
  const msg = (await db('chat_messages')
    .where({ id })
    .first('room', 'attachments')
    .catch(() => undefined)) as { room?: string; attachments?: unknown } | undefined
  if (!msg) return false
  let found = carries(msg.attachments)
  if (!found) {
    const versions = (await db('nivaro_chat_message_history')
      .where({ message_id: id })
      .select('attachments')
      .catch(() => [])) as Array<{ attachments: unknown }>
    found = versions.some((v) => carries(v.attachments))
  }
  if (!found) return false
  const { logActivity } = await import('./activity.js')
  try {
    await logActivity({
      action: 'chat-admin-read',
      collection: 'chat_messages',
      item: String(id),
      user: req.user.id,
      comment: `Opened attachment ${want} of message ${id} in ${msg.room ?? 'a conversation'}`,
      req
    })
  } catch {
    // A compliance read that could not be logged does not happen.
    return false
  }
  return true
}

/**
 * Of these file ids, the ones the caller may NOT read (as given). For write
 * paths that store file ids without a foreign key — chat attachments, comment
 * links, ticket and addendum attachments: refuse what the writer cannot read
 * themselves, so a stored id never names someone else's file. Ids that are
 * not files are left out (nothing to protect).
 */
export async function unreadableFileIds(ids: string[], req: Caller): Promise<string[]> {
  const asked = [...new Set(ids.map(String).filter((i) => UUID_RE.test(i)))]
  if (asked.length === 0 || req.isAdmin) return []
  const existing = (await db('nivaro_files').whereIn('id', asked).select('id')) as Array<{
    id: unknown
  }>
  const known = new Set(existing.map((r) => String(r.id).toLowerCase()))
  const readable = await readableFileIdList(asked, req)
  return asked.filter((i) => known.has(i.toLowerCase()) && !readable.has(i.toLowerCase()))
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The 400 a write gets for naming a file the writer cannot read. */
export function fileNotReadableError(field: string): Error {
  const label = field.replace(/_/g, ' ')
  return Object.assign(
    new Error(
      `${label.charAt(0).toUpperCase()}${label.slice(1)} names a file you cannot open, so it cannot be saved`
    ),
    { statusCode: 400, code: 'FILE_NOT_READABLE', field }
  )
}

/**
 * Throws fileNotReadableError when `value` (text, JSON, a list of ids) names a
 * file the writer cannot read that `previous` did not already name. Admins
 * pass; the uploader always passes. The one write-time check for every place
 * that stores file ids without a foreign key.
 */
export async function assertFileIdsReadable(
  field: string,
  value: unknown,
  req: Caller | undefined,
  previous?: unknown
): Promise<void> {
  if (!req?.user || req.isAdmin || value == null) return
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const before = previous == null ? new Set<string>() : extractFileIds(previous)
  const ids = [...extractFileIds(text)].filter((id) => !before.has(id))
  if (ids.length === 0) return
  if ((await unreadableFileIds(ids, req)).length > 0) throw fileNotReadableError(field)
}

const RICH_INTERFACE = /rich|wysiwyg|markdown|html/i
const FILE_INTERFACES = new Set(['file', 'image', 'files', 'file-image', 'file-interface'])

/**
 * Items create/update: rich-text and file fields of a business collection may
 * only name files the writer can read (a pasted id in a record anyone reads
 * would otherwise hand them someone else's file). Only ids the field did not
 * already hold are checked.
 */
export async function assertEmbeddedFilesReadable(
  collection: string,
  payload: Record<string, unknown>,
  req: Caller | undefined,
  previous?: Record<string, unknown> | null
): Promise<void> {
  if (!req?.user || req.isAdmin || isSystemCollection(collection)) return
  const { getFields } = await import('./collections.js')
  const fields = await getFields(collection).catch(() => [])
  for (const f of fields) {
    const iface = String(f.interface ?? '')
    const special = (
      Array.isArray(f.special) ? f.special.join(',') : String(f.special ?? '')
    ).toLowerCase()
    if (!RICH_INTERFACE.test(iface) && !FILE_INTERFACES.has(iface) && !special.includes('file'))
      continue
    const key = Object.keys(payload).find((k) => k.toLowerCase() === f.field.toLowerCase())
    if (!key) continue
    await assertFileIdsReadable(key, payload[key], req, previous?.[key])
  }
}

/** readableFileIds for bare ids (lower-cased answer): the rows are read
 *  here, and a private render or export counts only for its maker. */
export async function readableFileIdList(
  ids: string[],
  req: Caller,
  depth = 0
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  let rows: Array<{ id: unknown; uploaded_by: unknown; uploaded_on: unknown; tags: unknown }>
  try {
    rows = (await db('nivaro_files')
      .whereIn('id', ids)
      .select('id', 'uploaded_by', 'uploaded_on', 'tags')) as typeof rows
  } catch {
    // The rows could not be read: nothing is granted.
    return new Set()
  }
  const seen = rows.filter((r) => viewerMaySeeFile(r, { id: req.user?.id, isAdmin: req.isAdmin }))
  return readableSet(seen, req, depth)
}

export type FileChangeVerdict = { ok: true } | { ok: false; message: string; code?: string }

/** May the caller rename, re-tag, replace or delete this file? */
export async function mayChangeFile(
  file: FileRow,
  req: FastifyRequest
): Promise<FileChangeVerdict> {
  if (req.isAdmin) return { ok: true }
  const user = req.user
  if (!user) return { ok: false, message: 'Sign in to change files' }
  const found = await fileRecordRefs([String(file.id)])
  if (found.failed)
    return {
      ok: false,
      message: 'Could not confirm which records use this file. Try again shortly.'
    }
  const refs = found.get(String(file.id).toLowerCase()) ?? []
  if (refs.length === 0) {
    return isUploader(file, user)
      ? { ok: true }
      : { ok: false, message: 'Only the person who uploaded this file can change it' }
  }
  if (refs.length > MAX_REFS)
    return { ok: false, message: 'This file is used on too many records to change here' }
  const { canUpdateItem } = await import('./items.js')
  const { assertNotEditLocked, EditLockedError, EDIT_LOCKED } = await import('./edit-lock.js')
  for (const ref of refs) {
    if (!(await canUpdateItem(user, ref.collection, ref.id, req.workspaceId ?? undefined)))
      return { ok: false, message: 'You cannot change a record this file is attached to' }
    try {
      await assertNotEditLocked(user, ref.collection, { ids: [ref.id] }, req)
    } catch (e) {
      return {
        ok: false,
        code: EDIT_LOCKED,
        message:
          e instanceof EditLockedError
            ? e.message
            : 'Could not confirm you may change this record while it waits.'
      }
    }
  }
  return { ok: true }
}
