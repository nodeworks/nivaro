import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Loader2, Plus, Search, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  type CMSRelation,
  type PipelineBinding,
  type PipelineOwnerDimension,
  type PipelineOwnerGroup,
  type PipelineOwnerGroupsMap,
  type PipelineState,
  type RecordFilter,
  type User
} from '@/lib/api'
import { findM2ORelation, findO2MRelation, renderDisplayTemplate } from '@/lib/relations'

// ─── Filter combobox ──────────────────────────────────────────────────────────

function sortOptions(options: { value: string; label: string }[]) {
  return [...options].sort((a, b) => {
    const na = Number(a.label)
    const nb = Number(b.label)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  })
}

function FilterCombobox({
  label,
  value,
  options,
  onChange,
  onSearch,
  loading
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  onSearch: (q: string) => void
  loading?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sorted = useMemo(() => sortOptions(options), [options])

  const onSearchRef = useRef(onSearch)
  onSearchRef.current = onSearch

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else {
      setQuery('')
      onSearchRef.current('')
    }
  }, [open])

  const handleQueryChange = (v: string) => {
    setQuery(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => onSearch(v.trim()), 300)
  }

  const selectedLabel = value ? (options.find((o) => o.value === value)?.label ?? value) : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={`flex h-7 items-center gap-1 rounded-md border pl-2.5 text-[12px] transition-colors ${
            value
              ? 'border-nvr-cyan/50 bg-nvr-cyan/5 font-medium text-nvr-cyan pr-1'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 pr-2.5'
          }`}
        >
          <span>{selectedLabel ?? `All ${label}`}</span>
          {value ? (
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation()
                onChange('')
                onSearch('')
              }}
              className='flex h-5 w-5 items-center justify-center rounded hover:bg-nvr-cyan/20'
            >
              <X className='h-3 w-3' />
            </button>
          ) : loading ? (
            <Loader2 className='h-3 w-3 animate-spin opacity-50' />
          ) : (
            <ChevronDown className='h-3 w-3 opacity-50' />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-56 p-0' sideOffset={4}>
        <div className='border-b border-slate-100 px-2 py-1.5'>
          <div className='relative'>
            <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className='h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40'
            />
          </div>
        </div>
        <div className='max-h-56 overflow-y-auto py-1'>
          <button
            type='button'
            onClick={() => {
              onChange('')
              setOpen(false)
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-slate-50 ${!value ? 'font-medium text-slate-800' : 'text-slate-500'}`}
          >
            <Check className={`h-3.5 w-3.5 shrink-0 ${!value ? 'text-nvr-cyan' : 'opacity-0'}`} />
            All
          </button>
          {sorted.map((o) => (
            <button
              key={o.value}
              type='button'
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-slate-50 ${value === o.value ? 'font-medium text-slate-800' : 'text-slate-600'}`}
            >
              <Check
                className={`h-3.5 w-3.5 shrink-0 ${value === o.value ? 'text-nvr-cyan' : 'opacity-0'}`}
              />
              {o.label}
            </button>
          ))}
          {sorted.length === 0 && (
            <div className='px-3 py-2 text-[12px] text-slate-400'>No results</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── id_value resolution ─────────────────────────────────────────────────────

function getIdValue(
  dim: PipelineOwnerDimension,
  displayValue: string,
  rowItems: Record<string, unknown>[] | undefined,
  colFilterItems: Record<string, unknown>[] | undefined
): number | null {
  const parts = dim.field.split('.')
  const subField = parts.length > 1 ? parts[parts.length - 1] : null
  if (!subField) return null
  const candidates = [...(rowItems ?? []), ...(colFilterItems ?? [])]
  const match = candidates.find((item) => String(item[subField] ?? '') === displayValue)
  if (!match) return null
  const id = match.id
  return typeof id === 'number' ? id : typeof id === 'string' ? Number(id) || null : null
}

interface OwnerMatrixProps {
  templateId: string
  states: PipelineState[]
  bindings: PipelineBinding[]
}

type MatrixRow = { value: string; label: string }

function initials(u: {
  first_name: string | null
  last_name: string | null
  email: string
}): string {
  const parts = [u.first_name, u.last_name].filter(Boolean) as string[]
  if (parts.length)
    return parts
      .map((p) => p[0])
      .join('')
      .toUpperCase()
  return u.email[0].toUpperCase()
}

export function OwnerMatrix({ templateId, states, bindings }: OwnerMatrixProps) {
  const allDimensions = bindings.flatMap((b) => b.dimensions ?? [])
  const rowDim = allDimensions.find((d) => d.is_row_axis) ?? null
  const colFilterDims = allDimensions.filter((d) => !d.is_row_axis)

  const { data: groupsMap, isLoading } = useQuery<PipelineOwnerGroupsMap>({
    queryKey: ['pipeline-all-owner-groups', templateId],
    queryFn: () =>
      api
        .get<{ data: PipelineOwnerGroupsMap }>(`/pipelines/${templateId}/owner-groups`)
        .then((r) => r.data.data)
  })

  const firstCollection = bindings[0]?.collection ?? ''
  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', firstCollection],
    queryFn: () => api.get(`/collections/${firstCollection}`).then((r) => r.data.data),
    enabled: !!firstCollection && (!!rowDim || colFilterDims.length > 0)
  })
  const colRelations: CMSRelation[] = colMeta?.relations ?? []

  // Support dotted paths from FieldPicker (e.g. "regions.short_name")
  const rowFieldParts = rowDim ? rowDim.field.split('.') : []
  const rowBaseField = rowFieldParts[0] ?? ''
  const rowSubField = rowFieldParts[1] ?? null

  // Resolve row relation using the base field only
  const rowRelM2O = rowDim
    ? (findM2ORelation(colRelations, firstCollection, rowBaseField) ?? null)
    : null
  const rowRelM2MJunction =
    !rowRelM2O && rowDim
      ? (colRelations.find(
          (r) =>
            r.many_collection === firstCollection &&
            r.many_field === rowBaseField &&
            r.junction_field !== null &&
            r.one_collection
        ) ?? null)
      : null
  const rowRelM2MParent =
    !rowRelM2O && !rowRelM2MJunction && rowDim
      ? (colRelations.find(
          (r) =>
            r.one_collection === firstCollection &&
            r.one_field === rowBaseField &&
            r.junction_field !== null
        ) ?? null)
      : null
  const rowRelM2MTargetRel = rowRelM2MParent
    ? (colRelations.find(
        (r) =>
          r.many_collection === rowRelM2MParent.many_collection &&
          r.many_field === rowRelM2MParent.junction_field &&
          r.one_collection
      ) ?? null)
    : null
  const rowRelO2M =
    !rowRelM2O && !rowRelM2MJunction && !rowRelM2MParent && rowDim
      ? (findO2MRelation(colRelations, firstCollection, rowBaseField) ?? null)
      : null

  const rowRelatedCollection =
    rowRelM2O?.one_collection ??
    rowRelM2MJunction?.one_collection ??
    rowRelM2MTargetRel?.one_collection ??
    rowRelM2MParent?.many_collection ??
    rowRelO2M?.many_collection ??
    null

  // Pre-parse dotted paths from FieldPicker (e.g. "project.project_type.name")
  const colFilterPaths = colFilterDims.map((dim) => {
    const parts = dim.field.split('.')
    return {
      baseField: parts[0],
      // segments between base and leaf for 3+ part paths
      midFields: parts.length > 2 ? parts.slice(1, -1) : [],
      // leaf = sub-field to display/filter by; null when path is a direct relation field
      leafField: parts.length > 1 ? parts[parts.length - 1] : null
    }
  })

  // Resolve the initial (base-field) related collection for each col-filter dim
  const colFilterBaseCollections = colFilterPaths.map(({ baseField }) => {
    const m2o = findM2ORelation(colRelations, firstCollection, baseField)
    if (m2o?.one_collection) return m2o.one_collection
    // M2M junction-side: this collection IS the junction
    const m2mJunction = colRelations.find(
      (r) =>
        r.many_collection === firstCollection &&
        r.many_field === baseField &&
        r.junction_field !== null &&
        r.one_collection
    )
    if (m2mJunction?.one_collection) return m2mJunction.one_collection
    // M2M parent-side: this collection is one_collection; traverse through junction
    const m2mParent = colRelations.find(
      (r) =>
        r.one_collection === firstCollection &&
        r.one_field === baseField &&
        r.junction_field !== null
    )
    if (m2mParent) {
      const targetRel = colRelations.find(
        (r) =>
          r.many_collection === m2mParent.many_collection &&
          r.many_field === m2mParent.junction_field &&
          r.one_collection
      )
      if (targetRel?.one_collection) return targetRel.one_collection
    }
    const o2m = findO2MRelation(colRelations, firstCollection, baseField)
    if (o2m?.many_collection) return o2m.many_collection
    return null
  })

  // For multi-level paths, fetch the intermediate collection meta so we can
  // traverse one more level (handles "X.Y.leaf" patterns).
  const colFilterIntermediateMetaQueries = useQueries({
    queries: colFilterPaths.map((path, i) => {
      const baseCol = colFilterBaseCollections[i]
      if (!baseCol || path.midFields.length === 0) {
        return {
          queryKey: ['noop-inter', i],
          queryFn: async (): Promise<null> => null,
          enabled: false as const
        }
      }
      return {
        queryKey: ['collection-meta', baseCol],
        queryFn: (): Promise<any> => api.get(`/collections/${baseCol}`).then((r) => r.data.data)
      }
    })
  })

  // Resolve terminal { relatedCollection, subField } for each col-filter dim
  const colFilterResolved = colFilterPaths.map((path, i) => {
    const baseCol = colFilterBaseCollections[i]
    if (!baseCol) return null
    if (path.midFields.length === 0) {
      return { relatedCollection: baseCol, subField: path.leafField }
    }
    // Multi-level: traverse midFields using the intermediate collection's relations
    const interMeta = colFilterIntermediateMetaQueries[i]?.data
    if (!interMeta) return null
    let currentCol = baseCol
    const interRels: CMSRelation[] = interMeta.relations ?? []
    for (const midField of path.midFields) {
      const rel =
        findM2ORelation(interRels, currentCol, midField) ??
        interRels.find(
          (r) => r.many_collection === currentCol && r.many_field === midField && r.one_collection
        ) ??
        null
      if (!rel) return null
      currentCol = (rel as CMSRelation).one_collection ?? currentCol
    }
    return { relatedCollection: currentCol, subField: path.leafField }
  })

  const [filterValues, setFilterValues] = useState<Record<number, string>>({})
  const [searchTerms, setSearchTerms] = useState<Record<number, string>>({})

  // Fetch items for each col-filter dim's terminal collection
  const colFilterItemQueries = useQueries({
    queries: colFilterDims.map((dim, i) => {
      const resolved = colFilterResolved[i]
      const term = searchTerms[dim.id] ?? ''
      if (resolved?.relatedCollection) {
        return {
          queryKey: ['items-picker', resolved.relatedCollection, term],
          queryFn: () =>
            api
              .get<{ data: Record<string, unknown>[] }>(`/items/${resolved.relatedCollection}`, {
                params: { limit: 100, ...(term ? { search: term } : {}) }
              })
              .then((r) => r.data.data)
        }
      }
      return {
        queryKey: ['noop-items', i],
        queryFn: async () => [] as Record<string, unknown>[],
        enabled: false as const
      }
    })
  })

  const colFilterRelMetaQueries = useQueries({
    queries: colFilterDims.map((dim, i) => {
      const resolved = colFilterResolved[i]
      if (!resolved?.relatedCollection || resolved.subField)
        return {
          queryKey: ['noop-meta', dim.id],
          queryFn: async (): Promise<null> => null,
          enabled: false as const
        }
      return {
        queryKey: ['collection-meta', resolved.relatedCollection],
        queryFn: (): Promise<any> =>
          api.get(`/collections/${resolved.relatedCollection}`).then((r) => r.data.data)
      }
    })
  })

  const { data: rowItems } = useQuery<Record<string, unknown>[]>({
    queryKey: ['items-picker', rowRelatedCollection],
    queryFn: () =>
      api
        .get<{ data: Record<string, unknown>[] }>(`/items/${rowRelatedCollection}`, {
          params: { limit: 100 }
        })
        .then((r) => r.data.data),
    enabled: !!rowRelatedCollection
  })

  const { data: rowRelMeta } = useQuery({
    queryKey: ['collection-meta', rowRelatedCollection],
    queryFn: () => api.get(`/collections/${rowRelatedCollection}`).then((r) => r.data.data),
    enabled: !!rowRelatedCollection && !rowSubField
  })

  const { data: allUsers } = useQuery<User[]>({
    queryKey: ['users', 'picker'],
    queryFn: () =>
      api.get<{ data: User[] }>('/users', { params: { limit: 200 } }).then((r) => r.data.data)
  })

  const [expandedCell, setExpandedCell] = useState<{ stateId: string; rowValue: string } | null>(
    null
  )
  const [addingRow, setAddingRow] = useState(false)
  const [newRowValue, setNewRowValue] = useState('')
  const [newRowLabel, setNewRowLabel] = useState('')
  const [customRows, setCustomRows] = useState<Array<{ value: string; label: string }>>([])

  const rowsFromGroups = useMemo<MatrixRow[]>(() => {
    if (!rowDim || !groupsMap) return []
    const seen = new Map<string, string>()
    for (const groups of Object.values(groupsMap)) {
      for (const group of groups) {
        for (const f of group.filters ?? []) {
          if (f.field === rowDim.field && f.op === 'eq' && !seen.has(String(f.value))) {
            seen.set(String(f.value), String(f.value))
          }
        }
      }
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }))
  }, [rowDim, groupsMap])

  const rowValues = useMemo<MatrixRow[]>(() => {
    const base = [...rowsFromGroups]
    for (const r of customRows) {
      if (!base.some((x) => x.value === r.value)) base.push(r)
    }
    // Sub-field path (e.g. "regions.short_name"): value IS the sub-field string, already readable
    if (rowSubField || !rowRelatedCollection || !rowItems) return base
    // Pure ID-based relation: enrich labels from fetched items
    const displayTemplate: string | null = rowRelMeta?.display_template ?? null
    return base.map((r) => {
      const item = rowItems.find((i) => String(i.id) === r.value)
      if (!item) return r
      return { value: r.value, label: renderDisplayTemplate(displayTemplate, item) }
    })
  }, [rowsFromGroups, customRows, rowSubField, rowRelatedCollection, rowItems, rowRelMeta])

  function getCellResult(
    stateId: string,
    rowValue: string
  ): { group: PipelineOwnerGroup | null; isInherited: boolean } {
    if (!rowDim || !groupsMap) return { group: null, isInherited: false }
    const stateGroups = groupsMap[stateId] ?? []

    // Full context: row value + all active col filter values
    const context: Record<string, string> = { [rowDim.field]: rowValue }
    for (const dim of colFilterDims) {
      if (filterValues[dim.id]) context[dim.field] = filterValues[dim.id]
    }

    // Match groups where every filter is satisfied by the context
    const matching = stateGroups.filter((g) => {
      const filters = g.filters ?? []
      if (
        !filters.some(
          (f) => f.field === rowDim.field && f.op === 'eq' && String(f.value) === rowValue
        )
      )
        return false
      return filters.every(
        (f) =>
          f.op === 'eq' &&
          context[f.field] !== undefined &&
          String(context[f.field]) === String(f.value)
      )
    })

    if (matching.length === 0) return { group: null, isInherited: false }

    // Best match: most filters (specificity) DESC, then priority ASC
    const sorted = [...matching].sort((a, b) => {
      const sd = (b.filters ?? []).length - (a.filters ?? []).length
      return sd !== 0 ? sd : (a.priority ?? 0) - (b.priority ?? 0)
    })
    const best = sorted[0]

    // Inherited = active optional dims not explicitly covered by winning group
    const activeOptional = colFilterDims.filter((d) => !d.required && filterValues[d.id])
    const isInherited =
      activeOptional.length > 0 &&
      !activeOptional.every((d) =>
        best.filters?.some((f) => f.field === d.field && String(f.value) === filterValues[d.id])
      )

    return { group: best, isInherited }
  }

  function hasOverrides(stateId: string, rowValue: string): boolean {
    if (!rowDim || !groupsMap) return false
    const stateGroups = groupsMap[stateId] ?? []
    const optionalFields = new Set(colFilterDims.filter((d) => !d.required).map((d) => d.field))
    if (optionalFields.size === 0) return false
    return stateGroups.some(
      (g) =>
        (g.filters ?? []).some((f) => f.field === rowDim.field && String(f.value) === rowValue) &&
        (g.filters ?? []).some((f) => optionalFields.has(f.field))
    )
  }

  const qc = useQueryClient()
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['pipeline-all-owner-groups', templateId] })

  const addUserToCell = useMutation({
    mutationFn: async ({
      stateId,
      rowValue,
      userId
    }: {
      stateId: string
      rowValue: string
      userId: string
    }) => {
      const { group: existing, isInherited } = getCellResult(stateId, rowValue)
      let group = !isInherited ? existing : null
      if (!group) {
        const colFilterItems = colFilterItemQueries.flatMap(
          (q) => (q.data as Record<string, unknown>[] | undefined) ?? []
        )
        const rowFilter: RecordFilter = {
          field: rowDim?.field ?? '',
          op: 'eq',
          value: rowValue,
          id_value: rowDim ? getIdValue(rowDim, rowValue, rowItems, undefined) : undefined
        }
        const colFilters: RecordFilter[] = colFilterDims
          .filter((d) => filterValues[d.id])
          .map((d) => ({
            field: d.field,
            op: 'eq',
            value: filterValues[d.id],
            id_value: getIdValue(d, filterValues[d.id], undefined, colFilterItems)
          }))
        const filters: RecordFilter[] = [rowFilter, ...colFilters]
        const r = await api.post<{ data: PipelineOwnerGroup }>(
          `/pipelines/states/${stateId}/owner-groups`,
          { filters, is_default: false, sort: 0, priority: 0 }
        )
        group = r.data.data
      }
      return api.post(`/pipelines/owner-groups/${group.id}/users`, { user: userId })
    },
    onSuccess: () => {
      invalidate()
      toast.success('Owner added')
    },
    onError: () => toast.error('Failed to add owner')
  })

  const createOverride = useMutation({
    mutationFn: async ({ stateId, rowValue }: { stateId: string; rowValue: string }) => {
      const colFilterItems = colFilterItemQueries.flatMap(
        (q) => (q.data as Record<string, unknown>[] | undefined) ?? []
      )
      const rowFilter: RecordFilter = {
        field: rowDim?.field ?? '',
        op: 'eq',
        value: rowValue,
        id_value: getIdValue(rowDim!, rowValue, rowItems, undefined)
      }
      const colFilters: RecordFilter[] = colFilterDims
        .filter((d) => filterValues[d.id])
        .map((d) => ({
          field: d.field,
          op: 'eq',
          value: filterValues[d.id],
          id_value: getIdValue(d, filterValues[d.id], undefined, colFilterItems)
        }))
      const filters: RecordFilter[] = [rowFilter, ...colFilters]
      return api.post<{ data: PipelineOwnerGroup }>(`/pipelines/states/${stateId}/owner-groups`, {
        filters,
        is_default: false,
        sort: 0,
        priority: 0
      })
    },
    onSuccess: () => {
      invalidate()
      toast.success('Override created')
    },
    onError: () => toast.error('Failed to create override')
  })

  const updatePriority = useMutation({
    mutationFn: ({ groupId, priority }: { groupId: string; priority: number }) =>
      api.patch(`/pipelines/owner-groups/${groupId}`, { priority }),
    onSuccess: () => invalidate(),
    onError: () => toast.error('Failed to update priority')
  })

  const removeUser = useMutation({
    mutationFn: (linkId: number) => api.delete(`/pipelines/owner-group-users/${linkId}`),
    onSuccess: () => {
      invalidate()
      toast.success('Owner removed')
    },
    onError: () => toast.error('Failed to remove owner')
  })

  const unmetRequired = colFilterDims.filter((d) => d.required && !filterValues[d.id])

  if (!rowDim) return null
  if (isLoading)
    return (
      <div className='flex items-center gap-2 py-4 text-[13px] text-slate-400'>
        <Loader2 className='h-4 w-4 animate-spin' />
        Loading matrix…
      </div>
    )

  return (
    <div className='space-y-4'>
      {colFilterDims.length > 0 && (
        <div className='flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5'>
          <span className='text-[11px] font-medium text-slate-400 uppercase tracking-wide shrink-0'>
            Filter
          </span>
          {colFilterDims.map((dim, i) => {
            const resolved = colFilterResolved[i]
            const rawItems = (colFilterItemQueries[i]?.data ?? []) as Record<string, unknown>[]
            const relMeta = colFilterRelMetaQueries[i]?.data
            const options: { value: string; label: string }[] = resolved?.relatedCollection
              ? rawItems.map((item) => {
                  if (resolved.subField) {
                    const v = String(item[resolved.subField] ?? '')
                    return { value: v, label: v }
                  }
                  return {
                    value: String(item.id),
                    label: renderDisplayTemplate(relMeta?.display_template ?? null, item)
                  }
                })
              : []
            return (
              <div key={dim.id} className='flex items-center gap-1.5'>
                <span className='text-[12px] font-medium text-slate-600'>{dim.label}</span>
                <FilterCombobox
                  label={dim.label}
                  value={filterValues[dim.id] ?? ''}
                  options={options}
                  onChange={(v) => setFilterValues((prev) => ({ ...prev, [dim.id]: v }))}
                  onSearch={(q) => setSearchTerms((prev) => ({ ...prev, [dim.id]: q }))}
                  loading={colFilterItemQueries[i]?.isLoading}
                />
              </div>
            )
          })}
        </div>
      )}

      {unmetRequired.length > 0 && (
        <div className='flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700'>
          <span className='font-medium'>Select a value for:</span>
          {unmetRequired.map((d) => (
            <span key={d.id} className='font-mono'>
              {d.label}
            </span>
          ))}
          <span>before managing owners.</span>
        </div>
      )}

      <div className='overflow-x-auto rounded-lg border border-slate-200'>
        <table className='min-w-full border-collapse text-[12px]'>
          <thead>
            <tr className='bg-slate-50'>
              <th className='sticky left-0 z-10 bg-slate-50 border-b border-r border-slate-200 px-3 py-2 text-left text-[12px] font-semibold text-slate-700 min-w-[100px]'>
                {rowDim.label}
              </th>
              {states.map((s) => (
                <th
                  key={s.id}
                  className='border-b border-r border-slate-200 px-3 py-2 text-left text-[11px] font-medium text-slate-500 min-w-[100px] last:border-r-0'
                >
                  <span
                    className='inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium'
                    style={{
                      backgroundColor: s.color ? `${s.color}22` : '#f1f5f9',
                      color: s.color ?? '#475569'
                    }}
                  >
                    {s.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowValues.map((row) => (
              <Fragment key={row.value}>
                <tr className='hover:bg-slate-50/50'>
                  <td className='sticky left-0 z-10 bg-white border-b border-r border-slate-200 px-3 py-2 font-medium text-slate-700 text-[13px]'>
                    {row.label}
                  </td>
                  {states.map((s) => {
                    const { group, isInherited } = getCellResult(s.id, row.value)
                    const users = group?.users ?? []
                    const isExpanded =
                      expandedCell?.stateId === s.id && expandedCell?.rowValue === row.value
                    const showOverrideDot =
                      !isInherited &&
                      colFilterDims.some((d) => !d.required) &&
                      colFilterDims.every((d) => d.required || !filterValues[d.id]) &&
                      hasOverrides(s.id, row.value)
                    return (
                      <td
                        key={s.id}
                        className={`border-b border-r border-slate-200 px-2 py-1.5 last:border-r-0 transition-colors ${unmetRequired.length > 0 ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-nvr-cyan/5'} ${isExpanded ? 'bg-nvr-cyan/5' : ''}`}
                        onClick={() => {
                          if (unmetRequired.length > 0) return
                          setExpandedCell(
                            isExpanded ? null : { stateId: s.id, rowValue: row.value }
                          )
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            if (unmetRequired.length > 0) return
                            setExpandedCell(
                              isExpanded ? null : { stateId: s.id, rowValue: row.value }
                            )
                          }
                        }}
                        tabIndex={unmetRequired.length > 0 ? -1 : 0}
                      >
                        <div className='flex flex-wrap items-center gap-1'>
                          {users.length === 0 ? (
                            <span className='text-slate-300 text-[11px]'>—</span>
                          ) : (
                            users.slice(0, 4).map((u) => (
                              <span
                                key={u.link_id}
                                title={
                                  [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
                                }
                                className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${isInherited ? 'bg-slate-100 text-slate-400' : 'bg-nvr-cyan/10 text-nvr-cyan'}`}
                              >
                                {initials(u)}
                              </span>
                            ))
                          )}
                          {users.length > 4 && (
                            <span className='inline-flex h-6 items-center px-1 text-[10px] text-slate-400'>
                              +{users.length - 4}
                            </span>
                          )}
                          {isInherited && users.length > 0 && (
                            <span className='text-[10px] text-slate-400 italic'>inherited</span>
                          )}
                          {showOverrideDot && (
                            <span
                              title='Has context-specific overrides'
                              className='h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0'
                            />
                          )}
                        </div>
                      </td>
                    )
                  })}
                </tr>
                {expandedCell?.rowValue === row.value && (
                  <tr>
                    <td className='sticky left-0 z-10 bg-slate-50 border-b border-r border-slate-200' />
                    {states.map((s) => {
                      if (expandedCell.stateId !== s.id) {
                        return (
                          <td
                            key={s.id}
                            className='border-b border-r border-slate-200 last:border-r-0 bg-slate-50/50'
                          />
                        )
                      }
                      const { group, isInherited } = getCellResult(s.id, row.value)
                      const users = group?.users ?? []
                      return (
                        <td
                          key={s.id}
                          className='border-b border-r border-slate-200 px-3 py-2 last:border-r-0 bg-nvr-cyan/5'
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          {isInherited ? (
                            <div className='space-y-2 min-w-[200px]'>
                              <div className='rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700 border border-amber-200'>
                                Inherited from base level
                              </div>
                              {users.map((u) => (
                                <div
                                  key={u.link_id}
                                  className='flex items-center gap-1.5 opacity-60'
                                >
                                  <span className='flex-1 text-[12px] text-slate-600'>
                                    {[u.first_name, u.last_name].filter(Boolean).join(' ') ||
                                      u.email}
                                  </span>
                                </div>
                              ))}
                              {users.length === 0 && (
                                <span className='text-[12px] text-slate-400'>
                                  No owners at base level
                                </span>
                              )}
                              <button
                                type='button'
                                disabled={createOverride.isPending}
                                onClick={() =>
                                  createOverride.mutate({ stateId: s.id, rowValue: row.value })
                                }
                                className='flex w-full items-center justify-center gap-1 rounded border border-dashed border-slate-300 px-2 py-1.5 text-[12px] text-slate-500 hover:border-nvr-cyan/50 hover:text-nvr-cyan disabled:opacity-40'
                              >
                                <Plus className='h-3.5 w-3.5' />
                                Create override for this context
                              </button>
                            </div>
                          ) : (
                            <div className='space-y-2 min-w-[200px]'>
                              {users.map((u) => (
                                <div key={u.link_id} className='flex items-center gap-1.5'>
                                  <span className='flex-1 text-[12px] text-slate-700'>
                                    {[u.first_name, u.last_name].filter(Boolean).join(' ') ||
                                      u.email}
                                  </span>
                                  <button
                                    type='button'
                                    onClick={() => removeUser.mutate(u.link_id)}
                                    className='text-slate-400 hover:text-red-500'
                                  >
                                    <X className='h-3 w-3' />
                                  </button>
                                </div>
                              ))}
                              <AddUserToCell
                                stateId={s.id}
                                rowValue={row.value}
                                existingUserIds={users.map((u) => u.user)}
                                allUsers={allUsers ?? []}
                                onAdd={(userId) =>
                                  addUserToCell.mutate({
                                    stateId: s.id,
                                    rowValue: row.value,
                                    userId
                                  })
                                }
                                isPending={addUserToCell.isPending}
                              />
                              {group && (
                                <div className='flex items-center gap-2 border-t border-slate-100 pt-2'>
                                  <span className='text-[11px] text-slate-400 shrink-0'>
                                    Priority
                                  </span>
                                  <input
                                    type='number'
                                    key={group.id}
                                    defaultValue={group.priority ?? 0}
                                    min={0}
                                    className='h-6 w-14 rounded border border-slate-200 px-1 text-[12px] text-center focus:border-nvr-cyan/50 focus:outline-none'
                                    onBlur={(e) => {
                                      const val = Number.parseInt(e.target.value, 10)
                                      if (!Number.isNaN(val) && val !== (group.priority ?? 0)) {
                                        updatePriority.mutate({ groupId: group.id, priority: val })
                                      }
                                    }}
                                  />
                                  <span className='text-[10px] text-slate-400'>lower = higher</span>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )}
              </Fragment>
            ))}

            {rowValues.length === 0 && (
              <tr>
                <td
                  colSpan={states.length + 1}
                  className='px-4 py-6 text-center text-[13px] text-slate-400'
                >
                  No rows yet — click "+ Add Row" to begin.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {addingRow ? (
        <div className='flex items-center gap-2'>
          {rowRelatedCollection ? (
            <InlineM2OPicker
              relatedCollection={rowRelatedCollection}
              displayTemplate={rowSubField ? null : (rowRelMeta?.display_template ?? null)}
              valueField={rowSubField}
              value={newRowValue}
              label={newRowLabel}
              onChange={(value, label) => {
                setNewRowValue(value)
                setNewRowLabel(label)
              }}
            />
          ) : (
            <input
              value={newRowValue}
              onChange={(e) => {
                setNewRowValue(e.target.value)
                setNewRowLabel(e.target.value)
              }}
              placeholder={`${rowDim.label} value…`}
              className='h-8 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] focus:border-nvr-cyan/50 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
            />
          )}
          <Button
            size='sm'
            variant='outline'
            className='h-8 text-[12px]'
            disabled={!newRowValue}
            onClick={() => {
              if (!newRowValue) return
              setCustomRows((r) => [
                ...r,
                { value: newRowValue, label: newRowLabel || newRowValue }
              ])
              setNewRowValue('')
              setNewRowLabel('')
              setAddingRow(false)
            }}
          >
            Add
          </Button>
          <Button
            size='sm'
            variant='ghost'
            className='h-8 text-[12px]'
            onClick={() => {
              setAddingRow(false)
              setNewRowValue('')
              setNewRowLabel('')
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          size='sm'
          variant='outline'
          className='gap-1.5 text-[12px]'
          onClick={() => setAddingRow(true)}
        >
          <Plus className='h-3.5 w-3.5' />
          Add Row
        </Button>
      )}
    </div>
  )
}

function AddUserToCell({
  stateId: _stateId,
  rowValue: _rowValue,
  existingUserIds,
  allUsers,
  onAdd,
  isPending
}: {
  stateId: string
  rowValue: string
  existingUserIds: string[]
  allUsers: User[]
  onAdd: (userId: string) => void
  isPending: boolean
}) {
  const [userId, setUserId] = useState('')
  const available = allUsers.filter((u) => !existingUserIds.includes(u.id))
  return (
    <div className='flex items-center gap-1.5'>
      <select
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        className='h-7 flex-1 rounded border border-slate-200 bg-white px-1.5 text-[12px]'
      >
        <option value=''>Add user…</option>
        {available.map((u) => (
          <option key={u.id} value={u.id}>
            {[u.first_name, u.last_name].filter(Boolean).join(' ') || u.email}
          </option>
        ))}
      </select>
      <button
        type='button'
        disabled={!userId || isPending}
        onClick={() => {
          onAdd(userId)
          setUserId('')
        }}
        className='h-7 rounded bg-nvr-cyan px-2 text-[11px] font-medium text-white disabled:opacity-40'
      >
        {isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : '+'}
      </button>
    </div>
  )
}

function InlineM2OPicker({
  relatedCollection,
  displayTemplate,
  valueField,
  value,
  label,
  onChange
}: {
  relatedCollection: string
  displayTemplate: string | null
  valueField?: string | null
  value: string
  label: string
  onChange: (value: string, label: string) => void
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const { data: items, isLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: ['items-picker', relatedCollection, search],
    queryFn: () =>
      api
        .get<{ data: Record<string, unknown>[] }>(`/items/${relatedCollection}`, {
          params: { limit: 30, search: search || undefined }
        })
        .then((r) => r.data.data),
    enabled: open
  })

  return (
    <div className='relative' ref={containerRef}>
      <input
        value={open ? search : label || value}
        onChange={(e) => {
          setSearch(e.target.value)
        }}
        onFocus={() => setOpen(true)}
        placeholder='Search…'
        className='h-8 w-48 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] focus:border-nvr-cyan/50 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
      />
      {open && (
        <div className='absolute z-50 top-full mt-0.5 w-full min-w-[200px] max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg'>
          {isLoading ? (
            <div className='flex justify-center py-3'>
              <Loader2 className='h-3.5 w-3.5 animate-spin text-slate-400' />
            </div>
          ) : (items ?? []).length === 0 ? (
            <div className='px-3 py-2 text-[12px] text-slate-400'>No results</div>
          ) : (
            (items ?? []).map((item) => {
              const lbl = valueField
                ? String(item[valueField] ?? '')
                : renderDisplayTemplate(displayTemplate, item)
              const val = valueField ? String(item[valueField] ?? '') : String(item.id)
              return (
                <button
                  key={String(item.id)}
                  type='button'
                  onClick={() => {
                    onChange(val, lbl)
                    setOpen(false)
                    setSearch('')
                  }}
                  className='w-full px-3 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-50'
                >
                  {lbl}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
