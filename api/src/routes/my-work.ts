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
import { mcpConnOf } from '../services/mcp-calls.js'
import { span } from '../services/request-trace.js'
import { taskColumns } from '../services/tasks.js'
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

    return reply.send({
      data: {
        owned: owned.slice(0, 100),
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
        notifications,
        counts: {
          owned: owned.length,
          owned_breached: owned.filter((o) => o.sla?.status === 'breached').length,
          owned_warning: owned.filter((o) => o.sla?.status === 'warning').length,
          tasks: tasks.length,
          team_tasks: teamTasks.length,
          requested: requested.length,
          approvals: approvalSteps.length,
          notifications: notifications.length,
          questions: questions.length,
          ...(agentConn ? { agent_tasks: agentTasks.length, answers: answers.length } : {})
        }
      }
    })
  })
}
