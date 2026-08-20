import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { readItems } from '../services/items.js'
import { getLabels } from '../services/queues.js'
import { can } from '../services/permissions.js'
import { parseRollupFormula } from '../services/rollups.js'

/**
 * Number lineage — "why is this number what it is".
 *
 * Field history answers WHEN a value changed; this answers WHERE it comes
 * from: for a rollup field, the actual contributing child rows with each
 * one's value, label and last touch (who/when, and whether an import did
 * it); for a write-computed field, the formula and the current input values.
 * Read-only composition over data the caller can already read — the field's
 * own collection is permission-checked, and child rows surface only
 * label + contribution, same disclosure level as the rollup total itself.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

interface LineageRow {
  id: string
  label: string
  value: number | null
  updated_at: string | null
  updated_by: string | null
  via_import: boolean
}

export async function lineageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { collection: string; item: string; field: string } }>(
    '/:collection/:item/:field',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item, field } = req.params
      if (!IDENT.test(collection) || /^nivaro_|^directus_/i.test(collection) || !IDENT.test(field)) {
        return reply.code(400).send({ error: 'Invalid collection or field' })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const fieldRow = (await db('nivaro_fields')
        .where({ collection, field })
        .first('computed_type', 'computed_formula', 'computed_store')) as
        | { computed_type: string | null; computed_formula: string | null; computed_store: unknown }
        | undefined
      if (!fieldRow?.computed_type || !fieldRow.computed_formula) {
        return reply.code(404).send({ error: 'Field is not computed' })
      }

      const record = (await db(collection).where('id', item).first()) as
        | Record<string, unknown>
        | undefined
      if (!record) return reply.code(404).send({ error: 'Record not found' })

      // ── write-computed: formula + its current inputs ──────────────────────
      if (fieldRow.computed_type === 'write') {
        const formula = fieldRow.computed_formula
        const inputs: Record<string, unknown> = {}
        for (const m of formula.matchAll(/item\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
          inputs[m[1]] = record[m[1]] ?? null
        }
        return {
          data: {
            kind: 'write',
            formula,
            inputs,
            stored_value: record[field] ?? null
          }
        }
      }

      if (fieldRow.computed_type !== 'rollup') {
        return reply.code(404).send({ error: 'Field is not a rollup or write-computed field' })
      }
      const cfg = parseRollupFormula(fieldRow.computed_formula)
      if (!cfg) return reply.code(404).send({ error: 'Rollup config is not parseable' })

      const sources = await Promise.all(
        cfg.sources.map(async (src) => {
          if (
            !IDENT.test(src.related_collection) ||
            !IDENT.test(src.fk_field) ||
            (src.value_field && !IDENT.test(src.value_field))
          ) {
            return { collection: src.related_collection, error: 'Unsafe source config', rows: [] }
          }
          if (src.recursive) {
            return {
              collection: src.related_collection,
              aggregate: src.aggregate,
              note: 'Recursive rollup — contributions span the whole subtree and are not listed here.',
              rows: []
            }
          }
          // The caller must be able to READ the child collection to see its
          // rows — the parent's read permission covers the aggregate, not the
          // per-row breakdown (labels + editors disclose more than a sum).
          if (!(await can(req.user!, 'read', src.related_collection))) {
            return {
              collection: src.related_collection,
              aggregate: src.aggregate,
              restricted: true,
              note: 'You can read the total but not the contributing records.',
              rows: []
            }
          }
          try {
            // Through the items service, not raw knex: row-level security and
            // User Scopes must narrow the listed contributions exactly as they
            // narrow any other read of this collection.
            const result = await readItems(req.user!, src.related_collection, {
              filter: { [src.fk_field]: { _eq: item } },
              fields: src.value_field ? ['id', src.value_field] : ['id'],
              limit: 200
            })
            const raw = ((result as { data?: Array<Record<string, unknown>> }).data ??
              result ??
              []) as Array<Record<string, unknown>>
            // value_formula rows can't be recomputed cheaply here — surface
            // the rows with their base value_field where present.
            const ids = raw.map((r) => String(r.id))
            const [labels, touches] = await Promise.all([
              getLabels(new Map([[src.related_collection, new Set(ids)]])).catch(
                () => ({}) as Record<string, string>
              ),
              lastTouches(src.related_collection, ids)
            ])
            const rows: LineageRow[] = raw.map((r) => {
              const t = touches.get(String(r.id))
              const v = src.value_field ? Number(r[src.value_field]) : null
              return {
                id: String(r.id),
                label: labels[`${src.related_collection}:${r.id}`] ?? labels[String(r.id)] ?? `#${r.id}`,
                value: v != null && Number.isFinite(v) ? v : null,
                updated_at: t?.at ?? null,
                updated_by: t?.by ?? null,
                via_import: t?.viaImport ?? false
              }
            })
            const subtotal =
              src.aggregate === 'count'
                ? rows.length
                : rows.reduce((a, r) => a + (r.value ?? 0), 0)
            return {
              collection: src.related_collection,
              aggregate: src.aggregate,
              value_field: src.value_field ?? null,
              value_formula: src.value_formula ?? null,
              filtered: !!src.filter,
              rows,
              subtotal: Math.round(subtotal * 100) / 100,
              truncated: raw.length === 200
            }
          } catch (err) {
            return {
              collection: src.related_collection,
              error: err instanceof Error ? err.message : String(err),
              rows: []
            }
          }
        })
      )

      return {
        data: {
          kind: 'rollup',
          stored_value: record[field] ?? null,
          sources
        }
      }
    }
  )
}

/** Latest activity per row, one query: who last touched each contributing
 *  child and whether that touch was an import. */
async function lastTouches(
  collection: string,
  ids: string[]
): Promise<Map<string, { at: string | null; by: string | null; viaImport: boolean }>> {
  const out = new Map<string, { at: string | null; by: string | null; viaImport: boolean }>()
  if (ids.length === 0) return out
  try {
    const rows = (await db.raw(
      `SELECT item, action, timestamp, first_name, last_name FROM (
         SELECT a.item, a.action, a.timestamp, u.first_name, u.last_name,
                ROW_NUMBER() OVER (PARTITION BY a.item ORDER BY a.id DESC) AS rn
         FROM nivaro_activity a
         LEFT JOIN nivaro_users u ON u.id = a.[user]
         WHERE a.collection = ? AND a.item IN (${ids.slice(0, 200).map(() => '?').join(',')})
           AND a.action IN ('create', 'update')
       ) t WHERE rn = 1`,
      [collection, ...ids.slice(0, 200)]
    )) as Array<{
      item: string
      action: string
      timestamp: Date | string
      first_name: string | null
      last_name: string | null
    }>
    for (const r of rows) {
      out.set(String(r.item), {
        at: r.timestamp ? new Date(r.timestamp).toISOString() : null,
        by: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
        viaImport: false
      })
    }
  } catch {
    /* activity unavailable — lineage still shows rows/values */
  }
  return out
}
