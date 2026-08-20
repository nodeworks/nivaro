import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'
import { getLabels } from '../services/queues.js'

/**
 * One field's value history — "was $40k until Aug 3 (Beth), then $52k" —
 * mined from the revision deltas the system already stores. Deltas carry NEW
 * values only, so each entry is "became <value> at <time> by <who>"; the
 * record's creation snapshot supplies the original value when it's in reach.
 */
export async function fieldHistoryRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; id: string; field: string } }>(
    '/field-history/:collection/:id/:field',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id, field } = req.params
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ||
        /^nivaro_/i.test(collection)
      ) {
        return reply.code(400).send({ error: 'Not a valid target' })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const rows = (await db('nivaro_revisions as r')
        .leftJoin('nivaro_activity as a', 'r.activity', 'a.id')
        .leftJoin('nivaro_users as u', 'a.user', 'u.id')
        .where({ 'r.collection': collection, 'r.item': String(id) })
        .orderBy('r.id', 'desc')
        .limit(300)
        .select(
          'r.id',
          'r.delta',
          'r.data',
          'r.legacy_id',
          'a.action',
          'a.comment',
          'a.user as actor',
          'a.timestamp',
          'u.first_name',
          'u.last_name',
          'u.email'
        )) as Array<{
        id: number
        delta: string | null
        data: string | null
        legacy_id: number | null
        action: string | null
        comment: string | null
        actor: string | null
        timestamp: Date | null
        first_name: string | null
        last_name: string | null
        email: string | null
      }>

      /** Lineage: WHERE a value came from, not just who. Classified from the
       *  signals the rows already carry — the activity comment's machine
       *  markers, a null actor (system write), integration-identity emails,
       *  and legacy-import provenance. Heuristic and labeled honestly. */
      const classifyOrigin = (r: {
        comment: string | null
        actor: string | null
        email: string | null
        legacy_id: number | null
      }): { kind: string; label: string | null } => {
        const c = (r.comment ?? '').toLowerCase()
        if (r.legacy_id != null || c === 'legacy-import') {
          return { kind: 'import', label: 'Legacy import' }
        }
        if (c === 'reforecast') return { kind: 'automation', label: 'Nightly reforecast' }
        if (c.startsWith('forecast-import:'))
          return { kind: 'import', label: 'Forecast history import' }
        if (c.includes('replay')) return { kind: 'automation', label: 'Flow replay' }
        const email = (r.email ?? '').toLowerCase()
        if (email.endsWith('@nivaro.local') || email.includes('integration')) {
          return { kind: 'integration', label: null }
        }
        if (!r.actor) return { kind: 'automation', label: null }
        return { kind: 'user', label: null }
      }

      const entries: Array<{
        value: unknown
        display: string | null
        timestamp: string | null
        user_name: string | null
        action: string
        origin: { kind: string; label: string | null }
        note: string | null
      }> = []
      for (const r of rows) {
        if (entries.length >= 40) break
        let source: Record<string, unknown> | null = null
        let action = r.action ?? 'update'
        if (r.delta) {
          try {
            source = JSON.parse(r.delta) as Record<string, unknown>
          } catch {
            source = null
          }
        }
        // Creation rows have no delta — the snapshot IS the original value.
        if (!source && r.action === 'create' && r.data) {
          try {
            source = JSON.parse(r.data) as Record<string, unknown>
            action = 'create'
          } catch {
            source = null
          }
        }
        if (!source || !(field in source)) continue
        const origin = classifyOrigin(r)
        entries.push({
          value: source[field],
          display: null,
          timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : null,
          user_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || null,
          action,
          origin,
          // A human change-reason (change_reason_config) rides the activity
          // comment — surface it; machine markers already became the origin.
          note: origin.kind === 'user' && r.comment && r.comment.length <= 200 ? r.comment : null
        })
      }

      // Only ACTUAL changes: a delta can restate the same value (rules/import
      // re-writes) — consecutive identical values collapse to the first
      // (newest) occurrence.
      const changed: typeof entries = []
      for (let i = 0; i < entries.length; i++) {
        const next = entries[i + 1] // older neighbour
        if (next && JSON.stringify(entries[i].value) === JSON.stringify(next.value)) continue
        changed.push(entries[i])
      }
      const out = changed.slice(0, 25)

      // Formatted values, never internal ids:
      //  - M2O FK → the related record's display label
      //  - select-dropdown → the choice's text
      const [rel, fieldRow] = await Promise.all([
        db('nivaro_relations')
          .where({ many_collection: collection, many_field: field })
          .whereNull('junction_field')
          .whereNotNull('one_collection')
          .first('one_collection'),
        db('nivaro_fields').where({ collection, field }).first('options')
      ])
      if (rel?.one_collection) {
        const ids = new Set(
          out.map((e) => e.value).filter((v) => v !== null && v !== undefined && v !== '')
        )
        if (ids.size > 0) {
          try {
            const labels = await getLabels(
              new Map([[String(rel.one_collection), new Set([...ids].map(String))]])
            )
            for (const e of out) {
              if (e.value == null || e.value === '') continue
              e.display = labels[`${rel.one_collection}:${e.value}`] ?? null
            }
          } catch {
            /* labels are decoration */
          }
        }
      } else if (fieldRow?.options) {
        try {
          const opts = JSON.parse(String(fieldRow.options)) as {
            choices?: Array<{ text?: string; value?: unknown }>
          }
          for (const e of out) {
            const choice = opts.choices?.find((c) => String(c.value) === String(e.value))
            if (choice?.text) e.display = String(choice.text).replace(/^\$t:/, '')
          }
        } catch {
          /* not JSON — leave raw */
        }
      }

      return reply.send({ data: out })
    }
  )
}
