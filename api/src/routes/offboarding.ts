import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Offboarding / workload handoff (#1): everything a departing user HOLDS —
 * queue claims, pipeline instance ownerships, open tasks, owner-group
 * memberships, delegate chains pointing at them, notification subscriptions —
 * surfaced in one summary and reassigned in one guided pass. Coverage Gaps
 * detects the aftermath; this prevents it.
 */

async function count(table: string, where: Record<string, unknown>): Promise<number> {
  try {
    const row = (await db(table).where(where).count({ c: '*' }).first()) as
      | { c: number | string }
      | undefined
    return Number(row?.c ?? 0)
  } catch {
    return 0
  }
}

export async function offboardingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const user = await db('nivaro_users').where({ id: req.params.id }).first('id', 'first_name', 'last_name', 'email', 'status')
    if (!user) return reply.code(404).send({ error: 'User not found' })
    const uid = String(user.id)
    const [claims, instanceOwners, openTasks, ownerGroups, delegatesToThem, managerOf, subscriptions, fieldWatches] =
      await Promise.all([
        count('nivaro_queue_claims', { claimed_by: uid }),
        // Only OPEN instances matter — completed records need no owner.
        db('nivaro_pipeline_instance_owners as o')
          .join('nivaro_workflow_instances as i', 'i.id', 'o.instance')
          .where('o.user', uid)
          .whereNull('i.completed_at')
          .count({ c: '*' })
          .first()
          .then((r) => Number((r as { c?: number | string } | undefined)?.c ?? 0))
          .catch(() => 0),
        db('nivaro_tasks')
          .where({ assignee: uid })
          .whereNot('status', 'done')
          .count({ c: '*' })
          .first()
          .then((r) => Number((r as { c?: number | string } | undefined)?.c ?? 0))
          .catch(() => 0),
        count('nivaro_pipeline_owner_group_users', { user: uid }),
        count('nivaro_users', { delegate_id: uid }),
        count('nivaro_users', { manager_id: uid }),
        db('nivaro_notification_subscriptions')
          .where({ user: uid, is_active: true })
          .count({ c: '*' })
          .first()
          .then((r) => Number((r as { c?: number | string } | undefined)?.c ?? 0))
          .catch(() => 0),
        count('nivaro_field_watch_subscribers', { user: uid })
      ])
    return {
      data: {
        user: {
          id: uid,
          name: `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.email,
          status: user.status
        },
        holdings: {
          queue_claims: claims,
          instance_ownerships: instanceOwners,
          open_tasks: openTasks,
          owner_group_memberships: ownerGroups,
          delegates_pointing_here: delegatesToThem,
          direct_reports: managerOf,
          notification_subscriptions: subscriptions,
          field_watches: fieldWatches
        }
      }
    }
  })

  app.post<{ Params: { id: string } }>('/:id/run', async (req, reply) => {
    const b = req.body as {
      successor?: string
      include?: Record<string, boolean>
      suspend?: boolean
    }
    const departing = await db('nivaro_users').where({ id: req.params.id }).first('id', 'first_name', 'last_name', 'email')
    if (!departing) return reply.code(404).send({ error: 'User not found' })
    const successor = b.successor
      ? await db('nivaro_users').where({ id: b.successor }).first('id', 'first_name', 'last_name', 'email', 'status')
      : null
    const inc = b.include ?? {}
    const needsSuccessor = ['queue_claims', 'instance_ownerships', 'open_tasks', 'owner_group_memberships', 'delegates'].some(
      (k) => inc[k] !== false
    )
    if (needsSuccessor && !successor) {
      return reply.code(400).send({ error: 'A successor is required for the selected categories' })
    }
    if (successor && String(successor.id).toUpperCase() === String(departing.id).toUpperCase()) {
      return reply.code(400).send({ error: 'Successor must be a different user' })
    }
    if (successor && successor.status === 'suspended') {
      return reply.code(400).send({ error: 'The successor is suspended — pick a working user' })
    }
    const uid = String(departing.id)
    const sid = successor ? String(successor.id) : null
    const result: Record<string, number> = {}

    if (inc.queue_claims !== false && sid) {
      result.queue_claims = await db('nivaro_queue_claims')
        .where({ claimed_by: uid })
        .update({ claimed_by: sid })
        .catch(() => 0)
    }

    if (inc.instance_ownerships !== false && sid) {
      // Transfer per open instance, skipping ones the successor already owns
      // (the table is unique per instance+user in practice).
      const rows = (await db('nivaro_pipeline_instance_owners as o')
        .join('nivaro_workflow_instances as i', 'i.id', 'o.instance')
        .where('o.user', uid)
        .whereNull('i.completed_at')
        .select('o.id', 'o.instance')) as Array<{ id: number; instance: string }>
      const successorOwned = new Set(
        (
          (await db('nivaro_pipeline_instance_owners')
            .whereIn('instance', rows.map((r) => r.instance))
            .where('user', sid)
            .select('instance')) as Array<{ instance: string }>
        ).map((r) => String(r.instance))
      )
      let moved = 0
      for (const r of rows) {
        if (successorOwned.has(String(r.instance))) {
          await db('nivaro_pipeline_instance_owners').where('id', r.id).del()
        } else {
          await db('nivaro_pipeline_instance_owners').where('id', r.id).update({ user: sid })
          moved++
        }
      }
      result.instance_ownerships = moved
      // Closed instances keep their rows — history stays truthful.
    }

    if (inc.open_tasks !== false && sid) {
      result.open_tasks = await db('nivaro_tasks')
        .where({ assignee: uid })
        .whereNot('status', 'done')
        .update({ assignee: sid })
        .catch(() => 0)
    }

    if (inc.owner_group_memberships !== false && sid) {
      const rows = (await db('nivaro_pipeline_owner_group_users')
        .where({ user: uid })
        .select('id', 'group as owner_group')) as Array<{ id: number; owner_group: number }>
      const successorGroups = new Set(
        (
          (await db('nivaro_pipeline_owner_group_users')
            .where({ user: sid })
            .select('group as owner_group')) as Array<{ owner_group: number }>
        ).map((r) => String(r.owner_group))
      )
      let moved = 0
      for (const r of rows) {
        if (successorGroups.has(String(r.owner_group))) {
          await db('nivaro_pipeline_owner_group_users').where('id', r.id).del()
        } else {
          await db('nivaro_pipeline_owner_group_users').where('id', r.id).update({ user: sid })
          moved++
        }
      }
      result.owner_group_memberships = moved
      // Bust the engine's group cache so the change is visible immediately.
      try {
        const { bustOwnerGroupCache } = await import('../services/pipeline-engine.js')
        bustOwnerGroupCache()
      } catch {
        /* cache TTL covers it */
      }
    }

    if (inc.delegates !== false && sid) {
      result.delegates_repointed = await db('nivaro_users')
        .where({ delegate_id: uid })
        .whereNot('id', sid)
        .update({ delegate_id: sid })
        .catch(() => 0)
      result.reports_repointed = await db('nivaro_users')
        .where({ manager_id: uid })
        .whereNot('id', sid)
        .update({ manager_id: sid })
        .catch(() => 0)
    }

    if (inc.notification_subscriptions !== false) {
      result.subscriptions_deactivated = await db('nivaro_notification_subscriptions')
        .where({ user: uid })
        .update({ is_active: false })
        .catch(() => 0)
      result.field_watches_removed = await db('nivaro_field_watch_subscribers')
        .where({ user: uid })
        .del()
        .catch(() => 0)
    }

    // Their own delegation window is moot once offboarded.
    await db('nivaro_users')
      .where({ id: uid })
      .update({ delegate_id: null, is_out_of_office: false, ...(b.suspend ? { status: 'suspended' } : {}) })
      .catch(() => {})
    if (b.suspend) result.suspended = 1

    await logActivity({
      action: 'user-offboard',
      user: req.user?.id,
      collection: 'nivaro_users',
      item: uid,
      comment: `→ ${successor ? `${successor.first_name ?? ''} ${successor.last_name ?? ''}`.trim() || successor.email : 'no successor'}: ${Object.entries(result)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`.slice(0, 300),
      req
    })
    return { data: result }
  })

  /**
   * Account merge (#38): repoint EVERYTHING referencing a duplicate/legacy
   * account (the legacy-…@invalid.local twins) onto the survivor, then
   * suspend the twin. Coverage is schema-driven — every FK into nivaro_users
   * plus every uniqueidentifier column with a user-ish name — so new tables
   * are covered without a code change. dry_run returns per-table counts.
   * Membership-style tables where the survivor already holds the same row
   * (unique violations) fall back to DELETING the twin's duplicates.
   */
  app.post<{ Params: { id: string } }>('/:id/merge', async (req, reply) => {
    const b = req.body as { into?: string; dry_run?: boolean }
    const twin = await db('nivaro_users').where({ id: req.params.id }).first('id', 'first_name', 'last_name', 'email')
    if (!twin) return reply.code(404).send({ error: 'User not found' })
    if (!b.into) return reply.code(400).send({ error: 'into (survivor user id) is required' })
    const survivor = await db('nivaro_users').where({ id: b.into }).first('id', 'first_name', 'last_name', 'email')
    if (!survivor) return reply.code(404).send({ error: 'Survivor user not found' })
    if (String(survivor.id).toUpperCase() === String(twin.id).toUpperCase()) {
      return reply.code(400).send({ error: 'Cannot merge a user into itself' })
    }

    // Every column that can hold this user's id: declared FKs into
    // nivaro_users, plus user-ish-named uniqueidentifier columns (legacy
    // business tables carry user uuids without constraints).
    const fkCols = (await db.raw(`
      SELECT t.name AS table_name, c.name AS column_name
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.tables t ON t.object_id = fk.parent_object_id
      JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
      WHERE fk.referenced_object_id = OBJECT_ID('nivaro_users')
    `)) as Array<{ table_name: string; column_name: string }>
    const USERISH = [
      'user', 'user_created', 'user_updated', 'creator', 'created_by', 'owner', 'assignee',
      'recipient', 'sender', 'claimed_by', 'approved_by', 'placed_by', 'released_by',
      'triggered_by', 'added_by', 'imported_by', 'user_id', 'escalation_user'
    ]
    const namedCols = (await db('information_schema.columns')
      .whereIn('column_name', USERISH)
      .where('data_type', 'uniqueidentifier')
      .select('table_name', 'column_name')) as Array<{ table_name: string; column_name: string }>
    const SKIP_TABLES = new Set(['nivaro_sessions', 'nivaro_migrations'])
    const targets = new Map<string, { table: string; column: string }>()
    for (const r of [...fkCols, ...namedCols]) {
      const table = String(r.table_name)
      if (SKIP_TABLES.has(table.toLowerCase())) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(r.column_name))) continue
      targets.set(`${table}.${r.column_name}`, { table, column: String(r.column_name) })
    }

    const counts: Record<string, number> = {}
    for (const t of targets.values()) {
      const n = await count(t.table, { [t.column]: String(twin.id) })
      if (n > 0) counts[`${t.table}.${t.column}`] = n
    }
    if (b.dry_run) {
      return { data: { dry_run: true, references: counts, tables: Object.keys(counts).length } }
    }

    const applied: Record<string, { repointed: number; deleted_duplicates: number }> = {}
    for (const [key, n] of Object.entries(counts)) {
      const { table, column } = targets.get(key)!
      try {
        const updated = await db(table)
          .where({ [column]: String(twin.id) })
          .update({ [column]: String(survivor.id) })
        applied[key] = { repointed: updated, deleted_duplicates: 0 }
      } catch {
        // Unique collision — the survivor already holds equivalent rows
        // (memberships, subscriptions, pins). The twin's duplicates go.
        const deleted = await db(table)
          .where({ [column]: String(twin.id) })
          .del()
          .catch(() => 0)
        applied[key] = { repointed: n - deleted, deleted_duplicates: deleted }
      }
    }

    await db('nivaro_users')
      .where({ id: twin.id })
      .update({ status: 'suspended', delegate_id: null, is_out_of_office: false })
      .catch(() => {})
    await logActivity({
      action: 'user-merge',
      user: req.user?.id,
      collection: 'nivaro_users',
      item: String(survivor.id),
      comment: `Merged ${twin.email} into ${survivor.email}: ${Object.keys(applied).length} table(s) repointed`.slice(0, 300),
      req
    })
    return { data: { merged: true, applied } }
  })
}
