import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { cronTicksEnabled } from './cron-ticks.js'
import { instanceKey } from './instance-key.js'
import { listInstances } from './instance-roster.js'
import { type ReadinessResult, registerReadinessCheck } from './readiness.js'

/**
 * Deploy-shape readiness checks (DevOps batch, #1049 / #1050): is every process of this
 * deployment on one version, and is only this deployment ticking on the shared database.
 */

const DEFAULT_MIXED_MINUTES = 15

function mixedMinutesLimit(): number {
  const n = Number(process.env.MIXED_VERSION_MINUTES)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIXED_MINUTES
}

interface RosterEntry {
  id?: unknown
  host?: unknown
  version?: unknown
  instance?: unknown
  role?: unknown
  started_at?: unknown
}

function roleCounts(entries: RosterEntry[]): string {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const role = typeof e.role === 'string' && e.role ? e.role : 'unlabelled'
    counts.set(role, (counts.get(role) ?? 0) + 1)
  }
  return [...counts].map(([r, n]) => `${n} ${r}`).join(', ')
}

/**
 * #1049 — exported for tests. The mix began when the newest version's first process started
 * (or, symmetrically, when the second version appeared): the latest of each version's earliest
 * start. A rolling deploy that finished drops the old version from the roster within 90s.
 */
export function judgeMixedVersions(
  entries: RosterEntry[],
  now = Date.now(),
  limitMinutes = mixedMinutesLimit()
): ReadinessResult {
  if (entries.length === 0)
    return {
      status: 'skip',
      detail: 'No instance roster (Redis unavailable, or no process has registered yet).'
    }
  const byVersion = new Map<string, RosterEntry[]>()
  for (const e of entries) {
    const v = typeof e.version === 'string' ? e.version : 'unknown'
    const list = byVersion.get(v) ?? []
    list.push(e)
    byVersion.set(v, list)
  }
  if (byVersion.size === 1) {
    const [[version, list]] = [...byVersion]
    return {
      status: 'pass',
      detail: `${list.length} process${list.length === 1 ? '' : 'es'} on ${version} (${roleCounts(list)}).`
    }
  }
  let mixStart = 0
  for (const list of byVersion.values()) {
    const earliest = Math.min(
      ...list.map((e) => {
        const t = Date.parse(String(e.started_at ?? ''))
        return Number.isFinite(t) ? t : now
      })
    )
    mixStart = Math.max(mixStart, earliest)
  }
  const minutes = Math.max(0, Math.round((now - mixStart) / 60_000))
  const lines = [...byVersion].map(
    ([version, list]) =>
      `${version}: ${list.length} process${list.length === 1 ? '' : 'es'} (${roleCounts(list)}) on ${[
        ...new Set(list.map((e) => String(e.host ?? '?')))
      ].join(', ')}`
  )
  if (minutes <= limitMinutes)
    return {
      status: 'pass',
      detail: `Two versions have served together for ${minutes} min — a rolling deploy in progress (warns after ${limitMinutes} min).`,
      blockers: lines
    }
  return {
    status: 'warn',
    detail: `${byVersion.size} API versions have served together for ${minutes} min — a rolling deploy stalled, or a replica was left behind.`,
    blockers: lines
  }
}

/** #1050 — exported for tests. */
export function judgeOtherInstanceRuns(
  rows: Array<{
    instance: string | null
    runs: number
    last: Date | string
    sample: string | null
  }>,
  self: string,
  ticks: boolean
): ReadinessResult {
  const others = rows.filter((r) => (r.instance ?? '') !== self)
  const describe = (r: (typeof rows)[number]) =>
    `${r.instance ?? '(unnamed)'} ran ${r.runs} scheduled job${r.runs === 1 ? '' : 's'} (last ${new Date(r.last).toISOString().slice(0, 16).replace('T', ' ')} UTC${r.sample ? `, e.g. ${r.sample}` : ''}) — set CRON_TICKS=off on it`
  if (ticks) {
    if (others.length === 0)
      return {
        status: 'pass',
        detail: rows.length
          ? `Only ${self} ran scheduled jobs on this database in the last 24 hours.`
          : 'No scheduled job ran on this database in the last 24 hours.'
      }
    return {
      status: 'warn',
      detail: `Another instance ran scheduled jobs on this database in the last 24 hours — its digests, polls and imports ran twice.`,
      blockers: others.map(describe)
    }
  }
  const names = new Set(rows.map((r) => r.instance ?? ''))
  if (names.size <= 1)
    return {
      status: 'pass',
      detail: rows.length
        ? `This process does not tick; only ${rows[0]?.instance ?? '(unnamed)'} ran scheduled jobs in the last 24 hours.`
        : 'No scheduled job ran on this database in the last 24 hours.'
    }
  return {
    status: 'warn',
    detail: `${names.size} instances ran scheduled jobs on this database in the last 24 hours — only the deployed one should.`,
    blockers: rows.map(describe)
  }
}

let registered = false

export function registerDeployReadinessChecks(): void {
  if (registered) return
  registered = true
  registerReadinessCheck({
    id: 'mixed-api-versions',
    label: 'Every API process runs one version',
    group: 'Deploy',
    description:
      'Reads the instance roster. Two versions side by side for longer than MIXED_VERSION_MINUTES (default 15) means a rolling deploy stalled or a replica was left behind. Roster entries carry NIVARO_ROLE, so the counts read "2 web, 1 worker".',
    run: async () => {
      const self = instanceKey()
      const all = (await listInstances()) as RosterEntry[]
      // Several deployments can share one Redis (dev:db); compare like with like.
      const mine = all.filter((e) => !e.instance || e.instance === self)
      return judgeMixedVersions(mine)
    }
  })
  registerReadinessCheck({
    id: 'other-instance-scheduled-runs',
    label: 'Only this deployment runs scheduled jobs on its database',
    group: 'Deploy',
    description:
      'The dev laptop and staging share a database. A process booted with CRON_TICKS=on elsewhere runs every digest, poll and import a second time. Reads the scheduled job runs of the last 24 hours by instance.',
    run: async () => {
      if (!(await hasColumn('nivaro_job_runs', 'trigger_kind').catch(() => false)))
        return {
          status: 'skip',
          detail: 'Job runs do not record their instance yet (migration 388).'
        }
      const since = new Date(Date.now() - 24 * 3_600_000)
      const rows = (await db('nivaro_job_runs')
        .where('trigger_kind', 'schedule')
        .where('started_at', '>=', since)
        .groupBy('instance')
        .select('instance')
        .count({ runs: '*' })
        .max({ last: 'started_at' })
        .min({ sample: 'job_id' })) as Array<{
        instance: string | null
        runs: number | string
        last: Date | string
        sample: string | null
      }>
      return judgeOtherInstanceRuns(
        rows.map((r) => ({ ...r, runs: Number(r.runs) })),
        instanceKey(),
        cronTicksEnabled()
      )
    }
  })
}
