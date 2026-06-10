/**
 * Content-operations commands: export, draft/publish, scheduled changes,
 * field config/groups, virtual collections, record templates, collection
 * presets, field translations, line items, addendums & change orders,
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
  id: number
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
export function cancelScheduledChange(id: number): Command<void> {
  return cmd('DELETE', `/scheduled-changes/${id}`)
}

/** Execute a pending scheduled change immediately (admin). */
export function executeScheduledChange(
  id: number
): Command<{ data: { id: string; status: 'executed'; executed_at: ISODate } }> {
  return cmd('POST', `/scheduled-changes/${id}/execute`)
}

// ─── Field config ─────────────────────────────────────────────────────────────

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
  group_key: string | null
  visibility_rules: FieldVisibilityRules | null
  dependency_config: Record<string, unknown> | null
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

// ─── Line items ───────────────────────────────────────────────────────────────

export interface LineItem {
  id: number
  sort: number
  data: Record<string, unknown>
}

export interface LineItemTemplate {
  id: number
  collection: string
  field: string
  name: string
  items: Record<string, unknown>[]
  created_by: UUID
  created_at: ISODate
  updated_at: ISODate
}

export function listLineItems(
  collection: string,
  itemId: string | number,
  field: string
): Command<{ data: LineItem[] }> {
  return cmd('GET', `/line-items/${collection}/${itemId}/${field}`)
}

export function addLineItem(
  collection: string,
  itemId: string | number,
  field: string,
  data: Record<string, unknown>
): Command<{ data: LineItem }> {
  return cmd('POST', `/line-items/${collection}/${itemId}/${field}`, undefined, { data })
}

/** Bulk replace all line items for a parent field. */
export function replaceLineItems(
  collection: string,
  itemId: string | number,
  field: string,
  items: Array<{ id?: number | string; sort: number; data: Record<string, unknown> }>
): Command<{ data: LineItem[] }> {
  return cmd('PATCH', `/line-items/${collection}/${itemId}/${field}`, undefined, { items })
}

export function deleteLineItem(
  collection: string,
  itemId: string | number,
  field: string,
  lineItemId: number | string
): Command<void> {
  return cmd('DELETE', `/line-items/${collection}/${itemId}/${field}/${lineItemId}`)
}

export function reorderLineItems(body: {
  collection: string
  item_id: string
  field: string
  order: Array<{ id: number | string; sort: number }>
}): Command<{ data: LineItem[] }> {
  return cmd('POST', '/line-items/reorder', undefined, body)
}

export function listLineItemTemplates(
  collection: string,
  field: string
): Command<{ data: LineItemTemplate[] }> {
  return cmd('GET', `/line-items/templates/${collection}/${field}`)
}

export function createLineItemTemplate(body: {
  collection: string
  field: string
  name: string
  items: Record<string, unknown>[]
}): Command<{ data: LineItemTemplate }> {
  return cmd('POST', '/line-items/templates', undefined, body)
}

export function deleteLineItemTemplate(id: number): Command<void> {
  return cmd('DELETE', `/line-items/templates/${id}`)
}

/** Returns the template's line items for merging into the editor. */
export function applyLineItemTemplate(id: number): Command<{ items: Record<string, unknown>[] }> {
  return cmd('POST', `/line-items/templates/${id}/apply`)
}

// ─── Addendums & change orders ────────────────────────────────────────────────

export type AddendumStatus = 'draft' | 'review' | 'approved' | 'rejected'

export interface Addendum {
  id: number
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
  addendum_id: number
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

export function readAddendum(id: number): Command<{ data: Addendum }> {
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
}): Command<{ data: Addendum }> {
  return cmd('POST', '/addendums', undefined, body)
}

export function updateAddendum(
  id: number,
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
export function deleteAddendum(id: number): Command<void> {
  return cmd('DELETE', `/addendums/${id}`)
}

/** draft → review */
export function submitAddendum(id: number): Command<{ data: { id: string; status: 'review' } }> {
  return cmd('POST', `/addendums/${id}/submit`)
}

/** review → approved; creates a change-order entry. */
export function approveAddendum(id: number): Command<{ data: { id: string; status: 'approved' } }> {
  return cmd('POST', `/addendums/${id}/approve`)
}

export function rejectAddendum(id: number): Command<{ data: { id: string; status: 'rejected' } }> {
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
  id: string | number
): Command<{ data: { id: string | number } }> {
  return cmd('POST', `/items/${collection}/${id}/clone`)
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
