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
import { chunkArray, selectInChunks } from './db-batch.js'
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

/**
 * A row that re-occurs within this many hours of its last alert stays quiet —
 * a partner flapping, or a problem whose occurrence moves while it lasts,
 * must never become one notification per 5-minute cycle. A constant rather
 * than a per-signal setting: it is about how often a PERSON may be told, not
 * about what counts as a problem, and no signal has asked to tune it.
 */
export const REALERT_HOURS = 6
/** A row nobody could be told about (every delivery failed or was dropped)
 *  is offered again on later cycles, for this long after it first appeared. */
const RETRY_WINDOW_MS = 86_400_000

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

/**
 * A subscriber survives to delivery only when they are still a live admin at
 * the moment we're about to tell them something: status not suspended, not
 * redacted, and their CURRENT role still carries admin_access. A demoted or
 * offboarded person's subscription row is not deleted (they may get their
 * access back), but nothing goes out to them while it's gone — alerts
 * describe the admin-only console and link straight into it.
 *
 * One join, chunked ≤1000 ids — computed ONCE for a whole delivery/digest
 * pass, never re-queried per signal or per recipient.
 */
export async function filterActiveAdminUserIds(userIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(userIds.map((id) => String(id)))]
  const rows = (await selectInChunks(unique, 1000, (chunk) =>
    db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .whereIn('u.id', chunk)
      .whereNot('u.status', 'suspended')
      .where('u.is_redacted', false)
      .where('r.admin_access', true)
      .select('u.id')
  )) as Array<{ id: string }>
  return new Set(rows.map((r) => String(r.id).toUpperCase()))
}

/** "3 new · Failed pushes" + up to five titles (each naming its record when
 *  it has one — "Partner /orders · ORD-1042"), then "and N more". */
export function alertMessage(
  signalLabel: string,
  newRows: Array<{ title: string; again?: boolean; label?: string | null }>
): { subject: string; message: string } {
  const lines = newRows.slice(0, TITLES_SHOWN).map((r) => {
    const line = r.label ? `${r.title} · ${r.label}` : r.title
    return r.again ? `${line} — happened again` : line
  })
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
 * alerted — unless it re-occurred, which is news in its own right, and even
 * then only once `realertMs` (default REALERT_HOURS) has passed since the
 * last alert about it.
 *
 * "Happened again" only reads true when the row had actually been alerted
 * BEFORE this reoccurrence (`alerted_at != null`) — a row that reoccurred
 * without anyone ever having heard about it (nobody was subscribed yet, or
 * the last delivery failed for everyone) is, to whoever hears about it now,
 * simply new. `reoccurred` alone can't tell those two cases apart.
 */
export function selectAlertRows(
  signal: string,
  stored: StoredAlertRow[],
  reoccurred: Set<string>,
  snoozes: SnoozeRow[],
  now: Date,
  realertMs = REALERT_HOURS * 3600_000
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
    const again = reoccurred.has(row.key) && s.alerted_at != null
    if (s.alerted_at != null && !again) continue
    if (again && now.getTime() - new Date(s.alerted_at as Date | string).getTime() < realertMs) {
      continue
    }
    if (isSnoozed(row, signal, snoozes, now)) continue
    out.push({ id: s.id, row, again })
  }
  return out
}

/**
 * Give every alerted row that points at a record its friendly id — the same
 * lookup the console page does (`resolveFriendlyIds`), one call per
 * collection, never per row. A failed lookup leaves those lines unlabelled;
 * the alert still goes out. Mutates the rows (already parsed copies).
 */
export async function labelAlertRows(rows: SignalRow[]): Promise<void> {
  const want = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.record || r.record.label) continue
    if (!want.has(r.record.collection)) want.set(r.record.collection, new Set())
    want.get(r.record.collection)?.add(String(r.record.id))
  }
  if (want.size === 0) return
  const { resolveFriendlyIds } = await import('./workflow-transitions.js')
  const labels = new Map<string, string>()
  for (const [collection, ids] of want) {
    try {
      for (const [id, label] of await resolveFriendlyIds(collection, [...ids])) {
        labels.set(`${collection}:${id}`, label)
      }
    } catch {
      // Leave this collection's lines unlabelled.
    }
  }
  for (const r of rows) {
    if (!r.record || r.record.label) continue
    const label = labels.get(`${r.record.collection}:${r.record.id}`)
    if (label) r.record.label = label
  }
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
  // Every signal that evaluated cleanly — not only those with new keys: a row
  // an earlier delivery failed to get to anyone is retried below.
  const ready = summary.results.filter((r) => !r.error)
  if (ready.length === 0) return

  const subs = (await db('nivaro_integration_signal_subscriptions')
    .where({ mode: 'realtime' })
    .select('id', 'user', 'signal', 'mode')) as SubscriptionRow[]
  if (subs.length === 0) return
  const { maintenanceState } = await import('./security.js')
  if ((await maintenanceState()).on) return

  // Computed ONCE for every subscriber this cycle touches, never per signal —
  // a demoted or offboarded subscriber must not hear about ANY of them.
  const activeAdmins = await filterActiveAdminUserIds(subs.map((s) => s.user))

  const { notifyUser } = await import('./notification-channels.js')
  const snoozes = await loadActiveSnoozes()
  const now = new Date()
  const retrySince = new Date(now.getTime() - RETRY_WINDOW_MS)

  for (const r of ready) {
    const def = getIntegrationSignal(r.signal)
    if (!def) continue
    const settings = await resolveThresholds(def)
    if (!settings.enabled) continue
    const recipients = pickRecipients(
      subs,
      { id: def.id, severity: settings.severity },
      'realtime'
    ).filter((id) => activeAdmins.has(String(id).toUpperCase()))
    if (recipients.length === 0) continue

    // The DB row_key is the key truncated to 300 — look the rows up by that.
    const rowKeys = [...new Set(r.new_keys.map((k) => k.slice(0, 300)))]
    const byId = new Map<number, StoredAlertRow>()
    for (const chunk of chunkArray(rowKeys, 1000)) {
      for (const row of (await db('nivaro_integration_signal_rows')
        .where({ signal: def.id })
        .whereNull('cleared_at')
        .whereIn('row_key', chunk)
        .select('id', 'row_key', 'alerted_at', 'payload')) as StoredAlertRow[]) {
        byId.set(row.id, row)
      }
    }
    // Rows nobody has been told about yet (an earlier delivery reached no one)
    // are offered again for a day after they appeared.
    for (const row of (await db('nivaro_integration_signal_rows')
      .where({ signal: def.id })
      .whereNull('cleared_at')
      .whereNull('alerted_at')
      .where('first_seen', '>=', retrySince)
      .select('id', 'row_key', 'alerted_at', 'payload')) as StoredAlertRow[]) {
      byId.set(row.id, row)
    }
    const stored = [...byId.values()]
    if (stored.length === 0) continue
    const fresh = selectAlertRows(def.id, stored, new Set(r.reoccurred_keys), snoozes, now)
    if (fresh.length === 0) continue

    await labelAlertRows(fresh.map((f) => f.row)).catch(() => undefined)
    const { subject, message } = alertMessage(
      def.label,
      fresh.map((f) => ({ title: f.row.title, again: f.again, label: f.row.record?.label }))
    )
    // One recipient's failure — or being dropped downstream (suspended,
    // redacted, muted) — must never silently count as "this went out"; a row
    // is only stamped alerted once SOMEONE actually heard about it, so a
    // total failure retries on the next cycle instead of going quiet forever.
    let delivered = 0
    for (const userId of recipients) {
      try {
        const result = await notifyUser(app, userId, {
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
        })
        if (!result?.decision?.dropped) delivered++
      } catch {
        // Keep going — the rest of the recipients still deserve a try.
      }
    }
    if (delivered === 0) {
      console.warn(
        `[integration-signal-alerts] ${def.id}: notifyUser reached none of ${recipients.length} recipient(s) — leaving ${fresh.length} row(s) unstamped for the next cycle to retry`
      )
      continue
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
 *
 * "New since yesterday" is whichever column actually marks a row ENTERING
 * the board within the window: `first_seen` for a genuinely brand-new row
 * (this table has no separate snapshot-insert-time column — `first_seen` IS
 * it), OR'd with `alerted_at` for a row that reoccurred — a reoccurrence
 * stays a plain UPDATE and never re-stamps `first_seen` (see
 * `SnapshotWritePlan.reoccurredKeys`), so `alerted_at` is the only column
 * that moves when the SAME row is surfaced again. KNOWN LIMITATION: a
 * reoccurring row with nobody subscribed real-time never sets `alerted_at`
 * either, so it will only ever count as fresh on its very first appearance —
 * closing that needs a dedicated "entered the board" column this schema
 * doesn't have.
 */
async function signalCounts(): Promise<Map<string, { open: number; fresh: number }>> {
  if (openCache && Date.now() - openCache.at < DIGEST_CACHE_MS) return openCache.bySignal
  const now = new Date()
  const since = now.getTime() - 86_400_000
  const snoozes = await loadActiveSnoozes()
  const rows = (await db('nivaro_integration_signal_rows')
    .whereNull('cleared_at')
    .select('signal', 'payload', 'first_seen', 'alerted_at')) as Array<{
    signal: string
    payload: string
    first_seen: Date
    alerted_at: Date | string | null
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
    const firstSeenFresh = new Date(r.first_seen).getTime() >= since
    const alertedFresh = r.alerted_at != null && new Date(r.alerted_at).getTime() >= since
    if (firstSeenFresh || alertedFresh) c.fresh++
    bySignal.set(r.signal, c)
  }
  openCache = { at: Date.now(), bySignal }
  return bySignal
}

/** Users with at least one digest subscription who are still a live admin —
 *  they get a daily summary even if nothing else would have sent them one. */
export async function integrationSignalsDigestAudience(): Promise<string[]> {
  const rows = (await db('nivaro_integration_signal_subscriptions')
    .where({ mode: 'digest' })
    .distinct('user')) as Array<{ user: string }>
  const ids = rows.map((r) => String(r.user))
  const allowed = await filterActiveAdminUserIds(ids)
  return ids.filter((id) => allowed.has(id.toUpperCase()))
}

/**
 * "Integration alerts" in the daily action summary — one line per subscribed
 * signal that has something open (every critical one for `*critical`),
 * linking to that signal on the console.
 */
export async function integrationSignalsDigest(userId: string): Promise<DigestSection | null> {
  // The daily digest runs for anyone with a digest reason at all, not just
  // this section's own audience — a demoted subscriber can still receive a
  // summary for something else, and must not see this section in it.
  const allowed = await filterActiveAdminUserIds([userId])
  if (!allowed.has(String(userId).toUpperCase())) return null

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
