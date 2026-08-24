/**
 * Administration commands: roles & policies (RBAC/RLS), user management +
 * delegation, CSV import jobs, throughput reporting, notification-subscription
 * admin views, extension/flow registries, mail test, Report Studio, pipeline
 * template versions, metric alerts, scope dimensions, staged imports, access
 * audits, coverage gaps, integration health.
 */
import { type Command, cmd } from '../command.js'
import type { ISODate, UUID } from '../index.js'

// ─── Roles & policies ─────────────────────────────────────────────────────────

export interface Role {
  id: UUID
  name: string
  description: string | null
  admin_access: boolean
  app_access: boolean
  /** Disabled admin-UI route paths (parsed from JSON). */
  ui_permissions?: string[]
  workspace?: UUID | null
}

export interface Policy {
  id: number
  role: UUID
  collection: string
  action: string
  fields: string[] | null
  /** Row-level security conditions ({ field, op, value }[]); $CURRENT_USER /
   *  $CURRENT_ROLE tokens are substituted at evaluation time. */
  row_filter?: unknown
}

export function listRoles(): Command<{ data: Role[] }> {
  return cmd('GET', '/roles')
}

export function readRole(id: UUID): Command<{ data: Role }> {
  return cmd('GET', `/roles/${id}`)
}

export function createRole(data: {
  name: string
  description?: string | null
  admin_access?: boolean
  app_access?: boolean
}): Command<{ data: Role }> {
  return cmd('POST', '/roles', undefined, data)
}

export function updateRole(id: UUID, data: Partial<Omit<Role, 'id'>>): Command<{ data: Role }> {
  return cmd('PATCH', `/roles/${id}`, undefined, data)
}

export function deleteRole(id: UUID): Command<void> {
  return cmd('DELETE', `/roles/${id}`)
}

/** Replace a role's disabled admin-UI route list (admins bypass entirely). */
export function updateRoleUiPermissions(id: UUID, disabled: string[]): Command<{ data: Role }> {
  return cmd('PATCH', `/roles/${id}/ui-permissions`, undefined, { disabled })
}

export function listRoleUsers(id: UUID): Command<{
  data: Array<{
    id: UUID
    first_name: string | null
    last_name: string | null
    email: string
    status: string
    last_access: ISODate | null
  }>
}> {
  return cmd('GET', `/roles/${id}/users`)
}

export function listRolePolicies(id: UUID): Command<{ data: Policy[] }> {
  return cmd('GET', `/roles/${id}/policies`)
}

export function createRolePolicy(
  roleId: UUID,
  data: { collection: string; action: string; fields?: string[]; row_filter?: unknown }
): Command<{ data: Policy }> {
  return cmd('POST', `/roles/${roleId}/policies`, undefined, data)
}

export function updateRolePolicy(
  policyId: number,
  data: { fields?: string[] | null; row_filter?: unknown }
): Command<{ data: Policy }> {
  return cmd('PATCH', `/roles/policies/${policyId}`, undefined, data)
}

export function deleteRolePolicy(policyId: number): Command<void> {
  return cmd('DELETE', `/roles/policies/${policyId}`)
}

// ─── User management & delegation ─────────────────────────────────────────────

export interface ManagedUser {
  id: UUID
  email: string
  first_name: string | null
  last_name: string | null
  role: UUID | null
  status: string
  external_id?: string | null
  manager_id?: UUID | null
  delegate_id?: UUID | null
  delegate_expires_at?: ISODate | null
  is_out_of_office?: boolean
  last_access?: ISODate | null
}

export function readUser(id: UUID): Command<{ data: ManagedUser }> {
  return cmd('GET', `/users/${id}`)
}

/** Compact profile card (name, avatar initials, role) for hover cards. */
export function readUserCard(id: UUID): Command<{ data: Record<string, unknown> }> {
  return cmd('GET', `/users/${id}/card`)
}

export function createUser(data: {
  email: string
  first_name?: string | null
  last_name?: string | null
  role?: UUID | null
  status?: string
}): Command<{ data: ManagedUser }> {
  return cmd('POST', '/users', undefined, data)
}

/** Self-updates allowed for a narrow field set; admins can set role/status/manager. */
export function updateUser(
  id: UUID,
  data: Partial<Omit<ManagedUser, 'id'>>
): Command<{ data: ManagedUser }> {
  return cmd('PATCH', `/users/${id}`, undefined, data)
}

export function deleteUser(id: UUID): Command<void> {
  return cmd('DELETE', `/users/${id}`)
}

/** Self-serve out-of-office delegation: the delegate substitutes for the
 *  caller in pipeline owner resolution while is_out_of_office is set (and
 *  delegate_expires_at, if given, is in the future). */
export function setMyDelegate(data: {
  delegate_id?: UUID | null
  delegate_expires_at?: ISODate | null
  is_out_of_office?: boolean
  /** Scheduled OOO window — the server's ooo-schedule cron flips the toggle
   *  on entry and clears it after the window passes. */
  ooo_start?: ISODate | null
  ooo_end?: ISODate | null
}): Command<{ data: ManagedUser }> {
  return cmd('POST', '/users/me/delegate', undefined, data)
}

// ─── CSV import jobs (admin) ──────────────────────────────────────────────────

export interface ImportJob {
  id: UUID
  collection: string
  file_name: string | null
  status: string
  total_rows: number | null
  processed_rows: number | null
  created_rows: number | null
  updated_rows: number | null
  skipped_rows: number | null
  errors: unknown[] | null
  created_by: UUID
  created_at: ISODate
}

export function listImportJobs(): Command<{ data: ImportJob[] }> {
  return cmd('GET', '/imports')
}

export function readImportJob(id: UUID): Command<{ data: ImportJob }> {
  return cmd('GET', `/imports/${id}`)
}

/** Start an import from raw CSV text. Processing is async — poll readImportJob
 *  (or subscribe to the import:progress socket event). nivaro_* collections
 *  are blocked server-side. */
export function createImportJob(data: {
  collection: string
  csv_data: string
  column_map?: Record<string, string>
  duplicate_strategy?: string
  id_field?: string
  file_name?: string
}): Command<{ data: ImportJob }> {
  return cmd('POST', '/imports', undefined, data)
}

/** Start an import by fetching a CSV from a URL (SSRF-guarded server-side). */
export function createImportJobFromUrl(data: {
  collection: string
  url: string
  column_map?: Record<string, string>
  duplicate_strategy?: string
  id_field?: string
}): Command<{ data: ImportJob }> {
  return cmd('POST', '/imports/from-url', undefined, data)
}

/** Delete a completed or failed job (running jobs are protected). */
export function deleteImportJob(id: UUID): Command<void> {
  return cmd('DELETE', `/imports/${id}`)
}

// ─── Throughput reporting (admin) ─────────────────────────────────────────────

/** Per-user workflow throughput (transitions, completions, send-backs,
 *  time-to-action) aggregated on the fly from workflow history. */
export function readThroughputReport(
  options: {
    collection?: string
    from?: string
    to?: string
    bucket?: 'day' | 'week' | 'month'
    user?: UUID
  } = {}
): Command<{ data: Record<string, unknown> }> {
  return cmd('GET', '/reports/throughput', options)
}

/** Collections with a workflow binding — the throughput report's scope picker. */
export function listThroughputCollections(): Command<{ data: string[] }> {
  return cmd('GET', '/reports/throughput/collections')
}

// ─── Notification subscriptions (admin views) ─────────────────────────────────

export function listAllNotificationSubscriptions(): Command<{ data: unknown[] }> {
  return cmd('GET', '/notification-subscriptions/admin/all')
}

export function readNotificationSubscriptionStats(): Command<{ data: Record<string, unknown> }> {
  return cmd('GET', '/notification-subscriptions/admin/stats')
}

// ─── Registries ───────────────────────────────────────────────────────────────

/** Extensions currently loaded by the extension loader. */
export function listRegisteredExtensions(): Command<{ data: unknown[] }> {
  return cmd('GET', '/extension-registry')
}

/** Custom flow operation types registered by extensions. */
export function listRegisteredFlowOperations(): Command<{ data: unknown[] }> {
  return cmd('GET', '/flows/registered-operations')
}

/** Custom flow trigger types registered by extensions. */
export function listRegisteredFlowTriggers(): Command<{ data: unknown[] }> {
  return cmd('GET', '/flows/registered-triggers')
}

// ─── Mail ─────────────────────────────────────────────────────────────────────

/** Send a test email through the configured SMTP settings. */
export function sendTestMail(to: string): Command<{ data: { sent: boolean } }> {
  return cmd('POST', '/mail/test', undefined, { to })
}

// ─── Permission simulator ─────────────────────────────────────────────────────

export interface PermissionSimulation {
  allowed: boolean
  reason: string
  admin_access: boolean
  fields: string[] | null
  row_filter: Array<{ field: string; op: string; value?: unknown }> | null
  tree_permission: { result: boolean | null; note: string } | null
  ui_disabled_routes: string[]
}

/** Evaluate what a user with a role could do — same checks the API enforces. Admin only. */
export function simulatePermissions(
  roleId: UUID,
  input: {
    collection: string
    action: 'create' | 'read' | 'update' | 'delete'
    item_id?: string | null
    user_id?: string | null
  }
): Command<{ data: PermissionSimulation }> {
  return cmd('POST', `/roles/${roleId}/simulate`, undefined, input)
}

// ─── Backups ──────────────────────────────────────────────────────────────────

/** What a backup export would include. Admin only. */
export function readBackupManifest(
  options: { include_system?: boolean } = {}
): Command<{ data: { business: string[]; system: string[]; excluded: string[] } }> {
  return cmd('GET', '/backups/manifest', {
    include_system: options.include_system ? 'true' : 'false'
  })
}

/** Path streaming the gzip NDJSON logical backup (combine with client.url; admin only). */
export function backupExportPath(options: { include_system?: boolean } = {}): string {
  return `/api/backups/export?include_system=${options.include_system ? 'true' : 'false'}`
}

// ─── Content promotion ────────────────────────────────────────────────────────

export interface ContentBundle {
  type: 'nivaro-content-bundle'
  version: 1
  exported_at: string
  collections: Record<string, Array<Record<string, unknown>>>
}

export type PromotionPreview = Record<
  string,
  { create: number; update: number; unchanged: number; missing_ids: number; error?: string }
>

export type PromotionApplyResult = Record<
  string,
  { created: number; updated: number; skipped: number; errors: string[] }
>

/** Package collections from this instance into a portable content bundle. Admin only. */
export function exportContentBundle(collections: string[]): Command<{ data: ContentBundle }> {
  return cmd('POST', '/promotion/export', undefined, { collections })
}

/** Diff a bundle against this instance — no writes. Admin only. */
export function previewContentBundle(bundle: ContentBundle): Command<{ data: PromotionPreview }> {
  return cmd('POST', '/promotion/preview', undefined, { bundle })
}

/** Apply a bundle: id-keyed upsert, never deletes. Admin only. */
export function applyContentBundle(bundle: ContentBundle): Command<{ data: PromotionApplyResult }> {
  return cmd('POST', '/promotion/apply', undefined, { bundle })
}

// ─── Error reporting ──────────────────────────────────────────────────────────

/** Report a client-side error into the issue log (deduped server-side by route+message). */
export function reportClientError(input: {
  message: string
  stack?: string
  url?: string
}): Command<void> {
  return cmd('POST', '/issues/client', undefined, input)
}

// ─── Pipeline simulator ───────────────────────────────────────────────────────

export interface PipelineSimulation {
  template: string
  has_instance: boolean
  current_state: string | null
  states: Array<{
    id: string
    key: string
    label: string
    color: string | null
    is_initial: boolean
    is_terminal: boolean
    is_current: boolean
    owners: Array<{
      id: string
      email: string
      first_name: string | null
      last_name: string | null
    }>
    sla_rule: {
      name: string
      duration_hours: number
      warning_threshold_pct: number
      business_hours_only: boolean
    } | null
  }>
  transitions: Array<{
    id: string
    label: string
    from_state: string | null
    to_state: string
    from_ok: boolean
    conditions_pass: boolean
    role_pass: boolean
    available: boolean
    required_roles: string[]
    condition_rules: Array<{
      field: string
      op: string
      value: unknown
      record_value: unknown
      passed: boolean
    }>
  }>
}

/** Dry-run a record through its pipeline: owners per state, transition availability with reasons, SLA per state. */
export function simulatePipeline(
  collection: string,
  itemId: string | number
): Command<{ data: PipelineSimulation | null }> {
  return cmd('POST', '/pipelines/simulate', undefined, { collection, item_id: itemId })
}

// ─── Field impact analysis ────────────────────────────────────────────────────

/** What references this field? Layouts, queues, templates, formulas, rules, views… Admin only. */
export function readFieldImpact(
  collection: string,
  field: string
): Command<{
  data: Array<{ source: string; label: string; detail: string; link: string | null }>
  total: number
}> {
  return cmd('GET', `/data-model/${collection}/fields/${field}/impact`)
}

// ─── Scheduled reports ────────────────────────────────────────────────────────

export interface ScheduledReport {
  id: number
  name: string
  report_type: 'collection' | 'queue'
  collection: string | null
  queue_id: string | null
  filters: unknown
  fields: string[] | null
  recipients: string[]
  cron_schedule: string
  orientation: string
  row_limit: number
  is_active: boolean
  last_run_at: ISODate | null
  last_run_status: string | null
}

export function listScheduledReports(): Command<{ data: ScheduledReport[] }> {
  return cmd('GET', '/scheduled-reports/')
}

export function createScheduledReport(
  data: Partial<ScheduledReport> & { name: string; cron_schedule: string; recipients: string[] }
): Command<{ data: ScheduledReport }> {
  return cmd('POST', '/scheduled-reports/', undefined, data)
}

export function updateScheduledReport(
  id: number,
  data: Partial<ScheduledReport>
): Command<{ data: ScheduledReport }> {
  return cmd('PATCH', `/scheduled-reports/${id}`, undefined, data)
}

export function deleteScheduledReport(id: number): Command<void> {
  return cmd('DELETE', `/scheduled-reports/${id}`)
}

/** Render and email the report immediately. */
export function runScheduledReport(id: number): Command<{ data: { sent: number } }> {
  return cmd('POST', `/scheduled-reports/${id}/run`)
}

// ─── Record timeline ──────────────────────────────────────────────────────────

export interface TimelineEvent {
  id: string
  type: 'activity' | 'revision' | 'workflow' | 'comment' | 'task' | 'addendum'
  timestamp: ISODate
  user: { id: string; name: string } | null
  title: string
  detail: string | null
}

/** Unified chronological history for one record. */
export function readTimeline(
  collection: string,
  item: string | number
): Command<{ data: TimelineEvent[] }> {
  return cmd('GET', `/timeline/${collection}/${item}`)
}

// ─── Share links ──────────────────────────────────────────────────────────────

export interface ShareLink {
  id: UUID
  collection: string
  item: string
  token: string
  url: string
  layout_id: number | null
  expires_at: ISODate | null
  is_active: boolean
  view_count: number
}

export function createShareLink(data: {
  collection: string
  item: string | number
  layout_id?: number | null
  expires_in_days?: number | null
}): Command<{ data: ShareLink }> {
  return cmd('POST', '/share-links/', undefined, data)
}

export function listShareLinks(
  collection: string,
  item: string | number
): Command<{ data: ShareLink[] }> {
  return cmd('GET', `/share-links/for/${collection}/${item}`)
}

export function revokeShareLink(id: UUID): Command<void> {
  return cmd('DELETE', `/share-links/${id}`)
}

// ─── Blueprints ───────────────────────────────────────────────────────────────

/** Export a schema+workflow+layout+queue bundle for a collection set. Admin only. */
export function exportBlueprint(
  name: string,
  collections: string[]
): Command<{ data: Record<string, unknown> }> {
  return cmd('POST', '/blueprints/export', undefined, { name, collections })
}

/** Install a blueprint artifact idempotently. Admin only. */
export function installBlueprint(
  blueprint: Record<string, unknown>
): Command<{ data: Record<string, unknown> }> {
  return cmd('POST', '/blueprints/install', undefined, { blueprint })
}

// ─── Record graph ─────────────────────────────────────────────────────────────

export interface RecordGraphNode {
  collection: string
  id: string
  label: string
}

export interface RecordGraphEdge {
  kind: 'm2o' | 'o2m' | 'm2m'
  via: string
  node: RecordGraphNode
}

/** One record's relation neighborhood: M2O parents, O2M children, M2M partners. */
export function readRecordGraph(
  collection: string,
  item: string | number
): Command<{ data: { node: RecordGraphNode; edges: RecordGraphEdge[]; truncated: boolean } }> {
  return cmd('GET', `/record-graph/${collection}/${item}`)
}

// ─── Pipeline flow map & replay ───────────────────────────────────────────────

export interface PipelineFlowEdge {
  from: string
  to: string
  count: number
  back: boolean
}

export interface PipelineFlowState {
  id: string
  label: string
  color: string | null
}

/** Aggregated transition volumes between a pipeline's states (Sankey data). */
export function readPipelineFlowMap(
  templateId: string,
  days?: number
): Command<{ data: { states: PipelineFlowState[]; flows: PipelineFlowEdge[]; days: number } }> {
  return cmd('GET', `/pipelines/${templateId}/flow-map`, days ? { days } : undefined)
}

/** Daily per-state record counts over time (time-lapse replay frames). */
export function readPipelineReplay(
  templateId: string,
  days?: number
): Command<{
  data: { states: Array<Record<string, unknown>>; days: Array<Record<string, unknown>> }
}> {
  return cmd('GET', `/pipelines/${templateId}/replay`, days ? { days } : undefined)
}

// ─── Session recording (rrweb) ────────────────────────────────────────────────

export interface SessionRecording {
  id: UUID
  user: UUID
  app: string | null
  user_name?: string | null
  started_at: ISODate
  ended_at: ISODate | null
  last_event_at: ISODate | null
  event_count: number
  byte_size: number
  truncated: boolean
}

/** Is session recording enabled instance-wide? (Recorders no-op when false.) */
export function sessionRecordingEnabled(): Command<{
  data: { enabled: boolean; error_replay?: boolean }
}> {
  return cmd('GET', '/session-recordings/enabled')
}

/**
 * Open a recording. `app` labels which frontend it came from; `origin` says
 * which environment, so a replay list can tell production apart from a
 * developer's laptop. The server falls back to the request's referer when a
 * caller omits it.
 */
export function startSessionRecording(
  app?: string,
  origin?: string,
  clip?: boolean
): Command<{ data: { id: UUID } }> {
  const body: Record<string, string | boolean> = {}
  if (app) body.app = app
  const resolved = origin ?? (typeof window !== 'undefined' ? window.location.origin : undefined)
  if (resolved) body.origin = resolved
  // Error clips are gated server-side by the error_replay setting, not the
  // full-recording bit — see the error-clip mode on useSessionRecorder.
  if (clip) body.clip = true
  return cmd('POST', '/session-recordings/start', undefined, body)
}

/** Append an ordered chunk of rrweb events to an open recording. */
export function appendSessionRecordingEvents(
  id: UUID,
  seq: number,
  events: unknown[]
): Command<{ data: { ok: boolean } }> {
  return cmd('POST', `/session-recordings/${id}/events`, undefined, { seq, events })
}

/** Close a recording. */
export function endSessionRecording(id: UUID): Command<{ data: { ended: boolean } }> {
  return cmd('POST', `/session-recordings/${id}/end`)
}

/** List recordings (admin only). */
export function listSessionRecordings(user?: UUID): Command<{ data: SessionRecording[] }> {
  return cmd('GET', '/session-recordings/', user ? { user } : undefined)
}

/** Full concatenated rrweb event stream for a recording (admin only). */
export function readSessionRecordingEvents(id: UUID): Command<{ data: { events: unknown[] } }> {
  return cmd('GET', `/session-recordings/${id}/events`)
}

/** Delete a recording (admin only). */
export function deleteSessionRecording(id: UUID): Command<{ data: { deleted: boolean } }> {
  return cmd('DELETE', `/session-recordings/${id}`)
}

// ─── User scopes (dimensional defaults + restrictions) ────────────────────────

export interface ScopeDimensionInfo {
  name: string
  label: string
  target_collection: string
  display_field: string | null
  options_sort: string | null
}

export interface UserScopesInfo {
  dimensions: ScopeDimensionInfo[]
  defaults: Record<string, Array<string | number>>
  restricted: Record<string, Array<string | number>>
}

/** The caller's scope dimensions + own default/restricted value sets. */
export function readMyScopes(): Command<{ data: UserScopesInfo }> {
  return cmd('GET', '/users/me/scopes')
}

/** Self-edit DEFAULT values for a dimension (restrictions are admin-set). */
export function saveMyScopeDefaults(
  dimension: string,
  values: Array<string | number>
): Command<{ data: { saved: boolean; values: Array<string | number> } }> {
  return cmd('PUT', `/users/me/scopes/${dimension}`, undefined, { values })
}

/** Admin: any user's scopes. */
export function readUserScopes(userId: UUID): Command<{ data: UserScopesInfo }> {
  return cmd('GET', `/user-scopes/${userId}`)
}

/** Admin: set a user's default or restrict values for a dimension. */
export function saveUserScope(
  userId: UUID,
  body: { dimension: string; mode: 'default' | 'restrict'; values: Array<string | number> }
): Command<{ data: { saved: boolean } }> {
  return cmd('PUT', `/user-scopes/${userId}`, undefined, body)
}

// ─── Report Studio ────────────────────────────────────────────────────────────

/** Display format for a query-widget / table column value. */
export type ReportColumnFormat =
  | 'currency'
  | 'number'
  | 'integer'
  | 'percent'
  | 'days'
  | 'date'
  | 'datetime'

export interface ReportQueryColumn {
  field: string
  label?: string
  format?: ReportColumnFormat
  decimals?: number
}

/**
 * Custom-query-backed widget: executes a nivaro custom query (as the viewer)
 * and renders rows as a table, chart, or KPI tile strip. Param values may be
 * literals or tokens: '$filters.<field>' (selected option LABELS, comma-joined
 * — stored procs take names), '$filters.<field>:values' (raw values),
 * '$date.start' / '$date.end' (resolved from the report date range).
 * Unresolved optional tokens are omitted from the execute call.
 */
export interface ReportQueryWidgetConfig {
  slug: string
  params?: Record<string, string>
  display: 'table' | 'bar' | 'hbar' | 'stacked_bar' | 'line' | 'area' | 'donut' | 'kpis' | 'tree'
  /** Table column defs / KPI tile defs (kpis reads row 0, one tile per column). */
  columns?: ReportQueryColumn[]
  /** Chart category/x-axis field. */
  x_field?: string
  /** Chart series — one line/bar per entry (multi-series supported). */
  series?: Array<{ field: string; label?: string; color?: string; dash?: boolean }>
  value_format?: ReportColumnFormat
  limit?: number
  sort?: string
  /** Table: render a totals row over numeric columns. */
  totals?: boolean
  /** stacked_bar only: lay bars horizontally. */
  horizontal?: boolean
  /** Aggregate rows client-side: group by x_field, summing each series field. */
  group_rows?: boolean
  /**
   * display='tree': collapsible group tree over flat rows (EFP budget-health
   * style). `levels` are the group-by fields outer→leaf; series fields sum at
   * every level; `pct` renders a utilization bar (num/den, % colored by
   * `thresholds`, first match wins, checked in order); `badge` shows a leaf
   * chip; `drill` opens the record detail sheet on leaf click.
   */
  tree?: {
    levels: string[]
    badge?: string
    pct?: { num: string; den: string; label?: string }
    thresholds?: Array<{ gte: number; color: string }>
    drill?: { collection: string; id_field: string }
  }
}

export interface ReportWidgetConfig {
  metric?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string }
  dimension?: { field: string; bucket?: 'day' | 'week' | 'month' } | null
  filters?: Array<{ field: string; op: string; value?: unknown }>
  date_field?: string | null
  limit?: number
  /** Table columns — plain field names or {field, label, format} defs. */
  columns?: Array<string | ReportQueryColumn>
  sort?: string
  format?: { prefix?: string; suffix?: string; decimals?: number }
  compare?: 'previous_period' | 'previous_year' | null
  orientation?: 'horizontal' | 'vertical'
  metrics?: Array<{
    label: string
    collection: string
    aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'
    field?: string
    format?: { prefix?: string; suffix?: string; decimals?: number }
    color?: string
  }>
  /** type='query' widgets only. */
  query?: ReportQueryWidgetConfig
  /** Dual-axis second metric on value-dimension charts. */
  metric2?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; label?: string }
  /** type='calc' widgets: formula over sibling widgets' derived metrics. */
  formula?: string
  refs?: Record<string, UUID>
  /** Table widgets: value rules → cell/row tints. */
  format_rules?: Array<{
    field: string
    op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
    value: number
    color: string
    scope?: 'cell' | 'row'
  }>
  /** KPI mini trend line under the number (needs date_field). */
  sparkline?: boolean
  /** Heatmap column dimension (rows come from `dimension`). */
  dimension2?: { field: string } | null
  /** Line charts: shaded min/max band from the prior 4 same-length windows. */
  benchmark?: boolean
  /** Narrative widgets: markdown-lite text with {{token}} value refs. */
  text?: string
  /** Drill-to-report: clicking navigates to another report, carrying the value. */
  link_report?: { report_id: string; filter_field?: string } | null
}

export type ReportWidgetType =
  | 'kpi'
  | 'kpi_group'
  | 'bar'
  | 'line'
  | 'donut'
  | 'table'
  | 'divider'
  | 'query'
  | 'queue'
  | 'calc'
  | 'movers'
  | 'heatmap'
  | 'waterfall'
  | 'narrative'
  | 'pareto'
  | 'stats'
  | 'scatter'
  | 'hot_records'
  | 'metric'

export interface ReportWidget {
  id: UUID
  type: ReportWidgetType
  title: string
  collection: string | null
  config: ReportWidgetConfig | null
  x: number
  y: number
  w: number
  h: number
  sort?: number
}

export interface ReportDateRange {
  preset:
    | 'this_month'
    | 'last_30_days'
    | 'last_3_months'
    | 'last_6_months'
    | 'last_12_months'
    | 'ytd'
    | 'custom'
  start?: string
  end?: string
}

export interface ReportEntityFilter {
  field: string
  values: Array<string | number>
  /** Display labels parallel to values — query-widget params default to these. */
  labels?: string[]
}

export interface ReportDef {
  id: UUID
  name: string
  icon: string | null
  description: string | null
  owner: UUID
  is_shared: boolean
  role_id: UUID | null
  global_filters: {
    date_range?: ReportDateRange | null
    filter_bar?: Array<{
      field: string
      label: string
      /**
       * Optional explicit option source (fetched via /items) — for filter
       * fields that aren't a physical column on any widget collection
       * (e.g. funding year fed to query-widget params).
       */
      options?: {
        collection: string
        value_field?: string
        label_field?: string
        sort?: string
      }
    }>
  } | null
  widget_count?: number
  widgets?: ReportWidget[]
  editable?: boolean
  folder?: string | null
  snapshot_schedule?: 'weekly' | 'monthly' | null
  updated_at: ISODate
}

export interface ReportWidgetData {
  value?: number | null
  prev_value?: number | null
  change_pct?: number | null
  row_count?: number
  rows?: Array<Record<string, unknown>>
  series?: Array<{
    dim: string
    value: number
    prev?: number
    raw?: unknown
    value2?: number
    other?: boolean
    band?: [number, number]
    band_avg?: number
  }>
  spark?: Array<{ dim: string; value: number }>
  cells?: Array<{ dim: string; dim2: string; value: number }>
  waterfall?: { start: number; end: number; steps: Array<{ dim: string; delta: number }> }
  narrative?: string
  tiles?: Array<{
    label: string
    value: number | null
    prev_value?: number | null
    change_pct?: number | null
    format?: { prefix?: string; suffix?: string; decimals?: number }
    color?: string
  }>
}

/** List reports visible to the current user. */
export function listReports(): Command<{ data: ReportDef[] }> {
  return cmd('GET', '/report-studio/')
}

/** One report with its widgets. */
export function readReport(id: UUID): Command<{ data: ReportDef }> {
  return cmd('GET', `/report-studio/${id}`)
}

export function createReport(body: {
  name: string
  icon?: string
  description?: string
}): Command<{ data: ReportDef }> {
  return cmd('POST', '/report-studio/', undefined, body)
}

export function updateReport(
  id: UUID,
  body: Partial<{
    name: string
    icon: string | null
    description: string | null
    is_shared: boolean
    role_id: UUID | null
    global_filters: ReportDef['global_filters']
  }>
): Command<{ data: ReportDef }> {
  return cmd('PATCH', `/report-studio/${id}`, undefined, body)
}

export function deleteReport(id: UUID): Command<{ data: { deleted: boolean } }> {
  return cmd('DELETE', `/report-studio/${id}`)
}

/** Bulk-replace a report's widget set (the builder's save). */
export function saveReportWidgets(
  id: UUID,
  widgets: Array<Partial<ReportWidget>>
): Command<{ data: { saved: number; ids: UUID[] } }> {
  return cmd('PUT', `/report-studio/${id}/widgets`, undefined, { widgets })
}

/** Resolve a saved widget's data (as the viewer). */
export function readReportWidgetData(
  id: UUID,
  widgetId: UUID,
  body?: {
    date_range?: ReportDateRange | null
    entity_filters?: ReportEntityFilter[]
    /** Drill hierarchies (#418): override the widget's dimension for this fetch. */
    dimension_override?: string
  }
): Command<{ data: ReportWidgetData }> {
  return cmd('POST', `/report-studio/${id}/widgets/${widgetId}/data`, undefined, body ?? {})
}

/** Preview an unsaved widget config. */
export function previewReportWidget(body: {
  type: ReportWidgetType
  collection?: string | null
  config?: ReportWidgetConfig | null
  date_range?: ReportDateRange | null
  entity_filters?: ReportEntityFilter[]
}): Command<{ data: ReportWidgetData }> {
  return cmd('POST', '/report-studio/preview', undefined, body)
}

export function cloneReport(id: UUID): Command<{ data: { id: UUID } }> {
  return cmd('POST', `/report-studio/${id}/clone`)
}

/** Distinct values for a filter-bar field (FK-labeled). */
export function readReportFilterOptions(
  id: UUID,
  field: string
): Command<{ data: Array<{ value: string; label: string }> }> {
  return cmd('GET', `/report-studio/${id}/filter-options`, { field })
}

/** Compose widgets from a prompt (admin/owner). */
export function aiBuildReport(
  id: UUID,
  prompt: string
): Command<{ data: { widgets: ReportWidget[] } }> {
  return cmd('POST', `/report-studio/${id}/ai-build`, undefined, { prompt })
}

/** Turn prose into a date range + entity filters. */
export function aiReportFilters(
  id: UUID,
  prompt: string,
  fields: Array<string | { field: string; label?: string }>
): Command<{
  data: { date_range?: ReportDateRange | null; entity_filters?: ReportEntityFilter[] }
}> {
  return cmd('POST', `/report-studio/${id}/ai-filters`, undefined, { prompt, fields })
}

export interface ReportSubscription {
  id: number
  cadence: 'daily' | 'weekly'
  delivery_email: boolean
  delivery_inapp: boolean
}

export function readReportSubscription(id: UUID): Command<{ data: ReportSubscription | null }> {
  return cmd('GET', `/report-studio/${id}/subscription`)
}

/** Subscribe/update (body) or unsubscribe (null). */
export function setReportSubscription(
  id: UUID,
  body: { cadence: 'daily' | 'weekly'; delivery_email?: boolean; delivery_inapp?: boolean } | null
): Command<{ data: ReportSubscription | null }> {
  return cmd('PUT', `/report-studio/${id}/subscription`, undefined, body)
}

/**
 * Alert condition field syntax: 'value' | 'row_count' | '<col>' (sum of a
 * numeric result column) | 'sum:<col>' | 'avg:<col>' | 'max:<col>' |
 * 'min:<col>' | 'tile:<label>' (kpi_group tile).
 */
/** Clear cached custom-query results for this report's query widgets. */
export function resetReportCache(
  id: UUID
): Command<{ data: { queries: number; cleared: number } }> {
  return cmd('POST', `/report-studio/${id}/reset-cache`)
}

export interface ReportFilterPreset {
  id: number
  name: string
  date_range: ReportDateRange | null
  entity_filters: ReportEntityFilter[]
}

/** The caller's own named filter presets for a report (server-persisted). */
export function listReportFilterPresets(id: UUID): Command<{ data: ReportFilterPreset[] }> {
  return cmd('GET', `/report-studio/${id}/filter-presets`)
}

/** Save (upsert-by-name) a filter preset for the caller. */
export function saveReportFilterPreset(
  id: UUID,
  body: { name: string; date_range?: ReportDateRange | null; entity_filters?: ReportEntityFilter[] }
): Command<{ data: { id: number; updated: boolean } }> {
  return cmd('POST', `/report-studio/${id}/filter-presets`, undefined, body)
}

export function deleteReportFilterPreset(
  id: UUID,
  presetId: number
): Command<{ data: { deleted: boolean } }> {
  return cmd('DELETE', `/report-studio/${id}/filter-presets/${presetId}`)
}

export interface ReportAlertCondition {
  field: string
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
  value: number
}

export interface ReportAlert {
  id: UUID
  widget: UUID
  name: string
  conditions: ReportAlertCondition[]
  /** Per-alert entity-filter overrides — the alert evaluates in this scope. */
  filters?: ReportEntityFilter[] | null
  is_active: boolean
  delivery_email?: boolean
  delivery_inapp?: boolean
  firing: boolean
  last_fired?: ISODate | null
}

export function listReportAlerts(id: UUID): Command<{ data: ReportAlert[] }> {
  return cmd('GET', `/report-studio/${id}/alerts`)
}

export function createReportAlert(
  id: UUID,
  body: {
    widget: UUID
    name?: string
    conditions: ReportAlertCondition[]
    filters?: ReportEntityFilter[]
    delivery_email?: boolean
    delivery_inapp?: boolean
  }
): Command<{ data: { id: UUID } }> {
  return cmd('POST', `/report-studio/${id}/alerts`, undefined, body)
}

export function updateReportAlert(
  id: UUID,
  alertId: UUID,
  body: {
    name?: string
    conditions?: ReportAlertCondition[]
    filters?: ReportEntityFilter[] | null
    delivery_email?: boolean
    delivery_inapp?: boolean
    is_active?: boolean
  }
): Command<{ data: { updated: boolean } }> {
  return cmd('PATCH', `/report-studio/${id}/alerts/${alertId}`, undefined, body)
}

/** Mark an alert's open firing entry resolved. */
export function resolveReportAlert(
  id: UUID,
  alertId: UUID
): Command<{ data: { resolved: number } }> {
  return cmd('POST', `/report-studio/${id}/alerts/${alertId}/resolve`)
}

export interface ReportAlertLogEntry {
  id: number
  alert: UUID
  status: 'firing' | 'resolved'
  metric_snapshot: Record<string, number> | null
  fired_at: ISODate
  resolved_at: ISODate | null
}

export function readReportAlertLog(
  id: UUID,
  alertId: UUID
): Command<{ data: ReportAlertLogEntry[] }> {
  return cmd('GET', `/report-studio/${id}/alerts/${alertId}/log`)
}

export function toggleReportAlert(
  id: UUID,
  alertId: UUID,
  isActive: boolean
): Command<{ data: { updated: boolean } }> {
  return cmd('PATCH', `/report-studio/${id}/alerts/${alertId}`, undefined, { is_active: isActive })
}

export function deleteReportAlert(
  id: UUID,
  alertId: UUID
): Command<{ data: { deleted: boolean } }> {
  return cmd('DELETE', `/report-studio/${id}/alerts/${alertId}`)
}

/** Every alert's firing history for a report (newest first, capped 100). */
export function readReportAlertsLog(id: UUID): Command<{ data: ReportAlertLogEntry[] }> {
  return cmd('GET', `/report-studio/${id}/alerts-log`)
}

/** Currently-firing alerts for a report — drives the report's red strip. */
export function readReportFiring(
  id: UUID
): Command<{ data: Array<{ alert_id: UUID; name: string; widget: UUID; since: ISODate }> }> {
  return cmd('GET', `/report-studio/${id}/firing`)
}

// ─── Report Studio — templates, versions, snapshots, annotations ──────────────

export interface ReportVersionEntry {
  id: number
  version: number
  note: string | null
  created_at: ISODate
  created_by_name: string | null
}

/** Config version history for a report (newest first, capped 30). */
export function listReportVersions(id: UUID): Command<{ data: ReportVersionEntry[] }> {
  return cmd('GET', `/report-studio/${id}/versions`)
}

/** Restore a config version. Id-preserving; captures a 'before restore' version first. */
export function restoreReportVersion(
  id: UUID,
  versionId: number
): Command<{ data: Record<string, unknown> }> {
  return cmd('POST', `/report-studio/${id}/versions/${versionId}/restore`)
}

export interface ReportSnapshotEntry {
  id: number
  name: string
  taken_at: ISODate
}

/** Point-in-time snapshots (one derived metric per widget) for vs-then deltas. */
export function listReportSnapshots(id: UUID): Command<{ data: ReportSnapshotEntry[] }> {
  return cmd('GET', `/report-studio/${id}/snapshots`)
}

/** Take a snapshot now, resolved as the caller with the report's own date range. */
export function createReportSnapshot(
  id: UUID,
  name?: string
): Command<{ data: { id: number; name: string } }> {
  return cmd('POST', `/report-studio/${id}/snapshots`, undefined, name ? { name } : {})
}

/** One snapshot with its per-widget values ({ widgetId: { value } }). */
export function readReportSnapshot(
  id: UUID,
  snapId: number
): Command<{
  data: ReportSnapshotEntry & { data: Record<string, { value: number | null }> }
}> {
  return cmd('GET', `/report-studio/${id}/snapshots/${snapId}`)
}

export function deleteReportSnapshot(
  id: UUID,
  snapId: number
): Command<{ data: { deleted: boolean } }> {
  return cmd('DELETE', `/report-studio/${id}/snapshots/${snapId}`)
}

export interface ReportAnnotation {
  id: number
  widget: UUID
  note: string
  /** 'YYYY-MM' or 'YYYY-MM-DD' bucket key — renders as a chart marker when it
   *  matches a bucket. */
  anchor_date: string | null
  created_at: ISODate
  created_by: UUID
  created_by_name: string | null
}

export function listReportAnnotations(id: UUID): Command<{ data: ReportAnnotation[] }> {
  return cmd('GET', `/report-studio/${id}/annotations`)
}

export function createReportAnnotation(
  id: UUID,
  body: { widget: UUID; note: string; anchor_date?: string | null }
): Command<{ data: { id: number } }> {
  return cmd('POST', `/report-studio/${id}/annotations`, undefined, body)
}

/** Delete an annotation (own note, or anyone with edit access to the report). */
export function deleteReportAnnotation(
  id: UUID,
  annId: number
): Command<{ data: { deleted: boolean } }> {
  return cmd('DELETE', `/report-studio/${id}/annotations/${annId}`)
}

export interface ReportTemplateEntry {
  id: number
  name: string
  description: string | null
  created_at: ISODate
}

/** Whole-report templates (global filters + widget set snapshots). */
export function listReportTemplates(): Command<{ data: ReportTemplateEntry[] }> {
  return cmd('GET', '/report-studio/templates')
}

/** Snapshot a report's current config as a reusable template. */
export function saveReportTemplate(
  id: UUID,
  body: { name?: string; description?: string } = {}
): Command<{ data: { id: number; name: string } }> {
  return cmd('POST', `/report-studio/${id}/save-template`, undefined, body)
}

/** Instantiate a new (private) report from a template. */
export function createReportFromTemplate(body: {
  template_id: number
  name?: string
}): Command<{ data: { id: UUID } }> {
  return cmd('POST', '/report-studio/from-template', undefined, body)
}

/** Delete a template (creator or admin). */
export function deleteReportTemplate(templateId: number): Command<{ data: { deleted: boolean } }> {
  return cmd('DELETE', `/report-studio/templates/${templateId}`)
}

/** Copy a widget into another report (needs edit access to the target). */
export function copyReportWidget(
  id: UUID,
  widgetId: UUID,
  targetReportId: UUID
): Command<{ data: { id: UUID; report: UUID } }> {
  return cmd('POST', `/report-studio/${id}/widgets/${widgetId}/copy`, undefined, {
    target_report_id: targetReportId
  })
}

/** Infer the record behind a query-widget row from its column values.
 *  Resolved as the caller (RBAC/RLS apply); ambiguity is a miss. */
export function drillReportRow(
  values: Record<string, unknown>
): Command<{ data: { collection: string; item_id: string } | { resolved: false } }> {
  return cmd('POST', '/report-studio/drill-row', undefined, { values })
}

/** Per-report read stats from the throttled report-view activity log. Admin only. */
export function readReportUsage(): Command<{
  data: Record<string, { last_viewed: ISODate; views_30d: number; viewers_30d: number }>
}> {
  return cmd('GET', '/report-studio/usage')
}

// ─── Report Studio — prebuilt widget catalog ──────────────────────────────────

export interface ReportWidgetPreset {
  id: number
  name: string
  category: string
  description: string | null
  widget_type: ReportWidgetType
  config: ReportWidgetConfig | null
  w: number
  h: number
}

/** Active prebuilt widget presets, ordered by category/sort/name. */
export function listReportWidgetPresets(): Command<{ data: ReportWidgetPreset[] }> {
  return cmd('GET', '/report-studio/widget-presets')
}

/** Add a preset to the catalog. Admin only. */
export function createReportWidgetPreset(body: {
  name: string
  widget_type: ReportWidgetType
  category?: string
  description?: string | null
  config?: ReportWidgetConfig | null
  w?: number
  h?: number
  sort?: number
  is_active?: boolean
}): Command<{ data: { ok: boolean } }> {
  return cmd('POST', '/report-studio/widget-presets', undefined, body)
}

/** Update a preset. Admin only. */
export function updateReportWidgetPreset(
  presetId: number,
  body: Partial<Omit<ReportWidgetPreset, 'id'>> & { sort?: number; is_active?: boolean }
): Command<{ data: { ok: boolean } }> {
  return cmd('PATCH', `/report-studio/widget-presets/${presetId}`, undefined, body)
}

/** Delete a preset. Admin only. */
export function deleteReportWidgetPreset(presetId: number): Command<{ data: { ok: boolean } }> {
  return cmd('DELETE', `/report-studio/widget-presets/${presetId}`)
}

// ─── Pipeline template versions & impact preview ──────────────────────────────

export interface PipelineVersionEntry {
  id: number
  version: number
  note: string | null
  created_at: ISODate
  created_by_name: string | null
}

/** Config snapshots for a workflow/pipeline template (newest first). Admin only. */
export function listPipelineVersions(
  templateId: string
): Command<{ data: PipelineVersionEntry[] }> {
  return cmd('GET', `/pipelines/${templateId}/versions`)
}

/** One version with its parsed snapshot ({ template, states, transitions, bindings }). */
export function readPipelineVersion(
  templateId: string,
  versionId: number
): Command<{ data: PipelineVersionEntry & { snapshot: Record<string, unknown> } }> {
  return cmd('GET', `/pipelines/${templateId}/versions/${versionId}`)
}

/** Restore a template config version. Id-preserving — states/bindings are never
 *  deleted; a 'before restore' version is captured first. Admin only. */
export function restorePipelineVersion(
  templateId: string,
  versionId: number
): Command<{ data: Record<string, unknown> }> {
  return cmd('POST', `/pipelines/${templateId}/versions/${versionId}/restore`)
}

export interface PipelineImpactResult {
  state: { id: string; label: string | null }
  evaluated: number
  truncated: boolean
  now_skipped: number
  now_required: number
  changes: Array<{
    collection: string
    item: string
    current: boolean
    proposed: boolean
    proposed_reasons: string[]
  }>
}

/** Preview a proposed skip-criteria change against real records in active
 *  instances — returns only records whose skip decision flips. Admin only. */
export function simulatePipelineImpact(
  templateId: string,
  body: {
    state_id: string
    skip_criteria?: Record<string, unknown> | null
    skip_if_no_owners?: boolean
    limit?: number
  }
): Command<{ data: PipelineImpactResult }> {
  return cmd('POST', `/pipelines/${templateId}/simulate-impact`, undefined, body)
}

export interface ApprovalBrief {
  entered_at: ISODate
  days_in_state: number
  revisions: number
  field_changes: Array<{ field: string; old?: unknown; new: unknown }>
  changed_total: number
  comments: number
  addendums: { count: number; cost_impact: number }
  edited_by: string[]
}

/** What changed on a record since it entered its current state — the window an
 *  approver is signing off on. Null when the record has no workflow instance. */
export function readApprovalBrief(
  collection: string,
  item: string | number
): Command<{ data: ApprovalBrief | null }> {
  return cmd('GET', `/pipelines/instance/${collection}/${item}/approval-brief`)
}

/** Resolved owner display names per record id (one batched engine pass — feeds
 *  browser Owners columns). Max 500 ids. */
export function readStateOwnersBatch(
  collection: string,
  ids: Array<string | number>
): Command<{ data: Record<string, Array<{ id: string; name: string }>> }> {
  return cmd('POST', `/pipelines/instance/${collection}/owners/batch`, undefined, { ids })
}

// ─── Metric alert engine ──────────────────────────────────────────────────────

export interface MetricDefinition {
  id: number
  name: string
  description: string | null
  metric_key: string
  category: string
  unit: string
  default_operator: string
  default_threshold: number | null
  /** Admin callers only — omitted for everyone else. */
  metric_source?: Record<string, unknown>
  supported_filters: unknown
  status: string
  sort: number | null
}

export interface MetricAlertRule {
  id: number
  name: string
  definition_id: number
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'change_pct'
  threshold_value: number
  filters: unknown
  check_frequency: 'hourly' | 'daily' | 'weekly'
  is_shared: boolean
  status: 'active' | 'paused' | 'archived'
  created_by: UUID
  /** Joined definition summary on list reads. */
  definition?: {
    id: number
    name: string
    description: string | null
    category: string
    unit: string
  }
}

export interface MetricAlertSubscription {
  id: number
  rule_id: number
  user: UUID
  delivery_in_app: boolean
  delivery_email: boolean
  digest_frequency: 'immediate' | 'daily' | 'weekly'
  status: string
  rule_name?: string
  definition_name?: string
}

/** The metric catalog (active only unless an admin passes all). */
export function listMetricDefinitions(
  options: { all?: boolean } = {}
): Command<{ data: MetricDefinition[] }> {
  return cmd('GET', '/metric-alerts/definitions', options.all ? { all: '1' } : undefined)
}

/** Rules visible to the caller (shared or own). */
export function listMetricAlertRules(): Command<{ data: MetricAlertRule[] }> {
  return cmd('GET', '/metric-alerts/rules')
}

/** Create a rule (the creator is auto-subscribed, EFP behavior). */
export function createMetricAlertRule(body: {
  name: string
  definition_id: number
  threshold_value: number
  operator?: MetricAlertRule['operator']
  filters?: unknown
  check_frequency?: MetricAlertRule['check_frequency']
  is_shared?: boolean
  status?: MetricAlertRule['status']
}): Command<{ data: MetricAlertRule }> {
  return cmd('POST', '/metric-alerts/rules', undefined, body)
}

/** Update an own rule (admins may edit any). */
export function updateMetricAlertRule(
  id: number,
  body: Partial<Omit<MetricAlertRule, 'id' | 'created_by' | 'definition'>>
): Command<{ data: MetricAlertRule }> {
  return cmd('PATCH', `/metric-alerts/rules/${id}`, undefined, body)
}

/** Delete an own rule. Note: responds { ok: true }, not a data envelope. */
export function deleteMetricAlertRule(id: number): Command<{ ok: boolean }> {
  return cmd('DELETE', `/metric-alerts/rules/${id}`)
}

/** The caller's own subscriptions (with joined rule/definition summaries). */
export function listMetricAlertSubscriptions(): Command<{ data: MetricAlertSubscription[] }> {
  return cmd('GET', '/metric-alerts/subscriptions')
}

/** Subscribe to a shared (or own) rule — idempotent, returns the existing row. */
export function subscribeMetricAlert(body: {
  rule_id: number
  delivery_in_app?: boolean
  delivery_email?: boolean
  digest_frequency?: MetricAlertSubscription['digest_frequency']
}): Command<{ data: MetricAlertSubscription }> {
  return cmd('POST', '/metric-alerts/subscriptions', undefined, body)
}

export function updateMetricAlertSubscription(
  id: number,
  body: {
    delivery_in_app?: boolean
    delivery_email?: boolean
    digest_frequency?: MetricAlertSubscription['digest_frequency']
    status?: 'active' | 'paused'
  }
): Command<{ data: MetricAlertSubscription }> {
  return cmd('PATCH', `/metric-alerts/subscriptions/${id}`, undefined, body)
}

/** Unsubscribe. Note: responds { ok: true }, not a data envelope. */
export function unsubscribeMetricAlert(id: number): Command<{ ok: boolean }> {
  return cmd('DELETE', `/metric-alerts/subscriptions/${id}`)
}

/** Firing log for rules the caller can see (newest first, cap 500). */
export function readMetricAlertLog(
  options: { limit?: number } = {}
): Command<{ data: Array<Record<string, unknown>> }> {
  return cmd('GET', '/metric-alerts/log', options.limit ? { limit: options.limit } : undefined)
}

export interface AnomalyDefinition {
  id: number
  key: string
  name: string
  description: string | null
  category: string
  /** Admin callers only. */
  config?: Record<string, unknown>
  /** Public scope picker spec: [{key, label, collection?, value_field?, label_field?, sort?}] */
  scope_options: unknown
  sensitivity_hints: unknown
  status: string
}

export interface AnomalyRule {
  id: number
  name: string
  definition_id: number
  sensitivity: 'low' | 'medium' | 'high'
  scopes: unknown
  check_frequency: 'daily' | 'weekly'
  delivery_in_app: boolean
  delivery_email: boolean
  status: 'active' | 'paused'
  created_by: UUID
  definition?: { id: number; key: string; name: string; description: string | null }
}

/** The anomaly detector catalog (active only unless an admin passes all). */
export function listAnomalyDefinitions(
  options: { all?: boolean } = {}
): Command<{ data: AnomalyDefinition[] }> {
  return cmd('GET', '/metric-alerts/anomaly-definitions', options.all ? { all: '1' } : undefined)
}

export function listAnomalyRules(): Command<{ data: AnomalyRule[] }> {
  return cmd('GET', '/metric-alerts/anomaly-rules')
}

export function createAnomalyRule(body: {
  name: string
  definition_id: number
  sensitivity?: AnomalyRule['sensitivity']
  scopes?: unknown
  check_frequency?: AnomalyRule['check_frequency']
  delivery_in_app?: boolean
  delivery_email?: boolean
  status?: AnomalyRule['status']
}): Command<{ data: AnomalyRule }> {
  return cmd('POST', '/metric-alerts/anomaly-rules', undefined, body)
}

/** Update an own anomaly rule (admins may edit any). */
export function updateAnomalyRule(
  id: number,
  body: Partial<Omit<AnomalyRule, 'id' | 'created_by' | 'definition'>>
): Command<{ data: AnomalyRule }> {
  return cmd('PATCH', `/metric-alerts/anomaly-rules/${id}`, undefined, body)
}

/** Delete an own anomaly rule. Note: responds { ok: true }, not a data envelope. */
export function deleteAnomalyRule(id: number): Command<{ ok: boolean }> {
  return cmd('DELETE', `/metric-alerts/anomaly-rules/${id}`)
}

/** Detection log (newest first, cap 500); stats_snapshot comes back parsed. */
export function readAnomalyLog(
  options: { limit?: number } = {}
): Command<{ data: Array<Record<string, unknown>> }> {
  return cmd(
    'GET',
    '/metric-alerts/anomaly-log',
    options.limit ? { limit: options.limit } : undefined
  )
}

/** Acknowledge or resolve a detection. */
export function updateAnomalyLogEntry(
  id: number,
  status: 'acknowledged' | 'resolved'
): Command<{ data: Record<string, unknown> }> {
  return cmd('PATCH', `/metric-alerts/anomaly-log/${id}`, undefined, { status })
}

// ─── Scope dimension registry ─────────────────────────────────────────────────

export interface ScopeDimension {
  id: number
  name: string
  label: string
  target_collection: string
  display_field: string | null
  options_sort: string | null
  overrides: Record<string, string[]> | null
  exclusions: string[] | null
  strict: boolean
  is_active: boolean
}

/** The full dimension registry (authenticated; includes inactive rows). */
export function listScopeDimensions(): Command<{ data: ScopeDimension[] }> {
  return cmd('GET', '/scope-dimensions')
}

// NOTE: there is no GET /scope-dimensions/:id single-read route — read one from
// the list. Coverage below is the only per-dimension read.

/** Live coverage preview: how the dimension resolves on every business
 *  collection (self / auto / override / excluded / unreachable). Admin only. */
export function readScopeDimensionCoverage(id: number): Command<{
  data: Array<{
    collection: string
    status: 'self' | 'auto' | 'override' | 'excluded' | 'unreachable'
    route: string | null
    hops: unknown
  }>
}> {
  return cmd('GET', `/scope-dimensions/${id}/coverage`)
}

// ─── Staged imports ───────────────────────────────────────────────────────────

export interface StagedImportRun {
  id: number
  definition: number | null
  import_key: string
  status: 'queued' | 'running' | 'completed' | 'error' | 'canceled'
  sort: number
  file: UUID | null
  row_count: number | null
  duration: number | null
  logs: string | null
  started_at: ISODate | null
  finished_at: ISODate | null
  created_by: UUID | null
  created_at: ISODate
  updated_at: ISODate | null
  legacy_id: number | null
  definition_label: string | null
  staging_table: string | null
  procedure: string | null
  loader: string | null
  definition_active: boolean | null
  file_name: string | null
  file_size: number | null
  created_by_first_name: string | null
  created_by_last_name: string | null
  created_by_email: string | null
}

export interface StagedImportStats {
  window_days: number
  by_status: Record<string, number>
  total: number
  all_time_total: number
  by_key: Record<string, number>
  rows_imported: number
  median_duration: number | null
  success_rate: number | null
  runs_today: number
  active: Array<{
    id: number
    import_key: string
    status: string
    started_at: ISODate | null
    created_at: ISODate
    row_count: number | null
  }>
}

export interface ImportDefinition {
  id: number
  key: string
  label: string | null
  description: string | null
  staging_table: string | null
  procedure: string | null
  loader: 'bulk' | 'insert' | null
  sort: number
  is_active: boolean
  staging_columns?: unknown
  validation?: unknown
  procedure_body?: string | null
}

/** Paged staged-import runs. `days=0`/absent means all time; `status` accepts a
 *  comma list; `search` matches key / definition label / file name / run id. */
export function listStagedImports(
  options: {
    search?: string
    page?: number
    days?: number
    status?: string
    key?: string
    limit?: number
  } = {}
): Command<{ data: StagedImportRun[]; total: number; page: number; limit: number }> {
  return cmd('GET', '/staged-imports/', options)
}

/** Windowed aggregate stats (counts, success rate, live queue). `days=0` = all time. */
export function readStagedImportStats(days?: number): Command<{ data: StagedImportStats }> {
  return cmd('GET', '/staged-imports/stats', days != null ? { days } : undefined)
}

export function readStagedImport(id: number): Command<{ data: StagedImportRun }> {
  return cmd('GET', `/staged-imports/${id}`)
}

// previewStagedImport (POST /staged-imports/preview) and queueStagedImport
// (POST /staged-imports/) are MULTIPART file uploads — SDK request bodies are
// JSON-only, so these go through the host's own fetch (Import Console
// precedent: useApiFetchConfig + raw fetch).

/** Re-queue a finished or failed run without re-uploading its file. Admin only. */
export function requeueStagedImport(id: number): Command<{ data: { id: number; status: string } }> {
  return cmd('POST', `/staged-imports/${id}/requeue`)
}

/** Stop a run that hasn't started, or clear one wedged in `running`. Admin only. */
export function cancelStagedImport(id: number): Command<{ data: { id: number; status: string } }> {
  return cmd('POST', `/staged-imports/${id}/cancel`)
}

/** Import definitions (active only unless `all`). */
export function listImportDefinitions(
  options: { all?: boolean } = {}
): Command<{ data: ImportDefinition[] }> {
  return cmd('GET', '/staged-imports/definitions', options.all ? { all: 'true' } : undefined)
}

/** Register a new import definition. Admin only. */
export function createImportDefinition(data: {
  key: string
  label?: string
  description?: string
  staging_table?: string
  procedure?: string
  loader?: 'bulk' | 'insert'
  sort?: number
}): Command<{ data: ImportDefinition }> {
  return cmd('POST', '/staged-imports/definitions', undefined, data)
}

/** Update a definition (config fields accept objects or JSON strings). Admin only. */
export function updateImportDefinition(
  id: number,
  data: Partial<Omit<ImportDefinition, 'id' | 'key'>>
): Command<{ data: ImportDefinition }> {
  return cmd('PATCH', `/staged-imports/definitions/${id}`, undefined, data)
}

/** The LIVE procedure body from SQL Server vs the stored one (+ hashes). Admin only. */
export function readImportProcedure(id: number): Command<{
  data: {
    procedure: string
    live_body: string | null
    stored_body: string | null
    deployed_hash: string | null
    stored_hash: string | null
  }
}> {
  return cmd('GET', `/staged-imports/definitions/${id}/procedure`)
}

/** Deploy the stored procedure body via CREATE OR ALTER (scoped to the
 *  definition's own procedure name). Admin only. */
export function deployImportProcedure(
  id: number
): Command<{ data: { deployed: boolean; hash: string } }> {
  return cmd('POST', `/staged-imports/definitions/${id}/deploy`)
}

/** Definition version history (proc body + schema + validation together). Admin only. */
export function listImportDefinitionVersions(id: number): Command<{
  data: Array<{
    id: number
    version: number
    note: string | null
    created_by: UUID | null
    created_at: ISODate
  }>
}> {
  return cmd('GET', `/staged-imports/definitions/${id}/versions`)
}

/** Restore a definition version (captures a 'before restore' version first). Admin only. */
export function restoreImportDefinitionVersion(
  id: number,
  versionId: number
): Command<{ data: ImportDefinition }> {
  return cmd('POST', `/staged-imports/definitions/${id}/versions/${versionId}/restore`)
}

/** Regex-mine the live procedure for join/merge patterns and prefill a
 *  validation config for review — nothing is saved. Admin only. */
export function suggestImportValidation(id: number): Command<{
  data: {
    suggestion: {
      key_columns: string[]
      target_table?: string
      lookups: Array<{ column: string; collection: string; match_field: string }>
    }
    procedure: string
    note: string
  }
}> {
  return cmd('POST', `/staged-imports/definitions/${id}/suggest-validation`)
}

// ─── Access audits ────────────────────────────────────────────────────────────

export interface AccessAuditSubject {
  type: 'field' | 'pipeline_owners'
  field?: string
  label: string
}

export interface AccessAuditRun {
  id: number
  audit: number
  status: 'running' | 'completed' | 'error'
  checked_records?: number
  checked_pairs?: number
  violation_count?: number
  truncated?: boolean
  error?: string | null
  triggered_by: UUID | null
  started_at: ISODate
  finished_at?: ISODate | null
}

export interface AccessAudit {
  id: number
  name: string
  collection: string
  subjects: AccessAuditSubject[]
  is_active: boolean
  sort: number
  latest_run?: AccessAuditRun | null
}

export interface AccessAuditFinding {
  id: number
  collection: string
  item_id: string
  item_label: string | null
  user: UUID
  subject: string
  reasons: string[]
  user_email: string | null
  first_name: string | null
  last_name: string | null
  last_access: ISODate | null
}

/** Audit definitions with each one's latest run. Admin only (all routes here). */
export function listAccessAudits(): Command<{ data: AccessAudit[] }> {
  return cmd('GET', '/access-audits/')
}

export function createAccessAudit(data: {
  collection: string
  subjects: AccessAuditSubject[]
  name?: string
}): Command<{ data: AccessAudit }> {
  return cmd('POST', '/access-audits/', undefined, data)
}

export function updateAccessAudit(
  id: number,
  data: Partial<{
    name: string
    collection: string
    subjects: AccessAuditSubject[]
    is_active: boolean
  }>
): Command<{ data: AccessAudit }> {
  return cmd('PATCH', `/access-audits/${id}`, undefined, data)
}

export function deleteAccessAudit(id: number): Command<{ data: { deleted: boolean } }> {
  return cmd('DELETE', `/access-audits/${id}`)
}

/** Start a run (fire-and-forget — poll listAccessAuditRuns; 409 while one runs). */
export function runAccessAudit(id: number): Command<{ data: AccessAuditRun }> {
  return cmd('POST', `/access-audits/${id}/run`)
}

/** Run history for an audit (newest first, capped 30). */
export function listAccessAuditRuns(id: number): Command<{ data: AccessAuditRun[] }> {
  return cmd('GET', `/access-audits/${id}/runs`)
}

/** Paged findings for a run; filter by user id or search item label/id/email. */
export function readAccessAuditFindings(
  runId: number,
  options: { page?: number; limit?: number; user?: string; search?: string } = {}
): Command<{ data: AccessAuditFinding[]; total: number }> {
  return cmd('GET', `/access-audits/runs/${runId}/findings`, options)
}

// ─── Coverage gaps ────────────────────────────────────────────────────────────

export interface CoverageGapOwner {
  id: string
  name: string
  reason: 'suspended' | 'inactive' | 'redacted' | 'ooo_no_delegate'
}

export interface CoverageGapItem {
  collection: string
  item: string
  label: string
  state: string | null
  template: string
  kind: 'all_unavailable' | 'no_owners'
  owners: CoverageGapOwner[]
}

export interface CoverageGapReport {
  open_instances: number
  evaluated: number
  truncated: boolean
  blocked: CoverageGapItem[]
  no_owner_count: number
  by_user: Array<{
    id: string
    name: string
    reason: CoverageGapOwner['reason']
    blocked_count: number
  }>
}

/** Records whose entire resolved owner set cannot act (computed live). Admin only. */
export function readCoverageGaps(): Command<{ data: CoverageGapReport }> {
  return cmd('GET', '/coverage-gaps')
}

// ─── Integration health ───────────────────────────────────────────────────────

export interface IntegrationApiHealth {
  id: number
  name: string
  base_url: string | null
  auth_type: string | null
  totals: Record<string, number>
  last_success_at: ISODate | null
  last_activity_at: ISODate | null
  window_24h: Record<string, number>
  last_failure: {
    error: string | null
    at: ISODate
    collection: string
    item: string
  } | null
}

/** Per-external-API push outcomes + flow-run counts + the cron roster. Admin only. */
export function readIntegrationHealth(): Command<{
  data: {
    apis: IntegrationApiHealth[]
    crons: Array<Record<string, unknown>>
    dead_letters_24h: number
    flow_runs_24h: Record<string, number>
  }
}> {
  return cmd('GET', '/integration-health')
}
