import { db } from '../../db/index.js'
import {
  CLEANUP_DEFAULTS,
  type CleanupThresholds,
  describeRule,
  dropReferenced,
  extractFileIds,
  type FieldRuleRow,
  type FileRefMeta,
  fileRefSources,
  fileRefTables,
  findDuplicateViews,
  findRuleConflicts,
  groupLabelConcepts,
  type LabelOccurrence,
  leafOf,
  normalizeCleanup,
  type ReviewFinding,
  type SavedViewRow
} from './pure.js'

/**
 * The deterministic detectors behind the config review (#1913), the cleanup
 * list (#2020) and the label check (#1999). Each check is independent and
 * contributes zero findings on error — one broken table must never sink the
 * whole report. Nothing here writes.
 */

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const isTrue = (v: unknown) => v === true || v === 1
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

// ─── #1913 Config review ─────────────────────────────────────────────────────

async function ruleConflictFindings(): Promise<ReviewFinding[]> {
  const rules = (await db('nivaro_field_rules').select(
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
  return findRuleConflicts(rules).map((c) => ({
    family: 'review',
    code: c.kind === 'duplicate' ? 'rule-duplicate' : 'rule-contradiction',
    subject: `field-rule:${c.shadowed.id}`,
    title:
      c.kind === 'duplicate'
        ? `Field rule #${c.shadowed.id} on ${c.collection} repeats rule #${c.winner.id}`
        : `Field rules #${c.shadowed.id} and #${c.winner.id} on ${c.collection} set ${c.winner.target_field} differently`,
    severity: c.kind === 'duplicate' ? 'info' : 'warning',
    href: `/data-model/${c.collection}?tab=rules`,
    detail: {
      reason:
        c.kind === 'duplicate'
          ? `${describeRule(c.shadowed)} and ${describeRule(c.winner)} do the same thing on the same trigger; one of them can go.`
          : `${describeRule(c.shadowed)} runs first and ${describeRule(c.winner)} overwrites it on the same trigger, so the first rule never takes effect.`,
      fix: {
        kind: 'rule-deactivate',
        label: `Switch off rule #${c.shadowed.id}`,
        undoable: true
      },
      data: { shadowed: c.shadowed.id, winner: c.winner.id, collection: c.collection }
    }
  }))
}

async function duplicateViewFindings(): Promise<ReviewFinding[]> {
  const views = (await db('nivaro_saved_views').select(
    'id',
    'collection',
    'name',
    'filters',
    'sort',
    'columns',
    'user',
    'is_shared',
    'role',
    'is_default',
    'default_for_role',
    'created_at'
  )) as SavedViewRow[]
  const subscribed = new Set(
    (
      await safe(
        () =>
          db('nivaro_view_subscriptions').distinct('view_id') as Promise<
            Array<{ view_id: number }>
          >,
        []
      )
    ).map((r) => Number(r.view_id))
  )
  const out: ReviewFinding[] = []
  for (const group of findDuplicateViews(views)) {
    for (const d of group.duplicates) {
      const pinned = isTrue(d.is_default) || !!d.default_for_role
      const blocked = pinned
        ? 'it is a default view'
        : subscribed.has(Number(d.id))
          ? 'someone is subscribed to it'
          : null
      out.push({
        family: 'review',
        code: 'view-duplicate',
        subject: `saved-view:${d.id}`,
        title: `Saved view "${d.name}" (${d.collection}) duplicates "${group.keep.name}"`,
        severity: 'info',
        href: `/collections/${d.collection}`,
        detail: {
          reason: `Same filters, sort and columns as view #${group.keep.id} for the same audience — people pick between two identical pills.`,
          fix: blocked
            ? null
            : { kind: 'view-delete', label: 'Delete the duplicate view', undoable: true },
          data: { keep: group.keep.id, view: d.id, blocked }
        }
      })
    }
  }
  return out
}

/** Row counts from the partition stats — one query, no table scans. */
async function rowCounts(): Promise<Map<string, number>> {
  const rows = (await db.raw(
    `SELECT t.name AS name, SUM(p.row_count) AS n
       FROM sys.dm_db_partition_stats p
       JOIN sys.tables t ON t.object_id = p.object_id
      WHERE p.index_id IN (0, 1)
      GROUP BY t.name`
  )) as Array<{ name: string; n: number }>
  return new Map(rows.map((r) => [r.name.toLowerCase(), Number(r.n)]))
}

const AUDIT = new Set([
  'id',
  'created_at',
  'updated_at',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated',
  'created',
  'changed',
  'sort'
])

/** Collections above this many rows are skipped — the COUNT() scan must stay cheap. */
const FIELD_SCAN_MAX_ROWS = 250_000

/**
 * Fields nothing uses: physical columns empty on every record. On a layout
 * they cost every form a row; off every layout they are dead weight. Only
 * collections with a layout and at most FIELD_SCAN_MAX_ROWS rows are read.
 */
async function emptyFieldFindings(): Promise<ReviewFinding[]> {
  const counts = await rowCounts()
  const layouts = (await db('nivaro_collection_layouts').select(
    'id',
    'collection',
    'name',
    'layout_type'
  )) as Array<{ id: number; collection: string; name: string; layout_type: string | null }>
  const byCollection = new Map<string, typeof layouts>()
  for (const l of layouts) {
    if (/^nivaro_/i.test(l.collection)) continue
    const list = byCollection.get(l.collection) ?? []
    list.push(l)
    byCollection.set(l.collection, list)
  }
  const assignments = (await db('nivaro_layout_field_assignments').select(
    'id',
    'layout_id',
    'field'
  )) as Array<{ id: number; layout_id: number; field: string }>
  const onLayouts = new Map<string, Set<number>>()
  const layoutCollection = new Map(layouts.map((l) => [l.id, l.collection]))
  for (const a of assignments) {
    const c = layoutCollection.get(a.layout_id)
    if (!c || a.field.includes('.') || a.field.startsWith('__')) continue
    const key = `${c}.${a.field}`.toLowerCase()
    const set = onLayouts.get(key) ?? new Set<number>()
    set.add(a.layout_id)
    onLayouts.set(key, set)
  }
  const fieldMeta = (await db('nivaro_fields')
    .whereNot('collection', 'like', 'nivaro_%')
    .select('collection', 'field', 'computed_type', 'hidden', 'created_at')) as Array<{
    collection: string
    field: string
    computed_type: string | null
    hidden: boolean | number | null
    created_at: Date | null
  }>
  const metaByKey = new Map(fieldMeta.map((f) => [`${f.collection}.${f.field}`.toLowerCase(), f]))

  const out: ReviewFinding[] = []
  for (const [collection] of byCollection) {
    const rows = counts.get(collection.toLowerCase()) ?? 0
    if (rows === 0 || rows > FIELD_SCAN_MAX_ROWS || !IDENT.test(collection)) continue
    const columns = (
      (await db('information_schema.columns')
        .where({ table_name: collection })
        .select('column_name', 'data_type')) as Array<{ column_name: string; data_type: string }>
    ).filter(
      (c) =>
        IDENT.test(c.column_name) &&
        !AUDIT.has(c.column_name.toLowerCase()) &&
        !['bit', 'timestamp', 'rowversion'].includes(c.data_type.toLowerCase())
    )
    for (let i = 0; i < columns.length; i += 60) {
      const chunk = columns.slice(i, i + 60)
      const sel = chunk.map((c, j) => `COUNT([${c.column_name}]) AS c${j}`).join(', ')
      const res = await safe(
        () =>
          db.raw(`SELECT ${sel} FROM [${collection}]`) as Promise<Array<Record<string, number>>>,
        [] as Array<Record<string, number>>
      )
      const row = res[0]
      if (!row) continue
      chunk.forEach((c, j) => {
        if (Number(row[`c${j}`]) !== 0) return
        const key = `${collection}.${c.column_name}`.toLowerCase()
        const meta = metaByKey.get(key)
        if (meta?.computed_type) return
        // A field younger than 30 days has not had a fair chance to be filled.
        if (meta?.created_at && new Date(meta.created_at) > ago(30)) return
        const layoutIds = [...(onLayouts.get(key) ?? [])]
        if (layoutIds.length > 0) {
          const names = (byCollection.get(collection) ?? [])
            .filter((l) => layoutIds.includes(l.id))
            .map((l) => `"${l.name}"`)
          out.push({
            family: 'review',
            code: 'field-empty-on-layout',
            subject: `field:${collection}.${c.column_name}`,
            title: `${collection}.${c.column_name} is on ${layoutIds.length} layout(s) but empty on every record`,
            severity: 'info',
            href: `/data-model/${collection}?tab=groups`,
            detail: {
              reason: `None of the ${rows.toLocaleString('en-US')} ${collection} records has a value in ${c.column_name}, yet it takes space on ${names.join(', ')}.`,
              impact: { count: layoutIds.length, text: `${layoutIds.length} layout(s) lose a row` },
              fix: {
                kind: 'field-remove-from-layouts',
                label: 'Remove it from the layouts',
                undoable: true
              },
              data: { collection, field: c.column_name, layouts: layoutIds, rows }
            }
          })
        } else if (meta && !isTrue(meta.hidden)) {
          out.push({
            family: 'review',
            code: 'field-unused',
            subject: `field:${collection}.${c.column_name}`,
            title: `${collection}.${c.column_name} is on no layout and empty on every record`,
            severity: 'info',
            href: `/data-model/${collection}`,
            detail: {
              reason: `No layout shows it and none of the ${rows.toLocaleString('en-US')} records holds a value. Check what references it in the Table Editor before dropping it.`,
              fix: null,
              data: { collection, field: c.column_name, rows }
            }
          })
        }
      })
    }
  }
  return out.slice(0, 80)
}

const REACHABLE_TYPES = new Set(['grouped', 'table', 'detail', 'summary'])

/**
 * Layouts nobody can open: not active for their type, no slug (so no queue,
 * link or menu can pin them), no role or record conditions, and no grid,
 * drill, form or PDF slot pointing at them by id.
 */
async function unreachableLayoutFindings(): Promise<ReviewFinding[]> {
  const layouts = (await db('nivaro_collection_layouts').select(
    'id',
    'collection',
    'name',
    'is_active',
    'slug',
    'conditions',
    'layout_type',
    'addendum_layout_id'
  )) as Array<{
    id: number
    collection: string
    name: string
    is_active: boolean | number | null
    slug: string | null
    conditions: string | null
    layout_type: string | null
    addendum_layout_id: number | null
  }>
  const candidates = layouts.filter(
    (l) =>
      !isTrue(l.is_active) &&
      !l.slug?.trim() &&
      !(l.conditions?.trim() && l.conditions.trim() !== '{}') &&
      REACHABLE_TYPES.has(l.layout_type ?? 'grouped')
  )
  if (candidates.length === 0) return []
  // Every config text that can name a layout id, read once.
  const texts: string[] = []
  const pull = async (table: string, cols: string[]) => {
    const rows = await safe(
      () =>
        db(table)
          .select(cols)
          .where((qb) => {
            for (const c of cols) qb.orWhere(c, 'like', '%layout%')
          }) as Promise<Array<Record<string, unknown>>>,
      []
    )
    for (const r of rows) for (const c of cols) if (r[c]) texts.push(String(r[c]))
  }
  await pull('nivaro_layout_field_assignments', ['overrides', 'input_bindings'])
  await pull('nivaro_fields', ['options'])
  await pull('nivaro_queues', ['display_config'])
  await pull('nivaro_queue_sources', ['drilldown'])
  await pull('nivaro_widgets', ['config'])
  await pull('nivaro_collections', ['browser_config'])
  const blob = texts.join('\n')
  const addendumRefs = new Set(
    layouts.map((l) => Number(l.addendum_layout_id)).filter((n) => Number.isFinite(n) && n > 0)
  )
  const formRefs = new Set(
    (
      await safe(
        () =>
          db('nivaro_submission_forms').whereNotNull('layout_id').pluck('layout_id') as Promise<
            number[]
          >,
        []
      )
    ).map(Number)
  )
  const activeTypes = new Set(
    layouts
      .filter((l) => isTrue(l.is_active))
      .map((l) => `${l.collection}|${l.layout_type ?? 'grouped'}`)
  )
  const out: ReviewFinding[] = []
  for (const l of candidates) {
    const id = String(l.id)
    const named = new RegExp(`layout_id"?\\s*:\\s*"?${id}(?![0-9])`).test(blob)
    if (named || addendumRefs.has(l.id) || formRefs.has(l.id)) continue
    const type = l.layout_type ?? 'grouped'
    out.push({
      family: 'review',
      code: 'layout-unreachable',
      subject: `layout:${l.id}`,
      title: `Layout "${l.name}" on ${l.collection} cannot be opened`,
      severity: 'info',
      href: `/data-model/${l.collection}?tab=groups`,
      detail: {
        reason: `It is not the active ${type} layout${activeTypes.has(`${l.collection}|${type}`) ? '' : ' (none is)'}, has no slug for a queue or link to pin it, no role conditions, and no grid, drill, form or PDF slot names it — nobody sees it.`,
        fix: null,
        data: { layout: l.id, collection: l.collection }
      }
    })
  }
  return out
}

/** Owner groups whose every member has left: the cell resolves nobody. */
async function inactiveOwnerGroupFindings(): Promise<ReviewFinding[]> {
  const rows = (await db('nivaro_pipeline_owner_group_users as gu')
    .join('nivaro_users as u', 'u.id', 'gu.user')
    .join('nivaro_pipeline_owner_groups as g', 'g.id', 'gu.group')
    .select(
      'g.id as group_id',
      'g.name as group_name',
      'g.template',
      'u.status',
      'u.is_redacted'
    )) as Array<{
    group_id: string
    group_name: string | null
    template: string
    status: string | null
    is_redacted: boolean | number | null
  }>
  const teamLinked = new Set(
    (
      await safe(
        () =>
          db('nivaro_pipeline_owner_group_teams').distinct('group') as Promise<
            Array<{ group: string }>
          >,
        []
      )
    ).map((r) => String(r.group).toUpperCase())
  )
  const byGroup = new Map<
    string,
    { name: string | null; template: string; total: number; inactive: number }
  >()
  for (const r of rows) {
    const k = String(r.group_id).toUpperCase()
    const g = byGroup.get(k) ?? { name: r.group_name, template: r.template, total: 0, inactive: 0 }
    g.total++
    if (r.status !== 'active' || isTrue(r.is_redacted)) g.inactive++
    byGroup.set(k, g)
  }
  const templates = new Map(
    (
      (await db('nivaro_workflow_templates').select('id', 'name')) as Array<{
        id: string
        name: string
      }>
    ).map((t) => [String(t.id).toUpperCase(), t.name])
  )
  const out: ReviewFinding[] = []
  for (const [id, g] of byGroup) {
    if (g.total === 0 || g.inactive < g.total || teamLinked.has(id)) continue
    out.push({
      family: 'review',
      code: 'owner-group-inactive',
      subject: `owner-group:${id}`,
      title: `Owner group "${g.name ?? id}" on ${templates.get(String(g.template).toUpperCase()) ?? 'a pipeline'} has only inactive members`,
      severity: 'warning',
      href: `/pipelines/${g.template}`,
      detail: {
        reason: `All ${g.total} member(s) are suspended or redacted and no team is linked, so records this cell covers have nobody who can act. Pick replacements in the owner matrix.`,
        fix: null,
        data: { group: id, members: g.total }
      }
    })
  }
  return out.slice(0, 60)
}

/** The other deterministic checks, folded in so the report is one list. */
async function mirroredFindings(): Promise<ReviewFinding[]> {
  const out: ReviewFinding[] = []
  await safe(async () => {
    const { lintOwnerFilters } = await import('../owner-filter-lint.js')
    const { findings } = await lintOwnerFilters()
    for (const f of findings.slice(0, 20)) {
      out.push({
        family: 'review',
        code: 'owner-filter',
        subject: `owner-group:${f.group_id}`,
        title: `Owner group "${f.group_name ?? f.group_id}" has a filter that cannot match`,
        severity: 'warning',
        href: `/pipelines/${f.template}`,
        detail: { reason: f.detail, fix: null }
      })
    }
  }, undefined)
  await safe(async () => {
    const { lintTemplate } = await import('../pipeline-lint.js')
    const templates = (await db('nivaro_workflow_templates').select('id', 'name')) as Array<{
      id: string
      name: string
    }>
    for (const t of templates) {
      const [states, transitions] = await Promise.all([
        db('nivaro_workflow_states')
          .where({ template: t.id })
          .select('id', 'key', 'label', 'is_initial', 'is_terminal', 'sort'),
        db('nivaro_workflow_transitions')
          .where({ template: t.id })
          .select('id', 'from_state', 'to_state', 'label', 'condition_rules', 'auto_trigger')
      ])
      const res = lintTemplate(states, transitions)
      for (const f of res.findings.filter((x) => x.severity === 'warn').slice(0, 10)) {
        out.push({
          family: 'review',
          code: 'pipeline-lint',
          subject: `pipeline:${t.id}:${f.code}:${f.transition_id ?? f.state_id ?? ''}`,
          title: `${t.name}: ${f.message}`.slice(0, 380),
          severity: 'warning',
          href: `/pipelines/${t.id}`,
          detail: { reason: f.message, fix: null }
        })
      }
    }
  }, undefined)
  await safe(async () => {
    const { DEAD_COLUMNS } = await import('../../db/dead-columns.js')
    for (const d of DEAD_COLUMNS) {
      if (d.status !== 'drop') continue
      const present = await db.schema.hasColumn(d.table, d.column).catch(() => false)
      if (!present) continue
      out.push({
        family: 'review',
        code: 'dead-column',
        subject: `column:${d.table}.${d.column}`,
        title: `${d.table}.${d.column} is retired but still present`,
        severity: 'info',
        href: '/db-health',
        detail: {
          reason: `Replaced by ${d.replaced_by} since ${d.since}; nothing reads it any more.`,
          fix: null
        }
      })
    }
  }, undefined)
  return out
}

export async function reviewFindings(): Promise<ReviewFinding[]> {
  const parts = await Promise.all([
    safe(ruleConflictFindings, []),
    safe(duplicateViewFindings, []),
    safe(emptyFieldFindings, []),
    safe(unreachableLayoutFindings, []),
    safe(inactiveOwnerGroupFindings, []),
    safe(mirroredFindings, [])
  ])
  return parts.flat()
}

// ─── #2020 Cleanup suggestions ───────────────────────────────────────────────

export type CleanupOptions = Partial<CleanupThresholds>

export { CLEANUP_DEFAULTS }

/** Files younger than this are never offered — an upload may still be in flight. */
export const FILE_MIN_AGE_DAYS = 30

/** The thresholds a run uses: valid values from `opts`, the rest from `base`. */
export function cleanupCutoffs(
  opts: CleanupOptions = {},
  base: CleanupThresholds = CLEANUP_DEFAULTS
): CleanupThresholds {
  return normalizeCleanup(opts, base)
}

/** When saved-view opens started being recorded (null = never). */
export async function viewTrackingSince(): Promise<Date | null> {
  const row = (await db('nivaro_activity')
    .where('action', 'saved-view-open')
    .min({ m: 'timestamp' })
    .first()) as { m: Date | null } | undefined
  return row?.m ? new Date(row.m) : null
}

/**
 * File ids named anywhere a foreign key does not cover (upper-cased) — see
 * fileRefSources for the list. Fails CLOSED: a source that cannot be read
 * throws, so the caller reports nothing rather than calling a file nobody
 * could check an orphan. The values are read and matched in JS — a LIKE per
 * file in SQL ran past five minutes on dev.
 */
async function textReferencedFileIds(): Promise<Set<string>> {
  const { getFileRefColumns } = await import('../file-usage.js')
  const [fkRefs, relations, fields] = await Promise.all([
    getFileRefColumns(),
    db('nivaro_relations').select(
      'many_collection',
      'many_field',
      'one_collection',
      'one_field',
      'junction_field'
    ) as Promise<FileRefMeta['relations']>,
    db('nivaro_fields').select('collection', 'field', 'interface', 'special') as Promise<
      FileRefMeta['fields']
    >
  ])
  const tables = fileRefTables({ relations, fields })
  const columns: FileRefMeta['columns'] = []
  for (let i = 0; i < tables.length; i += 500) {
    const rows = (await db('information_schema.columns')
      .whereIn('table_name', tables.slice(i, i + 500))
      .select('table_name', 'column_name', 'data_type')) as Array<{
      table_name: string
      column_name: string
      data_type: string
    }>
    for (const r of rows)
      columns.push({ table: r.table_name, column: r.column_name, data_type: r.data_type })
  }
  const fileUuids = (await db('information_schema.columns')
    .where('data_type', 'uniqueidentifier')
    .where('column_name', 'like', '%file%')
    .select('table_name', 'column_name', 'data_type')) as Array<{
    table_name: string
    column_name: string
    data_type: string
  }>
  for (const r of fileUuids)
    columns.push({ table: r.table_name, column: r.column_name, data_type: r.data_type })

  const ids = new Set<string>()
  for (const src of fileRefSources({ fkRefs, relations, fields, columns })) {
    if (!IDENT.test(src.table) || !IDENT.test(src.column)) continue
    const col = `CAST([${src.column}] AS nvarchar(max))`
    const urlOnly = src.urlOnly
      ? ` AND ([${src.column}] LIKE '%files/%' OR [${src.column}] LIKE '%assets/%')`
      : ''
    const rows = (await db.raw(
      `SELECT ${src.mode === 'id' ? 'DISTINCT ' : ''}${col} AS v FROM [${src.table}]
        WHERE [${src.column}] IS NOT NULL${urlOnly}`
    )) as Array<{ v: string | null }>
    for (const row of rows) extractFileIds(row.v, ids)
  }
  return ids
}

export interface OrphanFile {
  id: string
  filename_download: string | null
  filesize: number | null
  uploaded_on: Date
}

/**
 * Files nothing references and older than `cutoff`, oldest first: no foreign
 * key points at them (SQL) and no FK-less column names them (JS). Shared by
 * the cleanup finding and its fix.
 */
export async function orphanFiles(cutoff: Date): Promise<OrphanFile[]> {
  const { getFileRefColumns } = await import('../file-usage.js')
  const refs = await getFileRefColumns()
  const notExists = refs
    .map((r) => `NOT EXISTS (SELECT 1 FROM [${r.table}] t WHERE t.[${r.column}] = f.id)`)
    .join(' AND ')
  // One anti-join per foreign key over every file: ~14 s on dev's 142k files,
  // past knex's 15 s default — so it runs on its own timeout. The cutoff is a
  // Date we made, inlined as an ISO literal (runLongSql takes no bindings).
  const { runLongSql } = await import('../run-long.js')
  const rows = await runLongSql<OrphanFile>(
    `SELECT f.id, f.filename_download, f.filesize, f.uploaded_on FROM nivaro_files f
      WHERE ${refs.length > 0 ? `${notExists} AND ` : ''}f.uploaded_on < '${cutoff.toISOString().slice(0, 19)}'
      ORDER BY f.uploaded_on ASC`,
    { timeoutMs: 120_000 }
  )
  if (rows.length === 0) return rows
  return dropReferenced(rows, await textReferencedFileIds())
}

export async function cleanupFindings(
  opts: CleanupOptions = {},
  base: CleanupThresholds = CLEANUP_DEFAULTS
): Promise<ReviewFinding[]> {
  const cut = cleanupCutoffs(opts, base)
  const out: ReviewFinding[] = []

  await safe(async () => {
    const cutoff = ago(cut.draftMonths * 30)
    const row = (await db('nivaro_drafts')
      .where('saved_at', '<', cutoff)
      .select(db.raw('COUNT(*) AS c, SUM(CAST(DATALENGTH(payload) AS BIGINT)) AS b'))
      .first()) as { c: number; b: number | null } | undefined
    const count = Number(row?.c ?? 0)
    if (count > 0) {
      out.push({
        family: 'cleanup',
        code: 'drafts-stale',
        subject: 'drafts',
        title: `${count} unsaved draft(s) older than ${cut.draftMonths} months`,
        severity: 'info',
        detail: {
          reason: `Form drafts are kept until their record is saved or discarded; these have not been touched in ${cut.draftMonths} months, so their owners have moved on.`,
          impact: { count, bytes: Number(row?.b ?? 0) },
          fix: { kind: 'drafts-delete', label: 'Delete these drafts', undoable: true },
          data: { cutoff: cutoff.toISOString(), months: cut.draftMonths }
        }
      })
    }
  }, undefined)

  await safe(async () => {
    const cutoff = ago(cut.taskMonths * 30)
    const row = (await db('nivaro_tasks')
      .whereIn('status', ['open', 'in_progress'])
      .where((qb) => qb.whereNot('kind', 'support').orWhereNull('kind'))
      .whereRaw('COALESCE(updated_at, created_at) < ?', [cutoff])
      .count({ c: '*' })
      .first()) as { c: number } | undefined
    const count = Number(row?.c ?? 0)
    if (count > 0) {
      out.push({
        family: 'cleanup',
        code: 'tasks-idle',
        subject: 'tasks',
        title: `${count} open task(s) untouched for ${cut.taskMonths} months`,
        severity: 'info',
        href: '/tasks',
        detail: {
          reason: `Nobody has updated these tasks in ${cut.taskMonths} months; they keep counting against people's open work. Support requests are left out.`,
          impact: {
            count,
            text: 'They are marked cancelled with a history line; undo reopens them.'
          },
          fix: { kind: 'tasks-cancel', label: 'Cancel these tasks', undoable: true },
          data: { cutoff: cutoff.toISOString(), months: cut.taskMonths }
        }
      })
    }
  }, undefined)

  await safe(async () => {
    const cutoff = ago(FILE_MIN_AGE_DAYS)
    const files = await orphanFiles(cutoff)
    const count = files.length
    const bytes = files.reduce((sum, f) => sum + Number(f.filesize ?? 0), 0)
    if (count > 0) {
      out.push({
        family: 'cleanup',
        code: 'files-orphan',
        subject: 'files',
        title: `${count} file(s) nothing references`,
        severity: 'info',
        href: '/files',
        detail: {
          reason: `No foreign key, file field, attachment list, configuration text or rich-text field names these files, and they are over ${FILE_MIN_AGE_DAYS} days old. Listed for review only — the config review never deletes files; check each in Files before removing it there.`,
          impact: { count, bytes },
          fix: null,
          data: {
            cutoff: cutoff.toISOString(),
            // The largest first: where the storage is.
            files: [...files]
              .sort((a, b) => Number(b.filesize ?? 0) - Number(a.filesize ?? 0))
              .slice(0, 200)
              .map((f) => ({
                id: f.id,
                name: f.filename_download,
                bytes: Number(f.filesize ?? 0),
                uploaded_on: f.uploaded_on
              }))
          }
        }
      })
    }
  }, undefined)

  await safe(async () => {
    const since = await viewTrackingSince()
    // Only judge once opens have been recorded for the whole window — before
    // that every view would look unopened.
    if (!since || since > ago(cut.viewDays)) return
    const opened = new Set(
      (
        (await db('nivaro_activity')
          .where('action', 'saved-view-open')
          .where('timestamp', '>=', ago(cut.viewDays))
          .distinct('item')) as Array<{ item: string | null }>
      ).map((r) => String(r.item ?? ''))
    )
    const subscribed = new Set(
      (
        await safe(
          () =>
            db('nivaro_view_subscriptions').distinct('view_id') as Promise<
              Array<{ view_id: number }>
            >,
          []
        )
      ).map((r) => Number(r.view_id))
    )
    const views = (await db('nivaro_saved_views')
      .where('created_at', '<', ago(cut.viewDays))
      .where((qb) => qb.where('is_default', false).orWhereNull('is_default'))
      .whereNull('default_for_role')
      .select('id', 'name', 'collection')) as Array<{
      id: number
      name: string
      collection: string
    }>
    const stale = views.filter((v) => !opened.has(String(v.id)) && !subscribed.has(Number(v.id)))
    if (stale.length > 0) {
      out.push({
        family: 'cleanup',
        code: 'views-unopened',
        subject: 'saved-views',
        title: `${stale.length} saved view(s) nobody opened in ${cut.viewDays} days`,
        severity: 'info',
        detail: {
          reason: `Opens are recorded since ${since.toISOString().slice(0, 10)}; these views were not opened once in the last ${cut.viewDays} days. Default and subscribed views are left out.`,
          impact: { count: stale.length },
          fix: { kind: 'views-delete', label: 'Delete these views', undoable: true },
          data: {
            days: cut.viewDays,
            views: stale
              .slice(0, 200)
              .map((v) => ({ id: v.id, name: v.name, collection: v.collection }))
          }
        }
      })
    }
  }, undefined)

  return out
}

// ─── #1999 Label consistency ─────────────────────────────────────────────────

/** Every place a label names a field, read once. */
export async function collectLabelOccurrences(): Promise<LabelOccurrence[]> {
  const occ: LabelOccurrence[] = []

  await safe(async () => {
    const fields = (await db('nivaro_fields')
      .whereNotNull('label')
      .whereNot('collection', 'like', 'nivaro_%')
      .select('id', 'collection', 'field', 'label')) as Array<{
      id: number
      collection: string
      field: string
      label: string
    }>
    for (const f of fields) {
      occ.push({
        source: 'field',
        ref: f.id,
        path: 'label',
        field: f.field,
        label: f.label,
        where: `${f.collection} field label`,
        href: `/data-model/${f.collection}`
      })
    }
  }, undefined)

  await safe(async () => {
    const rows = (await db('nivaro_layout_field_assignments as a')
      .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
      .where((qb) =>
        qb.whereNotNull('a.label_override').orWhere('a.overrides', 'like', '%"label"%')
      )
      .whereNot('l.collection', 'like', 'nivaro_%')
      .select(
        'a.id',
        'a.field',
        'a.label_override',
        'a.overrides',
        'l.id as layout_id',
        'l.name as layout_name',
        'l.collection'
      )) as Array<{
      id: number
      field: string
      label_override: string | null
      overrides: string | null
      layout_id: number
      layout_name: string
      collection: string
    }>
    for (const r of rows) {
      if (r.field.startsWith('__')) continue
      const where = `Layout "${r.layout_name}" · ${r.collection}`
      const href = `/data-model/${r.collection}?tab=groups`
      if (r.label_override?.trim()) {
        occ.push({
          source: 'layout',
          ref: r.id,
          path: 'label_override',
          field: leafOf(r.field),
          label: r.label_override,
          where,
          href
        })
      }
      try {
        const o = r.overrides ? (JSON.parse(r.overrides) as { label?: unknown }) : null
        if (o && typeof o.label === 'string' && o.label.trim()) {
          occ.push({
            source: 'layout',
            ref: r.id,
            path: 'overrides.label',
            field: leafOf(r.field),
            label: o.label,
            where,
            href
          })
        }
      } catch {
        /* unreadable overrides — skip */
      }
    }
  }, undefined)

  await safe(async () => {
    const queues = (await db('nivaro_queues')
      .whereNotNull('column_aliases')
      .select('id', 'name', 'column_aliases')) as Array<{
      id: string
      name: string
      column_aliases: string
    }>
    for (const q of queues) {
      let aliases: Record<string, unknown> = {}
      try {
        aliases = JSON.parse(q.column_aliases) as Record<string, unknown>
      } catch {
        continue
      }
      for (const [key, label] of Object.entries(aliases)) {
        if (typeof label !== 'string' || !label.trim() || !key.startsWith('extra.')) continue
        occ.push({
          source: 'queue',
          ref: q.id,
          path: key,
          field: leafOf(key),
          label,
          where: `Queue "${q.name}"`,
          href: `/queues/${q.id}`
        })
      }
    }
  }, undefined)

  await safe(async () => {
    const views = (await db('nivaro_saved_views')
      .where('columns', 'like', '%"label"%')
      .select('id', 'name', 'collection', 'columns')) as Array<{
      id: number
      name: string
      collection: string
      columns: string
    }>
    for (const v of views) {
      let cols: unknown
      try {
        cols = JSON.parse(v.columns)
      } catch {
        continue
      }
      if (!Array.isArray(cols)) continue
      for (const c of cols) {
        if (!c || typeof c !== 'object') continue
        const { key, label } = c as { key?: unknown; label?: unknown }
        if (typeof key !== 'string' || typeof label !== 'string' || !label.trim()) continue
        occ.push({
          source: 'view',
          ref: v.id,
          path: key,
          field: leafOf(key),
          label,
          where: `Saved view "${v.name}" · ${v.collection}`,
          href: `/collections/${v.collection}`
        })
      }
    }
  }, undefined)

  await safe(async () => {
    const widgets = (await db('nivaro_report_widgets')
      .where('config', 'like', '%"label"%')
      .select('id', 'report', 'title', 'config')) as Array<{
      id: string
      report: string
      title: string | null
      config: string
    }>
    for (const w of widgets) {
      let cfg: unknown
      try {
        cfg = JSON.parse(w.config)
      } catch {
        continue
      }
      for (const hit of findFieldLabels(cfg)) {
        occ.push({
          source: 'report',
          ref: w.id,
          path: hit.pointer,
          field: leafOf(hit.field),
          label: hit.label,
          where: `Report widget "${w.title ?? 'Untitled'}"`,
          href: `/report-studio/${w.report}`
        })
      }
    }
  }, undefined)

  return occ
}

/** Objects carrying both `field` and `label` strings, with a JSON pointer to each. */
export function findFieldLabels(
  value: unknown,
  pointer = ''
): Array<{ pointer: string; field: string; label: string }> {
  const out: Array<{ pointer: string; field: string; label: string }> = []
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      out.push(...findFieldLabels(v, `${pointer}/${i}`))
    })
    return out
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.field === 'string' && typeof o.label === 'string' && o.label.trim()) {
      out.push({ pointer, field: o.field, label: o.label })
    }
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') out.push(...findFieldLabels(v, `${pointer}/${k}`))
    }
  }
  return out
}

export async function labelFindings(): Promise<ReviewFinding[]> {
  const concepts = groupLabelConcepts(await collectLabelOccurrences())
  return concepts.map((c) => ({
    family: 'label',
    code: 'label-inconsistent',
    subject: `label:${c.field}`,
    title:
      `${c.field} is labelled ${c.labels.length} ways: ${c.labels.map((l) => `"${l.label}"`).join(', ')}`.slice(
        0,
        390
      ),
    severity: 'info',
    detail: {
      reason: `The same field reads differently across ${c.occurrences.length} places, so people cannot tell they are looking at one thing. "${c.suggested}" is used most.`,
      impact: { count: c.occurrences.length },
      fix: { kind: 'label-rename', label: 'Use one label everywhere', undoable: true },
      data: {
        field: c.field,
        suggested: c.suggested,
        labels: c.labels,
        occurrences: c.occurrences.slice(0, 80)
      }
    }
  }))
}
