import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { sendMail } from './mail.js'
import {
  actionsFor,
  deriveTarget,
  type NotificationTargetSpec,
  normalizeTarget,
  resolveTargetUrl
} from './notification-target.js'
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
  /** Explicit notification-rules category. Senders whose subjects carry no
   *  recognisable keyword (scheduled reports, view digests, flow ops) set it so
   *  the recipient's matrix row for that category applies; otherwise the
   *  category is sniffed from the subject. */
  category?: NotifyCategory
  /** Skip the two "you already know" suppressions — record mutes and
   *  presence-aware suppression — so the inbox row ALWAYS lands. The matrix
   *  (in-app / push off per category), quiet hours and suspended/redacted
   *  skips still apply. Flow notification ops set this by default: a flow
   *  author configured that notification deliberately. */
  always_inbox?: boolean
  /** Dedicated Liquid template for the EMAIL channel (default 'notification');
   *  `template_data` is merged into its context. Built by mail-builders.ts. */
  template?: string
  template_data?: Record<string, unknown>
  /** Footer "You're getting this because …" (see MailOptions.why). Falls
   *  back to `template_data.why`, then to the honest default: the
   *  recipient's notification rules for the category are on. */
  why?: string | null
  /** What the notification is about + what a click should offer
   *  (services/notification-target.ts). Stored on the row, drives the bell /
   *  center / push / portal click and the inline action. Defaults to the
   *  record named by collection + item. */
  target?: NotificationTargetSpec | null
  /** What produced this row (#77 — the bell's "why me?"): a watch, a
   *  subscription, a mention, a task, a flow… `label` names the specific
   *  rule / watch / flow, `id` its row where one exists. Absent = the
   *  category's notification rules are the honest answer. */
  source?: { kind: string; label?: string | null; id?: string | number | null } | null
  /** Structured content stored with the row (#27): the change lines a
   *  coalesced watch folded in, the child row it was about. */
  detail?: Omit<NotificationDetail, 'why'> | null
  /** Internal: set on outbox re-deliveries to prevent re-enqueue loops. */
  _retry?: boolean
}

/** `nivaro_notifications.detail` — what the row is ABOUT, beyond subject +
 *  message: the diff lines (bundle preview), the child row, and why the
 *  person got it. Diagnostic + explanatory only; never drives delivery. */
export interface NotificationDetail {
  changes?: Array<{ field: string; label: string; old: string; new: string }>
  via_child?: {
    collection: string
    item: string
    event: string
    label?: string | null
  } | null
  bundle?: { writes: number; children: string[] } | null
  why?: {
    kind: string
    text: string
    label?: string | null
    id?: string | number | null
  } | null
}

/** Serialise a detail record for the column — bounded, never throws. */
export function detailColumn(detail: NotificationDetail | null | undefined): string | null {
  if (!detail) return null
  const clip = (v: unknown, n: number) => String(v ?? '').slice(0, n)
  const out: NotificationDetail = {}
  if (detail.changes?.length)
    out.changes = detail.changes.slice(0, 40).map((c) => ({
      field: clip(c.field, 120),
      label: clip(c.label, 160),
      old: clip(c.old, 240),
      new: clip(c.new, 240)
    }))
  if (detail.via_child) out.via_child = detail.via_child
  if (detail.bundle) out.bundle = detail.bundle
  if (detail.why)
    out.why = {
      kind: clip(detail.why.kind, 40),
      text: clip(detail.why.text, 300),
      label: detail.why.label != null ? clip(detail.why.label, 160) : null,
      id: detail.why.id ?? null
    }
  try {
    return JSON.stringify(out)
  } catch {
    return null
  }
}

export function parseDetail(raw: unknown): NotificationDetail | null {
  if (!raw) return null
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return v && typeof v === 'object' ? (v as NotificationDetail) : null
  } catch {
    return null
  }
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
// inbox); truly critical subjects bypass. All America/New_York (the default wall clock).

export type NotifyCategory =
  | 'mentions'
  | 'workflow'
  | 'sla'
  | 'watch'
  | 'alerts'
  | 'anomaly'
  | 'reports'
  | 'system'
  | 'other'

export const NOTIFY_CATEGORIES: NotifyCategory[] = [
  'mentions',
  'workflow',
  'sla',
  'watch',
  'alerts',
  'anomaly',
  'reports',
  'system',
  'other'
]

/** Human labels for the matrix rows — the why-me footer's fallback names one. */
export const NOTIFY_CATEGORY_LABELS: Record<NotifyCategory, string> = {
  mentions: 'Mentions',
  workflow: 'Workflow',
  sla: 'SLA',
  watch: 'Record watches',
  alerts: 'Alerts',
  anomaly: 'Anomaly detection',
  reports: 'Reports',
  system: 'System',
  other: 'Everything else'
}

export function classifyNotification(subject: string): NotifyCategory {
  const s = subject.toLowerCase()
  // Prefix-shaped subjects first — an alert or anomaly rule NAME can contain
  // any word ("SLA breach watch"), so the writer's own prefix must win before
  // the keyword sniffing below gets a look.
  if (s.startsWith('anomaly')) return 'anomaly'
  if (s.startsWith('alert') || s.startsWith('report alert')) return 'alerts'
  if (s.includes('report') || s.startsWith('view "')) return 'reports'
  if (s.includes('mention')) return 'mentions'
  if (s.startsWith('sla') || s.includes('escalation') || s.includes('breach')) return 'sla'
  if (s.includes('watch') || (s.includes('field') && s.includes('changed'))) return 'watch'
  if (
    s.includes('workflow') ||
    s.includes('transition') ||
    s.includes('moved to') ||
    s.includes('approval')
  )
    return 'workflow'
  if (
    s.includes('maintenance') ||
    s.includes('monitor') ||
    s.includes('import') ||
    s.includes('digest')
  )
    return 'system'
  return 'other'
}

// A person can mark their own send critical by leading the subject with
// "Critical:" (the Message-stakeholders form's checkbox does exactly that) —
// it lands in the Critical lane, bypasses mutes and quiet hours, and the
// sender gets read receipts (#64).
const CRITICAL_SUBJECTS = /^critical:|sla escalation|maintenance|monitor failing/i

export type EmailMode = 'instant' | 'daily' | 'off'

export interface NotifyPrefs {
  quiet_start?: string
  quiet_end?: string
  /** Per category: in-app row on/off, browser push on/off, and how EMAIL
   *  reaches the person — each message as it happens, folded into the daily
   *  action summary, or not at all. `email` absent = the legacy
   *  preferences.email_digest default ('instant' unless 'daily').
   *  `quiet_override` (#78): this category's push and instant email go out
   *  even inside quiet hours. */
  matrix?: Partial<
    Record<
      NotifyCategory,
      { inapp?: boolean; push?: boolean; email?: EmailMode; quiet_override?: boolean }
    >
  >
}

/** Does this category ignore the person's quiet hours (#78)? */
export function quietOverridden(prefs: NotifyPrefs | null | undefined, category: NotifyCategory) {
  return prefs?.matrix?.[category]?.quiet_override === true
}

/** Effective email mode for one category, honouring the per-category setting
 *  first and the legacy account-wide `email_digest` default second. */
export function emailModeFor(
  prefs: NotifyPrefs | null | undefined,
  category: NotifyCategory,
  legacyEmailDigest: unknown
): EmailMode {
  const explicit = prefs?.matrix?.[category]?.email
  if (explicit === 'instant' || explicit === 'daily' || explicit === 'off') return explicit
  return legacyEmailDigest === 'daily' ? 'daily' : 'instant'
}

export const isCriticalSubject = (subject: string) => CRITICAL_SUBJECTS.test(subject)

const prefsCache = new Map<string, { at: number; prefs: NotifyPrefs | null }>()

export async function getNotifyPrefs(userId: string): Promise<NotifyPrefs | null> {
  const key = userId.toUpperCase()
  const hit = prefsCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.prefs
  let prefs: NotifyPrefs | null = null
  try {
    const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
      | { preferences?: string | Record<string, unknown> | null }
      | undefined
    const parsed =
      typeof row?.preferences === 'string'
        ? JSON.parse(row.preferences)
        : (row?.preferences ?? null)
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

/** One reason a channel was kept or dropped — the simulator shows these. */
export interface DeliveryReason {
  code:
    | 'suspended'
    | 'redacted'
    | 'muted'
    | 'critical'
    | 'always_inbox'
    | 'presence_viewing'
    | 'matrix_inapp_off'
    | 'matrix_push_off'
    | 'quiet_hours_push'
    | 'quiet_override'
    | 'email_off'
    | 'email_daily'
    | 'email_quiet_hours'
    | 'email_instant'
    | 'no_email'
    | 'no_phone'
    | 'sender_cadence'
  channel: 'all' | 'inapp' | 'push' | 'email' | 'sms'
  text: string
}

export interface DeliveryDecision {
  category: NotifyCategory
  critical: boolean
  /** Whether each channel fires; email 'deferred' = lands in the daily summary. */
  inapp: boolean
  push: boolean
  email: 'send' | 'deferred' | 'off' | 'not_requested' | 'no_address'
  sms: boolean
  reasons: DeliveryReason[]
  /** Fully dropped before any channel (suspended / redacted / muted). */
  dropped: boolean
}

/**
 * THE delivery decision for one recipient — notifyUser executes it; the
 * admin test bench renders it. Every suppression a person can configure
 * (mutes, the channel matrix, quiet hours, digest mode) and every bypass
 * (critical subjects, always_inbox) is judged here so the two can never
 * disagree.
 */
export async function decideDelivery(
  userId: string,
  opts: Pick<
    NotifyUserOptions,
    'subject' | 'collection' | 'item' | 'category' | 'always_inbox' | 'channels'
  > & { cadence?: 'sender' },
  now = new Date()
): Promise<DeliveryDecision> {
  const channels = { inapp: true, email: false, sms: false, ...(opts.channels ?? {}) }
  const reasons: DeliveryReason[] = []
  const category = opts.category ?? classifyNotification(opts.subject)
  const critical = CRITICAL_SUBJECTS.test(opts.subject)
  const dropped = (code: DeliveryReason['code'], text: string): DeliveryDecision => ({
    category,
    critical,
    inapp: false,
    push: false,
    email: 'off',
    sms: false,
    reasons: [{ code, channel: 'all', text }],
    dropped: true
  })

  // Nobody who has left gets told. A suspended account cannot act on the
  // notification and a redacted one is a person exercising a deletion right —
  // continuing to mail them is the part that matters legally, and an inbox row
  // for an account that can never sign in is noise either way.
  let recipient:
    | {
        status?: string
        is_redacted?: boolean | number
        email?: string | null
        phone?: string | null
      }
    | undefined
  try {
    recipient = (await db('nivaro_users')
      .where({ id: userId })
      .first('status', 'is_redacted', 'email', 'phone')) as typeof recipient
  } catch {
    recipient = undefined
  }
  if (String(recipient?.status ?? '').toLowerCase() === 'suspended')
    return dropped('suspended', 'The account is suspended — nothing is delivered.')
  if (recipient?.is_redacted === true || recipient?.is_redacted === 1)
    return dropped('redacted', 'The account is redacted — nothing is delivered.')

  if (critical)
    reasons.push({
      code: 'critical',
      channel: 'all',
      text: 'Critical subject — mutes, quiet hours and the matrix are bypassed.'
    })
  if (opts.always_inbox && !critical)
    reasons.push({
      code: 'always_inbox',
      channel: 'inapp',
      text: 'Sender asked for the inbox row to always land (record mutes and presence suppression skipped).'
    })

  // Record mute (#401): "never tell me about THIS record" beats every watch
  // and subscription — the mute is the most specific signal the user can
  // give. Critical subjects still bypass (same rule as quiet hours).
  if (opts.collection && opts.item && !opts.always_inbox && !critical) {
    try {
      const muted = await db('nivaro_notification_mutes')
        .where({ user: userId, collection: opts.collection, item: String(opts.item) })
        .first('id')
      if (muted)
        return dropped(
          'muted',
          `The recipient muted ${opts.collection} ${opts.item} — nothing is delivered.`
        )
    } catch {
      // table missing mid-migration — deliver rather than drop
    }
  }

  const prefs = await getNotifyPrefs(userId)
  const matrixRow = prefs?.matrix?.[category]
  let inapp = channels.inapp
  // Presence-aware suppression (#269): the recipient is LOOKING at the record
  // this notification is about — they watched it happen; the inbox doesn't
  // need to tell them. In-app + push only (email/digest unaffected); critical
  // subjects always land. Per-node presence, same accepted limitation.
  if (inapp && !critical && !opts.always_inbox && opts.collection && opts.item) {
    try {
      const { isUserViewing } = await import('../plugins/socketio.js')
      if (isUserViewing(opts.collection, String(opts.item), userId)) {
        inapp = false
        reasons.push({
          code: 'presence_viewing',
          channel: 'inapp',
          text: 'The recipient is viewing this record right now — in-app row and push are skipped.'
        })
      }
    } catch {
      // presence lookup failing must never swallow delivery decisions
    }
  }
  // Matrix: in-app off for this category kills the whole in-app channel
  // (row, push, toast) — critical subjects always land.
  if (inapp && matrixRow?.inapp === false && !critical) {
    inapp = false
    reasons.push({
      code: 'matrix_inapp_off',
      channel: 'inapp',
      text: `Notification rules: in-app is OFF for "${NOTIFY_CATEGORY_LABELS[category]}".`
    })
  }
  let push = inapp
  if (push && !critical) {
    if (matrixRow?.push === false) {
      push = false
      reasons.push({
        code: 'matrix_push_off',
        channel: 'push',
        text: `Notification rules: push is OFF for "${NOTIFY_CATEGORY_LABELS[category]}".`
      })
    } else if (inQuietHours(prefs, now)) {
      if (quietOverridden(prefs, category)) {
        reasons.push({
          code: 'quiet_override',
          channel: 'push',
          text: `Quiet hours are on, but "${NOTIFY_CATEGORY_LABELS[category]}" overrides them — push sent.`
        })
      } else {
        push = false
        reasons.push({
          code: 'quiet_hours_push',
          channel: 'push',
          text: `Quiet hours (${prefs?.quiet_start}–${prefs?.quiet_end} ET) — push is held; the inbox row still lands.`
        })
      }
    }
  }

  let email: DeliveryDecision['email'] = 'not_requested'
  if (channels.email) {
    if (!recipient?.email) {
      email = 'no_address'
      reasons.push({
        code: 'no_email',
        channel: 'email',
        text: 'The account has no email address.'
      })
    } else {
      const legacy = await legacyEmailDigest(userId)
      const mode = emailModeFor(prefs, category, legacy)
      if (critical) {
        email = 'send'
        reasons.push({
          code: 'email_instant',
          channel: 'email',
          text: 'Critical — emailed now regardless of the daily-summary setting.'
        })
      } else if (mode === 'off') {
        email = 'off'
        reasons.push({
          code: 'email_off',
          channel: 'email',
          text: `Notification rules: email is OFF for "${NOTIFY_CATEGORY_LABELS[category]}" — not sent, not summarised.`
        })
      } else if (mode === 'daily' && opts.cadence !== 'sender') {
        email = 'deferred'
        reasons.push({
          code: 'email_daily',
          channel: 'email',
          text: `Notification rules: "${NOTIFY_CATEGORY_LABELS[category]}" email goes in the daily summary.`
        })
      } else if (inQuietHours(prefs, now) && !quietOverridden(prefs, category)) {
        email = 'deferred'
        reasons.push({
          code: 'email_quiet_hours',
          channel: 'email',
          text: 'Quiet hours — the email waits for the next daily summary.'
        })
      } else {
        email = 'send'
        if (mode === 'daily' && opts.cadence === 'sender')
          reasons.push({
            code: 'sender_cadence',
            channel: 'email',
            text: 'The sender chose instant delivery (a subscription set to Instantly) — the daily-summary default is skipped.'
          })
        else reasons.push({ code: 'email_instant', channel: 'email', text: 'Emailed now.' })
      }
    }
  }
  let sms = channels.sms
  if (sms && !recipient?.phone) {
    sms = false
    reasons.push({ code: 'no_phone', channel: 'sms', text: 'The account has no phone number.' })
  }

  return { category, critical, inapp, push, email, sms, reasons, dropped: false }
}

async function legacyEmailDigest(userId: string): Promise<unknown> {
  try {
    const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
      | { preferences: unknown }
      | undefined
    const p =
      typeof row?.preferences === 'string'
        ? JSON.parse(row.preferences)
        : (row?.preferences ?? null)
    return p && typeof p === 'object' ? (p as { email_digest?: unknown }).email_digest : undefined
  } catch {
    return undefined
  }
}

// ── Lanes, delivery outcomes ────────────────────────────────────────────────

/** Inbox lane: Critical (bypasses everything, needs eyes now), Needs you
 *  (asks THIS person to act — a task, an approval, a mention, an SLA clock,
 *  a record they own moving), FYI (everything else). The bell badge counts
 *  the first two. */
export type NotificationLane = 'critical' | 'needs_you' | 'fyi'

const ACT_KINDS = new Set(['task', 'approval', 'access_request', 'sla'])

/** Lane from what is KNOWN about the row alone — no ownership lookup. */
export function laneFromRow(row: {
  subject?: string | null
  category?: string | null
  kind?: string | null
  action?: string | null
  actions?: unknown[] | null
}): NotificationLane {
  const subject = String(row.subject ?? '')
  if (CRITICAL_SUBJECTS.test(subject)) return 'critical'
  const category = row.category ?? classifyNotification(subject)
  if (row.kind && ACT_KINDS.has(row.kind)) return 'needs_you'
  if (row.action && row.action !== 'open') return 'needs_you'
  if (category === 'mentions' || category === 'sla') return 'needs_you'
  if (row.actions && row.actions.length > 0) return 'needs_you'
  if (/^(task assigned|approval requested)/i.test(subject) || /requested access/i.test(subject))
    return 'needs_you'
  return 'fyi'
}

/** Does the recipient currently OWN the record (resolved pipeline owner of
 *  its open instance)? A record you own moving is "needs you", the same
 *  record someone else owns is FYI. Best-effort: any failure = not owner. */
async function recipientOwnsRecord(
  userId: string,
  collection: string | null | undefined,
  item: string | number | null | undefined
): Promise<boolean> {
  if (!collection || item == null || /^nivaro_|^directus_|^__/i.test(collection)) return false
  try {
    const inst = (await db('nivaro_workflow_instances')
      .where({ collection, item: String(item) })
      .whereNull('completed_at')
      .first('id', 'current_state')) as { id: string; current_state: string } | undefined
    if (!inst) return false
    const { resolveStateOwnersBatch } = await import('./pipeline-engine.js')
    const owners = await resolveStateOwnersBatch([
      {
        key: String(item),
        stateId: String(inst.current_state),
        instanceId: String(inst.id),
        collection,
        itemId: String(item)
      }
    ])
    const set = owners.get(String(item)) as Array<{ id: unknown }> | undefined
    const me = userId.toUpperCase()
    return !!set?.some((o) => String(o.id).toUpperCase() === me)
  } catch {
    return false
  }
}

/** Lane for a row being written now: row rules first, then the ownership
 *  lookup for plain record rows. */
export async function computeLane(
  userId: string,
  row: {
    subject: string
    category: NotifyCategory
    critical: boolean
    target: NotificationTargetSpec | null
    collection?: string | null
    item?: string | number | null
  }
): Promise<NotificationLane> {
  if (row.critical) return 'critical'
  const byRow = laneFromRow({
    subject: row.subject,
    category: row.category,
    kind: row.target?.kind ?? null,
    action: row.target?.action ?? null,
    actions: actionsFor(row.target, { category: row.category })
  })
  if (byRow !== 'fyi') return byRow
  const collection = row.target?.collection ?? row.collection
  const item = row.target?.id ?? row.item
  if (row.target && row.target.kind !== 'record') return 'fyi'
  return (await recipientOwnsRecord(userId, collection, item)) ? 'needs_you' : 'fyi'
}

/** Column values the raw nivaro_notifications writers (subscription hooks,
 *  SLA hook) stamp alongside their insert so every row carries a category
 *  and a lane, not only the ones notifyUser wrote. */
export function notificationRowMeta(row: {
  subject: string
  category?: NotifyCategory
  kind?: string | null
  action?: string | null
}): { category: NotifyCategory; lane: NotificationLane; delivery: string } {
  const category = row.category ?? classifyNotification(row.subject)
  return {
    category,
    lane: laneFromRow({ subject: row.subject, category, kind: row.kind, action: row.action }),
    delivery: JSON.stringify({ inapp: { status: 'delivered' } })
  }
}

/** Per-channel outcome recorded on the inbox row — what the person can see
 *  under "where did this go?". */
export interface NotificationDelivery {
  inapp?: { status: 'delivered' | 'skipped'; reason?: string }
  push?: {
    status: 'sent' | 'no_subscription' | 'skipped' | 'failed'
    reason?: string
    at?: string
  }
  email?: {
    status:
      | 'sent'
      | 'deferred'
      | 'dropped'
      | 'failed'
      | 'off'
      | 'not_requested'
      | 'no_address'
      | 'unconfigured'
    reason?: string
    mail_log_id?: number | null
    at?: string
  }
  sms?: { status: 'sent' | 'failed' | 'skipped' | 'not_requested'; reason?: string }
  /** Unread-escalation stamps (channel fallback chain). */
  escalation?: { push_at?: string; email_at?: string; email_log_id?: number | null }
}

export function parseDelivery(raw: unknown): NotificationDelivery | null {
  if (!raw) return null
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return v && typeof v === 'object' ? (v as NotificationDelivery) : null
  } catch {
    return null
  }
}

async function stampDelivery(
  notificationId: number | null,
  patch: Partial<NotificationDelivery>
): Promise<void> {
  if (notificationId == null) return
  try {
    const row = (await db('nivaro_notifications')
      .where({ id: notificationId })
      .first('delivery')) as { delivery?: string | null } | undefined
    const cur = parseDelivery(row?.delivery) ?? {}
    await db('nivaro_notifications')
      .where({ id: notificationId })
      .update({ delivery: JSON.stringify({ ...cur, ...patch }) })
  } catch {
    // the delivery record is diagnostic — never a reason a notification fails
  }
}

export interface NotifyUserResult {
  /** Inbox row id, null when no in-app row landed. */
  id: number | null
  decision: DeliveryDecision
  lane: NotificationLane | null
}

export async function notifyUser(
  app: FastifyInstance,
  userId: string,
  opts: NotifyUserOptions
): Promise<NotifyUserResult> {
  const now = new Date()
  const decision = await decideDelivery(userId, opts, now)
  if (decision.dropped) return { id: null, decision, lane: null }
  const channels = {
    inapp: decision.inapp,
    // Email + SMS keep their own deferral / test-mode paths inside mail.ts /
    // sms.ts — the decision only says whether the channel was asked for.
    email: !!opts.channels?.email,
    sms: !!opts.channels?.sms
  }
  const pushAllowed = decision.push
  // Stored target: the caller's spec, else the record named by collection +
  // item (derived the same way legacy rows are read).
  const target =
    normalizeTarget(opts.target) ??
    deriveTarget({
      collection: opts.collection,
      item: opts.item != null ? String(opts.item) : null,
      subject: opts.subject
    })

  const lane = await computeLane(userId, {
    subject: opts.subject,
    category: decision.category,
    critical: decision.critical,
    target,
    collection: opts.collection,
    item: opts.item
  })
  const reasonText = (channel: DeliveryReason['channel']) =>
    decision.reasons.find((r) => r.channel === channel || r.channel === 'all')?.text
  // The delivery record starts from the decision (what was planned and why)
  // and is patched as each channel reports back.
  const delivery: NotificationDelivery = {
    inapp: decision.inapp
      ? { status: 'delivered' }
      : { status: 'skipped', reason: reasonText('inapp') },
    push: decision.inapp
      ? pushAllowed
        ? { status: 'skipped', reason: 'pending' }
        : { status: 'skipped', reason: reasonText('push') }
      : { status: 'skipped', reason: reasonText('inapp') },
    email:
      decision.email === 'not_requested'
        ? { status: 'not_requested' }
        : decision.email === 'no_address'
          ? { status: 'no_address', reason: reasonText('email') }
          : decision.email === 'off'
            ? { status: 'off', reason: reasonText('email') }
            : {
                status: decision.email === 'deferred' ? 'deferred' : 'sent',
                reason: reasonText('email')
              },
    sms: channels.sms
      ? decision.sms
        ? { status: 'sent' }
        : { status: 'skipped', reason: reasonText('sms') }
      : { status: 'not_requested' }
  }
  let notifId: number | null = null
  // "Why me?" (#77): the caller's source when it named one, else the honest
  // default — the recipient's notification rules for the category are on.
  const why: NotificationDetail['why'] = {
    kind: opts.source?.kind ?? (opts.sender ? 'message' : 'rules'),
    text:
      opts.why ??
      (opts.sender
        ? 'Sent to you directly.'
        : `Your notification rules for "${NOTIFY_CATEGORY_LABELS[decision.category]}" are on.`),
    label: opts.source?.label ?? null,
    id: opts.source?.id ?? null
  }
  const detail = detailColumn({ ...(opts.detail ?? {}), why })

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
          item: opts.item ?? null,
          target: target ? JSON.stringify(target) : null,
          kind: target?.kind ?? null,
          action: target?.action ?? null,
          category: decision.category,
          lane,
          delivery: JSON.stringify(delivery),
          detail
        })
        .returning('*')
      const rawId = (notif as { id?: unknown } | undefined)?.id
      notifId = Number.isFinite(Number(rawId)) ? Number(rawId) : null

      // Browser push rides the in-app channel: no-op for users with no
      // registered subscription, never blocks the caller. Quiet hours and the
      // per-category matrix suppress the interruption, never the inbox row.
      // The push opens the target in the app THIS recipient uses.
      if (pushAllowed) {
        const url =
          (await resolveTargetUrl(target, { recipientUserId: userId }).catch(() => null)) ??
          (opts.collection && opts.item
            ? `/collections/${opts.collection}/${opts.item}`
            : '/notifications')
        void sendWebPush(userId, {
          title: opts.subject.slice(0, 120),
          body: opts.message.slice(0, 300),
          url
        }).then(
          (sent) =>
            stampDelivery(notifId, {
              push:
                sent > 0
                  ? { status: 'sent', at: new Date().toISOString() }
                  : { status: 'no_subscription', reason: 'No browser registered for push.' }
            }),
          () => stampDelivery(notifId, { push: { status: 'failed' } })
        )
      }

      if (app.io) {
        emitNotification(app.io, userId, {
          id: notifId,
          subject: opts.subject.slice(0, 255),
          message: opts.message.slice(0, 200),
          collection: opts.collection ?? null,
          item: opts.item ?? null,
          sender: opts.sender ?? null,
          timestamp: now,
          target,
          category: decision.category,
          lane,
          actions: actionsFor(target, { category: decision.category })
        })
      }
    }

    if (channels.email || channels.sms) {
      const user = (await db('nivaro_users').where({ id: userId }).first()) as
        | { email: string | null; first_name: string | null; phone?: string | null }
        | undefined

      if (channels.email && user?.email) {
        // Generic notices get the record's header-strip card too (business
        // collections only) — the same block the dedicated templates use.
        const { cardFor } = await import('./mail-builders.js')
        const { resolveLinksFor, recordLink } = await import('./app-links.js')
        const card = opts.template_data?.record_card
          ? null
          : await cardFor(opts.collection, opts.item ?? null, userId).catch(() => null)
        // Links land in the app THIS recipient uses (portal vs admin).
        const templateData = opts.template_data
          ? await resolveLinksFor(opts.template_data, userId).catch(() => opts.template_data)
          : undefined
        const actionUrl =
          opts.collection && opts.item && !String(opts.collection).startsWith('__')
            ? await recordLink(opts.collection, opts.item, { recipientUserId: userId }).catch(
                () => `${config.ADMIN_URL}/collections/${opts.collection}/${opts.item}`
              )
            : null
        const category = opts.category ?? classifyNotification(opts.subject)
        const why =
          opts.why ??
          (typeof templateData?.why === 'string' ? (templateData.why as string) : null) ??
          `your notification rules for "${NOTIFY_CATEGORY_LABELS[category]}" send you email`
        try {
          const mail = await sendMail({
            to: user.email,
            subject: opts.subject,
            template: opts.template ?? 'notification',
            why,
            // Record context rides into the mail log so the record's Mail tab
            // sees every notification email about it.
            collection: opts.collection ?? undefined,
            item: opts.item != null ? String(opts.item) : undefined,
            data: {
              first_name: user.first_name,
              subject: opts.subject,
              message: opts.message,
              category,
              ...(card ? { record_card: card } : {}),
              ...(actionUrl ? { action_url: actionUrl, action_label: 'View item' } : {}),
              ...(templateData ?? {})
            }
          })
          await stampDelivery(notifId, {
            email: {
              status: mail.status,
              mail_log_id: mail.log_id,
              at: new Date().toISOString(),
              reason: mail.status === 'sent' ? undefined : delivery.email?.reason
            }
          })
        } catch (err) {
          await stampDelivery(notifId, {
            email: {
              status: 'failed',
              reason: err instanceof Error ? err.message.slice(0, 200) : 'send failed',
              at: new Date().toISOString()
            }
          })
          throw err
        }
      } else if (channels.email && !user?.email) {
        await stampDelivery(notifId, { email: { status: 'no_address' } })
      }

      if (channels.sms && user?.phone) {
        const ok = await sendSms(user.phone, `${opts.subject}\n${opts.message}`.slice(0, 1600))
        await stampDelivery(notifId, { sms: { status: ok ? 'sent' : 'failed' } })
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
  return { id: notifId, decision, lane }
}
