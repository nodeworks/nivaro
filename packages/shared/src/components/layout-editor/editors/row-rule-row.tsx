import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '../../../lib/utils'
import { extractTemplateFields, renderDisplayTemplate } from '../../pipeline/relations'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useEditorApi } from './editor-api'

export type RowRuleSource = {
  source_type: 'relation_field' | 'o2m_first' | 'o2m_filtered' | 'parent_m2o'
  source_field: string
  source_related_field: string
  // o2m_filtered only:
  source_hop?: 'm2o' | 'o2m_first' // how to resolve the intermediate record
  o2m_collection?: string // child collection to search
  filter_field?: string // field on child to filter
  filter_value?: string // value (supports $parent.X)
  // parent_m2o only:
  source_one_collection?: string // resolved one_collection of the parent M2O field
}

export type RowRuleItem = {
  trigger_field?: string | null
  trigger_fields?: string[] | null
  trigger_related_field?: string | null
  trigger_op?: string
  trigger_value?: string | null
  target_field: string
  target_type: 'set' | 'clear' | 'relation_field' | 'precedence' | 'pick' | 'lock'
  target_value?: string | null
  sources?: RowRuleSource[]
  only_if_empty?: boolean
  seed_only?: boolean
  sort?: number
  on_update?: boolean
  except_admin?: boolean
  reason?: string | null
}

export const ROW_RULE_SKIP_TYPES = new Set([
  'alias',
  'o2m',
  'm2m',
  'm2a',
  'presentation',
  'group',
  'divider'
])

export const NUMERIC_FIELD_TYPES = new Set([
  'integer',
  'bigInteger',
  'decimal',
  'float',
  'money',
  'smallmoney',
  'tinyint',
  'smallint',
  'bigint'
])

export function reorder<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr
  const next = [...arr]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

export function toFriendlyFieldLabel(field: string): string {
  return field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function fieldTypeHint(
  field: string,
  type: string | undefined,
  m2oRels: Array<{ many_field: string }>,
  o2mRels?: Array<{ one_field: string; many_collection?: string }>
): string {
  // one_field match OR the child-table-name alias form (second grid view on the
  // same relation uses many_collection as its field key — FieldRenderer parity)
  if (o2mRels?.some((r) => r.one_field === field || r.many_collection === field)) return 'O2M'
  if (m2oRels.some((r) => r.many_field === field)) return 'M2O'
  const t = (type ?? '').toLowerCase()
  if (['string', 'nvarchar', 'varchar', 'char', 'text'].some((x) => t.includes(x))) return 'text'
  if (['integer', 'bigint', 'smallint', 'tinyint'].some((x) => t === x) || t === 'int')
    return 'number'
  if (['decimal', 'float', 'double', 'real', 'money', 'numeric'].some((x) => t.includes(x)))
    return 'decimal'
  if (t === 'boolean' || t === 'bit') return 'bool'
  if (t.includes('datetime') || t === 'timestamp') return 'datetime'
  if (t === 'date') return 'date'
  if (t === 'uuid' || t === 'uniqueidentifier') return 'uuid'
  if (t === 'json') return 'json'
  return type ?? ''
}
export const VIA_ID_MARKERS = new Set(['__id__', '__entity__'])

export function ViaValuePicker({
  collection,
  value,
  isMulti,
  onChange
}: {
  collection: string
  value: string | null
  isMulti: boolean
  onChange: (v: string | null) => void
}) {
  const api = useEditorApi()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const selectedIds = value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []

  const { data: collectionMeta } = useQuery<{ display_template?: string | null }>({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data ?? {}),
    enabled: !!collection,
    staleTime: 5 * 60_000
  })

  const displayTemplate = collectionMeta?.display_template ?? null
  const templateFields = displayTemplate ? extractTemplateFields(displayTemplate) : []
  const extraFields = templateFields.filter((f) => f !== 'id')

  const { data: items = [] } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['via-pick-items', collection, search, extraFields.join(',')],
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>> }>(`/items/${collection}`, {
          params: {
            limit: 50,
            ...(search ? { search } : {}),
            ...(extraFields.length ? { fields: ['id', ...extraFields].join(',') } : {})
          }
        })
        .then((r) => r.data.data ?? []),
    enabled: !!collection,
    staleTime: 30_000
  })

  const { data: selectedItems = [] } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['via-pick-selected', collection, selectedIds.join(','), extraFields.join(',')],
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>> }>(`/items/${collection}`, {
          params: {
            filter: JSON.stringify({ id: { _in: selectedIds } }),
            limit: selectedIds.length,
            ...(extraFields.length ? { fields: ['id', ...extraFields].join(',') } : {})
          }
        })
        .then((r) => r.data.data ?? []),
    enabled: selectedIds.length > 0,
    staleTime: 60_000
  })

  function getLabel(item: Record<string, unknown>) {
    return renderDisplayTemplate(displayTemplate, item)
  }

  function toggle(id: string) {
    if (isMulti) {
      const next = selectedIds.includes(id)
        ? selectedIds.filter((s) => s !== id)
        : [...selectedIds, id]
      onChange(next.length ? next.join(',') : null)
    } else {
      onChange(selectedIds[0] === id ? null : id)
      setOpen(false)
    }
  }

  return (
    <div className='space-y-1'>
      {selectedIds.length > 0 && (
        <div className='flex flex-wrap gap-1'>
          {selectedIds.map((id) => {
            const item = selectedItems.find((r) => String(r.id) === id)
            return (
              <span
                key={id}
                className='inline-flex items-center gap-0.5 rounded bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan text-[10px] px-1.5 py-0.5'
              >
                {item ? getLabel(item) : id}
                <button
                  type='button'
                  onClick={() => toggle(id)}
                  className='hover:text-red-400 ml-0.5'
                >
                  ✕
                </button>
              </span>
            )
          })}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='w-full h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left hover:border-slate-400 text-slate-400'
          >
            {isMulti ? '+ add record…' : selectedIds.length ? 'change…' : 'pick record…'}
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-60 p-0' align='start'>
          <Command>
            <CommandInput
              placeholder='Search…'
              className='h-8 text-[12px]'
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandGroup>
                {items.map((item) => {
                  const id = String(item.id ?? '')
                  const isSelected = selectedIds.includes(id)
                  return (
                    <CommandItem
                      key={id}
                      value={`${id} ${getLabel(item)}`}
                      onSelect={() => toggle(id)}
                      className='text-[12px]'
                    >
                      {isMulti && (
                        <Check
                          className={cn(
                            'h-3 w-3 mr-1 shrink-0',
                            isSelected ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                      )}
                      {getLabel(item)}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export function PrecedenceSourceRow({
  source,
  index,
  total,
  m2oRels,
  o2mRels,
  parentContextFields,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown
}: {
  source: RowRuleSource
  index: number
  total: number
  m2oRels: Array<{ many_field: string; one_collection: string }>
  o2mRels: Array<{ one_field: string; many_collection: string }>
  parentContextFields?: Array<{ field: string; label: string; one_collection?: string | null }>
  onChange: (s: RowRuleSource) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const api = useEditorApi()
  const [sfOpen, setSfOpen] = useState(false)
  const [rfOpen, setRfOpen] = useState(false)
  const [ffOpen, setFfOpen] = useState(false)
  const [childColOpen, setChildColOpen] = useState(false)
  const [fvOpen, setFvOpen] = useState(false)
  const [fvSearch, setFvSearch] = useState('')

  const isFiltered = source.source_type === 'o2m_filtered'
  const isParentM2O = source.source_type === 'parent_m2o'
  const hop = source.source_hop ?? 'm2o'

  // For standard types: resolve the related collection for field picker
  const relCollection =
    source.source_type === 'relation_field'
      ? (m2oRels.find((r) => r.many_field === source.source_field)?.one_collection ?? null)
      : source.source_type === 'o2m_first'
        ? (o2mRels.find((r) => r.one_field === source.source_field)?.many_collection ?? null)
        : isParentM2O
          ? (source.source_one_collection ?? null)
          : null

  const { data: relFieldsRaw } = useQuery({
    queryKey: ['field-config-all', relCollection],
    queryFn: () =>
      api
        .get(`/field-config/${relCollection}`)
        .then(
          (r: {
            data: { data?: Array<{ field: string; label?: string | null; type?: string }> }
          }) => r.data.data ?? []
        ),
    enabled: !!relCollection && !isFiltered,
    staleTime: 5 * 60 * 1000
  })
  const relFieldOpts = (relFieldsRaw ?? [])
    .filter(
      (f: { field: string; type?: string }) =>
        f.field !== 'id' && !ROW_RULE_SKIP_TYPES.has(f.type ?? '')
    )
    .map((f: { field: string; label?: string | null }) => ({
      value: f.field,
      label: f.label || f.field
    }))

  const parentM2OOpts = useMemo(
    () =>
      (parentContextFields ?? [])
        .filter((p) => !!p.one_collection)
        .map((p) => ({ value: p.field, label: p.label, one_collection: p.one_collection! })),
    [parentContextFields]
  )

  const sourceFieldOpts = isFiltered
    ? hop === 'm2o'
      ? m2oRels.map((r) => ({ value: r.many_field, label: r.many_field }))
      : o2mRels.map((r) => ({ value: r.one_field, label: r.one_field }))
    : isParentM2O
      ? parentM2OOpts.map((p) => ({ value: p.value, label: p.label }))
      : source.source_type === 'relation_field'
        ? m2oRels.map((r) => ({ value: r.many_field, label: r.many_field }))
        : o2mRels.map((r) => ({ value: r.one_field, label: r.one_field }))

  // For o2m_filtered: resolve intermediate collection to populate child collection picker
  const intermediateCollection = isFiltered
    ? hop === 'm2o'
      ? (m2oRels.find((r) => r.many_field === source.source_field)?.one_collection ?? null)
      : (o2mRels.find((r) => r.one_field === source.source_field)?.many_collection ?? null)
    : null

  const { data: intermediateRelsRaw } = useQuery({
    queryKey: ['relations-for-intermediate', intermediateCollection],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            one_collection?: string
            many_collection?: string
            junction_field?: string | null
          }>
        }>(`/data-model/relations/for/${intermediateCollection}`)
        .then((r) => r.data.data ?? []),
    enabled: isFiltered && !!intermediateCollection && !!source.source_field,
    staleTime: 5 * 60 * 1000
  })
  const childCollectionOpts = useMemo(() => {
    const rels =
      (intermediateRelsRaw as
        | Array<{
            one_collection?: string
            many_collection?: string
            junction_field?: string | null
          }>
        | undefined) ?? []
    return rels
      .filter(
        (r) => r.one_collection === intermediateCollection && r.many_collection && !r.junction_field
      )
      .map((r) => ({ value: r.many_collection!, label: r.many_collection! }))
  }, [intermediateRelsRaw, intermediateCollection])

  // For o2m_filtered: fetch fields of the o2m_collection for filter_field + source_related_field pickers
  const { data: o2mFieldsRaw } = useQuery({
    queryKey: ['field-config-all', source.o2m_collection],
    queryFn: () =>
      api
        .get(`/field-config/${source.o2m_collection}`)
        .then(
          (r: {
            data: { data?: Array<{ field: string; label?: string | null; type?: string }> }
          }) => r.data.data ?? []
        ),
    enabled: isFiltered && !!source.o2m_collection,
    staleTime: 5 * 60 * 1000
  })
  const o2mFieldOpts = (o2mFieldsRaw ?? [])
    .filter((f: { field: string; type?: string }) => !ROW_RULE_SKIP_TYPES.has(f.type ?? ''))
    .map((f: { field: string; label?: string | null }) => ({
      value: f.field,
      label: f.label || f.field
    }))
  const o2mScalarOpts = o2mFieldOpts.filter(
    (f: { value: string; label: string }) => f.value !== 'id'
  )

  const parentFieldOpts = useMemo(
    () =>
      (parentContextFields ?? []).map((p) => ({
        value: `$parent.${p.field}`,
        label: `$parent.${p.field}`
      })),
    [parentContextFields]
  )

  return (
    <div className='relative rounded-md border border-slate-200 bg-white overflow-hidden'>
      {/* Actions — pinned top-right */}
      <div className='absolute top-1 right-1 flex items-center gap-px z-10'>
        <button
          type='button'
          onClick={onMoveUp}
          disabled={index === 0}
          className='h-6 w-6 flex items-center justify-center text-slate-400 hover:text-slate-700 disabled:opacity-20 transition-colors rounded hover:bg-slate-100'
        >
          ↑
        </button>
        <button
          type='button'
          onClick={onMoveDown}
          disabled={index === total - 1}
          className='h-6 w-6 flex items-center justify-center text-slate-400 hover:text-slate-700 disabled:opacity-20 transition-colors rounded hover:bg-slate-100'
        >
          ↓
        </button>
        <button
          type='button'
          onClick={onRemove}
          className='h-6 w-6 flex items-center justify-center text-slate-300 hover:text-red-400 transition-colors rounded hover:bg-red-50'
        >
          ✕
        </button>
      </div>

      {/* Primary row */}
      <div className='flex items-center gap-1.5 flex-wrap px-2 py-1.5 pr-20'>
        <span className='text-[11px] font-medium text-slate-400 w-4 text-right shrink-0 tabular-nums'>
          {index + 1}
        </span>
        <SelectButton
          value={source.source_type}
          opts={[
            { value: 'relation_field', label: 'M2O →' },
            { value: 'o2m_first', label: 'O2M first →' },
            { value: 'o2m_filtered', label: 'filtered child →' },
            { value: 'parent_m2o', label: 'parent M2O →' }
          ]}
          onChange={(v) =>
            onChange({
              source_type: v as RowRuleSource['source_type'],
              source_field: '',
              source_related_field: '',
              source_hop: 'm2o'
            })
          }
        />

        {isFiltered && (
          <SelectButton
            value={hop}
            opts={[
              { value: 'm2o', label: 'via M2O' },
              { value: 'o2m_first', label: 'via O2M first' }
            ]}
            onChange={(v) =>
              onChange({ ...source, source_hop: v as 'm2o' | 'o2m_first', source_field: '' })
            }
          />
        )}

        <Popover open={sfOpen} onOpenChange={setSfOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='h-7 rounded border border-slate-200 bg-slate-50 px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[70px] max-w-[110px] transition-colors'
            >
              {source.source_field || <span className='text-slate-400'>field…</span>}
            </button>
          </PopoverTrigger>
          <PopoverContent className='w-44 p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
              <CommandList>
                <CommandGroup>
                  {sourceFieldOpts.length === 0 ? (
                    <div className='px-3 py-2 text-[11px] text-slate-400'>No relations</div>
                  ) : (
                    sourceFieldOpts.map((f) => (
                      <CommandItem
                        key={f.value}
                        value={f.value}
                        onSelect={() => {
                          const oneCol = isParentM2O
                            ? (parentM2OOpts.find((p) => p.value === f.value)?.one_collection ??
                              undefined)
                            : undefined
                          onChange({
                            ...source,
                            source_field: f.value,
                            source_related_field: '',
                            ...(isParentM2O ? { source_one_collection: oneCol } : {})
                          })
                          setSfOpen(false)
                        }}
                        className='text-[11px]'
                      >
                        {f.label}
                      </CommandItem>
                    ))
                  )}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {!isFiltered && (
          <>
            <span className='text-slate-300 shrink-0'>→</span>
            <Popover open={rfOpen} onOpenChange={setRfOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='h-7 rounded border border-slate-200 bg-slate-50 px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[70px] max-w-[110px] transition-colors'
                >
                  {source.source_related_field ? (
                    (relFieldOpts.find(
                      (f: { value: string }) => f.value === source.source_related_field
                    )?.label ?? source.source_related_field)
                  ) : (
                    <span className='text-slate-400'>{relCollection ? 'field…' : '—'}</span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-44 p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                  <CommandList>
                    <CommandGroup>
                      {relFieldOpts.length === 0 ? (
                        <div className='px-3 py-2 text-[11px] text-slate-400'>No fields</div>
                      ) : (
                        relFieldOpts.map((f: { value: string; label: string }) => (
                          <CommandItem
                            key={f.value}
                            value={f.value}
                            onSelect={() => {
                              onChange({ ...source, source_related_field: f.value })
                              setRfOpen(false)
                            }}
                            className='text-[11px]'
                          >
                            {f.label}
                          </CommandItem>
                        ))
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </>
        )}
      </div>

      {/* Filtered child — condition row */}
      {isFiltered && (
        <div className='border-t border-slate-100 bg-slate-50 px-2 py-1.5'>
          <div className='flex items-center gap-1.5 flex-wrap pl-5'>
            <span className='text-[10px] font-medium text-slate-400 shrink-0 uppercase tracking-wide'>
              in
            </span>
            <Popover open={childColOpen} onOpenChange={setChildColOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='h-6 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[100px] max-w-[140px] transition-colors'
                >
                  {source.o2m_collection || (
                    <span className='text-slate-400'>
                      {intermediateCollection ? 'collection…' : 'pick field first'}
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-48 p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                  <CommandList>
                    <CommandGroup>
                      {childCollectionOpts.length === 0 ? (
                        <div className='px-3 py-2 text-[11px] text-slate-400'>
                          {intermediateCollection ? 'No child relations' : 'Pick field first'}
                        </div>
                      ) : (
                        childCollectionOpts.map((c) => (
                          <CommandItem
                            key={c.value}
                            value={c.value}
                            onSelect={() => {
                              onChange({
                                ...source,
                                o2m_collection: c.value,
                                filter_field: undefined,
                                source_related_field: ''
                              })
                              setChildColOpen(false)
                            }}
                            className='text-[11px]'
                          >
                            {c.label}
                          </CommandItem>
                        ))
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <span className='text-[11px] text-slate-400 shrink-0'>where</span>
            <Popover open={ffOpen} onOpenChange={setFfOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='h-6 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[80px] max-w-[110px] transition-colors'
                >
                  {source.filter_field || <span className='text-slate-400'>field…</span>}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-44 p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                  <CommandList>
                    <CommandGroup>
                      {o2mFieldOpts.length === 0 ? (
                        <div className='px-3 py-2 text-[11px] text-slate-400'>
                          {source.o2m_collection ? 'No fields' : 'Pick collection first'}
                        </div>
                      ) : (
                        o2mFieldOpts.map((f: { value: string; label: string }) => (
                          <CommandItem
                            key={f.value}
                            value={f.value}
                            onSelect={() => {
                              onChange({ ...source, filter_field: f.value })
                              setFfOpen(false)
                            }}
                            className='text-[11px]'
                          >
                            {f.label}
                          </CommandItem>
                        ))
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <span className='text-[11px] text-slate-400 shrink-0'>=</span>
            <Popover
              open={fvOpen}
              onOpenChange={(v) => {
                setFvOpen(v)
                if (!v) setFvSearch('')
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='h-6 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[100px] max-w-[150px] transition-colors font-mono'
                >
                  {source.filter_value || <span className='text-slate-400 font-sans'>value…</span>}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-52 p-0' align='start'>
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder='$parent.field or literal…'
                    className='h-7 text-[11px]'
                    value={fvSearch}
                    onValueChange={setFvSearch}
                  />
                  <CommandList>
                    {parentFieldOpts.filter((p) => !fvSearch || p.value.includes(fvSearch)).length >
                      0 && (
                      <CommandGroup heading='Parent fields'>
                        {parentFieldOpts
                          .filter((p) => !fvSearch || p.value.includes(fvSearch))
                          .map((p) => (
                            <CommandItem
                              key={p.value}
                              value={p.value}
                              onSelect={() => {
                                onChange({ ...source, filter_value: p.value })
                                setFvOpen(false)
                                setFvSearch('')
                              }}
                              className='text-[11px]'
                            >
                              {p.label}
                            </CommandItem>
                          ))}
                      </CommandGroup>
                    )}
                    {fvSearch && (
                      <CommandGroup heading='Use as literal'>
                        <CommandItem
                          value={`__use__${fvSearch}`}
                          onSelect={() => {
                            onChange({ ...source, filter_value: fvSearch })
                            setFvOpen(false)
                            setFvSearch('')
                          }}
                          className='text-[11px] font-mono'
                        >
                          {fvSearch}
                        </CommandItem>
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <span className='text-slate-300 shrink-0'>→</span>
            <Popover open={rfOpen} onOpenChange={setRfOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='h-6 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[80px] max-w-[110px] transition-colors'
                >
                  {source.source_related_field || (
                    <span className='text-slate-400'>{source.o2m_collection ? 'field…' : '—'}</span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-44 p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                  <CommandList>
                    <CommandGroup>
                      {o2mScalarOpts.length === 0 ? (
                        <div className='px-3 py-2 text-[11px] text-slate-400'>
                          {source.o2m_collection ? 'No fields' : 'Enter collection first'}
                        </div>
                      ) : (
                        o2mScalarOpts.map((f: { value: string; label: string }) => (
                          <CommandItem
                            key={f.value}
                            value={f.value}
                            onSelect={() => {
                              onChange({ ...source, source_related_field: f.value })
                              setRfOpen(false)
                            }}
                            className='text-[11px]'
                          >
                            {f.label}
                          </CommandItem>
                        ))
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      )}
    </div>
  )
}

export function SelectButton<T extends string>({
  value,
  opts,
  onChange,
  className
}: {
  value: T
  opts: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const label = opts.find((o) => o.value === value)?.label ?? value
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'h-7 rounded border border-slate-200 bg-white px-2.5 text-[11px] text-slate-700 hover:border-slate-400 flex items-center gap-1 shrink-0 transition-colors',
            className
          )}
        >
          {label}
          <ChevronDown className='h-3 w-3 text-slate-400 ml-0.5 shrink-0' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-auto min-w-[120px] p-1' align='start'>
        {opts.map((o) => (
          <button
            key={o.value}
            type='button'
            onClick={() => {
              onChange(o.value)
              setOpen(false)
            }}
            className={cn(
              'w-full text-left px-2.5 py-1.5 rounded text-[12px] hover:bg-slate-50 transition-colors',
              o.value === value ? 'font-medium text-slate-900 bg-slate-50' : 'text-slate-700'
            )}
          >
            {o.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export function OrTriggerPicker({
  value,
  fieldOpts,
  onChange
}: {
  value: string
  fieldOpts: Array<{ value: string; label: string }>
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex-1 h-6 rounded border border-slate-200 bg-white px-2 text-[10px] text-left truncate hover:border-slate-400 min-w-0'
        >
          {value ? (
            (fieldOpts.find((f) => f.value === value)?.label ?? value)
          ) : (
            <span className='text-slate-400'>field…</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-52 p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
          <CommandList>
            <CommandGroup>
              {fieldOpts.map((f) => (
                <CommandItem
                  key={f.value}
                  value={f.value}
                  onSelect={() => {
                    onChange(f.value)
                    setOpen(false)
                  }}
                  className='text-[11px]'
                >
                  {f.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function RowRuleRow({
  rule,
  childFields,
  m2oRels,
  o2mRels,
  onChange,
  onRemove,
  portalContainer,
  parentContextFields
}: {
  rule: RowRuleItem
  childFields: Array<{ field: string; label?: string | null; type?: string }>
  m2oRels: Array<{ many_field: string; one_collection: string }>
  o2mRels: Array<{ one_field: string; many_collection: string }>
  onChange: (r: RowRuleItem) => void
  onRemove: () => void
  portalContainer?: HTMLElement | null
  parentContextFields?: Array<{ field: string; label: string; one_collection?: string | null }>
}) {
  const api = useEditorApi()
  const [expanded, setExpanded] = useState(!rule.trigger_field)
  const [tfOpen, setTfOpen] = useState(false)
  const [tgtOpen, setTgtOpen] = useState(false)
  const [tvOpen, setTvOpen] = useState(false)
  const [trfOpen, setTrfOpen] = useState(false)
  const [trf2Open, setTrf2Open] = useState(false)
  const [parentTvOpen, setParentTvOpen] = useState(false)
  const [pickOpen, setPickOpen] = useState(false)
  const [pickSearch, setPickSearch] = useState('')
  const fieldOpts = childFields
    .filter((f) => !o2mRels.some((r) => r.one_field === f.field))
    .map((f) => ({
      value: f.field,
      label: toFriendlyFieldLabel(f.field),
      hint: fieldTypeHint(f.field, f.type, m2oRels, o2mRels)
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const isParentTrigger = !!rule.trigger_field && rule.trigger_field.startsWith('$parent.')
  const isTriggerM2O =
    !isParentTrigger &&
    !!rule.trigger_field &&
    !!m2oRels.find((r) => r.many_field === rule.trigger_field)
  const relatedCollection = rule.trigger_field
    ? (m2oRels.find((r) => r.many_field === rule.trigger_field)?.one_collection ?? null)
    : null
  const parentTriggerLabel = isParentTrigger
    ? (parentContextFields?.find((p) => `$parent.${p.field}` === rule.trigger_field)?.label ??
      rule.trigger_field!.slice(8))
    : null
  const parentTriggerOneCollection = isParentTrigger
    ? (parentContextFields?.find((p) => `$parent.${p.field}` === rule.trigger_field)
        ?.one_collection ?? null)
    : null

  // Parse dot-path in trigger_related_field (e.g. "category_type.type")
  const trfParts = (rule.trigger_related_field ?? '').split('.').filter(Boolean)
  const trfSeg1 = trfParts[0] ?? null
  const trfSeg2 = trfParts[1] ?? null

  const { data: relatedFieldsData } = useQuery({
    queryKey: ['field-config-all', relatedCollection],
    queryFn: () =>
      api
        .get(`/field-config/${relatedCollection}`)
        .then(
          (r: {
            data: { data?: Array<{ field: string; label?: string | null; type?: string }> }
          }) => r.data.data ?? []
        ),
    enabled: !!relatedCollection && (rule.target_type === 'relation_field' || isTriggerM2O),
    staleTime: 5 * 60 * 1000
  })

  const relatedFieldOpts = (relatedFieldsData ?? [])
    .filter(
      (f: { field: string; type?: string }) =>
        f.field !== 'id' && !ROW_RULE_SKIP_TYPES.has(f.type ?? '')
    )
    .map((f: { field: string; label?: string | null }) => ({
      value: f.field,
      label: f.label || f.field
    }))

  // Fetch relations on the related collection so we can detect 2nd-level M2O hops
  const { data: relCollRelations } = useQuery({
    queryKey: ['relations-for', relatedCollection],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            many_collection?: string
            many_field?: string
            one_collection?: string
            junction_field?: unknown
          }>
        }>(`/data-model/relations/for/${relatedCollection}`)
        .then((r) => r.data.data ?? []),
    enabled: !!relatedCollection && isTriggerM2O,
    staleTime: 5 * 60 * 1000
  })

  const seg1Rel = trfSeg1
    ? (relCollRelations ?? []).find(
        (r: {
          many_collection?: string
          many_field?: string
          one_collection?: string
          junction_field?: unknown
        }) =>
          r.many_collection === relatedCollection && r.many_field === trfSeg1 && !r.junction_field
      )
    : null
  const relRelCollection =
    (seg1Rel as { one_collection?: string } | null | undefined)?.one_collection ?? null

  const { data: relRelFieldsData } = useQuery({
    queryKey: ['field-config-all', relRelCollection],
    queryFn: () =>
      api
        .get(`/field-config/${relRelCollection}`)
        .then(
          (r: {
            data: { data?: Array<{ field: string; label?: string | null; type?: string }> }
          }) => r.data.data ?? []
        ),
    enabled: !!relRelCollection,
    staleTime: 5 * 60 * 1000
  })

  const relRelFieldOpts = (relRelFieldsData ?? [])
    .filter(
      (f: { field: string; type?: string }) =>
        f.field !== 'id' && !ROW_RULE_SKIP_TYPES.has(f.type ?? '')
    )
    .map((f: { field: string; label?: string | null }) => ({
      value: f.field,
      label: f.label || f.field
    }))

  // Target field M2O detection — for the "pick record" target type
  const targetM2ORel = rule.target_field
    ? m2oRels.find(
        (r: { many_field?: string; junction_field?: unknown }) =>
          r.many_field === rule.target_field && !r.junction_field
      )
    : null
  const targetRelCollection =
    (targetM2ORel as { one_collection?: string } | undefined)?.one_collection ?? null

  const { data: targetRelFieldsData } = useQuery({
    queryKey: ['field-config-all', targetRelCollection, 'pick'],
    queryFn: () =>
      api
        .get(`/field-config/${targetRelCollection}`)
        .then(
          (r: {
            data: { data?: Array<{ field: string; type?: string; label?: string | null }> }
          }) => r.data.data ?? []
        ),
    enabled: !!targetRelCollection && rule.target_type === 'pick',
    staleTime: 5 * 60 * 1000
  })

  const pickDisplayField = useMemo(() => {
    const fields =
      (targetRelFieldsData as Array<{ field: string; type?: string }> | undefined) ?? []
    const preferred = ['name', 'title', 'label', 'display_name', 'subject', 'heading']
    const byName = fields.find((f) => preferred.includes(f.field))
    if (byName) return byName.field
    const textTypes = new Set(['string', 'text', 'varchar', 'nvarchar', 'char'])
    return fields.find((f) => f.field !== 'id' && textTypes.has(f.type ?? ''))?.field ?? null
  }, [targetRelFieldsData])

  const { data: pickItemsData } = useQuery({
    queryKey: ['row-rule-pick-items', targetRelCollection, pickSearch],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '20' })
      if (pickSearch) params.set('search', pickSearch)
      return api
        .get(`/items/${targetRelCollection}?${params}`)
        .then((r: { data: { data?: Array<Record<string, unknown>> } }) => r.data.data ?? [])
    },
    enabled: !!targetRelCollection && rule.target_type === 'pick' && pickOpen,
    staleTime: 30 * 1000
  })

  const pickItems = (pickItemsData as Array<Record<string, unknown>> | undefined) ?? []

  // Fetch the currently-selected pick target record (for label display when popover is closed)
  const { data: pickValueItemData } = useQuery({
    queryKey: ['row-rule-pick-value-item', targetRelCollection, rule.target_value],
    queryFn: () =>
      api
        .get(`/items/${targetRelCollection}/${rule.target_value}`)
        .then((r: { data: { data?: Record<string, unknown> } }) => r.data.data ?? null),
    enabled: !!targetRelCollection && rule.target_type === 'pick' && !!rule.target_value,
    staleTime: 5 * 60 * 1000
  })

  // Trigger value label — resolve FK id to display name when trigger is M2O or parent M2O
  const triggerValueCollection = isParentTrigger
    ? parentTriggerOneCollection
    : isTriggerM2O
      ? relatedCollection
      : null
  const triggerValueIsId =
    !!triggerValueCollection &&
    !!rule.trigger_value &&
    ['eq', 'neq'].includes(rule.trigger_op ?? '')

  const { data: triggerValueItemData } = useQuery({
    queryKey: ['row-rule-trigger-value-item', triggerValueCollection, rule.trigger_value],
    queryFn: () =>
      api
        .get(`/items/${triggerValueCollection}/${rule.trigger_value}`)
        .then((r: { data: { data?: Record<string, unknown> } }) => r.data.data ?? null),
    enabled: triggerValueIsId,
    staleTime: 5 * 60 * 1000
  })

  function resolveItemLabel(
    item: Record<string, unknown> | null | undefined,
    fallback: string | null | undefined
  ): string | null {
    if (!item) return fallback ?? null
    const preferred = ['name', 'title', 'label', 'display_name', 'subject', 'heading']
    const hit =
      preferred.find((k) => item[k] != null && String(item[k]).trim() !== '') ??
      Object.keys(item).find(
        (k) => k !== 'id' && typeof item[k] === 'string' && String(item[k]).trim() !== ''
      )
    return hit ? String(item[hit]) : (fallback ?? null)
  }

  // Op shows after the final resolved field (not mid-hop M2O that still needs a second level)
  const showViaOp = !!rule.trigger_related_field && (!relRelCollection || !!trfSeg2)

  const isViaIdOrEntity = !!trfSeg2 && VIA_ID_MARKERS.has(trfSeg2)

  const showTriggerValue = !!rule.trigger_op && !['null', 'nnull'].includes(rule.trigger_op)
  const showTargetValue = rule.target_type === 'set' || rule.target_type === 'relation_field'
  const showRelatedCombobox = rule.target_type === 'relation_field' && !!relatedCollection
  const showPickCombobox = rule.target_type === 'pick'
  const sources = rule.sources ?? []

  function moveSource(idx: number, dir: -1 | 1) {
    const next = [...sources]
    const tmp = next[idx]
    next[idx] = next[idx + dir]
    next[idx + dir] = tmp
    onChange({ ...rule, sources: next })
  }

  // Build collapsed summary
  const triggerDisplayLabel = isParentTrigger
    ? `↑ ${parentTriggerLabel ?? rule.trigger_field!.slice(8)}`
    : rule.trigger_field
      ? (fieldOpts.find((f) => f.value === rule.trigger_field)?.label ?? rule.trigger_field)
      : null
  const opLabels: Record<string, string> = {
    eq: '=',
    neq: '≠',
    nnull: '≠ empty',
    null: 'is empty',
    in: 'in',
    contains: '~'
  }
  const opStr = opLabels[rule.trigger_op ?? 'nnull'] ?? rule.trigger_op ?? ''
  const resolvedTriggerVal = triggerValueIsId
    ? resolveItemLabel(triggerValueItemData as Record<string, unknown> | null, rule.trigger_value)
    : rule.trigger_value
  const valSnippet = resolvedTriggerVal
    ? ` "${resolvedTriggerVal.length > 20 ? `${resolvedTriggerVal.slice(0, 20)}…` : resolvedTriggerVal}"`
    : ''
  const targetDisplayLabel = rule.target_field
    ? (fieldOpts.find((f) => f.value === rule.target_field)?.label ?? rule.target_field)
    : null
  const resolvedPickVal =
    rule.target_type === 'pick' && rule.target_value
      ? resolveItemLabel(pickValueItemData as Record<string, unknown> | null, rule.target_value)
      : null
  const targetTypeBadge: Record<string, string> = {
    set: '',
    relation_field: 'M2O',
    precedence: 'chain',
    clear: 'clear',
    pick: ''
  }
  const pickSuffix = rule.target_type === 'pick' && resolvedPickVal ? ` = ${resolvedPickVal}` : ''
  const collapsedSummary =
    triggerDisplayLabel && targetDisplayLabel
      ? `${triggerDisplayLabel} ${opStr}${valSnippet} → ${targetDisplayLabel}${pickSuffix}${targetTypeBadge[rule.target_type] ? ` · ${targetTypeBadge[rule.target_type]}` : ''}`
      : triggerDisplayLabel
        ? `${triggerDisplayLabel} ${opStr}${valSnippet} → ?`
        : '(new rule — click to configure)'

  return (
    <div className='rounded-md border border-slate-200 bg-white overflow-hidden'>
      {/* Header — always visible, click to expand/collapse */}
      {/* biome-ignore lint/a11y/useSemanticElements: the header holds its own remove button */}
      <div
        role='button'
        tabIndex={0}
        aria-expanded={expanded}
        className='flex items-center gap-1.5 px-2.5 py-2 cursor-pointer select-none hover:bg-muted transition-colors'
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded((v) => !v)
          }
        }}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 text-slate-400 shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className='flex-1 text-[11px] text-slate-600 truncate min-w-0'>
          {collapsedSummary}
        </span>
        {rule.only_if_empty && (
          <span className='shrink-0 rounded px-1 py-0.5 text-[9px] font-medium bg-amber-50 text-amber-600 border border-amber-100'>
            fallback
          </span>
        )}
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className='shrink-0 text-slate-300 hover:text-red-400 transition-colors ml-1'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>

      {/* Expanded body */}
      {expanded && (
        <>
          {/* IF section */}
          <div className='border-t border-slate-100 px-2.5 py-2 space-y-1.5 bg-slate-50/50'>
            <div className='flex items-start gap-1.5'>
              <span className='text-[9px] font-semibold text-slate-400 mt-[7px] w-5 shrink-0 tracking-wide'>
                IF
              </span>
              <div className='flex-1 min-w-0 space-y-1.5'>
                {/* Trigger field + op */}
                <div className='flex items-center gap-1.5'>
                  <Popover open={tfOpen} onOpenChange={setTfOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type='button'
                        className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-0'
                      >
                        {isParentTrigger ? (
                          <span className='flex items-center gap-1'>
                            <span className='text-[9px] bg-nvr-cyan/10 text-nvr-cyan rounded px-1 py-0.5 shrink-0'>
                              parent
                            </span>
                            {parentTriggerLabel}
                          </span>
                        ) : rule.trigger_field ? (
                          (fieldOpts.find((f) => f.value === rule.trigger_field)?.label ??
                          rule.trigger_field)
                        ) : (
                          <span className='text-slate-400'>when field changes…</span>
                        )}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className='w-52 p-0' align='start' container={portalContainer}>
                      <Command>
                        <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
                        <CommandList className='max-h-[220px]'>
                          {parentContextFields && parentContextFields.length > 0 && (
                            <CommandGroup heading='↑ Parent record'>
                              {parentContextFields.map((p) => (
                                <CommandItem
                                  key={`$parent.${p.field}`}
                                  value={`parent ${p.label} ${p.field}`}
                                  onSelect={() => {
                                    onChange({
                                      ...rule,
                                      trigger_field: `$parent.${p.field}`,
                                      trigger_related_field: null
                                    })
                                    setTfOpen(false)
                                  }}
                                  className='text-[12px] flex items-center justify-between gap-2'
                                >
                                  <span className='truncate'>{p.label}</span>
                                  <span className='shrink-0 text-[9px] bg-nvr-cyan/10 text-nvr-cyan rounded px-1'>
                                    parent
                                  </span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          )}
                          <CommandGroup
                            heading={parentContextFields?.length ? 'Child record' : undefined}
                          >
                            {fieldOpts.map((f) => (
                              <CommandItem
                                key={f.value}
                                value={`${f.label} ${f.value}`}
                                onSelect={() => {
                                  onChange({
                                    ...rule,
                                    trigger_field: f.value,
                                    trigger_related_field: null
                                  })
                                  setTfOpen(false)
                                }}
                                className='text-[12px] flex items-center justify-between gap-2'
                              >
                                <span className='truncate'>{f.label}</span>
                                {f.hint && (
                                  <span className='shrink-0 rounded px-1 py-0.5 text-[9px] font-medium bg-slate-100 text-slate-500'>
                                    {f.hint}
                                  </span>
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  {!trfSeg1 && (
                    <SelectButton
                      value={(rule.trigger_op ?? 'nnull') as string}
                      opts={[
                        { value: 'nnull', label: 'has value' },
                        { value: 'null', label: 'is empty' },
                        { value: 'eq', label: 'equals' },
                        { value: 'neq', label: '≠' },
                        { value: 'in', label: 'in list' },
                        { value: 'contains', label: 'contains' }
                      ]}
                      onChange={(v) => onChange({ ...rule, trigger_op: v })}
                    />
                  )}
                </div>

                {/* Via related field — M2O drill-down */}
                {isTriggerM2O && (
                  <div className='flex items-center gap-1.5 flex-wrap'>
                    <span className='text-[10px] text-slate-400 shrink-0'>via:</span>
                    <Popover open={trfOpen} onOpenChange={setTrfOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type='button'
                          className='flex-1 h-6 rounded border border-slate-200 bg-white px-2 text-[10px] text-left truncate hover:border-slate-400 min-w-0'
                        >
                          {trfSeg1 ? (
                            (relatedFieldOpts.find((f: { value: string }) => f.value === trfSeg1)
                              ?.label ?? trfSeg1)
                          ) : (
                            <span className='text-slate-400 italic'>FK id (direct)</span>
                          )}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        className='w-48 p-0'
                        align='start'
                        container={portalContainer}
                      >
                        <Command>
                          <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                          <CommandList className='max-h-[180px]'>
                            <CommandGroup>
                              <CommandItem
                                value='__none__'
                                onSelect={() => {
                                  onChange({ ...rule, trigger_related_field: null })
                                  setTrfOpen(false)
                                }}
                                className='text-[11px] text-slate-400 italic'
                              >
                                FK id (direct)
                              </CommandItem>
                              {relatedFieldOpts.map((f: { value: string; label: string }) => (
                                <CommandItem
                                  key={f.value}
                                  value={f.value}
                                  onSelect={() => {
                                    onChange({ ...rule, trigger_related_field: f.value })
                                    setTrfOpen(false)
                                  }}
                                  className='text-[11px]'
                                >
                                  {f.label}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                    {trfSeg1 && relRelCollection && (
                      <>
                        <span className='text-[10px] text-slate-400 shrink-0'>→</span>
                        <Popover open={trf2Open} onOpenChange={setTrf2Open}>
                          <PopoverTrigger asChild>
                            <button
                              type='button'
                              className='flex-1 h-6 rounded border border-slate-200 bg-white px-2 text-[10px] text-left truncate hover:border-slate-400 min-w-0'
                            >
                              {trfSeg2 === '__entity__' || trfSeg2 === '__id__' ? (
                                <span className='italic'>(entity)</span>
                              ) : trfSeg2 ? (
                                (relRelFieldOpts.find((f: { value: string }) => f.value === trfSeg2)
                                  ?.label ?? trfSeg2)
                              ) : (
                                <span className='text-slate-400 italic'>field…</span>
                              )}
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className='w-48 p-0'
                            align='start'
                            container={portalContainer}
                          >
                            <Command>
                              <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                              <CommandList className='max-h-[180px]'>
                                <CommandGroup>
                                  <CommandItem
                                    value='__entity__'
                                    onSelect={() => {
                                      onChange({
                                        ...rule,
                                        trigger_related_field: `${trfSeg1}.__entity__`,
                                        trigger_value: null
                                      })
                                      setTrf2Open(false)
                                    }}
                                    className='text-[11px] italic text-slate-500'
                                  >
                                    (entity) — record picker
                                  </CommandItem>
                                  {relRelFieldOpts.map((f: { value: string; label: string }) => (
                                    <CommandItem
                                      key={f.value}
                                      value={f.value}
                                      onSelect={() => {
                                        onChange({
                                          ...rule,
                                          trigger_related_field: `${trfSeg1}.${f.value}`,
                                          trigger_value: null
                                        })
                                        setTrf2Open(false)
                                      }}
                                      className='text-[11px]'
                                    >
                                      {f.label}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      </>
                    )}
                    {showViaOp && (
                      <SelectButton
                        value={(rule.trigger_op ?? 'nnull') as string}
                        opts={[
                          { value: 'nnull', label: 'has value' },
                          { value: 'null', label: 'is empty' },
                          { value: 'eq', label: 'equals' },
                          { value: 'neq', label: '≠' },
                          { value: 'in', label: 'in list' },
                          { value: 'contains', label: 'contains' }
                        ]}
                        onChange={(v) => onChange({ ...rule, trigger_op: v })}
                      />
                    )}
                  </div>
                )}

                {/* Trigger value */}
                {showTriggerValue &&
                  (isViaIdOrEntity && relRelCollection ? (
                    <ViaValuePicker
                      collection={relRelCollection}
                      value={rule.trigger_value ?? null}
                      isMulti={rule.trigger_op === 'in'}
                      onChange={(v) => onChange({ ...rule, trigger_value: v })}
                    />
                  ) : isParentTrigger && parentTriggerOneCollection ? (
                    <ViaValuePicker
                      collection={parentTriggerOneCollection}
                      value={rule.trigger_value ?? null}
                      isMulti={rule.trigger_op === 'in'}
                      onChange={(v) => onChange({ ...rule, trigger_value: v })}
                    />
                  ) : (
                    <input
                      type='text'
                      value={rule.trigger_value ?? ''}
                      onChange={(e) => onChange({ ...rule, trigger_value: e.target.value || null })}
                      placeholder={
                        rule.trigger_op === 'in'
                          ? 'val1, val2 (comma-separated)'
                          : 'value (or $parent.field_name)'
                      }
                      className='w-full h-7 rounded border border-slate-200 bg-white px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
                    />
                  ))}

                {/* Extra OR triggers */}
                {(rule.trigger_fields ?? []).map((tf, i) => (
                  <div key={i} className='flex items-center gap-1'>
                    <span className='text-[10px] text-slate-400 shrink-0 italic'>or</span>
                    <OrTriggerPicker
                      value={tf}
                      fieldOpts={fieldOpts}
                      onChange={(v) => {
                        const next = [...(rule.trigger_fields ?? [])]
                        next[i] = v
                        onChange({ ...rule, trigger_fields: next })
                      }}
                    />
                    <button
                      type='button'
                      onClick={() =>
                        onChange({
                          ...rule,
                          trigger_fields: (rule.trigger_fields ?? []).filter((_, j) => j !== i)
                        })
                      }
                      className='shrink-0 text-slate-300 hover:text-red-400 text-[10px] px-0.5'
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {rule.trigger_field && (
                  <button
                    type='button'
                    onClick={() =>
                      onChange({ ...rule, trigger_fields: [...(rule.trigger_fields ?? []), ''] })
                    }
                    className='text-[10px] text-nvr-cyan hover:underline'
                  >
                    + or when another field changes
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* SET section */}
          <div className='border-t border-slate-100 px-2.5 py-2 space-y-1.5'>
            <div className='flex items-start gap-1.5'>
              <span className='text-[10px] font-semibold text-slate-500 mt-[7px] w-5 shrink-0 tracking-wide'>
                SET
              </span>
              <div className='flex-1 min-w-0 space-y-1.5'>
                {/* Target field + type */}
                <div className='flex items-center gap-1.5'>
                  <Popover open={tgtOpen} onOpenChange={setTgtOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type='button'
                        className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-0'
                      >
                        {rule.target_field ? (
                          (fieldOpts.find((f) => f.value === rule.target_field)?.label ??
                          rule.target_field)
                        ) : (
                          <span className='text-slate-400'>target field…</span>
                        )}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className='w-52 p-0' align='start' container={portalContainer}>
                      <Command>
                        <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
                        <CommandList className='max-h-[180px]'>
                          <CommandGroup>
                            {fieldOpts.map((f) => (
                              <CommandItem
                                key={f.value}
                                value={`${f.label} ${f.value}`}
                                onSelect={() => {
                                  onChange({ ...rule, target_field: f.value })
                                  setTgtOpen(false)
                                }}
                                className='text-[12px] flex items-center justify-between gap-2'
                              >
                                <span className='truncate'>{f.label}</span>
                                {f.hint && (
                                  <span className='shrink-0 rounded px-1 py-0.5 text-[9px] font-medium bg-slate-100 text-slate-500'>
                                    {f.hint}
                                  </span>
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <SelectButton
                    value={rule.target_type}
                    opts={[
                      { value: 'set', label: '= literal' },
                      { value: 'pick', label: '= pick record' },
                      { value: 'relation_field', label: '= from M2O' },
                      { value: 'precedence', label: '= chain' },
                      { value: 'clear', label: '= clear' },
                      { value: 'lock', label: '🔒 lock (read-only while matched)' }
                    ]}
                    onChange={(v) =>
                      onChange({
                        ...rule,
                        target_type: v as RowRuleItem['target_type'],
                        target_value: null,
                        sources: []
                      })
                    }
                  />
                </div>

                {/* Target value: relation_field combobox */}
                {showTargetValue && showRelatedCombobox && (
                  <Popover open={tvOpen} onOpenChange={setTvOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type='button'
                        className='w-full h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400'
                      >
                        {rule.target_value ? (
                          (relatedFieldOpts.find(
                            (f: { value: string }) => f.value === rule.target_value
                          )?.label ?? rule.target_value)
                        ) : (
                          <span className='text-slate-400'>field from {relatedCollection}…</span>
                        )}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className='w-52 p-0' align='start' container={portalContainer}>
                      <Command>
                        <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
                        <CommandList className='max-h-[180px]'>
                          <CommandGroup>
                            {relatedFieldOpts.length === 0 ? (
                              <div className='px-3 py-2 text-[11px] text-slate-400'>
                                No fields found
                              </div>
                            ) : (
                              relatedFieldOpts.map((f: { value: string; label: string }) => (
                                <CommandItem
                                  key={f.value}
                                  value={f.value}
                                  onSelect={() => {
                                    onChange({ ...rule, target_value: f.value })
                                    setTvOpen(false)
                                  }}
                                  className='text-[12px]'
                                >
                                  {f.label}
                                </CommandItem>
                              ))
                            )}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                )}

                {/* Target value: literal input */}
                {showTargetValue && !showRelatedCombobox && (
                  <div className='flex gap-1'>
                    <input
                      type='text'
                      value={rule.target_value ?? ''}
                      onChange={(e) => onChange({ ...rule, target_value: e.target.value || null })}
                      placeholder={
                        rule.target_type === 'relation_field'
                          ? 'select an M2O trigger field first'
                          : 'value'
                      }
                      className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan min-w-0'
                      readOnly={rule.target_type === 'relation_field'}
                    />
                    {parentContextFields &&
                      parentContextFields.length > 0 &&
                      rule.target_type === 'set' && (
                        <Popover open={parentTvOpen} onOpenChange={setParentTvOpen}>
                          <PopoverTrigger asChild>
                            <button
                              type='button'
                              title='Use parent field value'
                              className='h-7 px-1.5 rounded border border-slate-200 bg-white text-[10px] text-nvr-cyan hover:border-nvr-cyan shrink-0'
                            >
                              ↑
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className='w-52 p-0'
                            align='end'
                            container={portalContainer}
                          >
                            <Command>
                              <CommandList className='max-h-[180px]'>
                                <CommandGroup heading='Copy from parent'>
                                  {parentContextFields.map((p) => (
                                    <CommandItem
                                      key={p.field}
                                      value={`${p.label} ${p.field}`}
                                      onSelect={() => {
                                        onChange({ ...rule, target_value: `$parent.${p.field}` })
                                        setParentTvOpen(false)
                                      }}
                                      className='text-[12px] flex items-center justify-between gap-2'
                                    >
                                      <span className='truncate'>{p.label}</span>
                                      <span className='shrink-0 text-[9px] font-mono text-slate-400'>
                                        {p.field}
                                      </span>
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      )}
                  </div>
                )}

                {/* Pick record combobox */}
                {showPickCombobox &&
                  (!targetRelCollection ? (
                    <p className='text-[10px] text-slate-400 italic'>
                      Select an M2O target field first
                    </p>
                  ) : (
                    <Popover open={pickOpen} onOpenChange={setPickOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type='button'
                          className='w-full h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400'
                        >
                          {rule.target_value ? (
                            (resolveItemLabel(
                              pickValueItemData as Record<string, unknown> | null,
                              rule.target_value
                            ) ?? String(rule.target_value))
                          ) : (
                            <span className='text-slate-400'>pick from {targetRelCollection}…</span>
                          )}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        className='w-56 p-0'
                        align='start'
                        container={portalContainer}
                      >
                        <Command>
                          <CommandInput
                            placeholder='Search…'
                            className='h-8 text-[12px]'
                            value={pickSearch}
                            onValueChange={setPickSearch}
                          />
                          <CommandList className='max-h-[180px]'>
                            <CommandGroup>
                              {pickItems.length === 0 ? (
                                <div className='px-3 py-2 text-[11px] text-slate-400'>
                                  No records found
                                </div>
                              ) : (
                                pickItems.map((item) => {
                                  const id = String(item.id)
                                  const label =
                                    pickDisplayField && item[pickDisplayField] != null
                                      ? String(item[pickDisplayField])
                                      : id
                                  return (
                                    <CommandItem
                                      key={id}
                                      value={`${label} ${id}`}
                                      onSelect={() => {
                                        onChange({ ...rule, target_value: id })
                                        setPickOpen(false)
                                      }}
                                      className='text-[12px] flex items-center justify-between gap-2'
                                    >
                                      <span className='truncate'>{label}</span>
                                      {label !== id && (
                                        <span className='shrink-0 font-mono text-[9px] text-slate-400'>
                                          {id}
                                        </span>
                                      )}
                                    </CommandItem>
                                  )
                                })
                              )}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  ))}

                {/* Precedence chain sources */}
                {rule.target_type === 'precedence' && (
                  <div className='space-y-1.5 pt-0.5'>
                    <p className='text-[11px] text-slate-500 font-medium'>
                      Sources — first non-null wins:
                    </p>
                    {sources.map((src, idx) => (
                      <PrecedenceSourceRow
                        key={idx}
                        source={src}
                        index={idx}
                        total={sources.length}
                        m2oRels={m2oRels}
                        o2mRels={o2mRels}
                        parentContextFields={parentContextFields}
                        onChange={(updated) =>
                          onChange({
                            ...rule,
                            sources: sources.map((s, i) => (i === idx ? updated : s))
                          })
                        }
                        onRemove={() =>
                          onChange({ ...rule, sources: sources.filter((_, i) => i !== idx) })
                        }
                        onMoveUp={() => moveSource(idx, -1)}
                        onMoveDown={() => moveSource(idx, 1)}
                      />
                    ))}
                    <button
                      type='button'
                      onClick={() =>
                        onChange({
                          ...rule,
                          sources: [
                            ...sources,
                            {
                              source_type: 'relation_field',
                              source_field: '',
                              source_related_field: ''
                            }
                          ]
                        })
                      }
                      className='text-[11px] text-nvr-cyan hover:text-nvr-cyan/80 font-medium transition-colors'
                    >
                      + Add source
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className='border-t border-slate-100 px-2.5 py-1.5 bg-slate-50/50'>
            <label className='flex items-center gap-2 cursor-pointer'>
              <input
                type='checkbox'
                checked={!!rule.only_if_empty}
                onChange={(e) => onChange({ ...rule, only_if_empty: e.target.checked })}
                className='h-3.5 w-3.5 accent-nvr-cyan'
              />
              <span className='text-[11px] text-slate-600'>
                Only set if target is currently empty
              </span>
            </label>
            {rule.target_type !== 'lock' && (
              <label className='mt-1 flex items-center gap-2 cursor-pointer'>
                <input
                  type='checkbox'
                  checked={!!rule.seed_only}
                  onChange={(e) => onChange({ ...rule, seed_only: e.target.checked })}
                  className='h-3.5 w-3.5 accent-nvr-cyan'
                />
                <span
                  className='text-[11px] text-slate-600'
                  title='The target is an input this rule only seeds when empty (a project default). Re-run rules never blanks it to re-derive, and Data Integrity never reports it as drift.'
                >
                  Seed only — target is an input, never re-derived
                </span>
              </label>
            )}
            {rule.target_type === 'lock' && (
              <div className='mt-1 space-y-1'>
                <label className='flex items-center gap-2 cursor-pointer'>
                  <input
                    type='checkbox'
                    checked={rule.except_admin === true}
                    onChange={(e) => {
                      const next = { ...rule }
                      if (e.target.checked) next.except_admin = true
                      else delete next.except_admin
                      onChange(next)
                    }}
                    className='h-3.5 w-3.5 accent-nvr-cyan'
                  />
                  <span
                    className='text-[11px] text-slate-600'
                    title='Admins (role admin_access) keep editing the field — the lock binds everyone else, in the grid and on API writes.'
                  >
                    Except admins — view only for non-admins
                  </span>
                </label>
                <input
                  value={rule.reason ?? ''}
                  onChange={(e) => onChange({ ...rule, reason: e.target.value || null })}
                  placeholder='Lock message shown on hover (optional) — e.g. "set by the rules; ask an admin"'
                  className='h-7 w-full rounded border border-slate-200 bg-white px-2 text-[11px]'
                />
              </div>
            )}
            {rule.target_type !== 'lock' && (
              <label className='mt-1 flex items-center gap-2 cursor-pointer'>
                <input
                  type='checkbox'
                  checked={rule.on_update !== false}
                  onChange={(e) => {
                    const next = { ...rule }
                    if (e.target.checked) delete next.on_update
                    else next.on_update = false
                    onChange(next)
                  }}
                  className='h-3.5 w-3.5 accent-nvr-cyan'
                />
                <span
                  className='text-[11px] text-slate-600'
                  title='On by default: an API PATCH that changes one of this rule&apos;s trigger fields re-derives the target, the same way the form does on edit (a target the caller sent explicitly still wins). Untick to run this rule on creates only.'
                >
                  Re-run on API updates when a trigger field changes
                </span>
              </label>
            )}
          </div>
        </>
      )}
    </div>
  )
}
