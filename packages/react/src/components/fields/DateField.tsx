import type { FieldComponentProps } from '../../types'

/** Coerce a stored value into the string an <input type=date|datetime-local> expects. */
function toInputValue(value: unknown, datetime: boolean): string {
  if (value == null || value === '') return ''
  const str = String(value)
  // Already a date-only string.
  if (!datetime) return str.slice(0, 10)
  // datetime-local wants YYYY-MM-DDTHH:mm — trim seconds / timezone.
  const match = str.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
  if (match) return `${match[1]}T${match[2]}`
  return str.slice(0, 16).replace(' ', 'T')
}

export function DateField({
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
  const datetime = field.fieldType === 'datetime'
  return (
    <input
      type={datetime ? 'datetime-local' : 'date'}
      id={id}
      name={field.field}
      value={toInputValue(value, datetime)}
      required={field.required}
      disabled={disabled}
      readOnly={readOnly}
      aria-required={field.required}
      aria-invalid={error != null && error.length > 0}
      aria-describedby={errorId}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    />
  )
}
