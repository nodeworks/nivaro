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
  note: string | null
  placeholder: string | null
  repeater_schema: Record<string, unknown>[] | string | null
  dependency_config: Record<string, unknown> | string | null
  layout_assigned?: boolean
}

export interface CMSRelation {
  id: number
  one_collection: string | null
  one_field: string | null
  many_collection: string | null
  many_field: string | null
  junction_field: string | null
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
}

export interface SlotAssignment {
  field: string
  sort: number
  is_visible: boolean | number
  default_expanded?: boolean
  label_override?: string | null
}

export interface LayoutMeta {
  id: number
  name: string
  tab_mode: 'tabs' | 'steps' | null
  validate_before_next: boolean
  summary_enabled: boolean
  summary_show_all: boolean
  ai_enabled: boolean
  disable_comments?: boolean | number
  disable_tasks?: boolean | number
  disable_revisions?: boolean | number
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
