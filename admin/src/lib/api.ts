import axios from 'axios'

export const WORKSPACE_KEY = 'nivaro_workspace'

export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' }
})

api.interceptors.request.use((config) => {
  const ws = localStorage.getItem(WORKSPACE_KEY)
  if (ws) config.headers['x-workspace'] = ws
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && window.location.pathname !== '/login') {
      const redirect = window.location.pathname + window.location.search
      window.location.href = `/login?redirect=${encodeURIComponent(redirect)}`
    }
    return Promise.reject(err)
  }
)

// ─── Typed helpers ────────────────────────────────────────────────────────────

export interface ApiList<T> {
  data: T[]
  total: number
  limit: number
  offset: number
}

export interface ApiItem<T> {
  data: T
}

export type User = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  role: string | null
  status: string
  static_token: string | null
  last_access: string | null
  created_at: string
  current_workspace: string | null
  manager_id: string | null
  delegate_id: string | null
  delegate_expires_at: string | null
  is_out_of_office: boolean
  is_admin?: boolean
}

export interface Workspace {
  id: string
  name: string
  slug: string
  icon: string | null
  color: string | null
  created_at: string
  updated_at: string
}

export interface CollectionPreset {
  id: string
  collection: string
  name: string
  user_id: string | null
  columns: string[]
  is_default: boolean
  created_at: string
}

export interface CollectionPresetsData {
  systemDefault: CollectionPreset | null
  presets: CollectionPreset[]
  activePresetId: string | null
}

export type Role = {
  id: string
  name: string
  description: string | null
  admin_access: boolean
  app_access: boolean
}

export type Collection = {
  id: number
  collection: string
  display_name: string | null
  icon: string | null
  color: string | null
  note: string | null
  hidden: boolean
  singleton: boolean
  display_template: string | null
  sort: number | null
  group: string | null
}

export type CMSRelation = {
  id: number
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
  sort_field: string | null
  one_deselect_action: string
}

export type CMSSettings = {
  id: number
  project_name: string
  project_description: string | null
  project_url: string | null
  project_color: string
  default_language: string
  updated_at: string
  teams_webhook_url: string | null
  ad_group_role_map: Array<{ ad_group_id: string; role_id: string }> | null
  anthropic_api_key: string | null
  presence_session_ttl: number | null
  presence_sweep_interval: number | null
  presence_ping_interval: number | null
  ai_model: string | null
  ai_max_tokens_generate: number | null
  ai_max_tokens_summarize: number | null
  sla_business_day_start: number | null
  sla_business_day_end: number | null
  sla_business_days: string | null
  file_max_size_mb: number | null
  collection_page_size: number | null
  activity_retention_days: number | null
  revision_retention_count: number | null
}

export type CMSFile = {
  id: string
  storage: string
  filename_disk: string | null
  filename_download: string
  title: string | null
  type: string | null
  folder: string | null
  uploaded_by: string | null
  uploaded_on: string
  filesize: number | null
  width: number | null
  height: number | null
  description: string | null
}

export type ActivityEntry = {
  id: number
  action: string
  user: string | null
  timestamp: string
  ip: string | null
  user_agent: string | null
  collection: string | null
  item: string | null
  comment: string | null
  first_name: string | null
  last_name: string | null
  user_email: string | null
}

export type Revision = {
  id: number
  activity: number | null
  collection: string
  item: string
  data: Record<string, unknown>
  delta: Record<string, unknown> | null
  parent: number | null
  // joined
  timestamp: string | null
  action: string | null
  user_id: string | null
  first_name: string | null
  last_name: string | null
  user_email: string | null
}

export type PipelineTemplate = {
  id: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
  created_at: string
  updated_at: string
  state_count?: number
  collections?: string[]
  states?: PipelineState[]
  transitions?: PipelineTransition[]
  bindings?: PipelineBinding[]
}

export type SkipOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'notin'

export type SkipCondition =
  | { type: 'no_owners' }
  | { type: 'field_compare'; field: string; op: SkipOp; value: unknown }
  | { type: 'field_empty'; field: string }
  | { type: 'field_nonempty'; field: string }

export type SkipCriteria = {
  mode: 'any' | 'all'
  conditions: SkipCondition[]
}

export type ConditionOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'null' | 'nnull'

export type ConditionRule = {
  field: string
  op: ConditionOp
  value?: unknown
}

export type PipelineStateOwner = {
  id: number
  state: string
  user: string
  record_filters: Array<{ field: string; op: string; value: unknown }> | null
  is_default: boolean
  sort: number
  first_name: string | null
  last_name: string | null
  email: string
}

export type RecordFilter = {
  field: string
  op: string
  value: unknown
  id_value?: number | null
}

export type PipelineOwnerGroup = {
  id: string
  template: string
  state: string
  name: string | null
  filters: RecordFilter[] | null
  sort: number
  is_default: boolean
  priority: number
  users: PipelineOwnerGroupUser[]
}

export type PipelineOwnerGroupsMap = Record<string, PipelineOwnerGroup[]>

export type PipelineOwnerGroupUser = {
  id: number
  link_id: number
  group: string
  user: string
  first_name: string | null
  last_name: string | null
  email: string
}

export type PipelineOwnerDimension = {
  id: number
  binding: number
  field: string
  label: string
  sort: number
  is_row_axis: boolean
  required: boolean
}

export type PipelineInstanceOwner = {
  id: number
  instance: string
  state: string | null
  user: string
  added_by: string | null
  added_at: string
  first_name: string | null
  last_name: string | null
  email: string
}

export type PipelineState = {
  id: string
  template: string
  key: string
  label: string
  color: string | null
  is_initial: boolean
  is_terminal: boolean
  lock_record: boolean
  sort: number
  skip_criteria?: SkipCriteria | null
}

export type PipelineTransition = {
  id: string
  template: string
  from_state: string | null
  to_state: string
  label: string
  color: string | null
  required_roles: string[] | null
  actions: unknown[] | null
  sort: number
  group_label: string | null
  condition_rules: ConditionRule[] | null
}

export type PipelineBinding = {
  id: number
  template: string
  collection: string
  state_field: string | null
  dimensions?: PipelineOwnerDimension[]
}

export type PipelineInstance = {
  id: string
  template: string
  collection: string
  item: string
  current_state: string | null
  current_state_obj: PipelineState | null
  started_at: string
  completed_at: string | null
}

export type PipelineHistoryEntry = {
  id: number
  instance: string
  transition: string | null
  from_state: string | null
  to_state: string
  comment: string | null
  timestamp: string
  from_state_label: string | null
  from_state_color: string | null
  to_state_label: string
  to_state_color: string | null
  first_name: string | null
  last_name: string | null
  user_email: string | null
}

export type PipelineStateInfo = {
  state_key: string | null
  state_label: string | null
  state_color: string | null
  completed_at: string | null
}

export type PipelineInstancesMap = {
  binding: PipelineBinding
  instances: Record<string, PipelineStateInfo>
}

export type CMSField = {
  id: number
  collection: string
  field: string
  type: string
  interface: string | null
  note: string | null
  hidden: boolean
  readonly: boolean
  required: boolean
  sort: number | null
  computed_formula: string | null
  computed_type: 'read' | 'write' | null
  computed_store: boolean
  // Content ops fields:
  group_key: string | null
  visibility_rules: string | null // JSON
  dependency_config: string | null // JSON
  validation_rules: string | null // JSON array
  lock_condition: string | null // JSON
  default_formula: string | null
  cross_record_defaults: string | null // JSON
  remote_options_config: string | null // JSON
  repeater_schema: string | null // JSON
  is_translatable: boolean
}

export interface CMSNotification {
  id: number
  user: string
  title: string
  message: string | null
  type: string
  read: boolean
  data: unknown
  created_at: string
}

export interface ExternalApiEndpoint {
  id: number
  api_id: number
  name: string
  slug: string
  method: string
  path: string
  description: string | null
  default_body: unknown | null
  default_query: Record<string, string> | null
  default_headers: Record<string, string> | null
  sort: number
  created_at: string
  updated_at: string
}

export interface ExternalApiCallLog {
  id: number
  api_id: number
  endpoint_id: number | null
  triggered_by: string
  method: string
  url: string
  request_headers: Record<string, string> | null
  request_body: string | null
  response_status: number | null
  response_headers: Record<string, string> | null
  response_body: string | null
  duration_ms: number | null
  error: string | null
  user_id: string | null
  created_at: string
}

export interface Webhook {
  id: number
  name: string
  collections: string[] // already parsed from JSON
  events: string[] // already parsed from JSON
  url: string
  method: string
  headers: Record<string, string> | null
  secret: string | null // masked as "••••••" when set
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface FlowRun {
  id: string
  flow: string
  trigger: string
  status: 'running' | 'success' | 'error'
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  error_message: string | null
  user: string | null
}

export interface Comment {
  id: string
  collection: string
  item: string
  user: { id: string; first_name: string; last_name: string; email: string }
  text: string
  created_at: string
  updated_at: string
  mentions: Array<{ id: number; user: string }>
}

export interface CustomQuery {
  id: number
  name: string
  description: string | null
  slug: string
  sql_text: string
  params: Array<{ name: string; type: string; required: boolean; default?: unknown }> | null
  cache_ttl: number
  enabled: boolean
  access: string
  created_at: string
  updated_at: string
}

export interface BlackoutDate {
  id: number
  date: string // YYYY-MM-DD
  label: string | null
  scope: string[] | null // already parsed from JSON
  created_at: string
}

export interface Rule {
  id: number
  name: string
  collection: string
  trigger: string
  conditions: Array<{ field: string; op: string; value: unknown }>
  actions: Array<{
    type: string
    field?: string
    value?: unknown
    message?: string
    error_message?: string
  }>
  enabled: boolean
  sort: number
  created_at: string
  updated_at: string
}

export interface Dashboard {
  id: string
  name: string
  user: string | null
  is_shared: boolean
  created_at: string
  updated_at: string
  widgets?: DashboardWidget[]
}

export interface DashboardWidget {
  id: string
  dashboard: string
  type: 'count' | 'sum' | 'avg' | 'latest' | 'bar_chart' | 'line_chart'
  title: string
  collection: string | null
  field: string | null
  filters: unknown | null
  col: number
  row: number
  width: number
  height: number
}

export interface FieldGroup {
  id: number
  collection: string
  key: string
  label: string
  type: 'section' | 'tab'
  icon: string | null
  sort: number
  is_collapsed: boolean
}

export interface ScheduledChange {
  id: string
  collection: string
  item_id: string
  change_type: 'field_update' | 'workflow_transition'
  changes: Record<string, unknown>
  scheduled_at: string
  status: 'pending' | 'executed' | 'cancelled' | 'failed'
  executed_at: string | null
  created_at: string
}

export interface RecordTemplate {
  id: number
  collection: string
  name: string
  description: string | null
  data: Record<string, unknown>
  role_id: number | null
  is_shared: boolean
  created_by: string | null
  created_at: string
}

export interface Addendum {
  id: string
  parent_collection: string
  parent_id: string
  title: string
  description: string | null
  status: 'draft' | 'review' | 'approved' | 'rejected'
  cost_impact: number | null
  timeline_impact_days: number | null
  created_at: string
  updated_at: string
}

export interface LineItem {
  id: number
  sort: number
  data: Record<string, unknown>
}

// ─── Notification helpers ─────────────────────────────────────────────────────

export async function getNotifications(unread = false): Promise<CMSNotification[]> {
  const r = await api.get<{ data: CMSNotification[] }>('/notifications', {
    params: unread ? { unread: 'true' } : undefined
  })
  return r.data.data
}

export async function getUnreadCount(): Promise<number> {
  const r = await api.get<{ unread: number }>('/notifications/count')
  return r.data.unread
}

export async function markRead(id: number): Promise<void> {
  await api.post(`/notifications/${id}/read`)
}

export async function markAllRead(): Promise<void> {
  await api.post('/notifications/read-all')
}

// ─── Import/Export helpers ────────────────────────────────────────────────────

export async function exportFlow(id: string): Promise<void> {
  const response = await api.get(`/flows/${id}/export`, { responseType: 'blob' })
  const disposition = (response.headers['content-disposition'] as string) ?? ''
  const match = disposition.match(/filename="?([^";\s]+)"?/)
  const filename = match?.[1] ?? `flow-${id}.nivaro.json`
  const url = URL.createObjectURL(
    new Blob([response.data as BlobPart], { type: 'application/json' })
  )
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function importFlow(file: File): Promise<{ id: string; name: string }> {
  const text = await file.text()
  const body = JSON.parse(text) as unknown
  const r = await api.post<{ data: { id: string; name: string } }>('/flows/import', body)
  return r.data.data
}

export async function exportPipeline(id: string): Promise<void> {
  const response = await api.get(`/pipelines/${id}/export`, { responseType: 'blob' })
  const disposition = (response.headers['content-disposition'] as string) ?? ''
  const match = disposition.match(/filename="?([^";\s]+)"?/)
  const filename = match?.[1] ?? `pipeline-${id}.nivaro.json`
  const url = URL.createObjectURL(
    new Blob([response.data as BlobPart], { type: 'application/json' })
  )
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function importPipeline(file: File): Promise<{ id: string; name: string }> {
  const text = await file.text()
  const body = JSON.parse(text) as unknown
  const r = await api.post<{ data: { id: string; name: string } }>('/pipelines/import', body)
  return r.data.data
}
