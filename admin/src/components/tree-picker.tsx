import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Search, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface FlatNode {
  id: string | number
  depth: number
  label: string
  parent_id?: string | number | null
  [key: string]: unknown
}

export interface TreePickerProps {
  collection: string
  value: string | number | null
  onChange: (id: string | number | null) => void
  placeholder?: string
  excludeId?: string | number | null
  disabled?: boolean
  className?: string
}

/** Returns the set of node ids that are `excludeId` or any of its descendants. */
function buildExcludedSet(
  nodes: FlatNode[],
  excludeId: string | number | null | undefined
): Set<string> {
  if (excludeId == null) return new Set()

  const excluded = new Set<string>()
  excluded.add(String(excludeId))

  // One pass is enough if nodes are ordered parent-before-child (depth-first),
  // but we do a second pass to catch any ordering edge-cases.
  let changed = true
  while (changed) {
    changed = false
    for (const n of nodes) {
      const key = String(n.id)
      if (!excluded.has(key) && n.parent_id != null && excluded.has(String(n.parent_id))) {
        excluded.add(key)
        changed = true
      }
    }
  }
  return excluded
}

export function TreePicker({
  collection,
  value,
  onChange,
  placeholder = 'Select…',
  excludeId,
  disabled = false,
  className
}: TreePickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  // All flat nodes — fetched once the popover opens
  const { data: allNodes = [], isLoading: nodesLoading } = useQuery<FlatNode[]>({
    queryKey: ['tree-nodes', collection],
    queryFn: () => api.get(`/tree/${collection}/nodes`).then((r) => r.data.data as FlatNode[]),
    enabled: open,
    staleTime: 60 * 1000
  })

  // Ancestor path for the current value — used to build the display label
  const { data: ancestors = [] } = useQuery<FlatNode[]>({
    queryKey: ['tree-ancestors', collection, value],
    queryFn: () =>
      api.get(`/tree/${collection}/${value}/ancestors`).then((r) => r.data.data as FlatNode[]),
    enabled: value != null,
    staleTime: 60 * 1000
  })

  // Build display label from ancestors
  const displayLabel =
    value != null && ancestors.length > 0 ? ancestors.map((a) => a.label).join(' › ') : null

  // Client-side filtering
  const excluded = buildExcludedSet(allNodes, excludeId)

  const filtered = allNodes.filter((n) => {
    if (excluded.has(String(n.id))) return false
    if (search.trim()) {
      return n.label.toLowerCase().includes(search.trim().toLowerCase())
    }
    return true
  })

  function handleSelect(node: FlatNode) {
    onChange(node.id)
    setOpen(false)
    setSearch('')
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation()
    onChange(null)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          className={cn(
            'w-full h-9 px-3 text-[13px] border border-slate-200 dark:border-border rounded-md',
            'bg-white dark:bg-background text-left flex items-center justify-between gap-2',
            'hover:bg-slate-50 dark:hover:bg-accent/50 cursor-pointer',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className
          )}
        >
          {displayLabel != null ? (
            <span className='flex-1 truncate text-slate-800 dark:text-foreground'>
              {displayLabel}
            </span>
          ) : (
            <span className='flex-1 truncate text-slate-400 dark:text-muted-foreground'>
              {placeholder}
            </span>
          )}
          <span className='flex items-center gap-1 shrink-0'>
            {value != null && (
              <button
                type='button'
                aria-label='Clear selection'
                onClick={handleClear}
                className='p-0.5 rounded text-slate-300 hover:text-slate-500 dark:text-muted-foreground dark:hover:text-foreground'
              >
                <X className='h-3 w-3' />
              </button>
            )}
            <ChevronDown className='h-3.5 w-3.5 text-slate-400 dark:text-muted-foreground' />
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent className='w-[320px] p-0' align='start'>
        {/* Search */}
        <div className='flex items-center gap-2 px-2 pt-2 pb-1 border-b border-slate-100 dark:border-border'>
          <Search className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground' />
          <Input
            autoFocus
            placeholder='Search…'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className='h-7 text-[13px] border-0 shadow-none focus-visible:ring-0 p-0 bg-transparent'
          />
          {search && (
            <button
              type='button'
              onClick={() => setSearch('')}
              className='shrink-0 text-slate-300 hover:text-slate-500 dark:text-muted-foreground dark:hover:text-foreground'
            >
              <X className='h-3 w-3' />
            </button>
          )}
        </div>

        {/* Node list */}
        <div className='max-h-64 overflow-y-auto'>
          {nodesLoading && (
            <div className='px-3 py-4 text-[13px] text-slate-400 dark:text-muted-foreground text-center'>
              Loading tree…
            </div>
          )}

          {!nodesLoading && filtered.length === 0 && (
            <div className='px-3 py-4 text-[13px] text-slate-400 dark:text-muted-foreground text-center'>
              {search ? 'No matches' : 'No items'}
            </div>
          )}

          {!nodesLoading &&
            filtered.map((node) => {
              const isSelected = value != null && String(node.id) === String(value)
              const indent = node.depth * 16
              return (
                <button
                  key={String(node.id)}
                  type='button'
                  onClick={() => handleSelect(node)}
                  className={cn(
                    'w-full text-left flex items-center h-8 gap-1.5 text-[13px] pr-3',
                    'hover:bg-slate-50 dark:hover:bg-accent/50',
                    isSelected
                      ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/15 text-nvr-navy dark:text-nvr-cyan font-medium'
                      : 'text-slate-700 dark:text-foreground'
                  )}
                  style={{ paddingLeft: `${indent + 12}px` }}
                >
                  <span className='truncate'>{node.label}</span>
                </button>
              )
            })}
        </div>

        {/* Clear footer */}
        {value != null && (
          <div className='border-t border-slate-100 dark:border-border p-1.5'>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className='w-full h-7 text-[12px] text-slate-400 hover:text-slate-600 dark:text-muted-foreground dark:hover:text-foreground'
            >
              Clear selection
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
