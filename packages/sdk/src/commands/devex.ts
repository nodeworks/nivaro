/**
 * Developer-experience commands: dev-tools exports, webhook deliveries,
 * persisted GraphQL queries, saved views, global search, API keys,
 * data-quality rules/runs, API analytics, dead letters.
 */
import { type Command, cmd } from '../command.js'
import type { ISODate, UUID } from '../index.js'

// ─── Dev tools ────────────────────────────────────────────────────────────────

/** Postman collection JSON for the items API (admin). */
export function getPostmanCollection(): Command<Record<string, unknown>> {
  return cmd('GET', '/dev-tools/postman.json')
}

/** Bruno collection JSON for the items API (admin). */
export function getBrunoCollection(): Command<Record<string, unknown>> {
  return cmd('GET', '/dev-tools/bruno.json')
}

// ─── Webhook deliveries ───────────────────────────────────────────────────────

export interface WebhookDelivery {
  id: number
  webhook: number
  event: string
  status: number | null
  success: boolean
  attempt: number
  request_body: string | null
  response_body: string | null
  duration_ms: number | null
  created_at: ISODate
}

/** Paginated delivery log for a webhook (admin). */
export function listWebhookDeliveries(
  webhookId: number,
  query?: { limit?: number; offset?: number }
): Command<{ data: WebhookDelivery[]; total: number; limit: number; offset: number }> {
  const params: Record<string, unknown> = {}
  if (query?.limit != null) params.limit = query.limit
  if (query?.offset != null) params.offset = query.offset
  return cmd('GET', `/webhooks/${webhookId}/deliveries`, params)
}

/** Re-dispatch a stored delivery payload (re-signed). */
export function retryWebhookDelivery(deliveryId: number): Command<{ data: unknown }> {
  return cmd('POST', `/webhooks/deliveries/${deliveryId}/retry`)
}

/** Replay an activity event — re-fires matching webhooks + extension flow triggers. */
export function replayActivityEvent(activityId: number): Command<{
  data: { replayed: boolean; activity: number; collection: string; event: string }
}> {
  return cmd('POST', `/webhooks/replay/${activityId}`)
}

// ─── Persisted GraphQL queries ────────────────────────────────────────────────

export interface PersistedQuery {
  id: number
  hash: string
  name: string
  query: string
  created_by: UUID
  created_at: ISODate
}

export function listPersistedQueries(): Command<{ data: PersistedQuery[] }> {
  return cmd('GET', '/persisted-queries')
}

export function readPersistedQuery(id: number): Command<{ data: PersistedQuery }> {
  return cmd('GET', `/persisted-queries/${id}`)
}

/** Create a persisted query — the sha256 hash is computed server-side. */
export function createPersistedQuery(body: {
  name: string
  query: string
}): Command<{ data: PersistedQuery }> {
  return cmd('POST', '/persisted-queries', undefined, body)
}

export function updatePersistedQuery(
  id: number,
  body: Partial<{ name: string; query: string }>
): Command<{ data: PersistedQuery }> {
  return cmd('PATCH', `/persisted-queries/${id}`, undefined, body)
}

export function deletePersistedQuery(id: number): Command<void> {
  return cmd('DELETE', `/persisted-queries/${id}`)
}

// ─── Saved views ──────────────────────────────────────────────────────────────

export interface SavedView {
  id: number
  collection: string
  name: string
  filters: unknown | null
  sort: unknown | null
  columns: string[] | null
  user: UUID
  is_shared: boolean
  role: UUID | null
  created_at: ISODate
}

/** Own + shared (role-matched) views for a collection. */
export function listSavedViews(collection: string): Command<{ data: SavedView[] }> {
  return cmd('GET', '/saved-views', { collection })
}

export function createSavedView(body: {
  collection: string
  name: string
  filters?: unknown
  sort?: unknown
  columns?: string[]
  is_shared?: boolean
  role?: string | null
}): Command<{ data: SavedView }> {
  return cmd('POST', '/saved-views', undefined, body)
}

export function updateSavedView(
  id: number,
  body: Partial<{
    name: string
    filters: unknown
    sort: unknown
    columns: string[]
    is_shared: boolean
    role: string | null
  }>
): Command<{ data: SavedView }> {
  return cmd('PATCH', `/saved-views/${id}`, undefined, body)
}

export function deleteSavedView(id: number): Command<void> {
  return cmd('DELETE', `/saved-views/${id}`)
}

// ─── Global search ────────────────────────────────────────────────────────────

export interface GlobalSearchRecord {
  collection: string
  id: string | number
  label: string
  snippet: string
}

export interface GlobalSearchResults {
  records: GlobalSearchRecord[]
  pages: Array<{ label: string; path: string }>
  actions: Array<{ label: string; path: string }>
}

/** Search records (permission-scoped), admin pages, and quick actions. */
export function globalSearch(q: string): Command<{ data: GlobalSearchResults }> {
  return cmd('GET', '/global-search', { q })
}

// ─── API keys (admin) ─────────────────────────────────────────────────────────

export interface ApiKeyScope {
  collection: string
  actions: string[]
}

export interface ApiKey {
  id: number
  name: string
  prefix: string
  user: UUID
  scopes: ApiKeyScope[]
  expires_at: ISODate | null
  rate_limit_per_minute: number | null
  ip_allowlist: string[]
  is_active: boolean
  created_at: ISODate
}

export function listApiKeys(): Command<{ data: ApiKey[] }> {
  return cmd('GET', '/api-keys')
}

export function readApiKey(id: number): Command<{ data: ApiKey }> {
  return cmd('GET', `/api-keys/${id}`)
}

/**
 * Create an API key. The full `nvk_…` key is returned exactly once —
 * store it immediately; only the prefix is retrievable afterwards.
 */
export function createApiKey(body: {
  name: string
  user?: string
  scopes?: ApiKeyScope[]
  expires_at?: string | null
  rate_limit_per_minute?: number | null
  ip_allowlist?: string[] | null
}): Command<{ data: ApiKey & { key: string } }> {
  return cmd('POST', '/api-keys', undefined, body)
}

/** Update key metadata — the key itself is immutable. */
export function updateApiKey(
  id: number,
  body: Partial<{
    name: string
    scopes: ApiKeyScope[]
    expires_at: string | null
    rate_limit_per_minute: number | null
    ip_allowlist: string[] | null
    is_active: boolean
  }>
): Command<{ data: ApiKey }> {
  return cmd('PATCH', `/api-keys/${id}`, undefined, body)
}

/** Soft-revoke — keeps the row for auditing. */
export function revokeApiKey(id: number): Command<{ data: ApiKey }> {
  return cmd('POST', `/api-keys/${id}/revoke`)
}

export function deleteApiKey(id: number): Command<{ ok: boolean }> {
  return cmd('DELETE', `/api-keys/${id}`)
}

// ─── Data quality (admin) ─────────────────────────────────────────────────────

export type DataQualityRuleType = 'not_null' | 'regex' | 'range' | 'unique' | 'formula'
export type DataQualitySeverity = 'low' | 'medium' | 'high' | 'critical'

export interface DataQualityRule {
  id: number
  collection: string
  name: string
  rule_type: DataQualityRuleType
  field: string | null
  config: Record<string, unknown> | null
  severity: DataQualitySeverity
  is_active: boolean
  created_at: ISODate
}

export interface DataQualityRuleResult {
  rule_id: number
  name: string
  severity: string
  rule_type: string
  field: string | null
  failed_count: number
  sample_ids: (string | number)[]
  error?: string
}

export interface DataQualityRun {
  id: number
  collection: string
  started_at: ISODate
  finished_at: ISODate
  total_records: number
  failed_records: number
  results: DataQualityRuleResult[]
  created_by: UUID
}

export function listDataQualityRules(collection?: string): Command<{ data: DataQualityRule[] }> {
  return cmd('GET', '/data-quality/rules', collection ? { collection } : undefined)
}

export function createDataQualityRule(body: {
  collection: string
  name: string
  rule_type: DataQualityRuleType
  field?: string | null
  config?: Record<string, unknown> | null
  severity?: DataQualitySeverity
  is_active?: boolean
}): Command<{ data: DataQualityRule }> {
  return cmd('POST', '/data-quality/rules', undefined, body)
}

export function updateDataQualityRule(
  id: number,
  body: Partial<{
    name: string
    rule_type: DataQualityRuleType
    field: string | null
    config: Record<string, unknown> | null
    severity: DataQualitySeverity
    is_active: boolean
  }>
): Command<{ data: DataQualityRule }> {
  return cmd('PATCH', `/data-quality/rules/${id}`, undefined, body)
}

export function deleteDataQualityRule(id: number): Command<void> {
  return cmd('DELETE', `/data-quality/rules/${id}`)
}

/** Execute all active rules against a collection; persists + returns the run. */
export function runDataQuality(collection: string): Command<{ data: DataQualityRun }> {
  return cmd('POST', `/data-quality/run/${collection}`)
}

export function listDataQualityRuns(collection?: string): Command<{ data: DataQualityRun[] }> {
  return cmd('GET', '/data-quality/runs', collection ? { collection } : undefined)
}

export function readDataQualityRun(id: number): Command<{ data: DataQualityRun }> {
  return cmd('GET', `/data-quality/runs/${id}`)
}

// ─── API analytics (admin) ────────────────────────────────────────────────────

export interface ApiAnalyticsSummary {
  total: number
  error_rate: number
  p50: number
  p95: number
  avg_latency: number
}

export interface ApiAnalyticsBucket {
  bucket: ISODate
  count: number
  avg_latency: number
  errors: number
}

export interface ApiAnalyticsPath {
  method: string
  path: string
  count: number
  avg_latency: number
  errors: number
}

export interface ApiAnalyticsCollection {
  collection: string
  count: number
  avg_latency: number
}

export interface ApiErrorLog {
  id: number
  method: string
  path: string
  status: number
  latency_ms: number
  collection: string | null
  user: UUID | null
  created_at: ISODate
}

/** Totals, error rate, and latency percentiles over the last `hours` (default 24). */
export function readApiAnalyticsSummary(hours?: number): Command<{ data: ApiAnalyticsSummary }> {
  return cmd('GET', '/api-analytics/summary', hours != null ? { hours } : undefined)
}

/** Hourly request buckets. */
export function readApiAnalyticsTimeseries(
  hours?: number
): Command<{ data: ApiAnalyticsBucket[] }> {
  return cmd('GET', '/api-analytics/timeseries', hours != null ? { hours } : undefined)
}

/** Top 20 paths by request count. */
export function readApiAnalyticsTopPaths(hours?: number): Command<{ data: ApiAnalyticsPath[] }> {
  return cmd('GET', '/api-analytics/top-paths', hours != null ? { hours } : undefined)
}

/** Top 20 collections by request count. */
export function readApiAnalyticsTopCollections(
  hours?: number
): Command<{ data: ApiAnalyticsCollection[] }> {
  return cmd('GET', '/api-analytics/top-collections', hours != null ? { hours } : undefined)
}

/** Latest 50 error (status >= 400) responses. */
export function readApiAnalyticsErrors(): Command<{ data: ApiErrorLog[] }> {
  return cmd('GET', '/api-analytics/errors')
}

// ─── Dead letters (admin) ─────────────────────────────────────────────────────

export interface DeadLetter {
  id: string
  function: string
  event: string
  error: string
  payload: Record<string, unknown> | null
  failed_at: string
  retry_count: number
  source: 'flow-run' | 'inngest'
}

/** Failed flow runs + Inngest failures (best-effort). */
export function listDeadLetters(): Command<{ data: DeadLetter[]; error?: string }> {
  return cmd('GET', '/dead-letters')
}

/** Re-run a failed job. */
export function retryDeadLetter(
  runId: string
): Command<{ data: { ok: boolean; retried: string } }> {
  return cmd('POST', `/dead-letters/${runId}/retry`)
}

// ─── Collection layouts ───────────────────────────────────────────────────────

export interface CollectionLayout {
  id: number
  collection: string
  name: string
  is_active: boolean | number
  sort: number
  created_at: string
  // Layout behaviour
  tab_mode?: 'tabs' | 'steps'
  validate_before_next?: boolean | number
  summary_enabled?: boolean | number
  summary_show_all?: boolean | number
  ai_enabled?: boolean | number
  disable_comments?: boolean | number
  disable_tasks?: boolean | number
  // Conditional layout: only activates for users with these roles
  conditions?: { role_ids?: string[] } | null
}

export interface LayoutAssignment {
  field: string
  group_key: string | null
  sort: number
  // Slot sentinel fields (present when field is __pipeline__, __comments__, __tasks__)
  label_override?: string | null
  is_visible?: boolean | number
  default_expanded?: boolean | number
}

export interface LayoutGroup {
  id: number
  collection: string
  key: string
  label: string
  type: 'section' | 'tab' | 'metadata'
  icon: string | null
  sort: number
  is_collapsed: boolean | number
  layout_id: number
}

export type PageSlotKey = '__pipeline__' | '__comments__' | '__tasks__'

/** Check if an assignment is a page slot sentinel. */
export function isPageSlot(
  assignment: LayoutAssignment
): assignment is LayoutAssignment & { field: PageSlotKey } {
  return (
    assignment.field === '__pipeline__' ||
    assignment.field === '__comments__' ||
    assignment.field === '__tasks__'
  )
}

/** List all layouts for a collection. */
export function readCollectionLayouts(collection: string): Command<{ data: CollectionLayout[] }> {
  return cmd('GET', '/collection-layouts', { collection })
}

/** Read the active layout for a collection with groups + assignments. */
export function readActiveLayout(collection: string): Command<{
  data: { layout: CollectionLayout; groups: LayoutGroup[]; assignments: LayoutAssignment[] }
}> {
  return cmd('GET', '/collection-layouts/active', { collection })
}

/** Read groups for a specific layout by collection + layout id. */
export function readLayoutGroups(
  collection: string,
  layoutId: number
): Command<{ data: LayoutGroup[] }> {
  return cmd('GET', `/field-groups/${collection}`, { layout_id: layoutId })
}

/** Read field assignments for a specific layout. */
export function readLayoutAssignments(layoutId: number): Command<{ data: LayoutAssignment[] }> {
  return cmd('GET', `/collection-layouts/${layoutId}/assignments`)
}

/** Activate a layout (deactivates all others for the collection). */
export function activateLayout(layoutId: number): Command<{ data: CollectionLayout }> {
  return cmd('POST', `/collection-layouts/${layoutId}/activate`)
}

/** Clone a layout under a new name. */
export function cloneLayout(layoutId: number, name: string): Command<{ data: CollectionLayout }> {
  return cmd('POST', `/collection-layouts/${layoutId}/clone`, undefined, { name })
}

/** Create a new layout for a collection. */
export function createCollectionLayout(
  collection: string,
  name: string
): Command<{ data: CollectionLayout }> {
  return cmd('POST', '/collection-layouts', undefined, { collection, name })
}

/** Update layout behaviour/metadata. */
export function updateCollectionLayout(
  layoutId: number,
  patch: Partial<
    Pick<
      CollectionLayout,
      | 'name'
      | 'sort'
      | 'tab_mode'
      | 'validate_before_next'
      | 'summary_enabled'
      | 'summary_show_all'
      | 'ai_enabled'
      | 'disable_comments'
      | 'disable_tasks'
      | 'conditions'
    >
  >
): Command<{ data: CollectionLayout }> {
  return cmd('PATCH', `/collection-layouts/${layoutId}`, undefined, patch)
}

export function deleteCollectionLayout(layoutId: number): Command<void> {
  return cmd('DELETE', `/collection-layouts/${layoutId}`)
}

/** Bulk-replace a layout's field→group assignments (and slot sentinels). */
export function updateLayoutAssignments(
  layoutId: number,
  assignments: Array<{
    field: string
    group_key: string | null
    sort: number
    label_override?: string | null
    is_visible?: boolean
    default_expanded?: boolean
  }>
): Command<{ data: LayoutAssignment[] }> {
  return cmd('PUT', `/collection-layouts/${layoutId}/assignments`, undefined, { assignments })
}

// ─── Internal dashboard widgets ───────────────────────────────────────────────

export interface InternalWidget {
  id: number
  name: string
  description: string | null
  icon: string | null
  widget_type: string
  inputs: unknown
  config: unknown
  is_active: boolean
}

export function listInternalWidgets(): Command<{ data: InternalWidget[] }> {
  return cmd('GET', '/widgets-internal')
}

export function readInternalWidget(id: number): Command<{ data: InternalWidget }> {
  return cmd('GET', `/widgets-internal/${id}`)
}

export function createInternalWidget(
  data: Partial<Omit<InternalWidget, 'id'>> & { name: string; widget_type: string }
): Command<{ data: InternalWidget }> {
  return cmd('POST', '/widgets-internal', undefined, data)
}

export function updateInternalWidget(
  id: number,
  data: Partial<Omit<InternalWidget, 'id'>>
): Command<{ data: InternalWidget }> {
  return cmd('PATCH', `/widgets-internal/${id}`, undefined, data)
}

export function deleteInternalWidget(id: number): Command<{ data: { success: boolean } }> {
  return cmd('DELETE', `/widgets-internal/${id}`)
}

/** Resolve a widget's display data for a set of input values. */
export function renderInternalWidget(
  id: number,
  data: {
    inputs?: Record<string, unknown>
    draft?: Record<string, unknown>
    bindings?: unknown[]
    item_collection?: string
  } = {}
): Command<{ data: Record<string, unknown> }> {
  return cmd('POST', `/widgets-internal/${id}/render`, undefined, data)
}

/** Invoke a widget button action (field-update / toggle / flow / navigate). */
export function invokeInternalWidgetAction(
  id: number,
  data: { button_index: number; inputs?: Record<string, unknown> }
): Command<{ data: Record<string, unknown> }> {
  return cmd('POST', `/widgets-internal/${id}/action`, undefined, data)
}

// ─── Extension-registered item & bulk actions ─────────────────────────────────

export interface RegisteredAction {
  id: string
  label: string
  collection?: string | null
  description?: string | null
  [key: string]: unknown
}

/** Item actions registered by extensions (optionally scoped to a collection). */
export function listItemActions(collection?: string): Command<{ data: RegisteredAction[] }> {
  return cmd('GET', '/item-actions/registered', collection ? { collection } : undefined)
}

/** Execute an extension-registered item action against one record. */
export function executeItemAction(
  actionId: string,
  data: { collection: string; itemId: string | number; payload?: Record<string, unknown> }
): Command<{ data: unknown }> {
  return cmd('POST', `/item-actions/${actionId}/execute`, undefined, data)
}

/** Bulk actions registered by extensions (optionally scoped to a collection). */
export function listBulkActions(collection?: string): Command<{ data: RegisteredAction[] }> {
  return cmd('GET', '/bulk-actions/registered', collection ? { collection } : undefined)
}

/** Execute an extension-registered bulk action against many records. */
export function executeBulkAction(
  actionId: string,
  data: { collection: string; ids: Array<string | number>; payload?: Record<string, unknown> }
): Command<{ data: unknown }> {
  return cmd('POST', `/bulk-actions/${actionId}/execute`, undefined, data)
}

// ─── Deploy preflight (admin) ─────────────────────────────────────────────────

export type PreflightSeverity = 'ok' | 'warn' | 'fail'

export interface PreflightCheck {
  id: string
  status: PreflightSeverity
  /** One plain sentence for the operator. */
  summary: string
  detail?: Record<string, unknown>
}

export interface PreflightReport {
  status: PreflightSeverity
  version: string
  environment: string
  checks: PreflightCheck[]
  ts: ISODate
}

/**
 * Deploy coherence check: migrations (both directions), db/redis reachability,
 * required extensions, version pinning. Responds 503 when status is 'fail' so
 * CI can branch on the status code alone.
 */
export function readPreflight(): Command<{ data: PreflightReport }> {
  return cmd('GET', '/preflight')
}

// ─── Cron administration (admin) ──────────────────────────────────────────────

export interface CronJob {
  id: string
  expression: string
  /** Set when the job was registered by an extension. */
  extensionId?: string
  nextRun: ISODate | null
}

/** All scheduled jobs (core + extension-registered). */
export function listCronJobs(): Command<{ data: CronJob[] }> {
  return cmd('GET', '/cron')
}

/** Run a scheduled job now, out of band. Resolves after the job completes. */
export function runCronJob(
  id: string
): Command<{ data: { id: string; ran: boolean; duration_ms: number } }> {
  return cmd('POST', `/cron/${id}/run`)
}

// ─── Request traces (admin) ───────────────────────────────────────────────────

export interface TraceSpan {
  seq: number
  phase: string
  ms: number
  /** Offset from request start (waterfall layout). */
  at: number
  detail?: string
}

export interface RequestTrace {
  id: string
  method: string
  route: string
  url: string
  status: number
  user: string | null
  total_ms: number
  spans: TraceSpan[]
  ts: string
  unaccounted_ms: number
}

/**
 * Slow-request traces from THIS replica's in-process ring buffer (requests
 * faster than TRACE_SLOW_MS are never recorded). `limit` caps at 200;
 * `route` is a substring filter.
 */
export function listTraces(query?: { limit?: number; route?: string }): Command<{
  data: {
    config: Record<string, unknown>
    traces: Array<RequestTrace & { slowest_phase: string | null }>
  }
}> {
  const params: Record<string, unknown> = {}
  if (query?.limit != null) params.limit = query.limit
  if (query?.route) params.route = query.route
  return cmd('GET', '/traces', params)
}

export function readTrace(id: string): Command<{ data: RequestTrace }> {
  return cmd('GET', `/traces/${id}`)
}

export function clearTraces(): Command<{ data: { cleared: boolean } }> {
  return cmd('DELETE', '/traces')
}

// ─── Environment config diff (admin) ──────────────────────────────────────────

export interface ConfigTableClassification {
  config: string[]
  derived: string[]
  runtime: string[]
  /** Present in the database but in none of the lists — a new migration. */
  unclassified: string[]
  /** Classified but absent from this database — an older instance. */
  absent: string[]
}

export interface ConfigSnapshot {
  format: 1
  generated_at: string
  instance: { version: string; environment: string; database: string; label?: string }
  classification: ConfigTableClassification
  /** table → row id → hashed/serialized row. */
  tables: Record<string, Record<string, unknown>>
  /** Tables that were requested but could not be read, with the reason. */
  errors: Record<string, string>
}

/** What this instance considers configuration (with row counts), without shipping any of it. */
export function readConfigInventory(): Command<{
  data: {
    instance: { version: string; environment: string; database: string }
    classification: ConfigTableClassification
    counts: Record<string, number>
  }
}> {
  return cmd('GET', '/config-diff/inventory')
}

/**
 * Export this instance's config snapshot for comparison on another instance.
 * Secrets are DROPPED, not masked. Activity-logged.
 */
export function exportConfigSnapshot(options?: {
  label?: string
  /** Restrict to specific tables. */
  tables?: string[]
}): Command<{ data: ConfigSnapshot }> {
  const params: Record<string, unknown> = {}
  if (options?.label) params.label = options.label
  if (options?.tables?.length) params.tables = options.tables.join(',')
  return cmd('GET', '/config-diff/snapshot', params)
}

/**
 * Compare an uploaded snapshot (`theirs`) against this instance's live config
 * (`mine`). Body is the snapshot itself or `{snapshot}`. NOTE: real snapshots
 * are routinely far past 1MB — this route accepts bodies up to 128MB.
 */
export function compareConfigSnapshot(snapshot: unknown): Command<{ data: unknown }> {
  return cmd('POST', '/config-diff/compare', undefined, { snapshot })
}

// ─── Layout versions (admin) ──────────────────────────────────────────────────

export interface LayoutVersion {
  id: number
  version: number
  note: string | null
  created_at: ISODate
  created_by_name: string
}

/** Snapshot history for a layout (newest first, pruned to 30 server-side). */
export function listLayoutVersions(layoutId: number): Command<{ data: LayoutVersion[] }> {
  return cmd('GET', `/collection-layouts/${layoutId}/versions`)
}

/**
 * Restore a layout version — id-preserving; a "before restore" snapshot is
 * captured first so the restore itself is reversible.
 */
export function restoreLayoutVersion(
  layoutId: number,
  versionId: number
): Command<{ data: { restored_assignments: number; restored_groups: number } }> {
  return cmd('POST', `/collection-layouts/${layoutId}/versions/${versionId}/restore`)
}

// ─── Omnisearch ───────────────────────────────────────────────────────────────

export interface OmniSearchHit {
  collection: string
  collection_label: string
  id: string
  label: string
  score: number
  matched_field: string | null
}

/**
 * Cross-collection record search, resolved AS the requesting user (RBAC + RLS
 * + scopes). `q` must be at least 2 characters. Distinct from `globalSearch`
 * (the command palette route) and `semanticSearch` (vector similarity).
 */
export function omniSearch(
  q: string,
  options?: { collections?: string[]; limit?: number; per_collection?: number }
): Command<{
  data: OmniSearchHit[]
  meta: { searched: number; skipped: string[]; truncated: boolean }
}> {
  const params: Record<string, unknown> = { q }
  if (options?.collections?.length) params.collections = options.collections.join(',')
  if (options?.limit != null) params.limit = options.limit
  if (options?.per_collection != null) params.per_collection = options.per_collection
  return cmd('GET', '/search', params)
}

// ─── Flow test & replay ───────────────────────────────────────────────────────

export interface FlowTestStep {
  key: string
  name: string
  type: string
  status: 'resolve' | 'reject' | 'async'
  /** Rendered side-effect content when dry_run rendered instead of sending. */
  preview?: unknown
}

/**
 * Test-run a flow with a caller-supplied payload, regardless of active status.
 * dry_run defaults TRUE: side-effect ops (mail/webhook/…) render but do not
 * send. The run records in flow history with trigger 'test'.
 */
export function testFlow(
  flowId: string,
  body?: { payload?: Record<string, unknown>; dry_run?: boolean }
): Command<{
  data: {
    steps: FlowTestStep[]
    output: Record<string, unknown>
    error: string | null
    dry_run: boolean
  }
}> {
  return cmd('POST', `/flows/${flowId}/test`, undefined, body ?? {})
}

export interface FlowReplayResult {
  dry_run: boolean
  matched: number
  truncated: boolean
  skipped_deletes: number
  /** Dry run only: first 20 matched activity rows. */
  sample?: Array<{
    id: number
    collection: string
    action: string
    item: string
    timestamp: string
  }>
  /** Real run only. */
  executed?: number
  failed?: number
  missing?: number
}

/**
 * Replay an event-trigger flow over a historical window (admin) — re-executes
 * once per matching create/update in nivaro_activity. dry_run defaults TRUE
 * (count + sample first — replays fan out real side effects); the payload is
 * the record's CURRENT row with `$replay: true`, deletes are skipped, and
 * before-timing flows are refused (400).
 */
export function replayFlow(
  flowId: string,
  body: {
    /** ISO datetime, required. */
    from: string
    /** ISO datetime, required — must be after `from`. */
    to: string
    /** Defaults to true. Pass false to actually execute. */
    dry_run?: boolean
    /** Max writes to replay, 1–1000 (default 500). */
    limit?: number
  }
): Command<{ data: FlowReplayResult }> {
  return cmd('POST', `/flows/${flowId}/replay`, undefined, body)
}

// ─── Masquerade (admin) ───────────────────────────────────────────────────────

/**
 * Mint a masquerade token (admin): a short-lived `nvm_…` Bearer token that
 * resolves to the target user for up to 4h, with RBAC/RLS genuinely running
 * as them. Activity-logged.
 */
export function startMasquerade(userId: string): Command<{
  data: {
    token: string
    user: { id: UUID; first_name: string | null; last_name: string | null; email: string }
  }
}> {
  return cmd('POST', '/auth/masquerade', undefined, { user_id: userId })
}

/**
 * Revoke the current masquerade session. MUST be called with the `nvm_` token
 * as the Bearer — 400 otherwise. Bare `{ok}` response, no data envelope.
 */
export function stopMasquerade(): Command<{ ok: boolean }> {
  return cmd('DELETE', '/auth/masquerade')
}
