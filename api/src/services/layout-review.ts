import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { computeLayoutHealth } from './layout-analysis.js'
import { listLayoutOwnerIds } from './layout-notify.js'
import { DAILY, SEEN, usageTablesReady, utcDay } from './layout-usage.js'
import { notifyUser } from './notification-channels.js'

/**
 * Review reminders (#2718): the owner of a form (#2656) is reminded to look
 * it over when it has not changed for a set number of months, with its health
 * score and its last 30 days of use in the notice. Again every that many
 * months while it stays unchanged; a change starts the count over.
 *
 * No migration: the months are core key/value settings (nivaro_extension_settings,
 * 'nivaro-core') — `layout_review_months` is the default for every owned form
 * (unset = 6, 0 = off), `layout_review:<layout id>` overrides it for one form
 * (0 = never). When the owner was last reminded is their own
 * nivaro_users.preferences.layout_review { <layout id>: ISO time }.
 * "Changed" = the newest saved version of the form (every save snapshots one),
 * else when the form was created. Daily cron `layout-review-reminders`.
 */

const CORE_EXT = 'nivaro-core'
const DEFAULT_KEY = 'layout_review_months'
const formKey = (layoutId: number) => `layout_review:${layoutId}`
const FORM_PREFIX = 'layout_review:'
const PREFS_KEY = 'layout_review'
export const DEFAULT_REVIEW_MONTHS = 6
export const MAX_REVIEW_MONTHS = 36

/** A months value as stored: whole months 0..36, null when unset or malformed. */
export function parseMonths(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > MAX_REVIEW_MONTHS) return null
  return n
}

/** `months` calendar months after `from` (UTC; the 31st clamps to the month's end). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d
}

/**
 * Is a reminder due? Unchanged for `months` since `changedAt`, and not
 * reminded since it changed, or reminded `months` ago or more.
 */
export function reviewDue(opts: {
  changedAt: Date | null
  months: number
  remindedAt: Date | null
  now: Date
}): boolean {
  const { changedAt, months, remindedAt, now } = opts
  if (!changedAt || months <= 0) return false
  if (addMonths(changedAt, months) > now) return false
  if (!remindedAt || remindedAt < changedAt) return true
  return addMonths(remindedAt, months) <= now
}

/** Whole months between two dates (at least 1 when `to` is after `from`). */
export function monthsBetween(from: Date, to: Date): number {
  let m = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth()
  if (to.getUTCDate() < from.getUTCDate()) m--
  return Math.max(0, m)
}

export interface ReviewUsage {
  opens: number
  saves: number
  abandons: number
  people: number
}

export interface ReviewHealth {
  score: number
  errors: number
  warnings: number
}

/** The notice an owner gets. */
export function reviewNotice(opts: {
  layoutName: string
  changedAt: Date
  now: Date
  health: ReviewHealth | null
  usage: ReviewUsage | null
}): { subject: string; message: string } {
  const months = Math.max(1, monthsBetween(opts.changedAt, opts.now))
  const subject = `Time to review the form “${opts.layoutName}”`
  const parts = [`It has not changed in ${months} month${months === 1 ? '' : 's'}.`]
  if (opts.health) {
    const issues: string[] = []
    if (opts.health.errors)
      issues.push(`${opts.health.errors} error${opts.health.errors === 1 ? '' : 's'}`)
    if (opts.health.warnings)
      issues.push(`${opts.health.warnings} warning${opts.health.warnings === 1 ? '' : 's'}`)
    parts.push(`Health ${opts.health.score}/100${issues.length ? ` (${issues.join(', ')})` : ''}.`)
  }
  if (opts.usage) {
    const u = opts.usage
    parts.push(
      u.opens === 0
        ? 'Nobody opened it in the last 30 days.'
        : `Last 30 days: opened ${u.opens.toLocaleString('en-US')} time${u.opens === 1 ? '' : 's'} by ${u.people.toLocaleString('en-US')} ${u.people === 1 ? 'person' : 'people'}, ${u.saves.toLocaleString('en-US')} save${u.saves === 1 ? '' : 's'}${u.abandons ? `, ${u.abandons.toLocaleString('en-US')} new record${u.abandons === 1 ? '' : 's'} left unfinished` : ''}.`
    )
  }
  parts.push('Open it to check it still fits how people work.')
  return { subject, message: parts.join(' ') }
}

// ─── Settings ───────────────────────────────────────────────────────────────

async function readSetting(key: string): Promise<string | null> {
  const row = (await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT, key })
    .first('value')) as { value: string | null } | undefined
  return row?.value ?? null
}

async function writeSetting(key: string, value: string | null): Promise<void> {
  if (value == null) {
    await db('nivaro_extension_settings').where({ extension_id: CORE_EXT, key }).delete()
    return
  }
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT, key })
    .first('id')) as { id: number } | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  else
    await db('nivaro_extension_settings').insert({
      extension_id: CORE_EXT,
      key,
      value,
      updated_at: new Date()
    })
}

export async function defaultReviewMonths(): Promise<number> {
  return parseMonths(await readSetting(DEFAULT_KEY)) ?? DEFAULT_REVIEW_MONTHS
}

/** Set one form's months (0 = never); null goes back to the default. */
export async function setFormReviewMonths(layoutId: number, months: number | null): Promise<void> {
  await writeSetting(formKey(layoutId), months == null ? null : String(months))
}

async function formOverrides(): Promise<Map<number, number>> {
  const rows = (await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT })
    .where('key', 'like', `${FORM_PREFIX}%`)
    .select('key', 'value')) as Array<{ key: string; value: string | null }>
  const out = new Map<number, number>()
  for (const r of rows) {
    const id = Number(r.key.slice(FORM_PREFIX.length))
    const m = parseMonths(r.value)
    if (Number.isInteger(id) && m != null) out.set(id, m)
  }
  return out
}

/** Newest saved version per layout (else its creation time). */
async function changedAt(layoutIds: number[]): Promise<Map<number, Date>> {
  const out = new Map<number, Date>()
  if (layoutIds.length === 0) return out
  const created = (await db('nivaro_collection_layouts')
    .whereIn('id', layoutIds)
    .select('id', 'created_at')) as Array<{ id: number; created_at: unknown }>
  for (const r of created) {
    const d = r.created_at ? new Date(String(r.created_at)) : null
    if (d && !Number.isNaN(d.getTime())) out.set(Number(r.id), d)
  }
  const versions = (await db('nivaro_layout_versions')
    .whereIn('layout_id', layoutIds)
    .groupBy('layout_id')
    .select('layout_id')
    .max({ at: 'created_at' })) as Array<{ layout_id: number; at: unknown }>
  for (const v of versions) {
    const d = v.at ? new Date(String(v.at)) : null
    if (!d || Number.isNaN(d.getTime())) continue
    const prev = out.get(Number(v.layout_id))
    if (!prev || d > prev) out.set(Number(v.layout_id), d)
  }
  return out
}

export interface ReviewInfo {
  /** This form's own months; null = the default applies. */
  months: number | null
  default_months: number
  /** What applies: 0 = no reminders. */
  effective_months: number
  last_changed_at: string | null
  /** When the owner would next be reminded if nothing changes (null = never). */
  next_at: string | null
}

export async function reviewInfo(layoutId: number): Promise<ReviewInfo> {
  const [own, def, changed] = await Promise.all([
    readSetting(formKey(layoutId)).then(parseMonths),
    defaultReviewMonths(),
    changedAt([layoutId])
  ])
  const effective = own ?? def
  const at = changed.get(layoutId) ?? null
  return {
    months: own,
    default_months: def,
    effective_months: effective,
    last_changed_at: at ? at.toISOString() : null,
    next_at: at && effective > 0 ? addMonths(at, effective).toISOString() : null
  }
}

// ─── The daily run ──────────────────────────────────────────────────────────

function parsePrefs(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return { ...(raw as Record<string, unknown>) }
  try {
    const v = JSON.parse(String(raw))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

async function usageLast30(layoutId: number): Promise<ReviewUsage | null> {
  if (!(await usageTablesReady())) return null
  const since = utcDay(new Date(Date.now() - 30 * 86_400_000))
  const [sums, people] = await Promise.all([
    db(DAILY)
      .where({ layout_id: layoutId })
      .where('day', '>=', since)
      .sum({ opens: 'opens', saves: 'saves', abandons: 'abandons' })
      .first() as Promise<Record<string, unknown> | undefined>,
    db(SEEN)
      .where({ layout_id: layoutId, kind: 'u' })
      .where('day', '>=', since)
      .countDistinct({ n: 'ref' })
      .first() as Promise<{ n?: unknown } | undefined>
  ])
  return {
    opens: Number(sums?.opens ?? 0),
    saves: Number(sums?.saves ?? 0),
    abandons: Number(sums?.abandons ?? 0),
    people: Number(people?.n ?? 0)
  }
}

function editorUrl(collection: string, layoutId: number): string | null {
  const base = adminBaseUrl()
  if (!base) return null
  return `${base}/data-model/${encodeURIComponent(collection)}?tab=groups&layout=${layoutId}`
}

/** Remind every owner whose form is due; returns a one-line summary for the job run. */
export async function runReviewReminders(app: FastifyInstance, now = new Date()): Promise<string> {
  const owners = await listLayoutOwnerIds()
  if (owners.size === 0) return 'No form has an owner'
  const ids = [...owners.keys()]
  const [def, overrides, changed, layouts] = await Promise.all([
    defaultReviewMonths(),
    formOverrides(),
    changedAt(ids),
    db('nivaro_collection_layouts')
      .whereIn('id', ids)
      .select('id', 'name', 'collection') as Promise<
      Array<{ id: number; name: string; collection: string }>
    >
  ])
  const layoutById = new Map(layouts.map((l) => [Number(l.id), l]))
  let sent = 0
  let due = 0
  for (const [layoutId, ownerId] of owners) {
    const layout = layoutById.get(layoutId)
    if (!layout) continue
    const months = overrides.get(layoutId) ?? def
    const at = changed.get(layoutId) ?? null
    if (!at || months <= 0) continue
    const owner = (await db('nivaro_users')
      .where({ id: ownerId })
      .first('id', 'status', 'is_redacted', 'preferences')) as
      | { id: string; status: string | null; is_redacted?: unknown; preferences?: unknown }
      | undefined
    if (owner?.status !== 'active' || owner.is_redacted) continue
    const prefs = parsePrefs(owner.preferences)
    const map = { ...((prefs[PREFS_KEY] as Record<string, string> | undefined) ?? {}) }
    const last = map[String(layoutId)] ? new Date(map[String(layoutId)]) : null
    const remindedAt = last && !Number.isNaN(last.getTime()) ? last : null
    if (!reviewDue({ changedAt: at, months, remindedAt, now })) continue
    due++
    let health: ReviewHealth | null = null
    try {
      const row = (await computeLayoutHealth(String(layout.collection))).find(
        (h) => h.layout_id === layoutId
      )
      if (row) health = { score: row.score, errors: row.counts.error, warnings: row.counts.warn }
    } catch {
      health = null
    }
    const usage = await usageLast30(layoutId).catch(() => null)
    const n = reviewNotice({ layoutName: String(layout.name), changedAt: at, now, health, usage })
    const url = editorUrl(String(layout.collection), layoutId)
    try {
      await notifyUser(app, String(owner.id), {
        subject: n.subject,
        message: n.message,
        category: 'watch',
        why: 'You own this form.',
        source: { kind: 'layout-review', label: String(layout.name), id: layoutId },
        target: url ? { kind: 'external', url } : null
      })
    } catch (err) {
      app.log.warn({ err, layoutId }, 'layout review reminder failed')
      continue
    }
    map[String(layoutId)] = now.toISOString()
    prefs[PREFS_KEY] = map
    await db('nivaro_users')
      .where({ id: owner.id })
      .update({ preferences: JSON.stringify(prefs) })
    sent++
  }
  return due === 0
    ? `No owned form is due for review (${owners.size} owned)`
    : `${sent} review reminder${sent === 1 ? '' : 's'} sent (${due} due, ${owners.size} owned)`
}
