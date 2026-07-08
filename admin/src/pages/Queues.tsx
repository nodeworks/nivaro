import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Inbox, Plus, Settings2, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { DisplayTemplateEditor } from '@/components/display-template-editor'
import { CollectionFieldPicker, type PickedField } from '@/components/field-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { type ColumnFormatConfig, formatValue } from '@/lib/format-value'
import { cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

type SourceType = 'collection' | 'tasks' | 'approvals' | 'owned_by_me'

interface QueueCondition {
  field: string
  op: string
  value?: unknown
}

interface QueueSource {
  id?: number
  type: SourceType
  collection: string | null
  filters: QueueCondition[] | null
  state_values: string[] | null
  state_mode?: 'include' | 'exclude' | null
  label_template?: string | null
  drilldown?: Record<
    string,
    { enabled?: boolean; layout_id?: number | null; width?: number | string | null }
  > | null
  column_formats?: Record<string, ColumnFormatConfig> | null
  sla_filter: string | null
  extra_fields: string[] | null
  sort: number
}

const FILTER_OPS: { value: string; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'null', label: 'is empty' },
  { value: 'nnull', label: 'is not empty' }
]

type QueueViewKind = 'table' | 'kanban' | 'workload'
type QueueDefaultScope = 'mine' | 'unowned' | 'all'

interface QueueDisplayConfig {
  views: QueueViewKind[]
  default_view: QueueViewKind
  default_scope: QueueDefaultScope
  work_next: boolean
  bulk_actions: boolean
}

const VIEW_LABELS: Record<QueueViewKind, string> = {
  table: 'Table',
  kanban: 'Kanban',
  workload: 'Workload'
}

const SCOPE_LABELS: Record<QueueDefaultScope, string> = {
  mine: 'My Items',
  unowned: 'No Owners',
  all: 'All Items'
}

interface Queue {
  id: string
  name: string
  description: string | null
  owner: string
  is_shared: boolean
  role_id: string | null
  is_active: boolean
  claims_enabled: boolean
  column_aliases: Record<string, string>
  display_config: QueueDisplayConfig
}

interface QueueDetailData extends Queue {
  sources: QueueSource[]
  extra_field_meta?: Array<{
    path: string
    kind: 'relation' | 'plain'
    target_collection?: string
  }>
}

const SOURCE_TYPE_OPTIONS: { value: SourceType; label: string }[] = [
  { value: 'owned_by_me', label: 'Owned by me (auto)' },
  { value: 'collection', label: 'Collection' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'approvals', label: 'Approvals' }
]

// ─── Combobox helper (mirrors Hierarchies.tsx FieldCombobox) ──────────────────

function FieldCombobox({
  value,
  onChange,
  options,
  placeholder,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
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
          className='h-8 w-full justify-between px-2 text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
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
                  className='text-[12px]'
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

// ─── List item ──────────────────────────────────────────────────────────────

function QueueListItem({
  queue,
  selected,
  onSelect
}: {
  queue: Queue
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type='button'
        onClick={onSelect}
        className={cn(
          'block w-full px-4 py-3 text-left transition-colors',
          selected
            ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/[0.07]'
            : 'hover:bg-slate-50 dark:hover:bg-muted/50'
        )}
      >
        <div className='flex items-center gap-2'>
          <Inbox className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          <span
            className={cn(
              'flex-1 truncate text-[13px] font-medium',
              selected ? 'text-nvr-navy dark:text-nvr-cyan' : 'text-slate-700 dark:text-slate-300'
            )}
          >
            {queue.name}
          </span>
          {queue.is_shared && (
            <span className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-muted'>
              Shared
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

// Per-column drill-down config: enabled toggle + pinned detail layout of the
// target collection. Only offered for relation extra-field paths.
const DRILLDOWN_WIDTHS = [
  { value: 480, label: 'Narrow (480px)' },
  { value: 640, label: 'Default (640px)' },
  { value: 900, label: 'Wide (900px)' },
  { value: 1100, label: 'Extra wide (1100px)' }
]

// Freeform width: '800', '800px' -> 800 (px, clamped 320..2000); '75%' -> '75%'
// (of the viewport, clamped 10..96). Null = invalid / empty.
function normalizeDrilldownWidth(raw: string): number | string | null {
  const t = raw.trim().toLowerCase()
  if (!t) return null
  const pct = t.match(/^(\d{1,3})\s*%$/)
  if (pct) {
    const n = Math.min(96, Math.max(10, Number(pct[1])))
    return `${n}%`
  }
  const px = t.match(/^(\d{2,4})\s*(px)?$/)
  if (px) {
    return Math.min(2000, Math.max(320, Number(px[1])))
  }
  return null
}

function ConfigCombobox({
  value,
  options,
  onChange
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          role='combobox'
          aria-expanded={open}
          className='flex w-full items-center justify-between rounded border border-slate-200 bg-white px-2 py-1 text-left text-[11px] dark:border-border dark:bg-background'
        >
          <span className='truncate'>{selected?.label ?? 'Select…'}</span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[220px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[11px]' />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className='text-[11px]'
                >
                  <Check
                    className={cn(
                      'mr-1.5 h-3 w-3',
                      value === o.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const DATETIME_PRESETS = [
  { value: 'DD/MM/YYYY', label: 'Date (05/03/2026)' },
  { value: 'DD/MM/YYYY HH:mm', label: 'Date + time (05/03/2026 14:07)' },
  { value: 'relative', label: 'Relative (2h ago)' },
  { value: 'YYYY-MM-DD HH:mm:ss', label: 'ISO (2026-03-05 14:07:09)' }
]

function DatetimeFormatFields({
  format,
  onFormatChange
}: {
  format: { type: 'datetime'; template: string }
  onFormatChange: (next: ColumnFormatConfig) => void
}) {
  const isPreset = DATETIME_PRESETS.some((p) => p.value === format.template)
  const [custom, setCustom] = useState(!isPreset)
  return (
    <div className='space-y-1'>
      <ConfigCombobox
        value={custom ? '__custom__' : format.template}
        options={[...DATETIME_PRESETS, { value: '__custom__', label: 'Custom…' }]}
        onChange={(v) => {
          if (v === '__custom__') setCustom(true)
          else {
            setCustom(false)
            onFormatChange({ type: 'datetime', template: v })
          }
        }}
      />
      {custom && (
        <input
          type='text'
          value={format.template}
          maxLength={50}
          onChange={(e) => onFormatChange({ type: 'datetime', template: e.target.value })}
          placeholder='DD MMM YYYY HH:mm'
          className='w-full rounded border border-slate-200 bg-white px-2 py-1 font-mono text-[11px] dark:border-border dark:bg-background'
        />
      )}
      <p className='text-[10px] text-slate-400'>
        Preview: {formatValue(new Date().toISOString(), format)}
      </p>
    </div>
  )
}

function NumberFormatFields({
  format,
  onFormatChange
}: {
  format: {
    type: 'number'
    decimals?: number
    thousands?: boolean
    prefix?: string
    suffix?: string
  }
  onFormatChange: (next: ColumnFormatConfig) => void
}) {
  return (
    <div className='space-y-1'>
      <div className='flex items-center gap-2'>
        <label className='flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400'>
          Decimals
          <input
            type='number'
            min={0}
            max={10}
            value={format.decimals ?? 0}
            onChange={(e) =>
              onFormatChange({
                ...format,
                decimals: Math.max(0, Math.min(10, Number(e.target.value) || 0))
              })
            }
            className='w-14 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] dark:border-border dark:bg-background'
          />
        </label>
        <label className='flex cursor-pointer items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400'>
          <input
            type='checkbox'
            checked={format.thousands ?? false}
            onChange={(e) => onFormatChange({ ...format, thousands: e.target.checked })}
            className='h-3.5 w-3.5 rounded accent-nvr-cyan'
          />
          1,000s
        </label>
      </div>
      <div className='flex items-center gap-1.5'>
        <input
          type='text'
          value={format.prefix ?? ''}
          maxLength={30}
          onChange={(e) => onFormatChange({ ...format, prefix: e.target.value })}
          placeholder='Prefix (£)'
          className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-border dark:bg-background'
        />
        <input
          type='text'
          value={format.suffix ?? ''}
          maxLength={30}
          onChange={(e) => onFormatChange({ ...format, suffix: e.target.value })}
          placeholder='Suffix (%)'
          className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-border dark:bg-background'
        />
      </div>
      <p className='text-[10px] text-slate-400'>Preview: {formatValue('1234.5', format)}</p>
    </div>
  )
}

function BooleanFormatFields({
  format,
  onFormatChange
}: {
  format: { type: 'boolean'; true_label: string; false_label: string }
  onFormatChange: (next: ColumnFormatConfig) => void
}) {
  return (
    <div className='flex items-center gap-1.5'>
      <input
        type='text'
        value={format.true_label}
        maxLength={30}
        onChange={(e) => onFormatChange({ ...format, true_label: e.target.value })}
        placeholder='True label'
        className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-border dark:bg-background'
      />
      <input
        type='text'
        value={format.false_label}
        maxLength={30}
        onChange={(e) => onFormatChange({ ...format, false_label: e.target.value })}
        placeholder='False label'
        className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-border dark:bg-background'
      />
    </div>
  )
}

function ColumnChipConfig({
  path,
  targetCollection,
  cfg,
  format,
  onChange,
  onFormatChange
}: {
  path: string
  targetCollection: string | null
  cfg: { enabled?: boolean; layout_id?: number | null; width?: number | string | null } | undefined
  format: ColumnFormatConfig | undefined
  onChange: (next: {
    enabled: boolean
    layout_id: number | null
    width: number | string | null
  }) => void
  onFormatChange: (next: ColumnFormatConfig | null) => void
}) {
  const presetValues = new Set(DRILLDOWN_WIDTHS.map((w) => w.value))
  const isCustom = cfg?.width != null && !presetValues.has(cfg.width as number)
  const [customMode, setCustomMode] = useState(isCustom)
  const [customDraft, setCustomDraft] = useState(isCustom ? String(cfg?.width ?? '') : '')
  const [open, setOpen] = useState(false)
  const { data: detailLayouts = [] } = useQuery<
    Array<{ id: number; name: string; layout_type?: string }>
  >({
    queryKey: ['detail-layouts', targetCollection ?? ''],
    enabled: open && !!targetCollection,
    queryFn: () =>
      api
        .get(`/collection-layouts?collection=${targetCollection ?? ''}`)
        .then((r) =>
          ((r.data.data ?? []) as Array<{ id: number; name: string; layout_type?: string }>).filter(
            (l) => l.layout_type === 'detail'
          )
        )
  })
  const enabled = cfg?.enabled !== false
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={`Column settings for ${path}`}
          className={cn(
            'ml-0.5 rounded-sm hover:opacity-100',
            enabled || format ? 'opacity-80 text-nvr-cyan' : 'opacity-40'
          )}
        >
          <Settings2 className='h-3 w-3' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] space-y-2 p-3' align='start'>
        {targetCollection && (
          <>
            <p className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
              Drill-down · {path}
            </p>
            <label className='flex cursor-pointer items-center justify-between'>
              <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                Click value opens detail panel
              </span>
              <input
                type='checkbox'
                checked={enabled}
                onChange={(e) =>
                  onChange({
                    enabled: e.target.checked,
                    layout_id: cfg?.layout_id ?? null,
                    width: cfg?.width ?? null
                  })
                }
                className='h-3.5 w-3.5 rounded accent-nvr-cyan'
              />
            </label>
            {enabled && (
              <div className='space-y-1'>
                <span className='text-[10px] text-slate-400'>Detail layout</span>
                <select
                  value={cfg?.layout_id ?? ''}
                  onChange={(e) =>
                    onChange({
                      enabled: true,
                      layout_id: e.target.value ? Number(e.target.value) : null,
                      width: cfg?.width ?? null
                    })
                  }
                  className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-border dark:bg-background'
                >
                  <option value=''>Default (active detail layout)</option>
                  {detailLayouts.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                {detailLayouts.length === 0 && (
                  <p className='text-[10px] text-slate-400'>
                    No detail layouts on {targetCollection} yet — the panel falls back to a
                    read-only view. Create one in Data Model → Layout.
                  </p>
                )}
                <span className='text-[10px] text-slate-400'>Panel width</span>
                <select
                  value={customMode ? '__custom__' : String(cfg?.width ?? 640)}
                  onChange={(e) => {
                    if (e.target.value === '__custom__') {
                      setCustomMode(true)
                      setCustomDraft(cfg?.width != null ? String(cfg.width) : '')
                      return
                    }
                    setCustomMode(false)
                    const n = Number(e.target.value)
                    onChange({
                      enabled: true,
                      layout_id: cfg?.layout_id ?? null,
                      width: n === 640 ? null : n
                    })
                  }}
                  className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-border dark:bg-background'
                >
                  {DRILLDOWN_WIDTHS.map((w) => (
                    <option key={w.value} value={String(w.value)}>
                      {w.label}
                    </option>
                  ))}
                  <option value='__custom__'>Custom…</option>
                </select>
                {customMode && (
                  <div className='space-y-0.5'>
                    <Input
                      value={customDraft}
                      onChange={(e) => {
                        setCustomDraft(e.target.value)
                        const w = normalizeDrilldownWidth(e.target.value)
                        if (w != null) {
                          onChange({ enabled: true, layout_id: cfg?.layout_id ?? null, width: w })
                        }
                      }}
                      placeholder='e.g. 800px or 75%'
                      className='h-7 text-[11px]'
                    />
                    <p className='text-[10px] text-slate-400'>
                      Pixels (320–2000) or viewport percentage (10–96%).
                    </p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        <div className='space-y-1 border-t border-slate-100 pt-2 dark:border-border'>
          <p className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>Format</p>
          <ConfigCombobox
            value={format?.type ?? ''}
            options={[
              { value: '', label: 'None (raw value)' },
              { value: 'datetime', label: 'Date & time' },
              { value: 'number', label: 'Number' },
              { value: 'boolean', label: 'Yes / No' }
            ]}
            onChange={(t) => {
              if (!t) onFormatChange(null)
              else if (t === 'datetime')
                onFormatChange({ type: 'datetime', template: 'DD/MM/YYYY' })
              else if (t === 'number') onFormatChange({ type: 'number', decimals: 0 })
              else onFormatChange({ type: 'boolean', true_label: 'Yes', false_label: 'No' })
            }}
          />
          {format?.type === 'datetime' && (
            <DatetimeFormatFields format={format} onFormatChange={onFormatChange} />
          )}
          {format?.type === 'number' && (
            <NumberFormatFields format={format} onFormatChange={onFormatChange} />
          )}
          {format?.type === 'boolean' && (
            <BooleanFormatFields format={format} onFormatChange={onFormatChange} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Source row editor ──────────────────────────────────────────────────────

function SourceRow({
  source,
  collectionOptions,
  extraFieldMeta,
  index,
  onChange,
  onRemove,
  canEdit
}: {
  source: QueueSource
  collectionOptions: { value: string; label: string }[]
  extraFieldMeta: Array<{ path: string; kind: 'relation' | 'plain'; target_collection?: string }>
  index?: number
  onChange: (next: QueueSource) => void
  onRemove: () => void
  canEdit: boolean
}) {
  const currentExtraFields = source.extra_fields ?? []
  const isCollection = source.type === 'collection' && !!source.collection

  const { data: states = [] } = useQuery<Array<{ key: string; label: string }>>({
    queryKey: ['queue-collection-states', source.collection],
    queryFn: () =>
      api.get(`/queues/collection-states/${source.collection}`).then((r) => r.data.data),
    enabled: isCollection
  })

  const { data: fieldConfig } = useQuery<{
    data: Array<{ field: string; type: string; label: string | null; computed_type: string | null }>
  }>({
    queryKey: ['field-config', source.collection],
    queryFn: () => api.get(`/field-config/${source.collection}`).then((r) => r.data),
    enabled: isCollection
  })
  // Real DB columns only — alias (o2m/m2m presentation) and computed fields
  // aren't SQL-filterable by applyQueueConditions.
  const filterFieldOptions = (fieldConfig?.data ?? [])
    .filter((f) => f.type !== 'alias' && !f.computed_type)
    .map((f) => ({ value: f.field, label: f.label || f.field }))

  const conditions = Array.isArray(source.filters) ? source.filters : []
  const stateValues = source.state_values ?? []
  const stateMode = source.state_mode === 'exclude' ? 'exclude' : 'include'

  // cmdk lowercases CommandItem values in onSelect — resolve back to the real key.
  const resolveStateKey = (v: string) =>
    states.find((s) => s.key.toLowerCase() === v.toLowerCase())?.key ?? v
  const resolveField = (v: string) =>
    filterFieldOptions.find((f) => f.value.toLowerCase() === v.toLowerCase())?.value ?? v

  function updateCondition(idx: number, patch: Partial<QueueCondition>) {
    onChange({
      ...source,
      filters: conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c))
    })
  }

  return (
    <div className='overflow-visible rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      {/* Header: what this source pulls from */}
      <div className='flex items-start gap-2 rounded-t-lg border-b border-slate-100 bg-slate-50/70 p-2.5 dark:border-border dark:bg-muted/40'>
        {index !== undefined && (
          <span className='mt-1.5 w-5 shrink-0 text-center text-[11px] font-medium tabular-nums text-slate-400'>
            {index + 1}
          </span>
        )}
        <div className='w-44 shrink-0'>
          <FieldCombobox
            value={source.type}
            onChange={(v) =>
              onChange({
                ...source,
                type: v as SourceType,
                collection: v === 'collection' ? source.collection : null
              })
            }
            options={SOURCE_TYPE_OPTIONS}
            disabled={!canEdit}
          />
        </div>
        {source.type === 'collection' && (
          <div className='flex-1'>
            <FieldCombobox
              value={source.collection ?? ''}
              onChange={(v) => onChange({ ...source, collection: v || null })}
              options={collectionOptions}
              placeholder='Select collection…'
              disabled={!canEdit}
            />
          </div>
        )}
        {source.type === 'collection' && (
          <div className='w-40 shrink-0'>
            <FieldCombobox
              value={source.sla_filter ?? ''}
              onChange={(v) => onChange({ ...source, sla_filter: v || null })}
              options={[
                { value: 'breached', label: 'SLA: Breached' },
                { value: 'warning', label: 'SLA: Warning' }
              ]}
              placeholder='No SLA filter'
              disabled={!canEdit}
            />
          </div>
        )}
        {canEdit && (
          <Button
            variant='ghost'
            size='sm'
            className='h-8 w-8 shrink-0 p-0 text-slate-400 hover:text-red-500'
            onClick={onRemove}
          >
            <Trash2 className='h-3.5 w-3.5' />
          </Button>
        )}
      </div>
      {source.type === 'collection' && (
        <div className='grid gap-x-8 gap-y-5 p-4 md:grid-cols-2'>
          {/* Which items appear: narrowing (states + field filters) */}
          <div className='space-y-4'>
            <h4 className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
              Which items appear
            </h4>
            {isCollection && states.length > 0 && (
              <div className='space-y-1'>
                <div className='flex items-center gap-2'>
                  <Label className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                    States
                  </Label>
                  <div className='flex overflow-hidden rounded-md border border-slate-200 dark:border-border'>
                    {(['include', 'exclude'] as const).map((m) => (
                      <button
                        key={m}
                        type='button'
                        disabled={!canEdit}
                        onClick={() => onChange({ ...source, state_mode: m })}
                        className={cn(
                          'px-2 py-0.5 text-[11px] font-medium capitalize',
                          stateMode === m
                            ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-foreground'
                        )}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  {stateValues.length === 0 && (
                    <span className='text-[11px] text-slate-400'>No state filter — all states</span>
                  )}
                </div>
                <div className='flex flex-wrap items-center gap-1.5'>
                  {stateValues.map((k) => (
                    <Badge key={k} className='gap-1 text-[11px]'>
                      {k === '__none__'
                        ? '(No state)'
                        : (states.find((s) => s.key === k)?.label ?? k)}
                      <button
                        type='button'
                        aria-label={`Remove ${k}`}
                        disabled={!canEdit}
                        onClick={() =>
                          onChange({ ...source, state_values: stateValues.filter((x) => x !== k) })
                        }
                        className='ml-0.5 rounded-sm opacity-60 hover:opacity-100'
                      >
                        <X className='h-3 w-3' />
                      </button>
                    </Badge>
                  ))}
                  {canEdit && (
                    <div className='w-[200px]'>
                      <FieldCombobox
                        value=''
                        onChange={(v) => {
                          const key = resolveStateKey(v)
                          if (key && !stateValues.includes(key)) {
                            onChange({ ...source, state_values: [...stateValues, key] })
                          }
                        }}
                        options={[
                          ...(stateValues.includes('__none__')
                            ? []
                            : [{ value: '__none__', label: '(No state)' }]),
                          ...states
                            .filter((s) => !stateValues.includes(s.key))
                            .map((s) => ({ value: s.key, label: s.label }))
                        ]}
                        placeholder={stateMode === 'exclude' ? 'Exclude state…' : 'Include state…'}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
            {isCollection && (
              <div className='space-y-1'>
                <Label className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                  Filters
                  <span className='ml-1.5 font-normal text-slate-400'>all must match</span>
                </Label>
                {conditions.map((c, idx) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable identity
                  <div key={idx} className='flex items-center gap-1.5'>
                    <div className='w-44 shrink-0'>
                      <FieldCombobox
                        value={c.field}
                        onChange={(v) => updateCondition(idx, { field: resolveField(v) })}
                        options={filterFieldOptions}
                        placeholder='Field…'
                        disabled={!canEdit}
                      />
                    </div>
                    <div className='w-32 shrink-0'>
                      <FieldCombobox
                        value={c.op}
                        onChange={(v) => updateCondition(idx, { op: v || 'eq' })}
                        options={FILTER_OPS}
                        placeholder='Op…'
                        disabled={!canEdit}
                      />
                    </div>
                    {c.op !== 'null' && c.op !== 'nnull' && (
                      <Input
                        value={String(c.value ?? '')}
                        onChange={(e) => updateCondition(idx, { value: e.target.value })}
                        placeholder='Value'
                        disabled={!canEdit}
                        className='h-8 w-40 text-[12px]'
                      />
                    )}
                    {canEdit && (
                      <Button
                        variant='ghost'
                        size='sm'
                        className='h-8 w-8 shrink-0 p-0 text-slate-400 hover:text-red-500'
                        onClick={() =>
                          onChange({ ...source, filters: conditions.filter((_, i) => i !== idx) })
                        }
                      >
                        <X className='h-3.5 w-3.5' />
                      </Button>
                    )}
                  </div>
                ))}
                {canEdit && (
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-7 gap-1 px-2 text-[11px] text-slate-500 hover:text-slate-700'
                    onClick={() =>
                      onChange({
                        ...source,
                        filters: [...conditions, { field: '', op: 'eq', value: '' }]
                      })
                    }
                  >
                    <Plus className='h-3 w-3' /> Add filter
                  </Button>
                )}
              </div>
            )}
          </div>
          {/* How items display: label template + extra table columns */}
          <div className='space-y-4 md:border-l md:border-slate-100 md:pl-8 dark:md:border-border'>
            <h4 className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
              How items display
            </h4>
            {isCollection && (
              <div className='space-y-1'>
                <Label className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                  Item label
                  <span className='ml-1.5 font-normal text-slate-400'>
                    what the Item column shows
                  </span>
                </Label>
                <div className='max-w-[520px]'>
                  <DisplayTemplateEditor
                    value={source.label_template ?? ''}
                    onChange={(v) => onChange({ ...source, label_template: v || null })}
                    collection={source.collection as string}
                    placeholder='Add fields and text — controls the Item column'
                    disabled={!canEdit}
                  />
                </div>
                <p className='text-[11px] text-slate-400'>
                  Empty = the collection's display template, then title/name/label/subject. Direct
                  fields of this collection only.
                </p>
              </div>
            )}
            {source.type === 'collection' && (
              <div className='space-y-1'>
                <Label className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                  Extra columns
                  <span className='ml-1.5 font-normal text-slate-400'>
                    shown in the worklist table
                  </span>
                </Label>
                <div className='flex flex-wrap items-center gap-1.5'>
                  {currentExtraFields.map((f) => {
                    const meta = extraFieldMeta.find((m) => m.path === f)
                    return (
                      <Badge key={f} className='gap-1 font-mono text-[11px]'>
                        {f}
                        {canEdit && (
                          <ColumnChipConfig
                            path={f}
                            targetCollection={
                              meta?.kind === 'relation' ? (meta.target_collection ?? null) : null
                            }
                            cfg={source.drilldown?.[f]}
                            format={source.column_formats?.[f]}
                            onChange={(next) =>
                              onChange({
                                ...source,
                                drilldown: { ...(source.drilldown ?? {}), [f]: next }
                              })
                            }
                            onFormatChange={(next) => {
                              const current = { ...(source.column_formats ?? {}) }
                              if (
                                next === null ||
                                (next.type === 'boolean' && (!next.true_label || !next.false_label))
                              ) {
                                delete current[f]
                              } else {
                                current[f] = next
                              }
                              onChange({ ...source, column_formats: current })
                            }}
                          />
                        )}
                        <button
                          type='button'
                          aria-label={`Remove ${f}`}
                          onClick={() =>
                            onChange({
                              ...source,
                              extra_fields: currentExtraFields.filter((x) => x !== f)
                            })
                          }
                          className='ml-0.5 rounded-sm opacity-60 hover:opacity-100'
                          disabled={!canEdit}
                        >
                          <X className='h-3 w-3' />
                        </button>
                      </Badge>
                    )
                  })}
                  {canEdit && source.collection && (
                    <div className='w-[220px]'>
                      <CollectionFieldPicker
                        collection={source.collection}
                        value=''
                        onChange={(picked: PickedField) => {
                          const path = picked.path.join('.')
                          if (!currentExtraFields.includes(path)) {
                            onChange({ ...source, extra_fields: [...currentExtraFields, path] })
                          }
                        }}
                        placeholder='Add column…'
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Builder panel ──────────────────────────────────────────────────────────

function SimpleCombobox({
  value,
  options,
  onChange,
  disabled
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          className='flex h-8 w-44 items-center justify-between rounded-md border border-slate-200 bg-white px-2.5 text-[12px] text-slate-800 disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-100'
        >
          {current?.label ?? value}
          <ChevronsUpDown className='h-3.5 w-3.5 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-44 p-0' align='start'>
        <Command>
          <CommandList>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3.5 w-3.5',
                      value === o.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

type BuilderTab = 'sources' | 'columns' | 'settings'

function QueueBuilder({ queueId, onDeleted }: { queueId: string; onDeleted: () => void }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.is_admin ?? false

  const { data: queue } = useQuery<QueueDetailData>({
    queryKey: ['queue', queueId],
    queryFn: () => api.get(`/queues/${queueId}`).then((r) => r.data.data)
  })
  const { data: collections = [] } = useQuery<
    Array<{ collection: string; display_name: string | null; plural: string | null }>
  >({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data)
  })

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isShared, setIsShared] = useState(false)
  const [claimsEnabled, setClaimsEnabled] = useState(true)
  const [columnAliases, setColumnAliases] = useState<Record<string, string>>({})
  const [displayConfig, setDisplayConfig] = useState<QueueDisplayConfig>({
    views: ['table', 'kanban', 'workload'],
    default_view: 'table',
    default_scope: 'all',
    work_next: true,
    bulk_actions: true
  })
  const [sources, setSources] = useState<QueueSource[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [tab, setTab] = useState<BuilderTab>('sources')
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (queue && loadedFor !== queue.id) {
    setName(queue.name)
    setDescription(queue.description ?? '')
    setIsShared(queue.is_shared)
    setClaimsEnabled(queue.claims_enabled)
    setColumnAliases(queue.column_aliases ?? {})
    setDisplayConfig(queue.display_config)
    setSources(queue.sources)
    setLoadedFor(queue.id)
    setTab('sources')
    setConfirmDelete(false)
  }

  const collectionOptions = collections.map((c) => ({
    value: c.collection,
    label:
      c.display_name ||
      c.plural ||
      c.collection.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
  }))

  const saveMetaMut = useMutation({
    mutationFn: () =>
      api.patch(`/queues/${queueId}`, {
        name,
        description,
        is_shared: isShared,
        claims_enabled: claimsEnabled,
        column_aliases: columnAliases,
        display_config: displayConfig
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queues'] })
      qc.invalidateQueries({ queryKey: ['queue', queueId] })
      toast.success('Queue saved')
    },
    onError: () => toast.error('Failed to save queue')
  })

  const saveSourcesMut = useMutation({
    mutationFn: () =>
      api.patch(`/queues/${queueId}/sources`, {
        sources: sources.map((s, i) => ({
          ...s,
          // Drop half-built condition rows — an empty field name would make the
          // source's SQL query throw and the source silently resolve empty.
          filters: (s.filters ?? []).filter((c) => c.field && c.op),
          sort: i
        }))
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue', queueId] })
      toast.success('Sources saved')
    },
    onError: () =>
      toast.error('Failed to save sources — check each source has a collection selected')
  })

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/queues/${queueId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queues'] })
      toast.success('Queue deleted')
      onDeleted()
    },
    onError: () => toast.error('Failed to delete queue')
  })

  if (!queue)
    return (
      <div className='flex flex-1 items-center justify-center text-[13px] text-slate-400'>
        Loading…
      </div>
    )

  const canEdit = isAdmin || queue.owner === user?.id

  const metaDirty =
    name !== queue.name ||
    description !== (queue.description ?? '') ||
    isShared !== queue.is_shared ||
    claimsEnabled !== queue.claims_enabled ||
    JSON.stringify(displayConfig) !== JSON.stringify(queue.display_config) ||
    JSON.stringify(columnAliases) !== JSON.stringify(queue.column_aliases ?? {})
  const sourcesDirty = JSON.stringify(sources) !== JSON.stringify(queue.sources)
  const dirty = metaDirty || sourcesDirty
  const saving = saveMetaMut.isPending || saveSourcesMut.isPending

  async function saveAll() {
    try {
      if (metaDirty) await saveMetaMut.mutateAsync()
      if (sourcesDirty) await saveSourcesMut.mutateAsync()
    } catch {
      /* mutation onError already toasts */
    }
  }

  const aliasColumns = [
    { key: 'label', label: 'Item' },
    { key: 'collection', label: 'Collection' },
    { key: 'state', label: 'State' },
    { key: 'owners', label: 'Owners' },
    { key: 'aging_hours', label: 'Aging' },
    { key: 'sla_status', label: 'SLA' },
    { key: 'at_risk', label: 'Risk' }
  ]
  const extraAliasColumns = [...new Set(sources.flatMap((sc) => sc.extra_fields ?? []))].map(
    (f) => ({
      key: `extra.${f}`,
      label: f
        .split('.')
        .map((seg) => seg.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
        .join(' → ')
    })
  )

  const aliasRow = (col: { key: string; label: string }) => (
    <div key={col.key} className='flex items-center gap-3'>
      <span className='w-40 shrink-0 truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
        {col.label}
      </span>
      <Input
        value={columnAliases[col.key] ?? ''}
        onChange={(e) =>
          setColumnAliases((prev) => {
            const next = { ...prev }
            if (e.target.value) next[col.key] = e.target.value
            else delete next[col.key]
            return next
          })
        }
        placeholder={col.label}
        disabled={!canEdit}
        className='h-8 flex-1 text-[12px]'
      />
    </div>
  )

  const TABS: Array<{ key: BuilderTab; label: string; count?: number }> = [
    { key: 'sources', label: 'Sources', count: sources.length },
    { key: 'columns', label: 'Columns' },
    { key: 'settings', label: 'Settings' }
  ]

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      {/* ── Header: identity + one Save ── */}
      <div className='shrink-0 border-b border-slate-200 bg-white px-6 pt-4 dark:border-border dark:bg-card'>
        <div className='flex items-start justify-between gap-4'>
          <div className='-ml-2 min-w-0 flex-1'>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit}
              placeholder='Queue name'
              className='w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-[16px] font-semibold text-slate-900 outline-none transition-colors hover:border-slate-200 focus:border-nvr-cyan focus:ring-2 focus:ring-nvr-cyan/20 dark:text-foreground dark:hover:border-border'
            />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canEdit}
              placeholder='Add a description…'
              className='mt-0.5 w-full rounded-md border border-transparent bg-transparent px-2 py-0.5 text-[12px] text-slate-500 outline-none transition-colors placeholder:text-slate-400 hover:border-slate-200 focus:border-nvr-cyan focus:ring-2 focus:ring-nvr-cyan/20 dark:text-muted-foreground dark:hover:border-border'
            />
          </div>
          <div className='flex shrink-0 items-center gap-2 pt-0.5'>
            {!canEdit && (
              <span className='rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                Read only
              </span>
            )}
            {canEdit && dirty && (
              <span className='flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400'>
                <span className='h-1.5 w-1.5 rounded-full bg-amber-400' />
                Unsaved changes
              </span>
            )}
            <Link to={`/queues/${queueId}`}>
              <Button variant='outline' size='sm' className='h-8 text-[12px]'>
                Open Worklist →
              </Button>
            </Link>
            {canEdit && (
              <Button
                size='sm'
                className='h-8 text-[12px]'
                onClick={saveAll}
                disabled={!dirty || saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            )}
          </div>
        </div>
        {/* Tabs */}
        <div className='mt-2 flex gap-1'>
          {TABS.map((t) => (
            <button
              key={t.key}
              type='button'
              onClick={() => setTab(t.key)}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-3 pb-2 pt-1 text-[12px] font-medium transition-colors',
                tab === t.key
                  ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {t.label}
              {t.count !== undefined && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[10px] tabular-nums',
                    tab === t.key
                      ? 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                      : 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-muted-foreground'
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab content ── */}
      <div className='min-h-0 flex-1 overflow-y-auto px-6 py-5'>
        {tab === 'sources' && (
          <div className='mx-auto max-w-3xl space-y-3'>
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              Sources decide which items appear in this queue. Each source pulls from one place — a
              collection, tasks, or approvals — and can narrow by state, SLA, and field filters.
            </p>
            {sources.map((sc, i) => (
              <SourceRow
                extraFieldMeta={queue?.extra_field_meta ?? []}
                key={sc.id ?? `new-${i}`}
                index={i}
                source={sc}
                collectionOptions={collectionOptions}
                onChange={(next) => setSources(sources.map((x, xi) => (xi === i ? next : x)))}
                onRemove={() => setSources(sources.filter((_, xi) => xi !== i))}
                canEdit={canEdit}
              />
            ))}
            {sources.length === 0 && (
              <div className='rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-[12px] text-slate-400 dark:border-border'>
                No sources yet — this queue is empty until you add one.
              </div>
            )}
            {canEdit && (
              <button
                type='button'
                onClick={() =>
                  setSources([
                    ...sources,
                    {
                      type: 'collection',
                      collection: null,
                      filters: null,
                      state_values: null,
                      sla_filter: null,
                      extra_fields: [],
                      sort: sources.length
                    }
                  ])
                }
                className='flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-2.5 text-[12px] font-medium text-slate-500 transition-colors hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:text-muted-foreground dark:hover:border-nvr-cyan dark:hover:text-nvr-cyan'
              >
                <Plus className='h-3.5 w-3.5' /> Add source
              </button>
            )}
          </div>
        )}

        {tab === 'columns' && (
          <div className='mx-auto max-w-3xl space-y-6'>
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              Rename worklist table columns for everyone viewing this queue. Leave blank to keep the
              default label.
            </p>
            <div>
              <h3 className='mb-2 text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                Standard columns
              </h3>
              <div className='grid gap-x-8 gap-y-2 sm:grid-cols-2'>
                {aliasColumns.map(aliasRow)}
              </div>
            </div>
            {extraAliasColumns.length > 0 && (
              <div>
                <h3 className='mb-2 text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                  Columns from sources
                </h3>
                <div className='grid gap-x-8 gap-y-2 sm:grid-cols-2'>
                  {extraAliasColumns.map(aliasRow)}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div className='mx-auto max-w-3xl space-y-6'>
            <div className='space-y-3'>
              <label htmlFor='q-shared' className='flex cursor-pointer items-start gap-3'>
                <Checkbox
                  id='q-shared'
                  checked={isShared}
                  onCheckedChange={(v) => setIsShared(!!v)}
                  disabled={!canEdit}
                  className='mt-0.5'
                />
                <span>
                  <span className='block text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                    Shared with everyone
                  </span>
                  <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                    Anyone can open this queue. Off = only you (and admins) see it.
                  </span>
                </span>
              </label>
              <label htmlFor='q-claims' className='flex cursor-pointer items-start gap-3'>
                <Checkbox
                  id='q-claims'
                  checked={claimsEnabled}
                  onCheckedChange={(v) => setClaimsEnabled(!!v)}
                  disabled={!canEdit}
                  className='mt-0.5'
                />
                <span>
                  <span className='block text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                    Allow claiming items
                  </span>
                  <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                    Viewers can claim items to work on; Work Next auto-claims. Off hides all claim
                    controls.
                  </span>
                </span>
              </label>
            </div>

            <div className='space-y-3 border-t border-slate-200 pt-5 dark:border-border'>
              <h3 className='text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                Display
              </h3>
              <div className='space-y-2'>
                <span className='block text-[11px] font-medium uppercase tracking-wide text-slate-400'>
                  Views
                </span>
                {(['table', 'kanban', 'workload'] as const).map((v) => (
                  <label
                    key={v}
                    htmlFor={`q-view-${v}`}
                    className='flex cursor-pointer items-center gap-3'
                  >
                    <Checkbox
                      id={`q-view-${v}`}
                      checked={displayConfig.views.includes(v)}
                      disabled={!canEdit || v === 'table'}
                      onCheckedChange={(on) =>
                        setDisplayConfig((prev) => {
                          const views = (['table', 'kanban', 'workload'] as const).filter((k) =>
                            k === v ? !!on : prev.views.includes(k)
                          )
                          return {
                            ...prev,
                            views,
                            default_view: views.includes(prev.default_view)
                              ? prev.default_view
                              : 'table'
                          }
                        })
                      }
                    />
                    <span className='text-[13px] text-slate-800 dark:text-slate-100'>
                      {VIEW_LABELS[v]}
                      {v === 'table' && (
                        <span className='ml-1.5 text-[11px] text-slate-400'>always on</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              <div className='flex items-center gap-3'>
                <span className='w-40 shrink-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  Default view
                </span>
                <SimpleCombobox
                  value={displayConfig.default_view}
                  options={displayConfig.views.map((v) => ({ value: v, label: VIEW_LABELS[v] }))}
                  disabled={!canEdit}
                  onChange={(v) =>
                    setDisplayConfig((prev) => ({ ...prev, default_view: v as QueueViewKind }))
                  }
                />
              </div>
              <div className='flex items-center gap-3'>
                <span className='w-40 shrink-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  Default items scope
                </span>
                <SimpleCombobox
                  value={displayConfig.default_scope}
                  options={(['mine', 'unowned', 'all'] as const).map((s) => ({
                    value: s,
                    label: SCOPE_LABELS[s]
                  }))}
                  disabled={!canEdit}
                  onChange={(s) =>
                    setDisplayConfig((prev) => ({ ...prev, default_scope: s as QueueDefaultScope }))
                  }
                />
              </div>
              <label htmlFor='q-work-next' className='flex cursor-pointer items-start gap-3'>
                <Checkbox
                  id='q-work-next'
                  checked={displayConfig.work_next}
                  disabled={!canEdit}
                  onCheckedChange={(on) =>
                    setDisplayConfig((prev) => ({ ...prev, work_next: !!on }))
                  }
                  className='mt-0.5'
                />
                <span>
                  <span className='block text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                    Work Next button
                  </span>
                  <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                    Guided one-item-at-a-time triage from the table view.
                  </span>
                </span>
              </label>
              <label htmlFor='q-bulk-actions' className='flex cursor-pointer items-start gap-3'>
                <Checkbox
                  id='q-bulk-actions'
                  checked={displayConfig.bulk_actions}
                  disabled={!canEdit}
                  onCheckedChange={(on) =>
                    setDisplayConfig((prev) => ({ ...prev, bulk_actions: !!on }))
                  }
                  className='mt-0.5'
                />
                <span>
                  <span className='block text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                    Bulk actions
                  </span>
                  <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                    Row selection with bulk claim, release and transition.
                  </span>
                </span>
              </label>
            </div>

            {canEdit && (
              <div className='rounded-lg border border-red-200 p-4 dark:border-red-900/50'>
                <h3 className='text-[13px] font-medium text-red-700 dark:text-red-400'>
                  Delete this queue
                </h3>
                <p className='mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  Removes the queue, its saved views, and claims. Items themselves are untouched.
                </p>
                {confirmDelete ? (
                  <div className='mt-2 flex items-center gap-2'>
                    <Button
                      variant='destructive'
                      size='sm'
                      className='h-7 text-[12px]'
                      onClick={() => deleteMut.mutate()}
                      disabled={deleteMut.isPending}
                    >
                      Confirm delete
                    </Button>
                    <Button
                      variant='ghost'
                      size='sm'
                      className='h-7 text-[12px]'
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant='outline'
                    size='sm'
                    className='mt-2 h-7 border-red-200 text-[12px] text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:hover:bg-red-950/30'
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete Queue
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function QueuesPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data: queues = [], isLoading } = useQuery<Queue[]>({
    queryKey: ['queues'],
    queryFn: () => api.get('/queues').then((r) => r.data.data)
  })

  const createMut = useMutation({
    mutationFn: () => api.post('/queues', { name: 'New Queue' }).then((r) => r.data.data as Queue),
    onSuccess: (queue) => {
      qc.invalidateQueries({ queryKey: ['queues'] })
      setSelectedId(queue.id)
      toast.success('Queue created')
    },
    onError: () => toast.error('Failed to create queue')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
            Queues
          </h1>
          <Button size='sm' onClick={() => createMut.mutate()}>
            <Plus className='mr-1.5 h-3.5 w-3.5' /> New Queue
          </Button>
        </div>
      </div>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='flex w-[272px] shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {isLoading ? (
            <div className='p-4 text-[12px] text-slate-400'>Loading…</div>
          ) : (
            <ul>
              {queues.map((q) => (
                <QueueListItem
                  key={q.id}
                  queue={q}
                  selected={q.id === selectedId}
                  onSelect={() => setSelectedId(q.id)}
                />
              ))}
            </ul>
          )}
        </aside>
        <div className='flex flex-1 flex-col overflow-hidden bg-slate-50 dark:bg-background'>
          {selectedId ? (
            <QueueBuilder queueId={selectedId} onDeleted={() => setSelectedId(null)} />
          ) : (
            <div className='flex h-full items-center justify-center text-[13px] text-slate-400'>
              Select a queue or create a new one
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
