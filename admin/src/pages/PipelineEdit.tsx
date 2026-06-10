import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Filter,
  GripVertical,
  LayoutGrid,
  Link2,
  Link2Off,
  Loader2,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { FieldPicker } from '@/components/field-picker'
import { OwnerMatrix } from '@/components/pipeline-owner-matrix'
import { PipelineSkipCriteria } from '@/components/pipeline-skip-criteria'
import { PipelineStateOwners } from '@/components/pipeline-state-owners'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import {
  api,
  type CMSField,
  type Collection,
  type ConditionOp,
  type ConditionRule,
  exportPipeline,
  type PipelineBinding,
  type PipelineOwnerDimension,
  type PipelineOwnerGroup,
  type PipelineOwnerGroupsMap,
  type PipelineOwnerGroupUser,
  type PipelineState,
  type PipelineTemplate,
  type PipelineTransition
} from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Simple combobox ──────────────────────────────────────────────────────────

function SimpleCombobox({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  noneLabel,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  noneLabel?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else setQuery('')
  }, [open])

  const filtered = query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options

  const selectedLabel = value ? (options.find((o) => o.value === value)?.label ?? value) : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'flex h-8 w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 hover:border-slate-300',
            className
          )}
        >
          <span className={selectedLabel ? '' : 'text-slate-400'}>
            {selectedLabel ?? placeholder}
          </span>
          <div className='flex items-center gap-0.5 shrink-0'>
            {value && noneLabel !== undefined && (
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation()
                  onChange('')
                }}
                className='flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600'
              >
                <X className='h-3 w-3' />
              </button>
            )}
            <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-56 p-0' sideOffset={4}>
        <div className='border-b border-slate-100 px-2 py-1.5'>
          <div className='relative'>
            <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search…'
              className='h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40'
            />
          </div>
        </div>
        <div className='max-h-56 overflow-y-auto py-1'>
          {noneLabel !== undefined && (
            <button
              type='button'
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-slate-50 ${!value ? 'font-medium text-slate-800' : 'text-slate-500'}`}
            >
              <Check className={`h-3.5 w-3.5 shrink-0 ${!value ? 'text-nvr-cyan' : 'opacity-0'}`} />
              {noneLabel}
            </button>
          )}
          {filtered.map((o) => (
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
          {filtered.length === 0 && (
            <div className='px-3 py-2 text-[12px] text-slate-400'>No results</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Multi-state combobox ─────────────────────────────────────────────────────

function MultiStateCombobox({
  values,
  onChange,
  options,
  placeholder = 'Select states…'
}: {
  values: string[]
  onChange: (v: string[]) => void
  options: { value: string; label: string }[]
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else setQuery('')
  }, [open])

  const filtered = query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options

  function toggle(v: string) {
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])
  }

  const labelText =
    values.length === 0
      ? null
      : values.length === 1
        ? (options.find((o) => o.value === values[0])?.label ?? values[0])
        : `${values.length} states`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex h-8 w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 hover:border-slate-300'
        >
          <span className={labelText ? '' : 'text-slate-400'}>{labelText ?? placeholder}</span>
          <div className='flex items-center gap-0.5 shrink-0'>
            {values.length > 0 && (
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation()
                  onChange([])
                }}
                className='flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600'
              >
                <X className='h-3 w-3' />
              </button>
            )}
            <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-56 p-0' sideOffset={4}>
        <div className='border-b border-slate-100 px-2 py-1.5'>
          <div className='relative'>
            <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search…'
              className='h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40'
            />
          </div>
        </div>
        <div className='max-h-56 overflow-y-auto py-1'>
          {filtered.map((o) => {
            const selected = values.includes(o.value)
            return (
              <button
                key={o.value}
                type='button'
                onClick={() => toggle(o.value)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-slate-50 ${selected ? 'font-medium text-slate-800' : 'text-slate-600'}`}
              >
                <Check
                  className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-nvr-cyan' : 'opacity-0'}`}
                />
                {o.label}
              </button>
            )
          })}
          {filtered.length === 0 && (
            <div className='px-3 py-2 text-[12px] text-slate-400'>No results</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Color picker ─────────────────────────────────────────────────────────────

const COLORS = [
  '#6b7280',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899'
]

function ColorPicker({
  value,
  onChange
}: {
  value: string | null
  onChange: (c: string | null) => void
}) {
  return (
    <div className='flex items-center gap-1.5 flex-wrap'>
      <button
        type='button'
        onClick={() => onChange(null)}
        className={cn(
          'h-5 w-5 rounded-full border-2 bg-white transition-all',
          !value ? 'border-slate-400 scale-110' : 'border-slate-200 hover:border-slate-300'
        )}
        title='No color'
      />
      {COLORS.map((c) => (
        <button
          key={c}
          type='button'
          onClick={() => onChange(c)}
          className={cn(
            'h-5 w-5 rounded-full border-2 transition-all',
            value === c ? 'border-slate-700 scale-110' : 'border-transparent hover:scale-105'
          )}
          style={{ backgroundColor: c }}
          title={c}
        />
      ))}
    </div>
  )
}

// ─── State badge ──────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: PipelineState }) {
  return (
    <span
      className='inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium'
      style={{
        backgroundColor: state.color ? `${state.color}22` : '#f1f5f9',
        color: state.color ?? '#475569',
        border: `1px solid ${state.color ? `${state.color}44` : '#e2e8f0'}`
      }}
    >
      {state.is_initial && <span className='text-[10px]'>●</span>}
      {state.label}
      {state.is_terminal && <Check className='h-3 w-3' />}
    </span>
  )
}

// ─── State editor dialog ──────────────────────────────────────────────────────

interface StateFormData {
  key: string
  label: string
  color: string | null
  is_initial: boolean
  is_terminal: boolean
  lock_record: boolean
}

function StateForm({
  initial,
  onSave,
  onCancel,
  saving
}: {
  initial: Partial<StateFormData>
  onSave: (data: StateFormData) => void
  onCancel: () => void
  saving?: boolean
}) {
  const [form, setForm] = useState<StateFormData>({
    key: initial.key ?? '',
    label: initial.label ?? '',
    color: initial.color ?? null,
    is_initial: initial.is_initial ?? false,
    is_terminal: initial.is_terminal ?? false,
    lock_record: initial.lock_record ?? false
  })

  const set = <K extends keyof StateFormData>(k: K, v: StateFormData[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className='space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>Label</Label>
          <Input
            value={form.label}
            onChange={(e) => {
              const label = e.target.value
              set('label', label)
              if (!initial.key) {
                set(
                  'key',
                  label
                    .toLowerCase()
                    .replace(/\s+/g, '_')
                    .replace(/[^a-z0-9_]/g, '')
                )
              }
            }}
            placeholder='e.g. Pending Review'
            className='h-8 text-[13px]'
          />
        </div>
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>Key</Label>
          <Input
            value={form.key}
            onChange={(e) => set('key', e.target.value)}
            placeholder='e.g. pending_review'
            className='h-8 font-mono text-[12px]'
          />
        </div>
      </div>

      <div className='space-y-1.5'>
        <Label className='text-[12px]'>Color</Label>
        <ColorPicker value={form.color} onChange={(c) => set('color', c)} />
      </div>

      <div className='flex flex-wrap gap-4 text-[13px]'>
        <label className='flex items-center gap-1.5 cursor-pointer'>
          <input
            type='checkbox'
            checked={form.is_initial}
            onChange={(e) => set('is_initial', e.target.checked)}
            className='rounded'
          />
          Initial state
        </label>
        <label className='flex items-center gap-1.5 cursor-pointer'>
          <input
            type='checkbox'
            checked={form.is_terminal}
            onChange={(e) => set('is_terminal', e.target.checked)}
            className='rounded'
          />
          Terminal state
        </label>
        <label className='flex items-center gap-1.5 cursor-pointer'>
          <input
            type='checkbox'
            checked={form.lock_record}
            onChange={(e) => set('lock_record', e.target.checked)}
            className='rounded'
          />
          Lock record (read-only)
        </label>
      </div>

      <div className='flex gap-2 justify-end'>
        <Button type='button' variant='outline' size='sm' onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type='button'
          size='sm'
          disabled={!form.key.trim() || !form.label.trim() || saving}
          onClick={() => onSave(form)}
        >
          {saving ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Save State'}
        </Button>
      </div>
    </div>
  )
}

// ─── Group label combobox ─────────────────────────────────────────────────────

function GroupLabelCombobox({
  value,
  onChange,
  existingLabels
}: {
  value: string | null
  onChange: (v: string | null) => void
  existingLabels: string[]
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery(value ?? '')
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
    }
  }, [open, value])

  const trimmed = query.trim()
  const filtered = existingLabels.filter((l) => l.toLowerCase().includes(trimmed.toLowerCase()))
  const canCreate =
    trimmed && !existingLabels.some((l) => l.toLowerCase() === trimmed.toLowerCase())

  function choose(v: string | null) {
    onChange(v)
    setOpen(false)
    setQuery('')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex h-8 w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 hover:border-slate-300'
        >
          <span className={value ? '' : 'text-slate-400'}>{value ?? 'None'}</span>
          <div className='flex items-center gap-0.5 shrink-0'>
            {value && (
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation()
                  choose(null)
                }}
                className='flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600'
              >
                <X className='h-3 w-3' />
              </button>
            )}
            <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-64 p-0' sideOffset={4}>
        <div className='border-b border-slate-100 px-2 py-1.5'>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && trimmed) choose(trimmed)
            }}
            placeholder='Type a name or pick existing…'
            className='h-7 w-full rounded-md bg-slate-50 px-2.5 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40'
          />
        </div>
        <div className='max-h-52 overflow-y-auto py-1'>
          <button
            type='button'
            onClick={() => choose(null)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-slate-50 ${!value ? 'font-medium text-slate-800' : 'text-slate-500'}`}
          >
            <Check className={`h-3.5 w-3.5 shrink-0 ${!value ? 'text-nvr-cyan' : 'opacity-0'}`} />
            None
          </button>

          {filtered.map((l) => (
            <button
              key={l}
              type='button'
              onClick={() => choose(l)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-slate-50 ${value === l ? 'font-medium text-slate-800' : 'text-slate-600'}`}
            >
              <Check
                className={`h-3.5 w-3.5 shrink-0 ${value === l ? 'text-nvr-cyan' : 'opacity-0'}`}
              />
              {l}
            </button>
          ))}

          {canCreate && (
            <button
              type='button'
              onClick={() => choose(trimmed)}
              className='flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-nvr-cyan hover:bg-slate-50'
            >
              <Plus className='h-3.5 w-3.5 shrink-0' />
              Create "{trimmed}"
            </button>
          )}

          {filtered.length === 0 && !canCreate && (
            <div className='px-3 py-2 text-[12px] text-slate-400'>No existing groups</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Transition grouping ──────────────────────────────────────────────────────

type TransitionGroup = {
  key: string
  from_state: string | null
  group_label: string | null
  label: string
  color: string | null
  required_roles: string[] | null
  condition_rules: ConditionRule[] | null
  to_states: string[]
  ids: string[]
}

function groupTransitions(transitions: PipelineTransition[]): TransitionGroup[] {
  const groups: TransitionGroup[] = []
  const groupMap = new Map<string, TransitionGroup>()

  for (const tx of transitions) {
    if (tx.group_label) {
      const key = `${tx.from_state ?? ''}|${tx.group_label}`
      if (!groupMap.has(key)) {
        const g: TransitionGroup = {
          key,
          from_state: tx.from_state,
          group_label: tx.group_label,
          label: tx.label,
          color: tx.color,
          required_roles: tx.required_roles,
          condition_rules: tx.condition_rules,
          to_states: [],
          ids: []
        }
        groupMap.set(key, g)
        groups.push(g)
      }
      const g = groupMap.get(key)!
      g.to_states.push(tx.to_state)
      g.ids.push(tx.id)
    } else {
      groups.push({
        key: tx.id,
        from_state: tx.from_state,
        group_label: null,
        label: tx.label,
        color: tx.color,
        required_roles: tx.required_roles,
        condition_rules: tx.condition_rules,
        to_states: [tx.to_state],
        ids: [tx.id]
      })
    }
  }
  return groups
}

// ─── Transition condition rules (conditional branching) ──────────────────────

const CONDITION_OPS: { value: ConditionOp; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'not equals' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'greater or equal' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'less or equal' },
  { value: 'contains', label: 'contains' },
  { value: 'null', label: 'is empty' },
  { value: 'nnull', label: 'is not empty' }
]

const NUMERIC_FIELD_TYPES = new Set(['integer', 'bigInteger', 'float', 'decimal', 'number'])

function TransitionConditionsSection({
  rules,
  onChange,
  collection
}: {
  rules: ConditionRule[]
  onChange: (rules: ConditionRule[]) => void
  collection?: string
}) {
  const [expanded, setExpanded] = useState(rules.length > 0)

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection
  })
  const fields: CMSField[] = colMeta?.fields?.filter((f: CMSField) => !f.hidden) ?? []
  const fieldType = (name: string) => fields.find((f) => f.field === name)?.type ?? ''

  const updateRule = (idx: number, patch: Partial<ConditionRule>) =>
    onChange(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const removeRule = (idx: number) => onChange(rules.filter((_, i) => i !== idx))

  return (
    <div className='space-y-2 border-t border-slate-200 pt-3'>
      <button
        type='button'
        onClick={() => setExpanded((v) => !v)}
        className='flex items-center gap-1.5 text-[12px] font-medium text-slate-600 hover:text-slate-800'
      >
        {expanded ? (
          <ChevronDown className='h-3.5 w-3.5' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5' />
        )}
        <Filter className='h-3 w-3' />
        Conditions <span className='font-normal text-slate-400'>(optional)</span>
        {rules.length > 0 && (
          <span className='rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-nvr-navy'>
            {rules.length}
          </span>
        )}
      </button>

      {expanded && (
        <div className='space-y-2'>
          <p className='text-[11px] text-slate-400 leading-snug'>
            Transition is only offered when all conditions match the record — use two transitions
            with opposite conditions to branch.
          </p>

          {rules.map((rule, idx) => {
            const noValue = rule.op === 'null' || rule.op === 'nnull'
            const numeric = NUMERIC_FIELD_TYPES.has(fieldType(rule.field))
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional
                key={idx}
                className='flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2'
              >
                <div className='flex-1 min-w-[140px]'>
                  <SimpleCombobox
                    value={rule.field}
                    onChange={(v) => updateRule(idx, { field: v })}
                    options={fields.map((f) => ({ value: f.field, label: f.field }))}
                    placeholder='Field…'
                  />
                </div>
                <div className='w-40 shrink-0'>
                  <SimpleCombobox
                    value={rule.op}
                    onChange={(v) => updateRule(idx, { op: (v || 'eq') as ConditionOp })}
                    options={CONDITION_OPS.map((o) => ({ value: o.value, label: o.label }))}
                    placeholder='Operator…'
                  />
                </div>
                {!noValue && (
                  <div className='flex-1 min-w-[100px]'>
                    <Input
                      type={numeric ? 'number' : 'text'}
                      value={String(rule.value ?? '')}
                      onChange={(e) => updateRule(idx, { value: e.target.value })}
                      placeholder='Value'
                      className='h-8 text-[12px]'
                    />
                  </div>
                )}
                <button
                  type='button'
                  onClick={() => removeRule(idx)}
                  className='rounded p-1 text-slate-400 hover:text-red-500 shrink-0'
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </button>
              </div>
            )
          })}

          <Button
            type='button'
            size='sm'
            variant='outline'
            className='h-7 gap-1 text-[12px]'
            onClick={() => onChange([...rules, { field: '', op: 'eq', value: '' }])}
          >
            <Plus className='h-3 w-3' />
            Add Condition
          </Button>
        </div>
      )}
    </div>
  )
}

// ─── Transition editor ────────────────────────────────────────────────────────

interface TransitionFormData {
  from_state: string | null
  to_states: string[]
  label: string
  color: string | null
  required_roles: string[] | null
  group_label: string | null
  condition_rules: ConditionRule[] | null
}

function TransitionForm({
  initial,
  states,
  collection,
  existingGroupLabels = [],
  onSave,
  onCancel,
  saving
}: {
  initial: Partial<TransitionFormData>
  states: PipelineState[]
  collection?: string
  existingGroupLabels?: string[]
  onSave: (data: TransitionFormData) => void
  onCancel: () => void
  saving?: boolean
}) {
  const [form, setForm] = useState<TransitionFormData>({
    from_state: initial.from_state ?? null,
    to_states: initial.to_states ?? [],
    label: initial.label ?? '',
    color: initial.color ?? null,
    required_roles: initial.required_roles ?? null,
    group_label: initial.group_label ?? null,
    condition_rules: initial.condition_rules ?? null
  })

  const set = <K extends keyof TransitionFormData>(k: K, v: TransitionFormData[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const multiTarget = form.to_states.length > 1
  const isValid =
    form.to_states.length > 0 && form.label.trim() && (!multiTarget || !!form.group_label?.trim())

  return (
    <div className='space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>Button Label</Label>
          <Input
            value={form.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder='e.g. Approve, Submit for Review'
            className='h-8 text-[13px]'
          />
        </div>
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>
            Group Label
            {!multiTarget && <span className='ml-1.5 text-slate-400'>(optional)</span>}
            {multiTarget && <span className='ml-1.5 text-red-400'>required for multi-target</span>}
          </Label>
          <GroupLabelCombobox
            value={form.group_label}
            onChange={(v) => set('group_label', v)}
            existingLabels={existingGroupLabels}
          />
          <p className='text-[11px] text-slate-400 leading-snug'>
            Multi-target transitions share a group label and appear as a single dropdown button in
            the action panel.
          </p>
        </div>
      </div>

      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>From State</Label>
          <SimpleCombobox
            value={form.from_state ?? ''}
            onChange={(v) => set('from_state', v || null)}
            options={states.map((s) => ({ value: s.id, label: s.label }))}
            noneLabel='Any state'
            placeholder='Any state'
          />
        </div>
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>To State{form.to_states.length !== 1 ? 's' : ''}</Label>
          <MultiStateCombobox
            values={form.to_states}
            onChange={(v) => set('to_states', v)}
            options={states.map((s) => ({ value: s.id, label: s.label }))}
            placeholder='Select one or more states…'
          />
          {form.to_states.length > 1 && (
            <div className='flex flex-wrap gap-1 pt-1'>
              {form.to_states.map((sid) => {
                const s = states.find((st) => st.id === sid)
                return (
                  <span
                    key={sid}
                    className='inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-white'
                    style={{ backgroundColor: s?.color ?? '#6b7280' }}
                  >
                    {s?.label ?? sid}
                    <button
                      type='button'
                      onClick={() =>
                        set(
                          'to_states',
                          form.to_states.filter((x) => x !== sid)
                        )
                      }
                      className='opacity-70 hover:opacity-100'
                    >
                      <X className='h-2.5 w-2.5' />
                    </button>
                  </span>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div className='space-y-1.5'>
        <Label className='text-[12px]'>Color</Label>
        <ColorPicker value={form.color} onChange={(c) => set('color', c)} />
      </div>

      <TransitionConditionsSection
        rules={form.condition_rules ?? []}
        onChange={(rules) => set('condition_rules', rules)}
        collection={collection}
      />

      <div className='flex gap-2 justify-end'>
        <Button type='button' variant='outline' size='sm' onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type='button'
          size='sm'
          disabled={!isValid || saving}
          onClick={() => {
            const rules = (form.condition_rules ?? []).filter((r) => r.field.trim())
            onSave({ ...form, condition_rules: rules.length > 0 ? rules : null })
          }}
        >
          {saving ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Save Transition'}
        </Button>
      </div>
    </div>
  )
}

// ─── Sortable state row ───────────────────────────────────────────────────────

function userInitials(u: PipelineOwnerGroupUser): string {
  const f = u.first_name?.[0] ?? ''
  const l = u.last_name?.[0] ?? ''
  return (f + l).toUpperCase() || u.email[0].toUpperCase()
}

function getBaseOwners(groups: PipelineOwnerGroup[]): PipelineOwnerGroupUser[] {
  const base = groups.filter((g) => !g.filters || g.filters.length === 0)
  const seen = new Set<string>()
  const out: PipelineOwnerGroupUser[] = []
  for (const g of base) {
    for (const u of g.users) {
      if (!seen.has(u.user)) {
        seen.add(u.user)
        out.push(u)
      }
    }
  }
  return out
}

function OwnerAvatarStack({
  users,
  filteredCount
}: {
  users: PipelineOwnerGroupUser[]
  filteredCount: number
}) {
  if (!users.length && !filteredCount) return null
  const visible = users.slice(0, 4)
  const rest = users.length - visible.length
  return (
    <div className='flex items-center gap-1.5'>
      {visible.length > 0 && (
        <div className='flex items-center -space-x-1'>
          {visible.map((u) => (
            <div
              key={u.user}
              title={`${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email}
              className='h-5 w-5 rounded-full bg-nvr-cyan/20 border border-white flex items-center justify-center text-[9px] font-semibold text-nvr-cyan'
            >
              {userInitials(u)}
            </div>
          ))}
          {rest > 0 && (
            <div className='h-5 w-5 rounded-full bg-slate-100 border border-white flex items-center justify-center text-[9px] font-medium text-slate-500'>
              +{rest}
            </div>
          )}
        </div>
      )}
      {filteredCount > 0 && (
        <span
          className='text-[10px] text-slate-400'
          title={`${filteredCount} dimension-filtered group${filteredCount !== 1 ? 's' : ''}`}
        >
          +{filteredCount} ctx
        </span>
      )}
    </div>
  )
}

function SortableStateRow({
  s,
  groups,
  expandedStateId: _expandedStateId,
  onToggleExpand,
  onEdit,
  onDelete
}: {
  s: PipelineState
  groups: PipelineOwnerGroup[]
  expandedStateId: string | null
  onToggleExpand: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: s.id
  })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1
      }}
    >
      <div className='group flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2.5 hover:border-slate-200 hover:bg-slate-50'>
        <button
          type='button'
          {...attributes}
          {...listeners}
          className='cursor-grab touch-none text-slate-300 hover:text-slate-400 transition-colors shrink-0'
          tabIndex={-1}
        >
          <GripVertical className='h-3.5 w-3.5' />
        </button>
        <div
          className='h-3 w-3 rounded-full shrink-0'
          style={{ backgroundColor: s.color ?? '#94a3b8' }}
        />
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-2 flex-wrap'>
            <span className='text-[13px] font-medium text-slate-800'>{s.label}</span>
            <span className='font-mono text-[11px] text-slate-400'>{s.key}</span>
            {s.is_initial && (
              <Badge variant='secondary' className='text-[10px] h-4 px-1'>
                initial
              </Badge>
            )}
            {s.is_terminal && (
              <Badge variant='secondary' className='text-[10px] h-4 px-1'>
                terminal
              </Badge>
            )}
            {s.lock_record && (
              <Badge variant='outline' className='text-[10px] h-4 px-1'>
                locked
              </Badge>
            )}
          </div>
        </div>
        <OwnerAvatarStack
          users={getBaseOwners(groups)}
          filteredCount={groups.filter((g) => g.filters && g.filters.length > 0).length}
        />
        <div className='flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0'>
          <button
            type='button'
            onClick={onToggleExpand}
            className='rounded p-1 text-slate-400 hover:text-slate-700'
            title='Configure owners & skip'
          >
            <Settings className='h-3.5 w-3.5' />
          </button>
          <button
            type='button'
            onClick={onEdit}
            className='rounded p-1 text-slate-400 hover:text-slate-700'
          >
            <Pencil className='h-3.5 w-3.5' />
          </button>
          <button
            type='button'
            onClick={onDelete}
            className='rounded p-1 text-slate-400 hover:text-red-500'
          >
            <Trash2 className='h-3.5 w-3.5' />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Sortable dimension row ───────────────────────────────────────────────────

function SortableDimensionRow({
  d,
  onEdit,
  onDelete
}: {
  d: PipelineOwnerDimension
  onEdit: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: d.id
  })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1
      }}
      className='flex items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2'
    >
      <button
        type='button'
        {...attributes}
        {...listeners}
        className='cursor-grab touch-none text-slate-300 hover:text-slate-400 transition-colors'
        tabIndex={-1}
      >
        <GripVertical className='h-3.5 w-3.5' />
      </button>
      <div className='flex-1 min-w-0 flex items-center gap-3 flex-wrap'>
        <span className='font-mono text-[12px] text-slate-600 shrink-0'>{d.field}</span>
        <span className='text-[13px] font-medium text-slate-800'>{d.label}</span>
        {d.is_row_axis && (
          <Badge variant='secondary' className='text-[10px] h-4 px-1.5 shrink-0'>
            row axis
          </Badge>
        )}
        {d.required && (
          <Badge
            variant='secondary'
            className='text-[10px] h-4 px-1.5 shrink-0 bg-amber-50 text-amber-600 border-amber-200'
          >
            required
          </Badge>
        )}
      </div>
      <div className='flex items-center gap-1 shrink-0'>
        <button
          type='button'
          onClick={onEdit}
          className='rounded p-1 text-slate-400 hover:text-slate-700 transition-colors'
        >
          <Pencil className='h-3.5 w-3.5' />
        </button>
        <button
          type='button'
          onClick={onDelete}
          className='rounded p-1 text-slate-400 hover:text-red-500 transition-colors'
        >
          <Trash2 className='h-3.5 w-3.5' />
        </button>
      </div>
    </div>
  )
}

// ─── Binding dimensions panel ───────────────────────────────────────────────

interface DimensionFormData {
  field: string
  label: string
  sort: number
  is_row_axis: boolean
  required: boolean
}

function BindingDimensionsPanel({
  binding,
  templateId
}: {
  binding: PipelineBinding
  templateId: string
}) {
  const queryClient = useQueryClient()
  const dimensions: PipelineOwnerDimension[] = binding.dimensions ?? []

  // Local ID order for optimistic drag reordering
  const [localOrder, setLocalOrder] = useState<number[]>(() => dimensions.map((d) => d.id))
  useEffect(() => {
    setLocalOrder(dimensions.map((d) => d.id))
  }, [dimensions])
  const orderedDims = localOrder
    .map((id) => dimensions.find((d) => d.id === id))
    .filter(Boolean) as PipelineOwnerDimension[]

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const [editingDimId, setEditingDimId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<DimensionFormData>({
    field: '',
    label: '',
    sort: 0,
    is_row_axis: false,
    required: false
  })
  const [newForm, setNewForm] = useState<DimensionFormData>({
    field: '',
    label: '',
    sort: 0,
    is_row_axis: false,
    required: false
  })

  const { data: bindingColMeta } = useQuery({
    queryKey: ['collection-meta', binding.collection],
    queryFn: () => api.get(`/collections/${binding.collection}`).then((r) => r.data.data),
    enabled: !!binding.collection
  })
  const bindingFields: CMSField[] = bindingColMeta?.fields?.filter((f: CMSField) => !f.hidden) ?? []

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['pipeline-template', templateId] })

  const addDimension = useMutation({
    mutationFn: (body: DimensionFormData) =>
      api.post(`/pipelines/bindings/${binding.id}/dimensions`, body).then((r) => r.data),
    onSuccess: () => {
      invalidate()
      setNewForm({ field: '', label: '', sort: 0, is_row_axis: false, required: false })
      toast.success('Dimension added')
    },
    onError: () => toast.error('Failed to add dimension')
  })

  const updateDimension = useMutation({
    mutationFn: ({ dimId, body }: { dimId: number; body: Partial<DimensionFormData> }) =>
      api.patch(`/pipelines/dimensions/${dimId}`, body).then((r) => r.data),
    onSuccess: () => {
      invalidate()
      setEditingDimId(null)
      toast.success('Dimension updated')
    },
    onError: () => toast.error('Failed to update dimension')
  })

  const deleteDimension = useMutation({
    mutationFn: (dimId: number) => api.delete(`/pipelines/dimensions/${dimId}`),
    onSuccess: () => {
      invalidate()
      toast.success('Dimension deleted')
    },
    onError: () => toast.error('Failed to delete dimension')
  })

  const startEdit = (d: PipelineOwnerDimension) => {
    setEditingDimId(d.id)
    setEditForm({
      field: d.field,
      label: d.label,
      sort: d.sort,
      is_row_axis: d.is_row_axis,
      required: d.required
    })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = localOrder.indexOf(active.id as number)
    const newIndex = localOrder.indexOf(over.id as number)
    const nextOrder = arrayMove(localOrder, oldIndex, newIndex)
    setLocalOrder(nextOrder)
    // Persist new sort values
    nextOrder.forEach((id, i) => {
      if (dimensions.find((d) => d.id === id)?.sort !== i) {
        updateDimension.mutate({ dimId: id, body: { sort: i } })
      }
    })
  }

  return (
    <div className='border-t border-slate-100 bg-slate-50/50 px-4 pt-3 pb-4 space-y-3 rounded-b-lg'>
      {dimensions.length === 0 && (
        <p className='text-[12px] text-slate-400 py-0.5'>No dimensions — add one below.</p>
      )}

      {dimensions.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={localOrder} strategy={verticalListSortingStrategy}>
            <div className='space-y-1.5'>
              {orderedDims.map((d) =>
                editingDimId === d.id ? (
                  <div
                    key={d.id}
                    className='rounded-md border border-slate-200 bg-white p-3 space-y-3'
                  >
                    <div className='flex flex-wrap items-end gap-3'>
                      <div className='space-y-1.5 flex-1 min-w-[160px]'>
                        <Label className='text-[11px] text-slate-500'>Field</Label>
                        <FieldPicker
                          collection={binding.collection}
                          fields={bindingFields}
                          relations={bindingColMeta?.relations ?? []}
                          value={editForm.field}
                          onChange={(picked) => {
                            const fieldName = picked.path.join('.')
                            setEditForm((f) => ({
                              ...f,
                              field: fieldName,
                              label: f.label || picked.pathLabels.join(' → ')
                            }))
                          }}
                          onClear={() => setEditForm((f) => ({ ...f, field: '' }))}
                        />
                      </div>
                      <div className='space-y-1.5 flex-1 min-w-[100px]'>
                        <Label className='text-[11px] text-slate-500'>Label</Label>
                        <Input
                          value={editForm.label}
                          onChange={(e) => setEditForm((f) => ({ ...f, label: e.target.value }))}
                          placeholder='e.g. Region'
                          className='h-8 text-[13px]'
                        />
                      </div>
                      <label className='flex items-center gap-1.5 cursor-pointer text-[12px] text-slate-700 mb-1 whitespace-nowrap'>
                        <input
                          type='checkbox'
                          checked={editForm.is_row_axis}
                          onChange={(e) =>
                            setEditForm((f) => ({ ...f, is_row_axis: e.target.checked }))
                          }
                          className='rounded'
                        />
                        Row axis
                      </label>
                      <label className='flex items-center gap-1.5 cursor-pointer text-[12px] text-slate-700 mb-1 whitespace-nowrap'>
                        <input
                          type='checkbox'
                          checked={editForm.required}
                          onChange={(e) =>
                            setEditForm((f) => ({ ...f, required: e.target.checked }))
                          }
                          className='rounded'
                        />
                        Required
                      </label>
                    </div>
                    <div className='flex justify-end gap-2'>
                      <Button
                        type='button'
                        variant='ghost'
                        size='sm'
                        className='text-[12px] h-7'
                        onClick={() => setEditingDimId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type='button'
                        size='sm'
                        className='text-[12px] h-7'
                        disabled={
                          !editForm.field.trim() ||
                          !editForm.label.trim() ||
                          updateDimension.isPending
                        }
                        onClick={() => updateDimension.mutate({ dimId: d.id, body: editForm })}
                      >
                        {updateDimension.isPending ? (
                          <Loader2 className='h-3.5 w-3.5 animate-spin' />
                        ) : (
                          'Save'
                        )}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <SortableDimensionRow
                    key={d.id}
                    d={d}
                    onEdit={() => startEdit(d)}
                    onDelete={() => {
                      if (confirm(`Delete dimension "${d.label}"?`)) deleteDimension.mutate(d.id)
                    }}
                  />
                )
              )}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Add dimension — compact inline form */}
      <div className='flex flex-wrap items-end gap-2 pt-2 border-t border-slate-100'>
        <div className='space-y-1.5 flex-1 min-w-[160px]'>
          <Label className='text-[11px] text-slate-500'>Field</Label>
          <FieldPicker
            collection={binding.collection}
            fields={bindingFields}
            relations={bindingColMeta?.relations ?? []}
            value={newForm.field}
            onChange={(picked) => {
              const fieldName = picked.path.join('.')
              setNewForm((f) => ({
                ...f,
                field: fieldName,
                label: f.label || picked.pathLabels.join(' → ')
              }))
            }}
            onClear={() => setNewForm((f) => ({ ...f, field: '' }))}
          />
        </div>
        <div className='space-y-1.5 flex-1 min-w-[100px]'>
          <Label className='text-[11px] text-slate-500'>Label</Label>
          <Input
            value={newForm.label}
            onChange={(e) => setNewForm((f) => ({ ...f, label: e.target.value }))}
            placeholder='e.g. Region'
            className='h-8 text-[13px]'
          />
        </div>
        <label className='flex items-center gap-1.5 cursor-pointer text-[12px] text-slate-700 mb-0.5 whitespace-nowrap'>
          <input
            type='checkbox'
            checked={newForm.is_row_axis}
            onChange={(e) => setNewForm((f) => ({ ...f, is_row_axis: e.target.checked }))}
            className='rounded'
          />
          Row axis
        </label>
        <label className='flex items-center gap-1.5 cursor-pointer text-[12px] text-slate-700 mb-0.5 whitespace-nowrap'>
          <input
            type='checkbox'
            checked={newForm.required}
            onChange={(e) => setNewForm((f) => ({ ...f, required: e.target.checked }))}
            className='rounded'
          />
          Required
        </label>
        <Button
          type='button'
          size='sm'
          variant='outline'
          className='gap-1.5 text-[12px] h-8 mb-0.5'
          disabled={!newForm.field.trim() || !newForm.label.trim() || addDimension.isPending}
          onClick={() => addDimension.mutate({ ...newForm, sort: dimensions.length })}
        >
          {addDimension.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Plus className='h-3 w-3' />
          )}
          Add
        </Button>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function PipelineEditPage() {
  const { id } = useParams<{ id: string }>()
  const _navigate = useNavigate()
  const queryClient = useQueryClient()

  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [addingState, setAddingState] = useState(false)
  const [editingState, setEditingState] = useState<PipelineState | null>(null)
  const [addingTransition, setAddingTransition] = useState(false)
  const [editingGroup, setEditingGroup] = useState<TransitionGroup | null>(null)
  const [bindingCollection, setBindingCollection] = useState('')
  const [stateField, setStateField] = useState('')
  const [expandedStateId, setExpandedStateId] = useState<string | null>(null)

  // Local order for optimistic drag reordering of states
  const [localStateOrder, setLocalStateOrder] = useState<string[]>([])

  const stateSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const { data: bindingColFields } = useQuery({
    queryKey: ['collection-fields', bindingCollection],
    queryFn: () =>
      api
        .get(`/collections/${bindingCollection}`)
        .then((r) => (r.data.data?.fields ?? []).filter((f: CMSField) => !f.hidden)),
    enabled: !!bindingCollection
  })
  const [expandedBindingId, setExpandedBindingId] = useState<number | null>(null)

  const { data: templateData, isLoading } = useQuery<PipelineTemplate>({
    queryKey: ['pipeline-template', id],
    queryFn: () => api.get<{ data: PipelineTemplate }>(`/pipelines/${id}`).then((r) => r.data.data),
    enabled: !!id
  })

  // Sync localStateOrder from server whenever templateData.states changes
  useEffect(() => {
    const serverStates = templateData?.states ?? []
    setLocalStateOrder(serverStates.map((s) => s.id))
  }, [templateData?.states])

  const { data: collectionsData } = useQuery<Collection[]>({
    queryKey: ['collections', 'tables_only'],
    queryFn: () =>
      api.get<{ data: Collection[] }>('/collections?tables_only=true').then((r) => r.data.data)
  })

  const { data: ownerGroupsMap } = useQuery<PipelineOwnerGroupsMap>({
    queryKey: ['pipeline-all-owner-groups', id],
    queryFn: () =>
      api
        .get<{ data: PipelineOwnerGroupsMap }>(`/pipelines/${id}/owner-groups`)
        .then((r) => r.data.data),
    enabled: !!id
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['pipeline-template', id] })
    queryClient.invalidateQueries({ queryKey: ['pipeline-templates'] })
    queryClient.invalidateQueries({ queryKey: ['pipeline-all-owner-groups', id] })
  }

  // ─── Template mutations ─────────────────────────────────────────────────

  const updateTemplate = useMutation({
    mutationFn: (body: Partial<PipelineTemplate>) =>
      api.patch(`/pipelines/${id}`, body).then((r) => r.data),
    onSuccess: () => {
      invalidate()
      setEditingName(false)
    },
    onError: () => toast.error('Failed to update pipeline')
  })

  // ─── State mutations ────────────────────────────────────────────────────

  const addState = useMutation({
    mutationFn: (body: Omit<PipelineState, 'id' | 'template'>) =>
      api.post(`/pipelines/${id}/states`, body).then((r) => r.data),
    onSuccess: () => {
      invalidate()
      setAddingState(false)
    },
    onError: () => toast.error('Failed to add state')
  })

  const updateState = useMutation({
    mutationFn: ({ stateId, body }: { stateId: string; body: Partial<PipelineState> }) =>
      api.patch(`/pipelines/states/${stateId}`, body).then((r) => r.data),
    onSuccess: () => {
      invalidate()
      setEditingState(null)
    },
    onError: () => toast.error('Failed to update state')
  })

  const deleteState = useMutation({
    mutationFn: (stateId: string) => api.delete(`/pipelines/states/${stateId}`),
    onSuccess: () => {
      invalidate()
      toast.success('State deleted')
    },
    onError: () => toast.error('Failed to delete state')
  })

  // ─── Transition mutations ───────────────────────────────────────────────

  const addTransitions = useMutation({
    mutationFn: async (data: TransitionFormData) => {
      const shared = {
        from_state: data.from_state,
        label: data.label,
        color: data.color,
        required_roles: data.required_roles,
        condition_rules: data.condition_rules,
        actions: null,
        sort: 0,
        group_label:
          data.to_states.length > 1 ? (data.group_label ?? data.label) : (data.group_label ?? null)
      }
      for (const to_state of data.to_states) {
        await api.post(`/pipelines/${id}/transitions`, { ...shared, to_state })
      }
    },
    onSuccess: () => {
      invalidate()
      setAddingTransition(false)
    },
    onError: () => toast.error('Failed to add transition')
  })

  const updateTransitionGroup = useMutation({
    mutationFn: async ({ group, data }: { group: TransitionGroup; data: TransitionFormData }) => {
      const shared = {
        from_state: data.from_state,
        label: data.label,
        color: data.color,
        required_roles: data.required_roles,
        condition_rules: data.condition_rules,
        group_label:
          data.to_states.length > 1 ? (data.group_label ?? data.label) : (data.group_label ?? null)
      }
      // Delete all old rows in the group, then create new ones
      for (const txId of group.ids) {
        await api.delete(`/pipelines/transitions/${txId}`)
      }
      for (const to_state of data.to_states) {
        await api.post(`/pipelines/${id}/transitions`, {
          ...shared,
          to_state,
          actions: null,
          sort: 0
        })
      }
    },
    onSuccess: () => {
      invalidate()
      setEditingGroup(null)
    },
    onError: () => toast.error('Failed to update transition')
  })

  const deleteTransitionGroup = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const txId of ids) {
        await api.delete(`/pipelines/transitions/${txId}`)
      }
    },
    onSuccess: () => {
      invalidate()
      toast.success('Transition deleted')
    },
    onError: () => toast.error('Failed to delete transition')
  })

  // ─── Binding mutations ──────────────────────────────────────────────────

  const bindCollection = useMutation({
    mutationFn: (body: { collection: string; state_field?: string }) =>
      api.post(`/pipelines/${id}/bind`, body).then((r) => r.data),
    onSuccess: () => {
      invalidate()
      setBindingCollection('')
      setStateField('')
      toast.success('Collection bound')
    },
    onError: () => toast.error('Failed to bind collection')
  })

  const unbindCollection = useMutation({
    mutationFn: (bindingId: number) => api.delete(`/pipelines/bindings/${bindingId}`),
    onSuccess: () => {
      invalidate()
      toast.success('Collection unbound')
    },
    onError: () => toast.error('Failed to unbind')
  })

  if (isLoading || !templateData) {
    return (
      <div className='p-8 space-y-4'>
        <Skeleton className='h-8 w-64' />
        <Skeleton className='h-48 rounded-xl' />
        <Skeleton className='h-48 rounded-xl' />
      </div>
    )
  }

  const states: PipelineState[] = templateData.states ?? []
  const transitions: PipelineTransition[] = templateData.transitions ?? []
  const bindings: PipelineBinding[] = templateData.bindings ?? []
  const collections: Collection[] = collectionsData ?? []

  const orderedStates =
    localStateOrder.length > 0
      ? (localStateOrder
          .map((sid) => states.find((s) => s.id === sid))
          .filter(Boolean) as PipelineState[])
      : states

  const stateById = new Map(states.map((s) => [s.id, s]))
  const hasMatrix = bindings.some((b) => (b.dimensions ?? []).length > 0)
  const boundCollections = new Set(bindings.map((b) => b.collection))
  const availableCollections = collections.filter((c) => !boundCollections.has(c.collection))

  const handleStateDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = localStateOrder.indexOf(active.id as string)
    const newIndex = localStateOrder.indexOf(over.id as string)
    const nextOrder = arrayMove(localStateOrder, oldIndex, newIndex)
    setLocalStateOrder(nextOrder)
    // Persist new sort values — only patch states whose sort value actually changed
    nextOrder.forEach((sid, i) => {
      if (states.find((s) => s.id === sid)?.sort !== i) {
        updateState.mutate({ stateId: sid, body: { sort: i } })
      }
    })
  }

  return (
    <>
      {/* Sticky header */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2 text-[13px]'>
            <Link
              to='/pipelines'
              className='flex items-center gap-1 text-slate-400 transition-colors hover:text-slate-700'
            >
              <ArrowLeft className='h-3.5 w-3.5' />
              Pipelines
            </Link>
            <span className='text-slate-300'>/</span>
            {editingName ? (
              <form
                className='flex items-center gap-1.5'
                onSubmit={(e) => {
                  e.preventDefault()
                  if (nameInput.trim()) updateTemplate.mutate({ name: nameInput.trim() })
                }}
              >
                <Input
                  autoFocus
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  className='h-7 text-[13px] w-48'
                />
                <Button type='submit' size='sm' variant='ghost' className='h-7 px-1.5'>
                  <Check className='h-3.5 w-3.5' />
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  className='h-7 px-1.5'
                  onClick={() => setEditingName(false)}
                >
                  <X className='h-3.5 w-3.5' />
                </Button>
              </form>
            ) : (
              <button
                type='button'
                className='flex items-center gap-1.5 font-medium text-slate-800 hover:text-slate-600'
                onClick={() => {
                  setNameInput(templateData.name)
                  setEditingName(true)
                }}
              >
                {templateData.name}
                <Pencil className='h-3 w-3 text-slate-400' />
              </button>
            )}
          </div>
          <Button
            size='sm'
            variant='outline'
            onClick={async () => {
              try {
                await exportPipeline(id!)
              } catch {
                toast.error('Export failed')
              }
            }}
          >
            <Download className='mr-1.5 h-3.5 w-3.5' /> Export
          </Button>
        </div>
      </div>

      <div className='p-6 lg:p-8 space-y-6'>
        {/* Template meta — horizontal strip */}
        <div className='flex flex-col sm:flex-row gap-6 rounded-xl border border-slate-200 bg-white px-6 py-5'>
          <div className='flex-1 space-y-1.5 min-w-0'>
            <Label className='text-[12px]'>Description</Label>
            <Input
              defaultValue={templateData.description ?? ''}
              placeholder='What does this pipeline govern?'
              className='text-[13px]'
              onBlur={(e) => {
                const val = e.target.value.trim() || null
                if (val !== templateData.description) updateTemplate.mutate({ description: val })
              }}
            />
          </div>
          <div className='shrink-0 space-y-1.5'>
            <Label className='text-[12px]'>Accent color</Label>
            <ColorPicker
              value={templateData.color}
              onChange={(c) => updateTemplate.mutate({ color: c })}
            />
          </div>
        </div>

        {/* States + Transitions — two columns on large screens */}
        <div className='grid gap-6 lg:grid-cols-[5fr_7fr]'>
          {/* States */}
          <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
            <div className='flex items-center justify-between'>
              <h2 className='text-[13px] font-semibold text-slate-800'>
                States
                <span className='ml-2 font-mono text-[11px] font-normal text-slate-400'>
                  {states.length}
                </span>
              </h2>
              {!addingState && (
                <Button
                  size='sm'
                  variant='outline'
                  className='gap-1.5 text-[12px] h-7'
                  onClick={() => setAddingState(true)}
                >
                  <Plus className='h-3 w-3' />
                  Add State
                </Button>
              )}
            </div>

            {states.length === 0 && !addingState && (
              <p className='text-[13px] text-slate-400'>
                No states yet. States define the stages a record can be in.
              </p>
            )}

            <DndContext
              sensors={stateSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleStateDragEnd}
            >
              <SortableContext items={localStateOrder} strategy={verticalListSortingStrategy}>
                <div className='space-y-2'>
                  {orderedStates.map((s) => (
                    <div key={s.id}>
                      {editingState?.id === s.id ? (
                        <StateForm
                          initial={s}
                          saving={updateState.isPending}
                          onSave={(data) => updateState.mutate({ stateId: s.id, body: data })}
                          onCancel={() => setEditingState(null)}
                        />
                      ) : (
                        <SortableStateRow
                          s={s}
                          groups={ownerGroupsMap?.[s.id] ?? []}
                          expandedStateId={expandedStateId}
                          onToggleExpand={() =>
                            setExpandedStateId(expandedStateId === s.id ? null : s.id)
                          }
                          onEdit={() => setEditingState(s)}
                          onDelete={() => {
                            if (confirm(`Delete state "${s.label}"?`)) deleteState.mutate(s.id)
                          }}
                        />
                      )}
                      {expandedStateId === s.id && editingState?.id !== s.id && (
                        <div className='ml-4 mb-2 mt-2 rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-4'>
                          <PipelineStateOwners
                            stateId={s.id}
                            stateName={s.label}
                            templateId={id!}
                            collection={bindings[0]?.collection}
                          />
                          <div className='border-t border-slate-200 pt-4'>
                            <PipelineSkipCriteria
                              stateId={s.id}
                              stateName={s.label}
                              templateId={id!}
                              initialCriteria={s.skip_criteria ?? null}
                              collection={bindings[0]?.collection}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {addingState && (
                    <StateForm
                      initial={{}}
                      saving={addState.isPending}
                      onSave={(data) => addState.mutate({ ...data, sort: states.length })}
                      onCancel={() => setAddingState(false)}
                    />
                  )}
                </div>
              </SortableContext>
            </DndContext>
          </div>

          {/* Transitions */}
          <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
            <div className='flex items-center justify-between'>
              <h2 className='text-[13px] font-semibold text-slate-800'>
                Transitions
                <span className='ml-2 font-mono text-[11px] font-normal text-slate-400'>
                  {transitions.length}
                </span>
              </h2>
              {!addingTransition && (
                <Button
                  size='sm'
                  variant='outline'
                  className='gap-1.5 text-[12px] h-7'
                  onClick={() => setAddingTransition(true)}
                  disabled={states.length < 2}
                >
                  <Plus className='h-3 w-3' />
                  Add Transition
                </Button>
              )}
            </div>

            {states.length < 2 && (
              <p className='text-[12px] text-slate-400'>
                Add at least 2 states before defining transitions.
              </p>
            )}

            <div className='space-y-2'>
              {groupTransitions(transitions).map((grp) => {
                const fromState = grp.from_state ? stateById.get(grp.from_state) : null
                const existingGroupLabels = [
                  ...new Set(transitions.map((t) => t.group_label).filter(Boolean) as string[])
                ]
                return (
                  <div key={grp.key}>
                    {editingGroup?.key === grp.key ? (
                      <TransitionForm
                        initial={{
                          from_state: grp.from_state,
                          to_states: grp.to_states,
                          label: grp.label,
                          color: grp.color,
                          required_roles: grp.required_roles,
                          group_label: grp.group_label,
                          condition_rules: grp.condition_rules
                        }}
                        states={states}
                        collection={bindings[0]?.collection}
                        existingGroupLabels={existingGroupLabels}
                        saving={updateTransitionGroup.isPending}
                        onSave={(data) => updateTransitionGroup.mutate({ group: grp, data })}
                        onCancel={() => setEditingGroup(null)}
                      />
                    ) : (
                      <div className='group flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2.5 hover:border-slate-200 hover:bg-slate-50'>
                        {grp.color && (
                          <div
                            className='h-3 w-3 rounded-full shrink-0'
                            style={{ backgroundColor: grp.color }}
                          />
                        )}
                        <div className='flex-1 min-w-0 flex items-center gap-2 flex-wrap'>
                          <span className='text-[13px] font-semibold text-slate-800'>
                            {grp.label}
                          </span>
                          {grp.group_label && grp.to_states.length > 1 && (
                            <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500'>
                              {grp.group_label}
                            </span>
                          )}
                          {(grp.condition_rules ?? []).length > 0 && (
                            <span
                              className='inline-flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-2 py-0.5 text-[11px] font-medium text-nvr-navy'
                              title={(grp.condition_rules ?? [])
                                .map((r) => `${r.field} ${r.op} ${String(r.value ?? '')}`.trim())
                                .join(' AND ')}
                            >
                              <Filter className='h-3 w-3' />
                              {(grp.condition_rules ?? []).length}
                            </span>
                          )}
                          <span className='text-[12px] text-slate-400'>
                            {fromState ? (
                              <StateBadge state={fromState} />
                            ) : (
                              <span className='italic text-slate-400'>any state</span>
                            )}
                          </span>
                          <ArrowRight className='h-3 w-3 text-slate-300 shrink-0' />
                          <span className='flex items-center gap-1 flex-wrap'>
                            {grp.to_states.map((sid, i) => {
                              const s = stateById.get(sid)
                              return s ? (
                                <span key={sid} className='flex items-center gap-1'>
                                  {i > 0 && <span className='text-slate-300 text-[11px]'>/</span>}
                                  <StateBadge state={s} />
                                </span>
                              ) : null
                            })}
                          </span>
                        </div>
                        <div className='flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0'>
                          <button
                            type='button'
                            onClick={() => setEditingGroup(grp)}
                            className='rounded p-1 text-slate-400 hover:text-slate-700'
                          >
                            <Pencil className='h-3.5 w-3.5' />
                          </button>
                          <button
                            type='button'
                            onClick={() => {
                              const label =
                                grp.to_states.length > 1
                                  ? `group "${grp.label}" (${grp.to_states.length} transitions)`
                                  : `"${grp.label}"`
                              if (confirm(`Delete transition ${label}?`))
                                deleteTransitionGroup.mutate(grp.ids)
                            }}
                            className='rounded p-1 text-slate-400 hover:text-red-500'
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              {addingTransition && (
                <TransitionForm
                  initial={{}}
                  states={states}
                  collection={bindings[0]?.collection}
                  existingGroupLabels={[
                    ...new Set(transitions.map((t) => t.group_label).filter(Boolean) as string[])
                  ]}
                  saving={addTransitions.isPending}
                  onSave={(data) => addTransitions.mutate(data)}
                  onCancel={() => setAddingTransition(false)}
                />
              )}
            </div>
          </div>
        </div>
        {/* end states+transitions grid */}

        {/* Bindings */}
        <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
          <h2 className='text-[13px] font-semibold text-slate-800'>Applied to Collections</h2>

          {bindings.length > 0 && (
            <div className='space-y-2'>
              {bindings.map((b) => (
                <div key={b.id} className='rounded-lg border border-slate-200 bg-white'>
                  <div className='flex items-center gap-3 px-4 py-3'>
                    <div className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100'>
                      <Link2 className='h-3.5 w-3.5 text-slate-500' />
                    </div>
                    <div className='flex-1 min-w-0'>
                      <span className='font-mono text-[13px] font-medium text-slate-800'>
                        {b.collection}
                      </span>
                      {b.state_field && (
                        <div className='mt-0.5 text-[11px] text-slate-400'>
                          state field:{' '}
                          <span className='font-mono text-slate-500'>{b.state_field}</span>
                        </div>
                      )}
                    </div>
                    <div className='flex items-center gap-1 shrink-0'>
                      <button
                        type='button'
                        onClick={() =>
                          setExpandedBindingId(expandedBindingId === b.id ? null : b.id)
                        }
                        className={cn(
                          'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                          expandedBindingId === b.id
                            ? 'bg-nvr-cyan/10 text-nvr-cyan'
                            : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                        )}
                        title='Configure matrix dimensions'
                      >
                        <LayoutGrid className='h-3.5 w-3.5' />
                        Dimensions
                        {(b.dimensions ?? []).length > 0 && (
                          <span className='font-mono text-[10px] opacity-70'>
                            ({b.dimensions?.length})
                          </span>
                        )}
                      </button>
                      <button
                        type='button'
                        onClick={() => {
                          if (confirm(`Unbind "${b.collection}"?`)) unbindCollection.mutate(b.id)
                        }}
                        className='rounded p-1.5 text-slate-400 hover:text-red-500 transition-colors'
                        title='Unbind collection'
                      >
                        <Link2Off className='h-3.5 w-3.5' />
                      </button>
                    </div>
                  </div>
                  {expandedBindingId === b.id && (
                    <BindingDimensionsPanel binding={b} templateId={id!} />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Bind new collection */}
          <div className='space-y-2 pt-2'>
            <div className='flex gap-2'>
              <SimpleCombobox
                value={bindingCollection}
                onChange={setBindingCollection}
                options={availableCollections.map((c) => ({
                  value: c.collection,
                  label: c.display_name ?? c.collection
                }))}
                placeholder='Select a collection…'
                className='flex-1'
              />
              <SimpleCombobox
                value={stateField}
                onChange={setStateField}
                options={(bindingColFields ?? []).map((f: CMSField) => ({
                  value: f.field,
                  label: f.field
                }))}
                placeholder='state_field (optional)'
                noneLabel='None'
                className='w-48 font-mono text-[12px]'
              />
              <Button
                type='button'
                size='sm'
                variant='outline'
                className='shrink-0 gap-1.5'
                disabled={!bindingCollection || bindCollection.isPending}
                onClick={() =>
                  bindCollection.mutate({
                    collection: bindingCollection,
                    state_field: stateField.trim() || undefined
                  })
                }
              >
                <Link2 className='h-3.5 w-3.5' />
                Bind
              </Button>
            </div>
            <p className='text-[11px] text-slate-400'>
              <strong>state_field</strong> is optional — if set, Nivaro will write the current state
              key to that column on the record on every transition.
            </p>
          </div>
        </div>

        {/* Owner Matrix */}
        {hasMatrix && (
          <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
            <h2 className='text-[13px] font-semibold text-slate-800'>Owner Matrix</h2>
            <OwnerMatrix templateId={id!} states={orderedStates} bindings={bindings} />
          </div>
        )}
      </div>
    </>
  )
}
