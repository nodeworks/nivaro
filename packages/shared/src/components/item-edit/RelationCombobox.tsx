import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, Loader2, Search, X } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient, useStaleFieldReporter } from '../../context'
import { get } from '../../lib/commands'
import { ACTIVE_USER_OPTION_FILTER, cn } from '../../lib/utils'
import { applyDisplayTemplate } from './helpers'

/**
 * Instant hover tooltip for a picker whose committed value failed its
 * availability probe ("Current value is not an available option"). The old
 * inline <p> wrapped into a squished text column inside narrow grid cells —
 * the amber border + triangle stay as the signal, the words ride this
 * pointer-events-none body portal (safe under modal locks). Spread `bind`
 * onto the trigger element and render `tip` anywhere in the tree.
 */
export function useStaleTip(active: boolean): {
  bind: {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void
    onMouseLeave: () => void
  }
  tip: React.ReactNode
} {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const bind = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      if (!active) return
      const r = e.currentTarget.getBoundingClientRect()
      const flipUp = window.innerHeight - r.bottom < 80
      setPos({ x: r.left, y: flipUp ? r.top - 58 : r.bottom + 4 })
    },
    onMouseLeave: () => setPos(null)
  }
  const tip =
    active && pos
      ? createPortal(
          <div
            style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 130 }}
            className='pointer-events-none max-w-[300px] rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11.5px] leading-snug text-amber-800 shadow-md dark:border-amber-500/40 dark:bg-[#2a2113] dark:text-amber-300'
          >
            Current value is not an available option — clear to pick another
          </div>,
          document.body
        )
      : null
  return { bind, tip }
}

// ─── RelationCombobox (M2O) ────────────────────────────────────────────────────

export function RelationCombobox({
  collection,
  value,
  onChange,
  disabled,
  placeholder,
  extraFilter,
  autoSelectSingle,
  optionSort,
  requiredParent,
  facets,
  fieldKey
}: {
  collection: string
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  placeholder?: string
  extraFilter?: Record<string, unknown>
  /** When the filtered option set has EXACTLY one option and the field is
   *  empty, pick it automatically (options.auto_select_single). Two or more
   *  options — or zero — leave the field blank; an existing value is never
   *  overridden. Re-evaluates when the effective filter changes (e.g. a
   *  cascade parent narrowing the list). */
  autoSelectSingle?: boolean
  /** Option ordering: 'column' | '-column' (server sort) | 'label' | '-label' (display-label sort). Default: label ascending. */
  optionSort?: string
  requiredParent?: string
  /** Field name, so staleness can be reported to the form by name. */
  fieldKey?: string
  /** In-picker filter facets: M2O fields ON THE TARGET COLLECTION rendered as
   *  small pickers inside the dropdown. Ephemeral — they only narrow the
   *  option list, nothing is written to the form. */
  facets?: Array<{ field: string; label?: string; sort?: string; filter?: Record<string, unknown> }>
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30)
    else {
      setQuery('')
      setDebouncedQuery('')
    }
  }, [open])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Element | null
      // The panel PORTALS out of rootRef (see panelStyle below) — clicks inside
      // any combobox panel (incl. a nested facet's) must not read as outside.
      if (t?.closest?.('[data-nvr-combobox-panel]')) return
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // ── Portal positioning ──────────────────────────────────────────────────────
  // The options panel used to be `absolute` inside the trigger's own tree, so
  // any overflow ancestor (inline-grid drawers, table wrappers) CLIPPED it.
  // Portal it out — into the hosting [role=dialog] content when inside a sheet
  // (a body portal there inherits the modal lock's pointer-events:none — the
  // DropPanel/roster precedent), else document.body. Flips upward near the
  // viewport bottom; repositions on capture-phase scroll + resize.
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null)
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPanelStyle(null)
      return
    }
    const update = () => {
      const anchor = rootRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const container =
        (anchor.closest('[role="dialog"]') as HTMLElement | null) ?? document.body
      setPortalEl(container)
      const flipUp = window.innerHeight - r.bottom < 340 && r.top > window.innerHeight - r.bottom
      const x = r.left
      const y = flipUp ? r.top - 4 : r.bottom + 4
      const common: CSSProperties = {
        minWidth: r.width,
        zIndex: 120,
        ...(flipUp ? { transform: 'translateY(-100%)' } : {})
      }
      if (container === document.body) {
        setPanelStyle({ position: 'fixed', left: x, top: y, ...common })
      } else {
        const c = container.getBoundingClientRect()
        setPanelStyle({ position: 'absolute', left: x - c.left, top: y - c.top, ...common })
      }
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
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

  // ── In-picker facets ──────────────────────────────────────────────────────
  const [facetSel, setFacetSel] = useState<Record<string, unknown>>({})
  const { data: targetRelations = [] } = useQuery<
    Array<{
      many_collection?: string
      many_field?: string
      one_collection?: string
      junction_field?: string | null
    }>
  >({
    queryKey: ['collection-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { relations?: Array<Record<string, unknown>> } }>(
          get(`/collections/${collection}`)
        )
        .then(
          (r) =>
            (r.data?.relations ?? []) as Array<{
              many_collection?: string
              many_field?: string
              one_collection?: string
              junction_field?: string | null
            }>
        ),
    enabled: !!facets?.length,
    staleTime: 10 * 60_000
  })
  const facetTargets = useMemo(() => {
    const map: Record<string, string> = {}
    for (const f of facets ?? []) {
      const rel = targetRelations.find(
        (r) => r.many_collection === collection && r.many_field === f.field && !r.junction_field
      )
      if (rel?.one_collection) map[f.field] = rel.one_collection
    }
    return map
  }, [facets, targetRelations, collection])
  // System user pickers: nivaro_users has no nivaro_collections row, so give it a
  // sane default template + exclude redacted/suspended users (mirrors listUsers()).
  const isUserCollection = collection === 'nivaro_users'
  const combinedFilter = useMemo(() => {
    const clauses: Record<string, unknown>[] = []
    if (isUserCollection) clauses.push(ACTIVE_USER_OPTION_FILTER)
    if (extraFilter) clauses.push(extraFilter)
    for (const [f, v] of Object.entries(facetSel)) {
      if (v !== null && v !== undefined && v !== '') clauses.push({ [f]: { _eq: v } })
    }
    if (clauses.length === 0) return undefined
    return clauses.length === 1 ? clauses[0] : { _and: clauses }
  }, [extraFilter, facetSel])

  // Extract template fields for relation expansion (e.g. '{{category.name}}' → 'category.name')
  const effectiveTemplate =
    colMeta?.display_template ??
    (isUserCollection ? '{{first_name}} {{last_name}} ({{email}})' : null)
  const tmplFields = useMemo(() => {
    if (!effectiveTemplate) return undefined
    const matches = [...effectiveTemplate.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1])
    if (!matches.length) return undefined
    return ['id', ...matches].join(',')
  }, [effectiveTemplate])

  const filterStr = combinedFilter ? JSON.stringify(combinedFilter) : undefined
  // Column-based option sort goes to the server; 'label'/'-label' sort client-side
  const serverSort = optionSort && !/^-?label$/.test(optionSort) ? optionSort : undefined
  const { data, isFetching: isLoadingOptions } = useQuery<Item[]>({
    queryKey: [
      'relation-opts',
      collection,
      debouncedQuery,
      filterStr,
      tmplFields,
      serverSort ?? ''
    ],
    queryFn: () =>
      client
        .request<{ data: Item[] }>(
          get(`/items/${collection}`, {
            limit: 200,
            picker: '1',
            ...(debouncedQuery ? { search: debouncedQuery } : {}),
            ...(filterStr ? { filter: filterStr } : {}),
            ...(tmplFields ? { fields: tmplFields } : {}),
            ...(serverSort ? { sort: serverSort } : {})
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
          get(`/items/${collection}`, {
            filter: availabilityFilter,
            picker: '1',
            limit: 1,
            fields: 'id'
          })
        )
        .then((r) => r.data ?? []),
    enabled: !!value && !!selected,
    staleTime: 30_000
  })
  const isStale = !!value && availabilityData !== undefined && availabilityData.length === 0

  // auto_select_single: with the field EMPTY, probe the filtered option set
  // (limit 2 — only the "exactly one?" answer matters) and pick the sole
  // option. Side-effect fetch outside react-query, so it carries the same
  // dedupe guard as useCascadeEffects: one probe per filter shape, ref cleared
  // on failure so a transient error can't permanently suppress the fill.
  const autoSelectRef = useRef<string | null>(null)
  const isEmpty = value === null || value === undefined || value === ''
  useEffect(() => {
    if (!autoSelectSingle || disabled || !isEmpty) return
    const probeKey = `${collection}|${filterStr ?? ''}`
    if (autoSelectRef.current === probeKey) return
    autoSelectRef.current = probeKey
    client
      .request<{ data: Item[] }>(
        get(`/items/${collection}`, {
          limit: 2,
          picker: '1',
          fields: 'id',
          ...(filterStr ? { filter: filterStr } : {})
        })
      )
      .then((r) => {
        const rows = r.data ?? []
        if (rows.length === 1 && rows[0]?.id != null) onChange(rows[0].id)
      })
      .catch(() => {
        autoSelectRef.current = null
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSelectSingle, disabled, isEmpty, collection, filterStr])

  const tmpl = effectiveTemplate
  const selectedLabel = value && selected ? applyDisplayTemplate(tmpl, selected) : null
  const showLoader = !!value && isLoadingSelected && !selected
  const staleTip = useStaleTip(isStale)

  // Report upward. Deliberately AFTER availability has resolved: reporting
  // `false` while the probe is in flight would clear a real flag on every
  // re-render.
  const reportStale = useStaleFieldReporter()
  useEffect(() => {
    if (!reportStale || !fieldKey || availabilityData === undefined) return
    reportStale(fieldKey, isStale)
  }, [reportStale, fieldKey, isStale, availabilityData])

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
    // Stale tooltip binds on the WRAPPER: a disabled trigger button swallows
    // mouse events, so a locked-but-stale field would never show the hint.
    <div ref={rootRef} className='relative' {...staleTip.bind}>
      <button
        type='button'
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-50',
          isStale ? 'border-amber-300 dark:border-amber-600' : 'border-input'
        )}
      >
        {showLoader ? (
          <Loader2 className='h-3.5 w-3.5 animate-spin text-muted-foreground' />
        ) : (
          <span
            className={cn(
              'flex items-center gap-1.5 truncate min-w-0',
              !selectedLabel && 'text-muted-foreground'
            )}
          >
            {isStale && <AlertTriangle className='h-3.5 w-3.5 shrink-0 text-amber-500' />}
            <span className='truncate'>{selectedLabel ?? placeholder ?? 'Select…'}</span>
          </span>
        )}
        <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
      </button>
      {staleTip.tip}
      {open &&
        panelStyle &&
        portalEl &&
        createPortal(
        <div
          data-nvr-combobox-panel=''
          style={panelStyle}
          className={cn(
            'rounded-md border border-border bg-popover shadow-md',
            facets?.length ? 'w-[560px] max-w-[92vw]' : 'min-w-[240px] w-max max-w-[360px]'
          )}
        >
          {!!facets?.length && (
            <div className='grid grid-cols-2 gap-2 border-b border-border bg-slate-50/60 p-2 dark:bg-muted/40'>
              {facets.map((f) => {
                const target = facetTargets[f.field]
                if (!target) return null
                return (
                  <div key={f.field}>
                    <p className='mb-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400'>
                      {f.label ?? f.field}
                    </p>
                    <RelationCombobox
                      collection={target}
                      value={facetSel[f.field] ?? null}
                      onChange={(v) => setFacetSel((prev) => ({ ...prev, [f.field]: v }))}
                      placeholder='Any'
                      optionSort={f.sort}
                      extraFilter={f.filter}
                    />
                  </div>
                )
              })}
            </div>
          )}
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
                onClick={() => {
                  onChange(null)
                  setOpen(false)
                }}
                className='flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-slate-500 hover:bg-muted border-b border-slate-100 dark:text-slate-400 dark:border-border'
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
              (serverSort
                ? [...(data ?? [])]
                : [...(data ?? [])].sort((a, b) =>
                    optionSort === '-label'
                      ? applyDisplayTemplate(tmpl, b).localeCompare(applyDisplayTemplate(tmpl, a))
                      : applyDisplayTemplate(tmpl, a).localeCompare(applyDisplayTemplate(tmpl, b))
                  )
              ).map((item) => {
                const label = applyDisplayTemplate(tmpl, item) || `#${item.id}`
                const sel = String(item.id) === String(value)
                return (
                  <button
                    key={String(item.id)}
                    type='button'
                    onClick={() => {
                      onChange(item.id)
                      setOpen(false)
                    }}
                    className='flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-left hover:bg-muted'
                  >
                    <div
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                        sel ? 'border-nvr-cyan bg-nvr-cyan' : 'border-slate-300'
                      )}
                    >
                      {sel && <Check className='h-2.5 w-2.5 text-white' />}
                    </div>
                    {label}
                  </button>
                )
              })
            )}
          </div>
        </div>,
        portalEl
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
  const isFiles = collection === 'nivaro_files' || collection === 'directus_files'
  const { data, isLoading } = useQuery<Record<string, unknown>>({
    queryKey: ['relation-single', collection, String(id)],
    queryFn: () =>
      isFiles
        ? client.request<{ data: Record<string, unknown> }>(get(`/files/${id}`)).then((r) => r.data)
        : client
            .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${id}`))
            .then((r) => r.data),
    enabled: !!id && !!collection,
    staleTime: 60_000
  })
  if (isLoading) return <Loader2 className='h-3 w-3 animate-spin text-slate-400' />
  if (!data) return <span>{String(id ?? '')}</span>
  if (isFiles) {
    const label = (data.title ||
      data.filename_download ||
      data.filename_disk ||
      String(id)) as string
    return <span>{label}</span>
  }
  return <span>{applyDisplayTemplate(displayTemplate, data)}</span>
}
