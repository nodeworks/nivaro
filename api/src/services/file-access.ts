import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
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
 * administrators pass. A file no business record references — an avatar, a
 * chat attachment, an inline image, an upload whose record is not saved yet —
 * reads as before, and only its uploader or an administrator changes it.
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
  if (refs.length > 0) {
    const { getCollection, getRelations } = await import('./collections.js')
    for (const ref of refs) {
      if (!(await getCollection(ref.table).catch(() => undefined))) continue
      const rels = await getRelations(ref.table).catch(() => [])
      const leg = rels.find(
        (r) => r.many_collection === ref.table && r.many_field === ref.column && r.junction_field
      )
      const parent = leg
        ? rels.find((r) => r.many_collection === ref.table && r.many_field === leg.junction_field)
        : undefined
      if (leg && parent?.one_collection && !isSystemCollection(parent.one_collection)) {
        sites.push({
          ...ref,
          record: parent.one_collection,
          recordColumn: String(leg.junction_field)
        })
      } else if (!leg) {
        sites.push({ ...ref, record: ref.table, recordColumn: 'id' })
      }
    }
  }
  siteCache.set(key, { at: Date.now(), sites })
  return sites
}

/** The business records that reference each file (lower-cased file id → refs). */
export async function fileRecordRefs(fileIds: string[]): Promise<Map<string, FileRecordRef[]>> {
  const out = new Map<string, FileRecordRef[]>()
  const ids = [...new Set(fileIds.map((i) => String(i)))]
  if (ids.length === 0) return out
  for (const site of await refSites()) {
    let rows: Array<{ f: unknown; r: unknown }> = []
    try {
      rows = (await db(site.table)
        .whereIn(site.column, ids)
        .whereNotNull(site.recordColumn)
        .select({ f: site.column, r: site.recordColumn })
        .limit(MAX_REFS * ids.length)) as Array<{ f: unknown; r: unknown }>
    } catch {
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

type FileRow = { id: unknown; uploaded_by?: unknown }
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
  if (req.isAdmin) return true
  const user = req.user
  if (!user) return false
  if (isUploader(file, user)) return true
  const refs = (await fileRecordRefs([String(file.id)])).get(String(file.id).toLowerCase()) ?? []
  if (refs.length === 0) return true
  const { readOne } = await import('./items.js')
  for (const ref of refs.slice(0, MAX_REFS)) {
    const row = await readOne(user, ref.collection, ref.id, req.workspaceId ?? undefined, [
      'id'
    ]).catch(() => null)
    if (row) return true
  }
  return false
}

/** The lower-cased ids (of those given) the caller may read — the batch form
 *  of mayReadFile for lists and per-page lookups. */
export async function readableFileIds(files: FileRow[], req: Caller): Promise<Set<string>> {
  const out = new Set<string>()
  if (req.isAdmin) {
    for (const f of files) out.add(String(f.id).toLowerCase())
    return out
  }
  const user = req.user
  if (!user) return out
  const refs = await fileRecordRefs(files.map((f) => String(f.id)))
  const pending: Array<{ file: string; refs: FileRecordRef[] }> = []
  for (const f of files) {
    const k = String(f.id).toLowerCase()
    const list = refs.get(k) ?? []
    if (isUploader(f, user) || list.length === 0) out.add(k)
    else pending.push({ file: k, refs: list })
  }
  if (pending.length === 0) return out
  // One gate compile + one batched read per referencing collection.
  const byCollection = new Map<string, Set<string>>()
  for (const p of pending)
    for (const r of p.refs) {
      const set = byCollection.get(r.collection) ?? new Set<string>()
      set.add(r.id)
      byCollection.set(r.collection, set)
    }
  const { visibleRecordIds } = await import('./socket-access.js')
  const visible = new Set<string>()
  for (const [collection, ids] of byCollection) {
    for (const id of await visibleRecordIds(user, collection, [...ids], false))
      visible.add(`${collection}\u0001${String(id).toLowerCase()}`)
  }
  for (const p of pending) {
    if (p.refs.some((r) => visible.has(`${r.collection}\u0001${r.id.toLowerCase()}`)))
      out.add(p.file)
  }
  return out
}

/** readableFileIds for bare ids (lower-cased answer): the rows are read
 *  here, and a private render or export counts only for its maker. */
export async function readableFileIdList(ids: string[], req: Caller): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = (await db('nivaro_files')
    .whereIn('id', ids)
    .select('id', 'uploaded_by', 'tags')) as Array<{
    id: unknown
    uploaded_by: unknown
    tags: unknown
  }>
  const seen = rows.filter((r) => viewerMaySeeFile(r, { id: req.user?.id, isAdmin: req.isAdmin }))
  return readableFileIds(seen, req)
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
  const refs = (await fileRecordRefs([String(file.id)])).get(String(file.id).toLowerCase()) ?? []
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
