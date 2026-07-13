import { db } from '../db/index.js'

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
export async function getFileUsage(fileId: string): Promise<{ usages: FileUsage[]; total: number }> {
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
