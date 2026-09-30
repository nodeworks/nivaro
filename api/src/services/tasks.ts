/**
 * Tasks (#1000–#1017) — one place every task write goes through: the /tasks
 * routes, the flow `task` op, the `create_task` rule action, Ask AI, the
 * record lifecycle (delete / restore / merge) and the self-closing check.
 *
 * Every write leaves a plain-language history line (nivaro_activity on
 * (nivaro_tasks, id), comment = the sentence), so the record Timeline, the
 * ticket history and the Notes thread say what happened instead of "task
 * updated". Created / reassigned / completed also reach flows
 * (task-created / task-reassigned / task-completed triggers) and any webhook
 * that names nivaro_tasks explicitly.
 *
 * Columns from migration 372 (completed_by, done_when, auto_closed,
 * reminded_at, escalated_at, nudged_at) are probed, so a tenant behind 372
 * keeps writing tasks — it simply stores less.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { notifyUser } from './notification-channels.js'

export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const
/** Still to do. */
export const ACTIVE_STATUSES = ['open', 'in_progress']
export const TASK_PRIORITIES = ['low', 'normal', 'urgent']

export interface TaskRow {
  id: number
  kind?: string | null
  collection: string | null
  item: string | null
  title: string
  description: string | null
  assignee: string | null
  due_date: Date | string | null
  status: string
  priority: string
  created_by: string
  team_id?: number | null
  completed_at: Date | string | null
  completed_by?: string | null
  done_when?: string | null
  auto_closed?: string | null
  created_at: Date | string | null
  updated_at: Date | string | null
}

const same = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

/** Columns added by migration 372, probed per tenant. */
export async function taskColumns(): Promise<{
  completedBy: boolean
  doneWhen: boolean
  autoClosed: boolean
  reminders: boolean
  nudged: boolean
}> {
  const [completedBy, doneWhen, autoClosed, reminders, nudged] = await Promise.all([
    hasColumn('nivaro_tasks', 'completed_by'),
    hasColumn('nivaro_tasks', 'done_when'),
    hasColumn('nivaro_tasks', 'auto_closed'),
    hasColumn('nivaro_tasks', 'reminded_at'),
    hasColumn('nivaro_tasks', 'nudged_at')
  ])
  return { completedBy, doneWhen, autoClosed, reminders, nudged }
}

// ─── Names, dates, sentences ────────────────────────────────────────────────

export function personName(
  row: { first_name?: string | null; last_name?: string | null; email?: string | null } | undefined
): string | null {
  if (!row) return null
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || null
}

export async function namesOf(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter(Boolean).map((i) => String(i).toUpperCase()))]
  const out = new Map<string, string>()
  if (want.length === 0) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', want)
    .select('id', 'first_name', 'last_name', 'email')
    .catch(() => [])) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  for (const r of rows) out.set(String(r.id).toUpperCase(), personName(r) ?? 'someone')
  return out
}

/** 'Oct 3' — a due date is a calendar day; read it in UTC so it never shifts. */
export function shortDate(d: Date | string | null | undefined): string | null {
  if (!d) return null
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const PRIORITY_LABEL: Record<string, string> = { low: 'low', normal: 'normal', urgent: 'urgent' }
const STATUS_LABEL: Record<string, string> = {
  open: 'open',
  in_progress: 'in progress',
  done: 'done',
  cancelled: 'cancelled'
}

/** One history line on the task. Never throws. */
export async function logTaskEvent(
  taskId: number,
  userId: string | null | undefined,
  comment: string,
  req?: FastifyRequest,
  action = 'update'
): Promise<void> {
  await logActivity({
    action,
    user: userId ?? null,
    collection: 'nivaro_tasks',
    item: String(taskId),
    comment: comment.slice(0, 1000),
    req
  }).catch(() => undefined)
}

/** The sentences describing what a PATCH changed ("Reassigned to Beth",
 *  "Due moved to Oct 3", "Priority urgent", "Reopened"). */
export async function describeTaskChange(
  before: TaskRow,
  after: Partial<TaskRow>
): Promise<string[]> {
  const out: string[] = []
  const names = await namesOf([after.assignee as string | null])
  if (after.title !== undefined && after.title !== before.title)
    out.push(`Renamed to “${after.title}”`)
  if (after.assignee !== undefined && !same(after.assignee, before.assignee)) {
    out.push(
      after.assignee
        ? `Reassigned to ${names.get(String(after.assignee).toUpperCase()) ?? 'someone'}`
        : 'Unassigned'
    )
  }
  if (after.due_date !== undefined) {
    const was = shortDate(before.due_date)
    const now = shortDate(after.due_date)
    if (was !== now) out.push(now ? `Due moved to ${now}` : 'Due date removed')
  }
  if (after.priority !== undefined && after.priority !== before.priority) {
    out.push(`Priority ${PRIORITY_LABEL[String(after.priority)] ?? after.priority}`)
  }
  if (after.description !== undefined && (after.description ?? '') !== (before.description ?? '')) {
    out.push('Details edited')
  }
  if (after.status !== undefined && after.status !== before.status) {
    if (ACTIVE_STATUSES.includes(String(after.status)) && !ACTIVE_STATUSES.includes(before.status))
      out.push('Reopened')
    else out.push(`Marked ${STATUS_LABEL[String(after.status)] ?? after.status}`)
  }
  return out
}

// ─── Record access (#1000) ──────────────────────────────────────────────────

/** Can this person read the record the task sits on? RBAC, row filters and
 *  User Scopes in one probe (readOne answers 403/404 otherwise). A task with
 *  no record is readable by construction. */
export async function canReadTaskRecord(
  user: User,
  collection: string | null | undefined,
  item: string | null | undefined,
  workspaceId?: string
): Promise<boolean> {
  if (!collection || !item) return true
  try {
    const { readOne } = await import('./items.js')
    await readOne(user, collection, item, workspaceId, ['id'])
    return true
  } catch {
    return false
  }
}

/** The task's own people may see it even when the record has left their
 *  scope — it is still their work. */
export function isTaskParty(task: Pick<TaskRow, 'assignee' | 'created_by'>, userId: string) {
  return same(task.assignee, userId) || same(task.created_by, userId)
}

// ─── Events: flows + webhooks (#1008) ───────────────────────────────────────

export type TaskEvent = 'task-created' | 'task-reassigned' | 'task-completed'

async function eventPayload(task: TaskRow, extra: Record<string, unknown>) {
  const people = (await db('nivaro_users')
    .whereIn('id', [task.assignee, task.created_by, task.completed_by].filter(Boolean) as string[])
    .select('id', 'first_name', 'last_name', 'email')
    .catch(() => [])) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  const by = (id: unknown) => people.find((p) => same(p.id, id))
  let friendly: string | null = null
  if (task.collection && task.item) {
    const { resolveFriendlyId } = await import('./workflow-transitions.js')
    friendly = await resolveFriendlyId(task.collection, task.item).catch(() => task.item)
  }
  return {
    task_id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    due_date: task.due_date ? new Date(task.due_date).toISOString().slice(0, 10) : null,
    kind: task.kind ?? null,
    collection: task.collection,
    item: task.item,
    friendly_id: friendly,
    team_id: task.team_id ?? null,
    assignee: task.assignee,
    assignee_name: personName(by(task.assignee)),
    assignee_email: by(task.assignee)?.email ?? null,
    created_by: task.created_by,
    creator_name: personName(by(task.created_by)),
    creator_email: by(task.created_by)?.email ?? null,
    completed_by: task.completed_by ?? null,
    completed_by_name: personName(by(task.completed_by)),
    ...extra
  }
}

/** Fire the flow trigger and the webhooks that asked for task events.
 *  Fire-and-forget; never throws. */
export function emitTaskEvent(
  app: FastifyInstance | null | undefined,
  type: TaskEvent,
  task: TaskRow,
  extra: Record<string, unknown> = {}
): void {
  void (async () => {
    const payload = await eventPayload(task, extra)
    if (app) {
      const { emitTrigger } = await import('../flows/registry.js')
      emitTrigger(type, payload, app.log, (extra.actor as string | undefined) ?? undefined)
    }
    const { fireWebhooks } = await import('./webhook-dispatch.js')
    const event = type === 'task-created' ? 'create' : 'update'
    await fireWebhooks(
      'nivaro_tasks',
      event,
      { id: task.id, ...payload, event: type },
      {
        origin: (extra.origin as string | undefined) ?? 'person',
        changed_fields:
          type === 'task-completed'
            ? ['status', 'completed_at']
            : type === 'task-reassigned'
              ? ['assignee']
              : [],
        explicitOnly: true
      }
    )
  })().catch(() => undefined)
}

// ─── Notify ─────────────────────────────────────────────────────────────────

export async function notifyAssignee(
  app: FastifyInstance,
  task: TaskRow,
  actorId: string | null
): Promise<void> {
  if (!task.assignee || same(task.assignee, actorId)) return
  if (task.kind === 'support' || !task.collection || !task.item) return // tickets notify via /support
  const { buildTaskAssignedMail } = await import('./mail-builders.js')
  const built = await buildTaskAssignedMail(task.id).catch(() => null)
  const { renderNotificationTemplate } = await import('./notification-templates.js')
  const templated = await renderNotificationTemplate('task_assigned', {
    title: task.title,
    description: task.description ?? '',
    collection: task.collection,
    record: task.item,
    due: task.due_date ?? ''
  }).catch(() => null)
  await notifyUser(app, task.assignee, {
    subject: templated?.subject ?? `Task assigned: ${task.title}`,
    category: 'workflow',
    message:
      templated?.message ||
      (task.description
        ? task.description.slice(0, 400)
        : `You have been assigned a task on ${task.collection}/${task.item}.`),
    collection: task.collection,
    item: task.item,
    sender: actorId,
    target: {
      kind: 'record',
      collection: task.collection,
      id: task.item,
      task_id: task.id,
      action: 'complete'
    },
    source: { kind: 'task', label: 'Task', id: task.id },
    why: 'the task is assigned to you',
    ...(built ? { template: built.template, template_data: built.data } : {})
  }).catch(() => undefined)
}

/** Team tasks (#1014): tell every active member of the team, once. */
async function notifyTeam(app: FastifyInstance, task: TaskRow, actorId: string | null) {
  if (task.team_id == null || !task.collection || !task.item) return
  const members = (await db('nivaro_user_group_members as m')
    .join('nivaro_users as u', 'u.id', 'm.user')
    .where('m.group_id', task.team_id)
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .select('u.id')
    .catch(() => [])) as Array<{ id: string }>
  const team = (await db('nivaro_user_groups')
    .where('id', task.team_id)
    .first('name')
    .catch(() => undefined)) as { name?: string } | undefined
  for (const m of members) {
    if (same(m.id, actorId)) continue
    await notifyUser(app, m.id, {
      subject: `Team task: ${task.title}`,
      category: 'workflow',
      message: `A task for ${team?.name ?? 'your team'} is waiting for someone to pick it up.`,
      collection: task.collection,
      item: task.item,
      sender: actorId,
      target: { kind: 'my_work' },
      source: { kind: 'task', label: 'Team task', id: task.id },
      why: `you are on the ${team?.name ?? ''} team`.replace(/\s+team$/, ' team')
    }).catch(() => undefined)
  }
}

// ─── Create ─────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  collection?: string | null
  item?: string | number | null
  title?: string | null
  description?: string | null
  assignee?: string | null
  team_id?: number | string | null
  due_date?: string | Date | null
  priority?: string | null
  /** [{field, op, value}] — the task closes itself when the record meets it. */
  done_when?: unknown
}

export class TaskInputError extends Error {
  statusCode = 400
}

/** Parse + validate a done_when condition list; null when absent. */
export function normalizeDoneWhen(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      throw new TaskInputError('done_when must be a JSON condition list')
    }
  }
  if (!Array.isArray(v)) throw new TaskInputError('done_when must be a list of conditions')
  const rules = v
    .filter(
      (r) => r && typeof r === 'object' && typeof (r as { field?: unknown }).field === 'string'
    )
    .map((r) => {
      const x = r as { field: string; op?: unknown; value?: unknown }
      return { field: x.field, op: String(x.op ?? 'nnull'), value: x.value ?? null }
    })
    .slice(0, 10)
  if (rules.length === 0) return null
  return JSON.stringify(rules)
}

/** The delegate a new assignment routes to, when the person is out (#70). */
async function effectiveAssignee(assignee: string): Promise<{ id: string; from: string | null }> {
  const u = (await db('nivaro_users')
    .where({ id: assignee })
    .first('id', 'is_out_of_office', 'delegate_id', 'delegate_expires_at')) as
    | {
        id: string
        is_out_of_office: boolean | number
        delegate_id: string | null
        delegate_expires_at: Date | string | null
      }
    | undefined
  if (!u) throw new TaskInputError('Unknown assignee')
  if (
    u.is_out_of_office &&
    u.delegate_id &&
    !same(u.delegate_id, assignee) &&
    (!u.delegate_expires_at || new Date(u.delegate_expires_at).getTime() > Date.now())
  ) {
    const d = (await db('nivaro_users')
      .where({ id: u.delegate_id })
      .whereNot('status', 'suspended')
      .first('id', 'is_out_of_office')) as
      | { id: string; is_out_of_office?: boolean | number }
      | undefined
    if (d && !d.is_out_of_office) return { id: u.delegate_id, from: assignee }
  }
  return { id: assignee, from: null }
}

export async function createTask(
  app: FastifyInstance | null,
  actorId: string | null,
  input: CreateTaskInput,
  opts: { req?: FastifyRequest; via?: string; notify?: boolean; createdBy?: string } = {}
): Promise<{ task: TaskRow; delegated_from: string | null }> {
  const collection = input.collection ? String(input.collection) : null
  const item = input.item != null && input.item !== '' ? String(input.item) : null
  const title = String(input.title ?? '').trim()
  if (!title) throw new TaskInputError('title is required')
  if (!collection || !item) throw new TaskInputError('collection and item are required')
  if (collection.startsWith('nivaro_'))
    throw new TaskInputError('Tasks cannot target system collections')
  if (input.priority && !TASK_PRIORITIES.includes(String(input.priority)))
    throw new TaskInputError(`priority must be one of ${TASK_PRIORITIES.join(', ')}`)

  const teamId = input.team_id != null && input.team_id !== '' ? Number(input.team_id) : null
  if (teamId != null) {
    if (!Number.isFinite(teamId)) throw new TaskInputError('team_id must be a number')
    const team = await db('nivaro_user_groups')
      .where('id', teamId)
      .first('id')
      .catch(() => null)
    if (!team) throw new TaskInputError('Unknown team')
  }
  if (!input.assignee && teamId == null)
    throw new TaskInputError('assign the task to a person or a team')

  let assignee: string | null = null
  let delegatedFrom: string | null = null
  if (input.assignee) {
    const eff = await effectiveAssignee(String(input.assignee))
    assignee = eff.id
    delegatedFrom = eff.from
  }

  const cols = await taskColumns()
  const doneWhen = normalizeDoneWhen(input.done_when)
  const createdBy = opts.createdBy ?? actorId
  if (!createdBy) throw new TaskInputError('a task needs someone who asked for it')

  const now = new Date()
  const row: Record<string, unknown> = {
    collection,
    item,
    title: title.slice(0, 500),
    description: input.description ?? null,
    assignee,
    team_id: teamId,
    due_date: input.due_date ? new Date(input.due_date) : null,
    priority:
      input.priority && TASK_PRIORITIES.includes(String(input.priority))
        ? input.priority
        : 'normal',
    status: 'open',
    created_by: createdBy,
    completed_at: null,
    created_at: now,
    updated_at: now
  }
  if (cols.doneWhen && doneWhen) row.done_when = doneWhen
  const [task] = (await db('nivaro_tasks').insert(row).returning('*')) as unknown as [TaskRow]

  const names = await namesOf([assignee, delegatedFrom])
  const parts: string[] = []
  if (assignee) {
    parts.push(`assigned to ${names.get(assignee.toUpperCase()) ?? 'someone'}`)
    if (delegatedFrom)
      parts.push(`covering for ${names.get(delegatedFrom.toUpperCase()) ?? 'someone'}, who is out`)
  } else if (teamId != null) {
    const team = (await db('nivaro_user_groups').where('id', teamId).first('name')) as
      | { name?: string }
      | undefined
    parts.push(`for the ${team?.name ?? ''} team`.replace('the  team', 'a team'))
  }
  if (task.due_date) parts.push(`due ${shortDate(task.due_date)}`)
  if (task.priority === 'urgent') parts.push('urgent')
  const via = opts.via ? ` (${opts.via})` : ''
  await logTaskEvent(task.id, actorId, `Created — ${parts.join(', ')}${via}`, opts.req, 'create')

  if (app && opts.notify !== false) {
    if (assignee) await notifyAssignee(app, task, actorId)
    else await notifyTeam(app, task, actorId)
  }
  emitTaskEvent(app, 'task-created', task, {
    actor: actorId,
    via: opts.via ?? null,
    origin: actorId ? 'person' : 'machine'
  })
  return { task, delegated_from: delegatedFrom }
}

// ─── Complete ───────────────────────────────────────────────────────────────

export async function completeTask(
  app: FastifyInstance | null,
  task: TaskRow,
  actorId: string | null,
  opts: { req?: FastifyRequest; reason?: string; auto?: 'done-when' } = {}
): Promise<TaskRow> {
  const cols = await taskColumns()
  const now = new Date()
  const patch: Record<string, unknown> = { status: 'done', completed_at: now, updated_at: now }
  if (cols.completedBy) patch.completed_by = actorId
  if (cols.autoClosed) patch.auto_closed = opts.auto ?? null
  await db('nivaro_tasks').where({ id: task.id }).update(patch)
  const updated = (await db('nivaro_tasks').where({ id: task.id }).first()) as TaskRow

  let sentence = opts.reason
  if (!sentence) {
    const names = await namesOf([actorId])
    sentence = actorId ? `Done by ${names.get(actorId.toUpperCase()) ?? 'someone'}` : 'Done'
  }
  await logTaskEvent(task.id, actorId, sentence, opts.req)

  // A task that closed itself tells whoever asked for it.
  if (app && opts.auto && updated.created_by && !same(updated.created_by, actorId)) {
    await notifyUser(app, updated.created_by, {
      subject: `Task done: ${updated.title}`,
      category: 'workflow',
      message: sentence,
      collection: updated.collection,
      item: updated.item,
      target:
        updated.collection && updated.item
          ? { kind: 'record', collection: updated.collection, id: updated.item }
          : null,
      source: { kind: 'task', label: 'Task', id: updated.id },
      why: 'you asked for this task'
    }).catch(() => undefined)
  }
  emitTaskEvent(app, 'task-completed', updated, {
    actor: actorId,
    auto: opts.auto ?? null,
    origin: opts.auto ? 'machine' : 'person'
  })
  return updated
}

// ─── Record lifecycle (#1006) ───────────────────────────────────────────────

/** Deleted record: its open tasks are cancelled (and reopen on restore). */
export async function onRecordDeleted(
  collection: string,
  id: string | number,
  actorId: string | null
): Promise<number> {
  if (collection.startsWith('nivaro_')) return 0
  const open = (await db('nivaro_tasks')
    .where({ collection, item: String(id) })
    .whereIn('status', ACTIVE_STATUSES)
    .select('id')
    .catch(() => [])) as Array<{ id: number }>
  if (open.length === 0) return 0
  const cols = await taskColumns()
  const patch: Record<string, unknown> = { status: 'cancelled', updated_at: new Date() }
  if (cols.autoClosed) patch.auto_closed = 'record-deleted'
  await db('nivaro_tasks')
    .whereIn(
      'id',
      open.map((t) => t.id)
    )
    .update(patch)
  for (const t of open) await logTaskEvent(t.id, actorId, 'Cancelled — the record was deleted')
  return open.length
}

/** Restored record: the tasks its deletion cancelled are open again. */
export async function onRecordRestored(
  collection: string,
  id: string | number,
  actorId: string | null
): Promise<number> {
  const cols = await taskColumns()
  if (!cols.autoClosed) return 0
  const rows = (await db('nivaro_tasks')
    .where({ collection, item: String(id), status: 'cancelled', auto_closed: 'record-deleted' })
    .select('id')
    .catch(() => [])) as Array<{ id: number }>
  if (rows.length === 0) return 0
  await db('nivaro_tasks')
    .whereIn(
      'id',
      rows.map((t) => t.id)
    )
    .update({ status: 'open', auto_closed: null, updated_at: new Date() })
  for (const t of rows) await logTaskEvent(t.id, actorId, 'Reopened — the record was restored')
  return rows.length
}

/** Merged record: the duplicate's tasks move to the survivor. */
export async function onRecordMerged(
  collection: string,
  fromId: string | number,
  intoId: string | number,
  actorId: string | null
): Promise<number> {
  const rows = (await db('nivaro_tasks')
    .where({ collection, item: String(fromId) })
    .select('id')
    .catch(() => [])) as Array<{ id: number }>
  if (rows.length === 0) return 0
  await db('nivaro_tasks')
    .whereIn(
      'id',
      rows.map((t) => t.id)
    )
    .update({ item: String(intoId), updated_at: new Date() })
  const { resolveFriendlyId } = await import('./workflow-transitions.js')
  const [from, into] = await Promise.all([
    resolveFriendlyId(collection, String(fromId)).catch(() => String(fromId)),
    resolveFriendlyId(collection, String(intoId)).catch(() => String(intoId))
  ])
  for (const t of rows)
    await logTaskEvent(t.id, actorId, `Moved from ${from} — the record was merged into ${into}`)
  return rows.length
}

// ─── Self-closing tasks (#1016) ─────────────────────────────────────────────

interface DoneWhenWatch {
  /** Collections holding an open task with done_when. */
  parents: Set<string>
  /** Child collection → the parents whose related-row rules count it. */
  children: Map<string, Array<{ parent: string; fk: string }>>
}
let doneWhenWatch: { at: number; watch: DoneWhenWatch } | null = null

/** What the after-write hook must react to (60s cache) — every other write
 *  costs a Set lookup. */
export async function doneWhenWatchlist(): Promise<DoneWhenWatch> {
  if (doneWhenWatch && Date.now() - doneWhenWatch.at < 60_000) return doneWhenWatch.watch
  const watch: DoneWhenWatch = { parents: new Set(), children: new Map() }
  if ((await taskColumns()).doneWhen) {
    const rows = (await db('nivaro_tasks')
      .whereNotNull('done_when')
      .whereIn('status', ACTIVE_STATUSES)
      .whereNotNull('collection')
      .select('collection', 'done_when')
      .catch(() => [])) as Array<{ collection: string; done_when: string }>
    for (const r of rows) {
      watch.parents.add(String(r.collection))
      let rules: Array<{ field?: unknown }> = []
      try {
        rules = JSON.parse(r.done_when)
      } catch {
        continue
      }
      for (const rule of Array.isArray(rules) ? rules : []) {
        const m = /^([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/.exec(String(rule?.field ?? ''))
        if (!m) continue
        const list = watch.children.get(m[1]) ?? []
        if (!list.some((x) => x.parent === r.collection && x.fk === m[2]))
          list.push({ parent: String(r.collection), fk: m[2] })
        watch.children.set(m[1], list)
      }
    }
  }
  doneWhenWatch = { at: Date.now(), watch }
  return watch
}

async function collectionsWithDoneWhen(): Promise<Set<string>> {
  return (await doneWhenWatchlist()).parents
}

export function bustDoneWhenCache(): void {
  doneWhenWatch = null
}

async function fieldLabels(collection: string): Promise<Map<string, string>> {
  const rows = (await db('nivaro_fields')
    .where({ collection })
    .select('field', 'label')
    .catch(() => [])) as Array<{ field: string; label: string | null }>
  return new Map(rows.filter((r) => r.label).map((r) => [r.field, String(r.label)]))
}

const human = (s: string) => s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()

/** "requisition id was entered", "status is approved", "a line item was added". */
export function describeDoneWhen(
  rules: Array<{ field: string; op: string; value: unknown }>,
  labels: Map<string, string> = new Map()
): string {
  const parts = rules.map((r) => {
    if (r.field.includes(':')) {
      const [child] = r.field.split(':')
      const name = human(labels.get(child) ?? child)
      return r.op === 'related_none' ? `no ${name} remain` : `${name} were added`
    }
    const name = labels.get(r.field) ?? human(r.field.split('.').pop() ?? r.field)
    switch (r.op) {
      case 'nnull':
        return `${name} was entered`
      case 'null':
        return `${name} was cleared`
      case 'eq':
        return `${name} is ${r.value}`
      case 'neq':
        return `${name} is no longer ${r.value}`
      case 'in':
        return `${name} is one of ${r.value}`
      case 'gt':
      case 'gte':
        return `${name} reached ${r.value}`
      case 'lt':
      case 'lte':
        return `${name} dropped to ${r.value}`
      default:
        return `${name} ${r.op} ${r.value ?? ''}`.trim()
    }
  })
  return parts.join(' and ')
}

/** Close every open task on this record whose done_when now holds. */
export async function checkDoneWhen(
  app: FastifyInstance | null,
  collection: string,
  id: string | number
): Promise<number> {
  if (!(await collectionsWithDoneWhen()).has(collection)) return 0
  const tasks = (await db('nivaro_tasks')
    .where({ collection, item: String(id) })
    .whereNotNull('done_when')
    .whereIn('status', ACTIVE_STATUSES)
    .select('*')
    .catch(() => [])) as TaskRow[]
  if (tasks.length === 0) return 0
  const { fetchRecordForConditions, evaluateConditionRules, parseConditionRules } = await import(
    './workflow-conditions.js'
  )
  const record = await fetchRecordForConditions(
    collection,
    String(id),
    tasks.map((t) => t.done_when ?? null)
  ).catch(() => ({}))
  if (!record || Object.keys(record).length === 0) return 0
  const labels = await fieldLabels(collection)
  let closed = 0
  for (const t of tasks) {
    if (!evaluateConditionRules(t.done_when ?? null, record)) continue
    const rules = (parseConditionRules(t.done_when ?? null) ?? []) as Array<{
      field: string
      op: string
      value: unknown
    }>
    await completeTask(app, t, null, {
      auto: 'done-when',
      reason: `Closed automatically — ${describeDoneWhen(rules, labels)}`
    })
    closed++
  }
  if (closed) bustDoneWhenCache()
  return closed
}

/** Every open done_when task, re-checked (the hourly sweep: related-row rules
 *  change when a child row is written, which never touches the parent). */
export async function sweepDoneWhen(app: FastifyInstance | null): Promise<number> {
  if (!(await taskColumns()).doneWhen) return 0
  const rows = (await db('nivaro_tasks')
    .whereNotNull('done_when')
    .whereIn('status', ACTIVE_STATUSES)
    .whereNotNull('collection')
    .whereNotNull('item')
    .distinct('collection', 'item')
    .catch(() => [])) as Array<{ collection: string; item: string }>
  let closed = 0
  for (const r of rows) closed += await checkDoneWhen(app, r.collection, r.item).catch(() => 0)
  return closed
}

// ─── Reminders (#1007) ──────────────────────────────────────────────────────

/** Days past due before the requester and the assignee's manager hear. */
export const OVERDUE_ESCALATE_DAYS = Math.max(
  1,
  Number(process.env.TASK_OVERDUE_ESCALATE_DAYS) || 3
)

export async function runTaskReminders(
  app: FastifyInstance,
  opts: { dryRun?: boolean } = {}
): Promise<{ due_tomorrow: number; escalated: number; notified: number }> {
  const cols = await taskColumns()
  if (!cols.reminders) return { due_tomorrow: 0, escalated: 0, notified: 0 }
  const dueTomorrow = (await db('nivaro_tasks')
    .whereIn('status', ACTIVE_STATUSES)
    .whereNotNull('assignee')
    .whereNull('reminded_at')
    .whereRaw('CAST(due_date AS date) = CAST(DATEADD(day, 1, GETUTCDATE()) AS date)')
    .where((q) => q.whereNull('kind').orWhereNot('kind', 'support'))
    .select('*')) as TaskRow[]
  const overdue = (await db('nivaro_tasks')
    .whereIn('status', ACTIVE_STATUSES)
    .whereNull('escalated_at')
    .whereNotNull('due_date')
    .whereRaw('CAST(due_date AS date) <= CAST(DATEADD(day, ?, GETUTCDATE()) AS date)', [
      -OVERDUE_ESCALATE_DAYS
    ])
    .where((q) => q.whereNull('kind').orWhereNot('kind', 'support'))
    .select('*')) as TaskRow[]
  if (opts.dryRun)
    return { due_tomorrow: dueTomorrow.length, escalated: overdue.length, notified: 0 }

  let notified = 0
  const label = async (t: TaskRow) => {
    if (!t.collection || !t.item) return ''
    const { resolveFriendlyId } = await import('./workflow-transitions.js')
    return ` on ${await resolveFriendlyId(t.collection, t.item).catch(() => t.item)}`
  }
  for (const t of dueTomorrow) {
    await notifyUser(app, t.assignee as string, {
      subject: `Due tomorrow: ${t.title}`,
      category: 'workflow',
      message: `Your task${await label(t)} is due ${shortDate(t.due_date)}.`,
      collection: t.collection,
      item: t.item,
      target:
        t.collection && t.item
          ? {
              kind: 'record',
              collection: t.collection,
              id: t.item,
              task_id: t.id,
              action: 'complete'
            }
          : null,
      source: { kind: 'task', label: 'Task reminder', id: t.id },
      why: 'the task is assigned to you and due tomorrow'
    }).catch(() => undefined)
    await db('nivaro_tasks').where({ id: t.id }).update({ reminded_at: new Date() })
    notified++
  }

  const managers = new Map<string, string | null>()
  for (const t of overdue) {
    const tell = new Set<string>()
    if (t.created_by && !same(t.created_by, t.assignee))
      tell.add(String(t.created_by).toUpperCase())
    if (t.assignee) {
      const key = String(t.assignee).toUpperCase()
      if (!managers.has(key)) {
        const u = (await db('nivaro_users').where('id', t.assignee).first('manager_id')) as
          | { manager_id?: string | null }
          | undefined
        managers.set(key, u?.manager_id ? String(u.manager_id).toUpperCase() : null)
      }
      const m = managers.get(key)
      if (m && !same(m, t.assignee)) tell.add(m)
    }
    const names = await namesOf([t.assignee])
    const who = t.assignee ? (names.get(String(t.assignee).toUpperCase()) ?? 'someone') : 'its team'
    const where = await label(t)
    for (const r of tell) {
      await notifyUser(app, r, {
        subject: `Overdue: ${t.title}`,
        category: 'workflow',
        message: `${who}'s task${where} was due ${shortDate(t.due_date)} and is still open.`,
        collection: t.collection,
        item: t.item,
        target:
          t.collection && t.item ? { kind: 'record', collection: t.collection, id: t.item } : null,
        source: { kind: 'task', label: 'Overdue task', id: t.id },
        why: same(r, t.created_by)
          ? 'you asked for this task'
          : 'the task belongs to someone who reports to you'
      }).catch(() => undefined)
      notified++
    }
    await db('nivaro_tasks').where({ id: t.id }).update({ escalated_at: new Date() })
    await logTaskEvent(
      t.id,
      null,
      `Overdue ${OVERDUE_ESCALATE_DAYS}+ days — ${tell.size ? 'the requester and manager were told' : 'nobody else to tell'}`
    )
  }
  return { due_tomorrow: dueTomorrow.length, escalated: overdue.length, notified }
}

/** Daily-summary section: my tasks due today or overdue. */
export async function registerTaskDigest(): Promise<void> {
  const { registerDigestSection } = await import('./daily-digest.js')
  registerDigestSection(async (userId) => {
    const rows = (await db('nivaro_tasks')
      .where('assignee', userId)
      .whereIn('status', ACTIVE_STATUSES)
      .whereNotNull('due_date')
      .whereRaw('CAST(due_date AS date) <= CAST(GETUTCDATE() AS date)')
      .orderBy('due_date', 'asc')
      .limit(25)
      .select('id', 'title', 'collection', 'item', 'due_date')
      .catch(() => [])) as TaskRow[]
    if (rows.length === 0) return null
    const today = new Date().toISOString().slice(0, 10)
    const { resolveFriendlyId } = await import('./workflow-transitions.js')
    const lines = await Promise.all(
      rows.map(async (t) => {
        const due = new Date(t.due_date as string).toISOString().slice(0, 10)
        const rec =
          t.collection && t.item
            ? await resolveFriendlyId(t.collection, t.item).catch(() => t.item)
            : null
        return {
          text: t.title,
          sub: `${due === today ? 'Due today' : `Overdue since ${shortDate(t.due_date)}`}${rec ? ` · ${rec}` : ''}`,
          url: t.collection && t.item ? `/collections/${t.collection}/${t.item}` : '/my-work'
        }
      })
    )
    return { title: `Tasks due today or overdue (${rows.length})`, lines }
  })
}

// ─── Owners of a record (flow op / rule action "assign to owners") ─────────

/** The people who own the record's CURRENT pipeline state (after delegation).
 *  Empty when the record runs no pipeline or its state has no owners. */
export async function currentOwnerIds(collection: string, item: string): Promise<string[]> {
  const inst = (await db('nivaro_workflow_instances')
    .where({ collection, item: String(item) })
    .orderByRaw('CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END')
    .orderBy('id', 'desc')
    .first('id', 'current_state')
    .catch(() => undefined)) as { id: string; current_state: string } | undefined
  if (!inst?.current_state) return []
  const { resolveStateOwners } = await import('./pipeline-engine.js')
  const owners = await resolveStateOwners(
    inst.current_state,
    inst.id,
    collection,
    String(item)
  ).catch(() => [])
  return [...new Set(owners.map((o) => String(o.id).toUpperCase()))]
}

/** A user id from an id, an email, or nothing. */
export async function resolveUserRef(ref: unknown): Promise<string | null> {
  const v = String(ref ?? '').trim()
  if (!v) return null
  const byId = /^[0-9a-f-]{36}$/i.test(v)
    ? await db('nivaro_users')
        .where('id', v)
        .first('id')
        .catch(() => undefined)
    : undefined
  if (byId) return String((byId as { id: string }).id)
  const byEmail = v.includes('@')
    ? await db('nivaro_users')
        .whereRaw('LOWER(email) = ?', [v.toLowerCase()])
        .first('id')
        .catch(() => undefined)
    : undefined
  return byEmail ? String((byEmail as { id: string }).id) : null
}

/** Shared by the flow `task` op and the `create_task` rule action (#1009):
 *  one task per assignee (a person, or every current owner), each through
 *  createTask. */
export async function createTasksFromAutomation(
  app: FastifyInstance | null,
  spec: {
    collection: string
    item: string
    title: string
    description?: string | null
    assignee?: string | null
    assign_to_owners?: boolean
    team_id?: number | string | null
    due_in_days?: number | string | null
    due_date?: string | null
    priority?: string | null
    done_when?: unknown
    created_by: string
    via: string
  }
): Promise<{ created: number[]; skipped: string | null }> {
  const assignees: Array<string | null> = []
  if (spec.assign_to_owners) {
    assignees.push(...(await currentOwnerIds(spec.collection, spec.item)).slice(0, 10))
    if (assignees.length === 0 && spec.team_id == null)
      return { created: [], skipped: 'the record has no current owners' }
  } else if (spec.assignee) {
    const id = await resolveUserRef(spec.assignee)
    if (!id) return { created: [], skipped: `no user matches "${spec.assignee}"` }
    assignees.push(id)
  }
  if (assignees.length === 0) assignees.push(null) // team task
  let due: string | null = spec.due_date ? String(spec.due_date) : null
  const days = Number(spec.due_in_days)
  if (!due && spec.due_in_days != null && spec.due_in_days !== '' && Number.isFinite(days)) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() + Math.round(days))
    due = d.toISOString().slice(0, 10)
  }
  const created: number[] = []
  for (const a of assignees) {
    const { task } = await createTask(
      app,
      null,
      {
        collection: spec.collection,
        item: spec.item,
        title: spec.title,
        description: spec.description ?? null,
        assignee: a,
        team_id: a ? null : (spec.team_id ?? null),
        due_date: due,
        priority: spec.priority ?? 'normal',
        done_when: spec.done_when
      },
      { via: spec.via, createdBy: spec.created_by }
    )
    created.push(task.id)
  }
  if (created.length) bustDoneWhenCache()
  return { created, skipped: null }
}
