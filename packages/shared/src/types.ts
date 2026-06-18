import type React from 'react'

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'integer'
  | 'float'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'radio'
  | 'checkbox-group'
  | 'relation-m2o'
  | 'relation-o2m'
  | 'relation-m2m'
  | 'wysiwyg'
  | 'file'
  | 'json'
  | 'uuid'
  | 'unknown'

export type FormValidationRule = {
  type: string
  value?: unknown
  message?: string
  soft?: boolean
}

export type FormVisibilityRule = {
  when: string
  op: string
  value?: unknown
  action: 'show' | 'hide'
}

export type FormLockCondition = {
  when: string
  op: string
  value?: unknown
}

export type FormFieldDescriptor = {
  field: string
  type: string
  fieldType: FormFieldType
  interface: string | null
  label: string
  note: string | null
  required: boolean
  readonly: boolean
  hidden: boolean
  sort: number | null
  group: string | null
  options: Record<string, unknown> | null
  validationRules: FormValidationRule[] | null
  visibilityRules: FormVisibilityRule[] | null
  lockCondition: FormLockCondition | null
  relation?: {
    type: 'o2m' | 'm2o' | 'm2m' | 'm2a'
    relatedCollection: string
    junctionCollection?: string | null
    displayTemplate: string | null
    manyField?: string | null
    junctionField?: string | null
  } | null
  defaultValue?: unknown
  cascadeFilters?: Array<{
    parent_field: string
    filter_column: string
    clear_on_parent_change?: boolean
  }> | null
}

export type FormGroupDescriptor = {
  key: string
  label: string
  type: 'section' | 'tab' | 'metadata'
  icon: string | null
  sort: number
  isCollapsed: boolean
}

export type FormSlotAssignment = {
  slot: string
  groupKey: string | null
  sort: number
  labelOverride: string | null
  isVisible: boolean
  defaultExpanded: boolean
}

export type FormSchema = {
  collection: string
  displayName: string | null
  singleton: boolean
  draftPublishEnabled: boolean
  fields: FormFieldDescriptor[]
  groups: FormGroupDescriptor[]
  ungroupedSort: number | null
  tabMode: 'tabs' | 'steps' | null
  aiEnabled: boolean
  summaryEnabled: boolean
  validateBeforeNext: boolean
  slotAssignments: FormSlotAssignment[]
}

export type FormErrors = Record<string, string[]>

export type UseNivaroFormOptions = {
  mode: 'create' | 'edit'
  itemId?: string | number
  defaultValues?: Record<string, unknown>
  onSuccess?: (item: Record<string, unknown>) => void
  onError?: (error: Error) => void
  validate?: Record<string, (value: unknown, values: Record<string, unknown>) => string | null>
  includeHidden?: boolean
  layoutId?: number
  fieldRulesDebounce?: number
}

export type UseNivaroFormReturn = {
  schema: FormSchema | null
  schemaLoading: boolean
  schemaError: Error | null
  values: Record<string, unknown>
  initialValues: Record<string, unknown>
  errors: FormErrors
  isDirty: boolean
  isSubmitting: boolean
  isLoading: boolean
  isVisible: (field: string) => boolean
  isLocked: (field: string) => boolean
  setValue: (field: string, value: unknown) => void
  setValues: (patch: Record<string, unknown>) => void
  reset: (values?: Record<string, unknown>) => void
  handleSubmit: (e?: React.FormEvent) => Promise<void>
  fieldsByGroup: Map<string | null, FormFieldDescriptor[]>
  visibleGroups: FormGroupDescriptor[]
  gridFlushersRef: React.MutableRefObject<Map<string, () => Promise<void>>>
}

export type FieldComponentProps = {
  field: FormFieldDescriptor
  value: unknown
  onChange: (value: unknown) => void
  error: string[] | undefined
  disabled: boolean
  readOnly: boolean
  inputId?: string
  errorId?: string
}

export type ComponentOverrides = {
  text?: React.ComponentType<FieldComponentProps>
  textarea?: React.ComponentType<FieldComponentProps>
  integer?: React.ComponentType<FieldComponentProps>
  float?: React.ComponentType<FieldComponentProps>
  decimal?: React.ComponentType<FieldComponentProps>
  boolean?: React.ComponentType<FieldComponentProps>
  date?: React.ComponentType<FieldComponentProps>
  datetime?: React.ComponentType<FieldComponentProps>
  select?: React.ComponentType<FieldComponentProps>
  radio?: React.ComponentType<FieldComponentProps>
  'checkbox-group'?: React.ComponentType<FieldComponentProps>
  'relation-m2o'?: React.ComponentType<FieldComponentProps>
  'relation-o2m'?: React.ComponentType<FieldComponentProps>
  'relation-m2m'?: React.ComponentType<FieldComponentProps>
  wysiwyg?: React.ComponentType<FieldComponentProps>
  file?: React.ComponentType<FieldComponentProps>
  json?: React.ComponentType<FieldComponentProps>
  uuid?: React.ComponentType<FieldComponentProps>
  fallback?: React.ComponentType<FieldComponentProps>
}

export type RelationOption = {
  id: string | number
  label: string
  raw: Record<string, unknown>
}
