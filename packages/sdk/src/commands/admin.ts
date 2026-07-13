/**
 * Administration commands: roles & policies (RBAC/RLS), user management +
 * delegation, CSV import jobs, throughput reporting, notification-subscription
 * admin views, extension/flow registries, mail test.
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
    owners: Array<{ id: string; email: string; first_name: string | null; last_name: string | null }>
    sla_rule: { name: string; duration_hours: number; warning_threshold_pct: number; business_hours_only: boolean } | null
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
    condition_rules: Array<{ field: string; op: string; value: unknown; record_value: unknown; passed: boolean }>
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
): Command<{ data: Array<{ source: string; label: string; detail: string; link: string | null }>; total: number }> {
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
