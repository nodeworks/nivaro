import React from 'react'
import type { FieldComponentProps } from '../../types'

export function TextField({ field, value, onChange, disabled, readOnly }: FieldComponentProps) {
  return (
    <input
      type="text"
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
