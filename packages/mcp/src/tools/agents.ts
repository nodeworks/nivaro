/**
 * Agents working with people (#3220, #3223): ask a person a question and read the answer
 * (ask_human / get_human_answer / cancel_question), and move a task along (update_task) —
 * tasks handed to this connection show up in my_work's agent_tasks.
 *
 * A question is also a resource, nivaro://question/<id>: in a live session (/api/mcp?live=1)
 * subscribe to it and a notifications/resources/updated notice arrives when it is answered,
 * expires or is withdrawn.
 */
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type AgentQuestion,
  askHuman,
  cancelAgentQuestion,
  type NivaroClient,
  readAgentQuestion,
  updateTask
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ, WRITE, WRITE_IDEMPOTENT } from '../annotations.js'
import { questionUri } from '../record-resource.js'
import { fail, ok, refuse } from '../result.js'
import { collectionName, numericId, recordId, uuid } from '../schema.js'
import { summarizeTask } from './work.js'

/** The parts of a question a model needs. */
export function summarizeQuestion(q: AgentQuestion): Record<string, unknown> {
  const out: Record<string, unknown> = {
    question_id: q.id,
    status: q.status,
    question: q.question,
    to: q.recipient_name ?? q.recipient,
    expires_at: q.expires_at,
    resource_uri: questionUri(q.id)
  }
  if (q.choices?.length) {
    out.choices = q.choices
    out.free_text_allowed = q.allow_text
  }
  if (q.collection && q.item) out.record = { collection: q.collection, id: q.item }
  if (q.status === 'answered') {
    out.answer = q.answer_choice ?? q.answer
    if (q.answer_choice && q.answer) out.note = q.answer
    out.answered_at = q.answered_at
  }
  return out
}

const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(25)
  .optional()
  .describe('Wait up to this many seconds for the answer before returning (0–25).')

export function registerAgentTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'ask_human',
    {
      title: 'Ask a person',
      description:
        "Ask a person a question and get their answer back — when you need a decision, an approval or a fact only they have. It lands in their notifications and My Work; they answer there. Default recipient is the key's own user ('me'); pass a user id from find_people to ask someone else. Give choices for a quick pick. Returns a question_id: read the answer with get_human_answer (it can wait up to 25 s), from my_work's answers, or by subscribing to resource_uri in a live session. Questions expire (default 24 hours).",
      inputSchema: {
        question: z.string().min(1).max(4000).describe('What you need to know, in plain words.'),
        to: z
          .union([uuid, z.literal('me')])
          .optional()
          .describe('User id of the person to ask, or "me" (default).'),
        choices: z
          .array(z.string().min(1).max(200))
          .max(10)
          .optional()
          .describe('Up to 10 answers to pick from.'),
        allow_text: z
          .boolean()
          .optional()
          .describe('With choices: also let them write their own answer (default false).'),
        expires_in_minutes: z
          .number()
          .int()
          .min(5)
          .max(10080)
          .optional()
          .describe('How long the question stays open (5 minutes to 7 days, default 1 day).'),
        collection: collectionName.optional().describe('The record the question is about.'),
        id: recordId.optional(),
        wait_seconds: waitSeconds
      },
      annotations: WRITE
    },
    async ({
      question,
      to,
      choices,
      allow_text,
      expires_in_minutes,
      collection,
      id,
      wait_seconds
    }) => {
      if ((collection === undefined) !== (id === undefined))
        return refuse('Pass both collection and id for a record, or neither.', 'BAD_ARGUMENTS')
      try {
        const res = await client.request(
          askHuman({
            question,
            to,
            choices,
            allow_text,
            expires_in_minutes,
            collection,
            item: id === undefined ? undefined : String(id)
          })
        )
        let q = res.data
        if (wait_seconds && q.status === 'open')
          q = (await client.request(readAgentQuestion(q.id, wait_seconds))).data
        return ok({
          ...summarizeQuestion(q),
          next:
            q.status === 'open'
              ? 'Not answered yet. Call get_human_answer with question_id (wait_seconds up to 25), or carry on and check my_work later.'
              : undefined
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'get_human_answer',
    {
      title: 'Get the answer to a question',
      description:
        'The state of a question you asked with ask_human: open, answered (with the answer), expired or cancelled. wait_seconds (default 20, at most 25) holds the call until it is answered; call again to keep waiting.',
      inputSchema: {
        question_id: uuid.describe('The question_id ask_human returned.'),
        wait_seconds: waitSeconds
      },
      annotations: READ
    },
    async ({ question_id, wait_seconds }) => {
      try {
        const res = await client.request(readAgentQuestion(question_id, wait_seconds ?? 20))
        return ok(summarizeQuestion(res.data))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'cancel_question',
    {
      title: 'Withdraw a question',
      description:
        'Withdraw a question you asked that is still open (you found the answer another way). It leaves the person’s My Work.',
      inputSchema: { question_id: uuid },
      annotations: WRITE_IDEMPOTENT
    },
    async ({ question_id }) => {
      try {
        const res = await client.request(cancelAgentQuestion(question_id))
        return ok(summarizeQuestion(res.data))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'update_task',
    {
      title: 'Update a task',
      description:
        "Move a task along: status in_progress when you pick it up (tasks handed to this connection are my_work's agent_tasks), open to put it back, cancelled when it should not be done; or change its title, details, due date or priority. Use complete_task to finish it. Its assignee, its creator or an administrator only.",
      inputSchema: {
        task_id: numericId.describe('The task id from my_work or list_tasks.'),
        status: z.enum(['open', 'in_progress', 'cancelled']).optional(),
        title: z.string().min(1).max(500).optional(),
        description: z.string().max(10000).optional(),
        due_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}/, 'A date is YYYY-MM-DD')
          .optional()
          .describe('YYYY-MM-DD.'),
        priority: z.enum(['low', 'normal', 'urgent']).optional()
      },
      annotations: WRITE_IDEMPOTENT
    },
    async ({ task_id, status, title, description, due_date, priority }) => {
      const body = Object.fromEntries(
        Object.entries({ status, title, description, due_date, priority }).filter(
          ([, v]) => v !== undefined
        )
      )
      if (Object.keys(body).length === 0)
        return refuse('Pass at least one thing to change.', 'BAD_ARGUMENTS')
      try {
        const res = await client.request(updateTask(task_id, body))
        return ok(summarizeTask(res.data as unknown as Record<string, unknown>))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerResource(
    'question',
    new ResourceTemplate('nivaro://question/{id}', { list: undefined }),
    {
      title: 'Question to a person',
      description:
        'A question asked with ask_human. In a live session, subscribe to hear when it is answered.',
      mimeType: 'application/json'
    },
    async (uri, vars) => {
      const id = String(Array.isArray(vars.id) ? vars.id[0] : vars.id)
      const res = await client.request(readAgentQuestion(id))
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(summarizeQuestion(res.data))
          }
        ]
      }
    }
  )
}
