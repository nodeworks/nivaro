import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { CMSRelation, User } from '../types.js'
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
      // A junction row (an M2M files field) is judged through the record that owns it.
      const leg = await junctionParent(u.table, u.column)
      const site = leg
        ? { table: leg.parent, column: leg.alias, idColumn: leg.parentFk }
        : { table: u.table, column: u.column, idColumn: 'id' }
      if (/^(nivaro_|directus_)/i.test(site.table)) continue
      if (!(await mayReadField(user, site.table, site.column))) continue
      const ids = [
        ...new Set(
          (
            (await db(u.table)
              .where(u.column, fileId)
              .limit(MAX_IDS_PER_SITE)
              .pluck(site.idColumn)) as unknown[]
          )
            .filter((v) => v !== null && v !== undefined)
            .map(String)
        )
      ]
      if (ids.length === 0) continue
      const seen = await visibleIds(await compileAccessGates(user, site.table), ids)
      if (seen.size > 0)
        usages.push({ table: site.table, column: site.column ?? u.column, count: seen.size })
    } catch {
      /* a site that cannot be judged stays hidden */
    }
  }
  return { usages, total: usages.reduce((s, u) => s + u.count, 0) }
}

async function mayReadField(user: User, table: string, column: string | null): Promise<boolean> {
  if (!(await can(user, 'read', table))) return false
  const fields = await getAllowedFields(user, 'read', table)
  if (fields === null || fields.includes('*')) return true
  return column !== null && fields.includes(column)
}

/**
 * When `table.column` is the file leg of an M2M junction (review A10, 2026-10-27): the parent
 * collection, its M2M alias field and the junction column that points at the parent. The file
 * leg carries `junction_field` = the parent leg's column; the parent leg names the parent.
 */
async function junctionParent(
  table: string,
  column: string
): Promise<{ parent: string; alias: string | null; parentFk: string } | null> {
  const rels = (await db<CMSRelation>('nivaro_relations')
    .where({ many_collection: table })
    .select('many_field', 'one_collection', 'one_field', 'junction_field')) as Array<
    Pick<CMSRelation, 'many_field' | 'one_collection' | 'one_field' | 'junction_field'>
  >
  const fileLeg = rels.find((r) => r.many_field === column && r.junction_field)
  if (!fileLeg) return null
  const parentLeg = rels.find((r) => r.many_field === fileLeg.junction_field && r.one_collection)
  if (!parentLeg?.one_collection) return null
  const alias = parentLeg.one_field && parentLeg.one_field !== 'id' ? parentLeg.one_field : null
  return { parent: parentLeg.one_collection, alias, parentFk: parentLeg.many_field }
}
