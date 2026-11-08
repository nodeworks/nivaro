import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, matchesAllTokens } from '../../lib/utils'
import { applyDisplayTemplate } from './helpers'
import { NAMELESS_LABEL } from './option-disambiguate'
import { useStaleTip } from './RelationCombobox'

type Item = Record<string, unknown>
type ColMeta = {
  display_template?: string | null
  relations?: Array<{
    many_field?: string
    one_collection?: string
    junction_field?: string | null
  }>
}

export function RelationGroupedCombobox({
  collection,
  value,
  onChange,
  groupField,
  optionField,
  disabled,
  placeholder,
  extraFilter,
  pinned,
  narrowedBy
}: {
  collection: string
  value: unknown
  onChange: (v: unknown) => void
  groupField: string
  optionField: string
  disabled?: boolean
  placeholder?: string
  extraFilter?: Record<string, unknown>
  /** A floating option shown FIRST, above the groups (the project's default
   *  category) — same contract as RelationCombobox `pinned`. */
  pinned?: { id: unknown; tag?: string } | null
  /** Fields of the record narrowing this list (a line's Category follows the
   *  header's Project) — named when the list comes back empty, so an empty
   *  picker says why instead of a bare "No results". */
  narrowedBy?: { labels: string[] }
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  // Keyboard-highlighted option (index into pinned + listed options).
  const [activeIndex, setActiveIndex] = useState(-1)

  // Escape closes the list and focus leaving the picker closes it — an open
  // list must never sit over the next field (army8 b01, same as
  // RelationCombobox). Window capture so a hosting sheet keeps its Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const a = document.activeElement
      if (a !== document.body && !(a && rootRef.current?.contains(a))) return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Node | null
      if (t && t !== document.body && !rootRef.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open])

  const focusSearch = () => {
    const el = inputRef.current
    if (!el || document.activeElement === el) return
    el.focus({ preventScroll: true })
    const end = el.value.length
    el.setSelectionRange?.(end, end)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the listed inputs only; the helpers it calls read refs
  useEffect(() => {
    if (open) {
      // At once when the panel is there (keys typed meanwhile would land on
      // the trigger), and again shortly after for a slow first render.
      if (document.activeElement === triggerRef.current) focusSearch()
      const t = setTimeout(focusSearch, 30)
      return () => clearTimeout(t)
    } else {
      setQuery('')
      setExpandedGroups(new Set())
    }
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
    () =>
      (colMeta?.relations ?? []).find((r) => r.many_field === groupField && !r.junction_field)
        ?.one_collection ?? null,
    [colMeta, groupField]
  )
  const optionRelCollection = useMemo(
    () =>
      (colMeta?.relations ?? []).find((r) => r.many_field === optionField && !r.junction_field)
        ?.one_collection ?? null,
    [colMeta, optionField]
  )

  const { data: groupColMeta } = useQuery<{ display_template?: string | null }>({
    queryKey: ['col-meta', groupRelCollection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string | null } }>(
          get(`/collections/${groupRelCollection}`)
        )
        .then((r) => r.data),
    enabled: !!groupRelCollection,
    staleTime: 300_000,
    retry: false
  })
  const { data: optionColMeta } = useQuery<{ display_template?: string | null }>({
    queryKey: ['col-meta', optionRelCollection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string | null } }>(
          get(`/collections/${optionRelCollection}`)
        )
        .then((r) => r.data),
    enabled: !!optionRelCollection,
    staleTime: 300_000,
    retry: false
  })

  const fieldsParam = `id,${groupField}.*,${optionField}.*`
  const filterStr = extraFilter ? JSON.stringify(extraFilter) : undefined

  const { data: allItems, isFetching: isLoadingItems } = useQuery<Item[]>({
    queryKey: ['relation-grouped-opts', collection, groupField, optionField, filterStr],
    queryFn: () =>
      client
        .request<{ data: Item[] }>(
          get(`/items/${collection}`, {
            limit: 1000,
            picker: '1',
            fields: fieldsParam,
            ...(filterStr ? { filter: filterStr } : {})
          })
        )
        .then((r) => r.data ?? []),
    enabled: open,
    staleTime: filterStr ? 0 : 30_000
  })

  const { data: selectedItem, isLoading: isLoadingSelected } = useQuery<Item | null>({
    queryKey: ['relation-grouped-single', collection, String(value), groupField, optionField],
    queryFn: () =>
      client
        .request<{ data: Item }>(get(`/items/${collection}/${value}`, { fields: fieldsParam }))
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

      if (q && !matchesAllTokens(`${groupLabel} ${optionLabel}`, q)) continue

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

  const pinnedId = pinned?.id != null && pinned.id !== '' ? String(pinned.id) : null
  const { data: pinnedFetched } = useQuery<Item | null>({
    queryKey: ['relation-grouped-single', collection, pinnedId ?? '', groupField, optionField],
    queryFn: () =>
      client
        .request<{ data: Item }>(
          get(`/items/${collection}/${pinnedId}`, { fields: `id,${groupField}.*,${optionField}.*` })
        )
        .then((r) => r.data)
        .catch(() => null),
    enabled: !!pinnedId && open && !(allItems ?? []).some((i) => String(i.id) === pinnedId),
    staleTime: 60_000
  })
  const pinnedItem = pinnedId
    ? ((allItems ?? []).find((i) => String(i.id) === pinnedId) ?? pinnedFetched ?? null)
    : null
  const labelOf = (item: Item) => {
    const g = item[groupField] as Item | null
    const o = item[optionField] as Item | null
    const gl = g ? applyDisplayTemplate(groupTmpl, g) : null
    const ol = o ? applyDisplayTemplate(optionTmpl, o) : null
    return [gl, ol].filter(Boolean).join(' — ') || NAMELESS_LABEL
  }

  // ── Keyboard: one flat list of what is on screen (pinned, then the rows of
  // open groups). Typing highlights the first real match — the pinned
  // Default only when nothing else is listed (army8 review H1) — so Enter
  // picks like every other picker (army9 b01).
  // The pinned Default is listed while the box is empty, and while typing only
  // when the text matches it — a typed miss must never leave it as the one
  // thing Enter can pick (army9 review H4; same rule as RelationCombobox).
  const pinnedShown =
    !!pinnedId &&
    (!query.trim() ||
      matchesAllTokens(
        `${pinnedItem ? labelOf(pinnedItem) : ''} ${pinned?.tag ?? 'Default'}`,
        query.replace(/[-_/]+/g, ' ')
      ))
  const navOffset = pinnedShown ? 1 : 0
  const navItems = useMemo(
    () => groups.filter((g) => expandedGroups.has(g.id)).flatMap((g) => g.items),
    [groups, expandedGroups]
  )
  const navCount = navOffset + navItems.length
  const active = activeIndex >= navCount ? navCount - 1 : activeIndex
  useEffect(() => {
    // Typing highlights the first real match; the pinned row only when it is
    // the one thing listed; a miss highlights nothing.
    setActiveIndex(open && query.trim() ? (navItems.length ? navOffset : pinnedShown ? 0 : -1) : -1)
  }, [open, query, navOffset, navItems.length, pinnedShown])
  const optionDomId = (i: number) => `${listId}-opt-${i}`
  const pickId = (id: unknown) => {
    if (String(id) !== String(value)) onChange(id)
    setOpen(false)
    triggerRef.current?.focus()
  }
  const pickAt = (i: number) => {
    if (i < 0 || i >= navCount) return
    if (i < navOffset) pickId(pinnedItem?.id ?? pinned?.id)
    else pickId(navItems[i - navOffset].id)
  }
  useEffect(() => {
    if (!open || active < 0) return
    const el = rootRef.current?.querySelector(`[data-nav-index="${active}"]`) as
      | (HTMLElement & { scrollIntoView?: (o?: ScrollIntoViewOptions) => void })
      | null
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (navCount > 0) setActiveIndex(active < 0 ? 0 : Math.min(active + 1, navCount - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (navCount > 0) setActiveIndex(active <= 0 ? 0 : active - 1)
    } else if (e.key === 'Enter') {
      // Never submits the form around the picker, and never picks while the
      // list is still loading (the Default was the only row then).
      e.preventDefault()
      if (allItems === undefined) return
      if (active >= 0) pickAt(active)
      else if (query.trim() && navCount === 1) pickAt(0)
    } else if (e.key === 'Tab') {
      // Back to the trigger first so Tab continues to the next field.
      setOpen(false)
      triggerRef.current?.focus()
    }
  }
  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    const printable =
      e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && (open || e.key !== ' ')
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setOpen(true)
    } else if (printable) {
      // Typing on a closed picker opens it searching that text; keys that
      // reach the trigger before focus moved are added, never dropped.
      e.preventDefault()
      const typed = e.key
      setQuery((q) => q + typed)
      if (!open) setOpen(true)
      else focusSearch()
    } else if (open && e.key === 'Backspace') {
      e.preventDefault()
      setQuery((q) => q.slice(0, -1))
      focusSearch()
    } else if (open && (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      onSearchKeyDown(e)
      focusSearch()
    }
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
        ref={triggerRef}
        type='button'
        disabled={disabled}
        aria-haspopup='listbox'
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:pointer-events-none disabled:opacity-50',
          isStale ? 'border-amber-300 dark:border-amber-600' : 'border-input'
        )}
      >
        {showLoader ? (
          <Loader2 className='h-3.5 w-3.5 animate-spin text-muted-foreground' />
        ) : (
          <span
            className={cn(
              'flex items-center gap-1.5 truncate min-w-0',
              !triggerLabel && 'text-muted-foreground'
            )}
          >
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
              onKeyDown={onSearchKeyDown}
              role='combobox'
              aria-expanded
              aria-autocomplete='list'
              aria-controls={`${listId}-list`}
              aria-activedescendant={active >= 0 ? optionDomId(active) : undefined}
              placeholder='Search…'
              className='flex h-9 w-full bg-transparent py-3 text-[13px] outline-none placeholder:text-muted-foreground'
            />
          </div>
          <div id={`${listId}-list`} role='listbox' className='max-h-64 overflow-y-auto py-1'>
            {!!value && !disabled && (
              <button
                type='button'
                tabIndex={-1}
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
            {pinnedShown && (
              <button
                type='button'
                tabIndex={-1}
                id={optionDomId(0)}
                role='option'
                aria-selected={String(value) === pinnedId}
                data-nav-index={0}
                data-nvr-pinned-option
                onClick={() => pickAt(0)}
                onMouseMove={() => active !== 0 && setActiveIndex(0)}
                className={cn(
                  'flex w-full items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-left text-[13px] hover:bg-nvr-cyan/10 dark:border-border',
                  active === 0 ? 'bg-nvr-cyan/10' : 'bg-nvr-cyan/5'
                )}
              >
                <div
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                    String(value) === pinnedId ? 'border-nvr-cyan bg-nvr-cyan' : 'border-slate-300'
                  )}
                >
                  {String(value) === pinnedId && <Check className='h-2.5 w-2.5 text-white' />}
                </div>
                <span className='min-w-0 flex-1 truncate'>
                  {pinnedItem ? labelOf(pinnedItem) : 'Loading…'}
                </span>
                <span className='shrink-0 rounded bg-nvr-cyan/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700 dark:text-foreground'>
                  {pinned?.tag ?? 'Default'}
                </span>
              </button>
            )}
            {isLoadingItems ? (
              <div className='flex items-center justify-center py-4'>
                <Loader2 className='h-4 w-4 animate-spin text-muted-foreground' />
              </div>
            ) : groups.length === 0 ? (
              query.trim() && pinnedShown ? null : query.trim() ? (
                <p className='px-3 py-2 text-[13px] text-muted-foreground'>
                  No results for “{query.trim()}”
                </p>
              ) : extraFilter ? (
                // Nothing at all fits this record: say what narrows the list
                // (a project with no line categories set up — army9 b01) so
                // the person knows who can fix it, instead of a bare "No results".
                <p
                  className='px-3 py-2 text-[12px] leading-5 text-muted-foreground'
                  data-nvr-empty-narrowed
                >
                  {narrowedBy?.labels.length ? (
                    <>
                      Nothing set up for this{' '}
                      <span className='font-medium text-foreground'>
                        {narrowedBy.labels.join(' · ')}
                      </span>{' '}
                      yet.
                    </>
                  ) : (
                    'Nothing set up for this record yet.'
                  )}{' '}
                  Pick a different one, or ask an administrator to add options for it.
                </p>
              ) : (
                <p className='px-3 py-2 text-[13px] text-muted-foreground'>No results</p>
              )
            ) : (
              groups.map((group) => {
                const expanded = expandedGroups.has(group.id)
                return (
                  <div key={group.id}>
                    <button
                      type='button'
                      onClick={() => toggleGroup(group.id)}
                      className='flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 hover:bg-muted'
                    >
                      {expanded ? (
                        <ChevronDown className='h-3 w-3 shrink-0' />
                      ) : (
                        <ChevronRight className='h-3 w-3 shrink-0' />
                      )}
                      {group.label}
                      <span className='ml-auto font-normal normal-case tracking-normal text-slate-400'>
                        {group.items.length}
                      </span>
                    </button>
                    {expanded &&
                      group.items.map((item) => {
                        const nav = navOffset + navItems.indexOf(item)
                        const o = item[optionField] as Item | null
                        const label = o
                          ? applyDisplayTemplate(optionTmpl, o)
                          : String(item.id ?? '')
                        const sel = String(item.id) === String(value)
                        return (
                          <button
                            key={String(item.id)}
                            type='button'
                            tabIndex={-1}
                            id={optionDomId(nav)}
                            role='option'
                            aria-selected={sel}
                            data-nav-index={nav}
                            onClick={() => pickId(item.id)}
                            onMouseMove={() => active !== nav && setActiveIndex(nav)}
                            className={cn(
                              'flex w-full items-center gap-2 pl-8 pr-3 py-1.5 text-[13px] text-left hover:bg-muted',
                              active === nav && 'bg-muted'
                            )}
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
