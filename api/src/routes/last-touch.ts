import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'

/**
 * "Edited 3d ago by Beth" — the newest human-relevant activity row for one
 * record, for the record-header chip. Deliberately its own tiny endpoint:
 * the /activity listing is admin-gated and has no per-item filter, and the
 * chip needs exactly one row.
 */
export async function lastTouchRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; id: string } }>(
    '/last-touch/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) || /^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const row = (await db('nivaro_activity as a')
        .leftJoin('nivaro_users as u', 'a.user', 'u.id')
        .where({ 'a.collection': collection, 'a.item': String(id) })
        .whereIn('a.action', ['create', 'update'])
        .orderBy('a.id', 'desc')
        .first(
          'a.action',
          'a.timestamp',
          'a.user',
          'u.first_name',
          'u.last_name',
          'u.email'
        )) as
        | {
            action: string
            timestamp: Date
            user: string | null
            first_name: string | null
            last_name: string | null
            email: string | null
          }
        | undefined
      if (!row) return reply.send({ data: null })
      return reply.send({
        data: {
          action: row.action,
          timestamp: new Date(row.timestamp).toISOString(),
          user_id: row.user ?? null,
          user_name:
            [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || null
        }
      })
    }
  )

  /**
   * Provenance (#29): where this record CAME FROM, mined from the earliest
   * activity on it. Honest about the gaps — a row with no creation activity
   * (raw importer writes, pre-audit history) says so rather than guessing.
   */
  app.get<{ Params: { collection: string; id: string } }>(
    '/provenance/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) || /^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      // Provenance judges the record's ORIGIN — bookkeeping rows must not
      // outrank it. Per-collection read logging can write a 'read' row
      // milliseconds before the create lands (the reported false 'likely
      // imported' on a form-created record), and lock heartbeats are noise.
      const first = (await db('nivaro_activity as a')
        .leftJoin('nivaro_users as u', 'a.user', 'u.id')
        .where({ 'a.collection': collection, 'a.item': String(id) })
        .whereNotIn('a.action', ['read', 'lock-acquire', 'lock-release'])
        .orderBy('a.id', 'asc')
        .first(
          'a.id',
          'a.action',
          'a.timestamp',
          'a.comment',
          'a.legacy_id',
          'a.user',
          'u.first_name',
          'u.last_name',
          'u.email',
          'u.status'
        )) as
        | {
            id: number
            action: string
            timestamp: Date
            comment: string | null
            legacy_id: number | null
            user: string | null
            first_name: string | null
            last_name: string | null
            email: string | null
            status: string | null
          }
        | undefined
      if (!first) return reply.send({ data: null })

      const name = [first.first_name, first.last_name].filter(Boolean).join(' ') || first.email
      let origin = 'Manual'
      if (first.legacy_id != null) origin = 'Legacy import'
      else if (first.action !== 'create') origin = 'No creation record — likely imported'
      else if (!first.user) origin = 'Public form'
      else if (first.status === 'suspended' && /@(nivaro|invalid)\.local$/i.test(String(first.email ?? ''))) {
        origin = 'Integration'
      } else if (/import/i.test(String(first.comment ?? ''))) origin = 'Import'
      else {
        // An extension breadcrumb (namespaced "<ext>:<action>") stamped on
        // this record around creation names the pipeline that made it.
        const ext = (await db('nivaro_activity')
          .where({ collection, item: String(id) })
          .where('action', 'like', '%:%')
          .whereRaw('ABS(DATEDIFF(second, timestamp, ?)) < 120', [new Date(first.timestamp)])
          .orderBy('id', 'asc')
          .first('action')
          .catch(() => null)) as { action: string } | null | undefined
        if (ext) origin = `Integration (${String(ext.action).split(':')[0]})`
      }
      return reply.send({
        data: {
          origin,
          created: first.action === 'create' || first.legacy_id != null,
          timestamp: new Date(first.timestamp).toISOString(),
          user_name: name ?? null
        }
      })
    }
  )
}
