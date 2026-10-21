/**
 * Layout editor commands: the bundle + atomic ops save model, the overview and
 * "which form opens" explain reads, the editor's read-only canvas projection,
 * and the layout-gated record tools (picker toggle, scheduled changes).
 *
 * The block between the BEGIN/END markers mirrors
 * packages/shared/src/lib/layout-ops.ts (types and patch-key lists) so the SDK
 * needs no runtime dependency on @nivaro/shared. It must stay byte-identical:
 * packages/shared/src/lib/layout-ops-sdk.test.ts fails when the two drift.
 */
import { type Command, cmd } from '../command.js'

// BEGIN layout-ops mirror
export type PlacementKey = { field: string; group_key: string | null }

export interface PlacementPatch {
  label_override?: string | null
  is_visible?: boolean
  default_expanded?: boolean
  col_span?: number | null
  overrides?: unknown
  show_row_revisions?: boolean
  allow_revision_restore?: boolean | null
  lock_conditions?: string | null
  input_bindings?: unknown
  widget_id?: number | null
  show_approval_chain?: boolean
}

export interface PlacementRow {
  id?: number
  field: string
  group_key: string | null
  sort: number
  label_override: string | null
  is_visible: boolean
  default_expanded: boolean
  col_span: number | null
  overrides: unknown
  show_row_revisions: boolean
  allow_revision_restore: boolean | null
  lock_conditions: string | null
  input_bindings: unknown
  widget_id: number | null
  show_approval_chain: boolean
}

/** Group JSON settings (summary_fields, swap_config, …) travel as their stored JSON text. */
export interface GroupPatch {
  label?: string
  type?: string
  icon?: string | null
  is_collapsed?: boolean
  tab_mode?: string | null
  hide_when_empty?: boolean
  visibility_mode?: string | null
  summary_fields?: string | null
  summary_hide_empty?: boolean
  swap_config?: string | null
  skip_if_filled?: string | null
  content?: string | null
  content_tone?: string | null
  visible_when?: string | null
  hidden_for_roles?: string | null
  locked_for_roles?: string | null
  read_width?: string | null
  /** #2608: an editor-only note, JSON {text, by, by_name, at}. Never sent to record pages. */
  editor_note?: string | null
}

export interface GroupRow {
  id?: number
  key: string
  parent_key: string | null
  sort: number
  label: string
  type: string
  icon: string | null
  is_collapsed: boolean
  tab_mode: string | null
  hide_when_empty: boolean
  visibility_mode: string | null
  summary_fields: string | null
  summary_hide_empty: boolean
  swap_config: string | null
  skip_if_filled: string | null
  content: string | null
  content_tone: string | null
  visible_when: string | null
  hidden_for_roles: string | null
  locked_for_roles: string | null
  read_width: string | null
  /** #2608 — absent on databases without the column (migration 460). */
  editor_note?: string | null
}

/** The layout settings PATCH /collection-layouts/:id accepts. */
export type LayoutPatch = Partial<{
  name: string
  slug: string | null
  create_label: string | null
  create_hidden: boolean
  sort: number
  is_active: boolean
  disable_comments: boolean
  disable_tasks: boolean
  tab_mode: string
  validate_before_next: boolean
  summary_enabled: boolean
  summary_hide_empty: boolean
  ai_enabled: boolean
  accordion_mode: boolean
  disable_revisions: boolean
  disable_clone: boolean
  disable_delete: boolean
  row_order_field: string | null
  pdf_theme: string | null
  pdf_template_id: number | null
  pdf_cover_enabled: boolean
  pdf_cover_title_field: string | null
  pdf_cover_subtitle: string | null
  pdf_show_logo: boolean
  pdf_page_size: string
  pdf_orientation: string
  pdf_button_label: string | null
  conditions: { role_ids?: string[] } | null
  allow_schedule: boolean
  allow_disable_pickers: boolean
  layout_type: string
  addendum_layout_id: number | null
  workflow_template_id: string | null
  single_active_addendum: boolean
  addendum_default_view: boolean
  record_conditions: Array<{ field: string; op: string; value?: unknown }> | null
  default_values: Record<string, unknown> | null
  display_mode: string | null
  parent_layout_id: number | null
  hide_integrity_banner: boolean
  hide_sla_banner: boolean
  changes_tray: boolean
  dossier_enabled: boolean
  dossier_label: string | null
  quick_picker: string[] | null
  sheet_width: number | null
  header_fields: string[] | null
  hide_empty: boolean
  /** Required change note (#2654): null = off, 'note' = a reason, 'note_ticket' = reason + ticket. */
  change_note: 'note' | 'note_ticket' | null
}>

export type LayoutRow = Record<string, unknown> & { id: number; collection: string }

export type LayoutOp =
  | { op: 'place'; field: string; group_key: string | null; index: number; patch?: PlacementPatch }
  | { op: 'move'; from: PlacementKey; to_group_key: string | null; index: number }
  | { op: 'update_placement'; at: PlacementKey; patch: PlacementPatch }
  | { op: 'remove'; at: PlacementKey }
  | {
      op: 'group_create'
      key: string
      label: string
      group_type: string
      parent_key: string | null
      index: number
      patch?: GroupPatch
    }
  | { op: 'group_update'; key: string; patch: GroupPatch }
  | { op: 'group_move'; key: string; parent_key: string | null; index: number }
  | { op: 'group_remove'; key: string; placements: 'ungroup' | 'delete' }
  | { op: 'layout_update'; patch: LayoutPatch }

export interface LayoutBundle {
  layout: LayoutRow
  groups: GroupRow[]
  placements: PlacementRow[]
  rev: string
}

export const PLACEMENT_PATCH_KEYS = [
  'label_override',
  'is_visible',
  'default_expanded',
  'col_span',
  'overrides',
  'show_row_revisions',
  'allow_revision_restore',
  'lock_conditions',
  'input_bindings',
  'widget_id',
  'show_approval_chain'
] as const

/** #2608: the longest stored editor note (the JSON around its text included). */
export const EDITOR_NOTE_MAX = 4000

export const GROUP_PATCH_KEYS = [
  'label',
  'type',
  'icon',
  'is_collapsed',
  'tab_mode',
  'hide_when_empty',
  'visibility_mode',
  'summary_fields',
  'summary_hide_empty',
  'swap_config',
  'skip_if_filled',
  'content',
  'content_tone',
  'visible_when',
  'hidden_for_roles',
  'locked_for_roles',
  'read_width',
  'editor_note'
] as const

export const LAYOUT_PATCH_KEYS = [
  'name',
  'slug',
  'create_label',
  'create_hidden',
  'sort',
  'is_active',
  'disable_comments',
  'disable_tasks',
  'tab_mode',
  'validate_before_next',
  'summary_enabled',
  'summary_hide_empty',
  'ai_enabled',
  'accordion_mode',
  'disable_revisions',
  'disable_clone',
  'disable_delete',
  'row_order_field',
  'pdf_theme',
  'pdf_template_id',
  'pdf_cover_enabled',
  'pdf_cover_title_field',
  'pdf_cover_subtitle',
  'pdf_show_logo',
  'pdf_page_size',
  'pdf_orientation',
  'pdf_button_label',
  'conditions',
  'allow_schedule',
  'allow_disable_pickers',
  'layout_type',
  'addendum_layout_id',
  'workflow_template_id',
  'single_active_addendum',
  'addendum_default_view',
  'record_conditions',
  'default_values',
  'display_mode',
  'parent_layout_id',
  'hide_integrity_banner',
  'hide_sla_banner',
  'changes_tray',
  'dossier_enabled',
  'dossier_label',
  'quick_picker',
  'sheet_width',
  'header_fields',
  'hide_empty',
  'change_note'
] as const

// END layout-ops mirror

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Why a layout won resolution. */
export interface LayoutPickReason {
  kind: 'record_rule' | 'role' | 'default' | 'fallback' | 'slug' | 'type_use'
  rules?: Array<{ field: string; op: string; value?: unknown }>
  role_ids?: string[]
  role_names?: string[]
  type_use?: string
}

export interface LayoutOverviewRow {
  layout_id: number
  name: string
  layout_type: string
  slug: string | null
  section: 'forms' | 'link_only' | 'other_views' | 'unused'
  reason: LayoutPickReason
  is_default: boolean
  new_menu: { label: string; hidden: boolean } | null
  shape: {
    groups: number
    steps_or_tabs: number
    fields: number
    container_mode: 'tabs' | 'steps' | null
  }
  references: Array<{ kind: string; id: string | number; label: string }>
  warnings: string[]
}

/**
 * "Which form does each kind of record get?" Every layout of a collection,
 * sectioned and ordered as the active-layout resolution checks them. Admin only.
 */
export function readLayoutOverview(
  collection: string
): Command<{ data: { rows: LayoutOverviewRow[]; warning: string | null } }> {
  return cmd('GET', '/collection-layouts/overview', { collection })
}

/**
 * Which layout a saved record opens with, and why: the resolution itself, with
 * each candidate's check. `role_id` tests as that role (none = as an admin);
 * `slug` pins a layout by its link name. Admin only.
 */
export function explainLayout(query: {
  collection: string
  item?: string | number
  role_id?: string
  slug?: string
}): Command<{
  data: {
    layout_id: number | null
    reason: LayoutPickReason | null
    checked: Array<{ layout_id: number; matched: boolean; why: string }>
  }
}> {
  return cmd('GET', '/collection-layouts/explain', query)
}

/**
 * The layout, its groups and placements as the editor edits them, with the
 * `rev` the next ops batch must name. Not wrapped in `data`. Admin only.
 */
export function readLayoutBundle(layoutId: number): Command<LayoutBundle> {
  return cmd('GET', `/collection-layouts/${layoutId}/bundle`)
}

/**
 * Apply a batch of ops (at most 500) all or nothing and get the new bundle.
 * Rejections arrive as thrown errors carrying `status` and `response`:
 * 409 `{ error: 'stale', bundle }` when the layout changed since `base_rev`
 * (re-apply on `response.bundle`), 400 `{ error, op_index }` when an op is
 * refused, 400 `{ error, code: 'CHANGE_NOTE_REQUIRED' }` when the layout's
 * `change_note` asks for a `reason` (and `ticket`) the batch lacks. Admin only.
 */
export function submitLayoutOps(
  layoutId: number,
  body: {
    ops: LayoutOp[]
    base_rev: string
    note?: string | null
    reason?: string | null
    ticket?: string | null
  }
): Command<LayoutBundle> {
  return cmd('POST', `/collection-layouts/${layoutId}/ops`, undefined, body)
}

/** One saved version of a layout (the snapshot itself). Admin only. */
export function readLayoutVersion(
  layoutId: number,
  versionId: number
): Command<{ data: Record<string, unknown> }> {
  return cmd('GET', `/collection-layouts/${layoutId}/versions/${versionId}`)
}

/**
 * What changed between a version and now (`against` omitted or 'current') or
 * another version id. `versionId` 'newest' answers "what did the last save change".
 */
export function diffLayoutVersion(
  layoutId: number,
  versionId: number | 'newest',
  against?: number | 'current'
): Command<{ data: Record<string, unknown> }> {
  return cmd(
    'GET',
    `/collection-layouts/${layoutId}/versions/${versionId}/diff`,
    against !== undefined ? { against } : undefined
  )
}

/** Layouts whose last save shows a data-losing shape. Admin only. */
export function readLayoutDrift(): Command<{ data: unknown[] }> {
  return cmd('GET', '/collection-layouts/drift')
}

/** A placement as the projection route takes it: `field` plus any placement columns. */
export type ProjectedPlacement = { field: string } & Partial<Omit<PlacementRow, 'field' | 'id'>>

/**
 * The field-config rows the saved layout would answer if these placements
 * were it (at most 2000): the editor's canvas renders its unsaved draft
 * through this. A read; writes nothing. Admin only.
 */
export function projectFieldConfig(
  collection: string,
  assignments: ProjectedPlacement[]
): Command<{ data: Array<Record<string, unknown>>; ungrouped_sort: number | null }> {
  return cmd('POST', `/field-config/${collection}/project`, undefined, { assignments })
}

/** The layouts that place an internal widget: a config change reaches every one. Admin only. */
export function listInternalWidgetPlacements(
  widgetId: number
): Command<{ data: Array<{ layout_id: number; name: string; collection: string }> }> {
  return cmd('GET', `/widgets-internal/${widgetId}/placements`)
}

// ─── Layout-gated record tools ────────────────────────────────────────────────
//
// `layout` is the ?layout= slug of the form the record was opened with. A
// non-admin may use a tool only when that form grants it (allow_disable_pickers
// / allow_schedule) and they may update the record; admins need no layout.

/** Is a record excluded from relation pickers? */
export function readPickerExclusion(
  collection: string,
  itemId: string | number
): Command<{ data: { excluded: boolean } }> {
  return cmd('GET', `/picker-exclusions/status/${collection}/${itemId}`)
}

/** Which of these ids are excluded from pickers? */
export function readPickerExclusions(
  collection: string,
  ids: Array<string | number>
): Command<{ data: { excluded: string[] } }> {
  return cmd('POST', '/picker-exclusions/batch-status', undefined, { collection, ids })
}

/** Exclude a record from relation pickers. */
export function excludeFromPickers(body: {
  collection: string
  item_id: string | number
  layout?: string | null
}): Command<{ data: { excluded: true } }> {
  return cmd('POST', '/picker-exclusions', undefined, body)
}

/** Put a record back into relation pickers. */
export function includeInPickers(body: {
  collection: string
  item_id: string | number
  layout?: string | null
}): Command<{ data: { excluded: false } }> {
  return cmd('DELETE', '/picker-exclusions', undefined, body)
}

/** Exclude or include many records at once. Admin only. */
export function bulkPickerExclusion(body: {
  collection: string
  ids: Array<string | number>
  exclude: boolean
}): Command<{ data: { success: boolean; count: number } }> {
  return cmd('POST', '/picker-exclusions/bulk', undefined, body)
}
