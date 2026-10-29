/**
 * Everyday-work tools — My Work, queues, tasks and notifications, all as the
 * key's user. Each list is paged or cut to a model-sized slice and says when
 * it left something out.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type AgentQuestion,
  completeTask,
  createTask,
  listMyTasks,
  listNotifications,
  listQueues,
  listTasks,
  markAllNotificationsRead,
  markNotificationsRead,
  type NivaroClient,
  type QueueOwner,
  readMyWork,
  readQueueItems
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ, WRITE, WRITE_IDEMPOTENT } from '../annotations.js'
import { clip, clipRow, pageOf, personName } from '../compact.js'
import { fail, ok, refuse } from '../result.js'
import { clampTo, collectionName, numericId, recordId, uuid } from '../schema.js'
import { summarizeQuestion } from './agents.js'

type Row = Record<string, unknown>

/** The parts of a task a model needs; absent values are left out. */
export function summarizeTask(t: Row): Row {
  const out: Row = {}
  for (const key of [
    'id',
    'title',
    'status',
    'priority',
    'due_date',
    'collection',
    'item',
    'item_label',
    'assignee',
    'assignee_name',
    'agent_name',
    'team_name',
    'created_by_name',
    'completed_at'
  ]) {
    if (t[key] !== undefined && t[key] !== null) out[key] = t[key]
  }
  if (typeof t.description === 'string' && t.description) {
    out.description = clip(t.description, 300)
  }
  return out
}

/**
 * A chat notification (a mention, an urgent DM) quotes the message. A connection
 * that was not allowed chat (#2492) sees that one arrived, never what it said.
 */
function summarizeNotification(n: Row, chat = true): Row {
  if (!chat && n.collection === '__chat__') {
    return {
      id: n.id,
      unread: n.status === 'inbox',
      at: n.timestamp ?? n.created_at ?? null,
      chat_hidden: 'A chat message. This connection is not allowed to read chat.'
    }
  }
  const out: Row = {
    id: n.id,
    subject: n.subject ?? n.title ?? null,
    message: clip(n.message, 200),
    unread: n.status === 'inbox',
    at: n.timestamp ?? n.created_at ?? null
  }
  for (const key of ['lane', 'category', 'collection', 'item', 'sender_name', 'url']) {
    if (n[key] !== undefined && n[key] !== null) out[key] = n[key]
  }
  return out
}

const ownerName = (o: QueueOwner | null | undefined) =>
  o ? personName(o.first_name, o.last_name, o.email) : null

export function registerWorkTools(
  server: McpServer,
  client: NivaroClient,
  options: { chat?: boolean } = {}
) {
  const chat = options.chat === true
  const note = (n: Row) => summarizeNotification(n, chat)
  server.registerTool(
    'my_work',
    {
      title: 'My Work',
      description:
        "The key's user's inbox: records they own (most urgent SLA first), their tasks, team tasks waiting to be picked up, tasks they asked others to do, approval steps and unread notifications. For an agent connection also agent_tasks (tasks handed to this connection: pick them up with update_task status in_progress, finish with complete_task) and answers (replies to your ask_human questions, shown once). Start here when asked what needs doing.",
      inputSchema: {
        limit: z.number().int().optional().describe('Entries per section (1–50, default 10).')
      },
      annotations: READ
    },
    async ({ limit }) => {
      try {
        const n = clampTo(limit, 10, 50)
        const res = await client.request(readMyWork())
        const data = res.data as unknown as Record<string, unknown>
        const list = (key: string) => (Array.isArray(data[key]) ? (data[key] as Row[]) : [])
        const truncated: string[] = []
        const take = (key: string, total?: number) => {
          const rows = list(key)
          if ((total ?? rows.length) > n) truncated.push(key)
          return rows.slice(0, n)
        }
        const out: Row = {
          counts: data.counts,
          owned: take('owned', Number(data.owned_total ?? 0)).map((o) => {
            const sla = o.sla as Row | null
            return {
              collection: o.collection,
              item: o.item,
              label: o.label,
              state: o.state ?? null,
              sla: sla ? { status: sla.status, remaining_hours: sla.remaining_hours } : null
            }
          }),
          tasks: take('tasks').map(summarizeTask),
          team_tasks: take('team_tasks').map(summarizeTask),
          requested: take('requested').map(summarizeTask),
          approvals: take('approvals'),
          notifications: take('notifications').map(note)
        }
        // #3220 — questions assistants asked this person; #3223 / #3220 — for an agent
        // connection, the tasks handed to it and answers to its questions (now collected).
        const questions = take('questions').map((q) =>
          summarizeQuestion(q as unknown as AgentQuestion)
        )
        if (questions.length) out.questions_for_you = questions
        if (data.agent) {
          out.agent_tasks = take('agent_tasks').map(summarizeTask)
          out.answers = list('answers').map((q) => summarizeQuestion(q as unknown as AgentQuestion))
        }
        if (truncated.length > 0) {
          out.truncated = truncated
          out.note = `Only the first ${n} of each listed section are shown; counts has the totals.`
        }
        return ok(out)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'list_queues',
    {
      title: 'List my queues',
      description:
        "The worklists the key's user can open (their own and those shared with their role), with the collections each reads. Use read_queue to see a queue's items.",
      inputSchema: {
        limit: z.number().int().optional().describe('Queues per page (1–100, default 25).'),
        offset: z.number().int().min(0).optional()
      },
      annotations: READ
    },
    async ({ limit, offset }) => {
      try {
        const res = await client.request(listQueues())
        const page = pageOf(res.data, clampTo(limit, 25, 100), offset)
        return ok({
          queues: page.items.map((q) => {
            const row = q as unknown as Row
            return {
              id: q.id,
              name: q.name,
              description: clip(q.description, 200),
              shared: q.is_shared,
              claims_enabled: q.claims_enabled,
              source_collections: row.source_collections ?? []
            }
          }),
          total: page.total,
          offset: page.offset,
          truncated: page.truncated
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'read_queue',
    {
      title: 'Read a queue',
      description:
        "One page of a queue's items: label, state, owners, SLA status, age. scope 'mine' is what the key's user owns, 'unowned' has no owner, 'claimed' is what they picked up, 'all' is everything.",
      inputSchema: {
        queue_id: uuid.describe('The queue id from list_queues.'),
        scope: z.enum(['mine', 'unowned', 'all', 'claimed']).default('all'),
        sort: z
          .string()
          .optional()
          .describe('Column key, "-" first for descending (e.g. "-aging_hours").'),
        page: z.number().int().min(1).optional().describe('1-based page (default 1).'),
        limit: z.number().int().optional().describe('Items per page (1–100, default 25).')
      },
      annotations: READ
    },
    async ({ queue_id, scope, sort, page, limit }) => {
      try {
        const size = clampTo(limit, 25, 100)
        const at = page ?? 1
        const res = await client.request(
          readQueueItems(queue_id, { scope, sort: sort || undefined, page: at, limit: size })
        )
        const total = res.total ?? res.data.length
        const out: Row = {
          items: res.data.map((i) => {
            const item: Row = {
              collection: i.collection,
              id: i.item_id,
              label: i.label,
              state: i.state,
              owners: i.owners.map(ownerName).filter(Boolean),
              sla_status: i.sla_status,
              at_risk: i.at_risk,
              aging_hours: i.aging_hours
            }
            if (i.claimed_by) item.claimed_by = ownerName(i.claimed_by)
            if (i.extra && Object.keys(i.extra).length > 0) item.extra = clipRow(i.extra, 200)
            return item
          }),
          total,
          page: at,
          limit: size,
          truncated: at * size < total,
          stats: res.stats
        }
        const empty = (res as unknown as Row).empty
        if (empty) out.empty = empty
        return ok(out)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        "Tasks on one record (pass collection and id), or else the key's user's own open tasks. status narrows either list.",
      inputSchema: {
        collection: collectionName.optional(),
        id: recordId.optional(),
        status: z
          .enum(['active', 'open', 'in_progress', 'done', 'cancelled', 'all'])
          .optional()
          .describe('"active" = open + in progress.'),
        limit: z.number().int().optional().describe('Tasks per page (1–200, default 25).'),
        offset: z.number().int().min(0).optional()
      },
      annotations: READ
    },
    async ({ collection, id, status, limit, offset }) => {
      if ((collection === undefined) !== (id === undefined)) {
        return refuse('Pass both collection and id for a record, or neither.', 'BAD_ARGUMENTS')
      }
      try {
        const res =
          collection !== undefined && id !== undefined
            ? await client.request(listTasks({ collection, item: String(id), status }))
            : status && status !== 'active'
              ? await client.request(listTasks({ assignee: 'me', status }))
              : await client.request(listMyTasks())
        const page = pageOf(res.data as unknown as Row[], clampTo(limit, 25, 200), offset)
        return ok({
          tasks: page.items.map(summarizeTask),
          total: page.total,
          offset: page.offset,
          truncated: page.truncated
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'create_task',
    {
      title: 'Create a task',
      description:
        'Ask a person (assignee, a user id from find_people) or a team (team_id) to do something on one record. A person out of office with a delegate hands it on; delegated_from says so. agent: "self" hands it to this connection (it then shows in my_work agent_tasks).',
      inputSchema: {
        collection: collectionName,
        id: recordId,
        title: z.string().min(1).max(500),
        assignee: uuid.optional().describe('User id of the person to do it.'),
        team_id: z.number().int().positive().optional(),
        description: z.string().optional(),
        due_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}/, 'A date is YYYY-MM-DD')
          .optional()
          .describe('YYYY-MM-DD.'),
        priority: z.enum(['low', 'normal', 'urgent']).optional(),
        agent: z
          .string()
          .regex(/^(self|o[0-9a-f-]{36}|k\d{1,12})$/i)
          .optional()
          .describe('"self" = this connection; or another agent connection key.')
      },
      annotations: WRITE
    },
    async ({
      collection,
      id,
      title,
      assignee,
      team_id,
      description,
      due_date,
      priority,
      agent
    }) => {
      try {
        const res = await client.request(
          createTask({
            collection,
            item: String(id),
            title,
            assignee,
            team_id,
            description,
            due_date,
            priority,
            agent
          })
        )
        return ok({
          ...summarizeTask(res.data as unknown as Row),
          delegated_from: res.data.delegated_from ?? null
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'complete_task',
    {
      title: 'Complete a task',
      description:
        'Mark one task done (its assignee, its creator or an administrator). A 409 means it was already closed.',
      inputSchema: { task_id: numericId.describe('The task id from list_tasks or my_work.') },
      annotations: WRITE_IDEMPOTENT
    },
    async ({ task_id }) => {
      try {
        const res = await client.request(completeTask(task_id))
        return ok(summarizeTask(res.data as unknown as Row))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'list_notifications',
    {
      title: 'List notifications',
      description:
        "The key's user's notifications, newest first — unread only unless unread_only is false.",
      inputSchema: {
        unread_only: z.boolean().default(true),
        page: z.number().int().min(1).optional().describe('1-based page (default 1).'),
        limit: z.number().int().optional().describe('Rows per page (1–100, default 20).')
      },
      annotations: READ
    },
    async ({ unread_only, page, limit }) => {
      try {
        const size = clampTo(limit, 20, 100)
        const at = page ?? 1
        const res = await client.request(
          listNotifications({ status: unread_only ? 'inbox' : 'all', page: at, limit: size })
        )
        return ok({
          notifications: res.data.map((n) => note(n as unknown as Row)),
          total: res.total,
          page: at,
          limit: size,
          truncated: at * size < res.total
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'mark_notifications_read',
    {
      title: 'Mark notifications read',
      description:
        "Mark the key's user's notifications read: the ids given (up to 200), or every unread one with all: true.",
      inputSchema: {
        ids: z.array(numericId).max(200).optional(),
        all: z.boolean().optional().describe('true marks every unread notification read.')
      },
      annotations: WRITE_IDEMPOTENT
    },
    async ({ ids, all }) => {
      if (all !== true && (!ids || ids.length === 0)) {
        return refuse('Pass ids, or all: true. Nothing was marked.', 'BAD_ARGUMENTS')
      }
      try {
        const res =
          all === true
            ? await client.request(markAllNotificationsRead())
            : await client.request(markNotificationsRead(ids ?? []))
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )
}
