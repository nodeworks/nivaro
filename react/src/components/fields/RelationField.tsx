import React, { useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import { useRelationOptions } from '../../hooks/useRelationOptions'
import type { FieldComponentProps } from '../../types'

/**
 * Unstyled relation picker.
 *  - m2o: single <select> of related items
 *  - o2m / m2m: multi <select> of related item ids
 *
 * Options are fetched from the related collection via useRelationOptions and
 * labelled with the relation's display template.
 *
 * If no NivaroClient is available (neither via NivaroProvider nor passed
 * directly to the field consumer), a visible error is shown instead of a
 * silently-empty picker.
 */
export function RelationField({
  field,
  value,
  onChange,
  error,
  disabled,
  readOnly,
  inputId,
  errorId
}: FieldComponentProps) {
  const client = useOptionalNivaroClient()
  const [search, setSearch] = useState('')
  const relatedCollection = field.relation?.relatedCollection ?? ''
  const {
    options,
    loading,
    error: fetchError
  } = useRelationOptions(client, relatedCollection, {
    search: search || undefined,
    displayTemplate: field.relation?.displayTemplate ?? null,
    enabled: !!relatedCollection
  })

  const id = inputId ?? field.field
  const isMany = field.fieldType === 'relation-o2m' || field.fieldType === 'relation-m2m'

  if (!client) {
    return (
      <span role="alert" data-nivaro-field-error>
        No NivaroClient available — wrap in &lt;NivaroProvider&gt; or pass a client prop.
      </span>
    )
  }

  if (!relatedCollection) {
    return (
      <input
        type="text"
        id={id}
        name={field.field}
        value={value == null ? '' : String(value)}
        disabled={disabled}
        readOnly={readOnly}
        aria-required={field.required}
        aria-invalid={error != null && error.length > 0}
        aria-describedby={errorId}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  if (isMany) {
    const selected = Array.isArray(value)
      ? value.map((v) =>
          v != null && typeof v === 'object' ? String((v as { id?: unknown }).id) : String(v)
        )
      : []
    return (
      <div>
        <input
          type="search"
          placeholder="Search…"
          value={search}
          disabled={disabled || readOnly}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          id={id}
          name={field.field}
          multiple
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
          {options.map((o) => (
            <option key={String(o.id)} value={String(o.id)}>
              {o.label}
            </option>
          ))}
        </select>
        {loading ? <span aria-live="polite">Loading…</span> : null}
        {fetchError ? <span role="alert">{fetchError.message}</span> : null}
      </div>
    )
  }

  const current =
    value != null && typeof value === 'object'
      ? String((value as { id?: unknown }).id ?? '')
      : value == null
        ? ''
        : String(value)

  return (
    <div>
      <input
        type="search"
        placeholder="Search…"
        value={search}
        disabled={disabled || readOnly}
        onChange={(e) => setSearch(e.target.value)}
      />
      <select
        id={id}
        name={field.field}
        required={field.required}
        disabled={disabled || readOnly}
        value={current}
        aria-required={field.required}
        aria-invalid={error != null && error.length > 0}
        aria-describedby={errorId}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={String(o.id)} value={String(o.id)}>
            {o.label}
          </option>
        ))}
      </select>
      {loading ? <span aria-live="polite">Loading…</span> : null}
      {fetchError ? <span role="alert">{fetchError.message}</span> : null}
    </div>
  )
}
