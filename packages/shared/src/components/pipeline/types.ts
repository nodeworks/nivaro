// Pipeline editor types — a local copy of the admin api.ts shapes so the shared
// pipeline components carry no dependency on the admin package.

export type User = {
  preferences?: Record<string, unknown> | null
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  role: string | null
  status: string
  static_token: string | null
  last_access: string | null
  created_at: string
  current_workspace: string | null
  manager_id: string | null
  delegate_id: string | null
  delegate_expires_at: string | null
  is_out_of_office: boolean
  is_admin?: boolean
  is_redacted?: boolean
  redacted_at?: string | null
  title?: string | null
  department?: string | null
  company?: string | null
}

export type Collection = {
  id: number
  collection: string
  display_name: string | null
  icon: string | null
  color: string | null
  note: string | null
  hidden: boolean
  singleton: boolean
  display_template: string | null
  sort: number | null
  group: string | null
}

export type CMSRelation = {
  id: number
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
  sort_field: string | null
  one_deselect_action: string
}

export type CMSField = {
  id: number
  collection: string
  field: string
  type: string
  interface: string | null
  note: string | null
  hidden: boolean
  readonly: boolean
  required: boolean
  sort: number | null
  computed_formula: string | null
  computed_type: 'read' | 'write' | 'rollup' | 'lookup' | null
  computed_store: boolean
  // Content ops fields:
  group_key: string | null
  visibility_rules: string | null // JSON
  dependency_config: string | null // JSON
  validation_rules: string | null // JSON array
  lock_condition: string | null // JSON
  default_formula: string | null
  cross_record_defaults: string | null // JSON
  remote_options_config: string | null // JSON
  repeater_schema: string | null // JSON
  is_translatable: boolean
  options: string | null // JSON — includes col_span, slider config, choices, etc.
  label: string | null
  placeholder: string | null
}

export type PipelineTemplate = {
  id: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
  created_at: string
  updated_at: string
  state_count?: number
  collections?: string[]
  states?: PipelineState[]
  transitions?: PipelineTransition[]
  bindings?: PipelineBinding[]
}

export type SkipOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'notin'

export type SkipLookupFilter = {
  column: string
  value?: unknown
  record_field?: string
  op?: 'eq' | 'in'
}

export type SkipCondition =
  | { type: 'no_owners' }
  | { type: 'field_compare'; field: string; op: SkipOp; value: unknown }
  | { type: 'field_empty'; field: string }
  | { type: 'field_nonempty'; field: string }
  | {
      type: 'lookup_compare'
      collection: string
      filters: SkipLookupFilter[]
      compare_column: string
      record_field: string
      op: SkipOp
      match?: 'any' | 'all'
    }

export type SkipCriteria = {
  mode: 'any' | 'all'
  conditions: SkipCondition[]
}

export type ConditionOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'null' | 'nnull'

export type ConditionRule = {
  field: string
  op: ConditionOp
  value?: unknown
}

export type PipelineStateOwner = {
  id: number
  state: string
  user: string
  record_filters: Array<{ field: string; op: string; value: unknown }> | null
  is_default: boolean
  sort: number
  first_name: string | null
  last_name: string | null
  email: string
}

export type RecordFilter = {
  field: string
  op: string
  value: unknown
  id_value?: number | null
}

export type PipelineOwnerGroup = {
  id: string
  template: string
  state: string
  name: string | null
  filters: RecordFilter[] | null
  sort: number
  is_default: boolean
  priority: number
  max_wip: number | null
  users: PipelineOwnerGroupUser[]
  /** Whole teams (nivaro_user_groups) linked to this cell — their rosters
   *  resolve as owners at read time. */
  teams?: OwnerTeam[]
}

export type OwnerTeam = {
  link_id: number
  id: number
  name: string
  slug: string
  member_count: number
  /** {dimension: target ids[]} — empty/absent = unscoped. */
  scopes?: Record<string, Array<string | number>>
}

export type PipelineOwnerGroupsMap = Record<string, PipelineOwnerGroup[]>

export type PipelineOwnerGroupUser = {
  id: number
  link_id: number
  group: string
  user: string
  first_name: string | null
  last_name: string | null
  email: string
}

export type DimensionCascadeRule = {
  /** Sibling dimension's field whose picked value drives this filter. */
  parent_field: string
  /** Column (dotted ok) on THIS dimension's option collection. */
  filter: string
  /** Wrap the first hop in _some (junction/M2M path). */
  via_many?: boolean
}

export type PipelineOwnerDimension = {
  id: number
  binding: number
  field: string
  label: string
  sort: number
  is_row_axis: boolean
  required: boolean
  cascade?: DimensionCascadeRule[] | null
}

export type PipelineInstanceOwner = {
  id: number
  instance: string
  state: string | null
  user: string
  added_by: string | null
  added_at: string
  first_name: string | null
  last_name: string | null
  email: string
}

export type PipelineState = {
  id: string
  template: string
  key: string
  label: string
  color: string | null
  is_initial: boolean
  is_terminal: boolean
  lock_record: boolean
  sort: number
  skip_criteria?: SkipCriteria | null
  stage_visibility: 'always' | 'hide' | 'hide_unless_active'
}

export type TransitionRequirement = {
  type: 'child_fields'
  collection: string
  fk_field: string
  fields: string[]
  /** Context columns shown read-only per row in the transition dialog. */
  display_fields?: string[]
  labels?: Record<string, string>
  title?: string
}

export type PipelineTransition = {
  id: string
  template: string
  from_state: string | null
  to_state: string
  label: string
  color: string | null
  required_roles: string[] | null
  actions: unknown[] | null
  auto_trigger?: boolean
  /** 'none' (act on click) | 'optional' | 'required' — see migration 201. */
  comment_mode?: string
  sort: number
  group_label: string | null
  condition_rules: ConditionRule[] | null
  requirements: TransitionRequirement[] | null
}

export type PipelineBinding = {
  id: number
  template: string
  collection: string
  state_field: string | null
  auto_start: boolean
  auto_start_state: string | null
  owner_fallback_field: string | null
  dimensions?: PipelineOwnerDimension[]
}

export type PipelineInstance = {
  id: string
  template: string
  collection: string
  item: string
  current_state: string | null
  current_state_obj: PipelineState | null
  started_at: string
  completed_at: string | null
}

export type PipelineHistoryEntry = {
  id: number
  instance: string
  transition: string | null
  from_state: string | null
  to_state: string
  comment: string | null
  timestamp: string
  from_state_label: string | null
  from_state_color: string | null
  to_state_label: string
  to_state_color: string | null
  first_name: string | null
  last_name: string | null
  user_email: string | null
}

export type PipelineStateInfo = {
  state_key: string | null
  state_label: string | null
  state_color: string | null
  completed_at: string | null
}

export type PipelineInstancesMap = {
  binding: PipelineBinding
  instances: Record<string, PipelineStateInfo>
}
