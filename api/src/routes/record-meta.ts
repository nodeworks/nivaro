import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'

/**
 * Record & Form UX sprint routes: audience panel (#123), integrations tab
 * (#241), owner history (#144). All read-only aggregations, read-gated by
 * can() on the record's collection.
 */

async function nameOf(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const rows = (await db('nivaro_users')
    .whereIn('id', userIds)
    .select('id', 'first_name', 'last_name', 'email')) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  return new Map(
    rows.map((r) => [
      String(r.id).toUpperCase(),
      [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.id
    ])
  )
}

export async function recordMetaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth)

  // ── Record audience (#123): who hears about a change, and how ────────────
  app.get<{ Params: { collection: string; item: string } }>(
    '/audience/:collection/:item',
    async (req, reply) => {
      const { collection, item } = req.params
      if (!(await can(req.user!, 'read', collection)))
        return reply.code(403).send({ error: 'Forbidden' })

      // Field watchers on this collection (record-scoped or collection-wide).
      const watches = (await db('nivaro_field_watches as w')
        .join('nivaro_field_watch_subscribers as ws', 'ws.watch', 'w.id')
        .where('w.collection', collection)
        .where((q) => q.where('w.item_id', item).orWhereNull('w.item_id'))
        .select('ws.user', 'w.field')) as Array<{ user: string; field: string }>

      // Notification subscriptions matching this collection (record-id
      // filtered ones only when they name THIS record).
      const subs = (await db('nivaro_notification_subscriptions')
        .where({ collection, is_active: true })
        .select('user', 'filter_field', 'filter_value', 'digest_frequency', 'event_type')) as Array<{
        user: string
        filter_field: string | null
        filter_value: string | null
        digest_frequency: string
        event_type: string
      }>
      const matchingSubs = subs.filter(
        (sub) =>
          !sub.filter_field ||
          sub.filter_field !== 'id' ||
          String(sub.filter_value) === String(item)
      )

      // Current pipeline owners + their active delegates.
      let owners: Array<{ id: string; name: string }> = []
      try {
        const inst = (await db('nivaro_workflow_instances')
          .where({ collection, item: String(item) })
          .orderBy('started_at', 'desc')
          .first()) as { id: string; current_state: string } | undefined
        if (inst?.current_state) {
          const { resolveStateOwners } = await import('../services/pipeline-engine.js')
          owners = (
            await resolveStateOwners(inst.current_state, inst.id, collection, String(item))
          ).map((o) => ({
            id: o.id,
            name: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
          }))
        }
      } catch {
        owners = []
      }

      const allIds = [
        ...new Set([...watches.map((w) => w.user), ...matchingSubs.map((sub) => sub.user)])
      ]
      const names = await nameOf(allIds)
      return reply.send({
        data: {
          watchers: watches.map((w) => ({
            user: w.user,
            name: names.get(String(w.user).toUpperCase()) ?? w.user,
            field: w.field
          })),
          subscribers: matchingSubs.map((sub) => ({
            user: sub.user,
            name: names.get(String(sub.user).toUpperCase()) ?? sub.user,
            cadence: sub.digest_frequency,
            event_type: sub.event_type
          })),
          owners
        }
      })
    }
  )

  // ── Record integrations (#241): every push/delivery about this record ────
  app.get<{ Params: { collection: string; item: string } }>(
    '/record-integrations/:collection/:item',
    async (req, reply) => {
      const { collection, item } = req.params
      if (!(await can(req.user!, 'read', collection)))
        return reply.code(403).send({ error: 'Forbidden' })
      const [erp, webhooks] = await Promise.all([
        db('nivaro_erp_submissions')
          .where({ collection, item: String(item) })
          .orderBy('id', 'desc')
          .limit(30)
          .select('id', 'target', 'endpoint_path', 'status', 'created_at', 'last_error', 'attempts')
          .catch(() => []),
        db('nivaro_webhook_deliveries as d')
          .join('nivaro_webhooks as w', 'w.id', 'd.webhook')
          .whereRaw("d.payload LIKE ?", [`%"id":${JSON.stringify(String(item)).replace(/^"|"$/g, '')}%`])
          .where('w.collection', collection)
          .orderBy('d.id', 'desc')
          .limit(20)
          .select('d.id', 'w.name as webhook', 'd.response_status', 'd.created_at')
          .catch(() => [])
      ])
      return reply.send({ data: { erp, webhooks } })
    }
  )

  // ── Owner history (#144): who held the record when ───────────────────────
  // Derived from workflow history: each stay in a state paired with that
  // state's CURRENT owner resolution — an approximation (group membership
  // changes over time aren't snapshotted), labeled as such by the client.
  app.get<{ Params: { collection: string; item: string } }>(
    '/owner-history/:collection/:item',
    async (req, reply) => {
      const { collection, item } = req.params
      if (!(await can(req.user!, 'read', collection)))
        return reply.code(403).send({ error: 'Forbidden' })
      const inst = (await db('nivaro_workflow_instances')
        .where({ collection, item: String(item) })
        .orderBy('started_at', 'desc')
        .first()) as { id: string } | undefined
      if (!inst) return reply.send({ data: [] })
      const history = (await db('nivaro_workflow_history as h')
        .leftJoin('nivaro_workflow_states as s', 's.id', 'h.to_state')
        .leftJoin('nivaro_users as u', 'u.id', 'h.user')
        .where('h.instance', inst.id)
        .orderBy('h.timestamp', 'asc')
        .limit(100)
        .select(
          'h.to_state',
          's.label as state_label',
          'h.timestamp',
          db.raw("CONCAT(u.first_name, ' ', u.last_name) as actor")
        )) as Array<{
        to_state: string
        state_label: string | null
        timestamp: Date
        actor: string | null
      }>
      const { resolveStateOwners } = await import('../services/pipeline-engine.js')
      const ownerCache = new Map<string, Array<{ id: string; name: string }>>()
      const out: Array<Record<string, unknown>> = []
      for (const [i, h] of history.entries()) {
        let owners = ownerCache.get(h.to_state)
        if (!owners) {
          try {
            owners = (
              await resolveStateOwners(h.to_state, inst.id, collection, String(item))
            ).map((o) => ({
              id: o.id,
              name: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
            }))
          } catch {
            owners = []
          }
          ownerCache.set(h.to_state, owners)
        }
        const next = history[i + 1]
        out.push({
          state_label: h.state_label,
          entered_at: h.timestamp,
          left_at: next?.timestamp ?? null,
          moved_by: h.actor?.trim() || null,
          owners
        })
      }
      return reply.send({ data: out })
    }
  )
}
