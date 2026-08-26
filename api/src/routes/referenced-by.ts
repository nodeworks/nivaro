import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'
import { getLabels } from '../services/queues.js'

/**
 * Referenced-by (#644) — "what points AT this record".
 *
 * GET /referenced-by/:collection/:id walks nivaro_relations for plain M2O
 * relations whose one_collection is :collection (junction legs excluded —
 * they carry junction_field as the pairing marker, and their parent alias is
 * a different question), counts rows holding this record's id in the FK, and
 * returns up to 5 sample rows with display labels per relation.
 *
 * nivaro_relations is a CLAIM, not truth — every per-relation query is
 * try/caught and a broken relation degrades to a skip, never a 500.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_RELATIONS = 15
const MAX_SAMPLES = 5

interface RelRow {
  many_collection: string | null
  many_field: string | null
}

export async function referencedByRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; id: string } }>(
    '/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!IDENT_RE.test(collection) || /^(nivaro|directus)_/i.test(collection)) {
        return reply.code(400).send({ error: 'Business collections only' })
      }
      if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const rels = (await db('nivaro_relations')
        .where({ one_collection: collection })
        .whereNull('junction_field')
        .select('many_collection', 'many_field')) as RelRow[]

      // Junction tables sometimes appear via corrupt legacy rows with a null
      // junction_field — anything that is a junction elsewhere is excluded.
      const junctionRows = (await db('nivaro_relations')
        .whereNotNull('junction_field')
        .select('many_collection')) as Array<{ many_collection: string | null }>
      const junctionCollections = new Set(
        junctionRows.map((r) => r.many_collection).filter(Boolean) as string[]
      )

      const seen = new Set<string>()
      const candidates = rels
        .filter((r): r is { many_collection: string; many_field: string } => {
          if (!r.many_collection || !r.many_field) return false
          if (!IDENT_RE.test(r.many_collection) || !IDENT_RE.test(r.many_field)) return false
          if (/^(nivaro|directus)_/i.test(r.many_collection)) return false
          if (junctionCollections.has(r.many_collection)) return false
          const key = `${r.many_collection}.${r.many_field}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .slice(0, MAX_RELATIONS)

      // Counts and samples resolve THROUGH readItems as the caller: a
      // referencing collection the user cannot read contributes nothing (its
      // existence is not disclosed), and RLS row filters + User Scopes bound
      // both the count and the sample ids — a raw count here would leak rows
      // the user's own list views hide.
      const { readItems } = await import('../services/items.js')
      const resolved = (
        await Promise.all(
          candidates.map(async (rel) => {
            try {
              if (!req.isAdmin && !(await can(req.user!, 'read', rel.many_collection))) return null
              const page = await readItems(req.user!, rel.many_collection, {
                filter: { [rel.many_field]: { _eq: id } },
                fields: ['id'],
                sort: ['-id'],
                limit: MAX_SAMPLES
              })
              const count = Number(page.total ?? 0)
              if (count === 0) return null
              return {
                collection: rel.many_collection,
                field: rel.many_field,
                count,
                sample_ids: (page.data as Array<{ id: string | number }>).map((r) => String(r.id))
              }
            } catch {
              // Stale relation row / unreadable table — skip, never fail the panel.
              return null
            }
          })
        )
      ).filter(Boolean) as Array<{
        collection: string
        field: string
        count: number
        sample_ids: string[]
      }>

      if (resolved.length === 0) return reply.send({ data: [] })

      // Labels + display names in one pass each.
      const labelMap = new Map<string, Set<string>>()
      for (const r of resolved) {
        const set = labelMap.get(r.collection) ?? new Set<string>()
        for (const sid of r.sample_ids) set.add(sid)
        labelMap.set(r.collection, set)
      }
      const labels = await getLabels(labelMap).catch(() => ({}) as Record<string, string>)
      const metaRows = (await db('nivaro_collections')
        .whereIn('collection', [...new Set(resolved.map((r) => r.collection))])
        .select('collection', 'display_name')
        .catch(() => [])) as Array<{ collection: string; display_name: string | null }>
      const displayNames = new Map(metaRows.map((m) => [m.collection, m.display_name]))

      const data = resolved
        .sort((a, b) => b.count - a.count)
        .map((r) => ({
          collection: r.collection,
          display_name: displayNames.get(r.collection) ?? null,
          field: r.field,
          count: r.count,
          samples: r.sample_ids.map((sid) => ({
            id: sid,
            label: labels[`${r.collection}:${sid}`] ?? `#${sid}`
          }))
        }))

      return reply.send({ data })
    }
  )
}
