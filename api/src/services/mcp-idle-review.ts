import type { FastifyInstance } from 'fastify'
import { logActivity } from './activity.js'
import { linkTo } from './app-links.js'
import { IDLE_NOTICE_DAYS, type McpSettings, readMcpSettings } from './mcp-calls.js'
import { notifyUser } from './notification-channels.js'
import { listAllGrants, type OAuthGrant, revokeGrant, setGrantIdleStamps } from './oauth-store.js'

/**
 * Idle MCP connection review (#2497). Once a day (cron `mcp-idle-review`, deployed instances
 * only) every OAuth connection is judged by when it was last used:
 *   - unused for `idle_flag_days` (60)                → its owner is told, once;
 *   - unused for `idle_revoke_days` − 7 (83)          → its owner is told it will be disconnected;
 *   - unused for `idle_revoke_days` (90), told ≥ 7 days ago → disconnected, and the owner told.
 * A connection used again clears its stamps (resolveAccessToken does it on use; the review does
 * it for any it finds). A connection found already past the revoke age without a notice gets the
 * notice first — nobody is disconnected without seven days' warning. Notifications go through
 * notifyUser (the person's rules apply). API keys are not reviewed here (they have expiry).
 */

const DAY = 86_400_000
/** A daily job drifts by minutes; a notice 6 days 22 hours old counts as seven days. */
const NOTICE_SLACK_MS = 2 * 3600_000

export type IdleAction = 'none' | 'clear' | 'flag' | 'notice' | 'revoke'

export const lastUseOf = (g: Pick<OAuthGrant, 'last_used_at' | 'created_at'>): number =>
  Date.parse(g.last_used_at ?? g.created_at) || 0

export function idleDays(g: Pick<OAuthGrant, 'last_used_at' | 'created_at'>, now: number): number {
  return Math.max(0, Math.floor((now - lastUseOf(g)) / DAY))
}

/** What the review does to one connection today (pure). */
export function idleDecision(
  g: Pick<OAuthGrant, 'last_used_at' | 'created_at' | 'idle_flagged_at' | 'idle_notice_at'>,
  s: Pick<McpSettings, 'idle_flag_days' | 'idle_revoke_days'>,
  now: number
): IdleAction {
  const idle = (now - lastUseOf(g)) / DAY
  if (idle < s.idle_flag_days) return g.idle_flagged_at || g.idle_notice_at ? 'clear' : 'none'
  if (idle >= s.idle_revoke_days - IDLE_NOTICE_DAYS) {
    if (!g.idle_notice_at) return 'notice'
    const told = Date.parse(g.idle_notice_at) || now
    if (idle >= s.idle_revoke_days && now - told >= IDLE_NOTICE_DAYS * DAY - NOTICE_SLACK_MS)
      return 'revoke'
    return 'none'
  }
  return g.idle_flagged_at ? 'none' : 'flag'
}

/** The day a connection will be disconnected if it stays unused (ISO date). */
export function revokeOn(
  g: Pick<OAuthGrant, 'last_used_at' | 'created_at' | 'idle_notice_at'>,
  s: Pick<McpSettings, 'idle_revoke_days'>
): string {
  const byAge = lastUseOf(g) + s.idle_revoke_days * DAY
  const byNotice = g.idle_notice_at ? Date.parse(g.idle_notice_at) + IDLE_NOTICE_DAYS * DAY : 0
  return new Date(Math.max(byAge, byNotice)).toISOString().slice(0, 10)
}

const fmtDate = (iso: string | number) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

/** Notification copy per action (pure, exported for tests). */
export function idleMessage(
  action: 'flag' | 'notice' | 'revoke',
  g: OAuthGrant,
  s: Pick<McpSettings, 'idle_revoke_days'>,
  now: number
): { subject: string; message: string } {
  const name = g.client_name || 'A connected app'
  const days = idleDays(g, now)
  const since = fmtDate(lastUseOf(g))
  if (action === 'flag')
    return {
      subject: `${name} has not been used for ${days} days`,
      message: `${name} has not used Nivaro on your behalf since ${since}. If you no longer use it, disconnect it from your profile (What my agents did). Connections left unused for ${s.idle_revoke_days} days are disconnected.`
    }
  if (action === 'notice')
    return {
      subject: `${name} will be disconnected on ${fmtDate(revokeOn(g, s))}`,
      message: `${name} has not been used since ${since}. It will be disconnected on ${fmtDate(revokeOn(g, s))} unless it is used before then. You can connect it again at any time.`
    }
  return {
    subject: `${name} was disconnected`,
    message: `${name} was disconnected because it had not been used since ${since}. Connect it again from the app whenever you need it.`
  }
}

export interface IdleReviewResult {
  reviewed: number
  flagged: number
  noticed: number
  revoked: number
  cleared: number
}

async function tell(
  app: FastifyInstance,
  g: OAuthGrant,
  copy: { subject: string; message: string }
): Promise<void> {
  const url = `${await linkTo('profile', {}, { recipientUserId: g.user_id })}?tab=agents`
  await notifyUser(app, g.user_id, {
    ...copy,
    category: 'system',
    target: { kind: 'external', url, action: 'open' },
    source: { kind: 'mcp-idle-review', label: 'Idle connection review', id: g.id },
    why: 'You connected this app to Nivaro.'
  }).catch(() => undefined)
}

/** One pass over every connection. `dryRun` reports what would happen and changes nothing. */
export async function runIdleReview(
  app: FastifyInstance,
  opts: { now?: number; dryRun?: boolean } = {}
): Promise<IdleReviewResult> {
  const now = opts.now ?? Date.now()
  const settings = await readMcpSettings()
  const grants = await listAllGrants(app.redis)
  const out: IdleReviewResult = {
    reviewed: grants.length,
    flagged: 0,
    noticed: 0,
    revoked: 0,
    cleared: 0
  }
  const stamp = new Date(now).toISOString()
  for (const g of grants) {
    const action = idleDecision(g, settings, now)
    if (action === 'none') continue
    if (action === 'clear') {
      out.cleared++
      if (!opts.dryRun)
        await setGrantIdleStamps(app.redis, g.id, { idle_flagged_at: null, idle_notice_at: null })
      continue
    }
    if (action === 'flag') out.flagged++
    else if (action === 'notice') out.noticed++
    else out.revoked++
    if (opts.dryRun) continue
    try {
      if (action === 'revoke') {
        if (!(await revokeGrant(app.redis, g.user_id, g.id))) continue
        await logActivity({
          action: 'oauth-idle-revoke',
          user: g.user_id,
          comment: `${g.id} (${g.client_name}): unused ${idleDays(g, now)} days`
        })
      } else {
        await setGrantIdleStamps(
          app.redis,
          g.id,
          action === 'flag'
            ? { idle_flagged_at: stamp, idle_notice_at: g.idle_notice_at ?? null }
            : { idle_flagged_at: g.idle_flagged_at ?? stamp, idle_notice_at: stamp }
        )
      }
      await tell(app, g, idleMessage(action, g, settings, now))
    } catch (err) {
      app.log.warn({ err, grant: g.id }, '[mcp-idle-review] one connection failed')
    }
  }
  return out
}
