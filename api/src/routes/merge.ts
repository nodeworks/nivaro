import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { deleteOne, updateOne } from '../services/items.js'
import { can } from '../services/permissions.js'

/**
 * Record merge — combine duplicate records into one survivor.
 *
 * Preview resolves each candidate's field values plus inbound reference
 * counts (M2O FKs and M2M junction rows pointing at it). Execute repoints
 * every inbound reference from the losers to the survivor, applies the chosen
 * field values through updateOne (hooks/validation/RLS), then deletes the
 * losers through deleteOne — so they land in trash and stay restorable.
 * M2M junction repoints that would duplicate an existing (parent, survivor)
 * pair are deleted instead of updated.
 */

interface InboundRef {
  table: string
  column: string
  kind: 'm2o' | 'm2m'
}

async function inboundRefs(collection: string): Promise<InboundRef[]> {
  const rels = (await db('nivaro_relations').where('one_collection', collection)) as Array<
    Record<string, unknown>
  >
  const refs: InboundRef[] = []
  for (const r of rels) {
    const table = String(r.many_collection ?? '')
    const column = String(r.many_field ?? '')
    if (!table || !column) continue
    refs.push({ table, column, kind: r.junction_field != null ? 'm2m' : 'm2o' })
  }
  return refs
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = (await db.raw(
    `SELECT 1 AS ok FROM sys.columns WHERE object_id = OBJECT_ID(?) AND name = ?`,
    [table, column]
  )) as Array<{ ok: number }>
  return rows.length > 0
}

export async function mergeRoutes(app: FastifyInstance) {
  // Preview: field values per record + inbound reference counts
  app.get<{ Querystring: { collection?: string; ids?: string } }>(
    '/preview',
    { preHandler: requireAuth },
    async (req, reply) => {
      const collection = String(req.query.collection ?? '')
      const ids = String(req.query.ids ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (!/^[a-zA-Z0-9_]+$/.test(collection) || collection.startsWith('nivaro_')) {
        return reply.code(400).send({ error: 'Invalid collection' })
      }
      if (ids.length < 2 || ids.length > 5) {
        return reply.code(400).send({ error: 'Provide 2–5 ids' })
      }
      if (!(await can(req.user!, 'update', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const rows = (await db(collection).whereIn('id', ids)) as Array<Record<string, unknown>>
      if (rows.length !== ids.length) {
        return reply.code(404).send({ error: 'Some records were not found' })
      }

      const refs = await inboundRefs(collection)
      const refCounts: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]))
      for (const ref of refs) {
        try {
          if (!(await columnExists(ref.table, ref.column))) continue
          const counts = (await db(ref.table)
            .whereIn(ref.column, ids)
            .groupBy(ref.column)
            .select(ref.column)
            .count({ n: '*' })) as Array<Record<string, unknown>>
          for (const c of counts) {
            const key = String(c[ref.column])
            refCounts[key] = (refCounts[key] ?? 0) + Number(c.n)
          }
        } catch {
          /* physical mismatch — skip */
        }
      }

      // Field metadata: skip alias rows (no physical column)
      const fieldRows = (await db('nivaro_fields')
        .where({ collection })
        .select('field', 'type', 'interface')) as Array<{
        field: string
        type: string | null
        interface: string | null
      }>
      const physical = new Set(Object.keys(rows[0] ?? {}))
      const fields = fieldRows
        .filter((f) => physical.has(f.field) && f.field !== 'id')
        .map((f) => f.field)
        .sort()

      return reply.send({
        data: {
          records: ids.map((id) => rows.find((r) => String(r.id) === id)),
          fields,
          reference_counts: refCounts,
          relations: refs.length
        }
      })
    }
  )

  app.post<{
    Body: {
      collection?: string
      survivor_id?: string
      loser_ids?: string[]
      field_choices?: Record<string, unknown>
    }
  }>('/', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, survivor_id, loser_ids, field_choices } = req.body ?? {}
    if (!collection || !/^[a-zA-Z0-9_]+$/.test(collection) || collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    if (!survivor_id || !Array.isArray(loser_ids) || loser_ids.length === 0) {
      return reply.code(400).send({ error: 'survivor_id and loser_ids are required' })
    }
    if (loser_ids.includes(survivor_id)) {
      return reply.code(400).send({ error: 'Survivor cannot also be a loser' })
    }
    if (
      !(await can(req.user!, 'update', collection)) ||
      !(await can(req.user!, 'delete', collection))
    ) {
      return reply.code(403).send({ error: 'Merge needs update + delete permission' })
    }

    const survivor = await db(collection).where({ id: survivor_id }).first()
    if (!survivor) return reply.code(404).send({ error: 'Survivor not found' })

    const refs = await inboundRefs(collection)
    let repointed = 0

    for (const ref of refs) {
      try {
        if (!(await columnExists(ref.table, ref.column))) continue
        if (ref.kind === 'm2m') {
          // Repoint junction rows one by one; drop rows that would duplicate
          // an existing (other-columns, survivor) pairing.
          const junctionRows = (await db(ref.table).whereIn(
            ref.column,
            loser_ids
          )) as Array<Record<string, unknown>>
          for (const jr of junctionRows) {
            const otherCols = Object.entries(jr).filter(
              ([k]) => k !== 'id' && k !== ref.column
            )
            const dupQ = db(ref.table).where({ [ref.column]: survivor_id })
            for (const [k, v] of otherCols) {
              if (v === null) dupQ.whereNull(k)
              else dupQ.where({ [k]: v })
            }
            const dup = await dupQ.first()
            if (dup) {
              await db(ref.table).where({ id: jr.id }).del()
            } else {
              await db(ref.table)
                .where({ id: jr.id })
                .update({ [ref.column]: survivor_id })
              repointed++
            }
          }
        } else {
          repointed += await db(ref.table)
            .whereIn(ref.column, loser_ids)
            .update({ [ref.column]: survivor_id })
        }
      } catch (err) {
        console.warn(`[merge] repoint failed for ${ref.table}.${ref.column}:`, err)
      }
    }

    // Apply chosen survivor values through the items service
    if (field_choices && Object.keys(field_choices).length > 0) {
      const changes = { ...field_choices }
      delete changes.id
      await updateOne(req.user!, collection, survivor_id, changes, req)
    }

    // Losers → items-service delete (lands in trash, hooks fire)
    const deleted: string[] = []
    for (const loserId of loser_ids) {
      try {
        await deleteOne(req.user!, collection, loserId, req)
        deleted.push(loserId)
      } catch (err) {
        console.warn(`[merge] loser delete failed for ${loserId}:`, err)
      }
    }

    await logActivity({
      action: 'merge',
      collection,
      item: String(survivor_id),
      user: req.user!.id,
      comment: `Merged ${deleted.join(', ')} into ${survivor_id} (${repointed} references repointed)`,
      req
    })

    return reply.send({
      data: { survivor_id, merged: deleted, repointed }
    })
  })
}
