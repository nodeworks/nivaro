import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Search,
  X
} from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { cn, formatNumber } from '@/lib/utils'

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
  layout?: 'inline' | 'stacked'
}) {
  const stacked = layout === 'stacked'
  const currentVal = typeof value === 'string' ? value : ''
  const widthCls = stacked ? 'w-full' : 'w-40'

  let control: React.ReactNode
  if (def.type === 'text') {
    control = (
      <Input
        className={cn('h-8 border-slate-200 bg-slate-50 text-[13px]', widthCls)}
        placeholder={def.placeholder}
        value={currentVal}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  } else if (def.type === 'combobox') {
    control = (
      <div className={cn(stacked && '[&>button]:w-full')}>
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
            'h-8 border-slate-200 bg-slate-50 text-[13px]',
            stacked ? 'w-full' : 'w-20'
          )}
          placeholder='Min'
          value={minVal ?? ''}
          onChange={(e) => onChange(`${e.target.value}:${maxVal ?? ''}`)}
        />
        <span className='text-[12px] text-slate-400'>–</span>
        <Input
          type='number'
          className={cn(
            'h-8 border-slate-200 bg-slate-50 text-[13px]',
            stacked ? 'w-full' : 'w-20'
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
        <SelectTrigger className={cn('h-8 border-slate-200 bg-slate-50 text-[13px]', widthCls)}>
          <SelectValue placeholder={def.placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='__all__'>{def.placeholder}</SelectItem>
          {(def.options ?? []).map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  if (!stacked) return <>{control}</>
  return (
    <div className='space-y-1'>
      <span className='block text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
        {filterDefLabel(def)}
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
  hideFilterRow = false,
  nowrapCells = false,
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

  const renderRow = (row: T, i: number) => {
    const rowId = rowKey ? rowKey(row, i) : String(i)
    const isSelected = selectedIds?.includes(rowId) ?? false
    return (
      <TableRow
        key={rowId}
        className={cn(
          'border-slate-100',
          onRowClick && 'cursor-pointer hover:bg-slate-50/80',
          rowClassName?.(row),
          isSelected && 'bg-nvr-cyan/5'
        )}
        onClick={() => onRowClick?.(row)}
      >
        {onSelectionChange && (
          <TableCell
            className='w-9 px-3 py-2'
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
        {columns.map((col) => (
          <TableCell
            key={col.key}
            className={cn('px-3 py-2', nowrapCells && 'whitespace-nowrap', col.className)}
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
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
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
            <Table>
              <TableHeader>
                <TableRow className='border-b border-slate-200 hover:bg-transparent'>
                  {onSelectionChange && (
                    <TableHead className='h-9 w-9 bg-slate-50 px-3 py-0'>
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
                  {columns.map((col) => (
                    <TableHead
                      key={col.key}
                      className={cn(
                        'h-9 whitespace-nowrap bg-slate-50 px-3 py-0 text-[11px] font-medium text-slate-500',
                        col.sortable &&
                          onSortChange &&
                          'cursor-pointer select-none hover:text-slate-600',
                        col.headerClassName
                      )}
                      onClick={() => handleHeaderClick(col)}
                    >
                      {col.header}
                      {col.sortable && onSortChange && <SortIcon field={col.key} sort={sort} />}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
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
                      className='py-12 text-center text-[13px] text-slate-400'
                    >
                      {emptyMessage}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

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
