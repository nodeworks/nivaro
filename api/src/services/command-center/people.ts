import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { selectInChunks } from '../db-batch.js'
import { ccIsAdmin } from './auth.js'
import {
  readableRegions,
  regionCentroids,
  resolveRegionSource,
  userIdsInRegion,
  userRegionMap
} from './regions.js'
import type { CcScope } from './scope.js'

/**
 * The snapshot's people block. WHO is listed comes from the presence answer for this viewer
 * (presenceOnlineFor — the /presence/online visibility boundary: a restricted viewer sees only
 * people restricted the same way, plus admins and themself). WHAT each person is on is that
 * answer's page label (labelled through the viewer's own read access) plus the record they have
 * open — named only when the viewer can read it (resolveRecordLabels as the viewer); a record
 * the viewer cannot read is never named.
 *
 * Grouping: people with a geocoded office pin at their office; the rest by the region source's
 * user-scope dimension (regions named only when the viewer can read them); the rest in
 * "No location set". The region lens keeps only people placed in that region.
 */

export interface PersonOnOut {
  user_id: string
  name: string
  idle: boolean
  page_label: string | null
  record: { collection: string; id: string; label: string } | null
}

export interface PeopleBlock {
  online_count: number
  idle_count: number
  names: string[]
  by_region: Array<{ region_id: string; count: number }>
  offices: Array<{ lat: number; lng: number; label: string; count: number; names: string[] }>
  regions: Array<{
    region_id: string | null
    label: string
    count: number
    names: string[]
    lat?: number
    lng?: number
    people: PersonOnOut[]
  }>
  region_applies?: boolean
}

/**
 * The people block a wallboard (kiosk) may show: counts only. No person is named, and no page or
 * record anyone has open leaves the server.
 */
export function countsOnlyPeople(block: PeopleBlock): PeopleBlock {
  return {
    ...block,
    names: [],
    offices: block.offices.map((o) => ({ ...o, names: [] })),
    regions: block.regions.map((r) => ({ ...r, names: [], people: [] }))
  }
}

export const EMPTY_PEOPLE: PeopleBlock = {
  online_count: 0,
  idle_count: 0,
  names: [],
  by_region: [],
  offices: [],
  regions: []
}

const GROUP_NAMES = 30
const GROUP_PEOPLE = 60
const RECORD_PATH = /^\/(?:records|collections)\/([A-Za-z0-9_]+)\/([^/?#]+)/

/** Pure: the record a person has open, when the viewer may know it (label resolved). */
export function recordFromPath(
  path: string | null | undefined,
  labels: Map<string, string>
): PersonOnOut['record'] {
  if (!path) return null
  const m = RECORD_PATH.exec(path)
  if (!m || m[2] === 'new') return null
  const label = labels.get(`${m[1]}:${m[2]}`)
  return label ? { collection: m[1], id: m[2], label } : null
}

interface OnlineRow {
  user_id: string
  display_name: string | null
  is_idle: boolean
  page: string | null
}

/** Visible online people for this viewer (presence boundary), upper-cased ids. */
export async function visibleOnline(
  app: FastifyInstance,
  req: FastifyRequest
): Promise<OnlineRow[]> {
  const { presenceOnlineFor } = await import('../../routes/presence.js')
  const answer = await presenceOnlineFor(app, req.user!, ccIsAdmin(req))
  return answer.data
    .filter((r) => r.user_id)
    .map((r) => ({
      user_id: String(r.user_id).toUpperCase(),
      display_name: (r.display_name as string | null) ?? null,
      is_idle: !!r.is_idle,
      page: (r.page as string | null) ?? null
    }))
}

export async function snapshotPeople(
  app: FastifyInstance,
  req: FastifyRequest,
  scope: CcScope
): Promise<PeopleBlock> {
  let online = await visibleOnline(app, req)

  let regionApplies: boolean | undefined
  if (scope.region) {
    const inRegion = await userIdsInRegion(scope.region)
    regionApplies = inRegion !== null
    if (inRegion) online = online.filter((o) => inRegion.has(o.user_id))
  }
  const ids = online.map((o) => o.user_id)

  // What each person has open — named only when the viewer can read it.
  const records = new Map<string, PersonOnOut['record']>()
  if (ids.length > 0) {
    try {
      const rows = (await selectInChunks(ids, 2000, (chunk) =>
        db('user_presence').whereIn('user_id', chunk).select('user_id', 'current_path')
      )) as Array<{ user_id: string; current_path: string | null }>
      const { resolveRecordLabels } = await import('../../routes/presence.js')
      const labels = await resolveRecordLabels(
        rows.map((r) => r.current_path),
        req.user!
      )
      for (const r of rows)
        records.set(String(r.user_id).toUpperCase(), recordFromPath(r.current_path, labels))
    } catch {
      /* the page label still says where they are */
    }
  }
  const personOn = (o: OnlineRow): PersonOnOut => ({
    user_id: o.user_id,
    name: o.display_name ?? 'Someone',
    idle: o.is_idle,
    page_label: o.page,
    record: records.get(o.user_id) ?? null
  })

  // Geocoded offices first.
  const officeRows = ids.length
    ? ((await selectInChunks(ids, 2000, (chunk) =>
        db('nivaro_users')
          .whereIn('id', chunk)
          .whereNotNull('office_lat')
          .select('id', 'office_lat', 'office_lng', 'office_location')
      ).catch(() => [])) as Array<{
        id: string
        office_lat: number
        office_lng: number
        office_location: string | null
      }>)
    : []
  const officeByUser = new Map(officeRows.map((r) => [String(r.id).toUpperCase(), r]))
  const officeGroups = new Map<
    string,
    { lat: number; lng: number; label: string; people: OnlineRow[] }
  >()
  for (const o of online) {
    const office = officeByUser.get(o.user_id)
    if (!office) continue
    const lat = Number(office.office_lat)
    const lng = Number(office.office_lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      officeByUser.delete(o.user_id)
      continue
    }
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`
    const g = officeGroups.get(key) ?? {
      lat,
      lng,
      label: office.office_location ?? 'Office',
      people: []
    }
    g.people.push(o)
    officeGroups.set(key, g)
  }

  // The rest by region (scope dimension), named only when the viewer may read the region.
  const source = await resolveRegionSource()
  const [regionMap, readable, centroids] = await Promise.all([
    userRegionMap(source).catch(() => null),
    readableRegions(req.user!, source).catch(() => []),
    regionCentroids(source).catch(() => [])
  ])
  const labelOf = new Map(readable.map((r) => [r.id, r.label]))
  const centroidOf = new Map(centroids.map((c) => [c.id, c]))
  const byRegion = new Map<string, OnlineRow[]>()
  const unplaced: OnlineRow[] = []
  for (const o of online) {
    if (officeByUser.has(o.user_id)) continue
    const regs = (regionMap?.get(o.user_id) ?? []).filter(
      (r) => !scope.region || r === scope.region
    )
    if (regs.length === 0) {
      unplaced.push(o)
      continue
    }
    for (const rid of regs) byRegion.set(rid, [...(byRegion.get(rid) ?? []), o])
  }

  const group = (people: OnlineRow[]) => ({
    count: people.length,
    names: people.slice(0, GROUP_NAMES).map((p) => p.display_name ?? 'Someone'),
    people: people.slice(0, GROUP_PEOPLE).map(personOn)
  })
  // Regions the viewer cannot read are folded together, unnamed.
  const hiddenRegion: OnlineRow[] = []
  const regionGroups: PeopleBlock['regions'] = []
  for (const [rid, people] of byRegion) {
    const label = labelOf.get(rid)
    if (!label) {
      for (const p of people) if (!hiddenRegion.includes(p)) hiddenRegion.push(p)
      continue
    }
    const c = centroidOf.get(rid)
    regionGroups.push({
      region_id: rid,
      label,
      ...group(people),
      ...(c ? { lat: c.lat, lng: c.lng } : {})
    })
  }

  return {
    online_count: online.length,
    idle_count: online.filter((o) => o.is_idle).length,
    names: online.slice(0, 40).map((o) => o.display_name ?? 'Someone'),
    by_region: [...byRegion.entries()]
      .filter(([rid]) => labelOf.has(rid))
      .map(([region_id, people]) => ({ region_id, count: people.length })),
    offices: [...officeGroups.values()].map((g) => ({
      lat: g.lat,
      lng: g.lng,
      label: g.label,
      count: g.people.length,
      names: g.people.slice(0, GROUP_NAMES).map((p) => p.display_name ?? 'Someone')
    })),
    regions: [
      ...[...officeGroups.values()].map((g) => ({
        region_id: null,
        label: g.label,
        ...group(g.people),
        lat: g.lat,
        lng: g.lng
      })),
      ...regionGroups.sort((a, z) => z.count - a.count),
      ...(hiddenRegion.length > 0
        ? [{ region_id: null, label: 'Other places', ...group(hiddenRegion) }]
        : []),
      ...(unplaced.length > 0
        ? [{ region_id: null, label: 'No location set', ...group(unplaced) }]
        : [])
    ],
    ...(regionApplies !== undefined ? { region_applies: regionApplies } : {})
  }
}
