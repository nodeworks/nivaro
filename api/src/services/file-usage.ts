import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'

/**
 * File usage tracking.
 *
 * Reference discovery is FK-driven: every column with a FOREIGN KEY into
 * nivaro_files(id) (sys.foreign_keys) counts as a usage site. After the
 * 2026-07-12 fix:file-fks repoint this covers all legacy business junctions
 * (workflows_files etc.) plus any nivaro_* columns with a real constraint.
 * Columns holding file ids WITHOUT a constraint are invisible here — add the
 * FK rather than special-casing this scan.
 */

export interface FileRef {
  table: string
  column: string
}

let refCache: { refs: FileRef[]; at: number } | null = null
const REF_TTL_MS = 60_000

export async function getFileRefColumns(): Promise<FileRef[]> {
  if (refCache && Date.now() - refCache.at < REF_TTL_MS) return refCache.refs
  const rows = (await db.raw(`
    SELECT OBJECT_NAME(fk.parent_object_id) AS tbl, c.name AS col
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
    WHERE OBJECT_NAME(fk.referenced_object_id) = 'nivaro_files'
  `)) as Array<{ tbl: string; col: string }>
  const refs = rows.map((r) => ({ table: r.tbl, column: r.col }))
  refCache = { refs, at: Date.now() }
  return refs
}

export interface FileUsage {
  table: string
  column: string
  count: number
}

/** Where is this file referenced? One count query per FK site (~10 sites). */
export async function getFileUsage(
  fileId: string
): Promise<{ usages: FileUsage[]; total: number }> {
  const refs = await getFileRefColumns()
  const usages: FileUsage[] = []
  for (const ref of refs) {
    const [{ n }] = (await db.raw(
      `SELECT COUNT(*) AS n FROM [${ref.table}] WHERE [${ref.column}] = ?`,
      [fileId]
    )) as Array<{ n: number }>
    if (n > 0) usages.push({ table: ref.table, column: ref.column, count: Number(n) })
  }
  return { usages, total: usages.reduce((s, u) => s + u.count, 0) }
}

/** Files referenced by nothing — safe-to-delete candidates. */
export async function findOrphanFiles(opts: { limit?: number; offset?: number } = {}): Promise<{
  data: Array<Record<string, unknown>>
  total: number
}> {
  const refs = await getFileRefColumns()
  const notExists = refs
    .map((r) => `NOT EXISTS (SELECT 1 FROM [${r.table}] t WHERE t.[${r.column}] = f.id)`)
    .join(' AND ')
  const whereClause = refs.length > 0 ? `WHERE ${notExists}` : ''
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
  const offset = Math.max(0, opts.offset ?? 0)

  const [countRow] = (await db.raw(
    `SELECT COUNT(*) AS n FROM nivaro_files f ${whereClause}`
  )) as Array<{ n: number }>
  const data = (await db.raw(
    `SELECT f.id, f.filename_download, f.title, f.type, f.filesize, f.uploaded_on
     FROM nivaro_files f ${whereClause}
     ORDER BY f.uploaded_on DESC
     OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
  )) as Array<Record<string, unknown>>

  return { data, total: Number(countRow.n) }
}

// ─── Where a file was USED on one record (#1288) ──────────────────────────────
// The FK scan above answers "which rows point at this file"; this answers the
// question a person asks on a record form — what CARRIED the file: the
// addendum that attached it, the push whose payload named it, the email it
// rode, the layout that generated it. Four batched reads per record, one
// pure fold (unit-tested) over their rows.

export type FileUseKind = 'addendum' | 'push' | 'email' | 'generated'

export interface FileUse {
  kind: FileUseKind
  /** The source row's own id (addendum uuid, submission / mail-log / layout
   *  id) — a stable key for the list, never a position. */
  id: string
  /** One plain sentence: 'Addendum "Scope change" (approved)'. */
  label: string
  /** When it happened (ISO), null when the source carries no stamp. */
  at: string | null
  /** Admin-shaped console path (push / email). The host maps it through
   *  NavigationContext.consoleUrl; absent = nothing to open. */
  href?: string
  /** For an addendum use: the addendum id, so the host opens the record on
   *  that addendum view through its own item-url shape. */
  addendum_id?: string
  detail?: string
  /** 'id' = the source holds the file's uuid; 'name' = only its download
   *  name matched (an email body or a push payload naming the file). */
  match: 'id' | 'name'
}

export interface FileUsageFileRow {
  id: string
  filename_download: string | null
  generated_by_layout: number | null
  uploaded_on: string | Date | null
  layout_name?: string | null
}

export interface FileUsageAddendumRow {
  id: string
  title: string | null
  status: string | null
  attachments: string | null
  created_at: string | Date | null
}

export interface FileUsageSubmissionRow {
  id: number
  api_name: string | null
  payload: string | null
  status: string | null
  created_at: string | Date | null
}

export interface FileUsageMailRow {
  id: number
  to: string | null
  subject: string | null
  body: string | null
  status: string | null
  created_at: string | Date | null
}

export interface FileUsageSources {
  files: FileUsageFileRow[]
  addendums: FileUsageAddendumRow[]
  submissions: FileUsageSubmissionRow[]
  mails: FileUsageMailRow[]
}

function iso(v: string | Date | null | undefined): string | null {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function parseIdList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function containsCi(haystack: string | null, needle: string | null | undefined): boolean {
  if (!haystack || !needle) return false
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function recipientCount(to: string | null): number {
  if (!to) return 0
  return to
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean).length
}

function endpointOf(payload: string | null): string | null {
  if (!payload) return null
  try {
    const parsed = JSON.parse(payload) as { endpoint_path?: unknown }
    return typeof parsed?.endpoint_path === 'string' ? parsed.endpoint_path : null
  } catch {
    return null
  }
}

/** The pure fold: which of the record's addendums / pushes / emails / layouts
 *  carried each file. A file matched by its uuid reads `match: 'id'`; one
 *  only found by its download name reads `'name'`. Every requested id gets a
 *  key, an empty list when nothing carried it. Newest use first. */
export function foldFileUses(
  fileIds: string[],
  sources: FileUsageSources,
  record: { collection: string; item: string }
): Record<string, FileUse[]> {
  const pushHref = `/erp-submissions?collection=${encodeURIComponent(record.collection)}&item=${encodeURIComponent(record.item)}`
  const out: Record<string, FileUse[]> = {}
  for (const id of fileIds) out[id] = []
  const fileById = new Map(sources.files.map((f) => [String(f.id).toLowerCase(), f]))

  for (const id of fileIds) {
    const file = fileById.get(id.toLowerCase())
    const name = file?.filename_download ?? null
    const uses = out[id]

    if (file?.generated_by_layout != null) {
      uses.push({
        kind: 'generated',
        id: String(file.generated_by_layout),
        label: `Generated from layout "${file.layout_name ?? `#${file.generated_by_layout}`}"`,
        at: iso(file.uploaded_on),
        match: 'id'
      })
    }

    for (const a of sources.addendums) {
      const ids = parseIdList(a.attachments).map((x) => x.toLowerCase())
      if (!ids.includes(id.toLowerCase())) continue
      uses.push({
        kind: 'addendum',
        id: String(a.id),
        label: `Addendum "${a.title ?? 'Untitled'}"${a.status ? ` (${a.status})` : ''}`,
        at: iso(a.created_at),
        addendum_id: String(a.id),
        match: 'id'
      })
    }

    for (const s of sources.submissions) {
      const byId = containsCi(s.payload, id)
      const byName = !byId && containsCi(s.payload, name)
      if (!byId && !byName) continue
      const endpoint = endpointOf(s.payload)
      const api = s.api_name ?? 'an external API'
      uses.push({
        kind: 'push',
        id: String(s.id),
        label: `Sent to ${api}${endpoint ? ` — ${endpoint}` : ''}`,
        at: iso(s.created_at),
        href: pushHref,
        detail: s.status ?? undefined,
        match: byId ? 'id' : 'name'
      })
    }

    for (const m of sources.mails) {
      const byId = containsCi(m.body, id)
      const byName = !byId && containsCi(m.body, name)
      if (!byId && !byName) continue
      const n = recipientCount(m.to)
      uses.push({
        kind: 'email',
        id: String(m.id),
        label: `Emailed to ${n} recipient${n === 1 ? '' : 's'}${m.subject ? ` — ${m.subject}` : ''}`,
        at: iso(m.created_at),
        href: `/mail-log?id=${encodeURIComponent(String(m.id))}`,
        detail: m.status ?? undefined,
        match: byId ? 'id' : 'name'
      })
    }

    uses.sort((x, y) => (y.at ?? '').localeCompare(x.at ?? ''))
  }
  return out
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_[]/g, (c) => `\\${c}`)
}

/** `(col LIKE ? ESCAPE '\' OR …)` over every needle — bound, never interpolated. */
function likeAny(column: string, needles: string[]): { sql: string; bindings: string[] } {
  const parts = needles.map(() => `${column} LIKE ? ESCAPE '\\'`)
  return { sql: `(${parts.join(' OR ')})`, bindings: needles.map((n) => `%${escapeLike(n)}%`) }
}

const USAGE_CHUNK = 40

/** Where each of these files was used ON THIS RECORD. Four batched reads —
 *  the record's addendums, its pushes and its emails each in one query per
 *  chunk of needles (the payload / body LIKE is scoped to the record first,
 *  so the scan never crosses records), plus the files' own generated-by
 *  stamp. The mail log carries no attachment column: an email counts when
 *  its logged BODY names the file (a download link = id match, a bare
 *  filename = name match). */
export async function fileUsageOnRecord(
  collection: string,
  itemId: string | number,
  fileIds: string[]
): Promise<Record<string, FileUse[]>> {
  const ids = [...new Set(fileIds.map(String).filter(Boolean))]
  if (ids.length === 0) return {}
  const item = String(itemId)

  const files = (await selectInChunks(ids, 500, (chunk) =>
    db('nivaro_files as f')
      .leftJoin('nivaro_collection_layouts as l', 'l.id', 'f.generated_by_layout')
      .whereIn('f.id', chunk)
      .select(
        'f.id',
        'f.filename_download',
        'f.generated_by_layout',
        'f.uploaded_on',
        'l.name as layout_name'
      )
  )) as FileUsageFileRow[]

  const names = [...new Set(files.map((f) => f.filename_download).filter((n): n is string => !!n))]
  const needles = [...ids, ...names]

  const addendums = (await db('nivaro_addendums')
    .where({ parent_collection: collection, parent_id: item })
    .whereNotNull('attachments')
    .select('id', 'title', 'status', 'attachments', 'created_at')
    .catch(() => [])) as FileUsageAddendumRow[]

  const submissions = (await selectInChunks(needles, USAGE_CHUNK, (chunk) => {
    const like = likeAny('s.payload', chunk)
    return db('nivaro_erp_submissions as s')
      .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
      .where({ 's.collection': collection, 's.item': item })
      .whereRaw(like.sql, like.bindings)
      .select('s.id', 's.payload', 's.status', 's.created_at', 'a.name as api_name')
      .orderBy('s.id', 'desc')
      .limit(200)
  }).catch(() => [])) as FileUsageSubmissionRow[]

  const mails = (await selectInChunks(needles, USAGE_CHUNK, (chunk) => {
    const like = likeAny('body', chunk)
    return db('nivaro_mail_log')
      .where({ collection, item })
      .whereRaw(like.sql, like.bindings)
      .select('id', 'to', 'subject', 'body', 'status', 'created_at')
      .orderBy('id', 'desc')
      .limit(200)
  }).catch(() => [])) as FileUsageMailRow[]

  // A chunked read can hand the same row back once per chunk — dedupe by id.
  const uniq = <T extends { id: string | number }>(rows: T[]) => {
    const seen = new Set<string>()
    return rows.filter((r) => {
      const key = String(r.id)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  return foldFileUses(
    ids,
    {
      files,
      addendums,
      submissions: uniq(submissions),
      mails: uniq(mails)
    },
    { collection, item }
  )
}
