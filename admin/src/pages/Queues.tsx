import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Inbox, Plus, Trash2, X, Settings2 } from 'lucide-react'
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
    { enabled?: boolean; layout_id?: number | null; width?: number | null }
  > | null
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

interface Queue {
  id: string
  name: string
  description: string | null
  owner: string
  is_shared: boolean
  role_id: string | null
  view_mode: 'table' | 'kanban' | 'both'
  is_active: boolean
  claims_enabled: boolean
  column_aliases: Record<string, string>
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

function DrilldownChipConfig({
  path,
  targetCollection,
  cfg,
  onChange
}: {
  path: string
  targetCollection: string
  cfg: { enabled?: boolean; layout_id?: number | null; width?: number | null } | undefined
  onChange: (next: { enabled: boolean; layout_id: number | null; width: number | null }) => void
}) {
  const [open, setOpen] = useState(false)
  const { data: detailLayouts = [] } = useQuery<
    Array<{ id: number; name: string; layout_type?: string }>
  >({
    queryKey: ['detail-layouts', targetCollection],
    enabled: open,
    queryFn: () =>
      api
        .get(`/collection-layouts?collection=${targetCollection}`)
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
          aria-label={`Drill-down settings for ${path}`}
          className={cn(
            'ml-0.5 rounded-sm hover:opacity-100',
            enabled ? 'opacity-80 text-nvr-cyan' : 'opacity-40'
          )}
        >
          <Settings2 className='h-3 w-3' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] space-y-2 p-3' align='start'>
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
                No detail layouts on {targetCollection} yet — the panel falls back to a read-only
                view. Create one in Data Model → Layout.
              </p>
            )}
            <span className='text-[10px] text-slate-400'>Panel width</span>
            <select
              value={cfg?.width ?? 640}
              onChange={(e) =>
                onChange({
                  enabled: true,
                  layout_id: cfg?.layout_id ?? null,
                  width: Number(e.target.value) === 640 ? null : Number(e.target.value)
                })
              }
              className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-border dark:bg-background'
            >
              {DRILLDOWN_WIDTHS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ─── Source row editor ──────────────────────────────────────────────────────

function SourceRow({
  source,
  collectionOptions,
  extraFieldMeta,
  onChange,
  onRemove,
  canEdit
}: {
  source: QueueSource
  collectionOptions: { value: string; label: string }[]
  extraFieldMeta: Array<{ path: string; kind: 'relation' | 'plain'; target_collection?: string }>
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
    <div className='flex flex-col gap-2 rounded-md border border-slate-200 p-2 dark:border-border'>
      <div className='flex items-start gap-2'>
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
        <div className='space-y-1 pl-1'>
          <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            Extra columns
          </Label>
          <div className='flex flex-wrap items-center gap-1.5'>
            {currentExtraFields.map((f) => {
              const meta = extraFieldMeta.find((m) => m.path === f)
              return (
                <Badge key={f} className='gap-1 font-mono text-[11px]'>
                  {f}
                  {canEdit && meta?.kind === 'relation' && meta.target_collection && (
                    <DrilldownChipConfig
                      path={f}
                      targetCollection={meta.target_collection}
                      cfg={source.drilldown?.[f]}
                      onChange={(next) =>
                        onChange({ ...source, drilldown: { ...(source.drilldown ?? {}), [f]: next } })
                      }
                    />
                  )}
                  <button
                    type='button'
                    aria-label={`Remove ${f}`}
                    onClick={() =>
                      onChange({ ...source, extra_fields: currentExtraFields.filter((x) => x !== f) })
                    }
                    className='ml-0.5 rounded-sm opacity-60 hover:opacity-100'
                    disabled={!canEdit}
                  >
                    <X className='h-3 w-3' />
                  </button>
                </Badge>
              )
            })}
            {canEdit && currentExtraFields.length < 10 && source.collection && (
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
            {canEdit && currentExtraFields.length >= 10 && (
              <span className='text-[11px] text-slate-400'>
                10/10 columns — remove one to add another
              </span>
            )}
          </div>
        </div>
      )}
      {isCollection && states.length > 0 && (
        <div className='space-y-1 pl-1'>
          <div className='flex items-center gap-2'>
            <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>States</Label>
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
                {k === '__none__' ? '(No state)' : (states.find((s) => s.key === k)?.label ?? k)}
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
        <div className='space-y-1 pl-1'>
          <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>Filters</Label>
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
      {isCollection && (
        <div className='space-y-1 pl-1'>
          <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            Item label
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
            Empty = the collection's display template, then title/name/label/subject. Direct fields
            of this collection only.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Builder panel ──────────────────────────────────────────────────────────

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
  const [sources, setSources] = useState<QueueSource[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  if (queue && loadedFor !== queue.id) {
    setName(queue.name)
    setDescription(queue.description ?? '')
    setIsShared(queue.is_shared)
    setClaimsEnabled(queue.claims_enabled)
    setColumnAliases(queue.column_aliases ?? {})
    setSources(queue.sources)
    setLoadedFor(queue.id)
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
        column_aliases: columnAliases
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

  if (!queue) return <div className='p-6 text-[13px] text-slate-400'>Loading…</div>

  const canEdit = isAdmin || queue.owner === user?.id

  return (
    <div className='mx-auto max-w-2xl space-y-6 p-6'>
      <div className='flex items-center justify-between'>
        <h2 className='text-[15px] font-semibold text-slate-800 dark:text-slate-100'>Edit Queue</h2>
        <Link to={`/queues/${queueId}`}>
          <Button variant='outline' size='sm'>
            Open Worklist →
          </Button>
        </Link>
      </div>

      {!canEdit && (
        <p className='text-[11px] text-slate-400'>You do not own this queue — read only</p>
      )}

      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500'>Name</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className='h-9 text-[13px]'
          disabled={!canEdit}
        />
      </div>

      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500'>Description</Label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className='text-[13px]'
          rows={2}
          disabled={!canEdit}
        />
      </div>

      <div className='flex items-center gap-2'>
        <Checkbox
          checked={isShared}
          onCheckedChange={(v) => setIsShared(!!v)}
          id='is-shared'
          disabled={!canEdit}
        />
        <Label htmlFor='is-shared' className='text-[12px] text-slate-600'>
          Shared with everyone
        </Label>
      </div>

      <div className='flex items-center gap-2'>
        <Checkbox
          checked={claimsEnabled}
          onCheckedChange={(v) => setClaimsEnabled(!!v)}
          id='claims-enabled'
          disabled={!canEdit}
        />
        <Label htmlFor='claims-enabled' className='text-[12px] text-slate-600'>
          Allow claiming items
        </Label>
      </div>

      <div>
        <Label className='mb-1 block text-[12px] text-slate-600'>Column aliases</Label>
        <p className='mb-2 text-[11px] text-slate-400'>
          Rename the worklist table columns for everyone viewing this queue. Blank = default.
        </p>
        <div className='space-y-1.5'>
          {[
            { key: 'label', label: 'Item' },
            { key: 'collection', label: 'Collection' },
            { key: 'state', label: 'State' },
            { key: 'owners', label: 'Owners' },
            { key: 'aging_hours', label: 'Aging' },
            { key: 'sla_status', label: 'SLA' },
            { key: 'at_risk', label: 'Risk' },
            ...[...new Set(sources.flatMap((s) => s.extra_fields ?? []))].map((f) => ({
              key: `extra.${f}`,
              label: f
                .split('.')
                .map((seg) => seg.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
                .join(' → ')
            }))
          ].map((col) => (
            <div key={col.key} className='flex items-center gap-2'>
              <span className='w-40 shrink-0 truncate text-[11px] text-slate-500'>{col.label}</span>
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
                className='h-7 max-w-[240px] text-[12px]'
              />
            </div>
          ))}
        </div>
      </div>

      {canEdit && (
        <Button size='sm' onClick={() => saveMetaMut.mutate()} disabled={saveMetaMut.isPending}>
          Save Details
        </Button>
      )}

      <div className='border-t border-slate-100 pt-4 dark:border-border'>
        <div className='mb-2 flex items-center justify-between'>
          <Label className='text-[11px] text-slate-500'>Sources</Label>
          {canEdit && (
            <Button
              variant='outline'
              size='sm'
              className='h-7 gap-1 text-[11px]'
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
            >
              <Plus className='h-3 w-3' /> Add source
            </Button>
          )}
        </div>
        <div className='space-y-2'>
          {sources.map((s, i) => (
            <SourceRow
              extraFieldMeta={queue?.extra_field_meta ?? []}
              key={s.id ?? `new-${i}`}
              source={s}
              collectionOptions={collectionOptions}
              onChange={(next) => setSources(sources.map((x, xi) => (xi === i ? next : x)))}
              onRemove={() => setSources(sources.filter((_, xi) => xi !== i))}
              canEdit={canEdit}
            />
          ))}
        </div>
        {canEdit && (
          <Button
            size='sm'
            className='mt-3'
            onClick={() => saveSourcesMut.mutate()}
            disabled={saveSourcesMut.isPending}
          >
            Save Sources
          </Button>
        )}
      </div>

      {canEdit && (
        <div className='border-t border-slate-100 pt-4 dark:border-border'>
          <Button
            variant='destructive'
            size='sm'
            onClick={() => deleteMut.mutate()}
            disabled={deleteMut.isPending}
          >
            Delete Queue
          </Button>
        </div>
      )}
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
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
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
