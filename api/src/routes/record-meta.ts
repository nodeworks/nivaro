import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'

/**
 * Record & Form UX sprint routes: audience panel (#123), integrations tab
 * (#241), owner history (#144). All read-only aggregations, read-gated by
 * can() on the record's collection.
 */

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
        .select(
          'user',
          'filter_field',
          'filter_value',
          'filters',
          'digest_frequency',
          'event_type'
        )) as Array<{
        user: string
        filter_field: string | null
        filter_value: string | null
        filters: string | null
        digest_frequency: string
        event_type: string
      }>
      let matchingSubs = subs.filter(
        (sub) =>
          !sub.filter_field ||
          sub.filter_field !== 'id' ||
          String(sub.filter_value) === String(item)
      )
      // Dimension-scoped subscriptions (`filters` JSON — the EFP-imported
      // division prefs) are evaluated against THIS record with the same
      // evaluator the notification hook uses, so a Zone-2 subscriber doesn't
      // count toward a Zone-3 record's audience.
      if (matchingSubs.some((sub) => sub.filters)) {
        try {
          const { filterMatches } = await import('../hooks/notification-subscriptions.js')
          const { resolveRecordValue } = await import('../services/workflow-transitions.js')
          const record = ((await db(collection).where({ id: item }).first()) ?? {}) as Record<
            string,
            unknown
          >
          const valueCache = new Map<string, unknown>()
          const getValue = async (path: string) => {
            if (!valueCache.has(path)) {
              valueCache.set(path, await resolveRecordValue(collection, record, path, item, db))
            }
            return valueCache.get(path)
          }
          const kept: typeof matchingSubs = []
          for (const sub of matchingSubs) {
            let filters: Array<{ field?: string; op?: string; value?: unknown }> = []
            try {
              const parsed = sub.filters ? JSON.parse(sub.filters) : []
              filters = Array.isArray(parsed) ? parsed : []
            } catch {
              filters = []
            }
            let pass = true
            for (const f of filters) {
              if (!f?.field || !f.op) continue
              const actual = await getValue(f.field)
              if (!filterMatches(f.op as never, actual, f.value)) {
                pass = false
                break
              }
            }
            if (pass) kept.push(sub)
          }
          matchingSubs = kept
        } catch {
          /* filter evaluation is best-effort — over-report beats a 500 */
        }
      }

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

      // One row per PERSON: redacted/suspended users are dropped entirely
      // (they can't receive anything), and a user who is owner + watcher +
      // subscriber appears once with every channel listed — the raw
      // three-list shape repeated the same names over and over.
      const allIds = [
        ...new Set([
          ...watches.map((w) => String(w.user).toUpperCase()),
          ...matchingSubs.map((sub) => String(sub.user).toUpperCase()),
          ...owners.map((o) => String(o.id).toUpperCase())
        ])
      ]
      const eligible = allIds.length
        ? ((await db('nivaro_users')
            .whereIn('id', allIds)
            .where('is_redacted', 0)
            .whereRaw("(status IS NULL OR status <> 'suspended')")
            .select('id', 'first_name', 'last_name', 'email')) as Array<{
            id: string
            first_name: string | null
            last_name: string | null
            email: string | null
          }>)
        : []
      const people = new Map<
        string,
        {
          id: string
          name: string
          owner: boolean
          watch_fields: string[]
          subscriptions: Array<{ event_type: string; cadence: string; reason: string | null }>
        }
      >()
      for (const u of eligible) {
        people.set(String(u.id).toUpperCase(), {
          id: u.id,
          name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.id,
          owner: false,
          watch_fields: [],
          subscriptions: []
        })
      }
      for (const o of owners) {
        const p = people.get(String(o.id).toUpperCase())
        if (p) p.owner = true
      }
      for (const w of watches) {
        const p = people.get(String(w.user).toUpperCase())
        if (p && !p.watch_fields.includes(w.field)) p.watch_fields.push(w.field)
      }
      // State key → label, so "on 'Finance Review' changes" reads human.
      const stateLabels = new Map<string, string>()
      try {
        const binding = (await db('nivaro_workflow_bindings')
          .where({ collection })
          .first('template')) as { template: string } | undefined
        if (binding) {
          const states = (await db('nivaro_workflow_states')
            .where({ template: binding.template })
            .select('key', 'label')) as Array<{ key: string; label: string }>
          for (const s of states) stateLabels.set(s.key, s.label)
        }
      } catch {
        /* labels degrade to raw keys */
      }
      // WHY each subscriber hears: the record bell, a state-scoped sub, an
      // area (dimension-filtered) sub, or a plain collection-wide one.
      const reasonFor = (sub: (typeof matchingSubs)[number]): string | null => {
        let filters: Array<{ field?: string }> = []
        try {
          const parsed = sub.filters ? JSON.parse(sub.filters) : []
          filters = Array.isArray(parsed) ? parsed : []
        } catch {
          filters = []
        }
        if (filters.some((f) => f?.field === 'id') || sub.filter_field === 'id') {
          return 'Subscribed to this record'
        }
        if (sub.event_type === 'workflow_transition' && sub.filter_value) {
          return `On "${stateLabels.get(sub.filter_value) ?? sub.filter_value}" state changes`
        }
        const dims = filters.map((f) => f?.field).filter((f): f is string => !!f)
        if (dims.length > 0) {
          return `Area subscription (${dims.map((d) => d.replace(/_/g, ' ')).join(', ')})`
        }
        return null
      }
      for (const sub of matchingSubs) {
        const p = people.get(String(sub.user).toUpperCase())
        if (!p) continue
        const reason = reasonFor(sub)
        const key = `${sub.event_type}:${sub.digest_frequency}:${reason ?? ''}`
        if (!p.subscriptions.some((s) => `${s.event_type}:${s.cadence}:${s.reason ?? ''}` === key)) {
          p.subscriptions.push({
            event_type: sub.event_type,
            cadence: sub.digest_frequency,
            reason
          })
        }
      }
      const list = [...people.values()].sort(
        (a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name)
      )
      return reply.send({ data: { people: list } })
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
