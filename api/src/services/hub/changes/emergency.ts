import type { FastifyRequest } from 'fastify'
import { logActivity } from '../../activity.js'
import { deliverHubNotice, hubEventRecipients } from '../notify-events.js'
import type { FrozenAction } from '../releases/freeze.js'

/**
 * "Start outside the window" — an administrator's emergency start of a promotion, Apply now (a
 * secret rotation included), a move or a shared upgrade while the deploy windows are closed.
 *
 *   - only a Hub administrator on their own browser session (never View-as, a run-as key, an API
 *     key, an OAuth / MCP token or the phone), with a typed reason (10–500 characters);
 *   - it skips the deploy WINDOWS only: freezes, the pre-deploy checklist, locks and every other
 *     check still apply;
 *   - when a window really was closed, the start writes an activity row
 *     (`hub-outside-window-start`, the reason in its comment) and tells the app's owners and the
 *     Hub's administrators (deliverHubNotice).
 * The routes read `outside_window_reason` from the start's body.
 */

export interface OutsideWindow {
  reason: string
}

export class OutsideWindowError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** A person on their own browser session (not View-as, a key, a token, MCP or the phone). */
export function ownSession(req: FastifyRequest): boolean {
  if (!req.user) return false
  if (req.authMethod !== 'session') return false
  if (req.masqueradeAdminId) return false
  if (req.mcpInner) return false
  const r = req as FastifyRequest & { apiKeyId?: unknown; apiKeySimulatedId?: unknown }
  if (r.apiKeyId != null || r.apiKeySimulatedId != null) return false
  const kind = (req.user as { account_kind?: string | null } | undefined)?.account_kind
  return !kind
}

/**
 * The emergency override a start asked for, or null (none asked). Throws OutsideWindowError for
 * a caller who may not, or a reason too short.
 */
export function outsideWindowOf(
  req: FastifyRequest,
  body: Record<string, unknown>
): OutsideWindow | null {
  const raw = body.outside_window_reason
  if (raw == null || raw === '') return null
  if (!req.isAdmin || !ownSession(req))
    throw new OutsideWindowError(
      'OUTSIDE_WINDOW_ADMIN_ONLY',
      403,
      'Only a Hub administrator on their own session may start outside the deploy window.'
    )
  const reason = typeof raw === 'string' ? raw.trim() : ''
  if (reason.length < 10 || reason.length > 500)
    throw new OutsideWindowError(
      'REASON_REQUIRED',
      400,
      'Say why this cannot wait for the window (10 to 500 characters).'
    )
  return { reason }
}

/** Whether the windows would have refused this start (judged before it, without the override). */
export async function windowWasClosed(o: {
  appIds: number[]
  action: FrozenAction
  envId?: number | null
}): Promise<boolean> {
  try {
    const { windowRefusal } = await import('../releases/windows.js')
    const r = await windowRefusal(o)
    return !!r && (r.code === 'OUTSIDE_WINDOW' || r.code === 'WINDOW_INVALID')
  } catch {
    return true
  }
}

const WHAT: Partial<Record<FrozenAction, string>> = {
  promote: 'A promotion',
  apply: 'Apply now',
  move: 'A move',
  upgrade: 'A shared deployment upgrade',
  config_promote: 'A config promotion',
  extension_promote: 'An extension promotion'
}

/** The activity row and the owners' notice of an emergency start. Never throws. */
export async function recordOutsideWindow(o: {
  req?: FastifyRequest
  userId: string
  action: FrozenAction
  appIds: number[]
  where: string
  reason: string
  collection: string
  item: string
}): Promise<void> {
  try {
    await logActivity({
      action: 'hub-outside-window-start',
      user: o.userId,
      collection: o.collection,
      item: o.item,
      comment:
        `${WHAT[o.action] ?? 'A start'} of ${o.where} outside the deploy window: ${o.reason}`.slice(
          0,
          1000
        ),
      ...(o.req ? { req: o.req } : {})
    })
  } catch {
    // The start itself already happened; the log is best effort here.
  }
  try {
    const people = new Set<string>()
    for (const appId of o.appIds) for (const id of await hubEventRecipients(appId)) people.add(id)
    await deliverHubNotice([...people], {
      subject: `Started outside the deploy window: ${o.where}`,
      message: `${WHAT[o.action] ?? 'A start'} of ${o.where} was started outside its deploy window by an administrator. Reason: ${o.reason}`,
      path: '/hub/changes',
      urgent: true,
      source: { kind: 'hub', label: 'outside-window', id: o.item },
      why: 'You are a Hub administrator or an owner of this app.'
    })
  } catch {
    // Never holds the start.
  }
}
