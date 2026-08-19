import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'

function parseJson(val: unknown): Record<string, unknown> | null {
  if (val == null) return null
  if (typeof val === 'object') return val as Record<string, unknown>
  try {
    const parsed = JSON.parse(String(val))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * "Since you last looked" — per-user record view watermarks + the recap the
 * record form shows when a previously-visited record changed underneath you.
 *
 * One endpoint: opening a record POSTs /touch, which rolls the watermark AND
 * returns the recap against the previous one in the same round trip. The
 * watermark only rolls forward when the last open is more than SESSION_GRACE
 * old, so refreshing (or bouncing between tabs) doesn't erase the recap you
 * were just reading.
 *
 * Everything the recap counts is OTHER people's activity — your own edits are
 * not news to you.
 */
const SESSION_GRACE_MS = 30 * 60 * 1000
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export async function recordViewRoutes(app: FastifyInstance) {
  app.post<{ Params: { collection: string; id: string } }>(
    '/record-views/:collection/:id/touch',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      const userId = req.user!.id
      if (!IDENT.test(collection) || /^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const now = new Date()
      const existing = (await db('nivaro_record_views')
        .where({ user: userId, collection, item_id: String(id) })
        .first()) as
        | { id: number; last_viewed_at: Date; prev_viewed_at: Date | null }
        | undefined

      let since: Date | null = null
      if (!existing) {
        try {
          await db('nivaro_record_views').insert({
            user: userId,
            collection,
            item_id: String(id),
            last_viewed_at: now,
            prev_viewed_at: null
          })
        } catch {
          // Insert race (two tabs opening at once) — the other tab's row wins.
        }
      } else {
        const last = new Date(existing.last_viewed_at)
        if (now.getTime() - last.getTime() > SESSION_GRACE_MS) {
          // A genuinely new visit: yesterday's open becomes the diff baseline.
          await db('nivaro_record_views')
            .where('id', existing.id)
            .update({ last_viewed_at: now, prev_viewed_at: last })
          since = last
        } else {
          // Same session (refresh, tab bounce): keep the baseline stable.
          await db('nivaro_record_views').where('id', existing.id).update({ last_viewed_at: now })
          since = existing.prev_viewed_at ? new Date(existing.prev_viewed_at) : null
        }
      }

      if (!since) return reply.send({ data: null })

      // ── Recap: what OTHERS did between `since` and now ─────────────────────
      // Every source is best-effort — a missing table or column must degrade
      // to zero, never 500 the record form.
      const [activity, comments, transitions] = await Promise.all([
        db('nivaro_activity as a')
          .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
          .leftJoin('nivaro_users as u', 'u.id', 'a.user')
          .where({ 'a.collection': collection, 'a.item': String(id) })
          .whereIn('a.action', ['create', 'update'])
          .where('a.timestamp', '>', since)
          .where((b) => b.whereNull('a.user').orWhereNot('a.user', userId))
          .select('a.user', 'u.first_name', 'u.last_name', 'u.email', 'r.delta')
          .catch(() => [] as never[]),
        db('nivaro_comments')
          .where({ collection, item: String(id) })
          .where('created_at', '>', since)
          .whereNot('user', userId)
          .count({ c: '*' })
          .first()
          .catch(() => ({ c: 0 })),
        db('nivaro_workflow_history as h')
          .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
          .where({ 'i.collection': collection, 'i.item': String(id) })
          .where('h.timestamp', '>', since)
          .where((b) => b.whereNull('h.user').orWhereNot('h.user', userId))
          .count({ c: '*' })
          .first()
          .catch(() => ({ c: 0 }))
      ])

      const fields = new Set<string>()
      const editors = new Set<string>()
      for (const row of activity as Array<Record<string, unknown>>) {
        const name =
          [row.first_name, row.last_name].filter(Boolean).join(' ') ||
          (row.email as string | null) ||
          null
        if (name) editors.add(name)
        const delta = parseJson(row.delta as string | null)
        if (delta && typeof delta === 'object') {
          for (const k of Object.keys(delta as Record<string, unknown>)) fields.add(k)
        }
      }

      const fieldChanges = fields.size
      const commentCount = Number((comments as { c?: unknown })?.c ?? 0)
      const transitionCount = Number((transitions as { c?: unknown })?.c ?? 0)
      if (fieldChanges === 0 && commentCount === 0 && transitionCount === 0) {
        return reply.send({ data: null })
      }

      // Human labels, not machine names — nivaro_fields.label when set, else
      // the same titlecased fallback every form header uses.
      const fieldList = [...fields].slice(0, 8)
      let fieldLabels = fieldList
      if (fieldList.length > 0) {
        const labelRows = (await db('nivaro_fields')
          .where('collection', collection)
          .whereIn('field', fieldList)
          .select('field', 'label')
          .catch(() => [])) as Array<{ field: string; label: string | null }>
        const labelMap = new Map(labelRows.map((r) => [r.field, r.label]))
        fieldLabels = fieldList.map(
          (f) =>
            labelMap.get(f) ||
            f.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        )
      }

      return reply.send({
        data: {
          since: since.toISOString(),
          field_changes: fieldChanges,
          fields: fieldLabels,
          comments: commentCount,
          transitions: transitionCount,
          editors: [...editors].slice(0, 5)
        }
      })
    }
  )
}
