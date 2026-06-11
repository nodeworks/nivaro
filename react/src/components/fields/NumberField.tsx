import React from 'react'
import type { FieldComponentProps } from '../../types'

export function NumberField({ field, value, onChange, disabled, readOnly }: FieldComponentProps) {
  const step = field.fieldType === 'integer' ? 1 : 'any'
  return (
    <input
      type="number"
      id={field.field}
      name={field.field}
      step={step}
      value={value == null || value === '' ? '' : String(value)}
      required={field.required}
      disabled={disabled}
      readOnly={readOnly}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') {
          onChange(null)
          return
        }
        const parsed = field.fieldType === 'integer' ? Number.parseInt(raw, 10) : Number(raw)
        onChange(Number.isNaN(parsed) ? null : parsed)
      }}
    />
  )
}
