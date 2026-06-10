import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, ChevronsUpDown, Plus, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { FieldCombobox, type FieldOption } from '@/components/rule-condition-row'
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
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, type CMSField, type Collection } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type RuleForm = {
  name: string
  collection: string
  trigger: string
  enabled: boolean
  sort: number
}

export interface ConditionLeaf {
  field: string
  op: string
  value?: unknown
}

export interface ConditionGroup {
  logic: 'and' | 'or'
  conditions: Array<ConditionLeaf | ConditionGroup>
}

export interface RuleAction {
  type: string
  // set_field
  field?: string
  value?: unknown
  // notify
  message?: string
  // reject
  error_message?: string
  // cross_collection
  target_collection?: string
  operation?: 'create' | 'update'
  field_map?: Record<string, string>
  match_field?: string
}

type Rule = {
  id: string
  name: string
  collection: string
  trigger: string
  enabled: boolean
  sort: number
  conditions: unknown
  actions: RuleAction[] | null
}

function isGroup(node: ConditionLeaf | ConditionGroup): node is ConditionGroup {
  return typeof node === 'object' && node !== null && 'logic' in node
}

const EMPTY_GROUP: ConditionGroup = { logic: 'and', conditions: [] }

/** Normalize legacy operator codes from older rule rows. */
function normalizeOp(op: string): string {
  if (op === 'neq') return 'ne'
  if (op === 'is_null') return 'null'
  if (op === 'is_not_null') return 'nnull'
  return op
}

/** Parse stored conditions — flat array (legacy/engine format) or group object. */
function parseConditions(raw: unknown): ConditionGroup {
  if (Array.isArray(raw)) {
    return {
      logic: 'and',
      conditions: (raw as ConditionLeaf[]).map((c) => ({ ...c, op: normalizeOp(c.op ?? 'eq') }))
    }
  }
  if (raw && typeof raw === 'object' && 'logic' in (raw as Record<string, unknown>)) {
    const g = raw as ConditionGroup
    return {
      logic: g.logic === 'or' ? 'or' : 'and',
      conditions: (g.conditions ?? []).map((n) =>
        isGroup(n)
          ? {
              logic: n.logic === 'or' ? 'or' : 'and',
              conditions: (n.conditions ?? [])
                .filter((x) => !isGroup(x))
                .map((x) => ({
                  ...(x as ConditionLeaf),
                  op: normalizeOp((x as ConditionLeaf).op ?? 'eq')
                }))
            }
          : { ...n, op: normalizeOp(n.op ?? 'eq') }
      )
    }
  }
  return { ...EMPTY_GROUP, conditions: [] }
}

/**
 * Serialize for save. A plain AND group with no nested groups is stored as the
 * flat array the rules engine evaluates today — byte-compatible with rules
 * created before the builder existed. OR logic / nested groups keep the group
 * object shape.
 */
function serializeConditions(group: ConditionGroup): unknown {
  const hasNested = group.conditions.some(isGroup)
  if (group.logic === 'and' && !hasNested) return group.conditions
  return group
}

// ─── Operator config ──────────────────────────────────────────────────────────

const ALL_OPERATORS: { value: string; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'ne', label: 'not equals' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'greater or equal' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'less or equal' },
  { value: 'contains', label: 'contains' },
  { value: 'null', label: 'is empty' },
  { value: 'nnull', label: 'is not empty' },
  { value: 'in', label: 'in list' }
]

const NO_VALUE_OPS = new Set(['null', 'nnull'])

const NUMERIC_TYPES = new Set(['integer', 'bigInteger', 'float', 'decimal'])
const DATE_TYPES = new Set(['date', 'dateTime', 'timestamp', 'datetime', 'datetime2'])

// ─── Small generic combobox (shadcn Popover + Command) ───────────────────────

function SmallCombobox({
  value,
  onChange,
  options,
  placeholder,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className={cn('h-8 justify-between px-2.5 text-[12.5px] font-normal', className)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1.5 h-3.5 w-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[220px] p-0' align='start'>
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
                  onSelect={() => {
                    onChange(opt.value)
                    setOpen(false)
                  }}
                  className='text-[12.5px]'
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

// ─── Collection combobox ──────────────────────────────────────────────────────

function CollectionCombobox({
  collections,
  value,
  onChange,
  placeholder
}: {
  collections: Collection[]
  value: string
  onChange: (collection: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = collections.find((c) => c.collection === value)

  const filtered = collections.filter((c) => {
    const q = query.trim().toLowerCase()
    return (
      c.collection.toLowerCase().includes(q) || (c.display_name ?? '').toLowerCase().includes(q)
    )
  })

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
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='w-full justify-between font-normal'
        >
          {selected ? (
            <span className='truncate'>{selected.display_name ?? selected.collection}</span>
          ) : value ? (
            <span className='truncate'>{value}</span>
          ) : (
            <span className='text-muted-foreground'>{placeholder ?? 'Select collection…'}</span>
          )}
          <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[400px] p-0' align='start'>
        <div className='p-2'>
          <div className='relative mb-1.5'>
            <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search collections…'
              className='h-8 w-full rounded-md border border-slate-200 bg-slate-50 pl-8 pr-3 text-[13px] placeholder-slate-400 focus:border-nvr-cyan/50 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30 dark:border-slate-700 dark:bg-slate-800'
            />
          </div>
          <div className='max-h-60 overflow-auto'>
            {filtered.map((col) => (
              <button
                key={col.collection}
                type='button'
                onClick={() => {
                  onChange(col.collection)
                  setOpen(false)
                  setQuery('')
                }}
                className='flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800'
              >
                <Check
                  className={cn(
                    'mr-2 h-4 w-4 shrink-0',
                    value === col.collection ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className='flex-1 truncate'>{col.display_name ?? col.collection}</span>
                <span className='ml-2 font-mono text-xs text-muted-foreground'>
                  {col.collection}
                </span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className='px-2 py-3 text-center text-[12px] text-muted-foreground'>
                No collections found.
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Collection fields hook ───────────────────────────────────────────────────

function useCollectionFieldOptions(collection: string): FieldOption[] {
  const { data: colData } = useQuery({
    queryKey: ['collection-detail', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })
  return ((colData?.fields ?? []) as CMSField[]).map((f) => ({
    field: f.field,
    type: f.type,
    interface: f.interface
  }))
}

// ─── Type-aware value input ───────────────────────────────────────────────────

function TagListInput({ value, onChange }: { value: unknown; onChange: (v: unknown[]) => void }) {
  const tags: string[] = Array.isArray(value) ? (value as unknown[]).map(String) : []
  const [draft, setDraft] = useState('')

  const commit = () => {
    const parts = draft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length) onChange([...tags, ...parts])
    setDraft('')
  }

  return (
    <div className='flex min-h-[32px] flex-1 flex-wrap items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900'>
      {tags.map((t, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: tags can repeat
          key={`${t}-${i}`}
          className='inline-flex items-center gap-1 rounded bg-nvr-cyan/10 px-1.5 py-0.5 text-[11px] text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
        >
          {t}
          <button
            type='button'
            onClick={() => onChange(tags.filter((_, j) => j !== i))}
            className='opacity-50 hover:opacity-100'
            aria-label={`Remove ${t}`}
          >
            <X className='h-2.5 w-2.5' />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit()
          }
        }}
        onBlur={commit}
        placeholder={tags.length ? '' : 'value, value, …'}
        className='min-w-[80px] flex-1 bg-transparent text-[12.5px] placeholder-slate-400 focus:outline-none'
      />
    </div>
  )
}

function ConditionValueInput({
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
  if (NO_VALUE_OPS.has(op)) return null

  if (op === 'in') return <TagListInput value={value} onChange={onChange} />

  const type = field?.type ?? 'string'

  if (DATE_TYPES.has(type)) {
    return (
      <Input
        type={type === 'date' ? 'date' : 'datetime-local'}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className='h-8 w-48 text-[12.5px]'
      />
    )
  }

  if (NUMERIC_TYPES.has(type)) {
    return (
      <Input
        type='number'
        step={type === 'integer' || type === 'bigInteger' ? '1' : 'any'}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        className='h-8 w-32 text-[12.5px]'
      />
    )
  }

  if (type === 'boolean') {
    return (
      <SmallCombobox
        value={String(value ?? 'true')}
        onChange={(v) => onChange(v === 'true')}
        options={[
          { value: 'true', label: 'True' },
          { value: 'false', label: 'False' }
        ]}
        className='w-28'
      />
    )
  }

  return (
    <Input
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      placeholder='value'
      className='h-8 w-44 text-[12.5px]'
    />
  )
}

// ─── Condition row + group builder ────────────────────────────────────────────

function ConditionLeafRow({
  leaf,
  fields,
  onChange,
  onRemove
}: {
  leaf: ConditionLeaf
  fields: FieldOption[]
  onChange: (next: ConditionLeaf) => void
  onRemove: () => void
}) {
  const selectedField = fields.find((f) => f.field === leaf.field)
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <FieldCombobox
        fields={fields}
        value={leaf.field}
        onChange={(f) => onChange({ field: f, op: leaf.op || 'eq', value: '' })}
      />
      <SmallCombobox
        value={leaf.op}
        onChange={(op) =>
          onChange({ ...leaf, op, ...(NO_VALUE_OPS.has(op) ? { value: undefined } : {}) })
        }
        options={ALL_OPERATORS}
        placeholder='operator'
        className='w-40'
      />
      <ConditionValueInput
        field={selectedField}
        op={leaf.op}
        value={leaf.value}
        onChange={(value) => onChange({ ...leaf, value })}
      />
      <Button
        type='button'
        variant='ghost'
        size='icon'
        className='h-7 w-7'
        onClick={onRemove}
        aria-label='Remove condition'
      >
        <X className='h-3.5 w-3.5' />
      </Button>
    </div>
  )
}

function LogicToggle({
  logic,
  onChange
}: {
  logic: 'and' | 'or'
  onChange: (l: 'and' | 'or') => void
}) {
  return (
    <div className='inline-flex overflow-hidden rounded-md border border-slate-200 dark:border-slate-700'>
      {(['and', 'or'] as const).map((l) => (
        <button
          key={l}
          type='button'
          onClick={() => onChange(l)}
          className={cn(
            'px-2.5 py-1 text-[11px] font-semibold uppercase transition-colors',
            logic === l
              ? 'bg-nvr-cyan/10 text-nvr-cyan'
              : 'bg-white text-slate-400 hover:text-slate-600 dark:bg-slate-900'
          )}
        >
          {l}
        </button>
      ))}
    </div>
  )
}

function ConditionGroupBuilder({
  group,
  fields,
  onChange,
  depth = 0
}: {
  group: ConditionGroup
  fields: FieldOption[]
  onChange: (g: ConditionGroup) => void
  depth?: number
}) {
  const setNode = (idx: number, node: ConditionLeaf | ConditionGroup) =>
    onChange({ ...group, conditions: group.conditions.map((n, i) => (i === idx ? node : n)) })
  const removeNode = (idx: number) =>
    onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== idx) })

  return (
    <div
      className={cn(
        depth > 0 &&
          'rounded-lg border border-dashed border-slate-300 bg-slate-50/60 p-3 dark:border-slate-700 dark:bg-slate-900/40'
      )}
    >
      <div className='mb-2 flex items-center gap-2'>
        <span className='text-[11px] text-slate-400'>Match</span>
        <LogicToggle logic={group.logic} onChange={(logic) => onChange({ ...group, logic })} />
        <span className='text-[11px] text-slate-400'>of the following</span>
      </div>

      <div className='space-y-2'>
        {group.conditions.length === 0 && (
          <p className='text-[12px] text-slate-400'>
            {depth === 0 ? 'No conditions — rule always runs.' : 'Empty group.'}
          </p>
        )}
        {group.conditions.map((node, i) =>
          isGroup(node) ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: nodes have no stable id
            <div key={i} className='relative'>
              <ConditionGroupBuilder
                group={node}
                fields={fields}
                onChange={(g) => setNode(i, g)}
                depth={depth + 1}
              />
              <button
                type='button'
                onClick={() => removeNode(i)}
                className='absolute right-2 top-2 rounded p-1 text-slate-400 hover:text-red-500'
                aria-label='Remove group'
              >
                <Trash2 className='h-3.5 w-3.5' />
              </button>
            </div>
          ) : (
            <ConditionLeafRow
              // biome-ignore lint/suspicious/noArrayIndexKey: nodes have no stable id
              key={i}
              leaf={node}
              fields={fields}
              onChange={(next) => setNode(i, next)}
              onRemove={() => removeNode(i)}
            />
          )
        )}
      </div>

      <div className='mt-3 flex gap-2'>
        <button
          type='button'
          onClick={() =>
            onChange({
              ...group,
              conditions: [...group.conditions, { field: '', op: 'eq', value: '' }]
            })
          }
          className='flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-1.5 text-[12px] font-medium text-slate-500 transition-colors hover:border-nvr-cyan/50 hover:bg-slate-50 hover:text-nvr-cyan dark:border-slate-700 dark:hover:bg-slate-900'
        >
          <Plus className='h-3.5 w-3.5' /> Add Condition
        </button>
        {depth === 0 && (
          <button
            type='button'
            onClick={() =>
              onChange({
                ...group,
                conditions: [
                  ...group.conditions,
                  { logic: 'or', conditions: [{ field: '', op: 'eq', value: '' }] }
                ]
              })
            }
            className='flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-1.5 text-[12px] font-medium text-slate-500 transition-colors hover:border-nvr-cyan/50 hover:bg-slate-50 hover:text-nvr-cyan dark:border-slate-700 dark:hover:bg-slate-900'
          >
            <Plus className='h-3.5 w-3.5' /> Add Group
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Action cards ─────────────────────────────────────────────────────────────

const ACTION_TYPES: { value: string; label: string; desc: string }[] = [
  { value: 'set_field', label: 'Set field', desc: 'Write a value into a field on this record' },
  { value: 'notify', label: 'Send notification', desc: 'Send an in-app notification' },
  { value: 'reject', label: 'Reject (error)', desc: 'Block the save with an error message' },
  {
    value: 'cross_collection',
    label: 'Cross-collection',
    desc: 'Create or update a record in another collection'
  }
]

function FieldMapEditor({
  fieldMap,
  targetFields,
  onChange
}: {
  fieldMap: Record<string, string>
  targetFields: FieldOption[]
  onChange: (m: Record<string, string>) => void
}) {
  const entries = Object.entries(fieldMap)
  return (
    <div className='space-y-2'>
      {entries.map(([target, template], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order-stable map rows
        <div key={i} className='flex items-center gap-2'>
          <FieldCombobox
            fields={targetFields}
            value={target}
            onChange={(f) => {
              const next: Record<string, string> = {}
              entries.forEach(([k, v], j) => {
                next[j === i ? f : k] = v
              })
              onChange(next)
            }}
          />
          <span className='text-[12px] text-slate-400'>=</span>
          <Input
            value={template}
            onChange={(e) => onChange({ ...fieldMap, [target]: e.target.value })}
            placeholder='{{field}} template'
            className='h-8 flex-1 font-mono text-[12px]'
          />
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='h-7 w-7'
            onClick={() => {
              const next = { ...fieldMap }
              delete next[target]
              onChange(next)
            }}
            aria-label='Remove mapping'
          >
            <X className='h-3.5 w-3.5' />
          </Button>
        </div>
      ))}
      <button
        type='button'
        onClick={() => onChange({ ...fieldMap, '': '' })}
        className='flex items-center gap-1 text-[12px] text-slate-400 hover:text-nvr-cyan'
        disabled={'' in fieldMap}
      >
        <Plus className='h-3.5 w-3.5' /> Add field mapping
      </button>
      <p className='text-[11px] text-slate-400'>
        Use <code className='rounded bg-slate-100 px-1 dark:bg-slate-800'>{'{{field}}'}</code> to
        insert values from the triggering record.
      </p>
    </div>
  )
}

function ActionCard({
  action,
  collection,
  collections,
  onChange,
  onRemove
}: {
  action: RuleAction
  collection: string
  collections: Collection[]
  onChange: (a: RuleAction) => void
  onRemove: () => void
}) {
  const sourceFields = useCollectionFieldOptions(collection)
  const targetFields = useCollectionFieldOptions(
    action.type === 'cross_collection' ? (action.target_collection ?? '') : ''
  )

  return (
    <div className='rounded-lg border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/70'>
      <div className='mb-2 flex items-center gap-2'>
        <SmallCombobox
          value={action.type}
          onChange={(t) =>
            onChange({
              type: t,
              ...(t === 'cross_collection' ? { operation: 'create', field_map: {} } : {})
            })
          }
          options={ACTION_TYPES.map((a) => ({ value: a.value, label: a.label }))}
          placeholder='action type'
          className='w-44'
        />
        <span className='flex-1 truncate text-[11px] text-slate-400'>
          {ACTION_TYPES.find((a) => a.value === action.type)?.desc}
        </span>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='h-7 w-7'
          onClick={onRemove}
          aria-label='Remove action'
        >
          <X className='h-3.5 w-3.5' />
        </Button>
      </div>

      {action.type === 'set_field' && (
        <div className='flex flex-wrap items-center gap-2'>
          <FieldCombobox
            fields={sourceFields}
            value={action.field ?? ''}
            onChange={(f) => onChange({ ...action, field: f })}
          />
          <Input
            placeholder='value'
            value={String(action.value ?? '')}
            onChange={(e) => onChange({ ...action, value: e.target.value })}
            className='h-8 w-56 text-[12.5px]'
          />
        </div>
      )}

      {action.type === 'notify' && (
        <Input
          placeholder='Notification message'
          value={action.message ?? ''}
          onChange={(e) => onChange({ ...action, message: e.target.value })}
          className='h-8 text-[12.5px]'
        />
      )}

      {action.type === 'reject' && (
        <Input
          placeholder='Error message returned to caller'
          value={action.error_message ?? ''}
          onChange={(e) => onChange({ ...action, error_message: e.target.value })}
          className='h-8 text-[12.5px]'
        />
      )}

      {action.type === 'cross_collection' && (
        <div className='space-y-3'>
          <div className='grid grid-cols-2 gap-3'>
            <div className='space-y-1'>
              <Label className='text-[11px] text-slate-500'>Target collection</Label>
              <CollectionCombobox
                collections={collections.filter((c) => c.collection !== collection)}
                value={action.target_collection ?? ''}
                onChange={(c) =>
                  onChange({
                    ...action,
                    target_collection: c,
                    field_map: {},
                    match_field: undefined
                  })
                }
                placeholder='Select target…'
              />
            </div>
            <div className='space-y-1'>
              <Label className='text-[11px] text-slate-500'>Operation</Label>
              <div className='inline-flex overflow-hidden rounded-md border border-slate-200 dark:border-slate-700'>
                {(['create', 'update'] as const).map((op) => (
                  <button
                    key={op}
                    type='button'
                    onClick={() => onChange({ ...action, operation: op })}
                    className={cn(
                      'px-3 py-1.5 text-[12px] font-medium capitalize transition-colors',
                      (action.operation ?? 'create') === op
                        ? 'bg-nvr-cyan/10 text-nvr-cyan'
                        : 'bg-white text-slate-500 hover:bg-slate-50 dark:bg-slate-900'
                    )}
                  >
                    {op}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {action.target_collection && (
            <>
              <div className='space-y-1'>
                <Label className='text-[11px] text-slate-500'>Field map</Label>
                <FieldMapEditor
                  fieldMap={action.field_map ?? {}}
                  targetFields={targetFields}
                  onChange={(m) => onChange({ ...action, field_map: m })}
                />
              </div>
              {(action.operation ?? 'create') === 'update' && (
                <div className='space-y-1'>
                  <Label className='text-[11px] text-slate-500'>Match field</Label>
                  <div className='flex items-center gap-2'>
                    <FieldCombobox
                      fields={targetFields}
                      value={action.match_field ?? ''}
                      onChange={(f) => onChange({ ...action, match_field: f })}
                    />
                    <span className='text-[11px] text-slate-400'>
                      Field on the target used to find the record to update.
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function RuleEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isNew = id === 'new'

  const [form, setForm] = useState<RuleForm>({
    name: '',
    collection: '',
    trigger: 'before_create',
    enabled: true,
    sort: 0
  })
  const [conditionGroup, setConditionGroup] = useState<ConditionGroup>({
    ...EMPTY_GROUP,
    conditions: []
  })
  const [actions, setActions] = useState<RuleAction[]>([])

  // JSON power-user mode
  const [jsonMode, setJsonMode] = useState(false)
  const [jsonDraft, setJsonDraft] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)

  const { data: collectionsData } = useQuery({
    queryKey: ['collections', 'tables_only'],
    queryFn: () => api.get('/collections?tables_only=true').then((r) => r.data.data as Collection[])
  })
  const collections = collectionsData ?? []

  const { data, isLoading } = useQuery({
    queryKey: ['rules', id],
    queryFn: () => api.get(`/rules/${id}`).then((r) => r.data.data as Rule),
    enabled: !isNew && !!id
  })

  useEffect(() => {
    if (data) {
      setForm({
        name: data.name ?? '',
        collection: data.collection ?? '',
        trigger: data.trigger ?? 'before_create',
        enabled: data.enabled ?? true,
        sort: data.sort ?? 0
      })
      setConditionGroup(parseConditions(data.conditions))
      setActions(data.actions ?? [])
    }
  }, [data])

  const fields = useCollectionFieldOptions(form.collection)

  const serializedState = useMemo(
    () => JSON.stringify({ conditions: serializeConditions(conditionGroup), actions }, null, 2),
    [conditionGroup, actions]
  )

  function enterJsonMode() {
    setJsonDraft(serializedState)
    setJsonError(null)
    setJsonMode(true)
  }

  function applyJsonDraft(text: string) {
    setJsonDraft(text)
    try {
      const parsed = JSON.parse(text) as { conditions?: unknown; actions?: RuleAction[] }
      setConditionGroup(parseConditions(parsed.conditions))
      setActions(Array.isArray(parsed.actions) ? parsed.actions : [])
      setJsonError(null)
    } catch (err) {
      setJsonError((err as Error).message)
    }
  }

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      isNew
        ? api.post('/rules', body).then((r) => r.data)
        : api.patch(`/rules/${id}`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      toast.success(isNew ? 'Rule created' : 'Rule saved')
      navigate('/rules')
    },
    onError: () => toast.error('Failed to save rule')
  })

  function handleCollectionChange(collection: string) {
    setForm((p) => ({ ...p, collection }))
    // Conditions and actions are field-specific — reset when collection changes.
    setConditionGroup({ ...EMPTY_GROUP, conditions: [] })
    setActions([])
  }

  function handleSave() {
    if (!form.name.trim() || !form.collection.trim()) {
      toast.error('Name and collection are required')
      return
    }
    if (jsonMode && jsonError) {
      toast.error('Fix the JSON before saving')
      return
    }
    save.mutate({
      name: form.name,
      collection: form.collection,
      trigger: form.trigger,
      enabled: form.enabled,
      sort: form.sort,
      conditions: serializeConditions(conditionGroup),
      actions
    })
  }

  return (
    <>
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-4 dark:border-slate-800 dark:bg-slate-950'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <button
              type='button'
              onClick={() => navigate('/rules')}
              className='flex items-center gap-1.5 rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800'
            >
              <ArrowLeft className='h-4 w-4' />
            </button>
            <span className='text-[13px] text-slate-400'>/</span>
            <span className='text-[13px] font-medium text-slate-500'>Rules</span>
            <span className='text-[13px] text-slate-400'>/</span>
            <span className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
              {isNew ? 'New Rule' : (data?.name ?? 'Rule')}
            </span>
          </div>
          <div className='flex items-center gap-2'>
            <div className='inline-flex overflow-hidden rounded-md border border-slate-200 dark:border-slate-700'>
              <button
                type='button'
                onClick={() => setJsonMode(false)}
                className={cn(
                  'px-2.5 py-1 text-[11px] font-medium transition-colors',
                  !jsonMode
                    ? 'bg-nvr-cyan/10 text-nvr-cyan'
                    : 'bg-white text-slate-500 hover:bg-slate-50 dark:bg-slate-900'
                )}
              >
                Builder
              </button>
              <button
                type='button'
                onClick={enterJsonMode}
                className={cn(
                  'px-2.5 py-1 text-[11px] font-medium transition-colors',
                  jsonMode
                    ? 'bg-nvr-cyan/10 text-nvr-cyan'
                    : 'bg-white text-slate-500 hover:bg-slate-50 dark:bg-slate-900'
                )}
              >
                JSON
              </button>
            </div>
            <Button size='sm' onClick={handleSave} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>

      <div className='p-8'>
        {!isNew && isLoading ? (
          <div className='mx-auto max-w-3xl space-y-4'>
            <Skeleton className='h-40 w-full rounded-xl' />
            <Skeleton className='h-32 w-full rounded-xl' />
          </div>
        ) : (
          <div className='mx-auto max-w-3xl space-y-5'>
            {/* Settings */}
            <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-950'>
              <h2 className='mb-4 text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
                Rule Settings
              </h2>
              <div className='space-y-4'>
                <div className='space-y-1.5'>
                  <Label htmlFor='rule-name'>
                    Name <span className='text-red-500'>*</span>
                  </Label>
                  <Input
                    id='rule-name'
                    value={form.name}
                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder='e.g. Auto-assign region owner'
                  />
                </div>

                <div className='grid grid-cols-2 gap-3'>
                  <div className='space-y-1.5'>
                    <Label>
                      Collection <span className='text-red-500'>*</span>
                    </Label>
                    <CollectionCombobox
                      collections={collections}
                      value={form.collection}
                      onChange={handleCollectionChange}
                    />
                  </div>
                  <div className='space-y-1.5'>
                    <Label>Trigger</Label>
                    <SmallCombobox
                      value={form.trigger}
                      onChange={(v) => setForm((p) => ({ ...p, trigger: v }))}
                      options={[
                        { value: 'before_create', label: 'before_create' },
                        { value: 'before_update', label: 'before_update' },
                        { value: 'after_create', label: 'after_create' },
                        { value: 'after_update', label: 'after_update' }
                      ]}
                      className='h-9 w-full'
                    />
                  </div>
                </div>

                <div className='grid grid-cols-2 gap-3'>
                  <div className='space-y-1.5'>
                    <Label htmlFor='rule-sort'>Sort</Label>
                    <Input
                      id='rule-sort'
                      type='number'
                      value={form.sort}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, sort: Number(e.target.value) || 0 }))
                      }
                    />
                  </div>
                  <div className='flex items-end'>
                    <div className='flex w-full items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 px-4 py-2 dark:border-slate-800 dark:bg-slate-900/70'>
                      <span className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>
                        Enabled
                      </span>
                      <Switch
                        checked={form.enabled}
                        onCheckedChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {jsonMode ? (
              <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-950'>
                <h2 className='mb-1 text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
                  Conditions &amp; Actions (JSON)
                </h2>
                <p className='mb-4 text-[11px] text-slate-400'>
                  The exact payload saved to the API. Edits sync back into the builder.
                </p>
                <textarea
                  value={jsonDraft}
                  onChange={(e) => applyJsonDraft(e.target.value)}
                  rows={18}
                  spellCheck={false}
                  className='w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-[12px] text-slate-800 focus:outline-none focus:ring-1 focus:ring-nvr-cyan dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
                />
                {jsonError && (
                  <p className='mt-2 text-[12px] text-red-500'>Invalid JSON: {jsonError}</p>
                )}
              </div>
            ) : (
              <>
                {/* Conditions */}
                <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-950'>
                  <h2 className='mb-1 text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
                    Conditions
                  </h2>
                  <p className='mb-4 text-[11px] text-slate-400'>
                    The actions run when the conditions match. Groups let you combine AND/OR logic
                    one level deep.
                  </p>
                  {!form.collection && (
                    <p className='text-[12px] text-amber-600 dark:text-amber-500'>
                      Select a collection first to choose fields.
                    </p>
                  )}
                  {form.collection && (
                    <ConditionGroupBuilder
                      group={conditionGroup}
                      fields={fields}
                      onChange={setConditionGroup}
                    />
                  )}
                </div>

                {/* Actions */}
                <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-950'>
                  <h2 className='mb-4 text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
                    Actions
                  </h2>
                  {!form.collection && (
                    <p className='text-[12px] text-amber-600 dark:text-amber-500'>
                      Select a collection first to configure actions.
                    </p>
                  )}
                  {form.collection && (
                    <>
                      <div className='space-y-3'>
                        {actions.length === 0 && (
                          <p className='text-[12px] text-slate-400'>No actions defined.</p>
                        )}
                        {actions.map((a, i) => (
                          <ActionCard
                            // biome-ignore lint/suspicious/noArrayIndexKey: action rows have no stable id
                            key={i}
                            action={a}
                            collection={form.collection}
                            collections={collections}
                            onChange={(updated) =>
                              setActions((prev) => prev.map((x, j) => (j === i ? updated : x)))
                            }
                            onRemove={() => setActions((prev) => prev.filter((_, j) => j !== i))}
                          />
                        ))}
                      </div>
                      <button
                        type='button'
                        onClick={() => setActions((prev) => [...prev, { type: 'set_field' }])}
                        className='mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-2 text-[12px] font-medium text-slate-500 transition-colors hover:border-nvr-cyan/50 hover:bg-slate-50 hover:text-nvr-cyan dark:border-slate-700 dark:hover:bg-slate-900'
                      >
                        <Plus className='h-3.5 w-3.5' /> Add Action
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}
