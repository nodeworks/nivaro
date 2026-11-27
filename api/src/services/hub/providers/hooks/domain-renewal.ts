import { deliverHubNotice, hubEventRecipients } from '../../notify-events.js'
import { hubNotify } from '../notify-hook.js'
import { renewDaysOf } from '../renewal-window.js'
import { type HubResourceRow, listChanges } from '../store.js'
import { hubActorForUser, runCarriedChange } from './carried.js'

/**
 * Gap G-E: Hub auto-renew of a registrar domain. Namecheap's API has no command to change the
 * registrar's own auto-renew, so the Hub can renew by itself instead. The domain watch (Task 34
 * tick) asks this for every domain it just read: when the domain has `hub_auto_renew` on and ends
 * within `renew_days_before` (7–60, default 30), a `renew` is planned through the change engine
 * with origin `renewal` (one update carrying exactly `{renew: true}`; the engine refuses anything
 * else under that origin).
 *
 *  - It acts for the person who made the resource, never as an administrator: a renewal is a cost,
 *    so it waits for a Hub administrator's approval unless the Hub's auto-approve limit covers it
 *    (increases only, Task 44a). Admins hear once (`domain.expiring`) that it waits.
 *  - One renewal per expiry date: a change for this expiry that is open, applied or declined stops
 *    another; a failed or cancelled one is retried after RENEW_RETRY_HOURS. Once renewed the expiry
 *    moves out of the window.
 *  - The state comes from THIS tick's fresh read (the registrar's own answer), never a stored one.
 */

export const RENEW_RETRY_HOURS = 6
const DAY = 86_400_000
const NEVER_AGAIN = [
  'planned',
  'pending_approval',
  'applying',
  'interrupted',
  'applied',
  'declined'
]

export type DomainRenewal =
  | 'off'
  | 'not_due'
  | 'skipped'
  | 'started'
  | 'waiting'
  | 'failed'
  | 'no_actor'

export interface DomainRenewalDeps {
  now?: () => number
  run?: typeof runCarriedChange
  actorFor?: typeof hubActorForUser
  changes?: typeof listChanges
  notify?: typeof hubNotify
  notice?: typeof deliverHubNotice
  recipients?: (appId: number) => Promise<string[]>
}

/** Pure: is a Hub renewal due for this domain now? */
export function hubRenewalDue(
  row: Pick<HubResourceRow, 'desired' | 'external_id' | 'deleted_at'>,
  expiresAt: Date | null,
  now: number
): boolean {
  if (row.desired?.hub_auto_renew !== true || !row.external_id || row.deleted_at) return false
  if (!expiresAt) return false
  return expiresAt.getTime() - now <= renewDaysOf(row.desired) * DAY
}

/** Did an earlier change already carry the renewal of THIS expiry? (null = no). */
export function renewalHeld(
  changes: ReadonlyArray<{
    status: string
    created_at?: string | Date | null
    plan?: {
      origin?: { kind?: string } | null
      resourceIds?: Array<number | null>
      ops?: Array<{ preconditions?: Record<string, unknown> }>
    } | null
  }>,
  resourceId: number,
  expiresAt: Date,
  now: number
): boolean {
  for (const c of changes) {
    if (c.plan?.origin?.kind !== 'renewal' || !(c.plan.resourceIds ?? []).includes(resourceId))
      continue
    const forThis = (c.plan.ops ?? []).some((o) => {
      const t = Date.parse(String(o.preconditions?.expires_at ?? ''))
      return Number.isFinite(t) && t === expiresAt.getTime()
    })
    if (!forThis) continue
    if (NEVER_AGAIN.includes(c.status)) return true
    const at = c.created_at ? Date.parse(String(c.created_at)) : 0
    if (now - at < RENEW_RETRY_HOURS * 3_600_000) return true
  }
  return false
}

export async function domainRenewalFor(
  row: HubResourceRow,
  name: string,
  expiresAt: Date | null,
  deps: DomainRenewalDeps = {}
): Promise<DomainRenewal> {
  const now = (deps.now ?? Date.now)()
  if (row.desired?.hub_auto_renew !== true) return 'off'
  if (!hubRenewalDue(row, expiresAt, now) || !expiresAt) return 'not_due'
  const recent = await (deps.changes ?? listChanges)({ limit: 200 })
  const mine = recent.filter((c) => (c.plan?.resourceIds ?? []).includes(row.id))
  if (renewalHeld(mine, row.id, expiresAt, now)) return 'skipped'
  const days = Math.max(0, Math.floor((expiresAt.getTime() - now) / DAY))
  const tell = async (why: string, dedup: string, urgent: boolean) => {
    try {
      const people = await (deps.recipients ?? hubEventRecipients)(row.app_id ?? -1)
      await (deps.notice ?? deliverHubNotice)(people, {
        subject: `Domain renewal needs you: ${name}`,
        message: `${name} ends in ${days} day(s). The Hub could not renew it by itself: ${why}`,
        path: '/hub/security',
        urgent,
        source: { kind: 'hub_domain', label: 'Domain renewal', id: row.id },
        why: 'You are a Hub administrator; the Hub renews this domain for you.'
      })
    } catch {
      // never stops the watch
    }
    ;(deps.notify ?? hubNotify)('domain.expiring', {
      appId: row.app_id,
      detail: `${name} ends in ${days} day(s): ${why}`,
      link: '/hub/security',
      severity: 'warning',
      dedupKey: dedup
    })
  }
  const actorOf = await (deps.actorFor ?? hubActorForUser)(row.created_by)
  if (!actorOf) {
    await tell(
      'the person who added it can no longer act for it. Renew it from its resource page.',
      `domain-renew:${row.id}:${expiresAt.getTime()}:no-actor`,
      false
    )
    return 'no_actor'
  }
  // Never an administrator: a renewal is a cost the approval rule judges.
  const actor = { ...actorOf, isAdmin: false }
  try {
    const out = await (deps.run ?? runCarriedChange)({
      req: {
        connectionId: row.connection_id,
        scope: 'shared',
        ops: [{ action: 'update', resourceId: row.id, fields: { renew: true } }]
      },
      actor,
      origin: { kind: 'renewal', resourceId: row.id },
      deadlineMs: 60_000
    })
    if (out.status === 'applied' || out.status === 'interrupted') return 'started'
    if (out.status === 'pending_approval') {
      await tell(
        `change #${out.changeId} waits for a Hub administrator's approval (it costs money).`,
        `domain-renew:${row.id}:${expiresAt.getTime()}:${out.changeId}`,
        days <= 14
      )
      return 'waiting'
    }
    await tell(
      out.status === 'blocked'
        ? `${out.message}${out.changeId ? ` (change #${out.changeId})` : ''}`
        : `change #${out.changeId} ${out.status}: ${out.message}`,
      `domain-renew:${row.id}:${expiresAt.getTime()}:${out.changeId || out.status}`,
      days <= 14
    )
    return out.status === 'blocked' ? 'waiting' : 'failed'
  } catch {
    return 'failed'
  }
}
