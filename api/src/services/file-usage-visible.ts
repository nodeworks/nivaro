import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { FileUsage } from './file-usage.js'
import { can, getAllowedFields } from './permissions.js'
import { compileAccessGates, visibleIds } from './record-access.js'

/** Rows per usage site judged for visibility (a file on more rows counts as this many). */
const MAX_IDS_PER_SITE = 2000

/**
 * A file's usage as `req.user` may know it (Low, security audit 2026-10-27):
 * the FK scan counts every row of every table, so a non-admin learns which
 * hidden collections and records carry a file. They get only the sites in a
 * collection they may read, through a field they may read, counting only the
 * rows their row filter and User Scopes let them see. System tables never
 * show. An unrestricted administrator gets the scan unchanged.
 */
export async function fileUsageForReader(
  req: FastifyRequest,
  fileId: string,
  usage: { usages: FileUsage[]; total: number }
): Promise<{ usages: FileUsage[]; total: number }> {
  const user = req.user
  if (!user) return { usages: [], total: 0 }
  const restricted =
    (user.api_key_scope_restrictions?.length ?? 0) > 0 || (user.api_key_scopes?.length ?? 0) > 0
  if (req.isAdmin && !restricted) return usage
  const usages: FileUsage[] = []
  for (const u of Array.isArray(usage?.usages) ? usage.usages : []) {
    if (/^(nivaro_|directus_)/i.test(u.table)) continue
    try {
      if (!(await can(user, 'read', u.table))) continue
      const fields = await getAllowedFields(user, 'read', u.table)
      if (fields !== null && !fields.includes('*') && !fields.includes(u.column)) continue
      const ids = (
        (await db(u.table).where(u.column, fileId).limit(MAX_IDS_PER_SITE).pluck('id')) as unknown[]
      ).map(String)
      if (ids.length === 0) continue
      const seen = await visibleIds(await compileAccessGates(user, u.table), ids)
      if (seen.size > 0) usages.push({ table: u.table, column: u.column, count: seen.size })
    } catch {
      /* a site that cannot be judged stays hidden */
    }
  }
  return { usages, total: usages.reduce((s, u) => s + u.count, 0) }
}
