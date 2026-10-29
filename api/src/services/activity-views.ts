import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { type ActivityExportRow, activityCsv, fetchActivityRows } from './activity-export.js'
import {
  type ActivityFilters,
  activityWindow,
  normalizeActivityFilters
} from './activity-filters.js'
import { type DesiredSchedule, reconcile, registerScheduleResync } from './row-schedules.js'

/**
 * Saved audit views (#11, migration 517): a named ActivityFilters set, personal or shared with
 * every administrator, optionally emailed on a schedule.
 *
 * Share rules (every route is administrators-only — the audit log is):
 *   see   = mine, shared, or a system view (owner NULL)
 *   edit  = mine, or a system view
 *   A shared view someone else owns is read-only to the rest ("Save as" makes your own copy).
 *
 * A scheduled send is rendered PER RECIPIENT: an active administrator gets the view; anyone
 * else gets it only when the view is their own trail (filters.user = them); everyone else is
 * skipped and named in last_send_status. Recipients are user ids, never bare addresses, so each
 * one can be judged.
 */

export const TABLE = 'nivaro_activity_views'
export const VIEW_SCHEDULE_PREFIX = 'activity-view-'
const CRON_RE = /^(\S+\s+){4}\S+$/
const MAX_RECIPIENTS = 50
const MAIL_ROW_CAP = 5_000

export interface ActivityViewRow {
  id: number
  name: string
  owner: string | null
  filters: string | null
  shared: boolean | number | null
  schedule: string | null
  recipients: string | null
  last_sent_at: Date | string | null
  last_send_status: string | null
  created_at: Date | string
  updated_at: Date | string
}

export interface ActivityView {
  id: number
  name: string
  owner: string | null
  filters: ActivityFilters
  shared: boolean
  schedule: string | null
  recipients: string[]
  last_sent_at: string | null
  last_send_status: string | null
  created_at: string | null
  updated_at: string | null
  /** For the caller: may they change it. */
  editable?: boolean
  system?: boolean
}

const isoOrNull = (v: unknown) => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function parseList(raw: unknown): string[] {
  if (raw == null) return []
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseFilters(raw: unknown): ActivityFilters {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      v = {}
    }
  }
  return normalizeActivityFilters(v).filters
}

const sameId = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

export function formatView(row: ActivityViewRow, viewerId?: string | null): ActivityView {
  const view: ActivityView = {
    id: Number(row.id),
    name: row.name,
    owner: row.owner ?? null,
    filters: parseFilters(row.filters),
    shared: !!row.shared,
    schedule: row.schedule || null,
    recipients: parseList(row.recipients),
    last_sent_at: isoOrNull(row.last_sent_at),
    last_send_status: row.last_send_status ?? null,
    created_at: isoOrNull(row.created_at),
    updated_at: isoOrNull(row.updated_at),
    system: row.owner == null
  }
  if (viewerId !== undefined) view.editable = canEditView(view, viewerId)
  return view
}

export function canSeeView(view: Pick<ActivityView, 'owner' | 'shared'>, userId: string): boolean {
  return view.owner == null || view.shared || sameId(view.owner, userId)
}

export function canEditView(view: Pick<ActivityView, 'owner'>, userId: string | null): boolean {
  return view.owner == null || sameId(view.owner, userId)
}

export interface ViewInput {
  name?: string
  filters?: ActivityFilters
  shared?: boolean
  schedule?: string | null
  recipients?: string[]
}

/** Body → a validated write. `partial` = PATCH (absent keys untouched). */
export function validateViewInput(
  body: unknown,
  opts: { partial: boolean }
): { value: ViewInput } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const out: ViewInput = {}
  if (b.name !== undefined || !opts.partial) {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return { error: 'name is required' }
    if (name.length > 120) return { error: 'name is at most 120 characters' }
    out.name = name
  }
  if (b.filters !== undefined || !opts.partial) {
    const { filters, errors } = normalizeActivityFilters(b.filters ?? {})
    if (errors.length) return { error: errors.join('; ') }
    out.filters = filters
  }
  if (b.shared !== undefined) out.shared = b.shared === true || b.shared === 1 || b.shared === '1'
  if (b.schedule !== undefined) {
    const s = typeof b.schedule === 'string' ? b.schedule.trim() : ''
    if (s && !CRON_RE.test(s)) return { error: 'schedule must be a 5-part cron expression' }
    out.schedule = s || null
  }
  if (b.recipients !== undefined) {
    if (!Array.isArray(b.recipients)) return { error: 'recipients must be a list of user ids' }
    const ids = [...new Set(b.recipients.map((r) => String(r ?? '').trim()).filter(Boolean))]
    if (ids.some((r) => !/^[0-9a-f-]{36}$/i.test(r)))
      return { error: 'recipients must be user ids' }
    if (ids.length > MAX_RECIPIENTS) return { error: `at most ${MAX_RECIPIENTS} recipients` }
    out.recipients = ids
  }
  return { value: out }
}

// ─── store ───────────────────────────────────────────────────────────────────

export async function listViews(userId: string): Promise<ActivityView[]> {
  const rows = (await db(TABLE)
    .where((w) => {
      w.where('owner', userId).orWhere('shared', true).orWhereNull('owner')
    })
    .orderBy('name')) as ActivityViewRow[]
  return rows.map((r) => formatView(r, userId)).filter((v) => canSeeView(v, userId))
}

export async function getView(id: number): Promise<ActivityView | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  const row = (await db(TABLE).where({ id }).first()) as ActivityViewRow | undefined
  return row ? formatView(row) : null
}

function toRow(v: ViewInput): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  if (v.name !== undefined) row.name = v.name
  if (v.filters !== undefined) row.filters = JSON.stringify(v.filters)
  if (v.shared !== undefined) row.shared = v.shared
  if (v.schedule !== undefined) row.schedule = v.schedule
  if (v.recipients !== undefined) row.recipients = JSON.stringify(v.recipients)
  return row
}

export async function createView(owner: string, v: ViewInput): Promise<ActivityView> {
  const now = new Date()
  await db(TABLE).insert({
    shared: false,
    recipients: '[]',
    ...toRow(v),
    owner,
    created_at: now,
    updated_at: now
  })
  // Insert-then-select (no .returning on this stack's identity tables).
  const row = (await db(TABLE)
    .where({ owner, name: v.name as string })
    .orderBy('id', 'desc')
    .first()) as ActivityViewRow
  return formatView(row, owner)
}

export async function updateView(id: number, v: ViewInput): Promise<void> {
  const row = toRow(v)
  if (Object.keys(row).length === 0) return
  await db(TABLE)
    .where({ id })
    .update({ ...row, updated_at: new Date() })
}

export async function deleteView(id: number): Promise<void> {
  await db(TABLE).where({ id }).del()
}

// ─── scheduled send ──────────────────────────────────────────────────────────

export interface RecipientUser {
  id: string
  email: string | null
  first_name?: string | null
  status?: string | null
  is_redacted?: boolean | number | null
  isAdmin: boolean
}

export type RecipientPlan =
  | { user: RecipientUser; filters: ActivityFilters }
  | { user: RecipientUser; skip: string }

/** Who gets what. Pure; exported for tests. */
export function planRecipients(view: ActivityView, users: RecipientUser[]): RecipientPlan[] {
  return users.map((user) => {
    if (!user.email) return { user, skip: 'no email address' }
    if (user.is_redacted || (user.status && user.status !== 'active'))
      return { user, skip: 'not an active account' }
    if (user.isAdmin) return { user, filters: view.filters }
    if (sameId(view.filters.user, user.id)) return { user, filters: view.filters }
    return { user, skip: 'audit views go to administrators only' }
  })
}

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function topCounts(rows: ActivityExportRow[], key: 'action' | 'collection', n = 5) {
  const m = new Map<string, number>()
  for (const r of rows) {
    const k = String(r[key] ?? '—')
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}

/** The short summary above the CSV. Pure; exported for tests. */
export function viewSummaryHtml(
  view: ActivityView,
  rows: ActivityExportRow[],
  truncated: boolean,
  recipientName: string | null,
  now = new Date()
): string {
  const w = activityWindow(view.filters, now)
  const span = w.from
    ? `${w.from.toISOString().slice(0, 10)} to ${(w.to ?? now).toISOString().slice(0, 10)}`
    : 'all time'
  const list = (pairs: Array<[string, number]>) =>
    pairs.map(([k, n]) => `<li>${esc(k)}: <strong>${n}</strong></li>`).join('')
  const greeting = recipientName ? `<p>Hi ${esc(recipientName)},</p>` : ''
  if (rows.length === 0) {
    return `${greeting}<p>No entries matched <strong>${esc(view.name)}</strong> (${esc(span)}).</p>`
  }
  return `${greeting}<p><strong>${rows.length}${truncated ? '+' : ''}</strong> entries matched <strong>${esc(
    view.name
  )}</strong> (${esc(span)}). The full list is attached as CSV${
    truncated ? ` (first ${rows.length})` : ''
  }.</p><p>By action:</p><ul>${list(topCounts(rows, 'action'))}</ul><p>By collection:</p><ul>${list(
    topCounts(rows, 'collection')
  )}</ul>`
}

export interface SendDeps {
  loadRecipients: (ids: string[]) => Promise<RecipientUser[]>
  fetchRows: (
    filters: ActivityFilters
  ) => Promise<{ rows: ActivityExportRow[]; truncated: boolean }>
  send: (mail: {
    to: string
    subject: string
    html: string
    attachments: Array<{ filename: string; content: Buffer; contentType: string }>
  }) => Promise<unknown>
  markSent: (id: number, status: string) => Promise<void>
  now?: () => Date
}

export async function defaultLoadRecipients(ids: string[]): Promise<RecipientUser[]> {
  if (ids.length === 0) return []
  const rows = (await db('nivaro_users')
    .whereIn('id', ids)
    .select('id', 'email', 'first_name', 'status', 'is_redacted', 'role')) as Array<
    RecipientUser & { role: string | null }
  >
  const { isAdminRole } = await import('./user-scopes.js')
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      email: r.email,
      first_name: r.first_name,
      status: r.status,
      is_redacted: r.is_redacted,
      isAdmin: await isAdminRole(r.role).catch(() => false)
    }))
  )
}

const defaultDeps = (): SendDeps => ({
  loadRecipients: defaultLoadRecipients,
  fetchRows: (filters) => fetchActivityRows(filters, { limit: MAIL_ROW_CAP }),
  send: async (mail) => {
    const { sendRawMail } = await import('./mail.js')
    return sendRawMail({ ...mail, category: 'reports', template: 'activity-view' })
  },
  markSent: async (id, status) => {
    await db(TABLE)
      .where({ id })
      .update({ last_sent_at: new Date(), last_send_status: status.slice(0, 300) })
  }
})

/** Email the view to each recipient, rendered for that recipient. */
export async function sendActivityView(
  view: ActivityView,
  deps: SendDeps = defaultDeps()
): Promise<{ sent: number; skipped: Array<{ user: string; reason: string }> }> {
  const now = deps.now?.() ?? new Date()
  const users = await deps.loadRecipients(view.recipients)
  const plan = planRecipients(view, users)
  const missing = view.recipients.filter((id) => !users.some((u) => sameId(u.id, id)))
  const skipped = [
    ...missing.map((id) => ({ user: id, reason: 'no such user' })),
    ...plan
      .filter((p): p is Extract<RecipientPlan, { skip: string }> => 'skip' in p)
      .map((p) => ({ user: p.user.id, reason: p.skip }))
  ]
  let sent = 0
  const stamp = now.toISOString().slice(0, 10)
  const safeName = view.name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'activity'
  // One read per distinct filter set (admins share one).
  const cache = new Map<string, Promise<{ rows: ActivityExportRow[]; truncated: boolean }>>()
  for (const p of plan) {
    if ('skip' in p) continue
    const key = JSON.stringify(p.filters)
    let read = cache.get(key)
    if (!read) {
      read = deps.fetchRows(p.filters)
      cache.set(key, read)
    }
    const { rows, truncated } = await read
    await deps.send({
      to: p.user.email as string,
      subject: `${view.name} — ${stamp}`,
      html: viewSummaryHtml(view, rows, truncated, p.user.first_name ?? null, now),
      attachments: [
        {
          filename: `${safeName}-${stamp}.csv`,
          content: Buffer.from(activityCsv(rows), 'utf8'),
          contentType: 'text/csv'
        }
      ]
    })
    sent++
  }
  const status =
    `sent to ${sent} recipient(s)` +
    (skipped.length
      ? `; skipped ${skipped.length} (${[...new Set(skipped.map((s) => s.reason))].join(', ')})`
      : '')
  await deps.markSent(view.id, status)
  return { sent, skipped }
}

// ─── cron roster ─────────────────────────────────────────────────────────────
// Registered on import: server boot imports this module and resyncs 'activity-views';
// the routes resync after every write (row-schedules.ts resyncAfterWrites).

registerScheduleResync('activity-views', async (app: FastifyInstance) => {
  const rows = (await db(TABLE)
    .whereNotNull('schedule')
    .select('id', 'name', 'schedule')) as Array<{ id: number; name: string; schedule: string }>
  const desired = new Map<string, DesiredSchedule>()
  for (const r of rows) {
    if (!String(r.schedule ?? '').trim()) continue
    desired.set(`${VIEW_SCHEDULE_PREFIX}${r.id}`, {
      expression: String(r.schedule),
      description: `Audit view email: ${r.name}`,
      run: async () => {
        try {
          const fresh = await getView(Number(r.id))
          if (!fresh?.schedule) return
          await sendActivityView(fresh)
        } catch (err) {
          app.log.error({ err }, `[activity-views] view ${r.id} send failed`)
          throw err // the job run records the failure (Jobs)
        }
      }
    })
  }
  return reconcile(app, VIEW_SCHEDULE_PREFIX, desired)
})
