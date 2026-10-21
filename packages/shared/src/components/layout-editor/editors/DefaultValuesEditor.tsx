import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../../lib/utils'
import { RelationLabel } from '../pickers/relation-label'
import { RelationPicker } from '../pickers/relation-picker'
import { inputCls, PickList, quietText, Segmented } from '../settings/controls'
import {
  fieldLabel,
  parseFieldOptions,
  type SettingsField,
  type SettingsRelation,
  storedFieldNames,
  type TableColumn
} from '../settings/settings-api'
import { type DefaultValueRow, defaultsFromRows, rowsFromDefaults, sameJson } from './layout-rows'

/**
 * Typed editor for one starting value: relation fields pick records by their
 * display labels (M2M as a chip list), choice fields list their choices, yes/no
 * fields toggle — anything else is a text input (`typing` = coalesce the save).
 */
export function LayoutDefaultValueInput({
  tableName,
  field,
  value,
  onChange,
  onBlur,
  fieldMeta,
  relations
}: {
  tableName: string
  field: string
  value: unknown
  onChange: (v: unknown, opts?: { typing?: boolean }) => void
  onBlur?: () => void
  fieldMeta: SettingsField[]
  relations: SettingsRelation[]
}) {
  const meta = fieldMeta.find((f) => f.field === field)
  const opts = parseFieldOptions(meta?.options)

  // M2M alias: the relation whose one_field (or legacy junction-name) is this
  // field; the target collection comes from the junction's companion leg.
  const m2mRel =
    relations.find(
      (r) => r.one_collection === tableName && r.one_field === field && r.junction_field != null
    ) ??
    relations.find(
      (r) =>
        r.one_collection === tableName && r.many_collection === field && r.junction_field != null
    )
  const m2mTarget = m2mRel
    ? (relations.find(
        (cr) =>
          cr.many_collection === m2mRel.many_collection && cr.many_field === m2mRel.junction_field
      )?.one_collection ?? null)
    : null
  if (m2mRel && m2mTarget) {
    const ids = Array.isArray(value) ? (value as Array<string | number>) : []
    return (
      <div className='min-w-0 flex-1 space-y-1'>
        {ids.length > 0 && (
          <div className='flex flex-wrap gap-1'>
            {ids.map((id) => (
              <span
                key={String(id)}
                className='inline-flex max-w-full items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[12px] text-slate-700 dark:border-border dark:bg-muted dark:text-foreground'
              >
                <span className='truncate'>
                  <RelationLabel relatedCollection={m2mTarget} id={id} />
                </span>
                <button
                  type='button'
                  aria-label='Remove'
                  onClick={() => onChange(ids.filter((x) => String(x) !== String(id)))}
                  className='shrink-0 text-slate-400 hover:text-[#9c2f47] dark:hover:text-[#f08aa1]'
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <RelationPicker
          relatedCollection={m2mTarget}
          value={null}
          onChange={(id) => {
            if (id == null || id === '') return
            if (ids.some((x) => String(x) === String(id))) return
            onChange([...ids, id as string | number])
          }}
          placeholder='Add…'
        />
      </div>
    )
  }

  // Plain M2O FK on this collection.
  const m2oRel = relations.find(
    (r) =>
      r.many_collection === tableName &&
      r.many_field === field &&
      r.junction_field == null &&
      !!r.one_collection
  )
  if (m2oRel?.one_collection) {
    return (
      <div className='min-w-0 flex-1'>
        <RelationPicker
          relatedCollection={m2oRel.one_collection}
          value={value ?? null}
          onChange={(id) => onChange(id ?? null)}
          placeholder='Pick a record…'
        />
      </div>
    )
  }

  if (meta?.type === 'boolean') {
    return (
      <Segmented<string>
        ariaLabel='Starting value'
        value={value === true ? 'true' : value === false ? 'false' : ''}
        options={[
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' }
        ]}
        onChange={(v) => onChange(v === 'true')}
      />
    )
  }

  const choices = Array.isArray(opts.choices)
    ? (opts.choices as Array<{ text?: string; value?: unknown }>)
    : null
  if (choices && choices.length > 0) {
    return (
      <PickList
        ariaLabel='Starting value'
        value={value != null ? String(value) : null}
        options={choices.map((c) => ({
          value: String(c.value),
          label: c.text ?? String(c.value)
        }))}
        clearLabel='No value'
        onChange={(raw) => {
          if (raw == null) return onChange(null)
          const match = choices.find((c) => String(c.value) === raw)
          onChange(match?.value ?? raw)
        }}
        className='min-w-0 flex-1'
      />
    )
  }

  const numeric = meta?.type === 'integer' || meta?.type === 'decimal' || meta?.type === 'float'
  return (
    <input
      aria-label='Starting value'
      value={value != null ? String(value) : ''}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') return onChange(null, { typing: true })
        onChange(numeric && !Number.isNaN(Number(raw)) ? Number(raw) : raw, { typing: true })
      }}
      onBlur={onBlur}
      placeholder='Value'
      className={cn(inputCls, 'min-w-0 flex-1')}
    />
  )
}

/** Field names a starting value may target: stored fields plus M2M aliases (they stage links). */
export function defaultValueFields(
  collection: string,
  fields: SettingsField[],
  columns: TableColumn[],
  relations: SettingsRelation[]
): string[] {
  const names = storedFieldNames(collection, fields, columns, relations)
  for (const r of relations) {
    if (r.one_collection === collection && r.junction_field != null) {
      const alias = r.one_field ?? r.many_collection
      if (alias && !names.includes(alias)) names.push(alias)
    }
  }
  return names
}

/**
 * "Starting values for new records": one row per field. Rows without a value
 * stay here until they have one; the stored map holds complete rows only.
 */
export function DefaultValuesEditor({
  collection,
  value,
  fields,
  columns,
  relations,
  onChange,
  onBlur
}: {
  collection: string
  value: unknown
  fields: SettingsField[]
  /** The table's physical columns: a default may target a column with no field row. */
  columns: TableColumn[]
  relations: SettingsRelation[]
  onChange: (values: Record<string, unknown> | null, opts: { text: boolean }) => void
  onBlur?: () => void
}) {
  const [rows, setRows] = useState<DefaultValueRow[]>(() => rowsFromDefaults(value))
  useEffect(() => {
    setRows((current) =>
      sameJson(defaultsFromRows(current), value ?? null) ? current : rowsFromDefaults(value)
    )
  }, [value])

  const names = useMemo(
    () => defaultValueFields(collection, fields, columns, relations),
    [collection, fields, columns, relations]
  )
  const commit = (next: DefaultValueRow[], text = false) => {
    setRows(next)
    const map = defaultsFromRows(next)
    if (!sameJson(map, value ?? null)) onChange(map, { text })
  }
  const options = (current: string) =>
    names
      .filter((n) => n === current || !rows.some((r) => r.field === n))
      .map((n) => ({ value: n, label: fieldLabel(fields, n), hint: n }))
      .sort((a, b) => a.label.localeCompare(b.label))

  return (
    <div className='space-y-2' data-default-values>
      {rows.length === 0 ? (
        <p className={quietText}>No starting values. New records open empty.</p>
      ) : (
        <ul className='space-y-1.5'>
          {rows.map((row, i) => (
            <li
              key={row.field || `new-${i}`}
              data-default-row={row.field}
              className='flex items-start gap-1.5 rounded-md border border-slate-200 bg-white p-1.5 dark:border-border dark:bg-card'
            >
              <PickList
                ariaLabel='Starting value field'
                value={row.field || null}
                options={options(row.field)}
                placeholder='Field…'
                // A new field means the old value's shape may not fit (ids vs text).
                onChange={(v) =>
                  commit(rows.map((r, j) => (j === i ? { field: v ?? '', value: null } : r)))
                }
                className='w-[160px] shrink-0'
              />
              {row.field ? (
                <LayoutDefaultValueInput
                  tableName={collection}
                  field={row.field}
                  value={row.value}
                  fieldMeta={fields}
                  relations={relations}
                  onBlur={onBlur}
                  onChange={(v, o) =>
                    commit(
                      rows.map((r, j) => (j === i ? { ...r, value: v } : r)),
                      !!o?.typing
                    )
                  }
                />
              ) : (
                <span className={cn('flex-1 pt-1.5', quietText)}>Pick a field first.</span>
              )}
              <button
                type='button'
                aria-label='Remove starting value'
                onClick={() => commit(rows.filter((_, j) => j !== i))}
                className='mt-1 rounded p-1 text-slate-400 hover:bg-muted hover:text-[#9c2f47] dark:hover:text-[#f08aa1]'
              >
                <Trash2 className='h-3.5 w-3.5' />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type='button'
        onClick={() => setRows((r) => [...r, { field: '', value: null }])}
        className='inline-flex items-center gap-1 text-[12px] font-medium text-slate-600 hover:text-nvr-navy dark:text-muted-foreground dark:hover:text-nvr-cyan'
      >
        <Plus className='h-3.5 w-3.5' />
        Add a starting value
      </button>
    </div>
  )
}
