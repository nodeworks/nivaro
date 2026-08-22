import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { deleteOne } from '../services/items.js'

/**
 * Business-record merge (#63): two duplicate records (a vendor entered twice)
 * become one — every FK referencing the duplicate repoints to the survivor,
 * then the duplicate deletes THROUGH the items service (trash applies).
 * Coverage is schema-driven: registered M2O relations into the collection
 * (junction legs included, which covers M2M) plus physical FK constraints —
 * a plausible-looking nivaro_relations row whose table doesn't exist is
 * skipped, never trusted (relations are claims).
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export async function recordMergeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.post<{
    Params: { collection: string }
    Body: { survivor_id?: string | number; merged_id?: string | number; dry_run?: boolean }
  }>('/:collection', async (req, reply) => {
    const { collection } = req.params
    const { survivor_id, merged_id, dry_run } = req.body ?? {}
    if (!IDENT.test(collection) || /^(nivaro|directus)_/i.test(collection)) {
      return reply.code(400).send({ error: 'Not a valid business collection' })
    }
    if (survivor_id == null || merged_id == null) {
      return reply.code(400).send({ error: 'survivor_id and merged_id are required' })
    }
    if (String(survivor_id) === String(merged_id)) {
      return reply.code(400).send({ error: 'Cannot merge a record into itself' })
    }
    const survivor = await db(collection).where('id', survivor_id).first('id')
    const merged = await db(collection).where('id', merged_id).first('id')
    if (!survivor || !merged) return reply.code(404).send({ error: 'Record not found' })

    // Referencing columns: registered M2O relations into this collection
    // (junction legs carry junction_field — keep them, they ARE the M2M
    // coverage) + physical FK constraints. Both verified against live tables.
    const rels = (await db('nivaro_relations')
      .where({ one_collection: collection })
      .whereNotNull('many_field')
      .select('many_collection', 'many_field')) as Array<{
      many_collection: string
      many_field: string
    }>
    const fkCols = (await db.raw(
      `SELECT t.name AS table_name, c.name AS column_name
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables t ON t.object_id = fk.parent_object_id
       JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
       WHERE fk.referenced_object_id = OBJECT_ID(?)`,
      [collection]
    )) as Array<{ table_name: string; column_name: string }>

    const liveTables = new Set(
      (
        (await db('information_schema.tables')
          .where('table_type', 'BASE TABLE')
          .pluck('table_name')) as string[]
      ).map((t) => t.toLowerCase())
    )
    const targets = new Map<string, { table: string; column: string }>()
    for (const r of [
      ...rels.map((x) => ({ table_name: x.many_collection, column_name: x.many_field })),
      ...fkCols
    ]) {
      const table = String(r.table_name)
      const column = String(r.column_name)
      if (!IDENT.test(table) || !IDENT.test(column)) continue
      if (!liveTables.has(table.toLowerCase())) continue
      if (table.toLowerCase() === collection.toLowerCase() && column === 'id') continue
      // Alias columns aren't physical — verify the column exists too.
      targets.set(`${table}.${column}`, { table, column })
    }
    const colCheck = await Promise.all(
      [...targets.values()].map(async (t) => {
        const exists = await db('information_schema.columns')
          .where({ table_name: t.table, column_name: t.column })
          .first('column_name')
        return { key: `${t.table}.${t.column}`, ok: !!exists }
      })
    )
    for (const c of colCheck) if (!c.ok) targets.delete(c.key)

    const counts: Record<string, number> = {}
    for (const t of targets.values()) {
      const row = (await db(t.table)
        .where(t.column, String(merged_id))
        .count({ c: '*' })
        .first()) as { c?: number | string } | undefined
      const n = Number(row?.c ?? 0)
      if (n > 0) counts[`${t.table}.${t.column}`] = n
    }
    if (dry_run) {
      return { data: { dry_run: true, references: counts, tables: Object.keys(counts).length } }
    }

    const applied: Record<string, { repointed: number; deleted_duplicates: number }> = {}
    for (const [key, n] of Object.entries(counts)) {
      const t = targets.get(key)!
      try {
        const updated = await db(t.table)
          .where(t.column, String(merged_id))
          .update({ [t.column]: survivor_id })
        applied[key] = { repointed: updated, deleted_duplicates: 0 }
      } catch {
        // Unique collision — the survivor already holds an equivalent row
        // (junction pairs). The duplicate's rows go.
        const deleted = await db(t.table)
          .where(t.column, String(merged_id))
          .del()
          .catch(() => 0)
        applied[key] = { repointed: n - deleted, deleted_duplicates: deleted }
      }
    }

    // The duplicate deletes through the items service — trash snapshot,
    // hooks, activity, delete guards all apply. A guard blocking the delete
    // leaves the repoint DONE (references already moved) and reports it.
    let deleteError: string | null = null
    try {
      await deleteOne(req.user!, collection, String(merged_id), req)
    } catch (err) {
      deleteError = err instanceof Error ? err.message : String(err)
    }

    await logActivity({
      action: 'record-merge',
      user: req.user?.id,
      collection,
      item: String(survivor_id),
      comment: `Merged ${collection}/${merged_id} into ${survivor_id}: ${Object.keys(applied).length} table(s) repointed${deleteError ? ` (duplicate NOT deleted: ${deleteError.slice(0, 120)})` : ''}`,
      req
    })
    return { data: { merged: true, applied, delete_error: deleteError } }
  })
}
