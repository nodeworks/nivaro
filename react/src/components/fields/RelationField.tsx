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
 */
export function RelationField({
  field,
  value,
  onChange,
  disabled,
  readOnly
}: FieldComponentProps) {
  const client = useOptionalNivaroClient()
  const [search, setSearch] = useState('')
  const relatedCollection = field.relation?.relatedCollection ?? ''
  const { options, loading } = useRelationOptions(client, relatedCollection, {
    search: search || undefined,
    displayTemplate: field.relation?.displayTemplate ?? null,
    enabled: !!relatedCollection
  })

  const isMany = field.fieldType === 'relation-o2m' || field.fieldType === 'relation-m2m'

  if (!relatedCollection) {
    return (
      <input
        type="text"
        id={field.field}
        name={field.field}
        value={value == null ? '' : String(value)}
        disabled={disabled}
        readOnly={readOnly}
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
          id={field.field}
          name={field.field}
          multiple
          disabled={disabled || readOnly}
          value={selected}
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
        id={field.field}
        name={field.field}
        required={field.required}
        disabled={disabled || readOnly}
        value={current}
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
    </div>
  )
}
