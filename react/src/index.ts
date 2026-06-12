// Context
export { NivaroProvider, useNivaroClient } from './context'

// Hooks
export { useNivaroForm } from './hooks/useNivaroForm'
export { useRelationOptions } from './hooks/useRelationOptions'
export type { RelationOption } from './hooks/useRelationOptions'
export {
  useFormSchema,
  fetchSchema,
  normalizeFieldType,
  clearFormSchemaCache
} from './hooks/useFormSchema'

// Components
export { NivaroForm } from './components/NivaroForm'
export { LayoutForm } from './components/LayoutForm'
export { NivaroField } from './components/NivaroField'
export { TextField } from './components/fields/TextField'
export { TextareaField } from './components/fields/TextareaField'
export { NumberField } from './components/fields/NumberField'
export { BooleanField } from './components/fields/BooleanField'
export { DateField } from './components/fields/DateField'
export { SelectField } from './components/fields/SelectField'
export { RelationField } from './components/fields/RelationField'
export { FileField } from './components/fields/FileField'

// Types
export type {
  FormSchema,
  FormFieldDescriptor,
  FormGroupDescriptor,
  FormFieldType,
  FormErrors,
  FormValidationRule,
  FormVisibilityRule,
  FormLockCondition,
  UseNivaroFormOptions,
  UseNivaroFormReturn,
  FieldComponentProps,
  ComponentOverrides
} from './types'

// SDK re-exports (types useful in form consumers)
export type { CascadeFilterRule, FieldDependencyConfig } from '@nivaro/sdk'

// Layout hooks
export {
  useFieldState,
  useWatchFields,
  useFormDirty,
  useTabState,
  useSectionState,
  useOrderedLayout,
  useFormStatus,
  useFieldArray,
} from './hooks/useLayoutHooks'
export type {
  FieldState,
  FormDirtyState,
  TabState,
  SectionState,
  LayoutItem,
  FormStatus,
  FieldArrayReturn,
} from './hooks/useLayoutHooks'
