import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { selectInChunks } from '../db-batch.js'
import { geoFieldsOf, geoPins, readAsCaller } from './geo.js'
import {
  detectPlacement,
  readableName,
  recordIdsInRegion,
  regionCentroids,
  userIdsInRegion,
  userRegionMap
} from './regions.js'
import type { CcScope } from './scope.js'

/**
 * Extra map layers (CC-11). Every point is something the caller may already see:
 *   sla_heat  — the caller's own map pins in SLA warning / breached, weighted (breached = 1).
 *   activity  — geo records changed in the last 15 minutes, directly or through a record that
 *               links to one (an M2O to the geo collection); every hop read as the caller.
 *   out_today — people out of office now, at their office (else their region's centre), limited
 *               to the people the caller may see in presence (same boundary as the people pane).
 */

export type LayerKind = 'sla_heat' | 'activity' | 'out_today'
export const LAYER_KINDS: LayerKind[] = ['sla_heat', 'activity', 'out_today']

export interface LayerPoint {
  id: string
  lat: number
  lng: number
  label: string
  weight?: number
  href?: string | null
  /** Record the point stands for (click → peek). */
  collection?: string
}

export interface LayerAnswer {
  kind: LayerKind
  points: LayerPoint[]
  region_applies: boolean
  live_only?: boolean
}

const ACTIVITY_WINDOW_MS = 15 * 60_000
const MAX_POINTS = 300

/** Pure: weight of a change `ageMs` old inside the activity window (newest = 1, oldest ≥ 0.2). */
export function recencyWeight(ageMs: number, windowMs = ACTIVITY_WINDOW_MS): number {
  const w = 1 - Math.max(0, ageMs) / windowMs
  return Math.max(0.2, Math.min(1, Number(w.toFixed(2))))
}

export async function mapLayer(
  user: User,
  isAdmin: boolean,
  kind: LayerKind,
  collection: string | null,
  scope: CcScope
): Promise<LayerAnswer> {
  const live = scope.at ? { live_only: true } : {}
  if (kind === 'out_today') return { ...(await outToday(user, isAdmin, scope)), ...live }
  if (!collection) return { kind, points: [], region_applies: false, ...live }
  if (kind === 'sla_heat') {
    const ans = await geoPins(user, collection, scope, {
      states: [],
      sla: ['warning', 'breached'],
      owner: null
    })
    return {
      kind,
      points: ans.pins.map((p) => ({
        id: p.id,
        lat: p.lat,
        lng: p.lng,
        label: `${p.label} — SLA ${p.sla === 'breached' ? 'breached' : 'warning'}`,
        weight: p.sla === 'breached' ? 1 : 0.6,
        collection
      })),
      region_applies: ans.region_applies,
      ...live
    }
  }
  return { ...(await activity(user, collection, scope)), ...live }
}

async function activity(user: User, collection: string, scope: CcScope): Promise<LayerAnswer> {
  const g = await geoFieldsOf(collection)
  if (!g) return { kind: 'activity', points: [], region_applies: false }
  const { can } = await import('../permissions.js')
  if (!(await can(user, 'read', collection)))
    return { kind: 'activity', points: [], region_applies: false }
  const det = await detectPlacement()
  // Collections whose records name a geo record (M2O): their changes count at that place.
  const linked = det.meta.relations.filter(
    (r) =>
      r.one_collection === collection &&
      !r.junction_field &&
      r.many_collection !== collection &&
      /^[A-Za-z0-9_]+$/.test(r.many_collection) &&
      !/^(nivaro_|directus_)/i.test(r.many_collection)
  )
  const since = new Date(Date.now() - ACTIVITY_WINDOW_MS)
  const rows = (await db('nivaro_activity')
    .where('timestamp', '>', since)
    .whereIn('collection', [collection, ...new Set(linked.map((l) => l.many_collection))])
    .whereIn('action', ['create', 'update', 'pipeline-transition'])
    .whereNotNull('item')
    .orderBy('id', 'desc')
    .limit(600)
    .select('collection', 'item', 'timestamp')) as Array<{
    collection: string
    item: string
    timestamp: Date | string
  }>

  // geo id → newest change time + change count
  const hits = new Map<string, { at: number; n: number }>()
  const bump = (geoId: string, at: number) => {
    const h = hits.get(geoId) ?? { at: 0, n: 0 }
    h.at = Math.max(h.at, at)
    h.n++
    hits.set(geoId, h)
  }
  const byCollection = new Map<string, Array<{ item: string; at: number }>>()
  for (const r of rows) {
    const list = byCollection.get(r.collection) ?? []
    list.push({ item: String(r.item), at: new Date(r.timestamp).getTime() })
    byCollection.set(r.collection, list)
  }
  for (const r of byCollection.get(collection) ?? []) bump(r.item, r.at)
  for (const l of linked) {
    const changes = byCollection.get(l.many_collection)
    if (!changes?.length) continue
    if (!(await can(user, 'read', l.many_collection))) continue
    try {
      const { rows: linkedRows } = await readAsCaller(
        user,
        l.many_collection,
        ['id', l.many_field],
        null,
        new Set(changes.map((c) => c.item)),
        MAX_POINTS
      )
      const fk = new Map(linkedRows.map((x) => [String(x.id), x[l.many_field]]))
      for (const c of changes) {
        const target = fk.get(c.item)
        if (target != null && typeof target !== 'object') bump(String(target), c.at)
      }
    } catch {
      /* a linked collection the caller cannot read adds nothing */
    }
  }
  if (hits.size === 0) return { kind: 'activity', points: [], region_applies: !!scope.region }

  let ids = new Set(hits.keys())
  let regionApplies = false
  if (scope.region) {
    const inRegion = await recordIdsInRegion(collection, scope.region)
    regionApplies = inRegion !== null
    if (inRegion) ids = new Set([...ids].filter((i) => inRegion.has(i)))
  }
  const { getCollection } = await import('../collections.js')
  const label = readableName(
    collection,
    (await getCollection(collection).catch(() => undefined))?.singular
  )
  const { rows: geoRows } = await readAsCaller(
    user,
    collection,
    ['id', g.lat_field, g.lng_field],
    null,
    ids,
    MAX_POINTS
  )
  const now = Date.now()
  const points: LayerPoint[] = []
  for (const r of geoRows) {
    const lat = Number(r[g.lat_field])
    const lng = Number(r[g.lng_field])
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue
    const h = hits.get(String(r.id))
    if (!h) continue
    const mins = Math.max(0, Math.round((now - h.at) / 60_000))
    points.push({
      id: String(r.id),
      lat,
      lng,
      label: `${label}: ${h.n} change${h.n === 1 ? '' : 's'}, last ${mins < 1 ? 'just now' : `${mins} min ago`}`,
      weight: recencyWeight(now - h.at),
      collection
    })
  }
  return { kind: 'activity', points, region_applies: regionApplies }
}

async function outToday(user: User, isAdmin: boolean, scope: CcScope): Promise<LayerAnswer> {
  const now = new Date()
  const rows = (await db('nivaro_users')
    .where((qb) => qb.whereNull('status').orWhereNot('status', 'suspended'))
    .where('is_redacted', 0)
    .where((qb) => {
      qb.where('is_out_of_office', true).orWhere((w) => {
        w.whereNotNull('ooo_start')
          .where('ooo_start', '<=', now)
          .where((e) => e.whereNull('ooo_end').orWhere('ooo_end', '>=', now))
      })
    })
    .limit(2000)
    .select(
      'id',
      'first_name',
      'last_name',
      'email',
      'ooo_end',
      'office_lat',
      'office_lng',
      'office_location'
    )) as Array<Record<string, unknown>>
  if (rows.length === 0) return { kind: 'out_today', points: [], region_applies: !!scope.region }

  const { visibleToViewer } = await import('../../routes/presence.js')
  const visible = await visibleToViewer(
    user,
    isAdmin,
    rows.map((r) => String(r.id))
  )
  let people = rows.filter((r) => visible.has(String(r.id).toUpperCase()))
  let regionApplies = false
  if (scope.region) {
    const inRegion = await userIdsInRegion(scope.region)
    regionApplies = inRegion !== null
    if (inRegion) people = people.filter((r) => inRegion.has(String(r.id).toUpperCase()))
  }
  const [regionMap, centroids] = await Promise.all([
    userRegionMap().catch(() => null),
    regionCentroids().catch(() => [])
  ])
  const centroidOf = new Map(centroids.map((c) => [c.id, c]))
  const points: LayerPoint[] = []
  for (const r of people) {
    const uid = String(r.id).toUpperCase()
    let lat = Number(r.office_lat)
    let lng = Number(r.office_lng)
    let where = (r.office_location as string | null) ?? null
    if (r.office_lat == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      const regs = (regionMap?.get(uid) ?? []).filter((x) => !scope.region || x === scope.region)
      const c = regs.map((x) => centroidOf.get(x)).find(Boolean)
      if (!c) continue
      lat = c.lat
      lng = c.lng
      where = c.label
    }
    const name =
      [r.first_name, r.last_name].filter(Boolean).join(' ') ||
      String(r.email ?? '').split('@')[0] ||
      'Someone'
    const until = r.ooo_end ? new Date(String(r.ooo_end)) : null
    points.push({
      id: uid,
      lat,
      lng,
      label: `${name} — out of office${until && Number.isFinite(until.getTime()) ? ` until ${until.toISOString().slice(0, 10)}` : ''}${where ? ` · ${where}` : ''}`
    })
    if (points.length >= MAX_POINTS) break
  }
  return { kind: 'out_today', points, region_applies: regionApplies }
}

/** People ids an admin may message (exist, not suspended/redacted). */
export async function messageableUserIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = (await selectInChunks(ids, 2000, (chunk) =>
    db('nivaro_users')
      .whereIn('id', chunk)
      .where((qb) => qb.whereNull('status').orWhereNot('status', 'suspended'))
      .where('is_redacted', 0)
      .select('id')
  )) as Array<{ id: string }>
  return rows.map((r) => String(r.id))
}
