import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { getCollection, getFields } from './collections.js'
import { announceRecordAspect } from './record-events.js'

/**
 * Scheduled changes apply themselves at their time (Rob, 2026-11-15).
 *
 * A minute job (`scheduled-changes-apply`, server.ts; ticks only where cronTicksEnabled(), one
 * process by the scheduler lease) takes every pending change that is due and applies it through
 * the items service AS THE PERSON WHO SCHEDULED IT: their update policy, row filter, User
 * Scopes, edit locks, field rules, validation and hooks all judge it again now, exactly as if
 * they pressed Save. Nothing is ever applied in part — one updateOne per change.
 *
 * - Claim first: `pending → applying` by a compare-and-set update, so two replicas (or the
 *   job and an administrator's Execute) never apply the same change twice. A claim older than
 *   APPLY_STALE_MS (the process died mid-apply) becomes `failed` with a reason to check.
 * - Someone else changed a scheduled field after it was scheduled (its value then is kept with
 *   the change): `failed`, "Status was changed by someone else after this was scheduled".
 * - Refused (no longer allowed, out of scope, locked after approval…): `failed` with the plain
 *   reason. A record open for editing by someone else waits (back to pending) for up to
 *   LOCK_WAIT_MS past its time, then fails.
 * - Applied: `executed`, an activity row, the scheduler is told ("Applied: Status → Closed on
 *   CM26-80394"), and for UNDO_WINDOW_MS the scheduler (or an administrator) can put the
 *   previous values back from the record.
 * - Off per collection (`browser_config.scheduled_auto_apply: false`): changes there wait for an
 *   administrator's Execute, as before.
 *
 * Bookkeeping per change (values when scheduled, values before applying, the undo deadline, who
 * applied it) is JSON in `apply_meta` (migration 528, nvarchar(max)), never sent to clients.
 * Rows written before that migration kept it in `inngest_event_id`; `readMeta` falls back to it.
 */

export const APPLY_STALE_MS = 15 * 60_000
export const UNDO_WINDOW_MS = 24 * 3600_000
export const LOCK_WAIT_MS = 60 * 60_000
const META_COLUMN = 'apply_meta'
/** Where rows written before migration 528 kept the same JSON (read only). */
const LEGACY_META_COLUMN = 'inngest_event_id'
const TABLE = 'nivaro_scheduled_changes'

export interface ScheduleMeta {
  v: 1
  /** The scheduled fields' values when the change was made (conflict check). */
  at?: Record<string, unknown>
  /** The fields' values just before it was applied (undo). */
  before?: Record<string, unknown>
  /** Undo allowed until (ISO). */
  undo_until?: string
  /** 'schedule' = applied on time by the job; else the administrator who pressed Execute. */
  applied_by?: string
}

export function decodeMeta(raw: unknown): ScheduleMeta {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return { v: 1 }
  try {
    const m = JSON.parse(raw) as ScheduleMeta
    return m && typeof m === 'object' && m.v === 1 ? m : { v: 1 }
  } catch {
    return { v: 1 }
  }
}

/** A change row's bookkeeping: `apply_meta`, else (rows from before migration 528) the legacy column. */
export function readMeta(row: Record<string, unknown> | null | undefined): ScheduleMeta {
  if (!row) return { v: 1 }
  const now = row[META_COLUMN]
  if (typeof now === 'string' && now.startsWith('{')) return decodeMeta(now)
  return decodeMeta(row[LEGACY_META_COLUMN])
}

/** JSON for `apply_meta` (no size limit: nvarchar(max)). */
export function encodeMeta(m: ScheduleMeta): string {
  return JSON.stringify(m)
}

/** Loose equality for stored values (a decimal read back as a string, a date as a Date). */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return ''
    if (v instanceof Date) return String(v.getTime())
    if (typeof v === 'boolean') return v ? '1' : '0'
    if (typeof v === 'number') return String(v)
    const s = String(v)
    if (/^-?\d+(\.\d+)?$/.test(s.trim())) return String(Number(s))
    const t = Date.parse(s)
    if (/^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(t)) return String(t)
    if (s === 'true' || s === 'false') return s === 'true' ? '1' : '0'
    return s
  }
  return norm(a) === norm(b)
}

/**
 * Why the change must not go in, or null: a scheduled field someone else moved after it was
 * scheduled (it holds neither its value then nor the scheduled value). Fields with no snapshot
 * are not judged.
 */
export function conflictReason(
  changes: Record<string, unknown>,
  at: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
  labelOf: (field: string) => string
): string | null {
  if (!at) return null
  for (const [k, target] of Object.entries(changes)) {
    if (!(k in at)) continue
    const now = current[k]
    if (sameValue(now, at[k]) || sameValue(now, target)) continue
    return `${labelOf(k)} was changed by someone else after this was scheduled`
  }
  return null
}

export interface ChangeRow {
  id: string
  collection: string
  item_id: string
  change_type?: string
  changes: unknown
  scheduled_at: Date | string
  status: string
  executed_at?: Date | string | null
  error_message?: string | null
  created_by?: string | null
  [k: string]: unknown
}

function parseChanges(raw: unknown): Record<string, unknown> | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Compare-and-set claim: true when this caller moved the row from `pending` to `applying`. */
export async function claimChange(id: string, now = new Date()): Promise<boolean> {
  const n = await db(TABLE)
    .where({ id, status: 'pending' })
    .update({ status: 'applying', executed_at: now })
  return Number(Array.isArray(n) ? n[0] : n) === 1
}

/** Is automatic applying on for this collection? (default on) */
export async function autoApplyOn(collection: string): Promise<boolean> {
  const c = (await getCollection(collection).catch(() => undefined)) as
    | { browser_config?: unknown }
    | undefined
  let bc = c?.browser_config
  if (typeof bc === 'string') {
    try {
      bc = JSON.parse(bc)
    } catch {
      bc = null
    }
  }
  return !(
    bc &&
    typeof bc === 'object' &&
    (bc as { scheduled_auto_apply?: unknown }).scheduled_auto_apply === false
  )
}

async function fieldWords(collection: string) {
  const fields = await getFields(collection).catch(() => [])
  const by = new Map(fields.map((f) => [f.field, f]))
  const labelOf = (k: string) => {
    const f = by.get(k) as { label?: string | null } | undefined
    return f?.label || k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  }
  const textOf = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return '(empty)'
    let opts = (by.get(k) as { options?: unknown } | undefined)?.options
    if (typeof opts === 'string') {
      try {
        opts = JSON.parse(opts)
      } catch {
        opts = null
      }
    }
    const choices = (opts as { choices?: Array<{ text?: string; value?: unknown }> } | null)
      ?.choices
    const hit = Array.isArray(choices) ? choices.find((c) => sameValue(c.value, v)) : null
    return String(hit?.text ?? v).slice(0, 60)
  }
  return { labelOf, textOf }
}

/** "Status → Closed" / "Status and 2 more fields". */
export function changeWords(
  changes: Record<string, unknown>,
  labelOf: (k: string) => string,
  textOf: (k: string, v: unknown) => string
): string {
  const keys = Object.keys(changes)
  if (keys.length === 0) return 'A change'
  if (keys.length > 1)
    return `${labelOf(keys[0])} and ${keys.length - 1} more field${keys.length === 2 ? '' : 's'}`
  return `${labelOf(keys[0])} → ${textOf(keys[0], changes[keys[0]])}`
}

/** A request standing in for the scheduler when the job applies a change (no HTTP request). */
export function schedulerRequest(app: FastifyInstance | null): FastifyRequest {
  return {
    headers: { 'user-agent': 'nivaro-scheduled-changes' },
    query: {},
    params: {},
    ip: '127.0.0.1',
    server: app ?? undefined,
    log: app?.log,
    authMethod: 'session',
    id: 'scheduled-changes'
  } as unknown as FastifyRequest
}

export interface ApplyDeps {
  execute: (
    req: FastifyRequest,
    change: ChangeRow,
    changes: Record<string, unknown>
  ) => Promise<
    { ok: true } | { ok: false; status: number; error: string; extra?: Record<string, unknown> }
  >
  notify: (
    userId: string,
    opts: { subject: string; message: string; collection: string; item: string }
  ) => Promise<void>
  label: (userId: string, collection: string, item: string) => Promise<string>
  now: () => Date
}

export type ApplyOutcome =
  | { outcome: 'applied' }
  | { outcome: 'failed'; reason: string; status: number }
  | { outcome: 'waiting'; reason: string }
  | { outcome: 'skipped' }

/**
 * Apply one claimed change (status `applying`). Writes the final status, the activity row and
 * the scheduler's notice; never throws.
 */
export async function applyClaimed(
  app: FastifyInstance | null,
  change: ChangeRow,
  deps: ApplyDeps,
  opts: { req?: FastifyRequest; manualBy?: string | null } = {}
): Promise<ApplyOutcome> {
  const now = deps.now()
  const meta = readMeta(change)
  const { labelOf, textOf } = await fieldWords(change.collection)
  const changes = parseChanges(change.changes)
  const scheduler = change.created_by ? String(change.created_by) : null
  const words = changes ? changeWords(changes, labelOf, textOf) : 'A scheduled change'
  const finish = async (
    status: 'executed' | 'failed',
    reason: string | null,
    extra: ScheduleMeta = meta
  ) => {
    await db(TABLE)
      .where({ id: change.id, status: 'applying' })
      .update({
        status,
        executed_at: now,
        error_message: reason ? reason.slice(0, 500) : null,
        [META_COLUMN]: encodeMeta(extra)
      })
    announceRecordAspect(change.collection, change.item_id, '$scheduled')
  }
  const tell = async (subject: string, message: string) => {
    if (!scheduler) return
    await deps
      .notify(scheduler, {
        subject,
        message,
        collection: change.collection,
        item: String(change.item_id)
      })
      .catch(() => {})
  }
  const fail = async (reason: string, status = 409): Promise<ApplyOutcome> => {
    await finish('failed', reason)
    const label = scheduler
      ? await deps.label(scheduler, change.collection, String(change.item_id)).catch(() => '')
      : ''
    await tell(
      `Not applied: ${words}${label ? ` on ${label}` : ''}`,
      `Your scheduled change was not applied: ${reason}. Nothing on the record was changed.`
    )
    await logActivity({
      action: 'schedule-change-failed',
      user: scheduler,
      collection: change.collection,
      item: String(change.item_id),
      comment: reason.slice(0, 300),
      origin: 'machine'
    }).catch(() => {})
    return { outcome: 'failed', reason, status }
  }
  try {
    if (!changes || Object.keys(changes).length === 0)
      return await fail('The stored change is not a set of field values')
    const current = (await db(change.collection)
      .where({ id: change.item_id })
      .first(...Object.keys(changes).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)))
      .catch(() => null)) as Record<string, unknown> | null | undefined
    // No row read here: the write as the scheduler below says what is wrong (gone, hidden).
    const conflict = current ? conflictReason(changes, meta.at, current, labelOf) : null
    if (conflict) return await fail(conflict)
    const before: Record<string, unknown> | undefined = current ? {} : undefined
    if (current && before)
      for (const k of Object.keys(changes))
        before[k] =
          current[k] instanceof Date ? (current[k] as Date).toISOString() : (current[k] ?? null)
    const base = opts.req ?? schedulerRequest(app)
    const done = await deps.execute(base, change, changes)
    if (!done.ok) {
      const locked = (done.extra as { code?: string } | undefined)?.code === 'RECORD_LOCKED'
      const due = new Date(change.scheduled_at).getTime()
      if (locked && !opts.req && now.getTime() - due < LOCK_WAIT_MS) {
        // Someone has the record open for editing: try again next minute.
        await db(TABLE)
          .where({ id: change.id, status: 'applying' })
          .update({ status: 'pending', executed_at: null })
        return { outcome: 'waiting', reason: done.error }
      }
      return await fail(done.error, done.status)
    }
    const applied: ScheduleMeta = {
      v: 1,
      at: meta.at,
      ...(before
        ? { before, undo_until: new Date(now.getTime() + UNDO_WINDOW_MS).toISOString() }
        : {}),
      applied_by: opts.manualBy ?? 'schedule'
    }
    await finish('executed', null, applied)
    await logActivity({
      action: 'schedule-change-applied',
      user: scheduler,
      collection: change.collection,
      item: String(change.item_id),
      comment: opts.manualBy
        ? 'Applied early by an administrator'
        : 'Applied at its scheduled time',
      origin: 'machine'
    }).catch(() => {})
    const label = scheduler
      ? await deps.label(scheduler, change.collection, String(change.item_id)).catch(() => '')
      : ''
    await tell(
      `Applied: ${words}${label ? ` on ${label}` : ''}`,
      'Your scheduled change was applied. You can undo it from the record for 24 hours.'
    )
    return { outcome: 'applied' }
  } catch (err) {
    console.warn({ err, id: change.id }, 'Scheduled change apply failed')
    return await fail('Something went wrong while applying it', 500).catch(() => ({
      outcome: 'failed' as const,
      reason: 'error',
      status: 500
    }))
  }
}

/** The real dependencies (the route's executeAsCreator, notifyUser, labels as the scheduler). */
export async function defaultApplyDeps(app: FastifyInstance | null): Promise<ApplyDeps> {
  const { executeAsCreator } = await import('../routes/scheduled-changes.js')
  return {
    execute: (req, change, changes) => executeAsCreator(req, change, changes),
    notify: async (userId, o) => {
      if (!app) return
      const { notifyUser } = await import('./notification-channels.js')
      await notifyUser(app, userId, {
        subject: o.subject,
        message: o.message,
        collection: o.collection,
        item: o.item,
        category: 'workflow',
        source: { kind: 'scheduled-change', label: 'Scheduled change' }
      })
    },
    label: async (userId, collection, item) => {
      const user = (await db('nivaro_users').where({ id: userId }).first()) as User | undefined
      if (!user) return ''
      const { recordLabelsAsViewer } = await import('./record-labels-as-viewer.js')
      const out = await recordLabelsAsViewer(user, [{ collection, id: item }])
      return out[`${collection}:${item}`] ?? ''
    },
    now: () => new Date()
  }
}

/** The minute job: recover stale claims, then apply every due change in collections where it is on. */
export async function runScheduledChanges(
  app: FastifyInstance | null,
  deps?: ApplyDeps,
  opts: { limit?: number } = {}
): Promise<{ applied: number; failed: number; waiting: number; skipped: number }> {
  const d = deps ?? (await defaultApplyDeps(app))
  const now = d.now()
  const out = { applied: 0, failed: 0, waiting: 0, skipped: 0 }
  const stale = (await db(TABLE)
    .where({ status: 'applying' })
    .where('executed_at', '<', new Date(now.getTime() - APPLY_STALE_MS))
    .select('id', 'collection', 'item_id')) as Array<{
    id: string
    collection: string
    item_id: string
  }>
  for (const s of stale) {
    const n = await db(TABLE).where({ id: s.id, status: 'applying' }).update({
      status: 'failed',
      error_message: 'It stopped while being applied — check the record before scheduling it again'
    })
    if (Number(n) > 0) announceRecordAspect(s.collection, s.item_id, '$scheduled')
  }
  const due = (await db(TABLE)
    .where({ status: 'pending' })
    .where('scheduled_at', '<=', now)
    .orderBy('scheduled_at', 'asc')
    .limit(opts.limit ?? 50)) as ChangeRow[]
  const onByCollection = new Map<string, boolean>()
  for (const row of due) {
    let on = onByCollection.get(row.collection)
    if (on === undefined) {
      on = await autoApplyOn(row.collection)
      onByCollection.set(row.collection, on)
    }
    if (!on) {
      out.skipped++
      continue
    }
    if (!(await claimChange(row.id, now))) {
      out.skipped++
      continue
    }
    const r = await applyClaimed(app, { ...row, status: 'applying' }, d)
    if (r.outcome === 'applied') out.applied++
    else if (r.outcome === 'failed') out.failed++
    else if (r.outcome === 'waiting') out.waiting++
  }
  return out
}

export { LEGACY_META_COLUMN as SCHEDULE_LEGACY_META_COLUMN, META_COLUMN as SCHEDULE_META_COLUMN }
