import type { FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { collectionTitle } from '../record-label-fallback.js'
import { alertPrefillHref, regionAlertFilter } from './alert-href.js'
import { ccIsAdmin } from './auth.js'
import { readCcConfig } from './config.js'
import {
  type OpenInstance,
  type OpenWorkIndex,
  openWorkFor,
  type RecentInstance
} from './open-work.js'
import { readCcScope } from './scope.js'
import { Viewer } from './work-access.js'
import { ageStats, clearsInDays, wipDelta } from './work-math.js'

/**
 * CC-9 flow depth — per bound collection the caller may read: per state the open count, oldest
 * and median time in the state, how many are stuck (longer than the configured stuck_days), and
 * for the whole pipeline the 7-day open change, completions and "clears in". Every number counts
 * only records the caller can open (row filter + User Scopes through the work index's Viewer) and,
 * with a region focus, records placed in that region.
 *
 * Mirrors packages/shared/src/components/command-center/types.ts FlowDetail.
 */
export interface FlowStateDetail {
  key: string
  label: string
  color: string | null
  count: number
  oldest_age_s: number | null
  median_age_s: number | null
  stuck: number
  alert_href?: string | null
}

export interface FlowDetail {
  collection: string
  collection_label: string
  template_name: string
  states: FlowStateDetail[]
  open: number
  wip_7d_delta: number | null
  completed_7d: number
  arrivals_7d?: number
  clears_in_days: number | null
  live_only?: boolean
  region_applies?: boolean
}

export async function collectionLabels(collections: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (collections.length === 0) return out
  try {
    const rows = (await db('nivaro_collections')
      .whereIn('collection', collections)
      .select('collection', 'display_name')) as Array<{
      collection: string
      display_name: string | null
    }>
    for (const r of rows) out.set(r.collection, collectionTitle(r.collection, r.display_name))
  } catch {
    /* labels fall back to words below */
  }
  for (const c of collections) if (!out.has(c)) out.set(c, collectionTitle(c))
  return out
}

/** The open instances + recent rows of one binding the viewer may see. */
export async function viewerSlice(
  viewer: Viewer,
  index: OpenWorkIndex,
  collection: string,
  template: string
): Promise<{ open: OpenInstance[]; recent: RecentInstance[] } | null> {
  if (!(await viewer.mayRead(collection))) return null
  const same = (t: string) => t.toUpperCase() === template.toUpperCase()
  const open = index.open.filter((o) => o.collection === collection && same(o.template))
  const recent = index.recent.filter((r) => r.collection === collection && same(r.template))
  return {
    open: await viewer.filter(collection, open, (o) => o.item),
    recent: await viewer.filter(collection, recent, (r) => r.item)
  }
}

export async function computeFlow(
  viewer: Viewer,
  index: OpenWorkIndex,
  opts: { stuckDays: number; liveOnly?: boolean; alerts?: boolean }
): Promise<FlowDetail[]> {
  const labels = await collectionLabels([...new Set(index.bindings.map((b) => b.collection))])
  const regionFilter =
    opts.alerts && viewer.regionId ? await regionAlertFilter(viewer.regionId) : null
  const out: FlowDetail[] = []
  for (const b of index.bindings) {
    const slice = await viewerSlice(viewer, index, b.collection, b.template)
    if (!slice) continue
    const byState = new Map<string, OpenInstance[]>()
    for (const o of slice.open) {
      const k = o.state_id.toUpperCase()
      byState.set(k, [...(byState.get(k) ?? []), o])
    }
    const states = [...index.states.values()]
      .filter((s) => s.template.toUpperCase() === b.template.toUpperCase())
      .filter((s) => !s.is_terminal || byState.has(s.id.toUpperCase()))
      .sort((a, z) => a.sort - z.sort)
      .map((s): FlowStateDetail => {
        const list = byState.get(s.id.toUpperCase()) ?? []
        const ages = ageStats(
          list.map((o) => o.entered_at),
          index.as_of,
          opts.stuckDays
        )
        const filters =
          regionFilter && regionFilter.collection === b.collection
            ? { [regionFilter.field]: regionFilter.value }
            : undefined
        return {
          key: s.key,
          label: s.label,
          color: s.color,
          count: list.length,
          ...ages,
          ...(opts.alerts
            ? {
                alert_href: alertPrefillHref({
                  name: `${b.template_name}: ${s.label}`,
                  collection: b.collection,
                  category: 'workflow',
                  filters
                })
              }
            : {})
        }
      })
    const open = slice.open.length
    if (open === 0 && slice.recent.length === 0) continue
    const arrivals = slice.recent.filter((r) => r.started_at > index.as_of - 7 * 86_400_000).length
    const completed = slice.recent.filter((r) => r.completed_at != null).length
    out.push({
      collection: b.collection,
      collection_label: labels.get(b.collection) ?? b.collection,
      template_name: b.template_name,
      states,
      open,
      wip_7d_delta: index.truncated ? null : wipDelta(arrivals, completed),
      completed_7d: completed,
      arrivals_7d: arrivals,
      clears_in_days: clearsInDays(open, completed),
      ...(opts.liveOnly ? { live_only: true } : {}),
      ...(viewer.regionId
        ? { region_applies: (await viewer.regionSet(b.collection)) !== null }
        : {})
    })
  }
  return out
}

/** The /snapshot flow block's shape: states with open records, per binding with any. */
export function toSnapshotFlow(flow: FlowDetail[]): Array<{
  collection: string
  template_name: string
  states: Array<{ key: string; label: string; color: string | null; count: number }>
}> {
  return flow
    .map((f) => ({
      collection: f.collection,
      template_name: f.template_name,
      states: f.states
        .filter((s) => s.count > 0)
        .map((s) => ({ key: s.key, label: s.label, color: s.color, count: s.count }))
    }))
    .filter((f) => f.states.length > 0)
}

/** GET /command-center/flow for one request (scoped, region, rewind). */
export async function flowForRequest(req: FastifyRequest): Promise<FlowDetail[]> {
  const scope = readCcScope(req.query)
  const viewer = new Viewer(req.user!, ccIsAdmin(req), scope.region)
  const { index, liveOnly } = await openWorkFor(scope.at, String(req.user!.id))
  if (!index) return []
  const cfg = await readCcConfig()
  return computeFlow(viewer, index, {
    stuckDays: cfg.stuck_days,
    liveOnly,
    alerts: ccIsAdmin(req)
  })
}

/** The /snapshot flow block for one request: the same counts as /flow, in the snapshot's shape. */
export async function snapshotFlowBlock(
  req: FastifyRequest
): Promise<ReturnType<typeof toSnapshotFlow>> {
  const scope = readCcScope(req.query)
  const viewer = new Viewer(req.user!, ccIsAdmin(req), scope.region)
  // A cold index never holds the whole snapshot for long; the flow panel's own read waits.
  const { index } = await openWorkFor(scope.at, String(req.user!.id), 5000)
  if (!index) return []
  const cfg = await readCcConfig()
  return toSnapshotFlow(await computeFlow(viewer, index, { stuckDays: cfg.stuck_days }))
}
