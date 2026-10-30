import type { FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { ccCredKey, ccIsAdmin } from './auth.js'
import { liveOpenWork } from './open-work.js'
import { readCcScope } from './scope.js'
import { tenantMemo, Viewer } from './work-access.js'

/**
 * The /snapshot risk block (CC-1): at-risk + tracked from the materialized queue rows, open
 * issues, and the SLA warning / breached counts of open records — every record count narrowed to
 * what the caller can open (and to the focused region). Admins see the instance-wide figures.
 *
 * SLA counts come from the shared open-work index; when it is still building (cold start) the
 * snapshot does not wait past ~2 s and leaves them out (undefined) rather than reading zero.
 */
export interface SnapshotRisk {
  at_risk: number
  tracked: number
  /** Open issues are an administrator figure: null for everyone else. */
  open_issues: number | null
  sla_warning?: number
  sla_breached?: number
}

const QUEUE_ROW_CAP = 20_000

async function queueRisk(viewer: Viewer): Promise<{ at_risk: number; tracked: number }> {
  if (viewer.isAdmin && !viewer.regionId) {
    const row = (await db('nivaro_queue_items')
      .select(
        db.raw('SUM(CASE WHEN at_risk = 1 THEN 1 ELSE 0 END) as at_risk'),
        db.raw("COUNT(DISTINCT CONCAT(collection, ':', item_id)) as tracked")
      )
      .first()
      .catch(() => null)) as { at_risk: number; tracked: number } | null
    return { at_risk: Number(row?.at_risk ?? 0), tracked: Number(row?.tracked ?? 0) }
  }
  // Per record (one row per collection + item, at risk if any queue says so), then narrowed.
  const rows = (await db('nivaro_queue_items')
    .groupBy('collection', 'item_id')
    .select('collection', 'item_id', db.raw('MAX(CASE WHEN at_risk = 1 THEN 1 ELSE 0 END) as r'))
    .limit(QUEUE_ROW_CAP)
    .catch(() => [])) as Array<{ collection: string; item_id: string; r: number }>
  const byCollection = new Map<string, Array<{ item_id: string; r: number }>>()
  for (const r of rows)
    byCollection.set(r.collection, [...(byCollection.get(r.collection) ?? []), r])
  let atRisk = 0
  let tracked = 0
  for (const [collection, list] of byCollection) {
    const seen = await viewer.filter(collection, list, (r) => String(r.item_id))
    tracked += seen.length
    atRisk += seen.filter((r) => Number(r.r) === 1).length
  }
  return { at_risk: atRisk, tracked }
}

async function slaCounts(viewer: Viewer): Promise<{ warning: number; breached: number } | null> {
  const index = await liveOpenWork(2000)
  if (!index) return null
  let warning = 0
  let breached = 0
  const byCollection = new Map<string, typeof index.open>()
  for (const o of index.open) {
    if (o.sla !== 'warning' && o.sla !== 'breached') continue
    byCollection.set(o.collection, [...(byCollection.get(o.collection) ?? []), o])
  }
  for (const [collection, list] of byCollection) {
    for (const o of await viewer.filter(collection, list, (x) => x.item)) {
      if (o.sla === 'breached') breached++
      else warning++
    }
  }
  return { warning, breached }
}

export async function computeSnapshotRisk(viewer: Viewer): Promise<SnapshotRisk> {
  const since = new Date(Date.now() - 90 * 86_400_000)
  const [queue, issues, sla] = await Promise.all([
    queueRisk(viewer).catch(() => ({ at_risk: 0, tracked: 0 })),
    // Instance-wide error issues name internal failures: administrators only.
    viewer.isAdmin
      ? (db('nivaro_issues')
          .where('status', 'open')
          .where('last_seen_at', '>', since)
          .count('* as n')
          .first()
          .catch(() => null) as Promise<{ n: number } | null | undefined>)
      : Promise.resolve(undefined),
    slaCounts(viewer).catch(() => null)
  ])
  return {
    at_risk: queue.at_risk,
    tracked: queue.tracked,
    open_issues: viewer.isAdmin ? Number(issues?.n ?? 0) : null,
    ...(sla ? { sla_warning: sla.warning, sla_breached: sla.breached } : {})
  }
}

/** The snapshot's risk block for one request (per person + region, memoised ~30 s). */
export async function snapshotRiskBlock(req: FastifyRequest): Promise<SnapshotRisk> {
  const scope = readCcScope(req.query)
  const isAdmin = ccIsAdmin(req)
  const viewer = new Viewer(req.user!, isAdmin, scope.region)
  const out = await tenantMemo(
    `cc:risk:${String(req.user!.id).toUpperCase()}:${ccCredKey(req)}:${isAdmin ? 'a' : 'u'}:${scope.region ?? ''}`,
    30_000,
    () => computeSnapshotRisk(viewer)
  )
  return out ?? { at_risk: 0, tracked: 0, open_issues: isAdmin ? 0 : null }
}
