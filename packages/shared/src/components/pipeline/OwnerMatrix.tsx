import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Loader2, Plus, Search, Users2, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { findM2ORelation, findO2MRelation, renderDisplayTemplate } from './relations'
import type {
  CMSRelation,
  PipelineBinding,
  PipelineOwnerDimension,
  PipelineOwnerGroup,
  PipelineOwnerGroupsMap,
  PipelineState,
  RecordFilter,
  User
} from './types'

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

/** One-line secondary identity for picker rows — title · department, falling
 *  back to the role name, then the email. */
function personSecondary(u: User, roleNames: Map<string, string> | null): string {
  const role = u.role ? (roleNames?.get(String(u.role).toUpperCase()) ?? null) : null
  const parts = [u.title || role, u.department].filter(Boolean) as string[]
  return parts.join(' · ') || u.email
}

function sortPeople(users: User[]): User[] {
  const label = (u: User) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
  return [...users].sort((a, b) => label(a).localeCompare(label(b), undefined, { sensitivity: 'base' }))
}

/** Role id → name, best-effort: /roles is admin-only, so a non-admin host
 *  simply renders rows without role names. */
function useRoleNames(): Map<string, string> | null {
  const client = useNivaroClient()
  const { data } = useQuery<Map<string, string> | null>({
    queryKey: ['roles-name-map'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: string; name: string }> }>(get('/roles'))
        .then((r) => new Map(r.data.map((x) => [String(x.id).toUpperCase(), x.name])))
        .catch(() => null),
    staleTime: 5 * 60_000
  })
  return data ?? null
}

/** Server-side people search — the directory exceeds any client-side fetch
 *  cap (>1000 users on EFP), so slicing locally silently hides people. Every
 *  picker queries /users with search + alphabetical sort instead. */
function usePeopleSearch(query: string): { people: User[]; isFetching: boolean } {
  const client = useNivaroClient()
  const q = query.trim()
  const { data, isFetching } = useQuery<User[]>({
    queryKey: ['people-search', q],
    queryFn: () =>
      client
        .request<{ data: User[] }>(
          get('/users', { limit: 50, sort: 'first_name', search: q || undefined })
        )
        .then((r) => r.data),
    staleTime: 60_000
  })
  return { people: data ?? [], isFetching }
}

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
  const client = useNivaroClient()
  const allDimensions = bindings.flatMap((b) => b.dimensions ?? [])
  const rowDim = allDimensions.find((d) => d.is_row_axis) ?? null
  const colFilterDims = allDimensions.filter((d) => !d.is_row_axis)

  const { data: groupsMap, isLoading } = useQuery<PipelineOwnerGroupsMap>({
    queryKey: ['pipeline-all-owner-groups', templateId],
    queryFn: () =>
      client
        .request<{ data: PipelineOwnerGroupsMap }>(get(`/pipelines/${templateId}/owner-groups`))
        .then((r) => r.data)
  })

  const [bulkOpen, setBulkOpen] = useState(false)
  const firstCollection = bindings[0]?.collection ?? ''
  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', firstCollection],
    queryFn: () =>
      client.request<{ data: any }>(get(`/collections/${firstCollection}`)).then((r) => r.data),
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
        queryFn: (): Promise<any> =>
          client.request<{ data: any }>(get(`/collections/${baseCol}`)).then((r) => r.data)
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
            client
              .request<{ data: Record<string, unknown>[] }>(
                get(`/items/${resolved.relatedCollection}`, {
                  limit: 100,
                  ...(term ? { search: term } : {})
                })
              )
              .then((r) => r.data)
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
          client
            .request<{ data: any }>(get(`/collections/${resolved.relatedCollection}`))
            .then((r) => r.data)
      }
    })
  })

  const { data: rowItems } = useQuery<Record<string, unknown>[]>({
    queryKey: ['items-picker', rowRelatedCollection],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${rowRelatedCollection}`, { limit: 100 })
        )
        .then((r) => r.data),
    enabled: !!rowRelatedCollection
  })

  const { data: rowRelMeta } = useQuery({
    queryKey: ['collection-meta', rowRelatedCollection],
    queryFn: () =>
      client.request<{ data: any }>(get(`/collections/${rowRelatedCollection}`)).then((r) => r.data),
    enabled: !!rowRelatedCollection && !rowSubField
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
    // AUTO-POPULATE from the row dimension's related collection — the matrix
    // used to start empty (rows appeared only once a group referenced them),
    // forcing every axis value to be hand-added even though the target
    // collection was already fetched. Group-derived and custom rows merge on
    // top so historical values missing from the collection still render.
    const base: MatrixRow[] = []
    const push = (r: MatrixRow) => {
      if (r.value !== '' && !base.some((x) => x.value === r.value)) base.push(r)
    }
    if (rowItems) {
      if (rowSubField) {
        // Sub-field path (regions.short_name): one row per distinct sub-field
        // value, deduped (legacy data carries duplicate short names).
        const vals = [...new Set(rowItems.map((i) => String(i[rowSubField] ?? '')).filter(Boolean))]
        vals.sort((a, b) => a.localeCompare(b))
        for (const v of vals) push({ value: v, label: v })
      } else {
        const displayTemplate: string | null = rowRelMeta?.display_template ?? null
        for (const item of rowItems) {
          push({ value: String(item.id), label: renderDisplayTemplate(displayTemplate, item) })
        }
      }
    }
    for (const r of rowsFromGroups) push(r)
    for (const r of customRows) push(r)
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
        const r = await client.request<{ data: PipelineOwnerGroup }>(
          post(`/pipelines/states/${stateId}/owner-groups`, {
            filters,
            is_default: false,
            sort: 0,
            priority: 0
          })
        )
        group = r.data
      }
      return client.request(post(`/pipelines/owner-groups/${group.id}/users`, { user: userId }))
    },
    onSuccess: () => {
      invalidate()
      toast.success('Owner added')
    },
    onError: () => toast.error('Failed to add owner')
  })

  // The exact filter set a cell save would store — shared by the impact hint.
  const buildCellFilters = (_stateId: string, rowValue: string): RecordFilter[] => {
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
    return [rowFilter, ...colFilters]
  }

  // Teams (nivaro_user_groups) — assignable wholesale: the roster resolves
  // as owners at read time, managed once on the Teams page.
  const { data: allTeams } = useQuery<
    Array<{ id: number; name: string; slug: string; member_count: number }>
  >({
    queryKey: ['user-groups-teams'],
    queryFn: () =>
      client
        .request<{
          data: Array<{ id: number; name: string; slug: string; member_count: number }>
        }>(get('/user-groups'))
        .then((r) => r.data),
    staleTime: 60_000
  })

  const addTeamToCell = useMutation({
    mutationFn: async ({
      stateId,
      rowValue,
      teamId
    }: {
      stateId: string
      rowValue: string
      teamId: number
    }) => {
      const { group: existing, isInherited } = getCellResult(stateId, rowValue)
      let group = !isInherited ? existing : null
      if (!group) {
        const r = await client.request<{ data: PipelineOwnerGroup }>(
          post(`/pipelines/states/${stateId}/owner-groups`, {
            filters: buildCellFilters(stateId, rowValue),
            is_default: false,
            sort: 0,
            priority: 0
          })
        )
        group = r.data
      }
      return client.request(post(`/pipelines/owner-groups/${group.id}/teams`, { team_id: teamId }))
    },
    onSuccess: () => {
      invalidate()
      toast.success('Team assigned')
    },
    onError: () => toast.error('Failed to assign team')
  })

  const removeTeam = useMutation({
    mutationFn: ({ groupId, teamId }: { groupId: string; teamId: number }) =>
      client.request(del(`/pipelines/owner-groups/${groupId}/teams/${teamId}`)),
    onSuccess: () => {
      invalidate()
      toast.success('Team unassigned')
    },
    onError: () => toast.error('Failed to unassign team')
  })

  // Create a brand-new team and link it to the cell in one go — the manager
  // popover opens right after so members can be added without leaving Owners.
  const [managingTeam, setManagingTeam] = useState<{ id: number; name: string } | null>(null)
  const createTeamForCell = useMutation({
    mutationFn: async ({
      stateId,
      rowValue,
      name
    }: {
      stateId: string
      rowValue: string
      name: string
    }) => {
      const created = await client.request<{ data: { id: number; name: string } }>(
        post('/user-groups', { name })
      )
      const { group: existing, isInherited } = getCellResult(stateId, rowValue)
      let group = !isInherited ? existing : null
      if (!group) {
        const r = await client.request<{ data: PipelineOwnerGroup }>(
          post(`/pipelines/states/${stateId}/owner-groups`, {
            filters: buildCellFilters(stateId, rowValue),
            is_default: false,
            sort: 0,
            priority: 0
          })
        )
        group = r.data
      }
      await client.request(
        post(`/pipelines/owner-groups/${group.id}/teams`, { team_id: created.data.id })
      )
      return created.data
    },
    onSuccess: (team) => {
      invalidate()
      void qc.invalidateQueries({ queryKey: ['user-groups-teams'] })
      toast.success(`Team "${team.name}" created and assigned — add its members`)
      setManagingTeam({ id: team.id, name: team.name })
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { error?: string } })?.response?.error ?? 'Failed to create team'
      )
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
      return client.request<{ data: PipelineOwnerGroup }>(
        post(`/pipelines/states/${stateId}/owner-groups`, {
          filters,
          is_default: false,
          sort: 0,
          priority: 0
        })
      )
    },
    onSuccess: () => {
      invalidate()
      toast.success('Override created')
    },
    onError: () => toast.error('Failed to create override')
  })

  const updatePriority = useMutation({
    mutationFn: ({ groupId, priority }: { groupId: string; priority: number }) =>
      client.request(patch(`/pipelines/owner-groups/${groupId}`, { priority })),
    onSuccess: () => invalidate(),
    onError: () => toast.error('Failed to update priority')
  })

  const updateMaxWip = useMutation({
    mutationFn: ({ groupId, maxWip }: { groupId: string; maxWip: number | null }) =>
      client.request(patch(`/pipelines/owner-groups/${groupId}`, { max_wip: maxWip })),
    onSuccess: () => invalidate(),
    onError: () => toast.error('Failed to update WIP limit')
  })

  const removeUser = useMutation({
    mutationFn: (linkId: number) => client.request(del(`/pipelines/owner-group-users/${linkId}`)),
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
      {managingTeam && (
        <TeamManagerPanel
          team={managingTeam}
          onClose={() => {
            setManagingTeam(null)
            invalidate()
            void qc.invalidateQueries({ queryKey: ['user-groups-teams'] })
          }}
        />
      )}
      {/* Bulk matrix membership (#387) */}
      <div className='flex justify-end'>
        <button
          type='button'
          onClick={() => setBulkOpen((v) => !v)}
          className='rounded-md border border-dashed border-slate-300 px-2.5 py-1 text-[12px] text-slate-500 hover:bg-slate-50 dark:border-border'
        >
          ＋ Add a user to many cells…
        </button>
      </div>
      {bulkOpen && (
        <BulkMembershipPanel
          templateId={templateId}
          groupsMap={groupsMap ?? {}}
          states={states}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false)
            void qc.invalidateQueries({ queryKey: ['pipeline-all-owner-groups', templateId] })
          }}
        />
      )}
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
              <th className='sticky left-0 z-10 bg-slate-50 dark:bg-muted border-b border-r border-slate-200 dark:border-border px-3 py-2 text-left text-[12px] font-semibold text-slate-700 dark:text-slate-200 min-w-[100px]'>
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
                  <td className='sticky left-0 z-10 bg-white dark:bg-card border-b border-r border-slate-200 dark:border-border px-3 py-2 font-medium text-slate-700 dark:text-slate-200 text-[13px]'>
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
                          {(group?.teams ?? []).map((t) => (
                            <span
                              key={`t${t.link_id}`}
                              data-tip={`Team · ${t.member_count} member${t.member_count === 1 ? '' : 's'}`}
                              className={`inline-flex h-6 items-center gap-1 rounded-full px-2 text-[10.5px] font-semibold ${isInherited ? 'bg-slate-100 text-slate-400' : 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'}`}
                            >
                              <Users2 className='h-3 w-3' />
                              {t.name}
                            </span>
                          ))}
                          {users.length === 0 && (group?.teams ?? []).length === 0 ? (
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
                    <td className='sticky left-0 z-10 bg-slate-50 dark:bg-muted border-b border-r border-slate-200 dark:border-border' />
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
                      // Matrix OOO heat (#337): tint by out-of-office share.
                      const oooCount = users.filter(
                        (u) => (u as { is_out_of_office?: boolean | number }).is_out_of_office
                      ).length
                      const oooClass =
                        users.length > 0 && oooCount === users.length
                          ? 'bg-amber-100/80 dark:bg-amber-500/15'
                          : oooCount > 0
                            ? 'bg-amber-50/70 dark:bg-amber-500/8'
                            : 'bg-nvr-cyan/5'
                      return (
                        <td
                          key={s.id}
                          data-tip={
                            oooCount > 0
                              ? `${oooCount}/${users.length} member(s) out of office`
                              : undefined
                          }
                          className={`border-b border-r border-slate-200 px-3 py-2 last:border-r-0 ${oooClass}`}
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
                              {(group?.teams ?? []).map((t) => (
                                <div key={`t${t.link_id}`} className='flex items-center gap-1.5'>
                                  <button
                                    type='button'
                                    data-tip='Manage this team’s members'
                                    onClick={() => setManagingTeam({ id: t.id, name: t.name })}
                                    className='flex flex-1 items-center gap-1.5 text-left text-[12px] font-medium text-violet-700 hover:underline dark:text-violet-300'
                                  >
                                    <Users2 className='h-3.5 w-3.5' />
                                    {t.name}
                                    <span className='font-normal tabular-nums text-slate-400'>
                                      {t.member_count} member{t.member_count === 1 ? '' : 's'}
                                    </span>
                                  </button>
                                  <button
                                    type='button'
                                    data-tip='Unassign this team from the cell (the team itself is untouched)'
                                    onClick={() =>
                                      group && removeTeam.mutate({ groupId: group.id, teamId: t.id })
                                    }
                                    className='text-slate-400 hover:text-red-500'
                                  >
                                    <X className='h-3 w-3' />
                                  </button>
                                </div>
                              ))}
                              {users.map((u) => (
                                <div key={u.link_id} className='flex items-center gap-1.5'>
                                  <span className='flex-1 text-[12px] text-slate-700'>
                                    {[u.first_name, u.last_name].filter(Boolean).join(' ') ||
                                      u.email}
                                    {(u as { is_out_of_office?: boolean | number })
                                      .is_out_of_office && (
                                      <span className='ml-1 rounded bg-amber-100 px-1 py-px text-[9.5px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'>
                                        OOO
                                      </span>
                                    )}
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
                              <CellImpactHint
                                templateId={templateId}
                                stateId={s.id}
                                buildFilters={() => buildCellFilters(s.id, row.value)}
                              />
                              <AddUserToCell
                                stateId={s.id}
                                rowValue={row.value}
                                existingUserIds={users.map((u) => u.user)}
                                teams={(allTeams ?? []).filter(
                                  (t) => !(group?.teams ?? []).some((lt) => lt.id === t.id)
                                )}
                                onAdd={(userId) =>
                                  addUserToCell.mutate({
                                    stateId: s.id,
                                    rowValue: row.value,
                                    userId
                                  })
                                }
                                onAddTeam={(teamId) =>
                                  addTeamToCell.mutate({
                                    stateId: s.id,
                                    rowValue: row.value,
                                    teamId
                                  })
                                }
                                onCreateTeam={(name) =>
                                  createTeamForCell.mutate({
                                    stateId: s.id,
                                    rowValue: row.value,
                                    name
                                  })
                                }
                                isPending={
                                  addUserToCell.isPending ||
                                  addTeamToCell.isPending ||
                                  createTeamForCell.isPending
                                }
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
                              {group && (
                                <div className='flex items-center gap-2 border-t border-slate-100 pt-2'>
                                  <span className='text-[11px] text-slate-400 shrink-0'>
                                    Max WIP
                                  </span>
                                  <input
                                    type='number'
                                    key={`${group.id}-wip`}
                                    defaultValue={group.max_wip ?? ''}
                                    min={0}
                                    placeholder='—'
                                    className='h-6 w-14 rounded border border-slate-200 px-1 text-[12px] text-center focus:border-nvr-cyan/50 focus:outline-none'
                                    onBlur={(e) => {
                                      const raw = e.target.value.trim()
                                      const val = raw === '' ? null : Number.parseInt(raw, 10)
                                      const currentMaxWip = group.max_wip ?? null
                                      if (
                                        (val === null || !Number.isNaN(val)) &&
                                        val !== currentMaxWip
                                      ) {
                                        updateMaxWip.mutate({ groupId: group.id, maxWip: val })
                                      }
                                    }}
                                  />
                                  <span className='text-[10px] text-slate-400'>
                                    blank = unlimited
                                  </span>
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

/** Owner-matrix impact hint (#87): "this cell governs N live records" —
 *  fetched on demand so the matrix itself stays light. */
function CellImpactHint({
  templateId,
  stateId,
  buildFilters
}: {
  templateId: string
  stateId: string
  buildFilters: () => RecordFilter[]
}) {
  const client = useNivaroClient()
  const [result, setResult] = useState<{
    matched: number
    total_in_state: number
    sample: Array<{ item: string; label: string }>
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const check = async () => {
    setLoading(true)
    try {
      const r = await client.request<{
        data: {
          matched: number
          total_in_state: number
          sample: Array<{ item: string; label: string }>
        }
      }>(
        post(`/pipelines/${templateId}/owner-impact`, {
          state_id: stateId,
          filters: buildFilters()
        })
      )
      setResult(r.data)
    } catch {
      setResult(null)
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className='mt-1 text-[10.5px]'>
      {result ? (
        <span
          className='text-slate-500 dark:text-muted-foreground'
          title={result.sample.map((x) => x.label).join(', ')}
        >
          Governs {result.matched.toLocaleString()} of {result.total_in_state.toLocaleString()} live
          record(s) in this state
        </span>
      ) : (
        <button
          type='button'
          disabled={loading}
          onClick={() => void check()}
          className='text-slate-400 underline decoration-dotted hover:text-slate-600 disabled:opacity-50'
        >
          {loading ? 'Checking…' : 'Preview impact'}
        </button>
      )}
    </div>
  )
}

/** Searchable owner picker — Teams and People in one styled combobox
 *  (Popover + search, same vocabulary as FilterCombobox; never a native
 *  select). Picking adds immediately; "New team…" swaps to an inline name
 *  form that creates + links the team. */
function AddUserToCell({
  stateId: _stateId,
  rowValue: _rowValue,
  existingUserIds,
  teams = [],
  onAdd,
  onAddTeam,
  onCreateTeam,
  isPending
}: {
  stateId: string
  rowValue: string
  existingUserIds: string[]
  teams?: Array<{ id: number; name: string; member_count: number }>
  onAdd: (userId: string) => void
  onAddTeam?: (teamId: number) => void
  onCreateTeam?: (name: string) => void
  isPending: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else {
      setQuery('')
      setCreating(false)
      setNewTeamName('')
    }
  }, [open])

  const roleNames = useRoleNames()
  const { people } = usePeopleSearch(open ? query : '')
  const q = query.trim().toLowerCase()
  const userLabel = (u: User) =>
    [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
  const excluded = new Set(existingUserIds.map((id) => id.toUpperCase()))
  const filteredTeams = (q
    ? teams.filter((t) => t.name.toLowerCase().includes(q))
    : teams
  ).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const filteredUsers = people.filter((u) => !excluded.has(String(u.id).toUpperCase()))

  if (creating) {
    return (
      <div className='flex items-center gap-1.5'>
        <input
          // biome-ignore lint/a11y/noAutofocus: swapping an in-place form — focus continues the flow
          autoFocus
          value={newTeamName}
          onChange={(e) => setNewTeamName(e.target.value)}
          placeholder='New team name…'
          className='h-7 flex-1 rounded border border-slate-200 bg-white px-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-violet-400/50 dark:border-border dark:bg-card'
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newTeamName.trim()) {
              onCreateTeam?.(newTeamName.trim())
              setCreating(false)
              setNewTeamName('')
            }
            if (e.key === 'Escape') setCreating(false)
          }}
        />
        <button
          type='button'
          disabled={!newTeamName.trim() || isPending}
          onClick={() => {
            onCreateTeam?.(newTeamName.trim())
            setCreating(false)
            setNewTeamName('')
          }}
          className='h-7 rounded bg-violet-600 px-2 text-[11px] font-medium text-white disabled:opacity-40'
        >
          {isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Create'}
        </button>
        <button
          type='button'
          onClick={() => setCreating(false)}
          className='h-7 rounded px-1.5 text-[11px] text-slate-400 hover:text-slate-600'
        >
          ✕
        </button>
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={isPending}
          className='flex h-7 w-full items-center justify-between rounded border border-slate-200 bg-white px-2 text-[12px] text-slate-500 transition-colors hover:border-slate-300 disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-300'
        >
          <span className='flex items-center gap-1.5'>
            {isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : <Plus className='h-3 w-3' />}
            Add owner…
          </span>
          <ChevronDown className='h-3 w-3 opacity-50' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-96 p-0' sideOffset={4}>
        <div className='border-b border-slate-100 px-2 py-1.5 dark:border-border'>
          <div className='relative'>
            <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search teams and people…'
              className='h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40 dark:bg-muted'
            />
          </div>
        </div>
        <div className='max-h-64 overflow-y-auto py-1'>
          {onAddTeam && (filteredTeams.length > 0 || onCreateTeam) && (
            <>
              <p className='px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                Teams
              </p>
              {filteredTeams.map((t) => (
                <button
                  key={t.id}
                  type='button'
                  onClick={() => {
                    onAddTeam(t.id)
                    setOpen(false)
                  }}
                  className='flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-slate-200'
                >
                  <Users2 className='h-3.5 w-3.5 shrink-0 text-violet-500' />
                  <span className='flex-1 truncate'>{t.name}</span>
                  <span className='tabular-nums text-[11px] text-slate-400'>
                    {t.member_count}
                  </span>
                </button>
              ))}
              {onCreateTeam && (
                <button
                  type='button'
                  onClick={() => {
                    setOpen(false)
                    setCreating(true)
                    setNewTeamName(query.trim())
                  }}
                  className='flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-violet-700 hover:bg-muted dark:text-violet-300'
                >
                  <Plus className='h-3.5 w-3.5 shrink-0' />
                  New team…
                </button>
              )}
            </>
          )}
          <p className='px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
            People
          </p>
          {filteredUsers.map((u) => (
            <button
              key={u.id}
              type='button'
              onClick={() => {
                onAdd(u.id)
                setOpen(false)
              }}
              className='flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-slate-200'
            >
              <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#00ceff1a] text-[9.5px] font-semibold text-slate-600 dark:text-slate-300'>
                {initials(u)}
              </span>
              <span className='min-w-0 flex-1 truncate font-medium'>{userLabel(u)}</span>
              <span className='max-w-[55%] shrink-0 truncate text-[11px] text-slate-400'>
                {personSecondary(u, roleNames)}
              </span>
            </button>
          ))}
          {filteredUsers.length === 0 && filteredTeams.length === 0 && (
            <p className='px-3 py-2 text-[12px] text-slate-400'>
              No matches — people already in this cell are hidden
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
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
  const client = useNivaroClient()
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
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relatedCollection}`, { limit: 30, search: search || undefined })
        )
        .then((r) => r.data),
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
        <div className='absolute z-50 top-full mt-0.5 w-full min-w-[200px] max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg dark:border-border dark:bg-card'>
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

// ─── Bulk matrix membership (#387) ───────────────────────────────────────────
function BulkMembershipPanel({
  templateId,
  groupsMap,
  states,
  onClose,
  onDone
}: {
  templateId: string
  groupsMap: PipelineOwnerGroupsMap
  states: Array<{ id: string; label: string }>
  onClose: () => void
  onDone: () => void
}) {
  const client = useNivaroClient()
  const [userQuery, setUserQuery] = useState('')
  const [userId, setUserId] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const { data: users = [] } = useQuery<
    Array<{ id: string; first_name: string | null; last_name: string | null; email: string }>
  >({
    queryKey: ['bulk-matrix-users', userQuery.trim()],
    queryFn: () =>
      client
        .request<{
          data: Array<{
            id: string
            first_name: string | null
            last_name: string | null
            email: string
          }>
        }>(get('/users', { limit: 50, sort: 'first_name', search: userQuery.trim() || undefined }))
        .then((r) => r.data)
  })
  const filteredUsers = users.slice(0, 8)
  const submit = () => {
    setBusy(true)
    void client
      .request<{ data: { added: number } }>(
        post(`/pipelines/${templateId}/owner-groups/bulk-add`, {
          user_id: userId,
          group_ids: [...selected]
        })
      )
      .then((r) => {
        toast.success(`Added to ${r.data.added} group(s)`)
        onDone()
      })
      .catch(() => toast.error('Bulk add failed'))
      .finally(() => setBusy(false))
  }
  return (
    <div className='space-y-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3 dark:border-border dark:bg-muted/30'>
      <p className='text-[12.5px] font-medium'>Add one user to many owner-matrix cells</p>
      {!userId ? (
        <div>
          <input
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            placeholder='Search people…'
            className='h-8 w-[280px] rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] dark:border-border'
          />
          <div className='mt-1 flex flex-wrap gap-1.5'>
            {userQuery &&
              filteredUsers.map((u) => (
                <button
                  key={u.id}
                  type='button'
                  onClick={() => setUserId(u.id)}
                  className='rounded-full border border-slate-200 px-2.5 py-0.5 text-[12px] hover:border-nvr-cyan/60 dark:border-border'
                >
                  {[u.first_name, u.last_name].filter(Boolean).join(' ') || u.email}
                </button>
              ))}
          </div>
        </div>
      ) : (
        <>
          <p className='text-[12px] text-slate-500'>
            Adding{' '}
            <b>
              {(() => {
                const u = users.find((x) => x.id === userId)
                return u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email : userId
              })()}
            </b>{' '}
            — pick the groups:
          </p>
          <div className='max-h-64 space-y-2 overflow-y-auto'>
            {states.map((st) => {
              const groups = groupsMap[st.id] ?? []
              if (groups.length === 0) return null
              return (
                <div key={st.id}>
                  <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                    {st.label}
                  </p>
                  <div className='mt-0.5 flex flex-wrap gap-1'>
                    {groups.slice(0, 60).map((g) => {
                      const gid = Number((g as unknown as { id: number | string }).id)
                      const on = selected.has(gid)
                      return (
                        <button
                          key={gid}
                          type='button'
                          onClick={() =>
                            setSelected((prev) => {
                              const next = new Set(prev)
                              if (next.has(gid)) next.delete(gid)
                              else next.add(gid)
                              return next
                            })
                          }
                          className={
                            on
                              ? 'rounded-full bg-nvr-cyan/15 px-2 py-0.5 text-[11px] font-medium text-nvr-navy dark:text-nvr-cyan'
                              : 'rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:border-nvr-cyan/50 dark:border-border'
                          }
                        >
                          {(g as { name?: string | null }).name ?? `group ${gid}`}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
      <div className='flex justify-end gap-2'>
        <button
          type='button'
          onClick={onClose}
          className='rounded-md px-2.5 py-1 text-[12px] text-slate-500 hover:bg-white dark:hover:bg-muted'
        >
          Cancel
        </button>
        <button
          type='button'
          onClick={submit}
          disabled={busy || !userId || selected.size === 0}
          className='rounded-md bg-nvr-cyan px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-50'
        >
          {busy ? 'Adding…' : `Add to ${selected.size} group(s)`}
        </button>
      </div>
    </div>
  )
}


/** Inline team roster manager — opened from a team chip in the Owner Matrix
 *  so rosters are editable without leaving the pipeline. Edits apply to the
 *  TEAM itself: every cell (and mention) using it follows. */
function TeamManagerPanel({
  team,
  onClose
}: {
  team: { id: number; name: string }
  onClose: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: members, isLoading } = useQuery<
    Array<{ id: string; first_name: string | null; last_name: string | null; email: string }>
  >({
    queryKey: ['team-members', team.id],
    queryFn: () =>
      client
        .request<{
          data: Array<{
            id: string
            first_name: string | null
            last_name: string | null
            email: string
          }>
        }>(get(`/user-groups/${team.id}/members`))
        .then((r) => r.data)
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['team-members', team.id] })
    void qc.invalidateQueries({ queryKey: ['user-groups-teams'] })
  }
  const addMember = useMutation({
    mutationFn: (userId: string) =>
      client.request(post(`/user-groups/${team.id}/members`, { user_ids: [userId] })),
    onSuccess: refresh,
    onError: () => toast.error('Failed to add member')
  })
  const removeMember = useMutation({
    mutationFn: (userId: string) => client.request(del(`/user-groups/${team.id}/members/${userId}`)),
    onSuccess: refresh,
    onError: () => toast.error('Failed to remove member')
  })
  const memberIds = new Set((members ?? []).map((m) => String(m.id).toUpperCase()))

  return createPortal(
    <div
      className='fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4'
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className='w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl dark:border-border dark:bg-card'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='mb-1 flex items-center gap-2'>
          <Users2 className='h-4 w-4 text-violet-500' />
          <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
            {team.name}
          </h2>
          <span className='ml-auto text-[11px] tabular-nums text-slate-400'>
            {(members ?? []).length} member{(members ?? []).length === 1 ? '' : 's'}
          </span>
        </div>
        <p className='mb-3 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          Roster edits apply everywhere this team is assigned.
        </p>
        {isLoading ? (
          <div className='flex justify-center py-4'>
            <Loader2 className='h-4 w-4 animate-spin text-slate-400' />
          </div>
        ) : (
          <div className='mb-2 max-h-56 divide-y divide-slate-100 overflow-y-auto dark:divide-border/60'>
            {(members ?? []).map((m) => (
              <div key={m.id} className='flex items-center gap-1.5 py-1.5'>
                <span className='flex-1 truncate text-[12.5px] text-slate-700 dark:text-slate-200'>
                  {[m.first_name, m.last_name].filter(Boolean).join(' ') || m.email}
                </span>
                <button
                  type='button'
                  aria-label='Remove from team'
                  disabled={removeMember.isPending}
                  onClick={() => removeMember.mutate(m.id)}
                  className='text-slate-400 hover:text-red-500'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </div>
            ))}
            {(members ?? []).length === 0 && (
              <p className='py-2 text-[12px] text-slate-400'>No members yet — add people below.</p>
            )}
          </div>
        )}
        <MemberPickerCombobox
          excludeIds={[...memberIds]}
          isPending={addMember.isPending}
          onPick={(userId) => addMember.mutate(userId)}
        />
        <div className='mt-3 flex justify-end'>
          <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** People-only styled picker for the team roster manager — same combobox
 *  vocabulary as the cell's owner picker. */
function MemberPickerCombobox({
  excludeIds,
  isPending,
  onPick
}: {
  excludeIds: string[]
  isPending: boolean
  onPick: (userId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else setQuery('')
  }, [open])
  const roleNames = useRoleNames()
  const { people } = usePeopleSearch(open ? query : '')
  const label = (u: User) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
  const excluded = new Set(excludeIds.map((id) => id.toUpperCase()))
  const filtered = people.filter((u) => !excluded.has(String(u.id).toUpperCase()))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={isPending}
          className='flex h-7 w-full items-center justify-between rounded border border-slate-200 bg-white px-2 text-[12px] text-slate-500 transition-colors hover:border-slate-300 disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-300'
        >
          <span className='flex items-center gap-1.5'>
            {isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : <Plus className='h-3 w-3' />}
            Add member…
          </span>
          <ChevronDown className='h-3 w-3 opacity-50' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='z-[140] w-96 p-0' sideOffset={4}>
        <div className='border-b border-slate-100 px-2 py-1.5 dark:border-border'>
          <div className='relative'>
            <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search people…'
              className='h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-400/40 dark:bg-muted'
            />
          </div>
        </div>
        <div className='max-h-56 overflow-y-auto py-1'>
          {filtered.map((u) => (
            <button
              key={u.id}
              type='button'
              onClick={() => {
                onPick(u.id)
                setOpen(false)
              }}
              className='flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-slate-200'
            >
              <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[9.5px] font-semibold text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'>
                {initials(u)}
              </span>
              <span className='min-w-0 flex-1 truncate font-medium'>{label(u)}</span>
              <span className='max-w-[55%] shrink-0 truncate text-[11px] text-slate-400'>
                {personSecondary(u, roleNames)}
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className='px-3 py-2 text-[12px] text-slate-400'>
              No matches — people already on the team are hidden
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
