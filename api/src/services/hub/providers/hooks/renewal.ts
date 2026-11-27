import { RENEWABLE_TYPES } from '../engine/gates.js'
import { hubNotify } from '../notify-hook.js'
import { type HubResourceRow, listChanges, listResources } from '../store.js'
import { hubActorForUser, runCarriedChange } from './carried.js'

/**
 * Task 43: automatic renewal of certificates the Hub ordered (`acme.certificate`). The observe job
 * (`hub-resources-observe`, Hub only, cronTicksEnabled()) asks this once an hour: a certificate
 * whose stored observation says it ends within RENEW_WINDOW_DAYS gets a re-apply planned through
 * the change engine with origin `renewal` — the adapter's own plan answers its `renew` op in that
 * window (acme/plan.ts), and the engine refuses anything else under that origin (assertRenewalOps).
 *
 *  - It acts for the person who made the certificate (`created_by`, still active), judged as
 *    usual: an owner in production needs the owners-deploy-production switch, a connection with no
 *    `allowed_domains` makes every order an administrator's.
 *  - It starts the change only when nothing waits on a person (no typed confirm, no approval, no
 *    blocker). Otherwise the change stays planned and the app's owners and Hub admins hear once
 *    (`cert.expiring`) that it needs starting by hand: once per planned change, or once a day
 *    when the refusal left no change behind.
 *  - One renewal per certificate at a time; after one was planned it waits RENEW_RETRY_HOURS
 *    before planning another (the CA's own rate limits, Let's Encrypt's one order an hour).
 *  - It never re-applies anything else and never touches a resource a change is applying.
 */

export const RENEW_WINDOW_DAYS = 30
export const RENEW_RETRY_HOURS = 6
const MAX_PER_TICK = 20
const DAILY_HOUR_UTC = 13

const OPEN = ['planned', 'pending_approval', 'applying'] as const

/** When the certificate ends, from its stored observation (null = unknown). */
export function certificateEnds(row: Pick<HubResourceRow, 'observed'>): number | null {
  const v = row.observed?.fields?.not_after
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN
  return Number.isFinite(t) ? t : null
}

/** A live, renewable app resource whose certificate ends within the window. Pure. */
export function renewalDue(row: HubResourceRow, now: number): boolean {
  if (!RENEWABLE_TYPES.includes(row.type) || row.deleted_at || !row.external_id) return false
  if (row.scope !== 'app' || row.app_id == null) return false
  const ends = certificateEnds(row)
  return ends != null && ends - now <= RENEW_WINDOW_DAYS * 86_400_000
}

export interface RenewalSummary {
  due: number
  started: number
  waiting: number
  skipped: number
  failed: number
}

export interface RenewalDeps {
  now?: () => number
  run?: typeof runCarriedChange
  actorFor?: typeof hubActorForUser
  notify?: typeof hubNotify
}

export async function renewalTick(deps: RenewalDeps = {}): Promise<RenewalSummary> {
  const now = (deps.now ?? Date.now)()
  const run = deps.run ?? runCarriedChange
  const actorFor = deps.actorFor ?? hubActorForUser
  const notify = deps.notify ?? hubNotify
  const sum: RenewalSummary = { due: 0, started: 0, waiting: 0, skipped: 0, failed: 0 }
  const rows: HubResourceRow[] = []
  for (const type of RENEWABLE_TYPES) rows.push(...(await listResources({ type })))
  const due = rows.filter((r) => renewalDue(r, now)).slice(0, MAX_PER_TICK)
  sum.due = due.length
  if (!due.length) return sum
  // Recent changes: an open one on the resource, or a renewal planned within the retry window.
  const recent = await listChanges({ limit: 200 })
  for (const row of due) {
    const mine = recent.filter((c) => (c.plan?.resourceIds ?? []).includes(row.id))
    const open = mine.some((c) => (OPEN as readonly string[]).includes(c.status))
    const lately = mine.some(
      (c) =>
        c.plan?.origin?.kind === 'renewal' &&
        c.created_at != null &&
        now - Date.parse(c.created_at) < RENEW_RETRY_HOURS * 3_600_000
    )
    if (open || lately) {
      sum.skipped += 1
      continue
    }
    const name = row.name ?? row.observed?.name ?? `certificate #${row.id}`
    const ends = certificateEnds(row) ?? now
    const days = Math.max(0, Math.floor((ends - now) / 86_400_000))
    // A planned change is told once (the next ticks find it open); a refusal that left no change
    // behind is told once a day, at 13:00 UTC.
    const tell = (why: string, dedup: string, daily = false) => {
      if (daily && new Date(now).getUTCHours() !== DAILY_HOUR_UTC) return
      notify('cert.expiring', {
        appId: row.app_id,
        envId: row.environment_id,
        detail: `${name} ends in ${days} day(s) and was not renewed automatically: ${why}`,
        link: row.app_id ? `/hub?app=${row.app_id}` : '/hub/connections',
        dedupKey: dedup
      })
    }
    const actor = await actorFor(row.created_by)
    if (!actor) {
      sum.waiting += 1
      tell(
        'the person who made it can no longer act for it. Renew it from its resource page.',
        `renewal:${row.id}:no-actor`,
        true
      )
      continue
    }
    try {
      const out = await run({
        req: {
          connectionId: row.connection_id,
          scope: 'app',
          appId: Number(row.app_id),
          ...(row.environment_id != null ? { environmentId: row.environment_id } : {}),
          ops: [{ action: 'reapply', resourceId: row.id }]
        },
        actor,
        origin: { kind: 'renewal', resourceId: row.id },
        // A renewal waits only briefly in the tick; the run goes on in the background.
        deadlineMs: 60_000
      })
      if (out.status === 'applied' || out.status === 'interrupted') {
        sum.started += 1
        continue
      }
      if (out.status === 'pending_approval' || out.status === 'blocked') {
        sum.waiting += 1
        tell(
          out.status === 'pending_approval'
            ? `change #${out.changeId} waits for a Hub administrator's approval.`
            : `${out.message}${out.changeId ? ` (change #${out.changeId})` : ''}`,
          `renewal:${row.id}:${out.changeId || out.status}`,
          !out.changeId
        )
        continue
      }
      sum.failed += 1
      tell(
        `change #${out.changeId} ${out.status}: ${out.message}`,
        `renewal:${row.id}:${out.changeId}`
      )
    } catch {
      sum.failed += 1
    }
  }
  return sum
}
