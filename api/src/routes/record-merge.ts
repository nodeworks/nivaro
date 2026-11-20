import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { dialectOf, inboundForeignKeysSql } from '../db/dialect/items-query.js'
import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { deleteOne } from '../services/items.js'
import { announceRawWrites } from '../services/raw-write-announcer.js'
import { announceRecordAspect } from '../services/record-events.js'
import { applyMerge, undoMerge } from '../services/record-merge/apply.js'
import { mergeCandidates } from '../services/record-merge/candidates.js'
import { buildMergePlan, MergeRefusal, mergeCollection } from '../services/record-merge/plan.js'
import { UNDO_WINDOW_MS, undoRefusal } from '../services/record-merge/rules.js'
import { latestMergeInto, loadUndoLog } from '../services/record-merge/store.js'

/**
 * Merge records (Rob 2026-11-14, services/record-merge/*) — for anyone who may change and
 * delete the records, judged as them:
 *
 *   GET  /record-merge/:collection/allowed?item=   switch + may this person merge here, and
 *                                                  the latest merge into `item` still undoable
 *   GET  /record-merge/:collection/candidates?of=&q=   records to merge with (likely duplicates
 *                                                  of `of`, then a search), read as the caller
 *   GET  /record-merge/:collection/plan?ids=a,b    the merge screen's data
 *   POST /record-merge/:collection/apply           {survivor, discard[], keep?[], values, relations}
 *   GET  /record-merge/undo/:mergeId               is it still undoable, and by me
 *   POST /record-merge/undo/:mergeId               undo (24 h)
 *
 * The older admin-only one-step merge below (POST /:collection {survivor_id, merged_id})
 * stays for scripts.
 *
 * Business-record merge (#63): two duplicate records (a vendor entered twice)
 * become one — every FK referencing the duplicate repoints to the survivor,
 * then the duplicate deletes THROUGH the items service (trash applies).
 * Coverage is schema-driven: registered M2O relations into the collection
 * (junction legs included, which covers M2M) plus physical FK constraints —
 * a plausible-looking nivaro_relations row whose table doesn't exist is
 * skipped, never trusted (relations are claims).
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

function sendRefusal(reply: FastifyReply, err: unknown) {
  if (err instanceof MergeRefusal)
    return reply.code(err.statusCode).send({
      error: err.message,
      code: err.code,
      ...(err.record ? { record: err.record } : {}),
      ...(err.changedBy ? { changed_by: err.changedBy } : {})
    })
  throw err
}

const isAdminReq = async (req: FastifyRequest) => {
  if (req.isAdmin === true) return true
  const { isAdminRole } = await import('../services/permissions.js')
  return isAdminRole(req.user as never).catch(() => false)
}

export async function recordMergeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { collection: string }; Querystring: { item?: string } }>(
    '/:collection/allowed',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { collection } = req.params
        const { allowed, noun, plural } = await mergeCollection(collection)
        const { can } = await import('../services/permissions.js')
        const user = req.user as never
        const [mayUpdate, mayDelete] = await Promise.all([
          can(user, 'update', collection).catch(() => false),
          can(user, 'delete', collection).catch(() => false)
        ])
        let undo: { merge_id: string; until: string; discarded: string[] } | null = null
        const item = String(req.query.item ?? '').trim()
        if (allowed && item && item.length <= 64) {
          const log = await latestMergeInto(collection, item, UNDO_WINDOW_MS).catch(() => null)
          if (
            log &&
            !undoRefusal(log, { id: String(req.user?.id), isAdmin: await isAdminReq(req) })
          )
            undo = {
              merge_id: log.merge_id,
              until: new Date(Date.parse(log.at) + UNDO_WINDOW_MS).toISOString(),
              discarded: log.discarded.map((id) => log.labels[id] ?? id)
            }
        }
        return {
          data: { allowed, may_merge: allowed && mayUpdate && mayDelete, noun, plural, undo }
        }
      } catch (err) {
        return sendRefusal(reply, err)
      }
    }
  )

  app.get<{ Params: { collection: string }; Querystring: { of?: string; q?: string } }>(
    '/:collection/candidates',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { allowed } = await mergeCollection(req.params.collection)
        if (!allowed) return { data: { self: null, likely: [], results: [] } }
        return {
          data: await mergeCandidates(req, req.params.collection, {
            of: req.query.of ? String(req.query.of).slice(0, 64) : null,
            q: String(req.query.q ?? '').slice(0, 120)
          })
        }
      } catch (err) {
        return sendRefusal(reply, err)
      }
    }
  )

  app.get<{ Params: { collection: string }; Querystring: { ids?: string; draft?: string } }>(
    '/:collection/plan',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return {
          data: await buildMergePlan(req, req.params.collection, req.query.ids, {
            draft: req.query.draft === '1'
          })
        }
      } catch (err) {
        return sendRefusal(reply, err)
      }
    }
  )

  app.post<{ Params: { collection: string }; Body: Record<string, unknown> }>(
    '/:collection/apply',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const out = await applyMerge(req, req.params.collection, req.body ?? {})
        return { data: out }
      } catch (err) {
        return sendRefusal(reply, err)
      }
    }
  )

  app.get<{ Params: { mergeId: string } }>(
    '/undo/:mergeId',
    { preHandler: requireAuth },
    async (req) => {
      const log = await loadUndoLog(req.params.mergeId)
      const reason = undoRefusal(log, {
        id: String(req.user?.id),
        isAdmin: await isAdminReq(req)
      })
      return {
        data: {
          undoable: !reason,
          reason,
          until: log ? new Date(Date.parse(log.at) + UNDO_WINDOW_MS).toISOString() : null
        }
      }
    }
  )

  app.post<{ Params: { mergeId: string } }>(
    '/undo/:mergeId',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return { data: await undoMerge(req, req.params.mergeId) }
      } catch (err) {
        return sendRefusal(reply, err)
      }
    }
  )

  app.post<{
    Params: { collection: string }
    Body: { survivor_id?: string | number; merged_id?: string | number; dry_run?: boolean }
  }>('/:collection', { preHandler: requireAdmin }, async (req, reply) => {
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
    const fkCols = rawRows<{ table_name: string; column_name: string }>(
      await db.raw(inboundForeignKeysSql(), [collection])
    )

    const liveTables = new Set(
      (
        (await db('information_schema.tables')
          .where('table_type', 'BASE TABLE')
          .modify((b) => {
            if (dialectOf() === 'mysql') b.whereRaw('table_schema = DATABASE()')
          })
          .select('table_name')) as Array<{ table_name?: string; TABLE_NAME?: string }>
      )
        // MySQL names information_schema columns in upper case whatever the select says.
        .map((t) => String(t.table_name ?? t.TABLE_NAME ?? '').toLowerCase())
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
          .modify((b) => {
            if (dialectOf() === 'mysql') b.whereRaw('table_schema = DATABASE()')
          })
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

    // Tasks on the duplicate move to the survivor before its delete would
    // cancel them (#1006).
    try {
      const { onRecordMerged } = await import('../services/tasks.js')
      const moved = await onRecordMerged(collection, merged_id, survivor_id, req.user!.id)
      if (moved) applied['nivaro_tasks.item'] = { repointed: moved, deleted_duplicates: 0 }
    } catch {
      /* the merge itself stands */
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

    // Low 1 (realtime gaps 2026-11-17): the repoint is raw — every table it touched refreshes
    // collection-wide (ids are not read back), and the survivor's Related / Tasks panels too.
    for (const key of Object.keys(applied)) {
      const table = key.split('.')[0]
      if (!table || /^(nivaro|directus)_/i.test(table)) continue
      void announceRawWrites(table, null, {
        action: 'update',
        changed_fields: [key.slice(table.length + 1)],
        source: 'record-merge',
        noticeOnly: true
      })
    }
    announceRecordAspect(
      collection,
      String(survivor_id),
      applied['nivaro_tasks.item'] ? ['$related', '$tasks'] : ['$related']
    )
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
