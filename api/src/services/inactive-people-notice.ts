import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { tenantState } from './ai-tenant-state.js'
import { offloadTotalsByUser } from './inactive-people-offload.js'
import { bustInactiveLinkCache } from './inactive-user-links.js'
import { notifyUser } from './notification-channels.js'

/**
 * ONE notice to the administrators when people are suspended or redacted, however it happened.
 *
 *   noteUsersDeactivated(ids, { reason, actor? })
 *
 * Every path that suspends or redacts accounts calls this with the people it just changed.
 * Calls coalesce per reason (per tenant) over a short window, so a directory sync that suspends
 * 40 people — or a bulk action, or a retention run — sends each administrator a single
 * notification: "40 accounts were suspended by directory sync — 12 still own open work", linking
 * to the Inactive people tool. The count of owned work comes from the same scan as the
 * "People to offload" widget. Category `system`, so administrators can mute it in
 * Profile → Notification rules (or a role default).
 *
 * Never throws and never blocks the caller: it only records ids and arms a timer.
 */

export type DeactivationReason =
  | 'directory_sync'
  | 'admin'
  | 'bulk'
  | 'offboarding'
  | 'merge'
  | 'retention'
  | 'other'

export interface DeactivationOptions {
  reason: DeactivationReason
  /** The person who did it (admin edit, bulk action, offboarding). They are not told about their own action. */
  actor?: string | null
  /** The Fastify app, when the caller has one (cloud processes have no boot-time app). */
  app?: FastifyInstance
  /** 'redacted' wording for retention / redaction paths; default 'suspended'. */
  verb?: 'suspended' | 'redacted'
}

/** How long a batch keeps collecting before it is sent. */
export const COALESCE_MS = 8_000

const REASON_TEXT: Record<DeactivationReason, string> = {
  directory_sync: 'directory sync',
  admin: 'an administrator',
  bulk: 'a bulk action',
  offboarding: 'offboarding',
  merge: 'an account merge',
  retention: 'a retention policy',
  other: 'the system'
}

interface Batch {
  ids: Set<string>
  actors: Set<string>
  verb: 'suspended' | 'redacted'
  app?: FastifyInstance
  timer: ReturnType<typeof setTimeout> | null
}

const batches = tenantState(() => new Map<string, Batch>())
let defaultApp: FastifyInstance | null = null

/** Boot wiring: the app notifications go out through. */
export function setInactivePeopleNoticeApp(app: FastifyInstance) {
  defaultApp = app
}

/** Pure: the notification text for one flushed batch. */
export function buildDeactivationNotice(input: {
  count: number
  reason: DeactivationReason
  verb: 'suspended' | 'redacted'
  /** The people from the batch who still hold work, most first. */
  withWork: Array<{ id: string; total: number }>
  names: Map<string, string>
}): { subject: string; message: string } {
  const { count, reason, verb, withWork } = input
  const subject = `${count} ${count === 1 ? 'account was' : 'accounts were'} ${verb} by ${REASON_TEXT[reason]}`
  const who = withWork
    .slice(0, 5)
    .map((p) => `${input.names.get(p.id.toUpperCase()) ?? 'Someone'} (${p.total})`)
    .join(', ')
  const more = withWork.length > 5 ? ` and ${withWork.length - 5} more` : ''
  const message =
    withWork.length === 0
      ? `${count === 1 ? 'They hold' : 'None of them hold'} no open work that needs handing on.`
      : `${withWork.length} still ${withWork.length === 1 ? 'owns' : 'own'} open work that needs handing on: ${who}${more}. Hand it on from the Inactive people tool.`
  return {
    subject: `${subject}${withWork.length ? ` — ${withWork.length} still own open work` : ''}`,
    message
  }
}

/** Record people who just became unable to act. Synchronous, never throws. */
export function noteUsersDeactivated(
  ids: Array<string | number | null | undefined>,
  opts: DeactivationOptions
): void {
  try {
    const clean = ids.map((i) => String(i ?? '').trim()).filter(Boolean)
    if (clean.length === 0) return
    const map = batches()
    let b = map.get(opts.reason)
    if (!b) {
      b = { ids: new Set(), actors: new Set(), verb: 'suspended', timer: null }
      map.set(opts.reason, b)
    }
    for (const id of clean) b.ids.add(id.toUpperCase())
    if (opts.actor) b.actors.add(String(opts.actor).toUpperCase())
    if (opts.verb === 'redacted') b.verb = 'redacted'
    if (opts.app) b.app = opts.app
    if (b.timer) clearTimeout(b.timer)
    // A timer created inside a tenant context keeps it (AsyncLocalStorage follows timers).
    const key = opts.reason
    b.timer = setTimeout(() => {
      void flushDeactivationBatch(key).catch(() => {})
    }, COALESCE_MS)
    b.timer.unref?.()
  } catch {
    // a notice must never break the write that caused it
  }
}

/** Active administrators (admin role, not redacted) minus `exclude` (upper-case ids). */
async function adminRecipients(exclude: Set<string>): Promise<string[]> {
  const rows = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where((w) => w.where('u.status', 'active').orWhereNull('u.status'))
    .where((w) => w.where('u.is_redacted', false).orWhereNull('u.is_redacted'))
    .limit(500)
    .select('u.id')) as Array<{ id: string }>
  return rows.map((r) => String(r.id)).filter((id) => !exclude.has(id.toUpperCase()))
}

/** Send one batch now (tests and shutdown call this; the timer does in normal running). */
export async function flushDeactivationBatch(reason: DeactivationReason): Promise<number> {
  const map = batches()
  const b = map.get(reason)
  if (!b) return 0
  map.delete(reason)
  if (b.timer) clearTimeout(b.timer)
  const app = b.app ?? defaultApp
  if (!app) return 0

  const ids = [...b.ids]
  // People who changed the status themselves are not told about it; a sync/retention has no actor.
  const recipients = await adminRecipients(b.actors)
  if (recipients.length === 0) return 0

  let withWork: Array<{ id: string; total: number }> = []
  const names = new Map<string, string>()
  try {
    // The statuses just changed: a cached scan would not have them yet.
    bustInactiveLinkCache()
    const totals = await offloadTotalsByUser({ fresh: true })
    withWork = ids
      .map((id) => ({ id, total: totals.get(id.toUpperCase()) ?? 0 }))
      .filter((p) => p.total > 0)
      .sort((a, b) => b.total - a.total)
    if (withWork.length) {
      const rows = (await db('nivaro_users')
        .whereIn(
          'id',
          withWork.slice(0, 5).map((p) => p.id)
        )
        .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
      for (const r of rows) {
        const n = [r.first_name, r.last_name].filter(Boolean).join(' ') || String(r.email ?? '')
        names.set(String(r.id).toUpperCase(), n || 'Someone')
      }
    }
  } catch {
    // The scan is the slow, optional part: the notice still goes, without the work count.
  }

  const { subject, message } = buildDeactivationNotice({
    count: ids.length,
    reason,
    verb: b.verb,
    withWork,
    names
  })
  for (const adminId of recipients) {
    await notifyUser(app, adminId, {
      subject,
      message,
      category: 'system',
      target: { kind: 'external', url: '/data-integrity?tab=people' },
      source: { kind: 'inactive-people', label: 'People to offload' }
    }).catch(() => {})
  }
  return recipients.length
}

/** Send everything waiting (graceful shutdown, tests). */
export async function flushAllDeactivationBatches(): Promise<void> {
  for (const reason of [...batches().keys()])
    await flushDeactivationBatch(reason as DeactivationReason)
}
