import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Search, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { api, type CMSField, type CMSRelation } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RuleCondition {
  field: string
  op: string
  value: unknown
}

interface ConditionRowProps {
  condition: RuleCondition
  collection: string
  onChange: (updated: RuleCondition) => void
  onRemove: () => void
}

export interface FieldOption {
  field: string
  type: string
  interface: string | null
  relationType?: 'M2O' | 'O2M' | 'M2M'
  relatedCollection?: string
}

// ─── Relation field builder ──────────────────────────────────────────────────

function buildAllFields(
  fields: CMSField[],
  relations: CMSRelation[],
  collection: string
): FieldOption[] {
  const existing = new Set(fields.map((f) => f.field))
  const options: FieldOption[] = fields.map((f) => ({
    field: f.field,
    type: f.type,
    interface: f.interface
  }))

  for (const rel of relations) {
    if (rel.many_collection === collection && !rel.junction_field && rel.many_field) {
      // M2O: FK column lives on this collection
      if (!existing.has(rel.many_field)) {
        options.push({
          field: rel.many_field,
          type: 'integer',
          interface: 'm2o',
          relationType: 'M2O',
          relatedCollection: rel.one_collection ?? undefined
        })
        existing.add(rel.many_field)
      } else {
        const f = options.find((o) => o.field === rel.many_field)
        if (f) {
          f.relationType = 'M2O'
          f.relatedCollection = rel.one_collection ?? undefined
        }
      }
    } else if (rel.one_collection === collection && rel.one_field) {
      // O2M or M2M: virtual field on this (one) side
      if (!existing.has(rel.one_field)) {
        const relationType = rel.junction_field ? 'M2M' : 'O2M'
        options.push({
          field: rel.one_field,
          type: relationType.toLowerCase(),
          interface: relationType.toLowerCase(),
          relationType,
          relatedCollection: rel.many_collection
        })
        existing.add(rel.one_field)
      } else {
        const f = options.find((o) => o.field === rel.one_field)
        if (f) {
          f.relationType = rel.junction_field ? 'M2M' : 'O2M'
          f.relatedCollection = rel.many_collection
        }
      }
    }
  }

  return options
}

// ─── Operator config ──────────────────────────────────────────────────────────

function getOperators(
  type: string,
  iface: string | null,
  relationType?: string
): Array<{ value: string; label: string }> {
  const isM2O = relationType === 'M2O' || iface?.includes('m2o') || iface?.includes('many-to-one')
  const isMulti =
    relationType === 'O2M' ||
    relationType === 'M2M' ||
    iface?.includes('o2m') ||
    iface?.includes('one-to-many') ||
    iface?.includes('m2m') ||
    iface?.includes('many-to-many') ||
    iface?.includes('translations')

  if (isM2O) {
    return [
      { value: 'eq', label: 'equals' },
      { value: 'ne', label: 'not equals' },
      { value: 'is_null', label: 'is empty' },
      { value: 'is_not_null', label: 'is not empty' }
    ]
  }
  if (isMulti) {
    return [
      { value: 'has', label: 'has (any)' },
      { value: 'is_empty', label: 'is empty' },
      { value: 'count_gt', label: 'count >' },
      { value: 'count_lt', label: 'count <' }
    ]
  }
  switch (type) {
    case 'boolean':
      return [{ value: 'eq', label: 'is' }]
    case 'integer':
    case 'bigInteger':
    case 'float':
    case 'decimal':
      return [
        { value: 'eq', label: '=' },
        { value: 'ne', label: '≠' },
        { value: 'lt', label: '<' },
        { value: 'lte', label: '≤' },
        { value: 'gt', label: '>' },
        { value: 'gte', label: '≥' },
        { value: 'in', label: 'in list' },
        { value: 'is_null', label: 'is empty' }
      ]
    case 'date':
    case 'dateTime':
    case 'timestamp':
      return [
        { value: 'eq', label: 'on' },
        { value: 'ne', label: 'not on' },
        { value: 'lt', label: 'before' },
        { value: 'lte', label: 'on or before' },
        { value: 'gt', label: 'after' },
        { value: 'gte', label: 'on or after' },
        { value: 'is_null', label: 'is empty' }
      ]
    default:
      return [
        { value: 'eq', label: 'equals' },
        { value: 'ne', label: 'not equals' },
        { value: 'contains', label: 'contains' },
        { value: 'starts_with', label: 'starts with' },
        { value: 'ends_with', label: 'ends with' },
        { value: 'in', label: 'in list' },
        { value: 'is_null', label: 'is empty' },
        { value: 'is_not_null', label: 'is not empty' }
      ]
  }
}

// ─── Field combobox ─────────────────────────────────────────────────────────

const REL_TYPE_COLORS: Record<string, string> = {
  M2O: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  O2M: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  M2M: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
}

export function FieldCombobox({
  fields,
  value,
  onChange
}: {
  fields: FieldOption[]
  value: string
  onChange: (field: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = fields.find((f) => f.field === value)

  const filtered = fields.filter((f) => f.field.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='w-52 justify-between font-normal'
        >
          {selected ? (
            <span className='flex items-center gap-2 truncate'>
              <span className='font-mono text-[12px] truncate'>{selected.field}</span>
              {selected.relationType ? (
                <span
                  className={cn(
                    'rounded px-1 py-0.5 text-[10px] font-semibold',
                    REL_TYPE_COLORS[selected.relationType]
                  )}
                >
                  {selected.relationType}
                </span>
              ) : (
                <span className='text-xs text-muted-foreground'>{selected.type}</span>
              )}
            </span>
          ) : (
            <span className='text-muted-foreground'>Select field…</span>
          )}
          <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-72 p-0' align='start'>
        <div className='p-2'>
          <div className='relative mb-1.5'>
            <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search fields…'
              className='h-8 w-full rounded-md border border-slate-200 bg-slate-50 pl-8 pr-3 text-[13px] placeholder-slate-400 focus:border-nvr-cyan/50 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30 dark:border-slate-700 dark:bg-slate-800'
            />
          </div>
          <div className='max-h-60 overflow-auto'>
            {filtered.map((f) => (
              <button
                key={f.field}
                type='button'
                onClick={() => {
                  onChange(f.field)
                  setOpen(false)
                  setQuery('')
                }}
                className='flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800'
              >
                <Check
                  className={cn(
                    'mr-2 h-4 w-4 shrink-0',
                    value === f.field ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className='flex-1 font-mono text-[12px] truncate'>{f.field}</span>
                {f.relationType ? (
                  <span
                    className={cn(
                      'ml-2 rounded px-1 py-0.5 text-[10px] font-semibold',
                      REL_TYPE_COLORS[f.relationType]
                    )}
                  >
                    {f.relationType}
                    {f.relatedCollection && (
                      <span className='ml-1 font-normal opacity-70'>→ {f.relatedCollection}</span>
                    )}
                  </span>
                ) : (
                  <span className='ml-2 text-xs text-muted-foreground'>{f.type}</span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className='px-2 py-3 text-center text-[12px] text-muted-foreground'>
                No fields found.
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Value input ──────────────────────────────────────────────────────────────

function ValueInput({
  field,
  op,
  value,
  onChange
}: {
  field: FieldOption | undefined
  op: string
  value: unknown
  onChange: (v: unknown) => void
}) {
  if (['is_null', 'is_not_null', 'is_empty', 'has'].includes(op)) return null

  const type = field?.type ?? 'string'
  const iface = field?.interface ?? ''

  if (op === 'count_gt' || op === 'count_lt') {
    return (
      <Input
        type='number'
        step='1'
        value={String(value ?? '')}
        onChange={(e) => onChange(Number(e.target.value))}
        className='w-24'
      />
    )
  }

  if (type === 'boolean') {
    return (
      <Select value={String(value ?? 'true')} onValueChange={(v) => onChange(v === 'true')}>
        <SelectTrigger className='w-32'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='true'>True</SelectItem>
          <SelectItem value='false'>False</SelectItem>
        </SelectContent>
      </Select>
    )
  }

  if (op === 'in') {
    return (
      <Input
        placeholder='val1, val2, val3'
        value={Array.isArray(value) ? (value as string[]).join(', ') : String(value ?? '')}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
          )
        }
        className='w-48'
      />
    )
  }

  if (type === 'date') {
    return (
      <Input
        type='date'
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className='w-44'
      />
    )
  }

  if (type === 'dateTime' || type === 'timestamp') {
    return (
      <Input
        type='datetime-local'
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className='w-56'
      />
    )
  }

  if (['integer', 'bigInteger'].includes(type)) {
    return (
      <Input
        type='number'
        step='1'
        value={String(value ?? '')}
        onChange={(e) => onChange(Number(e.target.value))}
        className='w-32'
      />
    )
  }

  if (['float', 'decimal'].includes(type)) {
    return (
      <Input
        type='number'
        step='any'
        value={String(value ?? '')}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className='w-32'
      />
    )
  }

  if (iface?.includes('m2o') || iface?.includes('many-to-one')) {
    return (
      <Input
        placeholder='Record ID'
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className='w-40'
      />
    )
  }

  return (
    <Input
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      className='w-48'
    />
  )
}

// ─── Condition row ────────────────────────────────────────────────────────────

export function RuleConditionRow({ condition, collection, onChange, onRemove }: ConditionRowProps) {
  const { data: colData } = useQuery({
    queryKey: ['collection-detail', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection
  })

  const rawFields: CMSField[] = colData?.fields ?? []
  const relations: CMSRelation[] = colData?.relations ?? []
  const allFields = buildAllFields(rawFields, relations, collection)

  const selectedField = allFields.find((f) => f.field === condition.field)
  const operators = getOperators(
    selectedField?.type ?? 'string',
    selectedField?.interface ?? null,
    selectedField?.relationType
  )

  function handleFieldChange(fieldKey: string) {
    const f = allFields.find((x) => x.field === fieldKey)
    const ops = getOperators(f?.type ?? 'string', f?.interface ?? null, f?.relationType)
    const defaultOp = ops[0]?.value ?? 'eq'
    const defaultValue = f?.type === 'boolean' ? true : ''
    onChange({ field: fieldKey, op: defaultOp, value: defaultValue })
  }

  function handleOpChange(op: string) {
    onChange({ ...condition, op })
  }

  function handleValueChange(value: unknown) {
    onChange({ ...condition, value })
  }

  return (
    <div className='flex flex-wrap items-center gap-2'>
      <FieldCombobox fields={allFields} value={condition.field} onChange={handleFieldChange} />
      <Select value={condition.op} onValueChange={handleOpChange}>
        <SelectTrigger className='w-40'>
          <SelectValue placeholder='operator' />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op.value} value={op.value}>
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ValueInput
        field={selectedField}
        op={condition.op}
        value={condition.value}
        onChange={handleValueChange}
      />
      <Button variant='ghost' size='icon' onClick={onRemove} aria-label='Remove condition'>
        <X className='h-4 w-4' />
      </Button>
    </div>
  )
}
