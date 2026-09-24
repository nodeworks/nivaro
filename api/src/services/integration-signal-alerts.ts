/**
 * Opt-in integration alerts (spec 2026-09-23 §5). Nobody is told anything
 * unless they subscribed on the console's Alerts tab: `realtime` rides the
 * signals cycle (one notification per signal per cycle, listing what is new),
 * `digest` adds a section to the daily action summary.
 *
 * "New" is the cycle's own verdict (`CycleSummary.results[].new_keys`): a key
 * the snapshot had never seen open, or an open key whose occurrence moved on
 * (`reoccurred_keys` — worded "happened again"). Snoozes and Dismiss apply
 * exactly as on the page: a hidden row is never alerted, and a dismissed
 * occurrence stays quiet until a NEW occurrence of the same problem arrives.
 *
 * Deliberately separate from integration-alerts.ts, which tells the OWNERS of
 * unmet obligations (gated by `integration_notifications_enabled`). This file
 * only ever tells people who asked.
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { DigestLine, DigestSection } from './daily-digest.js'
import { chunkArray } from './db-batch.js'
import {
  isSnoozed,
  loadActiveSnoozes,
  resolveThresholds,
  type SnoozeRow
} from './integration-signal-settings.js'
import {
  type CycleSummary,
  getIntegrationSignal,
  listIntegrationSignals,
  type SignalRow
} from './integration-signals.js'

export const CRITICAL_SUBSCRIPTION = '*critical'
export type AlertMode = 'realtime' | 'digest'

const TITLES_SHOWN = 5
const WHY = 'you subscribed to this integration alert'

let _app: FastifyInstance | null = null
/** Set once at boot (server.ts) — notifyUser needs the app for sockets/push. */
export function setApp(app: FastifyInstance): void {
  _app = app
}

// ── pure helpers ────────────────────────────────────────────────────────────

/**
 * Who hears about `signal` in `mode`: an exact subscription, or `*critical`
 * when the signal's RESOLVED severity is critical (an admin can raise or
 * lower a signal's severity, and "all critical problems" follows that).
 * One entry per person — user ids compare case-insensitively (MSSQL hands
 * uuids back upper-cased; a hand-written row may not be).
 */
export function pickRecipients(
  subs: Array<{ user: string; signal: string; mode: string }>,
  signal: { id: string; severity: 'critical' | 'warn' },
  mode: AlertMode
): string[] {
  const out = new Map<string, string>()
  for (const s of subs) {
    if (s.mode !== mode) continue
    const hit =
      s.signal === signal.id ||
      (s.signal === CRITICAL_SUBSCRIPTION && signal.severity === 'critical')
    if (!hit) continue
    const k = String(s.user).toUpperCase()
    if (!out.has(k)) out.set(k, s.user)
  }
  return [...out.values()]
}

/** "3 new · Failed pushes" + up to five titles, then "and N more". */
export function alertMessage(
  signalLabel: string,
  newRows: Array<{ title: string; again?: boolean }>
): { subject: string; message: string } {
  const lines = newRows
    .slice(0, TITLES_SHOWN)
    .map((r) => (r.again ? `${r.title} — happened again` : r.title))
  if (newRows.length > TITLES_SHOWN) lines.push(`and ${newRows.length - TITLES_SHOWN} more`)
  return { subject: `${newRows.length} new · ${signalLabel}`, message: lines.join('\n') }
}

export interface StoredAlertRow {
  id: number
  row_key: string
  alerted_at: Date | string | null
  payload: string
}

/**
 * Which of the cycle's new rows are worth telling anyone about: not hidden
 * by a snooze or Dismiss (`isSnoozed` — the page's own rule), and not already
 * alerted — unless it re-occurred, which is news in its own right.
 */
export function selectAlertRows(
  signal: string,
  stored: StoredAlertRow[],
  reoccurred: Set<string>,
  snoozes: SnoozeRow[],
  now: Date
): Array<{ id: number; row: SignalRow; again: boolean }> {
  const out: Array<{ id: number; row: SignalRow; again: boolean }> = []
  for (const s of stored) {
    let row: SignalRow
    try {
      row = JSON.parse(s.payload) as SignalRow
    } catch {
      continue
    }
    if (!row || typeof row !== 'object' || typeof row.key !== 'string') continue
    const again = reoccurred.has(row.key)
    if (s.alerted_at != null && !again) continue
    if (isSnoozed(row, signal, snoozes, now)) continue
    out.push({ id: s.id, row, again })
  }
  return out
}

export function digestLine(label: string, open: number, fresh: number): string {
  return `${label} — ${open} open · ${fresh} new since yesterday`
}

// ── realtime delivery ───────────────────────────────────────────────────────

interface SubscriptionRow {
  id: number
  user: string
  signal: string
  mode: string
}

/**
 * Called at the end of every signals cycle. Never throws — a delivery
 * problem must never fail the cycle that wrote the snapshot.
 */
export async function deliverSignalAlerts(summary: CycleSummary): Promise<void> {
  try {
    await deliver(summary)
  } catch (err) {
    console.warn(
      '[integration-signal-alerts] delivery failed:',
      err instanceof Error ? err.message : err
    )
  }
}

async function deliver(summary: CycleSummary): Promise<void> {
  const app = _app
  if (!app) return
  const pending = summary.results.filter((r) => !r.error && r.new_keys.length > 0)
  if (pending.length === 0) return
  const { maintenanceState } = await import('./security.js')
  if ((await maintenanceState()).on) return

  const subs = (await db('nivaro_integration_signal_subscriptions')
    .where({ mode: 'realtime' })
    .select('id', 'user', 'signal', 'mode')) as SubscriptionRow[]
  if (subs.length === 0) return

  const { notifyUser } = await import('./notification-channels.js')
  const snoozes = await loadActiveSnoozes()
  const now = new Date()

  for (const r of pending) {
    const def = getIntegrationSignal(r.signal)
    if (!def) continue
    const settings = await resolveThresholds(def)
    if (!settings.enabled) continue
    const recipients = pickRecipients(subs, { id: def.id, severity: settings.severity }, 'realtime')
    if (recipients.length === 0) continue

    // The DB row_key is the key truncated to 300 — look the rows up by that.
    const rowKeys = [...new Set(r.new_keys.map((k) => k.slice(0, 300)))]
    const stored: StoredAlertRow[] = []
    for (const chunk of chunkArray(rowKeys, 1000)) {
      stored.push(
        ...((await db('nivaro_integration_signal_rows')
          .where({ signal: def.id })
          .whereNull('cleared_at')
          .whereIn('row_key', chunk)
          .select('id', 'row_key', 'alerted_at', 'payload')) as StoredAlertRow[])
      )
    }
    const fresh = selectAlertRows(def.id, stored, new Set(r.reoccurred_keys), snoozes, now)
    if (fresh.length === 0) continue

    const { subject, message } = alertMessage(
      def.label,
      fresh.map((f) => ({ title: f.row.title, again: f.again }))
    )
    for (const userId of recipients) {
      await notifyUser(app, userId, {
        subject,
        message,
        category: 'integrations',
        why: WHY,
        target: {
          kind: 'integration',
          query: `tab=firefight&signal=${encodeURIComponent(def.id)}`,
          action: 'review'
        },
        source: { kind: 'integration-signal', label: def.label, id: def.id }
      }).catch(() => undefined)
    }

    for (const chunk of chunkArray(
      fresh.map((f) => f.id),
      1000
    )) {
      await db('nivaro_integration_signal_rows').whereIn('id', chunk).update({ alerted_at: now })
    }
    const subIds = subs
      .filter(
        (s) =>
          s.signal === def.id ||
          (s.signal === CRITICAL_SUBSCRIPTION && settings.severity === 'critical')
      )
      .map((s) => s.id)
    for (const chunk of chunkArray(subIds, 1000)) {
      await db('nivaro_integration_signal_subscriptions')
        .whereIn('id', chunk)
        .update({ last_notified_at: now })
    }
  }
}

// ── daily summary ───────────────────────────────────────────────────────────

const DIGEST_CACHE_MS = 60_000
let openCache: {
  at: number
  bySignal: Map<string, { open: number; fresh: number }>
} | null = null

/**
 * Open + new-since-yesterday per signal, net of snoozes — computed ONCE per
 * digest pass (the provider runs per user, the numbers do not depend on who
 * asks), never per subscriber.
 */
async function signalCounts(): Promise<Map<string, { open: number; fresh: number }>> {
  if (openCache && Date.now() - openCache.at < DIGEST_CACHE_MS) return openCache.bySignal
  const now = new Date()
  const since = now.getTime() - 86_400_000
  const snoozes = await loadActiveSnoozes()
  const rows = (await db('nivaro_integration_signal_rows')
    .whereNull('cleared_at')
    .select('signal', 'payload', 'first_seen')) as Array<{
    signal: string
    payload: string
    first_seen: Date
  }>
  const bySignal = new Map<string, { open: number; fresh: number }>()
  for (const r of rows) {
    let row: SignalRow
    try {
      row = JSON.parse(r.payload) as SignalRow
    } catch {
      continue
    }
    if (isSnoozed(row, r.signal, snoozes, now)) continue
    const c = bySignal.get(r.signal) ?? { open: 0, fresh: 0 }
    c.open++
    if (new Date(r.first_seen).getTime() >= since) c.fresh++
    bySignal.set(r.signal, c)
  }
  openCache = { at: Date.now(), bySignal }
  return bySignal
}

/** Users with at least one digest subscription — they get a daily summary
 *  even if nothing else would have sent them one. */
export async function integrationSignalsDigestAudience(): Promise<string[]> {
  const rows = (await db('nivaro_integration_signal_subscriptions')
    .where({ mode: 'digest' })
    .distinct('user')) as Array<{ user: string }>
  return rows.map((r) => String(r.user))
}

/**
 * "Integration alerts" in the daily action summary — one line per subscribed
 * signal that has something open (every critical one for `*critical`),
 * linking to that signal on the console.
 */
export async function integrationSignalsDigest(userId: string): Promise<DigestSection | null> {
  const subs = (await db('nivaro_integration_signal_subscriptions')
    .where({ user: userId, mode: 'digest' })
    .select('signal')) as Array<{ signal: string }>
  if (subs.length === 0) return null
  const wanted = new Set(subs.map((s) => s.signal))
  const counts = await signalCounts()
  const { resolveTargetUrl } = await import('./notification-target.js')
  const lines: DigestLine[] = []
  for (const s of listIntegrationSignals()) {
    const settings = await resolveThresholds(s)
    if (!settings.enabled) continue
    const hit =
      wanted.has(s.id) || (wanted.has(CRITICAL_SUBSCRIPTION) && settings.severity === 'critical')
    if (!hit) continue
    const c = counts.get(s.id)
    if (!c || c.open === 0) continue
    lines.push({
      text: digestLine(s.label, c.open, c.fresh),
      url: await resolveTargetUrl(
        { kind: 'integration', query: `tab=firefight&signal=${encodeURIComponent(s.id)}` },
        { recipientUserId: userId }
      ).catch(() => null)
    })
  }
  if (lines.length === 0) return null
  return { title: 'Integration alerts', lines }
}
