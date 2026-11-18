import { db } from '../../../db/index.js'
import { noteTicketWrite } from '../../support-ticket-events.js'
import { sanitizeMarkdown } from '../templates.js'
import { addTrackerComment } from './comments.js'
import type { SourceActor, SourceView, TrackerSource } from './types.js'

/**
 * Support tickets (`nivaro_tasks` kind 'support'). Statuses open | in_progress | done | cancelled,
 * priorities low | normal | urgent, the thread is `nivaro_comments` on (nivaro_tasks, id).
 * Text is written by people, so every string variable is markdown-sanitised before a template
 * sees it. Admins and the people who work the ticket (canWorkTicket) may create from it — for
 * non-admins also only with a role in the connection's create_roles (checked by the caller).
 */

export const TICKET_STATUS_LIST = ['open', 'in_progress', 'done', 'cancelled'] as const
export const TICKET_PRIORITY_LIST = ['low', 'normal', 'urgent'] as const
const DESCRIPTION_MAX = 8000
const SUPPORT_KIND = 'support'

type Row = Record<string, unknown>

const one = (v: unknown) => sanitizeMarkdown(String(v ?? ''), { singleLine: true })
const iso = (v: unknown): string => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

export async function loadTicketRow(id: string | number): Promise<Row | null> {
  const n = Number(id)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  const row = (await db('nivaro_tasks').where({ id: n, kind: SUPPORT_KIND }).first()) as
    | Row
    | undefined
  return row ?? null
}

async function nameOf(userId: unknown): Promise<string> {
  if (!userId) return ''
  const u = (await db('nivaro_users')
    .where({ id: String(userId) })
    .first('first_name', 'last_name', 'email')
    .catch(() => undefined)) as Row | undefined
  if (!u) return ''
  return (
    [u.first_name, u.last_name]
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
      .join(' ') || String(u.email ?? '').split('@')[0]
  )
}

/** The admin link for one ticket (`/support?ticket=<id>`). */
export async function ticketUrl(id: number): Promise<string> {
  const { linkTo } = await import('../../app-links.js')
  return linkTo('support', { id }, { app: 'admin' })
}

export async function ticketView(row: Row): Promise<SourceView> {
  const id = Number(row.id)
  let category = ''
  if (row.category_id != null) {
    const c = (await db('nivaro_task_categories')
      .where({ id: Number(row.category_id) })
      .first('name')
      .catch(() => undefined)) as Row | undefined
    category = String(c?.name ?? '')
  }
  const url = await ticketUrl(id)
  const description =
    row.description == null ? '' : String(row.description).slice(0, DESCRIPTION_MAX)
  const vars: Record<string, unknown> = {
    title: one(row.title),
    description: sanitizeMarkdown(description),
    // the issue-template names, so a template written for issues still reads
    details: sanitizeMarkdown(description),
    status: one(row.status),
    priority: one(row.priority),
    category: one(category),
    category_id: row.category_id == null ? null : Number(row.category_id),
    requester: one(await nameOf(row.created_by)),
    assignee: one(await nameOf(row.assignee)),
    collection: one(row.collection),
    item: one(row.item),
    created_at: iso(row.created_at),
    first_seen: iso(row.created_at),
    nivaro_url: url,
    ticket_id: id
  }
  return {
    kind: 'ticket',
    id: String(id),
    title: String(row.title ?? ''),
    body: row.description == null ? null : String(row.description),
    status: row.status == null ? null : String(row.status),
    priority: row.priority == null ? null : String(row.priority),
    url,
    fingerprint: null,
    vars
  }
}

/**
 * Tell the requester and the people who work the ticket about a change GitLab made, the way a desk
 * reply / status change does (notifyTicket: their own rules; the requester's copy asks for email
 * when `support_email_updates` is on). Done / cancelled settles the ticket's open notifications.
 * Needs the app (io-holder); before boot, or on any failure, nothing is sent. Never throws.
 */
export async function notifyTicketFromGitLab(
  ticketId: number,
  e:
    | { kind: 'reply'; author: string; text: string }
    | { kind: 'status'; status: string; note: string },
  actorId: string
): Promise<void> {
  try {
    const { getApp } = await import('../../io-holder.js')
    const app = getApp()
    if (!app) return
    const row = await loadTicketRow(ticketId)
    if (!row) return
    const st = await import('../../support-tickets.js')
    const t = row as unknown as Parameters<typeof st.notifyTicket>[1]
    const recipients: Array<string | null> = [String(row.created_by ?? '') || null]
    if (row.assignee) recipients.push(String(row.assignee))
    else recipients.push(...(await st.supportAudience((row.team_id as number | null) ?? null)))
    const title = String(row.title ?? '')
    if (e.kind === 'reply') {
      await st.notifyTicket(app, t, recipients, {
        subject: `${e.author} replied on GitLab: ${title}`,
        message: e.text.slice(0, 400),
        actorId,
        category: 'workflow',
        emailRequester: true
      })
      return
    }
    const label = st.STATUS_LABELS[e.status as keyof typeof st.STATUS_LABELS] ?? e.status
    await st.notifyTicket(app, t, recipients, {
      subject: `${label}: ${title}`,
      message: e.note,
      actorId,
      category: 'workflow',
      emailRequester: true
    })
    if (e.status === 'done' || e.status === 'cancelled') {
      const { resolveNotifications } = await import('../../notification-resolve.js')
      await resolveNotifications({
        on: 'ticket',
        id: ticketId,
        at: new Date(),
        actorId,
        status: e.status
      })
    }
  } catch {
    // a notice that cannot go out never undoes the change
  }
}

async function writeTicket(
  id: string,
  patch: Row,
  actor: SourceActor,
  fallbackNote: string
): Promise<boolean> {
  const n = Number(id)
  const now = new Date()
  const res = await db('nivaro_tasks')
    .where({ id: n, kind: SUPPORT_KIND })
    .update({ ...patch, updated_at: now })
  if (!Number(res)) return false
  const { logActivity } = await import('../../activity.js')
  await logActivity({
    action: 'update',
    user: actor.userId,
    collection: 'nivaro_tasks',
    item: String(n),
    comment: actor.note ?? fallbackNote,
    origin: 'integration'
  })
  noteTicketWrite(n, 'changed')
  return true
}

export const ticketSource: TrackerSource = {
  kind: 'ticket',

  async load(id) {
    const row = await loadTicketRow(id)
    return row ? ticketView(row) : null
  },

  async canRead(user, id, isAdmin) {
    const row = await loadTicketRow(id)
    if (!row) return false
    if (isAdmin) return true
    const { canSeeTicket } = await import('../../support-tickets.js')
    return canSeeTicket(
      { id: String(user.id).toUpperCase(), isAdmin: false },
      row as unknown as Parameters<typeof canSeeTicket>[1]
    )
  },

  async canCreate(user, id, isAdmin) {
    const row = await loadTicketRow(id)
    if (!row) return false
    if (isAdmin) return true
    const { canWorkTicket } = await import('../../support-tickets.js')
    return canWorkTicket(
      { id: String(user.id).toUpperCase(), isAdmin: false },
      row as unknown as Parameters<typeof canWorkTicket>[1]
    )
  },

  async setStatus(id, status, actor) {
    if (!(TICKET_STATUS_LIST as readonly string[]).includes(status)) return
    const closed = status === 'done' || status === 'cancelled'
    const note = actor.note ?? `GitLab: status ${status}`
    if (await writeTicket(id, { status, completed_at: closed ? new Date() : null }, actor, note))
      await notifyTicketFromGitLab(Number(id), { kind: 'status', status, note }, actor.userId)
  },

  async setPriority(id, priority, actor) {
    if (!(TICKET_PRIORITY_LIST as readonly string[]).includes(priority)) return
    await writeTicket(id, { priority }, actor, `GitLab: priority ${priority}`)
  },

  async addComment(id, text, meta) {
    await addTrackerComment('nivaro_tasks', Number(id), text, meta)
    await db('nivaro_tasks')
      .where({ id: Number(id) })
      .update({ updated_at: new Date() })
      .catch(() => {})
    const { trackerUserId } = await import('../identity.js')
    await notifyTicketFromGitLab(
      Number(id),
      { kind: 'reply', author: meta.author, text },
      await trackerUserId()
    )
  },

  ref: (id) => ({ collection: 'nivaro_tasks', item: String(id) }),
  readers: () => 'everyone-who-can-read'
}
