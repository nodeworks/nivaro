import type { FieldComponentProps } from '../../types'

export function NumberField({
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
  const step = field.fieldType === 'integer' ? 1 : 'any'
  return (
    <input
      type='number'
      id={id}
      name={field.field}
      step={step}
      value={value == null || value === '' ? '' : String(value)}
      required={field.required}
      disabled={disabled}
      readOnly={readOnly}
      aria-required={field.required}
      aria-invalid={error != null && error.length > 0}
      aria-describedby={errorId}
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
