import { db } from '../../../db/index.js'
import { activeWindow, listFreezes, nextWindow } from '../releases/freeze.js'
import { listSchedules } from '../releases/schedules.js'

/**
 * Planned maintenance for the status page (Hub enhancement 34) — THE seam for the change calendar.
 *
 * A planned item is a public-safe line: which app (null = every app), a fixed kind word, a
 * generic title and the time range — never a version, an environment address, a freeze's own
 * name or who scheduled it. Today the items come from two sources (Hub release operations):
 *
 *   freezes    nivaro_hub_freezes windows on now or next   → "Change freeze — no updates"
 *   schedules  scheduled promotions and trains (scheduled / waiting) → "Planned update"
 *
 * The change calendar (Hub enhancement 26, hub-enh/change) plugs in by adding its reader to
 * `defaultPlannedSources()` below (one line); the status page reads only plannedMaintenance(), so
 * it never learns where an item came from. A source that fails is skipped (the page still shows).
 */

export type PlannedKind = 'update' | 'freeze' | 'maintenance'

export interface PlannedItem {
  app_id: number | null
  kind: PlannedKind
  title: string
  starts_at: string
  ends_at: string | null
}

export interface PlannedQuery {
  /** Apps on the page (Hub-wide items are always included). */
  appIds: number[]
  from: number
  to: number
}

export type PlannedSource = (q: PlannedQuery) => Promise<PlannedItem[]>

export const PLANNED_HORIZON_MS = 14 * 86_400_000

const iso = (ms: number) => new Date(ms).toISOString()

/** Freeze windows that are on now or start inside the horizon. */
export const freezeSource: PlannedSource = async (q) => {
  const out: PlannedItem[] = []
  const incidentFreezes = new Set(
    (
      (await db('nivaro_hub_freezes')
        .where('source', 'like', 'incident:%')
        .select('id')
        .catch(() => [])) as Array<{ id: number }>
    ).map((r) => Number(r.id))
  )
  for (const f of await listFreezes()) {
    if (f.app_id != null && !q.appIds.includes(f.app_id)) continue
    // An incident's own freeze is the incident on the page, not planned work (by source tag).
    if (incidentFreezes.has(f.id)) continue
    for (const w of [activeWindow(f, q.from), nextWindow(f, q.from)]) {
      if (!w || w.start > q.to) continue
      out.push({
        app_id: f.app_id,
        kind: 'freeze',
        title: 'Change freeze — no updates',
        starts_at: iso(w.start),
        ends_at: iso(w.end)
      })
    }
  }
  return out
}

/** Scheduled promotions and release trains not started yet. */
export const scheduleSource: PlannedSource = async (q) => {
  if (!q.appIds.length) return []
  const rows = await listSchedules({ appIds: q.appIds, limit: 200 })
  return rows
    .filter((s) => s.status === 'scheduled' || s.status === 'waiting')
    .filter((s) => {
      const at = Date.parse(s.run_at)
      return at >= q.from - 60 * 60_000 && at <= q.to
    })
    .map((s) => ({
      app_id: s.app_id,
      kind: 'update' as const,
      title: 'Planned update — the app may be briefly unavailable',
      starts_at: new Date(Date.parse(s.run_at)).toISOString(),
      ends_at: null
    }))
}

/** The sources the status page reads. The change calendar adds its own here. */
export function defaultPlannedSources(): PlannedSource[] {
  return [freezeSource, scheduleSource]
}

/** Every planned item for these apps from now to the horizon, soonest first, duplicates folded. */
export async function plannedMaintenance(
  q: Omit<PlannedQuery, 'from' | 'to'> & { now?: number },
  sources: PlannedSource[] = defaultPlannedSources()
): Promise<PlannedItem[]> {
  const from = q.now ?? Date.now()
  const query = { appIds: q.appIds, from, to: from + PLANNED_HORIZON_MS }
  const all = (await Promise.all(sources.map((s) => s(query).catch(() => [])))).flat()
  const seen = new Set<string>()
  return all
    .filter((i) => {
      const k = `${i.app_id}|${i.kind}|${i.starts_at}|${i.ends_at}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, 50)
}
