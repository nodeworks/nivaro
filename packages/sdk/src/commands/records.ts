/**
 * Record commands beyond plain CRUD: rehearsed updates, filter checks, slug and distinct
 * reads, bulk and batch writes, the trash bin, owner history, comment counts and reactions,
 * the pipeline outline a caller may act on, and the sign-in session (logout, socket token).
 *
 * Every write goes through the items service AS THE CALLER — permissions, row filters,
 * User Scopes, validation, hooks, revisions and edit locks all apply, row by row.
 */
import { type Command, cmd } from '../command.js'
import type { ISODate, UUID } from '../index.js'

// ─── Items: rehearsal, checks, lookups ────────────────────────────────────────

/** What an update would do. Nothing is stored. */
export interface UpdateDryRunReport {
  dry_run: true
  ok: boolean
  /** The status the real request would answer. */
  status: number
  would: 'update' | null
  id: string | number
  /** Stored fields the write would change, as the caller reads them before and after. */
  changes: Array<{ field: string; from: unknown; to: unknown }>
  /** Fields the write names whose value would stay as it is. */
  unchanged: string[]
  /** Fields the write would change that the caller may not read: names only. */
  hidden: string[]
  /** Changed fields the caller did not send (rules, derived values, audit stamps). */
  filled: string[]
  /** Keys of the payload that are stored nowhere. */
  ignored: string[]
  links: Record<string, Array<string | number>>
  nested: Record<string, Array<Record<string, unknown>>>
  notes: string[]
  change_reason?: string
  error?: string
  code?: string
  /** Someone else holds the record's edit lock. */
  locked_by_name?: string | null
  violations?: unknown
  fields?: unknown
  conflicts?: unknown
}

/**
 * Rehearse an update (`PATCH ?dry_run=1`): rules, validation, the edit lock and the
 * database's own checks run, the write is rolled back. The report lists `changes` (field,
 * from, to) or why it would be refused.
 */
export function rehearseUpdateItem<T = Record<string, unknown>>(
  collection: string,
  id: string | number,
  data: Partial<T>
): Command<UpdateDryRunReport> {
  return cmd('PATCH', `/items/${collection}/${id}`, { dry_run: 1 }, data)
}

export interface FilterProblem {
  path: string
  code: string
  message: string
  fix?: string
}

export interface FilterCheck {
  ok: boolean
  collection: string
  errors: FilterProblem[]
  warnings: FilterProblem[]
  /** A corrected filter when the server could suggest one. */
  suggestion: Record<string, unknown> | null
  clauses: number
  truncated?: boolean
}

/**
 * Check a filter against the server's own gates (unknown fields, operators, types, fields
 * the caller may not filter on) without reading a row.
 */
export function checkItemFilter(
  collection: string,
  filter: Record<string, unknown>
): Command<{ data: FilterCheck }> {
  return cmd('GET', `/items/${collection}/filter-check`, { filter: JSON.stringify(filter) })
}

/**
 * One record by its alias / friendly id or the collection's slug field (404 when none
 * matches or the caller cannot read it).
 */
export function readItemBySlug<T = Record<string, unknown>>(
  collection: string,
  slug: string,
  query?: { fields?: string[] }
): Command<{ data: T }> {
  return cmd(
    'GET',
    `/items/${collection}/by-slug/${encodeURIComponent(slug)}`,
    query?.fields?.length ? { fields: query.fields.join(',') } : undefined
  )
}

/**
 * Distinct non-null values of one stored column over the rows the caller may read — for a
 * filter dropdown. Default 200 values, max 500.
 */
export function readItemDistinct(
  collection: string,
  field: string,
  limit?: number
): Command<{ data: unknown[] }> {
  return cmd('GET', `/items/${collection}/distinct`, limit != null ? { field, limit } : { field })
}

// ─── Items: bulk and batch writes ─────────────────────────────────────────────

/**
 * Set the same values on several records. A record that already holds every value is
 * `skipped`; one whose form locks a field for the caller is `refused` (`by_form: true` also
 * refuses fields that are not on the record's form). Per-record failures never fail the call.
 */
export function bulkUpdateItems(
  collection: string,
  ids: Array<string | number>,
  data: Record<string, unknown>,
  opts?: { by_form?: boolean }
): Command<{ updated: number; skipped: number; refused: number; refused_reason?: string }> {
  return cmd('POST', `/items/${collection}/bulk-update`, undefined, {
    ids,
    data,
    ...(opts?.by_form ? { by_form: true } : {})
  })
}

/** Delete several records; ones the caller may not delete are skipped (not counted). */
export function bulkDeleteItems(
  collection: string,
  ids: Array<string | number>
): Command<{ deleted: number }> {
  return cmd('POST', `/items/${collection}/bulk-delete`, undefined, { ids })
}

/**
 * Run one pipeline transition on several records. `comment` is the note a transition that
 * requires one asks for, given once for all.
 */
export function bulkTransitionItems(
  collection: string,
  ids: Array<string | number>,
  transitionId: string,
  comment?: string
): Command<{ succeeded: number; failed: number; errors: Array<{ item: string; error: string }> }> {
  return cmd('POST', `/items/${collection}/bulk-transition`, undefined, {
    ids,
    transition_id: transitionId,
    ...(comment ? { comment } : {})
  })
}

export interface BatchWriteResult {
  op: 'create' | 'update'
  index: number
  ok: boolean
  id?: string | number
  data?: Record<string, unknown>
  error?: string
  /** Written, but hidden from the writer's own read-back (User Scope / row filter). */
  readable?: false
  link_failures?: string[]
}

/**
 * Create and update up to 100 records in one call, one result per row. The API answers
 * 422 (a NivaroError whose `response.data` holds the results) when every row failed.
 */
export function batchItems(
  collection: string,
  body: {
    create?: Array<Record<string, unknown>>
    /** Each row names its `id`. */
    update?: Array<Record<string, unknown> & { id: string | number }>
  }
): Command<{ data: { results: BatchWriteResult[]; ok: number; failed: number } }> {
  return cmd('POST', `/items/${collection}/batch`, undefined, body)
}

export interface BulkRowResult {
  index: number
  op: 'create' | 'update'
  status: number
  id?: string | number
  data?: Record<string, unknown>
  error?: string
  code?: string
  /** A create the collection's natural key routed to an existing record. */
  upserted?: boolean
  readable?: false
}

export interface BulkWriteOutcome {
  results: BulkRowResult[]
  ok: number
  failed: number
  rolled_back: boolean
  stopped_at: number | null
  leftover: Array<string | number>
}

/**
 * Up to 500 rows in one call: a row with an `id` is an update, without one a create
 * (answers 207 with per-row status). `atomic: true` = creates only, all or nothing (a
 * refused row → 422 BULK_ATOMIC_REFUSED, nothing kept). `returnIds` answers ids only.
 */
export function bulkWriteItems(
  collection: string,
  rows: Array<Record<string, unknown>>,
  opts?: { atomic?: boolean; returnIds?: boolean }
): Command<{ data: BulkWriteOutcome }> {
  return cmd('POST', `/items/${collection}/bulk`, opts?.returnIds ? { return: 'ids' } : undefined, {
    rows,
    ...(opts?.atomic ? { atomic: true } : {})
  })
}

/**
 * Queue a bulk write as a background job (`?async=1`, 202). Read its results with
 * {@link readBulkRun} — they are kept 24 hours.
 */
export function queueBulkWriteItems(
  collection: string,
  rows: Array<Record<string, unknown>>,
  opts?: { atomic?: boolean; returnIds?: boolean }
): Command<{
  data: { run_id: number; total: number; status: 'running'; results_url: string }
}> {
  return cmd(
    'POST',
    `/items/${collection}/bulk`,
    { async: 1, ...(opts?.returnIds ? { return: 'ids' } : {}) },
    { rows, ...(opts?.atomic ? { atomic: true } : {}) }
  )
}

/** The results of a queued bulk write (its owner or an admin). */
export function readBulkRun(
  collection: string,
  runId: number
): Command<{
  data: Partial<BulkWriteOutcome> & {
    run_id: number
    collection: string
    job: Record<string, unknown> | null
  } & Record<string, unknown>
}> {
  return cmd('GET', `/items/${collection}/bulk/${runId}`)
}

// ─── Trash ────────────────────────────────────────────────────────────────────

export interface TrashEntry {
  id: number
  collection: string
  item_id: string
  label: string
  deleted_by: UUID | null
  deleted_by_name: string | null
  deleted_at: ISODate
}

/**
 * Deleted records: administrators see every deletion, everyone else their own. `collections`
 * lists every collection with entries in the caller's view (for a filter).
 */
export function listTrash(query?: {
  collection?: string
  /** Contains-match over the snapshot and the item id. */
  search?: string
  /** Only deletions in the last N days. */
  days?: number
  page?: number
  /** Default 50, max 100. */
  limit?: number
}): Command<{
  data: TrashEntry[]
  collections: string[]
  total: number
  page: number
  limit: number
}> {
  const params: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') params[k] = v
  return cmd('GET', '/trash', params)
}

/**
 * The latest deletion of one record — described only to an unrestricted admin or the person
 * who deleted it (`data: null` otherwise, the same as "not deleted").
 */
export function readRecordDeletion(
  collection: string,
  item: string | number
): Command<{
  data: {
    deleted_at: ISODate
    deleted_by_name: string | null
    can_restore: boolean
    trash_id: number | null
  } | null
}> {
  return cmd('GET', '/trash/record', { collection, item })
}

/** Put a deleted record back with its original id (create permission required; 409 if taken). */
export function restoreTrashItem(
  trashId: number
): Command<{ data: { restored: true; collection: string; item_id: string } }> {
  return cmd('POST', `/trash/${trashId}/restore`)
}

/** Restore up to 100 entries, one result each (never all-or-nothing). */
export function bulkRestoreTrash(ids: number[]): Command<{
  data: {
    results: Array<{
      id: number
      ok: boolean
      collection?: string
      item_id?: string
      error?: string
    }>
    restored: number
    failed: number
  }
}> {
  return cmd('POST', '/trash/bulk-restore', undefined, { ids })
}

/** Purge an entry for good (admin or the deleter; 423 while the record is under legal hold). */
export function purgeTrashItem(trashId: number): Command<{ data: { purged: true } }> {
  return cmd('DELETE', `/trash/${trashId}`)
}

// ─── Owner history ────────────────────────────────────────────────────────────

export interface OwnerHistoryEntry {
  state_label: string | null
  entered_at: ISODate
  left_at: ISODate | null
  moved_by: string | null
  /** The state's resolved owners. */
  owners: Array<{ id: UUID; name: string }>
}

/** Who owned a record in each pipeline state it passed through, oldest first. */
export function readOwnerHistory(
  collection: string,
  item: string | number
): Command<{ data: OwnerHistoryEntry[] }> {
  return cmd('GET', `/owner-history/${collection}/${item}`)
}

// ─── Comments: counts and reactions ───────────────────────────────────────────

/** Comment counts per record id (up to 500 ids; only rows the caller can open are counted). */
export function readCommentCounts(
  collection: string,
  ids: Array<string | number>
): Command<{ data: Record<string, number> }> {
  return cmd('GET', '/comments/counts', { collection, ids: ids.join(',') })
}

/** The reactions a comment or recorded note takes. */
export type CommentReaction = '👍' | '✅' | '👀' | '🎉' | '❤️' | '😂'

/** Toggle the caller's reaction on a comment. */
export function toggleCommentReaction(
  commentId: string,
  emoji: CommentReaction
): Command<{ data: { reacted: boolean } }> {
  return cmd('POST', `/comments/${commentId}/reactions`, undefined, { emoji })
}

/** Toggle a reaction on a recorded note (transition comment, change reason) by its entry key. */
export function toggleEntryReaction(body: {
  collection: string
  item: string | number
  entry_key: string
  emoji: CommentReaction
}): Command<{ data: { reacted: boolean } }> {
  return cmd('POST', '/comments/entry-reactions', undefined, body)
}

// ─── Pipelines: what a caller may act on ──────────────────────────────────────

export interface PipelineOutline {
  id: UUID
  name: string | null
  states: Array<{
    id: UUID
    key: string
    label: string
    color: string | null
    sort: number | null
    is_initial: boolean
    is_terminal: boolean
  }>
  /** Manual transitions the caller's role may run (automatic ones are left out). */
  transitions: Array<{
    id: UUID
    label: string
    from_state: UUID | null
    to_state: UUID
    color: string | null
    sort: number | null
    group_label: string | null
    require_owner: boolean
    allow_creator: boolean
  }>
}

/** A pipeline's states and the manual transitions the caller's role may run (any sign-in). */
export function readPipelineOutline(templateId: string): Command<{ data: PipelineOutline }> {
  return cmd('GET', `/pipelines/${templateId}/outline`)
}

export interface OwnerSeat {
  group_id: UUID
  group_name: string | null
  /** The group's filters, named by dimension label. */
  filters: unknown
  is_default: boolean | number | null
  state_label: string
  state_key: string
  template_id: UUID
  template_name: string
}

/** The owner-matrix seats the caller holds across every pipeline. */
export function readMyOwnerSeats(): Command<{ data: OwnerSeat[] }> {
  return cmd('GET', '/pipelines/my-seats')
}

// ─── Sign-in session ──────────────────────────────────────────────────────────

/** End the current session (cookie sign-in; also ends any View-as the person started). */
export function logout(): Command<{ ok: true }> {
  return cmd('POST', '/auth/logout')
}

/** End every session of the caller across apps and tabs. */
export function logoutAll(): Command<{ ok: true; destroyed: number }> {
  return cmd('POST', '/auth/logout-all')
}

/**
 * A one-time socket token (2 minutes) for `createRealtime().connect(url, getter)` — the way
 * a session-cookie, API-key or static-token caller signs a socket in. 403 WS_UNBINDABLE for
 * a sign-in with nothing to bind the socket to.
 */
export function readWsToken(): Command<{ token: string }> {
  return cmd('GET', '/auth/ws-token')
}

export interface AuthProviders {
  oidc: { enabled: boolean; label: string }
  static_token: { enabled: boolean }
  saml: { enabled: boolean; label: string }
  password: { enabled: boolean }
  sso: Array<{
    id: number
    key: string
    label: string
    logo_url?: string | null
    button_color?: string | null
  }>
}

/** The sign-in methods this instance offers (public; display data only). */
export function readAuthProviders(): Command<{ data: AuthProviders }> {
  return cmd('GET', '/auth/providers')
}
