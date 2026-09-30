/**
 * Support tickets (#999) — requests people raise for administrators ("change
 * this workflow's project", "I need access to the National zone"). A ticket is
 * a nivaro_tasks row with kind 'support': it points at a record or at nothing
 * (General Support), carries a category, and waits unassigned with its team
 * (NULL = the administrators) until someone claims it.
 *
 * Status: open → in_progress → done, or cancelled. The thread is
 * nivaro_comments on (nivaro_tasks, id); the history is nivaro_activity rows on
 * the same pair, each carrying a plain sentence in `comment`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { notifyUser } from './notification-channels.js'

export const SUPPORT_KIND = 'support'
export const TICKET_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]
export const OPEN_STATUSES: TicketStatus[] = ['open', 'in_progress']

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled'
}

export interface TicketRow {
  id: number
  kind: string | null
  collection: string | null
  item: string | null
  title: string
  description: string | null
  assignee: string | null
  status: string
  priority: string
  created_by: string
  category_id: number | null
  team_id: number | null
  attachments: string | null
  legacy_id: number | null
  completed_at: Date | null
  created_at: Date | null
  updated_at: Date | null
}

export interface TicketViewer {
  id: string
  isAdmin: boolean
}

export function viewerOf(req: FastifyRequest): TicketViewer {
  return { id: String(req.user!.id).toUpperCase(), isAdmin: !!req.isAdmin }
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toUpperCase() === b.toUpperCase()

/** Team ids the person belongs to (tickets routed to those teams are theirs to work). */
export async function teamIdsOf(userId: string): Promise<number[]> {
  const rows = (await db('nivaro_user_group_members')
    .where('user', userId)
    .select('group_id')
    .catch(() => [])) as Array<{ group_id: number }>
  return rows.map((r) => Number(r.group_id))
}

/** Can this person work tickets at all (the desk)? Administrators, or members
 *  of a team some active category routes to. */
export async function canWorkDesk(viewer: TicketViewer): Promise<boolean> {
  if (viewer.isAdmin) return true
  const teams = await teamIdsOf(viewer.id)
  if (!teams.length) return false
  const hit = await db('nivaro_task_categories')
    .whereIn('team_id', teams)
    .where('is_active', true)
    .first('id')
    .catch(() => undefined)
  return !!hit
}

/** requester, assignee, administrators, members of the ticket's team. */
export async function canSeeTicket(viewer: TicketViewer, t: TicketRow): Promise<boolean> {
  if (viewer.isAdmin) return true
  if (same(t.created_by, viewer.id) || same(t.assignee, viewer.id)) return true
  if (t.team_id != null) return (await teamIdsOf(viewer.id)).includes(Number(t.team_id))
  return false
}

/** Who may work (claim, reassign, change status of) this ticket. */
export async function canWorkTicket(viewer: TicketViewer, t: TicketRow): Promise<boolean> {
  if (viewer.isAdmin || same(t.assignee, viewer.id)) return true
  if (t.team_id != null) return (await teamIdsOf(viewer.id)).includes(Number(t.team_id))
  return false
}

/** The people told about a new, unclaimed ticket: its team, else every active
 *  administrator. Machine accounts and people who cannot sign in are skipped. */
export async function supportAudience(teamId: number | null): Promise<string[]> {
  const base = () =>
    db('nivaro_users as u')
      .where('u.status', 'active')
      .where((q) => q.where('u.is_redacted', false).orWhereNull('u.is_redacted'))
      .whereNull('u.account_kind')
  const rows = (
    teamId != null
      ? await base()
          .join('nivaro_user_group_members as m', 'm.user', 'u.id')
          .where('m.group_id', teamId)
          .select('u.id')
      : await base()
          .join('nivaro_roles as r', 'r.id', 'u.role')
          .where('r.admin_access', true)
          .select('u.id')
  ) as Array<{ id: string }>
  return [...new Set(rows.map((r) => String(r.id).toUpperCase()))]
}

export function userName(
  row: { first_name?: string | null; last_name?: string | null; email?: string | null } | undefined
): string | null {
  if (!row) return null
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || null
}

export async function nameOf(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const u = await db('nivaro_users')
    .where('id', userId)
    .first('first_name', 'last_name', 'email')
    .catch(() => undefined)
  return userName(u as never)
}

/** One history line on the ticket. */
export async function logTicketEvent(
  ticketId: number,
  userId: string | null,
  comment: string,
  req?: FastifyRequest,
  action = 'update'
): Promise<void> {
  await logActivity({
    action,
    user: userId,
    collection: 'nivaro_tasks',
    item: String(ticketId),
    comment,
    req
  })
}

export function parseAttachments(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/** Tell people about a ticket, each through their own notification rules. */
export async function notifyTicket(
  app: FastifyInstance,
  t: TicketRow,
  recipients: Array<string | null | undefined>,
  opts: {
    subject: string
    message: string
    actorId: string | null
    category: 'system' | 'workflow'
  }
): Promise<void> {
  const seen = new Set<string>()
  for (const r of recipients) {
    if (!r) continue
    const id = r.toUpperCase()
    if (seen.has(id) || same(id, opts.actorId)) continue
    seen.add(id)
    await notifyUser(app, id, {
      subject: opts.subject,
      message: opts.message,
      sender: opts.actorId,
      category: opts.category,
      target: { kind: 'support', id: t.id },
      source: { kind: 'support', label: 'Support ticket', id: t.id },
      why: same(id, t.created_by)
        ? 'you raised this support request'
        : same(id, t.assignee)
          ? 'the support request is assigned to you'
          : 'you work support requests'
    }).catch(() => undefined)
  }
}
