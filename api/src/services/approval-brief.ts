import { db } from '../db/index.js'
import { briefLinesFor, type BriefLine } from './approval-brief-lines.js'
import { getLabels } from './queues.js'

/**
 * "What am I approving": everything that changed on a record since it ENTERED
 * its current state — field deltas (old → new, labelled, FK ids resolved to
 * display labels), comments, addendums, who edited. Shared by the transition
 * confirm strip (routes/pipelines.ts) and the transition emails.
 */

export interface BriefFieldChange {
  field: string
  label: string
  old: string
  new: string
}

export interface ApprovalBrief {
  entered_at: string
  days_in_state: number
  revisions: number
  field_changes: BriefFieldChange[]
  changed_total: number
  comments: number
  addendums: { count: number; cost_impact: number }
  edited_by: string[]
  /** One-line facts registered by extensions for this collection (approval-brief-lines.ts). */
  lines: BriefLine[]
}

const IGNORED = new Set(['date_updated', 'user_updated', 'changed', 'last_state_change'])
const titleCase = (s: string) => s.replace(/_+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

const fmt = (v: unknown): string => {
  if (v == null || v === '') return '(empty)'
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80)
  return String(v)
    .replace(/<[^>]+>/g, '')
    .slice(0, 120)
}

export async function buildApprovalBrief(
  collection: string,
  item: string,
  opts: { instanceId?: string; currentState?: string | null; startedAt?: Date } = {}
): Promise<ApprovalBrief | null> {
  let instance: { id: string; current_state: string | null; started_at: Date } | undefined =
    opts.instanceId
      ? {
          id: opts.instanceId,
          current_state: opts.currentState ?? null,
          started_at: opts.startedAt ?? new Date()
        }
      : undefined
  if (!instance) {
    instance = (await db('nivaro_workflow_instances')
      .where({ collection, item: String(item) })
      .orderBy('started_at', 'desc')
      .first()) as typeof instance
  }
  if (!instance) return null

  let enteredAt = new Date(instance.started_at)
  if (instance.current_state) {
    const entry = (await db('nivaro_workflow_history')
      .where({ instance: instance.id, to_state: instance.current_state })
      .orderBy('timestamp', 'desc')
      .first('timestamp')) as { timestamp: Date } | undefined
    if (entry) enteredAt = new Date(entry.timestamp)
  }

  const [inWindow, preWindow, commentCount, addendums] = await Promise.all([
    db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'r.activity', 'a.id')
      .where('a.collection', collection)
      .where('a.item', String(item))
      .where('a.action', 'update')
      .where('a.timestamp', '>', enteredAt)
      .orderBy('a.timestamp', 'asc')
      .select('r.delta', 'a.timestamp', 'a.user') as Promise<
      Array<{ delta: string | null; timestamp: Date; user: string | null }>
    >,
    db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'r.activity', 'a.id')
      .where('a.collection', collection)
      .where('a.item', String(item))
      .where('a.timestamp', '<=', enteredAt)
      .orderBy('a.timestamp', 'desc')
      .first('r.data') as Promise<{ data: string | null } | undefined>,
    db('nivaro_comments')
      .where({ collection, item: String(item) })
      .where('created_at', '>', enteredAt)
      .count('* as c')
      .first()
      .catch(() => ({ c: 0 })) as Promise<{ c: number | string } | undefined>,
    db('nivaro_addendums')
      .where({ parent_collection: collection, parent_id: String(item) })
      .where('created_at', '>', enteredAt)
      .select('status', 'cost_impact')
      .catch(() => []) as Promise<Array<{ status: string; cost_impact: number | null }>>
  ])

  let oldRow: Record<string, unknown> = {}
  try {
    oldRow = preWindow?.data ? (JSON.parse(preWindow.data) as Record<string, unknown>) : {}
  } catch {
    oldRow = {}
  }
  const changed = new Map<string, unknown>()
  const editors = new Set<string>()
  for (const rev of inWindow) {
    try {
      const delta = rev.delta ? (JSON.parse(rev.delta) as Record<string, unknown>) : {}
      for (const [k, v] of Object.entries(delta)) changed.set(k, v)
      if (rev.user) editors.add(rev.user)
    } catch {
      /* one bad delta must not sink the brief */
    }
  }

  const keys = [...changed.keys()].filter((k) => !IGNORED.has(k) && !k.startsWith('_'))
  const top = keys.slice(0, 15)

  // Labels + FK → display label for the changed fields.
  const fieldRows = top.length
    ? ((await db('nivaro_fields')
        .where({ collection })
        .whereIn('field', top)
        .select('field', 'label')) as Array<{ field: string; label: string | null }>)
    : []
  const labelOf = new Map(fieldRows.map((f) => [f.field, f.label]))
  const rels = top.length
    ? ((await db('nivaro_relations')
        .where({ many_collection: collection })
        .whereIn('many_field', top)
        .whereNull('junction_field')
        .select('many_field', 'one_collection')) as Array<{
        many_field: string
        one_collection: string | null
      }>)
    : []
  const targetOf = new Map(
    rels.filter((r) => r.one_collection).map((r) => [r.many_field, r.one_collection as string])
  )
  const want = new Map<string, Set<string>>()
  for (const k of top) {
    const t = targetOf.get(k)
    if (!t) continue
    for (const v of [oldRow[k], changed.get(k)]) {
      if (v == null || v === '' || typeof v === 'object') continue
      const set = want.get(t) ?? new Set<string>()
      set.add(String(v))
      want.set(t, set)
    }
  }
  const labels = want.size ? await getLabels(want).catch(() => ({}) as Record<string, string>) : {}
  const show = (k: string, v: unknown) => {
    const t = targetOf.get(k)
    if (t && v != null && v !== '' && typeof v !== 'object')
      return labels[`${t}:${String(v)}`] ?? fmt(v)
    return fmt(v)
  }

  const fieldChanges: BriefFieldChange[] = top.map((field) => ({
    field,
    label: labelOf.get(field) || titleCase(field),
    old: field in oldRow ? show(field, oldRow[field]) : '',
    new: show(field, changed.get(field))
  }))

  let editorNames: string[] = []
  if (editors.size > 0) {
    const rows = (await db('nivaro_users')
      .whereIn('id', [...editors])
      .select('first_name', 'last_name', 'email')) as Array<{
      first_name: string | null
      last_name: string | null
      email: string
    }>
    editorNames = rows.map((u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email)
  }

  return {
    entered_at: enteredAt.toISOString(),
    days_in_state: Math.floor((Date.now() - enteredAt.getTime()) / 86_400_000),
    revisions: inWindow.length,
    field_changes: fieldChanges,
    changed_total: keys.length,
    comments: Number(commentCount?.c ?? 0),
    addendums: {
      count: addendums.length,
      cost_impact: addendums.reduce((sum, a) => sum + (Number(a.cost_impact) || 0), 0)
    },
    edited_by: editorNames,
    lines: await briefLinesFor(collection, String(item))
  }
}
