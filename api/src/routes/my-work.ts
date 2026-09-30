import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { resolveOwnedByMeSource } from '../services/queues.js'
import { computeStatusBatch, type SlaBatchEntry } from './sla.js'

/**
 * My Work — one actionable inbox: approvals waiting on ME (records whose
 * current pipeline state resolves me as an owner), my open tasks, approval
 * chain steps naming me, and unread notifications.
 *
 * Aggregation only — every piece reuses an existing engine (owned_by_me queue
 * resolver, SLA batch, tasks, approval instances, notifications) so this page
 * can never disagree with the queues/panels that show the same facts.
 */

interface OwnedEntry {
  collection: string
  item: string
  label: string
  state: string | null
  state_color: string | null
  url: string
  sla: SlaBatchEntry | null
}

const SLA_RANK: Record<string, number> = { breached: 0, warning: 1, ok: 2 }

export async function myWorkRoutes(app: FastifyInstance) {
  app.get('/my-work', { preHandler: requireAuth }, async (req, reply) => {
    const userId = String(req.user?.id)

    const teamIds = (
      (await db('nivaro_user_group_members')
        .where('user', userId)
        .select('group_id')
        .catch(() => [])) as Array<{ group_id: number }>
    ).map((r) => Number(r.group_id))
    const taskCols = [
      't.id',
      't.kind',
      't.collection',
      't.item',
      't.title',
      't.due_date',
      't.status',
      't.priority',
      't.assignee',
      't.team_id',
      'a.first_name as assignee_first',
      'a.last_name as assignee_last',
      'g.name as team_name'
    ]
    const taskBase = () =>
      db('nivaro_tasks as t')
        .leftJoin('nivaro_users as a', 'a.id', 't.assignee')
        .leftJoin('nivaro_user_groups as g', 'g.id', 't.team_id')
        .whereIn('t.status', ['open', 'in_progress'])
        .orderByRaw("CASE t.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END")
        .orderByRaw('CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END')
        .orderBy([
          { column: 't.due_date', order: 'asc' },
          { column: 't.id', order: 'desc' }
        ])
        .limit(50)
        .select(taskCols)

    const [ownedResult, tasks, approvalSteps, notifications, teamTasks, requested] =
      await Promise.all([
        resolveOwnedByMeSource(userId).catch(() => ({
          items: [],
          matchedCount: 0,
          truncated: false
        })),
        taskBase()
          .where('t.assignee', userId)
          .catch(() => []),
        // Approval chains — pending instances whose CURRENT step approver is me
        // (directly, or via my role).
        db('nivaro_approval_instances as ai')
          .join('nivaro_approval_chains as c', 'ai.chain', 'c.id')
          .join('nivaro_approval_steps as st', (j) => {
            j.on('st.chain', 'c.id').andOn('st.step_order', 'ai.current_step')
          })
          .where('ai.status', 'pending')
          .where((qb) => {
            void qb.where('st.approver_user', userId).orWhereIn('st.approver_role', (sub) => {
              void sub.from('nivaro_users').where('id', userId).select('role')
            })
          })
          .select('ai.id', 'ai.collection', 'ai.item', 'c.name as chain_name', 'ai.current_step')
          .limit(50)
          .catch(() => []),
        db('nivaro_notifications')
          .where({ recipient: userId, status: 'inbox' })
          .orderBy('timestamp', 'desc')
          .limit(15)
          .select('id', 'subject', 'message', 'sender', 'collection', 'item', 'timestamp')
          .catch(() => []),
        // Team tasks waiting for someone to pick them up (#1014).
        teamIds.length
          ? taskBase()
              .whereIn('t.team_id', teamIds)
              .whereNull('t.assignee')
              .where((w) => w.whereNull('t.kind').orWhereNot('t.kind', 'support'))
              .catch(() => [])
          : Promise.resolve([]),
        // What I asked others to do and am still waiting on (#1015).
        taskBase()
          .where('t.created_by', userId)
          .where((w) => w.whereNull('t.assignee').orWhereNot('t.assignee', userId))
          .select('t.nudged_at')
          .catch(() =>
            taskBase()
              .where('t.created_by', userId)
              .where((w) => w.whereNull('t.assignee').orWhereNot('t.assignee', userId))
              .catch(() => [])
          )
      ])

    // The record each task sits on, the way people name it.
    const allTasks = [...tasks, ...teamTasks, ...requested] as Array<Record<string, unknown>>
    const byCol = new Map<string, string[]>()
    for (const t of allTasks) {
      if (!t.collection || !t.item) continue
      const c = String(t.collection)
      if (!byCol.has(c)) byCol.set(c, [])
      byCol.get(c)!.push(String(t.item))
    }
    const labels = new Map<string, string>()
    if (byCol.size) {
      const { resolveFriendlyIds } = await import('../services/workflow-transitions.js')
      await Promise.all(
        [...byCol].map(async ([c, ids]) => {
          const m = await resolveFriendlyIds(c, ids).catch(() => new Map<string, string>())
          for (const [id, l] of m) labels.set(`${c}\u0000${id}`, l)
        })
      )
    }
    const named = (rows: Array<Record<string, unknown>>) =>
      rows.map((t) => ({
        ...t,
        item_label:
          t.collection && t.item
            ? (labels.get(`${t.collection}\u0000${t.item}`) ?? String(t.item))
            : t.kind === 'support'
              ? 'General Support'
              : null,
        assignee_name: [t.assignee_first, t.assignee_last].filter(Boolean).join(' ') || null,
        assignee_first: undefined,
        assignee_last: undefined
      }))

    // SLA per owned record, batched per collection.
    const owned: OwnedEntry[] = ownedResult.items.map((i) => ({
      collection: i.collection,
      item: String(i.item_id),
      label: i.label,
      state: i.state,
      state_color: i.state_color,
      url: i.url,
      sla: null
    }))
    const byCollection = new Map<string, string[]>()
    for (const o of owned) {
      const list = byCollection.get(o.collection) ?? []
      list.push(o.item)
      byCollection.set(o.collection, list)
    }
    await Promise.all(
      [...byCollection.entries()].map(async ([collection, ids]) => {
        try {
          const statuses = await computeStatusBatch(collection, ids)
          for (const o of owned) {
            if (o.collection === collection && statuses[o.item]) o.sla = statuses[o.item]
          }
        } catch {
          /* SLA is decoration — never fail the inbox */
        }
      })
    )
    // Most urgent first: breached, warning, then by state entry recency proxy (stable).
    owned.sort(
      (a, b) => (SLA_RANK[a.sla?.status ?? ''] ?? 3) - (SLA_RANK[b.sla?.status ?? ''] ?? 3)
    )

    return reply.send({
      data: {
        owned: owned.slice(0, 100),
        owned_total: owned.length,
        tasks: named(tasks as Array<Record<string, unknown>>),
        team_tasks: named(teamTasks as Array<Record<string, unknown>>),
        requested: named(requested as Array<Record<string, unknown>>),
        on_a_team: teamIds.length > 0,
        approvals: approvalSteps,
        notifications,
        counts: {
          owned: owned.length,
          owned_breached: owned.filter((o) => o.sla?.status === 'breached').length,
          owned_warning: owned.filter((o) => o.sla?.status === 'warning').length,
          tasks: tasks.length,
          team_tasks: teamTasks.length,
          requested: requested.length,
          approvals: approvalSteps.length,
          notifications: notifications.length
        }
      }
    })
  })
}
