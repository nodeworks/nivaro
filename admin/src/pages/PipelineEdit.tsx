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
import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { FieldPicker, type PickedField } from '@/components/field-picker'
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
  type CMSRelation,
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
import { extractTemplateFields, findM2ORelation, renderDisplayTemplate } from '@/lib/relations'
import { cn, titleCase } from '@/lib/utils'

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
      <div className={cn('relative flex h-8 w-full', className)}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex h-full w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 hover:border-slate-300'
          >
            <span className={selectedLabel ? '' : 'text-slate-400'}>
              {selectedLabel ?? placeholder}
            </span>
            <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          </button>
        </PopoverTrigger>
        {value && noneLabel !== undefined && (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              onChange('')
            }}
            className='absolute right-6 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600'
          >
            <X className='h-3 w-3' />
          </button>
        )}
      </div>
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
      <div className='relative flex h-8 w-full'>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex h-full w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 hover:border-slate-300'
          >
            <span className={labelText ? '' : 'text-slate-400'}>{labelText ?? placeholder}</span>
            <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          </button>
        </PopoverTrigger>
        {values.length > 0 && (
          <button
            type='button'
            onClick={(e) => { e.stopPropagation(); onChange([]) }}
            className='absolute right-6 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600'
          >
            <X className='h-3 w-3' />
          </button>
        )}
      </div>
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

function StateBadge({ state, small }: { state: PipelineState; small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${small ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-[12px]'}`}
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
  stage_visibility: 'always' | 'hide' | 'hide_unless_active'
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
    lock_record: initial.lock_record ?? false,
    stage_visibility: (initial as Partial<StateFormData>).stage_visibility ?? 'always'
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

      <div className='space-y-1.5'>
        <Label className='text-[12px]'>Stage progress visibility</Label>
        <div className='flex flex-col gap-1.5'>
          {(
            [
              { value: 'always', label: 'Always visible' },
              { value: 'hide_unless_active', label: 'Hide unless active or in history' },
              { value: 'hide', label: 'Always hidden from stages' }
            ] as const
          ).map((opt) => (
            <label key={opt.value} className='flex cursor-pointer items-center gap-2 text-[13px]'>
              <input
                type='radio'
                name='stage_visibility'
                value={opt.value}
                checked={form.stage_visibility === opt.value}
                onChange={() => set('stage_visibility', opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
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
// Group by `label` — the label IS the button. Routes within a label group
// each represent one from_state → [to_states] bundle sharing the same conditions.
// Two transitions with the same from_state but different condition_rules are
// kept as separate routes so they can be edited and displayed independently.

type RouteEntry = {
  ids: string[]
  from_state: string | null
  to_states: string[]
  condition_rules: ConditionRule[] | null
  required_roles: string[] | null
  minSort: number
}

type LabelGroup = {
  label: string
  color: string | null
  routes: RouteEntry[]
  minSort: number
}

function conditionKey(rules: ConditionRule[] | null): string {
  if (!rules || rules.length === 0) return ''
  return [...rules]
    .sort((a, b) =>
      `${a.field}${a.op}${String(a.value)}`.localeCompare(`${b.field}${b.op}${String(b.value)}`)
    )
    .map((r) => `${r.field}:${r.op}:${String(r.value ?? '')}`)
    .join('|')
}

function groupByLabel(transitions: PipelineTransition[]): LabelGroup[] {
  const labelMap = new Map<string, LabelGroup>()
  for (const tx of transitions) {
    if (!labelMap.has(tx.label)) {
      labelMap.set(tx.label, { label: tx.label, color: tx.color, routes: [], minSort: tx.sort })
    }
    const grp = labelMap.get(tx.label)!
    grp.minSort = Math.min(grp.minSort, tx.sort)
    const ck = conditionKey(tx.condition_rules)
    const route = grp.routes.find(
      (r) => r.from_state === tx.from_state && conditionKey(r.condition_rules) === ck
    )
    if (route) {
      route.ids.push(tx.id)
      route.to_states.push(tx.to_state)
      route.minSort = Math.min(route.minSort, tx.sort)
    } else {
      grp.routes.push({
        ids: [tx.id],
        from_state: tx.from_state,
        to_states: [tx.to_state],
        condition_rules: tx.condition_rules,
        required_roles: tx.required_roles,
        minSort: tx.sort
      })
    }
  }
  const groups = Array.from(labelMap.values())
  groups.sort((a, b) => a.minSort - b.minSort)
  for (const g of groups) g.routes.sort((a, b) => a.minSort - b.minSort)
  return groups
}

// ─── Sortable transition items (context-based drag handle) ────────────────────

// biome-ignore lint/suspicious/noExplicitAny: dnd-kit types
type DragCtx = { listeners: any; attributes: any }
const TransitionDragCtx = createContext<DragCtx | null>(null)

function SortableTransitionItem({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <TransitionDragCtx.Provider value={{ listeners, attributes }}>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      >
        {children}
      </div>
    </TransitionDragCtx.Provider>
  )
}

function TransitionDragHandle() {
  const ctx = useContext(TransitionDragCtx)
  return (
    <button
      type='button'
      // biome-ignore lint/suspicious/noExplicitAny: dnd-kit listener spread
      {...(ctx?.listeners as any)}
      // biome-ignore lint/suspicious/noExplicitAny: dnd-kit attribute spread
      {...(ctx?.attributes as any)}
      className='cursor-grab touch-none text-slate-300 hover:text-slate-400 shrink-0'
      tabIndex={-1}
    >
      <GripVertical className='h-3.5 w-3.5' />
    </button>
  )
}

// ─── Relation value combobox (multi-select) ───────────────────────────────────

function toStringArray(v: unknown): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return [v]
  return []
}

function RelationValueCombobox({
  relatedCollection,
  value,
  onChange
}: {
  relatedCollection: string
  value: string[]
  onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else setQuery('')
  }, [open])

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    staleTime: 60_000,
    enabled: !!relatedCollection
  })

  const actualFieldNames: string[] = (colMeta?.fields ?? []).map((f: CMSField) => f.field)
  const displayTemplate: string | null = colMeta?.display_template ?? null
  const LABEL_FALLBACKS = ['name', 'title', 'label', 'display_name', 'subject', 'email', 'slug']
  const wantedFields = [
    ...new Set(['id', ...extractTemplateFields(displayTemplate), ...LABEL_FALLBACKS])
  ]
  const safeFields = actualFieldNames.length
    ? wantedFields.filter((f) => f === 'id' || actualFieldNames.includes(f)).join(',')
    : 'id'

  const { data, isLoading, isError } = useQuery({
    queryKey: ['relation-picker-items', relatedCollection, safeFields],
    queryFn: () =>
      api
        .get<{ data: Record<string, unknown>[] }>(`/items/${relatedCollection}`, {
          params: { limit: 200, fields: safeFields }
        })
        .then((r) => r.data.data),
    staleTime: 30_000,
    // Fetch when dropdown opens OR when there are existing values to resolve labels
    enabled: (open || value.length > 0) && !!actualFieldNames.length,
    retry: false,
    refetchOnWindowFocus: false
  })

  if (isError) {
    return (
      <Input
        type='text'
        value={value.join(', ')}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          )
        }
        placeholder='Value (comma-separated)'
        className='h-8 text-[12px]'
      />
    )
  }

  const items = data ?? []

  function labelFor(id: string): string {
    const item = items.find((i) => String(i.id) === id)
    return item ? renderDisplayTemplate(displayTemplate, item) : id
  }

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  }

  const filtered = query
    ? items.filter((i) =>
        renderDisplayTemplate(displayTemplate, i).toLowerCase().includes(query.toLowerCase())
      )
    : items

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className='relative w-full'>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-left hover:border-slate-300'
          >
            {value.length === 0 ? (
              <span className='text-[12px] text-slate-400 px-0.5'>Select…</span>
            ) : isLoading ? (
              <span className='flex items-center gap-1 text-[12px] text-slate-400'>
                <Loader2 className='h-3 w-3 animate-spin' />
                Loading…
              </span>
            ) : (
              value.map((id) => (
                <span
                  key={id}
                  className='inline-flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-2 py-0.5 text-[11px] font-medium text-nvr-navy'
                >
                  {labelFor(id)}
                  <span
                    role='button'
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggle(id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); toggle(id) }
                    }}
                    className='cursor-pointer text-nvr-navy/50 hover:text-red-500'
                  >
                    ×
                  </span>
                </span>
              ))
            )}
            <ChevronDown className='ml-auto h-3.5 w-3.5 shrink-0 text-slate-400' />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent align='start' className='w-64 p-0' sideOffset={4}>
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
          {isLoading ? (
            <div className='flex items-center gap-2 px-3 py-2 text-[12px] text-slate-400'>
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className='px-3 py-2 text-[12px] text-slate-400'>No results</div>
          ) : (
            filtered.map((item) => {
              const label = renderDisplayTemplate(displayTemplate, item)
              const id = String(item.id)
              const selected = value.includes(id)
              return (
                <button
                  key={id}
                  type='button'
                  onClick={() => toggle(id)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-slate-50 ${selected ? 'font-medium text-slate-800' : 'text-slate-600'}`}
                >
                  <Check
                    className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-nvr-cyan' : 'opacity-0'}`}
                  />
                  {label}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
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
const DATE_FIELD_TYPES = new Set(['date', 'dateTime', 'datetime', 'timestamp'])
const BOOLEAN_FIELD_TYPES = new Set(['boolean'])

// Per-rule metadata tracked in local state (not sent to server).
// For top-level fields we derive from `fields`; this fills the gap for dotted paths.
type RuleMeta = { type: string; relatedCollection?: string }

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
  // Keyed by field path, populated when user picks via FieldPicker
  const [fieldMeta, setFieldMeta] = useState<Record<string, RuleMeta>>({})

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection
  })
  const fields: CMSField[] = [...(colMeta?.fields?.filter((f: CMSField) => !f.hidden) ?? [])].sort(
    (a, b) => a.field.localeCompare(b.field)
  )
  const relations: CMSRelation[] = colMeta?.relations ?? []

  // Derive field type + related collection for a field path.
  // Top-level: from loaded fields/relations. Dotted: from fieldMeta state.
  function getRuleMeta(fieldPath: string): RuleMeta {
    if (!fieldPath) return { type: '' }
    if (!fieldPath.includes('.')) {
      const f = fields.find((fl) => fl.field === fieldPath)
      if (f) {
        const rel = findM2ORelation(relations, collection ?? '', fieldPath)
        return { type: f.type, relatedCollection: rel?.one_collection ?? undefined }
      }
    }
    return fieldMeta[fieldPath] ?? { type: 'string' }
  }

  const updateRule = (idx: number, patch: Partial<ConditionRule>) =>
    onChange(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const removeRule = (idx: number) => onChange(rules.filter((_, i) => i !== idx))

  // Friendly label for a field path (for FieldPicker valueLabel)
  function fieldValueLabel(fieldPath: string): string {
    if (!fieldPath) return ''
    return fieldPath.split('.').map(titleCase).join(' → ')
  }

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
            const meta = getRuleMeta(rule.field)
            const isNumeric = NUMERIC_FIELD_TYPES.has(meta.type)
            const isDate = DATE_FIELD_TYPES.has(meta.type)
            const isBoolean = BOOLEAN_FIELD_TYPES.has(meta.type)
            const isRelation = !!meta.relatedCollection

            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional
                key={idx}
                className='flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2'
              >
                {/* Field picker */}
                <div className='flex-1 min-w-[160px]'>
                  <FieldPicker
                    collection={collection ?? ''}
                    fields={fields}
                    relations={relations}
                    value={rule.field}
                    valueLabel={fieldValueLabel(rule.field)}
                    placeholder='Field…'
                    onChange={(picked: PickedField) => {
                      const path = picked.path.join('.')
                      setFieldMeta((prev) => ({
                        ...prev,
                        [path]: {
                          type: picked.fieldType,
                          relatedCollection: picked.relatedCollection
                        }
                      }))
                      updateRule(idx, { field: path, value: '' })
                    }}
                    onClear={() => updateRule(idx, { field: '', value: '' })}
                  />
                </div>

                {/* Operator */}
                <div className='w-36 shrink-0'>
                  <SimpleCombobox
                    value={rule.op}
                    onChange={(v) => updateRule(idx, { op: (v || 'eq') as ConditionOp })}
                    options={CONDITION_OPS.map((o) => ({ value: o.value, label: o.label }))}
                    placeholder='Operator…'
                  />
                </div>

                {/* Contextual value input */}
                {!noValue && (
                  <div className='flex-1 min-w-[120px]'>
                    {isRelation ? (
                      <RelationValueCombobox
                        relatedCollection={meta.relatedCollection!}
                        value={toStringArray(rule.value)}
                        onChange={(v) => updateRule(idx, { value: v.length === 1 ? v[0] : v })}
                      />
                    ) : isBoolean ? (
                      <SimpleCombobox
                        value={String(rule.value ?? '')}
                        onChange={(v) => updateRule(idx, { value: v })}
                        options={[
                          { value: 'true', label: 'Yes' },
                          { value: 'false', label: 'No' }
                        ]}
                        placeholder='Yes / No…'
                      />
                    ) : isDate ? (
                      <Input
                        type={meta.type === 'date' ? 'date' : 'datetime-local'}
                        value={String(rule.value ?? '')}
                        onChange={(e) => updateRule(idx, { value: e.target.value })}
                        className='h-8 text-[12px]'
                      />
                    ) : (
                      <Input
                        type={isNumeric ? 'number' : 'text'}
                        value={String(rule.value ?? '')}
                        onChange={(e) => updateRule(idx, { value: e.target.value })}
                        placeholder='Value'
                        className='h-8 text-[12px]'
                      />
                    )}
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
  condition_rules: ConditionRule[] | null
}

function TransitionForm({
  initial,
  states,
  collection,
  fixedLabel,
  onSave,
  onCancel,
  saving
}: {
  initial: Partial<TransitionFormData>
  states: PipelineState[]
  collection?: string
  /** When set, the label field is shown read-only (adding a route to existing group) */
  fixedLabel?: string
  onSave: (data: TransitionFormData) => void
  onCancel: () => void
  saving?: boolean
}) {
  const [form, setForm] = useState<TransitionFormData>({
    from_state: initial.from_state ?? null,
    to_states: initial.to_states ?? [],
    label: fixedLabel ?? initial.label ?? '',
    color: initial.color ?? null,
    required_roles: initial.required_roles ?? null,
    condition_rules: initial.condition_rules ?? null
  })

  const set = <K extends keyof TransitionFormData>(k: K, v: TransitionFormData[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const isValid = form.to_states.length > 0 && form.label.trim()

  return (
    <div className='space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4'>
      {fixedLabel ? (
        <p className='text-[12px] font-medium text-slate-500'>
          Adding route for <span className='font-semibold text-slate-800'>{fixedLabel}</span>
        </p>
      ) : (
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>Button Label</Label>
          <Input
            value={form.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder='e.g. Approve, Submit for Review'
            className='h-8 text-[13px]'
          />
        </div>
      )}

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

      {!fixedLabel && (
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>Color</Label>
          <ColorPicker value={form.color} onChange={(c) => set('color', c)} />
        </div>
      )}

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
  const [addingRouteTo, setAddingRouteTo] = useState<string | null>(null) // label group
  const [editingRoute, setEditingRoute] = useState<{ label: string; route: RouteEntry } | null>(
    null
  )
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

  const [localGroupOrder, setLocalGroupOrder] = useState<string[]>([])
  const [localRouteOrder, setLocalRouteOrder] = useState<Record<string, string[]>>({})

  // Sync localStateOrder from server whenever templateData.states changes
  useEffect(() => {
    const serverStates = templateData?.states ?? []
    setLocalStateOrder(serverStates.map((s) => s.id))
  }, [templateData?.states])

  // Sync group/route order from server
  useEffect(() => {
    const groups = groupByLabel(templateData?.transitions ?? [])
    setLocalGroupOrder(groups.map((g) => g.label))
    setLocalRouteOrder(Object.fromEntries(groups.map((g) => [g.label, g.routes.map((r) => r.ids[0])])))
  }, [templateData?.transitions])

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
        group_label: null,
        actions: null,
        sort: 0
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

  // Add a new route (from→to pair) to an existing label group
  const addRoute = useMutation({
    mutationFn: async ({
      labelGroup,
      data
    }: {
      labelGroup: LabelGroup
      data: TransitionFormData
    }) => {
      for (const to_state of data.to_states) {
        await api.post(`/pipelines/${id}/transitions`, {
          from_state: data.from_state,
          label: labelGroup.label,
          color: labelGroup.color,
          required_roles: data.required_roles,
          condition_rules: data.condition_rules,
          group_label: null,
          actions: null,
          sort: Math.max(labelGroup.minSort, ...labelGroup.routes.map((r) => r.minSort)),
          to_state
        })
      }
    },
    onSuccess: () => {
      invalidate()
      setAddingRouteTo(null)
    },
    onError: () => toast.error('Failed to add route')
  })

  const updateRoute = useMutation({
    mutationFn: async ({ route, data }: { route: RouteEntry; data: TransitionFormData }) => {
      for (const txId of route.ids) await api.delete(`/pipelines/transitions/${txId}`)
      for (const to_state of data.to_states) {
        await api.post(`/pipelines/${id}/transitions`, {
          from_state: data.from_state,
          label: data.label,
          color: data.color,
          required_roles: data.required_roles,
          condition_rules: data.condition_rules,
          group_label: null,
          actions: null,
          sort: 0,
          to_state
        })
      }
    },
    onSuccess: () => {
      invalidate()
      setEditingRoute(null)
    },
    onError: () => toast.error('Failed to update route')
  })

  const deleteRoute = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const txId of ids) await api.delete(`/pipelines/transitions/${txId}`)
    },
    onSuccess: () => {
      invalidate()
      toast.success('Deleted')
    },
    onError: () => toast.error('Failed to delete')
  })

  const updateTransitionSort = useMutation({
    mutationFn: async (updates: { id: string; sort: number }[]) => {
      for (const { id, sort } of updates) {
        await api.patch(`/pipelines/transitions/${id}`, { sort })
      }
    },
    onSuccess: () => invalidate(),
    onError: () => toast.error('Failed to reorder')
  })

  const patchGroupColor = useMutation({
    mutationFn: async ({ ids, color }: { ids: string[]; color: string | null }) => {
      for (const txId of ids) await api.patch(`/pipelines/transitions/${txId}`, { color })
    },
    onSuccess: () => invalidate(),
    onError: () => toast.error('Failed to update color')
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

  const updateBinding = useMutation({
    mutationFn: ({ bindingId, body }: { bindingId: number; body: { auto_start?: boolean; auto_start_state?: string | null } }) =>
      api.patch(`/pipelines/bindings/${bindingId}`, body).then((r) => r.data),
    onSuccess: () => invalidate(),
    onError: () => toast.error('Failed to update binding')
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
  const groupsMap = new Map(groupByLabel(transitions).map((g) => [g.label, g]))
  const displayGroups = localGroupOrder
    .map((label) => groupsMap.get(label))
    .filter((g): g is LabelGroup => !!g)

  function applySortUpdates(
    groupOrder: string[],
    routeOrder: Record<string, string[]>,
    gMap: Map<string, LabelGroup>
  ) {
    const updates: { id: string; sort: number }[] = []
    let i = 0
    for (const label of groupOrder) {
      const grp = gMap.get(label)
      if (!grp) continue
      for (const routeId of (routeOrder[label] ?? [])) {
        const route = grp.routes.find((r) => r.ids[0] === routeId)
        if (!route) continue
        for (const txId of route.ids) updates.push({ id: txId, sort: i })
        i++
      }
    }
    updateTransitionSort.mutate(updates)
  }

  function handleGroupDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const next = arrayMove(localGroupOrder, localGroupOrder.indexOf(active.id as string), localGroupOrder.indexOf(over.id as string))
    setLocalGroupOrder(next)
    applySortUpdates(next, localRouteOrder, groupsMap)
  }

  function handleRouteDragEnd(label: string, event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const cur = localRouteOrder[label] ?? []
    const next = arrayMove(cur, cur.indexOf(active.id as string), cur.indexOf(over.id as string))
    const nextRouteOrder = { ...localRouteOrder, [label]: next }
    setLocalRouteOrder(nextRouteOrder)
    applySortUpdates(localGroupOrder, nextRouteOrder, groupsMap)
  }
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

            <div className='space-y-3'>
              <DndContext sensors={stateSensors} collisionDetection={closestCenter} onDragEnd={handleGroupDragEnd}>
                <SortableContext items={localGroupOrder} strategy={verticalListSortingStrategy}>
              {displayGroups.map((grp) => {
                const routeMap = new Map(grp.routes.map((r) => [r.ids[0], r]))
                const routeIds = localRouteOrder[grp.label] ?? grp.routes.map((r) => r.ids[0])
                const displayRoutes = routeIds.map((rid) => routeMap.get(rid)).filter((r): r is RouteEntry => !!r)
                return (
                <SortableTransitionItem key={grp.label} id={grp.label}>
                <div
                  className='overflow-hidden rounded-lg border border-slate-200 bg-white'
                >
                  {/* Label group header */}
                  <div className='group/hdr flex items-center gap-2.5 border-b border-slate-100 bg-slate-50/60 px-3 py-2'>
                    <TransitionDragHandle />
                    {/* Group color swatch — click to change */}
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type='button'
                          title='Change group color'
                          className='h-3 w-3 shrink-0 rounded-full border border-slate-300 hover:scale-110 transition-transform'
                          style={{ backgroundColor: grp.color ?? '#e2e8f0' }}
                        />
                      </PopoverTrigger>
                      <PopoverContent align='start' className='w-auto p-3' sideOffset={6}>
                        <p className='mb-2 text-[11px] font-medium text-slate-500'>Group color</p>
                        <ColorPicker
                          value={grp.color}
                          onChange={(c) => {
                            const allIds = grp.routes.flatMap((r) => r.ids)
                            patchGroupColor.mutate({ ids: allIds, color: c })
                          }}
                        />
                      </PopoverContent>
                    </Popover>
                    <span className='flex-1 text-[13px] font-semibold text-slate-800'>
                      {grp.label}
                    </span>
                    <span className='text-[11px] text-slate-400 tabular-nums'>
                      {grp.routes.length} route{grp.routes.length !== 1 ? 's' : ''}
                    </span>
                    <button
                      type='button'
                      onClick={() => setAddingRouteTo(grp.label)}
                      className='flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-nvr-cyan opacity-0 hover:bg-nvr-cyan/10 group-hover/hdr:opacity-100 transition-opacity'
                    >
                      <Plus className='h-3 w-3' />
                      Add route
                    </button>
                    <button
                      type='button'
                      onClick={() => {
                        const allIds = grp.routes.flatMap((r) => r.ids)
                        if (confirm(`Delete all routes for "${grp.label}"?`))
                          deleteRoute.mutate(allIds)
                      }}
                      className='rounded p-1 text-slate-300 opacity-0 hover:text-red-500 group-hover/hdr:opacity-100 transition-opacity'
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  </div>

                  {/* Route rows */}
                  <DndContext sensors={stateSensors} collisionDetection={closestCenter} onDragEnd={(e) => handleRouteDragEnd(grp.label, e)}>
                    <SortableContext items={routeIds} strategy={verticalListSortingStrategy}>
                  {displayRoutes.map((route) => {
                    const routeKey = `${grp.label}|${route.from_state ?? '_any_'}|${route.ids[0]}`
                    const fromState = route.from_state ? stateById.get(route.from_state) : null
                    const isEditing =
                      editingRoute?.label === grp.label &&
                      editingRoute.route.ids[0] === route.ids[0]

                    if (isEditing) {
                      return (
                        <div key={routeKey} className='border-b border-slate-100 last:border-0 p-3'>
                          <TransitionForm
                            initial={{
                              from_state: route.from_state,
                              to_states: route.to_states,
                              label: grp.label,
                              color: grp.color,
                              required_roles: route.required_roles,
                              condition_rules: route.condition_rules
                            }}
                            fixedLabel={grp.label}
                            states={states}
                            collection={bindings[0]?.collection}
                            saving={updateRoute.isPending}
                            onSave={(data) => updateRoute.mutate({ route, data })}
                            onCancel={() => setEditingRoute(null)}
                          />
                        </div>
                      )
                    }

                    return (
                      <SortableTransitionItem key={routeKey} id={route.ids[0]}>
                      <div
                        className='group/row flex items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-0 hover:bg-slate-50'
                      >
                        <TransitionDragHandle />
                        <div className='flex flex-1 min-w-0 flex-wrap items-center gap-1.5 text-[12px]'>
                          {fromState ? (
                            <StateBadge state={fromState} />
                          ) : (
                            <span className='italic text-slate-400 text-[11px]'>any state</span>
                          )}
                          <ArrowRight className='h-3 w-3 text-slate-300 shrink-0' />
                          {route.to_states.map((sid, i) => {
                            const s = stateById.get(sid)
                            return s ? (
                              <span key={sid} className='flex items-center gap-1'>
                                {i > 0 && <span className='text-slate-300'>·</span>}
                                <StateBadge state={s} small />
                              </span>
                            ) : null
                          })}
                          {(route.condition_rules ?? []).length > 0 && (
                            <span
                              className='ml-1 inline-flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-nvr-navy'
                              title={(route.condition_rules ?? [])
                                .map((r) => `${r.field} ${r.op} ${String(r.value ?? '')}`)
                                .join(' AND ')}
                            >
                              <Filter className='h-2.5 w-2.5' />
                              {(route.condition_rules ?? []).length}
                            </span>
                          )}
                        </div>
                        <div className='flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100'>
                          <button
                            type='button'
                            onClick={() => setEditingRoute({ label: grp.label, route })}
                            className='rounded p-1 text-slate-400 hover:text-slate-700'
                          >
                            <Pencil className='h-3.5 w-3.5' />
                          </button>
                          <button
                            type='button'
                            onClick={() => {
                              if (confirm('Delete this route?')) deleteRoute.mutate(route.ids)
                            }}
                            className='rounded p-1 text-slate-400 hover:text-red-500'
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        </div>
                      </div>
                      </SortableTransitionItem>
                    )
                  })}
                    </SortableContext>
                  </DndContext>

                  {/* Add route form */}
                  {addingRouteTo === grp.label && (
                    <div className='border-t border-slate-100 p-3'>
                      <TransitionForm
                        initial={{ color: grp.color }}
                        fixedLabel={grp.label}
                        states={states}
                        collection={bindings[0]?.collection}
                        saving={addRoute.isPending}
                        onSave={(data) => addRoute.mutate({ labelGroup: grp, data })}
                        onCancel={() => setAddingRouteTo(null)}
                      />
                    </div>
                  )}
                </div>
                </SortableTransitionItem>
                )})}
                </SortableContext>
              </DndContext>

              {addingTransition && (
                <TransitionForm
                  initial={{}}
                  states={states}
                  collection={bindings[0]?.collection}
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
                      {/* Auto-start config */}
                      <div className='mt-2 flex flex-wrap items-center gap-3'>
                        <label className='flex items-center gap-1.5 cursor-pointer select-none'>
                          <input
                            type='checkbox'
                            checked={!!b.auto_start}
                            onChange={(e) =>
                              updateBinding.mutate({
                                bindingId: b.id,
                                body: { auto_start: e.target.checked, auto_start_state: b.auto_start_state }
                              })
                            }
                            className='rounded'
                          />
                          <span className='text-[12px] text-slate-600'>Auto-start on create</span>
                        </label>
                        {b.auto_start && (
                          <div className='flex items-center gap-1.5'>
                            <span className='text-[11px] text-slate-400'>Start in:</span>
                            <SimpleCombobox
                              value={b.auto_start_state ?? ''}
                              onChange={(v) =>
                                updateBinding.mutate({
                                  bindingId: b.id,
                                  body: { auto_start: true, auto_start_state: v || null }
                                })
                              }
                              options={(templateData?.states ?? []).map((s) => ({
                                value: s.id,
                                label: s.label
                              }))}
                              noneLabel='First initial state'
                              placeholder='First initial state'
                              className='w-52 text-[12px]'
                            />
                          </div>
                        )}
                      </div>
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
                placeholder='State field (optional)'
                noneLabel='None'
                className='w-64 font-mono text-[12px]'
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
