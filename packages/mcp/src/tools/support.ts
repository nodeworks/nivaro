/**
 * Support desk tools (#2493) — tickets on Tasks (kind 'support'), through
 * /api/support with its own gates: requesters see their own requests, desk
 * members (a team a request type routes to) and administrators the desk.
 *
 * Writes rehearse by default (dry_run: true): the ticket is read through the same
 * gate and the report says whether the change would be allowed, with nothing
 * written and nobody notified. dry_run: false makes the change — the API then
 * tells the other side through their notification rules, as it does for the app.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  claimSupportTicket,
  listSupportTickets,
  type NivaroClient,
  readSupportTicket,
  replySupportTicket,
  type SupportTicket,
  type SupportTicketDetail,
  type SupportTicketStatus,
  setSupportTicketStatus
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ, WRITE, WRITE_IDEMPOTENT } from '../annotations.js'
import { clip } from '../compact.js'
import { fail, ok } from '../result.js'
import { clampTo, numericId } from '../schema.js'

const ticketId = numericId.describe('Support ticket id (from support_tickets).')
const dryRun = z
  .boolean()
  .default(true)
  .describe(
    'true (default) rehearses: checks the ticket and whether you may make this change, writes nothing. false makes the change.'
  )

const OPEN = ['open', 'in_progress']

/** The parts of a ticket a model needs; absent values are left out. */
export function summarizeTicket(t: SupportTicket): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of [
    'id',
    'title',
    'status',
    'priority',
    'category_name',
    'team_name',
    'record_label',
    'collection',
    'item',
    'assignee_name',
    'requester_name'
  ] as const) {
    if (t[key] !== undefined && t[key] !== null) out[key] = t[key]
  }
  if (typeof t.description === 'string' && t.description) out.description = clip(t.description, 300)
  return out
}

function summarizeDetail(t: SupportTicketDetail) {
  return {
    ...summarizeTicket(t),
    description: typeof t.description === 'string' ? clip(t.description, 2000) : undefined,
    thread: (t.thread ?? []).slice(-30).map((c) => ({
      id: c.id,
      from: c.user_name,
      from_requester: c.from_requester,
      at: c.created_at,
      text: clip(c.text, 1000)
    })),
    history: (t.history ?? []).slice(-30).map((h) => ({ at: h.at, by: h.user_name, text: h.text })),
    can: t.can
  }
}

export function registerSupportTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'support_tickets',
    {
      title: 'Support tickets',
      description:
        'Support requests. scope "mine" (default) = requests the key\'s user raised; scope "desk" = the desk queue (only for desk members and administrators; others are refused with 403). Filter by status (open, closed, all, or one of open / in_progress / done / cancelled), assignee ("me" or "unassigned"), or text. Read one with support_ticket.',
      inputSchema: {
        scope: z.enum(['mine', 'desk']).default('mine'),
        status: z.string().max(20).optional().describe('open (default), closed, all, or a status.'),
        assignee: z.enum(['me', 'unassigned']).optional(),
        q: z.string().max(200).optional().describe('Words in the title, description or record.'),
        limit: z.number().int().optional().describe('1–50, default 20.')
      },
      annotations: READ
    },
    async ({ scope, status, assignee, q, limit }) => {
      try {
        const n = clampTo(limit, 20, 50)
        const res = await client.request(
          listSupportTickets({
            scope,
            ...(status ? { status } : {}),
            ...(assignee ? { assignee } : {}),
            ...(q ? { q } : {}),
            limit: n
          })
        )
        const rows = res.data ?? []
        return ok({
          scope,
          total: res.total ?? rows.length,
          tickets: rows.map(summarizeTicket),
          ...((res.total ?? 0) > rows.length
            ? { note: `Showing the first ${rows.length}; narrow with status, assignee or q.` }
            : {})
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'support_ticket',
    {
      title: 'Read a support ticket',
      description:
        'One support ticket: summary, the thread (latest 30 replies), history and what the key\'s user may do ("can": work, reply, cancel, reopen). A ticket the user may not see answers 404.',
      inputSchema: { id: ticketId },
      annotations: READ
    },
    async ({ id }) => {
      try {
        return ok(summarizeDetail((await client.request(readSupportTicket(id))).data))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'support_claim',
    {
      title: 'Claim a support ticket',
      description:
        "Pick up a support ticket: assigned to the key's user, status In progress. Desk members and administrators only; the requester is told. Rehearses by default (dry_run: true).",
      inputSchema: { id: ticketId, dry_run: dryRun },
      annotations: WRITE
    },
    async ({ id, dry_run }) => {
      try {
        if (dry_run !== false) {
          const t = (await client.request(readSupportTicket(id))).data
          const open = OPEN.includes(t.status)
          const allowed = t.can?.work === true && open
          return ok({
            dry_run: true,
            would_succeed: allowed,
            ...(allowed
              ? {}
              : {
                  why_not: open
                    ? "The key's user is not on the desk for this ticket"
                    : `Already ${t.status}`
                }),
            ticket: summarizeTicket(t)
          })
        }
        const res = await client.request(claimSupportTicket(id))
        return ok({ dry_run: false, ticket: summarizeTicket(res.data) })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'support_reply',
    {
      title: 'Reply on a support ticket',
      description:
        "Add a reply to a support ticket's thread. The requester or a desk member may reply; the other side is notified. Rehearses by default (dry_run: true) — nothing is posted.",
      inputSchema: {
        id: ticketId,
        text: z.string().min(1).max(8000).describe('The reply, plain text.'),
        dry_run: dryRun
      },
      annotations: WRITE
    },
    async ({ id, text, dry_run }) => {
      try {
        if (dry_run !== false) {
          const t = (await client.request(readSupportTicket(id))).data
          const allowed = t.can?.reply === true
          return ok({
            dry_run: true,
            would_succeed: allowed,
            ...(allowed ? {} : { why_not: "The key's user may not reply on this ticket" }),
            ticket: summarizeTicket(t),
            reply: clip(text, 400)
          })
        }
        await client.request(replySupportTicket(id, text))
        return ok({ dry_run: false, posted: true, id })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'support_set_status',
    {
      title: 'Change a support ticket status',
      description:
        'Move a support ticket to open, in_progress, done or cancelled. Desk members and administrators may set any status; the requester may only cancel or reopen their own. The people on it are notified. Rehearses by default (dry_run: true).',
      inputSchema: {
        id: ticketId,
        status: z.enum(['open', 'in_progress', 'done', 'cancelled']),
        dry_run: dryRun
      },
      annotations: WRITE_IDEMPOTENT
    },
    async ({ id, status, dry_run }) => {
      try {
        if (dry_run !== false) {
          const t = (await client.request(readSupportTicket(id))).data
          const next = status as SupportTicketStatus
          const allowed =
            t.status === next ||
            t.can?.work === true ||
            (next === 'cancelled' && t.can?.cancel === true) ||
            (next === 'open' && t.can?.reopen === true)
          return ok({
            dry_run: true,
            would_succeed: allowed,
            ...(allowed ? {} : { why_not: "The key's user may not set this status here" }),
            from: t.status,
            to: next,
            ticket: summarizeTicket(t)
          })
        }
        const res = await client.request(setSupportTicketStatus(id, status))
        return ok({ dry_run: false, ticket: summarizeTicket(res.data) })
      } catch (err) {
        return fail(err)
      }
    }
  )
}
