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

    const [ownedResult, tasks, approvalSteps, notifications] = await Promise.all([
      resolveOwnedByMeSource(userId).catch(() => ({ items: [], matchedCount: 0, truncated: false })),
      db('nivaro_tasks')
        .where({ assignee: userId, status: 'open' })
        .orderBy([
          { column: 'due_date', order: 'asc' },
          { column: 'id', order: 'desc' }
        ])
        .limit(50)
        .select('id', 'collection', 'item', 'title', 'due_date', 'status')
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
        .catch(() => [])
    ])

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
        tasks,
        approvals: approvalSteps,
        notifications,
        counts: {
          owned: owned.length,
          owned_breached: owned.filter((o) => o.sla?.status === 'breached').length,
          owned_warning: owned.filter((o) => o.sla?.status === 'warning').length,
          tasks: tasks.length,
          approvals: approvalSteps.length,
          notifications: notifications.length
        }
      }
    })
  })
}
