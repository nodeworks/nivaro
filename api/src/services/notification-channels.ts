import type { NotificationDetail, NotifyCategory, NotifyUserOptions } from '@nivaro/extension-kit'
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { withChainStep } from './chain.js'
import { chainFields } from './chain-columns.js'
import { sendMail } from './mail.js'
import {
  effectiveRules,
  emailLayerOf,
  type LayeredRules,
  layerOf,
  NOTIFY_CATEGORIES,
  type NotifyRules,
  type RuleLayer,
  sanitizeNotifyRules
} from './notification-layers.js'
import { buildDeliveryReason, derivePathKind, reasonColumn } from './notification-reason.js'
import { snapshotRevisionFor } from './notification-snapshot.js'
import {
  actionsFor,
  deriveTarget,
  type NotificationTargetSpec,
  normalizeTarget,
  resolveTargetUrl
} from './notification-target.js'
import { currentTenantKey } from './tenant-rooms.js'
import { sendWebPush } from './web-push.js'

export type { NotificationDetail, NotifyCategory, NotifyUserOptions } from '@nivaro/extension-kit'

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
  if (detail.ack_required === true) out.ack_required = true
  if (typeof detail.ack_at === 'string') out.ack_at = clip(detail.ack_at, 40)
  if (typeof detail.ack_by === 'string') out.ack_by = clip(detail.ack_by, 40)
  try {
    return JSON.stringify(out)
  } catch {
    return null
  }
}

/** SQL fragment: rows that still need an acknowledgement (#2365). */
// `[_]` — a bare `_` is a LIKE wildcard.
export const ACK_PENDING_LIKE = '%"ack[_]required":true%'
export const ACK_DONE_LIKE = '%"ack[_]at"%'

/** Authoritative ack state from the parsed detail (the LIKE patterns are only
 *  a prefilter: a string value can contain the same text). */
export function ackPending(raw: unknown): boolean {
  const d = parseDetail(raw)
  return d?.ack_required === true && typeof d.ack_at !== 'string'
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

export { NOTIFY_CATEGORIES }

/** Human labels for the matrix rows — the why-me footer's fallback names one. */
export const NOTIFY_CATEGORY_LABELS: Record<NotifyCategory, string> = {
  mentions: 'Mentions',
  workflow: 'Workflow',
  sla: 'SLA',
  watch: 'Record watches',
  alerts: 'Alerts',
  audit: 'Audit log patterns',
  anomaly: 'Anomaly detection',
  reports: 'Reports',
  integrations: 'Integrations',
  system: 'System',
  huddle: 'Huddles and calls',
  chaos: 'Chaos drills and game days',
  other: 'Everything else'
}

export function classifyNotification(subject: string): NotifyCategory {
  const s = subject.toLowerCase()
  // Prefix-shaped subjects first — an alert or anomaly rule NAME can contain
  // any word ("SLA breach watch"), so the writer's own prefix must win before
  // the keyword sniffing below gets a look.
  if (s.startsWith('anomaly')) return 'anomaly'
  if (s.startsWith('alert') || s.startsWith('report alert')) return 'alerts'
  if (s.startsWith('integration:')) return 'integrations'
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

/**
 * A person's notification rules (preferences.notification_prefs) — and, since #3077, a role's
 * defaults, in the same shape (services/notification-layers.ts). Per category: in-app row
 * on/off, browser push on/off, Teams (opt-in), how EMAIL reaches the person (instant / daily
 * summary / off; absent = the legacy preferences.email_digest default) and `quiet_override`
 * (#78: push + instant email go out even inside quiet hours). Plus quiet hours, the bot's
 * `teams_muted_until` and the unread-escalation steps.
 */
export type NotifyPrefs = NotifyRules

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

interface PersonPrefsEntry {
  at: number
  own: NotifyPrefs | null
  roleId: string | null
  roleName: string | null
  legacyEmailDigest: unknown
}
// Tenant-keyed: two cloud tenants never share an entry.
const prefsCache = new Map<string, PersonPrefsEntry>()
const prefsKey = (userId: string) => `${currentTenantKey()}:${userId.toUpperCase()}`

async function personPrefs(userId: string): Promise<PersonPrefsEntry> {
  const key = prefsKey(userId)
  const hit = prefsCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit
  const entry: PersonPrefsEntry = {
    at: Date.now(),
    own: null,
    roleId: null,
    roleName: null,
    legacyEmailDigest: undefined
  }
  try {
    const row = (await db('nivaro_users').where({ id: userId }).first('preferences', 'role')) as
      | { preferences?: string | Record<string, unknown> | null; role?: string | null }
      | undefined
    const parsed =
      typeof row?.preferences === 'string'
        ? JSON.parse(row.preferences)
        : (row?.preferences ?? null)
    entry.own = (parsed?.notification_prefs as NotifyPrefs) ?? null
    entry.legacyEmailDigest = parsed?.email_digest
    entry.roleId = row?.role != null ? String(row.role) : null
  } catch {
    // unreadable prefs = system defaults, never a failed delivery
  }
  prefsCache.set(key, entry)
  return entry
}

export interface LayeredNotifyPrefs extends LayeredRules {
  legacyEmailDigest: unknown
}

/**
 * The person's rules in layers (#3077): their own, their CURRENT role's defaults, and the
 * merged result every reader judges by. `ownOverride` judges proposed own rules instead of the
 * stored ones (the rules preview) — still over the role's defaults.
 */
export async function getNotifyPrefsLayered(
  userId: string,
  ownOverride?: NotifyPrefs | null
): Promise<LayeredNotifyPrefs> {
  const p = await personPrefs(userId)
  const own = ownOverride !== undefined ? ownOverride : p.own
  let role: LayeredRules['role'] = null
  if (p.roleId) {
    const { getRoleDefaults } = await import('./notification-role-defaults.js')
    const row = await getRoleDefaults(p.roleId).catch(() => null)
    if (row) {
      // The name only matters when the role has defaults (it labels "from your role").
      if (p.roleName == null) {
        const r = (await db('nivaro_roles')
          .where({ id: p.roleId })
          .first('name')
          .catch(() => undefined)) as { name?: string | null } | undefined
        p.roleName = r?.name ?? ''
      }
      role = { id: p.roleId, name: p.roleName || null, rules: row.rules }
    }
  }
  return {
    own,
    role,
    merged: effectiveRules(own, role?.rules, p.legacyEmailDigest),
    legacyEmailDigest: p.legacyEmailDigest
  }
}

/** The rules every reader judges by: the person's own over their role's defaults. Null = none. */
export async function getNotifyPrefs(userId: string): Promise<NotifyPrefs | null> {
  const l = await getNotifyPrefsLayered(userId)
  return l.own || l.role ? l.merged : null
}

export function bustNotifyPrefsCache(userId?: string): void {
  if (userId) prefsCache.delete(prefsKey(userId))
  else prefsCache.clear()
}

/** Sanitize a person's own rules (the users route and the rules preview use this). */
export const sanitizePersonRules = (raw: unknown) => sanitizeNotifyRules(raw)

/** The end of an active `mute 1h` on Teams, or null when none is running. */
export function teamsMutedUntil(prefs: NotifyPrefs | null | undefined, now = new Date()) {
  const raw = prefs?.teams_muted_until
  if (typeof raw !== 'string') return null
  const t = new Date(raw)
  return Number.isNaN(t.getTime()) || t.getTime() <= now.getTime() ? null : t
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
    | 'teams_off'
    | 'teams_not_connected'
    | 'teams_quiet_hours'
    | 'teams_muted'
    | 'teams_sent'
    | 'teams_test_mode'
    | 'quiet_override'
    | 'email_off'
    | 'email_daily'
    | 'email_quiet_hours'
    | 'email_instant'
    | 'no_email'
    | 'no_phone'
    | 'sender_cadence'
  channel: 'all' | 'inapp' | 'push' | 'teams' | 'email' | 'sms'
  text: string
  /** #3077 — which rules layer this reason came from (rules-driven reasons only). */
  layer?: RuleLayer
}

/** Per channel, the rules layer that decided its outcome (#3077). */
export interface DecisionLayers {
  inapp: RuleLayer
  push: RuleLayer
  teams: RuleLayer
  email: RuleLayer
  quiet: RuleLayer
}

export interface DeliveryDecision {
  category: NotifyCategory
  critical: boolean
  /** Whether each channel fires; email 'deferred' = lands in the daily summary. */
  inapp: boolean
  push: boolean
  /** Teams 1:1 message: opted in, connected, outside quiet hours. */
  teams: boolean
  email: 'send' | 'deferred' | 'off' | 'not_requested' | 'no_address'
  sms: boolean
  reasons: DeliveryReason[]
  /** Fully dropped before any channel (suspended / redacted / muted). */
  dropped: boolean
  /** #3077 — which layer (person / role default / system default) decided each channel. */
  layers?: DecisionLayers
  /** The role whose defaults were in play (null = none set for the person's role). */
  role?: { id: string; name: string | null } | null
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
  > & {
    cadence?: 'sender'
    /** #2407 — judge against PROPOSED rules instead of the stored ones. */
    prefsOverride?: NotifyPrefs | null
    /** #2407 — read-only replay of an earlier send: no live presence check. */
    replay?: boolean
  },
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
    teams: false,
    email: 'off',
    sms: false,
    reasons: [{ code, channel: 'all', text, layer: 'system' }],
    dropped: true,
    layers: { inapp: 'system', push: 'system', teams: 'system', email: 'system', quiet: 'system' },
    role: null
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

  const layered = await getNotifyPrefsLayered(userId, opts.prefsOverride)
  const prefs: NotifyPrefs | null = layered.own || layered.role ? layered.merged : null
  const matrixRow = prefs?.matrix?.[category]
  // #3077 — which layer supplies each value this decision reads.
  const L = (path: Parameters<typeof layerOf>[2]) => layerOf(layered.own, layered.role?.rules, path)
  const quietLayer = L('quiet')
  const layers: DecisionLayers = {
    inapp: L(`matrix.${category}.inapp`),
    push: L(`matrix.${category}.push`),
    teams: L(`matrix.${category}.teams`),
    email: emailLayerOf(layered.own, layered.role?.rules, category, layered.legacyEmailDigest),
    quiet: quietLayer
  }
  let inapp = channels.inapp
  // Presence-aware suppression (#269): the recipient is LOOKING at the record
  // this notification is about — they watched it happen; the inbox doesn't
  // need to tell them. In-app + push only (email/digest unaffected); critical
  // subjects always land. Per-node presence, same accepted limitation.
  if (inapp && !critical && !opts.always_inbox && !opts.replay && opts.collection && opts.item) {
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

  // Teams rides the in-app channel like push (viewing / in-app-off suppress it, critical lands),
  // but is opt-in: only a person who turned it on in Notification rules is messaged. Critical
  // subjects bypass quiet hours, never the opt-in.
  let teams = false
  // No bot (or Teams in test mode, which has no DM recipients) = nothing to say and nothing to
  // build: links survive the bot being turned off, so this is checked before anything else.
  if (inapp && (await teamsBotEnabled())) {
    if (await teamsTestMode()) {
      reasons.push({
        code: 'teams_test_mode',
        channel: 'teams',
        text: 'Teams is in test mode; only test recipients get messages.'
      })
    } else if (matrixRow?.teams !== true) {
      reasons.push({
        code: 'teams_off',
        channel: 'teams',
        text: 'Teams is off for this kind of notification.'
      })
    } else if (!(await hasTeamsLink(userId))) {
      reasons.push({
        code: 'teams_not_connected',
        channel: 'teams',
        text: 'Teams is not connected.'
      })
    } else if (!critical && teamsMutedUntil(prefs, now)) {
      reasons.push({
        code: 'teams_muted',
        channel: 'teams',
        text: `Teams is muted until ${teamsMutedUntil(prefs, now)?.toISOString()}.`
      })
    } else if (!critical && inQuietHours(prefs, now) && !quietOverridden(prefs, category)) {
      reasons.push({
        code: 'teams_quiet_hours',
        channel: 'teams',
        text: `Quiet hours (${prefs?.quiet_start}–${prefs?.quiet_end} ET) — the Teams message is held; the inbox row still lands.`
      })
    } else {
      teams = true
      reasons.push({ code: 'teams_sent', channel: 'teams', text: 'Sent to Teams.' })
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

  // Stamp each rules-driven reason with its layer, and let the reason that actually decided a
  // channel name that channel's layer (quiet hours holding a push = the quiet-hours layer).
  const overrideLayer = L(`matrix.${category}.quiet_override`)
  const CODE_LAYER: Partial<Record<DeliveryReason['code'], RuleLayer>> = {
    matrix_inapp_off: layers.inapp,
    matrix_push_off: layers.push,
    quiet_hours_push: quietLayer,
    teams_quiet_hours: quietLayer,
    email_quiet_hours: quietLayer,
    quiet_override: overrideLayer,
    teams_off: layers.teams,
    teams_sent: layers.teams,
    email_off: layers.email,
    email_daily: layers.email,
    muted: 'person',
    teams_muted: 'person'
  }
  for (const r of reasons) {
    const byCode = CODE_LAYER[r.code]
    r.layer =
      r.code === 'email_instant' ? (critical ? 'system' : layers.email) : (byCode ?? 'system')
  }
  const decidedBy = (channel: DeliveryReason['channel'], fallback: RuleLayer) =>
    reasons.find((r) => r.channel === channel && r.layer)?.layer ?? fallback
  const finalLayers: DecisionLayers = critical
    ? { inapp: 'system', push: 'system', teams: 'system', email: 'system', quiet: quietLayer }
    : {
        inapp: decidedBy('inapp', layers.inapp),
        push: inapp ? decidedBy('push', layers.push) : decidedBy('inapp', layers.inapp),
        teams: decidedBy('teams', layers.teams),
        email: decidedBy('email', layers.email),
        quiet: quietLayer
      }

  return {
    category,
    critical,
    inapp,
    push,
    teams,
    email,
    sms,
    reasons,
    dropped: false,
    layers: finalLayers,
    role: layered.role ? { id: layered.role.id, name: layered.role.name } : null
  }
}

async function teamsTestMode(): Promise<boolean> {
  try {
    const { getChannelTestConfig } = await import('./channel-test-mode.js')
    return (await getChannelTestConfig()).teams.on
  } catch {
    return false
  }
}

async function teamsBotEnabled(): Promise<boolean> {
  try {
    const { getTeamsBotConfig } = await import('./teams-bot/config.js')
    return (await getTeamsBotConfig()).enabled
  } catch {
    return false
  }
}

/** A working Teams link (active, with a chat to write to). Lookup trouble = not connected. */
async function hasTeamsLink(userId: string): Promise<boolean> {
  try {
    const { linkForUser } = await import('./teams-bot/links.js')
    const link = await linkForUser(userId)
    return !!(link?.conversation_id && link.service_url)
  } catch {
    return false
  }
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
  row: Parameters<typeof computeLaneDetailed>[1]
): Promise<NotificationLane> {
  return (await computeLaneDetailed(userId, row)).lane
}

/** The lane plus whether it came from the recipient owning the record (#3078: the "owner of
 *  the state" path). `owns` is only known when the ownership lookup ran. */
export async function computeLaneDetailed(
  userId: string,
  row: {
    subject: string
    category: NotifyCategory
    critical: boolean
    target: NotificationTargetSpec | null
    collection?: string | null
    item?: string | number | null
  }
): Promise<{ lane: NotificationLane; owns: boolean }> {
  if (row.critical) return { lane: 'critical', owns: false }
  const byRow = laneFromRow({
    subject: row.subject,
    category: row.category,
    kind: row.target?.kind ?? null,
    action: row.target?.action ?? null,
    actions: actionsFor(row.target, { category: row.category })
  })
  if (byRow !== 'fyi') return { lane: byRow, owns: false }
  const collection = row.target?.collection ?? row.collection
  const item = row.target?.id ?? row.item
  if (row.target && row.target.kind !== 'record') return { lane: 'fyi', owns: false }
  const owns = await recipientOwnsRecord(userId, collection, item)
  return { lane: owns ? 'needs_you' : 'fyi', owns }
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
  teams?: {
    status: 'sent' | 'not_connected' | 'disabled' | 'skipped' | 'failed'
    reason?: string
    at?: string
  }
  /** Unread-escalation stamps (channel fallback chain). */
  escalation?: {
    push_at?: string
    email_at?: string
    email_log_id?: number | null
    /** #2365 — acknowledgement reminder / manager escalation stamps. */
    ack_remind_at?: string
    ack_manager_at?: string
  }
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

  const { lane: computedLane, owns: ownsRecord } = await computeLaneDetailed(userId, {
    subject: opts.subject,
    category: decision.category,
    critical: decision.critical,
    target,
    collection: opts.collection,
    item: opts.item
  })
  // An acknowledgement request is never FYI (#2365).
  const lane = opts.ack_required && computedLane === 'fyi' ? 'needs_you' : computedLane
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
    // Only where the bot had something to say (it is on): an instance without a bot shows no
    // "Teams · skipped" chip.
    ...(decision.teams || decision.reasons.some((r) => r.channel === 'teams')
      ? {
          teams: decision.teams
            ? { status: 'skipped' as const, reason: 'pending' }
            : { status: 'skipped' as const, reason: reasonText('teams') }
        }
      : {}),
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
  // #3079 — the record revision the row points at; set when the in-app row lands.
  let stampedRevision: number | null = null
  // "Why me?" (#77 / #3078): the caller's source when it named one, else the path derived from
  // what is known — a mention, a direct message, an alert, owning the record's state, the role's
  // default rules, or the recipient's own rules for the category.
  const pathKind = derivePathKind({
    sourceKind: opts.source?.kind ?? null,
    sender: opts.sender ?? null,
    category: decision.category,
    ownsRecord,
    inappLayer: decision.layers?.inapp ?? null
  })
  const catLabel = NOTIFY_CATEGORY_LABELS[decision.category]
  const why: NotificationDetail['why'] = {
    kind: pathKind,
    text:
      opts.why ??
      (pathKind === 'message'
        ? 'Sent to you directly.'
        : pathKind === 'mention'
          ? 'You were @-mentioned.'
          : pathKind === 'owner'
            ? "You own this record's current state."
            : pathKind === 'role_default'
              ? `Your role's default notification rules for "${catLabel}" are on.`
              : `Your notification rules for "${catLabel}" are on.`),
    label:
      opts.source?.label ?? (pathKind === 'role_default' ? (decision.role?.name ?? null) : null),
    id: opts.source?.id ?? null
  }
  // #3078 — what happened, stored with the row (column-probed: migration 514).
  const reasonCols = await reasonColumn(buildDeliveryReason(decision, why))
  // The ack flags are server-owned: only opts.ack_required sets them.
  const {
    ack_required: _ar,
    ack_at: _aa,
    ack_by: _ab,
    ...safeDetail
  } = (opts.detail ?? {}) as Record<string, unknown>
  const detail = detailColumn({
    ...safeDetail,
    why,
    ...(opts.ack_required ? { ack_required: true } : {})
  })

  try {
    if (channels.inapp) {
      // #1385 — the record's revision current right now, so "as it was" can
      // open what the person saw. Column-probed: null on a tenant behind
      // migration 393, and the key is then left off the insert entirely.
      const revisionId = await snapshotRevisionFor(target)
      stampedRevision = revisionId
      const [notif] = await db('nivaro_notifications')
        .insert({
          ...(revisionId != null ? { revision_id: revisionId } : {}),
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
          detail,
          ...reasonCols,
          // #706 — the row is a step of whatever chain told this person.
          ...(await chainFields('nivaro_notifications'))
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

      // Teams 1:1 message: built per recipient (buttons only when there is something to do),
      // never blocks the caller, and a failure here is only a delivery stamp.
      if (decision.teams) {
        void (async () => {
          // Action.OpenUrl needs an absolute URI: the fallbacks use the same builders.
          const { linkTo, recordLink } = await import('./app-links.js')
          const openUrl =
            (await resolveTargetUrl(target, { recipientUserId: userId }).catch(() => null)) ??
            (opts.collection && opts.item && !String(opts.collection).startsWith('__')
              ? await recordLink(opts.collection, opts.item, { recipientUserId: userId }).catch(
                  () => null
                )
              : null) ??
            (await linkTo('notifications', {}, { recipientUserId: userId }))
          const { buildTeamsNotificationCard } = await import('./teams-bot/notification-card.js')
          const { deliverTeams } = await import('./teams-bot/send.js')
          const card = await buildTeamsNotificationCard({
            userId,
            notificationId: notifId,
            subject: opts.subject,
            message: opts.message,
            category: decision.category,
            collection: opts.collection,
            item: opts.item,
            target,
            ackRequired: !!opts.ack_required,
            openUrl
          })
          const outcome = await deliverTeams(app, userId, card, { notificationId: notifId })
          await stampDelivery(notifId, {
            teams:
              outcome === 'sent'
                ? { status: 'sent', at: new Date().toISOString() }
                : {
                    status: outcome,
                    reason:
                      outcome === 'not_connected'
                        ? 'Teams is not connected.'
                        : outcome === 'disabled'
                          ? 'Teams messages are off on this instance (or held by test mode).'
                          : 'The Teams message could not be sent.'
                  }
          })
        })().catch(() => stampDelivery(notifId, { teams: { status: 'failed' } }))
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

    // The email / SMS this notification sends hangs under the inbox row in
    // the event path (#706): "told X in-app, then emailed them".
    const sendOtherChannels = async () => {
      const user = (await db('nivaro_users').where({ id: userId }).first()) as
        | { email: string | null; first_name: string | null; phone?: string | null }
        | undefined

      if (channels.email && user?.email) {
        // Generic notices get the record's header-strip card too (business
        // collections only) — the same block the dedicated templates use.
        const { cardFor } = await import('./mail-builders.js')
        const { resolveLinksFor, recordLink, linkTo } = await import('./app-links.js')
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
        // #3079 — a record-change row: "See what changed" opens the inbox on it, where the
        // values are read as the recipient (never put in the email).
        const changesUrl =
          notifId != null && stampedRevision != null && target?.kind === 'record'
            ? await linkTo('notifications', {}, { recipientUserId: userId })
                .then((u) => `${u}${u.includes('?') ? '&' : '?'}changes=${notifId}`)
                .catch(() => null)
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
              ...(actionUrl
                ? {
                    action_url: actionUrl,
                    action_label: opts.ack_required ? 'Open to acknowledge' : 'View item'
                  }
                : {}),
              ...(changesUrl ? { changes_url: changesUrl } : {}),
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
    if (channels.email || channels.sms) {
      if (notifId != null) await withChainStep(`notification:${notifId}`, sendOtherChannels)
      else await sendOtherChannels()
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
