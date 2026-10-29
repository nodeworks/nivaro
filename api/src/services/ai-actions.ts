import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { createOne, readItems, updateOne } from './items.js'
import { can } from './permissions.js'

/**
 * AI action proposals — propose/approve/execute split.
 *
 * proposeAction() runs AS THE REQUESTING USER: affected records resolve
 * through readItems (RBAC + RLS), fields validate against the registry, and
 * the result is a STORED proposal + human-readable preview. Nothing mutates.
 *
 * executeProposal() — only the proposer, only while 'proposed', only within
 * EXPIRY — applies each row through updateOne/createOne so hooks, validation,
 * row security, computed fields and activity logging all run per record.
 */

const MAX_AFFECTED = 200
const EXPIRY_MS = 60 * 60 * 1000

export interface ProposalPreview {
  proposal_id: string
  action_type: 'bulk_update' | 'create_record' | 'create_dashboard' | 'create_task'
  collection: string
  count: number
  changes: Record<string, unknown> | null
  sample: Array<{ id: string; label: string }>
  widgets?: Array<{ type: string; title: string; collection: string; field: string | null }>
  expires_note: string
}

const WIDGET_TYPES = new Set(['count', 'sum', 'avg', 'latest', 'bar_chart', 'line_chart'])
/** #2738 — an Ask AI query widget (services/ai-query-widget.ts). */
const AI_QUERY_TYPE = 'ai_query'

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

function rowLabel(row: Record<string, unknown>): string {
  return String(row.title ?? row.name ?? row.label ?? row.subject ?? `#${String(row.id)}`)
}

export interface ProposeActionInput {
  action_type?: string
  collection?: string
  filter?: unknown
  changes?: Record<string, unknown>
  data?: Record<string, unknown>
  dashboard?: {
    name?: string
    widgets?: DashboardDraftWidget[]
  }
  task?: TaskProposalInput
}

/**
 * A validated, previewed action that has NOT been stored — what a proposal
 * row holds, and what one step of an AI plan (services/ai-plans.ts) holds.
 * Built AS THE PERSON: reads go through readItems, so the preview only ever
 * names records they can see.
 */
export interface BuiltAction {
  action_type: ProposalPreview['action_type']
  collection: string
  payload: Record<string, unknown>
  /** The preview the client renders (no proposal id yet). */
  preview: Omit<ProposalPreview, 'proposal_id' | 'expires_note'>
  /** What the proposals row stores in `preview` (kept as before). */
  storedPreview: Record<string, unknown>
  expiresNote: string
  /** The records the action acts on, when it acts on existing ones. */
  targets?: { collection: string; ids: string[] }
}

const DEFAULT_EXPIRES_NOTE =
  'The user must approve this proposal in the UI within 1 hour; it does NOT execute automatically.'

export async function buildAction(user: User, input: ProposeActionInput): Promise<BuiltAction> {
  // Dashboards validate per-widget collections instead of a single one
  if (input.action_type === 'create_dashboard') {
    return buildDashboard(user, input.dashboard ?? {})
  }
  if (input.action_type === 'create_task') {
    return buildTask(user, input.task ?? {})
  }
  const collection = String(input.collection ?? '')
  if (!/^[a-zA-Z0-9_]+$/.test(collection) || collection.startsWith('nivaro_')) {
    throw new Error('Invalid collection')
  }
  const actionType = input.action_type === 'create_record' ? 'create_record' : 'bulk_update'

  const requiredAction = actionType === 'create_record' ? 'create' : 'update'
  if (!(await can(user, requiredAction, collection))) {
    throw new Error(`You do not have ${requiredAction} permission on ${collection}`)
  }

  const validFields = new Set(
    (
      (await db('nivaro_fields').where({ collection }).select('field')) as Array<{ field: string }>
    ).map((r) => r.field)
  )

  if (actionType === 'create_record') {
    const data = Object.fromEntries(
      Object.entries(input.data ?? {}).filter(([k]) => validFields.has(k) && k !== 'id')
    )
    if (Object.keys(data).length === 0) throw new Error('data must set at least one valid field')
    const preview = {
      action_type: 'create_record' as const,
      collection,
      count: 1,
      changes: data,
      sample: []
    }
    return {
      action_type: 'create_record',
      collection,
      payload: { data },
      preview,
      storedPreview: preview,
      expiresNote: DEFAULT_EXPIRES_NOTE
    }
  }
  const changes = Object.fromEntries(
    Object.entries(input.changes ?? {}).filter(([k]) => validFields.has(k) && k !== 'id')
  )
  if (Object.keys(changes).length === 0) {
    throw new Error('changes must set at least one valid field')
  }
  // Resolve affected ids through the permission-checked read path (RLS applies)
  const res = await readItems(user, collection, {
    filter: (input.filter as Record<string, unknown>) ?? {},
    limit: MAX_AFFECTED + 1
  })
  const rows = ((res as { data?: Array<Record<string, unknown>> }).data ?? []) as Array<
    Record<string, unknown>
  >
  if (rows.length === 0) throw new Error('The filter matches no records you can read')
  if (rows.length > MAX_AFFECTED) {
    throw new Error(
      `The filter matches more than ${MAX_AFFECTED} records — narrow it before proposing`
    )
  }
  const ids = rows.map((r) => String(r.id))
  const preview = {
    action_type: 'bulk_update' as const,
    collection,
    count: rows.length,
    changes,
    sample: rows.slice(0, 8).map((r) => ({ id: String(r.id), label: rowLabel(r) }))
  }
  return {
    action_type: 'bulk_update',
    collection,
    payload: { ids, changes },
    preview,
    storedPreview: preview,
    expiresNote: DEFAULT_EXPIRES_NOTE,
    targets: { collection, ids }
  }
}

export async function proposeAction(
  user: User,
  input: ProposeActionInput
): Promise<ProposalPreview> {
  const built = await buildAction(user, input)
  const id = randomUUID()
  await db('nivaro_ai_proposals').insert({
    id,
    user: user.id,
    action_type: built.action_type,
    collection: built.collection,
    payload: JSON.stringify(built.payload),
    preview: JSON.stringify(built.storedPreview),
    status: 'proposed',
    created_at: new Date()
  })
  return { proposal_id: id, ...built.preview, expires_note: built.expiresNote }
}

interface TaskProposalInput {
  collection?: string
  id?: string | number
  title?: string
  description?: string
  /** A user id, an email, or a full name that matches exactly one active person. */
  assignee?: string
  due_date?: string
  priority?: string
}

/** A person by id, email, or an unambiguous full name among active people. */
export async function findPerson(ref: string): Promise<{ id: string; name: string }> {
  const v = ref.trim()
  const people = (await db('nivaro_users')
    .where('status', 'active')
    .whereNull('account_kind')
    .where((q) => q.where('is_redacted', false).orWhereNull('is_redacted'))
    .where((q) => {
      if (/^[0-9a-f-]{36}$/i.test(v)) q.orWhere('id', v)
      if (v.includes('@')) q.orWhereRaw('LOWER(email) = ?', [v.toLowerCase()])
      q.orWhereRaw("LOWER(CONCAT(first_name, ' ', last_name)) = ?", [v.toLowerCase()])
      q.orWhereRaw('LOWER(first_name) = ?', [v.toLowerCase()])
    })
    .limit(6)
    .select('id', 'first_name', 'last_name', 'email')) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  const name = (p: (typeof people)[number]) =>
    [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || p.id
  const exact = people.filter(
    (p) =>
      p.id.toLowerCase() === v.toLowerCase() ||
      (p.email ?? '').toLowerCase() === v.toLowerCase() ||
      name(p).toLowerCase() === v.toLowerCase()
  )
  const pick = exact.length === 1 ? exact : people
  if (pick.length === 0) throw new Error(`No active person matches "${v}"`)
  if (pick.length > 1)
    throw new Error(
      `"${v}" matches ${pick.length} people (${pick.map(name).join(', ')}) — ask the user which one, or use their email`
    )
  return { id: pick[0].id, name: name(pick[0]) }
}

async function buildTask(user: User, t: TaskProposalInput): Promise<BuiltAction> {
  const collection = String(t.collection ?? '')
  if (!/^[a-zA-Z0-9_]+$/.test(collection) || collection.startsWith('nivaro_'))
    throw new Error('Invalid collection')
  const item = String(t.id ?? '').trim()
  if (!item) throw new Error('task.id (the record id) is required')
  const title = String(t.title ?? '').trim()
  if (!title) throw new Error('task.title is required')
  if (!(await can(user, 'read', collection))) throw new Error(`You cannot read ${collection}`)
  const { canReadTaskRecord } = await import('./tasks.js')
  if (!(await canReadTaskRecord(user, collection, item))) throw new Error('Record not found')
  const assignee = t.assignee ? await findPerson(String(t.assignee)) : { id: user.id, name: 'you' }
  const priority = ['low', 'normal', 'urgent'].includes(String(t.priority))
    ? String(t.priority)
    : 'normal'
  let due: string | null = null
  if (t.due_date) {
    const d = new Date(String(t.due_date))
    if (Number.isNaN(d.getTime())) throw new Error('task.due_date must be a date (YYYY-MM-DD)')
    due = d.toISOString().slice(0, 10)
  }
  const { resolveFriendlyId } = await import('./workflow-transitions.js')
  const label = await resolveFriendlyId(collection, item).catch(() => item)
  const payload = {
    collection,
    item,
    title: title.slice(0, 500),
    description: t.description ? String(t.description).slice(0, 4000) : null,
    assignee: assignee.id,
    due_date: due,
    priority
  }
  const changes: Record<string, unknown> = {
    Task: payload.title,
    'Assign to': assignee.name,
    ...(due ? { Due: due } : {}),
    ...(priority !== 'normal' ? { Priority: priority } : {}),
    On: label
  }
  return {
    action_type: 'create_task',
    collection,
    payload,
    preview: {
      action_type: 'create_task',
      collection,
      count: 1,
      changes,
      sample: [{ id: item, label }]
    },
    storedPreview: { action_type: 'create_task', count: 1, changes },
    expiresNote:
      'The user must approve this proposal in the UI within 1 hour; the task is NOT created until then.',
    targets: { collection, ids: [item] }
  }
}

export interface DashboardDraftWidget {
  type?: string
  title?: string
  collection?: string
  field?: string
  filters?: unknown
  /** #2736 — an ai_query widget's query: {tool: aggregate | run_custom_query, input}. */
  query?: unknown
  chart?: string
  col?: number
  row?: number
  width?: number
  height?: number
}

/** A built widget: validated as the person, sized and placed on the 4-column grid. */
export interface BuiltDashboardWidget {
  type: string
  title: string
  collection: string | null
  field: string | null
  filters: string | null
  col: number
  row: number
  width: number
  height: number
}

async function buildDashboard(
  user: User,
  dashboard: { name?: string; widgets?: DashboardDraftWidget[] }
): Promise<BuiltAction> {
  const name = String(dashboard.name ?? '').trim()
  if (!name) throw new Error('dashboard.name is required')
  const rawWidgets = Array.isArray(dashboard.widgets) ? dashboard.widgets.slice(0, 12) : []
  if (rawWidgets.length === 0) throw new Error('dashboard.widgets must have at least one widget')

  const { widgetSourceRefusal } = await import('./dashboard-widgets.js')
  const { defaultWidgetSize, packDashboardGrid } = await import('./dashboard-grid-pack.js')
  const built: Array<Omit<BuiltDashboardWidget, 'col' | 'row'>> = []
  for (const w of rawWidgets) {
    const type = String(w.type ?? '')
    const title = String(w.title ?? '').trim()
    if (type === AI_QUERY_TYPE) {
      // #2736 / #2738 — a grouped aggregate or a saved query, stored as the query.
      const { aiQueryCollection, normalizeAiQuerySpec } = await import('./ai-query-widget.js')
      const spec = normalizeAiQuerySpec({
        source: w.query,
        chart: w.chart,
        question: title || undefined
      })
      if (!spec) {
        throw new Error(
          `Widget '${title || type}' needs query {tool: aggregate | run_custom_query, input}`
        )
      }
      const refusal = await widgetSourceRefusal(user, {
        type,
        collection: aiQueryCollection(spec),
        field: null,
        filters: spec
      })
      if (refusal) throw new Error(`Widget '${title || type}': ${refusal}`)
      const grouped = spec.source.tool !== 'aggregate' || !!spec.source.input.group_by
      const size = defaultWidgetSize(type, grouped)
      built.push({
        type,
        title: (title || 'Ask AI chart').slice(0, 100),
        collection: aiQueryCollection(spec),
        field: null,
        filters: JSON.stringify(spec),
        width: w.width ?? size.width,
        height: w.height ?? size.height
      })
      continue
    }
    if (!WIDGET_TYPES.has(type)) {
      throw new Error(
        `Invalid widget type '${type}' — use one of: ${[...WIDGET_TYPES, AI_QUERY_TYPE].join(', ')}`
      )
    }
    const collection = String(w.collection ?? '')
    if (!/^[a-zA-Z0-9_]+$/.test(collection) || collection.startsWith('nivaro_')) {
      throw new Error(`Invalid widget collection: ${collection}`)
    }
    if (!(await can(user, 'read', collection))) {
      throw new Error(`You cannot read ${collection}`)
    }
    const valid = new Set(
      (
        (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
          field: string
        }>
      ).map((r) => r.field)
    )
    const field = w.field != null && valid.has(String(w.field)) ? String(w.field) : null
    if (type !== 'count' && type !== 'latest' && !field) {
      throw new Error(`Widget '${String(w.title ?? type)}' needs a valid field for ${type}`)
    }
    const filters = w.filters ? JSON.stringify(w.filters) : null
    // The field and filter fields must be ones the person can read (#2736).
    const refusal = await widgetSourceRefusal(user, { type, collection, field, filters })
    if (refusal) throw new Error(`Widget '${title || type}': ${refusal}`)
    const size = defaultWidgetSize(type)
    built.push({
      type,
      title: (title || `${type} of ${collection}`).slice(0, 100),
      collection,
      field,
      filters,
      width: w.width ?? size.width,
      height: w.height ?? size.height
    })
  }
  const placed = packDashboardGrid(built)
  const widgets: BuiltDashboardWidget[] = built.map((w, i) => ({ ...w, ...placed[i] }))

  return {
    action_type: 'create_dashboard',
    collection: '__dashboard__',
    payload: { name, widgets },
    preview: {
      action_type: 'create_dashboard',
      collection: '__dashboard__',
      count: widgets.length,
      changes: { name },
      sample: [],
      widgets: widgets.map((w) => ({
        type: w.type,
        title: w.title,
        collection: w.collection ?? '',
        field: w.field
      }))
    },
    storedPreview: { action_type: 'create_dashboard', count: widgets.length },
    expiresNote: DEFAULT_EXPIRES_NOTE
  }
}

export async function executeProposal(
  user: User,
  proposalId: string
): Promise<{ status: string; result: Record<string, unknown> }> {
  const row = await db('nivaro_ai_proposals').where({ id: proposalId }).first()
  if (!row) throw Object.assign(new Error('Proposal not found'), { statusCode: 404 })
  if (row.user !== user.id) {
    throw Object.assign(new Error('Only the proposer can approve this'), { statusCode: 403 })
  }
  if (row.action_type === 'layout_ops') {
    // A layout proposal (#2694) is applied in the layout editor, through its draft.
    throw Object.assign(new Error('This is a layout proposal — review it in the layout editor'), {
      statusCode: 400
    })
  }
  if (row.action_type === 'schema_change') {
    // A schema proposal (#3209) is applied by an administrator on the Data Model page.
    throw Object.assign(
      new Error('This is a schema proposal — an administrator reviews it in the Data Model'),
      { statusCode: 400 }
    )
  }
  if (row.action_type === 'plan') {
    // A plan runs step by step through its own routes (services/ai-plans.ts).
    throw Object.assign(new Error('This is a plan — run it from its plan card'), {
      statusCode: 400
    })
  }
  if (row.status !== 'proposed') {
    throw Object.assign(new Error(`Proposal is already ${String(row.status)}`), { statusCode: 409 })
  }
  if (Date.now() - new Date(row.created_at).getTime() > EXPIRY_MS) {
    await db('nivaro_ai_proposals').where({ id: proposalId }).update({ status: 'expired' })
    throw Object.assign(new Error('Proposal expired — ask again'), { statusCode: 410 })
  }

  const payload = parseJson<Record<string, unknown>>(row.payload) ?? {}
  const result = await runAction(user, String(row.action_type), String(row.collection), payload)

  await db('nivaro_ai_proposals')
    .where({ id: proposalId })
    .update({
      status: 'executed',
      result: JSON.stringify(result),
      executed_at: new Date()
    })
  return { status: 'executed', result }
}

/**
 * Apply one built action AS THE PERSON — every write goes through the items
 * service (hooks, validation, row security, activity per record). Shared by
 * single proposals and AI plan steps. A bulk update reports its failures
 * rather than throwing; `failed_ids` names every record that refused.
 */
export async function runAction(
  user: User,
  actionType: string,
  collection: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> = {}
  if (actionType === 'create_task') {
    const { createTask } = await import('./tasks.js')
    const { getApp } = await import('./io-holder.js')
    const { task } = await createTask(getApp() ?? null, user.id, payload as never, {
      via: 'Ask AI'
    })
    result = { task_id: task.id, collection: task.collection, item: task.item }
  } else if (actionType === 'create_dashboard') {
    const name = String((payload.name as string) ?? 'AI Dashboard')
    const widgets = (payload.widgets as Array<Record<string, unknown>>) ?? []
    const dashId = randomUUID()
    await db('nivaro_dashboards').insert({
      id: dashId,
      name,
      user: user.id,
      is_shared: false,
      created_at: new Date(),
      updated_at: new Date()
    })
    // Placed when the draft was built (#2736); an older stored proposal has no
    // positions and is packed here the same way.
    const { defaultWidgetSize, packDashboardGrid } = await import('./dashboard-grid-pack.js')
    const placedAll = widgets.every((w) =>
      ['col', 'row', 'width', 'height'].every((k) => Number.isInteger(w[k]))
    )
    const packed = placedAll
      ? null
      : packDashboardGrid(widgets.map((w) => defaultWidgetSize(String(w.type))))
    for (const [i, w] of widgets.entries()) {
      const at = packed ? packed[i] : w
      await db('nivaro_dashboard_widgets').insert({
        id: randomUUID(),
        dashboard: dashId,
        type: w.type,
        title: w.title,
        collection: w.collection ?? null,
        field: w.field ?? null,
        filters: w.filters ?? null,
        col: at.col,
        row: at.row,
        width: at.width,
        height: at.height,
        created_at: new Date()
      })
    }
    result = { dashboard_id: dashId, widgets: widgets.length }
  } else if (actionType === 'create_record') {
    const created = (await createOne(
      user,
      collection,
      (payload.data as Record<string, unknown>) ?? {}
    )) as Record<string, unknown>
    result = { id: created?.id ?? null }
  } else {
    const ids = (payload.ids as string[]) ?? []
    const changes = (payload.changes as Record<string, unknown>) ?? {}
    let updated = 0
    const errors: string[] = []
    const failedIds: string[] = []
    for (const id of ids) {
      try {
        await updateOne(user, collection, id, { ...changes })
        updated++
      } catch (err) {
        failedIds.push(id)
        if (errors.length < 10) {
          errors.push(`${id}: ${err instanceof Error ? err.message.slice(0, 120) : 'failed'}`)
        }
      }
    }
    result = { updated, failed: ids.length - updated, errors, failed_ids: failedIds }
  }
  return result
}

export async function rejectProposal(user: User, proposalId: string): Promise<void> {
  const row = await db('nivaro_ai_proposals').where({ id: proposalId }).first()
  if (!row) throw Object.assign(new Error('Proposal not found'), { statusCode: 404 })
  if (row.user !== user.id) {
    throw Object.assign(new Error('Only the proposer can reject this'), { statusCode: 403 })
  }
  if (row.status !== 'proposed') return
  await db('nivaro_ai_proposals').where({ id: proposalId }).update({ status: 'rejected' })
}
