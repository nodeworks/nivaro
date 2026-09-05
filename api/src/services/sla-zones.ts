import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import { ADDENDUM_COLLECTION, resolvePipelineSubjectsBatch } from './pipeline-subject.js'

/**
 * Per-region SLA clocks.
 *
 * nivaro_settings.sla_zone_map is JSON: {source_collection, zones: {id: tz}}.
 * The source collection (e.g. `regions`) is the geography table; `zones` maps
 * its record ids to IANA timezones. A business record resolves its zone via
 * whatever link it has to the source collection — a plain M2O FK, or an M2M
 * junction (first-linked row wins, deterministic by junction row id — a
 * record spanning multiple mapped regions counts on the first one linked).
 *
 * Resolution is derived fresh from nivaro_relations (60s cache), never
 * stored, so it self-heals with schema changes — same philosophy as User
 * Scopes' auto-resolved paths. A record with no route, no link, or an
 * unmapped source id falls back to the instance-wide sla_timezone.
 */

export interface SlaZoneConfig {
  source_collection: string
  zones: Record<string, string> // source record id -> validated IANA zone
}

const TTL = 60_000

let cfgCache: { value: SlaZoneConfig | null; at: number } = { value: null, at: 0 }
let cfgLoading: Promise<SlaZoneConfig | null> | null = null

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

async function loadConfig(): Promise<SlaZoneConfig | null> {
  const row = await db('nivaro_settings').first('sla_zone_map').catch(() => null)
  const raw = row?.sla_zone_map ? String(row.sla_zone_map) : null
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as {
      source_collection?: unknown
      zones?: Record<string, unknown>
    }
    const src = String(parsed?.source_collection ?? '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(src) || /^nivaro_/i.test(src)) return null
    const zones: Record<string, string> = {}
    for (const [id, tz] of Object.entries(parsed?.zones ?? {})) {
      const z = String(tz ?? '').trim()
      // A typo'd zone must degrade to the instance default, never crash SLA math.
      if (z && validZone(z)) zones[String(id)] = z
    }
    if (Object.keys(zones).length === 0) return null
    return { source_collection: src, zones }
  } catch {
    return null
  }
}

export async function getSlaZoneConfig(): Promise<SlaZoneConfig | null> {
  if (Date.now() - cfgCache.at < TTL) return cfgCache.value
  if (!cfgLoading) {
    cfgLoading = loadConfig()
      .then((value) => {
        cfgCache = { value, at: Date.now() }
        return value
      })
      .catch(() => cfgCache.value)
      .finally(() => {
        cfgLoading = null
      })
  }
  return cfgLoading
}

export function clearSlaZoneCache(): void {
  cfgCache = { value: null, at: 0 }
  routeCache.clear()
}

type ZoneRoute =
  | { kind: 'm2o'; fk: string }
  | { kind: 'junction'; junction: string; parentFk: string; sourceFk: string }
  | { kind: 'none' }

const routeCache = new Map<string, { route: ZoneRoute; at: number }>()

/** How `collection` reaches the zone source collection. Derived from
 * nivaro_relations; junction legs carry junction_field as the pairing marker
 * (the documented trap — never filter them out when looking for M2M legs). */
async function routeFor(collection: string, source: string): Promise<ZoneRoute> {
  const key = `${collection}→${source}`
  const hit = routeCache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.route

  let route: ZoneRoute = { kind: 'none' }
  try {
    // Plain M2O FK on the record itself wins — the direct "belongs to" link.
    const m2o = (await db('nivaro_relations')
      .where({ many_collection: collection, one_collection: source })
      .whereNull('junction_field')
      .orderBy('id')
      .select('many_field')) as Array<{ many_field: string }>
    if (m2o.length > 0) {
      // Deterministic pick when several FKs target the source: a field named
      // after the source itself beats qualified variants (the User Scopes
      // wrong-FK lesson), then shortest name.
      const singular = source.replace(/s$/i, '').toLowerCase()
      const best = [...m2o].sort((a, b) => {
        const an = a.many_field.toLowerCase()
        const bn = b.many_field.toLowerCase()
        const aExact = an === singular || an === source.toLowerCase() ? 0 : 1
        const bExact = bn === singular || bn === source.toLowerCase() ? 0 : 1
        return aExact - bExact || an.length - bn.length || an.localeCompare(bn)
      })[0]
      route = { kind: 'm2o', fk: best.many_field }
    } else {
      // M2M: a junction table with one leg to the source and a sibling leg
      // back to the collection.
      const srcLegs = (await db('nivaro_relations')
        .where({ one_collection: source })
        .whereNotNull('junction_field')
        .orderBy('id')
        .select('many_collection', 'many_field')) as Array<{
        many_collection: string
        many_field: string
      }>
      for (const leg of srcLegs) {
        const sibling = (await db('nivaro_relations')
          .where({ many_collection: leg.many_collection, one_collection: collection })
          .whereNotNull('junction_field')
          .orderBy('id')
          .first('many_field')) as { many_field: string } | undefined
        if (sibling) {
          route = {
            kind: 'junction',
            junction: leg.many_collection,
            parentFk: sibling.many_field,
            sourceFk: leg.many_field
          }
          break
        }
      }
    }
  } catch {
    route = { kind: 'none' }
  }
  routeCache.set(key, { route, at: Date.now() })
  return route
}

/**
 * Resolve each record's SLA timezone. Returns only records that resolved to
 * a MAPPED zone — absent ids fall back to the instance default. Never throws:
 * SLA math must survive a broken zone config.
 */
export async function resolveRecordZones(
  collection: string,
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  try {
    const cfg = await getSlaZoneConfig()
    if (!cfg) return out
    // An addendum's clock is its PARENT record's region (pipeline-subject.ts):
    // resolve the parents' zones, then hand them back under the addendum ids.
    if (collection === ADDENDUM_COLLECTION) {
      const subjects = await resolvePipelineSubjectsBatch(collection, ids)
      const byParent = new Map<string, string[]>()
      const parentOf = new Map<string, { collection: string; itemId: string }>()
      for (const id of ids) {
        const s = subjects.get(String(id))
        if (!s || s.collection === ADDENDUM_COLLECTION) continue
        parentOf.set(String(id), s)
        byParent.set(s.collection, [...(byParent.get(s.collection) ?? []), s.itemId])
      }
      for (const [parentCollection, parentIds] of byParent) {
        const zones = await resolveRecordZones(parentCollection, [...new Set(parentIds)])
        for (const [id, s] of parentOf) {
          if (s.collection !== parentCollection) continue
          const tz = zones.get(s.itemId)
          if (tz) out.set(id, tz)
        }
      }
      return out
    }
    const route = await routeFor(collection, cfg.source_collection)
    if (route.kind === 'none') return out

    if (route.kind === 'm2o') {
      const rows = (await selectInChunks(ids, 2000, (chunk) =>
        db(collection)
          .whereIn('id', chunk)
          .select('id', db.raw('?? as src', [route.fk]))
      )) as Array<{ id: unknown; src: unknown }>
      for (const r of rows) {
        const tz = r.src != null ? cfg.zones[String(r.src)] : undefined
        if (tz) out.set(String(r.id), tz)
      }
    } else {
      const rows = (await selectInChunks(ids, 2000, (chunk) =>
        db(route.junction)
          .whereIn(route.parentFk, chunk)
          .orderBy('id')
          .select(
            db.raw('?? as parent', [route.parentFk]),
            db.raw('?? as src', [route.sourceFk])
          )
      )) as Array<{ parent: unknown; src: unknown }>
      for (const r of rows) {
        const pid = String(r.parent)
        if (out.has(pid)) continue // first-linked wins
        const tz = r.src != null ? cfg.zones[String(r.src)] : undefined
        if (tz) out.set(pid, tz)
      }
    }
  } catch {
    // fall through — instance default applies
  }
  return out
}
