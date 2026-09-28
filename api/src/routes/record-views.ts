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

export interface RecordRecap {
  field_changes: number
  /** Human labels of the changed fields (first 8); empty when labels were skipped. */
  fields: string[]
  comments: number
  transitions: number
  editors: string[]
}

/**
 * What OTHER people did to one record after `since`: field changes (revision
 * deltas of create/update activity), comments, workflow transitions, and the
 * names of whoever edited. Read-only — it never moves a watermark. Shared by
 * the /touch recap and the dashboard's changed-since read.
 *
 * Every source is best-effort — a missing table or column degrades to zero,
 * never a 500.
 */
export async function recordRecapSince(
  collection: string,
  id: string,
  userId: string,
  since: Date,
  opts: { labels?: boolean } = {}
): Promise<RecordRecap> {
  const [activity, comments, transitions] = await Promise.all([
    db('nivaro_activity as a')
      .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
      .leftJoin('nivaro_users as u', 'u.id', 'a.user')
      .where({ 'a.collection': collection, 'a.item': id })
      .whereIn('a.action', ['create', 'update'])
      .where('a.timestamp', '>', since)
      .where((b) => b.whereNull('a.user').orWhereNot('a.user', userId))
      .select('a.user', 'u.first_name', 'u.last_name', 'u.email', 'r.delta')
      .catch(() => [] as never[]),
    db('nivaro_comments')
      .where({ collection, item: id })
      .where('created_at', '>', since)
      .whereNot('user', userId)
      .count({ c: '*' })
      .first()
      .catch(() => ({ c: 0 })),
    db('nivaro_workflow_history as h')
      .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
      .where({ 'i.collection': collection, 'i.item': id })
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

  // Human labels, not machine names — nivaro_fields.label when set, else
  // the same titlecased fallback every form header uses.
  const fieldList = [...fields].slice(0, 8)
  let fieldLabels: string[] = []
  if (opts.labels !== false && fieldList.length > 0) {
    const labelRows = (await db('nivaro_fields')
      .where('collection', collection)
      .whereIn('field', fieldList)
      .select('field', 'label')
      .catch(() => [])) as Array<{ field: string; label: string | null }>
    const labelMap = new Map(labelRows.map((r) => [r.field, r.label]))
    fieldLabels = fieldList.map(
      (f) => labelMap.get(f) || f.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    )
  }

  return {
    field_changes: fields.size,
    fields: fieldLabels,
    comments: Number((comments as { c?: unknown })?.c ?? 0),
    transitions: Number((transitions as { c?: unknown })?.c ?? 0),
    editors: [...editors].slice(0, 5)
  }
}

export async function recordViewRoutes(app: FastifyInstance) {
  /** #43 — the caller's recently viewed records, newest first, with the
   *  record's friendly label and current pipeline state. The watermark table
   *  already knows every record the person opened; this is a read of it
   *  dressed for a rail. Collections the person cannot read are skipped. */
  app.get<{ Querystring: { limit?: string } }>(
    '/record-views/recent',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.user!.id
      const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 10))
      const rows = (await db('nivaro_record_views')
        .where({ user: userId })
        .orderBy('last_viewed_at', 'desc')
        .limit(limit * 2)
        .select('collection', 'item_id', 'last_viewed_at')) as Array<{
        collection: string
        item_id: string
        last_viewed_at: Date
      }>
      const visible: typeof rows = []
      const readable = new Map<string, boolean>()
      for (const r of rows) {
        if (/^nivaro_/i.test(r.collection)) continue
        let ok = readable.get(r.collection)
        if (ok === undefined) {
          ok = req.isAdmin || (await can(req.user!, 'read', r.collection).catch(() => false))
          readable.set(r.collection, ok)
        }
        if (ok) visible.push(r)
        if (visible.length >= limit) break
      }
      if (visible.length === 0) return reply.send({ data: [] })
      const byCollection = new Map<string, Set<string>>()
      for (const r of visible) {
        const set = byCollection.get(r.collection) ?? new Set<string>()
        set.add(String(r.item_id))
        byCollection.set(r.collection, set)
      }
      let labels: Record<string, string> = {}
      try {
        const { getLabels } = await import('../services/queues.js')
        labels = await getLabels(byCollection)
      } catch {
        labels = {}
      }
      const friendly = new Map<string, string>()
      try {
        const { resolveFriendlyId } = await import('../services/workflow-transitions.js')
        for (const r of visible) {
          const f = await resolveFriendlyId(r.collection, String(r.item_id)).catch(() => null)
          if (f && f !== String(r.item_id)) friendly.set(`${r.collection}:${r.item_id}`, f)
        }
      } catch {
        /* labels still answer */
      }
      const instances = (await db('nivaro_workflow_instances as wi')
        .join('nivaro_workflow_states as s', 'wi.current_state', 's.id')
        .where((qb) => {
          for (const [collection, ids] of byCollection)
            void qb.orWhere((q2) =>
              q2.where('wi.collection', collection).whereIn('wi.item', [...ids])
            )
        })
        .select('wi.collection', 'wi.item', 's.key', 's.label', 's.color')
        .catch(() => [])) as Array<Record<string, unknown>>
      const stateByKey = new Map(
        instances.map((i) => [
          `${i.collection}:${i.item}`,
          { key: i.key, label: i.label, color: i.color }
        ])
      )
      return reply.send({
        data: visible.map((r) => {
          const k = `${r.collection}:${r.item_id}`
          return {
            collection: r.collection,
            item_id: String(r.item_id),
            label: friendly.get(k) ?? labels[k] ?? `#${r.item_id}`,
            state: stateByKey.get(k) ?? null,
            last_viewed_at: r.last_viewed_at
          }
        })
      })
    }
  )

  // Dismissing the recap means "I have seen these changes": the diff baseline
  // collapses to now, so a refresh inside the session grace (which deliberately
  // keeps the baseline stable) no longer re-renders the same recap. Anything
  // that changes AFTER the dismissal still shows on the next open.
  app.post<{ Params: { collection: string; id: string } }>(
    '/record-views/:collection/:id/dismiss',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!IDENT.test(collection) || /^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      const now = new Date()
      await db('nivaro_record_views')
        .where({ user: req.user!.id, collection, item_id: String(id) })
        .update({ last_viewed_at: now, prev_viewed_at: now })
      return reply.send({ data: { ok: true } })
    }
  )

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
        .first()) as { id: number; last_viewed_at: Date; prev_viewed_at: Date | null } | undefined

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

      const recap = await recordRecapSince(collection, String(id), userId, since)
      if (recap.field_changes === 0 && recap.comments === 0 && recap.transitions === 0) {
        return reply.send({ data: null })
      }
      return reply.send({ data: { since: since.toISOString(), ...recap } })
    }
  )

  /** Who has opened this record, newest first — the audit companion to the
   *  recap ("did the approver actually look?"). Admin-only: viewing habits
   *  are behavioral data, not record data. */
  app.get<{ Params: { collection: string; id: string } }>(
    '/record-views/:collection/:id/viewers',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!IDENT.test(collection) || /^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
      const rows = await db('nivaro_record_views as v')
        .leftJoin('nivaro_users as u', 'u.id', 'v.user')
        .where({ 'v.collection': collection, 'v.item_id': String(id) })
        .orderBy('v.last_viewed_at', 'desc')
        .limit(50)
        .select('v.user', 'v.last_viewed_at', 'u.first_name', 'u.last_name', 'u.email')
      return reply.send({
        data: rows.map((r) => ({
          user_id: r.user,
          name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || 'Unknown',
          last_viewed_at: new Date(r.last_viewed_at).toISOString()
        }))
      })
    }
  )
}
