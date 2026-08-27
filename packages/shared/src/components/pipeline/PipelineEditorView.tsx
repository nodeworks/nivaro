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
  History,
  LayoutGrid,
  Link2,
  Link2Off,
  ListChecks,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
  Zap,
  GitFork
} from 'lucide-react'
import type React from 'react'
import { createPortal } from 'react-dom'
import { createContext, useContext, useEffect, useRef, useState, useMemo } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { FieldPicker, type PickedField } from './FieldPicker'
import { OwnerMatrix } from './OwnerMatrix'
import { TeamsView } from './TeamsView'
import { rankTeamForFilters, tierOrder, useScopeDimensions } from './teamScopes'
import { PipelineSkipCriteria } from './PipelineSkipCriteria'
import { PipelineStateOwners } from './PipelineStateOwners'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import type {
  CMSField,
  CMSRelation,
  Collection,
  ConditionOp,
  ConditionRule,
  PipelineBinding,
  PipelineOwnerDimension,
  PipelineOwnerGroup,
  PipelineOwnerGroupsMap,
  PipelineOwnerGroupUser,
  PipelineState,
  PipelineTemplate,
  PipelineTransition,
  TransitionRequirement,
  User
} from './types'
import type { DimensionCascadeRule } from './types'
import { extractTemplateFields, findM2ORelation, renderDisplayTemplate } from './relations'
import { cn, formatRelative, titleCase } from '../../lib/utils'

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
            className='absolute right-6 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'
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
            onClick={(e) => {
              e.stopPropagation()
              onChange([])
            }}
            className='absolute right-6 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'
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
  skip_if_no_owners: boolean
  owners_not_required: boolean
  stage_visibility: 'always' | 'hide' | 'hide_unless_active'
  description: string
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
    skip_if_no_owners: initial.skip_if_no_owners ?? false,
    owners_not_required: initial.owners_not_required ?? false,
    stage_visibility: (initial as Partial<StateFormData>).stage_visibility ?? 'always',
    description: initial.description ?? ''
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

      <div className='space-y-1.5'>
        <Label className='text-[12px]'>Help text</Label>
        <textarea
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder='What this state means and what happens here — shown as a tooltip on the record’s progress track'
          className='w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] dark:border-border dark:bg-card'
        />
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
        <label className='flex items-center gap-1.5 cursor-pointer'>
          <input
            type='checkbox'
            checked={form.skip_if_no_owners}
            onChange={(e) => set('skip_if_no_owners', e.target.checked)}
            className='rounded'
          />
          Auto-skip when record resolves no owners
        </label>
        <label
          className='flex items-center gap-1.5 cursor-pointer'
          title='Records parked here legitimately have nobody assigned (Started, Completed…) — owner-gap and coverage reports stop flagging this state'
        >
          <input
            type='checkbox'
            checked={form.owners_not_required}
            onChange={(e) => set('owners_not_required', e.target.checked)}
            className='rounded'
          />
          No owners expected in this state
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
                className='flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'
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
  requirements: TransitionRequirement[] | null
  auto_trigger: boolean
  comment_mode: string
  actions: TransitionAction[] | null
  minSort: number
}

// Transition action shape (server: services/workflow-actions.ts). Nested config
// (guard/context/writebacks/m2m) is edited as JSON — the flat fields are typed.
type TransitionAction = {
  type: 'erp_submit' | 'create_record'
  // erp_submit
  external_api?: string | number
  endpoint_path?: string
  method?: string
  skip_when_empty?: string
  // create_record
  target_collection?: string
  link_field?: string
  skip_if_exists?: { match_field: string; value_template: string }
  m2m?: Record<string, unknown>
  // shared
  payload_template?: string
  guard?: unknown[]
  context?: Record<string, unknown>
  on_success?: { set?: Record<string, string> }
  on_failure?: { set?: Record<string, string> }
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
        requirements: tx.requirements,
        auto_trigger: !!tx.auto_trigger,
        comment_mode: tx.comment_mode ?? 'none',
        actions: (tx.actions as TransitionAction[] | null) ?? null,
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id
  })
  return (
    <TransitionDragCtx.Provider value={{ listeners, attributes }}>
      <div
        ref={setNodeRef}
        style={{
          transform: CSS.Transform.toString(transform),
          transition,
          opacity: isDragging ? 0.4 : 1
        }}
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
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else setQuery('')
  }, [open])

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: any }>(get(`/collections/${relatedCollection}`))
        .then((r) => r.data),
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
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relatedCollection}`, { limit: 200, fields: safeFields })
        )
        .then((r) => r.data),
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
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation()
                        toggle(id)
                      }
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
  const client = useNivaroClient()
  const [expanded, setExpanded] = useState(rules.length > 0)
  // Keyed by field path, populated when user picks via FieldPicker
  const [fieldMeta, setFieldMeta] = useState<Record<string, RuleMeta>>({})

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () =>
      client.request<{ data: any }>(get(`/collections/${collection}`)).then((r) => r.data),
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

// ─── Transition requirements (child-row data gates) ───────────────────────────
// v1 supports the `child_fields` type only: block the transition until every
// row of a picked O2M child relation has the listed fields filled in. See
// docs/superpowers/specs/2026-07-19-transition-requirements-design.md.

function TransitionRequirementEntry({
  requirement,
  childRelations,
  onChange,
  onRemove
}: {
  requirement: TransitionRequirement
  childRelations: CMSRelation[]
  onChange: (patch: Partial<TransitionRequirement>) => void
  onRemove: () => void
}) {
  const client = useNivaroClient()
  const { data: childMeta } = useQuery({
    queryKey: ['collection-meta', requirement.collection],
    queryFn: () =>
      client
        .request<{ data: any }>(get(`/collections/${requirement.collection}`))
        .then((r) => r.data),
    enabled: !!requirement.collection
  })
  const childFields: CMSField[] = [
    ...(childMeta?.fields?.filter((f: CMSField) => !f.hidden) ?? [])
  ].sort((a, b) => a.field.localeCompare(b.field))

  const relationOptions = childRelations.map((r) => ({
    value: `${r.many_collection}::${r.many_field}`,
    label: `${r.many_collection}.${r.many_field}`
  }))
  const selectedRelationValue = requirement.collection
    ? `${requirement.collection}::${requirement.fk_field}`
    : ''

  const toggleField = (field: string, checked: boolean) => {
    const fields = checked
      ? [...requirement.fields, field]
      : requirement.fields.filter((f) => f !== field)
    const labels = { ...(requirement.labels ?? {}) }
    if (!checked) delete labels[field]
    onChange({ fields, labels: Object.keys(labels).length > 0 ? labels : undefined })
  }

  const setFieldLabel = (field: string, label: string) => {
    const labels = { ...(requirement.labels ?? {}) }
    if (label.trim()) labels[field] = label
    else delete labels[field]
    onChange({ labels: Object.keys(labels).length > 0 ? labels : undefined })
  }

  const toggleDisplayField = (field: string, checked: boolean) => {
    const current = requirement.display_fields ?? []
    const next = checked ? [...current, field] : current.filter((f) => f !== field)
    onChange({ display_fields: next.length > 0 ? next : undefined })
  }

  return (
    <div className='space-y-2.5 rounded-lg border border-slate-200 bg-white p-3'>
      <div className='flex items-start gap-2'>
        <div className='flex-1 space-y-1.5'>
          <Label className='text-[11px]'>Child Relation</Label>
          <SimpleCombobox
            value={selectedRelationValue}
            onChange={(v) => {
              const [coll, fk] = v.split('::')
              onChange({
                collection: coll ?? '',
                fk_field: fk ?? '',
                fields: [],
                display_fields: undefined,
                labels: undefined
              })
            }}
            options={relationOptions}
            placeholder='Select a child relation…'
          />
        </div>
        <button
          type='button'
          onClick={onRemove}
          className='mt-5 rounded p-1 text-slate-400 hover:text-red-500 shrink-0'
        >
          <Trash2 className='h-3.5 w-3.5' />
        </button>
      </div>

      {requirement.collection && (
        <div className='space-y-1.5'>
          <Label className='text-[11px]'>Required Fields</Label>
          <div className='max-h-48 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2'>
            {childFields.length === 0 && (
              <p className='text-[11px] text-slate-400'>No fields found.</p>
            )}
            {childFields.map((f) => {
              const checked = requirement.fields.includes(f.field)
              return (
                <div key={f.field} className='flex items-center gap-2'>
                  <input
                    type='checkbox'
                    checked={checked}
                    onChange={(e) => toggleField(f.field, e.target.checked)}
                    className='h-3.5 w-3.5 shrink-0 rounded border-slate-300'
                  />
                  <span className='flex-1 text-[12px] text-slate-700'>{f.field}</span>
                  {checked && (
                    <Input
                      value={requirement.labels?.[f.field] ?? ''}
                      onChange={(e) => setFieldLabel(f.field, e.target.value)}
                      placeholder='Display label (optional)'
                      className='h-6 w-40 text-[11px]'
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {requirement.collection && (
        <div className='space-y-1.5'>
          <Label className='text-[11px]'>
            Context Columns{' '}
            <span className='font-normal text-slate-400'>(shown read-only in the dialog)</span>
          </Label>
          <div className='max-h-36 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2'>
            {childFields
              .filter((f) => !requirement.fields.includes(f.field))
              .map((f) => (
                <div key={f.field} className='flex items-center gap-2'>
                  <input
                    type='checkbox'
                    checked={(requirement.display_fields ?? []).includes(f.field)}
                    onChange={(e) => toggleDisplayField(f.field, e.target.checked)}
                    className='h-3.5 w-3.5 shrink-0 rounded border-slate-300'
                  />
                  <span className='flex-1 text-[12px] text-slate-700'>{f.field}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className='space-y-1.5'>
        <Label className='text-[11px]'>Dialog Title</Label>
        <Input
          value={requirement.title ?? ''}
          onChange={(e) => onChange({ title: e.target.value.trim() ? e.target.value : undefined })}
          placeholder='Required before continuing'
          className='h-7 text-[12px]'
        />
      </div>
    </div>
  )
}

function TransitionRequirementsSection({
  requirements,
  onChange,
  collection
}: {
  requirements: TransitionRequirement[]
  onChange: (reqs: TransitionRequirement[]) => void
  collection?: string
}) {
  const client = useNivaroClient()
  const [expanded, setExpanded] = useState(requirements.length > 0)

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () =>
      client.request<{ data: any }>(get(`/collections/${collection}`)).then((r) => r.data),
    enabled: !!collection
  })
  const relations: CMSRelation[] = colMeta?.relations ?? []
  const childRelations = relations.filter(
    (r) => r.one_collection === collection && r.junction_field === null
  )

  const updateReq = (idx: number, patch: Partial<TransitionRequirement>) =>
    onChange(requirements.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const removeReq = (idx: number) => onChange(requirements.filter((_, i) => i !== idx))

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
        <ListChecks className='h-3 w-3' />
        Requirements <span className='font-normal text-slate-400'>(optional)</span>
        {requirements.length > 0 && (
          <span className='rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-nvr-navy'>
            {requirements.length}
          </span>
        )}
      </button>

      {expanded && (
        <div className='space-y-2'>
          <p className='text-[11px] text-slate-400 leading-snug'>
            Block this transition until every row of a child relation has the listed fields filled
            in. Prompts the user with a fill-in dialog when rows are incomplete.
          </p>

          {requirements.map((req, idx) => (
            <TransitionRequirementEntry
              // biome-ignore lint/suspicious/noArrayIndexKey: entries are positional
              key={idx}
              requirement={req}
              childRelations={childRelations}
              onChange={(patch) => updateReq(idx, patch)}
              onRemove={() => removeReq(idx)}
            />
          ))}

          <Button
            type='button'
            size='sm'
            variant='outline'
            className='h-7 gap-1 text-[12px]'
            onClick={() =>
              onChange([
                ...requirements,
                { type: 'child_fields', collection: '', fk_field: '', fields: [] }
              ])
            }
          >
            <Plus className='h-3 w-3' />
            Add Requirement
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
  requirements: TransitionRequirement[] | null
  auto_trigger: boolean
  comment_mode: string
  actions: TransitionAction[] | null
}

/** JSON sub-config editor: local text state, commits upward only when valid. */
function JsonField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3
}: {
  label: string
  value: unknown
  onChange: (v: unknown) => void
  placeholder?: string
  rows?: number
}) {
  const [text, setText] = useState(() =>
    value === null || value === undefined ? '' : JSON.stringify(value, null, 2)
  )
  const [invalid, setInvalid] = useState(false)
  return (
    <div className='space-y-1'>
      <span className='text-[10.5px] uppercase tracking-wide text-slate-400'>{label}</span>
      <Textarea
        value={text}
        onChange={(e) => {
          const t = e.target.value
          setText(t)
          if (!t.trim()) {
            setInvalid(false)
            onChange(undefined)
            return
          }
          try {
            onChange(JSON.parse(t))
            setInvalid(false)
          } catch {
            setInvalid(true)
          }
        }}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        className={cn(
          'font-mono text-[11px] resize-y',
          invalid && 'border-red-400 focus-visible:ring-red-400'
        )}
      />
      {invalid && <p className='text-[10.5px] text-red-500'>Invalid JSON — not saved yet.</p>}
    </div>
  )
}

function TransitionActionsSection({
  actions,
  onChange
}: {
  actions: TransitionAction[]
  onChange: (a: TransitionAction[]) => void
}) {
  const [open, setOpen] = useState(actions.length > 0)
  const update = (idx: number, patch: Partial<TransitionAction>) =>
    onChange(actions.map((a, i) => (i === idx ? { ...a, ...patch } : a)))
  const remove = (idx: number) => onChange(actions.filter((_, i) => i !== idx))

  return (
    <div className='space-y-2'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex items-center gap-1.5 text-[12px] font-medium text-slate-600 hover:text-slate-800'
      >
        {open ? <ChevronDown className='h-3.5 w-3.5' /> : <ChevronRight className='h-3.5 w-3.5' />}
        Actions
        {actions.length > 0 && (
          <span className='rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-medium text-teal-700'>
            {actions.length}
          </span>
        )}
      </button>
      {open && (
        <div className='space-y-2 rounded-xl border border-slate-200 bg-white p-3'>
          <p className='text-[11px] text-slate-400'>
            Run AFTER the transition lands — never block it. Liquid templates see{' '}
            <code className='font-mono'>record</code>, <code className='font-mono'>context</code>,{' '}
            <code className='font-mono'>state</code>, <code className='font-mono'>response</code>;
            filters: jsonify, editorjs_text, add_days, iso_date, at_least_days_out, next_open_day.
            Every erp_submit attempt logs to ERP Submissions (with retry).
          </p>
          {actions.map((action, idx) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              key={idx}
              className='space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3'
            >
              <div className='flex items-center gap-2'>
                <SimpleCombobox
                  value={action.type}
                  onChange={(v) => update(idx, { type: v as TransitionAction['type'] })}
                  options={[
                    { value: 'erp_submit', label: 'ERP submit — external API push' },
                    { value: 'create_record', label: 'Create record — in another collection' }
                  ]}
                  placeholder='Action type'
                />
                <button
                  type='button'
                  onClick={() => remove(idx)}
                  className='ml-auto rounded p-1 text-slate-400 hover:text-red-500'
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </button>
              </div>

              {action.type === 'erp_submit' && (
                <div className='grid gap-2 sm:grid-cols-2'>
                  <div className='space-y-1'>
                    <span className='text-[10.5px] uppercase tracking-wide text-slate-400'>
                      External API (name or id)
                    </span>
                    <Input
                      value={String(action.external_api ?? '')}
                      onChange={(e) => update(idx, { external_api: e.target.value })}
                      placeholder='ERP name'
                      className='h-8 font-mono text-[12px]'
                    />
                  </div>
                  <div className='space-y-1'>
                    <span className='text-[10.5px] uppercase tracking-wide text-slate-400'>
                      Endpoint path
                    </span>
                    <Input
                      value={action.endpoint_path ?? ''}
                      onChange={(e) => update(idx, { endpoint_path: e.target.value })}
                      placeholder='/customers/X/deploymentRequests'
                      className='h-8 font-mono text-[12px]'
                    />
                  </div>
                  <div className='space-y-1'>
                    <span className='text-[10.5px] uppercase tracking-wide text-slate-400'>
                      Method
                    </span>
                    <Input
                      value={action.method ?? ''}
                      onChange={(e) => update(idx, { method: e.target.value || undefined })}
                      placeholder='POST'
                      className='h-8 font-mono text-[12px]'
                    />
                  </div>
                  <div className='space-y-1'>
                    <span className='text-[10.5px] uppercase tracking-wide text-slate-400'>
                      Skip when context key empty
                    </span>
                    <Input
                      value={action.skip_when_empty ?? ''}
                      onChange={(e) =>
                        update(idx, { skip_when_empty: e.target.value || undefined })
                      }
                      placeholder='related_collection'
                      className='h-8 font-mono text-[12px]'
                    />
                  </div>
                </div>
              )}

              {action.type === 'create_record' && (
                <div className='grid gap-2 sm:grid-cols-2'>
                  <div className='space-y-1'>
                    <span className='text-[10.5px] uppercase tracking-wide text-slate-400'>
                      Target collection
                    </span>
                    <Input
                      value={action.target_collection ?? ''}
                      onChange={(e) => update(idx, { target_collection: e.target.value })}
                      placeholder='projects'
                      className='h-8 font-mono text-[12px]'
                    />
                  </div>
                  <div className='space-y-1'>
                    <span className='text-[10.5px] uppercase tracking-wide text-slate-400'>
                      Link field (FK writeback)
                    </span>
                    <Input
                      value={action.link_field ?? ''}
                      onChange={(e) => update(idx, { link_field: e.target.value || undefined })}
                      placeholder='project'
                      className='h-8 font-mono text-[12px]'
                    />
                  </div>
                </div>
              )}

              <div className='space-y-1'>
                <span className='text-[10.5px] uppercase tracking-wide text-slate-400'>
                  Payload template (Liquid — must render to valid JSON)
                </span>
                <Textarea
                  value={action.payload_template ?? ''}
                  onChange={(e) => update(idx, { payload_template: e.target.value })}
                  rows={5}
                  spellCheck={false}
                  placeholder={'{"name": {{ record.name | jsonify }}}'}
                  className='font-mono text-[11px] resize-y'
                />
              </div>
              <div className='grid gap-2 sm:grid-cols-2'>
                <JsonField
                  label='Guard (condition rules)'
                  value={action.guard}
                  onChange={(v) => update(idx, { guard: v as unknown[] })}
                  placeholder='[{"field": "status", "op": "eq", "value": "x"}]'
                />
                <JsonField
                  label='Context queries'
                  value={action.context}
                  onChange={(v) => update(idx, { context: v as Record<string, unknown> })}
                  placeholder='{"notes": {"collection": "notes", "filter": {"item": "$id"}, "sort": "-id", "limit": 1}}'
                />
                <JsonField
                  label='On success — set fields'
                  value={action.on_success}
                  onChange={(v) => update(idx, { on_success: v as TransitionAction['on_success'] })}
                  placeholder='{"set": {"order_number": "{{ response.salesOrderNumber }}"}}'
                />
                <JsonField
                  label='On failure — set fields'
                  value={action.on_failure}
                  onChange={(v) => update(idx, { on_failure: v as TransitionAction['on_failure'] })}
                  placeholder='{"set": {"status": "error"}}'
                />
                {action.type === 'create_record' && (
                  <>
                    <JsonField
                      label='Skip if exists'
                      value={action.skip_if_exists}
                      onChange={(v) =>
                        update(idx, { skip_if_exists: v as TransitionAction['skip_if_exists'] })
                      }
                      placeholder='{"match_field": "project_id", "value_template": "{{ record.project_id }}"}'
                    />
                    <JsonField
                      label='M2M junction sets'
                      value={action.m2m}
                      onChange={(v) => update(idx, { m2m: v as Record<string, unknown> })}
                      placeholder='{"regions": {"junction_collection": "…", "parent_field": "…", "related_field": "…", "values_template": "…"}}'
                    />
                  </>
                )}
              </div>
            </div>
          ))}
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='h-7 gap-1 text-[12px]'
            onClick={() => onChange([...actions, { type: 'erp_submit' }])}
          >
            <Plus className='h-3 w-3' />
            Add action
          </Button>
        </div>
      )}
    </div>
  )
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
    condition_rules: initial.condition_rules ?? null,
    requirements: initial.requirements ?? null,
    auto_trigger: initial.auto_trigger ?? false,
    comment_mode: initial.comment_mode ?? 'none',
    actions: initial.actions ?? null
  })

  const set = <K extends keyof TransitionFormData>(k: K, v: TransitionFormData[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const requirementComplete = (r: TransitionRequirement) =>
    r.collection.trim() !== '' && r.fk_field.trim() !== '' && r.fields.length > 0
  const requirementsValid = (form.requirements ?? []).every(requirementComplete)
  const isValid = form.to_states.length > 0 && form.label.trim() && requirementsValid

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

      <TransitionRequirementsSection
        requirements={form.requirements ?? []}
        onChange={(reqs) => set('requirements', reqs.length > 0 ? reqs : null)}
        collection={collection}
      />

      <TransitionActionsSection
        actions={form.actions ?? []}
        onChange={(a) => set('actions', a.length > 0 ? a : null)}
      />

      <div className='rounded-lg border border-slate-200 bg-white px-3 py-2'>
        <span className='text-[12px] font-medium text-slate-700'>Note on transition</span>
        <p className='mb-1.5 text-[11px] text-slate-400'>
          Whether taking this transition stops to ask for a note. Most transitions mean simply "move
          it on", so the default acts on the click; ask when the reason is worth recording, and
          require it when the record should never move without one.
        </p>
        <div className='flex gap-1'>
          {[
            { value: 'none', label: 'No note' },
            { value: 'optional', label: 'Optional' },
            { value: 'required', label: 'Required' }
          ].map((opt) => (
            <button
              key={opt.value}
              type='button'
              onClick={() => set('comment_mode', opt.value)}
              className={cn(
                'rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                (form.comment_mode ?? 'none') === opt.value
                  ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy'
                  : 'border-slate-200 text-slate-600 hover:border-slate-400'
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <label className='flex cursor-pointer items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2'>
        <div>
          <span className='text-[12px] font-medium text-slate-700'>Automatic</span>
          <p className='text-[11px] text-slate-400'>
            Fired by the engine when the conditions above match — never shown to users. Evaluated
            after record writes, after manual transitions, and hourly.
          </p>
        </div>
        <Switch checked={form.auto_trigger} onCheckedChange={(v) => set('auto_trigger', v)} />
      </label>

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
            const reqs = (form.requirements ?? []).filter(requirementComplete)
            onSave({
              ...form,
              condition_rules: rules.length > 0 ? rules : null,
              requirements: reqs.length > 0 ? reqs : null
            })
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

/** Cascade rules editor — narrows a dimension's matrix options by sibling
 *  picks ("Project filtered by the chosen Zone and Project Type"). Rule shape
 *  mirrors record-form cascade_filters: dotted filter column, via_many for
 *  junction hops. */
function DimensionCascadeEditor({
  d,
  siblings,
  onSave,
  saving
}: {
  d: PipelineOwnerDimension
  siblings: PipelineOwnerDimension[]
  onSave: (rules: DimensionCascadeRule[]) => void
  saving: boolean
}) {
  const [open, setOpen] = useState(false)
  const [rules, setRules] = useState<DimensionCascadeRule[]>(d.cascade ?? [])
  useEffect(() => {
    if (open) setRules(d.cascade ?? [])
  }, [open, d.cascade])
  const parents = siblings.filter((x) => x.id !== d.id && !x.is_row_axis)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-tip='Cascade — narrow this dimension’s filter options by sibling picks'
          className={cn(
            'rounded p-1 transition-colors',
            (d.cascade ?? []).length > 0
              ? 'text-nvr-cyan hover:text-[#00b8e0]'
              : 'text-slate-400 hover:text-slate-700'
          )}
        >
          <Filter className='h-3.5 w-3.5' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[380px] p-3' sideOffset={4}>
        <p className='text-[12px] font-semibold text-slate-800 dark:text-foreground'>
          Cascade {d.label}
        </p>
        <p className='mt-0.5 text-[11px] leading-snug text-slate-500 dark:text-muted-foreground'>
          Options narrow by each parent's picked value; an unset parent doesn't filter. The filter
          column lives on this dimension's option collection — dotted paths fold, “via many” wraps
          the first hop in _some for junction links.
        </p>
        <div className='mt-2 space-y-2'>
          {rules.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional editor rows
            <div key={i} className='space-y-1.5 rounded-md border border-slate-200 p-2 dark:border-border'>
              <div className='flex items-center gap-1.5'>
                <span className='w-14 shrink-0 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
                  Parent
                </span>
                <SimpleCombobox
                  value={r.parent_field}
                  options={parents.map((p) => ({ value: p.field, label: p.label }))}
                  placeholder='Pick a dimension…'
                  onChange={(v) =>
                    setRules(rules.map((x, xi) => (xi === i ? { ...x, parent_field: v } : x)))
                  }
                />
                <button
                  type='button'
                  aria-label='Remove rule'
                  className='ml-auto text-slate-400 hover:text-red-500'
                  onClick={() => setRules(rules.filter((_, xi) => xi !== i))}
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </div>
              <div className='flex items-center gap-1.5'>
                <span className='w-14 shrink-0 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
                  Filter
                </span>
                <Input
                  value={r.filter}
                  onChange={(e) =>
                    setRules(rules.map((x, xi) => (xi === i ? { ...x, filter: e.target.value } : x)))
                  }
                  placeholder='project_type or divisions.divisions_id'
                  className='h-7 flex-1 font-mono text-[11.5px]'
                />
                <label className='flex shrink-0 items-center gap-1 text-[11px] text-slate-500'>
                  <Switch
                    checked={!!r.via_many}
                    onCheckedChange={(v) =>
                      setRules(rules.map((x, xi) => (xi === i ? { ...x, via_many: v } : x)))
                    }
                  />
                  via many
                </label>
              </div>
            </div>
          ))}
          <button
            type='button'
            onClick={() => setRules([...rules, { parent_field: '', filter: '' }])}
            className='flex w-full items-center justify-center gap-1 rounded border border-dashed border-slate-300 px-2 py-1.5 text-[12px] text-slate-500 hover:border-nvr-cyan/50 hover:text-nvr-cyan dark:border-border'
          >
            <Plus className='h-3.5 w-3.5' /> Add cascade rule
          </button>
        </div>
        <div className='mt-2 flex justify-end gap-1.5'>
          <Button size='sm' variant='ghost' className='h-6 px-2 text-[11px]' onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size='sm'
            className='h-6 px-2.5 text-[11px]'
            disabled={saving}
            onClick={() => {
              onSave(rules.filter((r) => r.parent_field && r.filter.trim()))
              setOpen(false)
            }}
          >
            {saving ? 'Saving…' : 'Save cascade'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function SortableDimensionRow({
  d,
  siblings,
  onEdit,
  onDelete,
  onSaveCascade,
  cascadeSaving
}: {
  d: PipelineOwnerDimension
  siblings: PipelineOwnerDimension[]
  onEdit: () => void
  onDelete: () => void
  onSaveCascade: (rules: DimensionCascadeRule[]) => void
  cascadeSaving: boolean
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
        {(d.cascade ?? []).length > 0 && (
          <Badge variant='secondary' className='text-[10px] h-4 px-1.5 shrink-0'>
            cascades ({(d.cascade ?? []).length})
          </Badge>
        )}
      </div>
      <div className='flex items-center gap-1 shrink-0'>
        <DimensionCascadeEditor
          d={d}
          siblings={siblings}
          onSave={onSaveCascade}
          saving={cascadeSaving}
        />
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
  const client = useNivaroClient()
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
    queryFn: () =>
      client
        .request<{ data: any }>(get(`/collections/${binding.collection}`))
        .then((r) => r.data),
    enabled: !!binding.collection
  })
  const bindingFields: CMSField[] = bindingColMeta?.fields?.filter((f: CMSField) => !f.hidden) ?? []

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['pipeline-template', templateId] })

  const addDimension = useMutation({
    mutationFn: (body: DimensionFormData) =>
      client.request(post(`/pipelines/bindings/${binding.id}/dimensions`, body)),
    onSuccess: () => {
      invalidate()
      setNewForm({ field: '', label: '', sort: 0, is_row_axis: false, required: false })
      toast.success('Dimension added')
    },
    onError: () => toast.error('Failed to add dimension')
  })

  const updateDimension = useMutation({
    mutationFn: ({ dimId, body }: { dimId: number; body: Partial<DimensionFormData> }) =>
      client.request(patch(`/pipelines/dimensions/${dimId}`, body)),
    onSuccess: () => {
      invalidate()
      setEditingDimId(null)
      toast.success('Dimension updated')
    },
    onError: () => toast.error('Failed to update dimension')
  })

  const deleteDimension = useMutation({
    mutationFn: (dimId: number) => client.request(del(`/pipelines/dimensions/${dimId}`)),
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
                    siblings={orderedDims}
                    onEdit={() => startEdit(d)}
                    onDelete={() => {
                      if (confirm(`Delete dimension "${d.label}"?`)) deleteDimension.mutate(d.id)
                    }}
                    onSaveCascade={(rules) =>
                      updateDimension.mutate({
                        dimId: d.id,
                        body: { cascade: rules } as Partial<DimensionFormData> & {
                          cascade: DimensionCascadeRule[]
                        }
                      })
                    }
                    cascadeSaving={updateDimension.isPending}
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

export type PipelineEditorSection =
  | 'states'
  | 'transitions'
  | 'branches'
  | 'bindings'
  | 'matrix'
  | 'simulator'
  | 'canvas'
  | 'flow-map'
  | 'replay'
  | 'migration'
  | 'coverage'
  | 'ai-review'
  | 'versions'

export function PipelineEditorView({
  templateId,
  onBack,
  onExport,
  hidden
}: {
  templateId: string
  onBack?: () => void
  onExport?: () => Promise<void>
  /** Sections to omit entirely — e.g. a frontend host hides ['versions', 'replay', 'canvas']. Default: show everything. */
  hidden?: PipelineEditorSection[]
}) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const hiddenSet = new Set(hidden ?? [])

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
  const [teamsSheetOpen, setTeamsSheetOpen] = useState(false)

  // Local order for optimistic drag reordering of states
  const [localStateOrder, setLocalStateOrder] = useState<string[]>([])

  const stateSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const { data: bindingColFields } = useQuery({
    queryKey: ['collection-fields', bindingCollection],
    queryFn: () =>
      client
        .request<{ data: any }>(get(`/collections/${bindingCollection}`))
        .then((r) => (r.data?.fields ?? []).filter((f: CMSField) => !f.hidden)),
    enabled: !!bindingCollection
  })
  const [expandedBindingId, setExpandedBindingId] = useState<number | null>(null)

  const { data: templateData, isLoading } = useQuery<PipelineTemplate>({
    queryKey: ['pipeline-template', templateId],
    queryFn: () =>
      client
        .request<{ data: PipelineTemplate }>(get(`/pipelines/${templateId}`))
        .then((r) => r.data),
    enabled: !!templateId
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
    setLocalRouteOrder(
      Object.fromEntries(groups.map((g) => [g.label, g.routes.map((r) => r.ids[0])]))
    )
  }, [templateData?.transitions])

  const { data: collectionsData } = useQuery<Collection[]>({
    queryKey: ['collections', 'tables_only'],
    queryFn: () =>
      client
        .request<{ data: Collection[] }>(get('/collections?tables_only=true'))
        .then((r) => r.data)
  })

  const { data: ownerGroupsMap } = useQuery<PipelineOwnerGroupsMap>({
    queryKey: ['pipeline-all-owner-groups', templateId],
    queryFn: () =>
      client
        .request<{ data: PipelineOwnerGroupsMap }>(get(`/pipelines/${templateId}/owner-groups`))
        .then((r) => r.data),
    enabled: !!templateId
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['pipeline-template', templateId] })
    queryClient.invalidateQueries({ queryKey: ['pipeline-templates'] })
    queryClient.invalidateQueries({ queryKey: ['pipeline-all-owner-groups', templateId] })
  }

  // ─── Template mutations ─────────────────────────────────────────────────

  const updateTemplate = useMutation({
    mutationFn: (body: Partial<PipelineTemplate>) =>
      client.request(patch(`/pipelines/${templateId}`, body)),
    onSuccess: () => {
      invalidate()
      setEditingName(false)
    },
    onError: () => toast.error('Failed to update pipeline')
  })

  // ─── State mutations ────────────────────────────────────────────────────

  const addState = useMutation({
    mutationFn: (body: Omit<PipelineState, 'id' | 'template'>) =>
      client.request(post(`/pipelines/${templateId}/states`, body)),
    onSuccess: () => {
      invalidate()
      setAddingState(false)
    },
    onError: () => toast.error('Failed to add state')
  })

  const updateState = useMutation({
    mutationFn: ({ stateId, body }: { stateId: string; body: Partial<PipelineState> }) =>
      client.request(patch(`/pipelines/states/${stateId}`, body)),
    onSuccess: () => {
      invalidate()
      setEditingState(null)
    },
    onError: () => toast.error('Failed to update state')
  })

  const deleteState = useMutation({
    mutationFn: (stateId: string) => client.request(del(`/pipelines/states/${stateId}`)),
    onSuccess: () => {
      invalidate()
      toast.success('State deleted')
    },
    onError: (err) => {
      const msg = ((err as { response?: { error?: string } })?.response?.error ??
        (err as Error)?.message)
      toast.error(msg || 'Failed to delete state', { duration: 9000 })
    }
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
        requirements: data.requirements,
        auto_trigger: data.auto_trigger,
        comment_mode: data.comment_mode,
        group_label: null,
        actions: data.actions,
        sort: 0
      }
      for (const to_state of data.to_states) {
        await client.request(post(`/pipelines/${templateId}/transitions`, { ...shared, to_state }))
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
        await client.request(post(`/pipelines/${templateId}/transitions`, {
          from_state: data.from_state,
          label: labelGroup.label,
          color: labelGroup.color,
          required_roles: data.required_roles,
          condition_rules: data.condition_rules,
          requirements: data.requirements,
          auto_trigger: data.auto_trigger,
          group_label: null,
          actions: data.actions,
          sort: Math.max(labelGroup.minSort, ...labelGroup.routes.map((r) => r.minSort)),
          to_state
        }))
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
      // Diff-based save: PATCH kept targets in place, POST added ones, DELETE
      // removed ones LAST. The old delete-all-then-recreate broke on any
      // transition with history (FK) and risked losing the route on a
      // mid-flight failure.
      const existingByToState = new Map<string, string>()
      route.to_states.forEach((ts, i) => {
        existingByToState.set(ts, route.ids[i])
      })
      const desired = new Set(data.to_states)
      const shared = {
        from_state: data.from_state,
        label: data.label,
        color: data.color,
        required_roles: data.required_roles,
        condition_rules: data.condition_rules,
        requirements: data.requirements,
        auto_trigger: data.auto_trigger,
        comment_mode: data.comment_mode,
        actions: data.actions
      }
      for (const to_state of data.to_states) {
        const txId = existingByToState.get(to_state)
        if (txId) {
          await client.request(patch(`/pipelines/transitions/${txId}`, { ...shared, to_state }))
        } else {
          await client.request(post(`/pipelines/${templateId}/transitions`, {
            ...shared,
            group_label: null,
            sort: 0,
            to_state
          }))
        }
      }
      for (const [ts, txId] of existingByToState) {
        if (!desired.has(ts)) await client.request(del(`/pipelines/transitions/${txId}`))
      }
    },
    onSuccess: () => {
      invalidate()
      setEditingRoute(null)
    },
    onError: (err: unknown) => {
      const resp = (err as { response?: { error?: string } })?.response
      toast.error(resp?.error ?? (err as Error)?.message ?? 'Failed to update route')
    }
  })

  const deleteRoute = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const txId of ids) await client.request(del(`/pipelines/transitions/${txId}`))
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
        await client.request(patch(`/pipelines/transitions/${id}`, { sort }))
      }
    },
    onSuccess: () => invalidate(),
    onError: () => toast.error('Failed to reorder')
  })

  const patchGroupColor = useMutation({
    mutationFn: async ({ ids, color }: { ids: string[]; color: string | null }) => {
      for (const txId of ids)
        await client.request(patch(`/pipelines/transitions/${txId}`, { color }))
    },
    onSuccess: () => invalidate(),
    onError: () => toast.error('Failed to update color')
  })

  // ─── Binding mutations ──────────────────────────────────────────────────

  const bindCollection = useMutation({
    mutationFn: (body: { collection: string; state_field?: string }) =>
      client.request(post(`/pipelines/${templateId}/bind`, body)),
    onSuccess: () => {
      invalidate()
      setBindingCollection('')
      setStateField('')
      toast.success('Collection bound')
    },
    onError: () => toast.error('Failed to bind collection')
  })

  const unbindCollection = useMutation({
    mutationFn: (bindingId: number) => client.request(del(`/pipelines/bindings/${bindingId}`)),
    onSuccess: () => {
      invalidate()
      toast.success('Collection unbound')
    },
    onError: () => toast.error('Failed to unbind')
  })

  const updateBinding = useMutation({
    mutationFn: ({
      bindingId,
      body
    }: {
      bindingId: number
      body: {
        auto_start?: boolean
        auto_start_state?: string | null
        owner_fallback_field?: string | null
      }
    }) => client.request(patch(`/pipelines/bindings/${bindingId}`, body)),
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
      for (const routeId of routeOrder[label] ?? []) {
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
    const next = arrayMove(
      localGroupOrder,
      localGroupOrder.indexOf(active.id as string),
      localGroupOrder.indexOf(over.id as string)
    )
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
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2 text-[13px]'>
            {onBack && (
              <>
                <button
                  type='button'
                  onClick={onBack}
                  className='flex items-center gap-1 text-slate-400 transition-colors hover:text-slate-700'
                >
                  <ArrowLeft className='h-3.5 w-3.5' />
                  Pipelines
                </button>
                <span className='text-slate-300'>/</span>
              </>
            )}
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
          {onExport && (
            <Button
              size='sm'
              variant='outline'
              onClick={async () => {
                try {
                  await onExport()
                } catch {
                  toast.error('Export failed')
                }
              }}
            >
              <Download className='mr-1.5 h-3.5 w-3.5' /> Export
            </Button>
          )}
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
        {(!hiddenSet.has('states') || !hiddenSet.has('transitions')) && (
          <div className='grid gap-6 lg:grid-cols-[5fr_7fr]'>
            {/* States */}
            {!hiddenSet.has('states') && (
              <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
                <div className='flex items-center justify-between'>
                  <h2 className='text-[13px] font-semibold text-slate-800'>
                    States
                    <span className='ml-2 font-mono text-[11px] font-normal text-slate-400'>
                      {states.length}
                    </span>
                    <span className='mt-0.5 block max-w-[72ch] text-[12px] font-normal text-slate-500'>
                      The stages a record moves through, in order. Each can carry skip rules and
                      stage-track visibility.
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
                                templateId={templateId}
                                collection={bindings[0]?.collection}
                              />
                              <div className='border-t border-slate-200 pt-4'>
                                <PipelineSkipCriteria
                                  stateId={s.id}
                                  stateName={s.label}
                                  templateId={templateId}
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
            )}

            {/* Transitions */}
            {!hiddenSet.has('transitions') && (
              <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
                <div className='flex items-center justify-between'>
                  <h2 className='text-[13px] font-semibold text-slate-800'>
                    Transitions
                    <span className='ml-2 font-mono text-[11px] font-normal text-slate-400'>
                      {transitions.length}
                    </span>
                    <span className='mt-0.5 block max-w-[72ch] text-[12px] font-normal text-slate-500'>
                      The allowed moves between states — who may take them, the conditions that gate
                      them, and the actions they fire.
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
                  <DndContext
                    sensors={stateSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleGroupDragEnd}
                  >
                    <SortableContext items={localGroupOrder} strategy={verticalListSortingStrategy}>
                      {displayGroups.map((grp) => {
                        const routeMap = new Map(grp.routes.map((r) => [r.ids[0], r]))
                        const routeIds = localRouteOrder[grp.label] ?? grp.routes.map((r) => r.ids[0])
                        const displayRoutes = routeIds
                          .map((rid) => routeMap.get(rid))
                          .filter((r): r is RouteEntry => !!r)
                        return (
                          <SortableTransitionItem key={grp.label} id={grp.label}>
                            <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
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
                                    <p className='mb-2 text-[11px] font-medium text-slate-500'>
                                      Group color
                                    </p>
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
                              <DndContext
                                sensors={stateSensors}
                                collisionDetection={closestCenter}
                                onDragEnd={(e) => handleRouteDragEnd(grp.label, e)}
                              >
                                <SortableContext
                                  items={routeIds}
                                  strategy={verticalListSortingStrategy}
                                >
                                  {displayRoutes.map((route) => {
                                    const routeKey = `${grp.label}|${route.from_state ?? '_any_'}|${route.ids[0]}`
                                    const fromState = route.from_state
                                      ? stateById.get(route.from_state)
                                      : null
                                    const isEditing =
                                      editingRoute?.label === grp.label &&
                                      editingRoute.route.ids[0] === route.ids[0]

                                    if (isEditing) {
                                      return (
                                        <div
                                          key={routeKey}
                                          className='border-b border-slate-100 last:border-0 p-3'
                                        >
                                          <TransitionForm
                                            initial={{
                                              from_state: route.from_state,
                                              to_states: route.to_states,
                                              label: grp.label,
                                              color: grp.color,
                                              required_roles: route.required_roles,
                                              condition_rules: route.condition_rules,
                                              requirements: route.requirements,
                                              auto_trigger: route.auto_trigger,
                                              // Without this the form always opened
                                              // on 'No note', whatever was stored —
                                              // and saving then wrote that back.
                                              comment_mode: route.comment_mode,
                                              actions: route.actions
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
                                        <div className='group/row flex items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-0 hover:bg-slate-50'>
                                          <TransitionDragHandle />
                                          <div className='flex flex-1 min-w-0 flex-wrap items-center gap-1.5 text-[12px]'>
                                            {fromState ? (
                                              <StateBadge state={fromState} />
                                            ) : (
                                              <span className='italic text-slate-400 text-[11px]'>
                                                any state
                                              </span>
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
                                            {route.auto_trigger && (
                                              <span
                                                className='ml-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                                title='Automatic — fired by the engine when conditions match; hidden from users'
                                              >
                                                <Zap className='h-2.5 w-2.5' />
                                                Auto
                                              </span>
                                            )}
                                            {(route.actions ?? []).length > 0 && (
                                              <span
                                                className='ml-1 inline-flex items-center gap-1 rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700 dark:bg-teal-900/30 dark:text-teal-400'
                                                title='Transition actions run after this transition lands'
                                              >
                                                <PlugZap className='h-2.5 w-2.5' />
                                                {(route.actions ?? []).length}
                                              </span>
                                            )}
                                            {(route.condition_rules ?? []).length > 0 && (
                                              <span
                                                className='ml-1 inline-flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-nvr-navy'
                                                title={(route.condition_rules ?? [])
                                                  .map(
                                                    (r) => `${r.field} ${r.op} ${String(r.value ?? '')}`
                                                  )
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
                                              onClick={() =>
                                                setEditingRoute({ label: grp.label, route })
                                              }
                                              className='rounded p-1 text-slate-400 hover:text-slate-700'
                                            >
                                              <Pencil className='h-3.5 w-3.5' />
                                            </button>
                                            <button
                                              type='button'
                                              onClick={() => {
                                                if (confirm('Delete this route?'))
                                                  deleteRoute.mutate(route.ids)
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
                        )
                      })}
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
            )}
          </div>
        )}
        {/* end states+transitions grid */}

        {/* Parallel branches (split/join) */}
        {!hiddenSet.has('branches') && (
          <ParallelBranchesCard templateId={templateId} states={orderedStates} />
        )}

        {/* Bindings */}
        {!hiddenSet.has('bindings') && (
          <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
            <h2 className='text-[13px] font-semibold text-slate-800'>
              Applied to Collections
              <span className='mt-0.5 block max-w-[72ch] text-[12px] font-normal text-slate-500'>
                Which collections run this pipeline, and the ownership dimensions (Region, Zone…)
                the Owner Matrix below resolves against.
              </span>
            </h2>

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
                                  body: {
                                    auto_start: e.target.checked,
                                    auto_start_state: b.auto_start_state
                                  }
                                })
                              }
                              className='rounded'
                            />
                            <span className='text-[12px] text-slate-600'>Auto-start on create</span>
                          </label>
                          <div className='flex items-center gap-1.5'>
                            <span className='text-[11px] text-slate-400'>Owner fallback:</span>
                            <OwnerFallbackInput
                              value={b.owner_fallback_field ?? ''}
                              onCommit={(v) =>
                                updateBinding.mutate({
                                  bindingId: b.id,
                                  body: { owner_fallback_field: v || null }
                                })
                              }
                            />
                          </div>
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
                      <BindingDimensionsPanel binding={b} templateId={templateId} />
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
        )}

        {/* Owner Matrix */}
        {!hiddenSet.has('matrix') && hasMatrix && (
          <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
            <div className='flex items-start justify-between gap-4'>
              <h2 className='text-[13px] font-semibold text-slate-800'>
                Owner Matrix
                <span className='mt-0.5 block max-w-[72ch] text-[12px] font-normal text-slate-500'>
                  Who is responsible in each state, per dimension value. Records resolve their
                  owners from this grid automatically — notifications, queues, and SLAs follow it.
                </span>
              </h2>
              <Button
                size='sm'
                variant='outline'
                className='h-7 shrink-0 gap-1.5 text-[12px]'
                onClick={() => setTeamsSheetOpen(true)}
              >
                <ListChecks className='h-3.5 w-3.5' /> Manage teams
              </Button>
            </div>
            <OwnerMatrix templateId={templateId} states={orderedStates} bindings={bindings} />
          </div>
        )}

        {teamsSheetOpen && <TeamsSheet onClose={() => setTeamsSheetOpen(false)} />}

        {/* Simulator */}
        {!hiddenSet.has('simulator') && <PipelineSimulatorCard bindings={bindings} />}

        {/* Canvas */}
        {!hiddenSet.has('canvas') && <PipelineCanvasCard templateId={templateId} />}

        {/* Flow map */}
        {!hiddenSet.has('flow-map') && <PipelineFlowMapCard templateId={templateId} />}

        {/* Time-lapse replay */}
        {!hiddenSet.has('replay') && <PipelineReplayCard templateId={templateId} />}

        {/* Instance migration */}
        {!hiddenSet.has('migration') && <InstanceMigrationCard templateId={templateId} />}

        {/* Owner gaps */}
        {!hiddenSet.has('coverage') && <OwnerGapsCard templateId={templateId} states={states} />}

        {/* AI config reviewer (#361) */}
        {!hiddenSet.has('ai-review') && <AiReviewCard templateId={templateId} />}

        {/* Config versions */}
        {!hiddenSet.has('versions') && <PipelineVersionsCard templateId={templateId} />}
      </div>
    </>
  )
}

// ─── AI config reviewer (#361) ───────────────────────────────────────────────

export function AiReviewCard({ templateId }: { templateId: string }) {
  const client = useNivaroClient()
  const [result, setResult] = useState<{ structural: string[]; critique: string | null } | null>(null)
  const run = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { structural: string[]; critique: string | null } }>(
          post(`/pipelines/${templateId}/ai-review`)
        )
        .then((r) => r.data),
    onSuccess: setResult,
    onError: (e: unknown) =>
      toast.error(
        (e as { response?: { error?: string } })?.response?.error ??
          (e as Error)?.message ??
          'Review failed'
      )
  })
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-[13px] font-semibold text-slate-800'>Template review</h2>
          <p className='mt-0.5 max-w-[72ch] text-[12px] text-slate-500'>
            Structure analysis (unreachable states, dead ends, missing send-backs, unowned states)
            plus an AI critique of the state graph.
          </p>
        </div>
        <Button type='button' size='sm' variant='outline' className='h-7 text-[12px]' disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? 'Reviewing…' : 'Run review'}
        </Button>
      </div>
      {result && (
        <div className='mt-3 space-y-2'>
          {result.structural.length === 0 ? (
            <p className='text-[12px] text-emerald-600'>No structural problems found.</p>
          ) : (
            <ul className='space-y-1'>
              {result.structural.map((f) => (
                <li key={f} className='flex items-start gap-1.5 text-[12.5px] text-amber-700'>
                  <span className='mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400' />
                  {f}
                </li>
              ))}
            </ul>
          )}
          {result.critique && (
            <div className='whitespace-pre-wrap rounded-md border border-[#00ceff40] bg-[#00ceff0d] px-3 py-2 text-[12.5px] leading-snug text-slate-600'>
              {result.critique}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Config versions — snapshots captured before every template change ────────

interface TemplateVersionRow {
  id: number
  version: number
  note: string | null
  created_at: string
  created_by_name: string | null
}

function PipelineVersionsCard({ templateId }: { templateId: string }) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [diffId, setDiffId] = useState<number | null>(null)

  const { data: diff, isFetching: diffLoading } = useQuery({
    queryKey: ['pipeline-version-diff', templateId, diffId],
    queryFn: () =>
      client
        .request<{
          data: {
            from_version: number
            to: string
            diff: {
              template: Array<{ field: string; from: unknown; to: unknown }>
              states: VersionEntityDiff
              transitions: VersionEntityDiff
              bindings: VersionEntityDiff
            }
          }
        }>(get(`/pipelines/${templateId}/versions/${diffId}/diff`))
        .then((r) => r.data),
    enabled: diffId != null
  })

  const { data: versions, isLoading } = useQuery({
    queryKey: ['pipeline-versions', templateId],
    queryFn: () =>
      client
        .request<{ data: TemplateVersionRow[] }>(get(`/pipelines/${templateId}/versions`))
        .then((r) => r.data)
  })

  const restoreMut = useMutation({
    mutationFn: (versionId: number) =>
      client.request<{
        data?: { transitions?: { deleted: number; kept_in_history: number } }
      }>(post(`/pipelines/${templateId}/versions/${versionId}/restore`)),
    onSuccess: (res: {
      data?: { transitions?: { deleted: number; kept_in_history: number } }
    }) => {
      setConfirmId(null)
      const kept = res?.data?.transitions?.kept_in_history ?? 0
      toast.success(
        kept > 0
          ? `Version restored — ${kept} extra transition(s) kept (referenced by history)`
          : 'Version restored'
      )
      queryClient.invalidateQueries({ queryKey: ['pipeline', templateId] })
      queryClient.invalidateQueries({ queryKey: ['pipeline-versions', templateId] })
    },
    onError: () => toast.error('Failed to restore version')
  })

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-3'>
      <div className='flex items-center gap-2'>
        <History className='h-4 w-4 text-slate-400' />
        <h2 className='text-[13px] font-semibold text-slate-800'>Config versions</h2>
        {versions && versions.length > 0 && (
          <span className='ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
            {versions.length}
          </span>
        )}
      </div>
      {isLoading ? (
        <div className='space-y-2'>
          <Skeleton className='h-8 rounded' />
          <Skeleton className='h-8 rounded' />
        </div>
      ) : !versions || versions.length === 0 ? (
        <p className='text-[12px] text-slate-400'>
          No versions yet. A snapshot of the states, transitions and bindings is captured
          automatically before every config change.
        </p>
      ) : (
        <div className='max-h-72 divide-y divide-slate-100 overflow-y-auto dark:divide-border'>
          {versions.map((v) => (
            <div key={v.id} className='flex items-center gap-2 py-1.5'>
              <span className='shrink-0 font-mono text-[11px] font-semibold text-slate-700 dark:text-foreground'>
                v{v.version}
              </span>
              <span className='min-w-0 flex-1 truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                {v.note ?? '—'}
                {v.created_by_name?.trim() ? ` · ${v.created_by_name}` : ''}
              </span>
              <span className='shrink-0 text-[10.5px] text-slate-400'>
                {formatRelative(v.created_at)}
              </span>
              {confirmId === v.id ? (
                <span className='flex shrink-0 items-center gap-1.5'>
                  <Button
                    size='sm'
                    variant='destructive'
                    className='h-5 px-2 text-[10.5px]'
                    disabled={restoreMut.isPending}
                    onClick={() => restoreMut.mutate(v.id)}
                  >
                    {restoreMut.isPending ? 'Restoring…' : 'Yes, restore'}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-5 px-2 text-[10.5px]'
                    onClick={() => setConfirmId(null)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <span className='flex shrink-0 items-center gap-0.5'>
                  <button
                    type='button'
                    onClick={() => setDiffId((d) => (d === v.id ? null : v.id))}
                    className='rounded px-1.5 py-0.5 text-[10.5px] text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700 dark:hover:bg-muted'
                  >
                    {diffId === v.id ? 'Hide diff' : 'Diff'}
                  </button>
                  <button
                    type='button'
                    onClick={() => setConfirmId(v.id)}
                    className='rounded px-1.5 py-0.5 text-[10.5px] text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700 dark:hover:bg-muted'
                  >
                    Restore
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {diffId != null && (
        <div className='rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/30'>
          {diffLoading ? (
            <p className='text-[11.5px] text-slate-400'>Comparing…</p>
          ) : diff ? (
            <VersionDiffView fromVersion={diff.from_version} to={diff.to} diff={diff.diff} />
          ) : (
            <p className='text-[11.5px] text-slate-400'>Could not load the diff.</p>
          )}
        </div>
      )}
      <p className='text-[10.5px] text-slate-400'>
        Restore snapshots the current config first, then upserts states/transitions/bindings by id
        — states are never deleted, and transitions with execution history are kept.
      </p>
    </div>
  )
}


interface VersionEntityDiff {
  added: Array<Record<string, unknown>>
  removed: Array<Record<string, unknown>>
  changed: Array<{
    id: unknown
    label: string
    fields: Array<{ field: string; from: unknown; to: unknown }>
  }>
}

function fmtDiffVal(v: unknown): string {
  if (v == null || v === '') return '(empty)'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

/** Field-level diff between a stored version and the live config (#72) —
 *  "what would restoring change", answered before the restore button. */
function VersionDiffView({
  fromVersion,
  to,
  diff
}: {
  fromVersion: number
  to: string
  diff: {
    template: Array<{ field: string; from: unknown; to: unknown }>
    states: VersionEntityDiff
    transitions: VersionEntityDiff
    bindings: VersionEntityDiff
  }
}) {
  const sections: Array<{ label: string; d: VersionEntityDiff }> = [
    { label: 'States', d: diff.states },
    { label: 'Transitions', d: diff.transitions },
    { label: 'Bindings', d: diff.bindings }
  ]
  const empty =
    diff.template.length === 0 &&
    sections.every((s) => s.d.added.length + s.d.removed.length + s.d.changed.length === 0)
  return (
    <div className='space-y-2.5'>
      <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
        v{fromVersion} → {to}
      </p>
      {empty && <p className='text-[11.5px] text-slate-400'>No differences — identical config.</p>}
      {diff.template.length > 0 && (
        <div>
          <p className='text-[11px] font-semibold text-slate-600 dark:text-foreground'>Template</p>
          {diff.template.map((f) => (
            <p key={f.field} className='mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
              <span className='font-mono'>{f.field}</span>:{' '}
              <span className='text-red-600 line-through dark:text-red-400'>{fmtDiffVal(f.from)}</span>{' '}
              → <span className='text-emerald-700 dark:text-emerald-400'>{fmtDiffVal(f.to)}</span>
            </p>
          ))}
        </div>
      )}
      {sections.map(({ label, d }) =>
        d.added.length + d.removed.length + d.changed.length === 0 ? null : (
          <div key={label}>
            <p className='text-[11px] font-semibold text-slate-600 dark:text-foreground'>{label}</p>
            {/* "added" = present in the DIFF TARGET (usually current) but not the version */}
            {d.added.map((r) => (
              <p key={String(r.id)} className='mt-0.5 text-[11px] text-emerald-700 dark:text-emerald-400'>
                + {String(r.label ?? r.key ?? r.collection ?? r.id)} (only in {to})
              </p>
            ))}
            {d.removed.map((r) => (
              <p key={String(r.id)} className='mt-0.5 text-[11px] text-red-600 dark:text-red-400'>
                − {String(r.label ?? r.key ?? r.collection ?? r.id)} (only in v{fromVersion})
              </p>
            ))}
            {d.changed.map((c) => (
              <div key={String(c.id)} className='mt-0.5'>
                <p className='text-[11px] font-medium text-slate-600 dark:text-foreground'>{c.label}</p>
                {c.fields.map((f) => (
                  <p key={f.field} className='pl-3 text-[11px] text-slate-500 dark:text-muted-foreground'>
                    <span className='font-mono'>{f.field}</span>:{' '}
                    <span className='text-red-600 line-through dark:text-red-400'>
                      {fmtDiffVal(f.from)}
                    </span>{' '}
                    →{' '}
                    <span className='text-emerald-700 dark:text-emerald-400'>{fmtDiffVal(f.to)}</span>
                  </p>
                ))}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

// ─── Parallel branches (split/join) — merged from the old /workflows editor ───
// A split fans one record into several states at once; each branch runs with
// its own owners and SLA clock, and when every branch reaches a terminal
// state the record auto-joins downstream. Config lives in the same template.

type SplitStateLite = {
  id: string
  key: string
  label: string
  color: string | null
  is_terminal: boolean
}

type SplitConfig = {
  id: string
  label: string
  branch_states: string[]
  branch_state_objs: SplitStateLite[]
  join_state: string
  join_state_obj: SplitStateLite | null
}

function SplitStateChip({
  state,
  selected,
  onClick
}: {
  state: { key: string; label: string; color: string | null }
  selected?: boolean
  onClick?: () => void
}) {
  const base = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium'
  const style = {
    backgroundColor: state.color ? `${state.color}22` : '#f1f5f9',
    color: state.color ?? '#475569',
    border: `1px solid ${selected ? (state.color ?? '#475569') : state.color ? `${state.color}44` : '#e2e8f0'}`,
    boxShadow: selected ? `0 0 0 1px ${state.color ?? '#475569'}` : undefined
  }
  if (!onClick) {
    return (
      <span className={base} style={style}>
        {state.label}
      </span>
    )
  }
  return (
    <button type='button' className={`${base} transition-shadow`} style={style} onClick={onClick}>
      {selected && <Check className='h-3 w-3' />}
      {state.label}
    </button>
  )
}

/**
 * Names a user column on the bound record whose user counts as an owner, so a
 * record no owner group matches still has someone accountable for it rather
 * than falling off every worklist. Commits on blur/Enter — a per-keystroke
 * PATCH would write a half-typed column name.
 */
function OwnerFallbackInput({
  value,
  onCommit
}: {
  value: string
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (draft.trim() !== value.trim()) onCommit(draft.trim())
  }
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setDraft(value)
      }}
      placeholder='none'
      title='User column on the record (e.g. user_created) whose user is always an owner'
      className='w-40 rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[11px] dark:border-border dark:bg-background'
    />
  )
}

function SplitCreateForm({
  states,
  saving,
  onSave,
  onCancel
}: {
  states: PipelineState[]
  saving: boolean
  onSave: (data: { branch_states: string[]; join_state: string; label: string }) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [branchKeys, setBranchKeys] = useState<string[]>([])
  const [joinKey, setJoinKey] = useState('')

  const toggleBranch = (key: string) => {
    setBranchKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
    if (joinKey === key) setJoinKey('')
  }
  const valid = branchKeys.length >= 2 && !!joinKey && !branchKeys.includes(joinKey)

  return (
    <div className='rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4'>
      <div className='space-y-1.5'>
        <Label className='text-[12px]'>Label</Label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder='e.g. Finance + Engineering review in parallel'
          className='text-[13px] bg-white'
        />
      </div>
      <div className='space-y-1.5'>
        <Label className='text-[12px]'>
          Branch start states
          <span className='ml-1.5 font-normal text-slate-400'>
            (pick 2 or more — the record enters ALL of them at once)
          </span>
        </Label>
        <div className='flex flex-wrap gap-1.5'>
          {states.map((st) => (
            <SplitStateChip
              key={st.id}
              state={st}
              selected={branchKeys.includes(st.key)}
              onClick={() => toggleBranch(st.key)}
            />
          ))}
        </div>
      </div>
      <div className='space-y-1.5'>
        <Label className='text-[12px]'>
          Join state
          <span className='ml-1.5 font-normal text-slate-400'>
            (auto-entered when every branch reaches a terminal state)
          </span>
        </Label>
        <div className='flex flex-wrap gap-1.5'>
          {states
            .filter((st) => !branchKeys.includes(st.key))
            .map((st) => (
              <SplitStateChip
                key={st.id}
                state={st}
                selected={joinKey === st.key}
                onClick={() => setJoinKey(joinKey === st.key ? '' : st.key)}
              />
            ))}
        </div>
      </div>
      <div className='flex items-center justify-end gap-2'>
        <Button type='button' size='sm' variant='ghost' className='text-[12px]' onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type='button'
          size='sm'
          className='text-[12px]'
          disabled={!valid || saving}
          onClick={() =>
            onSave({ branch_states: branchKeys, join_state: joinKey, label: label.trim() })
          }
        >
          {saving ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Create Split'}
        </Button>
      </div>
    </div>
  )
}

function ParallelBranchesCard({
  templateId,
  states
}: {
  templateId: string
  states: PipelineState[]
}) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const splitsKey = ['workflow-splits', templateId]
  const { data: splits } = useQuery<SplitConfig[]>({
    queryKey: splitsKey,
    queryFn: () =>
      client
        .request<{ data: SplitConfig[] }>(get(`/workflows/templates/${templateId}/splits`))
        .then((r) => r.data)
  })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: splitsKey })

  const createSplit = useMutation({
    mutationFn: (body: { branch_states: string[]; join_state: string; label: string }) =>
      client.request(post(`/workflows/templates/${templateId}/splits`, body)),
    onSuccess: () => {
      invalidate()
      setAdding(false)
      toast.success('Split created')
    },
    onError: (err: unknown) => {
      const msg = ((err as { response?: { error?: string } })?.response?.error ??
        (err as Error)?.message)
      toast.error(msg ?? 'Failed to create split')
    }
  })
  const deleteSplit = useMutation({
    mutationFn: (splitId: string) =>
      client.request(del(`/workflows/templates/${templateId}/splits/${splitId}`)),
    onSuccess: () => {
      invalidate()
      setConfirmDelete(null)
      toast.success('Split deleted')
    },
    onError: () => toast.error('Failed to delete split')
  })

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
      <div className='flex items-start justify-between gap-4'>
        <h2 className='flex-1 text-[13px] font-semibold text-slate-800'>
          <span className='flex items-center gap-2'>
            <GitFork className='h-4 w-4 text-slate-400' />
            Parallel Branches
            <span className='font-mono text-[11px] font-normal text-slate-400'>
              {splits?.length ?? 0}
            </span>
          </span>
          <span className='mt-0.5 block max-w-[72ch] text-[12px] font-normal text-slate-500'>
            A split sends one record into several states at the same time — each branch keeps its
            own owners and SLA clock. When every branch reaches a terminal state, the record
            auto-joins into the join state. Splits appear as a "Split" action on bound records.
          </span>
        </h2>
        {!adding && (
          <Button
            size='sm'
            variant='outline'
            className='h-7 shrink-0 gap-1.5 text-[12px]'
            onClick={() => setAdding(true)}
            disabled={states.length < 3}
          >
            <Plus className='h-3 w-3' />
            Add Split
          </Button>
        )}
      </div>

      {states.length < 3 && (
        <p className='text-[13px] text-slate-400'>
          Define at least 3 states (2 branch starts + 1 join) before adding a split.
        </p>
      )}
      {(splits?.length ?? 0) === 0 && !adding && states.length >= 3 && (
        <p className='text-[13px] text-slate-400'>
          No splits yet — this pipeline runs as a single track. Add one when two reviews should
          happen concurrently instead of one after the other.
        </p>
      )}

      {(splits ?? []).map((split) => (
        <div
          key={split.id}
          className='flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-3'
        >
          <div className='min-w-0 flex-1 space-y-1.5'>
            <p className='text-[12px] font-medium text-slate-700'>{split.label}</p>
            <div className='flex flex-wrap items-center gap-1.5'>
              {split.branch_state_objs.map((st) => (
                <SplitStateChip key={st.id} state={st} />
              ))}
              <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
              {split.join_state_obj ? (
                <SplitStateChip state={split.join_state_obj} />
              ) : (
                <span className='text-[12px] italic text-slate-400'>missing join state</span>
              )}
            </div>
          </div>
          {confirmDelete === split.id ? (
            <div className='flex shrink-0 items-center gap-2'>
              <span className='text-[12px] text-slate-500'>Delete?</span>
              <Button
                size='sm'
                variant='destructive'
                className='h-7 text-[12px]'
                disabled={deleteSplit.isPending}
                onClick={() => deleteSplit.mutate(split.id)}
              >
                {deleteSplit.isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Confirm'}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                className='h-7 text-[12px]'
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <button
              type='button'
              className='shrink-0 rounded p-1.5 text-slate-400 hover:text-red-500'
              onClick={() => setConfirmDelete(split.id)}
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>
      ))}

      {adding && (
        <SplitCreateForm
          states={states}
          saving={createSplit.isPending}
          onSave={(data) => createSplit.mutate(data)}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  )
}

// ─── Simulator — dry-run a record through the pipeline ────────────────────────

interface SimState {
  id: string
  key: string
  label: string
  color: string | null
  is_current: boolean
  is_terminal: boolean
  owners: Array<{ id: string; email: string; first_name: string | null; last_name: string | null }>
  sla_rule: { name: string; duration_hours: number; business_hours_only: boolean } | null
}

interface SimTransition {
  id: string
  label: string
  from_ok: boolean
  conditions_pass: boolean
  role_pass: boolean
  available: boolean
  required_roles: string[]
  condition_rules: Array<{
    field: string
    op: string
    value: unknown
    record_value: unknown
    passed: boolean
  }>
}

export function PipelineSimulatorCard({ bindings }: { bindings: Array<{ collection: string }> }) {
  const client = useNivaroClient()
  const [itemId, setItemId] = useState('')
  const [collection, setCollection] = useState('')
  const effectiveCollection = collection || bindings[0]?.collection || ''

  const sim = useMutation({
    mutationFn: () =>
      client
        .request<{
          data: {
            current_state: string | null
            states: SimState[]
            transitions: SimTransition[]
            has_instance: boolean
          } | null
        }>(post('/pipelines/simulate', { collection: effectiveCollection, item_id: itemId.trim() }))
        .then((r) => r.data),
    onError: () => toast.error('Simulation failed')
  })
  const result = sim.data

  if (bindings.length === 0) return null

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
      <div>
        <h2 className='text-[13px] font-semibold text-slate-800'>Simulator</h2>
        <p className='text-[12px] text-slate-400'>
          Dry-run a record: who would own each state, which transitions are available and why.
        </p>
      </div>
      <div className='flex items-end gap-2'>
        {bindings.length > 1 && (
          <div>
            <p className='mb-1 text-[11px] font-medium text-slate-500'>Collection</p>
            <div className='flex items-center rounded-lg border border-slate-200 p-0.5'>
              {bindings.map((b) => (
                <button
                  key={b.collection}
                  type='button'
                  onClick={() => setCollection(b.collection)}
                  className={cn(
                    'h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors',
                    effectiveCollection === b.collection
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-400 hover:text-slate-700'
                  )}
                >
                  {b.collection}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <p className='mb-1 text-[11px] font-medium text-slate-500'>
            Record ID{bindings.length === 1 ? ` (${effectiveCollection})` : ''}
          </p>
          <Input
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            placeholder='e.g. 366518'
            className='h-8 w-40 text-[13px]'
            onKeyDown={(e) => {
              if (e.key === 'Enter' && itemId.trim()) sim.mutate()
            }}
          />
        </div>
        <Button size='sm' disabled={!itemId.trim() || sim.isPending} onClick={() => sim.mutate()}>
          {sim.isPending ? 'Running…' : 'Simulate'}
        </Button>
      </div>

      {sim.isSuccess && result === null && (
        <p className='text-[12px] text-slate-400'>
          No pipeline binding or instance for this record.
        </p>
      )}

      {result && (
        <div className='space-y-4'>
          {!result.has_instance && (
            <p className='text-[12px] text-amber-600'>
              No workflow instance yet — simulating from the initial state.
            </p>
          )}
          {/* State track with owners + SLA */}
          <div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-3'>
            {result.states.map((s) => (
              <div
                key={s.id}
                className={cn(
                  'rounded-lg border p-3',
                  s.is_current ? 'border-[#00ceff] bg-[#00ceff0a]' : 'border-slate-200'
                )}
              >
                <div className='flex items-center gap-1.5'>
                  <span
                    className='h-2 w-2 shrink-0 rounded-full'
                    style={{ background: s.color ?? '#94a3b8' }}
                  />
                  <p className='truncate text-[12px] font-semibold text-slate-800'>{s.label}</p>
                  {s.is_current && (
                    <Badge className='ml-auto h-4 shrink-0 px-1.5 text-[9px]'>current</Badge>
                  )}
                </div>
                <p className='mt-1.5 text-[11px] text-slate-500'>
                  {s.owners.length === 0
                    ? 'No owners'
                    : s.owners
                        .map(
                          (o) => [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
                        )
                        .slice(0, 3)
                        .join(', ') + (s.owners.length > 3 ? ` +${s.owners.length - 3}` : '')}
                </p>
                {s.sla_rule && (
                  <p className='mt-0.5 text-[10px] text-slate-400'>
                    SLA: {s.sla_rule.duration_hours}h
                    {s.sla_rule.business_hours_only ? ' (business)' : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
          {/* Transitions */}
          <table className='w-full text-left text-[12px]'>
            <thead>
              <tr className='border-b border-slate-100 text-[11px] text-slate-500'>
                <th className='py-1.5 font-medium'>Transition</th>
                <th className='py-1.5 font-medium'>From current</th>
                <th className='py-1.5 font-medium'>Conditions</th>
                <th className='py-1.5 font-medium'>Role</th>
                <th className='py-1.5 font-medium'>Available</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-50'>
              {result.transitions.map((t) => (
                <tr key={t.id} className={cn(!t.available && 'text-slate-400')}>
                  <td className='py-1.5 font-medium'>{t.label}</td>
                  <td className='py-1.5'>{t.from_ok ? '✓' : '—'}</td>
                  <td className='py-1.5'>
                    {t.condition_rules.length === 0 ? (
                      '—'
                    ) : t.conditions_pass ? (
                      '✓ pass'
                    ) : (
                      <span
                        className='text-red-500'
                        title={t.condition_rules
                          .filter((r) => !r.passed)
                          .map(
                            (r) =>
                              `${r.field} ${r.op} ${JSON.stringify(r.value)} (is ${JSON.stringify(r.record_value)})`
                          )
                          .join('; ')}
                      >
                        ✗ {t.condition_rules.filter((r) => !r.passed).length} failing
                      </span>
                    )}
                  </td>
                  <td className='py-1.5'>
                    {t.required_roles.length === 0 ? '—' : t.role_pass ? '✓' : '✗ restricted'}
                  </td>
                  <td className='py-1.5'>
                    {t.available ? (
                      <Badge className='h-4 bg-green-100 px-1.5 text-[9px] text-green-700'>
                        yes
                      </Badge>
                    ) : (
                      <span className='text-[11px]'>no</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Flow map — Sankey of transition volumes ──────────────────────────────────

interface FlowState {
  id: string
  label: string
  color: string | null
}

interface Flow {
  from: string
  to: string
  count: number
  back: boolean
}

const FLOW_W = 900
const FLOW_COL_W = 230

/**
 * Instance migration — the data-side companion of config versioning: when a
 * redesign removes or renames states, live records don't orphan silently.
 * Shows the instance distribution (orphaned states flagged red) and moves a
 * state's instances to a current state with history rows on every record.
 */
/**
 * Owner-gap advisor — why records resolve no owners, clustered by their
 * dimension values, with the closest owner-group repair suggested.
 */
// ─── Owner coverage (redesigned 2026-08-26) ──────────────────────────────────
// One question, one surface: who actually covers this pipeline? Two problem
// classes — records resolving NOBODY (clustered by dimension combination,
// with the closest group as the proposed repair) and owner seats held by
// people who can no longer act (suspended/redacted), fixable in place.

interface OwnerGapCluster {
  state_id: string
  state_key: string | null
  collection: string
  count: number
  sample_items: string[]
  dims: Record<string, string>
  filters: Array<{ field: string; op: 'eq'; value: string; id_value: number | null }>
  suggestion: {
    group_id: string | null
    group_label: string | null
    matched_filters: string[]
    mismatched_filters: string[]
  } | null
}

interface HygieneFinding {
  type: string
  state: string
  group_id: string
  group_name: string
  detail: string
  other_group_id?: string
  other_group_name?: string
  dead_field?: string
  group_filters?: Array<{ field?: string; op?: string; value?: unknown; id_value?: unknown }>
}

/** Compact multi-select people picker for the coverage remediations —
 *  search-as-you-type over /users, selected people as removable chips. */
function CoveragePeoplePicker({
  selected,
  onChange
}: {
  selected: Array<{ id: string; name: string }>
  onChange: (next: Array<{ id: string; name: string }>) => void
}) {
  const client = useNivaroClient()
  const [q, setQ] = useState('')
  const { data: users, isFetching } = useQuery<User[]>({
    queryKey: ['coverage-people', q],
    queryFn: () =>
      client
        .request<{ data: User[] }>(
          get('/users', { limit: 50, sort: 'first_name', search: q || undefined })
        )
        .then((r) => r.data),
    staleTime: 60_000
  })
  const selectedIds = new Set(selected.map((u) => u.id))
  const nameOf = (u: User) =>
    [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
  const secondaryOf = (u: User) =>
    [u.title, u.department].filter(Boolean).join(' · ') || u.email
  const sorted = [...(users ?? [])].sort((a, b) =>
    nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' })
  )
  return (
    <div className='space-y-1.5'>
      {selected.length > 0 && (
        <div className='flex flex-wrap gap-1'>
          {selected.map((u) => (
            <span
              key={u.id}
              className='inline-flex items-center gap-1 rounded-full bg-[#00ceff1a] px-2 py-px text-[11px] font-medium text-slate-700 dark:text-slate-200'
            >
              {u.name}
              <button
                type='button'
                aria-label={`Remove ${u.name}`}
                className='text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                onClick={() => onChange(selected.filter((x) => x.id !== u.id))}
              >
                <X className='h-3 w-3' />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder='Search people…'
        className='h-7 text-[12px]'
      />
      <div className='max-h-36 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200 dark:divide-border/60 dark:border-border'>
        {sorted.map((u) => {
          const picked = selectedIds.has(String(u.id))
          return (
            <button
              key={u.id}
              type='button'
              className={cn(
                'flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] transition-colors',
                picked ? 'bg-[#00ceff0f]' : 'hover:bg-muted'
              )}
              onClick={() =>
                onChange(
                  picked
                    ? selected.filter((x) => x.id !== String(u.id))
                    : [...selected, { id: String(u.id), name: nameOf(u) }]
                )
              }
            >
              <span
                className={cn(
                  'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                  picked
                    ? 'border-[#00ceff] bg-[#00ceff] text-white'
                    : 'border-slate-300 dark:border-border'
                )}
              >
                {picked && <Check className='h-2.5 w-2.5' />}
              </span>
              <span className='min-w-0 flex-1 truncate whitespace-nowrap font-medium text-slate-700 dark:text-slate-200'>
                {nameOf(u)}
              </span>
              <span className='max-w-[55%] shrink-0 truncate text-[10.5px] text-slate-400'>
                {secondaryOf(u)}
              </span>
            </button>
          )
        })}
        {!isFetching && (users ?? []).length === 0 && (
          <p className='px-2 py-2 text-[11.5px] text-slate-400'>No matching people</p>
        )}
      </div>
    </div>
  )
}

/** Inline remediation for one unowned cluster: adds people to the closest
 *  fully-matching group when one exists (the group matched but nobody active
 *  sits in it), otherwise creates a group scoped to this exact combination. */
function ClusterAssignPanel({
  templateId,
  cluster,
  onDone
}: {
  templateId: string
  cluster: OwnerGapCluster
  onDone: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const useExisting =
    !!cluster.suggestion?.group_id && cluster.suggestion.mismatched_filters.length === 0
  const defaultName = Object.values(cluster.dims).filter(Boolean).join(' · ') || 'New group'
  const [name, setName] = useState(defaultName)
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([])
  const [teamIds, setTeamIds] = useState<number[]>([])
  const scopeDims = useScopeDimensions()
  const { data: allTeams } = useQuery<
    Array<{
      id: number
      name: string
      member_count: number
      scopes?: Record<string, Array<string | number>>
    }>
  >({
    queryKey: ['user-groups-teams'],
    queryFn: () =>
      client
        .request<{
          data: Array<{
            id: number
            name: string
            member_count: number
            scopes?: Record<string, Array<string | number>>
          }>
        }>(get('/user-groups'))
        .then((r) => r.data),
    staleTime: 60_000
  })
  // Rank teams by the cluster's dimension values — a team scoped to exactly
  // this combination is the obvious staffing answer, so it leads.
  const rankedTeams = (allTeams ?? [])
    .map((t) => ({
      ...t,
      rank: rankTeamForFilters(t.scopes, cluster.filters, scopeDims, cluster.collection)
    }))
    .sort(
      (a, b) =>
        tierOrder(a.rank.tier) - tierOrder(b.rank.tier) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    )

  const assign = useMutation({
    mutationFn: async () => {
      let groupId = useExisting ? String(cluster.suggestion?.group_id) : null
      if (!groupId) {
        const r = await client.request<{ data: PipelineOwnerGroup }>(
          post(`/pipelines/states/${cluster.state_id}/owner-groups`, {
            name: name.trim() || defaultName,
            filters: cluster.filters,
            is_default: false,
            sort: 0,
            priority: 0
          })
        )
        groupId = String(r.data.id)
      }
      for (const tid of teamIds) {
        await client.request(post(`/pipelines/owner-groups/${groupId}/teams`, { team_id: tid }))
      }
      for (const u of people) {
        await client.request(post(`/pipelines/owner-groups/${groupId}/users`, { user: u.id }))
      }
      return people.length + teamIds.length
    },
    onSuccess: (n) => {
      toast.success(
        useExisting
          ? `Added ${n} owner${n === 1 ? '' : 's'} to ${cluster.suggestion?.group_label}`
          : `Created "${name.trim() || defaultName}" with ${n} owner${n === 1 ? '' : 's'}`
      )
      void qc.invalidateQueries({ queryKey: ['owner-gaps', templateId] })
      void qc.invalidateQueries({ queryKey: ['owner-lint', templateId] })
      void qc.invalidateQueries({ queryKey: ['pipeline-all-owner-groups', templateId] })
      onDone()
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { error?: string } })?.response?.error ?? 'Assignment failed',
        { duration: 9000 }
      )
  })

  return (
    <div className='mt-2 ml-8 space-y-2 rounded-md border border-slate-200 bg-slate-50/60 p-2.5 dark:border-border dark:bg-muted/20'>
      {useExisting ? (
        <p className='text-[11.5px] text-slate-600 dark:text-slate-300'>
          <span className='font-medium text-slate-800 dark:text-foreground'>
            {cluster.suggestion?.group_label}
          </span>{' '}
          already covers this combination — it just has nobody active in it. People you pick are
          added there.
        </p>
      ) : (
        <div className='space-y-1'>
          <p className='text-[11.5px] text-slate-600 dark:text-slate-300'>
            Creates a group scoped to exactly this combination, with the people you pick.
          </p>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Group name'
            className='h-7 text-[12px]'
          />
        </div>
      )}
      {rankedTeams.length > 0 && (
        <div className='flex flex-wrap items-center gap-1'>
          <span className='mr-0.5 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
            Teams
          </span>
          {rankedTeams.map((t) => {
            const picked = teamIds.includes(t.id)
            return (
              <button
                key={t.id}
                type='button'
                data-tip={
                  t.rank.tier === 'out'
                    ? `Outside this combination — ${t.rank.mismatches.join('; ')}. Picking it is an override.`
                    : t.rank.tier === 'suggested'
                      ? 'Scoped to this combination'
                      : undefined
                }
                onClick={() =>
                  setTeamIds(picked ? teamIds.filter((x) => x !== t.id) : [...teamIds, t.id])
                }
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] transition-colors',
                  picked
                    ? 'border-violet-300 bg-violet-100 font-medium text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-300'
                    : t.rank.tier === 'out'
                      ? 'border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-500/30 dark:text-amber-400 dark:hover:bg-amber-500/10'
                      : 'border-slate-200 text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
                )}
              >
                {t.rank.tier === 'suggested' && (
                  <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />
                )}
                {t.name}
                <span className='tabular-nums text-slate-400'>{t.member_count}</span>
              </button>
            )
          })}
        </div>
      )}
      <CoveragePeoplePicker selected={people} onChange={setPeople} />
      <div className='flex items-center justify-end gap-1.5'>
        <Button size='sm' variant='ghost' className='h-6 px-2 text-[11px]' onClick={onDone}>
          Cancel
        </Button>
        <Button
          size='sm'
          className='h-6 px-2.5 text-[11px]'
          disabled={(people.length === 0 && teamIds.length === 0) || assign.isPending}
          onClick={() => assign.mutate()}
        >
          {assign.isPending
            ? 'Assigning…'
            : people.length + teamIds.length === 0
              ? 'Assign'
              : `Assign ${people.length + teamIds.length} owner${people.length + teamIds.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  )
}

/** One hygiene finding with its fix inline: merge duplicates, staff or delete
 *  empty groups, strip dead filters. */
function HygieneRow({
  templateId,
  finding
}: {
  templateId: string
  finding: HygieneFinding
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [mode, setMode] = useState<'idle' | 'confirm-merge' | 'confirm-delete' | 'add-member'>(
    'idle'
  )
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([])
  const done = (msg: string) => {
    toast.success(msg)
    setMode('idle')
    setPeople([])
    void qc.invalidateQueries({ queryKey: ['owner-lint', templateId] })
    void qc.invalidateQueries({ queryKey: ['owner-gaps', templateId] })
    void qc.invalidateQueries({ queryKey: ['pipeline-all-owner-groups', templateId] })
  }
  const fail = (e: unknown) =>
    toast.error((e as { response?: { error?: string } })?.response?.error ?? 'Action failed', {
      duration: 9000
    })

  const merge = useMutation({
    mutationFn: () =>
      client.request<{ data: { moved: number } }>(
        post(`/pipelines/owner-groups/${finding.group_id}/merge-into`, {
          target_group_id: finding.other_group_id
        })
      ),
    onSuccess: (r) =>
      done(`Merged into ${finding.other_group_name} — ${r.data.moved} member(s) moved`),
    onError: fail
  })
  const removeGroup = useMutation({
    mutationFn: () => client.request(del(`/pipelines/owner-groups/${finding.group_id}`)),
    onSuccess: () => done(`Deleted ${finding.group_name}`),
    onError: fail
  })
  const addMembers = useMutation({
    mutationFn: async () => {
      for (const u of people) {
        await client.request(
          post(`/pipelines/owner-groups/${finding.group_id}/users`, { user: u.id })
        )
      }
      return people.length
    },
    onSuccess: (n) => done(`Added ${n} ${n === 1 ? 'person' : 'people'} to ${finding.group_name}`),
    onError: fail
  })
  const removeFilter = useMutation({
    mutationFn: () =>
      client.request(
        patch(`/pipelines/owner-groups/${finding.group_id}`, {
          filters: (finding.group_filters ?? []).filter((f) => f.field !== finding.dead_field)
        })
      ),
    onSuccess: () => done(`Removed the "${finding.dead_field}" filter from ${finding.group_name}`),
    onError: fail
  })
  const busy =
    merge.isPending || removeGroup.isPending || addMembers.isPending || removeFilter.isPending

  const actionBtn = 'h-6 shrink-0 px-2 text-[11px]'
  return (
    <div className='py-1.5 text-[12px]'>
      <div className='flex items-start gap-2'>
        <span
          className={cn(
            'mt-0.5 shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase',
            finding.type === 'empty' && 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
            finding.type === 'duplicate' &&
              'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
            finding.type === 'unknown_field' &&
              'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300'
          )}
        >
          {finding.type === 'empty'
            ? 'No members'
            : finding.type === 'duplicate'
              ? 'Duplicate'
              : finding.type === 'unknown_field'
                ? 'Dead filter'
                : finding.type}
        </span>
        <span className='min-w-0 flex-1'>
          <span className='font-medium text-slate-700 dark:text-foreground'>
            {finding.state} · {finding.group_name}
          </span>{' '}
          <span className='text-slate-500 dark:text-muted-foreground'>— {finding.detail}</span>
        </span>
        {mode === 'idle' && (
          <span className='flex shrink-0 items-center gap-1'>
            {finding.type === 'duplicate' && finding.other_group_id && (
              <Button
                size='sm'
                variant='outline'
                className={actionBtn}
                disabled={busy}
                onClick={() => setMode('confirm-merge')}
              >
                Merge…
              </Button>
            )}
            {finding.type === 'empty' && (
              <>
                <Button
                  size='sm'
                  variant='outline'
                  className={actionBtn}
                  disabled={busy}
                  onClick={() => setMode('add-member')}
                >
                  Add people…
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  className={cn(actionBtn, 'text-red-600 hover:text-red-700 dark:text-red-400')}
                  disabled={busy}
                  onClick={() => setMode('confirm-delete')}
                >
                  Delete…
                </Button>
              </>
            )}
            {finding.type === 'unknown_field' && finding.dead_field && finding.group_filters && (
              <Button
                size='sm'
                variant='outline'
                className={actionBtn}
                disabled={busy}
                onClick={() => removeFilter.mutate()}
              >
                {removeFilter.isPending ? 'Removing…' : 'Remove filter'}
              </Button>
            )}
          </span>
        )}
      </div>
      {mode === 'confirm-merge' && (
        <div className='mt-1.5 ml-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-slate-600 dark:text-slate-300'>
          Move its members into “{finding.other_group_name}” and delete this group?
          <Button
            size='sm'
            className='h-6 px-2 text-[11px]'
            disabled={merge.isPending}
            onClick={() => merge.mutate()}
          >
            {merge.isPending ? 'Merging…' : 'Merge'}
          </Button>
          <Button
            size='sm'
            variant='ghost'
            className='h-6 px-2 text-[11px]'
            onClick={() => setMode('idle')}
          >
            Cancel
          </Button>
        </div>
      )}
      {mode === 'confirm-delete' && (
        <div className='mt-1.5 ml-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-slate-600 dark:text-slate-300'>
          Delete “{finding.group_name}”? It has no members, so nothing loses coverage.
          <Button
            size='sm'
            variant='destructive'
            className='h-6 px-2 text-[11px]'
            disabled={removeGroup.isPending}
            onClick={() => removeGroup.mutate()}
          >
            {removeGroup.isPending ? 'Deleting…' : 'Delete group'}
          </Button>
          <Button
            size='sm'
            variant='ghost'
            className='h-6 px-2 text-[11px]'
            onClick={() => setMode('idle')}
          >
            Cancel
          </Button>
        </div>
      )}
      {mode === 'add-member' && (
        <div className='mt-2 ml-2 space-y-2 rounded-md border border-slate-200 bg-slate-50/60 p-2.5 dark:border-border dark:bg-muted/20'>
          <CoveragePeoplePicker selected={people} onChange={setPeople} />
          <div className='flex items-center justify-end gap-1.5'>
            <Button
              size='sm'
              variant='ghost'
              className='h-6 px-2 text-[11px]'
              onClick={() => {
                setMode('idle')
                setPeople([])
              }}
            >
              Cancel
            </Button>
            <Button
              size='sm'
              className='h-6 px-2.5 text-[11px]'
              disabled={people.length === 0 || addMembers.isPending}
              onClick={() => addMembers.mutate()}
            >
              {addMembers.isPending ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function OwnerGapsCard({
  templateId,
  states
}: {
  templateId: string
  states: PipelineState[]
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [confirmClean, setConfirmClean] = useState(false)
  const [assigningCluster, setAssigningCluster] = useState<string | null>(null)
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['owner-gaps', templateId],
    queryFn: () =>
      client
        .request<{
          data: {
            clusters: OwnerGapCluster[]
            dead_seats: {
              group_seats: number
              instance_seats: number
              users: Array<{ id: string | null; name: string; seats: number; redacted: boolean }>
            }
          }
        }>(get(`/pipelines/${templateId}/owner-gaps`))
        .then((r) => r.data),
    enabled: open,
    staleTime: 5 * 60_000
  })
  // Matrix hygiene rides the same Analyze click — the lint's inactive_member
  // findings are the dead seats above, so they are filtered out here.
  const { data: lint } = useQuery<{ groups_checked: number; findings: HygieneFinding[] }>({
    queryKey: ['owner-lint', templateId],
    queryFn: () =>
      client
        .request<{ data: { groups_checked: number; findings: HygieneFinding[] } }>(
          get(`/pipelines/${templateId}/owner-lint`)
        )
        .then((r) => r.data),
    enabled: open,
    staleTime: 5 * 60_000
  })
  const clean = useMutation({
    mutationFn: (userId: string | null) =>
      client.request<{
        data: { group_members_removed: number; instance_owners_removed: number; users: string[] }
      }>(post(`/pipelines/${templateId}/owner-cleanup`, userId ? { user_id: userId } : {})),
    onSuccess: (r) => {
      const d = r.data
      toast.success(
        `Removed ${d.group_members_removed} seat(s) and ${d.instance_owners_removed} record owner(s)`
      )
      void qc.invalidateQueries({ queryKey: ['owner-gaps', templateId] })
      void qc.invalidateQueries({ queryKey: ['owner-lint', templateId] })
      void qc.invalidateQueries({ queryKey: ['owner-groups', templateId] })
      void qc.invalidateQueries({ queryKey: ['pipeline-all-owner-groups', templateId] })
    },
    onError: () => toast.error('Cleanup failed')
  })

  const clusters = data?.clusters ?? []
  const dead = data?.dead_seats
  const hygiene = (lint?.findings ?? []).filter((f) => f.type !== 'inactive_member')
  const totalUnowned = clusters.reduce((sum, g) => sum + g.count, 0)
  const stateMeta = new Map(
    states.map((st) => [st.key, { label: st.label, color: st.color ?? null }])
  )

  // Group clusters per state, biggest states first — scanning by stage is how
  // an operator thinks ("who is missing at Manager Approval?").
  const byState = new Map<string, OwnerGapCluster[]>()
  for (const g of clusters) {
    const k = g.state_key ?? '(unknown state)'
    byState.set(k, [...(byState.get(k) ?? []), g])
  }
  const stateGroups = [...byState.entries()].sort(
    (a, b) =>
      b[1].reduce((s, g) => s + g.count, 0) - a[1].reduce((s, g) => s + g.count, 0)
  )

  const dimChip = (k: string, v: string) => (
    <span
      key={k}
      className='inline-flex items-baseline gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[10.5px] dark:border-border dark:bg-muted/40'
    >
      <span className='text-slate-400'>{dimLabel(k)}</span>
      <span className='font-medium text-slate-700 dark:text-foreground'>{v}</span>
    </span>
  )

  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex items-start justify-between gap-4'>
        <div>
          <h3 className='text-[14px] font-semibold text-slate-800 dark:text-foreground'>
            Owner coverage
          </h3>
          <p className='mt-0.5 max-w-[68ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
            Who actually covers this pipeline — open records resolving nobody, seats held by
            people who can no longer act, and hygiene problems in the matrix itself. Every finding
            is fixable in place.
          </p>
        </div>
        <Button
          size='sm'
          variant='outline'
          className='h-8 shrink-0 text-[12.5px]'
          disabled={isFetching}
          onClick={() => {
            if (!open) setOpen(true)
            else void refetch()
          }}
        >
          {isFetching ? 'Analyzing…' : open ? 'Re-analyze' : 'Analyze'}
        </Button>
      </div>

      {open && !isFetching && data && (
        <div className='mt-4 space-y-4'>
          {/* Verdict line — a sentence, not a stat wall. */}
          {totalUnowned === 0 && (dead?.group_seats ?? 0) === 0 && hygiene.length === 0 ? (
            <p className='flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-600 dark:text-emerald-400'>
              <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />
              Full coverage — every open record resolves an owner, and every seat is held by an
              active person.
            </p>
          ) : (
            <div className='flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px]'>
              {totalUnowned > 0 && (
                <span className='flex items-center gap-1.5 text-slate-700 dark:text-foreground'>
                  <span className='h-1.5 w-1.5 rounded-full bg-amber-500' />
                  <span className='font-semibold tabular-nums'>{totalUnowned}</span> unowned record
                  {totalUnowned === 1 ? '' : 's'} across{' '}
                  <span className='font-semibold tabular-nums'>{clusters.length}</span> combination
                  {clusters.length === 1 ? '' : 's'}
                </span>
              )}
              {(dead?.group_seats ?? 0) > 0 && (
                <span className='flex items-center gap-1.5 text-slate-700 dark:text-foreground'>
                  <span className='h-1.5 w-1.5 rounded-full bg-violet-500' />
                  <span className='font-semibold tabular-nums'>{dead?.group_seats}</span> dead seat
                  {dead?.group_seats === 1 ? '' : 's'}
                </span>
              )}
              {hygiene.length > 0 && (
                <span className='flex items-center gap-1.5 text-slate-700 dark:text-foreground'>
                  <span className='h-1.5 w-1.5 rounded-full bg-slate-400' />
                  <span className='font-semibold tabular-nums'>{hygiene.length}</span> hygiene issue
                  {hygiene.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          )}

          {/* Dead seats — remove one person, or everyone, right here. */}
          {dead && dead.group_seats > 0 && (
            <div className='overflow-hidden rounded-md border border-slate-200 dark:border-border'>
              <div className='flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 dark:border-border/60 dark:bg-muted/30'>
                <span className='h-2 w-2 shrink-0 rounded-full bg-violet-500' />
                <span className='text-[12px] font-semibold text-slate-700 dark:text-foreground'>
                  Dead seats
                </span>
                <span className='text-[11px] text-slate-400'>
                  suspended or redacted people still holding owner seats
                </span>
                {confirmClean ? (
                  <span className='ml-auto flex items-center gap-1.5'>
                    <span className='text-[11.5px] text-slate-600 dark:text-slate-300'>
                      Remove all of them from every group and open record?
                    </span>
                    <Button
                      size='sm'
                      className='h-6 bg-violet-600 px-2 text-[11px] text-white hover:bg-violet-700'
                      disabled={clean.isPending}
                      onClick={() => {
                        clean.mutate(null)
                        setConfirmClean(false)
                      }}
                    >
                      Remove all
                    </Button>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-6 px-2 text-[11px]'
                      onClick={() => setConfirmClean(false)}
                    >
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button
                    size='sm'
                    variant='outline'
                    className='ml-auto h-6 px-2 text-[11px]'
                    disabled={clean.isPending}
                    onClick={() => setConfirmClean(true)}
                  >
                    {clean.isPending ? 'Removing…' : 'Remove all…'}
                  </Button>
                )}
              </div>
              <div className='px-3 py-2'>
                <div className='flex flex-wrap gap-1'>
                  {dead.users.slice(0, 12).map((u) => (
                    <span
                      key={u.name}
                      className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-px text-[11px] text-slate-700 dark:border-border dark:bg-transparent dark:text-slate-300'
                    >
                      {u.name}
                      <span className='tabular-nums text-slate-400'>×{u.seats}</span>
                      {u.id && (
                        <button
                          type='button'
                          aria-label={`Remove ${u.name}'s seats`}
                          data-tip={`Remove ${u.name} from every group and open record`}
                          className='text-slate-400 transition-colors hover:text-red-600 dark:hover:text-red-400'
                          disabled={clean.isPending}
                          onClick={() => clean.mutate(u.id)}
                        >
                          <X className='h-3 w-3' />
                        </button>
                      )}
                    </span>
                  ))}
                  {dead.users.length > 12 && (
                    <span className='self-center text-[11px] text-slate-400'>
                      +{dead.users.length - 12} more
                    </span>
                  )}
                </div>
                {dead.instance_seats > 0 && (
                  <p className='mt-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    {dead.instance_seats} open record{dead.instance_seats === 1 ? '' : 's'} also
                    list{dead.instance_seats === 1 ? 's' : ''} one as a manually-added owner —
                    removal covers those too.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Unowned records, grouped by stage — assign people in place. */}
          {stateGroups.map(([stateKey, groupClusters]) => {
            const meta = stateMeta.get(stateKey)
            const stateTotal = groupClusters.reduce((s, g) => s + g.count, 0)
            return (
              <div
                key={stateKey}
                className='overflow-hidden rounded-md border border-slate-200 dark:border-border'
              >
                <div className='flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 dark:border-border/60 dark:bg-muted/30'>
                  <span
                    className='h-2 w-2 shrink-0 rounded-full'
                    style={{ backgroundColor: meta?.color ?? '#94a3b8' }}
                  />
                  <span className='text-[12px] font-semibold text-slate-700 dark:text-foreground'>
                    {meta?.label ?? titleCaseLabel(stateKey)}
                  </span>
                  <span className='ml-auto text-[11px] tabular-nums text-slate-400'>
                    {stateTotal} record{stateTotal === 1 ? '' : 's'} · {groupClusters.length}{' '}
                    combination{groupClusters.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className='divide-y divide-slate-100 dark:divide-border/60'>
                  {groupClusters.map((g, i) => {
                    const clusterKey = `${g.state_id}|${JSON.stringify(g.dims)}`
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: server-ordered clusters
                      <div key={i} className='px-3 py-2'>
                        <div className='flex flex-wrap items-center gap-1.5'>
                          <span className='w-8 shrink-0 text-[13px] font-semibold tabular-nums text-slate-800 dark:text-foreground'>
                            {g.count}
                          </span>
                          {Object.entries(g.dims).filter(([, v]) => v).length > 0 ? (
                            Object.entries(g.dims)
                              .filter(([, v]) => v)
                              .map(([k, v]) => dimChip(k, v))
                          ) : (
                            <span className='text-[11px] italic text-slate-400'>
                              no dimension values resolved
                            </span>
                          )}
                          <span
                            className='ml-auto max-w-[180px] truncate text-[10.5px] text-slate-400'
                            data-tip={g.sample_items.join(', ')}
                          >
                            e.g. {g.sample_items.slice(0, 3).join(', ')}
                          </span>
                          <Button
                            size='sm'
                            variant='outline'
                            className='h-6 shrink-0 px-2 text-[11px]'
                            onClick={() =>
                              setAssigningCluster(
                                assigningCluster === clusterKey ? null : clusterKey
                              )
                            }
                          >
                            Assign owners…
                          </Button>
                        </div>
                        <p className='mt-1 pl-8 text-[11.5px] leading-relaxed'>
                          {g.suggestion ? (
                            <>
                              <span className='text-slate-500 dark:text-muted-foreground'>
                                Closest group{' '}
                              </span>
                              <span className='font-medium text-slate-700 dark:text-foreground'>
                                {g.suggestion.group_label}
                              </span>
                              <span className='text-slate-500 dark:text-muted-foreground'>
                                {' '}
                                already matches{' '}
                                {humanizeFieldList(g.suggestion.matched_filters.join(', ')) ||
                                  'nothing'}
                              </span>
                              {g.suggestion.mismatched_filters.length > 0 && (
                                <span className='text-amber-700 dark:text-amber-400'>
                                  {' '}
                                  — it misses{' '}
                                  {humanizeFieldList(g.suggestion.mismatched_filters.join(', '))},
                                  so assigning creates a group for this combination
                                </span>
                              )}
                            </>
                          ) : (
                            <span className='inline-flex items-center gap-1 text-amber-700 dark:text-amber-400'>
                              <span className='rounded bg-amber-100 px-1 py-px text-[9.5px] font-semibold uppercase dark:bg-amber-500/15'>
                                no match
                              </span>
                              No group comes close — assigning creates one for this combination.
                            </span>
                          )}
                        </p>
                        {assigningCluster === clusterKey && (
                          <ClusterAssignPanel
                            templateId={templateId}
                            cluster={g}
                            onDone={() => setAssigningCluster(null)}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {/* Matrix hygiene — configuration debt, each row with its fix. */}
          {hygiene.length > 0 && (
            <div className='overflow-hidden rounded-md border border-slate-200 dark:border-border'>
              <div className='flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 dark:border-border/60 dark:bg-muted/30'>
                <span className='h-2 w-2 shrink-0 rounded-full bg-slate-400' />
                <span className='text-[12px] font-semibold text-slate-700 dark:text-foreground'>
                  Matrix hygiene
                </span>
                {lint && (
                  <span className='ml-auto text-[11px] tabular-nums text-slate-400'>
                    {lint.groups_checked.toLocaleString()} group(s) checked · {hygiene.length}{' '}
                    finding{hygiene.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div className='max-h-96 divide-y divide-slate-100 overflow-y-auto px-3 dark:divide-border/60'>
                {hygiene.map((f, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: findings are positional
                  <HygieneRow key={i} templateId={templateId} finding={f} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
function titleCaseLabel(v: string): string {
  return v.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** 'divisions.short_name' → 'Division', 'project.project_type.name' →
 *  'Project Type' — drop the trailing display column, name the entity. */
function dimLabel(path: string): string {
  const segs = path.split('.')
  while (
    segs.length > 1 &&
    /^((short_)?name|label|key|id|.*_id)$/i.test(segs[segs.length - 1])
  ) {
    segs.pop()
  }
  const leaf = segs[segs.length - 1].replace(/s$/i, '')
  return titleCaseLabel(leaf)
}

/** Humanize dotted field tokens inside server suggestion strings
 *  ('regions.short_name (wants 10)' → 'Region (wants 10)'). */
function humanizeFieldList(v: string): string {
  return v.replace(/[a-z_]+(?:\.[a-z_]+)+/g, (m) => dimLabel(m))
}

function InstanceMigrationCard({ templateId }: { templateId: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [fromState, setFromState] = useState('')
  const [toState, setToState] = useState('')
  const [confirming, setConfirming] = useState(false)

  const { data } = useQuery({
    queryKey: ['instance-distribution', templateId],
    queryFn: () =>
      client
        .request<{
          data: Array<{
            state_id: string | null
            collection: string
            count: number
            key: string | null
            label: string | null
            color: string | null
            orphaned: boolean
          }>
          states: Array<{ id: string; key: string; label: string }>
        }>(get(`/pipelines/${templateId}/instance-distribution`)),
    staleTime: 30_000
  })
  const rows = data?.data ?? []
  const states = data?.states ?? []
  const orphans = rows.filter((r) => r.orphaned)
  const fromCount = rows
    .filter((r) => String(r.state_id) === fromState)
    .reduce((sum, r) => sum + r.count, 0)

  const { data: bindingsForStart } = useQuery<{ data: Array<{ collection: string }> }>({
    queryKey: ['pipeline-bindings-start', templateId],
    queryFn: () => client.request<{ data: Array<{ collection: string }> }>(
      get(`/pipelines/${templateId}/bindings`)
    )
  })
  const boundCollections = (bindingsForStart?.data ?? []).map((b) => b.collection)
  const startMissing = useMutation({
    mutationFn: (collection: string) =>
      client.request<{ data: { started: number } }>(
        post(`/pipelines/${templateId}/start-missing`, { collection })
      ),
    onSuccess: (r) => {
      toast.success(`${r.data.started} instance(s) started`)
      void qc.invalidateQueries({ queryKey: ['instance-distribution', templateId] })
    },
    onError: (e: { response?: { error?: string } }) =>
      toast.error(e.response?.error ?? 'Start failed')
  })

  const migrate = useMutation({
    mutationFn: () =>
      client.request<{ data: { migrated: number } }>(
        post(`/pipelines/${templateId}/migrate-instances`, {
          from_state: fromState,
          to_state: toState
        })
      ),
    onSuccess: (r) => {
      toast.success(`${r.data.migrated} instance(s) migrated`)
      setConfirming(false)
      setFromState('')
      setToState('')
      void qc.invalidateQueries({ queryKey: ['instance-distribution', templateId] })
    },
    onError: (e: { response?: { error?: string } }) =>
      toast.error(e.response?.error ?? 'Migration failed')
  })

  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <h3 className='text-[14px] font-semibold text-slate-800 dark:text-foreground'>
        Instance migration
      </h3>
      <p className='mt-0.5 max-w-[72ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
        Where live records sit right now — including states a redesign removed (orphans, in red).
        Move a state's instances to a current state; every record gets a history entry saying so.
      </p>
      {orphans.length > 0 && (
        <p className='mt-2 rounded-md bg-red-500/10 px-3 py-1.5 text-[12px] font-medium text-red-700 dark:text-red-400'>
          {orphans.reduce((sum, o) => sum + o.count, 0)} instance(s) sit in{' '}
          {new Set(orphans.map((o) => o.state_id)).size} orphaned state(s) — they can't transition
          until migrated.
        </p>
      )}
      {/* Start missing instances (#108): records created before the binding. */}
      <div className='mt-2 flex flex-wrap items-center gap-2'>
        {boundCollections.map((c) => (
          <button
            key={c}
            type='button'
            disabled={startMissing.isPending}
            onClick={() => startMissing.mutate(c)}
            className='rounded-md border border-dashed border-slate-300 px-2.5 py-1 text-[11.5px] text-slate-500 hover:bg-slate-50 disabled:opacity-50 dark:border-border'
            data-tip='Records created before this binding have no instance and cannot transition — start them in the initial state'
          >
            {startMissing.isPending ? 'Starting…' : `Start missing instances (${c})`}
          </button>
        ))}
      </div>
      <div className='mt-3 flex flex-wrap gap-1.5'>
        {rows.map((r) => (
          <button
            key={`${r.state_id}-${r.collection}`}
            type='button'
            onClick={() => setFromState(String(r.state_id))}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-[11.5px]',
              fromState === String(r.state_id)
                ? 'border-nvr-cyan/60 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                : r.orphaned
                  ? 'border-red-300 text-red-700 dark:border-red-500/40 dark:text-red-400'
                  : 'border-slate-200 text-slate-500 dark:border-border dark:text-muted-foreground'
            )}
          >
            {r.label ?? `orphan ${String(r.state_id).slice(0, 8)}…`}
            <span className='ml-1 font-medium'>{r.count}</span>
            <span className='ml-1 text-[10px] text-slate-400'>{r.collection}</span>
          </button>
        ))}
        {rows.length === 0 && <p className='text-[12px] text-slate-400'>No open instances.</p>}
      </div>
      {fromState && (
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <span className='text-[12.5px] text-slate-600 dark:text-muted-foreground'>
            Move {fromCount} instance(s) to
          </span>
          <Select value={toState || undefined} onValueChange={setToState}>
            <SelectTrigger className='h-8 w-[220px] text-[12.5px]'>
              <SelectValue placeholder='Pick a state…' />
            </SelectTrigger>
            <SelectContent>
              {states
                .filter((st) => String(st.id) !== fromState)
                .map((st) => (
                  <SelectItem key={st.id} value={st.id}>
                    {st.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {toState && !confirming && (
            <Button size='sm' className='h-8 text-[12.5px]' onClick={() => setConfirming(true)}>
              Migrate…
            </Button>
          )}
          {toState && confirming && (
            <span className='flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 dark:border-amber-500/40 dark:bg-amber-400/10'>
              <span className='text-[12px] text-amber-800 dark:text-amber-300'>
                {fromCount} record(s) will move, each with a history entry. Sure?
              </span>
              <Button
                size='sm'
                className='h-6 text-[11.5px]'
                disabled={migrate.isPending}
                onClick={() => migrate.mutate()}
              >
                {migrate.isPending ? 'Migrating…' : 'Yes, migrate'}
              </Button>
              <button
                type='button'
                className='text-[11.5px] text-slate-500 underline'
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Visual canvas — an ADDITIONAL way to see and navigate the state machine
 * (the list editor stays the editing surface). States lay out in BFS ranks
 * from the initial state, transitions draw as edges (auto ⚡ and conditional
 * ◆ badged); drag nodes to taste (positions persist per browser), click
 * anything to inspect it and jump to its list-editor entry.
 */
function PipelineCanvasCard({ templateId }: { templateId: string }) {
  const client = useNivaroClient()
  const [selected, setSelected] = useState<{ kind: 'state' | 'transition'; id: string } | null>(null)
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(() => {
    try {
      return JSON.parse(localStorage.getItem(`nvr_canvas_${templateId}`) ?? '{}')
    } catch {
      return {}
    }
  })
  const dragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null)

  const { data } = useQuery({
    queryKey: ['pipeline-canvas', templateId],
    queryFn: () =>
      client
        .request<{
          data: {
            states: Array<{ id: string; key: string; label: string; color: string | null; is_initial: boolean; is_terminal: boolean; sort: number }>
            transitions: Array<{ id: string; label: string; from_state: string | null; to_state: string; auto_trigger?: boolean; condition_rules?: unknown; group_label?: string | null }>
          }
        }>(get(`/pipelines/${templateId}`))
        .then((r) => r.data),
    staleTime: 30_000
  })
  const states = data?.states ?? []
  const transitions = data?.transitions ?? []

  // BFS ranks from initial states along explicit forward edges; unreachable
  // states append as trailing ranks. Sort within a rank keeps it stable.
  const layout = useMemo(() => {
    const byId = new Map(states.map((st) => [String(st.id).toUpperCase(), st]))
    const rank = new Map<string, number>()
    const queue: Array<{ id: string; r: number }> = states
      .filter((st) => st.is_initial)
      .map((st) => ({ id: String(st.id).toUpperCase(), r: 0 }))
    const fwd = new Map<string, string[]>()
    for (const t of transitions) {
      if (!t.from_state) continue
      const from = String(t.from_state).toUpperCase()
      fwd.set(from, [...(fwd.get(from) ?? []), String(t.to_state).toUpperCase()])
    }
    while (queue.length > 0) {
      const { id: sid, r } = queue.shift()!
      if (rank.has(sid) && rank.get(sid)! <= r) continue
      if (!rank.has(sid)) rank.set(sid, r)
      for (const next of fwd.get(sid) ?? []) {
        const target = byId.get(next)
        // Backward (send-back) edges must not drag ranks around in circles.
        if (!rank.has(next) && (byId.get(sid)?.sort ?? 0) <= (target?.sort ?? 0)) {
          queue.push({ id: next, r: r + 1 })
        }
      }
    }
    let maxRank = Math.max(0, ...rank.values())
    for (const st of states) {
      const sid = String(st.id).toUpperCase()
      if (!rank.has(sid)) rank.set(sid, ++maxRank)
    }
    const byRank = new Map<number, string[]>()
    for (const st of [...states].sort((a, z) => a.sort - z.sort)) {
      const sid = String(st.id).toUpperCase()
      const r = rank.get(sid) ?? 0
      byRank.set(r, [...(byRank.get(r) ?? []), sid])
    }
    const NODE_W = 168
    const NODE_H = 44
    const GAP_X = 70
    const GAP_Y = 18
    const pos = new Map<string, { x: number; y: number }>()
    let maxRows = 1
    for (const [r, ids] of byRank) {
      maxRows = Math.max(maxRows, ids.length)
      ids.forEach((sid, row) => {
        pos.set(sid, { x: 20 + r * (NODE_W + GAP_X), y: 20 + row * (NODE_H + GAP_Y) })
      })
    }
    const width = 60 + (Math.max(0, ...byRank.keys()) + 1) * (NODE_W + GAP_X)
    const height = 60 + maxRows * (NODE_H + GAP_Y)
    return { pos, width, height, NODE_W, NODE_H }
  }, [states, transitions])

  const posOf = (sid: string) => positions[sid] ?? layout.pos.get(sid) ?? { x: 20, y: 20 }

  // Canvas edit mode (#135): hold Shift and drag from one state to another to
  // CREATE a transition (additive — the list editor stays authoritative).
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  const [linkPos, setLinkPos] = useState<{ x: number; y: number } | null>(null)
  const qcCanvas = useQueryClient()
  const createTransition = useMutation({
    mutationFn: (v: { from: string; to: string }) =>
      client.request(post(`/pipelines/${templateId}/transitions`, {
        from_state: v.from,
        to_state: v.to,
        label: 'New transition'
      })),
    onSuccess: () => {
      toast.success('Transition created — configure it in the Transitions list')
      void qcCanvas.invalidateQueries({ queryKey: ['pipeline-canvas', templateId] })
      void qcCanvas.invalidateQueries({ queryKey: ['pipeline', templateId] })
    },
    onError: (e: { response?: { error?: string } }) =>
      toast.error(e.response?.error ?? 'Create failed')
  })

  const onNodePointerDown = (sid: string, e: React.PointerEvent) => {
    if (e.shiftKey) {
      setLinkFrom(sid)
      return
    }
    const p = posOf(sid)
    dragRef.current = { id: sid, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (linkFrom) {
      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
      setLinkPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      return
    }
    const d = dragRef.current
    if (!d) return
    setPositions((prev) => ({
      ...prev,
      [d.id]: { x: Math.max(0, d.origX + e.clientX - d.startX), y: Math.max(0, d.origY + e.clientY - d.startY) }
    }))
  }
  const onPointerUp = () => {
    if (linkFrom) {
      // Node under the pointer at release?
      if (linkPos) {
        const hit = states.find((st) => {
          const sid = String(st.id).toUpperCase()
          const p = posOf(sid)
          return (
            linkPos.x >= p.x &&
            linkPos.x <= p.x + layout.NODE_W &&
            linkPos.y >= p.y &&
            linkPos.y <= p.y + layout.NODE_H &&
            sid !== linkFrom
          )
        })
        if (hit) createTransition.mutate({ from: linkFrom, to: String(hit.id) })
      }
      setLinkFrom(null)
      setLinkPos(null)
      return
    }
    if (dragRef.current) {
      dragRef.current = null
      setPositions((prev) => {
        localStorage.setItem(`nvr_canvas_${templateId}`, JSON.stringify(prev))
        return prev
      })
    }
  }

  const selState = selected?.kind === 'state' ? states.find((st) => String(st.id) === selected.id) : null
  const selTransition =
    selected?.kind === 'transition' ? transitions.find((t) => String(t.id) === selected.id) : null

  const jumpTo = (elementText: string) => {
    // Best-effort: scroll the list editor's matching entry into view.
    const nodes = Array.from(document.querySelectorAll('h3, p, span, button'))
    const hit = nodes.find((n) => n.textContent?.trim() === elementText)
    hit?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <h3 className='text-[14px] font-semibold text-slate-800 dark:text-foreground'>Canvas</h3>
      <p className='mt-0.5 max-w-[72ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
        The state machine as a graph — another way to see it (editing stays in the lists above).
        Drag states to arrange; click a state or an edge to inspect it. Shift-drag between two
        states to CREATE a transition. ⚡ automatic · ◆ conditional.
      </p>
      <div className='mt-3 overflow-x-auto rounded-md border border-slate-100 bg-slate-50/50 dark:border-border dark:bg-muted/20'>
        <svg
          width={Math.max(layout.width, 600)}
          height={Math.max(layout.height, 200)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role='img'
          aria-label='Workflow state machine'
        >
          <defs>
            <marker id='cv-arrow' markerWidth='7' markerHeight='7' refX='6' refY='3.5' orient='auto'>
              <path d='M0,0 L7,3.5 L0,7 z' className='fill-slate-400' />
            </marker>
          </defs>
          {transitions.map((t) => {
            if (!t.from_state) return null
            const from = posOf(String(t.from_state).toUpperCase())
            const to = posOf(String(t.to_state).toUpperCase())
            const x1 = from.x + layout.NODE_W
            const y1 = from.y + layout.NODE_H / 2
            const x2 = to.x
            const y2 = to.y + layout.NODE_H / 2
            const back = x2 < x1
            const midX = back ? Math.max(x1, x2 + layout.NODE_W) + 40 : (x1 + x2) / 2
            const path = back
              ? `M ${x1} ${y1} C ${x1 + 60} ${y1 - 40}, ${x2 - 60} ${y2 - 40}, ${x2} ${y2}`
              : `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
            const isSel = selected?.kind === 'transition' && selected.id === String(t.id)
            const hasCond = Array.isArray(t.condition_rules)
              ? t.condition_rules.length > 0
              : !!t.condition_rules
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: canvas edge, inspect-only
              <g key={t.id} onClick={() => setSelected({ kind: 'transition', id: String(t.id) })} className='cursor-pointer'>
                <path d={path} fill='none' strokeWidth={10} className='stroke-transparent' />
                <path
                  d={path}
                  fill='none'
                  strokeWidth={isSel ? 2.5 : 1.5}
                  markerEnd='url(#cv-arrow)'
                  className={
                    isSel
                      ? 'stroke-nvr-cyan'
                      : back
                        ? 'stroke-amber-400'
                        : 'stroke-slate-300 dark:stroke-slate-600'
                  }
                  strokeDasharray={t.auto_trigger ? '5 3' : undefined}
                />
                {(t.auto_trigger || hasCond) && (
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 - 6}
                    textAnchor='middle'
                    className='fill-slate-500 text-[11px]'
                  >
                    {t.auto_trigger ? '⚡' : ''}
                    {hasCond ? '◆' : ''}
                  </text>
                )}
              </g>
            )
          })}
          {linkFrom && linkPos && (
            <line
              x1={posOf(linkFrom).x + layout.NODE_W / 2}
              y1={posOf(linkFrom).y + layout.NODE_H / 2}
              x2={linkPos.x}
              y2={linkPos.y}
              stroke='#00ceff'
              strokeWidth={2}
              strokeDasharray='5 4'
            />
          )}
          {states.map((st) => {
            const sid = String(st.id).toUpperCase()
            const p = posOf(sid)
            const isSel = selected?.kind === 'state' && selected.id === String(st.id)
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: draggable canvas node
              <g
                key={st.id}
                transform={`translate(${p.x}, ${p.y})`}
                onPointerDown={(e) => onNodePointerDown(sid, e)}
                onClick={() => setSelected({ kind: 'state', id: String(st.id) })}
                className='cursor-grab'
              >
                <rect
                  width={layout.NODE_W}
                  height={layout.NODE_H}
                  rx={8}
                  strokeWidth={isSel ? 2 : 1}
                  className={
                    isSel
                      ? 'fill-white stroke-nvr-cyan dark:fill-card'
                      : 'fill-white stroke-slate-300 dark:fill-card dark:stroke-slate-600'
                  }
                />
                <circle cx={14} cy={layout.NODE_H / 2} r={4} fill={st.color ?? '#94a3b8'} />
                <text x={26} y={layout.NODE_H / 2 + 4} className='fill-slate-700 text-[12px] font-medium dark:fill-slate-200'>
                  {st.label.length > 20 ? `${st.label.slice(0, 19)}…` : st.label}
                </text>
                {st.is_initial && (
                  <text x={layout.NODE_W - 8} y={13} textAnchor='end' className='fill-emerald-500 text-[9px] font-semibold'>
                    START
                  </text>
                )}
                {st.is_terminal && (
                  <text x={layout.NODE_W - 8} y={13} textAnchor='end' className='fill-slate-400 text-[9px] font-semibold'>
                    END
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      {(selState || selTransition) && (
        <div className='mt-2 flex flex-wrap items-center gap-3 rounded-md border border-slate-100 px-3 py-2 text-[12.5px] dark:border-border'>
          {selState && (
            <>
              <span className='font-medium text-slate-800 dark:text-foreground'>{selState.label}</span>
              <span className='text-slate-400'>key: {selState.key}</span>
              <span className='text-slate-400'>
                {transitions.filter((t) => String(t.from_state) === String(selState.id)).length} out ·{' '}
                {transitions.filter((t) => String(t.to_state) === String(selState.id)).length} in
              </span>
              <button
                type='button'
                onClick={() => jumpTo(selState.label)}
                className='text-nvr-cyan underline decoration-dotted underline-offset-2'
              >
                Edit in the States list ↑
              </button>
            </>
          )}
          {selTransition && (
            <>
              <span className='font-medium text-slate-800 dark:text-foreground'>{selTransition.label}</span>
              {selTransition.auto_trigger && <span className='text-amber-600'>⚡ automatic</span>}
              {selTransition.group_label && <span className='text-slate-400'>group: {selTransition.group_label}</span>}
              <button
                type='button'
                onClick={() => jumpTo(selTransition.label)}
                className='text-nvr-cyan underline decoration-dotted underline-offset-2'
              >
                Edit in the Transitions list ↑
              </button>
            </>
          )}
          <button type='button' onClick={() => setSelected(null)} className='ml-auto text-slate-300 hover:text-slate-500'>
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

function PipelineFlowMapCard({ templateId }: { templateId: string }) {
  const client = useNivaroClient()
  const [days, setDays] = useState(90)
  const [hover, setHover] = useState<Flow | null>(null)

  const { data } = useQuery({
    queryKey: ['flow-map', templateId, days],
    queryFn: () =>
      client
        .request<{ data: { states: FlowState[]; flows: Flow[] } }>(
          get(`/pipelines/${templateId}/flow-map`, { days })
        )
        .then((r) => r.data),
    staleTime: 60_000
  })

  const states = data?.states ?? []
  const flows = (data?.flows ?? []).slice(0, 40)
  const total = flows.reduce((s, f) => s + f.count, 0)

  // Bipartite layout: outflow column left, inflow column right.
  const outTotals = new Map<string, number>()
  const inTotals = new Map<string, number>()
  for (const f of flows) {
    outTotals.set(f.from, (outTotals.get(f.from) ?? 0) + f.count)
    inTotals.set(f.to, (inTotals.get(f.to) ?? 0) + f.count)
  }
  const H_AVAIL = Math.max(360, states.length * 46)
  const layout = (totals: Map<string, number>) => {
    const activeStates = states.filter((st) => (totals.get(st.id) ?? 0) > 0)
    const sum = [...totals.values()].reduce((a, b) => a + b, 0) || 1
    const gaps = (activeStates.length + 1) * 8
    let y = 20
    const out = new Map<string, { y: number; h: number }>()
    for (const st of activeStates) {
      const h = Math.max(14, ((totals.get(st.id) ?? 0) / sum) * (H_AVAIL - gaps - 40))
      out.set(st.id, { y, h })
      y += h + 8
    }
    return { pos: out, height: y + 20 }
  }
  const left = layout(outTotals)
  const right = layout(inTotals)
  const H_TOTAL = Math.max(left.height, right.height, 380)

  // Per-node running offsets so ribbons stack within their node
  const leftOffset = new Map<string, number>()
  const rightOffset = new Map<string, number>()
  const ribbons = flows.map((f) => {
    const lp = left.pos.get(f.from)
    const rp = right.pos.get(f.to)
    if (!lp || !rp) return null
    const share = f.count / Math.max(1, outTotals.get(f.from) ?? 1)
    const inShare = f.count / Math.max(1, inTotals.get(f.to) ?? 1)
    const lh = Math.max(1.5, lp.h * share)
    const rh = Math.max(1.5, rp.h * inShare)
    const ly = lp.y + (leftOffset.get(f.from) ?? 0)
    const ry = rp.y + (rightOffset.get(f.to) ?? 0)
    leftOffset.set(f.from, (leftOffset.get(f.from) ?? 0) + lh)
    rightOffset.set(f.to, (rightOffset.get(f.to) ?? 0) + rh)
    const x1 = FLOW_COL_W + 8
    const x2 = FLOW_W - FLOW_COL_W - 8
    const mx = (x1 + x2) / 2
    const path = `M ${x1} ${ly} C ${mx} ${ly}, ${mx} ${ry}, ${x2} ${ry} L ${x2} ${ry + rh} C ${mx} ${ry + rh}, ${mx} ${ly + lh}, ${x1} ${ly + lh} Z`
    return { f, path }
  })

  const stateById = new Map(states.map((st) => [st.id, st]))

  if (states.length === 0) return null

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-[13px] font-semibold text-slate-800'>Flow Map</h2>
          <p className='text-[12px] text-slate-400'>
            {total.toLocaleString()} transitions in the last {days} days — red ribbons are
            send-backs.
          </p>
        </div>
        <div className='flex items-center rounded-lg border border-slate-200 p-0.5'>
          {[30, 90, 365].map((d) => (
            <button
              key={d}
              type='button'
              onClick={() => setDays(d)}
              className={cn(
                'h-6 rounded-md px-2 text-[11px] font-medium',
                days === d ? 'bg-slate-900 text-white' : 'text-slate-400 hover:text-slate-700'
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${FLOW_W} ${H_TOTAL}`} className='w-full select-none'>
        <title>Transition flow map</title>
        {/* ribbons */}
        {ribbons.map((r, i) =>
          r ? (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: derived list
              key={i}
              d={r.path}
              fill={r.f.back ? '#ef4444' : '#00ceff'}
              opacity={hover === null ? (r.f.back ? 0.45 : 0.3) : hover === r.f ? 0.75 : 0.08}
              onMouseEnter={() => setHover(r.f)}
              onMouseLeave={() => setHover(null)}
            />
          ) : null
        )}
        {/* left nodes (outflow) */}
        {[...left.pos.entries()].map(([sid, p]) => (
          <g key={`L-${sid}`}>
            <rect
              x={0}
              y={p.y}
              width={FLOW_COL_W}
              height={p.h}
              rx={4}
              fill={stateById.get(sid)?.color ?? '#94a3b8'}
              opacity={0.15}
            />
            <rect
              x={FLOW_COL_W}
              y={p.y}
              width={6}
              height={p.h}
              rx={2}
              fill={stateById.get(sid)?.color ?? '#94a3b8'}
            />
            <text
              x={FLOW_COL_W - 8}
              y={p.y + p.h / 2 + 3}
              textAnchor='end'
              className='fill-slate-700 text-[10.5px] font-medium'
            >
              {(stateById.get(sid)?.label ?? '').slice(0, 32)}
            </text>
          </g>
        ))}
        {/* right nodes (inflow) */}
        {[...right.pos.entries()].map(([sid, p]) => (
          <g key={`R-${sid}`}>
            <rect
              x={FLOW_W - FLOW_COL_W}
              y={p.y}
              width={FLOW_COL_W}
              height={p.h}
              rx={4}
              fill={stateById.get(sid)?.color ?? '#94a3b8'}
              opacity={0.15}
            />
            <rect
              x={FLOW_W - FLOW_COL_W - 6}
              y={p.y}
              width={6}
              height={p.h}
              rx={2}
              fill={stateById.get(sid)?.color ?? '#94a3b8'}
            />
            <text
              x={FLOW_W - FLOW_COL_W + 8}
              y={p.y + p.h / 2 + 3}
              className='fill-slate-700 text-[10.5px] font-medium'
            >
              {(stateById.get(sid)?.label ?? '').slice(0, 32)}
            </text>
          </g>
        ))}
      </svg>
      {hover && (
        <p className='text-[12px] text-slate-600'>
          <strong>{stateById.get(hover.from)?.label}</strong> →{' '}
          <strong>{stateById.get(hover.to)?.label}</strong>: {hover.count.toLocaleString()}{' '}
          transition{hover.count !== 1 ? 's' : ''}
          {hover.back ? ' (send-back)' : ''}
        </p>
      )}
    </div>
  )
}

// ─── Time-lapse replay — watch the period happen ──────────────────────────────

interface ReplayState {
  id: string
  label: string
  color: string | null
  is_terminal: boolean
}

function PipelineReplayCard({ templateId }: { templateId: string }) {
  const client = useNivaroClient()
  const [days, setDays] = useState(90)
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [hideTerminal, setHideTerminal] = useState(true)

  const { data } = useQuery({
    queryKey: ['pipeline-replay', templateId, days],
    queryFn: () =>
      client
        .request<{
          data: {
            states: ReplayState[]
            days: Array<{ date: string; counts: Record<string, number> }>
          }
        }>(get(`/pipelines/${templateId}/replay`, { days }))
        .then((r) => r.data),
    staleTime: 5 * 60_000
  })

  const frames = data?.days ?? []
  const states = (data?.states ?? []).filter((st) => !hideTerminal || !st.is_terminal)

  useEffect(() => {
    setFrame(0)
    setPlaying(false)
  }, [])

  useEffect(() => {
    if (!playing || frames.length === 0) return
    const t = setInterval(() => {
      setFrame((f) => {
        if (f + 1 >= frames.length) {
          setPlaying(false)
          return f
        }
        return f + 1
      })
    }, 120)
    return () => clearInterval(t)
  }, [playing, frames.length])

  const current = frames[Math.min(frame, frames.length - 1)]
  const counts = current?.counts ?? {}
  const visibleTotal = states.reduce((sum, st) => sum + (counts[st.id] ?? 0), 0)
  const maxAcross = Math.max(
    1,
    ...frames.map((d) => states.reduce((sum, st) => sum + (d.counts[st.id] ?? 0), 0))
  )

  if (frames.length === 0) return null

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-[13px] font-semibold text-slate-800'>Time-lapse</h2>
          <p className='text-[12px] text-slate-400'>
            Replay the state distribution day by day — watch the period happen.
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <label className='flex items-center gap-1.5 text-[11px] text-slate-500'>
            <input
              type='checkbox'
              checked={hideTerminal}
              onChange={(e) => setHideTerminal(e.target.checked)}
            />
            Hide terminal states
          </label>
          <div className='flex items-center rounded-lg border border-slate-200 p-0.5'>
            {[30, 90, 365].map((d) => (
              <button
                key={d}
                type='button'
                onClick={() => {
                  setDays(d)
                  setFrame(0)
                  setPlaying(false)
                }}
                className={cn(
                  'h-6 rounded-md px-2 text-[11px] font-medium',
                  days === d ? 'bg-slate-900 text-white' : 'text-slate-400 hover:text-slate-700'
                )}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Big date + total */}
      <div className='flex items-baseline gap-4'>
        <p className='w-36 font-mono text-[20px] font-bold tabular-nums text-slate-900'>
          {current?.date}
        </p>
        <p className='text-[13px] text-slate-500'>
          <strong className='text-slate-800'>{visibleTotal.toLocaleString()}</strong> records in
          view
        </p>
      </div>

      {/* Stacked bar for the current frame */}
      <div className='flex h-10 w-full overflow-hidden rounded-lg border border-slate-100'>
        {states.map((st) => {
          const v = counts[st.id] ?? 0
          if (v === 0) return null
          return (
            <div
              key={st.id}
              className='h-full transition-all duration-150'
              style={{
                width: `${(v / Math.max(1, visibleTotal)) * 100}%`,
                background: st.color ?? '#94a3b8'
              }}
              title={`${st.label}: ${v.toLocaleString()}`}
            />
          )
        })}
      </div>

      {/* Per-state rows with animated widths (scale fixed across frames) */}
      <div className='space-y-1.5'>
        {states.map((st) => {
          const v = counts[st.id] ?? 0
          return (
            <div key={st.id} className='flex items-center gap-3'>
              <span className='w-56 truncate text-[11.5px] text-slate-600'>{st.label}</span>
              <div className='h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100'>
                <div
                  className='h-full rounded-full transition-all duration-150'
                  style={{
                    width: `${(v / maxAcross) * 100}%`,
                    background: st.color ?? '#94a3b8'
                  }}
                />
              </div>
              <span className='w-14 text-right font-mono text-[11px] tabular-nums text-slate-500'>
                {v.toLocaleString()}
              </span>
            </div>
          )
        })}
      </div>

      {/* Controls */}
      <div className='flex items-center gap-3'>
        <Button
          size='sm'
          variant='outline'
          onClick={() => {
            if (frame >= frames.length - 1) setFrame(0)
            setPlaying((p) => !p)
          }}
        >
          {playing ? 'Pause' : frame >= frames.length - 1 ? 'Replay' : 'Play'}
        </Button>
        <input
          type='range'
          min={0}
          max={frames.length - 1}
          value={frame}
          onChange={(e) => {
            setPlaying(false)
            setFrame(Number(e.target.value))
          }}
          className='flex-1 accent-[#00ceff]'
        />
        <span className='w-20 text-right text-[11px] text-slate-400'>
          day {frame + 1}/{frames.length}
        </span>
      </div>
    </div>
  )
}


/** Slide-over hosting the full Teams surface from the Owner Matrix header —
 *  create teams, edit rosters and scopes without leaving the pipeline. */
function TeamsSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
  // Portal to body — the admin page-enter animation's transform re-anchors
  // position:fixed, which strands an inline sheet inside the card.
  return createPortal(
    <div className='fixed inset-0 z-[120]'>
      <button
        type='button'
        aria-label='Close'
        className='absolute inset-0 bg-black/30'
        onClick={onClose}
      />
      <div className='absolute inset-y-0 right-0 flex w-full max-w-[860px] flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-border dark:bg-card'>
        <div className='flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-border'>
          <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>Teams</h2>
          <span className='text-[11.5px] text-slate-400'>
            roster and scope edits apply everywhere a team is used
          </span>
          <button
            type='button'
            aria-label='Close teams'
            onClick={onClose}
            className='ml-auto rounded p-1 text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-slate-200'
          >
            <X className='h-4 w-4' />
          </button>
        </div>
        <div className='min-h-0 flex-1'>
          <TeamsView compact />
        </div>
      </div>
    </div>,
    document.body
  )
}
