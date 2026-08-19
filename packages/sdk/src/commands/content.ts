/**
 * Content-operations commands: export, draft/publish, scheduled changes,
 * field config/groups, virtual collections, record templates, collection
 * presets, field translations, sub-rows, addendums & change orders,
 * clone / rollback / field history.
 */
import { type Command, cmd } from '../command.js'
import type { ISODate, UUID } from '../index.js'

// ─── Content export ───────────────────────────────────────────────────────────

export type ContentExportFormat = 'csv' | 'json' | 'xlsx'

export interface ContentExportOptions {
  /** Defaults to 'json'. 'csv' resolves to the raw CSV text. */
  format?: ContentExportFormat
  /** Simple equality filters: { status: 'active' } */
  filters?: Record<string, unknown>
  /** Restrict exported columns. */
  fields?: string[]
}

/**
 * Export a collection. JSON format resolves to `{ data: rows }`;
 * CSV format resolves to the raw CSV string.
 */
export function exportContent(
  collection: string,
  options?: ContentExportOptions
): Command<string | { data: Record<string, unknown>[] }> {
  return cmd('POST', `/content-export/${collection}`, undefined, options ?? {})
}

// ─── Draft / Publish ──────────────────────────────────────────────────────────

export interface DraftPublishConfig {
  collection: string
  draft_publish_enabled: boolean
}

export type DraftStatus = 'draft' | 'review' | 'published'

export function readDraftPublishConfig(collection: string): Command<{ data: DraftPublishConfig }> {
  return cmd('GET', `/draft-publish/${collection}/config`)
}

/** Enable/disable draft-publish for a collection (admin). */
export function updateDraftPublishConfig(
  collection: string,
  enabled: boolean
): Command<{ data: DraftPublishConfig }> {
  return cmd('PATCH', `/draft-publish/${collection}/config`, undefined, {
    draft_publish_enabled: enabled
  })
}

export function publishItem(
  collection: string,
  id: string | number
): Command<{ data: { id: string; _status: DraftStatus } }> {
  return cmd('POST', `/draft-publish/${collection}/${id}/publish`)
}

export function unpublishItem(
  collection: string,
  id: string | number
): Command<{ data: { id: string; _status: DraftStatus } }> {
  return cmd('POST', `/draft-publish/${collection}/${id}/unpublish`)
}

export function submitItemForReview(
  collection: string,
  id: string | number
): Command<{ data: { id: string; _status: DraftStatus } }> {
  return cmd('POST', `/draft-publish/${collection}/${id}/submit-review`)
}

// ─── Scheduled changes ────────────────────────────────────────────────────────

export interface ScheduledChange {
  id: UUID
  collection: string
  item_id: string
  change_type: 'field_update' | 'workflow_transition'
  changes: Record<string, unknown>
  scheduled_at: ISODate
  status: 'pending' | 'executed' | 'cancelled' | 'failed'
  executed_at: ISODate | null
  created_by: UUID
  created_at: ISODate
  updated_at: ISODate
}

/** List all scheduled changes (admin), optionally filtered. */
export function listScheduledChanges(query?: {
  collection?: string
  status?: string
}): Command<{ data: ScheduledChange[] }> {
  const params: Record<string, unknown> = {}
  if (query?.collection) params.collection = query.collection
  if (query?.status) params.status = query.status
  return cmd('GET', '/scheduled-changes', params)
}

/** List scheduled changes for a single item. */
export function listItemScheduledChanges(
  collection: string,
  itemId: string | number
): Command<{ data: ScheduledChange[] }> {
  return cmd('GET', `/scheduled-changes/${collection}/${itemId}`)
}

export function createScheduledChange(body: {
  collection: string
  item_id: string
  change_type: 'field_update' | 'workflow_transition'
  changes: Record<string, unknown>
  /** ISO date string. */
  scheduled_at: string
}): Command<{ data: ScheduledChange }> {
  return cmd('POST', '/scheduled-changes', undefined, body)
}

/** Cancel a pending scheduled change (own or admin). */
export function cancelScheduledChange(id: UUID): Command<void> {
  return cmd('DELETE', `/scheduled-changes/${id}`)
}

/** Execute a pending scheduled change immediately (admin). */
export function executeScheduledChange(
  id: UUID
): Command<{ data: { id: UUID; status: 'executed'; executed_at: ISODate } }> {
  return cmd('POST', `/scheduled-changes/${id}/execute`)
}

// ─── Field config ─────────────────────────────────────────────────────────────

export interface CascadeFilterRule {
  parent_field: string
  filter_column: string
  clear_on_parent_change?: boolean
  clear_on_unavailable?: boolean
}

export interface FieldDependencyConfig {
  cascade_filters?: CascadeFilterRule[]
  depends_on?: string[]
  cascade?: 'clear' | 'recalculate'
  [key: string]: unknown
}

export interface FieldCondition {
  field: string
  operator: 'eq' | 'neq' | 'null' | 'nnull' | 'in' | 'nin' | 'gt' | 'lt'
  value?: unknown
}

export interface FieldVisibilityRules {
  show_when?: FieldCondition[]
  hide_when?: FieldCondition[]
}

export interface FieldConfig {
  field: string
  label: string | null
  placeholder?: string | null
  group_key: string | null
  visibility_rules: FieldVisibilityRules | null
  dependency_config: FieldDependencyConfig | null
  validation_rules: unknown | null
  lock_condition: FieldCondition | null
  default_formula: string | null
  cross_record_defaults: unknown | null
  remote_options_config: Record<string, unknown> | null
  repeater_schema: unknown | null
  is_translatable: boolean
}

export function readFieldConfig(collection: string): Command<{ data: FieldConfig[] }> {
  return cmd('GET', `/field-config/${collection}`)
}

/** Update one field's behavioral config (admin). */
export function updateFieldConfig(
  collection: string,
  field: string,
  body: Partial<Omit<FieldConfig, 'field'>>
): Command<{ data: FieldConfig }> {
  return cmd('PATCH', `/field-config/${collection}/${field}`, undefined, body)
}

/** Evaluate visibility rules against current form values. */
export function evaluateFieldVisibility(
  collection: string,
  values: Record<string, unknown>
): Command<{ hidden_fields: string[] }> {
  return cmd('POST', `/field-config/${collection}/evaluate-visibility`, undefined, { values })
}

/** Evaluate default formulas after a trigger field changed. */
export function evaluateFieldDefaults(
  collection: string,
  triggerField: string,
  values: Record<string, unknown>
): Command<{ updates: Record<string, unknown> }> {
  return cmd('POST', `/field-config/${collection}/evaluate-defaults`, undefined, {
    trigger_field: triggerField,
    values
  })
}

/** Evaluate lock conditions against current form values. */
export function evaluateFieldLock(
  collection: string,
  values: Record<string, unknown>
): Command<{ locked_fields: string[] }> {
  return cmd('POST', `/field-config/${collection}/evaluate-lock`, undefined, { values })
}

/** Resolve dependent-field cascades after a field changed. */
export function cascadeFieldDependencies(
  collection: string,
  changedField: string,
  values: Record<string, unknown>
): Command<{ updates: Record<string, unknown>; option_filters: Record<string, unknown> }> {
  return cmd('POST', `/field-config/${collection}/cascade`, undefined, {
    changed_field: changedField,
    values
  })
}

// ─── Field groups ─────────────────────────────────────────────────────────────

export interface FieldGroup {
  id: number
  collection: string
  key: string
  label: string
  type: string
  icon: string | null
  sort: number
  is_collapsed: boolean | number
}

export function listFieldGroups(collection: string): Command<{ data: FieldGroup[] }> {
  return cmd('GET', `/field-groups/${collection}`)
}

export function createFieldGroup(body: {
  collection: string
  key: string
  label: string
  type: string
  icon?: string
  sort?: number
  is_collapsed?: boolean
}): Command<{ data: FieldGroup }> {
  return cmd('POST', '/field-groups', undefined, body)
}

export function updateFieldGroup(
  id: number,
  body: Partial<{
    key: string
    label: string
    type: string
    icon: string | null
    sort: number
    is_collapsed: boolean
  }>
): Command<{ data: FieldGroup }> {
  return cmd('PATCH', `/field-groups/${id}`, undefined, body)
}

export function deleteFieldGroup(id: number): Command<void> {
  return cmd('DELETE', `/field-groups/${id}`)
}

export function reorderFieldGroups(
  collection: string,
  order: Array<{ id: number; sort: number }>
): Command<{ data: Array<Pick<FieldGroup, 'id' | 'key' | 'label' | 'sort'>> }> {
  return cmd('POST', '/field-groups/reorder', undefined, { collection, order })
}

// ─── Virtual collections ──────────────────────────────────────────────────────

export interface VirtualCollection {
  id: number
  collection: string
  display_name: string
  virtual_sql: string
  is_virtual: boolean | number
  created_at: ISODate
  updated_at: ISODate
}

export function listVirtualCollections(): Command<{ data: VirtualCollection[] }> {
  return cmd('GET', '/virtual-collections')
}

export function createVirtualCollection(body: {
  name: string
  display_name: string
  virtual_sql: string
}): Command<{ data: VirtualCollection }> {
  return cmd('POST', '/virtual-collections', undefined, body)
}

export function updateVirtualCollection(
  collection: string,
  body: Partial<{ display_name: string; virtual_sql: string }>
): Command<{ data: VirtualCollection }> {
  return cmd('PATCH', `/virtual-collections/${collection}`, undefined, body)
}

export function deleteVirtualCollection(collection: string): Command<void> {
  return cmd('DELETE', `/virtual-collections/${collection}`)
}

/** Execute the stored SQL of a virtual collection (capped at 100 rows). */
export function queryVirtualCollection(
  collection: string
): Command<{ data: Record<string, unknown>[] }> {
  return cmd('POST', `/virtual-collections/${collection}/query`)
}

/** Validate SQL without executing it (admin). Omitting `sql` validates the stored SQL. */
export function validateVirtualCollectionSql(
  collection: string,
  sql?: string
): Command<{ valid: boolean; error?: string }> {
  return cmd(
    'POST',
    `/virtual-collections/${collection}/validate-sql`,
    undefined,
    sql ? { sql } : {}
  )
}

// ─── Record templates ─────────────────────────────────────────────────────────

export interface RecordTemplate {
  id: number
  collection: string
  name: string
  description: string | null
  data: Record<string, unknown>
  role_id: string | null
  is_shared: boolean
  created_by: UUID
  created_at: ISODate
  updated_at: ISODate
}

/** List record templates visible to the caller, optionally per collection. */
export function listRecordTemplates(collection?: string): Command<{ data: RecordTemplate[] }> {
  return cmd('GET', '/record-templates', collection ? { collection } : undefined)
}

export function createRecordTemplate(body: {
  collection: string
  name: string
  description?: string
  data: Record<string, unknown>
  role_id?: string | null
  is_shared?: boolean
}): Command<{ data: RecordTemplate }> {
  return cmd('POST', '/record-templates', undefined, body)
}

export function updateRecordTemplate(
  id: number,
  body: Partial<{
    name: string
    description: string | null
    data: Record<string, unknown>
    role_id: string | null
    is_shared: boolean
  }>
): Command<{ data: RecordTemplate }> {
  return cmd('PATCH', `/record-templates/${id}`, undefined, body)
}

export function deleteRecordTemplate(id: number): Command<void> {
  return cmd('DELETE', `/record-templates/${id}`)
}

/** Returns the template's data payload for merging into a form. */
export function applyRecordTemplate(id: number): Command<{ data: Record<string, unknown> }> {
  return cmd('POST', `/record-templates/${id}/apply`)
}

// ─── Collection presets ───────────────────────────────────────────────────────

export interface CollectionPresetSummary {
  id: string
  name: string
  description: string
  collections: string[]
  fields_count: number
}

export function listCollectionPresets(): Command<{ data: CollectionPresetSummary[] }> {
  return cmd('GET', '/collection-presets')
}

/** Install a built-in preset's collections/fields/relations/alerts (admin). */
export function installCollectionPreset(id: string): Command<{ installed: string[] }> {
  return cmd('POST', `/collection-presets/${id}/install`)
}

// ─── Field translations ───────────────────────────────────────────────────────

/** `{ [field]: { [locale]: value } }` */
export type FieldTranslations = Record<string, Record<string, string>>

/** Available locales configured in settings (defaults to ['en']). */
export function getLocales(): Command<{ data: string[] }> {
  return cmd('GET', '/field-translations/locales')
}

export function getTranslations(
  collection: string,
  itemId: string | number
): Command<{ data: FieldTranslations }> {
  return cmd('GET', `/field-translations/${collection}/${itemId}`)
}

/** Upsert translations. Body shape: { [field]: { [locale]: value } }. */
export function setTranslations(
  collection: string,
  itemId: string | number,
  translations: FieldTranslations
): Command<{ data: FieldTranslations }> {
  return cmd('PATCH', `/field-translations/${collection}/${itemId}`, undefined, translations)
}

/** Translations for a single field: { [locale]: value }. */
export function getFieldTranslations(
  collection: string,
  itemId: string | number,
  field: string
): Command<{ data: Record<string, string> }> {
  return cmd('GET', `/field-translations/${collection}/${itemId}/${field}`)
}

export function deleteFieldTranslations(
  collection: string,
  itemId: string | number,
  field: string
): Command<void> {
  return cmd('DELETE', `/field-translations/${collection}/${itemId}/${field}`)
}

// ─── Sub-rows ─────────────────────────────────────────────────────────────────

export interface SubRow {
  id: number
  sort: number
  data: Record<string, unknown>
}

export interface SubRowTemplate {
  id: number
  collection: string
  field: string
  name: string
  items: Record<string, unknown>[]
  created_by: UUID
  created_at: ISODate
  updated_at: ISODate
}

export function listSubRows(
  collection: string,
  itemId: string | number,
  field: string
): Command<{ data: SubRow[] }> {
  return cmd('GET', `/sub-rows/${collection}/${itemId}/${field}`)
}

export function addSubRow(
  collection: string,
  itemId: string | number,
  field: string,
  data: Record<string, unknown>
): Command<{ data: SubRow }> {
  return cmd('POST', `/sub-rows/${collection}/${itemId}/${field}`, undefined, { data })
}

/** Bulk replace all sub-rows for a parent field. */
export function replaceSubRows(
  collection: string,
  itemId: string | number,
  field: string,
  items: Array<{ id?: number | string; sort: number; data: Record<string, unknown> }>
): Command<{ data: SubRow[] }> {
  return cmd('PATCH', `/sub-rows/${collection}/${itemId}/${field}`, undefined, { items })
}

export function deleteSubRow(
  collection: string,
  itemId: string | number,
  field: string,
  subRowId: number | string
): Command<void> {
  return cmd('DELETE', `/sub-rows/${collection}/${itemId}/${field}/${subRowId}`)
}

export function reorderSubRows(body: {
  collection: string
  item_id: string
  field: string
  order: Array<{ id: number | string; sort: number }>
}): Command<{ data: SubRow[] }> {
  return cmd('POST', '/sub-rows/reorder', undefined, body)
}

export function listSubRowTemplates(
  collection: string,
  field: string
): Command<{ data: SubRowTemplate[] }> {
  return cmd('GET', `/sub-rows/templates/${collection}/${field}`)
}

export function createSubRowTemplate(body: {
  collection: string
  field: string
  name: string
  items: Record<string, unknown>[]
}): Command<{ data: SubRowTemplate }> {
  return cmd('POST', '/sub-rows/templates', undefined, body)
}

export function deleteSubRowTemplate(id: number): Command<void> {
  return cmd('DELETE', `/sub-rows/templates/${id}`)
}

/** Returns the template's sub-rows for merging into the editor. */
export function applySubRowTemplate(id: number): Command<{ items: Record<string, unknown>[] }> {
  return cmd('POST', `/sub-rows/templates/${id}/apply`)
}

// ─── Addendums & change orders ────────────────────────────────────────────────

export type AddendumStatus = 'draft' | 'review' | 'approved' | 'rejected'

export interface Addendum {
  id: UUID
  parent_collection: string
  parent_id: string
  title: string
  description: string | null
  workflow_template_id: UUID | null
  fields_schema: unknown | null
  data: Record<string, unknown> | null
  cost_impact: number | null
  timeline_impact_days: number | null
  status: AddendumStatus
  approved_by: UUID | null
  approved_at: ISODate | null
  created_by: UUID
  created_at: ISODate
  updated_at: ISODate
}

export interface ChangeOrder {
  id: number
  addendum_id: UUID
  parent_collection: string
  parent_id: string
  approved_by: UUID
  approved_at: ISODate
  addendum_title: string | null
  addendum_description: string | null
  cost_impact: number | null
  timeline_impact_days: number | null
  created_at: ISODate
  updated_at: ISODate
}

export function listAddendums(
  collection: string,
  itemId: string | number
): Command<{ data: Addendum[] }> {
  return cmd('GET', `/addendums/${collection}/${itemId}`)
}

export function readAddendum(id: UUID): Command<{ data: Addendum }> {
  return cmd('GET', `/addendums/${id}`)
}

export function createAddendum(body: {
  parent_collection: string
  parent_id: string
  title: string
  description?: string
  workflow_template_id?: string | null
  fields_schema?: unknown
  data?: Record<string, unknown>
  cost_impact?: number | null
  timeline_impact_days?: number | null
  /** nivaro_files ids to attach (server caps at 50). */
  attachments?: string[]
}): Command<{ data: Addendum }> {
  return cmd('POST', '/addendums', undefined, body)
}

export function updateAddendum(
  id: UUID,
  body: Partial<{
    title: string
    description: string | null
    fields_schema: unknown
    data: Record<string, unknown>
    cost_impact: number | null
    timeline_impact_days: number | null
  }>
): Command<{ data: Addendum }> {
  return cmd('PATCH', `/addendums/${id}`, undefined, body)
}

/** Delete an addendum (admin only). */
export function deleteAddendum(id: UUID): Command<void> {
  return cmd('DELETE', `/addendums/${id}`)
}

/** draft → review */
export function submitAddendum(id: UUID): Command<{ data: { id: UUID; status: 'review' } }> {
  return cmd('POST', `/addendums/${id}/submit`)
}

/** review → approved; creates a change-order entry. */
export function approveAddendum(id: UUID): Command<{ data: { id: UUID; status: 'approved' } }> {
  return cmd('POST', `/addendums/${id}/approve`)
}

export function rejectAddendum(id: UUID): Command<{ data: { id: UUID; status: 'rejected' } }> {
  return cmd('POST', `/addendums/${id}/reject`)
}

/** Approved change orders for a parent record (joined with addendum info). */
export function listChangeOrders(
  collection: string,
  itemId: string | number
): Command<{ data: ChangeOrder[] }> {
  return cmd('GET', `/addendums/change-orders/${collection}/${itemId}`)
}

// ─── Clone / rollback / field history ─────────────────────────────────────────

/** Clone an item; returns the new item's id. Draft-publish collections clone as drafts. */
export function cloneItem(
  collection: string,
  id: string | number,
  options?: {
    field_overrides?: Record<string, unknown>
    exclude_fields?: string[]
    include_sub_rows?: string[]
  }
): Command<{ data: { id: string | number } }> {
  return cmd('POST', `/items/${collection}/${id}/clone`, undefined, options)
}

export interface FieldHistoryEntry {
  revision_id: number
  timestamp: ISODate
  value: unknown
  user_id: UUID | null
}

/** Change history of a single field (latest 50 revisions). */
export function readFieldHistory(
  collection: string,
  id: string | number,
  field: string
): Command<{ data: FieldHistoryEntry[] }> {
  return cmd('GET', `/items/${collection}/${id}/field-history/${field}`)
}

/** Restore an item's state from a revision snapshot. */
export function rollbackRevision(
  revisionId: number
): Command<{ data: { success: boolean; collection: string; item: string } }> {
  return cmd('POST', `/revisions/${revisionId}/rollback`)
}

// ─── Additions: record templates per collection, layout lookups ──────────────

/** Record templates available for one collection (personal + shared + role). */
export function listCollectionRecordTemplates(collection: string): Command<{ data: unknown[] }> {
  return cmd('GET', `/record-templates/${collection}`)
}

/** One layout by id (any type). */
export function readCollectionLayout(id: number): Command<{ data: Record<string, unknown> }> {
  return cmd('GET', `/collection-layouts/${id}`)
}

/** Resolve the detail (drill-down) layout for a collection: explicit
 *  layout_id > active detail layout > null (callers fall back to the active
 *  grouped layout read-only). */
export function readDetailLayout(
  collection: string,
  layoutId?: number
): Command<{ data: Record<string, unknown> | null }> {
  return cmd(
    'GET',
    `/collection-layouts/detail/${collection}`,
    layoutId ? { layout_id: layoutId } : undefined
  )
}

/** Move the Ungrouped section's position within a layout's group order. */
export function updateLayoutUngroupedSort(
  id: number,
  ungroupedSort: number
): Command<{ data: { ungrouped_sort: number } }> {
  return cmd('PATCH', `/collection-layouts/${id}/ungrouped-sort`, undefined, {
    ungrouped_sort: ungroupedSort
  })
}

// ─── Record views ("since you last looked") ───────────────────────────────────

export interface RecordViewRecap {
  /** Baseline of the recap — the caller's previous visit. */
  since: ISODate
  /** Number of distinct fields other users changed since then. */
  field_changes: number
  /** Human labels of the changed fields (first 8). */
  fields: string[]
  /** Comments by others since the baseline. */
  comments: number
  /** Workflow transitions by others since the baseline. */
  transitions: number
  /** Display names of the people who edited (first 5). */
  editors: string[]
}

/**
 * Roll the caller's view watermark for a record and get back the recap of what
 * OTHERS changed since the previous visit, in one round trip. `data` is null on
 * a first visit, a same-session refresh with no prior baseline, or when nothing
 * changed. Call when opening a record.
 */
export function touchRecordView(
  collection: string,
  id: string | number
): Command<{ data: RecordViewRecap | null }> {
  return cmd('POST', `/record-views/${collection}/${id}/touch`, undefined, {})
}

// ─── Field change history (delta-mined) ───────────────────────────────────────

export interface FieldChangeEntry {
  /** The value the field BECAME at this point. */
  value: unknown
  /** Resolved display label — M2O FK → related record label, select value → choice text. */
  display: string | null
  timestamp: ISODate | null
  user_name: string | null
  action: string
}

/**
 * One field's actual value changes (newest first, max 25) mined from revision
 * deltas — consecutive identical values are deduped, M2O FKs resolve to display
 * labels. Distinct from `readFieldHistory`, which reads the older
 * /items/…/field-history route.
 */
export function readFieldChangeHistory(
  collection: string,
  id: string | number,
  field: string
): Command<{ data: FieldChangeEntry[] }> {
  return cmd('GET', `/field-history/${collection}/${id}/${field}`)
}

// ─── Import preview ───────────────────────────────────────────────────────────

export interface ImportPreviewDiff {
  /** 1-based file row (header = row 1). */
  row: number
  id: string
  kind: 'changed' | 'conflict'
  /** Present on conflicts: why the operator must look. */
  reason?: string
  fields: Array<{ field: string; old: unknown; new: unknown }>
}

export interface ImportPreview {
  /** Rows scanned (capped at 5,000 — `truncated` flags a bigger file). */
  total: number
  truncated: boolean
  new: number
  unchanged: number
  changed: number
  /** Existing-and-differs under strategy 'skip', or duplicate ids within the file. */
  conflicts: number
  field_change_counts: Record<string, number>
  /** Field-level old→new diffs for the first 50 changed/conflicted rows. */
  diffs: ImportPreviewDiff[]
}

/**
 * Dry-run a CSV import (admin) — mirrors the real import's matching exactly
 * (same id_field lookup, same strategy semantics) without writing anything.
 */
export function previewImportJob(body: {
  collection: string
  /** Raw CSV text including the header row. */
  csv_data: string
  /** { csvColumn: fieldName } */
  column_map?: Record<string, string>
  id_field?: string | null
  /** Defaults to 'skip'. */
  duplicate_strategy?: string
}): Command<{ data: ImportPreview }> {
  return cmd('POST', '/imports/preview', undefined, body)
}

// ─── Related comments (recorded notes) ────────────────────────────────────────

export interface RelatedCommentEntry {
  id: string
  source: 'transition' | 'change_reason' | 'addendum' | 'note'
  label: string
  text: string
  user: string | null
  user_name: string | null
  created_at: ISODate
  /** Where the note came from ("Draft → Review", "Forecasts · 2026 · amount"). */
  context: string | null
}

/**
 * Read-only notes recorded about a record from other surfaces — workflow
 * transition comments, change reasons (own + child rows), addendum reasons,
 * and conventional note child tables. Time-ordered oldest first; merge with
 * `listComments` for the full thread.
 */
export function listRelatedComments(
  collection: string,
  item: string | number
): Command<{ data: RelatedCommentEntry[] }> {
  return cmd('GET', '/comments/related', { collection, item: String(item) })
}

// ─── Distinct column values ───────────────────────────────────────────────────

/**
 * Distinct non-null values of one PHYSICAL column, ascending — for
 * column-filter dropdowns. `limit` is clamped to 1–500 (default 200).
 */
export function readDistinctValues(
  collection: string,
  field: string,
  options?: { limit?: number }
): Command<{ data: unknown[] }> {
  const params: Record<string, unknown> = { field }
  if (options?.limit != null) params.limit = options.limit
  return cmd('GET', `/items/${collection}/distinct`, params)
}
