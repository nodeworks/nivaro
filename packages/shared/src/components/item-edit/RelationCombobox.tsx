import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, Loader2, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { applyDisplayTemplate } from './helpers'

// ─── RelationCombobox (M2O) ────────────────────────────────────────────────────

export function RelationCombobox({
  collection,
  value,
  onChange,
  disabled,
  placeholder,
  extraFilter,
  requiredParent
}: {
  collection: string
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  placeholder?: string
  extraFilter?: Record<string, unknown>
  requiredParent?: string
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30)
    else setQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const { data: colMeta } = useQuery<{ display_template?: string }>({
    queryKey: ['col-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${collection}`))
        .then((r) => r.data),
    staleTime: 300_000,
    retry: false
  })

  type Item = Record<string, unknown>

  // Extract template fields for relation expansion (e.g. '{{category.name}}' → 'category.name')
  const tmplFields = useMemo(() => {
    if (!colMeta?.display_template) return undefined
    const matches = [...colMeta.display_template.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1])
    if (!matches.length) return undefined
    return ['id', ...matches].join(',')
  }, [colMeta?.display_template])

  const filterStr = extraFilter ? JSON.stringify(extraFilter) : undefined
  const { data, isFetching: isLoadingOptions } = useQuery<Item[]>({
    queryKey: ['relation-opts', collection, query, filterStr, tmplFields],
    queryFn: () =>
      client
        .request<{ data: Item[] }>(
          get(`/items/${collection}`, {
            limit: 200,
            picker: '1',
            ...(query ? { search: query } : {}),
            ...(filterStr ? { filter: filterStr } : {}),
            ...(tmplFields ? { fields: tmplFields } : {})
          })
        )
        .then((r) => (r.data ?? []) as Item[]),
    enabled: open,
    staleTime: filterStr ? 0 : 30_000
  })
  const { data: selected, isLoading: isLoadingSelected } = useQuery<Item | null>({
    queryKey: ['relation-single', collection, String(value), tmplFields],
    queryFn: () =>
      client
        .request<{ data: Item }>(
          get(`/items/${collection}/${value}`, tmplFields ? { fields: tmplFields } : undefined)
        )
        .then((r) => r.data),
    enabled: !!value,
    staleTime: 60_000
  })

  const availabilityFilter = extraFilter
    ? JSON.stringify({ _and: [{ id: { _eq: value } }, extraFilter] })
    : JSON.stringify({ id: { _eq: value } })

  const { data: availabilityData } = useQuery<Item[]>({
    queryKey: ['relation-avail', collection, String(value), filterStr],
    queryFn: () =>
      client
        .request<{ data: Item[] }>(
          get(`/items/${collection}`, { filter: availabilityFilter, picker: '1', limit: 1, fields: 'id' })
        )
        .then((r) => r.data ?? []),
    enabled: !!value && !!selected,
    staleTime: 30_000
  })
  const isStale = !!value && availabilityData !== undefined && availabilityData.length === 0

  const tmpl = colMeta?.display_template
  const selectedLabel = (value && selected) ? applyDisplayTemplate(tmpl, selected) : null
  const showLoader = !!value && isLoadingSelected && !selected

  if (requiredParent) {
    return (
      <button
        type='button'
        disabled
        className='flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm text-left opacity-50 cursor-not-allowed'
      >
        <span className='truncate text-muted-foreground'>Select {requiredParent} first</span>
        <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
      </button>
    )
  }

  return (
    <div ref={rootRef} className='relative'>
      <button
        type='button'
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm text-left hover:bg-slate-50 disabled:opacity-50',
          isStale ? 'border-amber-300 dark:border-amber-600' : 'border-input'
        )}
      >
        {showLoader ? (
          <Loader2 className='h-3.5 w-3.5 animate-spin text-muted-foreground' />
        ) : (
          <span className={cn('flex items-center gap-1.5 truncate min-w-0', !selectedLabel && 'text-muted-foreground')}>
            {isStale && <AlertTriangle className='h-3.5 w-3.5 shrink-0 text-amber-500' />}
            <span className='truncate'>{selectedLabel ?? placeholder ?? 'Select…'}</span>
          </span>
        )}
        <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
      </button>
      {isStale && (
        <p className='mt-0.5 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400'>
          <AlertTriangle className='h-3 w-3 shrink-0' />
          Current value is not an available option — clear to pick another
        </p>
      )}
      {open && (
        <div className='absolute z-50 mt-1 min-w-[240px] w-max max-w-[360px] rounded-md border border-border bg-popover shadow-md'>
          <div className='flex items-center border-b px-3'>
            <Search className='mr-2 h-4 w-4 shrink-0 opacity-50' />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search…'
              className='flex h-9 w-full bg-transparent py-3 text-[13px] outline-none placeholder:text-muted-foreground'
            />
          </div>
          <div className='max-h-52 overflow-y-auto py-1'>
            {!!value && !disabled && (
              <button
                type='button'
                onClick={() => { onChange(null); setOpen(false) }}
                className='flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-slate-500 hover:bg-slate-50 border-b border-slate-100'
              >
                <X className='h-3.5 w-3.5 text-slate-400' />
                Clear selection
              </button>
            )}
            {isLoadingOptions ? (
              <div className='flex items-center justify-center py-4'>
                <Loader2 className='h-4 w-4 animate-spin text-muted-foreground' />
              </div>
            ) : (data ?? []).length === 0 ? (
              <p className='px-3 py-2 text-[13px] text-muted-foreground'>No results</p>
            ) : (
              [...(data ?? [])]
                .sort((a, b) =>
                  applyDisplayTemplate(tmpl, a).localeCompare(applyDisplayTemplate(tmpl, b))
                )
                .map((item) => {
                  const label = applyDisplayTemplate(tmpl, item)
                  const sel = String(item.id) === String(value)
                  return (
                    <button
                      key={String(item.id)}
                      type='button'
                      onClick={() => {
                        onChange(item.id)
                        setOpen(false)
                      }}
                      className='flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-left hover:bg-slate-50'
                    >
                      <div className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors', sel ? 'border-nvr-cyan bg-nvr-cyan' : 'border-slate-300')}>
                        {sel && <Check className='h-2.5 w-2.5 text-white' />}
                      </div>
                      {label}
                    </button>
                  )
                })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── RelatedItemLabel ──────────────────────────────────────────────────────────

export function RelatedItemLabel({
  collection,
  id,
  displayTemplate
}: {
  collection: string
  id: unknown
  displayTemplate?: string | null
}) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery<Record<string, unknown>>({
    queryKey: ['relation-single', collection, String(id)],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${id}`))
        .then((r) => r.data),
    enabled: !!id && !!collection,
    staleTime: 60_000
  })
  if (isLoading) return <Loader2 className='h-3 w-3 animate-spin text-slate-400' />
  return <span>{data ? applyDisplayTemplate(displayTemplate, data) : String(id ?? '')}</span>
}
