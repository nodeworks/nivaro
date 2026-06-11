import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Plus, Trash2, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { FieldPicker } from '@/components/field-picker'
import { RelationPicker } from '@/components/relation-picker'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type CMSField, type CMSRelation } from '@/lib/api'
import { findM2ORelation } from '@/lib/relations'
import { cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

interface FieldRule {
  id: number
  collection: string
  trigger_field: string
  trigger_op: string
  trigger_value: string | null
  target_field: string
  target_type: string
  target_value: string | null
  sort: number
  is_active: boolean | number
}

interface OpOption {
  value: string
  label: string
  needsValue: boolean
}

const OPS: OpOption[] = [
  { value: 'eq', label: 'equals', needsValue: true },
  { value: 'neq', label: 'not equals', needsValue: true },
  { value: 'null', label: 'is empty', needsValue: false },
  { value: 'nnull', label: 'is not empty', needsValue: false },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'in', label: 'is one of', needsValue: true }
]

const TARGET_TYPES = [
  { value: 'set', label: 'set to' },
  { value: 'clear', label: 'clear' }
]

function opNeedsValue(op: string): boolean {
  return OPS.find((o) => o.value === op)?.needsValue ?? false
}

// ─── Combobox helper ──────────────────────────────────────────────────────────

function Combobox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  width = 200
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled}
          className='h-8 w-full justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='p-0' align='start' style={{ width }}>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={(current) => {
                    onChange(current === value ? '' : current)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      value === opt.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── Type-aware value input ───────────────────────────────────────────────────

function ValueInput({
  fieldName,
  op,
  value,
  onChange,
  fields,
  relations,
  collection,
  placeholder = 'value'
}: {
  fieldName: string
  op: string
  value: string | null
  onChange: (v: string) => void
  fields: CMSField[]
  relations: CMSRelation[]
  collection: string
  placeholder?: string
}) {
  const field = fields.find((f) => f.field === fieldName)
  const m2oRelation = field ? findM2ORelation(relations, collection, fieldName) : undefined

  // "is one of" always uses comma-separated text regardless of field type
  if (op === 'in') {
    return (
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder='a, b, c'
        className='h-8 w-[180px] font-mono text-[12px]'
      />
    )
  }

  // M2O relation → RelationPicker
  if (m2oRelation?.one_collection) {
    return (
      <div className='w-[180px]'>
        <RelationPicker
          relatedCollection={m2oRelation.one_collection}
          value={value || null}
          onChange={(v) => onChange(v == null ? '' : String(v))}
        />
      </div>
    )
  }

  const type = field?.type ?? 'string'

  if (type === 'boolean') {
    return (
      <Combobox
        value={value ?? ''}
        onChange={onChange}
        options={[
          { value: 'true', label: 'true' },
          { value: 'false', label: 'false' }
        ]}
        placeholder='true / false'
        width={140}
      />
    )
  }

  if (type === 'datetime' || field?.interface === 'datetime') {
    return (
      <Input
        type='datetime-local'
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className='h-8 w-[200px] font-mono text-[12px]'
      />
    )
  }

  if (type === 'date') {
    return (
      <Input
        type='date'
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className='h-8 w-[160px] font-mono text-[12px]'
      />
    )
  }

  if (type === 'integer' || type === 'float') {
    return (
      <Input
        type='number'
        step={type === 'float' ? 'any' : '1'}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className='h-8 w-[140px] font-mono text-[12px]'
      />
    )
  }

  return (
    <Input
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className='h-8 w-[140px] font-mono text-[12px]'
    />
  )
}

// ─── Rule row ─────────────────────────────────────────────────────────────────

function RuleRow({
  rule,
  fields,
  relations,
  collection,
  isFirst,
  isLast,
  onPatch,
  onDelete,
  onMove
}: {
  rule: FieldRule
  fields: CMSField[]
  relations: CMSRelation[]
  collection: string
  isFirst: boolean
  isLast: boolean
  onPatch: (patch: Partial<FieldRule>) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const active = rule.is_active === true || rule.is_active === 1
  const showTriggerValue = opNeedsValue(rule.trigger_op)
  const showTargetValue = rule.target_type === 'set'

  return (
    <div
      className={cn(
        'rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card transition-opacity',
        !active && 'opacity-50'
      )}
    >
      {/* When row */}
      <div className='flex items-center gap-2 border-b border-slate-100 px-3 py-2.5 dark:border-border'>
        <span className='w-9 shrink-0 text-[11px] font-medium text-slate-400'>When</span>
        <div className='flex flex-1 flex-wrap items-center gap-2'>
          <div className='w-[180px]'>
            <FieldPicker
              collection={collection}
              fields={fields}
              relations={relations}
              value={rule.trigger_field}
              onChange={(p) => onPatch({ trigger_field: p.path.join('.'), trigger_value: '' })}
              onClear={() => onPatch({ trigger_field: '', trigger_value: '' })}
              placeholder='field…'
            />
          </div>
          <div className='w-[130px]'>
            <Combobox
              value={rule.trigger_op}
              onChange={(v) => onPatch({ trigger_op: v })}
              options={OPS.map((o) => ({ value: o.value, label: o.label }))}
              placeholder='condition…'
              width={160}
            />
          </div>
          {showTriggerValue && (
            <ValueInput
              fieldName={rule.trigger_field}
              op={rule.trigger_op}
              value={rule.trigger_value}
              onChange={(v) => onPatch({ trigger_value: v })}
              fields={fields}
              relations={relations}
              collection={collection}
            />
          )}
        </div>
      </div>

      {/* Then row */}
      <div className='flex items-center gap-2 px-3 py-2.5'>
        <span className='w-9 shrink-0 text-[11px] font-medium text-slate-400'>Then</span>
        <div className='flex flex-1 flex-wrap items-center gap-2'>
          <div className='w-[110px]'>
            <Combobox
              value={rule.target_type}
              onChange={(v) => onPatch({ target_type: v })}
              options={TARGET_TYPES}
              placeholder='action…'
              width={140}
            />
          </div>
          <div className='w-[180px]'>
            <FieldPicker
              collection={collection}
              fields={fields}
              relations={relations}
              value={rule.target_field}
              onChange={(p) => onPatch({ target_field: p.path.join('.'), target_value: '' })}
              onClear={() => onPatch({ target_field: '', target_value: '' })}
              placeholder='field…'
            />
          </div>
          {showTargetValue && (
            <ValueInput
              fieldName={rule.target_field}
              op='eq'
              value={rule.target_value}
              onChange={(v) => onPatch({ target_value: v })}
              fields={fields}
              relations={relations}
              collection={collection}
              placeholder='value'
            />
          )}
        </div>

        {/* Controls */}
        <div className='ml-auto flex shrink-0 items-center gap-0.5'>
          <label className='flex cursor-pointer select-none items-center gap-1.5 pr-1.5 text-[11px] text-slate-400 hover:text-slate-600'>
            <input
              type='checkbox'
              checked={active}
              onChange={(e) => onPatch({ is_active: e.target.checked })}
              className='h-3.5 w-3.5 rounded accent-nvr-cyan'
            />
            On
          </label>
          <Button
            size='icon'
            variant='ghost'
            className='h-7 w-7 text-slate-400 hover:text-slate-600'
            disabled={isFirst}
            onClick={() => onMove(-1)}
            aria-label='Move up'
          >
            <ArrowUp className='h-3.5 w-3.5' />
          </Button>
          <Button
            size='icon'
            variant='ghost'
            className='h-7 w-7 text-slate-400 hover:text-slate-600'
            disabled={isLast}
            onClick={() => onMove(1)}
            aria-label='Move down'
          >
            <ArrowDown className='h-3.5 w-3.5' />
          </Button>
          <Button
            size='icon'
            variant='ghost'
            className='h-7 w-7 text-red-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30'
            onClick={onDelete}
            aria-label='Delete rule'
          >
            <Trash2 className='h-3.5 w-3.5' />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Main section ─────────────────────────────────────────────────────────────

export function FieldRulesSection({
  collection,
  isAdmin
}: {
  collection: string
  isAdmin: boolean
}) {
  const qc = useQueryClient()

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })

  const { data: rules, isLoading } = useQuery({
    queryKey: ['field-rules', collection],
    queryFn: () =>
      api
        .get<{ data: FieldRule[] }>('/field-rules', { params: { collection } })
        .then((r) => r.data.data),
    enabled: !!collection
  })

  const allFields: CMSField[] = colMeta?.fields ?? []
  const relations: CMSRelation[] = colMeta?.relations ?? []

  const invalidate = () => qc.invalidateQueries({ queryKey: ['field-rules', collection] })

  const createRule = useMutation({
    mutationFn: () =>
      api.post('/field-rules', {
        collection,
        trigger_field: '',
        trigger_op: 'eq',
        trigger_value: '',
        target_field: '',
        target_type: 'set',
        target_value: '',
        sort: rules?.length ?? 0,
        is_active: true
      }),
    onSuccess: () => {
      invalidate()
      toast.success('Rule added')
    },
    onError: () => toast.error('Failed to add rule')
  })

  const patchRule = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<FieldRule> }) =>
      api.patch(`/field-rules/${id}`, patch),
    onSuccess: () => invalidate(),
    onError: () => toast.error('Failed to save rule')
  })

  const deleteRule = useMutation({
    mutationFn: (id: number) => api.delete(`/field-rules/${id}`),
    onSuccess: () => {
      invalidate()
      toast.success('Rule deleted')
    },
    onError: () => toast.error('Failed to delete rule')
  })

  const list = (rules ?? []).slice().sort((a, b) => a.sort - b.sort || a.id - b.id)

  function move(index: number, dir: -1 | 1) {
    const target = index + dir
    if (target < 0 || target >= list.length) return
    const a = list[index]
    const b = list[target]
    patchRule.mutate({ id: a.id, patch: { sort: b.sort } })
    patchRule.mutate({ id: b.id, patch: { sort: a.sort } })
  }

  return (
    <div className='space-y-4'>
      <div className='flex items-start justify-between gap-4'>
        <p className='text-[12px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
          Automatically set or clear a field when another field matches a condition. Applied on save
          and in real time in the item editor.
        </p>
        {isAdmin && (
          <Button
            size='sm'
            variant='outline'
            className='h-7 shrink-0 text-[12px]'
            disabled={createRule.isPending}
            onClick={() => createRule.mutate()}
          >
            <Plus className='mr-1 h-3 w-3' />
            Add rule
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className='space-y-2'>
          <Skeleton className='h-[76px] w-full rounded-lg' />
          <Skeleton className='h-[76px] w-full rounded-lg' />
        </div>
      ) : list.length === 0 ? (
        <div className='rounded-lg border border-dashed border-slate-200 py-10 text-center dark:border-border'>
          <Wand2 className='mx-auto mb-2.5 h-5 w-5 text-slate-300 dark:text-slate-600' />
          <p className='text-[12px] font-medium text-slate-500 dark:text-muted-foreground'>
            No field rules defined
          </p>
          <p className='mt-0.5 text-[11px] text-slate-400'>
            Rules apply automatically when a field condition is met.
          </p>
          {isAdmin && (
            <Button
              size='sm'
              variant='outline'
              className='mt-4 text-[12px]'
              disabled={createRule.isPending}
              onClick={() => createRule.mutate()}
            >
              <Plus className='mr-1 h-3 w-3' />
              Add first rule
            </Button>
          )}
        </div>
      ) : (
        <div className='space-y-2'>
          {list.map((rule, index) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              fields={allFields}
              relations={relations}
              collection={collection}
              isFirst={index === 0}
              isLast={index === list.length - 1}
              onPatch={(patch) => patchRule.mutate({ id: rule.id, patch })}
              onDelete={() => deleteRule.mutate(rule.id)}
              onMove={(dir) => move(index, dir)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
