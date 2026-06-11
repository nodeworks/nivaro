import React from 'react'
import type { ComponentOverrides, FieldComponentProps, FormFieldDescriptor } from '../types'
import { BooleanField } from './fields/BooleanField'
import { DateField } from './fields/DateField'
import { FileField } from './fields/FileField'
import { NumberField } from './fields/NumberField'
import { RelationField } from './fields/RelationField'
import { SelectField } from './fields/SelectField'
import { TextField } from './fields/TextField'
import { TextareaField } from './fields/TextareaField'

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
}

/**
 * Selects and renders the correct field component for a single field based on
 * its normalized fieldType. Override any type via `components`; falls back to
 * `components.fallback` or a basic text input for unknown types.
 */
export function NivaroField({
  field,
  value,
  onChange,
  error,
  disabled = false,
  readOnly = false,
  components,
  className
}: NivaroFieldProps) {
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
    readOnly
  }

  return (
    <div className={className} data-nivaro-field={field.field} data-field-type={field.fieldType}>
      <label htmlFor={field.field}>
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <Renderer {...props} />
      {field.note ? <small>{field.note}</small> : null}
      {error && error.length > 0 ? (
        <div role="alert">
          {error.map((msg, i) => (
            <span key={i}>{msg}</span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
