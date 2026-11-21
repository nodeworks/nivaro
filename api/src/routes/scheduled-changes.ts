import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { sqlDialect } from '../db/sql-dialect.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { getFields, getPhysicalColumns } from '../services/collections.js'
import { recordWriteRefusal } from '../services/edit-lock.js'
import { canUpdateItem, describeWriteRefusal, readOne, updateOne } from '../services/items.js'
import { can, getAllowedFields, isAdminRole } from '../services/permissions.js'
import { announceRecordAspect } from '../services/record-events.js'
import { recordToolRefusal } from '../services/record-tool-gate.js'
import {
  applyClaimed,
  autoApplyOn,
  type ChangeRow,
  claimChange,
  defaultApplyDeps,
  encodeMeta,
  readMeta,
  SCHEDULE_LEGACY_META_COLUMN,
  SCHEDULE_META_COLUMN,
  sameValue
} from '../services/scheduled-apply.js'
import { seesAllRecords } from '../services/user-scopes.js'
import type { User } from '../types.js'

/**
 * The record a scheduled change is for, judged AS THE CALLER: hidden = 404, not theirs to
 * update = 403. Skipped only for an administrator no restrict-mode User Scope narrows
 * (seesAllRecords) — a restricted administrator is judged like anyone (items service: their
 * scopes, never their policies). `update: false` checks reading only.
 */
export async function scheduledRecordRefusal(
  req: Pick<FastifyRequest, 'user' | 'isAdmin' | 'workspaceId'>,
  collection: string,
  itemId: string,
  opts: { update?: boolean } = {}
): Promise<{ status: 403 | 404; error: string } | null> {
  if (await seesAllRecords(req.isAdmin, req.user)) return null
  const workspaceId = req.workspaceId ?? undefined
  const visible = await readOne(req.user!, collection, itemId, workspaceId).catch(() => null)
  if (!visible) return { status: 404, error: 'Not found' }
  if (opts.update !== false && !(await canUpdateItem(req.user!, collection, itemId, workspaceId)))
    return { status: 403, error: 'Forbidden' }
  return null
}

/**
 * rt7 #12 — a record page counts down to its pending scheduled changes. Every change to a
 * schedule (created, rescheduled, cancelled, applied) tells the record's open pages with the
 * `$scheduled` aspect (a notice: no values); they re-read the list as the viewer.
 */
function announceScheduled(collection: unknown, item: unknown): void {
  if (typeof collection !== 'string' || item == null) return
  announceRecordAspect(collection, String(item), '$scheduled')
}

/** First + last name of each scheduler (directory columns only; never an email). */
async function schedulerNames(ids: unknown[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((i) => typeof i === 'string' && i).map(String))]
  const out = new Map<string, string>()
  if (uniq.length === 0) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', uniq)
    .select('id', 'first_name', 'last_name')
    .catch(() => [])) as Array<Record<string, unknown>>
  for (const r of rows) {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
    if (name) out.set(String(r.id).toUpperCase(), name)
  }
  return out
}

function parseJsonSafe(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

function formatChange(row0: Record<string, unknown>, readable: Set<string> | null = null) {
  // The bookkeeping column holds field values (before / when scheduled): never sent.
  const { [SCHEDULE_META_COLUMN]: _meta, [SCHEDULE_LEGACY_META_COLUMN]: _legacy, ...row } = row0
  const changes = parseJsonSafe(row.changes)
  if (!readable) return { ...row, changes }
  // A stored value that is not a field map can't be filtered, so it never
  // reaches a viewer limited to some fields.
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return { ...row, changes: {} }
  }
  // Values of fields the viewer may not read never leave the server.
  return {
    ...row,
    changes: Object.fromEntries(
      Object.entries(changes as Record<string, unknown>).filter(([k]) => readable.has(k))
    )
  }
}

/** Stamped by the items service itself: never a value someone schedules. */
const AUDIT_SPECIALS = new Set(['user-created', 'user-updated', 'date-created', 'date-updated'])

/**
 * The first key a non-admin may not schedule: execution writes each key straight to its
 * column (no hooks, activity or rollups), so only a registered field with a column of its own
 * that is not read-only, computed or an audit stamp qualifies. null = all may be scheduled.
 */
async function unschedulableKey(collection: string, keys: string[]): Promise<string | null> {
  if (keys.length === 0) return null
  const [fields, columns] = await Promise.all([
    getFields(collection),
    getPhysicalColumns(collection)
  ])
  const byName = new Map(fields.map((f) => [f.field, f]))
  for (const key of keys) {
    const f = byName.get(key)
    // Unregistered, or an alias (o2m, m2m, presentation): no column of its own.
    if (!f || !columns?.has(key.toLowerCase())) return key
    if (f.readonly || f.computed_type) return key
    if ((f.special ?? []).some((s) => AUDIT_SPECIALS.has(s) || s === 'alias')) return key
  }
  return null
}

type ExecuteOutcome =
  | { ok: true }
  | { ok: false; status: number; error: string; extra?: Record<string, unknown> }

/**
 * Apply a scheduled change as the person who scheduled it. The request is
 * re-cast as theirs (same headers / server / socket, their user and admin
 * flag, no workspace header) so every gate that reads the request — the
 * held-lock guard, the approval edit lock, admin-only exemptions — judges
 * the creator, never the administrator who pressed Execute.
 */
export async function executeAsCreator(
  req: FastifyRequest,
  change: { collection: string; item_id: string | number; created_by?: string | null },
  changes: Record<string, unknown>
): Promise<ExecuteOutcome> {
  const creator = change.created_by
    ? ((await db('nivaro_users')
        .where({ id: change.created_by })
        .first()
        .catch(() => null)) as User | null | undefined)
    : null
  if (!creator || (creator.status && creator.status !== 'active')) {
    return {
      ok: false,
      status: 409,
      error: 'The person who scheduled this change is no longer active'
    }
  }
  const asCreator = Object.create(req) as FastifyRequest
  Object.assign(asCreator, {
    user: creator,
    isAdmin: await isAdminRole(creator),
    workspaceId: undefined
  })
  const itemId = String(change.item_id)
  const refused = await recordWriteRefusal(asCreator, change.collection, itemId)
  if (refused) {
    const body = refused.body as { error?: string; code?: string }
    return {
      ok: false,
      status: refused.status,
      error: body.error ?? 'The change may not be applied',
      extra: body.code ? { code: body.code } : {}
    }
  }
  try {
    await updateOne(creator, change.collection, itemId, changes, asCreator, undefined, {
      callerPayload: true
    })
  } catch (err) {
    const why = describeWriteRefusal(err)
    if (why.status >= 500) console.error('Failed to execute scheduled change:', err)
    return {
      ok: false,
      status: why.status >= 500 ? 500 : why.status,
      error: why.status >= 500 ? 'Failed to apply changes to item' : why.error,
      extra: why.code ? { code: why.code } : {}
    }
  }
  return { ok: true }
}

export async function scheduledChangesRoutes(app: FastifyInstance) {
  // GET /scheduled-changes — list all (admin) with optional filters
  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection, status } = req.query as { collection?: string; status?: string }

    let query = db('nivaro_scheduled_changes').orderBy('scheduled_at', 'asc')

    if (collection) query = query.where({ collection })
    if (status) query = query.where({ status })

    const rows = (await query) as Record<string, unknown>[]
    return reply.send({ data: rows.map((r) => formatChange(r)) })
  })

  // GET /scheduled-changes/:collection/:itemId — list for an item. Non-admins
  // see the list only for a record they can see, and only the values of
  // fields they may read.
  app.get('/:collection/:itemId', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId } = req.params as { collection: string; itemId: string }

    let readable: Set<string> | null = null
    const hidden = await scheduledRecordRefusal(req, collection, itemId, { update: false })
    if (hidden) return reply.code(404).send({ error: 'Not found' })
    if (!(req.isAdmin ?? false)) {
      const fields = await getAllowedFields(req.user!, 'read', collection)
      readable = fields === null || fields.includes('*') ? null : new Set(fields)
    }

    const { status } = req.query as { status?: string }
    let q = db('nivaro_scheduled_changes')
      .where({ collection, item_id: itemId })
      .orderBy('scheduled_at', 'asc')
    if (status === 'pending') q = q.where({ status: 'pending' })
    // `recent`: what the record page shows — waiting changes, plus the ones applied, failed or
    // undone in the last day (the header flips to "Applied" / "Failed — reason").
    if (status === 'recent')
      q = q.where((w) =>
        w
          .whereIn('status', ['pending', 'applying'])
          .orWhere((x) =>
            x
              .whereIn('status', ['executed', 'failed', 'undone'])
              .where('executed_at', '>', new Date(Date.now() - 24 * 3600_000))
          )
      )
    const rows = (await q) as Record<string, unknown>[]
    const names = await schedulerNames(rows.map((r) => r.created_by))
    const me = String(req.user?.id ?? '').toUpperCase()
    const isAdmin = req.isAdmin ?? false
    const autoApply = await autoApplyOn(collection)
    return reply.send({
      data: rows.map((r) => {
        const meta = readMeta(r)
        const canManage = isAdmin || (!!me && String(r.created_by ?? '').toUpperCase() === me)
        const undoUntil =
          r.status === 'executed' && meta.before && meta.undo_until ? meta.undo_until : null
        return {
          ...formatChange(r, readable),
          created_by_name: names.get(String(r.created_by ?? '').toUpperCase()) ?? null,
          // Who may cancel or move it: its scheduler (still able to update the record — checked
          // again on the write) or an administrator.
          can_manage: canManage,
          // Applies by itself at its time (the collection's switch, default on).
          auto_apply: autoApply,
          applied_on_time: r.status === 'executed' ? meta.applied_by === 'schedule' : null,
          undo_until: undoUntil,
          can_undo: canManage && !!undoUntil && Date.parse(undoUntil) > Date.now()
        }
      })
    })
  })

  // POST /scheduled-changes — create
  app.post('/', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      collection: string
      item_id: string
      change_type: 'field_update' | 'workflow_transition'
      changes: Record<string, unknown>
      scheduled_at: string
      layout?: string | null
    }

    if (!body.collection || !body.item_id || !body.change_type || !body.scheduled_at) {
      return reply
        .code(400)
        .send({ error: 'collection, item_id, change_type, and scheduled_at are required' })
    }

    if (!['field_update', 'workflow_transition'].includes(body.change_type)) {
      return reply
        .code(400)
        .send({ error: 'change_type must be field_update or workflow_transition' })
    }

    if (body.changes != null && (typeof body.changes !== 'object' || Array.isArray(body.changes))) {
      return reply.code(400).send({ error: 'changes must be an object of field values' })
    }

    const isAdmin = req.isAdmin ?? false
    if (body.collection.startsWith('nivaro_') && !isAdmin) {
      return reply.code(403).send({ error: 'Cannot schedule changes to system collections' })
    }
    // Non-admins: the record must be visible (404), its form must grant
    // "Schedule a change" (allow_schedule) and they must be able to update
    // THIS record — the same gate as "Hide from pickers".
    const refusal = await recordToolRefusal(
      req,
      body.collection,
      String(body.item_id),
      'allow_schedule',
      {
        layout: typeof body.layout === 'string' ? body.layout : null,
        denied: 'Only administrators can schedule changes here'
      }
    )
    if (refusal) return reply.code(refusal.status).send({ error: refusal.error })
    // recordToolRefusal passes administrators through; a scope-restricted one is still judged.
    if (isAdmin) {
      const scoped = await scheduledRecordRefusal(req, body.collection, String(body.item_id))
      if (scoped) return reply.code(scoped.status).send({ error: scoped.error })
    }
    if (!(await can(req.user!, 'update', body.collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    if (!isAdmin) {
      // Execution writes every key as a column, whatever the change type, so
      // each one must be a field the caller may update.
      const allowed = await getAllowedFields(req.user!, 'update', body.collection)
      if (allowed !== null && !allowed.includes('*')) {
        const allowedSet = new Set(allowed)
        const blocked = Object.keys(body.changes ?? {}).find((k) => !allowedSet.has(k))
        if (blocked) {
          return reply.code(403).send({ error: `You may not change the field "${blocked}"` })
        }
      }
      const unschedulable = await unschedulableKey(body.collection, Object.keys(body.changes ?? {}))
      if (unschedulable) {
        return reply
          .code(400)
          .send({ error: `The field "${unschedulable}" can't be changed on a schedule` })
      }
    }
    const PROTECTED_FIELDS = [
      'id',
      'role',
      'admin_access',
      'static_token',
      'password_hash',
      'external_id'
    ]
    if (Object.keys(body.changes ?? {}).some((k) => PROTECTED_FIELDS.includes(k))) {
      return reply.code(400).send({ error: 'changes contains protected fields' })
    }

    const now = new Date()
    const scheduledAt = new Date(body.scheduled_at)
    if (Number.isNaN(scheduledAt.getTime())) {
      return reply.code(400).send({ error: 'scheduled_at is not a valid date' })
    }

    // The scheduled fields' values now: when it applies, a field someone else moved in the
    // meantime fails the change instead of overwriting their edit (services/scheduled-apply.ts).
    const keys = Object.keys(body.changes ?? {}).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    const nowRow =
      keys.length > 0 && !body.collection.startsWith('nivaro_')
        ? ((await db(body.collection)
            .where({ id: body.item_id })
            .first(...keys)
            .catch(() => null)) as Record<string, unknown> | null)
        : null
    const at: Record<string, unknown> = {}
    if (nowRow)
      for (const k of keys)
        at[k] = nowRow[k] instanceof Date ? (nowRow[k] as Date).toISOString() : (nowRow[k] ?? null)

    // MySQL has no RETURNING (knex answers the auto-increment id, 0 for this uuid key): the id
    // is made here and written with the row there.
    const mysqlId = sqlDialect(db) === 'mysql' ? randomUUID() : null
    const [row] = await db('nivaro_scheduled_changes')
      .insert({
        ...(mysqlId ? { id: mysqlId } : {}),
        [SCHEDULE_META_COLUMN]: nowRow ? encodeMeta({ v: 1, at }) : null,
        collection: body.collection,
        item_id: body.item_id,
        change_type: body.change_type,
        changes: JSON.stringify(body.changes ?? {}),
        scheduled_at: scheduledAt,
        status: 'pending',
        created_by: req.user!.id,
        created_at: now
        // The table has no updated_at column (000_base_schema): writing one failed every
        // create, cancel and execute with "Invalid column name 'updated_at'".
        // For now, scheduled changes must be executed manually via POST /:id/execute.
      })
      .returning('id')

    const insertedId = mysqlId ?? (typeof row === 'object' ? row.id : row)
    announceScheduled(body.collection, body.item_id)
    await logActivity({
      action: 'schedule-change-create',
      user: req.user?.id,
      collection: body.collection,
      item: body.item_id,
      comment: `${body.change_type} scheduled for ${scheduledAt.toISOString()}`,
      req
    })
    const created = (await db('nivaro_scheduled_changes')
      .where({ id: insertedId })
      .first()) as Record<string, unknown>

    return reply.code(201).send({ data: formatChange(created) })
  })

  // DELETE /scheduled-changes/:id — cancel
  app.delete('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = await db('nivaro_scheduled_changes').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    // Own or admin — and a non-admin only while they can still see and
    // update the record the change is for.
    const isAdmin = req.isAdmin ?? false
    if (
      !isAdmin &&
      String(existing.created_by ?? '').toUpperCase() !== String(req.user!.id).toUpperCase()
    ) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    // Judged as the caller — administrators too, unless no restrict scope narrows them.
    const delRefusal = await scheduledRecordRefusal(
      req,
      existing.collection,
      String(existing.item_id)
    )
    if (delRefusal) return reply.code(delRefusal.status).send({ error: delRefusal.error })

    if (existing.status === 'executed') {
      return reply.code(409).send({ error: 'Cannot cancel an already executed change' })
    }

    await db('nivaro_scheduled_changes').where({ id }).update({ status: 'cancelled' })
    announceScheduled(existing.collection, existing.item_id)

    await logActivity({
      action: 'schedule-change-cancel',
      user: req.user?.id,
      collection: existing.collection,
      item: existing.item_id,
      comment: existing.change_type,
      req
    })

    return reply.code(204).send()
  })

  // PATCH /scheduled-changes/:id — move a pending change to another time (rt7 #12), or
  // reschedule one that failed. The same
  // gate as cancelling it: its scheduler while they can still see and update the record, or an
  // administrator. Only `scheduled_at` moves; what the change writes stays as scheduled.
  app.patch('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { scheduled_at?: unknown }
    const at = typeof body.scheduled_at === 'string' ? new Date(body.scheduled_at) : null
    if (!at || Number.isNaN(at.getTime())) {
      return reply.code(400).send({ error: 'scheduled_at is not a valid date' })
    }
    const existing = await db('nivaro_scheduled_changes').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    if (
      !(req.isAdmin ?? false) &&
      String(existing.created_by ?? '').toUpperCase() !== String(req.user!.id).toUpperCase()
    ) {
      return reply.code(403).send({ error: 'Only the person who scheduled it can move it' })
    }
    // Judged as the caller — administrators too: Restrict User Scopes bind admins.
    const moveRefusal = await scheduledRecordRefusal(
      req,
      existing.collection,
      String(existing.item_id)
    )
    if (moveRefusal) return reply.code(moveRefusal.status).send({ error: moveRefusal.error })
    // A change that failed may be scheduled again for a new time ("Reschedule" in the record
    // header): it goes back to waiting with what it writes unchanged — the full stored change,
    // never a copy cut to the fields the caller can read.
    const rescheduling = existing.status === 'failed'
    if (existing.status !== 'pending' && !rescheduling) {
      return reply.code(409).send({ error: `Change is already ${existing.status}` })
    }
    if (rescheduling && at.getTime() <= Date.now()) {
      return reply.code(400).send({ error: 'Pick a time in the future' })
    }
    await db('nivaro_scheduled_changes')
      .where({ id, status: existing.status })
      .update(
        rescheduling
          ? { scheduled_at: at, status: 'pending', executed_at: null, error_message: null }
          : { scheduled_at: at }
      )
    await logActivity({
      action: 'schedule-change-move',
      user: req.user?.id,
      collection: existing.collection,
      item: existing.item_id,
      comment: `${existing.change_type} ${rescheduling ? 'rescheduled after it failed' : 'moved'} to ${at.toISOString()}`,
      req
    })
    announceScheduled(existing.collection, existing.item_id)
    return reply.send({ data: { id, status: 'pending', scheduled_at: at.toISOString() } })
  })

  // POST /scheduled-changes/:id/undo — put back the values a change replaced, within a day of
  // it being applied: its scheduler (judged as themselves: they must still be able to update the
  // record) or an administrator. Refused when one of the fields moved again since — an undo
  // never overwrites a later edit.
  app.post('/:id/undo', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const change = (await db('nivaro_scheduled_changes').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!change) return reply.code(404).send({ error: 'Not found' })
    const isAdmin = req.isAdmin ?? false
    const mine =
      String(change.created_by ?? '').toUpperCase() === String(req.user!.id).toUpperCase()
    if (!isAdmin && !mine)
      return reply.code(403).send({ error: 'Only the person who scheduled it can undo it' })
    const meta = readMeta(change)
    if (change.status !== 'executed' || !meta.before || !meta.undo_until)
      return reply.code(409).send({ error: 'This change can no longer be undone' })
    if (Date.parse(meta.undo_until) <= Date.now())
      return reply.code(409).send({ error: 'The 24 hours to undo this change have passed' })
    const collection = String(change.collection)
    const itemId = String(change.item_id)
    const refused = await recordWriteRefusal(req, collection, itemId)
    if (refused) return reply.code(refused.status).send(refused.body)
    const applied = parseJsonSafe(change.changes) as Record<string, unknown>
    const keys = Object.keys(meta.before).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    const current = (await db(collection)
      .where({ id: itemId })
      .first(...keys)
      .catch(() => null)) as Record<string, unknown> | null
    if (!current) return reply.code(404).send({ error: 'Not found' })
    const moved = keys.find((k) => applied && k in applied && !sameValue(current[k], applied[k]))
    if (moved)
      return reply
        .code(409)
        .send({ error: 'A field it set was changed again since — undo would overwrite that edit' })
    // Claim the undo (a second press, or two tabs, must not run it twice).
    const claimed = await db('nivaro_scheduled_changes')
      .where({ id, status: 'executed' })
      .update({ status: 'undoing' })
    if (Number(claimed) !== 1) return reply.code(409).send({ error: 'Already being undone' })
    try {
      await updateOne(
        req.user!,
        collection,
        itemId,
        { ...meta.before, _change_reason: 'Undo of a scheduled change' },
        req,
        req.workspaceId ?? undefined,
        { callerPayload: true }
      )
    } catch (err) {
      await db('nivaro_scheduled_changes')
        .where({ id, status: 'undoing' })
        .update({ status: 'executed' })
      const why = describeWriteRefusal(err)
      return reply
        .code(why.status >= 500 ? 500 : why.status)
        .send({ error: why.status >= 500 ? 'Could not undo the change' : why.error })
    }
    await db('nivaro_scheduled_changes')
      .where({ id, status: 'undoing' })
      .update({
        status: 'undone',
        [SCHEDULE_META_COLUMN]: encodeMeta({ v: 1, at: meta.at, applied_by: meta.applied_by })
      })
    await logActivity({
      action: 'schedule-change-undo',
      user: req.user?.id,
      collection,
      item: itemId,
      req
    })
    announceScheduled(collection, itemId)
    return reply.send({ data: { id, status: 'undone' } })
  })

  // POST /scheduled-changes/:id/execute — manually execute now (admin)
  app.post('/:id/execute', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const change = await db('nivaro_scheduled_changes').where({ id }).first()
    if (!change) return reply.code(404).send({ error: 'Not found' })

    if (change.status !== 'pending') {
      return reply.code(409).send({ error: `Change is already ${change.status}` })
    }

    // The same apply as the minute job (claim first — the job may be applying it right now),
    // as the person who scheduled it; only who pressed the button differs.
    if (!(await claimChange(id))) {
      return reply.code(409).send({ error: 'This change is already being applied' })
    }
    const deps = await defaultApplyDeps(app)
    const outcome = await applyClaimed(
      app,
      { ...(change as ChangeRow), status: 'applying' },
      deps,
      {
        req,
        manualBy: req.user?.id ?? null
      }
    )
    const now = new Date()
    if (outcome.outcome === 'failed')
      return reply.code(outcome.status).send({ error: outcome.reason, status: 'failed' })
    if (outcome.outcome !== 'applied')
      return reply.code(409).send({ error: 'Not applied', status: 'failed' })

    await logActivity({
      action: 'execute_scheduled_change',
      user: req.user?.id,
      collection: change.collection,
      item: change.item_id,
      req
    })

    return reply.send({ data: { id, status: 'executed', executed_at: now } })
  })
}
