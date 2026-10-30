import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { tenantState } from '../ai-tenant-state.js'
import { type CcRegionSource, readCcConfig } from './config.js'

/**
 * Region placement for Command Center reads — where records and people sit on the map.
 *
 * The region source is CONFIGURATION (CcConfig.region). When nothing is configured it is
 * DETECTED from the data model, never from tenant table names:
 *   - geo collections  = registered collections carrying a latitude/longitude field pair;
 *   - region collection = a collection a geo collection links to (M2M junction or M2O field);
 *     the strongest candidate is the one a user-scope dimension targets (people can then be
 *     placed too), then one whose name reads like a place grouping;
 *   - scope dimension  = the active nivaro_scope_dimensions row whose target_collection is the
 *     region collection — its values are region ids.
 *
 * Callers still read records AS THE CALLER; these helpers only narrow. null = "cannot place":
 * the caller answers for everywhere and says region_applies:false.
 *
 * Caches are per tenant (tenantState): detection 10 min, the resolved source and placements
 * 60 s, centroids 10 min. bustRegionCaches() after a config write.
 */

// ── Metadata shapes (raw rows; kept small so detection is testable on fake metadata) ────────
export interface MetaCollection {
  collection: string
  display_name: string | null
  display_template: string | null
}
export interface MetaField {
  collection: string
  field: string
  type: string | null
  db_column?: string | null
}
export interface MetaRelation {
  many_collection: string
  many_field: string
  one_collection: string | null
  junction_field: string | null
}
export interface MetaDimension {
  name: string
  label: string
  target_collection: string
  display_field: string | null
  is_active: boolean
}
export interface PlacementMeta {
  collections: MetaCollection[]
  fields: MetaField[]
  relations: MetaRelation[]
  dimensions: MetaDimension[]
}

export interface GeoCandidate {
  key: string
  label: string
  lat_field: string
  lng_field: string
}

export interface RegionCandidate {
  source: CcRegionSource
  /** Region collection's readable name ("Regions"). */
  label: string
  /** Plain-words description for the settings sheet. */
  description: string
  score: number
}

export interface Detection {
  geo: GeoCandidate[]
  regions: RegionCandidate[]
  /** The candidate detection would use (score high enough), else null. */
  suggested: RegionCandidate | null
  meta: PlacementMeta
}

const NAME = /^[A-Za-z0-9_]+$/
const SYSTEM = /^(nivaro_|directus_)/i
const NOT_GEO_TYPES = new Set([
  'alias',
  'json',
  'boolean',
  'uuid',
  'o2m',
  'm2m',
  'm2a',
  'files',
  'file',
  'text'
])
const LAT_RE = /^(.*?)(latitude|lat)$/i
const LNG_NAMES = ['longitude', 'lng', 'lon', 'long']
const PLACE_WORDS = /(region|zone|area|territor|district|market|branch|site|division)/i
const LABEL_GUESSES = ['name', 'short_name', 'title', 'label', 'code', 'display_name']
/** Below this a region candidate is listed for admins but not applied on its own. */
export const AUTO_REGION_MIN_SCORE = 3

export function readableName(collection: string, displayName?: string | null): string {
  if (displayName?.trim()) return displayName.trim()
  return collection
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function singleTemplateField(template: string | null | undefined): string | null {
  if (!template) return null
  const m = [...template.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)]
  return m.length === 1 ? m[0][1] : null
}

/** Pure: geo collections + region candidates from metadata rows. */
export function detectFromMetadata(meta: PlacementMeta): Omit<Detection, 'meta'> {
  const registered = new Map(
    meta.collections
      .filter((c) => NAME.test(c.collection) && !SYSTEM.test(c.collection))
      .map((c) => [c.collection, c])
  )
  const fieldsBy = new Map<string, MetaField[]>()
  for (const f of meta.fields) {
    if (!registered.has(f.collection)) continue
    const list = fieldsBy.get(f.collection) ?? []
    list.push(f)
    fieldsBy.set(f.collection, list)
  }
  const label = (c: string) => readableName(c, registered.get(c)?.display_name)

  // Geo collections: a lat field and its lng partner with the same prefix.
  const geo: GeoCandidate[] = []
  for (const [collection, fields] of fieldsBy) {
    const usable = fields.filter((f) => !NOT_GEO_TYPES.has(String(f.type ?? '').toLowerCase()))
    const byLower = new Map(usable.map((f) => [f.field.toLowerCase(), f.field]))
    let best: { lat: string; lng: string; prefix: string } | null = null
    for (const f of usable) {
      const m = LAT_RE.exec(f.field)
      if (!m) continue
      const prefix = m[1]
      if (prefix && !prefix.endsWith('_')) continue
      const lng = LNG_NAMES.map((n) => byLower.get(`${prefix}${n}`.toLowerCase())).find(Boolean)
      if (!lng) continue
      if (!best || prefix.length < best.prefix.length) best = { lat: f.field, lng, prefix }
    }
    if (best)
      geo.push({
        key: collection,
        label: label(collection),
        lat_field: best.lat,
        lng_field: best.lng
      })
  }

  const dimFor = (target: string) =>
    meta.dimensions.find((d) => d.is_active && d.target_collection === target) ?? null
  const labelFieldFor = (region: string, dim: MetaDimension | null): string | null => {
    const names = new Set((fieldsBy.get(region) ?? []).map((f) => f.field))
    if (dim?.display_field && names.has(dim.display_field)) return dim.display_field
    const tpl = singleTemplateField(registered.get(region)?.display_template)
    if (tpl && names.has(tpl)) return tpl
    return LABEL_GUESSES.find((n) => names.has(n)) ?? null
  }

  const seen = new Set<string>()
  const regions: RegionCandidate[] = []
  const add = (geoKey: string, regionCol: string, via: CcRegionSource['via'], viaWords: string) => {
    if (!registered.has(regionCol) || regionCol === geoKey) return
    const key = `${regionCol}|${JSON.stringify(via)}`
    if (seen.has(key)) return
    seen.add(key)
    const dim = dimFor(regionCol)
    const score =
      (dim ? 10 : 0) + (PLACE_WORDS.test(regionCol) ? 3 : 0) + (via.kind === 'field' ? 1 : 0)
    const regionLabel = label(regionCol)
    regions.push({
      source: {
        collection: regionCol,
        label_field: labelFieldFor(regionCol, dim),
        via,
        scope_dimension: dim?.name ?? null
      },
      label: regionLabel,
      description: `${label(geoKey)} ${viaWords} ${regionLabel}. ${
        dim
          ? `People are placed by their “${dim.label}” access.`
          : 'People are not placed (no access dimension uses this collection).'
      }`,
      score
    })
  }
  for (const g of geo) {
    for (const a of meta.relations) {
      // M2M: junction J has a leg to the geo collection and a partner leg to the region.
      if (a.one_collection === g.key && a.junction_field && NAME.test(a.many_collection)) {
        const partner = meta.relations.find(
          (b) =>
            b.many_collection === a.many_collection &&
            b.many_field === a.junction_field &&
            b.one_collection &&
            b.one_collection !== g.key
        )
        if (partner?.one_collection && NAME.test(a.many_field) && NAME.test(a.junction_field))
          add(
            g.key,
            partner.one_collection,
            {
              kind: 'junction',
              junction: a.many_collection,
              region_field: a.junction_field,
              item_field: a.many_field,
              item_collection: g.key
            },
            'link to'
          )
      }
      // M2O: a field on the geo collection points at the region.
      if (
        a.many_collection === g.key &&
        !a.junction_field &&
        a.one_collection &&
        a.one_collection !== g.key &&
        NAME.test(a.many_field)
      )
        add(
          g.key,
          a.one_collection,
          { kind: 'field', item_collection: g.key, field: a.many_field },
          'each name one'
        )
    }
  }
  regions.sort((a, z) => z.score - a.score || a.label.localeCompare(z.label))
  const suggested = regions[0] && regions[0].score >= AUTO_REGION_MIN_SCORE ? regions[0] : null
  // Geo collections that can be placed in the suggested regions first.
  geo.sort((a, z) => {
    const ra = suggested?.source.via.item_collection === a.key ? 0 : 1
    const rz = suggested?.source.via.item_collection === z.key ? 0 : 1
    return ra - rz || a.label.localeCompare(z.label)
  })
  return { geo, regions, suggested }
}

// ── Caches (per tenant) ───────────────────────────────────────────────────────────────────
const DETECT_TTL = 10 * 60_000
const SHORT_TTL = 60_000

interface TenantCache {
  detection: { at: number; value: Detection } | null
  detecting: Promise<Detection> | null
  source: { at: number; value: CcRegionSource | null } | null
  centroids: Map<string, { at: number; rows: RegionCentroid[] }>
  regionLabels: Map<string, { at: number; rows: Map<string, string> }>
  userRegions: Map<string, { at: number; map: Map<string, string[]> }>
  ids: Map<string, { at: number; ids: Set<string> | null }>
  readable: Map<string, { at: number; rows: Array<{ id: string; label: string }> }>
}

const cache = tenantState<TenantCache>(() => ({
  detection: null,
  detecting: null,
  source: null,
  centroids: new Map(),
  regionLabels: new Map(),
  userRegions: new Map(),
  ids: new Map(),
  readable: new Map()
}))

export function bustRegionCaches(): void {
  const c = cache()
  c.detection = null
  c.detecting = null
  c.source = null
  c.centroids.clear()
  c.regionLabels.clear()
  c.userRegions.clear()
  c.ids.clear()
  c.readable.clear()
}

function capSet<V>(m: Map<string, V>, key: string, v: V, max = 500): void {
  if (m.size >= max) m.delete(m.keys().next().value as string)
  m.set(key, v)
}

async function loadMeta(): Promise<PlacementMeta> {
  const [collections, fields, relations, dimensions] = await Promise.all([
    db('nivaro_collections').select('collection', 'display_name', 'display_template') as Promise<
      MetaCollection[]
    >,
    db('nivaro_fields').select('collection', 'field', 'type', 'db_column') as Promise<MetaField[]>,
    db('nivaro_relations').select(
      'many_collection',
      'many_field',
      'one_collection',
      'junction_field'
    ) as Promise<MetaRelation[]>,
    import('../user-scopes.js')
      .then((m) => m.listScopeDimensions(true))
      .catch(() => [] as MetaDimension[])
  ])
  return {
    collections,
    fields,
    relations,
    dimensions: dimensions.map((d) => ({
      name: d.name,
      label: d.label,
      target_collection: d.target_collection,
      display_field: d.display_field,
      is_active: d.is_active
    }))
  }
}

/** Detected geo collections + region candidates (10-min cache, single-flight per tenant). */
export async function detectPlacement(): Promise<Detection> {
  const c = cache()
  if (c.detection && Date.now() - c.detection.at < DETECT_TTL) return c.detection.value
  if (c.detecting) return c.detecting
  const run = (async () => {
    const meta = await loadMeta()
    const value: Detection = { ...detectFromMetadata(meta), meta }
    c.detection = { at: Date.now(), value }
    return value
  })()
  c.detecting = run
  try {
    return await run
  } finally {
    if (c.detecting === run) c.detecting = null
  }
}

/** The region source in force: configured, else detected; null = no regions. */
export async function resolveRegionSource(): Promise<CcRegionSource | null> {
  const c = cache()
  if (c.source && Date.now() - c.source.at < SHORT_TTL) return c.source.value
  let value: CcRegionSource | null = null
  try {
    const cfg = await readCcConfig()
    if (cfg.region === false) value = null
    else if (cfg.region) value = cfg.region
    else value = (await detectPlacement()).suggested?.source ?? null
  } catch {
    value = null
  }
  c.source = { at: Date.now(), value }
  return value
}

/** Map collections in force: configured (existing ones), else detected. */
export async function resolveGeoCollections(): Promise<GeoCandidate[]> {
  const det = await detectPlacement()
  const cfg = await readCcConfig().catch(() => null)
  if (cfg && cfg.geo_collections.length > 0) {
    const byKey = new Map(det.geo.map((g) => [g.key, g]))
    return cfg.geo_collections.map((k) => byKey.get(k)).filter((g): g is GeoCandidate => !!g)
  }
  return det.geo
}

/** Physical column of a field (nivaro_fields.db_column, else the field name). */
function columnOf(meta: PlacementMeta, collection: string, field: string): string {
  const f = meta.fields.find((x) => x.collection === collection && x.field === field)
  const col = f?.db_column?.trim() || field
  if (!NAME.test(col)) throw new Error('Unsafe column name')
  return col
}

function assertName(n: string): string {
  if (!NAME.test(n)) throw new Error('Unsafe identifier')
  return n
}

export interface RegionCentroid {
  id: string
  label: string
  lat: number
  lng: number
}

/** Every region's label (id → label), read as the system: names of regions, 10 min. */
async function allRegionLabels(source: CcRegionSource): Promise<Map<string, string>> {
  const c = cache()
  const key = `${source.collection}|${source.label_field ?? ''}`
  const hit = c.regionLabels.get(key)
  if (hit && Date.now() - hit.at < DETECT_TTL) return hit.rows
  const det = await detectPlacement()
  const rows = new Map<string, string>()
  try {
    const cols = ['id']
    if (source.label_field) cols.push(columnOf(det.meta, source.collection, source.label_field))
    const found = (await db(assertName(source.collection)).select(cols).limit(5000)) as Array<
      Record<string, unknown>
    >
    for (const r of found) {
      const label = source.label_field
        ? r[columnOf(det.meta, source.collection, source.label_field)]
        : null
      rows.set(String(r.id), label != null && String(label).trim() ? String(label) : `#${r.id}`)
    }
  } catch {
    /* labels degrade to ids */
  }
  capSet(c.regionLabels, key, { at: Date.now(), rows }, 20)
  return rows
}

/** Average position of each region's geocoded records (10 min). Regions with none are absent. */
export async function regionCentroids(source?: CcRegionSource | null): Promise<RegionCentroid[]> {
  const src = source === undefined ? await resolveRegionSource() : source
  if (!src) return []
  const c = cache()
  const key = JSON.stringify(src)
  const hit = c.centroids.get(key)
  if (hit && Date.now() - hit.at < DETECT_TTL) return hit.rows
  let rows: RegionCentroid[] = []
  try {
    const det = await detectPlacement()
    const g = det.geo.find((x) => x.key === src.via.item_collection)
    if (g) {
      const G = assertName(g.key)
      const lat = columnOf(det.meta, G, g.lat_field)
      const lng = columnOf(det.meta, G, g.lng_field)
      let raw: Array<{ id: unknown; lat: unknown; lng: unknown }>
      if (src.via.kind === 'junction') {
        const J = assertName(src.via.junction)
        const rf = columnOf(det.meta, J, src.via.region_field)
        const itf = columnOf(det.meta, J, src.via.item_field)
        raw = (await db.raw(
          `SELECT j.?? AS id, AVG(CAST(g.?? AS float)) AS lat, AVG(CAST(g.?? AS float)) AS lng
             FROM ?? j JOIN ?? g ON g.id = j.??
            WHERE j.?? IS NOT NULL AND g.?? IS NOT NULL AND g.?? <> 0 AND g.?? IS NOT NULL AND g.?? <> 0
            GROUP BY j.??`,
          [rf, lat, lng, J, G, itf, rf, lat, lat, lng, lng, rf]
        )) as typeof raw
      } else {
        const f = columnOf(det.meta, G, src.via.field)
        raw = (await db.raw(
          `SELECT g.?? AS id, AVG(CAST(g.?? AS float)) AS lat, AVG(CAST(g.?? AS float)) AS lng
             FROM ?? g
            WHERE g.?? IS NOT NULL AND g.?? IS NOT NULL AND g.?? <> 0 AND g.?? IS NOT NULL AND g.?? <> 0
            GROUP BY g.??`,
          [f, lat, lng, G, f, lat, lat, lng, lng, f]
        )) as typeof raw
      }
      const labels = await allRegionLabels(src)
      rows = raw
        .map((r) => ({
          id: String(r.id),
          label: labels.get(String(r.id)) ?? `#${r.id}`,
          lat: Number(r.lat),
          lng: Number(r.lng)
        }))
        .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && Math.abs(r.lat) <= 90)
    }
  } catch {
    rows = []
  }
  capSet(c.centroids, key, { at: Date.now(), rows }, 20)
  return rows
}

/**
 * Regions the caller may read (through the items service: role, row filter, User Scopes),
 * with labels. [] = no regions, or none readable. 60 s per person.
 */
export async function readableRegions(
  user: User,
  source?: CcRegionSource | null
): Promise<Array<{ id: string; label: string }>> {
  const src = source === undefined ? await resolveRegionSource() : source
  if (!src) return []
  const c = cache()
  const key = `${String(user.id).toUpperCase()}|${user.role ?? ''}|${src.collection}`
  const hit = c.readable.get(key)
  if (hit && Date.now() - hit.at < SHORT_TTL) return hit.rows
  let rows: Array<{ id: string; label: string }> = []
  try {
    const { can } = await import('../permissions.js')
    if (await can(user, 'read', src.collection)) {
      const { readItems } = await import('../items.js')
      const fields = ['id', ...(src.label_field ? [src.label_field] : [])]
      const res = (await readItems(user, src.collection, {
        fields,
        limit: 2000,
        count: false
      })) as { data?: Array<Record<string, unknown>> }
      rows = (res.data ?? []).map((r) => {
        const l = src.label_field ? r[src.label_field] : null
        return {
          id: String(r.id),
          label: l != null && String(l).trim() ? String(l) : `#${r.id}`
        }
      })
      rows.sort((a, z) => a.label.localeCompare(z.label))
    }
  } catch {
    rows = []
  }
  capSet(c.readable, key, { at: Date.now(), rows })
  return rows
}

/** upper-cased user id → region ids, from the source's user-scope dimension (60 s). null = not placed. */
export async function userRegionMap(
  source?: CcRegionSource | null
): Promise<Map<string, string[]> | null> {
  const src = source === undefined ? await resolveRegionSource() : source
  if (!src?.scope_dimension) return null
  const c = cache()
  const hit = c.userRegions.get(src.scope_dimension)
  if (hit && Date.now() - hit.at < SHORT_TTL) return hit.map
  const map = new Map<string, string[]>()
  try {
    const rows = (await db('nivaro_user_scopes')
      .where({ dimension: src.scope_dimension })
      .select('user', 'values')) as Array<{ user: string; values: unknown }>
    for (const r of rows) {
      let vals: unknown = r.values
      try {
        vals = typeof vals === 'string' ? JSON.parse(vals) : vals
      } catch {
        vals = []
      }
      if (!Array.isArray(vals) || vals.length === 0) continue
      const uid = String(r.user).toUpperCase()
      const cur = new Set(map.get(uid) ?? [])
      for (const v of vals) cur.add(String(v))
      map.set(uid, [...cur])
    }
  } catch {
    return null
  }
  capSet(c.userRegions, src.scope_dimension, { at: Date.now(), map }, 20)
  return map
}

const MAX_IDS = 50_000

/** Pure: how `collection` reaches the region — the plan recordIdsInRegion runs. */
export type RegionPath =
  | { kind: 'self' }
  | { kind: 'geo' }
  | { kind: 'm2o'; field: string }
  | { kind: 'm2m'; junction: string; item_field: string; region_field: string }
  | { kind: 'via_geo'; field: string }

export function regionPathFor(
  collection: string,
  source: CcRegionSource,
  relations: MetaRelation[]
): RegionPath | null {
  const R = source.collection
  const G = source.via.item_collection
  if (collection === R) return { kind: 'self' }
  if (collection === G) return { kind: 'geo' }
  const m2o = relations.find(
    (r) =>
      r.many_collection === collection &&
      r.one_collection === R &&
      !r.junction_field &&
      NAME.test(r.many_field)
  )
  if (m2o) return { kind: 'm2o', field: m2o.many_field }
  for (const a of relations) {
    if (a.one_collection !== collection || !a.junction_field) continue
    const partner = relations.find(
      (b) =>
        b.many_collection === a.many_collection &&
        b.many_field === a.junction_field &&
        b.one_collection === R
    )
    if (
      partner &&
      NAME.test(a.many_collection) &&
      NAME.test(a.many_field) &&
      NAME.test(a.junction_field)
    )
      return {
        kind: 'm2m',
        junction: a.many_collection,
        item_field: a.many_field,
        region_field: a.junction_field
      }
  }
  const toGeo = relations.find(
    (r) =>
      r.many_collection === collection &&
      r.one_collection === G &&
      !r.junction_field &&
      NAME.test(r.many_field)
  )
  if (toGeo) return { kind: 'via_geo', field: toGeo.many_field }
  return null
}

/**
 * Ids of `collection` records that sit in region `regionId` — through the configured or
 * detected region source (the geo collection itself, a direct link to the region collection, or
 * a link to a geo record in the region). null = this collection cannot be placed in regions.
 * Callers still read the records AS THE CALLER; this only narrows.
 */
export async function recordIdsInRegion(
  collection: string,
  regionId: string
): Promise<Set<string> | null> {
  if (!NAME.test(collection) || SYSTEM.test(collection)) return null
  const source = await resolveRegionSource()
  if (!source) return null
  const c = cache()
  const key = `${collection}|${regionId}`
  const hit = c.ids.get(key)
  if (hit && Date.now() - hit.at < SHORT_TTL) return hit.ids
  let ids: Set<string> | null = null
  try {
    const det = await detectPlacement()
    const path = regionPathFor(collection, source, det.meta.relations)
    if (path) {
      const geoIds = () => {
        const v = source.via
        if (v.kind === 'junction') {
          const J = assertName(v.junction)
          return db(J)
            .where(columnOf(det.meta, J, v.region_field), regionId)
            .whereNotNull(columnOf(det.meta, J, v.item_field))
            .select(columnOf(det.meta, J, v.item_field))
        }
        const G = assertName(v.item_collection)
        return db(G)
          .where(columnOf(det.meta, G, v.field), regionId)
          .select('id')
      }
      let q: ReturnType<typeof db> | null = null
      let col = 'id'
      if (path.kind === 'self') ids = new Set([regionId])
      else if (path.kind === 'geo') {
        q = geoIds()
        col =
          source.via.kind === 'junction'
            ? columnOf(det.meta, source.via.junction, source.via.item_field)
            : 'id'
      } else if (path.kind === 'm2o') {
        q = db(assertName(collection))
          .where(columnOf(det.meta, collection, path.field), regionId)
          .select('id')
      } else if (path.kind === 'm2m') {
        const J = assertName(path.junction)
        col = columnOf(det.meta, J, path.item_field)
        q = db(J)
          .where(columnOf(det.meta, J, path.region_field), regionId)
          .whereNotNull(col)
          .select(col)
      } else if (path.kind === 'via_geo') {
        q = db(assertName(collection))
          .whereIn(columnOf(det.meta, collection, path.field), geoIds())
          .select('id')
      }
      if (q) {
        const rows = (await q.limit(MAX_IDS)) as Array<Record<string, unknown>>
        ids = new Set(
          rows
            .map((r) => r[col] ?? r.id)
            .filter((v) => v != null)
            .map((v) => String(v))
        )
      }
    }
  } catch {
    ids = null
  }
  capSet(c.ids, key, { at: Date.now(), ids }, 200)
  return ids
}

/** User ids placed in region `regionId` (the region source's user-scope dimension); null = people are not placed. */
export async function userIdsInRegion(regionId: string): Promise<Set<string> | null> {
  const map = await userRegionMap()
  if (!map) return null
  const out = new Set<string>()
  for (const [uid, regions] of map) if (regions.includes(String(regionId))) out.add(uid)
  return out
}

/** Region id → label for every region (system read; labels only). */
export async function regionLabelMap(): Promise<Map<string, string>> {
  const src = await resolveRegionSource()
  return src ? allRegionLabels(src) : new Map()
}
