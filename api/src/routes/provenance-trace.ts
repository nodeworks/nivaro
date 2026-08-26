import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'

/**
 * Value provenance trace (#694) — "why does this field hold this value".
 *
 * GET /provenance-trace/:collection/:id/:field →
 *   current      the value as stored right now (physical columns only)
 *   derivations  every configured way the value can be machine-derived:
 *                computed/rollup formula, field rules targeting it, auto-id
 *                pattern, workflow transition action writebacks
 *   changes      the actual value history mined from revision deltas
 *                (deltas store NEW values — "from" is the older neighbour),
 *                each classified manual/import/integration/automation the
 *                same way field-history + last-touch classify.
 *
 * Read-only composition over data the system already stores.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

interface Derivation {
  kind: 'computed' | 'rollup' | 'field_rule' | 'auto_id' | 'transition_action'
  description: string
  /** Where to inspect further, when there's an obvious surface. */
  link?: string
}

function classifyVia(r: {
  action: string | null
  comment: string | null
  actor: string | null
  email: string | null
  legacy_id: number | null
}): string {
  const c = (r.comment ?? '').toLowerCase()
  const a = (r.action ?? '').toLowerCase()
  if (r.legacy_id != null || c === 'legacy-import' || c.startsWith('forecast-import:')) {
    return 'import'
  }
  if (a.startsWith('import') || /import/.test(c)) return 'import'
  if (c === 'reforecast' || c.includes('replay')) return 'automation'
  const email = (r.email ?? '').toLowerCase()
  if (email.endsWith('@nivaro.local') || email.includes('integration')) return 'integration'
  if (a.includes(':')) return 'integration' // extension-namespaced action
  if (!r.actor) return 'automation'
  return 'manual'
}

export async function provenanceTraceRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; id: string; field: string } }>(
    '/provenance-trace/:collection/:id/:field',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id, field } = req.params
      if (
        !IDENT_RE.test(collection) ||
        !IDENT_RE.test(field) ||
        /^nivaro_/i.test(collection) ||
        /^directus_/i.test(collection)
      ) {
        return reply.code(400).send({ error: 'Not a valid target' })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      // ── Current value (physical columns only — virtual fields have no
      //    stored value to show; the derivation cards explain those) ─────────
      const colRows = (await db.raw(
        `SELECT 1 AS x FROM information_schema.columns WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [collection, field]
      )) as Array<{ x: number }>
      const physical = colRows.length > 0
      let current: unknown = null
      let recordExists = false
      if (physical) {
        try {
          const row = (await db(collection).where({ id }).first(field)) as
            | Record<string, unknown>
            | undefined
          recordExists = !!row
          current = row ? row[field] : null
        } catch {
          /* unreadable column — leave null */
        }
      } else {
        recordExists = !!(await db(collection)
          .where({ id })
          .first('id')
          .catch(() => null))
      }

      // ── Derivations — every configured writer of this field ──────────────
      const derivations: Derivation[] = []
      const fieldRow = (await db('nivaro_fields')
        .where({ collection, field })
        .first('computed_formula', 'computed_type', 'computed_store', 'options')) as
        | {
            computed_formula: string | null
            computed_type: string | null
            computed_store: boolean | number | null
            options: string | null
          }
        | undefined

      if (fieldRow?.computed_formula) {
        const isRollup =
          fieldRow.computed_type === 'rollup' ||
          (() => {
            try {
              const parsed = JSON.parse(fieldRow.computed_formula ?? '') as Record<string, unknown>
              return !!(parsed && (parsed.sources || parsed.related_collection))
            } catch {
              return false
            }
          })()
        if (isRollup) {
          derivations.push({
            kind: 'rollup',
            description: `${fieldRow.computed_store ? 'Stored' : 'Virtual'} rollup over related records — the value is an aggregate, not a direct entry`,
            link: `/api/lineage/${collection}/${encodeURIComponent(id)}/${field}`
          })
        } else {
          derivations.push({
            kind: 'computed',
            description: `Computed (${fieldRow.computed_type ?? 'read'}${fieldRow.computed_store ? ', stored' : ''}): ${fieldRow.computed_formula}`
          })
        }
      }

      if (fieldRow?.options) {
        try {
          const opts = JSON.parse(fieldRow.options) as { auto_id?: { pattern?: string } | string }
          const pattern =
            typeof opts.auto_id === 'string' ? opts.auto_id : (opts.auto_id?.pattern ?? null)
          if (opts.auto_id && pattern) {
            derivations.push({
              kind: 'auto_id',
              description: `Auto-generated id — pattern: ${pattern}`
            })
          } else if (opts.auto_id) {
            derivations.push({ kind: 'auto_id', description: 'Auto-generated id field' })
          }
        } catch {
          /* options not JSON */
        }
      }

      try {
        const rules = (await db('nivaro_field_rules')
          .where({ collection, target_field: field })
          .orderBy('sort', 'asc')) as Array<{
          trigger_field: string
          trigger_op: string
          trigger_value: string | null
          target_type: string
          target_value: string | null
          is_active: boolean | number
        }>
        for (const r of rules) {
          const active = r.is_active === true || r.is_active === 1
          derivations.push({
            kind: 'field_rule',
            description: `${active ? '' : '(inactive) '}Field rule: when ${r.trigger_field} ${r.trigger_op}${r.trigger_value ? ` ${r.trigger_value}` : ''} → ${r.target_type}${r.target_value ? ` "${r.target_value}"` : ''}`,
            link: `/data-model/${collection}?tab=rules`
          })
        }
      } catch {
        /* surface degrades to nothing */
      }

      try {
        const bindings = (await db('nivaro_workflow_bindings')
          .where({ collection })
          .select('template')) as Array<{ template: string }>
        const templateIds = [...new Set(bindings.map((b) => String(b.template)))]
        if (templateIds.length > 0) {
          const transitions = (await db('nivaro_workflow_transitions')
            .whereIn('template', templateIds)
            .whereNotNull('actions')
            .where('actions', 'like', `%"${field.replace(/[%_[]/g, (c) => `[${c}]`)}"%`)
            .select('id', 'label', 'actions', 'template')) as Array<{
            id: string
            label: string | null
            actions: string | null
          }>
          for (const t of transitions) {
            try {
              const actions = JSON.parse(t.actions ?? '[]') as Array<Record<string, unknown>>
              const writes: string[] = []
              for (const a of actions) {
                const onSuccess = (a.on_success ?? {}) as Record<string, unknown>
                const onFailure = (a.on_failure ?? {}) as Record<string, unknown>
                if (field in onSuccess) writes.push('on success')
                if (field in onFailure) writes.push('on failure')
              }
              if (writes.length > 0) {
                derivations.push({
                  kind: 'transition_action',
                  description: `Workflow transition "${t.label ?? t.id}" writes this field ${[...new Set(writes)].join(' / ')}`
                })
              }
            } catch {
              /* unparseable actions — the LIKE hit stays unreported */
            }
          }
        }
      } catch {
        /* surface degrades to nothing */
      }

      // ── Value changes from revision deltas ───────────────────────────────
      const revRows = (await db('nivaro_revisions as r')
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

      const entries: Array<{
        value: unknown
        when: string | null
        who: string | null
        via: string
        action: string
        note: string | null
      }> = []
      for (const r of revRows) {
        if (entries.length >= 60) break
        let source: Record<string, unknown> | null = null
        let action = r.action ?? 'update'
        if (r.delta) {
          try {
            source = JSON.parse(r.delta) as Record<string, unknown>
          } catch {
            source = null
          }
        }
        if (!source && r.action === 'create' && r.data) {
          try {
            source = JSON.parse(r.data) as Record<string, unknown>
            action = 'create'
          } catch {
            source = null
          }
        }
        if (!source || !(field in source)) continue
        const via = classifyVia(r)
        entries.push({
          value: source[field],
          when: r.timestamp ? new Date(r.timestamp).toISOString() : null,
          who: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || null,
          via,
          action,
          note: via === 'manual' && r.comment && r.comment.length <= 200 ? r.comment : null
        })
      }

      // Collapse restated values (rules/imports re-write the same value) —
      // consecutive identical values keep the newest occurrence only.
      const collapsed: typeof entries = []
      for (let i = 0; i < entries.length; i++) {
        const older = entries[i + 1]
        if (older && JSON.stringify(entries[i].value) === JSON.stringify(older.value)) continue
        collapsed.push(entries[i])
      }
      // kept[i] === collapsed[i], so the older neighbour is collapsed[i + 1]
      const changes = collapsed.slice(0, 25).map((e, i) => ({
        when: e.when,
        who: e.who,
        from: e.action === 'create' ? null : (collapsed[i + 1]?.value ?? null),
        to: e.value,
        via: e.via,
        action: e.action,
        note: e.note
      }))

      return reply.send({
        data: {
          collection,
          id,
          field,
          record_exists: recordExists,
          physical_column: physical,
          current,
          derivations,
          changes
        }
      })
    }
  )
}
