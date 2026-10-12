import { db } from '../db/index.js'
import { emitJobProgress } from './live-progress.js'

/**
 * Where a queued staged import stands (#1753): "3rd in line, about 4 minutes".
 *
 * Runs serialise per lock group (the definition's staging table), so a queued run waits
 * for the running run of its group and every earlier queued run of the same group. Runs of
 * other groups proceed in parallel and are not ahead of it. The estimate is the sum of each
 * run ahead's typical duration (median of that definition's last 10 completed runs; a
 * running one counts what is left of it), plus the worker's 10-second tick.
 */

export interface QueueEntry {
  id: number
  import_key: string
  status: 'queued' | 'running'
  sort?: number | null
  started_at?: Date | string | null
  created_by?: string | null
}

export interface QueueStanding {
  id: number
  /** 1 = next up. */
  position: number
  /** Runs that must finish first. */
  ahead: number
  /** Seconds until it starts; null when no run ahead has history to judge by. */
  eta_seconds: number | null
}

const TICK_SECONDS = 10
const MIN_REMAINING_SECONDS = 5

/** Pure — exported for tests. */
export function computeStanding(
  entries: QueueEntry[],
  groupOf: (importKey: string) => string,
  medianSeconds: (importKey: string) => number | null,
  now = Date.now()
): Map<number, QueueStanding> {
  const running = entries.filter((e) => e.status === 'running')
  const queued = entries
    .filter((e) => e.status === 'queued')
    .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0) || a.id - b.id)
  const out = new Map<number, QueueStanding>()
  const earlier = new Map<string, QueueEntry[]>()
  for (const q of queued) {
    const group = groupOf(q.import_key)
    const ahead = [
      ...running.filter((r) => groupOf(r.import_key) === group),
      ...(earlier.get(group) ?? [])
    ]
    let eta: number | null = 0
    let known = ahead.length === 0
    for (const a of ahead) {
      const typical = medianSeconds(a.import_key)
      if (typical == null) continue
      known = true
      if (a.status === 'running' && a.started_at) {
        const elapsed = (now - new Date(a.started_at).getTime()) / 1000
        eta += Math.max(MIN_REMAINING_SECONDS, typical - elapsed)
      } else eta += typical
    }
    out.set(q.id, {
      id: q.id,
      position: ahead.length + 1,
      ahead: ahead.length,
      eta_seconds: known ? Math.round(eta + TICK_SECONDS) : null
    })
    earlier.set(group, [...(earlier.get(group) ?? []), q])
  }
  return out
}

/** Median of the most recent 10 durations per definition key. */
export async function recentMedians(keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (keys.length === 0) return out
  const rows = (await db('nivaro_import_queue')
    .whereIn('import_key', keys)
    .where('status', 'completed')
    .whereNotNull('duration')
    .orderBy('id', 'desc')
    .limit(400)
    .select('import_key', 'duration')) as Array<{ import_key: string; duration: number | string }>
  const by = new Map<string, number[]>()
  for (const r of rows) {
    const list = by.get(r.import_key) ?? []
    if (list.length < 10) list.push(Number(r.duration))
    by.set(r.import_key, list)
  }
  for (const [k, list] of by) {
    const sorted = list.filter(Number.isFinite).sort((a, b) => a - b)
    if (sorted.length === 0) continue
    const mid = Math.floor(sorted.length / 2)
    out.set(k, sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2)
  }
  return out
}

/** Queued + running entries with their standing, read live from the queue table. */
export async function loadQueueStanding(
  groupOf: (importKey: string) => string
): Promise<{ entries: QueueEntry[]; standing: Map<number, QueueStanding> }> {
  const entries = (await db('nivaro_import_queue')
    .whereIn('status', ['queued', 'running'])
    .orderBy('id')
    .limit(300)
    .select('id', 'import_key', 'status', 'sort', 'started_at', 'created_by')) as QueueEntry[]
  const medians = await recentMedians([...new Set(entries.map((e) => e.import_key))])
  return {
    entries,
    standing: computeStanding(entries, groupOf, (k) => medians.get(k) ?? null)
  }
}

// What each queued run's creator was last told, so a tick that changes nothing is silent.
const lastSent = new Map<number, string>()

/**
 * Tell each queued run's creator where it stands — only when the position or the
 * (minute-rounded) estimate moved. Runs that left the queue are forgotten.
 */
export function publishQueueStanding(
  entries: QueueEntry[],
  standing: Map<number, QueueStanding>,
  labelOf: (importKey: string) => string
): void {
  const live = new Set<number>()
  for (const e of entries) {
    if (e.status !== 'queued') continue
    live.add(e.id)
    const s = standing.get(e.id)
    if (!s) continue
    const sig = `${s.position}|${s.eta_seconds == null ? '' : Math.round(s.eta_seconds / 60)}`
    if (lastSent.get(e.id) === sig) continue
    lastSent.set(e.id, sig)
    emitJobProgress(e.created_by, {
      key: `import:${e.id}`,
      kind: 'import',
      label: `${labelOf(e.import_key)} import`,
      status: 'queued',
      position: s.position,
      eta_seconds: s.eta_seconds,
      href: `/imports?run=${e.id}`
    })
  }
  for (const id of lastSent.keys()) if (!live.has(id)) lastSent.delete(id)
}
