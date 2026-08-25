import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { sendMail } from './mail.js'
import { sendWebPush } from './web-push.js'

/**
 * Multi-channel user notification service.
 *
 * Channels:
 *  - inapp  : nivaro_notifications row + Socket.io `notification:new` to `user:<id>` room
 *  - email  : sendMail() using the `notification` Liquid template
 *  - sms    : Twilio REST API (fetch, no SDK) — requires user.phone + Twilio config
 *  - push   : Socket.io `push` event to the user room (in-app push)
 *
 * Twilio config resolution: nivaro_settings columns (twilio_account_sid,
 * twilio_auth_token, twilio_from) when present, else env vars
 * TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM. No-op + warn when unset.
 */

interface TwilioConfig {
  accountSid: string
  authToken: string
  from: string
}

async function getTwilioConfig(): Promise<TwilioConfig | null> {
  let settings: Record<string, unknown> | null = null
  try {
    settings = (await db('nivaro_settings').where({ id: 1 }).first()) ?? null
  } catch {
    settings = null
  }

  const accountSid =
    (settings?.twilio_account_sid as string | undefined) || process.env.TWILIO_ACCOUNT_SID || ''
  const authToken =
    (settings?.twilio_auth_token as string | undefined) || process.env.TWILIO_AUTH_TOKEN || ''
  const from = (settings?.twilio_from as string | undefined) || process.env.TWILIO_FROM || ''

  if (!accountSid || !authToken || !from) return null
  return { accountSid, authToken, from }
}

/** Send an SMS via the Twilio REST API. No-op (with warning) when unconfigured. */
export async function sendSms(to: string, body: string): Promise<boolean> {
  const cfg = await getTwilioConfig()
  if (!cfg) {
    console.warn('[notification-channels] Twilio not configured, skipping SMS to', to)
    return false
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`
    const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')
    const params = new URLSearchParams({ To: to, From: cfg.from, Body: body })

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000)
    })

    if (!res.ok) {
      console.warn('[notification-channels] Twilio SMS failed with status', res.status)
      return false
    }
    return true
  } catch (err) {
    console.warn('[notification-channels] Twilio SMS error:', err)
    return false
  }
}

/** In-app push: emits a `push` event to the user's personal Socket.io room. */
export function sendPush(
  app: FastifyInstance,
  userId: string,
  payload: Record<string, unknown>
): void {
  if (!app.io) return
  app.io.to(`user:${userId}`).emit('push', payload)
}

export interface NotifyUserOptions {
  subject: string
  message: string
  collection?: string | null
  item?: string | null
  sender?: string | null
  /** Defaults: inapp true, email false, sms false. */
  channels?: { inapp?: boolean; email?: boolean; sms?: boolean }
  /** Internal: set on outbox re-deliveries to prevent re-enqueue loops. */
  _retry?: boolean
}

/**
 * Notify a single user across the requested channels.
 * In-app (default on) inserts a nivaro_notifications row and emits to the
 * user's Socket.io room; email and SMS are opt-in via `channels`.
 */
// ── Per-user notification preferences (quiet hours + channel matrix) ────────
// prefs.notification_prefs: {quiet_start: 'HH:MM', quiet_end: 'HH:MM',
// matrix: {category: {inapp: bool, push: bool}}}. Categories are classified
// from the subject so every existing caller participates without changes.
// Quiet hours suppress PUSH only (the inbox row still lands — it IS the
// inbox); truly critical subjects bypass. All America/New_York — EFP's clock.

export type NotifyCategory = 'mentions' | 'workflow' | 'sla' | 'watch' | 'system' | 'other'

export function classifyNotification(subject: string): NotifyCategory {
  const s = subject.toLowerCase()
  if (s.includes('mention')) return 'mentions'
  if (s.startsWith('sla') || s.includes('escalation') || s.includes('breach')) return 'sla'
  if (s.includes('watch') || s.includes('field') && s.includes('changed')) return 'watch'
  if (s.includes('workflow') || s.includes('transition') || s.includes('moved to') || s.includes('approval')) return 'workflow'
  if (s.includes('maintenance') || s.includes('monitor') || s.includes('import') || s.includes('digest')) return 'system'
  return 'other'
}

const CRITICAL_SUBJECTS = /sla escalation|maintenance|monitor failing/i

interface NotifyPrefs {
  quiet_start?: string
  quiet_end?: string
  matrix?: Partial<Record<NotifyCategory, { inapp?: boolean; push?: boolean }>>
}

const prefsCache = new Map<string, { at: number; prefs: NotifyPrefs | null }>()

async function getNotifyPrefs(userId: string): Promise<NotifyPrefs | null> {
  const key = userId.toUpperCase()
  const hit = prefsCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.prefs
  let prefs: NotifyPrefs | null = null
  try {
    const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
      | { preferences?: string | Record<string, unknown> | null }
      | undefined
    const parsed =
      typeof row?.preferences === 'string' ? JSON.parse(row.preferences) : (row?.preferences ?? null)
    prefs = (parsed?.notification_prefs as NotifyPrefs) ?? null
  } catch {
    prefs = null
  }
  prefsCache.set(key, { at: Date.now(), prefs })
  return prefs
}

export function bustNotifyPrefsCache(userId?: string): void {
  if (userId) prefsCache.delete(userId.toUpperCase())
  else prefsCache.clear()
}

/** Is the wall clock inside the user's quiet window right now (ET)? */
export function inQuietHours(prefs: NotifyPrefs | null, now = new Date()): boolean {
  if (!prefs?.quiet_start || !prefs?.quiet_end) return false
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }).format(now)
  const cur = fmt.replace(':', '')
  const start = prefs.quiet_start.replace(':', '')
  const end = prefs.quiet_end.replace(':', '')
  if (!/^\d{4}$/.test(start) || !/^\d{4}$/.test(end)) return false
  // A window crossing midnight (22:00 → 07:00) is the normal case.
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end
}

export async function notifyUser(
  app: FastifyInstance,
  userId: string,
  opts: NotifyUserOptions
): Promise<void> {
  const channels = { inapp: true, email: false, sms: false, ...(opts.channels ?? {}) }
  const now = new Date()

  // Nobody who has left gets told. A suspended account cannot act on the
  // notification and a redacted one is a person exercising a deletion right —
  // continuing to mail them is the part that matters legally, and an inbox row
  // for an account that can never sign in is noise either way.
  //
  // Enforced HERE rather than at each caller because everything funnels
  // through this: digests, SLA, watches, subscriptions, flows, mentions.
  try {
    const recipient = (await db('nivaro_users')
      .where({ id: userId })
      .first('status', 'is_redacted')) as { status?: string; is_redacted?: boolean | number } | undefined
    const suspended = String(recipient?.status ?? '').toLowerCase() === 'suspended'
    const redacted = recipient?.is_redacted === true || recipient?.is_redacted === 1
    if (suspended || redacted) return
  } catch {
    // A lookup failure must not swallow a notification — deliver and move on.
  }

  // Record mute (#401): "never tell me about THIS record" beats every watch
  // and subscription — the mute is the most specific signal the user can
  // give. Critical subjects still bypass (same rule as quiet hours).
  if (opts.collection && opts.item && !CRITICAL_SUBJECTS.test(opts.subject)) {
    try {
      const muted = await db('nivaro_notification_mutes')
        .where({ user: userId, collection: opts.collection, item: String(opts.item) })
        .first('id')
      if (muted) return
    } catch {
      // table missing mid-migration — deliver rather than drop
    }
  }

  const category = classifyNotification(opts.subject)
  const prefs = await getNotifyPrefs(userId)
  const matrixRow = prefs?.matrix?.[category]
  const critical = CRITICAL_SUBJECTS.test(opts.subject)
  // Presence-aware suppression (#269): the recipient is LOOKING at the record
  // this notification is about — they watched it happen; the inbox doesn't
  // need to tell them. In-app + push only (email/digest unaffected); critical
  // subjects always land. Per-node presence, same accepted limitation.
  if (!critical && opts.collection && opts.item) {
    try {
      const { isUserViewing } = await import('../plugins/socketio.js')
      if (isUserViewing(opts.collection, String(opts.item), userId)) {
        channels.inapp = false
      }
    } catch {
      // presence lookup failing must never swallow delivery decisions
    }
  }
  // Matrix: in-app off for this category kills the whole in-app channel
  // (row, push, toast) — critical subjects always land.
  if (matrixRow?.inapp === false && !critical) channels.inapp = false
  const pushAllowed =
    critical || (matrixRow?.push !== false && !inQuietHours(prefs, now))

  try {
    if (channels.inapp) {
      const [notif] = await db('nivaro_notifications')
        .insert({
          recipient: userId,
          subject: opts.subject.slice(0, 255),
          status: 'inbox',
          timestamp: now,
          sender: opts.sender ?? null,
          message: opts.message.slice(0, 500),
          collection: opts.collection ?? null,
          item: opts.item ?? null
        })
        .returning('*')

      // Browser push rides the in-app channel: no-op for users with no
      // registered subscription, never blocks the caller. Quiet hours and the
      // per-category matrix suppress the interruption, never the inbox row.
      if (pushAllowed)
      void sendWebPush(userId, {
        title: opts.subject.slice(0, 120),
        body: opts.message.slice(0, 300),
        url:
          opts.collection && opts.item
            ? `/collections/${opts.collection}/${opts.item}`
            : '/notifications'
      })

      if (app.io) {
        emitNotification(app.io, userId, {
          id: (notif as { id?: number } | undefined)?.id ?? null,
          subject: opts.subject.slice(0, 255),
          message: opts.message.slice(0, 200),
          collection: opts.collection ?? null,
          item: opts.item ?? null,
          sender: opts.sender ?? null,
          timestamp: now
        })
      }
    }

    if (channels.email || channels.sms) {
      const user = (await db('nivaro_users').where({ id: userId }).first()) as
        | { email: string | null; first_name: string | null; phone?: string | null }
        | undefined

      if (channels.email && user?.email) {
        await sendMail({
          to: user.email,
          subject: opts.subject,
          template: 'notification',
          // Record context rides into the mail log so the record's Mail tab
          // sees every notification email about it.
          collection: opts.collection ?? undefined,
          item: opts.item != null ? String(opts.item) : undefined,
          data: {
            first_name: user.first_name,
            message: opts.message,
            ...(opts.collection && opts.item
              ? {
                  action_url: `${config.ADMIN_URL}/collections/${opts.collection}/${opts.item}`,
                  action_label: 'View item'
                }
              : {})
          }
        })
      }

      if (channels.sms && user?.phone) {
        await sendSms(user.phone, `${opts.subject}\n${opts.message}`.slice(0, 1600))
      }
    }
  } catch (err) {
    // Notifications are non-critical — never break the calling flow
    console.warn('[notification-channels] notifyUser error:', err)
    // Notification outbox (#335): a delivery failure lands in the outbox and
    // retries with backoff instead of vanishing. `_retry` marks a worker
    // re-invocation so a permanently-failing delivery can't loop forever
    // outside the outbox's own attempt cap.
    if (!opts._retry) {
      const { enqueueOutbox } = await import('./outbox.js')
      await enqueueOutbox('notification', { userId, opts: { ...opts, _retry: true } })
    }
  }
}
