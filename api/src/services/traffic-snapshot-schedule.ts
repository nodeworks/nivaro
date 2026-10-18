// api/src/services/traffic-snapshot-schedule.ts
/**
 * #2173 / #2177 — the Traffic Map's background chores, run by one cron every 5 minutes:
 *  - a snapshot just after each UTC day's busiest minute (kind `peak`; a later, higher peak the
 *    same day replaces the earlier one),
 *  - a snapshot every N hours when an admin set a schedule (kind `schedule`),
 *  - pruning of snapshots, scheduled snapshots and investigation notebooks by the retention
 *    settings (a pruning pass writes one activity row naming the counts).
 * Self-hosted only: cloud mode keeps map state per tenant and answers the map's extras 404.
 */
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { loadMapSettings } from './traffic-map-settings.js'
import {
  KIND_LIKE,
  type PruneResult,
  pruneMapData,
  SNAPSHOT_TABLE,
  storeAutoSnapshot
} from './traffic-snapshots.js'
import { markPeakCaptured, peakFacts, peakToCapture } from './traffic-taps/peak.js'
import { DEFAULT_STORE, withTrafficStore } from './traffic-taps.js'

const MIN_MS = 60_000
/** A scheduled snapshot is due this early, so a 5-minute tick never skips an hour. */
const SLACK_MS = 4 * MIN_MS

const pad = (n: number) => String(n).padStart(2, '0')
function stamp(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/** Is a scheduled snapshot due (pure)? `last` = the newest scheduled snapshot's time. */
export function scheduleDue(everyHours: number, last: Date | null, now: number): boolean {
  if (everyHours <= 0) return false
  if (!last) return true
  return now - last.getTime() >= everyHours * 3_600_000 - SLACK_MS
}

export interface ScheduleRun {
  peak: string | null
  schedule: string | null
  pruned: PruneResult
}

export async function runSnapshotSchedule(now = Date.now()): Promise<ScheduleRun> {
  const run: ScheduleRun = {
    peak: null,
    schedule: null,
    pruned: { snapshots: 0, scheduled: 0, notebooks: 0 }
  }
  if (process.env.CLOUD_META_DB_URL) return run
  if (!(await db.schema.hasTable(SNAPSHOT_TABLE))) return run
  const { settings } = await loadMapSettings()
  const sec = Math.floor(now / 1000)

  if (settings.schedule.peak) {
    const facts = withTrafficStore(DEFAULT_STORE, () => peakFacts(sec))
    const minute = peakToCapture(facts, sec)
    if (minute !== null) {
      const at = new Date(minute * MIN_MS)
      const dayStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
      // the day's earlier peak is superseded
      await db(SNAPSHOT_TABLE)
        .where('store', DEFAULT_STORE)
        .where('created_at', '>=', dayStart)
        .where('filters', 'like', KIND_LIKE.peak)
        .del()
      const made = await storeAutoSnapshot({
        store: DEFAULT_STORE,
        kind: 'peak',
        name: `Daily peak ${stamp(at)}`,
        note: `The busiest minute of the day so far: ${facts.peakCount} requests.`,
        window: 900
      })
      withTrafficStore(DEFAULT_STORE, () => markPeakCaptured(minute))
      run.peak = made.id
    }
  }

  if (settings.schedule.every_hours > 0) {
    const row = (await db(SNAPSHOT_TABLE)
      .where('store', DEFAULT_STORE)
      .where('filters', 'like', KIND_LIKE.schedule)
      .max('created_at as at')
      .first()) as { at?: Date | string | null } | undefined
    const last = row?.at ? new Date(row.at) : null
    if (scheduleDue(settings.schedule.every_hours, last, now)) {
      const made = await storeAutoSnapshot({
        store: DEFAULT_STORE,
        kind: 'schedule',
        name: `Scheduled ${stamp(new Date(now))}`,
        window: 300
      })
      run.schedule = made.id
    }
  }

  run.pruned = await pruneMapData(DEFAULT_STORE, settings.retention, now)
  const total = run.pruned.snapshots + run.pruned.scheduled + run.pruned.notebooks
  if (total > 0) {
    await logActivity({
      action: 'traffic-map-retention',
      user: null,
      collection: SNAPSHOT_TABLE,
      comment: `Traffic Map retention removed ${run.pruned.snapshots} snapshots, ${run.pruned.scheduled} scheduled snapshots and ${run.pruned.notebooks} notebooks.`,
      origin: 'machine'
    })
  }
  return run
}
