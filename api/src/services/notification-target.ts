import { linkTo, recordLink } from './app-links.js'

/**
 * What a notification is ABOUT, and what clicking it should do — structured,
 * so every surface (admin bell, notifications page, the portal's bell, push,
 * email) lands the person on the right thing in the app THEY use, and can
 * offer the one action that makes sense (mark the task done, acknowledge the
 * SLA) without knowing the domain.
 *
 * Writers pass `target` to notifyUser; rows written before this carry only
 * collection + item + subject and are DERIVED here at read time, so old
 * inboxes keep working.
 */

export type NotificationKind =
  | 'record'
  | 'task'
  | 'approval'
  | 'access_request'
  | 'sla'
  | 'chat'
  | 'queue'
  | 'report'
  | 'alerts'
  | 'issue'
  | 'import'
  | 'dashboard'
  | 'my_work'
  | 'home'
  | 'external'

export type NotificationAction =
  | 'open'
  | 'complete'
  | 'acknowledge'
  | 'review'
  | 'approve'
  | 'reply'

export interface NotificationTargetSpec {
  kind: NotificationKind
  /** record / sla: the record. approval: the approval's record. */
  collection?: string | null
  /** record id, task id, approval instance id, queue / report / dashboard id. */
  id?: string | number | null
  /** chat: room key. */
  room?: string | null
  /** record: query string appended (addendum=…, layout=…). */
  query?: string | null
  /** record: field to focus / tab to open on arrival. */
  focus?: string | null
  tab?: string | null
  /** external: absolute URL. */
  url?: string | null
  /** The primary thing a click should offer. Default 'open'. */
  action?: NotificationAction
  /** Extra ids the action needs (task id for a record-kind row, …). */
  task_id?: string | number | null
  instance_id?: string | number | null
}

/** An inline action the client may run without knowing the domain. */
export interface NotificationActionSpec {
  key: NotificationAction
  label: string
  method: 'POST' | 'PATCH'
  /** API path (no /api prefix). */
  endpoint: string
  body?: Record<string, unknown>
  /** The row should be marked read once the action succeeds. */
  mark_read?: boolean
}

const KINDS = new Set<NotificationKind>([
  'record',
  'task',
  'approval',
  'access_request',
  'sla',
  'chat',
  'queue',
  'report',
  'alerts',
  'issue',
  'import',
  'dashboard',
  'my_work',
  'home',
  'external'
])
const ACTIONS = new Set<NotificationAction>([
  'open',
  'complete',
  'acknowledge',
  'review',
  'approve',
  'reply'
])

/** Validate + trim a caller-supplied spec (unknown kinds are dropped). */
export function normalizeTarget(input: unknown): NotificationTargetSpec | null {
  if (!input || typeof input !== 'object') return null
  const t = input as Record<string, unknown>
  const kind = String(t.kind ?? '') as NotificationKind
  if (!KINDS.has(kind)) return null
  const str = (v: unknown, max = 255) => (v == null || v === '' ? null : String(v).slice(0, max))
  const out: NotificationTargetSpec = { kind }
  if (t.collection != null) out.collection = str(t.collection)
  if (t.id != null) out.id = typeof t.id === 'number' ? t.id : str(t.id)
  if (t.room != null) out.room = str(t.room)
  if (t.query != null) out.query = str(t.query, 500)
  if (t.focus != null) out.focus = str(t.focus)
  if (t.tab != null) out.tab = str(t.tab)
  if (t.url != null && /^https?:\/\//i.test(String(t.url))) out.url = str(t.url, 2000)
  if (t.task_id != null) out.task_id = typeof t.task_id === 'number' ? t.task_id : str(t.task_id)
  if (t.instance_id != null)
    out.instance_id = typeof t.instance_id === 'number' ? t.instance_id : str(t.instance_id)
  const action = String(t.action ?? 'open') as NotificationAction
  out.action = ACTIONS.has(action) ? action : 'open'
  return out
}

export function parseStoredTarget(raw: unknown): NotificationTargetSpec | null {
  if (!raw) return null
  try {
    return normalizeTarget(typeof raw === 'string' ? JSON.parse(raw) : raw)
  } catch {
    return null
  }
}

const ALERT_COLLECTIONS = new Set([
  'nivaro_metric_alert_log',
  'nivaro_anomaly_log',
  'nivaro_alert_definitions',
  'nivaro_alert_log'
])
const IMPORT_COLLECTIONS = new Set(['nivaro_import_queue', 'nivaro_import_jobs'])

/**
 * Best-effort target for a row written before targets existed: the
 * collection + item say WHERE, the subject says WHAT KIND (an SLA escalation
 * about a record offers Acknowledge; an approval request offers Review).
 */
export function deriveTarget(row: {
  collection?: string | null
  item?: string | null
  subject?: string | null
}): NotificationTargetSpec | null {
  const c = row.collection?.trim() ?? ''
  const i = row.item != null && String(row.item).trim() !== '' ? String(row.item) : null
  const subject = String(row.subject ?? '')
  if (!c) {
    if (/^access request/i.test(subject)) return { kind: 'access_request', action: 'review' }
    return null
  }
  if (c === '__chat__') return i ? { kind: 'chat', room: i, action: 'reply' } : null
  if (c === '__dashboard__') return i ? { kind: 'dashboard', id: i } : null
  if (c === 'nivaro_report_defs') return i ? { kind: 'report', id: i } : null
  if (c === 'nivaro_queues') return i ? { kind: 'queue', id: i } : null
  if (c === 'nivaro_dashboards') return i ? { kind: 'dashboard', id: i } : null
  if (c === 'nivaro_tasks') return { kind: 'task', id: i, action: 'complete' }
  if (c === 'nivaro_access_requests') return { kind: 'access_request', id: i, action: 'review' }
  if (ALERT_COLLECTIONS.has(c)) return { kind: 'alerts' }
  if (IMPORT_COLLECTIONS.has(c)) return { kind: 'import', id: i }
  if (c === 'nivaro_issues') return { kind: 'issue', id: i }
  if (/^nivaro_/i.test(c) || /^directus_/i.test(c)) return null
  if (!i) return { kind: 'record', collection: c }
  if (/^sla escalation/i.test(subject))
    return { kind: 'sla', collection: c, id: i, action: 'acknowledge' }
  if (/^approval requested/i.test(subject))
    return { kind: 'approval', collection: c, id: i, action: 'review' }
  if (/requested access to/i.test(subject))
    return { kind: 'access_request', collection: c, id: i, action: 'review' }
  if (/^task assigned/i.test(subject))
    return { kind: 'record', collection: c, id: i, action: 'open' }
  return { kind: 'record', collection: c, id: i, action: 'open' }
}

/** The URL a target opens in a given app (or the recipient's app). */
export async function resolveTargetUrl(
  spec: NotificationTargetSpec | null,
  opts: { recipientUserId?: string | null; app?: 'portal' | 'admin' } = {}
): Promise<string | null> {
  if (!spec) return null
  const q = (base: string, extra?: string | null) =>
    extra ? `${base}${base.includes('?') ? '&' : '?'}${extra}` : base
  const withFocus = (url: string) => {
    const parts: string[] = []
    if (spec.query) parts.push(spec.query)
    if (spec.tab) parts.push(`tab=${encodeURIComponent(spec.tab)}`)
    if (spec.focus) parts.push(`focus=${encodeURIComponent(spec.focus)}`)
    return q(url, parts.join('&') || null)
  }
  try {
    switch (spec.kind) {
      case 'record':
      case 'sla':
      case 'approval':
        if (spec.collection && spec.id != null)
          return withFocus(await recordLink(spec.collection, spec.id, opts))
        if (spec.collection)
          return (
            `${await linkTo('home', {}, opts)}`.replace(/\/$/, '') +
            `/collections/${spec.collection}`
          )
        return spec.kind === 'approval' ? linkTo('approvals', {}, opts) : null
      case 'task':
        return linkTo('tasks', {}, opts)
      case 'access_request':
        return linkTo('access_requests', {}, opts)
      case 'chat':
        return spec.room ? linkTo('chat', { room: spec.room }, opts) : null
      case 'queue':
        return spec.id != null ? linkTo('queue', { id: spec.id }, opts) : null
      case 'report':
        return spec.id != null ? linkTo('report', { id: spec.id }, opts) : null
      case 'alerts':
        return linkTo('alerts', {}, opts)
      case 'issue':
        return linkTo('issues', {}, opts)
      case 'import':
        return linkTo('imports', {}, opts)
      case 'dashboard':
        return spec.id != null ? linkTo('dashboard', { id: spec.id }, opts) : null
      case 'my_work':
        return linkTo('my_work', {}, opts)
      case 'home':
        return linkTo('home', {}, opts)
      case 'external':
        return spec.url ?? null
      default:
        return null
    }
  } catch {
    return null
  }
}

/** Inline actions a client may offer for the target — only ones whose
 *  endpoint is safe to fire from a click (no comment / decision needed). */
export function actionsFor(spec: NotificationTargetSpec | null): NotificationActionSpec[] {
  if (!spec) return []
  const out: NotificationActionSpec[] = []
  if (spec.kind === 'task' && spec.id != null) {
    out.push({
      key: 'complete',
      label: 'Mark done',
      method: 'POST',
      endpoint: `/tasks/${encodeURIComponent(String(spec.id))}/complete`,
      mark_read: true
    })
  } else if (spec.task_id != null) {
    out.push({
      key: 'complete',
      label: 'Mark task done',
      method: 'POST',
      endpoint: `/tasks/${encodeURIComponent(String(spec.task_id))}/complete`,
      mark_read: true
    })
  }
  if (spec.kind === 'sla' && spec.collection && spec.id != null) {
    out.push({
      key: 'acknowledge',
      label: 'Acknowledge',
      method: 'POST',
      endpoint: '/sla/ack',
      body: { collection: spec.collection, item: String(spec.id) },
      mark_read: true
    })
  }
  return out
}

/** Short human label for the target ("Task", "Approval", "Chat · #general"). */
export function describeTarget(spec: NotificationTargetSpec | null): string | null {
  if (!spec) return null
  switch (spec.kind) {
    case 'record':
      return spec.collection ? spec.collection.replace(/_/g, ' ') : null
    case 'sla':
      return 'SLA'
    case 'task':
      return 'Task'
    case 'approval':
      return 'Approval'
    case 'access_request':
      return 'Access request'
    case 'chat':
      return 'Chat'
    case 'queue':
      return 'Queue'
    case 'report':
      return 'Report'
    case 'alerts':
      return 'Alerts'
    case 'issue':
      return 'Issue'
    case 'import':
      return 'Import'
    case 'dashboard':
      return 'Dashboard'
    case 'my_work':
      return 'My Work'
    default:
      return null
  }
}
