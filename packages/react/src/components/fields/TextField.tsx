import type { FieldComponentProps } from '../../types'

export function TextField({
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
      type='text'
      id={id}
      name={field.field}
      value={value == null ? '' : String(value)}
      required={field.required}
      disabled={disabled}
      readOnly={readOnly}
      aria-required={field.required}
      aria-invalid={error != null && error.length > 0}
      aria-describedby={errorId}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
