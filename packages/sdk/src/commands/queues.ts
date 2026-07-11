/**
 * Queue commands: cross-collection worklists — queue CRUD, source config,
 * item resolution (scoped/filtered/sorted/paginated), claims, saved views,
 * per-viewer default view, column prefs, trends, workload, rematerialize.
 */
import { type Command, cmd } from '../command.js'
import type { ISODate, UUID } from '../index.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type QueueViewKind = 'table' | 'kanban' | 'workload'
export type QueueScope = 'mine' | 'unowned' | 'all' | 'claimed'
export type QueueRowClickMode = 'preview' | 'layout' | 'full'
export type QueueSourceType = 'collection' | 'tasks' | 'approvals' | 'owned_by_me'

export interface QueueDisplayConfig {
  views: QueueViewKind[]
  default_view: QueueViewKind
  default_scope: Exclude<QueueScope, 'claimed'>
  work_next: boolean
  bulk_actions: boolean
  row_click: QueueRowClickMode
  item_layout: string | null
  sheet_width: number | string | null
  /** Ordered default column keys; null = automatic (standard + first two extras). */
  default_columns: string[] | null
}

export interface QueueCondition {
  field: string
  op: string
  value: unknown
}

export interface QueueSource {
  id: number
  type: QueueSourceType
  collection: string | null
  filters: QueueCondition[] | null
  state_values: string[] | null
  state_mode: 'include' | 'exclude' | null
  label_template: string | null
  extra_fields: string[] | null
  drilldown: Record<
    string,
    { enabled?: boolean; layout_id?: number | null; width?: number | string | null }
  > | null
  column_formats: Record<string, unknown> | null
  aggregates: Record<string, 'sum' | 'avg' | 'min' | 'max' | 'count'> | null
  sla_filter: 'warning' | 'breached' | null
  sort: number
}

export interface Queue {
  id: UUID
  name: string
  description: string | null
  owner: UUID
  is_shared: boolean
  role_id: UUID | null
  is_active: boolean
  claims_enabled: boolean
  materialized: boolean
  column_aliases: Record<string, string>
  display_config: QueueDisplayConfig
  created_at: ISODate
  updated_at: ISODate
}

export interface QueueDetail extends Queue {
  sources: QueueSource[]
  available_extra_fields?: string[]
  extra_field_meta?: Array<{ path: string; target_collection: string | null }>
}

export interface QueueOwner {
  id: UUID
  email: string
  first_name: string | null
  last_name: string | null
}

export interface QueueItem {
  collection: string
  item_id: string
  label: string
  state: string | null
  state_color: string | null
  owners: QueueOwner[]
  sla_status: 'ok' | 'warning' | 'breached' | null
  at_risk: boolean
  aging_hours: number | null
  claimed_by: QueueOwner | null
  /** Configured relation extra-field values, keyed by dotted path. */
  extra?: Record<string, unknown>
  /** Related-record ids per relation extra-field path — powers drill-down. */
  extra_ids?: Record<string, string[]>
  /** Admin-shaped item URL; prefer building your own links from collection+item_id. */
  url: string
}

export interface QueueStats {
  total: number
  by_state: Record<string, number>
  unowned: number
  sla_warning: number
  sla_breached: number
  at_risk: number
}

export interface QueueItemsResult {
  data: QueueItem[]
  stats: QueueStats
  /** Stats over the column-filtered set (null when no column filters active). */
  filtered_stats: QueueStats | null
  /** Distinct values per filterable column, for building filter dropdowns. */
  available_values: Record<string, string[]>
  /** True when a source hit the per-source hydration ceiling — rows truncated. */
  truncated?: boolean
  /** Full matched count (present when page/limit pagination was requested). */
  total?: number
}

export interface QueueWorkloadRow {
  owner: QueueOwner | null
  count: number
  /** The owner's strictest max_wip across all their owner groups; null = none. */
  max_wip: number | null
}

export interface QueueView {
  id: number
  name: string
  user: UUID
  is_shared: boolean
  role: UUID | null
  state: {
    scope?: QueueScope
    filters?: Record<string, string>
    sort?: string
    group_by?: string | null
    view?: QueueViewKind
    /** Ordered visible columns; null/absent = follow queue default_columns. */
    columns?: string[] | null
  } | null
}

export interface QueueTrendPoint {
  date: string
  total: number
  unowned: number
  sla_warning: number
  sla_breached: number
  at_risk: number
}

export interface QueueColumnPrefs {
  /** LEGACY — columns now come from display_config.default_columns + view snapshots. */
  visible_columns: string[] | null
  default_view_id: number | null
}

// ─── Queue CRUD ───────────────────────────────────────────────────────────────

/** List queues visible to the caller (own + shared, role-scoped). */
export function listQueues(): Command<{ data: Queue[] }> {
  return cmd('GET', '/queues')
}

/** Read one queue with its sources and resolved extra-field metadata. */
export function readQueue(id: UUID): Command<{ data: QueueDetail }> {
  return cmd('GET', `/queues/${id}`)
}

export function createQueue(data: {
  name: string
  description?: string | null
  is_shared?: boolean
  role_id?: UUID | null
  claims_enabled?: boolean
  display_config?: Partial<QueueDisplayConfig>
}): Command<{ data: QueueDetail }> {
  return cmd('POST', '/queues', undefined, data)
}

export function updateQueue(
  id: UUID,
  data: {
    name?: string
    description?: string | null
    is_shared?: boolean
    role_id?: UUID | null
    is_active?: boolean
    claims_enabled?: boolean
    column_aliases?: Record<string, string>
    display_config?: Partial<QueueDisplayConfig>
  }
): Command<{ data: QueueDetail }> {
  return cmd('PATCH', `/queues/${id}`, undefined, data)
}

export function deleteQueue(id: UUID): Command<void> {
  return cmd('DELETE', `/queues/${id}`)
}

/** Replace a queue's sources wholesale (max 10). Cache-affecting edits demote
 *  a materialized queue and enqueue a rebuild; display-only edits apply in place. */
export function updateQueueSources(
  id: UUID,
  sources: Array<Omit<QueueSource, 'id' | 'sort'> & { id?: number; sort?: number }>
): Command<{ data: QueueSource[] }> {
  return cmd('PATCH', `/queues/${id}/sources`, undefined, { sources })
}

/** Force a full materialized-cache rebuild (owner or admin). */
export function rematerializeQueue(id: UUID): Command<{ data: { enqueued: boolean } }> {
  return cmd('POST', `/queues/${id}/rematerialize`)
}

// ─── Items / stats ────────────────────────────────────────────────────────────

/** Resolve a queue's items. Omit page/limit for the full set (kanban); pass
 *  them for table pagination (adds `total`). `filters` = per-column contains
 *  filters keyed by column key ('state', 'owners', 'extra.<path>' …). */
export function readQueueItems(
  id: UUID,
  options: {
    scope?: QueueScope
    sort?: string
    filters?: Record<string, string>
    page?: number
    limit?: number
  } = {}
): Command<QueueItemsResult> {
  const { filters, ...rest } = options
  return cmd('GET', `/queues/${id}/items`, {
    ...rest,
    ...(filters ? { filters: JSON.stringify(filters) } : {})
  })
}

/** Items grouped per owner with each owner's WIP limit — the Workload view. */
export function readQueueWorkload(
  id: UUID
): Command<{ data: Array<QueueWorkloadRow & { items: QueueItem[] }> }> {
  return cmd('GET', `/queues/${id}/workload`)
}

/** Daily stat-snapshot series for the stat-tile sparklines.
 *  scope 'mine' returns the caller's own series; anything else = queue-wide. */
export function readQueueTrends(
  id: UUID,
  options: { days?: number; scope?: string } = {}
): Command<{ data: Record<string, QueueTrendPoint[]> }> {
  return cmd('GET', `/queues/${id}/trends`, options)
}

/** Sample rendered labels for a source's label template (builder preview). */
export function suggestQueueLabels(
  id: UUID,
  options: { collection: string; template?: string } = { collection: '' }
): Command<{ data: string[] }> {
  return cmd('GET', `/queues/${id}/label-suggest`, options)
}

/** Pipeline states available for a collection (builder state pickers).
 *  Includes the '__none__' sentinel for stateless items. */
export function readQueueCollectionStates(
  collection: string
): Command<{ data: Array<{ id: string; key: string; label: string; color: string | null }> }> {
  return cmd('GET', `/queues/collection-states/${collection}`)
}

// ─── Claims ───────────────────────────────────────────────────────────────────

/** Claim an item in a queue (writes through to pipeline instance owners for
 *  real business records). 403 when the queue has claims disabled. */
export function claimQueueItem(
  id: UUID,
  item: { collection: string; item_id: string }
): Command<{ data: { claimed: boolean } }> {
  return cmd('POST', `/queues/${id}/claim`, undefined, item)
}

/** Release a claim (self-added instance-owner grants are removed too). */
export function releaseQueueItem(
  id: UUID,
  item: { collection: string; item_id: string }
): Command<{ data: { released: boolean } }> {
  return cmd('POST', `/queues/${id}/release`, undefined, item)
}

// ─── Saved views ──────────────────────────────────────────────────────────────

/** Saved views visible to the caller (own + shared behind queue visibility). */
export function listQueueViews(id: UUID): Command<{ data: QueueView[] }> {
  return cmd('GET', `/queues/${id}/views`)
}

export function createQueueView(
  id: UUID,
  data: { name: string; is_shared?: boolean; role?: UUID | null; state: QueueView['state'] }
): Command<{ data: QueueView }> {
  return cmd('POST', `/queues/${id}/views`, undefined, data)
}

/** Overwrite a view's name/sharing/state in place (owner or admin). */
export function updateQueueView(
  viewId: number,
  data: { name?: string; is_shared?: boolean; state?: QueueView['state'] }
): Command<{ data: QueueView }> {
  return cmd('PATCH', `/queues/views/${viewId}`, undefined, data)
}

export function deleteQueueView(viewId: number): Command<void> {
  return cmd('DELETE', `/queues/views/${viewId}`)
}

// ─── Per-viewer prefs ─────────────────────────────────────────────────────────

/** The caller's per-queue prefs (default saved view; visible_columns is legacy). */
export function readQueueColumnPrefs(id: UUID): Command<{ data: QueueColumnPrefs }> {
  return cmd('GET', `/queues/${id}/column-prefs`)
}

/** Star/unstar a saved view as the caller's default for this queue
 *  (null reverts to the queue's general default). */
export function setQueueDefaultView(
  id: UUID,
  viewId: number | null
): Command<{ data: { default_view_id: number | null } }> {
  return cmd('PUT', `/queues/${id}/default-view`, undefined, { view_id: viewId })
}
