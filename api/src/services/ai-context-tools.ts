import { db } from '../db/index.js'
import type { User } from '../types.js'
import { FieldAccessError, readableFieldSet } from './ai-aggregate-guard.js'
import { can, getRowFilter } from './permissions.js'
import { getUserScopeEnforcement, isAdminRole } from './user-scopes.js'

/**
 * Executors for the context tools (#1837 report_data, #1856 config_lookup,
 * #1894 my_team). Every one re-checks its gate at call time — the system
 * prompt offering a tool is never permission. All three stay out of
 * REPLAYABLE_TOOLS (ai-conversations.ts): an answer that used one is never
 * shown to anyone but its author.
 */

type ToolOut = { result: unknown; summary: string; access_note?: string }

const NAME_RE = /^[A-Za-z0-9_]+$/
const DATE_PRESETS = new Set([
  'this_month',
  'last_30_days',
  'last_3_months',
  'last_6_months',
  'last_12_months',
  'ytd',
  'custom'
])
const MAX_WIDGETS = 20
const MAX_SERIES = 30
const MAX_ROWS = 10

const asAdmin = (user: User) =>
  isAdminRole((user as { role?: string | null }).role).catch(() => false)

const parse = <T>(v: unknown): T | null => {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

export async function executeContextTool(
  user: User,
  name: string,
  input: Record<string, unknown>
): Promise<ToolOut> {
  switch (name) {
    case 'report_data':
      return reportData(user, input)
    case 'config_lookup':
      return configLookup(user, input)
    case 'my_team':
      return myTeam(user, input)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ── #1837 report_data ────────────────────────────────────────────────────────

/** A date range from the model, or null (the report default). */
export function cleanDateRange(raw: unknown): Record<string, string> | null {
  const r = parse<Record<string, unknown>>(raw)
  if (!r || !DATE_PRESETS.has(String(r.preset))) return null
  const out: Record<string, string> = { preset: String(r.preset) }
  for (const k of ['start', 'end'] as const)
    if (typeof r[k] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r[k] as string))
      out[k] = (r[k] as string).slice(0, 10)
  if (out.preset === 'custom' && (!out.start || !out.end)) return null
  return out
}

/** Report filters from the model: plain column names, a few values each. */
export function cleanEntityFilters(
  raw: unknown
): Array<{ field: string; values: Array<string | number>; labels?: string[] }> {
  const list = parse<unknown[]>(raw)
  if (!Array.isArray(list)) return []
  return list
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      field: String(f.field ?? ''),
      values: (Array.isArray(f.values) ? f.values : [])
        .slice(0, 50)
        .map((v) => (typeof v === 'number' ? v : String(v).slice(0, 200))),
      ...(Array.isArray(f.labels)
        ? { labels: f.labels.slice(0, 50).map((l) => String(l).slice(0, 200)) }
        : {})
    }))
    .filter((f) => NAME_RE.test(f.field) && f.values.length > 0)
    .slice(0, 10)
}

async function reportData(user: User, input: Record<string, unknown>): Promise<ToolOut> {
  const reportId = String(input.report_id ?? '').trim()
  if (!reportId) throw new Error('report_id is required')
  const report = (await db('nivaro_report_defs').where({ id: reportId }).first()) as
    | {
        id: string
        name: string
        owner: string
        is_shared: unknown
        role_id: string | null
        global_filters: string | null
      }
    | undefined
  const admin = await asAdmin(user)
  const role = (user as { role?: string | null }).role ?? null
  const readable =
    !!report &&
    (admin ||
      String(report.owner).toUpperCase() === String(user.id).toUpperCase() ||
      (!!report.is_shared && (!report.role_id || report.role_id === role)))
  if (!report || !readable) throw new Error('No report with that id that you can open')

  const { parseJson, physicalColumns, resolveWidgetDataFull } = await import('./report-studio.js')
  const widgetId = input.widget_id != null ? String(input.widget_id) : null
  const rows = (await db('nivaro_report_widgets')
    .where({ report: report.id })
    .modify((q) => {
      if (widgetId) q.where({ id: widgetId })
    })
    .orderBy('sort')
    .select('id', 'type', 'title', 'collection', 'config')) as Array<{
    id: string
    type: string
    title: string | null
    collection: string | null
    config: string | null
  }>
  if (widgetId && rows.length === 0) throw new Error('No widget with that id on this report')
  // ai_insight widgets would call the model from inside a tool call — never.
  const widgets = rows.filter((w) => w.type !== 'divider' && w.type !== 'ai_insight')

  const dateRange =
    cleanDateRange(input.date_range) ??
    parseJson<{ date_range?: Record<string, string> }>(report.global_filters)?.date_range ??
    null
  const entityFilters = cleanEntityFilters(input.entity_filters)

  // A filter on a column the asker cannot read would turn the widget into an
  // oracle for it — refused, the same rule the aggregate tool follows.
  const collections = [...new Set(widgets.map((w) => w.collection).filter(Boolean))] as string[]
  const narrowed: string[] = []
  for (const c of collections) {
    if (!(await can(user, 'read', c).catch(() => false))) continue
    if (entityFilters.length) {
      const physical = await physicalColumns(c)
      const readableCols = await readableFieldSet(user, c, physical)
      for (const f of entityFilters)
        if (physical.has(f.field) && !readableCols.has(f.field))
          throw new FieldAccessError(`You do not have access to the field "${f.field}" on ${c}.`)
    }
    const [rls, scope] = await Promise.all([
      getRowFilter(user, 'read', c).catch(() => null),
      getUserScopeEnforcement(user, c).catch(() => null)
    ])
    if (rls || (scope && (scope.deny || scope.filters.length > 0))) narrowed.push(c)
  }

  const out: Array<Record<string, unknown>> = []
  for (const w of widgets.slice(0, widgetId ? 1 : MAX_WIDGETS)) {
    const cfg = parseJson<Record<string, unknown>>(w.config)
    const widget = { id: w.id, type: w.type, collection: w.collection, config: cfg as never }
    try {
      const data = await resolveWidgetDataFull(
        user,
        report.id,
        widget,
        dateRange as never,
        entityFilters
      )
      const entry: Record<string, unknown> = {
        widget_id: w.id,
        title: w.title || w.type,
        type: w.type,
        collection: w.collection,
        ...shapeWidgetData(data as Record<string, unknown>, widgetId ? 200 : MAX_SERIES)
      }
      if (widgetId) {
        try {
          const { buildTrendContext } = await import('./report-trend.js')
          const trend = await buildTrendContext(
            user,
            report.id,
            widget,
            dateRange as never,
            entityFilters
          )
          entry.movers = trend.movers.slice(0, 10)
          entry.windows = trend.windows.map((win) => ({
            label: win.label,
            value: win.value,
            rows: win.rows.slice(0, MAX_ROWS)
          }))
        } catch {
          // a single-point widget has no trend — its figures stand alone
        }
      }
      out.push(entry)
    } catch (err) {
      out.push({
        widget_id: w.id,
        title: w.title || w.type,
        error: err instanceof Error ? err.message.slice(0, 200) : 'failed'
      })
    }
  }
  const result: Record<string, unknown> = {
    report: { id: report.id, name: report.name },
    date_range: dateRange,
    entity_filters: entityFilters,
    widgets: out,
    ...(rows.length > MAX_WIDGETS && !widgetId
      ? { note: `Only the first ${MAX_WIDGETS} widgets were read.` }
      : {})
  }
  return {
    result: narrowed.length
      ? { ...result, access_note: `figures limited by your access on ${narrowed.join(', ')}` }
      : result,
    summary: `${report.name}: ${out.length} widget(s)${widgetId ? ' with movers' : ''}`
  }
}

/** A widget's figures, trimmed for the model. */
export function shapeWidgetData(
  data: Record<string, unknown>,
  seriesCap = MAX_SERIES
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ['value', 'prev_value', 'change_pct', 'row_count', 'narrative', 'waterfall'])
    if (data[k] != null) out[k] = data[k]
  const series = Array.isArray(data.series) ? (data.series as Array<Record<string, unknown>>) : []
  if (series.length) {
    out.series = series.slice(0, seriesCap).map((s) => ({
      dim: s.dim,
      value: s.value,
      ...(s.prev != null ? { prev: s.prev } : {}),
      ...(s.value2 != null ? { value2: s.value2 } : {})
    }))
    if (series.length > seriesCap)
      out.series_note = `${series.length - seriesCap} more points not shown`
  }
  if (Array.isArray(data.tiles)) out.tiles = data.tiles
  if (Array.isArray(data.rows)) out.rows = (data.rows as unknown[]).slice(0, MAX_ROWS)
  if (data.pivot && typeof data.pivot === 'object') {
    const p = data.pivot as Record<string, unknown>
    out.pivot = { row_totals: p.row_totals, col_totals: p.col_totals, grand_total: p.grand_total }
  }
  return out
}

// ── #1894 my_team ────────────────────────────────────────────────────────────

async function myTeam(user: User, input: Record<string, unknown>): Promise<ToolOut> {
  const view = String(input.view ?? 'workload')
  const team = await import('./team.js')
  // The team routes answer for the CALLER's own reports — the same rule here.
  if (!(await team.hasReports(String(user.id)))) {
    throw new Error(
      'You have no direct reports, so there is no team to describe. This answers only for a manager about their own reports.'
    )
  }
  const viewer = {
    id: String(user.id),
    isAdmin: await asAdmin(user),
    role: (user as { role?: string | null }).role ?? null
  }
  const note = 'only your direct reports; records you cannot open are counted, not named'
  switch (view) {
    case 'workload': {
      const { buildTeamLoad } = await import('./user-profile.js')
      const load = await buildTeamLoad(viewer.id, viewer)
      const people = load.reports.map((r) => ({
        name: r.name,
        out_of_office: r.out,
        delegate: r.delegate?.name ?? null,
        open: r.open,
        breached: r.breached,
        warning: r.warning,
        stuck: r.stuck,
        hidden_from_you: r.hidden,
        oldest_hours: r.oldest_hours,
        oldest: r.oldest.map((o) => ({
          collection: o.collection,
          id: o.item_id,
          label: o.label,
          state: o.state_label,
          sla: o.sla_status,
          aging_hours: o.aging_hours
        }))
      }))
      return {
        result: {
          people,
          stuck_after_hours: load.stuck_hours,
          truncated: load.truncated,
          access_note: note
        },
        summary: `${people.length} report(s): ${people.reduce((n, p) => n + p.open, 0)} open, ${people.reduce((n, p) => n + p.stuck, 0)} stuck`
      }
    }
    case 'tasks': {
      const t = await team.buildTeamTasks(viewer.id, viewer)
      return {
        result: {
          people: t.reports.map((r) => ({ ...r, tasks: r.tasks.slice(0, 10) })),
          tasks_on_records_you_cannot_open: t.hidden,
          access_note: note
        },
        summary: `${t.reports.reduce((n, r) => n + r.open, 0)} open task(s), ${t.reports.reduce((n, r) => n + r.overdue, 0)} overdue`
      }
    }
    case 'coverage': {
      const c = await team.buildTeamCoverage(viewer.id, viewer)
      return {
        result: {
          people: c.map((e) => ({
            name: e.user.name,
            currently_out: e.currently_out,
            ooo_start: e.ooo_start,
            ooo_end: e.ooo_end,
            covered_by: e.delegate?.name ?? null,
            open: e.open
          })),
          access_note: note
        },
        summary: `${c.length} out or about to be, ${c.filter((e) => !e.delegate).length} without cover`
      }
    }
    case 'week': {
      const w = await team.buildTeamWeek(viewer.id, viewer)
      return {
        result: { ...w, access_note: note },
        summary: `last 7 days: ${w.completions} completed, ${w.send_backs} sent back, ${w.new_breaches} new breaches`
      }
    }
    default:
      throw new Error('view must be workload, tasks, coverage or week')
  }
}

// ── #1856 config_lookup ──────────────────────────────────────────────────────

async function configLookup(user: User, input: Record<string, unknown>): Promise<ToolOut> {
  if (!(await asAdmin(user))) throw new Error('Configuration questions are for administrators only')
  const collection = String(input.collection ?? '')
  if (!NAME_RE.test(collection)) throw new Error('Invalid collection name')
  const field = input.field != null ? String(input.field) : ''
  const mode = String(input.mode ?? '')
  if ((mode === 'field_usage' || mode === 'field_lock') && !NAME_RE.test(field))
    throw new Error('field is required for this mode (a column name)')
  switch (mode) {
    case 'field_usage':
      return fieldUsage(collection, field)
    case 'field_lock':
      return fieldLock(collection, field)
    case 'owners':
      return owners(collection, input.state, input.values)
    case 'automations':
      return automations(collection)
    default:
      throw new Error('mode must be field_usage, field_lock, owners or automations')
  }
}

const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function fieldUsage(collection: string, field: string): Promise<ToolOut> {
  const { buildImpactReport } = await import('./schema-impact.js')
  const report = await buildImpactReport(collection, field)
  // Flows are outside the impact scan: a flow on this collection whose
  // operations name the field.
  const flows = await safe(
    async () =>
      (await db('nivaro_flows as f')
        .join('nivaro_flow_operations as o', 'o.flow', 'f.id')
        .where('f.trigger_options', 'like', `%${collection}%`)
        .where((b) => {
          void b
            .where('o.options', 'like', `%"${field}"%`)
            .orWhere('o.options', 'like', `%.${field}%`)
        })
        .distinct('f.name', 'f.status')
        .select()) as Array<{ name: string; status: string }>,
    []
  )
  const surfaces = report.surfaces.map((s) => ({
    surface: s.surface,
    count: s.hits.length,
    hits: s.hits.slice(0, 15)
  }))
  if (flows.length)
    surfaces.push({
      surface: 'flows',
      count: flows.length,
      hits: flows.slice(0, 15).map((f) => ({ surface: 'flows', ref: f.name, detail: f.status }))
    })
  const total = report.total + flows.length
  return {
    result: {
      collection,
      field,
      total,
      surfaces,
      note: 'Matching is by name inside stored configuration, so a common name can over-match — say so when a hit looks unrelated.'
    },
    summary: `${collection}.${field}: ${total} reference(s) in ${surfaces.length} place(s)`
  }
}

async function fieldLock(collection: string, field: string): Promise<ToolOut> {
  const reasons: Array<{ source: string; detail: string }> = []
  const meta = (await safe(
    () =>
      db('nivaro_fields')
        .where({ collection, field })
        .first('readonly', 'computed_type', 'computed_formula', 'interface', 'hidden'),
    undefined
  )) as Record<string, unknown> | undefined
  if (meta?.readonly) {
    const kind = meta.computed_type
      ? `calculated (${meta.computed_type}${meta.computed_formula ? `: ${meta.computed_formula}` : ''})`
      : meta.interface === 'relation-path'
        ? 'a value read from a related record'
        : 'marked read-only in the field settings'
    reasons.push({ source: 'field settings', detail: `Always read-only — ${kind}.` })
  }
  const roleNames = new Map(
    (
      (await safe(() => db('nivaro_roles').select('id', 'name'), [])) as Array<{
        id: string
        name: string
      }>
    ).map((r) => [String(r.id).toUpperCase(), r.name])
  )
  const roleList = (ids: unknown) =>
    (Array.isArray(ids) ? ids : [])
      .map((id) => roleNames.get(String(id).toUpperCase()) ?? String(id))
      .join(', ')
  const assignments = (await safe(
    () =>
      db('nivaro_layout_field_assignments as a')
        .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
        .where('l.collection', collection)
        .where('a.field', field)
        .select(
          'l.name as layout',
          'a.lock_conditions',
          'a.overrides',
          'a.group_key',
          'a.layout_id'
        ),
    []
  )) as Array<{
    layout: string
    lock_conditions: string | null
    overrides: string | null
    group_key: string | null
    layout_id: number
  }>
  for (const a of assignments) {
    const conds = parse<Array<Record<string, unknown>>>(a.lock_conditions) ?? []
    for (const c of Array.isArray(conds) ? conds : []) {
      if (c.type === 'pipeline_state')
        reasons.push({
          source: `layout "${a.layout}"`,
          detail: `Locked while the record is in: ${(Array.isArray(c.state_keys) ? c.state_keys : []).join(', ')}.`
        })
      else if (c.type === 'role')
        reasons.push({
          source: `layout "${a.layout}"`,
          detail: `Locked for roles: ${roleList(c.role_ids)}.`
        })
      else
        reasons.push({
          source: `layout "${a.layout}"`,
          detail: `Lock condition ${JSON.stringify(c)}.`
        })
    }
    const ov = parse<Record<string, unknown>>(a.overrides)
    if (ov?.readonly === true)
      reasons.push({ source: `layout "${a.layout}"`, detail: 'Read-only on this layout.' })
    if (a.group_key) {
      const group = (await safe(
        () =>
          db('nivaro_field_groups')
            .where({ layout_id: a.layout_id, key: a.group_key })
            .first('label', 'locked_for_roles'),
        undefined
      )) as { label?: string | null; locked_for_roles?: string | null } | undefined
      const roles = parse<unknown[]>(group?.locked_for_roles)
      if (Array.isArray(roles) && roles.length)
        reasons.push({
          source: `layout "${a.layout}"`,
          detail: `Its section "${group?.label ?? a.group_key}" is locked for roles: ${roleList(roles)}.`
        })
    }
  }
  const lockRules = (await safe(
    () =>
      db('nivaro_field_rules')
        .where({ collection, target_field: field, target_type: 'lock' })
        .select('trigger_field', 'trigger_op', 'trigger_value', 'is_active'),
    []
  )) as Array<Record<string, unknown>>
  for (const r of lockRules)
    reasons.push({
      source: 'field rule',
      detail: `Locked when ${r.trigger_field} ${r.trigger_op ?? 'eq'} ${r.trigger_value ?? ''}${r.is_active === false || r.is_active === 0 ? ' (rule is off)' : ''}.`
    })
  const lockingStates = (await safe(
    () =>
      db('nivaro_workflow_states as s')
        .join('nivaro_workflow_bindings as b', 'b.template', 's.template')
        .where('b.collection', collection)
        .where('s.lock_record', true)
        .select('s.key', 's.label'),
    []
  )) as Array<{ key: string; label: string | null }>
  if (lockingStates.length)
    reasons.push({
      source: 'pipeline',
      detail: `The whole record locks in: ${lockingStates.map((s) => s.label || s.key).join(', ')}.`
    })
  return {
    result: {
      collection,
      field,
      reasons,
      also: 'A role without update access to the field also sees it read-only — explain_person_access answers that for one person. Someone else editing the record locks it until they leave.'
    },
    summary: `${collection}.${field}: ${reasons.length} lock setting(s)`
  }
}

async function owners(collection: string, stateRaw: unknown, valuesRaw: unknown): Promise<ToolOut> {
  const bindings = (await db('nivaro_workflow_bindings')
    .join('nivaro_workflow_templates as t', 't.id', 'nivaro_workflow_bindings.template')
    .where('nivaro_workflow_bindings.collection', collection)
    .select(
      'nivaro_workflow_bindings.id as binding',
      'nivaro_workflow_bindings.template',
      't.name as template_name'
    )) as Array<{ binding: string | number; template: string; template_name: string }>
  const chains = await safe(
    async () => {
      const list = (await db('nivaro_approval_chains')
        .where({ collection })
        .select('id', 'name')) as Array<{ id: string | number; name: string }>
      const out: Array<Record<string, unknown>> = []
      for (const c of list.slice(0, 10)) {
        const steps = (await db('nivaro_approval_steps as s')
          .leftJoin('nivaro_users as u', 'u.id', 's.approver')
          .leftJoin('nivaro_roles as r', 'r.id', 's.approver_role')
          .where('s.chain', c.id)
          .orderBy('s.step_order')
          .select('s.*', 'u.first_name', 'u.last_name', 'r.name as role_name')) as Array<
          Record<string, unknown>
        >
        out.push({
          chain: c.name,
          steps: steps.map((s) => ({
            step: s.step_order,
            ...(s.name ? { name: s.name } : {}),
            approver: s.approver ? [s.first_name, s.last_name].filter(Boolean).join(' ') : null,
            role: s.role_name ?? null,
            ...(s.conditions ? { conditions: parse(s.conditions) } : {})
          }))
        })
      }
      return out
    },
    [] as Array<Record<string, unknown>>
  )
  if (bindings.length === 0)
    return {
      result: { collection, pipelines: [], approval_chains: chains },
      summary: `${collection}: no pipeline bound${chains.length ? `, ${chains.length} approval chain(s)` : ''}`
    }

  const want = typeof stateRaw === 'string' ? stateRaw.trim().toLowerCase() : ''
  const values = parse<Record<string, unknown>>(valuesRaw) ?? {}
  const pe = await import('./pipeline-engine.js')
  const pipelines: Array<Record<string, unknown>> = []
  for (const b of bindings) {
    const [states, dims] = await Promise.all([
      db('nivaro_workflow_states')
        .where({ template: b.template })
        .orderBy('sort')
        .select('id', 'key', 'label', 'lock_record') as Promise<
        Array<{ id: string; key: string; label: string | null; lock_record: unknown }>
      >,
      safe(
        () =>
          db('nivaro_pipeline_owner_dimensions')
            .where({ binding: b.binding })
            .orderBy('sort')
            .select('field', 'label', 'required'),
        [] as Array<{ field: string; label: string; required: unknown }>
      )
    ])
    // Values may be keyed by a dimension's label or field, or a group filter's field.
    const valueFor = ownerValueLookup(values, dims)
    const given = Object.keys(values).length > 0
    const picked = want
      ? states.filter(
          (s) => s.key.toLowerCase() === want || String(s.label ?? '').toLowerCase() === want
        )
      : []
    const entry: Record<string, unknown> = {
      pipeline: b.template_name,
      dimensions: dims.map((d) => ({ field: d.field, label: d.label, required: !!d.required })),
      states: states.map((s) => ({ key: s.key, label: s.label, locks_record: !!s.lock_record }))
    }
    if (want && picked.length === 0) entry.note = `No state "${stateRaw}" in this pipeline.`
    if (picked.length) {
      const groups = await pe.getOwnerGroupsForStates(
        picked.map((s) => s.id),
        db
      )
      const out: Array<Record<string, unknown>> = []
      for (const s of picked) {
        const g = groups.get(s.id)
        if (!g) continue
        const transitions = await safe(
          () =>
            db('nivaro_workflow_transitions')
              .where({ template: b.template })
              .where((w) => w.where('from_state', s.id).orWhereNull('from_state'))
              .select('label', 'required_roles'),
          [] as Array<{ label: string; required_roles: string | null }>
        )
        const roleIds = new Set<string>()
        for (const t of transitions)
          for (const r of (parse<unknown[]>(t.required_roles) ?? []) as unknown[])
            roleIds.add(String(r))
        const roleNames = roleIds.size
          ? new Map(
              (
                (await db('nivaro_roles')
                  .whereIn('id', [...roleIds])
                  .select('id', 'name')) as Array<{
                  id: string
                  name: string
                }>
              ).map((r) => [String(r.id).toUpperCase(), r.name])
            )
          : new Map<string, string>()
        const match = given ? matchOwnerGroups(g.groups, valueFor) : null
        const shown = match ? match.groups : g.groups.slice(0, 25)
        const people = await usersOfGroups(shown.map((x) => x.id))
        out.push({
          state: s.label || s.key,
          owner_groups_total: g.groups.length,
          ...(match
            ? { matched_for: values, match: match.kind, note: match.note }
            : g.groups.length > shown.length
              ? {
                  note: `First ${shown.length} of ${g.groups.length} groups — give values to see the one that wins.`
                }
              : {}),
          groups: shown.map((x) => ({
            name: x.name,
            default: !!x.is_default,
            priority: x.priority,
            filters: parse(x.filters),
            people: people.get(String(x.id).toUpperCase()) ?? []
          })),
          transitions: transitions.map((t) => ({
            label: t.label,
            roles: ((parse<unknown[]>(t.required_roles) ?? []) as unknown[]).map(
              (r) => roleNames.get(String(r).toUpperCase()) ?? String(r)
            )
          }))
        })
      }
      entry.owners = out
    }
    pipelines.push(entry)
  }
  return {
    result: {
      collection,
      pipelines,
      approval_chains: chains,
      ...(want ? {} : { note: 'Give state (and values) to see the owner groups and their people.' })
    },
    summary: `${collection}: ${pipelines.length} pipeline(s)${want ? ` · state ${stateRaw}` : ''}`
  }
}

type OwnerGroupRow = {
  id: string
  name: string | null
  filters: string | null
  is_default: unknown
  priority: number
}

/** The value given for a filter field: by field, by a dimension's field or label. */
export function ownerValueLookup(
  values: Record<string, unknown>,
  dims: Array<{ field: string; label: string | null }>
): (field: string) => unknown {
  const byKey = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]))
  return (field) => {
    const direct = byKey.get(field.toLowerCase())
    if (direct !== undefined) return direct
    const dim = dims.find(
      (d) => d.field === field || d.field.endsWith(`.${field}`) || field.endsWith(`.${d.field}`)
    )
    if (!dim) return undefined
    return byKey.get(dim.field.toLowerCase()) ?? byKey.get(String(dim.label ?? '').toLowerCase())
  }
}

/**
 * Owner groups against the values a person gave. The matrix stores display
 * values beside ids, so "Zone 3" and 3 both match an eq filter; ordering ops
 * compare numbers. `exact` = every filter of the group is answered and true
 * (the winner is the most specific, then the lowest priority — the engine's
 * own rule); otherwise `partial` lists the groups nothing given contradicts.
 */
export function matchOwnerGroups(
  groups: OwnerGroupRow[],
  valueFor: (field: string) => unknown
): { kind: 'exact' | 'partial' | 'default' | 'none'; groups: OwnerGroupRow[]; note: string } {
  const same = (a: unknown, b: unknown) =>
    a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
  const test = (f: { field: string; op: string; value?: unknown; id_value?: unknown }) => {
    const v = valueFor(f.field)
    if (v === undefined) return null
    if (f.op === 'eq' || f.op === 'neq') {
      const hit = same(v, f.value) || (f.id_value != null && same(v, f.id_value))
      return f.op === 'eq' ? hit : !hit
    }
    if (f.op === 'in' || f.op === 'notin') {
      const list = String(f.value ?? '')
        .split(',')
        .map((x) => x.trim())
      const hit = list.some((x) => same(v, x))
      return f.op === 'in' ? hit : !hit
    }
    const a = Number(v)
    const b = Number(f.value)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
    return f.op === 'gt' ? a > b : f.op === 'gte' ? a >= b : f.op === 'lt' ? a < b : a <= b
  }
  const exact: Array<{ g: OwnerGroupRow; n: number }> = []
  const partial: OwnerGroupRow[] = []
  const defaults: OwnerGroupRow[] = []
  for (const g of groups) {
    if (g.is_default === true || g.is_default === 1) {
      defaults.push(g)
      continue
    }
    const filters = (parse<Array<Record<string, unknown>>>(g.filters) ?? []) as Array<{
      field: string
      op: string
      value?: unknown
      id_value?: unknown
    }>
    if (!Array.isArray(filters) || filters.length === 0) continue
    const results = filters.map(test)
    if (results.some((r) => r === false)) continue
    if (results.every((r) => r === true)) exact.push({ g, n: filters.length })
    else if (results.some((r) => r === true)) partial.push(g)
  }
  if (exact.length) {
    exact.sort((a, b) => b.n - a.n || (a.g.priority ?? 0) - (b.g.priority ?? 0))
    return { kind: 'exact', groups: [exact[0].g], note: 'The most specific matching group wins.' }
  }
  if (partial.length)
    return {
      kind: 'partial',
      groups: partial.slice(0, 25),
      note: `No group is fully decided by these values; ${partial.length} group(s) fit what was given — name the other dimensions to find the one that wins.`
    }
  if (defaults.length)
    return {
      kind: 'default',
      groups: defaults,
      note: 'No group matches; the state default applies.'
    }
  return { kind: 'none', groups: [], note: 'No group matches these values.' }
}

async function usersOfGroups(groupIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (groupIds.length === 0) return out
  const rows = (await safe(
    () =>
      db('nivaro_pipeline_owner_group_users as gu')
        .join('nivaro_users as u', 'u.id', 'gu.user')
        .whereIn('gu.group', groupIds)
        .select('gu.group', 'u.first_name', 'u.last_name', 'u.email'),
    []
  )) as Array<{
    group: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  for (const r of rows) {
    const k = String(r.group).toUpperCase()
    const list = out.get(k) ?? []
    list.push([r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || '')
    out.set(k, list)
  }
  return out
}

async function automations(collection: string): Promise<ToolOut> {
  const like = `%"${collection}"%`
  const [rules, flows, webhooks, alerts, watches, sla] = await Promise.all([
    safe(
      () => db('nivaro_rules').where({ collection }).select('name', 'enabled'),
      [] as Array<Record<string, unknown>>
    ),
    safe(
      () =>
        db('nivaro_flows')
          .where('trigger_options', 'like', like)
          .orWhere('trigger_options', 'like', `%${collection}%`)
          .select('name', 'status', 'trigger'),
      [] as Array<Record<string, unknown>>
    ),
    safe(
      () =>
        db('nivaro_webhooks')
          .where('collections', 'like', like)
          .select('name', 'enabled', 'events'),
      [] as Array<Record<string, unknown>>
    ),
    safe(
      () =>
        db('nivaro_alert_definitions').where({ collection }).select('name', 'field', 'is_active'),
      [] as Array<Record<string, unknown>>
    ),
    safe(
      () => db('nivaro_field_watches').where({ collection }).select('name', 'field'),
      [] as Array<Record<string, unknown>>
    ),
    safe(
      () =>
        db('nivaro_sla_rules as r')
          .join('nivaro_workflow_bindings as b', 'b.template', 'r.workflow_template')
          .where('b.collection', collection)
          .select('r.name', 'r.state_key', 'r.duration_hours', 'r.is_active'),
      [] as Array<Record<string, unknown>>
    )
  ])
  const { hooks } = await import('../hooks/registry.js')
  const codeHooks = hooks
    .timings()
    .filter((h) => h.collection === collection || h.collection === '*')
    .map((h) => ({ when: `${h.timing} ${h.action}`, owner: h.owner, name: h.name }))
  const result = {
    collection,
    rules: rules.map((r) => ({ name: r.name, enabled: !!r.enabled })),
    flows: flows.slice(0, 40),
    webhooks: webhooks.map((w) => ({
      name: w.name,
      enabled: !!w.enabled,
      events: parse(w.events)
    })),
    alerts: alerts.map((a) => ({ name: a.name, field: a.field, active: !!a.is_active })),
    field_watches: watches,
    sla_rules: sla.map((s) => ({
      name: s.name,
      state: s.state_key,
      hours: s.duration_hours,
      active: !!s.is_active
    })),
    code_hooks: codeHooks.slice(0, 40)
  }
  const n =
    result.rules.length +
    result.flows.length +
    result.webhooks.length +
    result.alerts.length +
    result.field_watches.length +
    result.sla_rules.length +
    result.code_hooks.length
  return { result, summary: `${collection}: ${n} automation(s)` }
}
