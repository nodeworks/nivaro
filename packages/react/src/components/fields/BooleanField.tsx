import type { FieldComponentProps } from '../../types'

export function BooleanField({
  field,
  value,
  onChange,
  error,
  disabled,
  readOnly,
  inputId,
  errorId
}: FieldComponentProps) {
  const id = inputId ?? field.field
  return (
    <input
      type='checkbox'
      id={id}
      name={field.field}
      checked={!!value}
      disabled={disabled || readOnly}
      aria-required={field.required}
      aria-invalid={error != null && error.length > 0}
      aria-describedby={errorId}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}
