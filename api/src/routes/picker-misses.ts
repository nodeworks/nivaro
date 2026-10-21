import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { getCollection, getFields, getRelations } from '../services/collections.js'
import { roleAllows } from '../services/layout-patch.js'
import { layoutUsageInfo } from '../services/layout-usage.js'
import { can } from '../services/permissions.js'
import {
  clearPickerMisses,
  type MissRedis,
  type MissSuggestion,
  recordPickerMisses,
  sessionTerms,
  suggestMissFix,
  topPickerMisses,
  validMissField
} from '../services/picker-misses.js'
import { takeWindowed } from '../services/windowed-limit.js'
import { countOf } from './picker-narrowing.js'

const PER_MIN = 30
const SUGGEST_MAX = 5

function parseObj(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v !== 'string' || !v) return {}
  try {
    const p = JSON.parse(v)
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {}
  } catch {
    return {}
  }
}

/** A filter carrying `$parent.` / `$CURRENT_` tokens depends on the record being edited. */
function hasTokens(v: unknown): boolean {
  return JSON.stringify(v ?? null).includes('"$')
}

/**
 * Picker search gaps (#2726) — see services/picker-misses.ts. Registered under
 * /layout-usage, deliberately not /collection-layouts: the report is a write,
 * and a write under a metadata route flushes the metadata caches.
 */
export async function pickerMissRoutes(app: FastifyInstance) {
  const redis = () => (app as unknown as { redis?: MissRedis }).redis ?? null

  // The record form, when a picker session ends after a search that found
  // nothing: { layout_id, collection, field, terms }. Always 204.
  app.post<{ Body: Record<string, unknown> }>(
    '/picker-miss',
    { preHandler: authenticate, bodyLimit: 8 * 1024 },
    async (req, reply) => {
      const user = req.user
      const b = req.body ?? {}
      const layoutId = Number(b.layout_id)
      const collection = typeof b.collection === 'string' ? b.collection : ''
      const field = b.field
      const terms = sessionTerms(b.terms)
      if (!user || !Number.isInteger(layoutId) || layoutId <= 0 || !validMissField(field))
        return reply.code(204).send()
      if (terms.length === 0) return reply.code(204).send()
      try {
        const info = await layoutUsageInfo(layoutId)
        if (!info || info.collection !== collection) return reply.code(204).send()
        if (!roleAllows(info, user.role ?? null, !!req.isAdmin)) return reply.code(204).send()
        if (!(await can(user, 'read', collection))) return reply.code(204).send()
        const fields = await getFields(collection)
        if (!fields.some((f) => f.field === field)) return reply.code(204).send()
        const granted = await takeWindowed(
          app.redis,
          `picker-miss:${String(user.id)}`,
          1,
          PER_MIN,
          60
        )
        if (granted < 1) return reply.code(204).send()
        await recordPickerMisses(redis(), layoutId, field, terms)
      } catch (err) {
        req.log.warn({ err, layout_id: layoutId }, 'picker miss not stored')
      }
      return reply.code(204).send()
    }
  )

  // Inspector: the top misses of a layout's fields (or one field, with a
  // suggested fix per miss, counted as the administrator now).
  app.get<{ Params: { id: string }; Querystring: { field?: string } }>(
    '/:id/picker-misses',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Invalid id' })
      const field = req.query.field
      if (field != null && !validMissField(field))
        return reply.code(400).send({ error: 'Invalid field' })
      const info = await layoutUsageInfo(id)
      if (!info) return reply.code(404).send({ error: 'Layout not found' })
      let rows: Awaited<ReturnType<typeof topPickerMisses>> = []
      try {
        rows = await topPickerMisses(redis(), id, field ?? null)
      } catch (err) {
        req.log.warn({ err, layout_id: id }, 'picker misses not read')
        return { data: { fields: [], available: false } }
      }
      if (!field || rows.length === 0) return { data: { fields: rows, available: true } }

      // Suggestions for one field: what its picker searches and how it is narrowed.
      const collection = info.collection
      const rel = (await getRelations(collection)).find(
        (r) => r.many_collection === collection && r.many_field === field && r.one_collection
      )
      const target = rel?.one_collection ?? null
      const suggestions: Record<string, MissSuggestion> = {}
      if (target) {
        const [fieldRow, placement, targetMeta] = await Promise.all([
          getFields(collection).then((fs) => fs.find((f) => f.field === field)),
          db('nivaro_layout_field_assignments')
            .where({ layout_id: id, field })
            .first('overrides')
            .catch(() => null) as Promise<{ overrides?: unknown } | null | undefined>,
          getCollection(target).catch(() => undefined)
        ])
        const opts = {
          ...parseObj(fieldRow?.options),
          ...parseObj(parseObj(placement?.overrides).options)
        }
        const filter = parseObj(opts.option_filter)
        const hasFilter = Object.keys(filter).length > 0
        const dependsOnRecord = hasFilter && hasTokens(filter)
        const quick = parseObj(opts.quick_create)
        const targetLabel = targetMeta?.display_name || targetMeta?.plural || target
        for (const m of rows[0].misses.slice(0, SUGGEST_MAX)) {
          try {
            const [shown, withoutFilter, withoutCuration] = await Promise.all([
              countOf(req.user!, target, {
                search: m.term,
                filter: hasFilter && !dependsOnRecord ? filter : undefined,
                picker: true
              }),
              hasFilter ? countOf(req.user!, target, { search: m.term, picker: true }) : null,
              countOf(req.user!, target, { search: m.term, picker: false })
            ])
            suggestions[m.term] = suggestMissFix({
              term: m.term,
              target: targetLabel,
              // A filter that depends on the record cannot be counted here.
              shown: dependsOnRecord ? 0 : shown,
              withoutFilter: dependsOnRecord ? shown : withoutFilter,
              withoutCuration,
              hasFilter,
              filterDependsOnRecord: dependsOnRecord,
              quickCreate: Array.isArray(quick.fields) && quick.fields.length > 0
            })
          } catch {
            /* no suggestion for this one */
          }
        }
      }
      return {
        data: {
          available: true,
          target,
          fields: rows.map((r) => ({
            ...r,
            misses: r.misses.map((m) => ({ ...m, suggestion: suggestions[m.term] ?? null }))
          }))
        }
      }
    }
  )

  app.delete<{ Params: { id: string }; Querystring: { field?: string } }>(
    '/:id/picker-misses',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const field = req.query.field
      if (!Number.isInteger(id) || id <= 0 || !validMissField(field))
        return reply.code(400).send({ error: 'Invalid layout or field' })
      await clearPickerMisses(redis(), id, field)
      return reply.code(204).send()
    }
  )
}
