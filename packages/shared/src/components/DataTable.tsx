import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Pin,
  Search,
  X
} from 'lucide-react'
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn, formatNumber } from '../lib/utils'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './ui/command'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Skeleton } from './ui/skeleton'
import { HScrollProxy } from './HScrollProxy'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

// ─── Constants ────────────────────────────────────────────────────────────────

const SKELETON_ROWS = [1, 2, 3, 4, 5, 6, 7, 8]

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Column<T = Record<string, unknown>> {
  key: string
  header: React.ReactNode
  sortable?: boolean
  className?: string
  headerClassName?: string
  render?: (row: T, index: number) => React.ReactNode
}

export interface FilterDef {
  key: string
  placeholder: string
  /** Defaults to 'select' — every existing FilterDef without this field keeps its current dropdown behavior unchanged. */
  type?: 'select' | 'text' | 'range' | 'combobox'
  /** Required when type is 'select' or omitted; static options for 'combobox'; ignored for 'text'/'range'. */
  options?: { label: string; value: string }[]
  /** 'combobox' only: server-backed autocomplete. Called (debounced) with the search
   *  text; overrides `options` when provided. */
  loadOptions?: (search: string) => Promise<{ label: string; value: string }[]>
  /** 'combobox' only: allow selecting multiple values (filter matches ANY of them). */
  multi?: boolean
  /** Options are narrowed to the viewer's restricted scope — renders an amber badge. */
  restricted?: boolean
}

export interface DataTableProps<T = Record<string, unknown>> {
  columns: Column<T>[]
  rows: T[]
  rowKey?: (row: T, i: number) => string
  total: number
  page: number
  limit?: number
  isLoading?: boolean
  isError?: boolean
  errorMessage?: string
  sort?: string
  onSortChange?: (sort: string) => void
  onPageChange: (page: number) => void
  onRowClick?: (row: T) => void
  searchValue?: string
  onSearchChange?: (val: string) => void
  searchPlaceholder?: string
  filterDefs?: FilterDef[]
  filterValues?: Record<string, string | string[]>
  onFilterChange?: (key: string, value: string | string[]) => void
  toolbarRight?: React.ReactNode
  emptyMessage?: string
  /** Suppress the inline filter-control row while keeping filterDefs available
   *  to the host (e.g. a page rendering its own filter rail). */
  hideFilterRow?: boolean
  /** Force single-line cells (whitespace-nowrap on every body cell) — hosts
   *  pair this with per-column truncation for dense, scannable tables. */
  nowrapCells?: boolean
  /** Pin the selection checkbox (when present) and the first data column so
   *  they stay visible while the table scrolls horizontally. */
  pinFirstColumn?: boolean
  /** Per-column pinning (CollectionBrowserView parity). When provided (even
   *  empty), replaces `pinFirstColumn`: left-pinned columns render first,
   *  right-pinned last, sticky offsets come from live header-cell width
   *  measurement, and (with `onColumnPinChange`) every header grows a
   *  hover-revealed pin button cycling none → left → right → none. */
  columnPins?: Record<string, 'left' | 'right'>
  onColumnPinChange?: (key: string, pin: 'left' | 'right' | null) => void
  /** Render a compact per-column filter row under the headers — each column
   *  whose key matches a FilterDef gets that def's control inline (the
   *  CollectionBrowserView column-filter pattern). Independent of the
   *  toolbar/rail rendering controlled by `hideFilterRow`. */
  columnFilterRow?: boolean
  /** Always-visible draggable horizontal scrollbar under the table (the
   *  CollectionBrowserView HScrollProxy) — the native x-scrollbar is hidden
   *  and trackpad panning is translated by the proxy. */
  hScrollProxy?: boolean
  /** Minimum height for the table body region — keeps empty/short tables from
   *  collapsing to a sliver (empty message centers in the space). */
  minBodyHeight?: number
  /** Fill the parent's (bounded) height: rows scroll INSIDE the card under a
   *  sticky header, so the h-scroll proxy and pagination stay pinned in view
   *  instead of sitting below a page-tall table. Parent must give the card a
   *  definite height (flex chain with min-h-0). */
  fillHeight?: boolean
  selectedIds?: string[]
  onSelectionChange?: (ids: string[]) => void
  /** Optional per-row class — e.g. at-risk background tinting. */
  rowClassName?: (row: T) => string | undefined
  /** Grouped rendering: when set, `rows` is ignored for the body; each group renders
   *  a full-width header row followed by its rows (unless collapsed). Pagination hides. */
  rowGroups?: Array<{ key: string; header: React.ReactNode; rows: T[] }>
  collapsedGroups?: Set<string>
  onToggleGroup?: (key: string) => void
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

function getSortField(sort: string): string {
  return sort.startsWith('-') ? sort.slice(1) : sort
}

function getSortDir(sort: string): 'asc' | 'desc' | null {
  if (!sort) return null
  return sort.startsWith('-') ? 'desc' : 'asc'
}

function nextSort(current: string, field: string): string {
  const currentField = getSortField(current)
  const currentDir = getSortDir(current)
  if (currentField !== field || !current) return field // not sorted by this field → asc
  if (currentDir === 'asc') return `-${field}` // asc → desc
  return '' // desc → clear
}

// ─── Sort icon ────────────────────────────────────────────────────────────────

function SortIcon({ field, sort }: { field: string; sort: string }) {
  const currentField = getSortField(sort)
  const dir = getSortDir(sort)
  if (currentField !== field || !sort) {
    return <ChevronsUpDown className='ml-1 inline h-3 w-3 shrink-0 text-slate-300' />
  }
  if (dir === 'asc') {
    return <ChevronUp className='ml-1 inline h-3 w-3 shrink-0 text-nvr-cyan' />
  }
  return <ChevronDown className='ml-1 inline h-3 w-3 shrink-0 text-nvr-cyan' />
}

// ─── Filter combobox ──────────────────────────────────────────────────────────
// Searchable single-select filter. Static `options` filter client-side via cmdk;
// `loadOptions` swaps to server-backed autocomplete (250ms debounce) for large
// datasets (relation targets). Value is the option value; label is remembered so
// an async-selected option still displays after its options page is gone.

function FilterCombobox({
  def,
  value,
  onChange
}: {
  def: FilterDef
  value: string | string[]
  onChange: (value: string | string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [asyncOptions, setAsyncOptions] = useState<{ label: string; value: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [labelCache, setLabelCache] = useState<Record<string, string>>({})
  const requestSeq = useRef(0)

  const isAsync = !!def.loadOptions
  const selected = Array.isArray(value) ? value : value === '' ? [] : [value]

  useEffect(() => {
    if (!isAsync || !open) return
    const seq = ++requestSeq.current
    setLoading(true)
    const timer = setTimeout(
      () => {
        def
          .loadOptions?.(search)
          .then((opts) => {
            if (requestSeq.current === seq) setAsyncOptions(opts)
          })
          .catch(() => {
            if (requestSeq.current === seq) setAsyncOptions([])
          })
          .finally(() => {
            if (requestSeq.current === seq) setLoading(false)
          })
      },
      search ? 250 : 0
    )
    return () => clearTimeout(timer)
    // biome-ignore lint/correctness/useExhaustiveDependencies: def identity is unstable per render; keyed on search/open
  }, [search, open, isAsync])

  const options = isAsync ? asyncOptions : (def.options ?? [])
  const labelFor = (v: string) =>
    options.find((o) => o.value === v)?.label ??
    (def.options ?? []).find((o) => o.value === v)?.label ??
    labelCache[v] ??
    v
  const currentLabel =
    selected.length === 0
      ? null
      : selected.length === 1
        ? labelFor(selected[0])
        : `${labelFor(selected[0])} +${selected.length - 1}`

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'flex h-8 w-40 items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-2.5 text-[13px] dark:border-border dark:bg-muted/40',
            currentLabel ? 'text-slate-800 dark:text-foreground' : 'text-slate-500'
          )}
        >
          <span className='truncate'>{currentLabel ?? def.placeholder}</span>
          <span className='ml-1 flex shrink-0 items-center gap-0.5'>
            {selected.length > 0 && (
              // biome-ignore lint/a11y/useKeyWithClickEvents: auxiliary clear affordance; Esc + reselect cover keyboard
              <span
                role='button'
                tabIndex={-1}
                aria-label='Clear filter'
                onClick={(e) => {
                  e.stopPropagation()
                  onChange(def.multi ? [] : '')
                }}
                className='rounded p-0.5 text-slate-400 hover:text-slate-600'
              >
                <X className='h-3 w-3' />
              </span>
            )}
            <ChevronsUpDown className='h-3 w-3 text-slate-400' />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command shouldFilter={!isAsync}>
          <CommandInput
            placeholder='Search…'
            className='h-8 text-[12px]'
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-slate-400'>
              {loading ? 'Searching…' : 'No results'}
            </CommandEmpty>
            {options.map((opt) => {
              const isSelected = selected.includes(opt.value)
              return (
                <CommandItem
                  key={opt.value}
                  value={isAsync ? opt.value : opt.label}
                  onSelect={() => {
                    setLabelCache((prev) => ({ ...prev, [opt.value]: opt.label }))
                    if (def.multi) {
                      onChange(
                        isSelected
                          ? selected.filter((v) => v !== opt.value)
                          : [...selected, opt.value]
                      )
                      // stays open — multiselect flows pick several values in a row
                    } else {
                      onChange(isSelected ? '' : opt.value)
                      setOpen(false)
                    }
                  }}
                  className='text-[12px]'
                >
                  <Check className={cn('mr-2 h-3 w-3', isSelected ? 'opacity-100' : 'opacity-0')} />
                  {opt.label}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── FilterControl ────────────────────────────────────────────────────────────
// One filter def rendered as its control. 'inline' = the classic compact
// toolbar chip; 'stacked' = label above a full-width control, for filter rails.

export function FilterControl({
  def,
  value,
  onChange,
  layout = 'inline'
}: {
  def: FilterDef
  value: string | string[]
  onChange: (value: string | string[]) => void
  layout?: 'inline' | 'stacked' | 'cell'
}) {
  const stacked = layout === 'stacked'
  const cell = layout === 'cell'

  const currentVal = typeof value === 'string' ? value : ''
  const widthCls = stacked || cell ? 'w-full' : 'w-40'
  const heightCls = cell ? 'h-7 text-[12px]' : 'text-[13px]'

  let control: React.ReactNode
  if (def.type === 'text') {
    control = (
      <Input
        className={cn('h-8 border-slate-200 bg-slate-50', heightCls, widthCls)}
        placeholder={def.placeholder}
        value={currentVal}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  } else if (def.type === 'combobox') {
    control = (
      <div
        className={cn(
          (stacked || cell) && '[&>button]:w-full',
          cell && '[&>button]:h-7 [&>button]:min-w-[88px] [&>button]:px-1.5 [&>button]:text-[12px]'
        )}
      >
        <FilterCombobox def={def} value={value} onChange={onChange} />
      </div>
    )
  } else if (def.type === 'range') {
    const [minVal, maxVal] = currentVal.split(':')
    control = (
      <div className='flex items-center gap-1'>
        <Input
          type='number'
          className={cn(
            'h-8 border-slate-200 bg-slate-50',
            heightCls,
            stacked || cell ? 'w-full min-w-[48px]' : 'w-20'
          )}
          placeholder='Min'
          value={minVal ?? ''}
          onChange={(e) => onChange(`${e.target.value}:${maxVal ?? ''}`)}
        />
        <span className='text-[12px] text-slate-400'>–</span>
        <Input
          type='number'
          className={cn(
            'h-8 border-slate-200 bg-slate-50',
            heightCls,
            stacked || cell ? 'w-full min-w-[48px]' : 'w-20'
          )}
          placeholder='Max'
          value={maxVal ?? ''}
          onChange={(e) => onChange(`${minVal ?? ''}:${e.target.value}`)}
        />
      </div>
    )
  } else {
    // Radix crashes on empty string value — use __all__ as sentinel
    const selectVal = currentVal === '' ? '__all__' : currentVal
    control = (
      <Select value={selectVal} onValueChange={(v) => onChange(v === '__all__' ? '' : v)}>
        <SelectTrigger className={cn('h-8 border-slate-200 bg-slate-50', heightCls, widthCls)}>
          <SelectValue placeholder={def.placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='__all__'>{def.placeholder}</SelectItem>
          {/* An empty-valued option throws inside Radix; the sentinel above
              already IS the clear-selection entry, so drop any caller's. */}
          {(def.options ?? [])
            .filter((opt) => opt.value !== '')
            .map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    )
  }

  if (!stacked)
    // Restricted scope in the compact layouts = amber outline on the control
    // itself (a floating chip overflows the tight header cells).
    return def.restricted ? (
      <div
        title='Options limited to your restricted scope'
        className='[&_button]:!border-amber-400 [&_input]:!border-amber-400 dark:[&_button]:!border-amber-500/60 dark:[&_input]:!border-amber-500/60'
      >
        {control}
      </div>
    ) : (
      <>{control}</>
    )
  return (
    <div className='space-y-1'>
      <span className='flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
        {filterDefLabel(def)}
        {def.restricted && (
          <span
            title='Options limited to your restricted scope'
            className='rounded bg-amber-500/15 px-1 text-[8.5px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300'
          >
            restricted
          </span>
        )}
      </span>
      {control}
    </div>
  )
}

// Placeholders double as labels in stacked rails and summary pills — drop the
// input-affordance words ("Search …", trailing ellipsis) so they read as nouns.
export function filterDefLabel(def: FilterDef): string {
  return def.placeholder.replace(/^Search\s+/i, '').replace(/[…]|\.{3}$/g, '')
}

/** Human display for an applied filter value — option labels for comboboxes
 * (ids → names), ≥/≤ for ranges, first two entries + count for multiselects. */
export function filterValueDisplay(def: FilterDef, value: string | string[]): string {
  const optLabel = (v: string) => def.options?.find((o) => o.value === v)?.label ?? v
  if (Array.isArray(value)) {
    const names = value.map(optLabel)
    return names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '')
  }
  if (def.type === 'range') {
    const [min, max] = value.split(':')
    return [min && `≥${min}`, max && `≤${max}`].filter(Boolean).join(' ')
  }
  return optLabel(value)
}

// ─── DataTable ────────────────────────────────────────────────────────────────

export function DataTable<T = Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  total,
  page,
  limit = 25,
  isLoading,
  isError,
  errorMessage,
  sort = '',
  onSortChange,
  onPageChange,
  onRowClick,
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search…',
  filterDefs,
  filterValues = {},
  onFilterChange,
  toolbarRight,
  emptyMessage = 'No records found.',
  minBodyHeight,
  fillHeight = false,
  hideFilterRow = false,
  nowrapCells = false,
  pinFirstColumn = false,
  columnPins,
  onColumnPinChange,
  columnFilterRow = false,
  hScrollProxy = false,
  selectedIds,
  onSelectionChange,
  rowClassName,
  rowGroups,
  collapsedGroups,
  onToggleGroup
}: DataTableProps<T>) {
  const totalPages = Math.ceil(total / limit)
  const start = (page - 1) * limit + 1
  const end = Math.min(page * limit, total)

  const showFilterRow = !hideFilterRow && filterDefs && filterDefs.length > 0
  const hasToolbar = searchValue !== undefined || showFilterRow || toolbarRight !== undefined

  const handleHeaderClick = (col: Column<T>) => {
    if (!col.sortable || !onSortChange) return
    onSortChange(nextSort(sort, col.key))
  }

  // ── Per-column pinning ──────────────────────────────────────────────────────
  // `columnPins` (even {}) supersedes pinFirstColumn: left pins render first,
  // right pins last, offsets from live header-cell measurement (guarded — only
  // sets state when values actually change, so the every-render effect is safe).
  const pinsActive = columnPins !== undefined
  const orderedColumns = useMemo(() => {
    if (!pinsActive || !columnPins) return columns
    const left = columns.filter((c) => columnPins[c.key] === 'left')
    const right = columns.filter((c) => columnPins[c.key] === 'right')
    const mid = columns.filter((c) => !columnPins[c.key])
    return [...left, ...mid, ...right]
  }, [columns, columnPins, pinsActive])

  const headCellRefs = useRef<Record<string, HTMLTableCellElement | null>>({})
  const hScrollRef = useRef<HTMLDivElement | null>(null)
  const checkboxHeadRef = useRef<HTMLTableCellElement | null>(null)
  const [pinPos, setPinPos] = useState<
    Record<string, { side: 'left' | 'right'; offset: number; seam: boolean }>
  >({})
  // biome-ignore lint/correctness/useExhaustiveDependencies: measures live DOM every render, guarded by value compare
  useLayoutEffect(() => {
    if (!pinsActive || !columnPins) return
    const left = orderedColumns.filter((c) => columnPins[c.key] === 'left')
    const right = orderedColumns.filter((c) => columnPins[c.key] === 'right')
    const widthOf = (key: string) =>
      headCellRefs.current[key]?.getBoundingClientRect().width ?? 120
    const next: Record<string, { side: 'left' | 'right'; offset: number; seam: boolean }> = {}
    let acc = onSelectionChange
      ? (checkboxHeadRef.current?.getBoundingClientRect().width ?? 40)
      : 0
    // Floor so adjacent pinned cells overlap by a sub-pixel instead of meeting
    // exactly on a fractional boundary — an exact meeting leaves a hairline for
    // the scrolling content to show through (see CollectionBrowserView).
    left.forEach((c, i) => {
      next[c.key] = { side: 'left', offset: Math.floor(acc), seam: i === left.length - 1 }
      acc += widthOf(c.key)
    })
    let racc = 0
    for (let i = right.length - 1; i >= 0; i--) {
      const c = right[i]
      next[c.key] = { side: 'right', offset: Math.floor(racc), seam: i === 0 }
      racc += widthOf(c.key)
    }
    setPinPos((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  })

  const pinStyle = (key: string): React.CSSProperties | undefined => {
    const p = pinPos[key]
    if (!pinsActive || !p) return undefined
    return p.side === 'left' ? { left: p.offset } : { right: p.offset }
  }
  const pinCls = (key: string, header: boolean): string | undefined => {
    const p = pinPos[key]
    if (!pinsActive || !p) return undefined
    return cn(
      header ? 'sticky z-[2]' : 'sticky z-[1] bg-inherit',
      p.side === 'left' && p.seam && 'border-r border-slate-200 dark:border-border',
      p.side === 'right' && p.seam && 'border-l border-slate-200 dark:border-border'
    )
  }
  const cyclePin = (key: string) => {
    if (!onColumnPinChange) return
    const cur = columnPins?.[key] ?? null
    onColumnPinChange(key, cur === null ? 'left' : cur === 'left' ? 'right' : null)
  }
  const filterDefByKey = useMemo(() => {
    const m = new Map<string, FilterDef>()
    for (const d of filterDefs ?? []) m.set(d.key, d)
    return m
  }, [filterDefs])
  const showColumnFilterRow = columnFilterRow && (filterDefs?.length ?? 0) > 0

  const renderRow = (row: T, i: number) => {
    const rowId = rowKey ? rowKey(row, i) : String(i)
    const isSelected = selectedIds?.includes(rowId) ?? false
    // Pinned cells use bg-inherit, so the row carries an opaque base bg (and a
    // solid hover) for the pinned column to cover horizontally scrolled content.
    return (
      <TableRow
        key={rowId}
        className={cn(
          'border-slate-100',
          (pinFirstColumn || pinsActive) && 'bg-white dark:bg-card',
          onRowClick &&
            (pinFirstColumn || pinsActive
              ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-muted'
              : 'cursor-pointer hover:bg-slate-50/80'),
          rowClassName?.(row),
          // Pinned sticky cells use bg-inherit, so a selected row's bg must be
          // OPAQUE or horizontally-scrolled content bleeds through the pinned
          // column. bg-nvr-cyan/5 is semi-transparent — use an opaque equivalent
          // (5% nvr-cyan #00ceff over white / card) when pinning.
          isSelected &&
            (pinFirstColumn || pinsActive ? 'bg-[#f2fdff] dark:bg-[#20303a]' : 'bg-nvr-cyan/5')
        )}
        onClick={() => onRowClick?.(row)}
      >
        {onSelectionChange && (
          <TableCell
            className={cn(
              'w-9 px-3 py-2',
              (pinFirstColumn || pinsActive) && 'sticky left-0 z-[1] min-w-[40px] bg-inherit'
            )}
            onClick={(e) => {
              e.stopPropagation()
              if (isSelected) {
                onSelectionChange(selectedIds?.filter((id) => id !== rowId) ?? [])
              } else {
                onSelectionChange([...(selectedIds ?? []), rowId])
              }
            }}
          >
            <Checkbox checked={isSelected} aria-label='Select row' />
          </TableCell>
        )}
        {orderedColumns.map((col, colIdx) => (
          <TableCell
            key={col.key}
            style={pinStyle(col.key)}
            className={cn(
              'px-3 py-2',
              nowrapCells && 'whitespace-nowrap',
              !pinsActive &&
                pinFirstColumn &&
                colIdx === 0 &&
                cn(
                  'sticky z-[1] border-r border-slate-100 bg-inherit dark:border-border',
                  onSelectionChange ? 'left-[39px]' : 'left-0'
                ),
              pinCls(col.key, false),
              col.className
            )}
          >
            {col.render
              ? col.render(row, i)
              : String((row as Record<string, unknown>)[col.key] ?? '—')}
          </TableCell>
        ))}
      </TableRow>
    )
  }

  return (
    <>
      {/* Error banner */}
      {isError && errorMessage && (
        <div className='mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700'>
          {errorMessage}
        </div>
      )}

      {/* Card */}
      <div
        className={cn(
          'overflow-hidden rounded-lg border border-slate-200 bg-white',
          fillHeight && 'flex h-full min-h-0 flex-col'
        )}
      >
        {/* Toolbar */}
        {hasToolbar && (
          <div className='flex items-center gap-2 border-b border-slate-100 px-3 py-2.5'>
            {onSearchChange !== undefined && (
              <div className='relative'>
                <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
                <Input
                  className='h-8 w-56 border-slate-200 bg-slate-50 pl-8 text-[13px]'
                  placeholder={searchPlaceholder}
                  value={searchValue ?? ''}
                  onChange={(e) => onSearchChange(e.target.value)}
                />
              </div>
            )}

            {showFilterRow &&
              filterDefs?.map((def) => (
                <FilterControl
                  key={def.key}
                  def={def}
                  value={filterValues[def.key] ?? ''}
                  onChange={(v) => onFilterChange?.(def.key, v)}
                />
              ))}

            <div className='flex-1' />

            {toolbarRight}
          </div>
        )}

        {/* Table */}
        {isLoading ? (
          <div className='divide-y divide-slate-100'>
            {SKELETON_ROWS.map((n) => (
              <div key={n} className='flex items-center gap-3 px-4 py-2.5'>
                {columns.map((col) => (
                  <Skeleton
                    key={col.key}
                    className={cn('h-4 rounded', col.className ? undefined : 'flex-1')}
                  />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* With the proxy active this wrapper is the horizontal scroll
                container (overflow-x hidden = single-bar guarantee; the ui
                Table's internal overflow-auto wrapper is neutralized). */}
            <div
              ref={hScrollRef}
              className={cn(
                hScrollProxy && 'overflow-x-hidden [&>div]:overflow-visible',
                // Bounded mode: rows scroll here under a sticky header. Header
                // cells sit above pinned body cells (z-[1/2]); the pinned
                // header corner (left-0) tops the other header cells so
                // horizontal scroll cannot bleed through it.
                fillHeight &&
                  'min-h-0 flex-1 overflow-y-auto [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[5] [&_thead_th.left-0]:z-[6]'
              )}
              style={minBodyHeight ? { minHeight: minBodyHeight } : undefined}
            >
              <Table>
              <TableHeader>
                <TableRow className='border-b border-slate-200 hover:bg-transparent'>
                  {onSelectionChange && (
                    <TableHead
                      ref={checkboxHeadRef}
                      className={cn(
                        'h-9 w-9 bg-slate-50 px-3 py-0',
                        (pinFirstColumn || pinsActive) && 'sticky left-0 z-[2] min-w-[40px]'
                      )}
                    >
                      <Checkbox
                        checked={
                          rows.length > 0 &&
                          rows.every((row, i) => {
                            const id = rowKey ? rowKey(row, i) : String(i)
                            return selectedIds?.includes(id)
                          })
                        }
                        onCheckedChange={(checked) => {
                          if (checked) {
                            onSelectionChange(
                              rows.map((row, i) => (rowKey ? rowKey(row, i) : String(i)))
                            )
                          } else {
                            onSelectionChange([])
                          }
                        }}
                        aria-label='Select all'
                      />
                    </TableHead>
                  )}
                  {orderedColumns.map((col, colIdx) => (
                    <TableHead
                      key={col.key}
                      ref={(el) => {
                        headCellRefs.current[col.key] = el
                      }}
                      style={pinStyle(col.key)}
                      className={cn(
                        'group/th h-9 whitespace-nowrap bg-slate-50 px-3 py-0 text-[11px] font-medium text-slate-500',
                        col.sortable &&
                          onSortChange &&
                          'cursor-pointer select-none hover:text-slate-600',
                        !pinsActive &&
                          pinFirstColumn &&
                          colIdx === 0 &&
                          cn(
                            'sticky z-[2] border-r border-slate-200 dark:border-border',
                            onSelectionChange ? 'left-[39px]' : 'left-0'
                          ),
                        pinsActive && 'bg-slate-50 dark:bg-muted',
                        pinCls(col.key, true),
                        col.headerClassName
                      )}
                      onClick={() => handleHeaderClick(col)}
                    >
                      <span className='inline-flex items-center'>
                        {col.header}
                        {col.sortable && onSortChange && <SortIcon field={col.key} sort={sort} />}
                        {pinsActive && onColumnPinChange && col.key !== 'claim' && (
                          <button
                            type='button'
                            onClick={(e) => {
                              e.stopPropagation()
                              cyclePin(col.key)
                            }}
                            aria-label={`Pin column ${col.key}`}
                            title={
                              columnPins?.[col.key] === 'left'
                                ? 'Pinned left — click to pin right'
                                : columnPins?.[col.key] === 'right'
                                  ? 'Pinned right — click to unpin'
                                  : 'Pin column'
                            }
                            className={cn(
                              'ml-1 rounded p-0.5 transition-opacity',
                              columnPins?.[col.key]
                                ? 'text-nvr-cyan opacity-100'
                                : 'text-slate-300 opacity-0 hover:text-slate-500 group-hover/th:opacity-100'
                            )}
                          >
                            <Pin
                              className={cn(
                                'h-3 w-3',
                                columnPins?.[col.key] === 'right' && 'rotate-90'
                              )}
                            />
                          </button>
                        )}
                      </span>
                    </TableHead>
                  ))}
                </TableRow>
                {showColumnFilterRow && (
                  <TableRow className='border-b border-slate-200 hover:bg-transparent'>
                    {onSelectionChange && (
                      <TableHead
                        className={cn(
                          'h-9 w-9 bg-slate-50 px-3 py-1',
                          (pinFirstColumn || pinsActive) && 'sticky left-0 z-[2] min-w-[40px]'
                        )}
                      />
                    )}
                    {orderedColumns.map((col) => {
                      const def = filterDefByKey.get(col.key)
                      return (
                        <TableHead
                          key={col.key}
                          style={pinStyle(col.key)}
                          className={cn(
                            'h-9 bg-slate-50 px-1.5 py-1 align-middle',
                            pinsActive && 'bg-slate-50 dark:bg-muted',
                            pinCls(col.key, true)
                          )}
                        >
                          {def && onFilterChange ? (
                            <FilterControl
                              def={def}
                              value={filterValues[def.key] ?? ''}
                              onChange={(v) => onFilterChange(def.key, v)}
                              layout='cell'
                            />
                          ) : null}
                        </TableHead>
                      )
                    })}
                  </TableRow>
                )}
              </TableHeader>
              {/* Tabular figures: DM Sans is proportional by default, which
                  leaves numeric columns visibly ragged. Letters are unaffected. */}
              <TableBody className='tabular-nums'>
                {rowGroups
                  ? rowGroups.map((group) => {
                      const collapsed = collapsedGroups?.has(group.key) ?? false
                      return (
                        <React.Fragment key={group.key}>
                          <TableRow
                            className='cursor-pointer border-slate-200 bg-slate-50/80 hover:bg-slate-100/80 dark:bg-muted/40'
                            onClick={() => onToggleGroup?.(group.key)}
                          >
                            <TableCell
                              colSpan={columns.length + (onSelectionChange ? 1 : 0)}
                              className='px-3 py-1.5'
                            >
                              <span className='flex items-center gap-1.5 text-[12px] font-medium text-slate-600 dark:text-foreground'>
                                {collapsed ? (
                                  <ChevronRight className='h-3.5 w-3.5 text-slate-400' />
                                ) : (
                                  <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
                                )}
                                {group.header}
                              </span>
                            </TableCell>
                          </TableRow>
                          {!collapsed && group.rows.map((row, i) => renderRow(row, i))}
                        </React.Fragment>
                      )
                    })
                  : rows.map((row, i) => renderRow(row, i))}

                {(rowGroups ? rowGroups.length === 0 : rows.length === 0) && (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length + (onSelectionChange ? 1 : 0)}
                      className='py-12 text-center align-middle text-[13px] text-slate-400'
                      style={minBodyHeight ? { height: Math.max(96, minBodyHeight - 56) } : undefined}
                    >
                      {emptyMessage}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              </Table>
            </div>
            {hScrollProxy && <HScrollProxy scrollerRef={hScrollRef} />}

            {/* Pagination */}
            {!rowGroups && total > limit && (
              <div className='flex items-center justify-between border-t border-slate-100 px-4 py-2.5'>
                <p className='text-[12px] text-slate-400'>
                  {formatNumber(start)}–{formatNumber(end)} of {formatNumber(total)} records
                </p>
                <div className='flex items-center gap-1'>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-7 px-2.5 text-[12px] text-slate-600'
                    disabled={page <= 1}
                    onClick={() => onPageChange(page - 1)}
                  >
                    ← Prev
                  </Button>
                  <span className='px-2 text-[12px] text-slate-400'>
                    {page} / {totalPages}
                  </span>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-7 px-2.5 text-[12px] text-slate-600'
                    disabled={page >= totalPages}
                    onClick={() => onPageChange(page + 1)}
                  >
                    Next →
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
