import { ChevronDown, ChevronsUpDown, ChevronUp, Search } from 'lucide-react'
import type React from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
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
  options: { label: string; value: string }[]
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
  filterValues?: Record<string, string>
  onFilterChange?: (key: string, value: string) => void
  toolbarRight?: React.ReactNode
  emptyMessage?: string
  selectedIds?: string[]
  onSelectionChange?: (ids: string[]) => void
  /** Optional per-row class — e.g. at-risk background tinting. */
  rowClassName?: (row: T) => string | undefined
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
  selectedIds,
  onSelectionChange,
  rowClassName
}: DataTableProps<T>) {
  const totalPages = Math.ceil(total / limit)
  const start = (page - 1) * limit + 1
  const end = Math.min(page * limit, total)

  const hasToolbar =
    searchValue !== undefined || (filterDefs && filterDefs.length > 0) || toolbarRight !== undefined

  const handleHeaderClick = (col: Column<T>) => {
    if (!col.sortable || !onSortChange) return
    onSortChange(nextSort(sort, col.key))
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

            {filterDefs?.map((def) => {
              const currentVal = filterValues[def.key] ?? ''
              // Radix crashes on empty string value — use __all__ as sentinel
              const selectVal = currentVal === '' ? '__all__' : currentVal

              return (
                <Select
                  key={def.key}
                  value={selectVal}
                  onValueChange={(v) => {
                    onFilterChange?.(def.key, v === '__all__' ? '' : v)
                  }}
                >
                  <SelectTrigger className='h-8 w-40 border-slate-200 bg-slate-50 text-[13px]'>
                    <SelectValue placeholder={def.placeholder} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='__all__'>{def.placeholder}</SelectItem>
                    {def.options.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            })}

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
                        'h-9 bg-slate-50 px-3 py-0 text-[11px] font-medium text-slate-500',
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
                {rows.map((row, i) => {
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
                              onSelectionChange(selectedIds?.filter((id) => id !== rowId))
                            } else {
                              onSelectionChange([...(selectedIds ?? []), rowId])
                            }
                          }}
                        >
                          <Checkbox checked={isSelected} aria-label='Select row' />
                        </TableCell>
                      )}
                      {columns.map((col) => (
                        <TableCell key={col.key} className={cn('px-3 py-2', col.className)}>
                          {col.render
                            ? col.render(row, i)
                            : String((row as Record<string, unknown>)[col.key] ?? '—')}
                        </TableCell>
                      ))}
                    </TableRow>
                  )
                })}

                {rows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length}
                      className='py-12 text-center text-[13px] text-slate-400'
                    >
                      {emptyMessage}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            {/* Pagination */}
            {total > limit && (
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
