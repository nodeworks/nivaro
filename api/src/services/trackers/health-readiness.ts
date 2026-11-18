import { db } from '../../db/index.js'
import { type ReadinessResult, registerReadinessCheck } from '../readiness.js'
import { trackersEnabled } from './feature.js'

/**
 * Readiness `tracker-health` (Integrations): is GitLab sync keeping up?
 *   - warn on outbox rows that ran out of retries (`dead`, waiting for an admin to retry/discard),
 *   - warn on a connection marked broken (bad token, host unreachable), with GitLab's error,
 *   - warn when GitLab issues are linked but no webhook has arrived in 24 hours (the reconcile
 *     sweep still catches up, but a dead hook means every change lags by up to 10 minutes).
 * Passes when the feature is off or there is no active connection. Skips (never throws) while
 * migration 532 has not been applied. Warn level only.
 */

const WEBHOOK_SILENCE_MS = 24 * 3_600_000

export interface TrackerHealthConnection {
  id: number
  name: string
  status: string | null
  last_error: string | null
  last_webhook_at: Date | string | null
  /** Dead outbox rows of this connection. */
  dead: number
  /** Links of this connection at least 24 hours old (a fresh link cannot have had a webhook yet). */
  links: number
}

export interface TrackerHealthInput {
  /** Active connections only. */
  connections: TrackerHealthConnection[]
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** The verdict from what was read (pure; exported for tests). */
export function judgeTrackerHealth(input: TrackerHealthInput, now = Date.now()): ReadinessResult {
  if (!input.connections.length)
    return { status: 'pass', detail: 'No active GitLab connection — nothing to check.' }
  const blockers: string[] = []
  let links = 0
  for (const c of input.connections) {
    links += c.links
    if (c.status === 'broken')
      blockers.push(
        `${c.name}: connection is broken${c.last_error ? ` — ${c.last_error.slice(0, 200)}` : ''}`
      )
    if (c.dead > 0)
      blockers.push(
        `${c.name}: ${plural(c.dead, 'GitLab send')} gave up after retries — retry or discard them in Connections → Issue trackers`
      )
    if (c.links > 0) {
      const at = c.last_webhook_at ? new Date(c.last_webhook_at).getTime() : Number.NaN
      if (!Number.isFinite(at))
        blockers.push(
          `${c.name}: no webhook has ever arrived, so GitLab changes only sync on the sweep`
        )
      else if (now - at > WEBHOOK_SILENCE_MS)
        blockers.push(`${c.name}: no webhook from GitLab in the last 24 hours`)
    }
  }
  if (!blockers.length)
    return {
      status: 'pass',
      detail: `${plural(input.connections.length, 'connection')} healthy, ${plural(links, 'link')}, nothing stuck.`
    }
  return {
    status: 'warn',
    detail: 'GitLab sync needs attention; open Connections → Issue trackers.',
    blockers
  }
}

type CountRow = { connection: number | string; n: number | string }
const countMap = (rows: CountRow[]) => new Map(rows.map((r) => [Number(r.connection), Number(r.n)]))

export async function trackerHealthReadiness(now = Date.now()): Promise<ReadinessResult> {
  try {
    if (!(await trackersEnabled()))
      return { status: 'pass', detail: 'GitLab sync is off — nothing to check.' }
    for (const t of ['nivaro_tracker_connections', 'nivaro_tracker_outbox', 'nivaro_tracker_links'])
      if (!(await db.schema.hasTable(t)))
        return {
          status: 'skip',
          detail: 'The tracker tables do not exist yet (migration 532 has not run).'
        }
    const rows = (await db('nivaro_tracker_connections')
      .where({ is_active: true })
      .select('id', 'name', 'status', 'last_error', 'last_webhook_at')) as Array<
      Omit<TrackerHealthConnection, 'dead' | 'links'>
    >
    if (!rows.length) return judgeTrackerHealth({ connections: [] }, now)
    const ids = rows.map((r) => Number(r.id))
    const dead = countMap(
      (await db('nivaro_tracker_outbox')
        .where({ status: 'dead' })
        .whereIn('connection', ids)
        .groupBy('connection')
        .select('connection')
        .count({ n: '*' })) as CountRow[]
    )
    const links = countMap(
      (await db('nivaro_tracker_links')
        .whereIn('connection', ids)
        .where('created_at', '<', new Date(now - WEBHOOK_SILENCE_MS))
        .groupBy('connection')
        .select('connection')
        .count({ n: '*' })) as CountRow[]
    )
    return judgeTrackerHealth(
      {
        connections: rows.map((r) => ({
          ...r,
          dead: dead.get(Number(r.id)) ?? 0,
          links: links.get(Number(r.id)) ?? 0
        }))
      },
      now
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'warn', detail: `GitLab sync health could not be read: ${msg.slice(0, 200)}` }
  }
}

export function registerTrackerHealthReadiness(): void {
  registerReadinessCheck({
    id: 'tracker-health',
    label: 'GitLab sync is keeping up',
    group: 'Integrations',
    description:
      'Warns on GitLab sends that ran out of retries (dead outbox rows), a connection marked broken, or linked issues with no webhook from GitLab in 24 hours. Passes while GitLab sync is off or nothing is connected; skips until the tracker tables exist. Never fails.',
    cost: 'light',
    run: () => trackerHealthReadiness()
  })
}
