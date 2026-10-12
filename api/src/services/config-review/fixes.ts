import type { FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { snapshotLayoutVersion } from '../layout-versions.js'
import { snapshotReportVersion } from '../report-versions.js'
import { writeRevision } from '../revisions.js'
import { collectLabelOccurrences, FILE_MIN_AGE_DAYS, orphanFiles } from './checks.js'
import {
  cleanLabel,
  describeRule,
  type FieldRuleRow,
  findDuplicateViews,
  findRuleConflicts,
  type LabelOccurrence,
  type ReviewDetail,
  reviveRow,
  rewriteLabel,
  type SavedViewRow
} from './pure.js'

/**
 * One-click fixes for config review findings (#1961) and cleanup suggestions
 * (#2020), and the label rename (#1999). Every fix is planned from the rows
 * as they are NOW (a stale finding answers 409, never acts on old facts),
 * previewed as a change set, applied with the same writes the editors make
 * (layout / report versions captured first, activity rows, saved-view delete
 * revisions) and — where the kind allows — recorded with what an undo needs.
 */

export class FixError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

export interface ChangeLine {
  action: 'delete' | 'update' | 'remove' | 'cancel' | 'switch-off'
  target: string
  before?: string | null
  after?: string | null
  href?: string
}

export interface ChangeSet {
  kind: string
  title: string
  /** At most PREVIEW_LINES lines; `total` is the full count. */
  lines: ChangeLine[]
  total: number
  undoable: boolean
  note?: string
}

export interface UndoPayload {
  kind: string
  data: unknown
}

export interface FindingRow {
  id: number
  family: string
  code: string
  subject: string
  detail: ReviewDetail
}

export interface FixContext {
  userId: string | null
  req?: FastifyRequest
  /** label-rename: the label to use (else the model's, else the most used). */
  label?: string
}

interface Plan {
  changeSet: ChangeSet
  apply: () => Promise<UndoPayload | null>
}

const PREVIEW_LINES = 60
/** Each apply works on at most this many rows — big backlogs go in visible rounds. */
export const FIX_BATCH = 500
/** Drafts above this many payload bytes are deleted without an undo copy. */
const DRAFT_UNDO_BYTES = 2_000_000
const DAY = 86_400_000
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const isTrue = (v: unknown) => v === true || v === 1

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const short = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : '—')

// ─── Field rules ─────────────────────────────────────────────────────────────

async function planRuleDeactivate(f: FindingRow, ctx: FixContext): Promise<Plan> {
  const shadowed = num(f.detail.data?.shadowed)
  const collection = String(f.detail.data?.collection ?? '')
  if (shadowed == null || !collection) throw new FixError(422, 'Finding names no rule')
  const rules = (await db('nivaro_field_rules')
    .where({ collection })
    .select(
      'id',
      'collection',
      'trigger_field',
      'trigger_op',
      'trigger_value',
      'target_field',
      'target_type',
      'target_value',
      'sort',
      'is_active',
      'only_when_empty',
      'dynamic_config'
    )) as FieldRuleRow[]
  const conflict = findRuleConflicts(rules).find((c) => c.shadowed.id === shadowed)
  if (!conflict) throw new FixError(409, 'These rules no longer conflict — run the review again')
  return {
    changeSet: {
      kind: 'rule-deactivate',
      title: `Switch off field rule #${shadowed}`,
      lines: [
        {
          action: 'switch-off',
          target: describeRule(conflict.shadowed),
          before: 'active',
          after: 'off',
          href: `/data-model/${collection}?tab=rules`
        }
      ],
      total: 1,
      undoable: true,
      note:
        conflict.kind === 'duplicate'
          ? `Rule #${conflict.winner.id} does the same thing, so nothing changes on the form.`
          : `Rule #${conflict.winner.id} already overwrites it, so nothing changes on the form — the rules are merged into the one that takes effect.`
    },
    apply: async () => {
      await db('nivaro_field_rules').where({ id: shadowed }).update({ is_active: false })
      await logActivity({
        action: 'update',
        user: ctx.userId,
        collection: 'nivaro_field_rules',
        item: String(shadowed),
        comment: `Switched off by the config review (shadowed by #${conflict.winner.id})`,
        req: ctx.req
      })
      return { kind: 'rule-deactivate', data: { rule: shadowed } }
    }
  }
}

async function undoRuleDeactivate(data: { rule: number }, ctx: FixContext): Promise<number> {
  const n = await db('nivaro_field_rules').where({ id: data.rule }).update({ is_active: true })
  if (n) {
    await logActivity({
      action: 'update',
      user: ctx.userId,
      collection: 'nivaro_field_rules',
      item: String(data.rule),
      comment: 'Switched back on (config review fix undone)',
      req: ctx.req
    })
  }
  return Number(n) || 0
}

// ─── Saved views ─────────────────────────────────────────────────────────────

async function subscribedViewIds(): Promise<Set<number>> {
  try {
    const rows = (await db('nivaro_view_subscriptions').distinct('view_id')) as Array<{
      view_id: number
    }>
    return new Set(rows.map((r) => Number(r.view_id)))
  } catch {
    return new Set()
  }
}

/** Delete views the way the saved-views route does: activity + full revision. */
async function deleteViews(
  rows: Array<Record<string, unknown>>,
  ctx: FixContext,
  why: string
): Promise<void> {
  for (const v of rows) {
    await db('nivaro_saved_views').where({ id: v.id }).delete()
    const activity = await logActivity({
      action: 'delete',
      user: ctx.userId,
      collection: 'nivaro_saved_views',
      item: String(v.id),
      comment: `${v.collection} · ${v.name} — ${why}`.slice(0, 1000),
      req: ctx.req
    })
    await writeRevision({
      activity,
      collection: 'nivaro_saved_views',
      item: String(v.id),
      data: v,
      delta: null
    })
  }
}

async function restoreViews(
  data: { views: Array<Record<string, unknown>> },
  ctx: FixContext
): Promise<number> {
  let n = 0
  for (const v of data.views) {
    const [row] = (await db('nivaro_saved_views').insert(reviveRow(v)).returning('id')) as unknown[]
    const id = typeof row === 'object' && row ? (row as { id: number }).id : row
    await logActivity({
      action: 'create',
      user: ctx.userId,
      collection: 'nivaro_saved_views',
      item: String(id),
      comment: `Restored view #${v.id} "${v.name}" (config review fix undone)`,
      req: ctx.req
    })
    n++
  }
  return n
}

async function planViewDelete(f: FindingRow, ctx: FixContext): Promise<Plan> {
  const viewId = num(f.detail.data?.view)
  if (viewId == null) throw new FixError(422, 'Finding names no view')
  const view = (await db('nivaro_saved_views').where({ id: viewId }).first()) as
    | (SavedViewRow & Record<string, unknown>)
    | undefined
  if (!view) throw new FixError(409, 'The view is already gone — run the review again')
  const siblings = (await db('nivaro_saved_views')
    .where({ collection: view.collection })
    .select()) as Array<SavedViewRow & Record<string, unknown>>
  const group = findDuplicateViews(siblings).find((g) => g.duplicates.some((d) => d.id === viewId))
  if (!group) throw new FixError(409, 'The view is no longer a duplicate — run the review again')
  if (isTrue(view.is_default) || view.default_for_role)
    throw new FixError(409, 'The view is a default view now')
  if ((await subscribedViewIds()).has(viewId))
    throw new FixError(409, 'Someone subscribed to the view since the review ran')
  return {
    changeSet: {
      kind: 'view-delete',
      title: `Delete saved view "${view.name}"`,
      lines: [
        {
          action: 'delete',
          target: `Saved view "${view.name}" (${view.collection}, #${view.id})`,
          href: `/collections/${view.collection}`
        }
      ],
      total: 1,
      undoable: true,
      note: `View #${group.keep.id} "${group.keep.name}" shows exactly the same thing and stays.`
    },
    apply: async () => {
      await deleteViews([view], ctx, `duplicate of #${group.keep.id} (config review)`)
      return { kind: 'views', data: { views: [view] } }
    }
  }
}

async function planViewsDelete(f: FindingRow, ctx: FixContext): Promise<Plan> {
  const listed = Array.isArray(f.detail.data?.views)
    ? (f.detail.data?.views as Array<{ id: number }>).map((v) => Number(v.id)).filter(Boolean)
    : []
  const days = num(f.detail.data?.days) ?? 90
  if (listed.length === 0) throw new FixError(422, 'Finding lists no views')
  const since = new Date(Date.now() - days * DAY)
  const opened = new Set(
    (
      (await db('nivaro_activity')
        .where('action', 'saved-view-open')
        .where('timestamp', '>=', since)
        .whereIn('item', listed.map(String))
        .distinct('item')) as Array<{ item: string }>
    ).map((r) => String(r.item))
  )
  const subscribed = await subscribedViewIds()
  const rows = (
    (await db('nivaro_saved_views').whereIn('id', listed).select()) as Array<
      SavedViewRow & Record<string, unknown>
    >
  ).filter(
    (v) =>
      !isTrue(v.is_default) &&
      !v.default_for_role &&
      !subscribed.has(Number(v.id)) &&
      !opened.has(String(v.id))
  )
  if (rows.length === 0) throw new FixError(409, 'Every listed view is in use again or gone')
  return {
    changeSet: {
      kind: 'views-delete',
      title: `Delete ${rows.length} unopened saved view(s)`,
      lines: rows.slice(0, PREVIEW_LINES).map((v) => ({
        action: 'delete' as const,
        target: `"${v.name}" (${v.collection}, #${v.id})`,
        href: `/collections/${v.collection}`
      })),
      total: rows.length,
      undoable: true,
      note:
        rows.length < listed.length
          ? `${listed.length - rows.length} listed view(s) were opened, subscribed to, made a default or deleted since the review ran and are left alone.`
          : undefined
    },
    apply: async () => {
      await deleteViews(rows, ctx, `not opened in ${days} days (config review cleanup)`)
      return { kind: 'views', data: { views: rows } }
    }
  }
}

// ─── Layout assignments ──────────────────────────────────────────────────────

async function planFieldRemove(f: FindingRow, ctx: FixContext): Promise<Plan> {
  const collection = String(f.detail.data?.collection ?? '')
  const field = String(f.detail.data?.field ?? '')
  const layoutIds = Array.isArray(f.detail.data?.layouts)
    ? (f.detail.data?.layouts as unknown[]).map(Number).filter(Number.isFinite)
    : []
  if (!IDENT.test(collection) || !IDENT.test(field) || layoutIds.length === 0)
    throw new FixError(422, 'Finding names no field')
  // Still empty? Someone may have started filling it since the review.
  const [row] = (await db.raw(`SELECT COUNT([${field}]) AS c FROM [${collection}]`)) as Array<{
    c: number
  }>
  if (Number(row?.c ?? 0) > 0)
    throw new FixError(409, `${row.c} record(s) hold a value in ${field} now — not removing it`)
  const assignments = (await db('nivaro_layout_field_assignments as a')
    .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
    .whereIn('a.layout_id', layoutIds)
    .where('a.field', field)
    .where('l.collection', collection)
    .select('a.*', 'l.name as layout_name')) as Array<Record<string, unknown>>
  if (assignments.length === 0) throw new FixError(409, 'The field is on none of those layouts now')
  return {
    changeSet: {
      kind: 'field-remove-from-layouts',
      title: `Remove ${field} from ${assignments.length} layout(s)`,
      lines: assignments.map((a) => ({
        action: 'remove' as const,
        target: `Layout "${a.layout_name}" · ${field}`,
        href: `/data-model/${collection}?tab=groups`
      })),
      total: assignments.length,
      undoable: true,
      note: 'Each layout gets a version first, so the Layouts tab history can restore it too. The column and its data are not touched.'
    },
    apply: async () => {
      const saved: Array<Record<string, unknown>> = []
      for (const a of assignments) {
        const layoutId = Number(a.layout_id)
        await snapshotLayoutVersion(layoutId, 'before config review fix', ctx.userId)
        await db('nivaro_layout_field_assignments').where({ id: a.id }).delete()
        const { layout_name: _n, ...cols } = a
        saved.push(cols)
        await logActivity({
          action: 'update',
          user: ctx.userId,
          collection: 'nivaro_collection_layouts',
          item: String(layoutId),
          comment: `Removed ${field} (empty on every record) — config review`,
          req: ctx.req
        })
      }
      return { kind: 'field-remove-from-layouts', data: { collection, field, assignments: saved } }
    }
  }
}

async function undoFieldRemove(
  data: { field: string; assignments: Array<Record<string, unknown>> },
  ctx: FixContext
): Promise<number> {
  let n = 0
  for (const a of data.assignments) {
    const layoutId = Number(a.layout_id)
    const present = await db('nivaro_layout_field_assignments')
      .where({ layout_id: layoutId, field: a.field })
      .first('id')
    if (present) continue
    const layout = await db('nivaro_collection_layouts').where({ id: layoutId }).first('id')
    if (!layout) continue
    await snapshotLayoutVersion(layoutId, 'before config review undo', ctx.userId)
    await db('nivaro_layout_field_assignments').insert(reviveRow(a))
    await logActivity({
      action: 'update',
      user: ctx.userId,
      collection: 'nivaro_collection_layouts',
      item: String(layoutId),
      comment: `Put ${data.field} back (config review fix undone)`,
      req: ctx.req
    })
    n++
  }
  return n
}

// ─── Drafts ──────────────────────────────────────────────────────────────────

async function planDraftsDelete(f: FindingRow, ctx: FixContext): Promise<Plan> {
  const cutoff = new Date(String(f.detail.data?.cutoff ?? ''))
  if (Number.isNaN(cutoff.getTime())) throw new FixError(422, 'Finding carries no cutoff')
  const rows = (await db('nivaro_drafts')
    .where('saved_at', '<', cutoff)
    .orderBy('saved_at', 'asc')
    .limit(FIX_BATCH)
    .select(
      'id',
      'user',
      'collection',
      'item_key',
      'saved_at',
      db.raw('CAST(DATALENGTH(payload) AS BIGINT) AS bytes')
    )) as Array<{
    id: number
    user: string
    collection: string
    item_key: string
    saved_at: Date
    bytes: number | null
  }>
  if (rows.length === 0) throw new FixError(409, 'No draft is that old any more')
  const [{ c }] = (await db('nivaro_drafts').where('saved_at', '<', cutoff).count({ c: '*' })) as [
    { c: number }
  ]
  const bytes = rows.reduce((s, r) => s + Number(r.bytes ?? 0), 0)
  const undoable = bytes <= DRAFT_UNDO_BYTES
  const total = Number(c)
  return {
    changeSet: {
      kind: 'drafts-delete',
      title: `Delete ${rows.length} stale draft(s)`,
      lines: rows.slice(0, PREVIEW_LINES).map((r) => ({
        action: 'delete' as const,
        target: `${r.collection} · ${r.item_key === 'new' ? 'unsaved new record' : `record ${r.item_key}`} · last saved ${short(r.saved_at)}`
      })),
      total: rows.length,
      undoable,
      note:
        [
          total > rows.length
            ? `${total} drafts qualify; this round deletes the oldest ${rows.length}.`
            : null,
          undoable
            ? null
            : `These drafts hold ${(bytes / 1e6).toFixed(1)} MB — too much to keep a copy, so this cannot be undone.`
        ]
          .filter(Boolean)
          .join(' ') || undefined
    },
    apply: async () => {
      const ids = rows.map((r) => r.id)
      const full = undoable
        ? ((await db('nivaro_drafts').whereIn('id', ids).select()) as Array<
            Record<string, unknown>
          >)
        : []
      await db('nivaro_drafts').whereIn('id', ids).delete()
      await logActivity({
        action: 'config-review-cleanup',
        user: ctx.userId,
        collection: 'nivaro_drafts',
        comment: `${ids.length} draft(s) older than ${short(cutoff)} deleted`,
        req: ctx.req
      })
      return undoable ? { kind: 'drafts', data: { drafts: full } } : null
    }
  }
}

async function undoDrafts(
  data: { drafts: Array<Record<string, unknown>> },
  ctx: FixContext
): Promise<number> {
  let n = 0
  for (const d of data.drafts) {
    // One draft per (user, collection, item_key): a newer one wins.
    const present = await db('nivaro_drafts')
      .where({ user: d.user, collection: d.collection, item_key: d.item_key })
      .first('id')
    if (present) continue
    await db('nivaro_drafts').insert(reviveRow(d))
    n++
  }
  await logActivity({
    action: 'config-review-undo',
    user: ctx.userId,
    collection: 'nivaro_drafts',
    comment: `${n} draft(s) restored`,
    req: ctx.req
  })
  return n
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

async function planTasksCancel(f: FindingRow, ctx: FixContext): Promise<Plan> {
  const cutoff = new Date(String(f.detail.data?.cutoff ?? ''))
  if (Number.isNaN(cutoff.getTime())) throw new FixError(422, 'Finding carries no cutoff')
  const rows = (await db('nivaro_tasks')
    .whereIn('status', ['open', 'in_progress'])
    .where((qb) => qb.whereNot('kind', 'support').orWhereNull('kind'))
    .whereRaw('COALESCE(updated_at, created_at) < ?', [cutoff])
    .orderBy('id', 'asc')
    .limit(FIX_BATCH)
    .select('id', 'title', 'status', 'completed_at', 'collection', 'item')) as Array<{
    id: number
    title: string
    status: string
    completed_at: Date | null
    collection: string | null
    item: string | null
  }>
  if (rows.length === 0) throw new FixError(409, 'No open task is that idle any more')
  const months = num(f.detail.data?.months) ?? 3
  return {
    changeSet: {
      kind: 'tasks-cancel',
      title: `Cancel ${rows.length} idle task(s)`,
      lines: rows.slice(0, PREVIEW_LINES).map((t) => ({
        action: 'cancel' as const,
        target: `#${t.id} ${t.title}`.slice(0, 200),
        before: t.status,
        after: 'cancelled',
        href: '/tasks'
      })),
      total: rows.length,
      undoable: true,
      note: 'Each task gets a history line saying why. Nobody is notified.'
    },
    apply: async () => {
      const { logTaskEvent } = await import('../tasks.js')
      const now = new Date()
      for (const t of rows) {
        await db('nivaro_tasks')
          .where({ id: t.id })
          .whereIn('status', ['open', 'in_progress'])
          .update({ status: 'cancelled', completed_at: now })
        await logTaskEvent(
          t.id,
          ctx.userId,
          `Cancelled by the config review: untouched for ${months} months`,
          ctx.req
        )
      }
      return {
        kind: 'tasks',
        data: {
          tasks: rows.map((t) => ({ id: t.id, status: t.status, completed_at: t.completed_at }))
        }
      }
    }
  }
}

async function undoTasks(
  data: { tasks: Array<{ id: number; status: string; completed_at: string | null }> },
  ctx: FixContext
): Promise<number> {
  const { logTaskEvent } = await import('../tasks.js')
  let n = 0
  for (const t of data.tasks) {
    // Only tasks still cancelled — one reopened or finished since is left alone.
    const changed = await db('nivaro_tasks')
      .where({ id: t.id, status: 'cancelled' })
      .update({ status: t.status, completed_at: t.completed_at ? new Date(t.completed_at) : null })
    if (!changed) continue
    n++
    await logTaskEvent(t.id, ctx.userId, 'Reopened: config review cleanup undone', ctx.req)
  }
  return n
}

// ─── Files ───────────────────────────────────────────────────────────────────

async function planFilesDelete(_f: FindingRow, ctx: FixContext): Promise<Plan> {
  const rows = (await orphanFiles(new Date(Date.now() - FILE_MIN_AGE_DAYS * DAY))).slice(0, 200)
  if (rows.length === 0) throw new FixError(409, 'No unreferenced file is left')
  const bytes = rows.reduce((s, r) => s + Number(r.filesize ?? 0), 0)
  return {
    changeSet: {
      kind: 'files-delete',
      title: `Delete ${rows.length} unreferenced file(s)`,
      lines: rows.slice(0, PREVIEW_LINES).map((r) => ({
        action: 'delete' as const,
        target: `${r.filename_download ?? r.id} · uploaded ${short(r.uploaded_on)}`
      })),
      total: rows.length,
      undoable: false,
      note: `Frees ${(bytes / 1e6).toFixed(1)} MB. The stored objects are removed too, so this cannot be undone.`
    },
    apply: async () => {
      const { deleteFile } = await import('../files.js')
      let deleted = 0
      let failed = 0
      for (const r of rows) {
        try {
          await deleteFile(String(r.id))
          deleted++
        } catch {
          failed++
        }
      }
      await logActivity({
        action: 'files-orphans-purge',
        user: ctx.userId,
        collection: 'nivaro_files',
        comment: `${deleted} unreferenced file(s) deleted by the config review${failed ? `, ${failed} failed` : ''}`,
        req: ctx.req
      })
      return null
    }
  }
}

// ─── Labels ──────────────────────────────────────────────────────────────────

interface LabelEdit {
  source: LabelOccurrence['source']
  ref: string | number
  path: string
  before: string
  after: string
}

/** Where each label occurrence is stored. */
function labelColumn(o: Pick<LabelOccurrence, 'source' | 'path'>): {
  table: string
  column: string
} {
  switch (o.source) {
    case 'field':
      return { table: 'nivaro_fields', column: 'label' }
    case 'layout':
      return {
        table: 'nivaro_layout_field_assignments',
        column: o.path === 'label_override' ? 'label_override' : 'overrides'
      }
    case 'queue':
      return { table: 'nivaro_queues', column: 'column_aliases' }
    case 'view':
      return { table: 'nivaro_saved_views', column: 'columns' }
    default:
      return { table: 'nivaro_report_widgets', column: 'config' }
  }
}

/** Rewrite each edit in place (fresh read per edit); return the ones that took. */
async function writeLabels(
  edits: LabelEdit[],
  ctx: FixContext,
  direction: 'apply' | 'undo'
): Promise<LabelEdit[]> {
  const done: LabelEdit[] = []
  const snapped = new Set<string>()
  let fieldsTouched = false
  for (const e of edits) {
    const { table, column } = labelColumn(e)
    const row = (await db(table).where({ id: e.ref }).first()) as
      | Record<string, unknown>
      | undefined
    if (!row) continue
    const [expected, next] = direction === 'apply' ? [e.before, e.after] : [e.after, e.before]
    const raw = row[column] == null ? null : String(row[column])
    const rewritten = rewriteLabel(e, raw, expected, next)
    if (rewritten == null) continue
    // Versioned editors get their version first, once per layout / report.
    if (e.source === 'layout' && !snapped.has(`l${row.layout_id}`)) {
      snapped.add(`l${row.layout_id}`)
      await snapshotLayoutVersion(Number(row.layout_id), `before label ${direction}`, ctx.userId)
    }
    if (e.source === 'report' && !snapped.has(`r${row.report}`)) {
      snapped.add(`r${row.report}`)
      await snapshotReportVersion(String(row.report), `before label ${direction}`, ctx.userId)
    }
    await db(table)
      .where({ id: e.ref })
      .update({ [column]: rewritten })
    if (e.source === 'field') fieldsTouched = true
    await logActivity({
      action: 'update',
      user: ctx.userId,
      collection: table,
      item: String(e.ref),
      comment: `Label "${expected}" → "${next}" (config review${direction === 'undo' ? ' undo' : ''})`,
      req: ctx.req
    })
    done.push(e)
  }
  if (fieldsTouched) {
    const { clearMetadataCache } = await import('../collections.js')
    clearMetadataCache()
  }
  return done
}

async function planLabelRename(f: FindingRow, ctx: FixContext): Promise<Plan> {
  const field = String(f.detail.data?.field ?? '').toLowerCase()
  if (!field) throw new FixError(422, 'Finding names no field')
  const proposed = ctx.label ?? f.detail.data?.ai_label ?? f.detail.data?.suggested
  const label = cleanLabel(proposed)
  if (!label) throw new FixError(400, 'Pick a label (plain text, at most 80 characters)')
  const occ = (await collectLabelOccurrences()).filter(
    (o) => o.field.toLowerCase() === field && o.label.trim() !== label
  )
  if (occ.length === 0) throw new FixError(409, `Every place already reads "${label}"`)
  const edits: LabelEdit[] = occ.map((o) => ({
    source: o.source,
    ref: o.ref,
    path: o.path,
    before: o.label.trim(),
    after: label
  }))
  return {
    changeSet: {
      kind: 'label-rename',
      title: `Label ${field} "${label}" everywhere`,
      lines: occ.slice(0, PREVIEW_LINES).map((o) => ({
        action: 'update' as const,
        target: o.where,
        before: o.label,
        after: label,
        href: o.href
      })),
      total: occ.length,
      undoable: true,
      note: 'Layouts and reports get a version first. An undo puts back only labels nobody changed since.'
    },
    apply: async () => {
      const done = await writeLabels(edits, ctx, 'apply')
      if (done.length === 0) throw new FixError(409, 'Every label changed since the preview')
      return { kind: 'labels', data: { edits: done } }
    }
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const PLANNERS: Record<string, (f: FindingRow, ctx: FixContext) => Promise<Plan>> = {
  'rule-deactivate': planRuleDeactivate,
  'view-delete': planViewDelete,
  'views-delete': planViewsDelete,
  'field-remove-from-layouts': planFieldRemove,
  'drafts-delete': planDraftsDelete,
  'tasks-cancel': planTasksCancel,
  'files-delete': planFilesDelete,
  'label-rename': planLabelRename
}

export const FIX_KINDS = Object.keys(PLANNERS)

async function plan(f: FindingRow, ctx: FixContext): Promise<Plan> {
  const kind = f.detail.fix?.kind
  const planner = kind ? PLANNERS[kind] : undefined
  if (!planner) throw new FixError(422, 'This finding has no one-click fix')
  return planner(f, ctx)
}

export async function previewFix(f: FindingRow, ctx: FixContext): Promise<ChangeSet> {
  return (await plan(f, ctx)).changeSet
}

export async function applyFix(
  f: FindingRow,
  ctx: FixContext
): Promise<{ changeSet: ChangeSet; undo: UndoPayload | null }> {
  const p = await plan(f, ctx)
  const undo = await p.apply()
  return { changeSet: p.changeSet, undo }
}

/** Reverse an applied fix; returns how many rows came back. */
export async function undoFix(undo: UndoPayload, ctx: FixContext): Promise<number> {
  const d = undo.data as never
  switch (undo.kind) {
    case 'rule-deactivate':
      return undoRuleDeactivate(d, ctx)
    case 'views':
      return restoreViews(d, ctx)
    case 'field-remove-from-layouts':
      return undoFieldRemove(d, ctx)
    case 'drafts':
      return undoDrafts(d, ctx)
    case 'tasks':
      return undoTasks(d, ctx)
    case 'labels':
      return (await writeLabels((undo.data as { edits: LabelEdit[] }).edits, ctx, 'undo')).length
    default:
      throw new FixError(422, 'This change cannot be undone')
  }
}
