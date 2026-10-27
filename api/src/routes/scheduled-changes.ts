import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { getFields, getPhysicalColumns } from '../services/collections.js'
import { recordWriteRefusal } from '../services/edit-lock.js'
import { canUpdateItem, describeWriteRefusal, readOne, updateOne } from '../services/items.js'
import { can, getAllowedFields, isAdminRole } from '../services/permissions.js'
import { recordToolRefusal } from '../services/record-tool-gate.js'
import type { User } from '../types.js'

function parseJsonSafe(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

function formatChange(row: Record<string, unknown>, readable: Set<string> | null = null) {
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
    if (!(req.isAdmin ?? false)) {
      const visible = await readOne(
        req.user!,
        collection,
        itemId,
        req.workspaceId ?? undefined
      ).catch(() => null)
      if (!visible) return reply.code(404).send({ error: 'Not found' })
      const fields = await getAllowedFields(req.user!, 'read', collection)
      readable = fields === null || fields.includes('*') ? null : new Set(fields)
    }

    const rows = (await db('nivaro_scheduled_changes')
      .where({ collection, item_id: itemId })
      .orderBy('scheduled_at', 'asc')) as Record<string, unknown>[]

    return reply.send({ data: rows.map((r) => formatChange(r, readable)) })
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
    // THIS record — the same gate as "Disable in pickers".
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

    const [row] = await db('nivaro_scheduled_changes')
      .insert({
        collection: body.collection,
        item_id: body.item_id,
        change_type: body.change_type,
        changes: JSON.stringify(body.changes ?? {}),
        scheduled_at: scheduledAt,
        status: 'pending',
        created_by: req.user!.id,
        created_at: now,
        updated_at: now
        // For now, scheduled changes must be executed manually via POST /:id/execute.
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
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
    if (!isAdmin) {
      if (existing.created_by !== req.user!.id) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const workspaceId = req.workspaceId ?? undefined
      const itemId = String(existing.item_id)
      const visible = await readOne(req.user!, existing.collection, itemId, workspaceId).catch(
        () => null
      )
      if (!visible) return reply.code(404).send({ error: 'Not found' })
      if (!(await canUpdateItem(req.user!, existing.collection, itemId, workspaceId))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
    }

    if (existing.status === 'executed') {
      return reply.code(409).send({ error: 'Cannot cancel an already executed change' })
    }

    await db('nivaro_scheduled_changes')
      .where({ id })
      .update({ status: 'cancelled', updated_at: new Date() })

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

  // POST /scheduled-changes/:id/execute — manually execute now (admin)
  app.post('/:id/execute', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const change = await db('nivaro_scheduled_changes').where({ id }).first()
    if (!change) return reply.code(404).send({ error: 'Not found' })

    if (change.status !== 'pending') {
      return reply.code(409).send({ error: `Change is already ${change.status}` })
    }

    const parsed = parseJsonSafe(change.changes)
    const changesData =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    const now = new Date()
    const fail = async (status: number, error: string, extra: Record<string, unknown> = {}) => {
      await db('nivaro_scheduled_changes')
        .where({ id })
        .update({ status: 'failed', error_message: error.slice(0, 500), updated_at: now })
      return reply.code(status).send({ error, status: 'failed', ...extra })
    }
    if (!changesData) return fail(400, 'The stored change is not a set of field values')

    // M4 (security audit 2026-10-27): the change runs AS ITS CREATOR through
    // the items service — their update policy, row filter, User Scopes, the
    // record's person-held and approval edit locks, field rules, validation,
    // hooks, a revision and rollups all apply, exactly as if they saved it
    // now. A creator who is gone, suspended, or may no longer make the
    // change marks it failed (with the reason) instead of it being written.
    const outcome = await executeAsCreator(req, change, changesData)
    if (!outcome.ok) return fail(outcome.status, outcome.error, outcome.extra)

    await db('nivaro_scheduled_changes')
      .where({ id })
      .update({ status: 'executed', executed_at: now, updated_at: now })

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
