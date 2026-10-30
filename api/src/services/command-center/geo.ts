import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { selectInChunks } from '../db-batch.js'
import { LABEL_FALLBACK } from '../display-value.js'
import { detectPlacement, type GeoCandidate, recordIdsInRegion } from './regions.js'
import type { CcScope } from './scope.js'

/**
 * Map pins for one geo collection — read AS THE CALLER through the items service (role, row
 * filter, User Scopes, field list), decorated with pipeline state, SLA and owners. The region
 * lens narrows through recordIdsInRegion; a collection that cannot be placed answers for
 * everywhere with region_applies:false. Pins are live (no rewind): `live_only` when `at` is set.
 */

export interface GeoPinOut {
  id: string
  lat: number
  lng: number
  label: string
  state: string | null
  state_key: string | null
  state_color: string | null
  sla: 'ok' | 'warning' | 'breached' | null
  owner: string | null
  owners: Array<{ id: string; name: string }>
}

export interface GeoFilters {
  states: string[]
  sla: Array<'ok' | 'warning' | 'breached'>
  owner: string | null
}

export interface GeoAnswer {
  pins: GeoPinOut[]
  truncated: boolean
  region_applies: boolean
  no_geo?: boolean
  live_only?: boolean
}

export const GEO_LIMIT = 500
const NAME = /^[A-Za-z0-9_]+$/
const KEY = /^[A-Za-z0-9_.:-]{1,64}$/

const csv = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : [])
    .map((s) => s.trim())
    .filter(Boolean)

/** Parse the map filters from a query string (unknown values dropped). */
export function readGeoFilters(query: unknown): GeoFilters {
  const q = (query ?? {}) as Record<string, unknown>
  const states = csv(q.states)
    .filter((s) => KEY.test(s))
    .slice(0, 30)
  const sla = csv(q.sla).filter((s): s is 'ok' | 'warning' | 'breached' =>
    ['ok', 'warning', 'breached'].includes(s)
  )
  const owner = typeof q.owner === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(q.owner) ? q.owner : null
  return { states, sla, owner }
}

export function validGeoCollection(collection: unknown): collection is string {
  return (
    typeof collection === 'string' &&
    NAME.test(collection) &&
    !/^(nivaro_|directus_)/i.test(collection)
  )
}

/** Which fields name a pin: the display template's plain fields, else the usual label fields. */
async function labelPlan(
  collection: string
): Promise<{ fields: string[]; render: (r: Record<string, unknown>) => string }> {
  const { getCollection, getFields } = await import('../collections.js')
  const [col, fields] = await Promise.all([
    getCollection(collection).catch(() => undefined),
    getFields(collection).catch(() => [])
  ])
  const names = new Set(fields.map((f) => f.field))
  const tpl = col?.display_template ?? null
  const tplFields = tpl ? [...tpl.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map((m) => m[1]) : []
  const dotted = tpl ? /\{\{\s*[\w]+\.[\w.]+\s*\}\}/.test(tpl) : false
  if (tpl && !dotted && tplFields.length > 0 && tplFields.every((f) => names.has(f))) {
    return {
      fields: tplFields,
      render: (r) =>
        tpl.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, k) => (r[k] == null ? '' : String(r[k]))).trim()
    }
  }
  const pick = LABEL_FALLBACK.find((f) => names.has(f)) ?? null
  return {
    fields: pick ? [pick] : [],
    render: (r) => (pick && r[pick] != null ? String(r[pick]) : '')
  }
}

export interface PinDecoration {
  state: { key: string; label: string; color: string | null } | null
  sla: 'ok' | 'warning' | 'breached' | null
  owners: Array<{ id: string; name: string }>
}

/** State, SLA and current-step owners for records of one collection (ids already readable). */
export async function decorateRecords(
  collection: string,
  ids: string[],
  opts: { owners?: boolean } = {}
): Promise<Map<string, PinDecoration>> {
  const out = new Map<string, PinDecoration>()
  if (ids.length === 0) return out
  const inst = (await selectInChunks(ids, 2000, (chunk) =>
    db('nivaro_workflow_instances as i')
      .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
      .where('i.collection', collection)
      .whereIn('i.item', chunk)
      .whereNull('i.completed_at')
      .select('i.id as instance_id', 'i.item', 'i.current_state', 's.key', 's.label', 's.color')
  ).catch(() => [])) as Array<{
    instance_id: string
    item: string
    current_state: string
    key: string
    label: string
    color: string | null
  }>
  const byItem = new Map(inst.map((i) => [String(i.item), i]))
  let sla: Record<string, { status?: string | null }> = {}
  try {
    const { computeStatusBatch } = await import('../../routes/sla.js')
    sla = (await computeStatusBatch(collection, ids)) as typeof sla
  } catch {
    /* no SLA rules */
  }
  let owners = new Map<string, Array<{ id: string; name: string }>>()
  if (opts.owners !== false && inst.length > 0) {
    try {
      const { resolveStateOwnersBatch } = await import('../pipeline-engine.js')
      const { withReadGate } = await import('../read-gate.js')
      const res = await withReadGate(
        'command-center',
        () =>
          resolveStateOwnersBatch(
            inst.map((i) => ({
              key: String(i.item),
              stateId: String(i.current_state),
              instanceId: String(i.instance_id),
              collection,
              itemId: String(i.item)
            }))
          ),
        { label: 'cc:geo-owners' }
      )
      owners = new Map(
        [...res].map(([k, list]) => [
          k,
          list.slice(0, 5).map((o) => ({
            id: String(o.id),
            name: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email || 'Someone'
          }))
        ])
      )
    } catch {
      /* owners are decoration */
    }
  }
  for (const id of ids) {
    const st = byItem.get(id)
    const s = sla[id]?.status
    out.set(id, {
      state: st ? { key: st.key, label: st.label, color: st.color } : null,
      sla: s === 'breached' ? 'breached' : s === 'warning' ? 'warning' : st ? 'ok' : null,
      owners: owners.get(id) ?? []
    })
  }
  return out
}

/** The geo field pair for a collection (detected), or null when it carries none. */
export async function geoFieldsOf(collection: string): Promise<GeoCandidate | null> {
  const det = await detectPlacement()
  return det.geo.find((g) => g.key === collection) ?? null
}

/** Read up to `limit` rows as the caller, optionally only among `ids` (chunked under the bound-parameter cap). */
export async function readAsCaller(
  user: User,
  collection: string,
  fields: string[],
  filter: Record<string, unknown> | null,
  ids: Set<string> | null,
  limit: number
): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }> {
  const { readItems } = await import('../items.js')
  const read = async (f: Record<string, unknown> | null, n: number) =>
    (
      (await readItems(user, collection, {
        fields,
        ...(f ? { filter: f } : {}),
        limit: n,
        count: false
      })) as { data?: Array<Record<string, unknown>> }
    ).data ?? []
  if (!ids) {
    const rows = await read(filter, limit + 1)
    return { rows: rows.slice(0, limit), truncated: rows.length > limit }
  }
  const all = [...ids]
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < all.length && rows.length <= limit; i += 1000) {
    const chunk = all.slice(i, i + 1000)
    const f = filter ? { _and: [filter, { id: { _in: chunk } }] } : { id: { _in: chunk } }
    rows.push(...(await read(f, limit + 1 - rows.length)))
  }
  return { rows: rows.slice(0, limit), truncated: rows.length > limit }
}

export async function geoPins(
  user: User,
  collection: string,
  scope: CcScope,
  filters: GeoFilters,
  opts: { limit?: number } = {}
): Promise<GeoAnswer> {
  const limit = opts.limit ?? GEO_LIMIT
  const g = await geoFieldsOf(collection)
  if (!g) return { pins: [], truncated: false, region_applies: false, no_geo: true }

  let ids: Set<string> | null = null
  let regionApplies = false
  if (scope.region) {
    ids = await recordIdsInRegion(collection, scope.region)
    regionApplies = ids !== null
    if (ids && ids.size === 0)
      return {
        pins: [],
        truncated: false,
        region_applies: true,
        ...(scope.at ? { live_only: true } : {})
      }
  }

  const plan = await labelPlan(collection)
  const conds: Array<Record<string, unknown>> = [
    { [g.lat_field]: { _nnull: true } },
    { [g.lng_field]: { _nnull: true } }
  ]
  if (filters.states.length > 0) conds.push({ $state: { _in: filters.states } })
  const fields = [...new Set(['id', g.lat_field, g.lng_field, ...plan.fields])]
  // Post-filters (SLA, owner) read a wider window so a narrowed map is still full.
  const postFilter = filters.sla.length > 0 || !!filters.owner
  const { rows: raw, truncated: hitLimit } = await readAsCaller(
    user,
    collection,
    fields,
    { _and: conds },
    ids,
    postFilter ? limit * 4 : limit
  )
  const rows = raw.filter((r) => {
    const lat = Number(r[g.lat_field])
    const lng = Number(r[g.lng_field])
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      !(lat === 0 && lng === 0) &&
      Math.abs(lat) <= 90
    )
  })
  const deco = await decorateRecords(
    collection,
    rows.map((r) => String(r.id))
  )
  let pins: GeoPinOut[] = rows.map((r) => {
    const id = String(r.id)
    const d = deco.get(id)
    return {
      id,
      lat: Number(r[g.lat_field]),
      lng: Number(r[g.lng_field]),
      label: plan.render(r) || `Record ${id}`,
      state: d?.state?.label ?? null,
      state_key: d?.state?.key ?? null,
      state_color: d?.state?.color ?? null,
      sla: d?.sla ?? null,
      owner: d?.owners[0]?.name ?? null,
      owners: d?.owners ?? []
    }
  })
  if (filters.sla.length > 0) pins = pins.filter((p) => p.sla && filters.sla.includes(p.sla))
  if (filters.owner) {
    const want = filters.owner.toUpperCase()
    pins = pins.filter((p) => p.owners.some((o) => o.id.toUpperCase() === want))
  }
  const truncated = hitLimit || pins.length > limit
  return {
    pins: pins.slice(0, limit),
    truncated,
    region_applies: regionApplies,
    ...(scope.at ? { live_only: true } : {})
  }
}
