import type { FieldComponentProps } from '../../types'

type Choice = { text: string; value: string | number }

function extractChoices(options: Record<string, unknown> | null): Choice[] {
  if (!options) return []
  const raw = (options.choices ?? options.options) as unknown
  if (!Array.isArray(raw)) return []
  return raw
    .map((c): Choice | null => {
      if (c && typeof c === 'object') {
        const obj = c as Record<string, unknown>
        const value = (obj.value ?? obj.text) as string | number | undefined
        const text = (obj.text ?? obj.label ?? obj.value) as string | undefined
        if (value === undefined) return null
        return { text: String(text ?? value), value: value as string | number }
      }
      if (typeof c === 'string' || typeof c === 'number') {
        return { text: String(c), value: c }
      }
      return null
    })
    .filter((c): c is Choice => c !== null)
}

export function SelectField({
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
  const choices = extractChoices(field.options)
  // Use the normalized fieldType, not the raw interface string, to detect
  // multi-select — fieldType is already resolved by normalizeFieldType.
  const isMultiple = field.fieldType === 'checkbox-group'

  if (isMultiple) {
    const selected = Array.isArray(value) ? value.map(String) : []
    return (
      <select
        id={id}
        name={field.field}
        multiple
        required={field.required}
        disabled={disabled || readOnly}
        value={selected}
        aria-required={field.required}
        aria-invalid={error != null && error.length > 0}
        aria-describedby={errorId}
        onChange={(e) => {
          const next = Array.from(e.target.selectedOptions).map((o) => o.value)
          onChange(next)
        }}
      >
        {choices.map((c) => (
          <option key={String(c.value)} value={String(c.value)}>
            {c.text}
          </option>
        ))}
      </select>
    )
  }

  return (
    <select
      id={id}
      name={field.field}
      required={field.required}
      disabled={disabled || readOnly}
      value={value == null ? '' : String(value)}
      aria-required={field.required}
      aria-invalid={error != null && error.length > 0}
      aria-describedby={errorId}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    >
      <option value=''>—</option>
      {choices.map((c) => (
        <option key={String(c.value)} value={String(c.value)}>
          {c.text}
        </option>
      ))}
    </select>
  )
}
