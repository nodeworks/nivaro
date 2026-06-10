/**
 * Collaboration commands: tasks, approval chains, item locks, notifications
 * (paginated center), per-user activity, issues.
 */
import { type Command, cmd } from '../command.js'
import type { ISODate, UUID } from '../index.js'

// ─── Tasks ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'open' | 'done' | 'cancelled'

export interface Task {
  id: number
  collection: string
  item: string
  title: string
  description: string | null
  assignee: UUID
  due_date: ISODate | null
  status: TaskStatus
  created_by: UUID
  completed_at: ISODate | null
  created_at: ISODate
  updated_at: ISODate
  assignee_name?: string | null
  created_by_name?: string | null
}

export interface MyTask extends Task {
  item_label: string | null
}

/** List tasks. `assignee: 'me'` resolves to the current user. */
export function listTasks(query?: {
  collection?: string
  item?: string
  assignee?: string
  status?: TaskStatus
}): Command<{ data: Task[] }> {
  const params: Record<string, unknown> = {}
  if (query?.collection) params.collection = query.collection
  if (query?.item) params.item = query.item
  if (query?.assignee) params.assignee = query.assignee
  if (query?.status) params.status = query.status
  return cmd('GET', '/tasks', params)
}

/** Open tasks assigned to the current user, with best-effort item labels. */
export function listMyTasks(): Command<{ data: MyTask[] }> {
  return cmd('GET', '/tasks/mine')
}

export function readTask(id: number): Command<{ data: Task }> {
  return cmd('GET', `/tasks/${id}`)
}

export function createTask(body: {
  collection: string
  item: string
  title: string
  assignee: string
  description?: string | null
  due_date?: string | null
}): Command<{ data: Task }> {
  return cmd('POST', '/tasks', undefined, body)
}

export function updateTask(
  id: number,
  body: Partial<{
    title: string
    description: string | null
    assignee: string
    due_date: string | null
    status: TaskStatus
  }>
): Command<{ data: Task }> {
  return cmd('PATCH', `/tasks/${id}`, undefined, body)
}

export function completeTask(id: number): Command<{ data: Task }> {
  return cmd('POST', `/tasks/${id}/complete`)
}

export function deleteTask(id: number): Command<void> {
  return cmd('DELETE', `/tasks/${id}`)
}

// ─── Approvals ────────────────────────────────────────────────────────────────

export interface ApprovalChainStep {
  id: number
  chain: number
  step_order: number
  approver: UUID | null
  approver_role: UUID | null
  label: string | null
}

export interface ApprovalChain {
  id: number
  name: string
  collection: string | null
  workflow_template: UUID | null
  state_key: string | null
  is_active: boolean
  created_at: ISODate
  steps: ApprovalChainStep[]
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface ApprovalInstance {
  id: number
  chain: number
  collection: string
  item: string
  current_step: number
  status: ApprovalStatus
  started_by: UUID
  created_at: ISODate
}

export interface ApprovalDecision {
  id: number
  instance: number
  step_order: number
  user: UUID
  decision: 'approved' | 'rejected'
  comment: string | null
  decided_at: ISODate
  user_name?: string | null
}

export interface ApprovalInstanceDetail extends ApprovalInstance {
  chain_name: string
  started_by_name: string | null
  steps: Array<
    ApprovalChainStep & { approver_name: string | null; approver_role_name?: string | null }
  >
  decisions: ApprovalDecision[]
}

export interface ApprovalStepInput {
  step_order?: number
  approver?: string | null
  approver_role?: string | null
  label?: string | null
}

/** List approval chains with steps (admin). */
export function listApprovalChains(): Command<{ data: ApprovalChain[] }> {
  return cmd('GET', '/approvals/chains')
}

export function readApprovalChain(id: number): Command<{ data: ApprovalChain }> {
  return cmd('GET', `/approvals/chains/${id}`)
}

export function createApprovalChain(body: {
  name: string
  collection?: string | null
  workflow_template?: string | null
  state_key?: string | null
  is_active?: boolean
  steps?: ApprovalStepInput[]
}): Command<{ data: ApprovalChain }> {
  return cmd('POST', '/approvals/chains', undefined, body)
}

/** Update a chain; passing `steps` replaces all steps. */
export function updateApprovalChain(
  id: number,
  body: Partial<{
    name: string
    collection: string | null
    workflow_template: string | null
    state_key: string | null
    is_active: boolean
    steps: ApprovalStepInput[]
  }>
): Command<{ data: ApprovalChain }> {
  return cmd('PATCH', `/approvals/chains/${id}`, undefined, body)
}

export function deleteApprovalChain(id: number): Command<void> {
  return cmd('DELETE', `/approvals/chains/${id}`)
}

/** Begin an approval on a record. Only the first step's approvers are notified. */
export function startApproval(body: {
  chain_id: number
  collection: string
  item: string
}): Command<{ data: ApprovalInstance }> {
  return cmd('POST', '/approvals/start', undefined, body)
}

/** Approve or reject the current step of an approval instance. */
export function decideApproval(
  instanceId: number,
  decision: 'approved' | 'rejected',
  comment?: string | null
): Command<{ data: ApprovalInstance }> {
  return cmd('POST', `/approvals/instances/${instanceId}/decide`, undefined, {
    decision,
    ...(comment != null ? { comment } : {})
  })
}

/** List approval instances with their chains, steps, and decisions. */
export function listApprovalInstances(query?: {
  collection?: string
  item?: string
  status?: ApprovalStatus
}): Command<{ data: ApprovalInstanceDetail[] }> {
  const params: Record<string, unknown> = {}
  if (query?.collection) params.collection = query.collection
  if (query?.item) params.item = query.item
  if (query?.status) params.status = query.status
  return cmd('GET', '/approvals/instances', params)
}

// ─── Item locks ───────────────────────────────────────────────────────────────

export interface ItemLock {
  collection: string
  item: string
  user: UUID
  locked_by_name?: string | null
  locked_at: ISODate
  expires_at: ISODate
  is_mine?: boolean
}

/** Current lock state — `data: null` when the item is free. */
export function readItemLock(
  collection: string,
  item: string | number
): Command<{ data: ItemLock | null }> {
  return cmd('GET', `/item-locks/${collection}/${item}/lock`)
}

/**
 * Acquire (or refresh your own) edit lock. Locks expire after 5 minutes
 * unless extended via heartbeat. 409 when held by another user.
 */
export function acquireItemLock(
  collection: string,
  item: string | number
): Command<{ data: ItemLock | null }> {
  return cmd('POST', `/item-locks/${collection}/${item}/lock`)
}

/** Extend your own lock's TTL. */
export function heartbeatItemLock(
  collection: string,
  item: string | number
): Command<{ data: { collection: string; item: string; user: UUID; expires_at: ISODate } }> {
  return cmd('POST', `/item-locks/${collection}/${item}/heartbeat`)
}

/** Release your lock. Admins may pass `force: true` to release anyone's lock. */
export function releaseItemLock(
  collection: string,
  item: string | number,
  options?: { force?: boolean }
): Command<void> {
  return cmd(
    'DELETE',
    `/item-locks/${collection}/${item}/lock`,
    options?.force ? { force: '1' } : undefined
  )
}

// ─── Notifications (paginated center) ────────────────────────────────────────

export interface NotificationItem {
  id: number
  user: UUID
  title: string
  message: string | null
  type: string
  read: boolean
  collection: string | null
  item: string | null
  data: unknown | null
  created_at: ISODate
}

export interface NotificationPage {
  data: NotificationItem[]
  total: number
  page: number
  limit: number
}

/** Paginated notification list. `status` filters inbox/read. */
export function listNotifications(query?: {
  page?: number
  limit?: number
  status?: 'all' | 'inbox' | 'read'
}): Command<NotificationPage> {
  const params: Record<string, unknown> = {}
  if (query?.page != null) params.page = query.page
  if (query?.limit != null) params.limit = query.limit
  if (query?.status) params.status = query.status
  return cmd('GET', '/notifications', params)
}

/** Unread notification count for the current user. */
export function readUnreadNotificationCount(): Command<{ unread: number }> {
  return cmd('GET', '/notifications/unread-count')
}

// ─── Per-user activity (admin) ────────────────────────────────────────────────

export interface UserActivityEntry {
  id: number
  action: string
  user: UUID
  timestamp: ISODate
  ip: string | null
  collection: string | null
  item: string | null
  comment: string | null
}

export interface UserActivitySummary {
  total: number
  actions: Array<{ action: string; count: number }>
  collections: Array<{ collection: string; count: number }>
}

/** Paginated activity feed for one user (admin). */
export function readUserActivity(
  userId: string,
  query?: { page?: number; limit?: number }
): Command<{ data: UserActivityEntry[]; total: number; page: number; limit: number }> {
  const params: Record<string, unknown> = {}
  if (query?.page != null) params.page = query.page
  if (query?.limit != null) params.limit = query.limit
  return cmd('GET', `/user-activity/${userId}`, params)
}

/** Activity counts by action + top collections for one user (admin). */
export function readUserActivitySummary(userId: string): Command<{ data: UserActivitySummary }> {
  return cmd('GET', `/user-activity/${userId}/summary`)
}

// ─── Issues ───────────────────────────────────────────────────────────────────

export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical'
export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed'

export interface Issue {
  id: number
  collection: string | null
  item: string | null
  title: string
  severity: IssueSeverity
  status: IssueStatus
  assigned_to: UUID | null
  raised_by: UUID
  resolution_notes: string | null
  created_at: ISODate
  updated_at: ISODate
  assigned_to_name?: string | null
  assigned_to_email?: string | null
  raised_by_name?: string | null
  raised_by_email?: string | null
}

export interface IssueSummary {
  by_status: Record<string, number>
  by_severity: Record<string, number>
}

/** List issues (latest 200). `assigned_to: 'me'` resolves to the current user. */
export function listIssues(query?: {
  collection?: string
  item?: string
  status?: IssueStatus
  severity?: IssueSeverity
  assigned_to?: string
}): Command<{ data: Issue[] }> {
  const params: Record<string, unknown> = {}
  if (query?.collection) params.collection = query.collection
  if (query?.item) params.item = query.item
  if (query?.status) params.status = query.status
  if (query?.severity) params.severity = query.severity
  if (query?.assigned_to) params.assigned_to = query.assigned_to
  return cmd('GET', '/issues', params)
}

/** Counts by status + open-issue counts by severity. */
export function readIssueSummary(): Command<{ data: IssueSummary }> {
  return cmd('GET', '/issues/summary')
}

export function readIssue(id: number): Command<{ data: Issue }> {
  return cmd('GET', `/issues/${id}`)
}

export function createIssue(body: {
  title: string
  severity?: IssueSeverity
  collection?: string | null
  item?: string | null
  assigned_to?: string | null
}): Command<{ data: Issue }> {
  return cmd('POST', '/issues', undefined, body)
}

export function updateIssue(
  id: number,
  body: Partial<{
    title: string
    severity: IssueSeverity
    status: IssueStatus
    assigned_to: string | null
    resolution_notes: string | null
    collection: string | null
    item: string | null
  }>
): Command<{ data: Issue }> {
  return cmd('PATCH', `/issues/${id}`, undefined, body)
}

/** Delete an issue (admin only). */
export function deleteIssue(id: number): Command<void> {
  return cmd('DELETE', `/issues/${id}`)
}
