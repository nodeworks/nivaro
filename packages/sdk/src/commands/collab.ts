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

// ─── Notifications: state changes ────────────────────────────────────────────

/** Total notification count for the current user. */
export function readNotificationCount(): Command<{ count: number }> {
  return cmd('GET', '/notifications/count')
}

/** Mark one notification read. */
export function markNotificationRead(id: number): Command<void> {
  return cmd('POST', `/notifications/${id}/read`)
}

/** Mark every inbox notification read. */
export function markAllNotificationsRead(): Command<{ data: { updated: number } }> {
  return cmd('POST', '/notifications/mark-all-read')
}

export function deleteNotification(id: number): Command<void> {
  return cmd('DELETE', `/notifications/${id}`)
}

// ─── Item locking config (admin) ─────────────────────────────────────────────

/** Whether soft edit-locking is enabled for a collection. */
export function readItemLockConfig(
  collection: string
): Command<{ data: { collection: string; item_locking_enabled: boolean } }> {
  return cmd('GET', `/item-locks/config/${collection}`)
}

/** Toggle per-collection edit locking. Disabling releases all active locks. */
export function updateItemLockConfig(
  collection: string,
  enabled: boolean
): Command<{ data: { collection: string; item_locking_enabled: boolean } }> {
  return cmd('PATCH', `/item-locks/config/${collection}`, undefined, {
    item_locking_enabled: enabled
  })
}

// ─── Field watches ────────────────────────────────────────────────────────────

export interface FieldWatch {
  id: number
  name: string
  collection: string
  field: string
  is_active: boolean
  created_by: UUID
  subscriber_count?: number
  subscribed?: boolean
}

export function listFieldWatches(): Command<{ data: FieldWatch[] }> {
  return cmd('GET', '/field-watches')
}

export function readFieldWatch(id: number): Command<{ data: FieldWatch }> {
  return cmd('GET', `/field-watches/${id}`)
}

export function createFieldWatch(data: {
  name: string
  collection: string
  field: string
  is_active?: boolean
}): Command<{ data: FieldWatch }> {
  return cmd('POST', '/field-watches', undefined, data)
}

export function updateFieldWatch(
  id: number,
  data: { name?: string; collection?: string; field?: string; is_active?: boolean }
): Command<{ data: FieldWatch }> {
  return cmd('PATCH', `/field-watches/${id}`, undefined, data)
}

export function deleteFieldWatch(id: number): Command<void> {
  return cmd('DELETE', `/field-watches/${id}`)
}

/** Subscribe the current user to change notifications for a watch
 *  (requires read access to the watched collection). */
export function subscribeFieldWatch(id: number): Command<{ data: { watch: number; user: UUID } }> {
  return cmd('POST', `/field-watches/${id}/subscribe`)
}

export function unsubscribeFieldWatch(id: number): Command<void> {
  return cmd('DELETE', `/field-watches/${id}/subscribe`)
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export type ChatRoomKind = 'global' | 'dm' | 'channel' | 'entity' | 'unknown'

export interface ChatRoomSummary {
  room: string
  kind: ChatRoomKind
  label: string | null
  unread: number
  muted: boolean
  notify_mode: 'all' | 'mentions'
  joined: boolean
  /** Channel rooms only. */
  channel: {
    id: number
    visibility: 'open' | 'role' | 'private'
    role: string | null
    topic: string | null
    created_by: string | null
    is_direct: boolean
  } | null
  last_message: {
    id: number
    message: string
    sender: string | null
    sender_name: string | null
    date_created: string
  } | null
}

export interface ChatChannel {
  id: number
  key: string
  name: string
  topic: string | null
  visibility: 'open' | 'role' | 'private'
  role: string | null
  created_by: string | null
  is_archived: boolean
  is_direct: boolean
}

export interface ChatDirectoryChannel extends ChatChannel {
  joined: boolean
  members: number
}

export interface ChatReaction {
  emoji: string
  user: string
  user_name: string | null
}

export interface ChatMessage {
  id: number
  room: string
  message: string
  sender: UUID | null
  sender_name: string | null
  date_created: ISODate
  edited_at?: ISODate | null
  deleted_at?: ISODate | null
  attachments: string[]
  reactions: ChatReaction[]
}

export interface ChatPin {
  pin_id: number
  id: number
  sender_name: string | null
  message: string
  date_created: ISODate
}

export interface ChatSearchHit {
  id: number
  room: string
  sender: UUID | null
  sender_name: string | null
  message: string
  date_created: ISODate
}

export interface ChatChannelMember {
  user: UUID
  first_name: string | null
  last_name: string | null
  email: string | null
  joined_at: ISODate | null
}

export interface ChatRoomType {
  id: number
  prefix: string
  collection: string
  match_field: string
  label: string | null
  is_active: boolean
}

/** The current user's sidebar rooms (joined channels, DMs, global) with unread counts. */
export function listChatRooms(): Command<{ data: ChatRoomSummary[] }> {
  return cmd('GET', '/chat/rooms')
}

/** Joinable channels (private ones appear only to members). Group DMs are excluded. */
export function readChatDirectory(search?: string): Command<{ data: ChatDirectoryChannel[] }> {
  return cmd('GET', '/chat/directory', search ? { search } : undefined)
}

/** Newest messages in a room, ascending for rendering. `before` = message id cursor. */
export function listChatMessages(
  room: string,
  options?: { before?: number; limit?: number }
): Command<{ data: ChatMessage[] }> {
  const params: Record<string, unknown> = { room }
  if (options?.before != null) params.before = options.before
  if (options?.limit != null) params.limit = options.limit
  return cmd('GET', '/chat/messages', params)
}

/** Send a message. `attachments` = uploaded nivaro_files ids; mentions notify explicitly. */
export function sendChatMessage(body: {
  room: string
  message?: string
  mentions?: string[]
  attachments?: string[]
}): Command<{ data: ChatMessage }> {
  return cmd('POST', '/chat/messages', undefined, body)
}

/** Edit your own message within the 15-minute window. Mentions are not re-fired. */
export function editChatMessage(
  id: number,
  message: string
): Command<{ data: { id: number; message: string } }> {
  return cmd('PATCH', `/chat/messages/${id}`, undefined, { message })
}

/** Soft-delete a message (own, or admin) — the row survives as a tombstone. */
export function deleteChatMessage(id: number): Command<{ data: { deleted: boolean } }> {
  return cmd('DELETE', `/chat/messages/${id}`)
}

/** Toggle a reaction from the fixed palette (👍 ✅ 👀 🎉 ❤️ 😂). */
export function toggleChatReaction(
  id: number,
  emoji: string
): Command<{ data: { toggled: string; on: boolean } }> {
  return cmd('POST', `/chat/messages/${id}/reactions`, undefined, { emoji })
}

/** Pin or unpin a message. Any room member may toggle. */
export function toggleChatPin(id: number): Command<{ data: { pinned: boolean } }> {
  return cmd('POST', `/chat/messages/${id}/pin`)
}

/** Pinned messages in a room (newest 20). */
export function listChatPins(room: string): Command<{ data: ChatPin[] }> {
  return cmd('GET', `/chat/rooms/${encodeURIComponent(room)}/pins`)
}

/** Search messages across the current user's sidebar rooms (min 2 chars). */
export function searchChatMessages(q: string): Command<{ data: ChatSearchHit[] }> {
  return cmd('GET', '/chat/search', { q })
}

/** Create a group DM (a private channel rendered as a conversation). */
export function createGroupDm(body: {
  user_ids: string[]
  name?: string
}): Command<{ data: { room: string; name: string } }> {
  return cmd('POST', '/chat/group-dm', undefined, body)
}

/** Instance chat config — bot name/user id when the AI bot is enabled. */
export function readChatConfig(): Command<{
  data: { bot_name: string | null; bot_user_id: string | null }
}> {
  return cmd('GET', '/chat/config')
}

/** Mark a room read up to now. */
export function markChatRoomRead(room: string): Command<{ data: { room: string; read: boolean } }> {
  return cmd('POST', `/chat/rooms/${encodeURIComponent(room)}/read`)
}

/** Join a room (adds it to the sidebar). Refused for rooms you cannot see. */
export function joinChatRoom(room: string): Command<{ data: { room: string; joined: boolean } }> {
  return cmd('POST', `/chat/rooms/${encodeURIComponent(room)}/join`)
}

/** Leave a room (removes the membership row). */
export function leaveChatRoom(room: string): Command<{ data: { room: string; joined: boolean } }> {
  return cmd('DELETE', `/chat/rooms/${encodeURIComponent(room)}/join`)
}

/** Update per-room notification settings. `notify_mode: 'mentions'` = mentions only, null = all. */
export function updateChatRoom(
  room: string,
  body: { muted?: boolean; notify_mode?: 'mentions' | null }
): Command<{ data: { room: string; is_muted?: boolean; notify_mode?: string | null } }> {
  return cmd('PATCH', `/chat/rooms/${encodeURIComponent(room)}`, undefined, body)
}

/** DM read receipt — when the other participant last read the room. */
export function readChatPeerRead(
  room: string
): Command<{ data: { last_read_at: ISODate | null } }> {
  return cmd('GET', `/chat/rooms/${encodeURIComponent(room)}/peer-read`)
}

/** Create a channel. Role-scoped channels require `role`. (Channel listing = readChatDirectory.) */
export function createChatChannel(body: {
  name: string
  key?: string
  topic?: string
  visibility?: 'open' | 'role' | 'private'
  role?: string | null
}): Command<{ data: ChatChannel }> {
  return cmd('POST', '/chat/channels', undefined, body)
}

/** Update a channel (owner or admin). */
export function updateChatChannel(
  id: number,
  body: Partial<{
    name: string
    topic: string | null
    visibility: 'open' | 'role' | 'private'
    role: string | null
    is_archived: boolean
  }>
): Command<{ data: ChatChannel }> {
  return cmd('PATCH', `/chat/channels/${id}`, undefined, body)
}

/** Members of a channel (visible to anyone who can see the room). */
export function listChatChannelMembers(id: number): Command<{ data: ChatChannelMember[] }> {
  return cmd('GET', `/chat/channels/${id}/members`)
}

/** Add someone to a channel (owner or admin). */
export function addChatChannelMember(
  id: number,
  userId: string
): Command<{ data: { room: string; user: string } }> {
  return cmd('POST', `/chat/channels/${id}/members`, undefined, { user_id: userId })
}

/** Remove a member (self, owner, or admin). */
export function removeChatChannelMember(
  id: number,
  userId: string
): Command<{ data: { removed: boolean } }> {
  return cmd('DELETE', `/chat/channels/${id}/members/${encodeURIComponent(userId)}`)
}

/** Roles (id + name only) for the role-scoped channel picker — readable by any user. */
export function listChatRoles(): Command<{ data: Array<{ id: UUID; name: string }> }> {
  return cmd('GET', '/chat/roles')
}

/** Entity-room registry — which room prefixes map to which collections. */
export function listChatRoomTypes(): Command<{ data: ChatRoomType[] }> {
  return cmd('GET', '/chat/room-types')
}

/** Register an entity-room prefix (admin). `match_field` defaults to 'id'. */
export function createChatRoomType(body: {
  prefix: string
  collection: string
  match_field?: string
  label?: string
}): Command<{ data: ChatRoomType }> {
  return cmd('POST', '/chat/room-types', undefined, body)
}

/** Update an entity-room registration (admin). */
export function updateChatRoomType(
  id: number,
  body: Partial<{
    collection: string
    match_field: string
    label: string | null
    is_active: boolean
  }>
): Command<{ data: ChatRoomType }> {
  return cmd('PATCH', `/chat/room-types/${id}`, undefined, body)
}

// ─── My Work ──────────────────────────────────────────────────────────────────

export interface MyWorkSla {
  state_key: string
  elapsed_hours: number
  duration_hours: number | null
  warning_threshold_pct: number | null
  business_hours_only: boolean
  status: 'ok' | 'warning' | 'breached' | null
  remaining_hours: number | null
  entered_at: ISODate
}

export interface MyWorkOwnedEntry {
  collection: string
  item: string
  label: string
  state: string | null
  state_color: string | null
  url: string
  sla: MyWorkSla | null
}

export interface MyWorkSummary {
  owned: MyWorkOwnedEntry[]
  owned_total: number
  tasks: Array<{
    id: number
    collection: string
    item: string
    title: string
    due_date: ISODate | null
    status: string
  }>
  approvals: Array<{
    id: number
    collection: string
    item: string
    chain_name: string
    current_step: number
  }>
  notifications: Array<{
    id: number
    subject: string
    message: string | null
    sender: UUID | null
    collection: string | null
    item: string | null
    timestamp: ISODate
  }>
  counts: {
    owned: number
    owned_breached: number
    owned_warning: number
    tasks: number
    approvals: number
    notifications: number
  }
}

/** The current user's actionable inbox: owned records (SLA-first), tasks,
 *  approval steps, unread notifications. */
export function readMyWork(): Command<{ data: MyWorkSummary }> {
  return cmd('GET', '/my-work')
}

// ─── Notifications: batch + send ─────────────────────────────────────────────

/** Mark several notifications read in one call (own rows only, max 200 ids). */
export function markNotificationsRead(
  ids: Array<string | number>
): Command<{ data: { updated: number } }> {
  return cmd('POST', '/notifications/mark-read', undefined, { ids })
}

/** Send a user-to-user notification. Sender is always the caller. */
export function createNotification(body: {
  recipient: string
  subject: string
  message?: string
  collection?: string
  item?: string
}): Command<{ ok: boolean }> {
  return cmd('POST', '/notifications', undefined, body)
}

/** Admin broadcast: audience = users whose restrict-mode scope for `dimension`
 *  intersects `values`, plus explicit `user_ids`. */
export function sendBulkNotification(body: {
  subject: string
  message?: string
  html?: string
  dimension?: string
  values?: Array<string | number>
  user_ids?: string[]
  channels?: { inapp?: boolean; email?: boolean }
}): Command<{ data: { recipients: number; emails_sent: number } }> {
  return cmd('POST', '/notifications/bulk', undefined, body)
}

// ─── Record links ─────────────────────────────────────────────────────────────

export type RecordLinkType = 'relates to' | 'supersedes' | 'duplicates' | 'blocks' | 'caused by'

export interface RecordLink {
  id: number
  direction: 'out' | 'in'
  /** Incoming links carry the inverse phrasing ('superseded by' etc.). */
  type: string
  collection: string
  item: string
  label: string | null
  note: string | null
}

/** Links attached to a record, both directions, labels for readable ends. */
export function listRecordLinks(
  collection: string,
  id: string | number
): Command<{ data: RecordLink[] }> {
  return cmd('GET', `/record-links/${collection}/${id}`)
}

/** Link two records. `link_type` defaults to 'relates to'; duplicates 409. */
export function createRecordLink(body: {
  from_collection: string
  from_item: string
  to_collection: string
  to_item: string
  link_type?: RecordLinkType
  note?: string
}): Command<{ data: { linked: boolean } }> {
  return cmd('POST', '/record-links', undefined, body)
}

/** Remove a link (requires read on the FROM side). */
export function deleteRecordLink(id: number): Command<{ data: { deleted: boolean } }> {
  return cmd('DELETE', `/record-links/${id}`)
}

// ─── Pinned items ─────────────────────────────────────────────────────────────

/** The current user's pinned item ids for a collection. */
export function listPinnedItems(collection: string): Command<{ data: string[] }> {
  return cmd('GET', `/pinned/${collection}`)
}

/** Pin or unpin a record for the current user. */
export function togglePinnedItem(
  collection: string,
  itemId: string | number
): Command<{ data: { pinned: boolean } }> {
  return cmd('POST', `/pinned/${collection}/${itemId}/toggle`)
}

// ─── Last touch ───────────────────────────────────────────────────────────────

export interface LastTouch {
  action: string
  timestamp: ISODate
  user_id: UUID | null
  user_name: string | null
}

/** Newest create/update on a record ("Edited 3d ago by Beth"). `data: null` when untouched. */
export function readLastTouch(
  collection: string,
  id: string | number
): Command<{ data: LastTouch | null }> {
  return cmd('GET', `/last-touch/${collection}/${id}`)
}

// ─── View subscriptions ───────────────────────────────────────────────────────

export interface ViewSubscription {
  id: number
  view_id: number
  digest: 'daily' | 'weekly'
  is_active: boolean
  last_run_at: ISODate | null
  view_name: string
  collection: string
}

/** The current user's saved-view digest subscriptions. */
export function listViewSubscriptions(): Command<{ data: ViewSubscription[] }> {
  return cmd('GET', '/view-subscriptions')
}

/** Subscribe to a saved view's new-records digest (upserts by view). */
export function createViewSubscription(body: {
  view_id: number
  digest?: 'daily' | 'weekly'
}): Command<{ data: { id: number; view_id: number; digest: string } }> {
  return cmd('POST', '/view-subscriptions', undefined, body)
}

/** Unsubscribe (own rows only). Responds 204 with no body. */
export function deleteViewSubscription(id: number): Command<void> {
  return cmd('DELETE', `/view-subscriptions/${id}`)
}

// ─── Access explain / requests ────────────────────────────────────────────────

export interface AccessReason {
  type: 'permission' | 'not_found' | 'row_filter' | 'scope' | 'scope_strict'
  message: string
  dimension?: string
  dimension_label?: string
  allowed_values?: string[]
}

/** Why a record is (in)visible to the current user — each access gate re-run
 *  separately, reasons only, never record data. */
export function explainRecordAccess(
  collection: string,
  id: string | number
): Command<{ data: { access: boolean; reasons: AccessReason[] } }> {
  return cmd('GET', `/access-explain/${collection}/${id}`)
}

/** Ask admins for access to a hidden record. Deduped per user+record per day
 *  (`already: true` on a repeat). */
export function requestRecordAccess(body: {
  collection: string
  item: string
  note?: string
}): Command<{ data: { requested: boolean; already?: boolean; notified?: number } }> {
  return cmd('POST', '/access-requests', undefined, body)
}

// ─── Presence (online list) ───────────────────────────────────────────────────

export interface OnlinePresenceUser {
  user_id: UUID | null
  display_name: string | null
  role_name: string | null
  current_path: string | null
  last_seen: ISODate
  is_idle: boolean
  last_active: ISODate | null
  /** Server-rendered "Collection › Record label" for the current path. */
  page: string | null
  app: string | null
  typing_room: string | null
  scopes: string[]
  scopes_by_dimension: Record<string, string[]>
  /** Live session recording id — admins only, null otherwise. */
  recording_id: string | null
}

export interface OnlinePresenceConfig {
  fields: string[]
  scope_dimensions: string[]
  admin_url: string
  dimensions: Array<{ name: string; label: string }>
}

/** Who is online, scoped by the viewer's own restrictions, with instance
 *  display config. Response carries `config` beside `data`. */
export function readOnlinePresence(): Command<{
  data: OnlinePresenceUser[]
  config: OnlinePresenceConfig
}> {
  return cmd('GET', '/presence/online')
}
