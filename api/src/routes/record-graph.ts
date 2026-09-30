import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'
import { getLabels } from '../services/queues.js'

/**
 * Relationship explorer (#998) — one hop of a record's neighbourhood.
 *
 * GET /record-graph/:collection/:id answers every registered relation the
 * record takes part in, grouped:
 *   - out   — its own M2O fields (vendor, project, creator…)
 *   - in    — plain M2O rows elsewhere that point AT it (lines, invoices…)
 *   - m2m   — junction-linked records, M2A legs split per target collection
 *
 * Every business record in the answer is read AS THE VIEWER through
 * readItems (RBAC, row filters, User Scopes): a group the viewer cannot read
 * is left out, and counts are what the viewer can see — nothing about hidden
 * rows is disclosed. The explorer asks again for each node someone expands,
 * so the graph grows one hop at a time.
 *
 * nivaro_relations is a CLAIM, not truth — every relation is try/caught and a
 * broken one degrades to a missing group, never a 500.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const PER_GROUP = 12
const MAX_RELATIONS = 40
const USER_COLLECTIONS = new Set(['nivaro_users', 'directus_users'])
const FILE_COLLECTIONS = new Set(['nivaro_files', 'directus_files'])

interface RelRow {
  id: number
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
  one_collection_field: string | null
  one_allowed_collections: string | null
}

export interface GraphNode {
  collection: string
  id: string
  label: string
}

export interface GraphGroup {
  key: string
  direction: 'out' | 'in' | 'm2m'
  /** The field on this record (out / m2m) or on the other collection (in). */
  field: string
  label: string
  collection: string
  collection_label: string
  total: number
  items: GraphNode[]
}

function ident(v: unknown): v is string {
  return typeof v === 'string' && IDENT_RE.test(v)
}

function isSystem(c: string): boolean {
  return /^(nivaro|directus)_/i.test(c)
}

/** A bare comma list on legacy rows, a JSON array on newer ones. */
function allowedList(raw: string | null): string[] {
  if (!raw) return []
  const t = raw.trim()
  if (t.startsWith('[')) {
    try {
      const v = JSON.parse(t)
      return Array.isArray(v) ? v.map(String) : []
    } catch {
      return []
    }
  }
  return t
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export async function recordGraphRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; id: string } }>(
    '/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!ident(collection) || isSystem(collection)) {
        return reply.code(400).send({ error: 'Business collections only' })
      }
      const user = req.user!
      const mayRead = async (c: string) => req.isAdmin || (await can(user, 'read', c))
      if (!(await mayRead(collection))) return reply.code(403).send({ error: 'Forbidden' })

      const { readItems } = await import('../services/items.js')

      // The record itself, as the viewer — a record outside their access has
      // no neighbourhood to show.
      const own = await readItems(user, collection, {
        filter: { id: { _eq: id } },
        limit: 1
      }).catch(() => null)
      const record = (own?.data as Array<Record<string, unknown>> | undefined)?.[0]
      if (!record) return reply.code(404).send({ error: 'Record not found' })

      const rels = (await db('nivaro_relations')
        .where((q) =>
          q
            .where({ many_collection: collection })
            .orWhere({ one_collection: collection })
            .orWhereNotNull('junction_field')
        )
        .select(
          'id',
          'many_collection',
          'many_field',
          'one_collection',
          'one_field',
          'junction_field',
          'one_collection_field',
          'one_allowed_collections'
        )) as RelRow[]

      const junctionCollections = new Set(
        rels.filter((r) => r.junction_field && r.many_collection).map((r) => r.many_collection!)
      )
      // Field labels name the groups on this record's side ("Vendor",
      // "Purchase orders") — the column name only when no label is set.
      const fieldLabels = new Map<string, string>()
      const fieldRows = (await db('nivaro_fields')
        .where({ collection })
        .select('field', 'label')
        .catch(() => [])) as Array<{ field: string; label: string | null }>
      for (const f of fieldRows) if (f.label) fieldLabels.set(f.field, f.label)

      interface Pending {
        key: string
        direction: GraphGroup['direction']
        field: string
        collection: string
        /** ids to resolve (out / m2m) — null = query by FK (in). */
        ids: string[] | null
        fk?: string
      }
      const pending: Pending[] = []
      const seen = new Set<string>()
      const add = (p: Pending) => {
        if (seen.has(p.key) || pending.length >= MAX_RELATIONS) return
        seen.add(p.key)
        pending.push(p)
      }

      // ── out: this record's own M2O columns ──────────────────────────────
      for (const r of rels) {
        if (r.many_collection !== collection || !ident(r.many_field) || !ident(r.one_collection))
          continue
        const v = record[r.many_field]
        const idv = v && typeof v === 'object' ? (v as Record<string, unknown>).id : (v as unknown)
        if (idv == null || idv === '') continue
        add({
          key: `out:${r.many_field}`,
          direction: 'out',
          field: r.many_field,
          collection: r.one_collection,
          ids: [String(idv)]
        })
      }

      // ── in + m2m: relations whose one side is this collection ───────────
      for (const r of rels) {
        if (r.one_collection !== collection || !ident(r.many_collection) || !ident(r.many_field))
          continue
        if (!r.junction_field) {
          if (junctionCollections.has(r.many_collection)) continue
          add({
            key: `in:${r.many_collection}.${r.many_field}`,
            direction: 'in',
            field: r.many_field,
            collection: r.many_collection,
            ids: null,
            fk: r.many_field
          })
          continue
        }
        // Junction leg pointing at this record: its companion names the target.
        const companion = rels.find(
          (c) =>
            c.id !== r.id &&
            c.many_collection === r.many_collection &&
            c.many_field === r.junction_field
        )
        if (!companion || !ident(r.junction_field)) continue
        const alias = r.one_field && ident(r.one_field) ? r.one_field : r.many_collection
        try {
          const discriminator =
            !companion.one_collection && ident(companion.one_collection_field)
              ? companion.one_collection_field
              : null
          const cols = discriminator ? [r.junction_field, discriminator] : [r.junction_field]
          const rows = (await db(r.many_collection)
            .where(r.many_field, id)
            .select(cols)
            .limit(400)) as Array<Record<string, unknown>>
          const byTarget = new Map<string, string[]>()
          for (const row of rows) {
            const v = row[r.junction_field]
            if (v == null || v === '') continue
            let target = companion.one_collection
            if (!target && discriminator) {
              const d = row[discriminator]
              target = typeof d === 'string' ? d : null
              if (target && !allowedList(companion.one_allowed_collections).includes(target))
                target = null
            }
            if (!target) continue
            const list = byTarget.get(target) ?? []
            list.push(String(v))
            byTarget.set(target, list)
          }
          for (const [target, ids] of byTarget) {
            add({
              key: `m2m:${alias}:${target}`,
              direction: 'm2m',
              field: alias,
              collection: target,
              ids: [...new Set(ids)]
            })
          }
        } catch {
          // Stale junction row / missing table — skip this relation.
        }
      }

      // ── resolve every group as the viewer ───────────────────────────────
      const groups = (
        await Promise.all(
          pending.map(async (p): Promise<GraphGroup | null> => {
            try {
              if (USER_COLLECTIONS.has(p.collection)) {
                if (!p.ids) return null
                const rows = (await db('nivaro_users')
                  .whereIn('id', p.ids.slice(0, PER_GROUP * 4))
                  .where((q) => q.where('is_redacted', false).orWhereNull('is_redacted'))
                  .select('id', 'first_name', 'last_name', 'email')) as Array<{
                  id: string
                  first_name: string | null
                  last_name: string | null
                  email: string | null
                }>
                if (rows.length === 0) return null
                return {
                  key: p.key,
                  direction: p.direction,
                  field: p.field,
                  label: fieldLabels.get(p.field) ?? titleCase(p.field),
                  collection: 'nivaro_users',
                  collection_label: 'People',
                  total: rows.length,
                  items: rows.slice(0, PER_GROUP).map((u) => ({
                    collection: 'nivaro_users',
                    id: String(u.id),
                    label:
                      [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || `#${u.id}`
                  }))
                }
              }
              if (FILE_COLLECTIONS.has(p.collection)) {
                if (!p.ids) return null
                const rows = (await db('nivaro_files')
                  .whereIn('id', p.ids.slice(0, PER_GROUP * 4))
                  .select('id', 'title', 'filename_download')) as Array<{
                  id: string
                  title: string | null
                  filename_download: string | null
                }>
                if (rows.length === 0) return null
                return {
                  key: p.key,
                  direction: p.direction,
                  field: p.field,
                  label: fieldLabels.get(p.field) ?? titleCase(p.field),
                  collection: 'nivaro_files',
                  collection_label: 'Files',
                  total: rows.length,
                  items: rows.slice(0, PER_GROUP).map((f) => ({
                    collection: 'nivaro_files',
                    id: String(f.id),
                    label: f.title || f.filename_download || `#${f.id}`
                  }))
                }
              }
              if (isSystem(p.collection) || !ident(p.collection)) return null
              if (!(await mayRead(p.collection))) return null
              const filter = p.ids
                ? { id: { _in: p.ids.slice(0, 2000) } }
                : { [p.fk!]: { _eq: id } }
              const page = await readItems(user, p.collection, {
                filter,
                fields: ['id'],
                sort: ['-id'],
                limit: PER_GROUP
              })
              const total = Number(page.total ?? 0)
              const rows = page.data as Array<{ id: string | number }>
              if (total === 0 || rows.length === 0) return null
              return {
                key: p.key,
                direction: p.direction,
                field: p.field,
                label: p.direction === 'in' ? '' : (fieldLabels.get(p.field) ?? titleCase(p.field)),
                collection: p.collection,
                collection_label: '',
                total,
                items: rows.map((row) => ({
                  collection: p.collection,
                  id: String(row.id),
                  label: ''
                }))
              }
            } catch {
              return null
            }
          })
        )
      ).filter((g): g is GraphGroup => g !== null)

      // Labels + collection names in one pass each.
      const labelMap = new Map<string, Set<string>>()
      const want = (c: string, i: string) => {
        const set = labelMap.get(c) ?? new Set<string>()
        set.add(i)
        labelMap.set(c, set)
      }
      want(collection, id)
      for (const g of groups) {
        if (isSystem(g.collection)) continue
        for (const n of g.items) want(n.collection, n.id)
      }
      const labels = await getLabels(labelMap).catch(() => ({}) as Record<string, string>)
      const names = (await db('nivaro_collections')
        .whereIn('collection', [collection, ...new Set(groups.map((g) => g.collection))])
        .select('collection', 'display_name')
        .catch(() => [])) as Array<{ collection: string; display_name: string | null }>
      const nameOf = new Map(names.map((n) => [n.collection, n.display_name]))
      const collectionLabel = (c: string) => nameOf.get(c) || titleCase(c)

      for (const g of groups) {
        if (!g.collection_label) g.collection_label = collectionLabel(g.collection)
        if (!g.label) g.label = collectionLabel(g.collection)
        for (const n of g.items) {
          if (!n.label) n.label = (labels[`${n.collection}:${n.id}`] ?? '').trim() || `#${n.id}`
        }
      }
      const order = { out: 0, m2m: 1, in: 2 }
      groups.sort((a, b) => order[a.direction] - order[b.direction] || b.total - a.total)

      // Legacy shape (edges) kept beside the groups for older callers of the
      // SDK's readRecordGraph.
      const kindOf = { out: 'm2o', in: 'o2m', m2m: 'm2m' } as const
      const edges = groups.flatMap((g) =>
        g.items.map((n) => ({ kind: kindOf[g.direction], via: g.field, node: n }))
      )
      const truncated = groups.some((g) => g.total > g.items.length)

      return reply.send({
        data: {
          edges,
          truncated,
          node: {
            collection,
            id,
            label: (labels[`${collection}:${id}`] ?? '').trim() || `#${id}`,
            collection_label: collectionLabel(collection)
          },
          groups
        }
      })
    }
  )
}
