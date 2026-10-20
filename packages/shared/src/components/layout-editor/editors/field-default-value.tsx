import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useMemo } from 'react'
import { Input } from '../../ui/input'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { RelationLabel } from '../pickers/relation-label'
import { RelationPicker } from '../pickers/relation-picker'
import { useEditorApi } from './editor-api'

export type DefaultValueSettings = { options?: unknown; interface?: string | null }

/** Per-field slice of the layout's default_values, edited from the field
 *  chip's settings — relation fields pick records by display label. Saves
 *  straight onto the layout row; the layout-level Settings list shows the
 *  same data. */
export function FieldDefaultValueSection({
  layoutId,
  collection,
  fieldName,
  isM2O,
  isM2M,
  relatedCollection,
  settings,
  abstractType
}: {
  layoutId: number
  collection: string
  fieldName: string
  isM2O?: boolean
  isM2M?: boolean
  relatedCollection?: string | null
  settings: DefaultValueSettings
  abstractType?: string
}) {
  const api = useEditorApi()
  const qc = useQueryClient()
  const { data: layouts = [] } = useQuery<
    Array<{ id: number; default_values?: Record<string, unknown> | string | null }>
  >({
    queryKey: ['collection-layouts', collection],
    queryFn: () =>
      api.get('/collection-layouts', { params: { collection } }).then((r) => r.data.data ?? []),
    enabled: !!collection
  })
  const layoutRow = layouts.find((l) => l.id === layoutId)
  const dv = useMemo(() => {
    const raw = layoutRow?.default_values
    const parsed =
      typeof raw === 'string'
        ? (() => {
            try {
              return JSON.parse(raw)
            } catch {
              return null
            }
          })()
        : raw
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  }, [layoutRow?.default_values])
  const value = dv[fieldName]

  const saveMut = useMutation({
    mutationFn: (next: Record<string, unknown> | null) =>
      api.patch(`/collection-layouts/${layoutId}`, { default_values: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collection-layouts', collection] })
  })
  const setValue = (v: unknown) => {
    const next = { ...dv }
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
      delete next[fieldName]
    } else {
      next[fieldName] = v
    }
    saveMut.mutate(Object.keys(next).length ? next : null)
  }

  return (
    <div className='space-y-2'>
      <p className='border-t border-slate-100 pt-2 text-[11px] font-semibold text-slate-400 dark:border-border'>
        Default value
      </p>
      <FieldDefaultValueControl
        value={value}
        onChange={setValue}
        isM2O={isM2O}
        isM2M={isM2M}
        relatedCollection={relatedCollection}
        settings={settings}
        abstractType={abstractType}
      />
      <p className='text-[11px] leading-relaxed text-slate-400'>
        Pre-filled when creating a new record on this layout. Optional.
      </p>
    </div>
  )
}

/** The value input for one field's default: a record picker for relations, a
 *  choice list for dropdowns, else text / number. `onChange(v, typing)` —
 *  typing is true for keystrokes in the text input. */
export function FieldDefaultValueControl({
  value,
  onChange,
  isM2O,
  isM2M,
  relatedCollection,
  settings,
  abstractType
}: {
  value: unknown
  onChange: (v: unknown, typing?: boolean) => void
  isM2O?: boolean
  isM2M?: boolean
  relatedCollection?: string | null
  settings: DefaultValueSettings
  abstractType?: string
}) {
  const setValue = onChange
  let control: ReactNode
  if (isM2M && relatedCollection) {
    const ids = Array.isArray(value) ? (value as Array<string | number>) : []
    control = (
      <div className='space-y-1'>
        {ids.length > 0 && (
          <div className='flex flex-wrap gap-1'>
            {ids.map((id) => (
              <span
                key={String(id)}
                className='inline-flex max-w-full items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-700 dark:bg-muted dark:border-border dark:text-foreground'
              >
                <span className='truncate'>
                  <RelationLabel relatedCollection={relatedCollection} id={id} />
                </span>
                <button
                  type='button'
                  onClick={() => setValue(ids.filter((x) => String(x) !== String(id)))}
                  className='shrink-0 text-slate-400 hover:text-red-500'
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <RelationPicker
          relatedCollection={relatedCollection}
          value={null}
          onChange={(id) => {
            if (id == null || id === '') return
            if (ids.some((x) => String(x) === String(id))) return
            setValue([...ids, id as string | number])
          }}
          placeholder='Add…'
        />
      </div>
    )
  } else if (isM2O && relatedCollection) {
    control = (
      <RelationPicker
        relatedCollection={relatedCollection}
        value={value ?? null}
        onChange={(id) => setValue(id ?? null)}
        placeholder='Pick a record…'
      />
    )
  } else if (abstractType === 'boolean') {
    control = (
      <SimpleSelect
        value={value === true ? 'true' : value === false ? 'false' : ''}
        onChange={(v) => setValue(v === '' ? null : v === 'true')}
        className='h-7 w-full rounded border-slate-200 bg-white px-1.5 py-1 text-[11px] dark:bg-card dark:border-border'
        options={[
          { value: '', label: '—' },
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' }
        ]}
      />
    )
  } else {
    const opts = (() => {
      const raw = settings.options as unknown
      if (raw && typeof raw === 'object') return raw as Record<string, unknown>
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw) as Record<string, unknown>
        } catch {
          return {}
        }
      }
      return {}
    })()
    const choices = Array.isArray(opts.choices)
      ? (opts.choices as Array<{ text?: string; value?: unknown }>)
      : null
    if ((settings.interface ?? '') === 'select-dropdown' && choices && choices.length > 0) {
      control = (
        <SimpleSelect
          value={value != null ? String(value) : ''}
          onChange={(raw) => {
            if (raw === '') return setValue(null)
            const match = choices.find((c) => String(c.value) === raw)
            setValue(match?.value ?? raw)
          }}
          className='h-7 w-full rounded border-slate-200 bg-white px-1.5 py-1 text-[11px] dark:bg-card dark:border-border'
          options={[
            { value: '', label: '—' },
            ...choices.map((c) => ({ value: String(c.value), label: c.text ?? String(c.value) }))
          ]}
        />
      )
    } else {
      const numeric =
        abstractType === 'integer' ||
        abstractType === 'decimal' ||
        abstractType === 'float' ||
        abstractType === 'number'
      control = (
        <Input
          value={value != null ? String(value) : ''}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') return setValue(null, true)
            setValue(numeric && !Number.isNaN(Number(raw)) ? Number(raw) : raw, true)
          }}
          placeholder='No default'
          className='h-7 text-[11px]'
        />
      )
    }
  }

  return control
}
