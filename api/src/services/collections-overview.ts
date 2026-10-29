import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import type { CMSField, CMSRelation } from '../types.js'
import { getFields, getRelations } from './collections.js'
import { currentTenantKey } from './tenant-rooms.js'

export interface CollectionStat {
  rows: number | null
  changed_at: string | null
  pipeline: string | null
  forms: number
  imports: number
  link: boolean
  virtual: boolean
}

export interface CollectionSummary {
  collection: string
  fields: Array<{ field: string; label: string; type: string }>
  field_count: number
  relations_out: Array<{ field: string; collection: string }>
  relations_in: Array<{ collection: string; field: string }>
  pipeline: string | null
  forms: number
  last_edit: { at: string; user: string | null } | null
}

const CACHE_TTL_MS = 60_000
const SUMMARY_FIELD_MAX = 8
const RELATION_MAX = 12
const SYSTEM_FIELDS = new Set([
  'id',
  'user_created',
  'user_updated',
  'date_created',
  'date_updated'
])
const ALIAS_SPECIAL = new Set(['alias', 'o2m', 'm2m', 'm2a', 'no-data', 'group'])

const cache = new Map<string, { at: number; data: Record<string, CollectionStat> }>()

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** 'date_created' → 'Date created'. */
export function fieldLabel(name: string): string {
  const s = name.replace(/_/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : name
}

export function toIso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** The `collection` key of an import definition's service_config text, or null. */
export function parseServiceConfigCollection(raw: unknown): string | null {
  if (raw == null) return null
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const c = (v as Record<string, unknown>).collection
  return typeof c === 'string' && c ? c : null
}

/** Fields shown on the hover card: no alias, no system columns, by sort. */
export function filterSummaryFields(fields: CMSField[], relations: CMSRelation[]): CMSField[] {
  const aliasNames = new Set(
    relations
      .filter((r) => r.one_collection != null && r.one_field)
      .map((r) => `${r.one_collection}\u0000${r.one_field}`)
  )
  return fields
    .filter((f) => {
      if (SYSTEM_FIELDS.has(f.field)) return false
      if (aliasNames.has(`${f.collection}\u0000${f.field}`)) return false
      if ((f.special ?? []).some((s) => ALIAS_SPECIAL.has(s))) return false
      return true
    })
    .sort((a, b) => (a.sort ?? 1e9) - (b.sort ?? 1e9) || a.field.localeCompare(b.field))
}

export function mapRelations(
  collection: string,
  relations: CMSRelation[]
): {
  out: Array<{ field: string; collection: string }>
  in: Array<{ collection: string; field: string }>
} {
  const out: Array<{ field: string; collection: string }> = []
  const inn: Array<{ collection: string; field: string }> = []
  const seenOut = new Set<string>()
  const seenIn = new Set<string>()
  for (const r of relations) {
    if (r.many_collection === collection && r.junction_field == null && r.one_collection) {
      const k = `${r.many_field}\u0000${r.one_collection}`
      if (!seenOut.has(k)) {
        seenOut.add(k)
        out.push({ field: r.many_field, collection: r.one_collection })
      }
    }
    if (r.one_collection === collection) {
      const k = `${r.many_collection}\u0000${r.many_field}`
      if (!seenIn.has(k)) {
        seenIn.add(k)
        inn.push({ collection: r.many_collection, field: r.many_field })
      }
    }
  }
  return { out: out.slice(0, RELATION_MAX), in: inn.slice(0, RELATION_MAX) }
}

export function junctionCollections(relations: CMSRelation[]): Set<string> {
  return new Set(relations.filter((r) => r.junction_field != null).map((r) => r.many_collection))
}

export interface StatSources {
  collections: Array<{ collection: string; is_virtual?: unknown }>
  rowCounts: Map<string, number>
  changed: Map<string, unknown>
  pipelines: Map<string, string>
  forms: Map<string, number>
  jobImports: Map<string, number>
  defImports: Map<string, number>
  junctions: Set<string>
}

export function mergeStats(src: StatSources): Record<string, CollectionStat> {
  const out: Record<string, CollectionStat> = {}
  for (const c of src.collections) {
    const name = c.collection
    const key = name.toLowerCase()
    const virtual = c.is_virtual === true || c.is_virtual === 1 || c.is_virtual === '1'
    out[name] = {
      rows: virtual ? null : (src.rowCounts.get(key) ?? null),
      changed_at: virtual ? null : toIso(src.changed.get(key)),
      pipeline: src.pipelines.get(name) ?? null,
      forms: src.forms.get(name) ?? 0,
      imports: (src.jobImports.get(name) ?? 0) + (src.defImports.get(name) ?? 0),
      link: src.junctions.has(name),
      virtual
    }
  }
  return out
}

// ─── Queries (each swallows its own failure) ──────────────────────────────────

async function safe<T>(p: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await p()
  } catch {
    return fallback
  }
}

async function hasTable(name: string): Promise<boolean> {
  return safe(() => db.schema.hasTable(name), false)
}

async function loadRowCounts(): Promise<Map<string, number>> {
  const rows = rawRows<{ name: string; n: number | string | null }>(
    await db.raw(
      `SELECT t.name, SUM(p.row_count) n FROM sys.dm_db_partition_stats p
       JOIN sys.tables t ON t.object_id = p.object_id
       WHERE p.index_id IN (0,1) GROUP BY t.name`
    )
  )
  return new Map(rows.map((r) => [String(r.name).toLowerCase(), Number(r.n ?? 0)]))
}

async function loadChanged(): Promise<Map<string, unknown>> {
  const rows = rawRows<{ n: string | null; u: unknown }>(
    await db.raw(
      `SELECT OBJECT_NAME(object_id) n, MAX(last_user_update) u
       FROM sys.dm_db_index_usage_stats WHERE database_id = DB_ID() GROUP BY object_id`
    )
  )
  const m = new Map<string, unknown>()
  for (const r of rows) {
    if (!r.n || !r.u) continue
    const k = String(r.n).toLowerCase()
    const prev = m.get(k)
    if (!prev || new Date(r.u as string).getTime() > new Date(prev as string).getTime()) {
      m.set(k, r.u)
    }
  }
  return m
}

async function loadPipelines(): Promise<Map<string, string>> {
  if (!(await hasTable('nivaro_workflow_bindings'))) return new Map()
  const rows = await db('nivaro_workflow_bindings as b')
    .leftJoin('nivaro_workflow_templates as t', 't.id', 'b.template')
    .select('b.collection', 't.name as name')
    .orderBy('b.id')
  const m = new Map<string, string>()
  for (const r of rows as Array<{ collection: string; name: string | null }>) {
    if (r.name && !m.has(r.collection)) m.set(r.collection, r.name)
  }
  return m
}

async function loadCounts(table: string, column: string): Promise<Map<string, number>> {
  if (!(await hasTable(table))) return new Map()
  const rows = await db(table).select(column).count({ n: '*' }).whereNotNull(column).groupBy(column)
  return new Map(
    (rows as unknown as Array<Record<string, unknown>>).map((r) => [
      String(r[column]),
      Number(r.n ?? 0)
    ])
  )
}

async function loadDefinitionImports(): Promise<Map<string, number>> {
  if (!(await hasTable('nivaro_import_definitions'))) return new Map()
  const rows = await db('nivaro_import_definitions')
    .select('service_config')
    .whereNotNull('service_config')
  const m = new Map<string, number>()
  for (const r of rows as Array<{ service_config: unknown }>) {
    const c = parseServiceConfigCollection(r.service_config)
    if (c) m.set(c, (m.get(c) ?? 0) + 1)
  }
  return m
}

export async function getOverviewStats(): Promise<Record<string, CollectionStat>> {
  const tenant = currentTenantKey()
  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data

  const [collections, rowCounts, changed, pipelines, forms, jobImports, defImports, relations] =
    await Promise.all([
      safe(
        async () =>
          (await db('nivaro_collections').select('collection', 'is_virtual')) as Array<{
            collection: string
            is_virtual?: unknown
          }>,
        []
      ),
      safe(loadRowCounts, new Map<string, number>()),
      safe(loadChanged, new Map<string, unknown>()),
      safe(loadPipelines, new Map<string, string>()),
      safe(() => loadCounts('nivaro_collection_layouts', 'collection'), new Map<string, number>()),
      safe(() => loadCounts('nivaro_import_jobs', 'collection'), new Map<string, number>()),
      safe(loadDefinitionImports, new Map<string, number>()),
      safe(() => getRelations(), [] as CMSRelation[])
    ])
  const data = mergeStats({
    collections,
    rowCounts,
    changed,
    pipelines,
    forms,
    jobImports,
    defImports,
    junctions: junctionCollections(relations)
  })
  cache.set(tenant, { at: Date.now(), data })
  return data
}

export async function getCollectionSummary(collection: string): Promise<CollectionSummary> {
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000)
  const [fields, relations, pipelines, forms, last] = await Promise.all([
    safe(() => getFields(collection), [] as CMSField[]),
    safe(() => getRelations(), [] as CMSRelation[]),
    safe(loadPipelines, new Map<string, string>()),
    safe(() => loadCounts('nivaro_collection_layouts', 'collection'), new Map<string, number>()),
    safe(
      async () => {
        const rows = rawRows<{ timestamp: unknown; user: string | null }>(
          await db.raw(
            'SELECT TOP 1 a.timestamp, a.[user] FROM nivaro_activity a WHERE a.collection = ? AND a.timestamp >= ? ORDER BY a.timestamp DESC',
            [collection, since]
          )
        )
        const row = rows[0]
        if (!row) return null
        let user: string | null = null
        if (row.user) {
          const u = (await db('nivaro_users')
            .select('first_name', 'last_name', 'email')
            .where({ id: row.user })
            .first()) as { first_name?: string; last_name?: string; email?: string } | undefined
          const full = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim()
          user = full || u?.email || null
        }
        return { at: toIso(row.timestamp) ?? '', user }
      },
      null as { at: string; user: string | null } | null
    )
  ])
  const shown = filterSummaryFields(fields, relations)
  const rel = mapRelations(collection, relations)
  return {
    collection,
    fields: shown
      .slice(0, SUMMARY_FIELD_MAX)
      .map((f) => ({ field: f.field, label: fieldLabel(f.field), type: f.type })),
    field_count: shown.length,
    relations_out: rel.out,
    relations_in: rel.in,
    pipeline: pipelines.get(collection) ?? null,
    forms: forms.get(collection) ?? 0,
    last_edit: last && last.at ? last : null
  }
}
