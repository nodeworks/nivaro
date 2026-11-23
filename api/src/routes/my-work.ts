import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import {
  markAnswerSeen,
  openQuestionsFor,
  questionNames,
  questionsAskedBy,
  questionView
} from '../services/agent-questions.js'
import { registerAppKeyed } from '../services/app-forget.js'
import { mcpConnOf } from '../services/mcp-calls.js'
import { span } from '../services/request-trace.js'
import { taskColumns } from '../services/tasks.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { approvalStepsFor, ownedWithSla } from '../services/waiting-on-me.js'

/**
 * My Work — one actionable inbox: approvals waiting on ME (records whose
 * current pipeline state resolves me as an owner), my open tasks, approval
 * chain steps naming me, and unread notifications.
 *
 * Aggregation only — every piece reuses an existing engine (owned_by_me queue
 * resolver, SLA batch, tasks, approval instances, notifications) so this page
 * can never disagree with the queues/panels that show the same facts.
 */

/** Tests: forget the shared answers. */
export function clearCountsCache(): void {
  countsCache.clear()
}

/** The tab-title figure: owned records, approval steps and open questions (same as waitingCount()). */
export interface MyWorkCounts {
  owned: number
  approvals: number
  questions: number
}

// Short on purpose: it only collapses same-instant reads of several tabs. A poke-triggered
// refetch (>= 1.5 s debounce + 0.4 s settle after the change) must not get a pre-change answer.
const COUNTS_TTL_MS = 2_000
const countsCache = registerAppKeyed(new Map<string, { at: number; p: Promise<MyWorkCounts> }>())

/** One person's waiting counts, shared for a few seconds so many tabs of one person cost one read. */
export async function waitingCountsFor(userId: string): Promise<MyWorkCounts> {
  const key = `${currentTenantKey()}|${userId}`
  const hit = countsCache.get(key)
  if (hit && Date.now() - hit.at < COUNTS_TTL_MS) return hit.p
  const p = (async () => {
    const { withReadGate } = await import('../services/read-gate.js')
    return withReadGate(
      userId,
      async () => {
        const [owned, approvals, questions] = await Promise.all([
          span('my-work:count-owned', async () => {
            const { resolveOwnedByMeSource } = await import('../services/queues.js')
            const r = await resolveOwnedByMeSource(userId).catch(() => null)
            return r ? r.items.length : 0
          }),
          approvalStepsFor(userId),
          openQuestionsFor(userId, 25).catch(() => [])
        ])
        return { owned, approvals: approvals.length, questions: questions.length }
      },
      { label: 'my-work:counts' }
    )
  })()
  countsCache.set(key, { at: Date.now(), p })
  p.catch(() => {
    if (countsCache.get(key)?.p === p) countsCache.delete(key)
  })
  if (countsCache.size > 2000) {
    for (const [k, v] of countsCache) if (Date.now() - v.at >= COUNTS_TTL_MS) countsCache.delete(k)
  }
  return p
}

export async function myWorkRoutes(app: FastifyInstance) {
  /**
   * S14 — only the numbers the tab title adds up. The full /my-work read also builds task lists,
   * labels, SLA and flags; every open tab re-reads this one instead when something moves.
   */
  app.get('/my-work/counts', { preHandler: requireAuth }, async (req) => ({
    data: await waitingCountsFor(String(req.user?.id))
  }))

  /**
   * rt5 #15 — who the caller is covering for right now (they named the caller their delegate and
   * are out) and how many records wait on the caller only because of it. One indexed read when
   * the caller covers nobody; otherwise the owner resolution runs inside the read gate.
   */
  app.get('/my-work/covering', { preHandler: requireAuth }, async (req) => {
    const userId = String(req.user?.id)
    const { coverFor } = await import('../services/delegate-cover.js')
    const { withReadGate } = await import('../services/read-gate.js')
    const lines = await withReadGate(
      userId,
      () => span('my-work:covering', () => coverFor(userId)),
      {
        label: 'my-work:covering'
      }
    ).catch(() => [])
    return { data: { covering: lines } }
  })

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
    // #3223 — a task handed to an agent names the connection; an agent caller gets its own list.
    const agentCols = (await taskColumns().catch(() => null))?.agent === true
    if (agentCols) taskCols.push('t.agent_assignee', 't.agent_name')
    const conn = mcpConnOf(req)
    const agentConn = conn && /^[ok]/.test(conn) ? conn : null
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

    const [questionRows, answerRows, agentTasks] = await Promise.all([
      // #3220 — what assistants asked me, and (for an agent caller) answers it has not collected.
      openQuestionsFor(userId, 25).catch(() => []),
      agentConn ? questionsAskedBy(agentConn, { status: 'unseen', limit: 25 }) : [],
      agentConn && agentCols
        ? taskBase()
            .where('t.agent_assignee', agentConn)
            .catch(() => [])
        : Promise.resolve([])
    ])
    // Change proposals waiting on my decision (idea 6) — read beside the rest.
    const proposalsP = import('../services/change-proposals.js')
      .then(async (m) => {
        const { isAdminRole } = await import('../services/permissions.js')
        const isAdmin = !!req.isAdmin || (await isAdminRole(req.user!))
        return m.decidableProposalsFor(req.user!, isAdmin, req.workspaceId ?? undefined)
      })
      .catch(() => [])
    const [ownedResult, tasks, approvalSteps, notifications, teamTasks, requested] =
      await Promise.all([
        // Owned records + SLA, most urgent first — the same set Ask AI's
        // waiting_on_me answers from (services/waiting-on-me.ts).
        span('my-work:owned', () => ownedWithSla(userId)),
        taskBase()
          .where('t.assignee', userId)
          .catch(() => []),
        // Approval chains — pending instances whose CURRENT step approver is me
        // (directly, or via my role).
        approvalStepsFor(userId),
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
    const allTasks = [...tasks, ...teamTasks, ...requested, ...agentTasks] as Array<
      Record<string, unknown>
    >
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

    const owned = ownedResult.owned
    const proposals = await proposalsP
    const qNames = await questionNames(
      [...questionRows, ...answerRows].flatMap((q) => [q.asker, q.recipient])
    ).catch(() => new Map<string, string | null>())
    const questions = await Promise.all(
      questionRows.map((q) => questionView(q, { id: userId, isAsker: false }, qNames))
    )
    const answers = await Promise.all(
      answerRows.map((q) => questionView(q, { id: userId, isAsker: true }, qNames))
    )
    // The agent has now read these answers: the next my_work does not repeat them.
    for (const q of answerRows) await markAnswerSeen(q)

    // Army 11 a1 F-2: a held record says so on the row ("On hold" chip) — every
    // at-risk rule each sent row matches, one batched read per collection.
    const sent = owned.slice(0, 100)
    const flags = await import('../services/at-risk-flags.js')
      .then((m) => m.atRiskFlags(sent.map((o) => ({ collection: o.collection, item_id: o.item }))))
      .catch(() => new Map<string, Array<{ name: string; color: string }>>())
    const ownedRows = sent.map((o) => {
      const f = flags.get(`${o.collection}:${o.item}`)
      return f ? { ...o, flags: f } : o
    })

    return reply.send({
      data: {
        owned: ownedRows,
        owned_total: owned.length,
        tasks: named(tasks as Array<Record<string, unknown>>),
        team_tasks: named(teamTasks as Array<Record<string, unknown>>),
        requested: named(requested as Array<Record<string, unknown>>),
        // #3223 / #3220 — present only for an agent connection (OAuth app or API key).
        ...(agentConn
          ? {
              agent: { connection: agentConn },
              agent_tasks: named(agentTasks as Array<Record<string, unknown>>),
              answers
            }
          : {}),
        questions,
        on_a_team: teamIds.length > 0,
        approvals: approvalSteps,
        // Proposed changes on locked records I may accept or decline (idea 6).
        proposals,
        notifications,
        counts: {
          owned: owned.length,
          owned_breached: owned.filter((o) => o.sla?.status === 'breached').length,
          owned_warning: owned.filter((o) => o.sla?.status === 'warning').length,
          tasks: tasks.length,
          team_tasks: teamTasks.length,
          requested: requested.length,
          approvals: approvalSteps.length,
          proposals: proposals.length,
          notifications: notifications.length,
          questions: questions.length,
          ...(agentConn ? { agent_tasks: agentTasks.length, answers: answers.length } : {})
        }
      }
    })
  })
}
