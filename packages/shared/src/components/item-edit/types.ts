import type { ReactNode } from 'react'

export interface CMSField {
  field: string
  type: string
  interface: string | null
  label: string | null
  required: boolean
  hidden: boolean
  readonly: boolean
  sort: number
  group_key: string | null
  // API returns pre-parsed objects via formatFieldConfig; accept both
  options: Record<string, unknown> | string | null
  computed_formula: string | null
  computed_type: string | null
  note: string | null
  placeholder: string | null
  repeater_schema: Record<string, unknown>[] | string | null
  dependency_config: Record<string, unknown> | string | null
  layout_assigned?: boolean
  /** Raw layout-assignment overrides (label, readonly, drilldown, ...) — passed through by field-config. */
  _overrides?: Record<string, unknown> | null
}

export interface CMSRelation {
  id: number
  one_collection: string | null
  one_field: string | null
  many_collection: string | null
  many_field: string | null
  junction_field: string | null
}

// Staged grandchild ops for a NestedRelationEditor under saveMode='pending' on
// an already-saved parent row — explicit ops rather than a full-list replace,
// so a replace-reconcile can't delete rows added concurrently by someone else
// between snapshot and flush.
export interface NestedOps {
  created: Record<string, unknown>[]
  updated: { id: string; changes: Record<string, unknown> }[]
  deleted: string[]
}

export interface FieldGroup {
  id: number
  key: string
  label: string
  type: 'section' | 'tab' | 'metadata' | 'container'
  icon: string | null
  sort: number
  is_collapsed: boolean
  container_id?: number | null
  tab_mode?: 'tabs' | 'steps' | null
  hide_when_empty?: boolean | number
  visibility_mode?: 'always' | 'new_only' | 'existing_only'
  summary_fields?: string[] | string | null
  summary_hide_empty?: boolean | number
  swap_config?: string | null
}

export interface SlotAssignment {
  field: string
  sort: number
  group_key?: string | null
  col_span?: number | null
  is_visible: boolean | number
  default_expanded?: boolean
  label_override?: string | null
  show_row_revisions?: boolean | number
  allow_revision_restore?: boolean | number
  lock_conditions?: string | null
  overrides?: Record<string, unknown> | string | null
  widget_id?: number | null
  input_bindings?: string | null  // JSON: [{key,binding_type,binding_value}]
}

export interface LayoutMeta {
  id: number
  name: string
  tab_mode: 'tabs' | 'steps' | null
  validate_before_next: boolean
  summary_enabled: boolean
  summary_show_all: boolean
  summary_hide_empty?: boolean
  ai_enabled: boolean
  disable_comments?: boolean | number
  disable_tasks?: boolean | number
  disable_revisions?: boolean | number
  disable_clone?: boolean | number
  disable_delete?: boolean | number
  accordion_mode?: boolean | number
  addendum_layout_id?: number | null
  addendum_default_view?: boolean | number
}

export interface ActiveLayoutData {
  layout: LayoutMeta | null
  groups: FieldGroup[]
  assignments: SlotAssignment[]
  ungrouped_sort?: number | null
}

export interface StepDef {
  key: string
  label: string
}

export interface SummaryScalarConfig {
  field: string
  label?: string
}

export interface SummaryAggConfig {
  field: string
  agg: 'sum' | 'count' | 'avg' | 'min' | 'max'
  agg_field: string
  label?: string
  field_options?: string | null
}

export type SummaryEntry = string | SummaryScalarConfig | SummaryAggConfig

export type RenderFieldProps = {
  field: any
  value: unknown
  onChange: (v: unknown) => void
  disabled: boolean
  collection: string
  itemId: string
  relations: any[]
  cascadeFilter?: Record<string, unknown>
  unsatisfiedParentLabel?: string | null
  requiredParentLabel?: string | null
}

export interface ItemEditContext {
  collection: string
  itemId: string
  activeLayoutData: ActiveLayoutData | null
  draft: Record<string, unknown>
  isDirty: boolean
  isSaving: boolean
  onSave: () => void
  onDelete: () => void
  onBack?: () => void
  renderField?: (props: RenderFieldProps) => ReactNode
}
