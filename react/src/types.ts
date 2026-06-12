import type React from 'react'

/**
 * Normalized field type used by the form renderer to pick a component.
 * Derived from the raw DB type + CMS interface string in `useFormSchema`.
 */
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
  | 'file'
  | 'json'
  | 'uuid'
  | 'unknown'

/** A single validation rule attached to a field. */
export type FormValidationRule = {
  type: string
  value?: unknown
  message?: string
  /** soft = warning only, hard (default) = blocks save */
  soft?: boolean
}

/** A client-evaluable visibility rule. */
export type FormVisibilityRule = {
  /** key of the field this rule observes */
  when: string
  /** eq | neq | null | nnull | in | contains */
  op: string
  value?: unknown
  action: 'show' | 'hide'
}

/** A client-evaluable lock condition. */
export type FormLockCondition = {
  when: string
  op: string
  value?: unknown
}

export type FormFieldDescriptor = {
  field: string
  /** raw DB type (string, integer, boolean, uuid, json, …) */
  type: string
  /** normalized type used to pick the rendering component */
  fieldType: FormFieldType
  /** CMS interface string (input, select-dropdown, many-to-one, …) */
  interface: string | null
  label: string
  note: string | null
  required: boolean
  readonly: boolean
  hidden: boolean
  sort: number | null
  /** field group key (null = ungrouped) */
  group: string | null
  /** interface options (e.g. { choices: [{text, value}] } for selects) */
  options: Record<string, unknown> | null
  validationRules: FormValidationRule[] | null
  visibilityRules: FormVisibilityRule[] | null
  lockCondition: FormLockCondition | null
  relation?: {
    type: 'o2m' | 'm2o' | 'm2m' | 'm2a'
    relatedCollection: string
    displayTemplate: string | null
    manyField?: string | null
    junctionField?: string | null
  } | null
  defaultValue?: unknown
}

export type FormGroupDescriptor = {
  key: string
  label: string
  type: 'section' | 'tab'
  icon: string | null
  sort: number
  isCollapsed: boolean
}

export type FormSchema = {
  collection: string
  displayName: string | null
  singleton: boolean
  draftPublishEnabled: boolean
  fields: FormFieldDescriptor[]
  groups: FormGroupDescriptor[]
  /** index of the Ungrouped zone among groups (null = after all groups) */
  ungroupedSort: number | null
}

export type FormErrors = Record<string, string[]>

export type UseNivaroFormOptions = {
  mode: 'create' | 'edit'
  /** required when mode='edit' */
  itemId?: string | number
  defaultValues?: Record<string, unknown>
  onSuccess?: (item: Record<string, unknown>) => void
  onError?: (error: Error) => void
  /** custom synchronous validators; return an error string or null when valid */
  validate?: Record<string, (value: unknown, values: Record<string, unknown>) => string | null>
  /** include hidden fields in the schema (default false) */
  includeHidden?: boolean
  /**
   * Specific layout id to use for group/field ordering.
   * When omitted, the collection's active layout is used automatically.
   */
  layoutId?: number
}

export type UseNivaroFormReturn = {
  // Schema
  schema: FormSchema | null
  schemaLoading: boolean
  schemaError: Error | null

  // State
  values: Record<string, unknown>
  errors: FormErrors
  isDirty: boolean
  isSubmitting: boolean
  /** true while loading schema or the item being edited */
  isLoading: boolean

  // Computed visibility/lock (evaluated client-side from rules)
  isVisible: (field: string) => boolean
  isLocked: (field: string) => boolean

  // Actions
  setValue: (field: string, value: unknown) => void
  setValues: (patch: Record<string, unknown>) => void
  reset: (values?: Record<string, unknown>) => void
  handleSubmit: (e?: React.FormEvent) => Promise<void>

  // Grouped fields helper
  fieldsByGroup: Map<string | null, FormFieldDescriptor[]>
  visibleGroups: FormGroupDescriptor[]
}

export type FieldComponentProps = {
  field: FormFieldDescriptor
  value: unknown
  onChange: (value: unknown) => void
  error: string[] | undefined
  disabled: boolean
  readOnly: boolean
}

export type ComponentOverrides = {
  text?: React.ComponentType<FieldComponentProps>
  textarea?: React.ComponentType<FieldComponentProps>
  integer?: React.ComponentType<FieldComponentProps>
  float?: React.ComponentType<FieldComponentProps>
  boolean?: React.ComponentType<FieldComponentProps>
  date?: React.ComponentType<FieldComponentProps>
  datetime?: React.ComponentType<FieldComponentProps>
  select?: React.ComponentType<FieldComponentProps>
  'relation-m2o'?: React.ComponentType<FieldComponentProps>
  'relation-o2m'?: React.ComponentType<FieldComponentProps>
  'relation-m2m'?: React.ComponentType<FieldComponentProps>
  file?: React.ComponentType<FieldComponentProps>
  json?: React.ComponentType<FieldComponentProps>
  fallback?: React.ComponentType<FieldComponentProps>
}
