import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'

/**
 * Real reload tracking (realtime idea 15).
 *
 * RUM load beacons carry how the page was reached (PerformanceNavigationTiming type: navigate |
 * reload | back_forward | prerender) and SPA route changes say whether Back/Forward caused them;
 * Back/Forward also names the route left behind. From that:
 *
 * - "Most reloaded screens": per screen, full loads that were the browser's Reload — a person
 *   not trusting what the page showed.
 * - "Back-and-forth": A → B → back to A, as (route ← left route) pairs — a person going away and
 *   back to see the page again.
 *
 * Both per release (the API version that took the beacon), so a release that fixes a screen's
 * live updates shows its reloads drop. Counts and route patterns only — never people or values.
 */

export type NavType = 'navigate' | 'reload' | 'back_forward' | 'prerender'
const NAV_TYPES: readonly NavType[] = ['navigate', 'reload', 'back_forward', 'prerender']

/** Pure: the nav columns for one intake event (null nav on beacons that do not say). */
export function navColumns(
  e: Record<string, unknown>,
  release: string
): { nav_type: NavType | null; prev_route: string | null; release: string } {
  const nav =
    (e.kind === 'load' || e.kind === 'route') && NAV_TYPES.includes(e.nav as NavType)
      ? (e.nav as NavType)
      : null
  const prev =
    nav === 'back_forward' && typeof e.prev === 'string' && e.prev.trim()
      ? e.prev.trim().slice(0, 300)
      : null
  return { nav_type: nav, prev_route: prev, release: String(release).slice(0, 40) }
}

export interface NavRow {
  route: string
  kind: string
  nav_type: string | null
  prev_route: string | null
  release: string | null
  app: string | null
}

export interface ReleaseCount {
  release: string
  views: number
  reloads: number
  back_forward: number
}

export interface ReloadedScreen {
  screen: string
  loads: number
  reloads: number
  /** reloads ÷ full loads (0–1). */
  share: number
  by_release: ReleaseCount[]
}

export interface BackForthPair {
  /** The screen people came back to. */
  screen: string
  /** The screen they had gone to. */
  via: string
  count: number
  by_release: ReleaseCount[]
}

export interface ReloadStats {
  available: boolean
  days: number
  views: number
  reloads: number
  back_forward: number
  releases: ReleaseCount[]
  reloaded: ReloadedScreen[]
  back_forth: BackForthPair[]
}

/** Pure: newest release first ("0.3.160" > "0.3.99"; anything else sorts after, by name). */
export function compareReleases(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  const ok = (p: number[]) => p.length >= 2 && p.every((n) => Number.isFinite(n))
  if (ok(pa) && ok(pb)) {
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  }
  if (ok(pa)) return -1
  if (ok(pb)) return 1
  return b.localeCompare(a)
}

const screenOf = (r: NavRow) => (r.app && r.app !== 'admin' ? `${r.app} ${r.route}` : r.route)

function bump(map: Map<string, ReleaseCount>, release: string | null, row: NavRow): void {
  const key = release || 'unknown'
  const c = map.get(key) ?? { release: key, views: 0, reloads: 0, back_forward: 0 }
  c.views++
  if (row.kind === 'load' && row.nav_type === 'reload') c.reloads++
  if (row.nav_type === 'back_forward') c.back_forward++
  map.set(key, c)
}

const sortedReleases = (m: Map<string, ReleaseCount>, keep = 4) =>
  [...m.values()].sort((a, z) => compareReleases(a.release, z.release)).slice(0, keep)

/** Pure: rows (page loads and route changes that say how they were reached) → the stats. */
export function summarizeReloads(rows: NavRow[], days: number, limit = 15): ReloadStats {
  const releases = new Map<string, ReleaseCount>()
  const screens = new Map<
    string,
    { loads: number; reloads: number; rel: Map<string, ReleaseCount> }
  >()
  const pairs = new Map<
    string,
    { screen: string; via: string; count: number; rel: Map<string, ReleaseCount> }
  >()
  let views = 0
  let reloads = 0
  let backForward = 0
  for (const r of rows) {
    if (!r.nav_type || (r.kind !== 'load' && r.kind !== 'route')) continue
    views++
    bump(releases, r.release, r)
    const screen = screenOf(r)
    const s = screens.get(screen) ?? { loads: 0, reloads: 0, rel: new Map() }
    bump(s.rel, r.release, r)
    if (r.kind === 'load') {
      s.loads++
      if (r.nav_type === 'reload') {
        s.reloads++
        reloads++
      }
    }
    screens.set(screen, s)
    if (r.nav_type === 'back_forward') {
      backForward++
      if (r.prev_route && r.prev_route !== r.route) {
        const via = r.app && r.app !== 'admin' ? `${r.app} ${r.prev_route}` : r.prev_route
        const key = `${screen}\u0000${via}`
        const p = pairs.get(key) ?? { screen, via, count: 0, rel: new Map() }
        p.count++
        bump(p.rel, r.release, r)
        pairs.set(key, p)
      }
    }
  }
  const reloaded = [...screens.entries()]
    .filter(([, s]) => s.reloads > 0)
    .map(([screen, s]) => ({
      screen,
      loads: s.loads,
      reloads: s.reloads,
      share: s.loads > 0 ? Math.round((s.reloads / s.loads) * 1000) / 1000 : 0,
      by_release: sortedReleases(s.rel)
    }))
    .sort((a, z) => z.reloads - a.reloads || z.share - a.share)
    .slice(0, limit)
  const back_forth = [...pairs.values()]
    .map((p) => ({
      screen: p.screen,
      via: p.via,
      count: p.count,
      by_release: sortedReleases(p.rel)
    }))
    .sort((a, z) => z.count - a.count)
    .slice(0, limit)
  return {
    available: true,
    days,
    views,
    reloads,
    back_forward: backForward,
    releases: sortedReleases(releases, 6),
    reloaded,
    back_forth
  }
}

const ROW_CAP = 60_000

/** Reload stats for a window (default: the last `days`, 1–14). */
export async function reloadStats(
  opts: { days?: number; since?: Date; until?: Date } = {}
): Promise<ReloadStats> {
  const days = Math.min(14, Math.max(1, Math.floor(opts.days ?? 7) || 7))
  if (!(await hasColumn('nivaro_rum_events', 'nav_type')))
    return { ...summarizeReloads([], days), available: false }
  const since = opts.since ?? new Date(Date.now() - days * 86_400_000)
  const qb = db('nivaro_rum_events')
    .where('created_at', '>=', since)
    .whereIn('kind', ['load', 'route'])
    .whereNotNull('nav_type')
    .orderBy('created_at', 'desc')
    .limit(ROW_CAP)
    .select('route', 'kind', 'nav_type', 'prev_route', 'release', 'app')
  if (opts.until) qb.where('created_at', '<', opts.until)
  const rows = (await qb) as NavRow[]
  return summarizeReloads(rows, days)
}

/** Daily report rows: the most reloaded screens and the commonest back-and-forth. */
export function reloadSectionRows(stats: ReloadStats): Array<{
  key: string
  label: string
  value: number
  unit: 'count'
  note?: string
  href?: string
  better: 'down'
}> {
  if (!stats.available) return []
  const rows: Array<{
    key: string
    label: string
    value: number
    unit: 'count'
    note?: string
    href?: string
    better: 'down'
  }> = [
    {
      key: 'reloads_total',
      label: 'Page reloads',
      value: stats.reloads,
      unit: 'count',
      note: `of ${stats.views} page views`,
      href: '/analytics/api',
      better: 'down'
    },
    {
      key: 'back_forward_total',
      label: 'Back-and-forth visits',
      value: stats.back_forward,
      unit: 'count',
      href: '/analytics/api',
      better: 'down'
    }
  ]
  for (const s of stats.reloaded.slice(0, 5)) {
    rows.push({
      key: `reloaded_${slug(s.screen)}`,
      label: `Reloaded: ${s.screen}`,
      value: s.reloads,
      unit: 'count',
      note: `${Math.round(s.share * 100)}% of its ${s.loads} loads`,
      better: 'down'
    })
  }
  for (const p of stats.back_forth.slice(0, 3)) {
    rows.push({
      key: `back_forth_${slug(`${p.screen}_${p.via}`)}`,
      label: `Back-and-forth: ${p.screen} ← ${p.via}`,
      value: p.count,
      unit: 'count',
      better: 'down'
    })
  }
  return rows
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 28) || 'screen'
  )
}
