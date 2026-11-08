import { relatedMissing } from '@nivaro/shared'
import { useEffect, useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import { renderLabel, useRelationOptions } from '../../hooks/useRelationOptions'
import { get } from '../../lib/commands'
import type { FieldComponentProps } from '../../types'

/**
 * The label of a current value that is not among the listed options: read it
 * once; a row the reader cannot open reads "Not available to you" / "Record
 * not found" — never its id (army9 review M7: a workflow whose project is now
 * outside the person's zones showed the bare project number).
 */
function useCurrentLabel(
  client: ReturnType<typeof useOptionalNivaroClient>,
  collection: string,
  current: string,
  listed: boolean,
  template: string | null | undefined
): string | null {
  const [label, setLabel] = useState<{ key: string; text: string } | null>(null)
  const key = `${collection}|${current}`
  useEffect(() => {
    if (!client || !collection || !current || listed) return
    let live = true
    client
      .request<{ data: Record<string, unknown> | null }>(
        get(`/items/${collection}/${encodeURIComponent(current)}`)
      )
      .then((r) => {
        if (!live) return
        const row = r?.data
        setLabel({
          key,
          text: row ? renderLabel(row, template, '') || 'Unnamed record' : relatedMissing(null).text
        })
      })
      .catch((err: unknown) => {
        if (live) setLabel({ key, text: relatedMissing(err).text })
      })
    return () => {
      live = false
    }
  }, [client, collection, current, listed, template, key])
  if (!current || listed) return null
  return label?.key === key ? label.text : 'Loading…'
}

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
  // max_values=1 on M2M means "single pick" — same logic as ItemEdit's M2MSingleSelectCombobox
  const isForcedSingle =
    (field.fieldType === 'relation-o2m' || field.fieldType === 'relation-m2m') &&
    field.options?.max_values === 1
  const isMany =
    (field.fieldType === 'relation-o2m' || field.fieldType === 'relation-m2m') && !isForcedSingle
  const singleCurrent =
    isMany || isForcedSingle
      ? ''
      : value != null && typeof value === 'object'
        ? String((value as { id?: unknown }).id ?? '')
        : value == null
          ? ''
          : String(value)
  const currentListed =
    !singleCurrent || loading || options.some((o) => String(o.id) === singleCurrent)
  const currentLabel = useCurrentLabel(
    client,
    relatedCollection,
    singleCurrent,
    currentListed,
    field.relation?.displayTemplate
  )

  if (!client) {
    return (
      <span role='alert' data-nivaro-field-error>
        No NivaroClient available — wrap in &lt;NivaroProvider&gt; or pass a client prop.
      </span>
    )
  }

  if (!relatedCollection) {
    return (
      <input
        type='text'
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

  if (isForcedSingle) {
    // M2M stored as array but interface wants a single pick — read first, write as [id]
    const arr = Array.isArray(value) ? value : value != null ? [value] : []
    const current =
      arr.length > 0
        ? arr[0] != null && typeof arr[0] === 'object'
          ? String((arr[0] as { id?: unknown }).id ?? '')
          : String(arr[0])
        : ''
    return (
      <div>
        <input
          type='search'
          placeholder='Search…'
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
          onChange={(e) => onChange(e.target.value === '' ? [] : [e.target.value])}
        >
          <option value=''>—</option>
          {options.map((o) => (
            <option key={String(o.id)} value={String(o.id)}>
              {o.label}
            </option>
          ))}
        </select>
        {loading ? <span aria-live='polite'>Loading…</span> : null}
        {fetchError ? <span role='alert'>{fetchError.message}</span> : null}
      </div>
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
          type='search'
          placeholder='Search…'
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
        {loading ? <span aria-live='polite'>Loading…</span> : null}
        {fetchError ? <span role='alert'>{fetchError.message}</span> : null}
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
        type='search'
        placeholder='Search…'
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
        <option value=''>—</option>
        {currentLabel != null && (
          <option value={current} data-nivaro-current-unlisted>
            {currentLabel}
          </option>
        )}
        {options.map((o) => (
          <option key={String(o.id)} value={String(o.id)}>
            {o.label}
          </option>
        ))}
      </select>
      {loading ? <span aria-live='polite'>Loading…</span> : null}
      {fetchError ? <span role='alert'>{fetchError.message}</span> : null}
    </div>
  )
}
