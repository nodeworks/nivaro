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
