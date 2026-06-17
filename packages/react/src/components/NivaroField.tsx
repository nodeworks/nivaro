import type React from 'react'
import { useId } from 'react'
import type { ComponentOverrides, FieldComponentProps, FormFieldDescriptor } from '../types'
import { BooleanField } from './fields/BooleanField'
import { DateField } from './fields/DateField'
import { FileField } from './fields/FileField'
import { NumberField } from './fields/NumberField'
import { RelationField } from './fields/RelationField'
import { SelectField } from './fields/SelectField'
import { TextareaField } from './fields/TextareaField'
import { TextField } from './fields/TextField'
import { InlineGridField } from './InlineGridField'

const DEFAULT_RENDERERS: Record<string, React.ComponentType<FieldComponentProps>> = {
  text: TextField,
  textarea: TextareaField,
  integer: NumberField,
  float: NumberField,
  decimal: NumberField,
  boolean: BooleanField,
  date: DateField,
  datetime: DateField,
  select: SelectField,
  radio: SelectField,
  'checkbox-group': SelectField,
  'relation-m2o': RelationField,
  'relation-o2m': RelationField,
  'relation-m2m': RelationField,
  wysiwyg: TextareaField,
  file: FileField,
  uuid: TextField,
  json: TextareaField
}

type NivaroFieldProps = {
  field: FormFieldDescriptor
  value: unknown
  onChange: (value: unknown) => void
  error?: string[]
  disabled?: boolean
  readOnly?: boolean
  components?: ComponentOverrides
  className?: string
  /** Parent item id — passed through to inline-grid fields */
  itemId?: string | number | null
}

/**
 * Selects and renders the correct field component for a single field based on
 * its normalized fieldType. Override any type via `components`; falls back to
 * `components.fallback` or a basic text input for unknown types.
 *
 * Uses React 18's useId() to generate a unique DOM id per field instance so
 * two forms with the same collection mounted simultaneously don't collide.
 */
export function NivaroField({
  field,
  value,
  onChange,
  error,
  disabled = false,
  readOnly = false,
  components,
  className,
  itemId
}: NivaroFieldProps) {
  const uid = useId()
  const inputId = `${uid}-${field.field}`
  const errorId = error && error.length > 0 ? `${uid}-err` : undefined

  // Inline-grid: completely separate rendering path — no label/renderer pattern
  if (field.interface === 'inline-grid' && field.relation?.type === 'o2m') {
    return (
      <div className={className} data-nivaro-field={field.field} data-field-type='inline-grid'>
        <InlineGridField field={field} itemId={itemId ?? null} />
      </div>
    )
  }

  const override = components?.[field.fieldType as keyof ComponentOverrides]
  const Renderer =
    override ??
    DEFAULT_RENDERERS[field.fieldType] ??
    components?.fallback ??
    (TextField as React.ComponentType<FieldComponentProps>)

  const props: FieldComponentProps = {
    field,
    value,
    onChange,
    error,
    disabled,
    readOnly,
    inputId,
    errorId
  }

  return (
    <div
      className={className}
      data-nivaro-field={field.field}
      data-field-type={field.fieldType}
      {...(field.note ? { 'data-nf-note': field.note } : {})}
    >
      <label htmlFor={inputId}>
        {field.label}
        {field.required ? (
          <span aria-hidden='true' data-nf-required>
            {' '}
            *
          </span>
        ) : null}
        {field.note ? (
          <span
            aria-label={field.note}
            title={field.note}
            data-nf-note-icon
            role='img'
            aria-hidden='false'
          >
            {' ?'}
          </span>
        ) : null}
      </label>
      <Renderer {...props} />
      {field.note ? <small data-nf-note-text>{field.note}</small> : null}
      {error && error.length > 0 ? (
        <div id={errorId} role='alert'>
          {error.map((msg) => (
            <span key={msg}>{msg}</span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
