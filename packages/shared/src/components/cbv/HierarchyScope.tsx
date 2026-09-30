import { useQuery } from '@tanstack/react-query'
import { ChevronDown, X } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * #743 — hierarchy parent scope (moved out of the admin classic browser).
 * When the collection is a non-root level of a multi-collection hierarchy
 * (Hierarchies page), the browser offers "Scope by <parent>": pick a parent
 * record and the list narrows to its children — through the level's parent
 * FK, or through its junction when the level links many-to-many.
 */

interface HierarchyLevel {
  collection: string
  label_field: string
  parent_fk: string | null
  junction_table?: string
  junction_child_fk?: string
  junction_parent_fk?: string
}

const isM2M = (l: HierarchyLevel) =>
  !!(l.junction_table && l.junction_child_fk && l.junction_parent_fk)

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export interface HierarchyScopeState {
  /** The parent level, when this collection sits under one. */
  parent: { collection: string; labelField: string } | null
  /** Condition to AND into the list query; null until a parent is picked (or
   *  while a many-to-many child list is loading). */
  condition: { path: string[]; op: string; value: unknown } | null
  /** True while a picked parent's children are still resolving. */
  pending: boolean
}

export function useHierarchyScope(
  collection: string,
  parentId: string | number | null
): HierarchyScopeState {
  const client = useNivaroClient()
  const { data: configs } = useQuery({
    queryKey: ['hierarchy-configs'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number; levels: HierarchyLevel[] }> }>(
          get('/hierarchy-configs')
        )
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 5 * 60_000,
    retry: false
  })
  let scope: { hierarchyId: number; level: HierarchyLevel; parentLevel: HierarchyLevel } | null =
    null
  for (const hc of configs ?? []) {
    const idx = hc.levels.findIndex((l) => l.collection === collection)
    if (idx > 0) {
      scope = { hierarchyId: hc.id, level: hc.levels[idx], parentLevel: hc.levels[idx - 1] }
      break
    }
  }
  const m2m = !!scope && isM2M(scope.level)
  const { data: childIds, isFetching } = useQuery({
    queryKey: ['hierarchy-scope-children', scope?.hierarchyId, collection, parentId],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: string | number }> }>(
          get(
            `/hierarchy/${scope?.hierarchyId}/node/${scope?.parentLevel.collection}/${parentId}/children`
          )
        )
        .then((r) => (r.data ?? []).map((n) => n.id)),
    enabled: !!scope && m2m && parentId != null
  })
  if (!scope) return { parent: null, condition: null, pending: false }
  const parent = {
    collection: scope.parentLevel.collection,
    labelField: scope.parentLevel.label_field
  }
  if (parentId == null) return { parent, condition: null, pending: false }
  if (m2m) {
    if (!childIds) return { parent, condition: null, pending: isFetching }
    // No children → match nothing rather than dropping the scope.
    return {
      parent,
      condition: { path: ['id'], op: '_in', value: childIds.length ? childIds : ['__none__'] },
      pending: false
    }
  }
  if (!scope.level.parent_fk) return { parent, condition: null, pending: false }
  return {
    parent,
    condition: { path: [scope.level.parent_fk], op: '_eq', value: parentId },
    pending: false
  }
}

export function HierarchyScopePicker({
  parent,
  value,
  onChange
}: {
  parent: { collection: string; labelField: string }
  value: string | number | null
  onChange: (id: string | number | null) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const fields = `id,${parent.labelField}`
  const { data: options = [] } = useQuery({
    queryKey: ['hierarchy-scope-parents', parent.collection, q],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${parent.collection}`, { limit: 50, fields, search: q || undefined })
        )
        .then((r) => r.data ?? []),
    enabled: open,
    staleTime: 30_000
  })
  const { data: current } = useQuery({
    queryKey: ['hierarchy-scope-current', parent.collection, value],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(
          get(`/items/${parent.collection}/${value}`, { fields })
        )
        .then((r) => r.data),
    enabled: value != null,
    staleTime: 60_000
  })
  const label = (row: Record<string, unknown> | undefined) =>
    row ? String(row[parent.labelField] ?? row.id) : ''
  const noun = titleCase(parent.collection)
  return (
    <div className='flex items-center gap-1.5 text-[12px]' data-cbv-hierarchy-scope>
      <span className='text-slate-500 dark:text-slate-400'>Scope by {noun}:</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            data-cbv-hierarchy-scope-trigger
            className='flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
          >
            {value != null ? label(current) || `#${value}` : `All ${noun}`}
            <ChevronDown className='h-3 w-3 text-slate-400' />
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-64 p-1'>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Find a ${noun.toLowerCase()}…`}
            aria-label={`Find a ${noun.toLowerCase()}`}
            className='mb-1 h-7 w-full rounded border border-slate-200 bg-white px-2 text-[12px] dark:border-slate-700 dark:bg-slate-900'
          />
          <div className='max-h-60 overflow-y-auto'>
            {options.map((row) => (
              <button
                key={String(row.id)}
                type='button'
                data-cbv-hierarchy-option={String(row.id)}
                onClick={() => {
                  onChange(row.id as string | number)
                  setOpen(false)
                }}
                className='block w-full truncate rounded px-2 py-1 text-left text-[12.5px] hover:bg-muted'
              >
                {label(row)}
              </button>
            ))}
            {options.length === 0 && (
              <p className='px-2 py-2 text-[12px] text-slate-400'>No matches.</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {value != null && (
        <button
          type='button'
          aria-label='Clear scope'
          onClick={() => onChange(null)}
          className='text-slate-400 hover:text-slate-600'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      )}
    </div>
  )
}
