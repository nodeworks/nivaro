import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronLeft, ChevronRight, Loader2, Plus, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type CMSField, type CMSRelation } from '@/lib/api'
import { titleCase } from '@/lib/utils'

export type ActiveFilter = {
  id: string
  path: string[]
  pathLabels: string[]
  fieldType: string
  op: string
  value: string
}

interface FilterBarProps {
  collection: string
  fields: CMSField[]
  relations: CMSRelation[]
  value: ActiveFilter[]
  onChange: (filters: ActiveFilter[]) => void
  searchValue: string
  onSearchChange: (v: string) => void
}

const OPS_STRING = [
  { label: 'Contains', value: '_contains' },
  { label: "Doesn't contain", value: '_ncontains' },
  { label: 'Equals', value: '_eq' },
  { label: 'Not equals', value: '_neq' },
  { label: 'Starts with', value: '_starts_with' },
  { label: 'Ends with', value: '_ends_with' },
  { label: 'Is empty', value: '_null' },
  { label: 'Is not empty', value: '_nnull' }
]

const OPS_NUMBER = [
  { label: 'Equals', value: '_eq' },
  { label: 'Not equals', value: '_neq' },
  { label: 'Less than', value: '_lt' },
  { label: 'Less than or equal', value: '_lte' },
  { label: 'Greater than', value: '_gt' },
  { label: 'Greater than or equal', value: '_gte' },
  { label: 'Is empty', value: '_null' },
  { label: 'Is not empty', value: '_nnull' }
]

const OPS_DATE = [
  { label: 'Equals', value: '_eq' },
  { label: 'Before', value: '_lt' },
  { label: 'After', value: '_gt' },
  { label: 'Is empty', value: '_null' },
  { label: 'Is not empty', value: '_nnull' }
]

const OPS_BY_TYPE: Record<string, { label: string; value: string }[]> = {
  string: OPS_STRING,
  text: OPS_STRING,
  integer: OPS_NUMBER,
  decimal: OPS_NUMBER,
  float: OPS_NUMBER,
  boolean: [
    { label: 'Is true', value: '_eq:true' },
    { label: 'Is false', value: '_eq:false' },
    { label: 'Is empty', value: '_null' }
  ],
  date: OPS_DATE,
  datetime: OPS_DATE,
  timestamp: OPS_DATE,
  uuid: [
    { label: 'Equals', value: '_eq' },
    { label: 'Not equals', value: '_neq' },
    { label: 'Is empty', value: '_null' },
    { label: 'Is not empty', value: '_nnull' }
  ]
}

function getOps(type: string) {
  return OPS_BY_TYPE[type] ?? OPS_STRING
}

function opLabel(op: string): string {
  for (const list of Object.values(OPS_BY_TYPE)) {
    const found = list.find((o) => o.value === op)
    if (found) return found.label
  }
  return op
}

function isM2O(relations: CMSRelation[], collection: string, field: string): CMSRelation | null {
  return (
    relations.find(
      (r) => r.many_collection === collection && r.many_field === field && r.one_collection
    ) ?? null
  )
}

function needsNoValue(op: string): boolean {
  return op === '_null' || op === '_nnull'
}

export function FilterBar({
  collection,
  fields,
  relations,
  value,
  onChange,
  searchValue,
  onSearchChange
}: FilterBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickerOpen) return
    function onClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [pickerOpen])

  return (
    <div className='relative flex flex-wrap items-center gap-2'>
      <div className='relative'>
        <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
        <input
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder='Search…'
          className='h-8 rounded-md border border-slate-200 bg-white pl-8 pr-3 text-[13px] placeholder-slate-400 focus:border-nvr-cyan/50 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
        />
      </div>

      {value.map((f) => (
        <span
          key={f.id}
          className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px]'
        >
          <span className='text-slate-500'>{f.pathLabels.join(' → ')}</span>
          <span className='font-semibold text-slate-700'>{opLabel(f.op)}</span>
          {f.value && <span className='text-nvr-cyan'>{f.value}</span>}
          <button
            type='button'
            onClick={() => onChange(value.filter((x) => x.id !== f.id))}
            className='ml-1 text-slate-400 hover:text-red-500'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}

      <div className='relative' ref={pickerRef}>
        <button
          type='button'
          onClick={() => setPickerOpen((v) => !v)}
          className='inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-slate-300 px-3 text-[12px] text-slate-500 hover:border-slate-400 hover:text-slate-700'
        >
          <Plus className='h-3.5 w-3.5' />
          Add Filter
        </button>
        {pickerOpen && (
          <FieldPickerDropdown
            collection={collection}
            fields={fields}
            relations={relations}
            onApply={(filter) => {
              onChange([...value, filter])
              setPickerOpen(false)
            }}
          />
        )}
      </div>
    </div>
  )
}

type Stage = 'picking_field' | 'picking_operator' | 'picking_value'

interface SelectedLeaf {
  path: string[]
  pathLabels: string[]
  fieldType: string
}

function FieldPickerDropdown({
  collection,
  fields,
  relations,
  onApply
}: {
  collection: string
  fields: CMSField[]
  relations: CMSRelation[]
  onApply: (filter: ActiveFilter) => void
}) {
  const [stage, setStage] = useState<Stage>('picking_field')
  const [selected, setSelected] = useState<SelectedLeaf | null>(null)
  const [op, setOp] = useState<string>('')

  return (
    <div className='absolute left-0 top-full z-50 mt-1 w-72 rounded-xl border border-slate-200 bg-white shadow-lg'>
      {stage === 'picking_field' && (
        <FieldStage
          collection={collection}
          fields={fields}
          relations={relations}
          onSelectLeaf={(leaf) => {
            setSelected(leaf)
            setStage('picking_operator')
          }}
        />
      )}

      {stage === 'picking_operator' && selected && (
        <OperatorStage
          selected={selected}
          onBack={() => setStage('picking_field')}
          onSelect={(chosen) => {
            setOp(chosen)
            if (needsNoValue(chosen) || chosen.includes(':')) {
              const baseOp = chosen.includes(':') ? chosen.split(':')[0] : chosen
              const presetVal = chosen.includes(':') ? chosen.split(':')[1] : ''
              onApply({
                id: crypto.randomUUID(),
                path: selected.path,
                pathLabels: selected.pathLabels,
                fieldType: selected.fieldType,
                op: chosen,
                value: needsNoValue(baseOp) ? '' : presetVal
              })
            } else {
              setStage('picking_value')
            }
          }}
        />
      )}

      {stage === 'picking_value' && selected && (
        <ValueStage
          selected={selected}
          op={op}
          onBack={() => setStage('picking_operator')}
          onApply={(val) =>
            onApply({
              id: crypto.randomUUID(),
              path: selected.path,
              pathLabels: selected.pathLabels,
              fieldType: selected.fieldType,
              op,
              value: val
            })
          }
        />
      )}
    </div>
  )
}

function FieldStage({
  collection,
  fields,
  relations,
  onSelectLeaf
}: {
  collection: string
  fields: CMSField[]
  relations: CMSRelation[]
  onSelectLeaf: (leaf: SelectedLeaf) => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const filtered = fields.filter((f) => f.field.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div className='p-2'>
      <div className='relative mb-1.5'>
        <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Search fields…'
          className='h-8 w-full rounded-md border border-slate-200 bg-slate-50 pl-8 pr-3 text-[13px] placeholder-slate-400 focus:border-nvr-cyan/50 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
        />
      </div>
      <div className='max-h-72 overflow-y-auto'>
        {filtered.map((f) => (
          <FieldRow
            key={f.field}
            field={f}
            collection={collection}
            relations={relations}
            pathPrefix={[]}
            labelPrefix={[]}
            onSelectLeaf={onSelectLeaf}
          />
        ))}
        {filtered.length === 0 && (
          <div className='px-2 py-3 text-center text-[12px] text-slate-400'>No fields</div>
        )}
      </div>
    </div>
  )
}

function FieldRow({
  field,
  collection,
  relations,
  pathPrefix,
  labelPrefix,
  onSelectLeaf,
  depth = 0
}: {
  field: CMSField
  collection: string
  relations: CMSRelation[]
  pathPrefix: string[]
  labelPrefix: string[]
  onSelectLeaf: (leaf: SelectedLeaf) => void
  depth?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const rel = isM2O(relations, collection, field.field)
  const label = titleCase(field.field)

  if (rel?.one_collection) {
    return (
      <div>
        <button
          type='button'
          onClick={() => setExpanded((v) => !v)}
          className='flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-50'
          style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
        >
          <span>{label}</span>
          {expanded ? (
            <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
          ) : (
            <ChevronRight className='h-3.5 w-3.5 text-slate-400' />
          )}
        </button>
        {expanded && (
          <RelatedFields
            relatedCollection={rel.one_collection}
            pathPrefix={[...pathPrefix, field.field]}
            labelPrefix={[...labelPrefix, label]}
            onSelectLeaf={onSelectLeaf}
            depth={depth + 1}
          />
        )}
      </div>
    )
  }

  return (
    <button
      type='button'
      onClick={() =>
        onSelectLeaf({
          path: [...pathPrefix, field.field],
          pathLabels: [...labelPrefix, label],
          fieldType: field.type
        })
      }
      className='w-full rounded-md px-2 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-50'
      style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
    >
      {label}
    </button>
  )
}

function RelatedFields({
  relatedCollection,
  pathPrefix,
  labelPrefix,
  onSelectLeaf,
  depth
}: {
  relatedCollection: string
  pathPrefix: string[]
  labelPrefix: string[]
  onSelectLeaf: (leaf: SelectedLeaf) => void
  depth: number
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data)
  })

  if (isLoading) {
    return (
      <div
        className='flex items-center gap-2 px-2 py-2 text-[12px] text-slate-400'
        style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
      >
        <Loader2 className='h-3.5 w-3.5 animate-spin' />
        Loading…
      </div>
    )
  }

  const relFields: CMSField[] = (data?.fields ?? []).filter((f: CMSField) => !f.hidden)
  const relRelations: CMSRelation[] = data?.relations ?? []

  // One more level of expansion is allowed; beyond that, treat M2O as leaf to bound depth.
  const allowDeeper = depth < 2

  return (
    <div>
      {relFields.map((f) => {
        const childRel = isM2O(relRelations, relatedCollection, f.field)
        if (childRel?.one_collection && allowDeeper) {
          return (
            <FieldRow
              key={f.field}
              field={f}
              collection={relatedCollection}
              relations={relRelations}
              pathPrefix={pathPrefix}
              labelPrefix={labelPrefix}
              onSelectLeaf={onSelectLeaf}
              depth={depth}
            />
          )
        }
        return (
          <button
            key={f.field}
            type='button'
            onClick={() =>
              onSelectLeaf({
                path: [...pathPrefix, f.field],
                pathLabels: [...labelPrefix, titleCase(f.field)],
                fieldType: f.type
              })
            }
            className='w-full rounded-md px-2 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-50'
            style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
          >
            {titleCase(f.field)}
          </button>
        )
      })}
      {relFields.length === 0 && (
        <div
          className='px-2 py-1.5 text-[12px] text-slate-400'
          style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
        >
          No fields
        </div>
      )}
    </div>
  )
}

function StageHeader({ children, onBack }: { children: React.ReactNode; onBack?: () => void }) {
  return (
    <div className='flex items-center gap-1.5 border-b border-slate-100 px-2.5 py-2'>
      {onBack && (
        <button type='button' onClick={onBack} className='text-slate-400 hover:text-slate-700'>
          <ChevronLeft className='h-3.5 w-3.5' />
        </button>
      )}
      <span className='truncate text-[12px] font-medium text-slate-600'>{children}</span>
    </div>
  )
}

function OperatorStage({
  selected,
  onBack,
  onSelect
}: {
  selected: SelectedLeaf
  onBack: () => void
  onSelect: (op: string) => void
}) {
  return (
    <div>
      <StageHeader onBack={onBack}>{selected.pathLabels.join(' → ')}</StageHeader>
      <div className='max-h-72 overflow-y-auto p-1.5'>
        {getOps(selected.fieldType).map((o) => (
          <button
            key={o.value}
            type='button'
            onClick={() => onSelect(o.value)}
            className='w-full rounded-md px-2 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-50'
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ValueStage({
  selected,
  op,
  onBack,
  onApply
}: {
  selected: SelectedLeaf
  op: string
  onBack: () => void
  onApply: (value: string) => void
}) {
  const [val, setVal] = useState('')
  const valRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    valRef.current?.focus()
  }, [])

  return (
    <div>
      <StageHeader onBack={onBack}>
        {selected.pathLabels.join(' → ')} · {opLabel(op)}
      </StageHeader>
      <div className='space-y-2 p-2.5'>
        {selected.fieldType === 'boolean' ? (
          <select
            value={val}
            onChange={(e) => setVal(e.target.value)}
            className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[13px] focus:border-nvr-cyan/50 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
          >
            <option value=''>Select…</option>
            <option value='true'>True</option>
            <option value='false'>False</option>
          </select>
        ) : (
          <input
            ref={valRef}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && val) onApply(val)
            }}
            placeholder='Value…'
            className='h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[13px] placeholder-slate-400 focus:border-nvr-cyan/50 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
          />
        )}
        <button
          type='button'
          disabled={!val}
          onClick={() => onApply(val)}
          className='h-8 w-full rounded-md bg-nvr-cyan text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40'
        >
          Apply
        </button>
      </div>
    </div>
  )
}
