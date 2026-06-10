/**
 * Infrastructure commands: workspaces (usage/quotas/templates), sync jobs,
 * ERP submissions, PDF templates, custom pages, two-factor auth, settings.
 */
import { type Command, cmd } from '../command.js'
import type { ISODate, UUID } from '../index.js'

// ─── Workspaces ───────────────────────────────────────────────────────────────

export interface WorkspaceQuotas {
  max_collections?: number
  max_users?: number
  max_roles?: number
  [key: string]: number | undefined
}

export interface Workspace {
  id: UUID
  name: string
  slug: string
  icon: string | null
  color: string | null
  quotas?: string | WorkspaceQuotas | null
  created_at: ISODate
  updated_at: ISODate
}

export interface WorkspaceUsage {
  quotas: WorkspaceQuotas
  usage: Record<string, number>
}

export interface WorkspaceTemplate {
  id: number
  name: string
  description: string | null
  source_workspace: UUID
  created_by: UUID
  created_at: ISODate
}

export function listWorkspaces(): Command<{ data: Workspace[] }> {
  return cmd('GET', '/workspaces')
}

export function readWorkspace(id: string): Command<{ data: Workspace }> {
  return cmd('GET', `/workspaces/${id}`)
}

/** Usage counters vs configured quota limits. */
export function readWorkspaceUsage(id: string): Command<{ data: WorkspaceUsage }> {
  return cmd('GET', `/workspaces/${id}/usage`)
}

/**
 * Create a workspace (admin). Passing `template_id` replays a saved workspace
 * template (collections, fields, relations, roles, policies, workflows);
 * the response then includes `template_errors`.
 */
export function createWorkspace(body: {
  name: string
  slug: string
  icon?: string
  color?: string
  template_id?: number
}): Command<{ data: Workspace & { template_errors?: string[] } }> {
  return cmd('POST', '/workspaces', undefined, body)
}

export function updateWorkspace(
  id: string,
  body: Partial<{
    name: string
    slug: string
    icon: string
    color: string
    quotas: WorkspaceQuotas | null
  }>
): Command<{ data: Workspace }> {
  return cmd('PATCH', `/workspaces/${id}`, undefined, body)
}

export function deleteWorkspace(id: string): Command<void> {
  return cmd('DELETE', `/workspaces/${id}`)
}

/** Set the current user's active workspace. */
export function switchWorkspace(id: string): Command<{ data: { workspace_id: string } }> {
  return cmd('POST', `/workspaces/${id}/switch`)
}

export function listWorkspaceTemplates(): Command<{ data: WorkspaceTemplate[] }> {
  return cmd('GET', '/workspaces/templates')
}

/** Snapshot an existing workspace's schema into a reusable template (admin). */
export function createWorkspaceTemplate(body: {
  name: string
  description?: string
  source_workspace: string
}): Command<{
  data: {
    id: number
    name: string
    description: string | null
    source_workspace: string
    counts: Record<string, number>
  }
}> {
  return cmd('POST', '/workspaces/templates', undefined, body)
}

export function deleteWorkspaceTemplate(id: number): Command<void> {
  return cmd('DELETE', `/workspaces/templates/${id}`)
}

// ─── Sync jobs ────────────────────────────────────────────────────────────────

export interface SyncJob {
  id: number
  name: string
  direction: 'pull' | 'push'
  external_api: number
  collection: string
  endpoint_path: string
  field_mapping: Record<string, unknown> | null
  conflict_strategy: string
  schedule: string | null
  id_field: string | null
  external_id_field: string | null
  is_active: boolean
  last_run_at: ISODate | null
  last_run_stats: Record<string, unknown> | null
  created_by: UUID | null
  created_at: ISODate
  updated_at: ISODate
}

export function listSyncJobs(): Command<{ data: SyncJob[] }> {
  return cmd('GET', '/sync-jobs')
}

export function readSyncJob(id: number): Command<{ data: SyncJob }> {
  return cmd('GET', `/sync-jobs/${id}`)
}

export function createSyncJob(body: {
  name: string
  direction: 'pull' | 'push'
  external_api: number
  collection: string
  endpoint_path: string
  field_mapping?: Record<string, unknown> | null
  conflict_strategy?: string
  /** Cron expression; omit for manual-only jobs. */
  schedule?: string | null
  id_field?: string | null
  external_id_field?: string | null
  is_active?: boolean
}): Command<{ data: SyncJob }> {
  return cmd('POST', '/sync-jobs', undefined, body)
}

export function updateSyncJob(
  id: number,
  body: Partial<{
    name: string
    direction: 'pull' | 'push'
    external_api: number
    collection: string
    endpoint_path: string
    field_mapping: Record<string, unknown> | null
    conflict_strategy: string
    schedule: string | null
    id_field: string | null
    external_id_field: string | null
    is_active: boolean
  }>
): Command<{ data: SyncJob }> {
  return cmd('PATCH', `/sync-jobs/${id}`, undefined, body)
}

export function deleteSyncJob(id: number): Command<{ data: { success: boolean } }> {
  return cmd('DELETE', `/sync-jobs/${id}`)
}

/** Trigger a sync run now (fire-and-forget; 202). */
export function runSyncJob(id: number): Command<{ data: { started: boolean } }> {
  return cmd('POST', `/sync-jobs/${id}/run`)
}

// ─── ERP submissions ──────────────────────────────────────────────────────────

export type ErpSubmissionStatus = 'pending' | 'submitted' | 'confirmed' | 'failed'

export interface ErpSubmission {
  id: number
  collection: string
  item: string
  external_api: number
  external_ref: string | null
  status: ErpSubmissionStatus
  attempts: number
  last_error: string | null
  payload: { endpoint_path: string; body: Record<string, unknown> } | null
  created_at: ISODate
  updated_at: ISODate
}

/** Submit an item's data to an external ERP endpoint; logs the attempt. */
export function submitToErp(body: {
  collection: string
  item: string | number
  external_api: number
  endpoint_path: string
  /** Restrict the payload to these fields; omit to send the whole row. */
  payload_fields?: string[]
}): Command<{ data: ErpSubmission }> {
  return cmd('POST', '/erp-submissions', undefined, body)
}

/** Submission history for an item (latest first). */
export function readErpSubmissionHistory(
  collection: string,
  item: string | number
): Command<{ data: ErpSubmission[] }> {
  return cmd('GET', `/erp-submissions/${collection}/${item}`)
}

/** Re-send the stored payload of a previous submission. */
export function retryErpSubmission(id: number): Command<{ data: ErpSubmission }> {
  return cmd('POST', `/erp-submissions/${id}/retry`)
}

/** Manual status override — e.g. driven by an ERP-side webhook (admin). */
export function updateErpSubmissionStatus(
  id: number,
  status: ErpSubmissionStatus,
  externalRef?: string | null
): Command<{ data: ErpSubmission }> {
  return cmd('PATCH', `/erp-submissions/${id}/status`, undefined, {
    status,
    ...(externalRef !== undefined ? { external_ref: externalRef } : {})
  })
}

// ─── PDF templates ────────────────────────────────────────────────────────────

export interface PdfTemplate {
  id: string
  name: string
  collection: string | null
  template: string
  created_by: UUID | null
  created_at: ISODate
  updated_at: ISODate | null
}

/** Templates bound to a collection (plus global ones), or all when omitted. */
export function listPdfTemplates(collection?: string): Command<{ data: PdfTemplate[] }> {
  return cmd('GET', '/pdf-templates', collection ? { collection } : undefined)
}

export function readPdfTemplate(id: string): Command<{ data: PdfTemplate }> {
  return cmd('GET', `/pdf-templates/${id}`)
}

export function createPdfTemplate(body: {
  name: string
  template: string
  collection?: string | null
}): Command<{ data: PdfTemplate }> {
  return cmd('POST', '/pdf-templates', undefined, body)
}

export function updatePdfTemplate(
  id: string,
  body: Partial<{ name: string; collection: string | null; template: string }>
): Command<{ data: PdfTemplate }> {
  return cmd('PATCH', `/pdf-templates/${id}`, undefined, body)
}

export function deletePdfTemplate(id: string): Command<void> {
  return cmd('DELETE', `/pdf-templates/${id}`)
}

/**
 * Render a template against an item. Resolves to an ArrayBuffer
 * (`application/pdf`) — wrap in `new Blob([buf], { type: 'application/pdf' })`
 * for download links, or `Buffer.from(buf)` in Node.
 */
export function renderPdfTemplate(
  id: string,
  body: { collection?: string; item_id: string | number }
): Command<ArrayBuffer> {
  return cmd('POST', `/pdf-templates/${id}/render`, undefined, body)
}

// ─── Custom pages ─────────────────────────────────────────────────────────────

export interface PageWidget {
  id: string
  type: 'table' | 'kpi' | 'markdown' | 'iframe' | 'recent-activity'
  x: number
  y: number
  w: number
  h: number
  config?: Record<string, unknown>
}

export interface PageLayout {
  columns: number
  widgets: PageWidget[]
}

export interface Page {
  id: number
  name: string
  slug: string
  icon: string | null
  layout: PageLayout
  is_shared: boolean
  role: UUID | null
  sort: number
  created_by: UUID | null
  created_at: ISODate
  updated_at: ISODate
}

/** Pages visible to the caller (own + shared + role-matched; admins see all). */
export function listPages(): Command<{ data: Page[] }> {
  return cmd('GET', '/pages')
}

/** Single page by slug (or numeric id). */
export function readPage(slug: string): Command<{ data: Page }> {
  return cmd('GET', `/pages/${slug}`)
}

export function createPage(body: {
  name: string
  slug?: string
  icon?: string | null
  layout?: PageLayout
  is_shared?: boolean
  role?: string | null
  sort?: number
}): Command<{ data: Page }> {
  return cmd('POST', '/pages', undefined, body)
}

export function updatePage(
  id: number,
  body: Partial<{
    name: string
    slug: string
    icon: string | null
    layout: PageLayout
    is_shared: boolean
    role: string | null
    sort: number
  }>
): Command<{ data: Page }> {
  return cmd('PATCH', `/pages/${id}`, undefined, body)
}

export function deletePage(id: number): Command<void> {
  return cmd('DELETE', `/pages/${id}`)
}

/** Execute a widget's stored config server-side (permission-checked). */
export function readPageWidgetData(
  slug: string,
  widgetId: string
): Command<{ data: Record<string, unknown> }> {
  return cmd('POST', `/pages/${slug}/widget-data`, undefined, { widget_id: widgetId })
}

// ─── Two-factor authentication ────────────────────────────────────────────────

/** Begin TOTP enrollment — returns the otpauth URI, QR data-URL, and secret. */
export function setupTwoFactor(): Command<{
  data: { uri: string; qr: string; secret: string }
}> {
  return cmd('POST', '/two-factor/setup')
}

/** Confirm enrollment with a 6-digit code → enables 2FA. */
export function verifyTwoFactor(token: string): Command<{ data: { enabled: boolean } }> {
  return cmd('POST', '/two-factor/verify', undefined, { token })
}

/** Disable 2FA — requires a currently valid 6-digit code. */
export function disableTwoFactor(token: string): Command<{ data: { enabled: boolean } }> {
  return cmd('POST', '/two-factor/disable', undefined, { token })
}

export function readTwoFactorStatus(): Command<{ data: { enabled: boolean } }> {
  return cmd('GET', '/two-factor/status')
}

// ─── Settings ─────────────────────────────────────────────────────────────────

/**
 * Project settings singleton. Includes AI configuration —
 * `anthropic_api_key` is masked on read and preserved when the masked
 * value is re-submitted.
 */
export function readSettings<T = Record<string, unknown>>(): Command<{ data: T }> {
  return cmd('GET', '/settings')
}

/** Update settings (admin). */
export function updateSettings<T = Record<string, unknown>>(
  body: Partial<T>
): Command<{ data: T }> {
  return cmd('PATCH', '/settings', undefined, body)
}

// ─── Embeddable widget feeds (admin) ─────────────────────────────────────────

export interface WidgetFeed {
  id: number
  name: string
  token: string
  collection: string
  fields: string[]
  filters: Record<string, unknown> | null
  limit_count: number
  sort: string | null
  is_active: boolean
  created_at: string
}

/** List widget feeds (admin). */
export function listWidgetFeeds(): Command<{ data: WidgetFeed[] }> {
  return cmd('GET', '/widget')
}

/** Create a widget feed; the response includes its public token (admin). */
export function createWidgetFeed(body: {
  name: string
  collection: string
  fields: string[]
  filters?: Record<string, unknown>
  limit_count?: number
  sort?: string
  is_active?: boolean
}): Command<{ data: WidgetFeed }> {
  return cmd('POST', '/widget', undefined, body)
}

/** Update a widget feed (admin). */
export function updateWidgetFeed(
  id: number,
  body: Partial<{
    name: string
    fields: string[]
    filters: Record<string, unknown> | null
    limit_count: number
    sort: string | null
    is_active: boolean
  }>
): Command<{ data: WidgetFeed }> {
  return cmd('PATCH', `/widget/${id}`, undefined, body)
}

/** Delete a widget feed (admin). */
export function deleteWidgetFeed(id: number): Command<void> {
  return cmd('DELETE', `/widget/${id}`)
}

/** Rotate a widget feed's public token (admin). */
export function rotateWidgetFeedToken(id: number): Command<{ data: WidgetFeed }> {
  return cmd('POST', `/widget/${id}/rotate-token`)
}
