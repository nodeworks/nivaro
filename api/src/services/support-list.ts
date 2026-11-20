/**
 * Support request lists (#999, desk rebuild 2026-11-16) — the pure half of
 * GET /support/tickets, /support/workload and POST /support/tickets/bulk:
 * reading the query string, the sort orders, and reading a bulk body. The
 * route applies them; access (scope=desk gating, team visibility) stays in
 * routes/support.ts.
 */

export const TICKET_SORTS = ['attention', 'newest', 'oldest', 'updated', 'priority'] as const
export type TicketSort = (typeof TICKET_SORTS)[number]

export const TICKET_PRIORITIES = ['low', 'normal', 'urgent'] as const

/** Most ids one bulk change may name. */
export const BULK_MAX = 200

/**
 * When the requester last heard back: the newest reply on the thread from
 * anyone but the requester, else when they asked. A request nobody answered
 * waits from its creation; one answered yesterday waits from yesterday.
 * Correlated on the comment table's (collection, item) key — t.id is cast,
 * never the comment's text key.
 */
export const WAITING_SQL =
  '(SELECT CASE WHEN MAX(c.created_at) > t.created_at THEN MAX(c.created_at) ELSE t.created_at END' +
  " FROM nivaro_comments c WHERE c.collection = 'nivaro_tasks'" +
  ' AND c.item = CAST(t.id AS nvarchar(50)) AND c.deleted_at IS NULL' +
  ' AND (t.created_by IS NULL OR c.[user] <> t.created_by))'

/**
 * WAITING_SQL for one database: SQL Server gets the text above unchanged; the others quote
 * `user` their own way and cast the id to their text type.
 */
export function waitingSql(dialect: 'mssql' | 'pg' | 'mysql' | 'sqlite'): string {
  if (dialect === 'mssql') return WAITING_SQL
  const user = dialect === 'mysql' ? 'c.`user`' : 'c."user"'
  const idText = dialect === 'mysql' ? 'CAST(t.id AS CHAR(50))' : 'CAST(t.id AS TEXT)'
  return WAITING_SQL.replace('CAST(t.id AS nvarchar(50))', idText).replace('c.[user]', user)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type StatusFilter =
  | { kind: 'open' }
  | { kind: 'closed' }
  | { kind: 'all' }
  | { kind: 'one'; status: string }

export type AssigneeFilter =
  | { kind: 'me' }
  | { kind: 'unassigned' }
  | { kind: 'user'; id: string }
  | null

export interface TicketListQuery {
  status: StatusFilter
  assignee: AssigneeFilter
  category: number | null
  priority: string | null
  /** Desk only: whose requests. */
  requester: string | null
  q: string
  /** null = the legacy order (status → priority → created) for callers that never ask. */
  sort: TicketSort | null
  page: number
  limit: number
}

function posInt(raw: unknown): number | null {
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Read GET /support/tickets' query string. Unknown values are dropped, never an error. */
export function parseTicketListQuery(
  qs: Record<string, string | undefined>,
  opts: { desk: boolean; statuses: readonly string[] }
): TicketListQuery {
  const rawStatus = qs.status ?? 'open'
  const status: StatusFilter =
    rawStatus === 'open'
      ? { kind: 'open' }
      : rawStatus === 'closed'
        ? { kind: 'closed' }
        : rawStatus === 'all'
          ? { kind: 'all' }
          : opts.statuses.includes(rawStatus)
            ? { kind: 'one', status: rawStatus }
            : { kind: 'open' }
  const a = qs.assignee?.trim() ?? ''
  const assignee: AssigneeFilter =
    a === 'me'
      ? { kind: 'me' }
      : a === 'unassigned'
        ? { kind: 'unassigned' }
        : UUID.test(a)
          ? { kind: 'user', id: a.toUpperCase() }
          : null
  const r = qs.requester?.trim() ?? ''
  const sort = (TICKET_SORTS as readonly string[]).includes(qs.sort ?? '')
    ? (qs.sort as TicketSort)
    : opts.desk
      ? 'attention'
      : null
  return {
    status,
    assignee,
    // A category id that is not a safe integer matches nothing (never a driver error).
    category: qs.category ? (posInt(qs.category) ?? -1) : null,
    priority: (TICKET_PRIORITIES as readonly string[]).includes(qs.priority ?? '')
      ? (qs.priority as string)
      : null,
    requester: opts.desk && UUID.test(r) ? r.toUpperCase() : null,
    q: (qs.q ?? '').trim().slice(0, 200),
    sort,
    page: Math.min(Math.max(Math.trunc(Number(qs.page)) || 1, 1), 100_000),
    limit: Math.min(Math.max(Number(qs.limit) || 50, 1), 200)
  }
}

const URGENT_FIRST = "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END"
const OPEN_FIRST = "CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END"

/**
 * ORDER BY clauses (raw SQL, no bindings) for a sort. Every order ends on t.id so a page
 * boundary never repeats or skips a row.
 *
 * attention — urgent first, then nobody has it, then whoever has waited longest. A list of
 *   closed requests has nobody waiting: newest closed first.
 */
export function ticketOrderClauses(
  sort: TicketSort | null,
  status: StatusFilter,
  waiting: string = WAITING_SQL
): string[] {
  const closed = status.kind === 'closed'
  switch (sort) {
    case 'attention':
      if (closed) return ['COALESCE(t.completed_at, t.updated_at, t.created_at) DESC', 't.id DESC']
      return [
        URGENT_FIRST,
        'CASE WHEN t.assignee IS NULL THEN 0 ELSE 1 END',
        `${waiting} ASC`,
        't.id ASC'
      ]
    case 'newest':
      return ['t.created_at DESC', 't.id DESC']
    case 'oldest':
      return ['t.created_at ASC', 't.id ASC']
    case 'updated':
      return ['COALESCE(t.updated_at, t.created_at) DESC', 't.id DESC']
    case 'priority':
      return [URGENT_FIRST, 't.created_at ASC', 't.id ASC']
    default:
      return [OPEN_FIRST, URGENT_FIRST, `t.created_at ${closed ? 'DESC' : 'ASC'}`, 't.id ASC']
  }
}

export interface TicketChange {
  status?: string
  /** A user id, null = unassign. 'me' is read as the caller before it gets here. */
  assignee?: string | null
  category_id?: number | null
  priority?: string
  title?: string
}

export type BulkBody =
  | { ok: true; ids: number[]; change: TicketChange }
  | { ok: false; error: string }

/** Read POST /support/tickets/bulk's body. `me` names the caller as the assignee. */
export function parseBulkBody(raw: unknown, me: string): BulkBody {
  const b = (raw ?? {}) as Record<string, unknown>
  if (!Array.isArray(b.ids) || !b.ids.length)
    return { ok: false, error: 'Pick some requests first' }
  if (b.ids.length > BULK_MAX) return { ok: false, error: `At most ${BULK_MAX} requests at a time` }
  const ids = [...new Set(b.ids.map((v) => posInt(v)))]
  if (ids.some((v) => v == null)) return { ok: false, error: 'A request id is not valid' }
  const change: TicketChange = {}
  if (b.status !== undefined) change.status = String(b.status)
  if (b.assignee !== undefined)
    change.assignee = b.assignee === 'me' ? me : b.assignee ? String(b.assignee) : null
  if (b.priority !== undefined) change.priority = String(b.priority)
  if (b.category_id !== undefined)
    change.category_id = b.category_id == null ? null : Number(b.category_id)
  if (!Object.keys(change).length)
    return { ok: false, error: 'Say what to change: status, assignee, priority or type' }
  return { ok: true, ids: ids as number[], change }
}
