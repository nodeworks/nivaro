import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { escapeLikeFor, likeOp } from '../db/dialect/ef.js'
import { db } from '../db/index.js'
import { castText, sqlDialect } from '../db/sql-dialect.js'
import { hasColumn } from '../lib/column-probe.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { singular as singularTitle } from '../services/access-words.js'
import { logActivity, logActivityThrottled } from '../services/activity.js'
import { getCollection } from '../services/collections.js'
import { selectInChunks } from '../services/db-batch.js'
import { assertInstanceAccess, InstanceAccessError } from '../services/instance-guard.js'
import { noteIssueWrite } from '../services/issue-raise.js'
import { readOne } from '../services/items.js'
import { cleanAppLabel } from '../services/page-at.js'
import { announceRecordHelp, loadRecordHelp } from '../services/record-help.js'
import { collectionTitle } from '../services/record-label-fallback.js'
import { readShare, type ShareRedis } from '../services/screen-share.js'
import { DEFAULT_TARGETS, loadSupportAnalytics } from '../services/support-analytics.js'
import {
  parseBulkBody,
  parseTicketListQuery,
  type TicketChange,
  ticketOrderClauses,
  waitingSql
} from '../services/support-list.js'
import { noteTicketWrite, ticketChangedByPerson } from '../services/support-ticket-events.js'
import {
  canSeeTicket,
  canWorkDesk,
  canWorkTicket,
  logTicketEvent,
  nameOf,
  notifyTicket,
  OPEN_STATUSES,
  parseAttachments,
  STATUS_LABELS,
  SUPPORT_KIND,
  supportAudience,
  TICKET_STATUSES,
  type TicketRow,
  type TicketStatus,
  teamIdsOf,
  userName,
  viewerOf
} from '../services/support-tickets.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { trackerBadgeOf } from '../services/trackers/comment-badge.js'
import { commentWritten } from '../services/trackers/comment-out-hook.js'
import { resolveFriendlyId, resolveFriendlyIds } from '../services/workflow-transitions.js'
import { screenShareTicketChanged, supportScreenShareRoutes } from './support-screen-share.js'

/**
 * /api/support — support tickets (#999) on the Tasks system.
 *
 * Anyone signed in can raise a ticket (about a record they can read, or General
 * Support) and follow their own; administrators — and members of a team a
 * category routes to — work the desk: claim, reply, move status, reassign.
 * Every change leaves a history line and tells the other side through their
 * notification rules.
 */

interface CategoryRow {
  id: number
  name: string
  description: string | null
  collection: string | null
  team_id: number | null
  default_assignee: string | null
  is_active: boolean | number
  sort: number
  legacy_id: number | null
}

const PRIORITIES = ['low', 'normal', 'urgent']

/** History rows that name an assignment rule: shown only to people who work the ticket. */
export const SUPPORT_RULE_ACTION = 'support-rule'
/**
 * Where those rows live: nivaro_activity under this pseudo collection (item = the ticket id),
 * never under nivaro_tasks — so every reader keyed on (nivaro_tasks, id) (tasks history, record
 * timelines, my_records) can never return them. Only GET /support/tickets/:id reads them, for
 * people who work the ticket; the whole activity log is administrators' anyway.
 */
export const SUPPORT_RULE_LOG = 'nivaro_support_rules'

/** The desk-only line naming the rule that routed a ticket. */
async function logRuleDetail(ticketId: number, comment: string, req: FastifyRequest) {
  await logActivity({
    action: SUPPORT_RULE_ACTION,
    user: null,
    collection: SUPPORT_RULE_LOG,
    item: String(ticketId),
    comment,
    req
  })
}

function serializeCategory(c: CategoryRow & Record<string, unknown>) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    collection: c.collection,
    team_id: c.team_id,
    team_name: (c.team_name as string | null) ?? null,
    default_assignee: c.default_assignee,
    default_assignee_name: userName({
      first_name: c.da_first as string | null,
      last_name: c.da_last as string | null
    }),
    is_active: !!c.is_active,
    sort: c.sort,
    legacy: c.legacy_id != null
  }
}

function ticketQuery() {
  return db('nivaro_tasks as t')
    .leftJoin('nivaro_users as a', 't.assignee', 'a.id')
    .leftJoin('nivaro_users as r', 't.created_by', 'r.id')
    .leftJoin('nivaro_task_categories as c', 't.category_id', 'c.id')
    .leftJoin('nivaro_user_groups as g', 't.team_id', 'g.id')
    .where('t.kind', SUPPORT_KIND)
    .select(
      't.*',
      'a.first_name as a_first',
      'a.last_name as a_last',
      'r.first_name as r_first',
      'r.last_name as r_last',
      'r.email as r_email',
      'c.name as category_name',
      'g.name as team_name'
    )
}

/** Each linked record's name, one batched lookup per collection: its readable id, else its
 *  display label — a purchase order reads "2971054", never its row id "134946" (army 9 b16).
 *  A record nothing names reads as its collection ("Purchase Order"), never the row id. */
export async function recordLabels(rows: TicketRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const byCollection = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.collection || !r.item) continue
    const set = byCollection.get(r.collection) ?? new Set<string>()
    set.add(String(r.item))
    byCollection.set(r.collection, set)
  }
  await Promise.all(
    [...byCollection.entries()].map(async ([c, ids]) => {
      // One failed batch must not rename the whole collection (Fable L9): each id is then
      // asked on its own.
      const batch = await resolveFriendlyIds(c, [...ids]).catch(() => null)
      for (const id of ids) {
        const name = batch ? batch.get(id) : await resolveFriendlyId(c, id).catch(() => id)
        out.set(`${c}:${id}`, name && name !== id ? name : await unnamedRecord(c))
      }
    })
  )
  return out
}

async function unnamedRecord(collection: string): Promise<string> {
  const col = await getCollection(collection).catch(() => null)
  return singularTitle(collectionTitle(collection, col?.display_name))
}

async function serializeTickets(rows: Array<TicketRow & Record<string, unknown>>) {
  const labels = await recordLabels(rows)
  const ids = rows.map((r) => String(r.id))
  const counts = ids.length
    ? ((await db('nivaro_comments')
        .where('collection', 'nivaro_tasks')
        .whereNull('deleted_at')
        .whereIn('item', ids)
        .groupBy('item')
        .select('item')
        .count('* as n')
        .catch(() => [])) as Array<{ item: string; n: number }>)
    : []
  const countOf = new Map(counts.map((c) => [String(c.item), Number(c.n)]))
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    status_label: STATUS_LABELS[r.status as TicketStatus] ?? r.status,
    priority: r.priority,
    collection: r.collection,
    item: r.item,
    record_label: r.collection && r.item ? (labels.get(`${r.collection}:${r.item}`) ?? null) : null,
    category_id: r.category_id,
    category_name: (r.category_name as string | null) ?? null,
    team_id: r.team_id,
    team_name: (r.team_name as string | null) ?? null,
    assignee: r.assignee,
    assignee_name: userName({
      first_name: r.a_first as string | null,
      last_name: r.a_last as string | null
    }),
    created_by: r.created_by,
    requester_name: userName({
      first_name: r.r_first as string | null,
      last_name: r.r_last as string | null,
      email: r.r_email as string | null
    }),
    attachments: parseAttachments(r.attachments),
    // #1390 — the issue a Report a problem filed alongside this request.
    issue_id: r.issue_id == null ? null : Number(r.issue_id),
    // #1377 — 'Watch what they saw' (only admins can open a replay).
    replay: r.replay_recording_id
      ? {
          recording_id: String(r.replay_recording_id),
          offset_ms: r.replay_offset_ms == null ? null : Number(r.replay_offset_ms)
        }
      : null,
    replies: countOf.get(String(r.id)) ?? 0,
    legacy: r.legacy_id != null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at
  }))
}

/**
 * #1377 — the requester's replay link ('Watch what they saw'). Caller-supplied,
 * so only a uuid-shaped id of a recording that exists AND belongs to the
 * requester is kept — a client must not attach someone else's recording.
 * The offset is ms into that recording (clamped, null when not given).
 */
export async function ownReplayLink(
  userId: string,
  raw: unknown
): Promise<{ recording_id: string; offset_ms: number | null } | null> {
  const r = raw as { recording_id?: unknown; offset_ms?: unknown } | null | undefined
  if (typeof r?.recording_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.recording_id)) return null
  const rec = await db('nivaro_session_recordings')
    .where({ id: r.recording_id, user: userId })
    .first('id')
    .catch(() => undefined)
  if (!rec) return null
  const n = r.offset_ms == null ? Number.NaN : Number(r.offset_ms)
  return {
    recording_id: r.recording_id,
    offset_ms: Number.isFinite(n) ? Math.min(Math.max(0, Math.floor(n)), 2_000_000_000) : null
  }
}

/** How long the same request from the same person counts as one (a double-click, a retry). */
const DUPLICATE_WINDOW_S = 30

/** Pure: the claim key of a ticket send — the person plus what they asked about. */
function ticketSendKey(
  userId: string,
  f: {
    title: string
    description: string | null
    collection: string | null
    item: string | null
    category_id: number | null
  },
  tenant = ''
): string {
  const what = createHash('sha256')
    .update(
      JSON.stringify([f.title, f.description ?? '', f.collection, f.item, f.category_id ?? null])
    )
    .digest('hex')
    .slice(0, 32)
  return `nvr:support-send:${tenant}:${String(userId).toUpperCase()}:${what}`
}

const sendClaims = new Map<string, number>()

/** First send of a key in the window wins: Redis SET NX, this process alone when Redis is down. */
async function claimTicketSend(
  redis: FastifyInstance['redis'] | undefined,
  key: string
): Promise<boolean> {
  try {
    if (!redis) throw new Error('no redis')
    return (await redis.set(key, '1', 'EX', DUPLICATE_WINDOW_S, 'NX')) === 'OK'
  } catch {
    const now = Date.now()
    const until = sendClaims.get(key)
    if (until && until > now) return false
    if (sendClaims.size > 5000) sendClaims.clear()
    sendClaims.set(key, now + DUPLICATE_WINDOW_S * 1000)
    return true
  }
}

/** The ticket this person raised for the same request inside the window, if any. */
async function recentTwin(
  userId: string,
  f: { title: string; description: string | null; collection: string | null; item: string | null }
): Promise<(TicketRow & Record<string, unknown>) | undefined> {
  const q = db('nivaro_tasks')
    .where({ kind: SUPPORT_KIND, created_by: userId, title: f.title.slice(0, 500) })
    .where('created_at', '>=', new Date(Date.now() - DUPLICATE_WINDOW_S * 1000))
  if (f.collection) q.where({ collection: f.collection, item: f.item })
  else q.whereNull('collection')
  const rows = (await q.orderBy('id', 'asc').limit(5).select('id', 'description')) as Array<{
    id: number
    description: string | null
  }>
  const twin = rows.find((r) => (r.description ?? null) === (f.description ?? null))
  return twin ? loadTicket(Number(twin.id)) : undefined
}

/** A positive safe integer id, or null — `1e99` or a 20-digit number is "not found", never a driver error. */
function safeId(raw: unknown): number | null {
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

async function loadTicket(id: number): Promise<(TicketRow & Record<string, unknown>) | undefined> {
  if (!Number.isSafeInteger(id) || id <= 0) return undefined
  return (await ticketQuery().where('t.id', id).first()) as
    | (TicketRow & Record<string, unknown>)
    | undefined
}

/** Only files the requester uploaded ride along (the admin will open them). */
async function ownFilesOf(req: FastifyRequest, raw: unknown): Promise<string[]> {
  const attachments = Array.isArray(raw)
    ? raw
        .map(String)
        .filter((s) => /^[0-9a-f-]{32,36}$/i.test(s))
        .slice(0, 20)
    : []
  if (!attachments.length || req.isAdmin) return attachments
  const rows = (await db('nivaro_files')
    .whereIn('id', attachments)
    .where('uploaded_by', req.user!.id)
    .select('id')) as Array<{ id: string }>
  const ok = new Set(rows.map((r) => String(r.id).toLowerCase()))
  return attachments.filter((a) => ok.has(a.toLowerCase()))
}

/**
 * Insert a support request as the caller, log it and tell the desk. Shared
 * by POST /tickets and POST /report-problem (#1390). Columns from migration
 * 425 (replay, issue link) are written only once it has run.
 */
export async function raiseTicket(
  app: FastifyInstance,
  req: FastifyRequest,
  f: {
    title: string
    description: string | null
    collection: string | null
    item: string | null
    category: CategoryRow | null
    priority: string
    attachments: string[]
    replay: { recording_id: string; offset_ms: number | null } | null
    issueId?: number | null
    /** Told before the desk, e.g. a form's owner for a form change request (#2609/#2656). */
    notifyFirst?: string[]
    /** Where it was raised from when the client says (an error's Get help); else derived. */
    source?: 'error' | null
  }
) {
  const replayCols =
    f.replay && (await hasColumn('nivaro_tasks', 'replay_recording_id'))
      ? { replay_recording_id: f.replay.recording_id, replay_offset_ms: f.replay.offset_ms }
      : {}
  const issueCols =
    f.issueId != null && (await hasColumn('nivaro_tasks', 'issue_id'))
      ? { issue_id: f.issueId }
      : {}
  const now = new Date()
  // Who gets it: the first matching assignment rule, then the type's default assignee, then
  // the desk (services/support-assign.ts). A rule that fails to evaluate never stops a request.
  let assignee: string | null = f.category?.default_assignee ?? null
  let teamId: number | null = f.category?.team_id ?? null
  // What the requester may read ("Assigned to Beth") and the desk-only detail naming the rule
  // (a rule's name or reasons can echo record values the requester may not read).
  let publicEvent: string | null = null
  let ruleEvent: string | null = null
  const assign = await import('../services/support-assign.js')
  const rules = await assign.loadRuleSet()
  if (rules.rules.some((r) => r.active)) {
    try {
      const d = await assign.decideAssignment(
        rules,
        {
          category_id: f.category?.id ?? null,
          collection: f.collection,
          item: f.item,
          requester: String(req.user!.id).toUpperCase(),
          priority: f.priority,
          title: f.title,
          description: f.description,
          source: f.source ?? null,
          issue_id: f.issueId ?? null,
          at: now
        },
        {
          trigger: 'create',
          hasAssignee: false,
          typeDefault: f.category?.default_assignee ?? null,
          redis: app.redis
        }
      )
      const o = d.outcome
      if (o.kind === 'person') {
        assignee = o.user.id
        if (o.rule) {
          publicEvent = `Assigned to ${o.user.name}`
          ruleEvent = `Assigned to ${o.user.name} by rule “${o.rule.name}”${
            o.via === 'rule_fallback' ? ' (nobody on it could take it; its fallback)' : ''
          }`
        }
      } else if (o.kind === 'team') {
        assignee = null
        teamId = o.team.id
        publicEvent = `Sent to ${o.team.name}`
        ruleEvent = `Sent to ${o.team.name} by rule “${o.rule.name}”`
      } else if (o.rule) {
        assignee = null
        ruleEvent = `Left on the desk by rule “${o.rule.name}” (nobody on it could take it)`
      }
    } catch (err) {
      req.log.warn({ err }, 'support assignment rules failed; the type default stands')
    }
  }
  const [row] = (await db('nivaro_tasks')
    .insert({
      ...replayCols,
      ...issueCols,
      kind: SUPPORT_KIND,
      collection: f.collection,
      item: f.item,
      title: f.title.slice(0, 500),
      description: f.description,
      assignee,
      category_id: f.category?.id ?? null,
      team_id: teamId,
      attachments: f.attachments.length ? JSON.stringify(f.attachments) : null,
      priority: f.priority,
      status: assignee ? 'in_progress' : 'open',
      created_by: req.user!.id,
      completed_at: null,
      created_at: now,
      updated_at: now
    })
    .returning('id')) as Array<{ id: number } | number>
  const id = Number(typeof row === 'object' ? row.id : row)
  await logTicketEvent(id, req.user!.id, 'Raised the request', req, 'create')
  // GitLab sync: support-ticket rules evaluate the new request (background, never blocks).
  noteTicketWrite(id, 'raised')
  if (publicEvent) await logTicketEvent(id, null, publicEvent, req)
  if (ruleEvent) await logRuleDetail(id, ruleEvent, req)
  assign.noteAssignment(app.redis, assignee, id)
  const t = (await loadTicket(id))!
  announceRecordHelp(t)
  const [s] = await serializeTickets([t])
  const where = s.record_label ? ` on ${s.record_label}` : ' (General Support)'
  const who = s.requester_name ?? 'Someone'
  const message = `${who} asked${where}${s.category_name ? ` · ${s.category_name}` : ''}.${
    s.description ? `\n\n${String(s.description).slice(0, 400)}` : ''
  }`
  // A request that lands with someone (the type's default assignee) tells THEM "Assigned to
  // you" — with email — instead of the desk's "New support request".
  const audience = [
    ...(f.notifyFirst ?? []).filter(
      (r) => !t.assignee || String(r).toUpperCase() !== String(t.assignee).toUpperCase()
    ),
    ...(t.assignee ? [] : await supportAudience(t.team_id))
  ]
  await notifyTicket(app, t, audience, {
    subject: `New support request: ${s.title}`,
    message,
    actorId: req.user!.id,
    category: 'system'
  })
  await notifyAssigned(
    app,
    t,
    t.assignee,
    req.user!.id,
    ruleEvent ? `${ruleEvent}.\n\n${message}` : message
  )
  return s
}

export type TicketChangeResult =
  | { ok: true; ticket: TicketRow & Record<string, unknown>; changed: boolean }
  | { ok: false; http: number; code: string; reason: string }

/** "Assigned to you: <title>" — the one ticket notice that also asks for email (their own
 *  per-category email setting decides: instant, daily summary or off). Never to the actor. */
export async function notifyAssigned(
  app: FastifyInstance,
  t: TicketRow,
  assignee: string | null | undefined,
  actorId: string | null,
  message: string
): Promise<void> {
  if (!assignee) return
  if (actorId && String(assignee).toUpperCase() === String(actorId).toUpperCase()) return
  await notifyTicket(app, t, [assignee], {
    subject: `Assigned to you: ${t.title}`,
    message,
    actorId,
    category: 'workflow',
    email: true
  })
}

/**
 * One change to one ticket — THE path for PATCH /tickets/:id and every id of
 * POST /tickets/bulk: who may make it, validation, the history line, settling
 * the request's notifications on close, the screen share, the record's help
 * badge, and telling people. The caller has already checked the ticket is
 * visible to them (404 otherwise).
 */
export async function applyTicketChange(
  app: FastifyInstance,
  req: FastifyRequest,
  t: TicketRow & Record<string, unknown>,
  b: TicketChange
): Promise<TicketChangeResult> {
  const viewer = viewerOf(req)
  const work = await canWorkTicket(viewer, t)
  const isRequester = String(t.created_by).toUpperCase() === viewer.id
  const onlyStatus = Object.keys(b).every((k) => k === 'status')
  if (!work && !(isRequester && onlyStatus && (b.status === 'cancelled' || b.status === 'open'))) {
    return {
      ok: false,
      http: 403,
      code: 'FORBIDDEN',
      reason: isRequester
        ? 'You can only cancel or reopen your own request'
        : 'You do not work this request'
    }
  }
  const refuse = (reason: string, code = 'INVALID') =>
    ({ ok: false, http: 400, code, reason }) as const
  const patch: Record<string, unknown> = { updated_at: new Date() }
  const events: string[] = []
  const me = (await nameOf(req.user!.id)) ?? 'Someone'
  if (b.status !== undefined && b.status !== t.status) {
    if (!(TICKET_STATUSES as readonly string[]).includes(b.status))
      return refuse(`status must be one of ${TICKET_STATUSES.join(', ')}`)
    patch.status = b.status
    patch.completed_at = b.status === 'done' || b.status === 'cancelled' ? new Date() : null
    // Who closed it (#1001), where the column exists.
    const { taskColumns } = await import('../services/tasks.js')
    if ((await taskColumns()).completedBy)
      patch.completed_by = b.status === 'done' ? viewer.id : null
    events.push(
      `${STATUS_LABELS[t.status as TicketStatus] ?? t.status} → ${STATUS_LABELS[b.status as TicketStatus]}`
    )
  }
  let assignedName: string | null = null
  if (
    b.assignee !== undefined &&
    String(b.assignee ?? '').toUpperCase() !== String(t.assignee ?? '').toUpperCase()
  ) {
    if (b.assignee) {
      const u = await db('nivaro_users').where({ id: b.assignee }).first('id')
      if (!u) return refuse('Unknown assignee', 'UNKNOWN_ASSIGNEE')
      assignedName = (await nameOf(b.assignee)) ?? 'someone'
    }
    patch.assignee = b.assignee || null
    events.push(b.assignee ? `Assigned to ${assignedName}` : 'Unassigned')
  }
  let typeChanged = false
  let typeDefault: string | null = null
  if (b.category_id !== undefined && (b.category_id ?? null) !== (t.category_id ?? null)) {
    let label = 'no type'
    if (b.category_id != null) {
      const c = (await db('nivaro_task_categories')
        .where({ id: safeId(b.category_id) ?? -1 })
        .first('id', 'name', 'team_id', 'default_assignee')) as
        | { id: number; name: string; team_id: number | null; default_assignee: string | null }
        | undefined
      if (!c) return refuse('Unknown support type', 'UNKNOWN_TYPE')
      label = c.name
      patch.team_id = c.team_id
      typeDefault = c.default_assignee
    }
    patch.category_id = b.category_id ?? null
    events.push(`Type changed to ${label}`)
    typeChanged = true
  }
  if (b.priority !== undefined && b.priority !== t.priority) {
    if (!PRIORITIES.includes(b.priority)) return refuse('Unknown priority')
    patch.priority = b.priority
    events.push(`Priority ${b.priority}`)
  }
  if (b.title !== undefined && String(b.title).trim() && b.title !== t.title) {
    patch.title = String(b.title).trim().slice(0, 500)
    events.push('Summary edited')
  }
  // A new type runs the assignment rules (then the type's default) unless the same change names
  // an assignee. Someone who already has it keeps it unless a rule says "also when the type
  // changes".
  let ruleDetail: string | null = null
  if (typeChanged && b.assignee === undefined) {
    const assign = await import('../services/support-assign.js')
    const rules = await assign.loadRuleSet()
    if (rules.rules.some((r) => r.active) || (!t.assignee && typeDefault)) {
      try {
        const d = await assign.decideAssignment(
          rules,
          {
            category_id: (patch.category_id as number | null) ?? null,
            collection: t.collection,
            item: t.item,
            requester: t.created_by ? String(t.created_by).toUpperCase() : null,
            priority: String(patch.priority ?? t.priority),
            title: String(patch.title ?? t.title),
            description: t.description,
            issue_id: (t.issue_id as number | null | undefined) ?? null
          },
          {
            trigger: 'type_change',
            hasAssignee: !!t.assignee,
            typeDefault,
            redis: app.redis
          }
        )
        const o = d.outcome
        if (
          o.kind === 'person' &&
          o.user.id.toUpperCase() !== String(t.assignee ?? '').toUpperCase()
        ) {
          patch.assignee = o.user.id
          events.push(`Assigned to ${o.user.name}`)
          ruleDetail = o.rule
            ? `Assigned to ${o.user.name} by rule “${o.rule.name}”`
            : `Assigned to ${o.user.name} (the type’s default)`
        } else if (o.kind === 'team') {
          patch.team_id = o.team.id
          if (t.assignee) patch.assignee = null
          events.push(`Sent to ${o.team.name}`)
          ruleDetail = `Sent to ${o.team.name} by rule “${o.rule.name}”`
        } else if (o.kind === 'desk' && o.rule && t.assignee) {
          patch.assignee = null
          events.push('Unassigned')
          ruleDetail = `Back on the desk by rule “${o.rule.name}” (nobody on it could take it)`
        }
      } catch (err) {
        req.log.warn({ err }, 'support assignment rules failed on a type change')
      }
    }
  }
  if (!events.length) return { ok: true, ticket: t, changed: false }
  await db('nivaro_tasks').where({ id: t.id }).update(patch)
  // GitLab sync: ticket rules re-run; a status / priority change goes to linked GitLab issues.
  ticketChangedByPerson(t.id, patch, req.user!.id)
  if (typeof patch.assignee === 'string') {
    const { noteAssignment } = await import('../services/support-assign.js')
    noteAssignment(app.redis, patch.assignee as string, t.id)
  }
  announceRecordHelp(t)
  // Closing settles the request's notifications: "Closed by <who>".
  if (patch.status === 'done' || patch.status === 'cancelled') {
    const { resolveNotifications } = await import('../services/notification-resolve.js')
    await resolveNotifications({
      on: 'ticket',
      id: t.id,
      at: new Date(),
      actorId: req.user!.id,
      status: patch.status as 'done' | 'cancelled'
    })
  }
  await logTicketEvent(t.id, req.user!.id, events.join(' · '), req)
  if (ruleDetail) await logRuleDetail(t.id, ruleDetail, req)
  if (patch.assignee !== undefined || patch.team_id !== undefined || patch.status !== undefined)
    await screenShareTicketChanged(app, t.id)
  const updated = (await loadTicket(t.id))!
  const statusMoved = patch.status !== undefined
  const newlyAssigned = typeof patch.assignee === 'string' ? (patch.assignee as string) : null
  // The new assignee hears "Assigned to you" (with email) instead of the general notice.
  const recipients = [t.created_by, updated.assignee].filter(
    (r) => !newlyAssigned || String(r ?? '').toUpperCase() !== newlyAssigned.toUpperCase()
  )
  await notifyTicket(app, updated, recipients, {
    subject: statusMoved
      ? `${STATUS_LABELS[updated.status as TicketStatus]}: ${t.title}`
      : `Support request updated: ${t.title}`,
    message: `${me}: ${events.join(' · ')}`,
    actorId: req.user!.id,
    category: 'workflow',
    // The requester's copy asks for email when they opted in (never the assignee's).
    emailRequester: true
  })
  if (newlyAssigned)
    await notifyAssigned(
      app,
      updated,
      newlyAssigned,
      req.user!.id,
      `${me}: ${events.join(' · ')}${ruleDetail ? `\n\n${ruleDetail}.` : ''}`
    )
  return { ok: true, ticket: updated, changed: true }
}

export async function supportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ── Categories (ticket types) ──────────────────────────────────────────────

  // GET /categories?collection=<c>&any=1  — the types offered for that kind of record
  //   (plus types with no collection). No collection = General Support types.
  //   ?all=1 (admins) = every category incl. inactive, for the editor.
  app.get<{ Querystring: { collection?: string; all?: string; any?: string } }>(
    '/categories',
    async (req, reply) => {
      const q = db('nivaro_task_categories as c')
        .leftJoin('nivaro_user_groups as g', 'c.team_id', 'g.id')
        .leftJoin('nivaro_users as u', 'c.default_assignee', 'u.id')
        .select('c.*', 'g.name as team_name', 'u.first_name as da_first', 'u.last_name as da_last')
        .orderBy('c.sort', 'asc')
        .orderBy('c.name', 'asc')
      if (!(req.query.all === '1' && req.isAdmin)) {
        q.where('c.is_active', true)
        const col = req.query.collection
        // ?any=1 — every active type wherever it is offered (the list filters' Type choices).
        if (req.query.any !== '1') {
          if (col) q.where((w) => w.where('c.collection', col).orWhereNull('c.collection'))
          else q.whereNull('c.collection')
        }
      }
      const rows = (await q) as Array<CategoryRow & Record<string, unknown>>
      return reply.send({ data: rows.map(serializeCategory) })
    }
  )

  app.post<{ Body: Partial<CategoryRow> }>(
    '/categories',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = req.body ?? {}
      const name = String(b.name ?? '').trim()
      if (!name) return reply.code(400).send({ error: 'name is required' })
      const now = new Date()
      const [row] = (await db('nivaro_task_categories')
        .insert({
          name: name.slice(0, 200),
          description: b.description ?? null,
          collection: b.collection || null,
          team_id: b.team_id ?? null,
          default_assignee: b.default_assignee || null,
          is_active: b.is_active === undefined ? true : !!b.is_active,
          sort: Number(b.sort ?? 0) || 0,
          created_at: now,
          updated_at: now
        })
        .returning('id')) as Array<{ id: number } | number>
      const id = typeof row === 'object' ? row.id : row
      await logActivity({
        action: 'create',
        user: req.user!.id,
        collection: 'nivaro_task_categories',
        item: String(id),
        comment: `Support type created: ${name}`,
        req
      })
      return reply.code(201).send({ data: { id } })
    }
  )

  app.patch<{ Params: { id: string }; Body: Partial<CategoryRow> }>(
    '/categories/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = safeId(req.params.id)
      const existing = id != null && (await db('nivaro_task_categories').where({ id }).first('id'))
      if (!existing) return reply.code(404).send({ error: 'Not found' })
      const b = req.body ?? {}
      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (b.name !== undefined) {
        const name = String(b.name).trim()
        if (!name) return reply.code(400).send({ error: 'name cannot be empty' })
        patch.name = name.slice(0, 200)
      }
      if (b.description !== undefined) patch.description = b.description || null
      if (b.collection !== undefined) patch.collection = b.collection || null
      if (b.team_id !== undefined) patch.team_id = b.team_id ?? null
      if (b.default_assignee !== undefined) patch.default_assignee = b.default_assignee || null
      if (b.is_active !== undefined) patch.is_active = !!b.is_active
      if (b.sort !== undefined) patch.sort = Number(b.sort) || 0
      await db('nivaro_task_categories').where({ id }).update(patch)
      return reply.send({ data: { id } })
    }
  )

  // DELETE removes an unused type; one that tickets name is switched off instead.
  app.delete<{ Params: { id: string } }>(
    '/categories/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = safeId(req.params.id)
      if (id == null) return reply.code(404).send({ error: 'Not found' })
      const used = await db('nivaro_tasks').where('category_id', id).first('id')
      if (used) {
        await db('nivaro_task_categories')
          .where({ id })
          .update({ is_active: false, updated_at: new Date() })
        return reply.send({ data: { id, deactivated: true } })
      }
      await db('nivaro_task_categories').where({ id }).delete()
      return reply.code(204).send()
    }
  )

  // ── Tickets ────────────────────────────────────────────────────────────────

  // GET /summary — counts for badges: my open requests, and (desk) unclaimed + mine.
  app.get('/summary', async (req, reply) => {
    const viewer = viewerOf(req)
    const n = (row: unknown) => Number((row as { n?: number } | undefined)?.n ?? 0)
    const mine = n(
      await db('nivaro_tasks')
        .where({ kind: SUPPORT_KIND, created_by: viewer.id })
        .whereIn('status', OPEN_STATUSES)
        .count('* as n')
        .first()
    )
    const desk = await canWorkDesk(viewer)
    let unassigned = 0
    let assigned = 0
    if (desk) {
      const teams = viewer.isAdmin ? null : await teamIdsOf(viewer.id)
      const uq = db('nivaro_tasks')
        .where('kind', SUPPORT_KIND)
        .whereNull('assignee')
        .where('status', 'open')
      if (teams) uq.whereIn('team_id', teams.length ? teams : [-1])
      unassigned = n(await uq.count('* as n').first())
      assigned = n(
        await db('nivaro_tasks')
          .where({ kind: SUPPORT_KIND, assignee: viewer.id })
          .whereIn('status', OPEN_STATUSES)
          .count('* as n')
          .first()
      )
    }
    return reply.send({ data: { mine_open: mine, desk, unassigned, assigned_to_me: assigned } })
  })

  // GET /analytics?days=&first_response_hours=&resolution_hours= (#1424) — the desk's numbers.
  //   Administrators see every team; a team member sees the tickets routed to their teams.
  app.get<{
    Querystring: { days?: string; first_response_hours?: string; resolution_hours?: string }
  }>('/analytics', async (req, reply) => {
    const viewer = viewerOf(req)
    if (!(await canWorkDesk(viewer))) return reply.code(403).send({ error: 'Forbidden' })
    const days = Math.min(365, Math.max(1, Math.trunc(Number(req.query.days)) || 30))
    const target = (v: string | undefined, d: number) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 && n <= 24 * 90 ? n : d
    }
    const data = await loadSupportAnalytics({
      days,
      teamIds: viewer.isAdmin ? null : await teamIdsOf(viewer.id),
      targets: {
        first_response_hours: target(
          req.query.first_response_hours,
          DEFAULT_TARGETS.first_response_hours
        ),
        resolution_hours: target(req.query.resolution_hours, DEFAULT_TARGETS.resolution_hours)
      }
    })
    return reply.send({ data })
  })

  // GET /record/:collection/:item — open requests raised from one record (rt9 #19): the count
  //   for anyone who can read the record, details only for those support lets see the ticket.
  app.get<{ Params: { collection: string; item: string } }>(
    '/record/:collection/:item',
    async (req, reply) => {
      const { collection, item } = req.params
      if (!collection || !item || collection.length > 128 || item.length > 128)
        return reply.code(400).send({ error: 'Bad request' })
      try {
        await assertInstanceAccess(req.user, !!req.isAdmin, collection, item, undefined, 'read')
      } catch (err) {
        if (err instanceof InstanceAccessError)
          return reply.code(err.statusCode).send({ error: err.message })
        throw err
      }
      return reply.send({ data: await loadRecordHelp(viewerOf(req), collection, item) })
    }
  )

  // GET /tickets?scope=mine|desk&status=open|closed|all|<status>&category=&priority=
  //   &assignee=me|unassigned|<user id>&requester=<user id, desk>&q=&sort=&page=&limit=
  //   sort: attention (desk default: urgent, then unassigned, then longest waiting) | newest |
  //   oldest | updated | priority. Each row carries waiting_since (when the requester last
  //   heard back, else when they asked).
  app.get<{ Querystring: Record<string, string | undefined> }>('/tickets', async (req, reply) => {
    const viewer = viewerOf(req)
    const qs = req.query
    let q = ticketQuery()
    const deskScope = qs.scope === 'desk'
    if (deskScope) {
      if (!(await canWorkDesk(viewer))) return reply.code(403).send({ error: 'Forbidden' })
      if (!viewer.isAdmin) {
        const teams = await teamIdsOf(viewer.id)
        q = q.where((w) =>
          w.whereIn('t.team_id', teams.length ? teams : [-1]).orWhere('t.assignee', viewer.id)
        )
      }
    } else if (qs.collection && qs.item) {
      // A record's tickets: requester's own, or everything for a desk worker.
      q = q.where({ 't.collection': qs.collection, 't.item': String(qs.item) })
      if (!(await canWorkDesk(viewer))) q = q.where('t.created_by', viewer.id)
    } else {
      q = q.where('t.created_by', viewer.id)
    }
    const lq = parseTicketListQuery(qs, { desk: deskScope, statuses: TICKET_STATUSES })
    if (lq.status.kind === 'open') q = q.whereIn('t.status', OPEN_STATUSES)
    else if (lq.status.kind === 'closed') q = q.whereIn('t.status', ['done', 'cancelled'])
    else if (lq.status.kind === 'one') q = q.where('t.status', lq.status.status)
    if (lq.category != null) q = q.where('t.category_id', lq.category)
    if (lq.priority) q = q.where('t.priority', lq.priority)
    if (lq.requester) q = q.where('t.created_by', lq.requester)
    if (lq.assignee?.kind === 'me') q = q.where('t.assignee', viewer.id)
    else if (lq.assignee?.kind === 'unassigned') q = q.whereNull('t.assignee')
    else if (lq.assignee?.kind === 'user') q = q.where('t.assignee', lq.assignee.id)
    if (lq.q) {
      const term = `%${escapeLikeFor(db, lq.q)}%`
      const like = likeOp(db)
      q = q.where((w) =>
        w
          .where('t.title', like, term)
          .orWhere('t.description', like, term)
          .orWhere('t.item', like, term)
          .orWhereRaw(`${castText(db, 't.id', 20)} = ?`, [lq.q])
      )
    }
    const total = Number(
      (
        (await q.clone().clearSelect().clearOrder().count('* as n').first()) as
          | { n?: number }
          | undefined
      )?.n ?? 0
    )
    const waiting = waitingSql(sqlDialect(db))
    q = q.select(db.raw(`${waiting} as waiting_since`))
    for (const clause of ticketOrderClauses(lq.sort, lq.status, waiting)) q = q.orderByRaw(clause)
    const rows = (await q.offset((lq.page - 1) * lq.limit).limit(lq.limit)) as Array<
      TicketRow & Record<string, unknown>
    >
    return reply.send({
      data: await serializeTickets(rows),
      total,
      page: lq.page,
      limit: lq.limit,
      sort: lq.sort
    })
  })

  // GET /workload — "who has what" on the desk the caller works (same visibility as
  //   scope=desk): open requests per assignee with the longest wait, the unassigned pile, and
  //   the people who work this desk (the assignee filter's and Assign to…'s choices).
  app.get('/workload', async (req, reply) => {
    const viewer = viewerOf(req)
    if (!(await canWorkDesk(viewer))) return reply.code(403).send({ error: 'Forbidden' })
    const teams = viewer.isAdmin ? null : await teamIdsOf(viewer.id)
    const open = db('nivaro_tasks as t')
      .where('t.kind', SUPPORT_KIND)
      .whereIn('t.status', OPEN_STATUSES)
      .select('t.assignee', 't.priority', db.raw(`${waitingSql(sqlDialect(db))} as w`))
    if (teams)
      open.where((w) =>
        w.whereIn('t.team_id', teams.length ? teams : [-1]).orWhere('t.assignee', viewer.id)
      )
    const grouped = (await db
      .from(open.as('x'))
      .groupBy('x.assignee')
      .select('x.assignee')
      .count('* as n')
      .select(db.raw("SUM(CASE WHEN x.priority = 'urgent' THEN 1 ELSE 0 END) as urgent"))
      .min('x.w as oldest')) as Array<{
      assignee: string | null
      n: number
      urgent: number
      oldest: Date | string | null
    }>
    // Who works this desk: administrators (or the caller's teams), plus anyone holding a request.
    const workerIds = new Set<string>()
    if (teams) {
      if (teams.length) {
        const rows = (await db('nivaro_user_group_members as m')
          .join('nivaro_users as u', 'u.id', 'm.user')
          .whereIn('m.group_id', teams)
          .where('u.status', 'active')
          .whereNull('u.account_kind')
          .select('u.id')) as Array<{ id: string }>
        for (const r of rows) workerIds.add(String(r.id).toUpperCase())
      }
    } else {
      for (const id of await supportAudience(null)) workerIds.add(id)
      const routed = (await db('nivaro_task_categories')
        .where('is_active', true)
        .whereNotNull('team_id')
        .distinct('team_id')) as Array<{ team_id: number }>
      for (const r of routed)
        for (const id of await supportAudience(Number(r.team_id))) workerIds.add(id)
    }
    workerIds.add(viewer.id)
    for (const g of grouped) if (g.assignee) workerIds.add(String(g.assignee).toUpperCase())
    const people = workerIds.size
      ? ((await selectInChunks([...workerIds], 500, (chunk) =>
          db('nivaro_users')
            .whereIn('id', chunk)
            .select('id', 'first_name', 'last_name', 'email', 'status')
        )) as Array<{
          id: string
          first_name: string | null
          last_name: string | null
          email: string | null
          status: string | null
        }>)
      : []
    const byId = new Map(people.map((p) => [String(p.id).toUpperCase(), p]))
    const iso = (v: Date | string | null) =>
      v == null ? null : v instanceof Date ? v.toISOString() : String(v)
    const held = grouped.filter((g) => g.assignee)
    const unassigned = grouped.find((g) => !g.assignee)
    const assignees = held
      .map((g) => {
        const id = String(g.assignee).toUpperCase()
        return {
          id,
          name: userName(byId.get(id)) ?? 'Unknown person',
          open: Number(g.n),
          urgent: Number(g.urgent ?? 0),
          oldest_waiting: iso(g.oldest),
          active: (byId.get(id)?.status ?? 'active') === 'active'
        }
      })
      .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
    const workers = [...workerIds]
      .map((id) => ({ id, name: userName(byId.get(id)) ?? 'Unknown person' }))
      .filter((p) => byId.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name))
    return reply.send({
      data: {
        assignees,
        unassigned: {
          open: Number(unassigned?.n ?? 0),
          urgent: Number(unassigned?.urgent ?? 0),
          oldest_waiting: iso(unassigned?.oldest ?? null)
        },
        workers
      }
    })
  })

  // GET /tickets/:id — the ticket, its thread and its history.
  app.get<{ Params: { id: string } }>('/tickets/:id', async (req, reply) => {
    const viewer = viewerOf(req)
    const t = await loadTicket(Number(req.params.id))
    if (!t || !(await canSeeTicket(viewer, t))) return reply.code(404).send({ error: 'Not found' })
    const [ticket] = await serializeTickets([t])
    // GitLab-mirrored replies carry meta.tracker (migration 532): the thread shows their badge.
    const withMeta = await hasColumn('nivaro_comments', 'meta')
    const thread = (await db('nivaro_comments as c')
      .leftJoin('nivaro_users as u', 'c.user', 'u.id')
      .where({ 'c.collection': 'nivaro_tasks', 'c.item': String(t.id) })
      .whereNull('c.deleted_at')
      .orderBy('c.created_at', 'asc')
      .select(
        'c.id',
        'c.text',
        'c.user',
        'c.created_at',
        'u.first_name',
        'u.last_name',
        ...(withMeta ? ['c.meta'] : [])
      )) as Array<Record<string, unknown>>
    const work = await canWorkTicket(viewer, t)
    // The rule detail rows (SUPPORT_RULE_LOG) only for people who work the ticket.
    const history = (await db('nivaro_activity as a')
      .leftJoin('nivaro_users as u', 'a.user', 'u.id')
      .where('a.item', String(t.id))
      .whereIn('a.collection', work ? ['nivaro_tasks', SUPPORT_RULE_LOG] : ['nivaro_tasks'])
      .whereNotNull('a.comment')
      .orderBy('a.timestamp', 'asc')
      .limit(200)
      .select(
        'a.id',
        'a.action',
        'a.comment',
        'a.user',
        'a.timestamp',
        'u.first_name',
        'u.last_name'
      )) as Array<Record<string, unknown>>
    // Defence in depth: a rule row that ever lands under nivaro_tasks is still desk only.
    // A desk worker sees the rule line ("Assigned to Beth by rule “…”") instead of its neutral
    // twin ("Assigned to Beth", written at the same moment for the requester).
    const ruleRows = history.filter((h) => h.action === SUPPORT_RULE_ACTION)
    const isTwin = (h: Record<string, unknown>) =>
      h.action !== SUPPORT_RULE_ACTION &&
      ruleRows.some(
        (r) =>
          String(r.comment ?? '').startsWith(`${String(h.comment ?? '')} by rule`) &&
          Math.abs(
            new Date(r.timestamp as string).getTime() - new Date(h.timestamp as string).getTime()
          ) < 5000
      )
    const visibleHistory =
      work && ruleRows.length
        ? history.filter((h) => !isTwin(h))
        : work
          ? history
          : history.filter((h) => h.action !== SUPPORT_RULE_ACTION)
    const files = ticket.attachments.length
      ? ((await db('nivaro_files')
          .whereIn('id', ticket.attachments)
          .select('id', 'title', 'filename_download', 'type', 'filesize')) as Array<
          Record<string, unknown>
        >)
      : []
    const isRequester = String(t.created_by).toUpperCase() === viewer.id
    return reply.send({
      data: {
        ...ticket,
        files,
        thread: thread.map((c) => ({
          id: c.id,
          text: c.text,
          user: c.user,
          user_name: userName(c as never),
          created_at: c.created_at,
          from_requester: String(c.user).toUpperCase() === String(t.created_by).toUpperCase(),
          // GitLab badge: provider + GitLab author only, never the link or note id (X3)
          tracker: trackerBadgeOf(c.meta)
        })),
        history: visibleHistory.map((h) => ({
          id: h.id,
          // Lets the sheet fold one screen share's start / watch / stop rows into one line.
          action: h.action,
          text: h.comment,
          user: h.user,
          user_name: userName(h as never),
          at: h.timestamp
        })),
        can: {
          work: work,
          requester: isRequester,
          reply: work || isRequester,
          cancel: (work || isRequester) && OPEN_STATUSES.includes(t.status as TicketStatus),
          reopen: (work || isRequester) && !OPEN_STATUSES.includes(t.status as TicketStatus)
        }
      }
    })
  })

  // POST /tickets — raise one.
  app.post<{
    Body: {
      title?: string
      description?: string | null
      category_id?: number | null
      collection?: string | null
      item?: string | number | null
      priority?: string
      attachments?: string[]
      /** #1377 — the requester's own recording + where they asked. */
      replay?: { recording_id?: string; offset_ms?: number | null } | null
      /** 'error' = raised from an error's Get help (assignment rules may route on it). */
      source?: string | null
    }
  }>('/tickets', async (req, reply) => {
    const b = req.body ?? {}
    const title = String(b.title ?? '').trim()
    if (!title) return reply.code(400).send({ error: 'A short summary is required' })
    const collection = b.collection ? String(b.collection) : null
    const item = b.item != null && b.item !== '' ? String(b.item) : null
    if ((collection && !item) || (!collection && item)) {
      return reply.code(400).send({ error: 'collection and item go together' })
    }
    if (collection && item) {
      if (/^(nivaro|directus)_/i.test(collection)) {
        return reply.code(400).send({ error: 'Tickets cannot target system collections' })
      }
      // The requester must be able to open the record they are asking about.
      try {
        // readOne answers NULL (no throw) for a row the caller cannot see.
        if (!(await readOne(req.user!, collection, item, req.workspaceId ?? undefined, ['id']))) {
          return reply.code(404).send({ error: 'Record not found' })
        }
      } catch {
        return reply.code(404).send({ error: 'Record not found' })
      }
    }
    let category: CategoryRow | undefined
    if (b.category_id != null) {
      const categoryId = safeId(b.category_id)
      category =
        categoryId == null
          ? undefined
          : ((await db('nivaro_task_categories')
              .where({ id: categoryId, is_active: true })
              .first()) as CategoryRow | undefined)
      if (!category) return reply.code(400).send({ error: 'Unknown support type' })
      if (category.collection && category.collection !== collection) {
        return reply.code(400).send({ error: 'That type is only for a different kind of record' })
      }
    }
    const priority = b.priority && PRIORITIES.includes(b.priority) ? b.priority : 'normal'
    // A double-click (or a client retry) files ONE ticket: the same person
    // sending the same request within DUPLICATE_WINDOW_S gets the first
    // ticket back. Attachments are left out of the match — each click
    // uploads its own "what I was doing" file.
    const description = b.description ?? null
    const ask = { title, description, collection, item }
    const userId = String(req.user!.id)
    const twinAnswer = async (t: TicketRow & Record<string, unknown>) => {
      const [first] = await serializeTickets([t])
      return reply.code(200).send({ data: first, duplicate: true })
    }
    const earlier = await recentTwin(userId, ask)
    if (earlier) return twinAnswer(earlier)
    const sendKey = ticketSendKey(
      userId,
      { ...ask, category_id: category?.id ?? null },
      currentTenantKey()
    )
    if (!(await claimTicketSend(app.redis, sendKey))) {
      // The first send is still being written: wait briefly for it.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 300))
        const first = await recentTwin(userId, ask)
        if (first) return twinAnswer(first)
      }
      return reply
        .code(409)
        .send({ error: 'This request was just sent', code: 'DUPLICATE_REQUEST' })
    }
    let s: Awaited<ReturnType<typeof raiseTicket>>
    try {
      s = await raiseTicket(app, req, {
        title,
        description,
        collection,
        item,
        category: category ?? null,
        priority,
        attachments: await ownFilesOf(req, b.attachments),
        replay: await ownReplayLink(req.user!.id, b.replay),
        source: b.source === 'error' ? 'error' : null
      })
    } catch (err) {
      // Nothing was filed: free the claim so the person can send again at once.
      sendClaims.delete(sendKey)
      await app.redis?.del(sendKey).catch(() => {})
      throw err
    }
    return reply.code(201).send({ data: s })
  })

  // POST /report-problem (#1390) — the portal's (and any host's) "Report a
  // problem": one sentence, a masked screenshot, the replay and the page's
  // console/request tail become an ISSUE (source client, raised by the
  // person) AND a support request linked to it, which they follow under My
  // requests. The replay is kept only when it is the person's own recording;
  // attachments only when they uploaded them.
  app.post<{
    Body: {
      sentence?: string
      route?: string
      app?: string
      screenshot?: string | null
      context?: string | null
      attachments?: string[]
      replay?: { recording_id?: string; offset_ms?: number | null } | null
    }
  }>('/report-problem', async (req, reply) => {
    const b = req.body ?? {}
    const sentence = String(b.sentence ?? '').trim()
    if (!sentence) return reply.code(400).send({ error: 'Say what went wrong in a sentence' })
    const shot = typeof b.screenshot === 'string' && b.screenshot ? b.screenshot : null
    if (shot && !/^data:image\/(png|jpeg|webp);base64,/.test(shot)) {
      return reply.code(400).send({ error: 'screenshot must be a data:image URI' })
    }
    if (shot && shot.length > 2_500_000) {
      return reply.code(400).send({ error: 'screenshot too large (2MB cap)' })
    }
    const route =
      typeof b.route === 'string' && /^\/(?!\/)[^\s]*$/.test(b.route) ? b.route.slice(0, 300) : null
    const appLabel = cleanAppLabel(b.app)
    const context = typeof b.context === 'string' ? b.context.slice(0, 6000) : ''
    const replay = await ownReplayLink(req.user!.id, b.replay)
    const now = new Date()
    const details = [
      sentence,
      '',
      `Page: ${route ?? 'unknown'}${appLabel ? ` (${appLabel})` : ''}`,
      'Reported by the person through Report a problem.',
      ...(context ? ['', context] : [])
    ]
      .join('\n')
      .slice(0, 8000)
    const [irow] = (await db('nivaro_issues')
      .insert({
        title: sentence.slice(0, 500),
        severity: 'medium',
        status: 'open',
        collection: null,
        item: null,
        assigned_to: null,
        details,
        screenshot: shot,
        source: 'client',
        raised_by: req.user!.id,
        recording_id: replay?.recording_id ?? null,
        recording_offset_ms: replay?.offset_ms ?? null,
        created_at: now,
        updated_at: now
      })
      .returning('id')) as Array<{ id: number } | number>
    const issueId = Number(typeof irow === 'object' ? irow.id : irow)
    noteIssueWrite(Number.isFinite(issueId) ? issueId : null, 'raised', {
      hits: [{ userId: req.user!.id, at: now }]
    })
    await logActivity({
      action: 'create',
      user: req.user!.id,
      collection: 'nivaro_issues',
      item: String(issueId),
      comment: 'Report a problem',
      req
    })
    const ticket = await raiseTicket(app, req, {
      title: sentence,
      description: `${sentence}\n\nReported from ${route ?? 'an unknown page'}${
        appLabel ? ` (${appLabel})` : ''
      }. Issue #${issueId} has the screenshot and the details.`,
      collection: null,
      item: null,
      category: null,
      priority: 'normal',
      attachments: await ownFilesOf(req, b.attachments),
      replay,
      issueId
    })
    return reply.code(201).send({ data: { ticket, issue_id: issueId } })
  })

  // POST /tickets/:id/comments — reply on the thread.
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/tickets/:id/comments',
    async (req, reply) => {
      const viewer = viewerOf(req)
      const t = await loadTicket(Number(req.params.id))
      if (!t || !(await canSeeTicket(viewer, t)))
        return reply.code(404).send({ error: 'Not found' })
      const isRequester = String(t.created_by).toUpperCase() === viewer.id
      if (!isRequester && !(await canWorkTicket(viewer, t))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const text = String(req.body?.text ?? '').trim()
      if (!text) return reply.code(400).send({ error: 'Write something first' })
      const now = new Date()
      const { randomUUID } = await import('node:crypto')
      const commentId = randomUUID()
      await db('nivaro_comments').insert({
        id: commentId,
        collection: 'nivaro_tasks',
        item: String(t.id),
        user: req.user!.id,
        text: text.slice(0, 8000),
        created_at: now,
        updated_at: now
      })
      // GitLab sync: a reply on a linked request goes to its GitLab issue (requester or desk,
      // under their own name; background pool, never blocks this request).
      void commentWritten(commentId, 'nivaro_tasks', null)
      await db('nivaro_tasks').where({ id: t.id }).update({ updated_at: now })
      const me = (await nameOf(req.user!.id)) ?? 'Someone'
      const recipients = isRequester
        ? t.assignee
          ? [t.assignee]
          : await supportAudience(t.team_id)
        : [t.created_by, t.assignee]
      await notifyTicket(app, t, recipients, {
        subject: `${me} replied: ${t.title}`,
        message: text.slice(0, 400),
        actorId: req.user!.id,
        category: isRequester ? 'system' : 'workflow',
        // A reply from the desk: the requester's copy asks for email when they opted in.
        emailRequester: !isRequester
      })
      return reply.code(201).send({ data: { ok: true } })
    }
  )

  // GET /tickets/:id/traffic — #2276: the requester's requests, errors and pages ±30 min around
  // the moment the ticket was raised. Desk only: the requester gets a 404, as for any ticket
  // they may not work. Reading it leaves an activity row.
  app.get<{ Params: { id: string } }>('/tickets/:id/traffic', async (req, reply) => {
    const viewer = viewerOf(req)
    const t = await loadTicket(Number(req.params.id))
    if (!t || !(await canSeeTicket(viewer, t))) return reply.code(404).send({ error: 'Not found' })
    if (!(await canWorkTicket(viewer, t)) && !(await canWorkDesk(viewer))) {
      return reply.code(404).send({ error: 'Not found' })
    }
    if (!t.created_at || !t.created_by) return reply.send({ data: null })
    const { ticketTraffic } = await import('../services/support-ticket-traffic.js')
    const data = await ticketTraffic(String(t.created_by), t.created_at)
    // An access audit row, once per ticket per viewer per screen share (or outside one, once a
    // day) — opening the sheet again is the same look, not a new one.
    const tenant = currentTenantKey()
    const share = await readShare(app.redis as unknown as ShareRedis, tenant, t.id).catch(
      () => null
    )
    // The requester looking at their own activity (an admin who raised it) is not an access.
    const own = String(t.created_by).toUpperCase() === String(viewer.id).toUpperCase()
    if (!own)
      void logActivityThrottled(
        app.redis as unknown as Parameters<typeof logActivityThrottled>[0],
        `support-traffic:${tenant}:${t.id}:${viewer.id}:${share?.id ?? 'none'}`,
        share ? Math.max(60, Math.ceil((share.expires_at - Date.now()) / 1000) + 3600) : 86_400,
        {
          action: 'support-traffic-view',
          user: viewer.id,
          collection: 'nivaro_tasks',
          item: String(t.id),
          comment: 'Viewed the requester’s traffic around the ticket'
        }
      )
    return reply.send({
      data: {
        ...data,
        // the map is an admin page: the link is offered to administrators only (epoch seconds)
        map_at: viewer.isAdmin ? Math.floor(data.moment / 1000) : null
      }
    })
  })

  // POST /tickets/:id/claim — take it: assigned to me, In progress.
  app.post<{ Params: { id: string } }>('/tickets/:id/claim', async (req, reply) => {
    const viewer = viewerOf(req)
    const t = await loadTicket(Number(req.params.id))
    if (!t || !(await canSeeTicket(viewer, t))) return reply.code(404).send({ error: 'Not found' })
    if (!(await canWorkTicket(viewer, t)) && !(await canWorkDesk(viewer))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    if (!OPEN_STATUSES.includes(t.status as TicketStatus)) {
      return reply.code(409).send({
        error: `This request is already ${STATUS_LABELS[t.status as TicketStatus] ?? t.status}`
      })
    }
    await db('nivaro_tasks')
      .where({ id: t.id })
      .update({ assignee: req.user!.id, status: 'in_progress', updated_at: new Date() })
    ticketChangedByPerson(t.id, { status: 'in_progress', assignee: req.user!.id }, req.user!.id)
    const me = (await nameOf(req.user!.id)) ?? 'Someone'
    const { noteAssignment } = await import('../services/support-assign.js')
    noteAssignment(app.redis, String(req.user!.id), t.id)
    await logTicketEvent(t.id, req.user!.id, `Picked up by ${me} · In progress`, req)
    // A live screen share goes to whoever it was started with: taken over = it ends.
    await screenShareTicketChanged(app, t.id)
    announceRecordHelp(t)
    const updated = (await loadTicket(t.id))!
    await notifyTicket(app, updated, [t.created_by], {
      subject: `Your request is in progress: ${t.title}`,
      message: `${me} picked it up.`,
      actorId: req.user!.id,
      category: 'workflow',
      emailRequester: true
    })
    const [s] = await serializeTickets([updated])
    return reply.send({ data: s })
  })

  // PATCH /tickets/:id — status / assignee / type / priority / summary.
  // The requester may only cancel or reopen their own request.
  app.patch<{
    Params: { id: string }
    Body: {
      status?: string
      assignee?: string | null
      category_id?: number | null
      priority?: string
      title?: string
    }
  }>('/tickets/:id', async (req, reply) => {
    const viewer = viewerOf(req)
    const t = await loadTicket(Number(req.params.id))
    if (!t || !(await canSeeTicket(viewer, t))) return reply.code(404).send({ error: 'Not found' })
    const out = await applyTicketChange(app, req, t, req.body ?? {})
    if (!out.ok) return reply.code(out.http).send({ error: out.reason, code: out.code })
    return reply.send({ data: (await serializeTickets([out.ticket]))[0] })
  })

  // POST /tickets/bulk {ids, status?, assignee?, priority?, category_id?} — the same change on
  //   many requests. Each one goes through PATCH's own path (who may work it, validation, the
  //   history line, closing its notifications, telling people, the screen share, the record's
  //   help badge); the answer says per id what happened. Not exempt from the maintenance freeze.
  app.post<{ Body: Record<string, unknown> }>('/tickets/bulk', async (req, reply) => {
    const viewer = viewerOf(req)
    const parsed = parseBulkBody(req.body, viewer.id)
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
    const results: Array<
      | { id: number; outcome: 'updated' | 'unchanged' }
      | { id: number; outcome: 'refused'; code: string; reason: string }
    > = []
    for (const id of parsed.ids) {
      const t = await loadTicket(id)
      if (!t || !(await canSeeTicket(viewer, t))) {
        results.push({ id, outcome: 'refused', code: 'NOT_FOUND', reason: 'Not found' })
        continue
      }
      const out = await applyTicketChange(app, req, t, parsed.change)
      results.push(
        out.ok
          ? { id, outcome: out.changed ? 'updated' : 'unchanged' }
          : { id, outcome: 'refused', code: out.code, reason: out.reason }
      )
    }
    return reply.send({
      data: {
        results,
        updated: results.filter((r) => r.outcome === 'updated').length,
        unchanged: results.filter((r) => r.outcome === 'unchanged').length,
        refused: results.filter((r) => r.outcome === 'refused').length
      }
    })
  })

  // Share my screen with support (realtime idea 24): start / read / stop a live screen share.
  await app.register(supportScreenShareRoutes)
  // Auto-assign rules (administrators): /assign-rules, /options, /fields, /test.
  const { supportAssignRuleRoutes } = await import('./support-assign-rules.js')
  await app.register(supportAssignRuleRoutes)
}
