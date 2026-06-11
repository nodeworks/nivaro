import React from 'react'
import type { FieldComponentProps } from '../../types'

export function BooleanField({ field, value, onChange, disabled, readOnly }: FieldComponentProps) {
  return (
    <input
      type="checkbox"
      id={field.field}
      name={field.field}
      checked={!!value}
      disabled={disabled || readOnly}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}
