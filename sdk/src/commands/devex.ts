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
