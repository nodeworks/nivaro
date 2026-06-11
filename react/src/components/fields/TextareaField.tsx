import React from 'react'
import type { FieldComponentProps } from '../../types'

export function TextareaField({
  field,
  value,
  onChange,
  disabled,
  readOnly
}: FieldComponentProps) {
  return (
    <textarea
      id={field.field}
      name={field.field}
      value={value == null ? '' : String(value)}
      required={field.required}
      disabled={disabled}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
