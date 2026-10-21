import { db } from '../db/index.js'

/**
 * Worst dead-click elements per route (#1314). The RUM collector reports a
 * dead-click burst (and a rage click) as one nivaro_rum_events row whose route
 * reads "<route pattern> :: <element label>"; this folds those rows into one
 * line per (route, element) with counts, how many people hit it, and a sample
 * replay link when the latest event falls inside a recording. Counts only —
 * no click coordinates, no text beyond the element's own label.
 */

const SEP = ' :: '
/** Playback opens this long before the click. */
const LEAD_MS = 5_000

export interface FrustrationRow {
  route: string
  kind: string
  user: string | null
  created_at: Date | string
}

export interface DeadClickElement {
  route: string
  element: string
  dead: number
  rage: number
  /** dead + rage bursts */
  total: number
  people: number
  last_at: string
  /** Latest event with a person — what the replay lookup anchors on. */
  sample_user: string | null
  sample_at: string | null
}

export interface DeadClickRoute {
  route: string
  total: number
  elements: DeadClickElement[]
}

export function splitTarget(s: string): { route: string; element: string } {
  const i = s.indexOf(SEP)
  return i < 0
    ? { route: s || '/', element: '(unlabelled)' }
    : { route: s.slice(0, i) || '/', element: s.slice(i + SEP.length) || '(unlabelled)' }
}

/** Fold dead/rage rows per route and element; routes and elements ranked by count. */
export function summarizeDeadClicks(
  rows: FrustrationRow[],
  perRoute = 5,
  routeLimit = 25
): DeadClickRoute[] {
  const by = new Map<string, DeadClickElement & { users: Set<string> }>()
  for (const r of rows) {
    if (r.kind !== 'dead' && r.kind !== 'rage') continue
    const { route, element } = splitTarget(r.route)
    const key = `${route}\u0000${element}`
    const at = new Date(r.created_at).toISOString()
    let e = by.get(key)
    if (!e) {
      e = {
        route,
        element,
        dead: 0,
        rage: 0,
        total: 0,
        people: 0,
        last_at: at,
        sample_user: null,
        sample_at: null,
        users: new Set()
      }
      by.set(key, e)
    }
    if (r.kind === 'dead') e.dead++
    else e.rage++
    e.total++
    if (r.user) e.users.add(r.user)
    if (at > e.last_at) e.last_at = at
    if (r.user && (!e.sample_at || at > e.sample_at)) {
      e.sample_user = r.user
      e.sample_at = at
    }
  }
  const routes = new Map<string, DeadClickElement[]>()
  for (const { users, ...e } of by.values()) {
    const list = routes.get(e.route) ?? []
    list.push({ ...e, people: users.size })
    routes.set(e.route, list)
  }
  return [...routes.entries()]
    .map(([route, els]) => {
      els.sort((a, z) => z.total - a.total || z.last_at.localeCompare(a.last_at))
      return {
        route,
        total: els.reduce((n, e) => n + e.total, 0),
        elements: els.slice(0, perRoute)
      }
    })
    .sort((a, z) => z.total - a.total)
    .slice(0, routeLimit)
}

export interface ReplayLink {
  recording: string
  /** ms into the recording to open at. */
  t: number
}

/** The recording running for `user` at `at`, if one exists (retention may have purged it). */
export async function replayAt(user: string, at: string): Promise<ReplayLink | null> {
  const when = new Date(at)
  const row = (await db('nivaro_session_recordings')
    .where('user', user)
    .where('started_at', '<=', when)
    .whereRaw('DATEADD(second, 60, COALESCE(last_event_at, ended_at, GETUTCDATE())) >= ?', [when])
    .orderBy('started_at', 'desc')
    .first('id', 'started_at')) as { id: string; started_at: Date | string } | undefined
  if (!row) return null
  const t = Math.max(0, when.getTime() - new Date(row.started_at).getTime() - LEAD_MS)
  return { recording: String(row.id), t }
}

export async function deadClickReport(days: number) {
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = (await db('nivaro_rum_events')
    .whereIn('kind', ['dead', 'rage'])
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(20_000)
    .select('route', 'kind', 'user', 'created_at')) as FrustrationRow[]
  const routes = summarizeDeadClicks(rows)
  // One replay lookup per listed element (≤ 125) — failures just drop the link.
  const withLinks = await Promise.all(
    routes.map(async (r) => ({
      ...r,
      elements: await Promise.all(
        r.elements.map(async ({ sample_user, sample_at, ...e }) => ({
          ...e,
          replay:
            sample_user && sample_at
              ? await replayAt(sample_user, sample_at).catch(() => null)
              : null
        }))
      )
    }))
  )
  return { routes: withLinks, total_events: rows.length }
}
