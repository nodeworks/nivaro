import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { applyDisplayTemplate } from './helpers'
import { useStaleTip } from './RelationCombobox'

type Item = Record<string, unknown>
type ColMeta = { display_template?: string | null; relations?: Array<{ many_field?: string; one_collection?: string; junction_field?: string | null }> }

export function RelationGroupedCombobox({
  collection,
  value,
  onChange,
  groupField,
  optionField,
  disabled,
  placeholder,
  extraFilter
}: {
  collection: string
  value: unknown
  onChange: (v: unknown) => void
  groupField: string
  optionField: string
  disabled?: boolean
  placeholder?: string
  extraFilter?: Record<string, unknown>
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30)
    else { setQuery(''); setExpandedGroups(new Set()) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Collection metadata — returns display_template + relations
  const { data: colMeta } = useQuery<ColMeta>({
    queryKey: ['col-meta', collection],
    queryFn: () =>
      client.request<{ data: ColMeta }>(get(`/collections/${collection}`)).then((r) => r.data),
    staleTime: 300_000,
    retry: false
  })

  // Resolve one_collection for each grouping field from relations
  const groupRelCollection = useMemo(
    () => (colMeta?.relations ?? []).find((r) => r.many_field === groupField && !r.junction_field)?.one_collection ?? null,
    [colMeta, groupField]
  )
  const optionRelCollection = useMemo(
    () => (colMeta?.relations ?? []).find((r) => r.many_field === optionField && !r.junction_field)?.one_collection ?? null,
    [colMeta, optionField]
  )

  const { data: groupColMeta } = useQuery<{ display_template?: string | null }>({
    queryKey: ['col-meta', groupRelCollection],
    queryFn: () =>
      client.request<{ data: { display_template?: string | null } }>(get(`/collections/${groupRelCollection}`)).then((r) => r.data),
    enabled: !!groupRelCollection,
    staleTime: 300_000,
    retry: false
  })
  const { data: optionColMeta } = useQuery<{ display_template?: string | null }>({
    queryKey: ['col-meta', optionRelCollection],
    queryFn: () =>
      client.request<{ data: { display_template?: string | null } }>(get(`/collections/${optionRelCollection}`)).then((r) => r.data),
    enabled: !!optionRelCollection,
    staleTime: 300_000,
    retry: false
  })

  const fieldsParam = `id,${groupField}.*,${optionField}.*`
  const filterStr = extraFilter ? JSON.stringify(extraFilter) : undefined

  const { data: allItems, isFetching: isLoadingItems } = useQuery<Item[]>({
    queryKey: ['relation-grouped-opts', collection, groupField, optionField, filterStr],
    queryFn: () =>
      client.request<{ data: Item[] }>(get(`/items/${collection}`, { limit: 1000, picker: '1', fields: fieldsParam, ...(filterStr ? { filter: filterStr } : {}) })).then((r) => r.data ?? []),
    enabled: open,
    staleTime: filterStr ? 0 : 30_000
  })

  const { data: selectedItem, isLoading: isLoadingSelected } = useQuery<Item | null>({
    queryKey: ['relation-grouped-single', collection, String(value), groupField, optionField],
    queryFn: () =>
      client.request<{ data: Item }>(get(`/items/${collection}/${value}`, { fields: fieldsParam })).then((r) => r.data),
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
    enabled: !!value && !!selectedItem,
    staleTime: 30_000
  })
  const isStale = !!value && availabilityData !== undefined && availabilityData.length === 0

  const groupTmpl = groupColMeta?.display_template
  const optionTmpl = optionColMeta?.display_template

  // Build groups — filter by search query
  const groups = useMemo(() => {
    const items = allItems ?? []
    const q = query.toLowerCase()
    const groupMap = new Map<string, { label: string; items: Item[] }>()

    for (const item of items) {
      const g = item[groupField] as Item | null
      const o = item[optionField] as Item | null
      const groupId = g ? String(g.id ?? '') : '__none__'
      const groupLabel = g ? applyDisplayTemplate(groupTmpl, g) : '—'
      const optionLabel = o ? applyDisplayTemplate(optionTmpl, o) : String(item.id ?? '')

      if (q && !groupLabel.toLowerCase().includes(q) && !optionLabel.toLowerCase().includes(q)) continue

      if (!groupMap.has(groupId)) groupMap.set(groupId, { label: groupLabel, items: [] })
      groupMap.get(groupId)!.items.push(item)
    }

    return [...groupMap.entries()].map(([id, v]) => ({ id, label: v.label, items: v.items }))
  }, [allItems, query, groupField, optionField, groupTmpl, optionTmpl])

  // Auto-expand all groups when searching
  useEffect(() => {
    if (query) setExpandedGroups(new Set(groups.map((g) => g.id)))
  }, [query, groups])

  function toggleGroup(id: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Trigger button label: "GroupLabel — OptionLabel"
  let triggerLabel: string | null = null
  if (selectedItem) {
    const g = selectedItem[groupField] as Item | null
    const o = selectedItem[optionField] as Item | null
    const gl = g ? applyDisplayTemplate(groupTmpl, g) : null
    const ol = o ? applyDisplayTemplate(optionTmpl, o) : null
    triggerLabel = [gl, ol].filter(Boolean).join(' — ') || null
  }
  const showLoader = !!value && isLoadingSelected && !selectedItem
  const staleTip = useStaleTip(isStale)

  return (
    <div ref={rootRef} className='relative' {...staleTip.bind}>
      <button
        type='button'
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm text-left hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-50',
          isStale ? 'border-amber-300 dark:border-amber-600' : 'border-input'
        )}
      >
        {showLoader ? (
          <Loader2 className='h-3.5 w-3.5 animate-spin text-muted-foreground' />
        ) : (
          <span className={cn('flex items-center gap-1.5 truncate min-w-0', !triggerLabel && 'text-muted-foreground')}>
            {isStale && <AlertTriangle className='h-3.5 w-3.5 shrink-0 text-amber-500' />}
            <span className='truncate'>{triggerLabel ?? placeholder ?? 'Select…'}</span>
          </span>
        )}
        <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
      </button>
      {staleTip.tip}

      {open && (
        <div className='absolute z-50 mt-1 min-w-[280px] w-max max-w-[420px] rounded-md border border-border bg-popover shadow-md'>
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
          <div className='max-h-64 overflow-y-auto py-1'>
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
            {isLoadingItems ? (
              <div className='flex items-center justify-center py-4'>
                <Loader2 className='h-4 w-4 animate-spin text-muted-foreground' />
              </div>
            ) : groups.length === 0 ? (
              <p className='px-3 py-2 text-[13px] text-muted-foreground'>No results</p>
            ) : (
              groups.map((group) => {
                const expanded = expandedGroups.has(group.id)
                return (
                  <div key={group.id}>
                    <button
                      type='button'
                      onClick={() => toggleGroup(group.id)}
                      className='flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-50'
                    >
                      {expanded
                        ? <ChevronDown className='h-3 w-3 shrink-0' />
                        : <ChevronRight className='h-3 w-3 shrink-0' />
                      }
                      {group.label}
                      <span className='ml-auto font-normal normal-case tracking-normal text-slate-400'>
                        {group.items.length}
                      </span>
                    </button>
                    {expanded && group.items.map((item) => {
                      const o = item[optionField] as Item | null
                      const label = o ? applyDisplayTemplate(optionTmpl, o) : String(item.id ?? '')
                      const sel = String(item.id) === String(value)
                      return (
                        <button
                          key={String(item.id)}
                          type='button'
                          onClick={() => { onChange(item.id); setOpen(false) }}
                          className='flex w-full items-center gap-2 pl-8 pr-3 py-1.5 text-[13px] text-left hover:bg-slate-50'
                        >
                          <div className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors', sel ? 'border-nvr-cyan bg-nvr-cyan' : 'border-slate-300')}>
                            {sel && <Check className='h-2.5 w-2.5 text-white' />}
                          </div>
                          {label}
                        </button>
                      )
                    })}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
