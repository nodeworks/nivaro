import type { ImportParseResponse } from '@nivaro/sdk'
import { ImportIssuesPanel } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  FileSpreadsheet,
  Plus,
  Trash2,
  Upload
} from 'lucide-react'
import { createContext, type ReactNode, useContext, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Config types (mirrors api/src/services/import-templates-config.ts) ───────

type ImportMode = 'prefill' | 'direct' | 'both'
type FileType = 'xlsx' | 'csv'
type OnMiss = 'leave_blank' | 'error' | 'create_stub'
type Take = 'id' | 'record'
type RowFilterOp = 'nnull' | 'eq' | 'neq'

interface ScopeFilter {
  field: string
  op: 'eq' | 'neq'
  value: string
}

type ImportStep =
  | { type: 'trim' }
  | { type: 'remap'; map: Record<string, string>; passthrough: boolean }
  | { type: 'expression'; template: string }
  | {
      type: 'lookup'
      collection: string
      match_field: string
      scope_filters: ScopeFilter[]
      on_miss: OnMiss
      take: Take
    }
  | { type: 'wrap_richtext' }
  | { type: 'const'; value: unknown }

interface ImportHeaderRule {
  target: string
  source: string | null
  steps: ImportStep[]
}

interface ImportDisperseConfig {
  map_collection: string
  map_key_column: string
  map_key_field: string
  map_values_path: string
  map_all_field: string | null
  member_match_column: string
  group_by_column: string
  amount_column: string
  nested_target: string
  split: 'even'
  member_columns: ImportHeaderRule[]
}

interface ImportLineConfig {
  target_field: string
  row_filter: { column: string; op: RowFilterOp; value?: string } | null
  columns: ImportHeaderRule[]
  apply_field_rules: boolean
  disperse: ImportDisperseConfig | null
}

interface ConfigErrorDetail {
  path: string
  message: string
}

interface TemplateRow {
  id: string
  name: string
  collection: string
  mode: ImportMode
  file_types: FileType[]
  sheet_match: string | null
  header_row: number
  header_map: ImportHeaderRule[]
  line_map: ImportLineConfig | null
  attach_file_field: string | null
  is_active: boolean
  is_shared: boolean
  role_id: string | null
}

interface TemplateDraft {
  id: string | null
  name: string
  mode: ImportMode
  file_types: FileType[]
  sheet_match: string
  header_row: number
  attach_file_field: string
  header_map: ImportHeaderRule[]
  line_map: ImportLineConfig | null
  is_active: boolean
  is_shared: boolean
  role_id: string
}

interface FieldConfigRow {
  field: string
  type: string | null
  label: string | null
  interface: string | null
}

interface RelationRow {
  id: number
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
}

type Option = { value: string; label: string }

const DEFAULT_LINE_CONFIG: ImportLineConfig = {
  target_field: '',
  row_filter: null,
  columns: [],
  apply_field_rules: true,
  disperse: null
}

const DEFAULT_DISPERSE: ImportDisperseConfig = {
  map_collection: '',
  map_key_column: '',
  map_key_field: '',
  map_values_path: '',
  map_all_field: null,
  member_match_column: '',
  group_by_column: '',
  amount_column: '',
  nested_target: '',
  split: 'even',
  member_columns: []
}

const STEP_TYPES: { value: ImportStep['type']; label: string }[] = [
  { value: 'trim', label: 'Trim whitespace' },
  { value: 'remap', label: 'Remap values' },
  { value: 'expression', label: 'Expression template' },
  { value: 'lookup', label: 'Lookup related record' },
  { value: 'wrap_richtext', label: 'Wrap as rich text' },
  { value: 'const', label: 'Constant value' }
]

function defaultStepFor(type: ImportStep['type']): ImportStep {
  switch (type) {
    case 'remap':
      return { type: 'remap', map: {}, passthrough: true }
    case 'expression':
      return { type: 'expression', template: '' }
    case 'lookup':
      return {
        type: 'lookup',
        collection: '',
        match_field: '',
        scope_filters: [],
        on_miss: 'leave_blank',
        take: 'id'
      }
    case 'const':
      return { type: 'const', value: '' }
    case 'wrap_richtext':
      return { type: 'wrap_richtext' }
    default:
      return { type: 'trim' }
  }
}

function stepLabel(type: ImportStep['type']): string {
  return STEP_TYPES.find((s) => s.value === type)?.label ?? type
}

function blankDraft(): TemplateDraft {
  return {
    id: null,
    name: '',
    mode: 'prefill',
    file_types: ['xlsx', 'csv'],
    sheet_match: '',
    header_row: 1,
    attach_file_field: '',
    header_map: [],
    line_map: null,
    is_active: true,
    is_shared: false,
    role_id: ''
  }
}

function rowToDraft(row: TemplateRow): TemplateDraft {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    file_types: row.file_types.length ? row.file_types : ['xlsx', 'csv'],
    sheet_match: row.sheet_match ?? '',
    header_row: row.header_row,
    attach_file_field: row.attach_file_field ?? '',
    header_map: row.header_map,
    line_map: row.line_map,
    is_active: row.is_active,
    is_shared: row.is_shared,
    role_id: row.role_id ?? ''
  }
}

function draftToBody(draft: TemplateDraft): Record<string, unknown> {
  return {
    name: draft.name,
    mode: draft.mode,
    file_types: draft.file_types,
    sheet_match: draft.sheet_match || null,
    header_row: draft.header_row,
    attach_file_field: draft.attach_file_field || null,
    header_map: draft.header_map,
    line_map: draft.line_map,
    is_active: draft.is_active,
    is_shared: draft.is_shared,
    role_id: draft.role_id || null
  }
}

function isPlainField(f: FieldConfigRow): boolean {
  return !f.field.includes('.') && !f.field.startsWith('__') && f.type !== 'alias'
}

function isFileField(f: FieldConfigRow): boolean {
  return !!f.interface && f.interface.includes('file')
}

function fieldLabel(f: FieldConfigRow): string {
  return f.label || f.field
}

function useFieldOptions(collection: string | null) {
  return useQuery({
    queryKey: ['field-config', collection],
    queryFn: () =>
      api.get<{ data: FieldConfigRow[] }>(`/field-config/${collection}`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })
}

function errorsUnder(errors: ConfigErrorDetail[], prefix: string): ConfigErrorDetail[] {
  return errors.filter(
    (e) => e.path === prefix || e.path.startsWith(`${prefix}.`) || e.path.startsWith(`${prefix}[`)
  )
}

const CollectionOptionsContext = createContext<Option[]>([])
function useCollectionOptions(): Option[] {
  return useContext(CollectionOptionsContext)
}

// ─── Small building blocks ──────────────────────────────────────────────────

function Combobox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  width = 220
}: {
  value: string
  onChange: (v: string) => void
  options: Option[]
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
          type='button'
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
          <CommandList>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={`${opt.value}-${opt.label}`}
                  onSelect={() => {
                    onChange(opt.value === value ? '' : opt.value)
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

function InlineErrors({ errors, ownPath }: { errors: ConfigErrorDetail[]; ownPath: string }) {
  if (errors.length === 0) return null
  return (
    <div className='mt-1.5 space-y-0.5 rounded border border-red-200 bg-red-50 px-2 py-1.5 dark:border-red-500/30 dark:bg-red-500/10'>
      {errors.map((e, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static error list, re-derived each save
        <p key={i} className='text-[11px] text-red-700 dark:text-red-300'>
          {e.path === ownPath ? e.message : `${e.path}: ${e.message}`}
        </p>
      ))}
    </div>
  )
}

function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='space-y-1'>
      <Label className='text-[11px] text-slate-500'>{label}</Label>
      {children}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <h3 className='mb-3 text-[12.5px] font-semibold text-slate-700 dark:text-slate-200'>
        {title}
      </h3>
      {children}
    </div>
  )
}

// ─── Step editors ───────────────────────────────────────────────────────────

function AddStepButton({ onAdd }: { onAdd: (t: ImportStep['type']) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type='button' variant='outline' size='sm' className='h-7 text-[11px]'>
          <Plus className='mr-1 h-3 w-3' /> Add step
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[220px] p-0' align='start'>
        <Command>
          <CommandList>
            <CommandGroup>
              {STEP_TYPES.map((s) => (
                <CommandItem
                  key={s.value}
                  value={s.value}
                  onSelect={() => {
                    onAdd(s.value)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  {s.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function RemapEditor({
  step,
  onChange
}: {
  step: Extract<ImportStep, { type: 'remap' }>
  onChange: (s: ImportStep) => void
}) {
  const entries = Object.entries(step.map)
  function setEntries(next: [string, string][]) {
    onChange({ ...step, map: Object.fromEntries(next) })
  }
  return (
    <div className='space-y-1.5'>
      {entries.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: unordered key/value pairs, no stable id
        <div key={i} className='flex items-center gap-1.5'>
          <Input
            value={k}
            onChange={(e) => {
              const next = entries.slice()
              next[i] = [e.target.value, v]
              setEntries(next)
            }}
            placeholder='source value'
            className='h-7 w-[130px] text-[12px]'
          />
          <span className='text-slate-300'>→</span>
          <Input
            value={v}
            onChange={(e) => {
              const next = entries.slice()
              next[i] = [k, e.target.value]
              setEntries(next)
            }}
            placeholder='mapped value'
            className='h-7 w-[130px] text-[12px]'
          />
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='h-6 w-6 text-red-400'
            onClick={() => setEntries(entries.filter((_, idx) => idx !== i))}
            aria-label='Remove pair'
          >
            <Trash2 className='h-3 w-3' />
          </Button>
        </div>
      ))}
      <div className='flex items-center justify-between'>
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='h-6 text-[11px]'
          onClick={() => setEntries([...entries, ['', '']])}
        >
          <Plus className='mr-1 h-3 w-3' /> Add pair
        </Button>
        <label className='flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-500'>
          <input
            type='checkbox'
            checked={step.passthrough}
            onChange={(e) => onChange({ ...step, passthrough: e.target.checked })}
            className='h-3.5 w-3.5 rounded accent-nvr-cyan'
          />
          Pass through unmapped values
        </label>
      </div>
    </div>
  )
}

function ExpressionEditor({
  step,
  onChange
}: {
  step: Extract<ImportStep, { type: 'expression' }>
  onChange: (s: ImportStep) => void
}) {
  return (
    <div className='space-y-1'>
      <Input
        value={step.template}
        onChange={(e) => onChange({ ...step, template: e.target.value })}
        placeholder='{{First Name}} {{Last Name}}'
        className='h-8 font-mono text-[12px]'
      />
      <p className='text-[10.5px] text-slate-400'>
        Use {'{{Column Header}}'} to reference source spreadsheet columns.
      </p>
    </div>
  )
}

function ConstEditor({
  step,
  onChange
}: {
  step: Extract<ImportStep, { type: 'const' }>
  onChange: (s: ImportStep) => void
}) {
  const strValue =
    typeof step.value === 'string'
      ? step.value
      : step.value == null
        ? ''
        : JSON.stringify(step.value)
  return (
    <Input
      value={strValue}
      onChange={(e) => onChange({ ...step, value: e.target.value })}
      placeholder='constant value'
      className='h-8 text-[12px]'
    />
  )
}

function LookupEditor({
  step,
  onChange,
  path
}: {
  step: Extract<ImportStep, { type: 'lookup' }>
  onChange: (s: ImportStep) => void
  path: string
}) {
  const collectionOptions = useCollectionOptions()
  const { data: lookupFields = [] } = useFieldOptions(step.collection || null)
  const matchFieldOptions = lookupFields
    .filter(isPlainField)
    .map((f) => ({ value: f.field, label: fieldLabel(f) }))

  function setFilters(next: ScopeFilter[]) {
    onChange({ ...step, scope_filters: next })
  }

  return (
    <div className='space-y-2'>
      <div className='flex flex-wrap gap-2'>
        <div className='w-[180px]'>
          <Combobox
            value={step.collection}
            onChange={(v) => onChange({ ...step, collection: v, match_field: '' })}
            options={collectionOptions}
            placeholder='collection…'
          />
        </div>
        <div className='w-[180px]'>
          <Combobox
            value={step.match_field}
            onChange={(v) => onChange({ ...step, match_field: v })}
            options={matchFieldOptions}
            placeholder='match field…'
            disabled={!step.collection}
          />
        </div>
      </div>
      <div className='space-y-1'>
        <p className='text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
          Scope filters
        </p>
        {step.scope_filters.map((f, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: unordered filter rows, no stable id
          <div key={i} className='flex flex-wrap items-center gap-1.5'>
            <div className='w-[140px]'>
              <Combobox
                value={f.field}
                onChange={(v) => {
                  const next = step.scope_filters.slice()
                  next[i] = { ...f, field: v }
                  setFilters(next)
                }}
                options={matchFieldOptions}
                placeholder='field…'
              />
            </div>
            <div className='w-[90px]'>
              <Combobox
                value={f.op}
                onChange={(v) => {
                  const next = step.scope_filters.slice()
                  next[i] = { ...f, op: v === 'neq' ? 'neq' : 'eq' }
                  setFilters(next)
                }}
                options={[
                  { value: 'eq', label: '=' },
                  { value: 'neq', label: '≠' }
                ]}
                placeholder='op'
                width={100}
              />
            </div>
            <Input
              value={f.value}
              onChange={(e) => {
                const next = step.scope_filters.slice()
                next[i] = { ...f, value: e.target.value }
                setFilters(next)
              }}
              placeholder='value'
              className='h-7 w-[140px] text-[12px]'
            />
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className='h-6 w-6 text-red-400'
              onClick={() => setFilters(step.scope_filters.filter((_, idx) => idx !== i))}
              aria-label='Remove filter'
            >
              <Trash2 className='h-3 w-3' />
            </Button>
          </div>
        ))}
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='h-6 text-[11px]'
          onClick={() => setFilters([...step.scope_filters, { field: '', op: 'eq', value: '' }])}
        >
          <Plus className='mr-1 h-3 w-3' /> Add filter
        </Button>
      </div>
      <div className='flex flex-wrap items-center gap-4 text-[11px]'>
        <div className='flex items-center gap-2'>
          <span className='text-slate-400'>On miss:</span>
          {(['leave_blank', 'error', 'create_stub'] as const).map((v) => (
            <label key={v} className='flex cursor-pointer items-center gap-1 text-slate-600'>
              <input
                type='radio'
                name={`onmiss-${path}`}
                checked={step.on_miss === v}
                onChange={() => onChange({ ...step, on_miss: v })}
              />
              {v.replace('_', ' ')}
            </label>
          ))}
        </div>
        <div className='flex items-center gap-2'>
          <span className='text-slate-400'>Take:</span>
          {(['id', 'record'] as const).map((v) => (
            <label key={v} className='flex cursor-pointer items-center gap-1 text-slate-600'>
              <input
                type='radio'
                name={`take-${path}`}
                checked={step.take === v}
                onChange={() => onChange({ ...step, take: v })}
              />
              {v}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

function StepEditor({
  step,
  path,
  errors,
  isFirst,
  isLast,
  onChange,
  onDelete,
  onMove
}: {
  step: ImportStep
  path: string
  errors: ConfigErrorDetail[]
  isFirst: boolean
  isLast: boolean
  onChange: (s: ImportStep) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
}) {
  return (
    <div className='rounded-md border border-slate-200 bg-slate-50 p-2.5 dark:border-border dark:bg-muted/20'>
      <div className='flex items-center justify-between gap-2'>
        <Badge variant='outline' className='text-[10px] font-normal'>
          {stepLabel(step.type)}
        </Badge>
        <div className='flex items-center gap-0.5'>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='h-6 w-6 text-slate-400'
            disabled={isFirst}
            onClick={() => onMove(-1)}
            aria-label='Move step up'
          >
            <ArrowUp className='h-3 w-3' />
          </Button>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='h-6 w-6 text-slate-400'
            disabled={isLast}
            onClick={() => onMove(1)}
            aria-label='Move step down'
          >
            <ArrowDown className='h-3 w-3' />
          </Button>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='h-6 w-6 text-red-400'
            onClick={onDelete}
            aria-label='Delete step'
          >
            <Trash2 className='h-3 w-3' />
          </Button>
        </div>
      </div>
      <div className='mt-2'>
        {step.type === 'trim' && (
          <p className='text-[11px] text-slate-400'>
            Trims leading/trailing whitespace from the value.
          </p>
        )}
        {step.type === 'wrap_richtext' && (
          <p className='text-[11px] text-slate-400'>Wraps the plain value as rich-text HTML.</p>
        )}
        {step.type === 'remap' && <RemapEditor step={step} onChange={onChange} />}
        {step.type === 'expression' && <ExpressionEditor step={step} onChange={onChange} />}
        {step.type === 'const' && <ConstEditor step={step} onChange={onChange} />}
        {step.type === 'lookup' && <LookupEditor step={step} onChange={onChange} path={path} />}
      </div>
      <InlineErrors errors={errorsUnder(errors, path)} ownPath={path} />
    </div>
  )
}

// ─── Rule editor (shared across header_map / line_map.columns / member_columns) ─

function RuleRow({
  rule,
  isFirst,
  isLast,
  fieldOptions,
  path,
  errors,
  onPatch,
  onDelete,
  onMove
}: {
  rule: ImportHeaderRule
  isFirst: boolean
  isLast: boolean
  fieldOptions: Option[] | null
  path: string
  errors: ConfigErrorDetail[]
  onPatch: (patch: Partial<ImportHeaderRule>) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
}) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='w-[200px]'>
          {fieldOptions ? (
            <Combobox
              value={rule.target}
              onChange={(v) => onPatch({ target: v })}
              options={fieldOptions}
              placeholder='target field…'
            />
          ) : (
            <Input
              value={rule.target}
              onChange={(e) => onPatch({ target: e.target.value })}
              placeholder='target key'
              className='h-8 text-[12px]'
            />
          )}
        </div>
        <Input
          value={rule.source ?? ''}
          onChange={(e) => onPatch({ source: e.target.value || null })}
          placeholder='source column'
          className='h-8 w-[200px] text-[12px]'
        />
        <div className='ml-auto flex shrink-0 items-center gap-0.5'>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='h-7 w-7 text-slate-400'
            disabled={isFirst}
            onClick={() => onMove(-1)}
            aria-label='Move rule up'
          >
            <ArrowUp className='h-3.5 w-3.5' />
          </Button>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='h-7 w-7 text-slate-400'
            disabled={isLast}
            onClick={() => onMove(1)}
            aria-label='Move rule down'
          >
            <ArrowDown className='h-3.5 w-3.5' />
          </Button>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='h-7 w-7 text-red-400'
            onClick={onDelete}
            aria-label='Delete rule'
          >
            <Trash2 className='h-3.5 w-3.5' />
          </Button>
        </div>
      </div>
      <InlineErrors errors={errorsUnder(errors, path)} ownPath={path} />
      <div className='mt-2.5 space-y-1.5'>
        {rule.steps.map((step, si) => (
          <StepEditor
            // biome-ignore lint/suspicious/noArrayIndexKey: reorderable step list, no stable id
            key={si}
            step={step}
            path={`${path}.steps[${si}]`}
            errors={errors}
            isFirst={si === 0}
            isLast={si === rule.steps.length - 1}
            onChange={(s) => onPatch({ steps: rule.steps.map((st, idx) => (idx === si ? s : st)) })}
            onDelete={() => onPatch({ steps: rule.steps.filter((_, idx) => idx !== si) })}
            onMove={(dir) => {
              const j = si + dir
              if (j < 0 || j >= rule.steps.length) return
              const next = rule.steps.slice()
              ;[next[si], next[j]] = [next[j], next[si]]
              onPatch({ steps: next })
            }}
          />
        ))}
        <AddStepButton onAdd={(t) => onPatch({ steps: [...rule.steps, defaultStepFor(t)] })} />
      </div>
    </div>
  )
}

function RuleEditor({
  rules,
  onChange,
  fieldOptions,
  basePath,
  errors
}: {
  rules: ImportHeaderRule[]
  onChange: (rules: ImportHeaderRule[]) => void
  fieldOptions: Option[] | null
  basePath: string
  errors: ConfigErrorDetail[]
}) {
  function addRule() {
    onChange([...rules, { target: '', source: '', steps: [] }])
  }
  function updateRule(i: number, patch: Partial<ImportHeaderRule>) {
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  function deleteRule(i: number) {
    onChange(rules.filter((_, idx) => idx !== i))
  }
  function moveRule(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= rules.length) return
    const next = rules.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div className='space-y-2'>
      {rules.length === 0 && <p className='text-[12px] text-slate-400'>No rules yet.</p>}
      {rules.map((rule, i) => (
        <RuleRow
          // biome-ignore lint/suspicious/noArrayIndexKey: reorderable rule list, no stable id
          key={i}
          rule={rule}
          isFirst={i === 0}
          isLast={i === rules.length - 1}
          fieldOptions={fieldOptions}
          path={`${basePath}[${i}]`}
          errors={errors}
          onPatch={(patch) => updateRule(i, patch)}
          onDelete={() => deleteRule(i)}
          onMove={(dir) => moveRule(i, dir)}
        />
      ))}
      <Button
        type='button'
        variant='outline'
        size='sm'
        className='h-7 text-[11px]'
        onClick={addRule}
      >
        <Plus className='mr-1 h-3 w-3' /> Add rule
      </Button>
    </div>
  )
}

// ─── Line config sub-sections ──────────────────────────────────────────────

function RowFilterEditor({
  value,
  onChange
}: {
  value: ImportLineConfig['row_filter']
  onChange: (v: ImportLineConfig['row_filter']) => void
}) {
  const enabled = value != null
  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-2.5'>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => onChange(v ? { column: '', op: 'nnull' } : null)}
        />
        <span className='text-[12px] text-slate-600'>Only import rows matching a condition</span>
      </div>
      {enabled && value && (
        <div className='flex flex-wrap items-center gap-2 pl-1'>
          <Input
            value={value.column}
            onChange={(e) => onChange({ ...value, column: e.target.value })}
            placeholder='source column'
            className='h-8 w-[200px] text-[12px]'
          />
          <div className='w-[150px]'>
            <Combobox
              value={value.op}
              onChange={(v) => onChange({ ...value, op: v as RowFilterOp })}
              options={[
                { value: 'nnull', label: 'is not empty' },
                { value: 'eq', label: 'equals' },
                { value: 'neq', label: 'not equals' }
              ]}
              width={170}
            />
          </div>
          {value.op !== 'nnull' && (
            <Input
              value={value.value ?? ''}
              onChange={(e) => onChange({ ...value, value: e.target.value })}
              placeholder='value'
              className='h-8 w-[160px] text-[12px]'
            />
          )}
        </div>
      )}
    </div>
  )
}

function DisperseFields({
  disperse,
  onChange
}: {
  disperse: ImportDisperseConfig
  onChange: (patch: Partial<ImportDisperseConfig>) => void
}) {
  const collectionOptions = useCollectionOptions()
  const { data: mapFields = [] } = useFieldOptions(disperse.map_collection || null)
  const mapFieldOptions = mapFields
    .filter(isPlainField)
    .map((f) => ({ value: f.field, label: fieldLabel(f) }))

  return (
    <div className='grid grid-cols-2 gap-3'>
      <LabeledField label='Map collection'>
        <Combobox
          value={disperse.map_collection}
          onChange={(v) => onChange({ map_collection: v, map_key_field: '' })}
          options={collectionOptions}
          placeholder='collection…'
        />
      </LabeledField>
      <LabeledField label='Map key field'>
        <Combobox
          value={disperse.map_key_field}
          onChange={(v) => onChange({ map_key_field: v })}
          options={mapFieldOptions}
          placeholder='field…'
          disabled={!disperse.map_collection}
        />
      </LabeledField>
      <LabeledField label='Map key column (source)'>
        <Input
          value={disperse.map_key_column}
          onChange={(e) => onChange({ map_key_column: e.target.value })}
          className='h-8 text-[12px]'
        />
      </LabeledField>
      <LabeledField label='Map values path'>
        <Input
          value={disperse.map_values_path}
          onChange={(e) => onChange({ map_values_path: e.target.value })}
          className='h-8 text-[12px]'
        />
      </LabeledField>
      <LabeledField label='Map "all" field (optional)'>
        <Input
          value={disperse.map_all_field ?? ''}
          onChange={(e) => onChange({ map_all_field: e.target.value || null })}
          className='h-8 text-[12px]'
        />
      </LabeledField>
      <LabeledField label='Member match column (source)'>
        <Input
          value={disperse.member_match_column}
          onChange={(e) => onChange({ member_match_column: e.target.value })}
          className='h-8 text-[12px]'
        />
      </LabeledField>
      <LabeledField label='Group by column (source)'>
        <Input
          value={disperse.group_by_column}
          onChange={(e) => onChange({ group_by_column: e.target.value })}
          className='h-8 text-[12px]'
        />
      </LabeledField>
      <LabeledField label='Amount column (source)'>
        <Input
          value={disperse.amount_column}
          onChange={(e) => onChange({ amount_column: e.target.value })}
          className='h-8 text-[12px]'
        />
      </LabeledField>
      <LabeledField label='Nested target field'>
        <Input
          value={disperse.nested_target}
          onChange={(e) => onChange({ nested_target: e.target.value })}
          className='h-8 text-[12px]'
        />
      </LabeledField>
    </div>
  )
}

function DisperseSection({
  disperse,
  onChange,
  errors
}: {
  disperse: ImportDisperseConfig | null
  onChange: (d: ImportDisperseConfig | null) => void
  errors: ConfigErrorDetail[]
}) {
  const [open, setOpen] = useState(false)
  const enabled = disperse != null
  return (
    <div className='rounded-lg border border-slate-200 dark:border-border'>
      <div className='flex items-center justify-between px-3 py-2.5'>
        <button
          type='button'
          onClick={() => setOpen((o) => !o)}
          className='flex items-center gap-1.5 text-[12px] font-medium text-slate-700 dark:text-slate-200'
        >
          {open ? (
            <ChevronDown className='h-3.5 w-3.5' />
          ) : (
            <ChevronRight className='h-3.5 w-3.5' />
          )}
          Disperse across a value map (advanced)
        </button>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => {
            onChange(v ? DEFAULT_DISPERSE : null)
            if (v) setOpen(true)
          }}
        />
      </div>
      {open && enabled && disperse && (
        <div className='space-y-3 border-t border-slate-100 p-3 dark:border-border'>
          <DisperseFields
            disperse={disperse}
            onChange={(patch) => onChange({ ...disperse, ...patch })}
          />
          <InlineErrors
            errors={errorsUnder(errors, 'line_map.disperse')}
            ownPath='line_map.disperse'
          />
          <div>
            <Label className='mb-1.5 block text-[11px] text-slate-500'>Member columns</Label>
            <RuleEditor
              rules={disperse.member_columns}
              onChange={(cols) => onChange({ ...disperse, member_columns: cols })}
              fieldOptions={null}
              basePath='line_map.disperse.member_columns'
              errors={errors}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Basics ─────────────────────────────────────────────────────────────────

function BasicsFields({
  draft,
  patch,
  fileFieldOptions,
  roleOptions
}: {
  draft: TemplateDraft
  patch: (p: Partial<TemplateDraft>) => void
  fileFieldOptions: Option[]
  roleOptions: Option[]
}) {
  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-3'>
        <LabeledField label='Name'>
          <Input
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder='e.g. Bid Sheet Import'
            className='h-8 text-[12px]'
          />
        </LabeledField>
        <LabeledField label='Sheet match (optional)'>
          <Input
            value={draft.sheet_match}
            onChange={(e) => patch({ sheet_match: e.target.value })}
            placeholder='sheet/tab name contains…'
            className='h-8 text-[12px]'
          />
        </LabeledField>
        <LabeledField label='Header row'>
          <Input
            type='number'
            min={1}
            value={draft.header_row}
            onChange={(e) => patch({ header_row: Math.max(1, Number(e.target.value) || 1) })}
            className='h-8 w-28 text-[12px]'
          />
        </LabeledField>
        <LabeledField label='Attach uploaded file to field'>
          <Combobox
            value={draft.attach_file_field}
            onChange={(v) => patch({ attach_file_field: v })}
            options={[{ value: '', label: '(none)' }, ...fileFieldOptions]}
            placeholder='(none)'
          />
        </LabeledField>
      </div>

      <div className='space-y-1.5'>
        <Label className='text-[11px] text-slate-500'>Mode</Label>
        <div className='flex flex-wrap items-center gap-4'>
          {(
            [
              { value: 'prefill', label: 'Prefill form' },
              { value: 'direct', label: 'Direct create' },
              { value: 'both', label: 'Both' }
            ] as const
          ).map((m) => (
            <label
              key={m.value}
              className='flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-600'
            >
              <input
                type='radio'
                name='import-template-mode'
                checked={draft.mode === m.value}
                onChange={() => patch({ mode: m.value })}
              />
              {m.label}
            </label>
          ))}
        </div>
      </div>

      <div className='space-y-1.5'>
        <Label className='text-[11px] text-slate-500'>File types</Label>
        <div className='flex items-center gap-4'>
          {(['xlsx', 'csv'] as const).map((t) => (
            <label
              key={t}
              className='flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-600'
            >
              <input
                type='checkbox'
                checked={draft.file_types.includes(t)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...draft.file_types, t]
                    : draft.file_types.filter((x) => x !== t)
                  patch({ file_types: next })
                }}
              />
              {t.toUpperCase()}
            </label>
          ))}
        </div>
      </div>

      <div className='flex flex-wrap items-center gap-6'>
        <div className='flex items-center gap-2.5'>
          <Switch checked={draft.is_active} onCheckedChange={(v) => patch({ is_active: v })} />
          <span className='text-[12px] text-slate-600'>Active</span>
        </div>
        <div className='flex items-center gap-2.5'>
          <Switch checked={draft.is_shared} onCheckedChange={(v) => patch({ is_shared: v })} />
          <span className='text-[12px] text-slate-600'>Shared</span>
        </div>
        {draft.is_shared && (
          <div className='w-[200px]'>
            <Combobox
              value={draft.role_id}
              onChange={(v) => patch({ role_id: v })}
              options={[{ value: '', label: '(all roles)' }, ...roleOptions]}
              placeholder='(all roles)'
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Test panel ─────────────────────────────────────────────────────────────

function formatCell(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function TestPanel({ collection, draft }: { collection: string; draft: TemplateDraft }) {
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<ImportParseResponse | null>(null)
  const [testError, setTestError] = useState<{
    message: string
    issues?: ImportParseResponse['issues']
  } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const runTest = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a file first')
      const form = new FormData()
      form.append('file', file, file.name)
      const configPayload = {
        collection,
        file_types: draft.file_types,
        sheet_match: draft.sheet_match || null,
        header_row: draft.header_row,
        header_map: draft.header_map,
        line_map: draft.line_map,
        attach_file_field: draft.attach_file_field || null
      }
      form.append('config', JSON.stringify(configPayload))
      const res = await api.post<{ data: ImportParseResponse }>('/import-templates/test', form)
      return res.data.data
    },
    onSuccess: (data) => {
      setResult(data)
      setTestError(null)
    },
    onError: (err: unknown) => {
      const e = err as {
        response?: {
          data?: {
            error?: string
            details?: ConfigErrorDetail[]
            issues?: ImportParseResponse['issues']
          }
        }
      }
      const data = e.response?.data
      setResult(null)
      if (data?.details && data.details.length > 0) {
        setTestError({ message: data.details.map((d) => `${d.path}: ${d.message}`).join('; ') })
      } else {
        setTestError({ message: data?.error ?? 'Test failed', issues: data?.issues })
      }
    }
  })

  const rows = useMemo(() => result?.lines.slice(0, 20) ?? [], [result])
  const columnKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const line of rows) for (const k of Object.keys(line.values ?? {})) keys.add(k)
    return Array.from(keys)
  }, [rows])

  return (
    <div className='space-y-3'>
      <div className='flex items-center gap-2'>
        <input
          ref={fileRef}
          type='file'
          accept='.xlsx,.csv'
          className='hidden'
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setResult(null)
            setTestError(null)
          }}
        />
        <Button type='button' variant='outline' size='sm' onClick={() => fileRef.current?.click()}>
          <Upload className='mr-1.5 h-3.5 w-3.5' /> {file ? file.name : 'Choose file…'}
        </Button>
        <Button
          type='button'
          size='sm'
          disabled={!file || runTest.isPending}
          onClick={() => runTest.mutate()}
        >
          {runTest.isPending ? 'Running…' : 'Run test'}
        </Button>
      </div>

      {testError && (
        <div className='rounded-lg border border-red-200 bg-red-50 p-3 text-[12px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'>
          {testError.message}
        </div>
      )}
      {testError?.issues && <ImportIssuesPanel issues={testError.issues} />}

      {result && (
        <div className='space-y-3'>
          <div>
            <p className='mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
              Resolved values
            </p>
            {Object.keys(result.values).length === 0 ? (
              <p className='text-[12px] text-slate-400'>No values resolved.</p>
            ) : (
              <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border sm:grid-cols-3'>
                {Object.entries(result.values).map(([k, v]) => (
                  <div key={k} className='bg-white p-2.5 dark:bg-card'>
                    <p className='text-[10px] font-semibold uppercase tracking-wider text-slate-400'>
                      {k}
                    </p>
                    <p className='mt-0.5 truncate text-[12px] text-slate-700 dark:text-slate-200'>
                      {formatCell(v)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {result.line_target_field && (
            <div>
              <p className='mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
                Lines ({result.lines.length}
                {result.lines.length > 20 ? ', showing first 20' : ''})
              </p>
              {rows.length === 0 ? (
                <p className='text-[12px] text-slate-400'>No line rows produced.</p>
              ) : (
                <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
                  <table className='w-full text-[12px]'>
                    <thead>
                      <tr className='border-b border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/30'>
                        {columnKeys.map((k) => (
                          <th
                            key={k}
                            className='px-2.5 py-1.5 text-left font-medium text-slate-500'
                          >
                            {k}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((line, i) => (
                        <tr
                          // biome-ignore lint/suspicious/noArrayIndexKey: static preview rows, no stable id
                          key={i}
                          className='border-b border-slate-100 last:border-0 dark:border-border'
                        >
                          {columnKeys.map((k) => (
                            <td
                              key={k}
                              className='px-2.5 py-1.5 text-slate-700 dark:text-slate-300'
                            >
                              {formatCell(line.values?.[k])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <ImportIssuesPanel issues={result.issues} />
        </div>
      )}
    </div>
  )
}

// ─── Main section ───────────────────────────────────────────────────────────

function isKnownSectionPath(path: string): boolean {
  return path.startsWith('header_map') || path.startsWith('line_map')
}

export function ImportTemplatesSection({ collection }: { collection: string }) {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [draft, setDraftState] = useState<TemplateDraft>(() => blankDraft())
  const [errors, setErrors] = useState<ConfigErrorDetail[]>([])

  const { data: templates = [], isLoading } = useQuery<TemplateRow[]>({
    queryKey: ['import-templates', collection],
    queryFn: () =>
      api
        .get<{ data: TemplateRow[] }>('/import-templates', { params: { collection } })
        .then((r) => r.data.data),
    enabled: !!collection
  })

  const { data: collectionsList = [] } = useQuery<
    { collection: string; display_name: string | null }[]
  >({
    queryKey: ['collections-registry'],
    queryFn: () =>
      api
        .get<{ data: { collection: string; display_name: string | null }[] }>('/collections')
        .then((r) => r.data.data)
  })
  const collectionOptions = useMemo(
    () =>
      collectionsList
        .filter((c) => !c.collection.startsWith('nivaro_'))
        .map((c) => ({ value: c.collection, label: c.display_name || c.collection })),
    [collectionsList]
  )

  const { data: roles = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['roles'],
    queryFn: () =>
      api.get<{ data: { id: string; name: string }[] }>('/roles').then((r) => r.data.data)
  })
  const roleOptions = roles.map((r) => ({ value: r.id, label: r.name }))

  const { data: fields = [] } = useFieldOptions(collection)
  const targetFieldOptions = fields
    .filter(isPlainField)
    .map((f) => ({ value: f.field, label: fieldLabel(f) }))
  const fileFieldOptions = fields
    .filter(isFileField)
    .map((f) => ({ value: f.field, label: fieldLabel(f) }))

  const { data: relations = [] } = useQuery<RelationRow[]>({
    queryKey: ['relations-for', collection],
    queryFn: () =>
      api
        .get<{ data: RelationRow[] }>(`/data-model/relations/for/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection
  })
  const lineTargetOptions = relations
    .filter(
      (r): r is RelationRow & { one_field: string } =>
        r.one_collection === collection && !!r.one_field
    )
    .map((r) => ({ value: r.one_field, label: `${r.one_field} → ${r.many_collection}` }))

  const childCollection = useMemo(() => {
    const rel = relations.find(
      (r) => r.one_collection === collection && r.one_field === draft.line_map?.target_field
    )
    return rel?.many_collection ?? null
  }, [relations, collection, draft.line_map?.target_field])

  const { data: childFields = [] } = useFieldOptions(childCollection)
  const columnFieldOptions = childCollection
    ? childFields.filter(isPlainField).map((f) => ({ value: f.field, label: fieldLabel(f) }))
    : null

  function selectTemplate(row: TemplateRow) {
    setSelectedId(row.id)
    setPendingDeleteId(null)
    setErrors([])
    setDraftState(rowToDraft(row))
  }

  function newTemplate() {
    setSelectedId(null)
    setPendingDeleteId(null)
    setErrors([])
    setDraftState(blankDraft())
  }

  function patch(p: Partial<TemplateDraft>) {
    setDraftState((d) => ({ ...d, ...p }))
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const body = draftToBody(draft)
      if (selectedId) {
        return api
          .patch<{ data: TemplateRow }>(`/import-templates/${selectedId}`, body)
          .then((r) => r.data.data)
      }
      return api
        .post<{ data: TemplateRow }>('/import-templates', { ...body, collection })
        .then((r) => r.data.data)
    },
    onSuccess: (row) => {
      setErrors([])
      qc.invalidateQueries({ queryKey: ['import-templates', collection] })
      setSelectedId(row.id)
      toast.success(selectedId ? 'Template saved' : 'Template created')
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: string; details?: ConfigErrorDetail[] } } }
      const details = e.response?.data?.details ?? []
      setErrors(details)
      toast.error(e.response?.data?.error ?? 'Failed to save template')
    }
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/import-templates/${id}`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['import-templates', collection] })
      if (selectedId === id) newTemplate()
      setPendingDeleteId(null)
      toast.success('Template deleted')
    },
    onError: () => toast.error('Failed to delete template')
  })

  const generalErrors = errors.filter((e) => !isKnownSectionPath(e.path))

  return (
    <div className='flex min-h-0 gap-4'>
      <aside className='flex w-[272px] shrink-0 flex-col rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between gap-2 border-b border-slate-100 p-3 dark:border-border'>
          <p className='text-[12px] font-semibold text-slate-600 dark:text-slate-300'>Templates</p>
          <Button size='sm' variant='outline' className='h-7 text-[11px]' onClick={newTemplate}>
            <Plus className='mr-1 h-3 w-3' /> New
          </Button>
        </div>
        <div className='max-h-[560px] flex-1 overflow-y-auto'>
          {isLoading ? (
            <div className='space-y-2 p-3'>
              <Skeleton className='h-12 w-full rounded-lg' />
              <Skeleton className='h-12 w-full rounded-lg' />
            </div>
          ) : templates.length === 0 ? (
            <div className='p-6 text-center'>
              <FileSpreadsheet className='mx-auto mb-2 h-5 w-5 text-slate-300' />
              <p className='text-[12px] text-slate-400'>No import templates yet</p>
            </div>
          ) : (
            <ul className='divide-y divide-slate-100 dark:divide-border'>
              {templates.map((t) => (
                <li key={t.id}>
                  <button
                    type='button'
                    onClick={() => selectTemplate(t)}
                    className={cn(
                      'flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors',
                      selectedId === t.id
                        ? 'bg-nvr-cyan/10'
                        : 'hover:bg-slate-50 dark:hover:bg-muted/30'
                    )}
                  >
                    <div className='flex items-center gap-1.5'>
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          t.is_active ? 'bg-emerald-500' : 'bg-slate-300'
                        )}
                      />
                      <span className='truncate text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
                        {t.name}
                      </span>
                    </div>
                    <Badge variant='outline' className='w-fit text-[10px] font-normal capitalize'>
                      {t.mode}
                    </Badge>
                  </button>
                  {selectedId === t.id &&
                    (pendingDeleteId === t.id ? (
                      <div className='flex items-center justify-end gap-1.5 border-t border-slate-100 bg-red-50/50 px-3 py-1.5 dark:border-border'>
                        <span className='mr-auto text-[11px] text-red-600'>Delete?</span>
                        <Button
                          size='sm'
                          variant='ghost'
                          className='h-6 text-[11px]'
                          onClick={() => setPendingDeleteId(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size='sm'
                          variant='destructive'
                          className='h-6 text-[11px]'
                          disabled={deleteMut.isPending}
                          onClick={() => deleteMut.mutate(t.id)}
                        >
                          Confirm
                        </Button>
                      </div>
                    ) : (
                      <div className='flex justify-end px-3 pb-1.5'>
                        <button
                          type='button'
                          className='text-[10.5px] text-red-400 hover:text-red-600'
                          onClick={() => setPendingDeleteId(t.id)}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <div className='min-w-0 flex-1 space-y-5'>
        {generalErrors.length > 0 && <InlineErrors errors={generalErrors} ownPath='__general__' />}

        <Section title='Basics'>
          <BasicsFields
            draft={draft}
            patch={patch}
            fileFieldOptions={fileFieldOptions}
            roleOptions={roleOptions}
          />
        </Section>

        <Section title='Header rules'>
          <CollectionOptionsContext.Provider value={collectionOptions}>
            <RuleEditor
              rules={draft.header_map}
              onChange={(rules) => patch({ header_map: rules })}
              fieldOptions={targetFieldOptions}
              basePath='header_map'
              errors={errors}
            />
          </CollectionOptionsContext.Provider>
        </Section>

        <Section title='Line config'>
          <div className='flex items-center gap-2.5'>
            <Switch
              checked={draft.line_map != null}
              onCheckedChange={(v) => patch({ line_map: v ? DEFAULT_LINE_CONFIG : null })}
            />
            <span className='text-[12px] text-slate-600'>
              Import child rows into a related collection
            </span>
          </div>
          {draft.line_map && (
            <div className='mt-3 space-y-3'>
              <div className='w-[280px]'>
                <Label className='mb-1 block text-[11px] text-slate-500'>Target relation</Label>
                <Combobox
                  value={draft.line_map.target_field}
                  onChange={(v) =>
                    patch({
                      line_map: { ...(draft.line_map as ImportLineConfig), target_field: v }
                    })
                  }
                  options={lineTargetOptions}
                  placeholder='relation…'
                />
              </div>
              <InlineErrors errors={errorsUnder(errors, 'line_map')} ownPath='line_map' />

              <div>
                <Label className='mb-1.5 block text-[11px] text-slate-500'>Row filter</Label>
                <RowFilterEditor
                  value={draft.line_map.row_filter}
                  onChange={(rf) =>
                    patch({ line_map: { ...(draft.line_map as ImportLineConfig), row_filter: rf } })
                  }
                />
              </div>

              <div>
                <Label className='mb-1.5 block text-[11px] text-slate-500'>Columns</Label>
                <CollectionOptionsContext.Provider value={collectionOptions}>
                  <RuleEditor
                    rules={draft.line_map.columns}
                    onChange={(cols) =>
                      patch({
                        line_map: { ...(draft.line_map as ImportLineConfig), columns: cols }
                      })
                    }
                    fieldOptions={columnFieldOptions}
                    basePath='line_map.columns'
                    errors={errors}
                  />
                </CollectionOptionsContext.Provider>
              </div>

              <div className='flex items-center gap-2.5'>
                <Switch
                  checked={draft.line_map.apply_field_rules}
                  onCheckedChange={(v) =>
                    patch({
                      line_map: { ...(draft.line_map as ImportLineConfig), apply_field_rules: v }
                    })
                  }
                />
                <span className='text-[12px] text-slate-600'>Apply field rules to each line</span>
              </div>

              <CollectionOptionsContext.Provider value={collectionOptions}>
                <DisperseSection
                  disperse={draft.line_map.disperse}
                  onChange={(d) =>
                    patch({ line_map: { ...(draft.line_map as ImportLineConfig), disperse: d } })
                  }
                  errors={errors}
                />
              </CollectionOptionsContext.Provider>
            </div>
          )}
        </Section>

        <Section title='Test'>
          <TestPanel key={selectedId ?? '__new__'} collection={collection} draft={draft} />
        </Section>

        <div className='flex items-center justify-end gap-2 pb-2'>
          <Button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || !draft.name.trim()}
          >
            {saveMut.isPending ? 'Saving…' : selectedId ? 'Save changes' : 'Create template'}
          </Button>
        </div>
      </div>
    </div>
  )
}
