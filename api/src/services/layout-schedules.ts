import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { clearMetadataCache } from './collections.js'
import { announceConfigChanged } from './config-live.js'
import { getApp } from './io-holder.js'
import {
  applyLayoutOps,
  type LayoutBundle,
  type LayoutOp,
  loadLayoutBundle,
  runLayoutOps
} from './layout-ops.js'
import { bustLayoutReferences } from './layout-references.js'
import { bustSectionLockCache } from './section-locks.js'

/**
 * Scheduled layout changes (#2590). The editor's unsaved ops, the rev they
 * were made against and a time: the `layout-schedules` cron applies due rows
 * through runLayoutOps — the same path a Save takes, so the change gets a
 * version ("Scheduled change by …"), history and a new rev like any other.
 *
 * When the layout moved since the change was scheduled, the ops are folded
 * onto the layout as it is now; they apply only if every one still fits,
 * otherwise the row fails and the person who scheduled it is told (through
 * notifyUser, never raw rows). Each row is claimed (pending → running) before
 * anything else, so two processes never apply one twice.
 */

export type ScheduleStatus = 'pending' | 'running' | 'applied' | 'failed' | 'cancelled'

export interface ScheduleRow {
  id: number
  layout_id: number
  layout_name: string | null
  collection: string
  note: string | null
  run_at: string
  status: ScheduleStatus
  error: string | null
  op_count: number
  created_by: string | null
  created_by_name: string | null
  created_at: string | null
  updated_by_name: string | null
  applied_at: string | null
}

export class ScheduleError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

const TABLE = 'nivaro_layout_schedules'
/** Failed rows stay on the overview this long (or until dismissed). */
const FAILED_SHOWN_MS = 7 * 24 * 3600_000
const MAX_OPS = 5000
/** A 'running' row older than this was interrupted. */
const STUCK_MS = 10 * 60_000

// Migration 457 creates the table; until it has run, scheduling answers 503
// and the cron does nothing. Present is remembered; missing is re-checked.
let tableCheck: { has: boolean; at: number } | null = null
export async function schedulesAvailable(): Promise<boolean> {
  if (tableCheck && (tableCheck.has || Date.now() - tableCheck.at < 60_000)) return tableCheck.has
  let has = false
  try {
    has = await db.schema.hasTable(TABLE)
  } catch {
    has = false
  }
  tableCheck = { has, at: Date.now() }
  return has
}

const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString()

function parseOps(v: unknown): LayoutOp[] {
  try {
    const ops = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(ops) ? (ops as LayoutOp[]) : []
  } catch {
    return []
  }
}

/** The run time an admin asked for: a real date, not in the past (a minute's grace). */
export function parseRunAt(v: unknown, now = new Date()): Date {
  const d = typeof v === 'string' || typeof v === 'number' ? new Date(v) : null
  if (!d || Number.isNaN(d.getTime())) throw new ScheduleError(400, 'run_at must be a date')
  if (d.getTime() < now.getTime() - 60_000)
    throw new ScheduleError(400, 'Pick a time in the future')
  if (d.getTime() > now.getTime() + 366 * 24 * 3600_000)
    throw new ScheduleError(400, 'Pick a time within the next year')
  return d
}

/**
 * Fold the scheduled ops onto the layout as it is now. null = they all fit
 * (the batch can run against `bundle.rev`); otherwise the reason one does not.
 */
export function foldScheduled(bundle: LayoutBundle, ops: LayoutOp[]): string | null {
  try {
    applyLayoutOps(bundle, ops)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

async function userName(id: string | null | undefined): Promise<string | null> {
  if (!id) return null
  const u = (await db('nivaro_users').where({ id }).first('first_name', 'last_name')) as
    | { first_name: string | null; last_name: string | null }
    | undefined
  const n = `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim()
  return n || null
}

export async function createSchedule(input: {
  layoutId: number
  ops: unknown
  base_rev: unknown
  run_at: unknown
  note?: unknown
  userId: string | null
}): Promise<ScheduleRow> {
  if (!Array.isArray(input.ops) || input.ops.length === 0)
    throw new ScheduleError(400, 'Nothing to schedule')
  if (input.ops.length > MAX_OPS)
    throw new ScheduleError(400, `At most ${MAX_OPS} changes per schedule`)
  if (typeof input.base_rev !== 'string' || !input.base_rev)
    throw new ScheduleError(400, 'base_rev required')
  const runAt = parseRunAt(input.run_at)
  const bundle = await loadLayoutBundle(db, input.layoutId)
  if (!bundle) throw new ScheduleError(404, 'Not found')
  const ops = input.ops as LayoutOp[]
  // Checked now so a change that cannot apply is never scheduled to fail later.
  const misfit = foldScheduled(bundle, ops)
  if (misfit)
    throw new ScheduleError(
      400,
      bundle.rev === input.base_rev
        ? `These changes cannot be applied: ${misfit}`
        : `Someone else saved this layout and these changes no longer fit: ${misfit}`
    )
  const note =
    typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 255) : null
  await db(TABLE).insert({
    layout_id: input.layoutId,
    collection: String(bundle.layout.collection ?? ''),
    ops: JSON.stringify(ops),
    base_rev: input.base_rev.slice(0, 128),
    note,
    run_at: runAt,
    status: 'pending',
    created_by: input.userId,
    created_at: new Date()
  })
  const row = (await db(TABLE)
    .where({ layout_id: input.layoutId, created_by: input.userId, status: 'pending' })
    .orderBy('id', 'desc')
    .first('id')) as { id: number }
  const [view] = await listSchedules({ ids: [Number(row.id)] })
  return view
}

export async function listSchedules(filter: {
  collection?: string
  layoutId?: number
  ids?: number[]
}): Promise<ScheduleRow[]> {
  const since = new Date(Date.now() - FAILED_SHOWN_MS)
  const rows = (await db(`${TABLE} as s`)
    .leftJoin('nivaro_collection_layouts as l', 's.layout_id', 'l.id')
    .leftJoin('nivaro_users as u', 's.created_by', 'u.id')
    .leftJoin('nivaro_users as w', 's.updated_by', 'w.id')
    .modify((q) => {
      if (filter.ids) q.whereIn('s.id', filter.ids)
      else
        q.where((w) =>
          w
            .whereIn('s.status', ['pending', 'running'])
            .orWhere((f) => f.where('s.status', 'failed').where('s.updated_at', '>=', since))
        )
      if (filter.collection) q.where('s.collection', filter.collection)
      if (filter.layoutId != null) q.where('s.layout_id', filter.layoutId)
    })
    .orderBy('s.run_at', 'asc')
    .select(
      's.id',
      's.layout_id',
      'l.name as layout_name',
      's.collection',
      's.ops',
      's.note',
      's.run_at',
      's.status',
      's.error',
      's.created_by',
      's.created_at',
      's.applied_at',
      db.raw(
        "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as created_by_name"
      ),
      db.raw(
        "LTRIM(RTRIM(CONCAT(COALESCE(w.first_name, ''), ' ', COALESCE(w.last_name, '')))) as updated_by_name"
      )
    )) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    layout_id: Number(r.layout_id),
    layout_name: (r.layout_name as string | null) ?? null,
    collection: String(r.collection),
    note: (r.note as string | null) ?? null,
    run_at: iso(r.run_at) as string,
    status: String(r.status) as ScheduleStatus,
    error: (r.error as string | null) ?? null,
    op_count: parseOps(r.ops).length,
    created_by: (r.created_by as string | null) ?? null,
    created_by_name: (r.created_by_name as string | null) || null,
    created_at: iso(r.created_at),
    updated_by_name: (r.updated_by_name as string | null) || null,
    applied_at: iso(r.applied_at)
  }))
}

/** Cancel a pending change, or dismiss a failed one. Any admin. */
export async function cancelSchedule(id: number, userId: string | null): Promise<boolean> {
  const n = await db(TABLE)
    .where({ id })
    .whereIn('status', ['pending', 'failed'])
    .update({ status: 'cancelled', updated_by: userId, updated_at: new Date() })
  return Number(n) > 0
}

/** Move a pending change to another time. Any admin. */
export async function rescheduleSchedule(
  id: number,
  runAt: unknown,
  userId: string | null
): Promise<ScheduleRow | null> {
  const at = parseRunAt(runAt)
  const n = await db(TABLE)
    .where({ id, status: 'pending' })
    .update({ run_at: at, updated_by: userId, updated_at: new Date() })
  if (Number(n) === 0) return null
  const [view] = await listSchedules({ ids: [id] })
  return view ?? null
}

/** A layout write made outside a request: what the config-write hook does for routes. */
function announceLayoutChanged(collection: string) {
  clearMetadataCache()
  bustSectionLockCache()
  bustLayoutReferences()
  try {
    announceConfigChanged('collection-layouts', collection)
  } catch {
    /* broadcast is best-effort */
  }
}

async function failSchedule(
  row: Record<string, unknown>,
  reason: string,
  layoutName: string | null
): Promise<void> {
  const id = Number(row.id)
  await db(TABLE)
    .where({ id })
    .update({ status: 'failed', error: reason.slice(0, 2000), updated_at: new Date() })
  await logActivity({
    action: 'layout-schedule-failed',
    user: (row.created_by as string | null) ?? null,
    collection: 'nivaro_collection_layouts',
    item: String(row.layout_id),
    comment: `scheduled change ${id} not applied: ${reason}`.slice(0, 500),
    origin: 'machine'
  })
  const app = getApp()
  const to = row.created_by ? String(row.created_by) : null
  if (!app || !to) return
  try {
    const base = adminBaseUrl()
    const url = base
      ? `${base}/data-model/${encodeURIComponent(String(row.collection))}?tab=groups&layout=${row.layout_id}`
      : null
    const { notifyUser } = await import('./notification-channels.js')
    await notifyUser(app, to, {
      subject: `Scheduled layout change not applied${layoutName ? `: ${layoutName}` : ''}`.slice(
        0,
        200
      ),
      message: `It could not run at its time: ${reason}. Nothing on the layout changed. Open the layout to make the change again.`,
      category: 'system',
      ...(url ? { target: { kind: 'external', url } } : {})
    })
  } catch (err) {
    app.log?.warn?.({ err, schedule: id }, 'Scheduled layout change notification failed')
  }
}

/**
 * The `layout-schedules` tick: apply every pending change that is due. A
 * change whose rev moved is folded onto the layout as it is now; it runs only
 * when every op still fits.
 */
export async function runDueSchedules(
  now = new Date()
): Promise<{ applied: number; failed: number }> {
  if (!(await schedulesAvailable())) return { applied: 0, failed: 0 }
  // A process that died mid-apply leaves its row 'running'. Whether the write
  // committed is unknown, so it is never retried: the scheduler is told.
  const stuck = (await db(TABLE)
    .where({ status: 'running' })
    .where('updated_at', '<', new Date(now.getTime() - STUCK_MS))) as Array<Record<string, unknown>>
  for (const row of stuck)
    await failSchedule(
      row,
      'it was interrupted while applying; check the layout before scheduling it again',
      null
    ).catch(() => {})
  const due = (await db(TABLE)
    .where({ status: 'pending' })
    .where('run_at', '<=', now)
    .orderBy('run_at', 'asc')
    .limit(50)) as Array<Record<string, unknown>>
  let applied = 0
  let failed = 0
  for (const row of due) {
    const id = Number(row.id)
    const claimed = await db(TABLE)
      .where({ id, status: 'pending' })
      .update({ status: 'running', updated_at: new Date() })
    if (Number(claimed) !== 1) continue
    const layoutId = Number(row.layout_id)
    try {
      const bundle = await loadLayoutBundle(db, layoutId)
      if (!bundle) {
        await failSchedule(row, 'the layout no longer exists', null)
        failed++
        continue
      }
      const layoutName = bundle.layout.name != null ? String(bundle.layout.name) : null
      const ops = parseOps(row.ops)
      const misfit = foldScheduled(bundle, ops)
      if (misfit) {
        await failSchedule(
          row,
          bundle.rev === row.base_rev
            ? misfit
            : `the layout changed since it was scheduled and a change no longer fits (${misfit})`,
          layoutName
        )
        failed++
        continue
      }
      const by = await userName(row.created_by as string | null)
      const note = `Scheduled change by ${by ?? 'an admin'}${row.note ? ` — ${row.note}` : ''}`
      const result = await runLayoutOps(
        layoutId,
        { ops, base_rev: bundle.rev, note },
        (row.created_by as string | null) ?? null
      )
      if (result.status === 409) {
        // Someone saved between the read and the write: try again next tick.
        await db(TABLE).where({ id }).update({ status: 'pending', updated_at: new Date() })
        continue
      }
      if (result.status !== 200) {
        await failSchedule(
          row,
          result.status === 404 ? 'the layout no longer exists' : result.error,
          layoutName
        )
        failed++
        continue
      }
      await db(TABLE)
        .where({ id })
        .update({ status: 'applied', applied_at: new Date(), updated_at: new Date(), error: null })
      await logActivity({
        action: 'layout-schedule-apply',
        user: (row.created_by as string | null) ?? null,
        collection: 'nivaro_collection_layouts',
        item: String(layoutId),
        comment:
          `scheduled change ${id}: ${ops.length} change(s)${row.note ? ` — ${row.note}` : ''}`.slice(
            0,
            500
          ),
        origin: 'machine'
      })
      if (result.changed) announceLayoutChanged(String(row.collection))
      applied++
    } catch (err) {
      await failSchedule(
        row,
        `it failed while applying (${err instanceof Error ? err.message : String(err)})`,
        null
      ).catch(() => {})
      failed++
    }
  }
  return { applied, failed }
}
