import type { Modifier } from '@dnd-kit/core'
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  CornerDownLeft,
  Crosshair,
  Eye,
  EyeOff,
  GripVertical,
  Key,
  Languages,
  Lock,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
  Users,
  X
} from 'lucide-react'

const snapLeftEdgeToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (draggingNodeRect && activatorEvent && 'clientX' in activatorEvent) {
    const e = activatorEvent as PointerEvent
    return {
      ...transform,
      x: transform.x + e.clientX - draggingNodeRect.left,
      y: transform.y + e.clientY - (draggingNodeRect.top + draggingNodeRect.height / 2)
    }
  }
  return transform
}

import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS as DndCSS } from '@dnd-kit/utilities'
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { DisplayTemplateEditor } from '@/components/display-template-editor'
import {
  CollectionFieldPicker,
  CollectionFieldPickerPanel,
  FieldPicker,
  FieldPickerPanel,
  type PickedField
} from '@/components/field-picker'
import { FormulaBuilder } from '@/components/formula-builder'
import { IconPicker } from '@/components/icon-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { usePersistedTab } from '@/hooks/usePersistedTab'
import { api, type CMSField, type CMSRelation } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import {
  CHOICE_INTERFACES,
  type Choice,
  COLOR_INTERFACES,
  DATETIME_INTERFACES,
  FIELD_TYPES,
  getDefaultDisplay,
  getDefaultInterface,
  getDisplays,
  getInterfaces,
  type LabelChoice,
  parseJson,
  SLIDER_INTERFACES
} from '@/lib/field-config'
import { extractTemplateFields, renderDisplayTemplate } from '@/lib/relations'
import {
  type CMSRelationRow,
  type CreateColumnBody,
  type DBColumn,
  type DBTableDetail,
  type DBTableSummary,
  detectRelationType,
  type RelationType,
  schemaApi
} from '@/lib/schema-api'
import { cn, resolveCollectionIcon, titleCase } from '@/lib/utils'
import { TreeSection } from '@/pages/DataModel'
import { FieldRulesSection } from '@/pages/FieldRulesSection'
import { ImportTemplatesSection } from '@/pages/ImportTemplatesSection'

// ─── Formula mode toggle (Builder | Raw) ─────────────────────────────────────

function FormulaModeToggle({
  mode,
  onChange
}: {
  mode: 'builder' | 'raw'
  onChange: (m: 'builder' | 'raw') => void
}) {
  return (
    <div className='inline-flex overflow-hidden rounded-md border border-slate-200 dark:border-slate-700'>
      {(['builder', 'raw'] as const).map((m) => (
        <button
          key={m}
          type='button'
          onClick={() => onChange(m)}
          className={cn(
            'px-2.5 py-1 text-[11px] font-medium capitalize transition-colors',
            mode === m
              ? 'bg-nvr-cyan/10 text-nvr-cyan'
              : 'bg-white text-slate-500 hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800'
          )}
        >
          {m}
        </button>
      ))}
    </div>
  )
}

// ─── Data type badge colors ───────────────────────────────────────────────────

const TYPE_STYLES: Record<string, string> = {
  int: 'bg-blue-50 text-blue-700',
  bigint: 'bg-blue-50 text-blue-700',
  smallint: 'bg-blue-50 text-blue-700',
  tinyint: 'bg-blue-50 text-blue-700',
  integer: 'bg-blue-50 text-blue-700',
  nvarchar: 'bg-slate-100 text-slate-600',
  varchar: 'bg-slate-100 text-slate-600',
  char: 'bg-slate-100 text-slate-600',
  nchar: 'bg-slate-100 text-slate-600',
  text: 'bg-slate-100 text-slate-600',
  ntext: 'bg-slate-100 text-slate-600',
  bit: 'bg-purple-50 text-purple-700',
  boolean: 'bg-purple-50 text-purple-700',
  datetime: 'bg-amber-50 text-amber-700',
  datetime2: 'bg-amber-50 text-amber-700',
  date: 'bg-amber-50 text-amber-700',
  time: 'bg-amber-50 text-amber-700',
  timestamp: 'bg-amber-50 text-amber-700',
  decimal: 'bg-green-50 text-green-700',
  numeric: 'bg-green-50 text-green-700',
  float: 'bg-green-50 text-green-700',
  real: 'bg-green-50 text-green-700',
  money: 'bg-green-50 text-green-700',
  uniqueidentifier: 'bg-orange-50 text-orange-700'
}

function TypeBadge({ type }: { type: string }) {
  const style = TYPE_STYLES[type.toLowerCase()] ?? 'bg-slate-100 text-slate-500'
  return (
    <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10.5px] font-medium', style)}>
      {type}
    </span>
  )
}

// ─── Combobox (shadcn Popover + Command) ──────────────────────────────────────

function Combobox({
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
          className='h-7 w-full justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
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

// ─── O2MAggFieldCombobox ──────────────────────────────────────────────────────

function O2MAggFieldCombobox({
  relatedCollection,
  value,
  onChange
}: {
  relatedCollection: string | null
  value: string
  onChange: (fieldName: string, fieldOptions: string | null) => void
}) {
  const { data } = useQuery<{ data: Array<{ field: string; type: string; options: unknown }> }>({
    queryKey: ['field-config', relatedCollection],
    queryFn: () => api.get(`/field-config/${relatedCollection}`).then((r) => r.data),
    enabled: !!relatedCollection,
    staleTime: 120_000
  })
  const fields = (data?.data ?? []).filter((f) => !f.field.startsWith('_'))
  const options = fields.map((f) => ({ value: f.field, label: f.field }))
  return (
    <Combobox
      value={value}
      onChange={(v) => {
        const field = fields.find((f) => f.field === v)
        const opts = field?.options
          ? typeof field.options === 'string'
            ? field.options
            : JSON.stringify(field.options)
          : null
        onChange(v, opts)
      }}
      options={options}
      placeholder='Select column…'
    />
  )
}

// ─── Rollup computed config ────────────────────────────────────────────────────

type RollupAggregate = 'sum' | 'count' | 'avg' | 'min' | 'max'

interface RollupSourceConfig {
  related_collection: string
  fk_field: string
  aggregate: RollupAggregate
  value_field: string
  recursive?: boolean
}

interface RollupConfig {
  sources: RollupSourceConfig[]
}

const ROLLUP_AGGREGATE_OPTIONS: { value: RollupAggregate; label: string }[] = [
  { value: 'sum', label: 'sum' },
  { value: 'count', label: 'count' },
  { value: 'avg', label: 'avg' },
  { value: 'min', label: 'min' },
  { value: 'max', label: 'max' }
]

const EMPTY_ROLLUP_SOURCE: RollupSourceConfig = {
  related_collection: '',
  fk_field: '',
  aggregate: 'sum',
  value_field: '',
  recursive: false
}

function emptyRollup(): RollupConfig {
  return { sources: [{ ...EMPTY_ROLLUP_SOURCE }] }
}

// Accepts both the legacy single-source object shape and `{ sources: [...] }`
// — mirrors api/src/services/rollups.ts parseRollupFormula exactly, so a
// formula written by either shape loads into the same row-list UI.
function parseRollup(formula: string | null | undefined): RollupConfig {
  if (!formula) return emptyRollup()
  try {
    const parsed = JSON.parse(formula) as Record<string, unknown>
    const rawSources = Array.isArray(parsed?.sources) ? parsed.sources : [parsed]
    const sources = (rawSources as Partial<RollupSourceConfig>[]).map((s) => ({
      ...EMPTY_ROLLUP_SOURCE,
      ...s
    }))
    return { sources: sources.length ? sources : [{ ...EMPTY_ROLLUP_SOURCE }] }
  } catch {
    return emptyRollup()
  }
}

// Serializes back to the legacy single-source object when there's exactly one
// source (round-trip safe with older formulas), else `{ sources: [...] }`.
function serializeRollup(cfg: RollupConfig): string {
  if (cfg.sources.length === 1) return JSON.stringify(cfg.sources[0])
  return JSON.stringify({ sources: cfg.sources })
}

function isRollupSourceValid(cfg: RollupSourceConfig): boolean {
  if (!cfg.related_collection || !cfg.fk_field) return false
  if (cfg.aggregate !== 'count' && !cfg.value_field) return false
  return true
}

function isRollupValid(cfg: RollupConfig): boolean {
  return cfg.sources.length > 0 && cfg.sources.every(isRollupSourceValid)
}

const NUMERIC_COLUMN_TYPES = new Set(['integer', 'bigInteger', 'decimal', 'float'])

// A stored rollup's physical column must hold a real DB column type; the
// generic Type picker defaults to 'string', which is wrong for an aggregate.
// Keep the user's choice when it's already numeric-ish, else fall back to decimal.
function rollupColumnType(t: string): CreateColumnBody['type'] {
  return NUMERIC_COLUMN_TYPES.has(t) ? (t as CreateColumnBody['type']) : 'decimal'
}

function RollupSourceRow({
  source,
  currentCollection,
  onChange,
  onRemove
}: {
  source: RollupSourceConfig
  currentCollection: string
  onChange: (next: RollupSourceConfig) => void
  onRemove?: () => void
}) {
  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () =>
      api.get<{ data: { collection: string }[] }>('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })

  const { data: relatedMeta } = useQuery({
    queryKey: ['collection-meta', source.related_collection],
    queryFn: () =>
      api
        .get<{ data: { fields: { field: string; type: string; hidden?: boolean }[] } }>(
          `/collections/${source.related_collection}`
        )
        .then((r) => r.data.data),
    enabled: !!source.related_collection,
    staleTime: 30_000
  })

  const collections = collectionsData ?? []
  const relatedFields = (relatedMeta?.fields ?? []).filter((f) => !f.hidden)
  const fieldOptions = relatedFields.map((f) => ({
    value: f.field,
    label: `${f.field} (${f.type})`
  }))
  const isSameCollection =
    !!source.related_collection && source.related_collection === currentCollection

  return (
    <div className='space-y-3 rounded-md border border-slate-200 bg-white p-3'>
      <div className='grid grid-cols-2 gap-3'>
        {/* Related collection */}
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Related collection</Label>
          <Combobox
            value={source.related_collection}
            onChange={(v) =>
              onChange({
                ...source,
                related_collection: v,
                fk_field: '',
                value_field: '',
                // recursive only valid when same collection — clear if it no longer applies
                recursive: v === currentCollection ? source.recursive : false
              })
            }
            options={collections.map((c) => ({ value: c.collection, label: c.collection }))}
            placeholder='Select collection…'
          />
        </div>

        {/* FK field */}
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>FK field</Label>
          <Combobox
            value={source.fk_field}
            onChange={(v) => onChange({ ...source, fk_field: v })}
            options={fieldOptions}
            placeholder={source.related_collection ? 'Select field…' : 'Select collection first'}
            disabled={!source.related_collection}
          />
        </div>

        {/* Aggregate function */}
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Aggregate</Label>
          <Combobox
            value={source.aggregate}
            onChange={(v) => onChange({ ...source, aggregate: (v || 'sum') as RollupAggregate })}
            options={ROLLUP_AGGREGATE_OPTIONS}
            placeholder='Select function…'
          />
        </div>

        {/* Value field */}
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Value field</Label>
          <Combobox
            value={source.value_field}
            onChange={(v) => onChange({ ...source, value_field: v })}
            options={fieldOptions}
            placeholder={
              source.aggregate === 'count'
                ? 'Not used for count'
                : source.related_collection
                  ? 'Select field…'
                  : 'Select collection first'
            }
            disabled={source.aggregate === 'count' || !source.related_collection}
          />
        </div>
      </div>

      {/* Recursive — only when aggregating the same collection (tree) */}
      {isSameCollection && (
        <label className='flex cursor-pointer items-center gap-1.5 text-[12px]'>
          <input
            type='checkbox'
            checked={!!source.recursive}
            onChange={(e) => onChange({ ...source, recursive: e.target.checked })}
            className='rounded'
          />
          Recursive — aggregate all descendants at any depth (same-collection tree)
        </label>
      )}

      <div className='flex items-center justify-between'>
        <p className='text-[11px] text-slate-400'>
          FK field is the column on{' '}
          <code className='rounded bg-slate-100 px-1'>
            {source.related_collection || 'the related collection'}
          </code>{' '}
          that points to this item's id.
        </p>
        {onRemove && (
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-6 shrink-0 px-2 text-[11px] text-destructive hover:text-destructive'
            onClick={onRemove}
          >
            <Trash2 className='mr-1 h-3 w-3' />
            Remove source
          </Button>
        )}
      </div>
    </div>
  )
}

function RollupConfigEditor({
  config,
  currentCollection,
  onChange,
  computedStore,
  onComputedStoreChange
}: {
  config: RollupConfig
  currentCollection: string
  onChange: (next: RollupConfig) => void
  computedStore: boolean
  onComputedStoreChange: (next: boolean) => void
}) {
  const updateSource = (i: number, next: RollupSourceConfig) => {
    onChange({ sources: config.sources.map((s, idx) => (idx === i ? next : s)) })
  }
  const addSource = () => {
    onChange({ sources: [...config.sources, { ...EMPTY_ROLLUP_SOURCE }] })
  }
  const removeSource = (i: number) => {
    onChange({ sources: config.sources.filter((_, idx) => idx !== i) })
  }

  return (
    <div className='space-y-3'>
      <p className='text-[11px] text-slate-400'>
        Aggregate values from related items in one or more collections — each source's aggregate
        is summed together.
      </p>

      <div className='space-y-2'>
        {config.sources.map((source, i) => (
          <RollupSourceRow
            // biome-ignore lint/suspicious/noArrayIndexKey: sources are positional
            key={i}
            source={source}
            currentCollection={currentCollection}
            onChange={(next) => updateSource(i, next)}
            onRemove={config.sources.length > 1 ? () => removeSource(i) : undefined}
          />
        ))}
      </div>

      <Button
        type='button'
        variant='outline'
        size='sm'
        className='h-7 text-[12px]'
        onClick={addSource}
      >
        <Plus className='mr-1 h-3 w-3' />
        Add source
      </Button>

      <div className='flex items-center justify-between rounded-md border border-slate-200 bg-white p-3'>
        <div>
          <p className='text-[11px] font-medium text-slate-600'>
            Store value (recalculate on writes)
          </p>
          <p className='text-[11px] text-slate-400'>
            Off: computed fresh on every read. On: cached in the DB column and recalculated
            whenever a contributing row changes.
          </p>
        </div>
        <Switch checked={computedStore} onCheckedChange={onComputedStoreChange} />
      </div>
    </div>
  )
}

// ─── SQL type → abstract Knex type ───────────────────────────────────────────

function normalizeDataType(col: { data_type: string; max_length: number | null }): string {
  const t = col.data_type.toLowerCase()
  if (t === 'nvarchar' || t === 'varchar' || t === 'char' || t === 'nchar') {
    return col.max_length === -1 ? 'text' : 'string'
  }
  if (t === 'ntext' || t === 'text') return 'text'
  if (t === 'int') return 'integer'
  if (t === 'bigint') return 'bigInteger'
  if (t === 'bit') return 'boolean'
  if (t === 'decimal' || t === 'numeric') return 'decimal'
  if (t === 'float' || t === 'real') return 'float'
  if (t === 'date') return 'date'
  if (t === 'datetime' || t === 'datetime2' || t === 'smalldatetime') return 'datetime'
  if (t === 'time') return 'time'
  if (t === 'uniqueidentifier') return 'uuid'
  if (t === 'json') return 'json'
  return t
}

// ─── Add column form ──────────────────────────────────────────────────────────

const NUMERIC_DATA_TYPES = new Set([
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'decimal',
  'numeric',
  'float',
  'real',
  'money',
  'smallmoney',
  'integer',
  'double'
])

const COLUMN_TYPES = [
  'string',
  'text',
  'integer',
  'bigInteger',
  'boolean',
  'decimal',
  'float',
  'date',
  'datetime',
  'uuid'
] as const

function AddColumnForm({
  table,
  onSuccess,
  onCancel
}: {
  table: string
  onSuccess: () => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<CreateColumnBody>({
    name: '',
    type: 'string',
    nullable: true,
    default_value: null,
    max_length: undefined
  })
  const [fieldInterface, setFieldInterfaceRaw] = useState(() => getDefaultInterface('string'))
  const [note, setNote] = useState('')
  const [hidden, setHidden] = useState(false)
  const [readonly, setReadonly] = useState(false)
  const [required, setRequired] = useState(false)
  const [computedEnabled, setComputedEnabled] = useState(false)
  const [computedType, setComputedType] = useState<'read' | 'write' | 'rollup'>('read')
  const [computedFormula, setComputedFormula] = useState('')
  const [computedStore, setComputedStore] = useState(false)
  const [rollup, setRollup] = useState<RollupConfig>(emptyRollup)
  const [formulaMode, setFormulaMode] = useState<'builder' | 'raw'>('builder')
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof CreateColumnBody>(k: K, v: CreateColumnBody[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  function setFormType(t: string) {
    set('type', t as CreateColumnBody['type'])
    const ifaces = getInterfaces(t)
    const current = ifaces.find((i) => i.value === fieldInterface)
    if (!current) setFieldInterfaceRaw(ifaces[0]?.value ?? '')
  }

  // Read-time computed is always virtual. A rollup is virtual only while
  // unstored — a stored rollup needs a real physical column, same as 'write'.
  const isRollup = computedEnabled && computedType === 'rollup'
  const isStoredRollup = isRollup && computedStore
  const isVirtual = computedEnabled && (computedType === 'read' || (isRollup && !computedStore))

  // Stored value of computed_formula depends on type (JSON for rollup).
  const computedFormulaValue = isRollup ? serializeRollup(rollup) : computedFormula.trim()
  const computedReady = isRollup ? isRollupValid(rollup) : !!computedFormula.trim()

  // A stored rollup's DB column must be numeric — the generic Type picker
  // defaults to 'string', which is wrong for an aggregate; fall back to
  // decimal when the picker isn't already holding a numeric type.
  const columnType = isStoredRollup ? rollupColumnType(form.type) : form.type

  const addInterfaces = getInterfaces(form.type)

  const handleSubmit = async () => {
    if (!form.name) return
    setSaving(true)
    try {
      if (!isVirtual) {
        await schemaApi.addColumn(table, { ...form, type: columnType })
      }
      // Always save field metadata (interface, note, visibility flags)
      await api.post(`/collections/${table}/fields`, {
        field: form.name,
        type: columnType,
        interface: fieldInterface || null,
        note: note || null,
        hidden,
        readonly,
        required,
        ...(computedEnabled && computedReady
          ? {
              computed_formula: computedFormulaValue,
              computed_type: computedType,
              computed_store: computedType === 'write' || computedType === 'rollup' ? computedStore : false
            }
          : {})
      })
      if (isStoredRollup && computedReady) {
        // Fire-and-forget backfill — the column starts NULL/0 otherwise until
        // the next write to a contributing row triggers a recalc.
        api.post(`/data-model/${table}/fields/${form.name}/rollup-recalc`).catch(() => {
          toast.error(`"${form.name}" was added, but backfilling existing rows failed — recalc it manually`)
        })
      }
      toast.success(`${isVirtual ? 'Computed field' : 'Column'} "${form.name}" added`)
      onSuccess()
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to add column'
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='border-t border-slate-200 bg-slate-50 p-4'>
      <p className='mb-3 text-[12px] font-medium text-slate-500'>Add Column</p>
      <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
        <div>
          <Label className='mb-1 block text-[11px]'>Column name</Label>
          <Input
            value={form.name}
            onChange={(e) => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
            placeholder='column_name'
            className='h-7 font-mono text-[12px]'
          />
        </div>
        <div>
          <Label className='mb-1 block text-[11px]'>{isVirtual ? 'Display type' : 'Type'}</Label>
          <Sel
            value={form.type}
            onChange={setFormType}
            options={FIELD_TYPES.map((ft) => ({
              value: ft.value,
              label: ft.label,
              group: ft.group
            }))}
            placeholder='Select type…'
          />
        </div>
        <div>
          <Label className='mb-1 block text-[11px]'>Interface</Label>
          <Sel
            value={fieldInterface}
            onChange={setFieldInterfaceRaw}
            options={addInterfaces}
            placeholder='Select interface…'
          />
        </div>
        {form.type === 'string' && !isVirtual && (
          <div>
            <Label className='mb-1 block text-[11px]'>Max length</Label>
            <Input
              type='number'
              value={form.max_length ?? ''}
              onChange={(e) =>
                set('max_length', e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder='255'
              className='h-7 text-[12px]'
            />
          </div>
        )}
        {(form.type === 'decimal' || form.type === 'float') && !isVirtual && (
          <div>
            <Label className='mb-1 block text-[11px]'>Precision</Label>
            <Input
              type='number'
              min={1}
              max={form.type === 'float' ? 53 : 38}
              value={form.precision ?? ''}
              onChange={(e) =>
                set('precision', e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder={form.type === 'float' ? '8' : '10'}
              className='h-7 text-[12px]'
            />
          </div>
        )}
        {form.type === 'decimal' && !isVirtual && (
          <div>
            <Label className='mb-1 block text-[11px]'>Scale</Label>
            <Input
              type='number'
              min={0}
              max={form.precision ?? 10}
              value={form.scale ?? ''}
              onChange={(e) => set('scale', e.target.value ? Number(e.target.value) : undefined)}
              placeholder='2'
              className='h-7 text-[12px]'
            />
          </div>
        )}
        {!isVirtual && (
          <div>
            <Label className='mb-1 block text-[11px]'>Default value</Label>
            <Input
              value={
                form.default_value !== null && form.default_value !== undefined
                  ? String(form.default_value)
                  : ''
              }
              onChange={(e) => set('default_value', e.target.value || null)}
              placeholder='none'
              className='h-7 text-[12px]'
            />
          </div>
        )}
      </div>

      {/* Computed formula */}
      <div className='mt-3 rounded-md border border-slate-200 bg-white p-3'>
        <div className='mb-2 flex items-center justify-between'>
          <p className='text-[11px] font-medium text-slate-600'>Computed Formula</p>
          <label className='flex cursor-pointer items-center gap-1.5 text-[12px]'>
            <input
              type='checkbox'
              checked={computedEnabled}
              onChange={(e) => setComputedEnabled(e.target.checked)}
              className='rounded'
            />
            Enable
          </label>
        </div>
        {computedEnabled && (
          <div className='space-y-2.5'>
            <div className='flex items-center gap-4 text-[12px]'>
              <span className='text-[11px] text-slate-500'>Evaluate on:</span>
              <label className='flex cursor-pointer items-center gap-1.5'>
                <input
                  type='radio'
                  name='new-computed-type'
                  value='read'
                  checked={computedType === 'read'}
                  onChange={() => setComputedType('read')}
                />
                Read (virtual)
              </label>
              <label className='flex cursor-pointer items-center gap-1.5'>
                <input
                  type='radio'
                  name='new-computed-type'
                  value='write'
                  checked={computedType === 'write'}
                  onChange={() => setComputedType('write')}
                />
                Write (before save)
              </label>
              <label className='flex cursor-pointer items-center gap-1.5'>
                <input
                  type='radio'
                  name='new-computed-type'
                  value='rollup'
                  checked={computedType === 'rollup'}
                  onChange={() => setComputedType('rollup')}
                />
                Rollup (aggregate)
              </label>
            </div>
            {isVirtual && (
              <p className='text-[11px] text-slate-400'>
                No database column will be created — value is computed fresh on every GET.
              </p>
            )}
            {isRollup ? (
              <RollupConfigEditor
                config={rollup}
                currentCollection={table}
                onChange={setRollup}
                computedStore={computedStore}
                onComputedStoreChange={setComputedStore}
              />
            ) : (
              <>
                <div>
                  <div className='mb-1 flex items-center justify-between'>
                    <Label className='block text-[11px]'>Formula</Label>
                    <FormulaModeToggle mode={formulaMode} onChange={setFormulaMode} />
                  </div>
                  {formulaMode === 'builder' ? (
                    <FormulaBuilder
                      collection={table}
                      value={computedFormula}
                      onChange={setComputedFormula}
                    />
                  ) : (
                    <textarea
                      value={computedFormula}
                      onChange={(e) => setComputedFormula(e.target.value)}
                      rows={2}
                      placeholder={
                        computedType === 'read'
                          ? 'e.g. item.price * 1.2'
                          : 'e.g. concat(item.first_name, " ", item.last_name)'
                      }
                      className='w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 font-mono text-[12px] text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
                      spellCheck={false}
                    />
                  )}
                  <p className='mt-1 text-[11px] text-slate-400'>
                    Use <code className='rounded bg-slate-100 px-1'>item.fieldName</code> to
                    reference fields on the record.
                  </p>
                </div>
                {computedType === 'write' && (
                  <label className='flex cursor-pointer items-center gap-1.5 text-[12px]'>
                    <input
                      type='checkbox'
                      checked={computedStore}
                      onChange={(e) => setComputedStore(e.target.checked)}
                      className='rounded'
                    />
                    Store result in database column
                  </label>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Note */}
      <div className='mt-3'>
        <Label className='mb-1 block text-[11px]'>Note</Label>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className='h-7 text-[12px]'
          placeholder='Helper text for editors'
        />
      </div>

      <div className='mt-3 flex flex-wrap items-center gap-4 text-[12px]'>
        {!isVirtual && (
          <label className='flex cursor-pointer items-center gap-1.5'>
            <input
              type='checkbox'
              checked={form.nullable !== false}
              onChange={(e) => set('nullable', e.target.checked)}
              className='rounded'
            />
            Nullable
          </label>
        )}
        {!isVirtual && (
          <label className='flex cursor-pointer items-center gap-1.5'>
            <input
              type='checkbox'
              checked={form.unique === true}
              onChange={(e) => set('unique', e.target.checked || undefined)}
              className='rounded'
            />
            Unique
          </label>
        )}
        <label className='flex cursor-pointer items-center gap-1.5'>
          <input
            type='checkbox'
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
            className='rounded'
          />
          Hidden
        </label>
        <label className='flex cursor-pointer items-center gap-1.5'>
          <input
            type='checkbox'
            checked={readonly}
            onChange={(e) => setReadonly(e.target.checked)}
            className='rounded'
          />
          Read-only
        </label>
        <label className='flex cursor-pointer items-center gap-1.5'>
          <input
            type='checkbox'
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className='rounded'
          />
          Required
        </label>
        <div className='ml-auto flex gap-2'>
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='h-7 text-[12px]'
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type='button'
            size='sm'
            className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
            disabled={form.name.length < 1 || saving || (computedEnabled && !computedReady)}
            onClick={handleSubmit}
          >
            {saving ? 'Adding…' : isVirtual ? 'Add Computed Field' : 'Add Column'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Fields tab ───────────────────────────────────────────────────────────────

function FieldsTab({
  tableData,
  tableName,
  onRefresh,
  isSystem = false,
  extendMode = false,
  onExtendModeChange
}: {
  tableData: DBTableDetail
  tableName: string
  onRefresh: () => void
  isSystem?: boolean
  extendMode?: boolean
  onExtendModeChange?: (v: boolean) => void
}) {
  const qc = useQueryClient()
  const [addingColumn, setAddingColumn] = useState(false)

  const dropColumn = useMutation({
    mutationFn: (col: string) => schemaApi.dropColumn(tableName, col),
    onSuccess: (_, col) => {
      toast.success(`Column "${col}" dropped`)
      qc.invalidateQueries({ queryKey: ['data-model-table', tableName] })
      onRefresh()
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to drop column'
      toast.error(msg)
    }
  })

  const columns = tableData.columns

  return (
    <div className='space-y-3'>
      {/* System table banner */}
      {isSystem && (
        <div className='flex items-center justify-between gap-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3'>
          <div>
            <p className='text-[12px] font-medium text-amber-800'>
              System table — schema changes restricted
            </p>
            <p className='text-[11px] text-amber-600 mt-0.5'>
              {extendMode
                ? 'Extend mode active. You can add columns and modify columns you created.'
                : 'Original columns are protected. Enable extend mode to add new columns.'}
            </p>
          </div>
          <button
            type='button'
            onClick={() => onExtendModeChange?.(!extendMode)}
            className={cn(
              'shrink-0 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
              extendMode
                ? 'bg-amber-200 text-amber-900 hover:bg-amber-300'
                : 'bg-amber-100 text-amber-800 hover:bg-amber-200'
            )}
          >
            {extendMode ? 'Exit extend mode' : 'Extend table →'}
          </button>
        </div>
      )}

      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
        {/* Column rows */}
        {columns.map((col, i) => (
          <ColumnRow
            key={col.name}
            col={col}
            tableName={tableName}
            isFirst={i === 0}
            isSystem={isSystem}
            canDrop={!isSystem || (extendMode && !!col.field_meta)}
            onDrop={() => {
              if (confirm(`Drop column "${col.name}"? This cannot be undone.`)) {
                dropColumn.mutate(col.name)
              }
            }}
            onRefresh={onRefresh}
          />
        ))}

        {columns.length === 0 && !addingColumn && (
          <div className='px-4 py-8 text-center text-[13px] text-slate-400'>No columns found</div>
        )}

        {/* Add column inline form — hidden for system tables unless extend mode */}
        {(!isSystem || extendMode) &&
          (addingColumn ? (
            <AddColumnForm
              table={tableName}
              onSuccess={() => {
                setAddingColumn(false)
                qc.invalidateQueries({ queryKey: ['data-model-table', tableName] })
              }}
              onCancel={() => setAddingColumn(false)}
            />
          ) : (
            <div className='border-t border-slate-100 px-4 py-2.5'>
              <button
                type='button'
                onClick={() => setAddingColumn(true)}
                className='flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-nvr-cyan'
              >
                <Plus className='h-3.5 w-3.5' />
                Add column
              </button>
            </div>
          ))}
      </div>
    </div>
  )
}

function ColumnRow({
  col,
  tableName,
  isFirst,
  onDrop,
  onRefresh,
  isSystem = false,
  canDrop = true
}: {
  col: DBColumn
  tableName: string
  isFirst: boolean
  onDrop: () => void
  onRefresh: () => void
  isSystem?: boolean
  canDrop?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const qc = useQueryClient()

  const removeFieldMeta = useMutation({
    mutationFn: () => schemaApi.removeFieldMeta(tableName, col.name),
    onSuccess: () => {
      toast.success('Field metadata removed')
      qc.invalidateQueries({ queryKey: ['data-model-table', tableName] })
      onRefresh()
    },
    onError: () => toast.error('Failed to remove field metadata')
  })

  const addFieldMeta = useMutation({
    mutationFn: (body: Record<string, unknown>) => schemaApi.addFieldMeta(tableName, body),
    onSuccess: () => {
      toast.success('Field metadata saved')
      qc.invalidateQueries({ queryKey: ['data-model-table', tableName] })
      onRefresh()
    },
    onError: () => toast.error('Failed to save field metadata')
  })

  const isProtected = isSystem && !col.field_meta

  return (
    <div className={cn(!isFirst && 'border-t border-slate-100')}>
      <div
        className={cn(
          'group flex items-center gap-3 px-4 py-2.5',
          isProtected ? 'opacity-40 cursor-default' : 'hover:bg-slate-50'
        )}
      >
        {/* PK indicator */}
        <div className='flex w-4 shrink-0 justify-center'>
          {col.is_primary_key && (
            <span title='Primary key'>
              <Key className='h-3 w-3 text-amber-500' />
            </span>
          )}
        </div>

        {/* Column name */}
        <span className='min-w-[160px] font-mono text-[12.5px] font-medium text-slate-900'>
          {col.name}
        </span>

        {/* Type */}
        {col.is_virtual ? (
          <span className='inline-flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:bg-violet-900/30 dark:text-violet-400'>
            virtual computed
          </span>
        ) : (
          <TypeBadge type={col.data_type} />
        )}

        {/* Nullable */}
        {!col.is_virtual && (
          <span className='text-[11px] text-slate-400'>
            {col.nullable ? 'nullable' : 'not null'}
          </span>
        )}

        {/* Field meta hints */}
        {col.field_meta && (
          <div className='flex items-center gap-1.5'>
            {col.field_meta.hidden && (
              <span title='Hidden'>
                <EyeOff className='h-3 w-3 text-slate-400' />
              </span>
            )}
            {col.field_meta.required && (
              <span className='text-[10px] font-semibold text-rose-500'>required</span>
            )}
          </div>
        )}

        {/* Protected system column indicator */}
        {isProtected && (
          <div className='ml-auto'>
            <Lock className='h-3 w-3 text-slate-300' aria-label='System column — protected' />
          </div>
        )}

        {/* Action buttons — hidden for protected system columns */}
        {!isProtected && (
          <div className='ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100'>
            <button
              type='button'
              onClick={() => setExpanded((v) => !v)}
              className='rounded p-1 text-slate-400 hover:text-slate-700'
              title='Field metadata'
            >
              <Settings2 className='h-3.5 w-3.5' />
            </button>

            {!col.is_primary_key && !col.is_virtual && canDrop && (
              <button
                type='button'
                onClick={onDrop}
                className='rounded p-1 text-slate-400 hover:text-red-500'
                title='Drop column'
              >
                <Trash2 className='h-3.5 w-3.5' />
              </button>
            )}

            <button
              type='button'
              onClick={() => setExpanded((v) => !v)}
              className='rounded p-1 text-slate-400 hover:text-slate-700'
            >
              {expanded ? (
                <ChevronUp className='h-3.5 w-3.5' />
              ) : (
                <ChevronDown className='h-3.5 w-3.5' />
              )}
            </button>
          </div>
        )}
      </div>

      {/* Expanded field metadata editor — never shown for protected columns */}
      {expanded && !isProtected && (
        <FieldMetaEditor
          key={col.name}
          col={col}
          tableName={tableName}
          onSave={(body) => addFieldMeta.mutateAsync(body)}
          onRemove={col.field_meta ? () => removeFieldMeta.mutate() : undefined}
          saving={addFieldMeta.isPending}
        />
      )}
    </div>
  )
}

// ─── Choices editor (for select/radio/checkbox interfaces) ───────────────────

function ChoicesEditor({
  choices,
  onChange
}: {
  choices: Choice[]
  onChange: (c: Choice[]) => void
}) {
  const add = () => onChange([...choices, { value: '', text: '' }])
  const remove = (i: number) => onChange(choices.filter((_, idx) => idx !== i))
  const update = (i: number, k: keyof Choice, v: string) =>
    onChange(choices.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)))

  return (
    <div className='space-y-1.5'>
      {choices.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order-stable list
        <div key={i} className='flex items-center gap-2'>
          <Input
            value={c.value}
            onChange={(e) => update(i, 'value', e.target.value)}
            placeholder='value'
            className='h-6 w-28 font-mono text-[11px]'
          />
          <Input
            value={c.text}
            onChange={(e) => update(i, 'text', e.target.value)}
            placeholder='label'
            className='h-6 flex-1 text-[11px]'
          />
          <button
            type='button'
            onClick={() => remove(i)}
            className='text-slate-300 hover:text-red-400'
          >
            <Trash2 className='h-3 w-3' />
          </button>
        </div>
      ))}
      <button
        type='button'
        onClick={add}
        className='flex items-center gap-1 text-[11px] text-slate-400 hover:text-nvr-cyan'
      >
        <Plus className='h-3 w-3' />
        Add choice
      </button>
    </div>
  )
}

// ─── Label choices editor (for display: label) ────────────────────────────────

function LabelChoicesEditor({
  choices,
  onChange
}: {
  choices: LabelChoice[]
  onChange: (c: LabelChoice[]) => void
}) {
  const add = () =>
    onChange([...choices, { value: '', text: '', background: '#e2e8f0', foreground: '#1e293b' }])
  const remove = (i: number) => onChange(choices.filter((_, idx) => idx !== i))
  const update = (i: number, k: keyof LabelChoice, v: string) =>
    onChange(choices.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)))

  return (
    <div className='space-y-1.5'>
      {choices.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order-stable list
        <div key={i} className='flex items-center gap-2'>
          <Input
            value={c.value}
            onChange={(e) => update(i, 'value', e.target.value)}
            placeholder='value'
            className='h-6 w-24 font-mono text-[11px]'
          />
          <Input
            value={c.text}
            onChange={(e) => update(i, 'text', e.target.value)}
            placeholder='label'
            className='h-6 w-28 text-[11px]'
          />
          <input
            type='color'
            value={c.background}
            onChange={(e) => update(i, 'background', e.target.value)}
            title='Background'
            className='h-6 w-7 cursor-pointer rounded border border-slate-200 p-0.5'
          />
          <input
            type='color'
            value={c.foreground}
            onChange={(e) => update(i, 'foreground', e.target.value)}
            title='Text color'
            className='h-6 w-7 cursor-pointer rounded border border-slate-200 p-0.5'
          />
          <button
            type='button'
            onClick={() => remove(i)}
            className='text-slate-300 hover:text-red-400'
          >
            <Trash2 className='h-3 w-3' />
          </button>
        </div>
      ))}
      <button
        type='button'
        onClick={add}
        className='flex items-center gap-1 text-[11px] text-slate-400 hover:text-nvr-cyan'
      >
        <Plus className='h-3 w-3' />
        Add label
      </button>
    </div>
  )
}

// ─── Combobox wrapper ─────────────────────────────────────────────────────────

function Sel({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; group?: string }[]
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)

  // Group options
  const groups: Record<string, { value: string; label: string }[]> = {}
  const ungrouped: { value: string; label: string }[] = []
  for (const o of options) {
    if (o.group) {
      ;(groups[o.group] ??= []).push(o)
    } else ungrouped.push(o)
  }
  const hasGroups = Object.keys(groups).length > 0

  return (
    <Popover open={disabled ? false : open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          className={cn(
            'flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-left text-[12px] text-slate-800 focus:outline-none focus:ring-1 focus:ring-nvr-cyan dark:border-border dark:bg-card dark:text-foreground',
            !selected && 'text-slate-400',
            disabled && 'cursor-not-allowed opacity-50',
            className
          )}
        >
          <span className='truncate'>{selected?.label ?? placeholder ?? 'Select…'}</span>
          <ChevronDown className='ml-1 h-3 w-3 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[220px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-2 text-center text-[12px] text-slate-400'>
              No results
            </CommandEmpty>
            {hasGroups
              ? Object.entries(groups).map(([group, items]) => (
                  <CommandGroup key={group} heading={group}>
                    {items.map((o) => (
                      <CommandItem
                        key={o.value}
                        value={`${o.label} ${o.value}`}
                        onSelect={() => {
                          onChange(o.value)
                          setOpen(false)
                        }}
                        className='text-[12px]'
                      >
                        <Check
                          className={cn(
                            'mr-1.5 h-3 w-3 shrink-0',
                            value === o.value ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        {o.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))
              : ungrouped.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={`${o.label} ${o.value}`}
                    onSelect={() => {
                      onChange(o.value)
                      setOpen(false)
                    }}
                    className='text-[12px]'
                  >
                    <Check
                      className={cn(
                        'mr-1.5 h-3 w-3 shrink-0',
                        value === o.value ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    {o.label}
                  </CommandItem>
                ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── Field meta editor ────────────────────────────────────────────────────────

function FieldMetaEditor({
  col,
  tableName,
  onSave,
  onRemove,
  saving
}: {
  col: DBColumn
  tableName: string
  onSave: (body: Record<string, unknown>) => Promise<unknown>
  onRemove?: () => void
  saving: boolean
}) {
  const fm = col.field_meta
  const abstractType = fm?.type ?? normalizeDataType(col)

  const [fieldType, setFieldTypeRaw] = useState(abstractType)
  const [fieldInterface, setFieldInterface] = useState(
    fm?.interface ?? getDefaultInterface(abstractType)
  )
  const [display, setDisplay] = useState(fm?.display ?? getDefaultDisplay(abstractType))
  const [note, setNote] = useState(fm?.note ?? '')
  const [hidden, setHidden] = useState(fm?.hidden ?? false)
  const [readonly, setReadonly] = useState(fm?.readonly ?? false)
  const [required, setRequired] = useState(fm?.required ?? false)
  const [nullable, setNullable] = useState(
    () => parseJson<{ nullable?: boolean }>(fm?.options)?.nullable ?? true
  )
  const [sort, setSort] = useState<number | ''>(fm?.sort ?? '')

  // Interface options state
  const [choices, setChoices] = useState<Choice[]>(
    () => parseJson<Choice[]>(fm?.options)?.filter?.((c) => 'value' in c && 'text' in c) ?? []
  )
  const [sliderMin, setSliderMin] = useState(
    () => parseJson<{ min?: number }>(fm?.options)?.min ?? 0
  )
  const [sliderMax, setSliderMax] = useState(
    () => parseJson<{ max?: number }>(fm?.options)?.max ?? 100
  )
  const [sliderStep, setSliderStep] = useState(
    () => parseJson<{ step?: number }>(fm?.options)?.step ?? 1
  )
  const [dtMode, setDtMode] = useState<string>(
    () => parseJson<{ mode?: string }>(fm?.options)?.mode ?? 'datetime'
  )
  const [dtFormat, setDtFormat] = useState(
    () => parseJson<{ format?: string }>(fm?.options)?.format ?? ''
  )
  const [dtOnCreate, setDtOnCreate] = useState<string>(
    () => parseJson<{ on_create?: string }>(fm?.options)?.on_create ?? 'do_nothing'
  )
  const [dtOnUpdate, setDtOnUpdate] = useState<string>(
    () => parseJson<{ on_update?: string }>(fm?.options)?.on_update ?? 'do_nothing'
  )
  const [colorPresets, setColorPresets] = useState(() =>
    (parseJson<{ presets?: string[] }>(fm?.options)?.presets ?? []).join(', ')
  )
  const [isUnique, setIsUnique] = useState(
    () => parseJson<{ unique?: boolean }>(fm?.options)?.unique ?? false
  )
  const [numPrecision, setNumPrecision] = useState(
    () => parseJson<{ precision?: number }>(fm?.options)?.precision ?? ''
  )
  const [numScale, setNumScale] = useState(
    () => parseJson<{ scale?: number }>(fm?.options)?.scale ?? ''
  )

  // Computed formula state
  const [computedEnabled, setComputedEnabled] = useState(() => !!fm?.computed_formula)
  const [computedType, setComputedType] = useState<'read' | 'write' | 'rollup'>(() =>
    fm?.computed_type === 'write' ? 'write' : fm?.computed_type === 'rollup' ? 'rollup' : 'read'
  )
  const [computedFormula, setComputedFormula] = useState(() =>
    fm?.computed_type === 'rollup' ? '' : (fm?.computed_formula ?? '')
  )
  const [computedStore, setComputedStore] = useState(() => fm?.computed_store ?? false)
  const [rollup, setRollup] = useState<RollupConfig>(() =>
    fm?.computed_type === 'rollup' ? parseRollup(fm?.computed_formula) : emptyRollup()
  )
  const [formulaMode, setFormulaMode] = useState<'builder' | 'raw'>('builder')
  // True while provisioning a physical column for a rollup that's toggling store on
  const [provisioning, setProvisioning] = useState(false)

  // Encryption-at-rest flag
  const [isEncrypted, setIsEncrypted] = useState(
    () => !!(fm as { is_encrypted?: boolean } | null | undefined)?.is_encrypted
  )

  // Tree inheritance flag — descendants without a value inherit it from ancestors
  const [isInheritable, setIsInheritable] = useState(
    () => !!(fm as { is_inheritable?: boolean } | null | undefined)?.is_inheritable
  )

  // Display options state
  const [fmtPrefix, setFmtPrefix] = useState(
    () => parseJson<{ prefix?: string }>(fm?.display_options)?.prefix ?? ''
  )
  const [fmtSuffix, setFmtSuffix] = useState(
    () => parseJson<{ suffix?: string }>(fm?.display_options)?.suffix ?? ''
  )
  const [labelChoices, setLabelChoices] = useState<LabelChoice[]>(
    () =>
      parseJson<LabelChoice[]>(fm?.display_options)?.filter?.((c) => 'value' in c && 'text' in c) ??
      []
  )
  const [dtDisplayFormat, setDtDisplayFormat] = useState(
    () => parseJson<{ format?: string }>(fm?.display_options)?.format ?? ''
  )
  const [boolTrueLabel, setBoolTrueLabel] = useState(
    () => parseJson<{ true_label?: string }>(fm?.display_options)?.true_label ?? 'true'
  )
  const [boolFalseLabel, setBoolFalseLabel] = useState(
    () => parseJson<{ false_label?: string }>(fm?.display_options)?.false_label ?? 'false'
  )

  function setFieldType(t: string) {
    setFieldTypeRaw(t)
    const ifaces = getInterfaces(t)
    const current = ifaces.find((i) => i.value === fieldInterface)
    if (!current) setFieldInterface(ifaces[0]?.value ?? '')
    const displays = getDisplays(t)
    const curDisplay = displays.find((d) => d.value === display)
    if (!curDisplay) setDisplay(displays[0]?.value ?? 'raw')
  }

  function buildOptions(): string | null {
    if (CHOICE_INTERFACES.has(fieldInterface) && choices.length > 0) {
      return JSON.stringify(choices)
    }
    if (SLIDER_INTERFACES.has(fieldInterface)) {
      return JSON.stringify({ min: sliderMin, max: sliderMax, step: sliderStep })
    }
    if (DATETIME_INTERFACES.has(fieldInterface)) {
      return JSON.stringify({
        mode: dtMode,
        format: dtFormat || undefined,
        on_create: dtOnCreate !== 'do_nothing' ? dtOnCreate : undefined,
        on_update: dtOnUpdate !== 'do_nothing' ? dtOnUpdate : undefined
      })
    }
    if (COLOR_INTERFACES.has(fieldInterface)) {
      const presets = colorPresets
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      return presets.length ? JSON.stringify({ presets }) : null
    }
    const extra: Record<string, unknown> = {}
    if (isUnique) extra.unique = true
    if (!nullable) extra.nullable = false
    if ((fieldType === 'decimal' || fieldType === 'float') && numPrecision !== '') {
      extra.precision = Number(numPrecision)
      if (fieldType === 'decimal' && numScale !== '') extra.scale = Number(numScale)
    }
    return Object.keys(extra).length ? JSON.stringify(extra) : null
  }

  function buildDisplayOptions(): string | null {
    if (display === 'formatted-value') {
      return JSON.stringify({ prefix: fmtPrefix || undefined, suffix: fmtSuffix || undefined })
    }
    if (display === 'label') {
      return labelChoices.length ? JSON.stringify(labelChoices) : null
    }
    if (display === 'datetime') {
      return dtDisplayFormat ? JSON.stringify({ format: dtDisplayFormat }) : null
    }
    if (display === 'boolean') {
      return JSON.stringify({ true_label: boolTrueLabel, false_label: boolFalseLabel })
    }
    return null
  }

  // Build the computed_* payload depending on the selected compute type.
  // Rollup serializes its config to JSON; read/write use the raw formula.
  const computedReady = computedType === 'rollup' ? isRollupValid(rollup) : !!computedFormula.trim()
  const computedPayload =
    computedEnabled && computedReady
      ? {
          computed_formula:
            computedType === 'rollup' ? serializeRollup(rollup) : computedFormula.trim(),
          computed_type: computedType,
          computed_store:
            computedType === 'write' || computedType === 'rollup' ? computedStore : false
        }
      : { computed_formula: null, computed_type: null, computed_store: false }

  // col.is_virtual is the DB's own truth about whether a physical column
  // exists yet (see data-model.ts: only computed fields with no matching
  // dbColumnNames entry are marked virtual) — toggling store on for a rollup
  // that's still virtual means we must provision the column before saving
  // metadata, or every recalc write silently fails against a nonexistent column.
  const isStoredRollup = computedEnabled && computedReady && computedType === 'rollup' && computedStore
  const needsColumnProvisioning = isStoredRollup && col.is_virtual
  const columnType = isStoredRollup ? rollupColumnType(fieldType) : (fieldType as CreateColumnBody['type'])

  async function handleSave() {
    if (needsColumnProvisioning) {
      setProvisioning(true)
      try {
        await schemaApi.addColumn(tableName, { name: col.name, type: columnType, nullable: true })
      } catch {
        toast.error(`Failed to provision the "${col.name}" column — save aborted`)
        setProvisioning(false)
        return
      }
      setProvisioning(false)
    }

    try {
      await onSave({
        field: col.name,
        type: columnType,
        interface: fieldInterface || null,
        display: display || null,
        display_options: buildDisplayOptions(),
        options: buildOptions(),
        note: note || null,
        hidden,
        readonly,
        required,
        sort: sort === '' ? null : sort,
        is_encrypted: isEncrypted,
        is_inheritable: isInheritable,
        ...computedPayload
      })
    } catch {
      // onSave's own mutation already surfaced an error toast — nothing left to do,
      // and the metadata never saved so backfilling now would run against stale config.
      return
    }

    if (isStoredRollup) {
      // Fire-and-forget backfill — the column starts NULL/0 otherwise until the
      // next write to a contributing row triggers a recalc. Only reachable once
      // the metadata save above actually succeeded, so nivaro_fields is current.
      api.post(`/data-model/${tableName}/fields/${col.name}/rollup-recalc`).catch(() => {
        toast.error(`"${col.name}" saved, but backfilling existing rows failed — recalc it manually`)
      })
    }
  }

  const interfaces = getInterfaces(fieldType)
  const displays = getDisplays(fieldType)
  const typeGroups = FIELD_TYPES.reduce<Record<string, typeof FIELD_TYPES>>((acc, ft) => {
    acc[ft.group] ??= []
    acc[ft.group].push(ft)
    return acc
  }, {})

  return (
    <div className='border-t border-slate-100 bg-slate-50 px-4 pb-4 pt-3'>
      <p className='mb-3 text-[11px] font-medium text-slate-500'>
        Field config — <span className='font-mono'>{col.name}</span>
      </p>

      {/* ── Row 1: Type / Interface / Note ── */}
      <div className='grid grid-cols-2 gap-3 sm:grid-cols-3'>
        <div>
          <Label className='mb-1 flex items-center gap-1.5 text-[11px]'>
            Type
            {!col.is_virtual && (
              <span className='text-[10px] font-normal text-slate-400'>(read-only)</span>
            )}
          </Label>
          <Sel
            value={fieldType}
            onChange={setFieldType}
            options={FIELD_TYPES.map((ft) => ({
              value: ft.value,
              label: ft.label,
              group: ft.group
            }))}
            placeholder='Select type…'
            disabled={!col.is_virtual}
          />
          {!col.is_virtual && (
            <p className='mt-0.5 text-[10px] text-slate-400'>
              Use Change Type in the column actions to alter the DB column.
            </p>
          )}
        </div>
        <div>
          <Label className='mb-1 block text-[11px]'>Interface</Label>
          <Sel
            value={fieldInterface}
            onChange={setFieldInterface}
            options={interfaces}
            placeholder='Select interface…'
          />
        </div>
        <div>
          <Label className='mb-1 block text-[11px]'>Note</Label>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className='h-7 text-[12px]'
            placeholder='Helper text for editors'
          />
        </div>
      </div>

      {/* ── Interface options ── */}
      {CHOICE_INTERFACES.has(fieldInterface) && (
        <div className='mt-3 rounded-md border border-slate-200 bg-white p-3'>
          <p className='mb-2 text-[11px] font-medium text-slate-500'>Choices</p>
          <ChoicesEditor choices={choices} onChange={setChoices} />
        </div>
      )}

      {SLIDER_INTERFACES.has(fieldInterface) && (
        <div className='mt-3 grid grid-cols-3 gap-3 rounded-md border border-slate-200 bg-white p-3'>
          <div>
            <Label className='mb-1 block text-[11px]'>Min</Label>
            <Input
              type='number'
              value={sliderMin}
              onChange={(e) => setSliderMin(Number(e.target.value))}
              className='h-7 text-[12px]'
            />
          </div>
          <div>
            <Label className='mb-1 block text-[11px]'>Max</Label>
            <Input
              type='number'
              value={sliderMax}
              onChange={(e) => setSliderMax(Number(e.target.value))}
              className='h-7 text-[12px]'
            />
          </div>
          <div>
            <Label className='mb-1 block text-[11px]'>Step</Label>
            <Input
              type='number'
              value={sliderStep}
              onChange={(e) => setSliderStep(Number(e.target.value))}
              className='h-7 text-[12px]'
            />
          </div>
        </div>
      )}

      {DATETIME_INTERFACES.has(fieldInterface) && (
        <div className='mt-3 rounded-md border border-slate-200 bg-white p-3 space-y-3'>
          <div className='grid grid-cols-2 gap-3'>
            <div>
              <Label className='mb-1 block text-[11px]'>Mode</Label>
              <Sel
                value={dtMode}
                onChange={setDtMode}
                options={[
                  { value: 'date', label: 'Date only' },
                  { value: 'time', label: 'Time only' },
                  { value: 'datetime', label: 'Date & Time' }
                ]}
              />
            </div>
            <div>
              <Label className='mb-1 block text-[11px]'>Format</Label>
              <Input
                value={dtFormat}
                onChange={(e) => setDtFormat(e.target.value)}
                className='h-7 font-mono text-[12px]'
                placeholder='e.g. YYYY-MM-DD'
              />
            </div>
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div>
              <Label className='mb-1 block text-[11px]'>On Create</Label>
              <Sel
                value={dtOnCreate}
                onChange={setDtOnCreate}
                options={[
                  { value: 'do_nothing', label: 'Do Nothing' },
                  { value: 'now', label: 'Save Current Date/Time' }
                ]}
              />
            </div>
            <div>
              <Label className='mb-1 block text-[11px]'>On Update</Label>
              <Sel
                value={dtOnUpdate}
                onChange={setDtOnUpdate}
                options={[
                  { value: 'do_nothing', label: 'Do Nothing' },
                  { value: 'now', label: 'Save Current Date/Time' }
                ]}
              />
            </div>
          </div>
        </div>
      )}

      {COLOR_INTERFACES.has(fieldInterface) && (
        <div className='mt-3 rounded-md border border-slate-200 bg-white p-3'>
          <Label className='mb-1 block text-[11px]'>Preset colors (comma-separated hex)</Label>
          <Input
            value={colorPresets}
            onChange={(e) => setColorPresets(e.target.value)}
            className='h-7 font-mono text-[12px]'
            placeholder='#ef4444, #3b82f6, #22c55e'
          />
        </div>
      )}

      {/* ── Precision (decimal / float) ── */}
      {(fieldType === 'decimal' || fieldType === 'float') && (
        <div className='mt-3 grid grid-cols-2 gap-3 rounded-md border border-slate-200 bg-white p-3'>
          <div>
            <Label className='mb-1 block text-[11px]'>Precision</Label>
            <Input
              type='number'
              min={1}
              max={fieldType === 'float' ? 53 : 38}
              value={numPrecision}
              onChange={(e) => setNumPrecision(e.target.value ? Number(e.target.value) : '')}
              placeholder={fieldType === 'float' ? '8' : '10'}
              className='h-7 text-[12px]'
            />
          </div>
          {fieldType === 'decimal' && (
            <div>
              <Label className='mb-1 block text-[11px]'>Scale</Label>
              <Input
                type='number'
                min={0}
                max={numPrecision !== '' ? Number(numPrecision) : 10}
                value={numScale}
                onChange={(e) => setNumScale(e.target.value ? Number(e.target.value) : '')}
                placeholder='2'
                className='h-7 text-[12px]'
              />
            </div>
          )}
        </div>
      )}

      {/* ── Display configuration ── */}
      {displays.length > 0 && (
        <div className='mt-3 rounded-md border border-slate-200 bg-white p-3'>
          <div className='mb-3 flex items-center gap-3'>
            <div className='flex-1'>
              <Label className='mb-1 block text-[11px]'>Display</Label>
              <Sel
                value={display}
                onChange={setDisplay}
                options={displays}
                placeholder='Select display…'
              />
            </div>
          </div>

          {display === 'formatted-value' && (
            <div className='grid grid-cols-2 gap-3'>
              <div>
                <Label className='mb-1 block text-[11px]'>Prefix</Label>
                <Input
                  value={fmtPrefix}
                  onChange={(e) => setFmtPrefix(e.target.value)}
                  className='h-7 text-[12px]'
                  placeholder='e.g. $'
                />
              </div>
              <div>
                <Label className='mb-1 block text-[11px]'>Suffix</Label>
                <Input
                  value={fmtSuffix}
                  onChange={(e) => setFmtSuffix(e.target.value)}
                  className='h-7 text-[12px]'
                  placeholder='e.g. USD'
                />
              </div>
            </div>
          )}

          {display === 'label' && (
            <div>
              <p className='mb-2 text-[11px] text-slate-400'>Map stored values to colored labels</p>
              <LabelChoicesEditor choices={labelChoices} onChange={setLabelChoices} />
            </div>
          )}

          {display === 'datetime' && (
            <div>
              <Label className='mb-1 block text-[11px]'>Format string</Label>
              <Input
                value={dtDisplayFormat}
                onChange={(e) => setDtDisplayFormat(e.target.value)}
                className='h-7 font-mono text-[12px]'
                placeholder='e.g. MMM D, YYYY h:mm A'
              />
            </div>
          )}

          {display === 'boolean' && (
            <div className='grid grid-cols-2 gap-3'>
              <div>
                <Label className='mb-1 block text-[11px]'>True label</Label>
                <Input
                  value={boolTrueLabel}
                  onChange={(e) => setBoolTrueLabel(e.target.value)}
                  className='h-7 text-[12px]'
                  placeholder='true'
                />
              </div>
              <div>
                <Label className='mb-1 block text-[11px]'>False label</Label>
                <Input
                  value={boolFalseLabel}
                  onChange={(e) => setBoolFalseLabel(e.target.value)}
                  className='h-7 text-[12px]'
                  placeholder='false'
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Computed formula ── */}
      <div className='mt-3 rounded-md border border-slate-200 bg-white p-3'>
        <div className='mb-2 flex items-center justify-between'>
          <p className='text-[11px] font-medium text-slate-600'>Computed Formula</p>
          <label className='flex cursor-pointer items-center gap-1.5 text-[12px]'>
            <input
              type='checkbox'
              checked={computedEnabled}
              onChange={(e) => setComputedEnabled(e.target.checked)}
              className='rounded'
            />
            Enable
          </label>
        </div>

        {computedEnabled && (
          <div className='space-y-2.5'>
            {/* Type: read vs write vs rollup */}
            <div className='flex items-center gap-4 text-[12px]'>
              <span className='text-[11px] text-slate-500'>Evaluate on:</span>
              <label className='flex cursor-pointer items-center gap-1.5'>
                <input
                  type='radio'
                  name={`computed-type-${col.name}`}
                  value='read'
                  checked={computedType === 'read'}
                  onChange={() => setComputedType('read')}
                />
                Read (virtual)
              </label>
              <label className='flex cursor-pointer items-center gap-1.5'>
                <input
                  type='radio'
                  name={`computed-type-${col.name}`}
                  value='write'
                  checked={computedType === 'write'}
                  onChange={() => setComputedType('write')}
                />
                Write (before save)
              </label>
              <label className='flex cursor-pointer items-center gap-1.5'>
                <input
                  type='radio'
                  name={`computed-type-${col.name}`}
                  value='rollup'
                  checked={computedType === 'rollup'}
                  onChange={() => setComputedType('rollup')}
                />
                Rollup (aggregate)
              </label>
            </div>

            {computedType === 'rollup' ? (
              <RollupConfigEditor
                config={rollup}
                currentCollection={tableName}
                onChange={setRollup}
                computedStore={computedStore}
                onComputedStoreChange={setComputedStore}
              />
            ) : (
              <>
                {/* Formula editor — visual builder or raw text */}
                <div>
                  <div className='mb-1 flex items-center justify-between'>
                    <Label className='block text-[11px]'>Formula</Label>
                    <FormulaModeToggle mode={formulaMode} onChange={setFormulaMode} />
                  </div>
                  {formulaMode === 'builder' ? (
                    <FormulaBuilder
                      collection={tableName}
                      value={computedFormula}
                      onChange={setComputedFormula}
                    />
                  ) : (
                    <textarea
                      value={computedFormula}
                      onChange={(e) => setComputedFormula(e.target.value)}
                      rows={3}
                      placeholder={
                        computedType === 'read'
                          ? 'e.g. item.price * 1.2'
                          : 'e.g. concat(item.first_name, " ", item.last_name)'
                      }
                      className='w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 font-mono text-[12px] text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
                      spellCheck={false}
                    />
                  )}
                  <p className='mt-1 text-[11px] text-slate-400'>
                    Use <code className='rounded bg-slate-100 px-1'>item.field</code> to reference
                    fields. Strings:{' '}
                    <code className='rounded bg-slate-100 px-1'>
                      {'concat(item.a, " ", item.b)'}
                    </code>{' '}
                    or{' '}
                    <code className='rounded bg-slate-100 px-1'>{'item.a || " " || item.b'}</code>.
                    Numbers: <code className='rounded bg-slate-100 px-1'>item.price * 1.2</code>.
                  </p>
                </div>

                {/* Store result (write-type only) */}
                {computedType === 'write' && (
                  <label className='flex cursor-pointer items-center gap-1.5 text-[12px]'>
                    <input
                      type='checkbox'
                      checked={computedStore}
                      onChange={(e) => setComputedStore(e.target.checked)}
                      className='rounded'
                    />
                    Store result in database column
                  </label>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Encryption ── */}
      <div className='mt-3 flex items-center justify-between rounded-md border border-slate-200 bg-white p-3'>
        <div>
          <p className='text-[11px] font-medium text-slate-600'>Encrypted</p>
          <p className='text-[11px] text-slate-400'>
            Values encrypted at rest; not searchable/filterable.
          </p>
        </div>
        <Switch checked={isEncrypted} onCheckedChange={setIsEncrypted} />
      </div>

      {/* ── Tree inheritance ── */}
      <div className='mt-3 flex items-center justify-between rounded-md border border-slate-200 bg-white p-3'>
        <div>
          <p className='text-[11px] font-medium text-slate-600'>Inheritable</p>
          <p className='text-[11px] text-slate-400'>
            In tree collections, items without a value inherit it from their nearest ancestor.
          </p>
        </div>
        <Switch checked={isInheritable} onCheckedChange={setIsInheritable} />
      </div>

      {/* ── Behavior ── */}
      <div className='mt-3 flex flex-wrap items-center gap-4 text-[12px]'>
        <label className='flex cursor-pointer items-center gap-1.5'>
          <input
            type='checkbox'
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
            className='rounded'
          />
          Hidden
        </label>
        <label className='flex cursor-pointer items-center gap-1.5'>
          <input
            type='checkbox'
            checked={readonly}
            onChange={(e) => setReadonly(e.target.checked)}
            className='rounded'
          />
          Read-only
        </label>
        <label className='flex cursor-pointer items-center gap-1.5'>
          <input
            type='checkbox'
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className='rounded'
          />
          Required
        </label>
        <label className='flex cursor-pointer items-center gap-1.5'>
          <input
            type='checkbox'
            checked={isUnique}
            onChange={(e) => setIsUnique(e.target.checked)}
            className='rounded'
          />
          Unique
        </label>
        <label className='flex cursor-pointer items-center gap-1.5'>
          <input
            type='checkbox'
            checked={nullable}
            onChange={(e) => setNullable(e.target.checked)}
            className='rounded'
          />
          Nullable
        </label>
        <div className='flex items-center gap-1.5'>
          <Label className='text-[11px]'>Sort</Label>
          <Input
            type='number'
            value={sort}
            onChange={(e) => setSort(e.target.value === '' ? '' : Number(e.target.value))}
            className='h-6 w-16 text-[12px]'
            placeholder='—'
          />
        </div>

        <div className='ml-auto flex gap-2'>
          {onRemove && (
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='h-7 text-[12px] text-red-500 hover:text-red-700'
              onClick={onRemove}
            >
              Remove
            </Button>
          )}
          <Button
            type='button'
            size='sm'
            className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
            disabled={saving || provisioning}
            onClick={handleSave}
          >
            {saving || provisioning ? (
              'Saving…'
            ) : (
              <>
                <Check className='mr-1 h-3 w-3' />
                Save
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Relations tab ────────────────────────────────────────────────────────────

const REL_TYPE_META: Record<RelationType, { label: string; badgeCls: string; desc: string }> = {
  m2o: {
    label: 'Many-to-One',
    badgeCls: 'bg-blue-50 text-blue-700',
    desc: 'This table has a FK pointing to another table'
  },
  o2m: {
    label: 'One-to-Many',
    badgeCls: 'bg-purple-50 text-purple-700',
    desc: 'Another table has a FK pointing to this table'
  },
  m2m: {
    label: 'Many-to-Many',
    badgeCls: 'bg-orange-50 text-orange-700',
    desc: 'A junction table links this table to another'
  },
  m2a: {
    label: 'Many-to-Any',
    badgeCls: 'bg-pink-50 text-pink-700',
    desc: 'Polymorphic: relates to multiple different collections'
  }
}

function TblSel({
  value,
  onChange,
  allTables,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  allTables: DBTableSummary[]
  placeholder?: string
}) {
  return (
    <Sel
      value={value}
      onChange={onChange}
      placeholder={placeholder ?? 'Select table…'}
      options={allTables.map((t) => ({
        value: t.name,
        label:
          t.display_name && t.display_name !== t.name ? `${t.name} — ${t.display_name}` : t.name
      }))}
    />
  )
}

function ColSel({
  table,
  value,
  onChange,
  placeholder,
  disabled,
  allowNew,
  onNewColumn
}: {
  table: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  allowNew?: boolean
  onNewColumn?: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const { data, isFetching } = useQuery({
    queryKey: ['data-model-table', table],
    queryFn: () => schemaApi.getTable(table),
    enabled: !!table
  })
  const cols = data?.data?.columns ?? []
  const selected = cols.find((c) => c.name === value)
  const isDisabled = disabled || !table || isFetching
  const isNew = !!value && !selected

  const trimmed = search.trim()
  const showCreate = allowNew && !!trimmed && !cols.some((c) => c.name === trimmed)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={isDisabled}
          className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-left text-[12px] text-slate-800 focus:outline-none focus:ring-1 focus:ring-nvr-cyan disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground'
        >
          <span
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1 truncate',
              !value && 'text-slate-400'
            )}
          >
            {isFetching ? (
              'Loading…'
            ) : value ? (
              <>
                <span className={cn('font-mono truncate', isNew && 'text-nvr-cyan')}>{value}</span>
                {isNew && (
                  <span className='shrink-0 rounded bg-nvr-cyan/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-nvr-cyan'>
                    NEW
                  </span>
                )}
                {selected && (
                  <span className='shrink-0 text-slate-400'>({selected.data_type})</span>
                )}
              </>
            ) : (
              (placeholder ?? 'Select column…')
            )}
          </span>
          <ChevronDown className='ml-1 h-3 w-3 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput
            placeholder={allowNew ? 'Search or type new name…' : 'Search columns…'}
            className='h-8 text-[12px]'
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty
              className={cn('py-2 text-center text-[12px] text-slate-400', showCreate && 'hidden')}
            >
              No columns
            </CommandEmpty>
            {cols.map((c) => (
              <CommandItem
                key={c.name}
                value={`${c.name} ${c.data_type}`}
                onSelect={() => {
                  onChange(c.name)
                  onNewColumn?.('')
                  setOpen(false)
                  setSearch('')
                }}
                className='text-[12px]'
              >
                <Check
                  className={cn(
                    'mr-1.5 h-3 w-3 shrink-0',
                    value === c.name ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className='font-mono'>{c.name}</span>
                <span className='ml-1.5 text-slate-400'>({c.data_type})</span>
              </CommandItem>
            ))}
            {showCreate && (
              <CommandItem
                key='__create__'
                value={`__create__ ${trimmed}`}
                onSelect={() => {
                  onChange(trimmed)
                  onNewColumn?.(trimmed)
                  setOpen(false)
                  setSearch('')
                }}
                className='text-[12px] text-nvr-cyan'
              >
                <span className='mr-1.5'>✚</span>
                Create <span className='mx-1 font-mono font-semibold'>'{trimmed}'</span>
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── FK constraints panel ─────────────────────────────────────────────────────

function FkConstraintsPanel({
  relations
}: {
  relations: {
    column_name: string
    referenced_table: string
    referenced_column: string
    constraint_name: string
  }[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='flex w-full items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-600'
      >
        {open ? (
          <ChevronUp className='h-3 w-3 shrink-0' />
        ) : (
          <ChevronDown className='h-3 w-3 shrink-0' />
        )}
        <span>DB Constraints ({relations.length})</span>
      </button>
      {open && (
        <div className='mt-2 overflow-hidden rounded-lg border border-slate-200 bg-white'>
          {relations.map((rel, i) => (
            <div
              key={rel.constraint_name}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-[12px]',
                i > 0 && 'border-t border-slate-100'
              )}
            >
              <span className='font-mono font-medium text-slate-900'>{rel.column_name}</span>
              <span className='text-slate-400'>→</span>
              <span className='font-mono text-slate-700'>
                {rel.referenced_table}.{rel.referenced_column}
              </span>
              <span className='ml-auto text-[10.5px] text-slate-400'>{rel.constraint_name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Relation diagram primitives ──────────────────────────────────────────────

function DiagArrow() {
  return (
    <div className='flex shrink-0 items-center self-center'>
      <div className='h-px w-7 bg-slate-300' />
      <svg width='6' height='8' viewBox='0 0 6 8' aria-hidden='true'>
        <path d='M0 0.5L5.5 4L0 7.5Z' fill='#cbd5e1' />
      </svg>
    </div>
  )
}

function DiagNode({
  nodeRole,
  roleCls,
  containerCls,
  tableContent,
  fields
}: {
  nodeRole: string
  roleCls: string
  containerCls: string
  tableContent: ReactNode
  fields: { label: string; input: ReactNode }[]
}) {
  return (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-2.5 rounded-lg border p-3', containerCls)}>
      <div className={cn('text-[10px] font-semibold leading-none', roleCls)}>{nodeRole}</div>
      <div>{tableContent}</div>
      {fields.map((f) => (
        <div key={f.label}>
          <div className='mb-1 text-[11px] text-slate-500'>{f.label}</div>
          {f.input}
        </div>
      ))}
    </div>
  )
}

function RelationFormDiagram({
  relType,
  tableName,
  allTables,
  form,
  patch,
  showFkOption
}: {
  relType: RelationType
  tableName: string
  allTables: DBTableSummary[]
  form: typeof DEFAULT_REL_FORM
  patch: (k: Partial<typeof DEFAULT_REL_FORM>) => void
  showFkOption?: boolean
}) {
  const thisTableDisplay = (
    <span className='font-mono text-[12px] font-semibold text-slate-900'>{tableName}</span>
  )

  if (relType === 'm2o') {
    return (
      <div className='space-y-3'>
        <div className='flex items-stretch gap-1.5'>
          <DiagNode
            nodeRole='Many side — this table'
            roleCls='text-[#009abe]'
            containerCls='bg-[rgba(0,206,255,0.06)] border-[rgba(0,206,255,0.3)]'
            tableContent={thisTableDisplay}
            fields={[
              {
                label: 'Foreign key field',
                input: (
                  <>
                    <ColSel
                      table={tableName}
                      value={form.m2o_many_field}
                      onChange={(v) => patch({ m2o_many_field: v, m2o_is_new_field: false })}
                      allowNew
                      onNewColumn={(name) => patch({ m2o_is_new_field: !!name })}
                    />
                    {form.m2o_is_new_field && (
                      <div className='mt-1 flex items-center gap-1.5'>
                        <span className='text-[10px] text-slate-400'>Column type:</span>
                        {(['integer', 'uuid'] as const).map((t) => (
                          <button
                            key={t}
                            type='button'
                            onClick={() => patch({ m2o_new_field_type: t })}
                            className={cn(
                              'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                              form.m2o_new_field_type === t
                                ? 'bg-nvr-cyan/10 text-nvr-cyan'
                                : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400'
                            )}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )
              }
            ]}
          />
          <DiagArrow />
          <DiagNode
            nodeRole='One side — referenced table'
            roleCls='text-slate-500'
            containerCls='bg-slate-50 border-slate-200'
            tableContent={
              <TblSel
                allTables={allTables}
                value={form.m2o_one_collection}
                onChange={(v) => patch({ m2o_one_collection: v, m2o_one_field: '' })}
              />
            }
            fields={[
              {
                label: 'Referenced field',
                input: (
                  <ColSel
                    table={form.m2o_one_collection}
                    value={form.m2o_one_field}
                    onChange={(v) => patch({ m2o_one_field: v })}
                    placeholder='id (default)'
                  />
                )
              }
            ]}
          />
        </div>
        {showFkOption && (
          <label className='flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-600'>
            <input
              type='checkbox'
              checked={form.m2o_create_fk}
              onChange={(e) => patch({ m2o_create_fk: e.target.checked })}
              className='rounded'
            />
            Also create FK constraint in database
          </label>
        )}
      </div>
    )
  }

  if (relType === 'o2m') {
    return (
      <div className='flex items-stretch gap-1.5'>
        <DiagNode
          nodeRole='Many side — related table'
          roleCls='text-slate-500'
          containerCls='bg-slate-50 border-slate-200'
          tableContent={
            <TblSel
              allTables={allTables}
              value={form.o2m_many_collection}
              onChange={(v) => patch({ o2m_many_collection: v, o2m_many_field: '' })}
            />
          }
          fields={[
            {
              label: 'FK field pointing to this table',
              input: (
                <ColSel
                  table={form.o2m_many_collection}
                  value={form.o2m_many_field}
                  onChange={(v) => patch({ o2m_many_field: v })}
                  placeholder='Select FK column…'
                />
              )
            }
          ]}
        />
        <DiagArrow />
        <DiagNode
          nodeRole='One side — this table'
          roleCls='text-[#009abe]'
          containerCls='bg-[rgba(0,206,255,0.06)] border-[rgba(0,206,255,0.3)]'
          tableContent={thisTableDisplay}
          fields={[
            {
              label: 'Referenced field',
              input: (
                <div className='rounded-md bg-slate-100 px-2 py-1.5 font-mono text-[11px] text-slate-500'>
                  id
                </div>
              )
            }
          ]}
        />
      </div>
    )
  }

  if (relType === 'm2m') {
    const autoJunctionName =
      form.m2m_auto_junction_name ||
      (form.m2m_one_collection ? `${tableName}_${form.m2m_one_collection}` : '')
    return (
      <div className='space-y-3'>
        {/* Auto / existing toggle */}
        <div className='flex gap-1 rounded-md border border-slate-200 bg-slate-50 p-0.5 w-fit'>
          <button
            type='button'
            onClick={() => patch({ m2m_auto: true })}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] font-medium transition-colors ${
              form.m2m_auto
                ? 'bg-white text-nvr-navy shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {form.m2m_auto && <Check className='h-3 w-3 text-nvr-cyan' />}
            Auto-generate junction table
          </button>
          <button
            type='button'
            onClick={() => patch({ m2m_auto: false })}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] font-medium transition-colors ${
              !form.m2m_auto
                ? 'bg-white text-nvr-navy shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {!form.m2m_auto && <Check className='h-3 w-3 text-nvr-cyan' />}
            Use existing table
          </button>
        </div>

        {form.m2m_auto ? (
          <div className='flex items-stretch gap-1.5'>
            <DiagNode
              nodeRole='This table'
              roleCls='text-[#009abe]'
              containerCls='bg-[rgba(0,206,255,0.06)] border-[rgba(0,206,255,0.3)]'
              tableContent={thisTableDisplay}
              fields={[]}
            />
            <DiagArrow />
            <DiagNode
              nodeRole='Junction table (auto)'
              roleCls='text-amber-700'
              containerCls='bg-amber-50 border-amber-200'
              tableContent={
                <span className='font-mono text-[12px] font-semibold text-amber-700'>
                  {autoJunctionName || '…'}
                </span>
              }
              fields={[
                {
                  label: 'Custom name (optional)',
                  input: (
                    <Input
                      value={form.m2m_auto_junction_name}
                      onChange={(e) => patch({ m2m_auto_junction_name: e.target.value })}
                      placeholder={
                        form.m2m_one_collection
                          ? `${tableName}_${form.m2m_one_collection}`
                          : 'e.g. articles_tags'
                      }
                      className='h-7 font-mono text-[12px]'
                    />
                  )
                }
              ]}
            />
            <DiagArrow />
            <DiagNode
              nodeRole='Target table'
              roleCls='text-slate-500'
              containerCls='bg-slate-50 border-slate-200'
              tableContent={
                <TblSel
                  allTables={allTables}
                  value={form.m2m_one_collection}
                  onChange={(v) => patch({ m2m_one_collection: v })}
                />
              }
              fields={[]}
            />
          </div>
        ) : (
          <div className='flex items-stretch gap-1.5'>
            <DiagNode
              nodeRole='This table'
              roleCls='text-[#009abe]'
              containerCls='bg-[rgba(0,206,255,0.06)] border-[rgba(0,206,255,0.3)]'
              tableContent={thisTableDisplay}
              fields={[]}
            />
            <DiagArrow />
            <DiagNode
              nodeRole='Junction table'
              roleCls='text-amber-700'
              containerCls='bg-amber-50 border-amber-200'
              tableContent={
                <TblSel
                  allTables={allTables}
                  value={form.m2m_junction}
                  onChange={(v) =>
                    patch({ m2m_junction: v, m2m_many_field: '', m2m_junction_field: '' })
                  }
                />
              }
              fields={[
                {
                  label: 'FK pointing to this table',
                  input: (
                    <ColSel
                      table={form.m2m_junction}
                      value={form.m2m_many_field}
                      onChange={(v) => patch({ m2m_many_field: v })}
                    />
                  )
                },
                {
                  label: 'FK pointing to target table',
                  input: (
                    <ColSel
                      table={form.m2m_junction}
                      value={form.m2m_junction_field}
                      onChange={(v) => patch({ m2m_junction_field: v })}
                    />
                  )
                }
              ]}
            />
            <DiagArrow />
            <DiagNode
              nodeRole='Target table'
              roleCls='text-slate-500'
              containerCls='bg-slate-50 border-slate-200'
              tableContent={
                <TblSel
                  allTables={allTables}
                  value={form.m2m_one_collection}
                  onChange={(v) => patch({ m2m_one_collection: v, m2m_one_field: '' })}
                />
              }
              fields={[
                {
                  label: 'Referenced field',
                  input: (
                    <ColSel
                      table={form.m2m_one_collection}
                      value={form.m2m_one_field}
                      onChange={(v) => patch({ m2m_one_field: v })}
                      placeholder='id (default)'
                    />
                  )
                }
              ]}
            />
          </div>
        )}
      </div>
    )
  }

  // m2a
  return (
    <div className='flex items-stretch gap-1.5'>
      <DiagNode
        nodeRole='This table'
        roleCls='text-[#009abe]'
        containerCls='bg-[rgba(0,206,255,0.06)] border-[rgba(0,206,255,0.3)]'
        tableContent={thisTableDisplay}
        fields={[
          {
            label: 'Local ID field',
            input: (
              <>
                <ColSel
                  table={tableName}
                  value={form.m2a_many_field}
                  onChange={(v) => patch({ m2a_many_field: v, m2a_is_new_field: false })}
                  allowNew
                  onNewColumn={(name) => patch({ m2a_is_new_field: !!name })}
                />
                {form.m2a_is_new_field && (
                  <div className='mt-1 flex items-center gap-1.5'>
                    <span className='text-[10px] text-slate-400'>Column type:</span>
                    {(['integer', 'uuid'] as const).map((t) => (
                      <button
                        key={t}
                        type='button'
                        onClick={() => patch({ m2a_new_field_type: t })}
                        className={cn(
                          'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                          form.m2a_new_field_type === t
                            ? 'bg-nvr-cyan/10 text-nvr-cyan'
                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400'
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )
          }
        ]}
      />
      <DiagArrow />
      <DiagNode
        nodeRole='Any collection (polymorphic)'
        roleCls='text-fuchsia-600'
        containerCls='border-dashed border-fuchsia-300 bg-fuchsia-50'
        tableContent={
          <span className='text-[11px] italic text-fuchsia-400'>determined at runtime</span>
        }
        fields={[
          {
            label: 'Collection discriminator field',
            input: (
              <Input
                value={form.m2a_one_collection_field}
                onChange={(e) => patch({ m2a_one_collection_field: e.target.value })}
                placeholder='e.g. collection'
                className='h-7 font-mono text-[12px]'
              />
            )
          },
          {
            label: 'Allowed collections (blank = any)',
            input: (
              <Input
                value={form.m2a_one_allowed_collections}
                onChange={(e) => patch({ m2a_one_allowed_collections: e.target.value })}
                placeholder='e.g. articles,pages,events'
                className='h-7 font-mono text-[12px]'
              />
            )
          }
        ]}
      />
    </div>
  )
}

const DEFAULT_REL_FORM = {
  m2o_many_field: '',
  m2o_one_collection: '',
  m2o_one_field: '',
  m2o_create_fk: false,
  m2o_is_new_field: false,
  m2o_new_field_type: 'integer' as 'integer' | 'uuid',
  o2m_many_collection: '',
  o2m_many_field: '',
  m2m_junction: '',
  m2m_many_field: '',
  m2m_junction_field: '',
  m2m_one_collection: '',
  m2m_one_field: '',
  m2m_auto: true,
  m2m_auto_junction_name: '',
  m2a_many_field: '',
  m2a_one_collection_field: '',
  m2a_one_allowed_collections: '',
  m2a_is_new_field: false,
  m2a_new_field_type: 'integer' as 'integer' | 'uuid'
}

function RelationsTab({
  tableData,
  tableName,
  onRefresh
}: {
  tableData: DBTableDetail
  tableName: string
  onRefresh: () => void
}) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<'list' | 'add'>('list')
  const [addStep, setAddStep] = useState<'type' | 'form'>('type')
  const [selectedType, setSelectedType] = useState<RelationType>('m2o')
  const [form, setForm] = useState(DEFAULT_REL_FORM)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState(DEFAULT_REL_FORM)

  const patch = (k: Partial<typeof DEFAULT_REL_FORM>) => setForm((f) => ({ ...f, ...k }))
  const editPatch = (k: Partial<typeof DEFAULT_REL_FORM>) => setEditForm((f) => ({ ...f, ...k }))

  const { data: tablesData } = useQuery({
    queryKey: ['data-model-tables'],
    queryFn: schemaApi.listTables
  })
  const allTables = tablesData?.data ?? []

  const { data: cmsRelData, isLoading: relLoading } = useQuery({
    queryKey: ['cms-relations', tableName],
    queryFn: () => schemaApi.getCMSRelations(tableName)
  })
  const cmsRelations = cmsRelData?.data ?? []

  const fkRelations = tableData.relations

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cms-relations', tableName] })
    qc.invalidateQueries({ queryKey: ['data-model-table', tableName] })
    onRefresh()
  }

  const buildPayload = (): Record<string, unknown> => {
    if (selectedType === 'm2o')
      return {
        many_collection: tableName,
        many_field: form.m2o_many_field,
        one_collection: form.m2o_one_collection,
        one_field: form.m2o_one_field || 'id',
        create_fk: form.m2o_create_fk
      }
    if (selectedType === 'o2m')
      return {
        many_collection: form.o2m_many_collection,
        many_field: form.o2m_many_field,
        one_collection: tableName,
        one_field: form.o2m_many_collection
      }
    if (selectedType === 'm2m') {
      if (form.m2m_auto) {
        const junctionName =
          form.m2m_auto_junction_name || `${tableName}_${form.m2m_one_collection}`
        return {
          many_collection: junctionName,
          many_field: `${tableName}_id`,
          one_collection: tableName,
          one_field: 'id',
          junction_field: `${form.m2m_one_collection}_id`
        }
      }
      return {
        many_collection: form.m2m_junction,
        many_field: form.m2m_many_field,
        one_collection: tableName,
        one_field: form.m2m_one_field || 'id',
        junction_field: form.m2m_junction_field
      }
    }
    return {
      many_collection: tableName,
      many_field: form.m2a_many_field,
      one_collection_field: form.m2a_one_collection_field,
      one_allowed_collections: form.m2a_one_allowed_collections || null
    }
  }

  const isFormValid = (): boolean => {
    if (selectedType === 'm2o') return !!form.m2o_many_field && !!form.m2o_one_collection
    if (selectedType === 'o2m') return !!form.o2m_many_collection && !!form.o2m_many_field
    if (selectedType === 'm2m') {
      if (form.m2m_auto) return !!form.m2m_one_collection
      return (
        !!form.m2m_junction &&
        !!form.m2m_many_field &&
        !!form.m2m_junction_field &&
        !!form.m2m_one_collection
      )
    }
    return !!form.m2a_many_field && !!form.m2a_one_collection_field
  }

  const resetAdd = () => {
    setMode('list')
    setAddStep('type')
    setSelectedType('m2o')
    setForm(DEFAULT_REL_FORM)
  }

  const formatRelSummary = (rel: CMSRelationRow): string => {
    const t = detectRelationType(rel, tableName)
    if (t === 'm2o')
      return `${tableName}.${rel.many_field} → ${rel.one_collection}.${rel.one_field ?? 'id'}`
    if (t === 'o2m')
      return `${rel.many_collection}.${rel.many_field} → ${tableName}.${rel.one_field ?? 'id'}`
    if (t === 'm2m') {
      const companion = cmsRelations.find(
        (r) =>
          r.many_collection === rel.many_collection &&
          r.many_field === rel.junction_field &&
          r.id !== rel.id
      )
      const target =
        companion?.one_collection ??
        (rel.junction_field?.endsWith('_id')
          ? rel.junction_field.slice(0, -3)
          : rel.junction_field) ??
        rel.one_collection
      return `${tableName} ↔ ${target} (via ${rel.many_collection})`
    }
    return `${tableName}.${rel.many_field} → any (${rel.one_collection_field})`
  }

  const startEdit = (rel: CMSRelationRow) => {
    const t = detectRelationType(rel, tableName)
    const base = { ...DEFAULT_REL_FORM }
    if (t === 'm2o') {
      base.m2o_many_field = rel.many_field
      base.m2o_one_collection = rel.one_collection ?? ''
      base.m2o_one_field = rel.one_field ?? ''
    } else if (t === 'o2m') {
      base.o2m_many_collection = rel.many_collection
      base.o2m_many_field = rel.many_field
    } else if (t === 'm2m') {
      base.m2m_auto = false
      base.m2m_junction = rel.many_collection
      base.m2m_many_field = rel.many_field
      base.m2m_junction_field = rel.junction_field ?? ''
      const companion = cmsRelations.find(
        (r) =>
          r.many_collection === rel.many_collection &&
          r.many_field === rel.junction_field &&
          r.id !== rel.id
      )
      // fall back to stripping _id suffix if no companion exists yet
      const derivedTarget =
        companion?.one_collection ??
        (rel.junction_field?.endsWith('_id')
          ? rel.junction_field.slice(0, -3)
          : rel.junction_field) ??
        ''
      base.m2m_one_collection = derivedTarget
      base.m2m_one_field = companion?.one_field ?? ''
    } else {
      base.m2a_many_field = rel.many_field
      base.m2a_one_collection_field = rel.one_collection_field ?? ''
      base.m2a_one_allowed_collections = rel.one_allowed_collections ?? ''
    }
    setEditForm(base)
    setEditingId(rel.id)
  }

  const buildEditPayload = (relType: RelationType): Record<string, unknown> => {
    if (relType === 'm2o')
      return {
        many_field: editForm.m2o_many_field,
        one_collection: editForm.m2o_one_collection,
        one_field: editForm.m2o_one_field || 'id'
      }
    if (relType === 'o2m')
      return {
        many_collection: editForm.o2m_many_collection,
        many_field: editForm.o2m_many_field
      }
    if (relType === 'm2m')
      return {
        many_collection: editForm.m2m_junction,
        many_field: editForm.m2m_many_field,
        junction_field: editForm.m2m_junction_field,
        one_collection: tableName,
        one_field: editForm.m2m_one_field || editForm.m2m_one_collection
      }
    return {
      many_field: editForm.m2a_many_field,
      one_collection_field: editForm.m2a_one_collection_field,
      one_allowed_collections: editForm.m2a_one_allowed_collections || null
    }
  }

  const isEditFormValid = (relType: RelationType): boolean => {
    if (relType === 'm2o') return !!editForm.m2o_many_field && !!editForm.m2o_one_collection
    if (relType === 'o2m') return !!editForm.o2m_many_collection && !!editForm.o2m_many_field
    if (relType === 'm2m')
      return (
        !!editForm.m2m_junction &&
        !!editForm.m2m_many_field &&
        !!editForm.m2m_junction_field &&
        !!editForm.m2m_one_collection
      )
    return !!editForm.m2a_many_field && !!editForm.m2a_one_collection_field
  }

  const updateMut = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Record<string, unknown> }) =>
      schemaApi.updateRelation(id, payload),
    onSuccess: () => {
      toast.success('Relation updated')
      setEditingId(null)
      invalidate()
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to update relation'
      toast.error(msg)
    }
  })

  const createMut = useMutation({
    mutationFn: async () => {
      if (selectedType === 'm2o' && form.m2o_is_new_field && form.m2o_many_field) {
        await schemaApi.addColumn(tableName, {
          name: form.m2o_many_field,
          type: form.m2o_new_field_type,
          nullable: true
        })
        await api.post(`/collections/${tableName}/fields`, {
          field: form.m2o_many_field,
          type: form.m2o_new_field_type
        })
      }
      if (selectedType === 'm2a' && form.m2a_is_new_field && form.m2a_many_field) {
        await schemaApi.addColumn(tableName, {
          name: form.m2a_many_field,
          type: form.m2a_new_field_type,
          nullable: true
        })
        await api.post(`/collections/${tableName}/fields`, {
          field: form.m2a_many_field,
          type: form.m2a_new_field_type
        })
      }
      if (selectedType === 'm2m' && form.m2m_auto && form.m2m_one_collection) {
        const junctionName =
          form.m2m_auto_junction_name || `${tableName}_${form.m2m_one_collection}`
        const sourceFK = `${tableName}_id`
        const targetFK = `${form.m2m_one_collection}_id`
        await schemaApi.createTable({ name: junctionName })
        await schemaApi.addColumn(junctionName, {
          name: sourceFK,
          type: 'integer',
          nullable: false
        })
        await schemaApi.addColumn(junctionName, {
          name: targetFK,
          type: 'integer',
          nullable: false
        })
        // primary relation (junction → source/this table)
        await schemaApi.createRelation({
          many_collection: junctionName,
          many_field: sourceFK,
          one_collection: tableName,
          one_field: 'id',
          junction_field: targetFK
        })
        // companion relation (junction → target table) — needed for summary display
        await schemaApi.createRelation({
          many_collection: junctionName,
          many_field: targetFK,
          one_collection: form.m2m_one_collection,
          one_field: 'id',
          junction_field: sourceFK
        })
        return
      }
      return schemaApi.createRelation(buildPayload())
    },
    onSuccess: () => {
      toast.success('Relation created')
      resetAdd()
      invalidate()
      onRefresh()
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to create relation'
      toast.error(msg)
    }
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => schemaApi.deleteRelation(id),
    onSuccess: () => {
      toast.success('Relation deleted')
      setDeleteId(null)
      invalidate()
    },
    onError: () => toast.error('Failed to delete relation')
  })

  return (
    <div className='space-y-6'>
      {/* FK constraints — collapsible */}
      {fkRelations.length > 0 && <FkConstraintsPanel relations={fkRelations} />}

      {/* CMS Relations */}
      <div>
        <div className='mb-2 flex items-center justify-between'>
          <h3 className='text-[11px] font-medium text-slate-500'>CMS Relations</h3>
          {mode === 'list' && (
            <button
              type='button'
              onClick={() => {
                setMode('add')
                setAddStep('type')
              }}
              className='flex items-center gap-1 text-[12px] text-slate-400 hover:text-nvr-cyan'
            >
              <Plus className='h-3.5 w-3.5' />
              Add relation
            </button>
          )}
        </div>

        {/* Step 1: type picker */}
        {mode === 'add' && addStep === 'type' && (
          <div className='mb-4 rounded-lg border border-slate-200 bg-white p-4'>
            <p className='mb-3 text-[12px] font-medium text-slate-700'>Choose relation type</p>
            <div className='grid grid-cols-2 gap-2'>
              {(
                Object.entries(REL_TYPE_META) as [
                  RelationType,
                  (typeof REL_TYPE_META)[RelationType]
                ][]
              ).map(([t, meta]) => (
                <button
                  key={t}
                  type='button'
                  onClick={() => setSelectedType(t)}
                  className={cn(
                    'rounded-lg border-2 p-3 text-left transition-colors',
                    selectedType === t
                      ? 'border-nvr-cyan bg-cyan-50'
                      : 'border-slate-200 hover:border-slate-300'
                  )}
                >
                  <div className='mb-1 flex items-center gap-2'>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                        meta.badgeCls
                      )}
                    >
                      {t.toUpperCase()}
                    </span>
                    <span className='text-[12px] font-medium text-slate-800'>{meta.label}</span>
                  </div>
                  <p className='text-[11px] text-slate-500'>{meta.desc}</p>
                </button>
              ))}
            </div>
            <div className='mt-3 flex justify-end gap-2'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='h-7 text-[12px]'
                onClick={resetAdd}
              >
                Cancel
              </Button>
              <Button
                type='button'
                size='sm'
                className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
                onClick={() => setAddStep('form')}
              >
                Continue →
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: type-specific form */}
        {mode === 'add' && addStep === 'form' && (
          <div className='mb-4 rounded-lg border border-slate-200 bg-white p-4'>
            <div className='mb-3 flex items-center gap-2'>
              <button
                type='button'
                onClick={() => setAddStep('type')}
                className='text-[12px] text-slate-400 hover:text-slate-600'
              >
                ← Back
              </button>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                  REL_TYPE_META[selectedType].badgeCls
                )}
              >
                {selectedType.toUpperCase()}
              </span>
              <span className='text-[12px] font-medium text-slate-700'>
                {REL_TYPE_META[selectedType].label}
              </span>
            </div>

            <RelationFormDiagram
              relType={selectedType}
              tableName={tableName}
              allTables={allTables}
              form={form}
              patch={patch}
              showFkOption
            />

            <div className='mt-4 flex justify-end gap-2'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='h-7 text-[12px]'
                onClick={resetAdd}
              >
                Cancel
              </Button>
              <Button
                type='button'
                size='sm'
                className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
                disabled={!isFormValid() || createMut.isPending}
                onClick={() => createMut.mutate()}
              >
                {createMut.isPending ? 'Creating…' : 'Create Relation'}
              </Button>
            </div>
          </div>
        )}

        {/* Existing CMS relations */}
        {relLoading ? (
          <div className='space-y-1'>
            {[1, 2].map((n) => (
              <div key={n} className='h-10 animate-pulse rounded-lg bg-slate-100' />
            ))}
          </div>
        ) : cmsRelations.length > 0 ? (
          <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
            {cmsRelations
              .filter(
                (rel) =>
                  // Only show relations directly involving this table.
                  // Junction companion rows (many_collection=junction, one_collection=other)
                  // stay in cmsRelations for M2M resolution but aren't table-level relations.
                  rel.many_collection === tableName || rel.one_collection === tableName
              )
              .map((rel, i) => {
                const t = detectRelationType(rel, tableName)
                const isDeleting = deleteId === rel.id
                const isEditing = editingId === rel.id
                return (
                  <div
                    key={rel.id}
                    className={cn('px-4 py-3', i > 0 && 'border-t border-slate-100')}
                  >
                    {isDeleting ? (
                      <div className='flex items-center gap-3'>
                        <span className='text-[12px] text-slate-700'>Delete this relation?</span>
                        <div className='ml-auto flex gap-2'>
                          <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            className='h-6 text-[11px]'
                            onClick={() => setDeleteId(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type='button'
                            size='sm'
                            className='h-6 bg-red-500 text-[11px] text-white hover:bg-red-600'
                            disabled={deleteMut.isPending}
                            onClick={() => deleteMut.mutate(rel.id)}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    ) : isEditing ? (
                      <div className='space-y-3'>
                        <div className='flex items-center gap-2'>
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                              REL_TYPE_META[t].badgeCls
                            )}
                          >
                            {t.toUpperCase()}
                          </span>
                          <span className='text-[12px] font-medium text-slate-600'>
                            Edit relation
                          </span>
                        </div>

                        <RelationFormDiagram
                          relType={t}
                          tableName={tableName}
                          allTables={allTables}
                          form={editForm}
                          patch={editPatch}
                        />

                        <div className='flex justify-end gap-2'>
                          <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            className='h-7 text-[12px]'
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type='button'
                            size='sm'
                            className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
                            disabled={!isEditFormValid(t) || updateMut.isPending}
                            onClick={() =>
                              updateMut.mutate({ id: rel.id, payload: buildEditPayload(t) })
                            }
                          >
                            {updateMut.isPending ? 'Saving…' : 'Save Changes'}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className='flex items-center gap-2'>
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                            REL_TYPE_META[t].badgeCls
                          )}
                        >
                          {t.toUpperCase()}
                        </span>
                        <span className='font-mono text-[12px] text-slate-700'>
                          {formatRelSummary(rel)}
                        </span>
                        <div className='ml-auto flex items-center gap-1'>
                          <button
                            type='button'
                            onClick={() => startEdit(rel)}
                            className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700'
                            title='Edit relation'
                          >
                            <Pencil className='h-3.5 w-3.5' />
                          </button>
                          <button
                            type='button'
                            onClick={() => setDeleteId(rel.id)}
                            className='rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500'
                            title='Delete relation'
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        ) : mode === 'list' ? (
          <div className='rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-[13px] text-slate-400'>
            No CMS relations defined for this collection.
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

// ─── Display template chip editor ────────────────────────────────────────────

function SettingsTab({
  tableData,
  tableName,
  onRefresh
}: {
  tableData: DBTableDetail
  tableName: string
  onRefresh: () => void
}) {
  const qc = useQueryClient()
  const meta = tableData.collection_meta

  // Draft state: null means "use server value". Set on edit, cleared on save.
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [singularDraft, setSingularDraft] = useState<string | null>(null)
  const [pluralDraft, setPluralDraft] = useState<string | null>(null)
  const [iconDraft, setIconDraft] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState<string | null>(null)
  const [templateDraft, setTemplateDraft] = useState<string | null>(null)

  // Reset drafts when tableName changes (navigating between tables)
  const prevTableRef = useRef(tableName)
  if (prevTableRef.current !== tableName) {
    prevTableRef.current = tableName
    if (nameDraft !== null) setNameDraft(null)
    if (singularDraft !== null) setSingularDraft(null)
    if (pluralDraft !== null) setPluralDraft(null)
    if (iconDraft !== null) setIconDraft(null)
    if (noteDraft !== null) setNoteDraft(null)
    if (templateDraft !== null) setTemplateDraft(null)
  }

  const displayName = nameDraft ?? meta?.display_name ?? ''
  const singular = singularDraft ?? meta?.singular ?? ''
  const plural = pluralDraft ?? meta?.plural ?? ''
  const icon = iconDraft ?? meta?.icon ?? ''
  const note = noteDraft ?? meta?.note ?? ''
  const displayTemplate = templateDraft ?? meta?.display_template ?? ''

  const registerMutation = useMutation({
    mutationFn: () =>
      schemaApi.registerCollection(tableName, {
        display_name: displayName || undefined,
        singular: singular || null,
        plural: plural || null,
        icon: icon || undefined,
        note: note || undefined,
        display_template: displayTemplate || null
      }),
    onSuccess: () => {
      toast.success('Collection settings saved')
      setNameDraft(null)
      setSingularDraft(null)
      setPluralDraft(null)
      setIconDraft(null)
      setNoteDraft(null)
      // Don't clear templateDraft — clearing it causes DisplayTemplateEditor to briefly
      // see stale meta and reset its internal tokens state before the refetch completes.
      // Draft is cleared naturally on table navigation via prevTableRef.
      qc.invalidateQueries({ queryKey: ['data-model-table', tableName] })
      onRefresh()
    },
    onError: () => toast.error('Failed to save settings')
  })

  if (!tableData.registered) {
    return (
      <div className='rounded-lg border border-slate-200 bg-white px-6 py-8 text-center'>
        <Eye className='mx-auto mb-3 h-6 w-6 text-slate-300' />
        <p className='text-[13px] text-slate-500'>
          This table is not registered as a CMS collection.
        </p>
        <p className='mt-1 text-[12px] text-slate-400'>
          Register it from the header to configure display settings.
        </p>
      </div>
    )
  }

  return (
    <div className='space-y-4'>
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white p-6'>
        <h3 className='mb-4 text-[11px] font-medium text-slate-500'>Collection Settings</h3>
        <div className='space-y-4 max-w-sm'>
          <div>
            <Label className='mb-1 block text-[12px]'>Display name</Label>
            <Input
              value={displayName}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder={tableName}
              className='text-[13px]'
            />
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div>
              <Label className='mb-1 block text-[12px]'>Singular</Label>
              <Input
                value={singular}
                onChange={(e) => setSingularDraft(e.target.value)}
                placeholder={displayName || tableName}
                className='text-[13px]'
              />
            </div>
            <div>
              <Label className='mb-1 block text-[12px]'>Plural</Label>
              <Input
                value={plural}
                onChange={(e) => setPluralDraft(e.target.value)}
                placeholder={displayName || tableName}
                className='text-[13px]'
              />
            </div>
          </div>
          <div>
            <Label className='mb-1 block text-[12px]'>Icon</Label>
            <IconPicker value={icon} onChange={setIconDraft} />
          </div>
          <div>
            <Label className='mb-1 block text-[12px]'>Note</Label>
            <Input
              value={note}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder='A short description of this collection'
              className='text-[13px]'
            />
          </div>
          <div>
            <Label className='mb-1 block text-[12px]'>Display template</Label>
            <DisplayTemplateEditor
              value={displayTemplate}
              onChange={setTemplateDraft}
              collection={tableName}
            />
            <p className='mt-1 text-[11px] text-slate-400'>
              Used in relation pickers and list previews. Insert field chips with the + button.
            </p>
          </div>
          <Button
            type='button'
            size='sm'
            className='bg-nvr-cyan text-white hover:bg-nvr-cyan-dark'
            disabled={registerMutation.isPending}
            onClick={() => registerMutation.mutate()}
          >
            {registerMutation.isPending ? 'Saving…' : 'Save Settings'}
          </Button>
        </div>
      </div>
      <ItemLockingSection tableName={tableName} />
      <AddendumsSection tableName={tableName} />
      <PickerFilterSection tableName={tableName} />
      <AiFeaturesCard tableName={tableName} />
    </div>
  )
}

// ─── Item locking toggle (Settings tab) ────────────────────────────────────────

function ItemLockingSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()

  const { data: config } = useQuery({
    queryKey: ['item-locking-config', tableName],
    queryFn: () =>
      api
        .get<{ data: { item_locking_enabled: boolean } }>(`/item-locks/config/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName
  })

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch(`/item-locks/config/${tableName}`, { item_locking_enabled: enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['item-locking-config', tableName] })
      toast.success('Item locking setting saved')
    },
    onError: () => toast.error('Failed to update setting')
  })

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='flex items-center justify-between px-4 py-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Item locking</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Prevents simultaneous edits — shows an amber banner and read-only mode to other users
            while someone is editing a record.
          </p>
        </div>
        <Switch
          checked={config?.item_locking_enabled ?? true}
          onCheckedChange={(v) => toggleMut.mutate(v)}
          disabled={toggleMut.isPending || config === undefined}
        />
      </div>
      {config?.item_locking_enabled === false && (
        <div className='border-t border-slate-100 bg-amber-50 px-4 py-2.5'>
          <p className='text-[11px] text-amber-700'>
            Locking disabled — multiple users can edit the same record simultaneously. Any existing
            locks on this collection have been released.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Addendums toggle + state restrictions (Settings tab) ─────────────────────

function AddendumPipelineRow({
  pipeline,
  stateKeys,
  onStateKeysChange
}: {
  pipeline: { id: string; name: string }
  stateKeys: string[]
  onStateKeysChange: (keys: string[]) => void
}) {
  const { data: detail } = useQuery<{
    states: Array<{ id: string; key: string; label: string; color?: string }>
  }>({
    queryKey: ['pipeline-detail-lock', pipeline.id],
    queryFn: () => api.get(`/pipelines/${pipeline.id}`).then((r) => r.data.data),
    staleTime: 60_000
  })
  const states = detail?.states ?? []

  return (
    <div className='mt-3'>
      <p className='text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5'>
        {pipeline.name}
      </p>
      {states.length === 0 ? (
        <p className='text-[11px] text-slate-400 italic'>No states defined.</p>
      ) : (
        <div className='grid grid-cols-2 gap-x-4 gap-y-1'>
          {states.map((s) => (
            <label
              key={s.key}
              className='flex items-center gap-1.5 text-[11px] cursor-pointer select-none'
            >
              <input
                type='checkbox'
                checked={stateKeys.includes(s.key)}
                onChange={(e) => {
                  if (e.target.checked) onStateKeysChange([...stateKeys, s.key])
                  else onStateKeysChange(stateKeys.filter((k) => k !== s.key))
                }}
                className='rounded'
              />
              <span className='inline-flex items-center gap-1'>
                {s.color && (
                  <span className='h-2 w-2 rounded-full shrink-0' style={{ background: s.color }} />
                )}
                <span className='text-slate-700 dark:text-slate-300'>{s.label}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function AddendumsSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()

  const { data: col } = useQuery({
    queryKey: ['collection-meta', tableName],
    queryFn: () =>
      api
        .get<{
          data: {
            addendums_enabled: boolean
            addendum_allowed_states?: string | null
            addendum_allowed_roles?: string | null
          }
        }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 10 * 60 * 1000
  })

  const toggleMut = useMutation({
    mutationFn: (v: boolean) =>
      api.patch(`/collections/${tableName}`, { addendums_enabled: v ? 1 : 0 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection-meta', tableName] })
      toast.success('Addendums setting saved')
    },
    onError: () => toast.error('Failed to update setting')
  })

  const enabled = col?.addendums_enabled === true || (col?.addendums_enabled as unknown) === 1

  // State restrictions
  const [stateRules, setStateRules] = useState<
    Array<{ pipeline_id: string; state_keys: string[] }>
  >([])
  const [rulesInit, setRulesInit] = useState(false)

  useEffect(() => {
    if (col !== undefined && !rulesInit) {
      try {
        const parsed = col.addendum_allowed_states ? JSON.parse(col.addendum_allowed_states) : []
        setStateRules(Array.isArray(parsed) ? parsed : [])
      } catch {
        setStateRules([])
      }
      setRulesInit(true)
    }
  }, [col, rulesInit])

  const saveRulesMut = useMutation({
    mutationFn: (rules: typeof stateRules) =>
      api.patch(`/collections/${tableName}`, {
        addendum_allowed_states: rules.length ? JSON.stringify(rules) : null
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection-meta', tableName] })
      toast.success('State restrictions saved')
    },
    onError: () => toast.error('Failed to save state restrictions')
  })

  const { data: pipelinesData } = useQuery<
    Array<{ id: string; name: string; collections: string[] }>
  >({
    queryKey: ['pipelines-list-for-lock'],
    queryFn: () => api.get('/pipelines').then((r) => r.data.data),
    staleTime: 60_000,
    enabled: enabled && !!tableName
  })
  const boundPipelines = (pipelinesData ?? []).filter((p) => p.collections.includes(tableName))

  const updateRule = (pipelineId: string, stateKeys: string[]) => {
    setStateRules((prev) => {
      const next = prev.filter((r) => r.pipeline_id !== pipelineId)
      if (stateKeys.length > 0) next.push({ pipeline_id: pipelineId, state_keys: stateKeys })
      return next
    })
  }

  // Role restrictions
  const [allowedRoles, setAllowedRoles] = useState<string[]>([])
  const [rolesInit, setRolesInit] = useState(false)

  useEffect(() => {
    if (col !== undefined && !rolesInit) {
      try {
        const parsed = col.addendum_allowed_roles ? JSON.parse(col.addendum_allowed_roles) : []
        setAllowedRoles(Array.isArray(parsed) ? parsed : [])
      } catch {
        setAllowedRoles([])
      }
      setRolesInit(true)
    }
  }, [col, rolesInit])

  const saveRolesMut = useMutation({
    mutationFn: (roles: string[]) =>
      api.patch(`/collections/${tableName}`, {
        addendum_allowed_roles: roles.length ? JSON.stringify(roles) : null
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection-meta', tableName] })
      toast.success('Role restrictions saved')
    },
    onError: () => toast.error('Failed to save role restrictions')
  })

  const { data: allRoles = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['roles-list-addendum'],
    queryFn: () => api.get('/roles').then((r) => r.data.data ?? []),
    staleTime: 60_000,
    enabled: enabled && !!tableName
  })

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='flex items-center justify-between px-4 py-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800 dark:text-slate-100'>Addendums</p>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-slate-400'>
            Allow addendum records to be created against items in this collection, with optional
            cost and timeline impact tracking.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => toggleMut.mutate(v)}
          disabled={toggleMut.isPending || col === undefined}
        />
      </div>

      {enabled && (
        <div className='border-t border-slate-100 dark:border-border px-4 pb-4 pt-3'>
          <div className='flex items-center justify-between mb-1'>
            <div>
              <p className='text-[12px] font-medium text-slate-700 dark:text-slate-300'>
                State restrictions
              </p>
              <p className='text-[11px] text-slate-500 dark:text-slate-400 mt-0.5'>
                Check the pipeline states from which addendums can be created. Leave all unchecked
                to allow from any state.
              </p>
            </div>
            <Button
              size='sm'
              variant='outline'
              className='h-7 text-[11px] shrink-0 ml-4'
              onClick={() => saveRulesMut.mutate(stateRules)}
              disabled={saveRulesMut.isPending}
            >
              Save
            </Button>
          </div>

          {boundPipelines.length === 0 ? (
            <p className='mt-2 text-[11px] text-slate-400 italic'>
              No pipelines are bound to this collection.
            </p>
          ) : (
            boundPipelines.map((pipeline) => (
              <AddendumPipelineRow
                key={pipeline.id}
                pipeline={pipeline}
                stateKeys={stateRules.find((r) => r.pipeline_id === pipeline.id)?.state_keys ?? []}
                onStateKeysChange={(keys) => updateRule(pipeline.id, keys)}
              />
            ))
          )}

          <div className='mt-4 border-t border-slate-100 dark:border-border pt-3'>
            <div className='flex items-center justify-between mb-1'>
              <div>
                <p className='text-[12px] font-medium text-slate-700 dark:text-slate-300'>
                  Role restrictions
                </p>
                <p className='text-[11px] text-slate-500 dark:text-slate-400 mt-0.5'>
                  Roles allowed to create addendums. Leave all unchecked to allow any role.
                </p>
              </div>
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-[11px] shrink-0 ml-4'
                onClick={() => saveRolesMut.mutate(allowedRoles)}
                disabled={saveRolesMut.isPending}
              >
                Save
              </Button>
            </div>
            {allRoles.length === 0 ? (
              <p className='mt-2 text-[11px] text-slate-400 italic'>No roles defined.</p>
            ) : (
              <div className='grid grid-cols-2 gap-x-4 gap-y-1 mt-2'>
                {allRoles.map((role) => (
                  <label
                    key={role.id}
                    className='flex items-center gap-1.5 text-[11px] cursor-pointer select-none'
                  >
                    <input
                      type='checkbox'
                      checked={allowedRoles.includes(role.id)}
                      onChange={(e) => {
                        if (e.target.checked) setAllowedRoles((prev) => [...prev, role.id])
                        else setAllowedRoles((prev) => prev.filter((r) => r !== role.id))
                      }}
                      className='rounded'
                    />
                    <span className='text-slate-700 dark:text-slate-300'>{role.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Relation Picker Filter (Settings tab) ────────────────────────────────────

function PickerFilterSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()

  const { data: col } = useQuery({
    queryKey: ['collection-meta', tableName],
    queryFn: () =>
      api
        .get<{ data: { picker_filter: unknown } }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 10 * 60 * 1000
  })

  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [initialised, setInitialised] = useState(false)

  useEffect(() => {
    if (col !== undefined && !initialised) {
      setDraft(col.picker_filter ? JSON.stringify(col.picker_filter, null, 2) : '')
      setInitialised(true)
    }
  }, [col, initialised])

  const save = async () => {
    if (!draft.trim()) {
      await api.patch(`/collections/${tableName}`, { picker_filter: null })
      qc.invalidateQueries({ queryKey: ['collection-meta', tableName] })
      toast.success('Picker filter cleared')
      return
    }
    try {
      const parsed = JSON.parse(draft)
      setError('')
      await api.patch(`/collections/${tableName}`, { picker_filter: parsed })
      qc.invalidateQueries({ queryKey: ['collection-meta', tableName] })
      toast.success('Picker filter saved')
    } catch {
      setError('Invalid JSON — check the filter expression')
    }
  }

  const clear = async () => {
    setDraft('')
    setError('')
    await api.patch(`/collections/${tableName}`, { picker_filter: null })
    qc.invalidateQueries({ queryKey: ['collection-meta', tableName] })
    toast.success('Picker filter cleared')
  }

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='px-4 py-3 space-y-2'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Relation Picker Filter</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Records not matching this filter are hidden from all relation pickers for this
            collection. Existing references are unaffected.
          </p>
        </div>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={'{"is_disabled": {"_neq": true}}'}
          rows={3}
          className='font-mono text-[12px]'
        />
        {error && <p className='text-[11px] text-red-500'>{error}</p>}
        <p className='text-[11px] text-slate-400'>
          Tip: use attribute filters — hard-coded IDs break on data migration.
        </p>
        <div className='flex gap-2'>
          <Button size='sm' onClick={save} className='h-7 text-[12px]'>
            Save filter
          </Button>
          {draft && (
            <Button size='sm' variant='outline' onClick={clear} className='h-7 text-[12px]'>
              Clear
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── AI Features card (Settings tab) ───────────────────────────────────────────

// Mirrors api/src/hooks/aggregate-caps.ts isSumCapRule — a typed rule entry
// living alongside plain AI-prompt strings in the same validation_rules array.
interface SumCapRule {
  type: 'sum_cap'
  severity: 'block' | 'warn'
  sum_field: string
  group_by: string
  cap: { relation: string; field: string }
  message: string
}

type ValidationRuleEntry = string | SumCapRule

const EMPTY_SUM_CAP_RULE: SumCapRule = {
  type: 'sum_cap',
  severity: 'block',
  sum_field: '',
  group_by: '',
  cap: { relation: '', field: '' },
  message: ''
}

function isSumCapRuleFilledIn(rule: SumCapRule): boolean {
  return (
    rule.sum_field.trim() !== '' &&
    rule.group_by.trim() !== '' &&
    rule.cap.relation.trim() !== '' &&
    rule.cap.field.trim() !== ''
  )
}

interface AiCollectionSettings {
  collection: string
  validation_enabled: boolean
  validation_mode: 'soft' | 'hard'
  validation_rules: ValidationRuleEntry[]
  duplicate_detection_enabled: boolean
  duplicate_threshold: number
}

// Sum cap rule editor — sum field / group-by / cap relation / cap field
// Comboboxes, severity radio, message input. Group-by and cap-relation share
// the same option set: M2O fields on this collection (falls back to all
// fields when relations haven't loaded yet). Cap field lists the fields of
// whichever collection the chosen cap relation points to.
function SumCapRuleEditor({
  tableName,
  rule,
  onChange,
  onRemove
}: {
  tableName: string
  rule: SumCapRule
  onChange: (next: SumCapRule) => void
  onRemove: () => void
}) {
  const severityName = useId()

  const { data: fieldsMeta } = useQuery({
    queryKey: ['collection-meta', tableName],
    queryFn: () =>
      api
        .get<{ data: { fields: { field: string; type: string; hidden?: boolean }[] } }>(
          `/collections/${tableName}`
        )
        .then((r) => r.data.data),
    staleTime: 30_000
  })
  const fieldOptions = (fieldsMeta?.fields ?? [])
    .filter((f) => !f.hidden)
    .map((f) => ({ value: f.field, label: `${f.field} (${f.type})` }))

  const { data: relData } = useQuery({
    queryKey: ['cms-relations', tableName],
    queryFn: () => schemaApi.getCMSRelations(tableName)
  })
  const m2oRelations = (relData?.data ?? []).filter(
    (r) => r.many_collection === tableName && !r.junction_field
  )
  const relationOptions = m2oRelations.length
    ? m2oRelations.map((r) => ({
        value: r.many_field,
        label: `${r.many_field} → ${r.one_collection}`
      }))
    : fieldOptions

  const selectedRelation = m2oRelations.find((r) => r.many_field === rule.cap.relation)
  const parentCollection = selectedRelation?.one_collection ?? null

  const { data: parentFieldsMeta } = useQuery({
    queryKey: ['collection-meta', parentCollection],
    queryFn: () =>
      api
        .get<{ data: { fields: { field: string; type: string; hidden?: boolean }[] } }>(
          `/collections/${parentCollection}`
        )
        .then((r) => r.data.data),
    enabled: !!parentCollection,
    staleTime: 30_000
  })
  const parentFieldOptions = (parentFieldsMeta?.fields ?? [])
    .filter((f) => !f.hidden)
    .map((f) => ({ value: f.field, label: `${f.field} (${f.type})` }))

  return (
    <div className='space-y-2.5 rounded-md border border-slate-200 p-3'>
      <div className='flex items-center justify-between'>
        <p className='text-[11px] font-medium text-slate-600'>Sum Cap Rule</p>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='h-6 w-6 shrink-0 text-destructive hover:text-destructive'
          onClick={onRemove}
        >
          <Trash2 className='h-3.5 w-3.5' />
        </Button>
      </div>

      <div className='grid grid-cols-2 gap-3'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Sum field</Label>
          <Combobox
            value={rule.sum_field}
            onChange={(v) => onChange({ ...rule, sum_field: v })}
            options={fieldOptions}
            placeholder='Select field…'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Group by</Label>
          <Combobox
            value={rule.group_by}
            onChange={(v) => onChange({ ...rule, group_by: v })}
            options={relationOptions}
            placeholder='Select field…'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Cap relation</Label>
          <Combobox
            value={rule.cap.relation}
            onChange={(v) => onChange({ ...rule, cap: { relation: v, field: '' } })}
            options={relationOptions}
            placeholder='Select relation…'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Cap field</Label>
          <Combobox
            value={rule.cap.field}
            onChange={(v) => onChange({ ...rule, cap: { ...rule.cap, field: v } })}
            options={parentFieldOptions}
            placeholder={parentCollection ? 'Select field…' : 'Select cap relation first'}
            disabled={!parentCollection}
          />
        </div>
      </div>

      <div className='flex items-center gap-4 text-[12px]'>
        <span className='text-[11px] text-slate-500'>Severity:</span>
        <label className='flex cursor-pointer items-center gap-1.5'>
          <input
            type='radio'
            name={severityName}
            checked={rule.severity === 'block'}
            onChange={() => onChange({ ...rule, severity: 'block' })}
          />
          Block
        </label>
        <label className='flex cursor-pointer items-center gap-1.5'>
          <input
            type='radio'
            name={severityName}
            checked={rule.severity === 'warn'}
            onChange={() => onChange({ ...rule, severity: 'warn' })}
          />
          Warn
        </label>
      </div>

      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500'>Message</Label>
        <Input
          value={rule.message}
          onChange={(e) => onChange({ ...rule, message: e.target.value })}
          placeholder='Shown to the editor when the cap is exceeded'
          className='h-7 text-[12px]'
        />
      </div>
    </div>
  )
}

function AiFeaturesCard({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const { data: settings, isLoading } = useQuery<AiCollectionSettings>({
    queryKey: ['ai-settings', tableName],
    queryFn: () =>
      api.get<{ data: AiCollectionSettings }>(`/ai-settings/${tableName}`).then((r) => r.data.data)
  })

  const [validationEnabled, setValidationEnabled] = useState(false)
  const [validationMode, setValidationMode] = useState<'soft' | 'hard'>('soft')
  const [rules, setRules] = useState<ValidationRuleEntry[]>([])
  const [dupEnabled, setDupEnabled] = useState(false)
  const [dupThreshold, setDupThreshold] = useState(0.85)
  const [seeded, setSeeded] = useState(false)

  useEffect(() => {
    if (settings && !seeded) {
      setValidationEnabled(settings.validation_enabled)
      setValidationMode(settings.validation_mode)
      setRules(settings.validation_rules)
      setDupEnabled(settings.duplicate_detection_enabled)
      setDupThreshold(settings.duplicate_threshold)
      setSeeded(true)
    }
  }, [settings, seeded])

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch(`/ai-settings/${tableName}`, {
        validation_enabled: validationEnabled,
        validation_mode: validationMode,
        validation_rules: rules
          .map((r) => (typeof r === 'string' ? r.trim() : r))
          .filter((r) => (typeof r === 'string' ? r.length > 0 : true)),
        duplicate_detection_enabled: dupEnabled,
        duplicate_threshold: Number(dupThreshold)
      }),
    onSuccess: () => {
      toast.success('AI feature settings saved')
      qc.invalidateQueries({ queryKey: ['ai-settings', tableName] })
    },
    onError: () => toast.error('Failed to save AI settings')
  })

  if (isLoading) {
    return (
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white p-6'>
        <h3 className='mb-4 text-[11px] font-medium text-slate-500'>AI Features</h3>
        <Skeleton className='h-24 w-full max-w-md' />
      </div>
    )
  }

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white p-6'>
      <h3 className='mb-4 text-[11px] font-medium text-slate-500'>AI Features</h3>
      <div className='space-y-6 max-w-xl'>
        {/* Content Validation */}
        <div className='space-y-3'>
          <div className='flex items-center gap-3'>
            <Switch
              id='ai-validation-enabled'
              checked={validationEnabled}
              onCheckedChange={setValidationEnabled}
            />
            <Label htmlFor='ai-validation-enabled' className='cursor-pointer text-[12px]'>
              Content Validation
            </Label>
            <span className='text-[11px] text-slate-400'>
              Evaluate records against natural-language rules with Claude on save
            </span>
          </div>

          {validationEnabled && (
            <div className='space-y-3 pl-1'>
              <div>
                <Label className='mb-1 block text-[12px]'>Mode</Label>
                <div className='inline-flex rounded-md border border-slate-200 p-0.5'>
                  <Button
                    type='button'
                    size='sm'
                    variant={validationMode === 'soft' ? 'default' : 'ghost'}
                    className='h-6 px-3 text-[11px]'
                    onClick={() => setValidationMode('soft')}
                  >
                    Warn
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    variant={validationMode === 'hard' ? 'default' : 'ghost'}
                    className='h-6 px-3 text-[11px]'
                    onClick={() => setValidationMode('hard')}
                  >
                    Block
                  </Button>
                </div>
                <p className='mt-1 text-[11px] text-slate-400'>
                  {validationMode === 'soft'
                    ? 'Violations notify the editor but the save still goes through'
                    : 'Violations reject the save with a 422 error'}
                </p>
              </div>

              <div>
                <div className='mb-1 flex items-center justify-between'>
                  <Label className='text-[12px]'>Rules</Label>
                  <div className='flex gap-1.5'>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      className='h-6 px-2 text-[11px]'
                      onClick={() => setRules((prev) => [...prev, ''])}
                    >
                      <Plus className='mr-1 h-3 w-3' />
                      AI Prompt
                    </Button>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      className='h-6 px-2 text-[11px]'
                      onClick={() => setRules((prev) => [...prev, { ...EMPTY_SUM_CAP_RULE }])}
                    >
                      <Plus className='mr-1 h-3 w-3' />
                      Sum Cap
                    </Button>
                  </div>
                </div>
                {rules.length === 0 ? (
                  <p className='text-[11px] text-slate-400'>
                    No rules yet — e.g. "description must be at least 50 words"
                  </p>
                ) : (
                  <div className='space-y-2'>
                    {rules.map((rule, i) => {
                      return typeof rule === 'string' ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional
                        <div key={i} className='flex items-start gap-2'>
                          <Textarea
                            value={rule}
                            onChange={(e) =>
                              setRules((prev) =>
                                prev.map((r, idx) => (idx === i ? e.target.value : r))
                              )
                            }
                            placeholder='e.g. "description must be at least 50 words"'
                            rows={2}
                            className='min-h-0 text-[12px]'
                          />
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon'
                            className='h-7 w-7 shrink-0 text-destructive hover:text-destructive'
                            onClick={() => setRules((prev) => prev.filter((_, idx) => idx !== i))}
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </Button>
                        </div>
                      ) : (
                        <SumCapRuleEditor
                          // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional
                          key={i}
                          tableName={tableName}
                          rule={rule}
                          onChange={(next) =>
                            setRules((prev) => prev.map((r, idx) => (idx === i ? next : r)))
                          }
                          onRemove={() => setRules((prev) => prev.filter((_, idx) => idx !== i))}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Duplicate Detection */}
        <div className='space-y-3 border-t border-slate-100 pt-4'>
          <div className='flex items-center gap-3'>
            <Switch id='ai-dup-enabled' checked={dupEnabled} onCheckedChange={setDupEnabled} />
            <Label htmlFor='ai-dup-enabled' className='cursor-pointer text-[12px]'>
              Duplicate Detection
            </Label>
            <span className='text-[11px] text-slate-400'>
              Flag new records that look similar to existing ones
            </span>
          </div>

          {dupEnabled && (
            <div className='pl-1'>
              <Label className='mb-1 block text-[12px]'>Similarity threshold</Label>
              <div className='flex items-center gap-3'>
                <input
                  type='range'
                  min={0.5}
                  max={0.99}
                  step={0.01}
                  value={dupThreshold}
                  onChange={(e) => setDupThreshold(Number(e.target.value))}
                  className='h-1.5 w-48 cursor-pointer accent-[#00ceff]'
                />
                <Input
                  type='number'
                  min={0.5}
                  max={0.99}
                  step={0.01}
                  value={dupThreshold}
                  onChange={(e) => setDupThreshold(Number(e.target.value))}
                  className='h-7 w-20 text-[12px]'
                />
              </div>
              <p className='mt-1 text-[11px] text-slate-400'>
                0.5 = loose matching, 0.99 = near-identical only (default 0.85)
              </p>
            </div>
          )}
        </div>

        <Button
          type='button'
          size='sm'
          className='bg-nvr-cyan text-white hover:bg-nvr-cyan-dark'
          disabled={saveMutation.isPending}
          onClick={() => {
            const incomplete = rules.some(
              (r) => typeof r !== 'string' && r.type === 'sum_cap' && !isSumCapRuleFilledIn(r)
            )
            if (incomplete) {
              toast.error('Complete all Sum Cap rule fields before saving')
              return
            }
            saveMutation.mutate()
          }}
        >
          {saveMutation.isPending ? 'Saving…' : 'Save AI Settings'}
        </Button>
      </div>
    </div>
  )
}

// ─── Attributes tab (Dynamic EAV) ──────────────────────────────────────────────

interface AttributeDefinition {
  id: number
  collection: string
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'date' | 'select'
  options: string[] | null
  required: boolean
  sort: number
  is_active: boolean
}

const ATTR_TYPE_OPTIONS: { value: AttributeDefinition['type']; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Select' }
]

function AttrTypeCombobox({
  value,
  onChange
}: {
  value: AttributeDefinition['type']
  onChange: (v: AttributeDefinition['type']) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = ATTR_TYPE_OPTIONS.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-7 w-full justify-between px-2 text-[12px] font-normal'
        >
          <span className='truncate'>{selected?.label ?? 'Select type…'}</span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[180px] p-0' align='start'>
        <Command>
          <CommandList>
            <CommandGroup>
              {ATTR_TYPE_OPTIONS.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={() => {
                    onChange(opt.value)
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

function AttributeDefRow({
  def,
  onUpdate,
  onDelete,
  saving
}: {
  def: AttributeDefinition
  onUpdate: (patch: Partial<AttributeDefinition>) => void
  onDelete: () => void
  saving: boolean
}) {
  const [label, setLabel] = useState(def.label)
  const [optionsText, setOptionsText] = useState((def.options ?? []).join(', '))
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setLabel(def.label)
    setOptionsText((def.options ?? []).join(', '))
  }, [def.label, def.options])

  const parseOpts = () =>
    optionsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  return (
    <div className='border-t border-slate-100 px-4 py-3 first:border-t-0'>
      <div className='flex items-start gap-3'>
        <div className='grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4'>
          <div>
            <Label className='mb-1 block text-[11px]'>Key</Label>
            <div className='flex h-7 items-center rounded-md bg-slate-100 px-2 font-mono text-[12px] text-slate-500'>
              {def.key}
            </div>
          </div>
          <div>
            <Label className='mb-1 block text-[11px]'>Label</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={() => {
                if (label.trim() && label !== def.label) onUpdate({ label: label.trim() })
              }}
              className='h-7 text-[12px]'
            />
          </div>
          <div>
            <Label className='mb-1 block text-[11px]'>Type</Label>
            <AttrTypeCombobox value={def.type} onChange={(type) => onUpdate({ type })} />
          </div>
          <div className='flex items-end gap-3 pb-0.5'>
            <span className='flex items-center gap-1.5 text-[12px]'>
              <Switch
                checked={def.required}
                onCheckedChange={(required) => onUpdate({ required })}
              />
              Required
            </span>
          </div>
          {def.type === 'select' && (
            <div className='col-span-2 sm:col-span-4'>
              <Label className='mb-1 block text-[11px]'>Options (comma-separated)</Label>
              <Input
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                onBlur={() => {
                  const next = parseOpts()
                  if (JSON.stringify(next) !== JSON.stringify(def.options ?? []))
                    onUpdate({ options: next })
                }}
                placeholder='low, medium, high'
                className='h-7 text-[12px]'
              />
            </div>
          )}
        </div>
        <div className='flex shrink-0 items-center gap-2 pt-5'>
          <span className='flex items-center gap-1.5 text-[11px] text-slate-500'>
            <Switch
              checked={def.is_active}
              onCheckedChange={(is_active) => onUpdate({ is_active })}
            />
            Active
          </span>
          {confirmDelete ? (
            <div className='flex items-center gap-1'>
              <Button
                size='sm'
                variant='destructive'
                className='h-6 text-[11px]'
                disabled={saving}
                onClick={onDelete}
              >
                Delete
              </Button>
              <Button
                size='sm'
                variant='outline'
                className='h-6 text-[11px]'
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <button
              type='button'
              onClick={() => setConfirmDelete(true)}
              className='rounded p-1 text-slate-400 hover:text-red-500'
              title='Delete attribute'
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function AddAttributeForm({
  tableName,
  nextSort,
  onSuccess,
  onCancel
}: {
  tableName: string
  nextSort: number
  onSuccess: () => void
  onCancel: () => void
}) {
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [type, setType] = useState<AttributeDefinition['type']>('text')
  const [optionsText, setOptionsText] = useState('')
  const [required, setRequired] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleSubmit = async () => {
    if (!key.trim() || !label.trim()) return
    setSaving(true)
    try {
      await api.post('/attribute-definitions', {
        collection: tableName,
        key: key.trim(),
        label: label.trim(),
        type,
        options:
          type === 'select'
            ? optionsText
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : null,
        required,
        sort: nextSort,
        is_active: true
      })
      toast.success(`Attribute "${key.trim()}" added`)
      onSuccess()
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to add attribute'
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='border-t border-slate-200 bg-slate-50 p-4'>
      <p className='mb-3 text-[12px] font-medium text-slate-500'>Add Attribute</p>
      <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
        <div>
          <Label className='mb-1 block text-[11px]'>Key (slug)</Label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
            placeholder='priority_score'
            className='h-7 font-mono text-[12px]'
          />
        </div>
        <div>
          <Label className='mb-1 block text-[11px]'>Label</Label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder='Priority Score'
            className='h-7 text-[12px]'
          />
        </div>
        <div>
          <Label className='mb-1 block text-[11px]'>Type</Label>
          <AttrTypeCombobox value={type} onChange={setType} />
        </div>
        <div className='flex items-end pb-1'>
          <span className='flex items-center gap-1.5 text-[12px]'>
            <Switch checked={required} onCheckedChange={setRequired} />
            Required
          </span>
        </div>
        {type === 'select' && (
          <div className='col-span-2 sm:col-span-4'>
            <Label className='mb-1 block text-[11px]'>Options (comma-separated)</Label>
            <Input
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              placeholder='low, medium, high'
              className='h-7 text-[12px]'
            />
          </div>
        )}
      </div>
      <div className='mt-3 flex items-center justify-end gap-2'>
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='h-7 text-[12px]'
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type='button'
          size='sm'
          className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
          disabled={!key.trim() || !label.trim() || saving}
          onClick={handleSubmit}
        >
          {saving ? 'Adding…' : 'Add Attribute'}
        </Button>
      </div>
    </div>
  )
}

function AttributesTab({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)

  const { data: defs, isLoading } = useQuery({
    queryKey: ['attribute-definitions', tableName],
    queryFn: () =>
      api
        .get<{ data: AttributeDefinition[] }>('/attribute-definitions', {
          params: { collection: tableName }
        })
        .then((r) => r.data.data),
    enabled: !!tableName
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['attribute-definitions', tableName] })

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<AttributeDefinition> }) =>
      api.patch(`/attribute-definitions/${id}`, patch),
    onSuccess: () => {
      invalidate()
      toast.success('Attribute updated')
    },
    onError: () => toast.error('Failed to update attribute')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/attribute-definitions/${id}`),
    onSuccess: () => {
      invalidate()
      toast.success('Attribute deleted')
    },
    onError: () => toast.error('Failed to delete attribute')
  })

  const list = defs ?? []
  const nextSort = list.length ? Math.max(...list.map((d) => d.sort)) + 1 : 0

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[12px] text-slate-500'>
          Dynamic attributes are stored separately from the table — no column or migration needed.
          They appear as a "Custom Attributes" card on each item editor.
        </p>
      </div>

      {isLoading ? (
        <div className='space-y-2 p-4'>
          {[1, 2, 3].map((k) => (
            <Skeleton key={k} className='h-10 w-full rounded-lg' />
          ))}
        </div>
      ) : list.length === 0 && !adding ? (
        <div className='px-4 py-8 text-center text-[13px] text-slate-400'>
          No custom attributes defined for this collection
        </div>
      ) : (
        list.map((def) => (
          <AttributeDefRow
            key={def.id}
            def={def}
            onUpdate={(patch) => updateMut.mutate({ id: def.id, patch })}
            onDelete={() => deleteMut.mutate(def.id)}
            saving={deleteMut.isPending}
          />
        ))
      )}

      {adding ? (
        <AddAttributeForm
          tableName={tableName}
          nextSort={nextSort}
          onSuccess={() => {
            setAdding(false)
            invalidate()
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className='border-t border-slate-100 px-4 py-2.5'>
          <button
            type='button'
            onClick={() => setAdding(true)}
            className='flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-nvr-cyan'
          >
            <Plus className='h-3.5 w-3.5' />
            Add attribute
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Layout tab ──────────────────────────────────────────────────────────────

// ── Page slot sentinels (special ItemEdit panels) ──
type SlotKey = '__pipeline__' | '__comments__' | '__tasks__' | '__addendums__'
interface SlotState {
  sort: number
  label_override: string | null
  is_visible: boolean
  default_expanded: boolean
  show_approval_chain: boolean
}
const SLOT_KEYS: SlotKey[] = ['__pipeline__', '__comments__', '__tasks__', '__addendums__']
const SLOT_META: Record<SlotKey, { name: string; defaultLabel: string; editable: boolean }> = {
  __pipeline__: { name: 'Pipeline', defaultLabel: 'Pipeline', editable: true },
  __comments__: { name: 'Comments', defaultLabel: 'Comments', editable: true },
  __tasks__: { name: 'Tasks', defaultLabel: 'Tasks', editable: true },
  __addendums__: { name: 'Addendums', defaultLabel: 'Addendums', editable: true }
}
// PDF Button is a special draggable field chip (not a top-level slot card): placed in groups
// like __owners__, persisted as a field-assignment row with field = '__pdf__'.
const PDF_FIELD = '__pdf__'
// Owners is a special draggable field chip (not a top-level slot card): it can be
// dropped into any group or the ungrouped zone like a normal field, persisted as a
// field-assignment row with field = '__owners__'.
const OWNERS_FIELD = '__owners__'

interface FieldGroup {
  id: number
  collection: string
  key: string
  label: string
  type: 'section' | 'tab' | 'metadata' | 'container'
  icon: string | null
  sort: number
  is_collapsed: boolean
  container_id?: number | null
  tab_mode?: 'tabs' | 'steps' | null
  hide_when_empty?: boolean | number
  visibility_mode?: 'always' | 'new_only' | 'existing_only'
  summary_fields?: string | null
  summary_hide_empty?: boolean | number
  swap_config?: string | null
}

// ── Width options ──────────────────────────────────────────────────────────────
const WIDTH_OPTIONS = [
  { span: 12, label: 'Full' },
  { span: 6, label: '1/2' },
  { span: 4, label: '1/3' },
  { span: 3, label: '1/4' }
] as const

function parseColSpan(options: unknown): number {
  try {
    const obj = typeof options === 'string' ? JSON.parse(options) : options
    const span = (obj as Record<string, unknown>)?.col_span
    return typeof span === 'number' ? span : 12
  } catch {
    return 12
  }
}

// ── Friendly type badge colors (used in Layout tab chips) ─────────────────────

const FRIENDLY_TYPE_STYLES: Record<string, string> = {
  text: 'bg-slate-100 text-slate-600',
  num: 'bg-blue-50 text-blue-700',
  bigint: 'bg-blue-50 text-blue-700',
  bool: 'bg-purple-50 text-purple-700',
  float: 'bg-green-50 text-green-700',
  decimal: 'bg-green-50 text-green-700',
  money: 'bg-green-50 text-green-700',
  date: 'bg-amber-50 text-amber-700',
  datetime: 'bg-amber-50 text-amber-700',
  time: 'bg-amber-50 text-amber-700',
  uuid: 'bg-orange-50 text-orange-700',
  json: 'bg-slate-100 text-slate-600',
  M2O: 'bg-nvr-cyan/10 text-nvr-cyan',
  M2M: 'bg-nvr-cyan/15 text-nvr-cyan',
  O2M: 'bg-nvr-cyan/10 text-nvr-cyan',
  panel: 'bg-indigo-50 text-indigo-600',
  owners: 'bg-violet-50 text-violet-600'
}

// ── FieldImpactPopover — "what references this field?" ───────────────────────

function FieldImpactPopover({ collection, fieldName }: { collection: string; fieldName: string }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['field-impact', collection, fieldName],
    queryFn: () =>
      api
        .get<{
          data: Array<{ source: string; label: string; detail: string; link: string | null }>
          total: number
        }>(`/data-model/${collection}/fields/${fieldName}/impact`)
        .then((r) => r.data),
    enabled: open,
    staleTime: 60_000
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          onPointerDown={(e) => e.stopPropagation()}
          className='rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-nvr-navy dark:hover:bg-muted'
          title='Where is this field used?'
          aria-label='Field impact analysis'
        >
          <Crosshair className='h-3 w-3' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-80 p-3' align='end' onPointerDown={(e) => e.stopPropagation()}>
        <p className='mb-2 text-[11px] font-semibold text-slate-500'>
          References to <code className='font-mono'>{fieldName}</code>
        </p>
        {isLoading ? (
          <Skeleton className='h-4 w-40' />
        ) : !data || data.total === 0 ? (
          <p className='text-[12px] text-slate-400'>
            No references found — safe to rename or delete. (Layouts, queues, templates, formulas,
            rules, alerts, watches, views and workflow conditions were scanned.)
          </p>
        ) : (
          <div className='max-h-72 space-y-1.5 overflow-y-auto'>
            {data.data.map((i, idx) => (
              <div key={`${i.source}-${idx}`} className='text-[12px]'>
                {i.link ? (
                  <Link
                    to={i.link}
                    className='font-medium text-nvr-navy hover:underline dark:text-[#00ceff]'
                  >
                    {i.label}
                  </Link>
                ) : (
                  <span className='font-medium text-slate-700 dark:text-slate-300'>{i.label}</span>
                )}
                <span className='text-slate-400'> — {i.detail}</span>
              </div>
            ))}
            <p className='pt-1 text-[11px] text-slate-400'>
              {data.total} reference{data.total !== 1 ? 's' : ''} — review before renaming or
              deleting this field.
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ── FieldSettingsPopover ──────────────────────────────────────────────────────

interface FieldSettings {
  label: string | null
  interface: string | null
  note: string | null
  required: boolean
  hidden: boolean
  readonly: boolean
  inline_relation: boolean
  max_values: number | null
  options?: string | null
  placeholder: string | null
  drilldown?: {
    enabled?: boolean
    layout_id?: number | null
    width?: number | string | null
  } | null
}

// ── Cascade Filters ───────────────────────────────────────────────────────────

interface CascadeFilterRule {
  parent_field: string
  filter_column: string
  clear_on_parent_change: boolean
  clear_on_unavailable: boolean
  filter_is_m2m?: boolean
  show_all_if_no_parent?: boolean
}

interface CascadeParentField {
  field: string
  label: string
  kind: 'M2O' | 'M2M'
}

function CascadeFiltersEditor({
  rules,
  m2oFields,
  relatedCollection,
  onChange
}: {
  rules: CascadeFilterRule[]
  m2oFields: CascadeParentField[]
  relatedCollection?: string | null
  onChange: (rules: CascadeFilterRule[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [parentField, setParentField] = useState('')
  const [filterColumn, setFilterColumn] = useState('')
  const [fcOpen, setFcOpen] = useState(false)
  const [pfOpen, setPfOpen] = useState(false)
  const [editPfOpen, setEditPfOpen] = useState(false)
  const [editFcOpen, setEditFcOpen] = useState(false)
  const [editParentField, setEditParentField] = useState('')
  const [editFilterColumn, setEditFilterColumn] = useState('')

  const { data: relColMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    enabled: !!relatedCollection,
    staleTime: 10 * 60 * 1000
  })
  const relatedFields: string[] = relColMeta?.fields?.map((f: { field: string }) => f.field) ?? []
  const [clearOnChange, setClearOnChange] = useState(true)
  const [clearOnUnavailable, setClearOnUnavailable] = useState(false)
  const [showAllIfNoParent, setShowAllIfNoParent] = useState(true)

  function openAdd() {
    setEditingIdx(null)
    setParentField('')
    setFilterColumn('')
    setClearOnChange(true)
    setClearOnUnavailable(false)
    setShowAllIfNoParent(true)
    setAdding(true)
  }

  function cancelAdd() {
    setAdding(false)
  }

  function computeFilterIsMm(fc: string) {
    const relRels = (relColMeta?.relations ?? []) as Array<{
      one_field?: string
      junction_field?: string
    }>
    return relRels.some((r) => r.one_field === fc && !!r.junction_field)
  }

  function saveAdd() {
    if (!parentField.trim() || !filterColumn.trim()) return
    const fc = filterColumn.trim()
    onChange([
      ...rules,
      {
        parent_field: parentField.trim(),
        filter_column: fc,
        clear_on_parent_change: clearOnChange,
        clear_on_unavailable: clearOnUnavailable,
        filter_is_m2m: computeFilterIsMm(fc),
        show_all_if_no_parent: showAllIfNoParent
      }
    ])
    setAdding(false)
  }

  function openEdit(idx: number) {
    setAdding(false)
    setEditParentField(rules[idx].parent_field)
    setEditFilterColumn(rules[idx].filter_column)
    setEditingIdx(idx)
  }

  function cancelEdit() {
    setEditingIdx(null)
  }

  function saveEdit() {
    if (editingIdx === null) return
    if (!editParentField.trim() || !editFilterColumn.trim()) return
    const fc = editFilterColumn.trim()
    onChange(
      rules.map((r, i) =>
        i === editingIdx
          ? {
              ...r,
              parent_field: editParentField.trim(),
              filter_column: fc,
              filter_is_m2m: computeFilterIsMm(fc)
            }
          : r
      )
    )
    setEditingIdx(null)
  }

  function removeRule(idx: number) {
    onChange(rules.filter((_, i) => i !== idx))
  }

  function toggleClear(idx: number, val: boolean) {
    onChange(
      rules.map((r, i) =>
        i === idx
          ? {
              ...r,
              clear_on_parent_change: val,
              clear_on_unavailable: r.clear_on_unavailable ?? false
            }
          : r
      )
    )
  }

  function toggleUnavailable(idx: number, val: boolean) {
    onChange(rules.map((r, i) => (i === idx ? { ...r, clear_on_unavailable: val } : r)))
  }

  function toggleShowAll(idx: number, val: boolean) {
    onChange(rules.map((r, i) => (i === idx ? { ...r, show_all_if_no_parent: val } : r)))
  }

  return (
    <div className='mt-4 border-t border-[#e2e8f0] pt-4'>
      <p
        className='mb-2 text-[11px] font-medium text-[#6b7280]'
        style={{ letterSpacing: '0.01em' }}
      >
        Cascade Filters
      </p>

      {rules.length > 0 && (
        <div className='mb-2 space-y-2'>
          {rules.map((rule, idx) => {
            const parentMeta = m2oFields.find((f) => f.field === rule.parent_field)
            const parentLabel = parentMeta?.label ?? rule.parent_field
            const isM2MParent = parentMeta?.kind === 'M2M'
            const isEditing = editingIdx === idx

            if (isEditing) {
              return (
                <div
                  key={idx}
                  className='space-y-2 rounded-md border border-nvr-cyan/40 bg-[#f6f8fa] p-2 dark:border-nvr-cyan/30 dark:bg-muted/40'
                >
                  <div>
                    <p className='mb-1 text-[10px] text-slate-500'>Parent field</p>
                    <Popover open={editPfOpen} onOpenChange={setEditPfOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type='button'
                          className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-[11px] text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-background'
                        >
                          {(() => {
                            const sel = m2oFields.find((f) => f.field === editParentField)
                            return sel ? (
                              <span className='flex items-center gap-1.5'>
                                {sel.label}
                                {sel.kind === 'M2M' && (
                                  <span className='rounded px-1 py-0.5 text-[9px] font-semibold bg-amber-100 text-amber-700'>
                                    M2M
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className='text-slate-400'>Parent field…</span>
                            )
                          })()}
                          <ChevronsUpDown className='h-3 w-3 text-slate-400' />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className='w-56 p-0' align='start'>
                        <Command>
                          <CommandInput placeholder='Search fields…' className='h-7 text-[11px]' />
                          <CommandList>
                            <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
                              No relation fields
                            </CommandEmpty>
                            <CommandGroup>
                              {m2oFields.map((item) => (
                                <CommandItem
                                  key={item.field}
                                  value={item.label}
                                  onSelect={() => {
                                    setEditParentField(item.field)
                                    setEditPfOpen(false)
                                  }}
                                  className='text-[11px]'
                                >
                                  <Check
                                    className={cn(
                                      'mr-1.5 h-3 w-3 shrink-0',
                                      editParentField === item.field ? 'opacity-100' : 'opacity-0'
                                    )}
                                  />
                                  <span className='flex-1'>{item.label}</span>
                                  {item.kind === 'M2M' && (
                                    <span className='ml-1.5 rounded px-1 py-0.5 text-[9px] font-semibold bg-amber-100 text-amber-700'>
                                      M2M
                                    </span>
                                  )}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div>
                    <p className='mb-1 text-[10px] text-slate-500'>
                      Filter column on
                      {relatedCollection ? ` ${relatedCollection}` : ' related table'}
                    </p>
                    {relatedFields.length > 0 ? (
                      <Popover open={editFcOpen} onOpenChange={setEditFcOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type='button'
                            className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-[11px] hover:bg-slate-50 dark:border-border dark:bg-background'
                          >
                            <span
                              className={
                                editFilterColumn ? 'font-mono text-slate-700' : 'text-slate-400'
                              }
                            >
                              {editFilterColumn || 'Select column…'}
                            </span>
                            <ChevronsUpDown className='h-3 w-3 text-slate-400' />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className='w-52 p-0' align='start'>
                          <Command>
                            <CommandInput
                              placeholder='Search columns…'
                              className='h-7 text-[11px]'
                            />
                            <CommandList>
                              <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
                                No columns
                              </CommandEmpty>
                              <CommandGroup>
                                {relatedFields.map((f) => (
                                  <CommandItem
                                    key={f}
                                    value={f}
                                    onSelect={() => {
                                      setEditFilterColumn(f)
                                      setEditFcOpen(false)
                                    }}
                                    className='font-mono text-[11px]'
                                  >
                                    <Check
                                      className={cn(
                                        'mr-1.5 h-3 w-3 shrink-0',
                                        editFilterColumn === f ? 'opacity-100' : 'opacity-0'
                                      )}
                                    />
                                    {f}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    ) : (
                      <Input
                        value={editFilterColumn}
                        onChange={(e) => setEditFilterColumn(e.target.value)}
                        placeholder='e.g. division_id'
                        className='h-7 font-mono text-[11px]'
                      />
                    )}
                  </div>
                  <div className='flex items-center gap-2'>
                    <span className='flex-1' />
                    <button
                      type='button'
                      onClick={cancelEdit}
                      className='rounded px-2 py-1 text-[12px] text-slate-500 hover:bg-slate-100'
                    >
                      Cancel
                    </button>
                    <Button
                      size='sm'
                      disabled={!editParentField || !editFilterColumn.trim()}
                      onClick={saveEdit}
                      className='h-7 px-3 py-1.5 text-[12px]'
                    >
                      Save
                    </Button>
                  </div>
                </div>
              )
            }

            return (
              <div
                key={idx}
                className='rounded-md border border-[#e2e8f0] bg-[#f6f8fa] px-3 py-2 dark:border-border dark:bg-muted/40'
              >
                <div className='flex items-center gap-1.5'>
                  <span className='text-[12px] font-medium text-slate-700'>{parentLabel}</span>
                  {isM2MParent && (
                    <span className='rounded px-1 py-0.5 text-[9px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'>
                      M2M
                    </span>
                  )}
                  <span className='flex-1' />
                  <button
                    type='button'
                    onClick={() => openEdit(idx)}
                    className='rounded p-0.5 text-slate-300 transition-colors hover:text-slate-600'
                  >
                    <Pencil className='h-3 w-3' />
                  </button>
                  <button
                    type='button'
                    onClick={() => removeRule(idx)}
                    className='rounded p-0.5 text-slate-300 transition-colors hover:text-red-400'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </div>
                <div className='mt-1'>
                  <span className='font-mono text-[11px] text-[#6b7280]'>{rule.filter_column}</span>
                  {rule.filter_is_m2m && (
                    <span className='ml-1.5 rounded px-1 py-0.5 text-[9px] font-semibold bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'>
                      M2M filter
                    </span>
                  )}
                </div>
                <div className='mt-1.5 flex items-center gap-1.5'>
                  <span className='text-[10px] text-slate-400'>Clear on parent change</span>
                  <span className='flex-1' />
                  <Switch
                    checked={rule.clear_on_parent_change}
                    onCheckedChange={(val) => toggleClear(idx, val)}
                    className='scale-75'
                  />
                </div>
                <div className='mt-1 flex items-center gap-1.5'>
                  <span className='text-[10px] text-slate-400'>Clear if value unavailable</span>
                  <span className='flex-1' />
                  <Switch
                    checked={rule.clear_on_unavailable ?? false}
                    onCheckedChange={(val) => toggleUnavailable(idx, val)}
                    className='scale-75'
                  />
                </div>
                <div className='mt-1 flex items-center gap-1.5'>
                  <span className='text-[10px] text-slate-400'>
                    Show all options if parent not set
                  </span>
                  <span className='flex-1' />
                  <Switch
                    checked={rule.show_all_if_no_parent ?? true}
                    onCheckedChange={(val) => toggleShowAll(idx, val)}
                    className='scale-75'
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!adding && (
        <button
          type='button'
          onClick={openAdd}
          className='flex items-center gap-1 text-[12px] text-[#00ceff] hover:text-[#00ceff]/80'
        >
          <Plus className='h-3 w-3' />
          {rules.length > 0 ? 'Add another filter' : 'Add cascade filter'}
        </button>
      )}

      {adding && (
        <div
          className='space-y-2 rounded-md border border-[#e2e8f0] bg-[#f6f8fa] p-2 dark:border-border dark:bg-muted/40'
          style={{ transition: 'opacity 150ms ease-out' }}
        >
          {/* parent field combobox */}
          <div>
            <p className='mb-1 text-[10px] text-slate-500'>Parent field</p>
            <Popover open={pfOpen} onOpenChange={setPfOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-[11px] text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-background'
                >
                  {(() => {
                    const sel = m2oFields.find((f) => f.field === parentField)
                    return sel ? (
                      <span className='flex items-center gap-1.5'>
                        {sel.label}
                        {sel.kind === 'M2M' && (
                          <span className='rounded px-1 py-0.5 text-[9px] font-semibold bg-amber-100 text-amber-700'>
                            M2M
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className='text-slate-400'>Parent field…</span>
                    )
                  })()}
                  <ChevronsUpDown className='h-3 w-3 text-slate-400' />
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-56 p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search fields…' className='h-7 text-[11px]' />
                  <CommandList>
                    <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
                      No relation fields
                    </CommandEmpty>
                    <CommandGroup>
                      {m2oFields.map((item) => (
                        <CommandItem
                          key={item.field}
                          value={item.label}
                          onSelect={() => {
                            setParentField(item.field)
                            setPfOpen(false)
                          }}
                          className='text-[11px]'
                        >
                          <Check
                            className={cn(
                              'mr-1.5 h-3 w-3 shrink-0',
                              parentField === item.field ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          <span className='flex-1'>{item.label}</span>
                          {item.kind === 'M2M' && (
                            <span className='ml-1.5 rounded px-1 py-0.5 text-[9px] font-semibold bg-amber-100 text-amber-700'>
                              M2M
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {parentField && m2oFields.find((f) => f.field === parentField)?.kind === 'M2M' && (
              <p className='mt-1 text-[10px] text-amber-600 dark:text-amber-400'>
                M2M parent: the first staged selection's value is used as the filter.
              </p>
            )}
          </div>

          {/* filter column */}
          <div>
            <p className='mb-1 text-[10px] text-slate-500'>
              Filter column on{relatedCollection ? ` ${relatedCollection}` : ' related table'}
            </p>
            {relatedFields.length > 0 ? (
              <Popover open={fcOpen} onOpenChange={setFcOpen}>
                <PopoverTrigger asChild>
                  <button
                    type='button'
                    className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-[11px] hover:bg-slate-50 dark:border-border dark:bg-background'
                  >
                    <span className={filterColumn ? 'font-mono text-slate-700' : 'text-slate-400'}>
                      {filterColumn || 'Select column…'}
                    </span>
                    <ChevronsUpDown className='h-3 w-3 text-slate-400' />
                  </button>
                </PopoverTrigger>
                <PopoverContent className='w-52 p-0' align='start'>
                  <Command>
                    <CommandInput placeholder='Search columns…' className='h-7 text-[11px]' />
                    <CommandList>
                      <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
                        No columns
                      </CommandEmpty>
                      <CommandGroup>
                        {relatedFields.map((f) => (
                          <CommandItem
                            key={f}
                            value={f}
                            onSelect={() => {
                              setFilterColumn(f)
                              setFcOpen(false)
                            }}
                            className='font-mono text-[11px]'
                          >
                            <Check
                              className={cn(
                                'mr-1.5 h-3 w-3 shrink-0',
                                filterColumn === f ? 'opacity-100' : 'opacity-0'
                              )}
                            />
                            {f}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            ) : (
              <Input
                value={filterColumn}
                onChange={(e) => setFilterColumn(e.target.value)}
                placeholder='e.g. division_id'
                className='h-7 font-mono text-[11px]'
              />
            )}
          </div>

          {/* clear options + actions */}
          <div className='space-y-1.5'>
            <div className='flex items-center gap-2'>
              <Switch
                checked={clearOnChange}
                onCheckedChange={setClearOnChange}
                className='scale-75'
              />
              <span className='text-[11px] text-slate-600'>Clear on parent change</span>
            </div>
            <div className='flex items-center gap-2'>
              <Switch
                checked={clearOnUnavailable}
                onCheckedChange={setClearOnUnavailable}
                className='scale-75'
              />
              <span className='text-[11px] text-slate-600'>
                Clear if value no longer in options
              </span>
            </div>
            <div className='flex items-center gap-2'>
              <Switch
                checked={showAllIfNoParent}
                onCheckedChange={setShowAllIfNoParent}
                className='scale-75'
              />
              <span className='text-[11px] text-slate-600'>Show all options if parent not set</span>
            </div>
          </div>
          <div className='flex items-center gap-2'>
            <span className='flex-1' />
            <button
              type='button'
              onClick={cancelAdd}
              className='rounded px-2 py-1 text-[12px] text-slate-500 hover:bg-slate-100'
            >
              Cancel
            </button>
            <Button
              size='sm'
              disabled={!parentField || !filterColumn.trim()}
              onClick={saveAdd}
              className='h-7 px-3 py-1.5 text-[12px]'
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function LayoutPicker({
  collection,
  value,
  onChange,
  layoutType
}: {
  collection?: string | null
  value: number | null
  onChange: (id: number | null, slug: string | null) => void
  layoutType?: 'grouped' | 'table'
}) {
  const [open, setOpen] = useState(false)
  const { data: allLayouts = [] } = useQuery({
    queryKey: ['collection-layouts-list', collection],
    queryFn: () =>
      api
        .get<{
          data: Array<{ id: number; name: string; slug: string | null; layout_type?: string }>
        }>(`/collection-layouts?collection=${collection}`)
        .then((r) => r.data.data ?? []),
    enabled: !!collection,
    staleTime: 60_000
  })
  const layouts = layoutType
    ? allLayouts.filter((l) => (l.layout_type ?? 'grouped') === layoutType)
    : allLayouts
  const selected = layouts.find((l) => l.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-[11px] text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-background'
        >
          <span className={selected ? '' : 'text-slate-400'}>
            {selected ? selected.name : 'Select layout…'}
          </span>
          <ChevronsUpDown className='h-3 w-3 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-52 p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search layouts…' className='h-7 text-[11px]' />
          <CommandList>
            <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
              No layouts
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value=''
                onSelect={() => {
                  onChange(null, null)
                  setOpen(false)
                }}
                className='text-[11px] text-slate-400'
              >
                None
              </CommandItem>
              {layouts.map((l) => (
                <CommandItem
                  key={l.id}
                  value={l.name}
                  onSelect={() => {
                    onChange(l.id, l.slug ?? null)
                    setOpen(false)
                  }}
                  className='text-[11px]'
                >
                  <Check
                    className={cn(
                      'mr-1.5 h-3 w-3 shrink-0',
                      value === l.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {l.name}
                  {l.slug && (
                    <span className='ml-1.5 font-mono text-[10px] text-slate-400'>{l.slug}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function CascadeRuleRow({
  rule,
  parentFields,
  childFields,
  onChange,
  onRemove
}: {
  rule: { parent_field: string; child_field: string }
  parentFields: Array<{ value: string; label: string }>
  childFields: Array<{ value: string; label: string }>
  onChange: (r: { parent_field: string; child_field: string }) => void
  onRemove: () => void
}) {
  const [pfOpen, setPfOpen] = useState(false)
  const [cfOpen, setCfOpen] = useState(false)
  return (
    <div className='flex items-center gap-1.5'>
      <Popover open={pfOpen} onOpenChange={setPfOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan min-w-0'
          >
            {rule.parent_field ? (
              (parentFields.find((f) => f.value === rule.parent_field)?.label ?? rule.parent_field)
            ) : (
              <span className='text-slate-400'>parent field…</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-52 p-0' align='start'>
          <Command>
            <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
            <CommandList>
              <CommandGroup>
                {parentFields.map((f) => (
                  <CommandItem
                    key={f.value}
                    value={f.value}
                    onSelect={() => {
                      onChange({ ...rule, parent_field: f.value })
                      setPfOpen(false)
                    }}
                    className='text-[12px]'
                  >
                    {f.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <span className='text-[10px] text-slate-400 shrink-0'>→</span>
      <Popover open={cfOpen} onOpenChange={setCfOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan min-w-0'
          >
            {rule.child_field ? (
              (childFields.find((f) => f.value === rule.child_field)?.label ?? rule.child_field)
            ) : (
              <span className='text-slate-400'>child field…</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-52 p-0' align='start'>
          <Command>
            <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
            <CommandList>
              <CommandGroup>
                {childFields.map((f) => (
                  <CommandItem
                    key={f.value}
                    value={f.value}
                    onSelect={() => {
                      onChange({ ...rule, child_field: f.value })
                      setCfOpen(false)
                    }}
                    className='text-[12px]'
                  >
                    {f.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <button
        type='button'
        onClick={onRemove}
        className='shrink-0 text-slate-300 hover:text-red-400 text-[11px] px-0.5'
      >
        ✕
      </button>
    </div>
  )
}

type RowRuleSource = {
  source_type: 'relation_field' | 'o2m_first' | 'o2m_filtered' | 'parent_m2o'
  source_field: string
  source_related_field: string
  // o2m_filtered only:
  source_hop?: 'm2o' | 'o2m_first' // how to resolve the intermediate record
  o2m_collection?: string // child collection to search
  filter_field?: string // field on child to filter
  filter_value?: string // value (supports $parent.X)
  // parent_m2o only:
  source_one_collection?: string // resolved one_collection of the parent M2O field
}

type RowRuleItem = {
  trigger_field?: string | null
  trigger_fields?: string[] | null
  trigger_related_field?: string | null
  trigger_op?: string
  trigger_value?: string | null
  target_field: string
  target_type: 'set' | 'clear' | 'relation_field' | 'precedence' | 'pick'
  target_value?: string | null
  sources?: RowRuleSource[]
  only_if_empty?: boolean
  sort?: number
}

const ROW_RULE_SKIP_TYPES = new Set([
  'alias',
  'o2m',
  'm2m',
  'm2a',
  'presentation',
  'group',
  'divider'
])

const NUMERIC_FIELD_TYPES = new Set([
  'integer',
  'bigInteger',
  'decimal',
  'float',
  'money',
  'smallmoney',
  'tinyint',
  'smallint',
  'bigint'
])

function reorder<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr
  const next = [...arr]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

function toFriendlyFieldLabel(field: string): string {
  return field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function fieldTypeHint(
  field: string,
  type: string | undefined,
  m2oRels: Array<{ many_field: string }>,
  o2mRels?: Array<{ one_field: string }>
): string {
  if (o2mRels?.some((r) => r.one_field === field)) return 'O2M'
  if (m2oRels.some((r) => r.many_field === field)) return 'M2O'
  const t = (type ?? '').toLowerCase()
  if (['string', 'nvarchar', 'varchar', 'char', 'text'].some((x) => t.includes(x))) return 'text'
  if (['integer', 'bigint', 'smallint', 'tinyint'].some((x) => t === x) || t === 'int')
    return 'number'
  if (['decimal', 'float', 'double', 'real', 'money', 'numeric'].some((x) => t.includes(x)))
    return 'decimal'
  if (t === 'boolean' || t === 'bit') return 'bool'
  if (t.includes('datetime') || t === 'timestamp') return 'datetime'
  if (t === 'date') return 'date'
  if (t === 'uuid' || t === 'uniqueidentifier') return 'uuid'
  if (t === 'json') return 'json'
  return type ?? ''
}
const VIA_ID_MARKERS = new Set(['__id__', '__entity__'])

function ViaValuePicker({
  collection,
  value,
  isMulti,
  onChange
}: {
  collection: string
  value: string | null
  isMulti: boolean
  onChange: (v: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const selectedIds = value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []

  const { data: collectionMeta } = useQuery<{ display_template?: string | null }>({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data ?? {}),
    enabled: !!collection,
    staleTime: 5 * 60_000
  })

  const displayTemplate = collectionMeta?.display_template ?? null
  const templateFields = displayTemplate ? extractTemplateFields(displayTemplate) : []
  const extraFields = templateFields.filter((f) => f !== 'id')

  const { data: items = [] } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['via-pick-items', collection, search, extraFields.join(',')],
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>> }>(`/items/${collection}`, {
          params: {
            limit: 50,
            ...(search ? { search } : {}),
            ...(extraFields.length ? { fields: ['id', ...extraFields].join(',') } : {})
          }
        })
        .then((r) => r.data.data ?? []),
    enabled: !!collection,
    staleTime: 30_000
  })

  const { data: selectedItems = [] } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['via-pick-selected', collection, selectedIds.join(','), extraFields.join(',')],
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>> }>(`/items/${collection}`, {
          params: {
            filter: JSON.stringify({ id: { _in: selectedIds } }),
            limit: selectedIds.length,
            ...(extraFields.length ? { fields: ['id', ...extraFields].join(',') } : {})
          }
        })
        .then((r) => r.data.data ?? []),
    enabled: selectedIds.length > 0,
    staleTime: 60_000
  })

  function getLabel(item: Record<string, unknown>) {
    return renderDisplayTemplate(displayTemplate, item)
  }

  function toggle(id: string) {
    if (isMulti) {
      const next = selectedIds.includes(id)
        ? selectedIds.filter((s) => s !== id)
        : [...selectedIds, id]
      onChange(next.length ? next.join(',') : null)
    } else {
      onChange(selectedIds[0] === id ? null : id)
      setOpen(false)
    }
  }

  return (
    <div className='space-y-1'>
      {selectedIds.length > 0 && (
        <div className='flex flex-wrap gap-1'>
          {selectedIds.map((id) => {
            const item = selectedItems.find((r) => String(r.id) === id)
            return (
              <span
                key={id}
                className='inline-flex items-center gap-0.5 rounded bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan text-[10px] px-1.5 py-0.5'
              >
                {item ? getLabel(item) : id}
                <button
                  type='button'
                  onClick={() => toggle(id)}
                  className='hover:text-red-400 ml-0.5'
                >
                  ✕
                </button>
              </span>
            )
          })}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='w-full h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left hover:border-slate-400 text-slate-400'
          >
            {isMulti ? '+ add record…' : selectedIds.length ? 'change…' : 'pick record…'}
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-60 p-0' align='start'>
          <Command>
            <CommandInput
              placeholder='Search…'
              className='h-8 text-[12px]'
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandGroup>
                {items.map((item) => {
                  const id = String(item.id ?? '')
                  const isSelected = selectedIds.includes(id)
                  return (
                    <CommandItem
                      key={id}
                      value={`${id} ${getLabel(item)}`}
                      onSelect={() => toggle(id)}
                      className='text-[12px]'
                    >
                      {isMulti && (
                        <Check
                          className={cn(
                            'h-3 w-3 mr-1 shrink-0',
                            isSelected ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                      )}
                      {getLabel(item)}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function PrecedenceSourceRow({
  source,
  index,
  total,
  m2oRels,
  o2mRels,
  parentContextFields,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown
}: {
  source: RowRuleSource
  index: number
  total: number
  m2oRels: Array<{ many_field: string; one_collection: string }>
  o2mRels: Array<{ one_field: string; many_collection: string }>
  parentContextFields?: Array<{ field: string; label: string; one_collection?: string | null }>
  onChange: (s: RowRuleSource) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const [sfOpen, setSfOpen] = useState(false)
  const [rfOpen, setRfOpen] = useState(false)
  const [ffOpen, setFfOpen] = useState(false)
  const [childColOpen, setChildColOpen] = useState(false)
  const [fvOpen, setFvOpen] = useState(false)
  const [fvSearch, setFvSearch] = useState('')

  const isFiltered = source.source_type === 'o2m_filtered'
  const isParentM2O = source.source_type === 'parent_m2o'
  const hop = source.source_hop ?? 'm2o'

  // For standard types: resolve the related collection for field picker
  const relCollection =
    source.source_type === 'relation_field'
      ? (m2oRels.find((r) => r.many_field === source.source_field)?.one_collection ?? null)
      : source.source_type === 'o2m_first'
        ? (o2mRels.find((r) => r.one_field === source.source_field)?.many_collection ?? null)
        : isParentM2O
          ? (source.source_one_collection ?? null)
          : null

  const { data: relFieldsRaw } = useQuery({
    queryKey: ['field-config-all', relCollection],
    queryFn: () =>
      api
        .get(`/field-config/${relCollection}`)
        .then(
          (r: {
            data: { data?: Array<{ field: string; label?: string | null; type?: string }> }
          }) => r.data.data ?? []
        ),
    enabled: !!relCollection && !isFiltered,
    staleTime: 5 * 60 * 1000
  })
  const relFieldOpts = (relFieldsRaw ?? [])
    .filter(
      (f: { field: string; type?: string }) =>
        f.field !== 'id' && !ROW_RULE_SKIP_TYPES.has(f.type ?? '')
    )
    .map((f: { field: string; label?: string | null }) => ({
      value: f.field,
      label: f.label || f.field
    }))

  const parentM2OOpts = useMemo(
    () =>
      (parentContextFields ?? [])
        .filter((p) => !!p.one_collection)
        .map((p) => ({ value: p.field, label: p.label, one_collection: p.one_collection! })),
    [parentContextFields]
  )

  const sourceFieldOpts = isFiltered
    ? hop === 'm2o'
      ? m2oRels.map((r) => ({ value: r.many_field, label: r.many_field }))
      : o2mRels.map((r) => ({ value: r.one_field, label: r.one_field }))
    : isParentM2O
      ? parentM2OOpts.map((p) => ({ value: p.value, label: p.label }))
      : source.source_type === 'relation_field'
        ? m2oRels.map((r) => ({ value: r.many_field, label: r.many_field }))
        : o2mRels.map((r) => ({ value: r.one_field, label: r.one_field }))

  // For o2m_filtered: resolve intermediate collection to populate child collection picker
  const intermediateCollection = isFiltered
    ? hop === 'm2o'
      ? (m2oRels.find((r) => r.many_field === source.source_field)?.one_collection ?? null)
      : (o2mRels.find((r) => r.one_field === source.source_field)?.many_collection ?? null)
    : null

  const { data: intermediateRelsRaw } = useQuery({
    queryKey: ['relations-for-intermediate', intermediateCollection],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            one_collection?: string
            many_collection?: string
            junction_field?: string | null
          }>
        }>(`/data-model/relations/for/${intermediateCollection}`)
        .then((r) => r.data.data ?? []),
    enabled: isFiltered && !!intermediateCollection && !!source.source_field,
    staleTime: 5 * 60 * 1000
  })
  const childCollectionOpts = useMemo(() => {
    const rels =
      (intermediateRelsRaw as
        | Array<{
            one_collection?: string
            many_collection?: string
            junction_field?: string | null
          }>
        | undefined) ?? []
    return rels
      .filter(
        (r) => r.one_collection === intermediateCollection && r.many_collection && !r.junction_field
      )
      .map((r) => ({ value: r.many_collection!, label: r.many_collection! }))
  }, [intermediateRelsRaw, intermediateCollection])

  // For o2m_filtered: fetch fields of the o2m_collection for filter_field + source_related_field pickers
  const { data: o2mFieldsRaw } = useQuery({
    queryKey: ['field-config-all', source.o2m_collection],
    queryFn: () =>
      api
        .get(`/field-config/${source.o2m_collection}`)
        .then(
          (r: {
            data: { data?: Array<{ field: string; label?: string | null; type?: string }> }
          }) => r.data.data ?? []
        ),
    enabled: isFiltered && !!source.o2m_collection,
    staleTime: 5 * 60 * 1000
  })
  const o2mFieldOpts = (o2mFieldsRaw ?? [])
    .filter((f: { field: string; type?: string }) => !ROW_RULE_SKIP_TYPES.has(f.type ?? ''))
    .map((f: { field: string; label?: string | null }) => ({
      value: f.field,
      label: f.label || f.field
    }))
  const o2mScalarOpts = o2mFieldOpts.filter(
    (f: { value: string; label: string }) => f.value !== 'id'
  )

  const parentFieldOpts = useMemo(
    () =>
      (parentContextFields ?? []).map((p) => ({
        value: `$parent.${p.field}`,
        label: `$parent.${p.field}`
      })),
    [parentContextFields]
  )

  return (
    <div className='relative rounded-md border border-slate-200 bg-white overflow-hidden'>
      {/* Actions — pinned top-right */}
      <div className='absolute top-1 right-1 flex items-center gap-px z-10'>
        <button
          type='button'
          onClick={onMoveUp}
          disabled={index === 0}
          className='h-6 w-6 flex items-center justify-center text-slate-400 hover:text-slate-700 disabled:opacity-20 transition-colors rounded hover:bg-slate-100'
        >
          ↑
        </button>
        <button
          type='button'
          onClick={onMoveDown}
          disabled={index === total - 1}
          className='h-6 w-6 flex items-center justify-center text-slate-400 hover:text-slate-700 disabled:opacity-20 transition-colors rounded hover:bg-slate-100'
        >
          ↓
        </button>
        <button
          type='button'
          onClick={onRemove}
          className='h-6 w-6 flex items-center justify-center text-slate-300 hover:text-red-400 transition-colors rounded hover:bg-red-50'
        >
          ✕
        </button>
      </div>

      {/* Primary row */}
      <div className='flex items-center gap-1.5 flex-wrap px-2 py-1.5 pr-20'>
        <span className='text-[11px] font-medium text-slate-400 w-4 text-right shrink-0 tabular-nums'>
          {index + 1}
        </span>
        <SelectButton
          value={source.source_type}
          opts={[
            { value: 'relation_field', label: 'M2O →' },
            { value: 'o2m_first', label: 'O2M first →' },
            { value: 'o2m_filtered', label: 'filtered child →' },
            { value: 'parent_m2o', label: 'parent M2O →' }
          ]}
          onChange={(v) =>
            onChange({
              source_type: v as RowRuleSource['source_type'],
              source_field: '',
              source_related_field: '',
              source_hop: 'm2o'
            })
          }
        />

        {isFiltered && (
          <SelectButton
            value={hop}
            opts={[
              { value: 'm2o', label: 'via M2O' },
              { value: 'o2m_first', label: 'via O2M first' }
            ]}
            onChange={(v) =>
              onChange({ ...source, source_hop: v as 'm2o' | 'o2m_first', source_field: '' })
            }
          />
        )}

        <Popover open={sfOpen} onOpenChange={setSfOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='h-7 rounded border border-slate-200 bg-slate-50 px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[70px] max-w-[110px] transition-colors'
            >
              {source.source_field || <span className='text-slate-400'>field…</span>}
            </button>
          </PopoverTrigger>
          <PopoverContent className='w-44 p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
              <CommandList>
                <CommandGroup>
                  {sourceFieldOpts.length === 0 ? (
                    <div className='px-3 py-2 text-[11px] text-slate-400'>No relations</div>
                  ) : (
                    sourceFieldOpts.map((f) => (
                      <CommandItem
                        key={f.value}
                        value={f.value}
                        onSelect={() => {
                          const oneCol = isParentM2O
                            ? (parentM2OOpts.find((p) => p.value === f.value)?.one_collection ??
                              undefined)
                            : undefined
                          onChange({
                            ...source,
                            source_field: f.value,
                            source_related_field: '',
                            ...(isParentM2O ? { source_one_collection: oneCol } : {})
                          })
                          setSfOpen(false)
                        }}
                        className='text-[11px]'
                      >
                        {f.label}
                      </CommandItem>
                    ))
                  )}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {!isFiltered && (
          <>
            <span className='text-slate-300 shrink-0'>→</span>
            <Popover open={rfOpen} onOpenChange={setRfOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='h-7 rounded border border-slate-200 bg-slate-50 px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[70px] max-w-[110px] transition-colors'
                >
                  {source.source_related_field ? (
                    (relFieldOpts.find(
                      (f: { value: string }) => f.value === source.source_related_field
                    )?.label ?? source.source_related_field)
                  ) : (
                    <span className='text-slate-400'>{relCollection ? 'field…' : '—'}</span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-44 p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                  <CommandList>
                    <CommandGroup>
                      {relFieldOpts.length === 0 ? (
                        <div className='px-3 py-2 text-[11px] text-slate-400'>No fields</div>
                      ) : (
                        relFieldOpts.map((f: { value: string; label: string }) => (
                          <CommandItem
                            key={f.value}
                            value={f.value}
                            onSelect={() => {
                              onChange({ ...source, source_related_field: f.value })
                              setRfOpen(false)
                            }}
                            className='text-[11px]'
                          >
                            {f.label}
                          </CommandItem>
                        ))
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </>
        )}
      </div>

      {/* Filtered child — condition row */}
      {isFiltered && (
        <div className='border-t border-slate-100 bg-slate-50 px-2 py-1.5'>
          <div className='flex items-center gap-1.5 flex-wrap pl-5'>
            <span className='text-[10px] font-medium text-slate-400 shrink-0 uppercase tracking-wide'>
              in
            </span>
            <Popover open={childColOpen} onOpenChange={setChildColOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='h-6 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[100px] max-w-[140px] transition-colors'
                >
                  {source.o2m_collection || (
                    <span className='text-slate-400'>
                      {intermediateCollection ? 'collection…' : 'pick field first'}
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-48 p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                  <CommandList>
                    <CommandGroup>
                      {childCollectionOpts.length === 0 ? (
                        <div className='px-3 py-2 text-[11px] text-slate-400'>
                          {intermediateCollection ? 'No child relations' : 'Pick field first'}
                        </div>
                      ) : (
                        childCollectionOpts.map((c) => (
                          <CommandItem
                            key={c.value}
                            value={c.value}
                            onSelect={() => {
                              onChange({
                                ...source,
                                o2m_collection: c.value,
                                filter_field: undefined,
                                source_related_field: ''
                              })
                              setChildColOpen(false)
                            }}
                            className='text-[11px]'
                          >
                            {c.label}
                          </CommandItem>
                        ))
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <span className='text-[11px] text-slate-400 shrink-0'>where</span>
            <Popover open={ffOpen} onOpenChange={setFfOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='h-6 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[80px] max-w-[110px] transition-colors'
                >
                  {source.filter_field || <span className='text-slate-400'>field…</span>}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-44 p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                  <CommandList>
                    <CommandGroup>
                      {o2mFieldOpts.length === 0 ? (
                        <div className='px-3 py-2 text-[11px] text-slate-400'>
                          {source.o2m_collection ? 'No fields' : 'Pick collection first'}
                        </div>
                      ) : (
                        o2mFieldOpts.map((f: { value: string; label: string }) => (
                          <CommandItem
                            key={f.value}
                            value={f.value}
                            onSelect={() => {
                              onChange({ ...source, filter_field: f.value })
                              setFfOpen(false)
                            }}
                            className='text-[11px]'
                          >
                            {f.label}
                          </CommandItem>
                        ))
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <span className='text-[11px] text-slate-400 shrink-0'>=</span>
            <Popover
              open={fvOpen}
              onOpenChange={(v) => {
                setFvOpen(v)
                if (!v) setFvSearch('')
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='h-6 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[100px] max-w-[150px] transition-colors font-mono'
                >
                  {source.filter_value || <span className='text-slate-400 font-sans'>value…</span>}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-52 p-0' align='start'>
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder='$parent.field or literal…'
                    className='h-7 text-[11px]'
                    value={fvSearch}
                    onValueChange={setFvSearch}
                  />
                  <CommandList>
                    {parentFieldOpts.filter((p) => !fvSearch || p.value.includes(fvSearch)).length >
                      0 && (
                      <CommandGroup heading='Parent fields'>
                        {parentFieldOpts
                          .filter((p) => !fvSearch || p.value.includes(fvSearch))
                          .map((p) => (
                            <CommandItem
                              key={p.value}
                              value={p.value}
                              onSelect={() => {
                                onChange({ ...source, filter_value: p.value })
                                setFvOpen(false)
                                setFvSearch('')
                              }}
                              className='text-[11px]'
                            >
                              {p.label}
                            </CommandItem>
                          ))}
                      </CommandGroup>
                    )}
                    {fvSearch && (
                      <CommandGroup heading='Use as literal'>
                        <CommandItem
                          value={`__use__${fvSearch}`}
                          onSelect={() => {
                            onChange({ ...source, filter_value: fvSearch })
                            setFvOpen(false)
                            setFvSearch('')
                          }}
                          className='text-[11px] font-mono'
                        >
                          {fvSearch}
                        </CommandItem>
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <span className='text-slate-300 shrink-0'>→</span>
            <Popover open={rfOpen} onOpenChange={setRfOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='h-6 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-[80px] max-w-[110px] transition-colors'
                >
                  {source.source_related_field || (
                    <span className='text-slate-400'>{source.o2m_collection ? 'field…' : '—'}</span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className='w-44 p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                  <CommandList>
                    <CommandGroup>
                      {o2mScalarOpts.length === 0 ? (
                        <div className='px-3 py-2 text-[11px] text-slate-400'>
                          {source.o2m_collection ? 'No fields' : 'Enter collection first'}
                        </div>
                      ) : (
                        o2mScalarOpts.map((f: { value: string; label: string }) => (
                          <CommandItem
                            key={f.value}
                            value={f.value}
                            onSelect={() => {
                              onChange({ ...source, source_related_field: f.value })
                              setRfOpen(false)
                            }}
                            className='text-[11px]'
                          >
                            {f.label}
                          </CommandItem>
                        ))
                      )}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      )}
    </div>
  )
}

function SelectButton<T extends string>({
  value,
  opts,
  onChange,
  className
}: {
  value: T
  opts: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const label = opts.find((o) => o.value === value)?.label ?? value
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'h-7 rounded border border-slate-200 bg-white px-2.5 text-[11px] text-slate-700 hover:border-slate-400 flex items-center gap-1 shrink-0 transition-colors',
            className
          )}
        >
          {label}
          <ChevronDown className='h-3 w-3 text-slate-400 ml-0.5 shrink-0' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-auto min-w-[120px] p-1' align='start'>
        {opts.map((o) => (
          <button
            key={o.value}
            type='button'
            onClick={() => {
              onChange(o.value)
              setOpen(false)
            }}
            className={cn(
              'w-full text-left px-2.5 py-1.5 rounded text-[12px] hover:bg-slate-50 transition-colors',
              o.value === value ? 'font-medium text-slate-900 bg-slate-50' : 'text-slate-700'
            )}
          >
            {o.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function OrTriggerPicker({
  value,
  fieldOpts,
  onChange
}: {
  value: string
  fieldOpts: Array<{ value: string; label: string }>
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex-1 h-6 rounded border border-slate-200 bg-white px-2 text-[10px] text-left truncate hover:border-slate-400 min-w-0'
        >
          {value ? (
            (fieldOpts.find((f) => f.value === value)?.label ?? value)
          ) : (
            <span className='text-slate-400'>field…</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-52 p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
          <CommandList>
            <CommandGroup>
              {fieldOpts.map((f) => (
                <CommandItem
                  key={f.value}
                  value={f.value}
                  onSelect={() => {
                    onChange(f.value)
                    setOpen(false)
                  }}
                  className='text-[11px]'
                >
                  {f.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function RowRuleRow({
  rule,
  childFields,
  m2oRels,
  o2mRels,
  onChange,
  onRemove,
  portalContainer,
  parentContextFields
}: {
  rule: RowRuleItem
  childFields: Array<{ field: string; label?: string | null; type?: string }>
  m2oRels: Array<{ many_field: string; one_collection: string }>
  o2mRels: Array<{ one_field: string; many_collection: string }>
  onChange: (r: RowRuleItem) => void
  onRemove: () => void
  portalContainer?: HTMLElement | null
  parentContextFields?: Array<{ field: string; label: string; one_collection?: string | null }>
}) {
  const [expanded, setExpanded] = useState(!rule.trigger_field)
  const [tfOpen, setTfOpen] = useState(false)
  const [tgtOpen, setTgtOpen] = useState(false)
  const [tvOpen, setTvOpen] = useState(false)
  const [trfOpen, setTrfOpen] = useState(false)
  const [trf2Open, setTrf2Open] = useState(false)
  const [parentTvOpen, setParentTvOpen] = useState(false)
  const [pickOpen, setPickOpen] = useState(false)
  const [pickSearch, setPickSearch] = useState('')
  const fieldOpts = childFields
    .filter((f) => !o2mRels.some((r) => r.one_field === f.field))
    .map((f) => ({
      value: f.field,
      label: toFriendlyFieldLabel(f.field),
      hint: fieldTypeHint(f.field, f.type, m2oRels, o2mRels)
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const isParentTrigger = !!rule.trigger_field && rule.trigger_field.startsWith('$parent.')
  const isTriggerM2O =
    !isParentTrigger &&
    !!rule.trigger_field &&
    !!m2oRels.find((r) => r.many_field === rule.trigger_field)
  const relatedCollection = rule.trigger_field
    ? (m2oRels.find((r) => r.many_field === rule.trigger_field)?.one_collection ?? null)
    : null
  const parentTriggerLabel = isParentTrigger
    ? (parentContextFields?.find((p) => `$parent.${p.field}` === rule.trigger_field)?.label ??
      rule.trigger_field!.slice(8))
    : null
  const parentTriggerOneCollection = isParentTrigger
    ? (parentContextFields?.find((p) => `$parent.${p.field}` === rule.trigger_field)
        ?.one_collection ?? null)
    : null

  // Parse dot-path in trigger_related_field (e.g. "category_type.type")
  const trfParts = (rule.trigger_related_field ?? '').split('.').filter(Boolean)
  const trfSeg1 = trfParts[0] ?? null
  const trfSeg2 = trfParts[1] ?? null

  const { data: relatedFieldsData } = useQuery({
    queryKey: ['field-config-all', relatedCollection],
    queryFn: () =>
      api
        .get(`/field-config/${relatedCollection}`)
        .then(
          (r: {
            data: { data?: Array<{ field: string; label?: string | null; type?: string }> }
          }) => r.data.data ?? []
        ),
    enabled: !!relatedCollection && (rule.target_type === 'relation_field' || isTriggerM2O),
    staleTime: 5 * 60 * 1000
  })

  const relatedFieldOpts = (relatedFieldsData ?? [])
    .filter(
      (f: { field: string; type?: string }) =>
        f.field !== 'id' && !ROW_RULE_SKIP_TYPES.has(f.type ?? '')
    )
    .map((f: { field: string; label?: string | null }) => ({
      value: f.field,
      label: f.label || f.field
    }))

  // Fetch relations on the related collection so we can detect 2nd-level M2O hops
  const { data: relCollRelations } = useQuery({
    queryKey: ['relations-for', relatedCollection],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            many_collection?: string
            many_field?: string
            one_collection?: string
            junction_field?: unknown
          }>
        }>(`/data-model/relations/for/${relatedCollection}`)
        .then((r) => r.data.data ?? []),
    enabled: !!relatedCollection && isTriggerM2O,
    staleTime: 5 * 60 * 1000
  })

  const seg1Rel = trfSeg1
    ? (relCollRelations ?? []).find(
        (r: {
          many_collection?: string
          many_field?: string
          one_collection?: string
          junction_field?: unknown
        }) =>
          r.many_collection === relatedCollection && r.many_field === trfSeg1 && !r.junction_field
      )
    : null
  const relRelCollection =
    (seg1Rel as { one_collection?: string } | null | undefined)?.one_collection ?? null

  const { data: relRelFieldsData } = useQuery({
    queryKey: ['field-config-all', relRelCollection],
    queryFn: () =>
      api
        .get(`/field-config/${relRelCollection}`)
        .then(
          (r: {
            data: { data?: Array<{ field: string; label?: string | null; type?: string }> }
          }) => r.data.data ?? []
        ),
    enabled: !!relRelCollection,
    staleTime: 5 * 60 * 1000
  })

  const relRelFieldOpts = (relRelFieldsData ?? [])
    .filter(
      (f: { field: string; type?: string }) =>
        f.field !== 'id' && !ROW_RULE_SKIP_TYPES.has(f.type ?? '')
    )
    .map((f: { field: string; label?: string | null }) => ({
      value: f.field,
      label: f.label || f.field
    }))

  // Target field M2O detection — for the "pick record" target type
  const targetM2ORel = rule.target_field
    ? m2oRels.find(
        (r: { many_field?: string; junction_field?: unknown }) =>
          r.many_field === rule.target_field && !r.junction_field
      )
    : null
  const targetRelCollection =
    (targetM2ORel as { one_collection?: string } | undefined)?.one_collection ?? null

  const { data: targetRelFieldsData } = useQuery({
    queryKey: ['field-config-all', targetRelCollection, 'pick'],
    queryFn: () =>
      api
        .get(`/field-config/${targetRelCollection}`)
        .then(
          (r: {
            data: { data?: Array<{ field: string; type?: string; label?: string | null }> }
          }) => r.data.data ?? []
        ),
    enabled: !!targetRelCollection && rule.target_type === 'pick',
    staleTime: 5 * 60 * 1000
  })

  const pickDisplayField = useMemo(() => {
    const fields =
      (targetRelFieldsData as Array<{ field: string; type?: string }> | undefined) ?? []
    const preferred = ['name', 'title', 'label', 'display_name', 'subject', 'heading']
    const byName = fields.find((f) => preferred.includes(f.field))
    if (byName) return byName.field
    const textTypes = new Set(['string', 'text', 'varchar', 'nvarchar', 'char'])
    return fields.find((f) => f.field !== 'id' && textTypes.has(f.type ?? ''))?.field ?? null
  }, [targetRelFieldsData])

  const { data: pickItemsData } = useQuery({
    queryKey: ['row-rule-pick-items', targetRelCollection, pickSearch],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '20' })
      if (pickSearch) params.set('search', pickSearch)
      return api
        .get(`/items/${targetRelCollection}?${params}`)
        .then((r: { data: { data?: Array<Record<string, unknown>> } }) => r.data.data ?? [])
    },
    enabled: !!targetRelCollection && rule.target_type === 'pick' && pickOpen,
    staleTime: 30 * 1000
  })

  const pickItems = (pickItemsData as Array<Record<string, unknown>> | undefined) ?? []

  // Fetch the currently-selected pick target record (for label display when popover is closed)
  const { data: pickValueItemData } = useQuery({
    queryKey: ['row-rule-pick-value-item', targetRelCollection, rule.target_value],
    queryFn: () =>
      api
        .get(`/items/${targetRelCollection}/${rule.target_value}`)
        .then((r: { data: { data?: Record<string, unknown> } }) => r.data.data ?? null),
    enabled: !!targetRelCollection && rule.target_type === 'pick' && !!rule.target_value,
    staleTime: 5 * 60 * 1000
  })

  // Trigger value label — resolve FK id to display name when trigger is M2O or parent M2O
  const triggerValueCollection = isParentTrigger
    ? parentTriggerOneCollection
    : isTriggerM2O
      ? relatedCollection
      : null
  const triggerValueIsId =
    !!triggerValueCollection &&
    !!rule.trigger_value &&
    ['eq', 'neq'].includes(rule.trigger_op ?? '')

  const { data: triggerValueItemData } = useQuery({
    queryKey: ['row-rule-trigger-value-item', triggerValueCollection, rule.trigger_value],
    queryFn: () =>
      api
        .get(`/items/${triggerValueCollection}/${rule.trigger_value}`)
        .then((r: { data: { data?: Record<string, unknown> } }) => r.data.data ?? null),
    enabled: triggerValueIsId,
    staleTime: 5 * 60 * 1000
  })

  function resolveItemLabel(
    item: Record<string, unknown> | null | undefined,
    fallback: string | null | undefined
  ): string | null {
    if (!item) return fallback ?? null
    const preferred = ['name', 'title', 'label', 'display_name', 'subject', 'heading']
    const hit =
      preferred.find((k) => item[k] != null && String(item[k]).trim() !== '') ??
      Object.keys(item).find(
        (k) => k !== 'id' && typeof item[k] === 'string' && String(item[k]).trim() !== ''
      )
    return hit ? String(item[hit]) : (fallback ?? null)
  }

  // Op shows after the final resolved field (not mid-hop M2O that still needs a second level)
  const showViaOp = !!rule.trigger_related_field && (!relRelCollection || !!trfSeg2)

  const isViaIdOrEntity = !!trfSeg2 && VIA_ID_MARKERS.has(trfSeg2)

  const showTriggerValue = !!rule.trigger_op && !['null', 'nnull'].includes(rule.trigger_op)
  const showTargetValue = rule.target_type === 'set' || rule.target_type === 'relation_field'
  const showRelatedCombobox = rule.target_type === 'relation_field' && !!relatedCollection
  const showPickCombobox = rule.target_type === 'pick'
  const sources = rule.sources ?? []

  function moveSource(idx: number, dir: -1 | 1) {
    const next = [...sources]
    const tmp = next[idx]
    next[idx] = next[idx + dir]
    next[idx + dir] = tmp
    onChange({ ...rule, sources: next })
  }

  // Build collapsed summary
  const triggerDisplayLabel = isParentTrigger
    ? `↑ ${parentTriggerLabel ?? rule.trigger_field!.slice(8)}`
    : rule.trigger_field
      ? (fieldOpts.find((f) => f.value === rule.trigger_field)?.label ?? rule.trigger_field)
      : null
  const opLabels: Record<string, string> = {
    eq: '=',
    neq: '≠',
    nnull: '≠ empty',
    null: 'is empty',
    in: 'in',
    contains: '~'
  }
  const opStr = opLabels[rule.trigger_op ?? 'nnull'] ?? rule.trigger_op ?? ''
  const resolvedTriggerVal = triggerValueIsId
    ? resolveItemLabel(triggerValueItemData as Record<string, unknown> | null, rule.trigger_value)
    : rule.trigger_value
  const valSnippet = resolvedTriggerVal
    ? ` "${resolvedTriggerVal.length > 20 ? `${resolvedTriggerVal.slice(0, 20)}…` : resolvedTriggerVal}"`
    : ''
  const targetDisplayLabel = rule.target_field
    ? (fieldOpts.find((f) => f.value === rule.target_field)?.label ?? rule.target_field)
    : null
  const resolvedPickVal =
    rule.target_type === 'pick' && rule.target_value
      ? resolveItemLabel(pickValueItemData as Record<string, unknown> | null, rule.target_value)
      : null
  const targetTypeBadge: Record<string, string> = {
    set: '',
    relation_field: 'M2O',
    precedence: 'chain',
    clear: 'clear',
    pick: ''
  }
  const pickSuffix = rule.target_type === 'pick' && resolvedPickVal ? ` = ${resolvedPickVal}` : ''
  const collapsedSummary =
    triggerDisplayLabel && targetDisplayLabel
      ? `${triggerDisplayLabel} ${opStr}${valSnippet} → ${targetDisplayLabel}${pickSuffix}${targetTypeBadge[rule.target_type] ? ` · ${targetTypeBadge[rule.target_type]}` : ''}`
      : triggerDisplayLabel
        ? `${triggerDisplayLabel} ${opStr}${valSnippet} → ?`
        : '(new rule — click to configure)'

  return (
    <div className='rounded-md border border-slate-200 bg-white overflow-hidden'>
      {/* Header — always visible, click to expand/collapse */}
      <div
        className='flex items-center gap-1.5 px-2.5 py-2 cursor-pointer select-none hover:bg-slate-50/80 transition-colors'
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 text-slate-400 shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className='flex-1 text-[11px] text-slate-600 truncate min-w-0'>
          {collapsedSummary}
        </span>
        {rule.only_if_empty && (
          <span className='shrink-0 rounded px-1 py-0.5 text-[9px] font-medium bg-amber-50 text-amber-600 border border-amber-100'>
            fallback
          </span>
        )}
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className='shrink-0 text-slate-300 hover:text-red-400 transition-colors ml-1'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>

      {/* Expanded body */}
      {expanded && (
        <>
          {/* IF section */}
          <div className='border-t border-slate-100 px-2.5 py-2 space-y-1.5 bg-slate-50/50'>
            <div className='flex items-start gap-1.5'>
              <span className='text-[9px] font-semibold text-slate-400 mt-[7px] w-5 shrink-0 tracking-wide'>
                IF
              </span>
              <div className='flex-1 min-w-0 space-y-1.5'>
                {/* Trigger field + op */}
                <div className='flex items-center gap-1.5'>
                  <Popover open={tfOpen} onOpenChange={setTfOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type='button'
                        className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-0'
                      >
                        {isParentTrigger ? (
                          <span className='flex items-center gap-1'>
                            <span className='text-[9px] bg-nvr-cyan/10 text-nvr-cyan rounded px-1 py-0.5 shrink-0'>
                              parent
                            </span>
                            {parentTriggerLabel}
                          </span>
                        ) : rule.trigger_field ? (
                          (fieldOpts.find((f) => f.value === rule.trigger_field)?.label ??
                          rule.trigger_field)
                        ) : (
                          <span className='text-slate-400'>when field changes…</span>
                        )}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className='w-52 p-0' align='start' container={portalContainer}>
                      <Command>
                        <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
                        <CommandList className='max-h-[220px]'>
                          {parentContextFields && parentContextFields.length > 0 && (
                            <CommandGroup heading='↑ Parent record'>
                              {parentContextFields.map((p) => (
                                <CommandItem
                                  key={`$parent.${p.field}`}
                                  value={`parent ${p.label} ${p.field}`}
                                  onSelect={() => {
                                    onChange({
                                      ...rule,
                                      trigger_field: `$parent.${p.field}`,
                                      trigger_related_field: null
                                    })
                                    setTfOpen(false)
                                  }}
                                  className='text-[12px] flex items-center justify-between gap-2'
                                >
                                  <span className='truncate'>{p.label}</span>
                                  <span className='shrink-0 text-[9px] bg-nvr-cyan/10 text-nvr-cyan rounded px-1'>
                                    parent
                                  </span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          )}
                          <CommandGroup
                            heading={parentContextFields?.length ? 'Child record' : undefined}
                          >
                            {fieldOpts.map((f) => (
                              <CommandItem
                                key={f.value}
                                value={`${f.label} ${f.value}`}
                                onSelect={() => {
                                  onChange({
                                    ...rule,
                                    trigger_field: f.value,
                                    trigger_related_field: null
                                  })
                                  setTfOpen(false)
                                }}
                                className='text-[12px] flex items-center justify-between gap-2'
                              >
                                <span className='truncate'>{f.label}</span>
                                {f.hint && (
                                  <span className='shrink-0 rounded px-1 py-0.5 text-[9px] font-medium bg-slate-100 text-slate-500'>
                                    {f.hint}
                                  </span>
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  {!trfSeg1 && (
                    <SelectButton
                      value={(rule.trigger_op ?? 'nnull') as string}
                      opts={[
                        { value: 'nnull', label: 'has value' },
                        { value: 'null', label: 'is empty' },
                        { value: 'eq', label: 'equals' },
                        { value: 'neq', label: '≠' },
                        { value: 'in', label: 'in list' },
                        { value: 'contains', label: 'contains' }
                      ]}
                      onChange={(v) => onChange({ ...rule, trigger_op: v })}
                    />
                  )}
                </div>

                {/* Via related field — M2O drill-down */}
                {isTriggerM2O && (
                  <div className='flex items-center gap-1.5 flex-wrap'>
                    <span className='text-[10px] text-slate-400 shrink-0'>via:</span>
                    <Popover open={trfOpen} onOpenChange={setTrfOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type='button'
                          className='flex-1 h-6 rounded border border-slate-200 bg-white px-2 text-[10px] text-left truncate hover:border-slate-400 min-w-0'
                        >
                          {trfSeg1 ? (
                            (relatedFieldOpts.find((f: { value: string }) => f.value === trfSeg1)
                              ?.label ?? trfSeg1)
                          ) : (
                            <span className='text-slate-400 italic'>FK id (direct)</span>
                          )}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        className='w-48 p-0'
                        align='start'
                        container={portalContainer}
                      >
                        <Command>
                          <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                          <CommandList className='max-h-[180px]'>
                            <CommandGroup>
                              <CommandItem
                                value='__none__'
                                onSelect={() => {
                                  onChange({ ...rule, trigger_related_field: null })
                                  setTrfOpen(false)
                                }}
                                className='text-[11px] text-slate-400 italic'
                              >
                                FK id (direct)
                              </CommandItem>
                              {relatedFieldOpts.map((f: { value: string; label: string }) => (
                                <CommandItem
                                  key={f.value}
                                  value={f.value}
                                  onSelect={() => {
                                    onChange({ ...rule, trigger_related_field: f.value })
                                    setTrfOpen(false)
                                  }}
                                  className='text-[11px]'
                                >
                                  {f.label}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                    {trfSeg1 && relRelCollection && (
                      <>
                        <span className='text-[10px] text-slate-400 shrink-0'>→</span>
                        <Popover open={trf2Open} onOpenChange={setTrf2Open}>
                          <PopoverTrigger asChild>
                            <button
                              type='button'
                              className='flex-1 h-6 rounded border border-slate-200 bg-white px-2 text-[10px] text-left truncate hover:border-slate-400 min-w-0'
                            >
                              {trfSeg2 === '__entity__' || trfSeg2 === '__id__' ? (
                                <span className='italic'>(entity)</span>
                              ) : trfSeg2 ? (
                                (relRelFieldOpts.find((f: { value: string }) => f.value === trfSeg2)
                                  ?.label ?? trfSeg2)
                              ) : (
                                <span className='text-slate-400 italic'>field…</span>
                              )}
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className='w-48 p-0'
                            align='start'
                            container={portalContainer}
                          >
                            <Command>
                              <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
                              <CommandList className='max-h-[180px]'>
                                <CommandGroup>
                                  <CommandItem
                                    value='__entity__'
                                    onSelect={() => {
                                      onChange({
                                        ...rule,
                                        trigger_related_field: `${trfSeg1}.__entity__`,
                                        trigger_value: null
                                      })
                                      setTrf2Open(false)
                                    }}
                                    className='text-[11px] italic text-slate-500'
                                  >
                                    (entity) — record picker
                                  </CommandItem>
                                  {relRelFieldOpts.map((f: { value: string; label: string }) => (
                                    <CommandItem
                                      key={f.value}
                                      value={f.value}
                                      onSelect={() => {
                                        onChange({
                                          ...rule,
                                          trigger_related_field: `${trfSeg1}.${f.value}`,
                                          trigger_value: null
                                        })
                                        setTrf2Open(false)
                                      }}
                                      className='text-[11px]'
                                    >
                                      {f.label}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      </>
                    )}
                    {showViaOp && (
                      <SelectButton
                        value={(rule.trigger_op ?? 'nnull') as string}
                        opts={[
                          { value: 'nnull', label: 'has value' },
                          { value: 'null', label: 'is empty' },
                          { value: 'eq', label: 'equals' },
                          { value: 'neq', label: '≠' },
                          { value: 'in', label: 'in list' },
                          { value: 'contains', label: 'contains' }
                        ]}
                        onChange={(v) => onChange({ ...rule, trigger_op: v })}
                      />
                    )}
                  </div>
                )}

                {/* Trigger value */}
                {showTriggerValue &&
                  (isViaIdOrEntity && relRelCollection ? (
                    <ViaValuePicker
                      collection={relRelCollection}
                      value={rule.trigger_value ?? null}
                      isMulti={rule.trigger_op === 'in'}
                      onChange={(v) => onChange({ ...rule, trigger_value: v })}
                    />
                  ) : isParentTrigger && parentTriggerOneCollection ? (
                    <ViaValuePicker
                      collection={parentTriggerOneCollection}
                      value={rule.trigger_value ?? null}
                      isMulti={rule.trigger_op === 'in'}
                      onChange={(v) => onChange({ ...rule, trigger_value: v })}
                    />
                  ) : (
                    <input
                      type='text'
                      value={rule.trigger_value ?? ''}
                      onChange={(e) => onChange({ ...rule, trigger_value: e.target.value || null })}
                      placeholder={
                        rule.trigger_op === 'in'
                          ? 'val1, val2 (comma-separated)'
                          : 'value (or $parent.field_name)'
                      }
                      className='w-full h-7 rounded border border-slate-200 bg-white px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
                    />
                  ))}

                {/* Extra OR triggers */}
                {(rule.trigger_fields ?? []).map((tf, i) => (
                  <div key={i} className='flex items-center gap-1'>
                    <span className='text-[10px] text-slate-400 shrink-0 italic'>or</span>
                    <OrTriggerPicker
                      value={tf}
                      fieldOpts={fieldOpts}
                      onChange={(v) => {
                        const next = [...(rule.trigger_fields ?? [])]
                        next[i] = v
                        onChange({ ...rule, trigger_fields: next })
                      }}
                    />
                    <button
                      type='button'
                      onClick={() =>
                        onChange({
                          ...rule,
                          trigger_fields: (rule.trigger_fields ?? []).filter((_, j) => j !== i)
                        })
                      }
                      className='shrink-0 text-slate-300 hover:text-red-400 text-[10px] px-0.5'
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {rule.trigger_field && (
                  <button
                    type='button'
                    onClick={() =>
                      onChange({ ...rule, trigger_fields: [...(rule.trigger_fields ?? []), ''] })
                    }
                    className='text-[10px] text-nvr-cyan hover:underline'
                  >
                    + or when another field changes
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* SET section */}
          <div className='border-t border-slate-100 px-2.5 py-2 space-y-1.5'>
            <div className='flex items-start gap-1.5'>
              <span className='text-[10px] font-semibold text-slate-500 mt-[7px] w-5 shrink-0 tracking-wide'>
                SET
              </span>
              <div className='flex-1 min-w-0 space-y-1.5'>
                {/* Target field + type */}
                <div className='flex items-center gap-1.5'>
                  <Popover open={tgtOpen} onOpenChange={setTgtOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type='button'
                        className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 min-w-0'
                      >
                        {rule.target_field ? (
                          (fieldOpts.find((f) => f.value === rule.target_field)?.label ??
                          rule.target_field)
                        ) : (
                          <span className='text-slate-400'>target field…</span>
                        )}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className='w-52 p-0' align='start' container={portalContainer}>
                      <Command>
                        <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
                        <CommandList className='max-h-[180px]'>
                          <CommandGroup>
                            {fieldOpts.map((f) => (
                              <CommandItem
                                key={f.value}
                                value={`${f.label} ${f.value}`}
                                onSelect={() => {
                                  onChange({ ...rule, target_field: f.value })
                                  setTgtOpen(false)
                                }}
                                className='text-[12px] flex items-center justify-between gap-2'
                              >
                                <span className='truncate'>{f.label}</span>
                                {f.hint && (
                                  <span className='shrink-0 rounded px-1 py-0.5 text-[9px] font-medium bg-slate-100 text-slate-500'>
                                    {f.hint}
                                  </span>
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <SelectButton
                    value={rule.target_type}
                    opts={[
                      { value: 'set', label: '= literal' },
                      { value: 'pick', label: '= pick record' },
                      { value: 'relation_field', label: '= from M2O' },
                      { value: 'precedence', label: '= chain' },
                      { value: 'clear', label: '= clear' }
                    ]}
                    onChange={(v) =>
                      onChange({
                        ...rule,
                        target_type: v as RowRuleItem['target_type'],
                        target_value: null,
                        sources: []
                      })
                    }
                  />
                </div>

                {/* Target value: relation_field combobox */}
                {showTargetValue && showRelatedCombobox && (
                  <Popover open={tvOpen} onOpenChange={setTvOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type='button'
                        className='w-full h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400'
                      >
                        {rule.target_value ? (
                          (relatedFieldOpts.find(
                            (f: { value: string }) => f.value === rule.target_value
                          )?.label ?? rule.target_value)
                        ) : (
                          <span className='text-slate-400'>field from {relatedCollection}…</span>
                        )}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className='w-52 p-0' align='start' container={portalContainer}>
                      <Command>
                        <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
                        <CommandList className='max-h-[180px]'>
                          <CommandGroup>
                            {relatedFieldOpts.length === 0 ? (
                              <div className='px-3 py-2 text-[11px] text-slate-400'>
                                No fields found
                              </div>
                            ) : (
                              relatedFieldOpts.map((f: { value: string; label: string }) => (
                                <CommandItem
                                  key={f.value}
                                  value={f.value}
                                  onSelect={() => {
                                    onChange({ ...rule, target_value: f.value })
                                    setTvOpen(false)
                                  }}
                                  className='text-[12px]'
                                >
                                  {f.label}
                                </CommandItem>
                              ))
                            )}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                )}

                {/* Target value: literal input */}
                {showTargetValue && !showRelatedCombobox && (
                  <div className='flex gap-1'>
                    <input
                      type='text'
                      value={rule.target_value ?? ''}
                      onChange={(e) => onChange({ ...rule, target_value: e.target.value || null })}
                      placeholder={
                        rule.target_type === 'relation_field'
                          ? 'select an M2O trigger field first'
                          : 'value'
                      }
                      className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan min-w-0'
                      readOnly={rule.target_type === 'relation_field'}
                    />
                    {parentContextFields &&
                      parentContextFields.length > 0 &&
                      rule.target_type === 'set' && (
                        <Popover open={parentTvOpen} onOpenChange={setParentTvOpen}>
                          <PopoverTrigger asChild>
                            <button
                              type='button'
                              title='Use parent field value'
                              className='h-7 px-1.5 rounded border border-slate-200 bg-white text-[10px] text-nvr-cyan hover:border-nvr-cyan shrink-0'
                            >
                              ↑
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className='w-52 p-0'
                            align='end'
                            container={portalContainer}
                          >
                            <Command>
                              <CommandList className='max-h-[180px]'>
                                <CommandGroup heading='Copy from parent'>
                                  {parentContextFields.map((p) => (
                                    <CommandItem
                                      key={p.field}
                                      value={`${p.label} ${p.field}`}
                                      onSelect={() => {
                                        onChange({ ...rule, target_value: `$parent.${p.field}` })
                                        setParentTvOpen(false)
                                      }}
                                      className='text-[12px] flex items-center justify-between gap-2'
                                    >
                                      <span className='truncate'>{p.label}</span>
                                      <span className='shrink-0 text-[9px] font-mono text-slate-400'>
                                        {p.field}
                                      </span>
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      )}
                  </div>
                )}

                {/* Pick record combobox */}
                {showPickCombobox &&
                  (!targetRelCollection ? (
                    <p className='text-[10px] text-slate-400 italic'>
                      Select an M2O target field first
                    </p>
                  ) : (
                    <Popover open={pickOpen} onOpenChange={setPickOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type='button'
                          className='w-full h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400'
                        >
                          {rule.target_value ? (
                            (resolveItemLabel(
                              pickValueItemData as Record<string, unknown> | null,
                              rule.target_value
                            ) ?? String(rule.target_value))
                          ) : (
                            <span className='text-slate-400'>pick from {targetRelCollection}…</span>
                          )}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        className='w-56 p-0'
                        align='start'
                        container={portalContainer}
                      >
                        <Command>
                          <CommandInput
                            placeholder='Search…'
                            className='h-8 text-[12px]'
                            value={pickSearch}
                            onValueChange={setPickSearch}
                          />
                          <CommandList className='max-h-[180px]'>
                            <CommandGroup>
                              {pickItems.length === 0 ? (
                                <div className='px-3 py-2 text-[11px] text-slate-400'>
                                  No records found
                                </div>
                              ) : (
                                pickItems.map((item) => {
                                  const id = String(item.id)
                                  const label =
                                    pickDisplayField && item[pickDisplayField] != null
                                      ? String(item[pickDisplayField])
                                      : id
                                  return (
                                    <CommandItem
                                      key={id}
                                      value={`${label} ${id}`}
                                      onSelect={() => {
                                        onChange({ ...rule, target_value: id })
                                        setPickOpen(false)
                                      }}
                                      className='text-[12px] flex items-center justify-between gap-2'
                                    >
                                      <span className='truncate'>{label}</span>
                                      {label !== id && (
                                        <span className='shrink-0 font-mono text-[9px] text-slate-400'>
                                          {id}
                                        </span>
                                      )}
                                    </CommandItem>
                                  )
                                })
                              )}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  ))}

                {/* Precedence chain sources */}
                {rule.target_type === 'precedence' && (
                  <div className='space-y-1.5 pt-0.5'>
                    <p className='text-[11px] text-slate-500 font-medium'>
                      Sources — first non-null wins:
                    </p>
                    {sources.map((src, idx) => (
                      <PrecedenceSourceRow
                        key={idx}
                        source={src}
                        index={idx}
                        total={sources.length}
                        m2oRels={m2oRels}
                        o2mRels={o2mRels}
                        parentContextFields={parentContextFields}
                        onChange={(updated) =>
                          onChange({
                            ...rule,
                            sources: sources.map((s, i) => (i === idx ? updated : s))
                          })
                        }
                        onRemove={() =>
                          onChange({ ...rule, sources: sources.filter((_, i) => i !== idx) })
                        }
                        onMoveUp={() => moveSource(idx, -1)}
                        onMoveDown={() => moveSource(idx, 1)}
                      />
                    ))}
                    <button
                      type='button'
                      onClick={() =>
                        onChange({
                          ...rule,
                          sources: [
                            ...sources,
                            {
                              source_type: 'relation_field',
                              source_field: '',
                              source_related_field: ''
                            }
                          ]
                        })
                      }
                      className='text-[11px] text-nvr-cyan hover:text-nvr-cyan/80 font-medium transition-colors'
                    >
                      + Add source
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className='border-t border-slate-100 px-2.5 py-1.5 bg-slate-50/50'>
            <label className='flex items-center gap-2 cursor-pointer'>
              <input
                type='checkbox'
                checked={!!rule.only_if_empty}
                onChange={(e) => onChange({ ...rule, only_if_empty: e.target.checked })}
                className='h-3.5 w-3.5 accent-nvr-cyan'
              />
              <span className='text-[11px] text-slate-600'>
                Only set if target is currently empty
              </span>
            </label>
          </div>
        </>
      )}
    </div>
  )
}

// _key is a client-only React list key (never serialized — save() reads only
// the named fields below), so reordering keeps identity stable across moves.
type ColumnPresetItem = { name: string; columns: string[]; _key: string }
type DrawerRelationItem = { field: string; sumField: string; capField: string; _key: string }
type PresetFieldOption = { field: string; label: string }
// One group per relatedCollection layout columns (heading undefined) plus one group
// per configured drawer relation offering "relationField.memberField" dot tokens.
type PresetOptionGroup = { heading?: string; options: PresetFieldOption[] }

// Module-level (not per-render) so useMemo deps referencing them are stable —
// mirrors InlineTableField's NON_DISPLAY_TYPES/SENTINEL_FIELDS/SPECIAL_GROUP_KEYS predicate.
const PRESET_NON_DISPLAY_TYPES = new Set([
  'alias',
  'o2m',
  'm2m',
  'm2a',
  'presentation',
  'group',
  'divider'
])
const PRESET_SENTINEL_FIELDS = new Set([
  '__pipeline__',
  '__comments__',
  '__tasks__',
  '__addendums__',
  '__owners__',
  '__pdf__',
  '__subtitle__'
])
const PRESET_SPECIAL_GROUP_KEYS = new Set(['__apply_values__', '__create_with_defaults__'])
const isM2MIfacePreset = (ifc: string | null | undefined) =>
  ifc === 'select-multiple-m2m' || (ifc ?? '').endsWith('-m2m')

function ColumnPresetRow({
  preset,
  optionGroups,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast
}: {
  preset: ColumnPresetItem
  optionGroups: PresetOptionGroup[]
  onChange: (p: ColumnPresetItem) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  isFirst: boolean
  isLast: boolean
}) {
  const [colsOpen, setColsOpen] = useState(false)
  const allOptions = useMemo(() => optionGroups.flatMap((g) => g.options), [optionGroups])
  // Stored columns not present in the current option set (layout changed, drawer
  // relation removed, etc.) — surfaced as removable warning chips, never silently dropped.
  const staleTokens = preset.columns.filter((c) => !allOptions.some((o) => o.field === c))
  return (
    <div className='space-y-1.5 rounded border border-slate-200 p-2'>
      <div className='flex items-center gap-1.5'>
        <Input
          value={preset.name}
          onChange={(e) => onChange({ ...preset, name: e.target.value })}
          placeholder='Preset name'
          className='h-7 flex-1 text-[11px]'
        />
        <button
          type='button'
          onClick={onMoveUp}
          disabled={isFirst}
          className='shrink-0 text-slate-400 hover:text-nvr-cyan disabled:opacity-30 disabled:hover:text-slate-400'
        >
          <ChevronUp className='h-3.5 w-3.5' />
        </button>
        <button
          type='button'
          onClick={onMoveDown}
          disabled={isLast}
          className='shrink-0 text-slate-400 hover:text-nvr-cyan disabled:opacity-30 disabled:hover:text-slate-400'
        >
          <ChevronDown className='h-3.5 w-3.5' />
        </button>
        <button
          type='button'
          onClick={onRemove}
          className='shrink-0 text-slate-300 hover:text-red-400 text-[11px] px-0.5'
        >
          ✕
        </button>
      </div>
      <Popover open={colsOpen} onOpenChange={setColsOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='w-full flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-left hover:border-slate-400'
          >
            <span
              className={cn('truncate', preset.columns.length ? 'text-slate-700' : 'text-slate-400')}
            >
              {preset.columns.length
                ? preset.columns
                    .map((f) => allOptions.find((o) => o.field === f)?.label || f)
                    .join(', ')
                : 'No columns selected'}
            </span>
            <ChevronDown className='h-3.5 w-3.5 text-slate-400 ml-1 shrink-0' />
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-72 p-0' align='start'>
          <Command>
            <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
            <CommandList className='max-h-[260px]'>
              {optionGroups.map((group, gi) => (
                <CommandGroup key={group.heading ?? `__layout_${gi}`} heading={group.heading}>
                  {group.options.map((f) => {
                    const checked = preset.columns.includes(f.field)
                    return (
                      <CommandItem
                        key={f.field}
                        value={`${f.label} ${f.field}`}
                        onSelect={() =>
                          onChange({
                            ...preset,
                            columns: checked
                              ? preset.columns.filter((x) => x !== f.field)
                              : [...preset.columns, f.field]
                          })
                        }
                        className='text-[11px] flex items-center gap-2'
                      >
                        <Check className={cn('h-3 w-3 shrink-0', checked ? 'opacity-100' : 'opacity-0')} />
                        <span className='flex-1 truncate'>{f.label}</span>
                        <span className='font-mono text-[9px] text-slate-400 shrink-0'>{f.field}</span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {staleTokens.length > 0 && (
        <div className='flex flex-wrap gap-1'>
          {staleTokens.map((token) => (
            <span
              key={token}
              title='Not in the current layout or relation set'
              className='inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700'
            >
              {token}
              <button
                type='button'
                onClick={() => onChange({ ...preset, columns: preset.columns.filter((x) => x !== token) })}
                className='text-amber-500 hover:text-amber-800'
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function DrawerRelationRow({
  entry,
  relationOptions,
  capFieldOptions,
  onChange,
  onRemove
}: {
  entry: DrawerRelationItem
  relationOptions: Array<{ value: string; label: string; collection: string }>
  capFieldOptions: Array<{ field: string; label?: string | null }>
  onChange: (e: DrawerRelationItem) => void
  onRemove: () => void
}) {
  const [fieldOpen, setFieldOpen] = useState(false)
  const [sumOpen, setSumOpen] = useState(false)
  const [capOpen, setCapOpen] = useState(false)

  // sum_field is summed over the GRANDCHILD rows the relation points at
  // (NestedRelationEditor reads it off each nested row), not the child row
  // itself — so its options must come from the selected relation's target
  // collection, resolved fresh per entry.
  const grandCollection = relationOptions.find((r) => r.value === entry.field)?.collection ?? null
  const { data: grandFields = [] } = useQuery<
    Array<{ field: string; label?: string | null; type?: string; hidden?: boolean }>
  >({
    queryKey: ['field-config-all', grandCollection],
    queryFn: () => api.get(`/field-config/${grandCollection}`).then((r) => r.data.data ?? []),
    enabled: !!grandCollection,
    staleTime: 5 * 60 * 1000
  })
  const sumFieldOptions = useMemo(
    () =>
      grandFields.filter(
        (f) => !f.hidden && f.field !== 'id' && NUMERIC_FIELD_TYPES.has(f.type ?? '')
      ),
    [grandFields]
  )

  return (
    <div className='space-y-1.5 rounded border border-slate-200 p-2'>
      <div className='flex items-center gap-1.5'>
        <Popover open={fieldOpen} onOpenChange={setFieldOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan min-w-0'
            >
              {entry.field ? (
                (relationOptions.find((f) => f.value === entry.field)?.label ?? entry.field)
              ) : (
                <span className='text-slate-400'>relation…</span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className='w-56 p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
              <CommandList>
                <CommandGroup>
                  {relationOptions.map((f) => (
                    <CommandItem
                      key={f.value}
                      value={f.value}
                      onSelect={() => {
                        // Changing the relation changes the grandchild collection,
                        // so a previously-chosen sum_field can no longer be valid.
                        onChange({ ...entry, field: f.value, sumField: '' })
                        setFieldOpen(false)
                      }}
                      className='text-[12px]'
                    >
                      {f.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <button
          type='button'
          onClick={onRemove}
          className='shrink-0 text-slate-300 hover:text-red-400 text-[11px] px-0.5'
        >
          ✕
        </button>
      </div>
      <div className='flex items-center gap-1.5'>
        <span className='text-[10px] text-slate-400 shrink-0 w-6'>sum</span>
        <Popover open={sumOpen} onOpenChange={setSumOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              disabled={!grandCollection}
              className='flex-1 h-6 rounded border border-slate-200 bg-white px-2 text-[10px] text-left truncate hover:border-slate-400 min-w-0 disabled:opacity-50 disabled:hover:border-slate-200'
            >
              {entry.sumField ? (
                (sumFieldOptions.find((f) => f.field === entry.sumField)?.label ?? entry.sumField)
              ) : (
                <span className='text-slate-400'>
                  {grandCollection ? 'none' : 'select relation first'}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className='w-48 p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
              <CommandList>
                <CommandGroup>
                  <CommandItem
                    value='__none__'
                    onSelect={() => {
                      onChange({ ...entry, sumField: '' })
                      setSumOpen(false)
                    }}
                    className='text-[12px] text-slate-500'
                  >
                    — None
                  </CommandItem>
                  {sumFieldOptions.map((f) => (
                    <CommandItem
                      key={f.field}
                      value={f.field}
                      onSelect={() => {
                        onChange({ ...entry, sumField: f.field })
                        setSumOpen(false)
                      }}
                      className='text-[12px]'
                    >
                      {f.label || f.field}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <span className='text-[10px] text-slate-400 shrink-0 w-6'>cap</span>
        <Popover open={capOpen} onOpenChange={setCapOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='flex-1 h-6 rounded border border-slate-200 bg-white px-2 text-[10px] text-left truncate hover:border-slate-400 min-w-0'
            >
              {entry.capField ? (
                (capFieldOptions.find((f) => f.field === entry.capField)?.label ?? entry.capField)
              ) : (
                <span className='text-slate-400'>none</span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className='w-48 p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
              <CommandList>
                <CommandGroup>
                  <CommandItem
                    value='__none__'
                    onSelect={() => {
                      onChange({ ...entry, capField: '' })
                      setCapOpen(false)
                    }}
                    className='text-[12px] text-slate-500'
                  >
                    — None
                  </CommandItem>
                  {capFieldOptions.map((f) => (
                    <CommandItem
                      key={f.field}
                      value={f.field}
                      onSelect={() => {
                        onChange({ ...entry, capField: f.field })
                        setCapOpen(false)
                      }}
                      className='text-[12px]'
                    >
                      {f.label || f.field}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

function RoleConditionRow({
  roleIds,
  onRoleIdsChange
}: {
  roleIds: string[]
  onRoleIdsChange: (ids: string[]) => void
}) {
  const { data: rolesData } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['roles-list-for-lock'],
    queryFn: () => api.get('/roles').then((r) => r.data.data),
    staleTime: 60_000
  })
  const roles = rolesData ?? []
  return (
    <div className='rounded border border-slate-100 bg-slate-50 px-2 py-1.5 space-y-1'>
      {roles.length === 0 && <p className='text-[10px] text-slate-400'>No roles found.</p>}
      {roles.map((r) => (
        <label
          key={r.id}
          className='flex items-center gap-1.5 text-[10px] cursor-pointer select-none'
        >
          <input
            type='checkbox'
            checked={roleIds.includes(r.id)}
            onChange={(e) => {
              if (e.target.checked) onRoleIdsChange([...roleIds, r.id])
              else onRoleIdsChange(roleIds.filter((id) => id !== r.id))
            }}
            className='rounded'
          />
          <span className='text-slate-700'>{r.name}</span>
        </label>
      ))}
    </div>
  )
}

function PipelineStateConditionRow({
  collection,
  pipelineId,
  stateKeys,
  onPipelineChange,
  onStateKeysChange
}: {
  collection?: string
  pipelineId?: string
  stateKeys: string[]
  onPipelineChange: (id: string | undefined) => void
  onStateKeysChange: (keys: string[]) => void
}) {
  const { data: pipelinesData } = useQuery<
    Array<{ id: string; name: string; collections: string[] }>
  >({
    queryKey: ['pipelines-list-for-lock'],
    queryFn: () => api.get('/pipelines').then((r) => r.data.data),
    staleTime: 60_000
  })
  const bound = (pipelinesData ?? []).filter(
    (p) => !collection || p.collections.includes(collection)
  )

  const { data: pipelineDetail } = useQuery<{
    states: Array<{ id: string; key: string; label: string; color?: string }>
  }>({
    queryKey: ['pipeline-detail-lock', pipelineId],
    queryFn: () => api.get(`/pipelines/${pipelineId}`).then((r) => r.data.data),
    staleTime: 60_000,
    enabled: !!pipelineId
  })
  const states = pipelineDetail?.states ?? []

  return (
    <div className='space-y-1.5'>
      <select
        value={pipelineId ?? ''}
        onChange={(e) => onPipelineChange(e.target.value || undefined)}
        className='w-full rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px]'
      >
        <option value=''>— Select pipeline —</option>
        {bound.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {bound.length === 0 && (
        <p className='text-[10px] text-slate-400'>No pipelines bound to this collection.</p>
      )}
      {pipelineId && states.length > 0 && (
        <div className='rounded border border-slate-100 bg-slate-50 px-2 py-1.5 space-y-1'>
          {states.map((s) => (
            <label
              key={s.key}
              className='flex items-center gap-1.5 text-[10px] cursor-pointer select-none'
            >
              <input
                type='checkbox'
                checked={stateKeys.includes(s.key)}
                onChange={(e) => {
                  if (e.target.checked) onStateKeysChange([...stateKeys, s.key])
                  else onStateKeysChange(stateKeys.filter((k) => k !== s.key))
                }}
                className='rounded'
              />
              <span className='text-slate-700'>{s.label}</span>
            </label>
          ))}
        </div>
      )}
      {pipelineId && states.length === 0 && (
        <p className='text-[10px] text-slate-400'>No states defined for this pipeline.</p>
      )}
    </div>
  )
}

function FieldSettingsPopover({
  fieldName,
  abstractType,
  isM2O,
  isM2M,
  settings,
  m2oFields,
  dependencyConfig,
  relatedCollection,
  onSave,
  showRowRevisions,
  onRowRevisionsChange,
  allowRevisionRestore = true,
  onAllowRevisionRestoreChange,
  lockConditions = [],
  onLockConditionsChange,
  inlineDisplayConfig,
  onInlineDisplayChange,
  collection,
  prefillFromParent,
  onPrefillFromParentChange
}: {
  fieldName: string
  abstractType?: string
  isM2O?: boolean
  isM2M?: boolean
  settings: FieldSettings
  m2oFields?: CascadeParentField[]
  dependencyConfig?: Record<string, unknown> | null
  relatedCollection?: string | null
  onSave: (patch: Partial<FieldSettings> & { dependency_config?: string }) => void
  showRowRevisions?: boolean
  onRowRevisionsChange?: (v: boolean) => void
  allowRevisionRestore?: boolean
  onAllowRevisionRestoreChange?: (v: boolean) => void
  lockConditions?: Array<{
    type: string
    state_keys?: string[]
    role_ids?: string[]
    pipeline_id?: string
  }>
  onLockConditionsChange?: (
    v: Array<{ type: string; state_keys?: string[]; role_ids?: string[]; pipeline_id?: string }>
  ) => void
  inlineDisplayConfig?: InlineDisplayConfig
  onInlineDisplayChange?: (config: InlineDisplayConfig) => void
  collection?: string
  prefillFromParent?: boolean
  onPrefillFromParentChange?: (v: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [rowRulePortalContainer, setRowRulePortalContainer] = useState<HTMLDivElement | null>(null)
  const [parentCtxOpen, setParentCtxOpen] = useState(false)
  const [localInlineEntries, setLocalInlineEntries] = useState<InlineDisplayEntry[]>([])
  const [localInlineSeparator, setLocalInlineSeparator] = useState<string | null>(null)
  const [label, setLabel] = useState(settings.label ?? '')
  const [iface, setIface] = useState(settings.interface ?? '')
  const [note, setNote] = useState(settings.note ?? '')
  const [placeholder, setPlaceholder] = useState(settings.placeholder ?? '')
  const [required, setRequired] = useState(settings.required)
  const [hidden, setHidden] = useState(settings.hidden)
  const [readonly, setReadonly] = useState(settings.readonly)
  // Drill-down config (M2O / M2M / relation-path): overrides.drilldown
  const ddQualifies = isM2O || isM2M || (settings.interface ?? '') === 'relation-path'
  const [ddEnabled, setDdEnabled] = useState(
    settings.drilldown?.enabled ?? (settings.interface ?? '') === 'relation-path'
  )
  const [ddLayoutId, setDdLayoutId] = useState<number | null>(settings.drilldown?.layout_id ?? null)
  const [ddWidth, setDdWidth] = useState<string>(
    settings.drilldown?.width != null ? String(settings.drilldown.width) : ''
  )
  const ddTargetCollection = useMemo(() => {
    if (relatedCollection) return relatedCollection
    try {
      const opts = settings.options ? (JSON.parse(settings.options) as Record<string, unknown>) : {}
      return (opts.path_target_collection as string | undefined) ?? null
    } catch {
      return null
    }
  }, [relatedCollection, settings.options])
  const { data: ddDetailLayouts = [] } = useQuery<
    Array<{ id: number; name: string; layout_type?: string }>
  >({
    queryKey: ['detail-layouts', ddTargetCollection],
    enabled: !!ddTargetCollection && ddQualifies,
    queryFn: () =>
      api
        .get(`/collection-layouts?collection=${ddTargetCollection}`)
        .then((r) =>
          ((r.data.data ?? []) as Array<{ id: number; name: string; layout_type?: string }>).filter(
            (l) => l.layout_type === 'detail'
          )
        )
  })
  const [inlineRelation, setInlineRelation] = useState(settings.inline_relation)
  const [maxValues, setMaxValues] = useState<string>(
    settings.max_values != null ? String(settings.max_values) : ''
  )
  const [cascadeRules, setCascadeRules] = useState<CascadeFilterRule[]>([])
  const [gridLayoutSlug, setGridLayoutSlug] = useState<string | null>(null)
  const [gridLayoutId, setGridLayoutId] = useState<number | null>(null)
  const [gridShowTotals, setGridShowTotals] = useState(false)
  const [allowUpload, setAllowUpload] = useState(true)
  const [allowPick, setAllowPick] = useState(true)
  const [filePendingSave, setFilePendingSave] = useState(false)
  const [numFormat, setNumFormat] = useState<'int' | 'decimal' | 'currency' | ''>('')
  const [numPrecisionFmt, setNumPrecisionFmt] = useState('2')
  const [numCurrency, setNumCurrency] = useState('USD')
  const [numAggregate, setNumAggregate] = useState<'sum' | 'count' | 'avg' | 'min' | 'max' | ''>('')
  const [saveMode, setSaveMode] = useState<'immediate' | 'pending'>('immediate')
  const [showLineNumbers, setShowLineNumbers] = useState(false)
  const [enableReorder, setEnableReorder] = useState(true)
  const [parentCascades, setParentCascades] = useState<
    Array<{ parent_field: string; child_field: string }>
  >([])
  const [rowRulesLocal, setRowRulesLocal] = useState<RowRuleItem[]>([])
  const [parentContextFieldsLocal, setParentContextFieldsLocal] = useState<string[]>([])
  const [columnPresetsLocal, setColumnPresetsLocal] = useState<ColumnPresetItem[]>([])
  const [drawerRelationsLocal, setDrawerRelationsLocal] = useState<DrawerRelationItem[]>([])
  const [uniqueBy, setUniqueBy] = useState<string[]>([])
  const [uniqueByOpen, setUniqueByOpen] = useState(false)
  const [sortField, setSortField] = useState<string>('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [sortFieldOpen, setSortFieldOpen] = useState(false)
  const [groupedGroupField, setGroupedGroupField] = useState('')
  const [groupedOptionField, setGroupedOptionField] = useState('')
  const [groupedGroupFieldOpen, setGroupedGroupFieldOpen] = useState(false)
  const [groupedOptionFieldOpen, setGroupedOptionFieldOpen] = useState(false)

  const isNumericAbstractType = [
    'integer',
    'bigInteger',
    'decimal',
    'float',
    'money',
    'smallmoney',
    'tinyint',
    'smallint',
    'bigint'
  ].includes(abstractType ?? '')

  // Child M2O fields for cascade config — fetched from related collection's relations
  const { data: childCollectionMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    enabled: !!relatedCollection,
    staleTime: 10 * 60 * 1000
  })

  type RelRow = {
    many_collection?: string
    many_field?: string
    one_collection?: string
    one_field?: string
    junction_field?: string | null
  }
  const isInlineTable = iface === 'inline-table' || settings.interface === 'inline-table'
  // Grouped combobox pickers (Group by / Option field) list the target
  // collection's M2O fields — the relations fetch must run for that interface
  // too, not just inline tables, or the pickers render empty.
  const isRelationGrouped =
    iface === 'relation-grouped' || settings.interface === 'relation-grouped'
  const { data: childRelationsRaw = [] } = useQuery<RelRow[]>({
    queryKey: ['relations-for', relatedCollection],
    queryFn: () =>
      api
        .get<{ data: RelRow[] }>(`/data-model/relations/for/${relatedCollection}`)
        .then((r) => r.data.data ?? []),
    enabled: !!relatedCollection && (isInlineTable || isRelationGrouped),
    staleTime: 5 * 60 * 1000
  })

  const childM2OFields = useMemo(
    () =>
      childRelationsRaw
        .filter((r) => r.many_collection === relatedCollection && r.many_field && !r.junction_field)
        .map((r) => ({ value: r.many_field!, label: `${r.many_field} → ${r.one_collection}` })),
    [childRelationsRaw, relatedCollection]
  )

  const childM2ORels = useMemo(
    () =>
      childRelationsRaw
        .filter(
          (r) =>
            r.many_collection === relatedCollection &&
            r.many_field &&
            r.one_collection &&
            !r.junction_field
        )
        .map((r) => ({ many_field: r.many_field!, one_collection: r.one_collection! })),
    [childRelationsRaw, relatedCollection]
  )

  const childO2MRels = useMemo(
    () =>
      childRelationsRaw
        .filter(
          (r) => r.one_collection === relatedCollection && r.many_collection && !r.junction_field
        )
        .map((r) => ({
          one_field: !r.one_field || r.one_field === 'id' ? r.many_collection! : r.one_field!,
          many_collection: r.many_collection!
        })),
    [childRelationsRaw, relatedCollection]
  )

  // drawer_relations picker — O2M aliases defined on the child collection,
  // resolved the same way ImportTemplatesSection's lineTargetOptions does.
  const drawerRelationOptions = useMemo(
    () =>
      childO2MRels.map((r) => ({
        value: r.one_field,
        label: `${r.one_field} → ${r.many_collection}`,
        collection: r.many_collection
      })),
    [childO2MRels]
  )

  const parentM2OFields = useMemo(
    () =>
      (m2oFields ?? [])
        .filter((f) => f.kind === 'M2O')
        .map((f) => ({ value: f.field, label: f.label })),
    [m2oFields]
  )

  const { data: childAllFields = [] } = useQuery<
    Array<{
      field: string
      label?: string | null
      type?: string
      interface?: string | null
      hidden?: boolean
    }>
  >({
    queryKey: ['field-config-all', relatedCollection],
    queryFn: () => api.get(`/field-config/${relatedCollection}`).then((r) => r.data.data ?? []),
    enabled: !!relatedCollection && isInlineTable,
    staleTime: 5 * 60 * 1000
  })

  const { data: parentAllFields = [] } = useQuery<
    Array<{ field: string; label?: string | null; type?: string; interface?: string | null }>
  >({
    queryKey: ['field-config-all', collection],
    queryFn: () => api.get(`/field-config/${collection}`).then((r) => r.data.data ?? []),
    enabled: !!collection && iface === 'inline-table',
    staleTime: 5 * 60 * 1000
  })

  const { data: parentRelationsRaw = [] } = useQuery<RelRow[]>({
    queryKey: ['relations-for', collection],
    queryFn: () =>
      api
        .get<{ data: RelRow[] }>(`/data-model/relations/for/${collection}`)
        .then((r) => r.data.data ?? []),
    enabled: !!collection && isInlineTable,
    staleTime: 5 * 60 * 1000
  })

  // field → one_collection for parent M2O/M2M fields
  const parentFieldRelatedCollectionMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const r of parentRelationsRaw) {
      if (
        r.many_collection === collection &&
        r.many_field &&
        r.one_collection &&
        !r.junction_field
      ) {
        map[r.many_field] = r.one_collection
      }
      // M2M: junction row gives us the far-end via two rows; find the row where junction_field is set
      // and the companion row pointing to the far-end collection
    }
    // Also handle M2M: junction rows
    for (const r of parentRelationsRaw) {
      if (r.one_collection === collection && r.junction_field && r.many_collection) {
        const companion = parentRelationsRaw.find(
          (c) =>
            c.many_collection === r.many_collection &&
            c.many_field === r.junction_field &&
            c.one_collection !== collection
        )
        if (companion?.one_collection) {
          if (r.one_field) map[r.one_field] = companion.one_collection
        }
      }
    }
    return map
  }, [parentRelationsRaw, collection])

  const SKIP_TYPES = new Set(['alias', 'o2m', 'm2m', 'm2a', 'presentation', 'group', 'divider'])
  const uniqueByOptions = useMemo(
    () =>
      childAllFields.filter((f) => !f.hidden && f.field !== 'id' && !SKIP_TYPES.has(f.type ?? '')),
    [childAllFields]
  )

  // drawer_relations hint pickers — numeric fields on the child collection.
  const childNumericFieldOptions = useMemo(
    () => uniqueByOptions.filter((f) => NUMERIC_FIELD_TYPES.has(f.type ?? '')),
    [uniqueByOptions]
  )

  // ── Column presets picker: layout-sourced options + relation summary tokens ──
  // The FK column on the child collection pointing back at THIS O2M's parent —
  // excluded from the picker the same way InlineTableField's displayCols excludes manyField.
  const childToParentField = useMemo(() => {
    const rel = childRelationsRaw.find(
      (r) =>
        r.many_collection === relatedCollection &&
        r.one_collection === collection &&
        !r.junction_field &&
        (r.one_field === fieldName ||
          ((!r.one_field || r.one_field === 'id') && r.many_collection === fieldName))
    )
    return rel?.many_field ?? null
  }, [childRelationsRaw, relatedCollection, collection, fieldName])

  // Picker source = the selected Layout's display columns — replicates
  // InlineTableField's displayCols predicate so a picked column is guaranteed to render.
  const { data: presetLayoutFields = [] } = useQuery<
    Array<{
      field: string
      label?: string | null
      type?: string
      interface?: string | null
      hidden?: boolean
      group_key?: string | null
      layout_assigned?: boolean
    }>
  >({
    queryKey: ['field-config', relatedCollection, gridLayoutId],
    queryFn: () =>
      api
        .get(`/field-config/${relatedCollection}`, {
          params: gridLayoutId ? { layout_id: gridLayoutId } : {}
        })
        .then((r) => r.data.data ?? []),
    enabled: !!relatedCollection && isInlineTable,
    staleTime: 60 * 1000
  })

  const presetPickerFieldOptions = useMemo<PresetFieldOption[]>(
    () =>
      presetLayoutFields
        .filter(
          (f) =>
            !f.hidden &&
            (!PRESET_NON_DISPLAY_TYPES.has(f.type ?? '') || isM2MIfacePreset(f.interface)) &&
            f.field !== childToParentField &&
            f.field !== 'id' &&
            (!gridLayoutId || f.layout_assigned === true) &&
            !PRESET_SENTINEL_FIELDS.has(f.field) &&
            !PRESET_SPECIAL_GROUP_KEYS.has(f.group_key ?? '')
        )
        .map((f) => ({ field: f.field, label: f.label || titleCase(f.field) })),
    [presetLayoutFields, childToParentField, gridLayoutId]
  )

  // Relation summary options: one group per configured drawer relation, offering
  // that relation's grandchild plain fields as "relationField.memberField" dot tokens.
  const drawerRelationGrandCollections = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of drawerRelationsLocal) {
      const gc = drawerRelationOptions.find((r) => r.value === entry.field)?.collection
      if (gc) map.set(entry.field, gc)
    }
    return map
  }, [drawerRelationsLocal, drawerRelationOptions])

  const distinctSummaryGrandCollections = useMemo(
    () => [...new Set(drawerRelationGrandCollections.values())],
    [drawerRelationGrandCollections]
  )

  const summaryGrandFieldsQueries = useQueries({
    queries: distinctSummaryGrandCollections.map((gc) => ({
      queryKey: ['field-config-all', gc],
      queryFn: () => api.get(`/field-config/${gc}`).then((r) => r.data.data ?? []),
      enabled: !!gc,
      staleTime: 5 * 60 * 1000
    }))
  })
  const summaryGrandFieldsByCollection = useMemo(() => {
    const map = new Map<
      string,
      Array<{
        field: string
        label?: string | null
        type?: string
        hidden?: boolean
        group_key?: string | null
      }>
    >()
    distinctSummaryGrandCollections.forEach((gc, i) => {
      map.set(gc, summaryGrandFieldsQueries[i]?.data ?? [])
    })
    return map
  }, [distinctSummaryGrandCollections, summaryGrandFieldsQueries])

  const presetSummaryOptionGroups = useMemo<PresetOptionGroup[]>(() => {
    const groups: PresetOptionGroup[] = []
    for (const entry of drawerRelationsLocal) {
      const grandCollection = drawerRelationGrandCollections.get(entry.field)
      if (!grandCollection) continue
      const fkField = childRelationsRaw.find(
        (r) =>
          r.one_collection === relatedCollection &&
          r.many_collection === grandCollection &&
          !r.junction_field &&
          (r.one_field === entry.field ||
            ((!r.one_field || r.one_field === 'id') && r.many_collection === entry.field))
      )?.many_field
      const grandFields = summaryGrandFieldsByCollection.get(grandCollection) ?? []
      const options = grandFields
        .filter(
          (f) =>
            !f.hidden &&
            !PRESET_NON_DISPLAY_TYPES.has(f.type ?? '') &&
            f.field !== fkField &&
            f.field !== 'id' &&
            !PRESET_SENTINEL_FIELDS.has(f.field) &&
            !PRESET_SPECIAL_GROUP_KEYS.has(f.group_key ?? '')
        )
        .map((f) => ({
          field: `${entry.field}.${f.field}`,
          label: `${entry.field} → ${f.label || titleCase(f.field)}`
        }))
      if (options.length > 0) groups.push({ heading: entry.field, options })
    }
    return groups
  }, [
    drawerRelationsLocal,
    drawerRelationGrandCollections,
    childRelationsRaw,
    relatedCollection,
    summaryGrandFieldsByCollection
  ])

  const presetOptionGroups = useMemo<PresetOptionGroup[]>(
    () => [{ options: presetPickerFieldOptions }, ...presetSummaryOptionGroups],
    [presetPickerFieldOptions, presetSummaryOptionGroups]
  )

  // Reset local state when popover opens
  function handleOpenChange(next: boolean) {
    if (next) {
      setLocalInlineEntries(inlineDisplayConfig?.entries ?? [])
      setLocalInlineSeparator(inlineDisplayConfig?.separator ?? null)
      setLabel(settings.label ?? '')
      setIface(settings.interface ?? '')
      setNote(settings.note ?? '')
      setPlaceholder(settings.placeholder ?? '')
      setRequired(settings.required)
      setHidden(settings.hidden)
      setReadonly(settings.readonly)
      setInlineRelation(settings.inline_relation)
      setMaxValues(settings.max_values != null ? String(settings.max_values) : '')
      // dependencyConfig is already a parsed object from the API — use directly
      const dep = dependencyConfig && typeof dependencyConfig === 'object' ? dependencyConfig : {}
      setCascadeRules(
        Array.isArray(dep.cascade_filters) ? (dep.cascade_filters as CascadeFilterRule[]) : []
      )
      // Parse inline-grid / inline-table options from settings.options
      try {
        const opts = settings.options
          ? ((typeof settings.options === 'string'
              ? JSON.parse(settings.options)
              : settings.options) as Record<string, unknown>)
          : {}
        setGridLayoutSlug((opts.layout_slug as string | null) ?? null)
        setGridLayoutId((opts.layout_id as number | null) ?? null)
        setGridShowTotals(!!opts.grid_show_totals)
        setAllowUpload(opts.allow_upload !== false)
        setAllowPick(opts.allow_pick !== false)
        setFilePendingSave(!!opts.pending_save)
        setNumFormat((opts.format as 'int' | 'decimal' | 'currency' | '') ?? '')
        setNumPrecisionFmt(opts.precision != null ? String(opts.precision) : '2')
        setNumCurrency((opts.currency as string) ?? 'USD')
        setNumAggregate((opts.aggregate as 'sum' | 'count' | 'avg' | 'min' | 'max' | '') ?? '')
        setSaveMode((opts.save_mode as 'immediate' | 'pending') ?? 'immediate')
        setShowLineNumbers(!!opts.show_line_numbers)
        setEnableReorder(opts.enable_reorder !== false)
        setParentCascades(
          Array.isArray(opts.parent_cascades)
            ? (opts.parent_cascades as Array<{ parent_field: string; child_field: string }>)
            : []
        )
        setRowRulesLocal(
          Array.isArray(opts.row_rules) ? (opts.row_rules as typeof rowRulesLocal) : []
        )
        setParentContextFieldsLocal(
          Array.isArray(opts.parent_context_fields) ? (opts.parent_context_fields as string[]) : []
        )
        setColumnPresetsLocal(
          Array.isArray(opts.column_presets)
            ? (opts.column_presets as Array<{ name?: string; columns?: string[] }>).map((p) => ({
                name: p.name ?? '',
                columns: Array.isArray(p.columns) ? p.columns : [],
                _key: crypto.randomUUID()
              }))
            : []
        )
        setDrawerRelationsLocal(
          Array.isArray(opts.drawer_relations)
            ? (
                opts.drawer_relations as Array<
                  string | { field: string; hint?: { sum_field: string; cap_field: string } }
                >
              ).map((dr) =>
                typeof dr === 'string'
                  ? { field: dr, sumField: '', capField: '', _key: crypto.randomUUID() }
                  : {
                      field: dr.field,
                      sumField: dr.hint?.sum_field ?? '',
                      capField: dr.hint?.cap_field ?? '',
                      _key: crypto.randomUUID()
                    }
              )
            : []
        )
        setUniqueBy(Array.isArray(opts.unique_by) ? (opts.unique_by as string[]) : [])
        setSortField((opts.sort_field as string) ?? '')
        setSortDir((opts.sort_dir as 'asc' | 'desc') === 'desc' ? 'desc' : 'asc')
        setGroupedGroupField((opts.group_field as string) ?? '')
        setGroupedOptionField((opts.option_field as string) ?? '')
      } catch {
        setGridLayoutSlug(null)
        setGridLayoutId(null)
        setGridShowTotals(false)
        setAllowUpload(true)
        setAllowPick(true)
        setFilePendingSave(false)
        setNumFormat('')
        setNumPrecisionFmt('2')
        setNumCurrency('USD')
        setNumAggregate('')
        setSaveMode('immediate')
        setShowLineNumbers(false)
        setEnableReorder(true)
        setParentCascades([])
        setRowRulesLocal([])
        setParentContextFieldsLocal([])
        setColumnPresetsLocal([])
        setDrawerRelationsLocal([])
        setUniqueBy([])
        setSortField('')
        setSortDir('asc')
        setGroupedGroupField('')
        setGroupedOptionField('')
      }
    }
    setOpen(next)
  }

  function save() {
    const maxV = maxValues.trim() ? parseInt(maxValues, 10) : null
    // Merge cascade_filters into dependency_config object and send to API (API will JSON.stringify it)
    let depPatch: Record<string, unknown> | null = null
    if (isM2O || isM2M) {
      const existing =
        dependencyConfig && typeof dependencyConfig === 'object' ? dependencyConfig : {}
      const merged: Record<string, unknown> = { ...existing }
      if (cascadeRules.length > 0) {
        merged.cascade_filters = cascadeRules
      } else {
        delete merged.cascade_filters
      }
      depPatch = Object.keys(merged).length > 0 ? merged : null
    }
    // Inline-grid / inline-table options for O2M
    let optionsPatch: string | null = null
    const needsOptionsPatch =
      (abstractType === 'o2m' && (iface === 'inline-grid' || iface === 'inline-table')) ||
      isNumericAbstractType ||
      iface === 'file-image' ||
      iface === 'files-m2m' ||
      iface === 'relation-grouped'
    if (needsOptionsPatch) {
      try {
        const existing = settings.options
          ? ((typeof settings.options === 'string'
              ? JSON.parse(settings.options)
              : settings.options) as Record<string, unknown>)
          : {}
        const formatOpts: Record<string, unknown> = {}
        if (isNumericAbstractType && numFormat) {
          formatOpts.format = numFormat
          if (numFormat === 'decimal') formatOpts.precision = parseInt(numPrecisionFmt, 10) || 2
          if (numFormat === 'currency') formatOpts.currency = numCurrency || 'USD'
        } else if (isNumericAbstractType) {
          delete existing.format
          delete existing.precision
          delete existing.currency
        }
        if (isNumericAbstractType && numAggregate) {
          formatOpts.aggregate = numAggregate
        } else if (isNumericAbstractType) {
          delete existing.aggregate
        }
        const validColumnPresets = columnPresetsLocal
          .filter((p) => p.name.trim() && p.columns.length > 0)
          .map((p) => ({ name: p.name.trim(), columns: p.columns }))
        const validDrawerRelations = drawerRelationsLocal
          .filter((d) => d.field)
          .map((d) =>
            d.sumField && d.capField
              ? { field: d.field, hint: { sum_field: d.sumField, cap_field: d.capField } }
              : d.field
          )
        const o2mOpts =
          abstractType === 'o2m' && (iface === 'inline-grid' || iface === 'inline-table')
            ? {
                layout_slug: gridLayoutSlug,
                layout_id: gridLayoutId,
                ...(iface === 'inline-grid'
                  ? { grid_show_totals: gridShowTotals }
                  : {
                      save_mode: saveMode,
                      show_line_numbers: showLineNumbers,
                      enable_reorder: enableReorder,
                      ...(parentCascades.length > 0 ? { parent_cascades: parentCascades } : {}),
                      ...(rowRulesLocal.length > 0
                        ? { row_rules: rowRulesLocal }
                        : { row_rules: undefined }),
                      ...(parentContextFieldsLocal.length > 0
                        ? { parent_context_fields: parentContextFieldsLocal }
                        : { parent_context_fields: undefined }),
                      ...(validColumnPresets.length > 0
                        ? { column_presets: validColumnPresets }
                        : { column_presets: undefined }),
                      ...(validDrawerRelations.length > 0
                        ? { drawer_relations: validDrawerRelations }
                        : { drawer_relations: undefined }),
                      ...(uniqueBy.length > 0 ? { unique_by: uniqueBy } : { unique_by: undefined }),
                      ...(sortField
                        ? { sort_field: sortField, sort_dir: sortDir }
                        : { sort_field: undefined, sort_dir: undefined })
                    })
              }
            : {}
        const fileOpts =
          iface === 'file-image' || iface === 'files-m2m'
            ? {
                allow_upload: allowUpload,
                allow_pick: allowPick,
                ...(iface === 'files-m2m' ? { pending_save: filePendingSave } : {})
              }
            : {}
        const groupedOpts =
          iface === 'relation-grouped'
            ? {
                group_field: groupedGroupField || undefined,
                option_field: groupedOptionField || undefined
              }
            : {}
        optionsPatch = JSON.stringify({
          ...existing,
          ...o2mOpts,
          ...fileOpts,
          ...formatOpts,
          ...groupedOpts
        })
      } catch {
        optionsPatch = JSON.stringify({
          ...(isNumericAbstractType && numFormat
            ? {
                format: numFormat,
                ...(numFormat === 'decimal'
                  ? { precision: parseInt(numPrecisionFmt, 10) || 2 }
                  : {}),
                ...(numFormat === 'currency' ? { currency: numCurrency } : {})
              }
            : {})
        })
      }
    }
    const normalizedDdWidth = (() => {
      const t = ddWidth.trim().toLowerCase()
      if (!t) return null
      const pct = t.match(/^(\d{1,3})\s*%$/)
      if (pct) return `${Math.min(96, Math.max(10, Number(pct[1])))}%`
      const px = t.match(/^(\d{2,4})\s*(px)?$/)
      if (px) return Math.min(2000, Math.max(320, Number(px[1])))
      return null
    })()
    const patch: Partial<FieldSettings> & {
      dependency_config?: Record<string, unknown> | null
      options?: string | null
    } = {
      label: label.trim() !== '' ? label.trim() : settings.label === '' ? '' : null,
      interface: iface || null,
      note: note.trim() || null,
      placeholder: placeholder.trim() || null,
      ...(ddQualifies
        ? {
            drilldown: ddEnabled
              ? { enabled: true, layout_id: ddLayoutId, width: normalizedDdWidth }
              : { enabled: false }
          }
        : {}),
      required,
      hidden,
      readonly,
      inline_relation: inlineRelation,
      max_values: maxV && maxV > 0 ? maxV : null
    }
    if (isM2O || isM2M) patch.dependency_config = depPatch
    if (optionsPatch !== null || needsOptionsPatch) patch.options = optionsPatch
    onSave(patch as Partial<FieldSettings> & { dependency_config?: string })
    onInlineDisplayChange?.({ entries: localInlineEntries, separator: localInlineSeparator })
    setOpen(false)
  }

  const interfaceOptions = abstractType
    ? getInterfaces(abstractType).map((i) => ({ value: i.value, label: i.label }))
    : []

  const hasOverrides =
    !!settings.label ||
    !!settings.interface ||
    !!settings.note ||
    settings.hidden ||
    settings.readonly ||
    settings.required

  const SectionHeader = ({ label }: { label: string }) => (
    <div className='flex items-center gap-2'>
      <span className='text-[11px] font-medium text-slate-500 shrink-0'>{label}</span>
      <div className='flex-1 h-px bg-slate-100' />
    </div>
  )

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <button
          type='button'
          title='Display settings'
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            'shrink-0 rounded p-0.5 transition-colors',
            hasOverrides
              ? 'text-nvr-cyan hover:text-nvr-cyan/80'
              : 'text-slate-300 opacity-0 group-hover:opacity-100 hover:text-slate-500'
          )}
        >
          <Settings2 className='h-3.5 w-3.5' />
        </button>
      </SheetTrigger>
      <SheetContent
        side='right'
        className='!w-[480px] flex flex-col p-0 gap-0'
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='shrink-0 border-b border-slate-100 px-3 py-2 pr-10'>
          <p className='text-[12px] font-medium text-slate-800'>Display settings</p>
          <p className='text-[11px] text-slate-400 font-mono'>{fieldName}</p>
        </div>
        <div className='flex-1 overflow-y-auto'>
          <div className='p-4 space-y-5'>
            {/* ── Display ── */}
            <div className='space-y-3'>
              <SectionHeader label='Display' />
              <div className='space-y-1'>
                <Label className='text-[11px] text-slate-600'>Label</Label>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={titleCase(fieldName)}
                  className='h-7 text-[12px]'
                />
              </div>
              {interfaceOptions.length > 0 && (
                <div className='space-y-1'>
                  <Label className='text-[11px] text-slate-600'>Interface</Label>
                  <Combobox
                    value={iface}
                    onChange={setIface}
                    options={[{ value: '', label: 'Default' }, ...interfaceOptions]}
                    placeholder='Default'
                  />
                </div>
              )}
              <div className='space-y-1'>
                <Label className='text-[11px] text-slate-600'>Placeholder</Label>
                <Input
                  value={placeholder}
                  onChange={(e) => setPlaceholder(e.target.value)}
                  placeholder='e.g. Enter a value…'
                  className='h-7 text-[12px]'
                />
              </div>
              <div className='space-y-1'>
                <Label className='text-[11px] text-slate-600'>Helper text</Label>
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder='Description shown below the field'
                  className='min-h-[52px] resize-none text-[12px]'
                />
              </div>
            </div>

            {/* ── Behavior ── */}
            <div className='space-y-3'>
              <SectionHeader label='Behavior' />
              <div className='divide-y divide-slate-100 rounded-md border border-slate-200'>
                {(
                  [
                    { key: 'required', label: 'Required', value: required, set: setRequired },
                    { key: 'hidden', label: 'Hidden', value: hidden, set: setHidden },
                    { key: 'readonly', label: 'Read-only', value: readonly, set: setReadonly }
                  ] as const
                ).map((row) => (
                  <div key={row.key} className='flex items-center justify-between px-3 py-2'>
                    <span className='text-[12px] text-slate-700'>{row.label}</span>
                    <Switch checked={row.value} onCheckedChange={row.set} className='scale-90' />
                  </div>
                ))}
                {(isM2O || isM2M) && (
                  <div className='flex items-center justify-between px-3 py-2'>
                    <span className='text-[12px] text-slate-700'>Inline edit</span>
                    <Switch
                      checked={inlineRelation}
                      onCheckedChange={setInlineRelation}
                      className='scale-90'
                    />
                  </div>
                )}
              </div>
              {isM2M && (
                <div className='space-y-1'>
                  <Label className='text-[11px] text-slate-600'>Max values</Label>
                  <Input
                    type='number'
                    min={1}
                    value={maxValues}
                    onChange={(e) => setMaxValues(e.target.value)}
                    placeholder='Unlimited'
                    className='h-7 text-[12px]'
                  />
                  <p className='text-[10px] text-slate-400'>
                    Leave blank for unlimited. Set to 1 for single-select.
                  </p>
                </div>
              )}
            </div>

            {/* ── Numeric format ── */}
            {isNumericAbstractType && (
              <div className='space-y-3'>
                <SectionHeader label='Format' />
                <div className='flex gap-1.5'>
                  {(
                    [
                      { val: '' as const, label: 'Default' },
                      { val: 'int' as const, label: 'Integer' },
                      { val: 'decimal' as const, label: 'Decimal' },
                      { val: 'currency' as const, label: 'Currency' }
                    ] as { val: '' | 'int' | 'decimal' | 'currency'; label: string }[]
                  ).map((opt) => (
                    <button
                      key={opt.val}
                      type='button'
                      onClick={() => setNumFormat(opt.val)}
                      className={cn(
                        'px-2 py-0.5 rounded text-[11px] border transition-colors',
                        numFormat === opt.val
                          ? 'bg-nvr-cyan text-white border-nvr-cyan'
                          : 'border-slate-200 text-slate-600 hover:border-slate-400'
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {numFormat === 'decimal' && (
                  <div className='space-y-1'>
                    <Label className='text-[11px] text-slate-500'>Decimal places</Label>
                    <Input
                      type='number'
                      min={0}
                      max={10}
                      value={numPrecisionFmt}
                      onChange={(e) => setNumPrecisionFmt(e.target.value)}
                      className='h-7 text-[12px] w-24'
                    />
                  </div>
                )}
                {numFormat === 'currency' && (
                  <div className='space-y-1'>
                    <Label className='text-[11px] text-slate-500'>Currency code</Label>
                    <Input
                      value={numCurrency}
                      onChange={(e) => setNumCurrency(e.target.value.toUpperCase())}
                      placeholder='USD'
                      className='h-7 text-[12px] w-24'
                    />
                  </div>
                )}
                <div className='space-y-1'>
                  <Label className='text-[11px] text-slate-600'>Footer aggregate</Label>
                  <div className='flex flex-wrap gap-1'>
                    {(
                      [
                        { val: '' as const, label: 'None' },
                        { val: 'sum' as const, label: 'SUM' },
                        { val: 'count' as const, label: 'COUNT' },
                        { val: 'avg' as const, label: 'AVG' },
                        { val: 'min' as const, label: 'MIN' },
                        { val: 'max' as const, label: 'MAX' }
                      ] as { val: '' | 'sum' | 'count' | 'avg' | 'min' | 'max'; label: string }[]
                    ).map((opt) => (
                      <button
                        key={opt.val}
                        type='button'
                        onClick={() => setNumAggregate(opt.val)}
                        className={cn(
                          'px-2 py-0.5 rounded text-[11px] border transition-colors font-mono',
                          numAggregate === opt.val
                            ? 'bg-nvr-cyan text-white border-nvr-cyan'
                            : 'border-slate-200 text-slate-600 hover:border-slate-400'
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── File options ── */}
            {(iface === 'file-image' || iface === 'files-m2m') && (
              <div className='space-y-3'>
                <SectionHeader label='File options' />
                <div className='divide-y divide-slate-100 rounded-md border border-slate-200'>
                  {[
                    {
                      key: 'allowUpload',
                      label: 'Allow upload',
                      value: allowUpload,
                      set: setAllowUpload
                    },
                    {
                      key: 'allowPick',
                      label: 'Allow picking existing files',
                      value: allowPick,
                      set: setAllowPick
                    },
                    ...(iface === 'files-m2m'
                      ? [
                          {
                            key: 'pendingSave',
                            label: 'Save on form submit',
                            value: filePendingSave,
                            set: setFilePendingSave
                          }
                        ]
                      : [])
                  ].map((row) => (
                    <div key={row.key} className='flex items-center justify-between px-3 py-2'>
                      <span className='text-[12px] text-slate-700'>{row.label}</span>
                      <Switch checked={row.value} onCheckedChange={row.set} className='scale-90' />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Drill-down ── */}
            {ddQualifies && (
              <div className='space-y-2'>
                <SectionHeader label='Drill-down' />
                <label className='flex cursor-pointer items-center justify-between'>
                  <span className='text-[11px] text-slate-600'>Click value opens detail panel</span>
                  <input
                    type='checkbox'
                    checked={ddEnabled}
                    onChange={(e) => setDdEnabled(e.target.checked)}
                    className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                  />
                </label>
                {ddEnabled && (
                  <div className='grid grid-cols-2 gap-2'>
                    <div className='space-y-1'>
                      <Label className='text-[11px] text-slate-500'>Detail layout</Label>
                      <select
                        value={ddLayoutId ?? ''}
                        onChange={(e) =>
                          setDdLayoutId(e.target.value ? Number(e.target.value) : null)
                        }
                        className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-border dark:bg-background'
                      >
                        <option value=''>Default (active detail)</option>
                        {ddDetailLayouts.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className='space-y-1'>
                      <Label className='text-[11px] text-slate-500'>Panel width</Label>
                      <Input
                        value={ddWidth}
                        onChange={(e) => setDdWidth(e.target.value)}
                        placeholder='640, 900px or 75%'
                        className='h-[26px] text-[11px]'
                      />
                    </div>
                  </div>
                )}
                {ddEnabled && !ddTargetCollection && (
                  <p className='text-[10px] text-slate-400'>
                    Target collection unknown — save the layout once, then reopen.
                  </p>
                )}
              </div>
            )}

            {/* ── Grouped combobox ── */}
            {iface === 'relation-grouped' && (
              <div className='space-y-3'>
                <SectionHeader label='Grouped combobox' />
                <div className='space-y-2'>
                  <div className='space-y-1'>
                    <Label className='text-[11px] text-slate-600'>Group by field</Label>
                    <Popover open={groupedGroupFieldOpen} onOpenChange={setGroupedGroupFieldOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type='button'
                          className='flex h-8 w-full items-center justify-between rounded border border-slate-200 bg-white px-2 text-[12px] hover:bg-slate-50'
                        >
                          <span className={groupedGroupField ? '' : 'text-slate-400'}>
                            {(childM2OFields.find((f) => f.value === groupedGroupField)?.label ??
                              groupedGroupField) ||
                              'Select field…'}
                          </span>
                          <ChevronDown className='h-3.5 w-3.5 opacity-50' />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className='w-[260px] p-0' align='start'>
                        <Command>
                          <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
                          <CommandList>
                            {childM2OFields.map((f) => (
                              <CommandItem
                                key={f.value}
                                value={f.value}
                                onSelect={() => {
                                  setGroupedGroupField(f.value)
                                  setGroupedGroupFieldOpen(false)
                                }}
                                className='text-[12px]'
                              >
                                {f.label}
                              </CommandItem>
                            ))}
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div className='space-y-1'>
                    <Label className='text-[11px] text-slate-600'>Option field (leaf)</Label>
                    <Popover open={groupedOptionFieldOpen} onOpenChange={setGroupedOptionFieldOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type='button'
                          className='flex h-8 w-full items-center justify-between rounded border border-slate-200 bg-white px-2 text-[12px] hover:bg-slate-50'
                        >
                          <span className={groupedOptionField ? '' : 'text-slate-400'}>
                            {(childM2OFields.find((f) => f.value === groupedOptionField)?.label ??
                              groupedOptionField) ||
                              'Select field…'}
                          </span>
                          <ChevronDown className='h-3.5 w-3.5 opacity-50' />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className='w-[260px] p-0' align='start'>
                        <Command>
                          <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
                          <CommandList>
                            {childM2OFields.map((f) => (
                              <CommandItem
                                key={f.value}
                                value={f.value}
                                onSelect={() => {
                                  setGroupedOptionField(f.value)
                                  setGroupedOptionFieldOpen(false)
                                }}
                                className='text-[12px]'
                              >
                                {f.label}
                              </CommandItem>
                            ))}
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </div>
            )}

            {/* ── Cascade filters (M2O/M2M) ── */}
            {(isM2O || isM2M) && (
              <CascadeFiltersEditor
                rules={cascadeRules}
                m2oFields={(m2oFields ?? []).filter((f) => f.field !== fieldName)}
                relatedCollection={relatedCollection}
                onChange={setCascadeRules}
              />
            )}

            {/* ── Inline display (M2O) ── */}
            {isM2O && relatedCollection && (
              <div className='space-y-2'>
                <SectionHeader label='Display value' />
                <InlineDisplaySection
                  relatedCollection={relatedCollection}
                  entries={localInlineEntries}
                  separator={localInlineSeparator}
                  onChange={setLocalInlineEntries}
                  onSeparatorChange={setLocalInlineSeparator}
                />
              </div>
            )}

            {/* ── Table / Grid settings (O2M) ── */}
            {abstractType === 'o2m' && (iface === 'inline-grid' || iface === 'inline-table') && (
              <div className='space-y-4'>
                <SectionHeader
                  label={iface === 'inline-table' ? 'Table settings' : 'Grid settings'}
                />

                {/* Layout */}
                <div className='space-y-1.5'>
                  <Label className='text-[11px] text-slate-600'>Layout</Label>
                  <LayoutPicker
                    collection={relatedCollection}
                    value={gridLayoutId}
                    onChange={(id, slug) => {
                      setGridLayoutId(id)
                      setGridLayoutSlug(slug)
                    }}
                    layoutType={iface === 'inline-table' ? 'table' : 'grouped'}
                  />
                </div>

                {/* Options */}
                <div className='divide-y divide-slate-100 rounded-md border border-slate-200'>
                  {iface === 'inline-grid' && (
                    <div className='flex items-center justify-between px-3 py-2'>
                      <span className='text-[12px] text-slate-700'>Show column totals</span>
                      <Switch
                        checked={gridShowTotals}
                        onCheckedChange={setGridShowTotals}
                        className='scale-90'
                      />
                    </div>
                  )}
                  {iface === 'inline-table' && (
                    <>
                      <div className='flex items-center justify-between px-3 py-2'>
                        <div>
                          <p className='text-[12px] text-slate-700'>Save with main form</p>
                          <p className='text-[10px] text-slate-400'>
                            Rows save when the parent record saves
                          </p>
                        </div>
                        <Switch
                          checked={saveMode === 'pending'}
                          onCheckedChange={(v) => setSaveMode(v ? 'pending' : 'immediate')}
                          className='scale-90'
                        />
                      </div>
                      <div className='flex items-center justify-between px-3 py-2'>
                        <span className='text-[12px] text-slate-700'>Show line numbers</span>
                        <Switch
                          checked={showLineNumbers}
                          onCheckedChange={setShowLineNumbers}
                          className='scale-90'
                        />
                      </div>
                      <div className='flex items-center justify-between px-3 py-2'>
                        <span className='text-[12px] text-slate-700'>Drag to reorder</span>
                        <Switch
                          checked={enableReorder}
                          onCheckedChange={setEnableReorder}
                          className='scale-90'
                        />
                      </div>
                    </>
                  )}
                </div>

                {/* Cascade from parent (table only) */}
                {iface === 'inline-table' && (
                  <div className='space-y-2'>
                    <div className='flex items-center justify-between'>
                      <Label className='text-[11px] text-slate-600'>Cascade from parent</Label>
                      <button
                        type='button'
                        onClick={() =>
                          setParentCascades([
                            ...parentCascades,
                            { parent_field: '', child_field: '' }
                          ])
                        }
                        className='text-[10px] text-nvr-cyan hover:underline'
                      >
                        + Add
                      </button>
                    </div>
                    {parentCascades.length === 0 && (
                      <p className='text-[10px] text-slate-400'>
                        Parent = M2O on this form. Child = M2O on each row.
                      </p>
                    )}
                    {parentCascades.map((rule, idx) => (
                      <CascadeRuleRow
                        key={idx}
                        rule={rule}
                        parentFields={parentM2OFields}
                        childFields={childM2OFields}
                        onChange={(updated) =>
                          setParentCascades(parentCascades.map((r, i) => (i === idx ? updated : r)))
                        }
                        onRemove={() =>
                          setParentCascades(parentCascades.filter((_, i) => i !== idx))
                        }
                      />
                    ))}
                  </div>
                )}

                {/* Row rules (table only) */}
                {iface === 'inline-table' && (
                  <div className='space-y-2'>
                    <div ref={setRowRulePortalContainer} />
                    <div className='flex items-center justify-between'>
                      <Label className='text-[11px] text-slate-600'>Row auto-fill rules</Label>
                      <button
                        type='button'
                        onClick={() =>
                          setRowRulesLocal([
                            ...rowRulesLocal,
                            {
                              trigger_field: null,
                              trigger_op: 'nnull',
                              target_field: '',
                              target_type: 'relation_field',
                              sort: rowRulesLocal.length
                            }
                          ])
                        }
                        className='text-[10px] text-nvr-cyan hover:underline'
                      >
                        + Add rule
                      </button>
                    </div>
                    {rowRulesLocal.length === 0 && (
                      <p className='text-[10px] text-slate-400'>
                        No rules. Rules auto-fill row fields when conditions are met.
                      </p>
                    )}
                    {rowRulesLocal.map((rule, idx) => (
                      <RowRuleRow
                        key={idx}
                        rule={rule}
                        childFields={(() => {
                          const seen = new Map<
                            string,
                            {
                              field: string
                              label?: string | null
                              type?: string
                              interface?: string | null
                              hidden?: boolean
                            }
                          >()
                          const O2M_IFACES = new Set([
                            'inline-table',
                            'inline-grid',
                            'list-o2m',
                            'relation-list'
                          ])
                          for (const f of childAllFields.filter(
                            (f) =>
                              !f.hidden &&
                              f.field !== 'id' &&
                              !f.field.startsWith('__') &&
                              !ROW_RULE_SKIP_TYPES.has(f.type ?? '') &&
                              !O2M_IFACES.has(f.interface ?? '')
                          )) {
                            const existing = seen.get(f.field)
                            if (!existing || (!existing.label && f.label)) seen.set(f.field, f)
                          }
                          return [...seen.values()]
                        })()}
                        m2oRels={childM2ORels}
                        o2mRels={childO2MRels}
                        onChange={(updated) =>
                          setRowRulesLocal(rowRulesLocal.map((r, i) => (i === idx ? updated : r)))
                        }
                        onRemove={() => setRowRulesLocal(rowRulesLocal.filter((_, i) => i !== idx))}
                        portalContainer={rowRulePortalContainer}
                        parentContextFields={parentContextFieldsLocal.map((field) => ({
                          field,
                          label: parentAllFields.find((pf) => pf.field === field)?.label || field,
                          one_collection: parentFieldRelatedCollectionMap[field] ?? null
                        }))}
                      />
                    ))}
                    {/* Parent context — always visible for inline-table */}
                    <div className='pt-1 border-t border-slate-100 space-y-1.5'>
                      <Label className='text-[11px] text-slate-600'>Parent context fields</Label>
                      <p className='text-[10px] text-slate-400'>
                        Available as{' '}
                        <code className='font-mono bg-slate-100 px-0.5 rounded'>$parent.field</code>{' '}
                        in rules above.
                      </p>
                      <Popover open={parentCtxOpen} onOpenChange={setParentCtxOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type='button'
                            className='w-full flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-left hover:border-slate-400'
                          >
                            <span
                              className={cn(
                                'truncate',
                                parentContextFieldsLocal.length
                                  ? 'text-slate-700'
                                  : 'text-slate-400'
                              )}
                            >
                              {parentContextFieldsLocal.length
                                ? parentContextFieldsLocal
                                    .map(
                                      (f) =>
                                        parentAllFields.find((pf) => pf.field === f)?.label || f
                                    )
                                    .join(', ')
                                : 'None selected'}
                            </span>
                            <ChevronDown className='h-3.5 w-3.5 text-slate-400 ml-1 shrink-0' />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className='w-64 p-0' align='start'>
                          <Command>
                            <CommandInput
                              placeholder='Search fields…'
                              className='h-8 text-[12px]'
                            />
                            <CommandList className='max-h-[220px]'>
                              <CommandGroup>
                                {parentAllFields
                                  .filter(
                                    (f) =>
                                      f.field !== 'id' &&
                                      !SKIP_TYPES.has(f.type ?? '') &&
                                      ![
                                        'inline-table',
                                        'inline-grid',
                                        'list-o2m',
                                        'relation-list'
                                      ].includes(f.interface ?? '')
                                  )
                                  .map((f) => {
                                    const checked = parentContextFieldsLocal.includes(f.field)
                                    return (
                                      <CommandItem
                                        key={f.field}
                                        value={`${f.label || f.field} ${f.field}`}
                                        onSelect={() =>
                                          setParentContextFieldsLocal(
                                            checked
                                              ? parentContextFieldsLocal.filter(
                                                  (x) => x !== f.field
                                                )
                                              : [...parentContextFieldsLocal, f.field]
                                          )
                                        }
                                        className='text-[11px] flex items-center gap-2'
                                      >
                                        <Check
                                          className={cn(
                                            'h-3 w-3 shrink-0',
                                            checked ? 'opacity-100' : 'opacity-0'
                                          )}
                                        />
                                        <span className='flex-1 truncate'>
                                          {f.label || f.field}
                                        </span>
                                        <span className='font-mono text-[9px] text-slate-400 shrink-0'>
                                          {f.field}
                                        </span>
                                      </CommandItem>
                                    )
                                  })}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                )}

                {/* Unique by (table only) */}
                {iface === 'inline-table' && (
                  <div className='space-y-1.5'>
                    <Label className='text-[11px] text-slate-600'>Unique rows by</Label>
                    <Popover open={uniqueByOpen} onOpenChange={setUniqueByOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type='button'
                          className='w-full flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-left hover:border-slate-400'
                        >
                          <span className={uniqueBy.length ? 'text-slate-700' : 'text-slate-400'}>
                            {uniqueBy.length
                              ? uniqueBy
                                  .map(
                                    (f) => uniqueByOptions.find((o) => o.field === f)?.label || f
                                  )
                                  .join(', ')
                              : 'None (no uniqueness enforced)'}
                          </span>
                          <ChevronDown className='h-3.5 w-3.5 text-slate-400 ml-1 shrink-0' />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className='w-56 p-1' align='start'>
                        {uniqueByOptions.length === 0 ? (
                          <p className='px-2 py-1 text-[11px] text-slate-400'>
                            No fields available
                          </p>
                        ) : (
                          <>
                            {uniqueByOptions.map((f) => {
                              const checked = uniqueBy.includes(f.field)
                              return (
                                <button
                                  key={f.field}
                                  type='button'
                                  onClick={() =>
                                    setUniqueBy(
                                      checked
                                        ? uniqueBy.filter((x) => x !== f.field)
                                        : [...uniqueBy, f.field]
                                    )
                                  }
                                  className='flex w-full items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-slate-100'
                                >
                                  <span
                                    className={`h-3.5 w-3.5 rounded border flex items-center justify-center shrink-0 ${checked ? 'border-nvr-cyan bg-nvr-cyan' : 'border-slate-300'}`}
                                  >
                                    {checked && (
                                      <span className='text-white text-[8px] font-bold'>✓</span>
                                    )}
                                  </span>
                                  <span className='flex-1 truncate text-slate-700'>
                                    {f.label || f.field}
                                  </span>
                                  <span className='text-slate-400 font-mono text-[10px]'>
                                    {f.type}
                                  </span>
                                </button>
                              )
                            })}
                            {uniqueBy.length > 0 && (
                              <button
                                type='button'
                                onClick={() => setUniqueBy([])}
                                className='mt-1 w-full rounded px-2 py-1 text-[10px] text-slate-400 hover:text-red-500 text-left'
                              >
                                Clear all
                              </button>
                            )}
                          </>
                        )}
                      </PopoverContent>
                    </Popover>
                    {uniqueBy.length > 0 && (
                      <p className='text-[10px] text-slate-400'>
                        Blocks duplicates by: {uniqueBy.join(', ')}
                      </p>
                    )}
                  </div>
                )}

                {/* Sort by (table only) */}
                {iface === 'inline-table' && uniqueByOptions.length > 0 && (
                  <div className='space-y-1.5'>
                    <Label className='text-[11px] text-slate-600'>Sort rows by</Label>
                    <div className='flex gap-1'>
                      <Popover open={sortFieldOpen} onOpenChange={setSortFieldOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type='button'
                            className='flex flex-1 items-center justify-between rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 hover:border-slate-300'
                          >
                            <span className='truncate'>
                              {sortField
                                ? uniqueByOptions.find((f) => f.field === sortField)?.label ||
                                  sortField
                                : 'None'}
                            </span>
                            <ChevronDown className='h-3 w-3 text-slate-400 shrink-0' />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className='w-48 p-1' align='start'>
                          <button
                            type='button'
                            onClick={() => {
                              setSortField('')
                              setSortFieldOpen(false)
                            }}
                            className='flex w-full items-center rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100'
                          >
                            — None
                          </button>
                          {uniqueByOptions.map((f) => (
                            <button
                              key={f.field}
                              type='button'
                              onClick={() => {
                                setSortField(f.field)
                                setSortFieldOpen(false)
                              }}
                              className={`flex w-full items-center justify-between rounded px-2 py-1 text-[11px] hover:bg-slate-100 ${sortField === f.field ? 'text-nvr-cyan font-medium' : 'text-slate-700'}`}
                            >
                              <span className='truncate'>{f.label || f.field}</span>
                              <span className='text-slate-400 font-mono text-[10px]'>{f.type}</span>
                            </button>
                          ))}
                        </PopoverContent>
                      </Popover>
                      {sortField && (
                        <button
                          type='button'
                          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                          className='shrink-0 rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-medium text-slate-600 hover:border-slate-300 hover:text-nvr-cyan'
                        >
                          {sortDir === 'asc' ? '↑ ASC' : '↓ DESC'}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Column presets (table only) */}
                {iface === 'inline-table' && (
                  <div className='space-y-2'>
                    <div className='flex items-center justify-between'>
                      <Label className='text-[11px] text-slate-600'>Column presets</Label>
                      <button
                        type='button'
                        onClick={() =>
                          setColumnPresetsLocal([
                            ...columnPresetsLocal,
                            { name: '', columns: [], _key: crypto.randomUUID() }
                          ])
                        }
                        className='text-[10px] text-nvr-cyan hover:underline'
                      >
                        + Add preset
                      </button>
                    </div>
                    {columnPresetsLocal.length === 0 && (
                      <p className='text-[10px] text-slate-400'>
                        No presets. Presets let users switch which columns the table shows.
                      </p>
                    )}
                    {columnPresetsLocal.map((preset, idx) => (
                      <ColumnPresetRow
                        key={preset._key}
                        preset={preset}
                        optionGroups={presetOptionGroups}
                        onChange={(updated) =>
                          setColumnPresetsLocal(
                            columnPresetsLocal.map((p, i) => (i === idx ? updated : p))
                          )
                        }
                        onRemove={() =>
                          setColumnPresetsLocal(columnPresetsLocal.filter((_, i) => i !== idx))
                        }
                        onMoveUp={() =>
                          setColumnPresetsLocal(reorder(columnPresetsLocal, idx, idx - 1))
                        }
                        onMoveDown={() =>
                          setColumnPresetsLocal(reorder(columnPresetsLocal, idx, idx + 1))
                        }
                        isFirst={idx === 0}
                        isLast={idx === columnPresetsLocal.length - 1}
                      />
                    ))}
                  </div>
                )}

                {/* Drawer relations (table only) */}
                {iface === 'inline-table' && (
                  <div className='space-y-2'>
                    <div className='flex items-center justify-between'>
                      <Label className='text-[11px] text-slate-600'>Drawer relations</Label>
                      <button
                        type='button'
                        onClick={() =>
                          setDrawerRelationsLocal([
                            ...drawerRelationsLocal,
                            { field: '', sumField: '', capField: '', _key: crypto.randomUUID() }
                          ])
                        }
                        className='text-[10px] text-nvr-cyan hover:underline'
                      >
                        + Add relation
                      </button>
                    </div>
                    {drawerRelationsLocal.length === 0 && (
                      <p className='text-[10px] text-slate-400'>
                        No nested relations. Shown in each row's expanded drawer.
                      </p>
                    )}
                    {drawerRelationsLocal.map((entry, idx) => (
                      <DrawerRelationRow
                        key={entry._key}
                        entry={entry}
                        relationOptions={drawerRelationOptions}
                        capFieldOptions={childNumericFieldOptions}
                        onChange={(updated) =>
                          setDrawerRelationsLocal(
                            drawerRelationsLocal.map((d, i) => (i === idx ? updated : d))
                          )
                        }
                        onRemove={() =>
                          setDrawerRelationsLocal(drawerRelationsLocal.filter((_, i) => i !== idx))
                        }
                      />
                    ))}
                  </div>
                )}

                {/* Revision history (table only) */}
                {iface === 'inline-table' && onRowRevisionsChange && (
                  <div className='divide-y divide-slate-100 rounded-md border border-slate-200'>
                    <div className='flex items-center justify-between px-3 py-2'>
                      <span className='text-[12px] text-slate-700'>Row revision history</span>
                      <Switch
                        checked={!!showRowRevisions}
                        onCheckedChange={onRowRevisionsChange}
                        className='scale-90'
                      />
                    </div>
                    {showRowRevisions && onAllowRevisionRestoreChange && (
                      <div className='flex items-center justify-between px-3 py-2 bg-slate-50/50'>
                        <span className='text-[12px] text-slate-600 pl-2'>Allow restore</span>
                        <Switch
                          checked={!!allowRevisionRestore}
                          onCheckedChange={onAllowRevisionRestoreChange}
                          className='scale-90'
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Addendum: prefill from parent record */}
                {onPrefillFromParentChange && (
                  <div className='flex items-center justify-between rounded-md border border-slate-200 px-3 py-2'>
                    <span className='text-[12px] text-slate-700'>Prefill from current record</span>
                    <Switch
                      checked={prefillFromParent ?? true}
                      onCheckedChange={onPrefillFromParentChange}
                      className='scale-90'
                    />
                  </div>
                )}
              </div>
            )}

            {/* ── Lock conditions ── */}
            {onLockConditionsChange && (
              <div className='space-y-3'>
                <div className='flex items-center gap-2'>
                  <span className='text-[11px] font-medium text-slate-500 shrink-0'>
                    Lock conditions
                  </span>
                  <div className='flex-1 h-px bg-slate-100' />
                  <button
                    type='button'
                    onClick={() =>
                      onLockConditionsChange([
                        ...lockConditions,
                        { type: 'pipeline_state', state_keys: [] }
                      ])
                    }
                    className='text-[10px] text-nvr-cyan hover:underline shrink-0'
                  >
                    + Add
                  </button>
                </div>
                {lockConditions.length === 0 && (
                  <p className='text-[10px] text-slate-400'>
                    No conditions — field is always editable.
                  </p>
                )}
                {lockConditions.map((cond, i) => (
                  <div
                    key={i}
                    className='rounded-md border border-slate-200 bg-white overflow-hidden'
                  >
                    <div className='flex items-center gap-1.5 px-2.5 py-2 bg-slate-50/50'>
                      <select
                        value={cond.type}
                        onChange={(e) => {
                          const next = [...lockConditions]
                          next[i] = { ...next[i], type: e.target.value }
                          onLockConditionsChange(next)
                        }}
                        className='flex-1 rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px]'
                      >
                        <option value='pipeline_state'>Pipeline state</option>
                        <option value='role'>User role</option>
                      </select>
                      <button
                        type='button'
                        onClick={() =>
                          onLockConditionsChange(lockConditions.filter((_, j) => j !== i))
                        }
                        className='text-slate-400 hover:text-red-500'
                      >
                        <X className='h-3.5 w-3.5' />
                      </button>
                    </div>
                    {cond.type === 'pipeline_state' && (
                      <div className='px-2.5 py-2 border-t border-slate-100'>
                        <PipelineStateConditionRow
                          collection={collection}
                          pipelineId={cond.pipeline_id}
                          stateKeys={cond.state_keys ?? []}
                          onPipelineChange={(pid) => {
                            const next = [...lockConditions]
                            next[i] = { ...next[i], pipeline_id: pid, state_keys: [] }
                            onLockConditionsChange(next)
                          }}
                          onStateKeysChange={(keys) => {
                            const next = [...lockConditions]
                            next[i] = { ...next[i], state_keys: keys }
                            onLockConditionsChange(next)
                          }}
                        />
                      </div>
                    )}
                    {cond.type === 'role' && (
                      <div className='px-2.5 py-2 border-t border-slate-100'>
                        <RoleConditionRow
                          roleIds={cond.role_ids ?? []}
                          onRoleIdsChange={(ids) => {
                            const next = [...lockConditions]
                            next[i] = { ...next[i], role_ids: ids }
                            onLockConditionsChange(next)
                          }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className='shrink-0 flex gap-2 p-3 border-t border-slate-100'>
          <Button size='sm' className='h-7 flex-1 text-[12px]' onClick={save}>
            Save
          </Button>
          <Button
            size='sm'
            variant='outline'
            className='h-7 text-[12px]'
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ── SortableFieldChip ─────────────────────────────────────────────────────────

function FieldChip({
  fieldName,
  displayName,
  fieldType,
  abstractType,
  isM2O,
  isM2M,
  colSpan,
  onColSpan,
  fieldSettings,
  onSettings,
  m2oFields,
  dependencyConfig,
  relatedCollection,
  dragHandleProps = {},
  style = {},
  isDragging = false,
  onUnassign,
  rowRevisions,
  onRowRevisionsChange,
  allowRevisionRestore = true,
  onAllowRevisionRestoreChange,
  lockConditions = [],
  onLockConditionsChange,
  extraControls,
  inlineDisplayConfig,
  onInlineDisplayChange,
  collection,
  compact,
  prefillFromParent,
  onPrefillFromParentChange
}: {
  fieldName: string
  displayName?: string
  fieldType?: string
  abstractType?: string
  isM2O?: boolean
  isM2M?: boolean
  colSpan: number
  onColSpan?: (span: number) => void
  fieldSettings?: FieldSettings
  onSettings?: (patch: Partial<FieldSettings> & { dependency_config?: string }) => void
  m2oFields?: CascadeParentField[]
  dependencyConfig?: Record<string, unknown> | null
  relatedCollection?: string | null
  dragHandleProps?: Record<string, unknown>
  style?: React.CSSProperties
  isDragging?: boolean
  onUnassign?: () => void
  rowRevisions?: boolean
  onRowRevisionsChange?: (v: boolean) => void
  allowRevisionRestore?: boolean
  onAllowRevisionRestoreChange?: (v: boolean) => void
  lockConditions?: Array<{
    type: string
    state_keys?: string[]
    role_ids?: string[]
    pipeline_id?: string
  }>
  onLockConditionsChange?: (
    v: Array<{ type: string; state_keys?: string[]; role_ids?: string[]; pipeline_id?: string }>
  ) => void
  extraControls?: React.ReactNode
  inlineDisplayConfig?: InlineDisplayConfig
  onInlineDisplayChange?: (config: InlineDisplayConfig) => void
  collection?: string
  compact?: boolean
  prefillFromParent?: boolean
  onPrefillFromParentChange?: (v: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const widthLabel = WIDTH_OPTIONS.find((w) => w.span === colSpan)?.label ?? 'Full'

  if (compact) {
    return (
      <div
        style={style}
        className={cn(
          'group flex items-center gap-1.5 rounded px-1.5 py-[5px] text-[12px] select-none',
          isDragging ? 'opacity-30' : 'hover:bg-slate-100 dark:hover:bg-slate-800'
        )}
      >
        <span
          className='shrink-0 cursor-grab text-slate-300 group-hover:text-slate-400 active:cursor-grabbing'
          {...dragHandleProps}
        >
          <GripVertical className='h-3 w-3' />
        </span>
        <span className='flex-1 truncate text-slate-700 dark:text-slate-200' title={fieldName}>
          {displayName ?? <span className='font-mono text-[11px]'>{fieldName}</span>}
        </span>
        {fieldType && (
          <span
            className={cn(
              'shrink-0 rounded px-1 py-px font-mono text-[9px] leading-none',
              FRIENDLY_TYPE_STYLES[fieldType] ?? 'bg-slate-100 text-slate-500'
            )}
          >
            {fieldType}
          </span>
        )}
      </div>
    )
  }

  return (
    <div
      style={style}
      className={cn(
        'group flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[12px] select-none',
        isDragging
          ? 'shadow-lg opacity-80 ring-2 ring-nvr-cyan/40'
          : 'shadow-sm hover:border-slate-300'
      )}
    >
      {/* drag handle */}
      <span
        className='shrink-0 cursor-grab text-slate-300 hover:text-slate-500 active:cursor-grabbing'
        {...dragHandleProps}
      >
        <GripVertical className='h-3.5 w-3.5' />
      </span>

      {/* field name */}
      <span className='flex-1 truncate text-slate-700' title={fieldName}>
        {displayName ?? <span className='font-mono'>{fieldName}</span>}
      </span>

      {/* type badge */}
      {fieldType && (
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]',
            FRIENDLY_TYPE_STYLES[fieldType] ?? 'bg-slate-100 text-slate-500'
          )}
        >
          {fieldType}
        </span>
      )}

      {/* settings popover */}
      {fieldSettings && onSettings && (
        <FieldSettingsPopover
          fieldName={fieldName}
          abstractType={abstractType}
          isM2O={isM2O}
          isM2M={isM2M}
          settings={fieldSettings}
          m2oFields={m2oFields}
          dependencyConfig={dependencyConfig}
          relatedCollection={relatedCollection}
          onSave={onSettings}
          showRowRevisions={rowRevisions}
          onRowRevisionsChange={onRowRevisionsChange}
          allowRevisionRestore={allowRevisionRestore}
          onAllowRevisionRestoreChange={onAllowRevisionRestoreChange}
          lockConditions={lockConditions}
          onLockConditionsChange={onLockConditionsChange}
          inlineDisplayConfig={inlineDisplayConfig}
          onInlineDisplayChange={onInlineDisplayChange}
          collection={collection}
          prefillFromParent={prefillFromParent}
          onPrefillFromParentChange={onPrefillFromParentChange}
        />
      )}

      {/* impact analysis popover */}
      {fieldSettings && collection && (
        <FieldImpactPopover collection={collection} fieldName={fieldName} />
      )}

      {/* label visibility toggle */}
      {onSettings && (
        <div onPointerDown={(e) => e.stopPropagation()}>
          <button
            type='button'
            title={fieldSettings?.label === '' ? 'Show label' : 'Hide label'}
            onClick={() => onSettings({ label: fieldSettings?.label === '' ? null : '' })}
            className={cn(
              'shrink-0 rounded p-0.5 hover:text-slate-600',
              fieldSettings?.label === '' ? 'text-amber-400' : 'text-slate-300'
            )}
          >
            {fieldSettings?.label === '' ? (
              <EyeOff className='h-3 w-3' />
            ) : (
              <Eye className='h-3 w-3' />
            )}
          </button>
        </div>
      )}

      {extraControls}

      {/* unassign — send back to pool */}
      {onUnassign && (
        <div onPointerDown={(e) => e.stopPropagation()}>
          <button
            type='button'
            onClick={onUnassign}
            className='shrink-0 rounded p-0.5 text-slate-300 hover:text-red-400'
          >
            <X className='h-3 w-3' />
          </button>
        </div>
      )}

      {/* width selector — stopPropagation prevents dnd-kit from capturing pointer events */}
      {onColSpan && (
        <div className='relative shrink-0' onPointerDown={(e) => e.stopPropagation()}>
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            className='flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-200'
          >
            {widthLabel}
            <ChevronDown className='h-2.5 w-2.5' />
          </button>
          {open && (
            <div className='absolute right-0 top-full z-20 mt-1 rounded-md border border-slate-200 bg-white py-1 shadow-md'>
              {WIDTH_OPTIONS.map((w) => (
                <button
                  key={w.span}
                  type='button'
                  onClick={() => {
                    onColSpan(w.span)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-1.5 text-[12px] hover:bg-slate-50',
                    w.span === colSpan ? 'font-medium text-nvr-cyan' : 'text-slate-700'
                  )}
                >
                  <span className='inline-flex h-2.5 w-12 overflow-hidden rounded-sm bg-slate-100'>
                    <span
                      className='h-full rounded-sm bg-nvr-cyan/50'
                      style={{ width: `${(w.span / 12) * 100}%` }}
                    />
                  </span>
                  {w.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SortableFieldChip({
  fieldName,
  displayName,
  fieldType,
  abstractType,
  isM2O,
  isM2M,
  colSpan,
  onColSpan,
  fieldSettings,
  onSettings,
  m2oFields,
  dependencyConfig,
  relatedCollection,
  onUnassign,
  inGrid = false,
  sortableId,
  rowRevisions,
  onRowRevisionsChange,
  allowRevisionRestore = true,
  onAllowRevisionRestoreChange,
  lockConditions = [],
  onLockConditionsChange,
  extraControls,
  inlineDisplayConfig,
  onInlineDisplayChange,
  collection,
  compact,
  prefillFromParent,
  onPrefillFromParentChange
}: {
  fieldName: string
  displayName?: string
  fieldType?: string
  abstractType?: string
  isM2O?: boolean
  isM2M?: boolean
  colSpan: number
  onColSpan?: (span: number) => void
  fieldSettings?: FieldSettings
  onSettings?: (patch: Partial<FieldSettings> & { dependency_config?: string }) => void
  m2oFields?: CascadeParentField[]
  dependencyConfig?: Record<string, unknown> | null
  relatedCollection?: string | null
  onUnassign?: () => void
  inGrid?: boolean
  sortableId?: string
  rowRevisions?: boolean
  onRowRevisionsChange?: (v: boolean) => void
  allowRevisionRestore?: boolean
  onAllowRevisionRestoreChange?: (v: boolean) => void
  lockConditions?: Array<{
    type: string
    state_keys?: string[]
    role_ids?: string[]
    pipeline_id?: string
  }>
  onLockConditionsChange?: (
    v: Array<{ type: string; state_keys?: string[]; role_ids?: string[]; pipeline_id?: string }>
  ) => void
  extraControls?: React.ReactNode
  inlineDisplayConfig?: InlineDisplayConfig
  onInlineDisplayChange?: (config: InlineDisplayConfig) => void
  collection?: string
  compact?: boolean
  prefillFromParent?: boolean
  onPrefillFromParentChange?: (v: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId ?? fieldName,
    data: { type: 'field' }
  })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      style={{
        transform: DndCSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.3 : 1,
        gridColumn: inGrid ? `span ${colSpan}` : undefined
      }}
    >
      <FieldChip
        fieldName={fieldName}
        displayName={displayName}
        fieldType={fieldType}
        abstractType={abstractType}
        isM2O={isM2O}
        isM2M={isM2M}
        colSpan={colSpan}
        onColSpan={onColSpan}
        fieldSettings={fieldSettings}
        onSettings={onSettings}
        m2oFields={m2oFields}
        dependencyConfig={dependencyConfig}
        relatedCollection={relatedCollection}
        onUnassign={onUnassign}
        dragHandleProps={listeners ?? {}}
        rowRevisions={rowRevisions}
        onRowRevisionsChange={onRowRevisionsChange}
        allowRevisionRestore={allowRevisionRestore}
        onAllowRevisionRestoreChange={onAllowRevisionRestoreChange}
        lockConditions={lockConditions}
        onLockConditionsChange={onLockConditionsChange}
        extraControls={extraControls}
        inlineDisplayConfig={inlineDisplayConfig}
        onInlineDisplayChange={onInlineDisplayChange}
        collection={collection}
        compact={compact}
        prefillFromParent={prefillFromParent}
        onPrefillFromParentChange={onPrefillFromParentChange}
      />
    </div>
  )
}

// ── Composite sortable ID helpers ─────────────────────────────────────────────
// dnd-kit requires unique IDs. When the same field appears in multiple zones
// (multi-group layout), use "f::container::fieldName" to ensure uniqueness.
const toSortableId = (container: string, field: string) => `f::${container}::${field}`
function parseSortableId(id: string): { container: string | null; fieldName: string } {
  if (id.startsWith('f::')) {
    const rest = id.slice(3)
    const sep = rest.indexOf('::')
    if (sep !== -1) return { container: rest.slice(0, sep), fieldName: rest.slice(sep + 2) }
  }
  return { container: null, fieldName: id }
}

// ── SortableUngroupedZone ─────────────────────────────────────────────────────

function SortableUngroupedZone({
  localFieldOrder,
  allFields,
  getColSpan,
  patchField,
  getFieldSettings,
  handleFieldSettings,
  relKind,
  friendlyType,
  getM2OFields,
  getDependencyConfig,
  getRelatedCollection,
  onUnassign,
  onReturnAll,
  isTableMode,
  getExtraControls,
  widgetSlotMeta,
  getInlineDisplay,
  onInlineDisplayChange,
  getLockConditions,
  onLockConditions,
  collection,
  getPrefillFromParent,
  onPrefillFromParent
}: {
  localFieldOrder: Record<string, string[]>
  allFields: Array<{ field: string; type?: string; options?: string | null }>
  getColSpan: (f: string) => number
  patchField: (field: string, patch: Record<string, unknown>) => void
  getFieldSettings: (f: string) => FieldSettings
  handleFieldSettings: (
    f: string,
    patch: Partial<FieldSettings> & { dependency_config?: string }
  ) => void
  relKind: (f: string) => string | null
  friendlyType: (type: string | undefined, field: string) => string | undefined
  getM2OFields?: () => CascadeParentField[]
  getDependencyConfig?: (f: string) => Record<string, unknown> | null
  getRelatedCollection?: (f: string) => string | null
  onUnassign?: (f: string, groupKey: string) => void
  onReturnAll?: () => void
  isTableMode?: boolean
  getExtraControls?: (
    f: string,
    opts?: { isM2O?: boolean; relatedCollection?: string | null }
  ) => React.ReactNode
  widgetSlotMeta?: Record<
    string,
    { widget_id: number; name: string; label_override: string | null }
  >
  getInlineDisplay?: (f: string) => InlineDisplayConfig | undefined
  onInlineDisplayChange?: (f: string, config: InlineDisplayConfig) => void
  getLockConditions?: (
    f: string
  ) => Array<{ type: string; state_keys?: string[]; role_ids?: string[]; pipeline_id?: string }>
  onLockConditions?: (
    f: string,
    v: Array<{ type: string; state_keys?: string[]; role_ids?: string[]; pipeline_id?: string }>
  ) => void
  collection?: string
  getPrefillFromParent?: (f: string) => boolean
  onPrefillFromParent?: (f: string, v: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: 'group:__ungrouped__'
  })
  const style = {
    transform: DndCSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1
  }
  const fields = localFieldOrder.__unassigned__ ?? []
  return (
    <div
      ref={setNodeRef}
      style={style}
      className='rounded-lg border border-dashed border-slate-300 bg-white dark:bg-card'
    >
      <div className='flex items-center gap-1.5 border-b border-slate-200 px-3 py-2 dark:border-border'>
        <button
          type='button'
          {...attributes}
          {...listeners}
          className='cursor-grab touch-none rounded p-0.5 text-slate-300 hover:text-slate-500 active:cursor-grabbing'
        >
          <GripVertical className='h-3.5 w-3.5' />
        </button>
        <span className='text-[11px] font-medium text-slate-500'>
          {isTableMode ? 'Columns' : 'Ungrouped'}
        </span>
        <span className='text-[10px] text-slate-300'>
          {isTableMode
            ? '— column order in the table'
            : '— fields rendered above sections in the item editor'}
        </span>
        {fields.length > 0 && onReturnAll && (
          <button
            type='button'
            onClick={onReturnAll}
            className='ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800'
          >
            Return all
          </button>
        )}
      </div>
      <DroppableFieldZone containerId='__unassigned__'>
        <SortableContext
          items={fields.map((f) => toSortableId('__unassigned__', f))}
          strategy={rectSortingStrategy}
        >
          <div
            className={cn(
              'min-h-[52px] p-3',
              fields.length === 0
                ? 'flex items-center justify-center'
                : 'grid grid-cols-12 gap-2 auto-rows-auto'
            )}
          >
            {fields.length === 0 ? (
              <p className='text-[11px] text-slate-300'>
                {isTableMode
                  ? 'Add fields to define table columns'
                  : 'Drop fields here to leave them ungrouped'}
              </p>
            ) : (
              fields.map((f) => {
                if (f === OWNERS_FIELD) {
                  return (
                    <SortableFieldChip
                      key={toSortableId('__unassigned__', f)}
                      sortableId={toSortableId('__unassigned__', f)}
                      fieldName={f}
                      displayName='Owners'
                      fieldType='owners'
                      colSpan={getColSpan(f)}
                      onColSpan={
                        isTableMode ? undefined : (span) => patchField(f, { col_span: span })
                      }
                      onUnassign={onUnassign ? () => onUnassign(f, '__unassigned__') : undefined}
                      inGrid
                    />
                  )
                }
                if (f === PDF_FIELD) {
                  return (
                    <SortableFieldChip
                      key={toSortableId('__unassigned__', f)}
                      sortableId={toSortableId('__unassigned__', f)}
                      fieldName={f}
                      displayName='PDF Button'
                      fieldType='pdf'
                      colSpan={getColSpan(f)}
                      onColSpan={
                        isTableMode ? undefined : (span) => patchField(f, { col_span: span })
                      }
                      onUnassign={onUnassign ? () => onUnassign(f, '__unassigned__') : undefined}
                      extraControls={getExtraControls?.(f)}
                      inGrid
                    />
                  )
                }
                if (typeof f === 'string' && f.startsWith('__widget_') && f.endsWith('__')) {
                  const meta = widgetSlotMeta?.[f]
                  return (
                    <SortableFieldChip
                      key={toSortableId('__unassigned__', f)}
                      sortableId={toSortableId('__unassigned__', f)}
                      fieldName={f}
                      displayName={meta?.label_override || meta?.name || 'Widget'}
                      fieldType='widget'
                      colSpan={getColSpan(f)}
                      onColSpan={
                        isTableMode ? undefined : (span) => patchField(f, { col_span: span })
                      }
                      onUnassign={onUnassign ? () => onUnassign(f, '__unassigned__') : undefined}
                      extraControls={getExtraControls?.(f)}
                      inGrid
                    />
                  )
                }
                const ft = allFields.find((af) => af.field === f)
                const settings = getFieldSettings(f)
                const kind = relKind(f)
                return (
                  <SortableFieldChip
                    key={toSortableId('__unassigned__', f)}
                    sortableId={toSortableId('__unassigned__', f)}
                    fieldName={f}
                    displayName={settings.label || titleCase(f)}
                    fieldType={kind ?? friendlyType(ft?.type, f)}
                    abstractType={kind ? kind.toLowerCase() : ft?.type}
                    isM2O={kind === 'M2O'}
                    isM2M={kind === 'M2M'}
                    colSpan={getColSpan(f)}
                    onColSpan={
                      isTableMode ? undefined : (span) => patchField(f, { col_span: span })
                    }
                    fieldSettings={settings}
                    onSettings={(patch) => handleFieldSettings(f, patch)}
                    m2oFields={
                      kind === 'M2O' || kind === 'M2M' || kind === 'O2M'
                        ? getM2OFields?.()
                        : undefined
                    }
                    dependencyConfig={
                      kind === 'M2O' || kind === 'M2M' ? getDependencyConfig?.(f) : undefined
                    }
                    relatedCollection={
                      kind === 'M2O' || kind === 'M2M' || kind === 'O2M'
                        ? getRelatedCollection?.(f)
                        : undefined
                    }
                    onUnassign={onUnassign ? () => onUnassign(f, '__unassigned__') : undefined}
                    lockConditions={getLockConditions?.(f) ?? []}
                    onLockConditionsChange={
                      onLockConditions ? (v) => onLockConditions(f, v) : undefined
                    }
                    extraControls={getExtraControls?.(f, {
                      isM2O: kind === 'M2O',
                      relatedCollection: getRelatedCollection?.(f)
                    })}
                    inlineDisplayConfig={kind === 'M2O' ? getInlineDisplay?.(f) : undefined}
                    onInlineDisplayChange={
                      kind === 'M2O' && onInlineDisplayChange
                        ? (config) => onInlineDisplayChange(f, config)
                        : undefined
                    }
                    collection={collection}
                    prefillFromParent={getPrefillFromParent?.(f)}
                    onPrefillFromParentChange={
                      onPrefillFromParent ? (v) => onPrefillFromParent(f, v) : undefined
                    }
                    inGrid
                  />
                )
              })
            )}
          </div>
        </SortableContext>
      </DroppableFieldZone>
    </div>
  )
}

// ── SortableGroupCard ─────────────────────────────────────────────────────────

function SwapConfigEditor({
  group,
  allFields,
  onGroupSettings
}: {
  group: FieldGroup
  allFields: Array<{ field: string; type?: string }>
  onGroupSettings: (id: number, patch: Partial<Pick<FieldGroup, 'swap_config'>>) => void
}) {
  type AltField = { field: string; width: 1 | 2 }
  type SwapCfg = {
    enabled: boolean
    primary_field: string
    alternate_fields: AltField[]
    toggle_label?: string
    back_label?: string
  }

  const [pfOpen, setPfOpen] = useState(false)
  const [afOpen, setAfOpen] = useState(false)
  const [pfSearch, setPfSearch] = useState('')
  const [afSearch, setAfSearch] = useState('')

  const swapCfg = (() => {
    try {
      if (!group.swap_config) return null
      const raw = JSON.parse(group.swap_config)
      // Normalise legacy string[] to AltField[]
      const alts: AltField[] = (raw.alternate_fields ?? []).map((x: string | AltField) =>
        typeof x === 'string' ? { field: x, width: 2 } : x
      )
      return { ...raw, alternate_fields: alts } as SwapCfg
    } catch {
      return null
    }
  })()

  const save = (patch: Partial<SwapCfg>) => {
    const next: SwapCfg = {
      enabled: swapCfg?.enabled ?? false,
      primary_field: swapCfg?.primary_field ?? '',
      alternate_fields: swapCfg?.alternate_fields ?? [],
      toggle_label: swapCfg?.toggle_label,
      back_label: swapCfg?.back_label,
      ...patch
    }
    onGroupSettings(group.id, { swap_config: JSON.stringify(next) })
  }

  const fieldLabel = (f: string) => titleCase(f)
  const altFieldKeys = new Set((swapCfg?.alternate_fields ?? []).map((a) => a.field))
  const pfFiltered = allFields.filter(
    (f) => !f.field.startsWith('__') && f.field.toLowerCase().includes(pfSearch.toLowerCase())
  )
  const afFiltered = allFields.filter(
    (f) =>
      !f.field.startsWith('__') &&
      f.field.toLowerCase().includes(afSearch.toLowerCase()) &&
      !altFieldKeys.has(f.field)
  )
  const altFields = swapCfg?.alternate_fields ?? []

  const setWidth = (field: string, width: 1 | 2) => {
    save({ alternate_fields: altFields.map((a) => (a.field === field ? { ...a, width } : a)) })
  }
  const removeAlt = (field: string) => {
    save({ alternate_fields: altFields.filter((a) => a.field !== field) })
  }

  return (
    <div className='border-t border-slate-100 dark:border-border pt-3 space-y-2'>
      <p className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>Field Swap</p>
      <p className='text-[10px] text-slate-400'>
        Toggle between a M2O picker and manual entry fields.
      </p>
      <label className='flex items-center gap-2 text-[11px] text-slate-600'>
        <input
          type='checkbox'
          checked={!!swapCfg?.enabled}
          onChange={(e) => save({ enabled: e.target.checked })}
          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
        />
        Enable field swap
      </label>
      {swapCfg?.enabled && (
        <div className='space-y-2 pl-1'>
          {/* Primary field */}
          <div>
            <p className='text-[10px] text-slate-400 mb-1'>Primary field (M2O)</p>
            <button
              type='button'
              onClick={() => {
                setPfOpen((v) => !v)
                setPfSearch('')
              }}
              className='w-full h-7 rounded border border-slate-200 dark:border-border bg-white dark:bg-background px-2 text-left text-[11px] flex items-center justify-between gap-1 hover:border-nvr-cyan/50'
            >
              {swapCfg.primary_field ? (
                <span className='flex-1 truncate'>
                  <span className='font-medium'>{fieldLabel(swapCfg.primary_field)}</span>{' '}
                  <span className='font-mono text-[10px] text-slate-400'>
                    {swapCfg.primary_field}
                  </span>
                </span>
              ) : (
                <span className='text-slate-400'>Select field…</span>
              )}
              <ChevronDown className='h-3 w-3 shrink-0 text-slate-400' />
            </button>
            {pfOpen && (
              <div className='mt-0.5 rounded border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm overflow-hidden'>
                <div className='flex items-center border-b border-slate-100 dark:border-border px-2'>
                  <Search className='h-3 w-3 text-slate-400 shrink-0' />
                  <input
                    autoFocus
                    value={pfSearch}
                    onChange={(e) => setPfSearch(e.target.value)}
                    placeholder='Search…'
                    className='flex-1 h-7 bg-transparent px-2 text-[11px] outline-none'
                  />
                </div>
                <div className='max-h-36 overflow-y-auto'>
                  {pfFiltered.length === 0 ? (
                    <p className='px-3 py-2 text-[11px] text-slate-400'>No fields</p>
                  ) : (
                    pfFiltered.map((f) => (
                      <button
                        key={f.field}
                        type='button'
                        onClick={() => {
                          save({ primary_field: f.field })
                          setPfOpen(false)
                        }}
                        className={[
                          'w-full text-left px-3 py-1.5 text-[11px] hover:bg-slate-50 dark:hover:bg-muted flex items-center justify-between gap-2',
                          swapCfg.primary_field === f.field ? 'bg-nvr-cyan/5 text-nvr-cyan' : ''
                        ].join(' ')}
                      >
                        <span className='font-medium truncate'>{fieldLabel(f.field)}</span>
                        <span className='font-mono text-[10px] text-slate-400 shrink-0'>
                          {f.type ?? ''}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          {/* Alternate fields */}
          <div>
            <p className='text-[10px] text-slate-400 mb-1'>Alternate fields</p>
            {altFields.length > 0 && (
              <div className='mb-1 space-y-1'>
                {altFields.map((a) => (
                  <div
                    key={a.field}
                    className='flex items-center gap-1.5 rounded border border-slate-100 dark:border-border bg-white dark:bg-card px-2 py-1'
                  >
                    <span className='flex-1 truncate text-[11px] font-medium text-slate-700 dark:text-slate-200'>
                      {fieldLabel(a.field)}
                    </span>
                    <div className='flex rounded border border-slate-200 dark:border-border overflow-hidden shrink-0'>
                      <button
                        type='button'
                        onClick={() => setWidth(a.field, 1)}
                        className={[
                          'px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                          a.width === 1
                            ? 'bg-nvr-cyan text-white'
                            : 'text-slate-400 hover:text-slate-600'
                        ].join(' ')}
                        title='Half width'
                      >
                        ½
                      </button>
                      <button
                        type='button'
                        onClick={() => setWidth(a.field, 2)}
                        className={[
                          'px-1.5 py-0.5 text-[10px] font-medium transition-colors border-l border-slate-200 dark:border-border',
                          a.width === 2
                            ? 'bg-nvr-cyan text-white'
                            : 'text-slate-400 hover:text-slate-600'
                        ].join(' ')}
                        title='Full width'
                      >
                        1
                      </button>
                    </div>
                    <button
                      type='button'
                      onClick={() => removeAlt(a.field)}
                      className='text-slate-300 hover:text-red-500 text-[14px] leading-none shrink-0'
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type='button'
              onClick={() => {
                setAfOpen((v) => !v)
                setAfSearch('')
              }}
              className='w-full h-7 rounded border border-dashed border-slate-200 dark:border-border bg-white dark:bg-background px-2 text-left text-[11px] flex items-center gap-1.5 text-slate-400 hover:border-nvr-cyan/50 hover:text-nvr-cyan'
            >
              <Plus className='h-3 w-3' /> Add field…
            </button>
            {afOpen && (
              <div className='mt-0.5 rounded border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm overflow-hidden'>
                <div className='flex items-center border-b border-slate-100 dark:border-border px-2'>
                  <Search className='h-3 w-3 text-slate-400 shrink-0' />
                  <input
                    autoFocus
                    value={afSearch}
                    onChange={(e) => setAfSearch(e.target.value)}
                    placeholder='Search…'
                    className='flex-1 h-7 bg-transparent px-2 text-[11px] outline-none'
                  />
                </div>
                <div className='max-h-36 overflow-y-auto'>
                  {afFiltered.length === 0 ? (
                    <p className='px-3 py-2 text-[11px] text-slate-400'>No more fields</p>
                  ) : (
                    afFiltered.map((f) => (
                      <button
                        key={f.field}
                        type='button'
                        onClick={() => {
                          save({ alternate_fields: [...altFields, { field: f.field, width: 2 }] })
                          setAfSearch('')
                          setAfOpen(false)
                        }}
                        className='w-full text-left px-3 py-1.5 text-[11px] hover:bg-slate-50 dark:hover:bg-muted flex items-center justify-between gap-2'
                      >
                        <span className='font-medium truncate'>{fieldLabel(f.field)}</span>
                        <span className='font-mono text-[10px] text-slate-400 shrink-0'>
                          {f.type ?? ''}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          {/* Labels */}
          <div className='flex gap-2'>
            <div className='flex-1'>
              <p className='text-[10px] text-slate-400 mb-1'>Toggle label</p>
              <input
                type='text'
                placeholder='Enter custom'
                key={`tl-${group.id}`}
                defaultValue={swapCfg.toggle_label ?? ''}
                onBlur={(e) => save({ toggle_label: e.target.value || undefined })}
                className='w-full h-6 rounded border border-slate-200 dark:border-border bg-white dark:bg-background px-2 text-[11px]'
              />
            </div>
            <div className='flex-1'>
              <p className='text-[10px] text-slate-400 mb-1'>Back label</p>
              <input
                type='text'
                placeholder='Use saved'
                key={`bl-${group.id}`}
                defaultValue={swapCfg.back_label ?? ''}
                onBlur={(e) => save({ back_label: e.target.value || undefined })}
                className='w-full h-6 rounded border border-slate-200 dark:border-border bg-white dark:bg-background px-2 text-[11px]'
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SortableGroupCard({
  group,
  fieldNames,
  allFields,
  getColSpan,
  onColSpan,
  onToggleType,
  onDelete,
  onRename,
  onIconChange,
  getRelKind,
  getFriendlyType,
  getFieldSettings,
  onFieldSettings,
  getM2OFields,
  getDependencyConfig,
  getRelatedCollection,
  onUnassign,
  onPatchTabMode,
  containerGroups,
  onSetContainer,
  onToggleCollapsed,
  onGroupSettings,
  getRowRevisions,
  onRowRevisions,
  getAllowRevisionRestore,
  onAllowRevisionRestore,
  getLockConditions,
  onLockConditions,
  getExtraControls,
  widgetSlotMeta,
  getInlineDisplay,
  onInlineDisplayChange,
  collection,
  getPrefillFromParent,
  onPrefillFromParent
}: {
  group: FieldGroup
  fieldNames: string[]
  allFields: Array<{ field: string; type?: string }>
  getColSpan: (f: string) => number
  onColSpan: (f: string, span: number) => void
  onToggleType: () => void
  onDelete: () => void
  onRename: (label: string) => void
  onIconChange: (icon: string | null) => void
  getRelKind?: (f: string) => string | null
  getFriendlyType?: (t?: string, fieldName?: string) => string | undefined
  getFieldSettings?: (f: string) => FieldSettings
  onFieldSettings?: (
    f: string,
    patch: Partial<FieldSettings> & { dependency_config?: string }
  ) => void
  getM2OFields?: () => CascadeParentField[]
  getDependencyConfig?: (f: string) => Record<string, unknown> | null
  getRelatedCollection?: (f: string) => string | null
  onUnassign?: (f: string, groupKey: string) => void
  onPatchTabMode?: (id: number, tab_mode: 'tabs' | 'steps') => void
  containerGroups?: FieldGroup[]
  onSetContainer?: (id: number, container_id: number | null) => void
  onToggleCollapsed?: (id: number) => void
  onGroupSettings?: (
    id: number,
    patch: Partial<
      Pick<
        FieldGroup,
        | 'hide_when_empty'
        | 'visibility_mode'
        | 'summary_fields'
        | 'summary_hide_empty'
        | 'swap_config'
      >
    >
  ) => void
  getRowRevisions?: (f: string) => boolean
  onRowRevisions?: (f: string, v: boolean) => void
  getAllowRevisionRestore?: (f: string) => boolean
  onAllowRevisionRestore?: (f: string, v: boolean) => void
  getLockConditions?: (
    f: string
  ) => Array<{ type: string; state_keys?: string[]; role_ids?: string[]; pipeline_id?: string }>
  onLockConditions?: (
    f: string,
    v: Array<{ type: string; state_keys?: string[]; role_ids?: string[]; pipeline_id?: string }>
  ) => void
  getExtraControls?: (
    f: string,
    opts?: { isM2O?: boolean; relatedCollection?: string | null }
  ) => React.ReactNode
  widgetSlotMeta?: Record<
    string,
    { widget_id: number; name: string; label_override: string | null }
  >
  getInlineDisplay?: (f: string) => InlineDisplayConfig | undefined
  onInlineDisplayChange?: (f: string, config: InlineDisplayConfig) => void
  collection?: string
  getPrefillFromParent?: (f: string) => boolean
  onPrefillFromParent?: (f: string, v: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [labelDraft, setLabelDraft] = useState(group.label)

  function commitRename() {
    const trimmed = labelDraft.trim()
    if (trimmed && trimmed !== group.label) onRename(trimmed)
    else setLabelDraft(group.label)
    setEditing(false)
  }

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `group:${group.key}`,
    data: { type: 'group' }
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Transform.toString(transform), transition }}
      className={cn('rounded-lg border border-slate-200 bg-white', isDragging && 'opacity-0')}
    >
      {/* Group header */}
      <div className='group flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2.5'>
        <span
          className='shrink-0 cursor-grab text-slate-300 hover:text-slate-500 active:cursor-grabbing'
          {...attributes}
          {...listeners}
        >
          <GripVertical className='h-3.5 w-3.5' />
        </span>
        {/* Icon picker */}
        <div className='flex items-center' onPointerDown={(e) => e.stopPropagation()}>
          {(() => {
            const GroupIcon = group.icon ? resolveCollectionIcon(group.icon) : null
            return (
              <IconPicker
                value={group.icon ?? ''}
                onChange={(v) => onIconChange(v || null)}
                trigger={
                  GroupIcon ? (
                    <button
                      type='button'
                      title='Change icon'
                      className='shrink-0 rounded p-0.5 text-slate-400 hover:text-nvr-cyan transition-colors'
                    >
                      <GroupIcon className='h-3.5 w-3.5' />
                    </button>
                  ) : (
                    <button
                      type='button'
                      title='Add icon'
                      className='shrink-0 rounded p-0.5 text-slate-300 hover:text-slate-500 transition-all'
                    >
                      <Plus className='h-3 w-3' />
                    </button>
                  )
                }
              />
            )
          })()}
        </div>
        {editing ? (
          <input
            autoFocus
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') {
                setLabelDraft(group.label)
                setEditing(false)
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className='flex-1 rounded border border-nvr-cyan/50 bg-white px-1.5 py-0.5 text-[13px] font-medium text-slate-800 outline-none ring-1 ring-nvr-cyan/30'
          />
        ) : (
          <button
            type='button'
            onClick={() => {
              setLabelDraft(group.label)
              setEditing(true)
            }}
            title='Click to rename'
            className='group/label flex flex-1 items-center gap-1 truncate text-left text-[13px] font-medium text-slate-800 hover:text-nvr-cyan'
          >
            <span className='truncate'>{group.label}</span>
            <Pencil className='h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/label:opacity-50' />
          </button>
        )}
        <span className='font-mono text-[10px] text-slate-400'>{group.key}</span>
        {group.type === 'container' && onPatchTabMode && (
          <button
            type='button'
            title='Toggle tabs / steps mode'
            onClick={() => onPatchTabMode(group.id, group.tab_mode === 'steps' ? 'tabs' : 'steps')}
            className='rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 hover:opacity-80'
          >
            {group.tab_mode === 'steps' ? 'steps' : 'tabs'}
          </button>
        )}
        {group.type === 'tab' &&
          containerGroups &&
          containerGroups.length > 0 &&
          onSetContainer && (
            <select
              value={group.container_id ?? ''}
              onChange={(e) =>
                onSetContainer(group.id, e.target.value ? Number(e.target.value) : null)
              }
              onPointerDown={(e) => e.stopPropagation()}
              className='rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] text-slate-500'
            >
              <option value=''>No container</option>
              {containerGroups.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        {(group.type === 'section' || group.type === 'metadata' || group.type === 'tab') &&
          onGroupSettings && (
            <div onPointerDown={(e) => e.stopPropagation()}>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type='button'
                    title='Section settings'
                    className='shrink-0 rounded p-1 text-slate-300 hover:text-slate-500'
                  >
                    <Settings2 className='h-3.5 w-3.5' />
                  </button>
                </PopoverTrigger>
                <PopoverContent className='w-[260px] p-3 space-y-3' align='end'>
                  <div>
                    <Label className='mb-1 block text-[11px]'>Show section</Label>
                    <Sel
                      value={group.visibility_mode ?? 'always'}
                      onChange={(v) =>
                        onGroupSettings(group.id, {
                          visibility_mode: v as 'always' | 'new_only' | 'existing_only'
                        })
                      }
                      options={[
                        { value: 'always', label: 'Always' },
                        { value: 'new_only', label: 'New items only' },
                        { value: 'existing_only', label: 'Existing items only' }
                      ]}
                    />
                  </div>
                  <label className='flex items-center gap-2 text-[12px] text-slate-600'>
                    <input
                      type='checkbox'
                      checked={!!group.hide_when_empty}
                      onChange={(e) =>
                        onGroupSettings(group.id, { hide_when_empty: e.target.checked })
                      }
                      className='h-3.5 w-3.5'
                    />
                    Hide when all fields are empty
                  </label>
                  <div>
                    <Label className='mb-1 block text-[11px]'>Collapsed summary fields</Label>
                    <p className='mb-1.5 text-[10px] text-slate-400'>Shown in the collapsed bar</p>
                    <div className='space-y-1.5 max-h-[220px] overflow-y-auto'>
                      {(() => {
                        type SummaryAggConfig = {
                          field: string
                          agg: 'sum' | 'count' | 'avg' | 'min' | 'max'
                          agg_field: string
                          label?: string
                        }
                        type SummaryScalarConfig = { field: string; label?: string }
                        type SummaryEntry = string | SummaryScalarConfig | SummaryAggConfig

                        let selected: SummaryEntry[] = []
                        try {
                          const p = JSON.parse(group.summary_fields ?? '[]')
                          if (Array.isArray(p)) selected = p
                        } catch {
                          /* noop */
                        }

                        const entryKey = (e: SummaryEntry) => (typeof e === 'string' ? e : e.field)
                        const findEntry = (f: string): SummaryEntry | undefined =>
                          selected.find((e) => entryKey(e) === f)
                        const getEntryLabel = (e: SummaryEntry): string =>
                          typeof e === 'string' ? '' : (e.label ?? '')

                        const save = (next: SummaryEntry[]) =>
                          onGroupSettings(group.id, { summary_fields: JSON.stringify(next) })

                        const setEntryLabel = (f: string, label: string) => {
                          const next = selected.map((e) => {
                            if (entryKey(e) !== f) return e
                            if (typeof e === 'string') return label ? { field: f, label } : f
                            return { ...e, label: label || undefined }
                          })
                          save(next)
                        }

                        const AGG_OPTIONS: { value: SummaryAggConfig['agg']; label: string }[] = [
                          { value: 'count', label: 'Count' },
                          { value: 'sum', label: 'Sum' },
                          { value: 'avg', label: 'Average' },
                          { value: 'min', label: 'Min' },
                          { value: 'max', label: 'Max' }
                        ]

                        return fieldNames.map((f) => {
                          const isO2M = getRelKind?.(f) === 'O2M'
                          const entry = findEntry(f)
                          const checked = !!entry
                          const aggEntry =
                            entry && typeof entry !== 'string' && 'agg' in entry ? entry : null
                          const currentAgg = aggEntry?.agg ?? 'count'
                          const currentAggField = aggEntry?.agg_field ?? ''
                          const needsAggField = currentAgg !== 'count'

                          return (
                            <div
                              key={f}
                              className='rounded border border-slate-100 bg-slate-50/60 p-1.5'
                            >
                              <div className='flex items-center gap-2'>
                                <label className='flex flex-1 items-center gap-2 text-[12px] text-slate-700 cursor-pointer min-w-0'>
                                  <input
                                    type='checkbox'
                                    checked={checked}
                                    onChange={() => {
                                      if (checked) {
                                        save(selected.filter((e) => entryKey(e) !== f))
                                      } else {
                                        save([
                                          ...selected,
                                          isO2M ? { field: f, agg: 'count', agg_field: '' } : f
                                        ])
                                      }
                                    }}
                                    className='h-3.5 w-3.5 shrink-0'
                                  />
                                  <span className='font-medium truncate'>{titleCase(f)}</span>
                                </label>
                                {isO2M && (
                                  <span className='shrink-0 rounded bg-nvr-cyan/10 px-1 py-px text-[9px] font-medium text-nvr-cyan uppercase tracking-wide'>
                                    list
                                  </span>
                                )}
                              </div>
                              {checked && isO2M && (
                                <div className='mt-1.5 ml-5 space-y-1'>
                                  <div className='flex items-center gap-1.5'>
                                    <span className='text-[10px] text-slate-400 shrink-0'>
                                      Show:
                                    </span>
                                    <select
                                      value={currentAgg}
                                      onChange={(e) => {
                                        const agg = e.target.value as SummaryAggConfig['agg']
                                        save(
                                          selected.map((ent) =>
                                            entryKey(ent) === f
                                              ? {
                                                  field: f,
                                                  agg,
                                                  agg_field: agg === 'count' ? '' : currentAggField
                                                }
                                              : ent
                                          )
                                        )
                                      }}
                                      className='flex-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
                                    >
                                      {AGG_OPTIONS.map((o) => (
                                        <option key={o.value} value={o.value}>
                                          {o.label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  {needsAggField && (
                                    <div className='flex items-center gap-1.5'>
                                      <span className='text-[10px] text-slate-400 shrink-0'>
                                        of column:
                                      </span>
                                      <div className='flex-1'>
                                        <O2MAggFieldCombobox
                                          relatedCollection={getRelatedCollection?.(f) ?? null}
                                          value={currentAggField}
                                          onChange={(v, fieldOpts) => {
                                            save(
                                              selected.map((ent) =>
                                                entryKey(ent) === f
                                                  ? {
                                                      field: f,
                                                      agg: currentAgg,
                                                      agg_field: v,
                                                      field_options: fieldOpts
                                                    }
                                                  : ent
                                              )
                                            )
                                          }}
                                        />
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                              {checked && (
                                <div className='mt-1.5 ml-5 flex items-center gap-1.5'>
                                  <span className='text-[10px] text-slate-400 shrink-0'>
                                    Label:
                                  </span>
                                  <input
                                    type='text'
                                    key={`label-${f}`}
                                    defaultValue={entry ? getEntryLabel(entry) : ''}
                                    onBlur={(e) => setEntryLabel(f, e.target.value)}
                                    placeholder={titleCase(f)}
                                    className='flex-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-nvr-cyan placeholder:text-slate-300'
                                  />
                                </div>
                              )}
                            </div>
                          )
                        })
                      })()}
                      {fieldNames.length === 0 && (
                        <p className='text-[11px] text-slate-300'>No fields assigned</p>
                      )}
                    </div>
                    <label className='flex items-center gap-2 text-[11px] text-slate-600 mt-2'>
                      <input
                        type='checkbox'
                        checked={!!group.summary_hide_empty}
                        onChange={(e) =>
                          onGroupSettings(group.id, { summary_hide_empty: e.target.checked })
                        }
                        className='h-3.5 w-3.5'
                      />
                      Hide fields with no values
                    </label>
                  </div>
                  <SwapConfigEditor
                    group={group}
                    allFields={allFields}
                    onGroupSettings={onGroupSettings}
                  />
                </PopoverContent>
              </Popover>
            </div>
          )}
        <button
          type='button'
          title='Click to cycle section / tab / record info / container'
          onClick={onToggleType}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:opacity-80',
            group.type === 'tab'
              ? 'bg-nvr-cyan/10 text-nvr-cyan'
              : group.type === 'metadata'
                ? 'bg-slate-600/10 text-slate-600'
                : group.type === 'container'
                  ? 'bg-violet-100 text-violet-600'
                  : 'bg-slate-100 text-slate-500'
          )}
        >
          {group.type === 'metadata' ? 'record info' : group.type}
        </button>
        {(group.type === 'section' || group.type === 'metadata') && (
          <button
            type='button'
            title={
              group.is_collapsed
                ? 'Default: collapsed — click to start expanded'
                : 'Default: expanded — click to start collapsed'
            }
            onClick={() => onToggleCollapsed?.(group.id)}
            className='rounded p-1 text-slate-300 hover:text-slate-500'
          >
            {group.is_collapsed ? (
              <ChevronRight className='h-3.5 w-3.5' />
            ) : (
              <ChevronDown className='h-3.5 w-3.5' />
            )}
          </button>
        )}
        <button
          type='button'
          onClick={onDelete}
          className='rounded p-1 text-slate-300 hover:text-red-500'
        >
          <Trash2 className='h-3.5 w-3.5' />
        </button>
      </div>

      {/* Field drop zone — hidden for container groups (they hold tab children, not fields directly) */}
      {group.type === 'container' ? (
        <div className='flex min-h-[44px] items-center justify-center px-3 py-2'>
          <p className='text-[11px] text-slate-300'>
            Assign tab groups to this container using the selector on each tab group
          </p>
        </div>
      ) : null}
      {group.type !== 'container' && (
        <DroppableFieldZone containerId={group.key}>
          <SortableContext
            items={fieldNames.map((f) => toSortableId(group.key, f))}
            strategy={rectSortingStrategy}
          >
            <div
              className={cn(
                'min-h-[52px] p-3',
                fieldNames.length === 0
                  ? 'flex items-center justify-center'
                  : 'grid grid-cols-12 gap-2 auto-rows-auto'
              )}
            >
              {fieldNames.length === 0 ? (
                <p className='text-[11px] text-slate-300'>Drop fields here</p>
              ) : (
                fieldNames.map((f) => {
                  if (f === OWNERS_FIELD) {
                    return (
                      <SortableFieldChip
                        key={toSortableId(group.key, f)}
                        sortableId={toSortableId(group.key, f)}
                        fieldName={f}
                        displayName='Owners'
                        fieldType='owners'
                        colSpan={getColSpan(f)}
                        onColSpan={(span) => onColSpan(f, span)}
                        onUnassign={onUnassign ? () => onUnassign(f, group.key) : undefined}
                        inGrid
                      />
                    )
                  }
                  if (f === PDF_FIELD) {
                    return (
                      <SortableFieldChip
                        key={toSortableId(group.key, f)}
                        sortableId={toSortableId(group.key, f)}
                        fieldName={f}
                        displayName='PDF Button'
                        fieldType='pdf'
                        colSpan={getColSpan(f)}
                        onColSpan={(span) => onColSpan(f, span)}
                        onUnassign={onUnassign ? () => onUnassign(f, group.key) : undefined}
                        extraControls={getExtraControls?.(f)}
                        inGrid
                      />
                    )
                  }
                  if (typeof f === 'string' && f.startsWith('__widget_') && f.endsWith('__')) {
                    const meta = widgetSlotMeta?.[f]
                    return (
                      <SortableFieldChip
                        key={toSortableId(group.key, f)}
                        sortableId={toSortableId(group.key, f)}
                        fieldName={f}
                        displayName={meta?.label_override || meta?.name || 'Widget'}
                        fieldType='widget'
                        colSpan={getColSpan(f)}
                        onColSpan={(span) => onColSpan(f, span)}
                        onUnassign={onUnassign ? () => onUnassign(f, group.key) : undefined}
                        extraControls={getExtraControls?.(f)}
                        inGrid
                      />
                    )
                  }
                  const ft = allFields.find((af) => af.field === f)
                  const settings = getFieldSettings?.(f)
                  const kind = getRelKind?.(f)
                  return (
                    <SortableFieldChip
                      key={toSortableId(group.key, f)}
                      sortableId={toSortableId(group.key, f)}
                      fieldName={f}
                      displayName={settings?.label || titleCase(f)}
                      fieldType={kind ?? getFriendlyType?.(ft?.type, f)}
                      abstractType={kind ? kind.toLowerCase() : ft?.type}
                      isM2O={kind === 'M2O'}
                      isM2M={kind === 'M2M'}
                      colSpan={getColSpan(f)}
                      onColSpan={(span) => onColSpan(f, span)}
                      fieldSettings={settings}
                      onSettings={
                        onFieldSettings ? (patch) => onFieldSettings(f, patch) : undefined
                      }
                      m2oFields={
                        kind === 'M2O' || kind === 'M2M' || kind === 'O2M'
                          ? getM2OFields?.()
                          : undefined
                      }
                      dependencyConfig={
                        kind === 'M2O' || kind === 'M2M' ? getDependencyConfig?.(f) : undefined
                      }
                      relatedCollection={
                        kind === 'M2O' || kind === 'M2M' || kind === 'O2M'
                          ? getRelatedCollection?.(f)
                          : undefined
                      }
                      onUnassign={onUnassign ? () => onUnassign(f, group.key) : undefined}
                      rowRevisions={getRowRevisions?.(f)}
                      onRowRevisionsChange={
                        onRowRevisions ? (v) => onRowRevisions(f, v) : undefined
                      }
                      allowRevisionRestore={getAllowRevisionRestore?.(f) ?? true}
                      onAllowRevisionRestoreChange={
                        onAllowRevisionRestore ? (v) => onAllowRevisionRestore(f, v) : undefined
                      }
                      lockConditions={getLockConditions?.(f) ?? []}
                      onLockConditionsChange={
                        onLockConditions ? (v) => onLockConditions(f, v) : undefined
                      }
                      extraControls={getExtraControls?.(f, {
                        isM2O: kind === 'M2O',
                        relatedCollection: getRelatedCollection?.(f)
                      })}
                      inlineDisplayConfig={kind === 'M2O' ? getInlineDisplay?.(f) : undefined}
                      onInlineDisplayChange={
                        kind === 'M2O' && onInlineDisplayChange
                          ? (config) => onInlineDisplayChange(f, config)
                          : undefined
                      }
                      collection={collection}
                      prefillFromParent={getPrefillFromParent?.(f)}
                      onPrefillFromParentChange={
                        onPrefillFromParent ? (v) => onPrefillFromParent(f, v) : undefined
                      }
                      inGrid
                    />
                  )
                })
              )}
            </div>
          </SortableContext>
        </DroppableFieldZone>
      )}
    </div>
  )
}

// ── DroppableFieldZone ────────────────────────────────────────────────────────

function DroppableFieldZone({
  containerId,
  children,
  className
}: {
  containerId: string
  children: React.ReactNode
  className?: string
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `drop:${containerId}` })
  return (
    <div
      ref={setNodeRef}
      className={cn('transition-colors', isOver && 'bg-nvr-cyan/[0.04]', className)}
    >
      {children}
    </div>
  )
}

// ─── Layouts tab ─────────────────────────────────────────────────────────────

interface CollectionLayout {
  id: number
  collection: string
  name: string
  slug?: string | null
  is_active: boolean | number
  sort: number
  disable_comments?: boolean | number
  disable_tasks?: boolean | number
  disable_revisions?: boolean | number
  disable_clone?: boolean | number
  disable_delete?: boolean | number
  accordion_mode?: boolean | number
  tab_mode?: string
  validate_before_next?: boolean | number
  summary_enabled?: boolean | number
  summary_show_all?: boolean | number
  summary_hide_empty?: boolean | number
  ai_enabled?: boolean | number
  allow_clone?: boolean | number
  allow_schedule?: boolean | number
  allow_disable_pickers?: boolean | number
  conditions?: { role_ids?: string[] } | null
  layout_type?: 'grouped' | 'table' | 'file' | 'addendum' | 'detail'
  addendum_layout_id?: number | null
  workflow_template_id?: string | null
  single_active_addendum?: boolean
  addendum_default_view?: boolean
  row_order_field?: string | null
  pdf_theme?: string | null
  pdf_template_id?: number | null
  pdf_cover_enabled?: boolean | number | null
  pdf_cover_title_field?: string | null
  pdf_cover_subtitle?: string | null
  pdf_show_logo?: boolean | number | null
  pdf_page_size?: string | null
  pdf_orientation?: string | null
  pdf_button_label?: string | null
}

function WorkflowCombobox({
  value,
  options,
  onChange
}: {
  value: string | null
  options: Array<{ id: string; name: string }>
  onChange: (val: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex max-w-[140px] items-center justify-between gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-border dark:bg-background'
        >
          <span className='truncate text-slate-700 dark:text-slate-200'>
            {selected?.name ?? 'None'}
          </span>
          <ChevronsUpDown className='h-3 w-3 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-48 p-0' align='end'>
        <Command>
          <CommandInput placeholder='Search…' className='h-7 text-[11px]' />
          <CommandList>
            <CommandItem
              value='__none__'
              onSelect={() => {
                onChange(null)
                setOpen(false)
              }}
              className='text-[11px]'
            >
              <Check
                className={cn('mr-1.5 h-3 w-3', value == null ? 'opacity-100' : 'opacity-0')}
              />
              None
            </CommandItem>
            {options.map((o) => (
              <CommandItem
                key={o.id}
                value={o.name}
                onSelect={() => {
                  onChange(o.id)
                  setOpen(false)
                }}
                className='text-[11px]'
              >
                <Check
                  className={cn('mr-1.5 h-3 w-3', value === o.id ? 'opacity-100' : 'opacity-0')}
                />
                {o.name}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function LayoutVisibilitySection({
  selected,
  roles,
  onChange
}: {
  selected: CollectionLayout
  roles: Array<{ id: string; name: string }>
  onChange: (roleIds: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const roleIds = selected.conditions?.role_ids ?? []
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id
  const available = roles.filter((r) => !roleIds.includes(r.id))

  const addRole = (id: string) => {
    if (!roleIds.includes(id)) onChange([...roleIds, id])
    setOpen(false)
  }
  const removeRole = (id: string) => onChange(roleIds.filter((x) => x !== id))

  return (
    <div className='space-y-1.5'>
      <span className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>Visibility</span>
      <div className='flex flex-wrap items-center gap-1.5'>
        {roleIds.length === 0 ? (
          <span className='text-[11px] text-slate-400 dark:text-slate-500'>
            Visible to everyone
          </span>
        ) : (
          roleIds.map((id) => (
            <span
              key={id}
              className='inline-flex items-center gap-1 rounded bg-nvr-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-nvr-cyan'
            >
              {roleName(id)}
              <button
                type='button'
                onClick={() => removeRole(id)}
                className='hover:text-nvr-navy dark:hover:text-white'
              >
                <X className='h-2.5 w-2.5' />
              </button>
            </span>
          ))
        )}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              disabled={available.length === 0}
              className='inline-flex items-center gap-1 rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-500 hover:border-nvr-cyan hover:text-nvr-cyan disabled:opacity-40 dark:border-border'
            >
              <Plus className='h-2.5 w-2.5' />
              Add role
            </button>
          </PopoverTrigger>
          <PopoverContent className='w-[200px] p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search roles…' className='h-8 text-[12px]' />
              <CommandList>
                <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                  No roles
                </CommandEmpty>
                <CommandGroup>
                  {available.map((r) => (
                    <CommandItem
                      key={r.id}
                      value={r.name}
                      onSelect={() => addRole(r.id)}
                      className='text-[12px]'
                    >
                      {r.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <p className='text-[10px] text-slate-400 dark:text-slate-500'>
        {roleIds.length === 0
          ? 'Shows for all users. Restrict to specific roles below.'
          : 'Only activates for users with the selected roles.'}
      </p>
    </div>
  )
}

function LayoutsTab({
  tableName,
  dbColumns
}: {
  tableName: string
  dbColumns: Array<{ name: string; data_type: string }>
}) {
  const qc = useQueryClient()
  const invalidateLayouts = useCallback(
    () => qc.invalidateQueries({ queryKey: ['collection-layouts', tableName] }),
    [qc, tableName]
  )

  const { data: layouts = [], isSuccess: layoutsLoaded } = useQuery<CollectionLayout[]>({
    queryKey: ['collection-layouts', tableName],
    queryFn: () =>
      api
        .get<{ data: CollectionLayout[] }>('/collection-layouts', {
          params: { collection: tableName }
        })
        .then((r) => r.data.data ?? []),
    enabled: !!tableName
  })

  const { data: roles = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['roles'],
    queryFn: () => api.get('/roles').then((r) => r.data.data ?? [])
  })

  const { data: workflowTemplates = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['workflow-templates-list'],
    queryFn: () => api.get('/pipelines').then((r) => r.data.data ?? [])
  })

  const { data: addendumLayouts = [] } = useQuery<Array<{ id: number; name: string }>>({
    queryKey: ['addendum-layouts-list', tableName],
    queryFn: () =>
      api
        .get('/collection-layouts', { params: { collection: tableName, layout_type: 'addendum' } })
        .then((r) => r.data.data ?? []),
    enabled: !!tableName
  })

  // Auto-seed "Default" layout for collections that have none yet
  useEffect(() => {
    if (layoutsLoaded && layouts.length === 0 && tableName) {
      api
        .post('/collection-layouts', { collection: tableName, name: 'Default', slug: 'default' })
        .then(() => qc.invalidateQueries({ queryKey: ['collection-layouts', tableName] }))
    }
  }, [layoutsLoaded, layouts.length, tableName, qc])

  const activeLayout = layouts.find((l) => l.is_active) ?? layouts[0] ?? null
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const effectiveId = selectedId ?? activeLayout?.id ?? null

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  function nameToSlug(name: string) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
  }

  const createMut = useMutation({
    mutationFn: (name: string) =>
      api.post('/collection-layouts', { collection: tableName, name, slug: nameToSlug(name) }),
    onSuccess: () => {
      invalidateLayouts()
      setAdding(false)
      setNewName('')
    },
    onError: () => toast.error('Failed to create layout')
  })

  const activateMut = useMutation({
    mutationFn: (id: number) => api.post(`/collection-layouts/${id}/activate`),
    onSuccess: () => {
      invalidateLayouts()
      toast.success('Layout activated')
    }
  })

  const cloneMut = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.post<{ data: CollectionLayout }>(`/collection-layouts/${id}/clone`, {
        name,
        slug: nameToSlug(name)
      }),
    onSuccess: (res) => {
      invalidateLayouts()
      setSelectedId(res.data.data.id)
      toast.success('Layout cloned')
    }
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/collection-layouts/${id}`),
    onSuccess: () => {
      invalidateLayouts()
      setSelectedId(null)
    },
    onError: () => toast.error('Cannot delete the only layout')
  })

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.patch(`/collection-layouts/${id}`, { name }),
    onSuccess: () => {
      invalidateLayouts()
      setEditingId(null)
    }
  })

  const patchLayoutMut = useMutation({
    mutationFn: (
      patch: { id: number } & Partial<
        Pick<
          CollectionLayout,
          | 'slug'
          | 'disable_comments'
          | 'disable_tasks'
          | 'disable_revisions'
          | 'disable_clone'
          | 'disable_delete'
          | 'accordion_mode'
          | 'tab_mode'
          | 'validate_before_next'
          | 'summary_enabled'
          | 'summary_show_all'
          | 'summary_hide_empty'
          | 'ai_enabled'
          | 'conditions'
          | 'allow_clone'
          | 'allow_schedule'
          | 'allow_disable_pickers'
          | 'layout_type'
          | 'row_order_field'
          | 'pdf_theme'
          | 'pdf_template_id'
          | 'pdf_cover_enabled'
          | 'pdf_cover_title_field'
          | 'pdf_cover_subtitle'
          | 'pdf_show_logo'
          | 'pdf_page_size'
          | 'pdf_orientation'
          | 'pdf_button_label'
          | 'is_active'
          | 'addendum_layout_id'
          | 'workflow_template_id'
          | 'single_active_addendum'
          | 'addendum_default_view'
        >
      >
    ) => {
      const { id, ...rest } = patch
      return api.patch(`/collection-layouts/${id}`, rest)
    },
    onSuccess: () => invalidateLayouts()
  })

  const selected = layouts.find((l) => l.id === effectiveId) ?? null
  const [settingsExpanded, setSettingsExpanded] = useState(false)
  const [slugDraft, setSlugDraft] = useState<string>('')
  const [slugEditing, setSlugEditing] = useState(false)

  // Sync slug draft when selection changes
  useEffect(() => {
    setSlugDraft(selected?.slug ?? '')
    setSlugEditing(false)
  }, [selected?.id])

  return (
    <div className='flex min-h-0 gap-4'>
      {/* Left sidebar */}
      <div className='flex w-[140px] shrink-0 flex-col gap-0.5 border-r border-slate-200 pr-3 dark:border-border'>
        <p className='mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400'>
          Layouts
        </p>
        {layouts.map((l) => (
          <div key={l.id} className='group relative'>
            {editingId === l.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (editingName.trim()) renameMut.mutate({ id: l.id, name: editingName.trim() })
                }}
              >
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={() => setEditingId(null)}
                  className='w-full rounded border border-nvr-cyan px-2 py-1 text-[11px] outline-none'
                />
              </form>
            ) : (
              <div
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] transition-colors',
                  effectiveId === l.id
                    ? 'bg-nvr-cyan/10 font-medium text-nvr-cyan'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                )}
              >
                <button
                  type='button'
                  onClick={() => setSelectedId(l.id)}
                  className='flex min-w-0 flex-1 items-center gap-1.5'
                >
                  {l.is_active ? (
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        l.layout_type === 'file'
                          ? 'bg-amber-400'
                          : l.layout_type === 'addendum'
                            ? 'bg-violet-400'
                            : l.layout_type === 'detail'
                              ? 'bg-emerald-400'
                              : 'bg-nvr-cyan'
                      )}
                    />
                  ) : (
                    <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-transparent' />
                  )}
                  <span className='truncate'>{l.name}</span>
                  {l.layout_type && l.layout_type !== 'grouped' && (
                    <span
                      className={cn(
                        'shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide',
                        l.layout_type === 'addendum'
                          ? 'bg-violet-100 text-violet-600 dark:bg-violet-900/40 dark:text-violet-400'
                          : l.layout_type === 'file'
                            ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400'
                            : l.layout_type === 'table'
                              ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400'
                              : l.layout_type === 'detail'
                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                                : ''
                      )}
                    >
                      {l.layout_type === 'addendum' ? 'addn' : l.layout_type}
                    </span>
                  )}
                </button>
                <button
                  type='button'
                  onClick={() => {
                    setEditingId(l.id)
                    setEditingName(l.name)
                  }}
                  className='shrink-0 opacity-0 transition-opacity group-hover:opacity-50 hover:!opacity-100'
                >
                  <Pencil className='h-3 w-3' />
                </button>
              </div>
            )}
          </div>
        ))}
        {adding ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (newName.trim()) createMut.mutate(newName.trim())
            }}
            className='mt-1'
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => {
                setAdding(false)
                setNewName('')
              }}
              placeholder='Layout name'
              className='w-full rounded border border-slate-300 px-2 py-1 text-[11px] outline-none focus:border-nvr-cyan dark:border-border'
            />
          </form>
        ) : (
          <button
            type='button'
            onClick={() => setAdding(true)}
            className='mt-1 flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
          >
            <span>+ Add layout</span>
          </button>
        )}
      </div>

      {/* Right panel */}
      <div className='min-h-0 flex-1'>
        {selected && (
          <div className='mb-3 flex items-center gap-2'>
            <span className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
              {selected.name}
            </span>
            {selected.layout_type === 'file' ? (
              <button
                type='button'
                onClick={() =>
                  patchLayoutMut.mutate({ id: selected.id, is_active: !selected.is_active })
                }
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                  selected.is_active
                    ? 'bg-nvr-cyan/10 text-nvr-cyan hover:bg-nvr-cyan/20'
                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-muted dark:text-slate-400 dark:hover:bg-slate-700'
                )}
              >
                {selected.is_active ? 'PDF Export Active' : 'Enable PDF Export'}
              </button>
            ) : selected.is_active ? (
              <span className='rounded bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-cyan'>
                Default Layout
              </span>
            ) : (
              <button
                type='button'
                onClick={() => activateMut.mutate(selected.id)}
                className='rounded bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-cyan hover:bg-nvr-cyan/20'
              >
                Set Default Layout
              </button>
            )}
            <div className='ml-auto flex items-center gap-1'>
              <button
                type='button'
                onClick={() =>
                  cloneMut.mutate({ id: selected.id, name: `${selected.name} (copy)` })
                }
                className='rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
              >
                Clone
              </button>
              {confirmDeleteId === selected.id ? (
                <>
                  <span className='text-[10px] text-slate-500'>Delete?</span>
                  <button
                    type='button'
                    onClick={() => {
                      deleteMut.mutate(selected.id)
                      setConfirmDeleteId(null)
                    }}
                    className='rounded px-2 py-0.5 text-[10px] text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                  >
                    Yes
                  </button>
                  <button
                    type='button'
                    onClick={() => setConfirmDeleteId(null)}
                    className='rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100'
                  >
                    No
                  </button>
                </>
              ) : (
                <button
                  type='button'
                  onClick={() => setConfirmDeleteId(selected.id)}
                  className='rounded px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        )}
        {selected && (
          <div className='mb-3 rounded-md border border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/30'>
            {/* Collapsed summary row */}
            <button
              type='button'
              onClick={() => setSettingsExpanded((v) => !v)}
              className='flex w-full items-center gap-2 px-3 py-2 text-left'
            >
              <span className='text-[11px] font-medium text-slate-500 dark:text-slate-400'>
                Settings
              </span>
              <div className='flex flex-1 flex-wrap items-center gap-1.5'>
                {!!selected.summary_enabled && (
                  <span className='rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-muted dark:text-slate-300'>
                    summary
                  </span>
                )}
                {!!selected.ai_enabled && (
                  <span className='rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-muted dark:text-slate-300'>
                    AI
                  </span>
                )}
                {selected.layout_type === 'file' && (
                  <span className='rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-muted dark:text-slate-300'>
                    PDF · {selected.pdf_theme ?? 'classic'}
                  </span>
                )}
                {(selected.conditions?.role_ids?.length ?? 0) > 0 && (
                  <span className='rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-muted dark:text-slate-300'>
                    {selected.conditions?.role_ids?.length}{' '}
                    {(selected.conditions?.role_ids?.length ?? 0) === 1 ? 'role' : 'roles'}
                  </span>
                )}
              </div>
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150',
                  settingsExpanded && 'rotate-180'
                )}
              />
            </button>

            {/* Expanded edit panel */}
            {settingsExpanded && (
              <div className='space-y-2 border-t border-slate-200 px-3 py-3 dark:border-border'>
                <div className='space-y-1'>
                  <label className='block text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                    Machine name (slug)
                  </label>
                  <div className='flex items-center gap-1.5'>
                    <input
                      value={slugDraft}
                      onChange={(e) => {
                        setSlugDraft(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))
                        setSlugEditing(true)
                      }}
                      onBlur={() => {
                        if (slugEditing && selected) {
                          patchLayoutMut.mutate({ id: selected.id, slug: slugDraft || null })
                          setSlugEditing(false)
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && selected) {
                          patchLayoutMut.mutate({ id: selected.id, slug: slugDraft || null })
                          setSlugEditing(false)
                          e.currentTarget.blur()
                        }
                      }}
                      placeholder='e.g. my_layout'
                      className='flex-1 rounded border border-slate-200 bg-white px-2 py-1 font-mono text-[11px] text-slate-700 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200'
                    />
                    {!slugDraft && selected?.name && (
                      <button
                        type='button'
                        onClick={() => {
                          const gen = selected.name
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, '_')
                            .replace(/^_|_$/g, '')
                          setSlugDraft(gen)
                          patchLayoutMut.mutate({ id: selected.id, slug: gen })
                        }}
                        className='shrink-0 rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-400 hover:border-nvr-cyan hover:text-nvr-cyan'
                      >
                        Generate
                      </button>
                    )}
                  </div>
                  <p className='text-[10px] text-slate-400'>
                    Used to reference this layout in code. Only a–z, 0–9, and _.
                  </p>
                </div>
                <div className='flex items-center justify-between border-t border-slate-200 pt-2 dark:border-border'>
                  <span className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                    Layout type
                  </span>
                  <div className='flex items-center rounded-md border border-slate-200 bg-white dark:border-border dark:bg-background overflow-hidden'>
                    {(['grouped', 'table', 'file', 'addendum', 'detail'] as const).map((lt) => (
                      <button
                        key={lt}
                        type='button'
                        onClick={() => patchLayoutMut.mutate({ id: selected.id, layout_type: lt })}
                        className={cn(
                          'px-2.5 py-1 text-[11px] font-medium transition-colors capitalize',
                          (selected.layout_type ?? 'grouped') === lt
                            ? 'bg-[#172940] text-white dark:bg-[#00ceff] dark:text-[#172940]'
                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
                        )}
                      >
                        {lt === 'addendum'
                          ? 'Addendum Form'
                          : lt === 'detail'
                            ? 'Detail (drill-down)'
                            : lt}
                      </button>
                    ))}
                  </div>
                </div>
                {selected.layout_type === 'addendum' && (
                  <div className='space-y-2'>
                    <div className='flex items-center justify-between border-t border-slate-200 pt-2 dark:border-border'>
                      <span className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                        Workflow
                      </span>
                      <WorkflowCombobox
                        value={selected.workflow_template_id ?? null}
                        options={workflowTemplates}
                        onChange={(val) =>
                          patchLayoutMut.mutate({ id: selected.id, workflow_template_id: val })
                        }
                      />
                    </div>
                    <label className='flex cursor-pointer items-center justify-between'>
                      <div>
                        <span className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                          One at a time
                        </span>
                        <p className='text-[10px] text-slate-400 dark:text-slate-500'>
                          Block new addendum while one is active
                        </p>
                      </div>
                      <input
                        type='checkbox'
                        checked={!!selected.single_active_addendum}
                        onChange={(e) =>
                          patchLayoutMut.mutate({
                            id: selected.id,
                            single_active_addendum: e.target.checked
                          })
                        }
                        className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                      />
                    </label>
                  </div>
                )}
                {(selected.layout_type == null || selected.layout_type === 'grouped') && (
                  <>
                    <div className='flex items-center justify-between border-t border-slate-200 pt-2 dark:border-border'>
                      <span className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                        Addendum form
                      </span>
                      <select
                        value={selected.addendum_layout_id ?? ''}
                        onChange={(e) =>
                          patchLayoutMut.mutate({
                            id: selected.id,
                            addendum_layout_id: e.target.value ? Number(e.target.value) : null
                          })
                        }
                        className='max-w-[140px] rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-border dark:bg-background'
                      >
                        <option value=''>Collection default</option>
                        {addendumLayouts.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <label className='flex cursor-pointer items-center justify-between'>
                      <div>
                        <span className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                          Default to addendum view
                        </span>
                        <p className='text-[10px] text-slate-400 dark:text-slate-500'>
                          Show active addendum changes first on item open
                        </p>
                      </div>
                      <input
                        type='checkbox'
                        checked={!!selected.addendum_default_view}
                        onChange={(e) =>
                          patchLayoutMut.mutate({
                            id: selected.id,
                            addendum_default_view: e.target.checked
                          })
                        }
                        className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                      />
                    </label>
                  </>
                )}
                {selected.layout_type !== 'addendum' && (
                  <>
                    {(selected.layout_type ?? 'grouped') !== 'table' && (
                      <>
                        <div className='border-t border-slate-200 dark:border-border pt-2 space-y-1.5'>
                          <label className='flex cursor-pointer items-center justify-between'>
                            <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                              Summary panel
                            </span>
                            <input
                              type='checkbox'
                              checked={!!selected.summary_enabled}
                              onChange={(e) =>
                                patchLayoutMut.mutate({
                                  id: selected.id,
                                  summary_enabled: e.target.checked
                                })
                              }
                              className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                            />
                          </label>
                          {!!selected.summary_enabled && (
                            <label className='flex cursor-pointer items-center justify-between'>
                              <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                                Show all fields in summary
                              </span>
                              <input
                                type='checkbox'
                                checked={!!selected.summary_show_all}
                                onChange={(e) =>
                                  patchLayoutMut.mutate({
                                    id: selected.id,
                                    summary_show_all: e.target.checked
                                  })
                                }
                                className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                              />
                            </label>
                          )}
                          {!!selected.summary_enabled && (
                            <label className='flex cursor-pointer items-center justify-between'>
                              <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                                Hide fields with no values
                              </span>
                              <input
                                type='checkbox'
                                checked={!!selected.summary_hide_empty}
                                onChange={(e) =>
                                  patchLayoutMut.mutate({
                                    id: selected.id,
                                    summary_hide_empty: e.target.checked
                                  })
                                }
                                className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                              />
                            </label>
                          )}
                        </div>
                      </>
                    )}
                    {(selected.layout_type ?? 'grouped') === 'table' && (
                      <div className='border-t border-slate-200 dark:border-border pt-2 space-y-2'>
                        <label className='flex cursor-pointer items-center justify-between'>
                          <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                            Allow row reordering
                          </span>
                          <input
                            type='checkbox'
                            checked={!!selected.row_order_field}
                            onChange={(e) =>
                              patchLayoutMut.mutate({
                                id: selected.id,
                                row_order_field: e.target.checked
                                  ? (dbColumns.find((c) =>
                                      NUMERIC_DATA_TYPES.has(c.data_type.toLowerCase())
                                    )?.name ?? null)
                                  : null
                              })
                            }
                            className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                          />
                        </label>
                        {!!selected.row_order_field && (
                          <div>
                            <p className='text-[10px] text-slate-400 mb-1'>Order field</p>
                            <select
                              value={selected.row_order_field ?? ''}
                              onChange={(e) =>
                                patchLayoutMut.mutate({
                                  id: selected.id,
                                  row_order_field: e.target.value || null
                                })
                              }
                              className='w-full h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-slate-700 dark:border-border dark:bg-background dark:text-slate-300'
                            >
                              <option value=''>— select field —</option>
                              {dbColumns
                                .filter((c) => NUMERIC_DATA_TYPES.has(c.data_type.toLowerCase()))
                                .map((c) => (
                                  <option key={c.name} value={c.name}>
                                    {c.name}
                                  </option>
                                ))}
                            </select>
                          </div>
                        )}
                      </div>
                    )}
                    {(selected.layout_type ?? 'grouped') === 'file' && (
                      <div className='border-t border-slate-200 dark:border-border pt-2 space-y-3'>
                        <p className='text-[10px] font-semibold text-slate-400 dark:text-slate-500 mb-1'>
                          PDF Settings
                        </p>

                        {/* Theme */}
                        <div className='space-y-1'>
                          <label className='block text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                            Theme
                          </label>
                          <div className='flex gap-1.5'>
                            {(['classic', 'minimal', 'executive'] as const).map((t) => (
                              <button
                                key={t}
                                type='button'
                                onClick={() =>
                                  patchLayoutMut.mutate({ id: selected.id, pdf_theme: t })
                                }
                                className={cn(
                                  'flex-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors capitalize',
                                  (selected.pdf_theme ?? 'classic') === t
                                    ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan'
                                    : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-border dark:hover:border-slate-600'
                                )}
                              >
                                {t}
                              </button>
                            ))}
                          </div>
                          <button
                            type='button'
                            onClick={() =>
                              patchLayoutMut.mutate({ id: selected.id, pdf_theme: 'custom' })
                            }
                            className={cn(
                              'w-full rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors',
                              selected.pdf_theme === 'custom'
                                ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan'
                                : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-border'
                            )}
                          >
                            Custom template
                          </button>
                          {selected.pdf_theme === 'custom' && (
                            <div className='space-y-1'>
                              <p className='text-[10px] text-slate-400'>
                                Enter the ID of a template from Settings → PDF Templates
                              </p>
                              <input
                                type='number'
                                placeholder='Template ID'
                                value={selected.pdf_template_id ?? ''}
                                onChange={(e) =>
                                  patchLayoutMut.mutate({
                                    id: selected.id,
                                    pdf_template_id: e.target.value ? Number(e.target.value) : null
                                  })
                                }
                                className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200'
                              />
                            </div>
                          )}
                        </div>

                        {/* Cover page */}
                        <div className='space-y-1.5'>
                          <label className='flex cursor-pointer items-center justify-between'>
                            <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                              Cover page
                            </span>
                            <input
                              type='checkbox'
                              checked={Boolean(selected.pdf_cover_enabled ?? true)}
                              onChange={(e) =>
                                patchLayoutMut.mutate({
                                  id: selected.id,
                                  pdf_cover_enabled: e.target.checked
                                })
                              }
                              className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                            />
                          </label>
                          {Boolean(selected.pdf_cover_enabled ?? true) && (
                            <>
                              <div>
                                <p className='text-[10px] text-slate-400 mb-1'>
                                  Title field (collection field key, e.g. "name")
                                </p>
                                <input
                                  type='text'
                                  placeholder='e.g. name'
                                  value={selected.pdf_cover_title_field ?? ''}
                                  onChange={(e) =>
                                    patchLayoutMut.mutate({
                                      id: selected.id,
                                      pdf_cover_title_field: e.target.value || null
                                    })
                                  }
                                  className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200'
                                />
                              </div>
                              <div>
                                <p className='text-[10px] text-slate-400 mb-1'>
                                  Subtitle (static text)
                                </p>
                                <input
                                  type='text'
                                  placeholder='e.g. Procurement Summary Q4 2026'
                                  value={selected.pdf_cover_subtitle ?? ''}
                                  onChange={(e) =>
                                    patchLayoutMut.mutate({
                                      id: selected.id,
                                      pdf_cover_subtitle: e.target.value || null
                                    })
                                  }
                                  className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200'
                                />
                              </div>
                            </>
                          )}
                        </div>

                        {/* Button label */}
                        <div className='space-y-1'>
                          <label className='block text-[11px] font-medium text-slate-600 dark:text-slate-300'>
                            Button label
                          </label>
                          <input
                            type='text'
                            placeholder='Download PDF'
                            value={selected.pdf_button_label ?? ''}
                            onChange={(e) =>
                              patchLayoutMut.mutate({
                                id: selected.id,
                                pdf_button_label: e.target.value || null
                              })
                            }
                            className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200'
                          />
                          <p className='text-[10px] text-slate-400'>
                            Text shown on the download button. Default: "Download PDF"
                          </p>
                        </div>

                        {/* Page settings */}
                        <div className='space-y-1.5'>
                          <label className='flex cursor-pointer items-center justify-between'>
                            <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                              Include logo
                            </span>
                            <input
                              type='checkbox'
                              checked={Boolean(selected.pdf_show_logo ?? true)}
                              onChange={(e) =>
                                patchLayoutMut.mutate({
                                  id: selected.id,
                                  pdf_show_logo: e.target.checked
                                })
                              }
                              className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                            />
                          </label>
                          <div className='flex gap-2'>
                            <div className='flex-1'>
                              <p className='text-[10px] text-slate-400 mb-1'>Page size</p>
                              <div className='flex rounded-md border border-slate-200 bg-white overflow-hidden dark:border-border dark:bg-background'>
                                {(['A4', 'Letter'] as const).map((sz) => (
                                  <button
                                    key={sz}
                                    type='button'
                                    onClick={() =>
                                      patchLayoutMut.mutate({ id: selected.id, pdf_page_size: sz })
                                    }
                                    className={cn(
                                      'flex-1 py-1 text-[11px] font-medium transition-colors',
                                      (selected.pdf_page_size ?? 'A4') === sz
                                        ? 'bg-[#172940] text-white dark:bg-[#00ceff] dark:text-[#172940]'
                                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
                                    )}
                                  >
                                    {sz}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className='flex-1'>
                              <p className='text-[10px] text-slate-400 mb-1'>Orientation</p>
                              <div className='flex rounded-md border border-slate-200 bg-white overflow-hidden dark:border-border dark:bg-background'>
                                {(['portrait', 'landscape'] as const).map((o) => (
                                  <button
                                    key={o}
                                    type='button'
                                    onClick={() =>
                                      patchLayoutMut.mutate({ id: selected.id, pdf_orientation: o })
                                    }
                                    className={cn(
                                      'flex-1 py-1 text-[11px] font-medium transition-colors capitalize',
                                      (selected.pdf_orientation ?? 'portrait') === o
                                        ? 'bg-[#172940] text-white dark:bg-[#00ceff] dark:text-[#172940]'
                                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
                                    )}
                                  >
                                    {o.slice(0, 4)}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Preview */}
                        <button
                          type='button'
                          onClick={() =>
                            window.open(
                              `/api/collection-layouts/${selected.id}/preview-html`,
                              '_blank'
                            )
                          }
                          className='w-full rounded-md border border-dashed border-slate-300 py-1.5 text-[11px] text-slate-500 transition-colors hover:border-nvr-cyan hover:text-nvr-cyan dark:border-border dark:text-slate-400'
                        >
                          Preview theme →
                        </button>
                      </div>
                    )}
                    <div className='border-t border-slate-200 dark:border-border pt-2 space-y-1.5'>
                      <label className='flex cursor-pointer items-center justify-between'>
                        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                          Enable AI features
                        </span>
                        <input
                          type='checkbox'
                          checked={!!selected.ai_enabled}
                          onChange={(e) =>
                            patchLayoutMut.mutate({ id: selected.id, ai_enabled: e.target.checked })
                          }
                          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                        />
                      </label>
                      <label className='flex cursor-pointer items-center justify-between'>
                        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                          Accordion mode (one section open)
                        </span>
                        <input
                          type='checkbox'
                          checked={!!selected.accordion_mode}
                          onChange={(e) =>
                            patchLayoutMut.mutate({
                              id: selected.id,
                              accordion_mode: e.target.checked
                            })
                          }
                          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                        />
                      </label>
                    </div>
                    <div className='border-t border-slate-200 dark:border-border pt-2 space-y-1.5'>
                      <p className='text-[10px] font-semibold text-slate-400 dark:text-slate-500 mb-1'>
                        Hide panels
                      </p>
                      <label className='flex cursor-pointer items-center justify-between'>
                        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                          Hide revisions
                        </span>
                        <input
                          type='checkbox'
                          checked={!!selected.disable_revisions}
                          onChange={(e) =>
                            patchLayoutMut.mutate({
                              id: selected.id,
                              disable_revisions: e.target.checked
                            })
                          }
                          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                        />
                      </label>
                      <label className='flex cursor-pointer items-center justify-between'>
                        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                          Hide comments
                        </span>
                        <input
                          type='checkbox'
                          checked={!!selected.disable_comments}
                          onChange={(e) =>
                            patchLayoutMut.mutate({
                              id: selected.id,
                              disable_comments: e.target.checked
                            })
                          }
                          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                        />
                      </label>
                      <label className='flex cursor-pointer items-center justify-between'>
                        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                          Hide tasks
                        </span>
                        <input
                          type='checkbox'
                          checked={!!selected.disable_tasks}
                          onChange={(e) =>
                            patchLayoutMut.mutate({
                              id: selected.id,
                              disable_tasks: e.target.checked
                            })
                          }
                          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                        />
                      </label>
                      <label className='flex cursor-pointer items-center justify-between'>
                        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                          Hide clone button
                        </span>
                        <input
                          type='checkbox'
                          checked={!!selected.disable_clone}
                          onChange={(e) =>
                            patchLayoutMut.mutate({
                              id: selected.id,
                              disable_clone: e.target.checked
                            })
                          }
                          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                        />
                      </label>
                      <label className='flex cursor-pointer items-center justify-between'>
                        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                          Hide delete button
                        </span>
                        <input
                          type='checkbox'
                          checked={!!selected.disable_delete}
                          onChange={(e) =>
                            patchLayoutMut.mutate({
                              id: selected.id,
                              disable_delete: e.target.checked
                            })
                          }
                          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                        />
                      </label>
                    </div>
                    <div className='border-t border-slate-200 dark:border-border pt-2 space-y-1.5'>
                      <p className='text-[10px] font-semibold text-slate-400 dark:text-slate-500 mb-1'>
                        Show for all users
                      </p>
                      <label className='flex cursor-pointer items-center justify-between'>
                        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                          Clone button
                        </span>
                        <input
                          type='checkbox'
                          checked={!!selected.allow_clone}
                          onChange={(e) =>
                            patchLayoutMut.mutate({
                              id: selected.id,
                              allow_clone: e.target.checked
                            })
                          }
                          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                        />
                      </label>
                      <label className='flex cursor-pointer items-center justify-between'>
                        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                          Schedule button
                        </span>
                        <input
                          type='checkbox'
                          checked={!!selected.allow_schedule}
                          onChange={(e) =>
                            patchLayoutMut.mutate({
                              id: selected.id,
                              allow_schedule: e.target.checked
                            })
                          }
                          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                        />
                      </label>
                      <label className='flex cursor-pointer items-center justify-between'>
                        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                          Disable in pickers button
                        </span>
                        <input
                          type='checkbox'
                          checked={!!selected.allow_disable_pickers}
                          onChange={(e) =>
                            patchLayoutMut.mutate({
                              id: selected.id,
                              allow_disable_pickers: e.target.checked
                            })
                          }
                          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                        />
                      </label>
                    </div>
                    <div className='border-t border-slate-200 dark:border-border pt-2'>
                      <LayoutVisibilitySection
                        selected={selected}
                        roles={roles}
                        onChange={(roleIds) =>
                          patchLayoutMut.mutate({
                            id: selected.id,
                            conditions: roleIds.length > 0 ? { role_ids: roleIds } : null
                          })
                        }
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        <FieldGroupsTab
          tableName={tableName}
          dbColumns={dbColumns}
          layoutId={effectiveId}
          layoutType={
            selected?.layout_type === 'table'
              ? 'table'
              : selected?.layout_type === 'addendum'
                ? 'addendum'
                : 'grouped'
          }
        />
      </div>
    </div>
  )
}

// ── LayoutTab ─────────────────────────────────────────────────────────────────

function PdfFieldConfig({
  tableName,
  value,
  filenameTemplate,
  onChange,
  onFilenameChange
}: {
  tableName: string
  value: string | null | undefined
  filenameTemplate: string | null | undefined
  onChange: (v: string | null) => void
  onFilenameChange: (v: string | null) => void
}) {
  const { data: relData } = useQuery({
    queryKey: ['relations-for', tableName],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            id: number
            many_collection: string
            many_field: string
            one_collection: string | null
            one_field: string | null
            junction_field: string | null
          }>
        }>(`/data-model/relations/for/${tableName}`)
        .then((r) => r.data.data ?? []),
    enabled: !!tableName,
    staleTime: 30_000
  })

  // Find M2M fields on this collection that point to nivaro_files
  const fileFields = useMemo(() => {
    if (!relData) return []
    const junctions = relData.filter(
      (r) => r.one_collection === tableName && r.junction_field != null
    )
    const results: Array<{ field: string; junction: string }> = []
    const seen = new Set<string>()
    for (const jr of junctions) {
      if (seen.has(jr.many_collection)) continue
      // Primary: companion row explicitly points to nivaro_files
      const companion = relData.find(
        (r) => r.many_collection === jr.many_collection && r.one_collection === 'nivaro_files'
      )
      // Fallback: single-row M2M where junction_field or junction table name hints at files
      const jf = jr.junction_field ?? ''
      const looksLikeFiles = !!companion || /file/i.test(jf) || /file/i.test(jr.many_collection)
      if (!looksLikeFiles) continue
      seen.add(jr.many_collection)
      // Derive display name: skip 'id' (it's the PK ref, not a useful alias)
      const fieldName =
        jr.one_field && jr.one_field !== 'id'
          ? jr.one_field
          : jr.many_collection
              .replace(new RegExp(`^${tableName}_?|_?${tableName}$`, 'i'), '')
              .replace(/^_|_$/g, '') || jr.many_collection
      results.push({ field: fieldName, junction: jr.many_collection })
    }
    return results
  }, [relData, tableName])

  const [open, setOpen] = useState(false)
  const selected = fileFields.find((f) => f.field === value) ?? null

  return (
    <div className='mt-1.5 space-y-1'>
      <p className='text-[10px] font-medium text-slate-400 uppercase tracking-wide'>
        Attach PDF to field
      </p>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex w-full items-center justify-between rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 hover:border-nvr-cyan/50 dark:border-border dark:bg-card dark:text-slate-200'
          >
            <span>
              {selected ? (
                selected.field
              ) : (
                <span className='text-slate-400'>Select file field…</span>
              )}
            </span>
            <ChevronDown className='h-3 w-3 text-slate-400' />
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-56 p-0' align='start'>
          <Command>
            <CommandInput placeholder='Search fields…' className='text-[12px]' />
            <CommandList>
              <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
                {fileFields.length === 0 ? 'No file M2M fields found' : 'No match'}
              </CommandEmpty>
              {value && (
                <CommandItem
                  value='__clear__'
                  onSelect={() => {
                    onChange(null)
                    setOpen(false)
                  }}
                  className='text-[11px] text-slate-400'
                >
                  Clear
                </CommandItem>
              )}
              {fileFields.map((f) => (
                <CommandItem
                  key={f.field}
                  value={f.field}
                  onSelect={() => {
                    onChange(f.field)
                    setOpen(false)
                  }}
                  className='text-[11px]'
                >
                  {f.field}
                  <span className='ml-auto text-[10px] text-slate-400 truncate'>{f.junction}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <div className='mt-2 space-y-1'>
        <p className='text-[10px] font-medium text-slate-400 uppercase tracking-wide'>
          Filename template
        </p>
        <input
          type='text'
          value={filenameTemplate ?? ''}
          onChange={(e) => onFilenameChange(e.target.value || null)}
          placeholder='e.g. {{title}}-report'
          className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 placeholder:text-slate-300 focus:border-nvr-cyan/50 focus:outline-none dark:border-border dark:bg-card dark:text-slate-200'
        />
        <p className='text-[10px] text-slate-400'>
          Use {'{{field}}'} tokens. Defaults to template name.
        </p>
      </div>
    </div>
  )
}

function PdfFieldConfigButton({
  tableName,
  value,
  filenameTemplate,
  onChange,
  onFilenameChange
}: {
  tableName: string
  value: string | null | undefined
  filenameTemplate: string | null | undefined
  onChange: (v: string | null) => void
  onFilenameChange: (v: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div onPointerDown={(e) => e.stopPropagation()}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            title='PDF settings'
            className='shrink-0 rounded p-0.5 text-slate-300 hover:text-nvr-cyan'
          >
            <Settings2 className='h-3 w-3' />
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-72 p-3' align='end'>
          <PdfFieldConfig
            tableName={tableName}
            value={value}
            filenameTemplate={filenameTemplate}
            onChange={onChange}
            onFilenameChange={onFilenameChange}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

function SortableSlotCard({
  slotKey,
  slots,
  updateSlot,
  editingSlot,
  setEditingSlot,
  slotLabelDraft,
  setSlotLabelDraft,
  tableName
}: {
  slotKey: SlotKey
  slots: Record<SlotKey, SlotState>
  updateSlot: (key: SlotKey, patch: Partial<SlotState>) => void
  editingSlot: SlotKey | null
  setEditingSlot: (k: SlotKey | null) => void
  slotLabelDraft: string
  setSlotLabelDraft: (v: string) => void
  tableName: string
}) {
  const meta = SLOT_META[slotKey]
  const s = slots[slotKey]
  const label = s.label_override?.trim() || meta.defaultLabel
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `slot:${slotKey}`,
    data: { type: 'slot' }
  })
  const isEditing = editingSlot === slotKey
  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Transform.toString(transform), transition }}
      className={cn(
        'rounded-lg border border-dashed border-slate-200 bg-slate-50',
        isDragging && 'opacity-0'
      )}
    >
      <div className='flex items-center gap-2 px-3 py-2'>
        <button
          type='button'
          {...attributes}
          {...listeners}
          className='cursor-grab text-slate-300 hover:text-slate-500 active:cursor-grabbing'
        >
          <GripVertical className='h-3.5 w-3.5' />
        </button>
        <span className='shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500'>
          {meta.name}
        </span>
        {meta.editable && isEditing ? (
          <input
            autoFocus
            value={slotLabelDraft}
            onChange={(e) => setSlotLabelDraft(e.target.value)}
            onBlur={() => {
              const v = slotLabelDraft.trim()
              updateSlot(slotKey, { label_override: v && v !== meta.defaultLabel ? v : null })
              setEditingSlot(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditingSlot(null)
            }}
            placeholder={meta.defaultLabel}
            className='flex-1 rounded border border-nvr-cyan/50 bg-white px-1.5 py-0.5 text-[12px] font-medium text-slate-800 outline-none ring-1 ring-nvr-cyan/30'
          />
        ) : meta.editable ? (
          <button
            type='button'
            onClick={() => {
              setSlotLabelDraft(label)
              setEditingSlot(slotKey)
            }}
            className='group/slot flex flex-1 items-center gap-1 truncate text-left text-[12px] font-medium text-slate-700 hover:text-nvr-cyan'
          >
            <span className='truncate'>{label}</span>
            <Pencil className='h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/slot:opacity-50' />
          </button>
        ) : (
          <span className='flex-1 truncate text-[12px] font-medium text-slate-700'>{label}</span>
        )}
        {!s.is_visible && (
          <span className='shrink-0 rounded bg-slate-500 px-1.5 py-0.5 text-[10px] font-medium text-white'>
            hidden
          </span>
        )}
        <button
          type='button'
          title={s.default_expanded ? 'Start collapsed' : 'Start expanded'}
          onClick={() => updateSlot(slotKey, { default_expanded: !s.default_expanded })}
          className='shrink-0 rounded p-1 text-slate-400 hover:text-nvr-cyan'
        >
          {s.default_expanded ? (
            <ChevronDown className='h-3.5 w-3.5' />
          ) : (
            <ChevronRight className='h-3.5 w-3.5' />
          )}
        </button>
        {slotKey === '__pipeline__' && (
          <button
            type='button'
            title={
              s.show_approval_chain ? 'Hide approval chain button' : 'Show approval chain button'
            }
            onClick={() => updateSlot(slotKey, { show_approval_chain: !s.show_approval_chain })}
            className={cn(
              'shrink-0 rounded p-1 transition-colors',
              s.show_approval_chain ? 'text-nvr-cyan' : 'text-slate-400 hover:text-nvr-cyan'
            )}
          >
            <Users className='h-3.5 w-3.5' />
          </button>
        )}
        <button
          type='button'
          title={s.is_visible ? 'Hide' : 'Show'}
          onClick={() => updateSlot(slotKey, { is_visible: !s.is_visible })}
          className='shrink-0 rounded p-1 text-slate-400 hover:text-nvr-cyan'
        >
          {s.is_visible ? <Eye className='h-3.5 w-3.5' /> : <EyeOff className='h-3.5 w-3.5' />}
        </button>
      </div>
    </div>
  )
}

type InlineDisplayEntry = {
  field: string
  label: string | null
  format: string | null
  line_break?: boolean
}
type InlineDisplayConfig = { entries: InlineDisplayEntry[]; separator: string | null }
type SubtitleField = {
  field: string
  label: string | null
  color?: string
  weight?: string
  display_as?: string
}

function InlineDisplaySection({
  relatedCollection,
  entries,
  separator,
  onChange,
  onSeparatorChange
}: {
  relatedCollection: string
  entries: InlineDisplayEntry[]
  separator: string | null
  onChange: (entries: InlineDisplayEntry[]) => void
  onSeparatorChange: (sep: string | null) => void
}) {
  const { data: relFields = [] } = useQuery<Array<{ field: string; label?: string }>>({
    queryKey: ['field-config', relatedCollection],
    queryFn: () =>
      api.get(`/field-config/${relatedCollection}`).then((r) => r.data?.data ?? r.data ?? []),
    staleTime: 60_000
  })
  const fieldOptions = (relFields as Array<{ field: string; label?: string }>)
    .filter((f) => !f.field.startsWith('__'))
    .map((f) => ({ value: f.field, label: f.label || f.field }))
  const FORMAT_OPTS = [
    { value: 'text', label: 'Text' },
    { value: 'date', label: 'Date' },
    { value: 'datetime', label: 'Date & Time' },
    { value: 'boolean', label: 'Yes / No' }
  ]
  return (
    <div className='mt-1.5 space-y-1.5 border-t border-slate-100 pt-1.5'>
      <p className='text-[9px] font-semibold uppercase tracking-wider text-slate-400'>
        Inline display
      </p>
      <div className='flex gap-1 mt-1'>
        <button
          type='button'
          onClick={() => onSeparatorChange(null)}
          className={cn(
            'flex-1 rounded border px-2 py-0.5 text-[10px]',
            separator === null
              ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
              : 'border-slate-200 text-slate-500 hover:border-slate-300'
          )}
        >
          Stacked
        </button>
        <button
          type='button'
          onClick={() => onSeparatorChange(separator ?? ', ')}
          className={cn(
            'flex-1 rounded border px-2 py-0.5 text-[10px]',
            separator !== null
              ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
              : 'border-slate-200 text-slate-500 hover:border-slate-300'
          )}
        >
          Inline
        </button>
      </div>
      {separator !== null && (
        <div className='flex items-center gap-1.5 mt-1'>
          <span className='text-[10px] text-slate-400 shrink-0'>Separator</span>
          <input
            type='text'
            value={separator}
            onChange={(e) => onSeparatorChange(e.target.value)}
            className='flex-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
            placeholder=', '
          />
        </div>
      )}
      {entries.map((entry, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable config order
        <div key={i} className='space-y-1'>
          {separator !== null && i > 0 && (
            <button
              type='button'
              title={entry.line_break ? 'Remove line break' : 'Start new line before this field'}
              onClick={() =>
                onChange(entries.map((e, j) => (j === i ? { ...e, line_break: !e.line_break } : e)))
              }
              className={cn(
                'flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 border transition-colors',
                entry.line_break
                  ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                  : 'border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-600'
              )}
            >
              <CornerDownLeft className='h-3 w-3' />
              New line
            </button>
          )}
          <div className='flex items-center gap-1'>
            <div className='flex-1 min-w-0'>
              <Combobox
                value={entry.field}
                onChange={(v) =>
                  onChange(entries.map((e, j) => (j === i ? { ...e, field: v } : e)))
                }
                options={fieldOptions}
                placeholder='Field…'
              />
            </div>
            <button
              type='button'
              onClick={() => onChange(entries.filter((_, j) => j !== i))}
              className='shrink-0 text-slate-300 hover:text-red-500'
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </div>
          <div className='flex gap-1'>
            <input
              type='text'
              value={entry.label ?? ''}
              placeholder='Label…'
              onChange={(e) =>
                onChange(
                  entries.map((en, j) => (j === i ? { ...en, label: e.target.value || null } : en))
                )
              }
              className='flex-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan placeholder:text-slate-300'
            />
            <select
              value={entry.format ?? 'text'}
              onChange={(e) =>
                onChange(
                  entries.map((en, j) =>
                    j === i
                      ? { ...en, format: e.target.value === 'text' ? null : e.target.value }
                      : en
                  )
                )
              }
              className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
            >
              {FORMAT_OPTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}
      <button
        type='button'
        onClick={() => onChange([...entries, { field: '', label: null, format: null }])}
        className='flex items-center gap-1 text-[11px] text-slate-400 hover:text-nvr-cyan'
      >
        <Plus className='h-3.5 w-3.5' />
        Add field
      </button>
    </div>
  )
}

function FieldGroupsTab({
  tableName,
  dbColumns = [],
  layoutId,
  layoutType = 'grouped'
}: {
  tableName: string
  dbColumns?: Array<{ name: string; data_type: string }>
  layoutId: number | null
  layoutType?: 'grouped' | 'table' | 'addendum'
}) {
  const qc = useQueryClient()

  const { data: groups = [], isLoading: groupsLoading } = useQuery<FieldGroup[]>({
    queryKey: ['field-groups', tableName, layoutId],
    queryFn: () =>
      api
        .get<{ data: FieldGroup[] }>(`/field-groups/${tableName}`, {
          params: layoutId ? { layout_id: layoutId } : {}
        })
        .then((r) => r.data.data ?? []),
    enabled: !!tableName
  })

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', tableName],
    queryFn: () => api.get(`/collections/${tableName}`).then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 30_000
  })

  const { data: fieldConfigResult } = useQuery({
    queryKey: ['field-config', tableName, layoutId],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            field: string
            group_key: string | null
            sort: number | null
            label: string | null
            note: string | null
            hidden: boolean
            readonly: boolean
            required: boolean
            interface: string | null
            options: Record<string, unknown> | null
            dependency_config: string | null
          }>
          ungrouped_sort: number | null
        }>(`/field-config/${tableName}`, { params: layoutId ? { layout_id: layoutId } : {} })
        .then((r) => r.data),
    enabled: !!tableName,
    staleTime: 30_000
  })

  const fieldConfig = fieldConfigResult?.data ?? []
  const ungroupedSortFromServer: number | null = fieldConfigResult?.ungrouped_sort ?? null
  const { data: availableWidgets = [] } = useQuery<
    Array<{ id: number; name: string; widget_type: string; inputs: unknown }>
  >({
    queryKey: ['widgets-internal'],
    queryFn: () => api.get('/widgets-internal').then((r) => r.data.data),
    staleTime: 60_000
  })
  const [addingWidget, setAddingWidget] = useState(false)
  const relations: Array<{
    many_field: string
    many_collection?: string
    one_collection: string | null
    one_field?: string | null
    junction_field: string | null
  }> = colMeta?.relations ?? []
  // Memoized — new array reference every render would fire the init effect infinitely
  const allFields = useMemo(() => {
    const base: Array<{ field: string; type?: string; options?: string | null }> =
      colMeta?.fields ?? []
    const seenO2m = new Set<string>()
    const o2mVirtuals = (colMeta?.relations ?? [])
      .filter(
        (r: {
          one_field?: string | null
          junction_field: string | null
          many_collection?: string
        }) => {
          if (!r.one_field || r.junction_field !== null) return false
          const effectiveName = r.one_field === 'id' ? (r.many_collection ?? '') : r.one_field
          return effectiveName && !base.find((f) => f.field === effectiveName)
        }
      )
      .map((r: { one_field: string; many_collection?: string }) => ({
        field: r.one_field === 'id' ? (r.many_collection ?? r.one_field) : r.one_field,
        type: 'o2m' as const
      }))
      .filter((v: { field: string; type: 'o2m' }) => {
        if (seenO2m.has(v.field)) return false
        seenO2m.add(v.field)
        return true
      })
    // M2M alias fields — junction_field is set; use one_field if set (not 'id'),
    // else fall back to many_collection (junction table name) for legacy one_field='id' rows
    const seenM2m = new Set<string>()
    const m2mVirtuals = (colMeta?.relations ?? [])
      .filter(
        (r: {
          one_field?: string | null
          junction_field: string | null
          many_collection?: string
        }) => {
          if (!r.junction_field) return false
          const name = r.one_field && r.one_field !== 'id' ? r.one_field : (r.many_collection ?? '')
          return !!name && !base.find((f) => f.field === name)
        }
      )
      .map((r: { one_field?: string | null; many_collection?: string }) => ({
        field:
          r.one_field && r.one_field !== 'id'
            ? r.one_field!
            : (r.many_collection ?? r.one_field ?? ''),
        type: 'm2m' as const
      }))
      .filter((v: { field: string; type: 'm2m' }) => {
        if (!v.field || seenM2m.has(v.field)) return false
        seenM2m.add(v.field)
        return true
      })
    const ownersPseudo = { field: OWNERS_FIELD, type: 'owners' as const }
    const pdfPseudo = { field: PDF_FIELD, type: 'pdf' as const }
    return [...base, ...o2mVirtuals, ...m2mVirtuals, ownersPseudo, pdfPseudo]
  }, [colMeta])

  // Grouped + alphabetically sorted field options for widget input binding pickers
  // field → relation kind label
  const relKind = (fieldName: string): string | null => {
    // Virtual M2M field — match by one_field, or by many_collection when one_field='id'
    const m2m = relations.find(
      (r) =>
        r.junction_field !== null &&
        ((r.one_field && r.one_field !== 'id' && r.one_field === fieldName) ||
          ((!r.one_field || r.one_field === 'id') && r.many_collection === fieldName))
    )
    if (m2m) return 'M2M'
    // Virtual O2M field
    const o2m = relations.find(
      (r) =>
        r.junction_field === null &&
        (r.one_field === fieldName || (r.one_field === 'id' && r.many_collection === fieldName))
    )
    if (o2m) return 'O2M'
    // M2O FK column on this collection
    const r = relations.find((r) => r.many_field === fieldName)
    if (!r) return null
    return r.one_collection ? 'M2O' : null
  }

  const DB_TYPE_LABELS: Record<string, string> = {
    nvarchar: 'text',
    varchar: 'text',
    ntext: 'text',
    text: 'text',
    int: 'num',
    bigint: 'bigint',
    tinyint: 'bool',
    bit: 'bool',
    float: 'float',
    real: 'float',
    decimal: 'decimal',
    numeric: 'decimal',
    money: 'money',
    date: 'date',
    datetime: 'datetime',
    datetime2: 'datetime',
    time: 'time',
    uniqueidentifier: 'uuid'
  }
  const ABSTRACT_TYPE_LABELS: Record<string, string> = {
    string: 'text',
    text: 'text',
    integer: 'num',
    bigInteger: 'bigint',
    float: 'float',
    decimal: 'decimal',
    boolean: 'bool',
    date: 'date',
    datetime: 'datetime',
    uuid: 'uuid',
    json: 'json'
  }
  const friendlyType = (abstractType?: string, fieldName?: string): string | undefined => {
    // Prefer actual DB column type when available
    if (fieldName) {
      const col = dbColumns.find((c) => c.name === fieldName)
      if (col) return DB_TYPE_LABELS[col.data_type.toLowerCase()] ?? col.data_type
    }
    return abstractType ? (ABSTRACT_TYPE_LABELS[abstractType] ?? abstractType) : undefined
  }

  // ── Local optimistic state ──
  const [localGroupOrder, setLocalGroupOrder] = useState<
    (number | '__ungrouped__' | SlotKey | string)[]
  >([])
  type WidgetSlotMeta = {
    widget_id: number
    name: string
    label_override: string | null
    is_visible: boolean
    input_bindings: Array<{ key: string; binding_type: string; binding_value: string }>
  }
  const [widgetSlotMeta, setWidgetSlotMeta] = useState<Record<string, WidgetSlotMeta>>({})
  type HeaderFieldMeta = {
    label_override: string | null
    display_format: string
    color?: string
    weight?: string
    display_as?: string
  }
  const [headerFieldDisplayMeta, setHeaderFieldDisplayMeta] = useState<
    Record<string, HeaderFieldMeta>
  >({})
  const [localAssignments, setLocalAssignments] = useState<Record<string, string | null>>({})
  const [localColSpans, setLocalColSpans] = useState<Record<string, number | null>>({})
  const [localRowRevisions, setLocalRowRevisions] = useState<Record<string, boolean>>({})
  const [localAllowRevisionRestore, setLocalAllowRevisionRestore] = useState<
    Record<string, boolean>
  >({})
  const [localLockConditions, setLocalLockConditions] = useState<
    Record<
      string,
      Array<{ type: string; state_keys?: string[]; role_ids?: string[]; pipeline_id?: string }>
    >
  >({})
  const [inlineDisplayMeta, setInlineDisplayMeta] = useState<Record<string, InlineDisplayConfig>>(
    {}
  )
  const [subtitleConfig, setSubtitleConfig] = useState<{
    fields: SubtitleField[]
    separator: string
  } | null>(null)
  const [subtitlePickerOpen, setSubtitlePickerOpen] = useState(false)
  const [subtitleStyleOpen, setSubtitleStyleOpen] = useState<number | null>(null)
  const [localOverrides, setLocalOverrides] = useState<Record<string, Record<string, unknown>>>({})
  const [localFieldOrder, setLocalFieldOrder] = useState<Record<string, string[]>>({})
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null)
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [poolSearch, setPoolSearch] = useState('')
  const [poolCategory, setPoolCategory] = useState<'all' | 'fields' | 'relations' | 'widgets'>(
    'all'
  )

  // ── Page slot state ──
  // Special panels (pipeline/comments/tasks) persisted as sentinel assignments.
  // sort = position relative to groups/ungrouped; label_override only for comments/tasks.
  const [slots, setSlots] = useState<Record<SlotKey, SlotState>>(() => ({
    __pipeline__: {
      sort: 0,
      label_override: null,
      is_visible: true,
      default_expanded: true,
      show_approval_chain: false
    },
    __comments__: {
      sort: 0,
      label_override: null,
      is_visible: true,
      default_expanded: true,
      show_approval_chain: false
    },
    __tasks__: {
      sort: 0,
      label_override: null,
      is_visible: true,
      default_expanded: true,
      show_approval_chain: false
    },
    __addendums__: {
      sort: 0,
      label_override: null,
      is_visible: true,
      default_expanded: true,
      show_approval_chain: false
    }
  }))
  const [editingSlot, setEditingSlot] = useState<SlotKey | null>(null)
  const [slotLabelDraft, setSlotLabelDraft] = useState('')

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True only after user makes a drag change — prevents saving on server-data reloads
  const hasLocalChangeRef = useRef(false)
  // Bumped on every local change — lets the save know whether newer edits arrived while in flight
  const changeSeqRef = useRef(0)

  // Reset dirty flag when layout changes so the init effect re-initialises with fresh server data
  useEffect(() => {
    hasLocalChangeRef.current = false
    changeSeqRef.current++
  }, [layoutId])

  useEffect(() => {
    if (!groups.length && !allFields.length) return
    // Unsaved local changes pending — a refetch landing now (e.g. from a previous save)
    // must not clobber them or cancel the pending debounced save
    if (hasLocalChangeRef.current) return
    const ungroupedIdx =
      ungroupedSortFromServer !== null
        ? Math.min(ungroupedSortFromServer, groups.length)
        : groups.length
    const baseOrder: (number | '__ungrouped__' | SlotKey | string)[] = groups.map((g) => g.id)
    baseOrder.splice(ungroupedIdx, 0, '__ungrouped__')
    // Interleave slot keys at their saved positions (after groups/ungrouped are placed)
    for (const key of SLOT_KEYS) {
      const row = fieldConfig.find((fc) => fc.field === key) as Record<string, unknown> | undefined
      const slotSort = row
        ? typeof row.sort === 'number'
          ? row.sort
          : baseOrder.length
        : baseOrder.length + SLOT_KEYS.indexOf(key)
      const insertAt = Math.min(Math.max(0, slotSort), baseOrder.length)
      baseOrder.splice(insertAt, 0, key)
    }
    // Interleave widget slots at their saved positions
    const widgetRows = fieldConfig.filter(
      (fc) =>
        typeof fc.field === 'string' &&
        (fc.field as string).startsWith('__widget_') &&
        (fc.field as string).endsWith('__') &&
        (fc as Record<string, unknown>).widget_id
    ) as Array<Record<string, unknown>>
    const nextWidgetMeta: Record<
      string,
      {
        widget_id: number
        name: string
        label_override: string | null
        is_visible: boolean
        input_bindings: Array<{ key: string; binding_type: string; binding_value: string }>
      }
    > = {}
    for (const row of widgetRows) {
      const key = row.field as string
      const wid = row.widget_id as number
      const wDef = availableWidgets.find((w) => w.id === wid)
      nextWidgetMeta[key] = {
        widget_id: wid,
        name: wDef?.name ?? `Widget ${wid}`,
        label_override: (row.label_override as string | null) ?? null,
        is_visible:
          row.is_visible === undefined || row.is_visible === null ? true : !!row.is_visible,
        input_bindings: (() => {
          try {
            return typeof row.input_bindings === 'string'
              ? JSON.parse(row.input_bindings as string)
              : []
          } catch {
            return []
          }
        })()
      }
    }
    setWidgetSlotMeta(nextWidgetMeta)
    // Initialize header field display meta from saved assignments
    const headerFieldRows = fieldConfig.filter((fc) => {
      const f = fc.field as string
      const gk = (fc as Record<string, unknown>).group_key as string | null
      return f && !f.startsWith('__') && gk === '__header__'
    })
    const nextHeaderFieldMeta: Record<string, HeaderFieldMeta> = {}
    for (const row of headerFieldRows) {
      const f = row.field as string
      let displayFormat = 'text'
      try {
        const raw = (row as Record<string, unknown>).input_bindings
        const parsed: Array<{ key: string; binding_type: string; binding_value: string }> =
          typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : []
        const fmt = parsed.find((b) => b.key === '__display_format__')
        if (fmt?.binding_value) displayFormat = fmt.binding_value
      } catch {
        /* noop */
      }
      const rawBindings2 = (row as Record<string, unknown>).input_bindings
      const parsedBindings2: Array<{ key: string; binding_value: string }> = (() => {
        try {
          return typeof rawBindings2 === 'string'
            ? JSON.parse(rawBindings2)
            : Array.isArray(rawBindings2)
              ? rawBindings2
              : []
        } catch {
          return []
        }
      })()
      nextHeaderFieldMeta[f] = {
        label_override: ((row as Record<string, unknown>).label_override as string | null) ?? null,
        display_format: displayFormat,
        color: parsedBindings2.find((b) => b.key === '__color__')?.binding_value || undefined,
        weight: parsedBindings2.find((b) => b.key === '__weight__')?.binding_value || undefined,
        display_as:
          parsedBindings2.find((b) => b.key === '__display_as__')?.binding_value || undefined
      }
    }
    setHeaderFieldDisplayMeta(nextHeaderFieldMeta)
    setLocalGroupOrder(baseOrder)
    const assignments: Record<string, string | null> = {}
    // __pool__ = Fields List (always contains ALL fields); __unassigned__ = Ungrouped zone
    const fieldOrder: Record<string, string[]> = {
      __pool__: [],
      __unassigned__: [],
      __apply_values__: [],
      __create_with_defaults__: [],
      __header__: []
    }
    for (const g of groups) fieldOrder[g.key] = []
    const sorted = [...allFields].sort((a, b) => {
      const as_ = fieldConfig.find((fc) => fc.field === a.field)?.sort ?? 9999
      const bs_ = fieldConfig.find((fc) => fc.field === b.field)?.sort ?? 9999
      return as_ - bs_
    })
    // __pool__ always has every field — it's a static Fields List palette
    for (const f of sorted) {
      fieldOrder.__pool__.push(f.field)
      assignments[f.field] = null
    }
    // Populate groups from ALL fieldConfig rows (multi-group: same field can appear in multiple groups)
    const fcSorted = [...fieldConfig].sort((a, b) => (a.sort ?? 9999) - (b.sort ?? 9999))
    for (const fc of fcSorted) {
      if (!(fc as Record<string, unknown>).layout_assigned) continue
      const gk = fc.group_key ?? null
      const f = fc.field
      if (
        !f ||
        f === '__ungrouped_pos__' ||
        (typeof f === 'string' &&
          f.startsWith('__') &&
          f.endsWith('__') &&
          f !== '__unassigned__' &&
          f !== OWNERS_FIELD &&
          f !== PDF_FIELD &&
          !f.startsWith('__widget_'))
      )
        continue
      assignments[f] = gk
      if (gk === '__apply_values__') {
        if (!fieldOrder.__apply_values__.includes(f)) fieldOrder.__apply_values__.push(f)
      } else if (gk === '__create_with_defaults__') {
        if (!fieldOrder.__create_with_defaults__.includes(f))
          fieldOrder.__create_with_defaults__.push(f)
      } else if (gk === '__header__') {
        if (!fieldOrder.__header__.includes(f)) fieldOrder.__header__.push(f)
      } else if (gk && fieldOrder[gk] !== undefined) {
        if (!fieldOrder[gk].includes(f)) fieldOrder[gk].push(f)
      } else if (!gk) {
        if (!fieldOrder.__unassigned__.includes(f)) fieldOrder.__unassigned__.push(f)
      }
    }
    // Widgets are synthetic — add their keys to pool so they appear in the left panel
    for (const key of Object.keys(nextWidgetMeta)) {
      if (!fieldOrder.__pool__.includes(key)) fieldOrder.__pool__.push(key)
    }
    // Build per-layout col_span map from fieldConfig (which has the layout overlay applied)
    const colSpans: Record<string, number | null> = {}
    const overrides: Record<string, Record<string, unknown>> = {}
    const rowRevisions: Record<string, boolean> = {}
    const allowRevisionRestore: Record<string, boolean> = {}
    const lockConditions: Record<
      string,
      Array<{ type: string; state_keys?: string[]; role_ids?: string[]; pipeline_id?: string }>
    > = {}
    for (const f of sorted) {
      const fc = fieldConfig.find((fc) => fc.field === f.field)
      const opts = fc?.options
      const parsed = (() => {
        try {
          return typeof opts === 'string' ? JSON.parse(opts) : opts
        } catch {
          return null
        }
      })()
      const span = parsed?.col_span
      colSpans[f.field] = typeof span === 'number' ? span : null
      rowRevisions[f.field] = !!parsed?.show_row_revisions
      allowRevisionRestore[f.field] = parsed?.allow_revision_restore !== false
      if (parsed?.lock_conditions) {
        try {
          lockConditions[f.field] =
            typeof parsed.lock_conditions === 'string'
              ? JSON.parse(parsed.lock_conditions)
              : parsed.lock_conditions
        } catch {
          /* noop */
        }
      }
      const raw = (fc as Record<string, unknown> | undefined)?._overrides
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        overrides[f.field] = raw as Record<string, unknown>
      }
    }
    setLocalColSpans(colSpans)
    setLocalRowRevisions(rowRevisions)
    setLocalAllowRevisionRestore(allowRevisionRestore)
    setLocalLockConditions(lockConditions)
    setLocalOverrides(overrides)
    // Parse __inline_display__ bindings for M2O fields
    const nextInlineDisplay: Record<string, InlineDisplayConfig> = {}
    for (const fc of fieldConfig) {
      const fname = fc.field as string
      if (!fname || fname.startsWith('__')) continue
      try {
        const raw = (fc as Record<string, unknown>).input_bindings
        const parsed: Array<{ key: string; binding_value: string }> =
          typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : []
        const entry = parsed.find((b) => b.key === '__inline_display__')
        if (entry?.binding_value) {
          const data = JSON.parse(entry.binding_value)
          const isArr = Array.isArray(data)
          const entries = isArr ? data : (data.fields ?? [])
          const separator: string | null = isArr ? null : (data.separator ?? null)
          if (Array.isArray(entries) && entries.length)
            nextInlineDisplay[fname] = { entries, separator }
        }
      } catch {
        /* noop */
      }
    }
    setInlineDisplayMeta(nextInlineDisplay)
    setLocalAssignments(assignments)
    setLocalFieldOrder(fieldOrder)

    // ── Parse page slot sentinels from the same assignments payload ──
    const nextSlots: Record<SlotKey, SlotState> = {
      __pipeline__: {
        sort: groups.length + 1,
        label_override: null,
        is_visible: true,
        default_expanded: true,
        show_approval_chain: false
      },
      __comments__: {
        sort: groups.length + 2,
        label_override: null,
        is_visible: true,
        default_expanded: true,
        show_approval_chain: false
      },
      __tasks__: {
        sort: groups.length + 3,
        label_override: null,
        is_visible: true,
        default_expanded: true,
        show_approval_chain: false
      },
      __addendums__: {
        sort: groups.length + 4,
        label_override: null,
        is_visible: true,
        default_expanded: true,
        show_approval_chain: false
      }
    }
    for (const key of SLOT_KEYS) {
      const row = fieldConfig.find((fc) => fc.field === key) as Record<string, unknown> | undefined
      if (!row) continue
      nextSlots[key] = {
        sort: typeof row.sort === 'number' ? row.sort : nextSlots[key].sort,
        label_override: (row.label_override as string | null | undefined) ?? null,
        is_visible:
          row.is_visible === undefined || row.is_visible === null ? true : !!row.is_visible,
        default_expanded:
          row.default_expanded === undefined || row.default_expanded === null
            ? true
            : !!row.default_expanded,
        show_approval_chain: !!row.show_approval_chain
      }
    }
    setSlots(nextSlots)
    // ── Parse subtitle sentinel ──
    const subtitleRow = fieldConfig.find((fc) => fc.field === '__subtitle__') as
      | Record<string, unknown>
      | undefined
    if (subtitleRow) {
      try {
        const raw = subtitleRow.input_bindings
        const parsed: Array<{ key: string; binding_value: string }> =
          typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : []
        const entry = parsed.find((b) => b.key === '__subtitle_config__')
        if (entry?.binding_value) {
          const data = JSON.parse(entry.binding_value)
          if (data.fields && Array.isArray(data.fields) && data.fields.length > 0) {
            setSubtitleConfig({ fields: data.fields, separator: data.separator ?? ' | ' })
          } else {
            setSubtitleConfig(null)
          }
        } else {
          setSubtitleConfig(null)
        }
      } catch {
        setSubtitleConfig(null)
      }
    } else {
      setSubtitleConfig(null)
    }
  }, [groups, fieldConfig, allFields, ungroupedSortFromServer])

  // ── Mutations ──
  const invalidateGroups = useCallback(
    () => qc.invalidateQueries({ queryKey: ['field-groups', tableName] }),
    [qc, tableName]
  )
  const invalidateFieldConfig = useCallback(
    () => qc.invalidateQueries({ queryKey: ['field-config', tableName] }),
    [qc, tableName]
  )
  const invalidateMeta = useCallback(
    () => qc.invalidateQueries({ queryKey: ['collection-meta', tableName] }),
    [qc, tableName]
  )

  // Debounced layout save — watches state directly (no stale-ref risk)
  // Must be declared after invalidateFieldConfig to avoid TDZ error
  useEffect(() => {
    if (!layoutId || !hasLocalChangeRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const seq = changeSeqRef.current
      const ungroupedPos = localGroupOrder.indexOf('__ungrouped__')
      // Build assignments from localFieldOrder directly — __pool__ is the static Fields List, skip it
      const fieldAssignments: Array<{
        field: string
        group_key: string | null
        sort: number
        label_override?: string | null
        is_visible?: boolean
        col_span?: number | null
        overrides?: Record<string, unknown> | null
        show_row_revisions?: boolean
        allow_revision_restore?: boolean | null
        lock_conditions?: string | null
        widget_id?: number
        input_bindings?: Array<{ key: string; binding_type: string; binding_value: string }> | null
      }> = []
      for (const [container, fields] of Object.entries(localFieldOrder)) {
        if (container === '__pool__') continue
        const gk = container === '__unassigned__' ? null : container
        fields.forEach((f, idx) => {
          if (typeof f === 'string' && f.startsWith('__widget_') && f.endsWith('__')) {
            const wMeta = widgetSlotMeta[f]
            if (wMeta)
              fieldAssignments.push({
                field: f,
                group_key: gk,
                sort: idx,
                label_override: wMeta.label_override,
                is_visible: wMeta.is_visible,
                widget_id: wMeta.widget_id,
                input_bindings: wMeta.input_bindings.length > 0 ? wMeta.input_bindings : null
              })
          } else if (gk === '__header__') {
            const hMeta = headerFieldDisplayMeta[f]
            const styleBindings: Array<{
              key: string
              binding_type: 'static'
              binding_value: string
            }> = []
            if (hMeta?.display_format && hMeta.display_format !== 'text')
              styleBindings.push({
                key: '__display_format__',
                binding_type: 'static',
                binding_value: hMeta.display_format
              })
            if (hMeta?.color)
              styleBindings.push({
                key: '__color__',
                binding_type: 'static',
                binding_value: hMeta.color
              })
            if (hMeta?.weight)
              styleBindings.push({
                key: '__weight__',
                binding_type: 'static',
                binding_value: hMeta.weight
              })
            if (hMeta?.display_as)
              styleBindings.push({
                key: '__display_as__',
                binding_type: 'static',
                binding_value: hMeta.display_as
              })
            fieldAssignments.push({
              field: f,
              group_key: gk,
              sort: idx,
              label_override: hMeta?.label_override ?? null,
              input_bindings: styleBindings.length > 0 ? styleBindings : null
            })
          } else {
            const ov = localOverrides[f]
            const config = inlineDisplayMeta[f]
            const inlineBinding =
              config && config.entries.length > 0
                ? [
                    {
                      key: '__inline_display__',
                      binding_type: 'static' as const,
                      binding_value: JSON.stringify({
                        fields: config.entries,
                        separator: config.separator
                      })
                    }
                  ]
                : null
            const lc = localLockConditions[f]
            fieldAssignments.push({
              field: f,
              group_key: gk,
              sort: idx,
              col_span: localColSpans[f] ?? null,
              overrides: ov && Object.keys(ov).length > 0 ? ov : null,
              show_row_revisions: localRowRevisions[f] ?? false,
              allow_revision_restore: localAllowRevisionRestore[f] ?? true,
              lock_conditions: lc?.length ? JSON.stringify(lc) : null,
              input_bindings: inlineBinding
            })
          }
        })
      }
      const assignments = [
        ...fieldAssignments,
        {
          field: '__ungrouped_pos__',
          group_key: null,
          sort: ungroupedPos >= 0 ? ungroupedPos : localGroupOrder.length
        },
        // Page slot sentinels — sort derived from position in localGroupOrder
        ...SLOT_KEYS.map((key) => ({
          field: key,
          group_key: null,
          sort:
            localGroupOrder.indexOf(key as SlotKey) >= 0
              ? localGroupOrder.indexOf(key as SlotKey)
              : localGroupOrder.length,
          label_override: slots[key].label_override,
          is_visible: slots[key].is_visible,
          default_expanded: slots[key].default_expanded,
          show_approval_chain: slots[key].show_approval_chain
        })),
        // Subtitle sentinel
        ...(subtitleConfig
          ? [
              {
                field: '__subtitle__',
                group_key: null,
                sort: 0,
                input_bindings: [
                  {
                    key: '__subtitle_config__',
                    binding_type: 'static',
                    binding_value: JSON.stringify({
                      fields: subtitleConfig.fields,
                      separator: subtitleConfig.separator
                    })
                  }
                ]
              }
            ]
          : [])
      ]
      // Keep group sorts in sync with slot sorts: slot sort = position in localGroupOrder,
      // so group sort must also = position in localGroupOrder; otherwise a group.sort from
      // a prior DnD session can exceed newly-saved slot sorts and the group renders
      // below Notes/Tasks in ItemEditForm.
      const groupSortUpdates = (localGroupOrder as Array<number | string>)
        .map((id, pos) => ({ id, pos }))
        .filter((x): x is { id: number; pos: number } => typeof x.id === 'number')
        .map(({ id, pos }) => ({ id, sort: pos }))
      if (groupSortUpdates.length > 0) {
        api
          .post('/field-groups/reorder', { collection: tableName, order: groupSortUpdates })
          .catch(() => {})
      }
      api
        .put(`/collection-layouts/${layoutId}/assignments`, { assignments })
        .then(() => {
          // Clear the dirty flag only if no newer local change arrived while this PUT was
          // in flight. Do NOT refetch on success: local state already equals what was
          // saved, and a post-save refetch is the only path that can rebuild
          // localFieldOrder from server data and visually revert a just-made drag.
          if (changeSeqRef.current === seq) hasLocalChangeRef.current = false
        })
        .catch(() => {
          toast.error('Failed to save field order')
          // Resync from server truth only when the save failed
          if (changeSeqRef.current === seq) hasLocalChangeRef.current = false
          invalidateFieldConfig()
        })
    }, 400)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [
    localAssignments,
    localColSpans,
    localRowRevisions,
    localOverrides,
    localFieldOrder,
    localGroupOrder,
    slots,
    widgetSlotMeta,
    headerFieldDisplayMeta,
    inlineDisplayMeta,
    subtitleConfig,
    layoutId,
    invalidateFieldConfig
  ])

  const createMut = useMutation({
    mutationFn: (body: {
      collection: string
      key: string
      label: string
      type: 'section' | 'tab' | 'metadata' | 'container'
    }) => api.post('/field-groups', { ...body, layout_id: layoutId }),
    onSuccess: () => {
      invalidateGroups()
      setAdding(false)
      setNewKey('')
      setNewLabel('')
      toast.success('Group created')
    },
    onError: () => toast.error('Failed to create group')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/field-groups/${id}`),
    onSuccess: () => {
      invalidateGroups()
      invalidateFieldConfig()
      toast.success('Group deleted')
    }
  })

  const patchTypeMut = useMutation({
    mutationFn: ({
      id,
      type,
      tab_mode
    }: {
      id: number
      type: 'section' | 'tab' | 'metadata' | 'container'
      tab_mode?: 'tabs' | 'steps' | null
    }) => api.patch(`/field-groups/${id}`, { type, tab_mode }),
    onSuccess: () => invalidateGroups()
  })

  const renameMut = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) =>
      api.patch(`/field-groups/${id}`, { label }),
    onSuccess: () => invalidateGroups()
  })

  const iconMut = useMutation({
    mutationFn: ({ id, icon }: { id: number; icon: string | null }) =>
      api.patch(`/field-groups/${id}`, { icon }),
    onSuccess: () => invalidateGroups()
  })

  const patchCollapsedMut = useMutation({
    mutationFn: ({ id, is_collapsed }: { id: number; is_collapsed: boolean }) =>
      api.patch(`/field-groups/${id}`, { is_collapsed }),
    onSuccess: () => invalidateGroups()
  })

  const patchGroupSettingsMut = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Record<string, unknown> }) => {
      const body: Record<string, unknown> = { ...patch }
      if ('hide_when_empty' in body) body.hide_when_empty = body.hide_when_empty ? 1 : 0
      return api.patch(`/field-groups/${id}`, body)
    },
    onSuccess: () => invalidateGroups()
  })

  const reorderGroupsMut = useMutation({
    mutationFn: (order: Array<{ id: number; sort: number }>) =>
      api.post('/field-groups/reorder', { collection: tableName, order })
  })

  const patchTabModeMut = useMutation({
    mutationFn: ({ id, tab_mode }: { id: number; tab_mode: 'tabs' | 'steps' }) =>
      api.patch(`/field-groups/${id}`, { tab_mode }),
    onSuccess: () => invalidateGroups()
  })

  const setContainerMut = useMutation({
    mutationFn: ({ id, container_id }: { id: number; container_id: number | null }) =>
      api.patch(`/field-groups/${id}`, { container_id }),
    onSuccess: () => invalidateGroups()
  })

  // Keys that are per-layout overrides (not global field settings)
  const LAYOUT_OVERRIDE_KEYS = [
    'label',
    'interface',
    'note',
    'placeholder',
    'required',
    'hidden',
    'readonly',
    'options',
    'inline_relation',
    'max_values',
    'drilldown'
  ]

  // Option keys inside `options` JSON that are scoped to a specific layout and must NOT
  // be written to nivaro_fields (global). They live in layout_field_assignments.overrides.options.
  const LAYOUT_LOCAL_OPTION_KEYS = [
    'layout_id',
    'layout_slug',
    'save_mode',
    'show_line_numbers',
    'enable_reorder',
    'parent_cascades',
    'row_rules',
    'parent_context_fields',
    'unique_by',
    'sort_field',
    'sort_dir'
  ]

  const patchField = useCallback(
    (field: string, patch: Record<string, unknown>) => {
      if (layoutId && ('group_key' in patch || 'sort' in patch)) {
        // State update triggers the debounced save effect — just mark dirty
        hasLocalChangeRef.current = true
        changeSeqRef.current++
      } else if (layoutId && 'col_span' in patch) {
        // col_span is per-layout — store in localColSpans and let debounced assignment save handle it
        const span = patch.col_span as number | null
        setLocalColSpans((prev) => ({ ...prev, [field]: span }))
        hasLocalChangeRef.current = true
        changeSeqRef.current++
      } else if (layoutId && Object.keys(patch).some((k) => LAYOUT_OVERRIDE_KEYS.includes(k))) {
        const { options: rawOptions, dependency_config: rawDepConfig, ...layoutPatch } = patch

        // Split options: layout-local keys (layout_id, save_mode, etc.) go into localOverrides;
        // global keys (format, currency, etc.) go to nivaro_fields.options.
        let globalOptions: Record<string, unknown> | null = null
        let localOptionsMerge: Record<string, unknown> | null = null
        if (rawOptions !== undefined) {
          let parsed: Record<string, unknown> = {}
          try {
            parsed =
              typeof rawOptions === 'string'
                ? JSON.parse(rawOptions)
                : ((rawOptions as Record<string, unknown>) ?? {})
          } catch {
            /* noop */
          }
          for (const [k, v] of Object.entries(parsed)) {
            if (LAYOUT_LOCAL_OPTION_KEYS.includes(k)) {
              localOptionsMerge = localOptionsMerge ?? {}
              localOptionsMerge[k] = v
            } else {
              globalOptions = globalOptions ?? {}
              globalOptions[k] = v
            }
          }
        }

        // Send only global options + dependency_config to nivaro_fields
        if (globalOptions !== null || rawDepConfig !== undefined) {
          const directPatch: Record<string, unknown> = {}
          if (globalOptions !== null) directPatch.options = JSON.stringify(globalOptions)
          if (rawDepConfig !== undefined) directPatch.dependency_config = rawDepConfig
          api
            .patch(`/field-config/${tableName}/${field}`, directPatch)
            .then(() => {
              invalidateFieldConfig()
              invalidateMeta()
            })
            .catch(() => {
              toast.error(`Failed to save settings for field "${field}"`)
            })
        }

        // Merge layout-local option keys + other override fields into localOverrides
        const hasLayoutLocalOpts = localOptionsMerge !== null
        const hasLayoutPatchKeys = Object.keys(layoutPatch).some((k) =>
          LAYOUT_OVERRIDE_KEYS.includes(k)
        )
        if (hasLayoutLocalOpts || hasLayoutPatchKeys) {
          setLocalOverrides((prev) => {
            const existing = prev[field] ?? {}
            const patched = { ...existing }
            // Layout-local option keys go into overrides.options
            if (localOptionsMerge) {
              patched.options = {
                ...(typeof patched.options === 'object' && patched.options ? patched.options : {}),
                ...localOptionsMerge
              } as Record<string, unknown>
            }
            // Flatten inline_relation / max_values into the options sub-object; all other keys are top-level overrides
            const optionKeys = ['inline_relation', 'max_values']
            for (const [k, v] of Object.entries(layoutPatch)) {
              if (!LAYOUT_OVERRIDE_KEYS.includes(k)) continue
              if (optionKeys.includes(k)) {
                patched.options = {
                  ...(typeof patched.options === 'object' && patched.options
                    ? patched.options
                    : {}),
                  [k]: v
                } as Record<string, unknown>
              } else {
                patched[k] = v
              }
            }
            return { ...prev, [field]: patched }
          })
          hasLocalChangeRef.current = true
          changeSeqRef.current++
        }
      } else {
        api
          .patch(`/field-config/${tableName}/${field}`, patch)
          .then(() => {
            invalidateFieldConfig()
            invalidateMeta()
          })
          .catch(() => {
            toast.error(`Failed to save settings for field "${field}"`)
          })
      }
    },
    [tableName, layoutId, invalidateFieldConfig, invalidateMeta]
  )

  // ── Add group form ──
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newType, setNewType] = useState<'section' | 'tab' | 'metadata' | 'container'>('section')

  // ── dnd ──
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // orderedItems includes '__ungrouped__' sentinel at its saved position
  const orderedItems = useMemo(
    () =>
      localGroupOrder
        .map((id) => {
          if (id === '__ungrouped__') return '__ungrouped__'
          if (SLOT_KEYS.includes(id as SlotKey)) return id as SlotKey
          return groups.find((g) => g.id === id) ?? null
        })
        .filter(Boolean) as (FieldGroup | '__ungrouped__' | SlotKey)[],
    [localGroupOrder, groups]
  )
  const orderedGroups = useMemo(
    () => orderedItems.filter((x): x is FieldGroup => x !== '__ungrouped__'),
    [orderedItems]
  )

  function findContainer(id: string): string {
    if (id.startsWith('group:')) return '__groups__'
    const { container, fieldName } = parseSortableId(id)
    if (container) return container
    for (const [cont, fields] of Object.entries(localFieldOrder)) {
      if (fields.includes(fieldName)) return cont
    }
    return '__pool__'
  }

  function handleDragStart({ active }: DragStartEvent) {
    const id = String(active.id)
    if (id.startsWith('group:') || id.startsWith('slot:')) setActiveGroupId(id)
    else setActiveFieldId(parseSortableId(id).fieldName)
  }

  function handleDragCancel() {
    setActiveFieldId(null)
    setActiveGroupId(null)
  }

  function handleDragOver({ active, over }: DragOverEvent) {
    // Only handle same-container sorting here — cross-container done in onDragEnd
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId.startsWith('group:') || overId.startsWith('drop:') || overId.startsWith('group:'))
      return

    const fromContainer = findContainer(activeId)
    const toContainer = findContainer(overId)
    // __pool__ is a static drag source — no reordering within it
    if (!toContainer || fromContainer !== toContainer || fromContainer === '__pool__') return
    // Mark dirty immediately so a refetch landing mid-drag can't rebuild over this reorder
    if (layoutId) {
      hasLocalChangeRef.current = true
      changeSeqRef.current++
    }
    // Compute indices inside the updater so stale-closure calls don't oscillate.
    // dnd-kit fires onDragOver faster than React re-renders; if fromIdx/toIdx were
    // computed from the closure, a second call before re-render would apply wrong
    // indices to the already-updated prev state and flip the order back.
    setLocalFieldOrder((prev) => {
      const fields = prev[fromContainer] ?? []
      const af = parseSortableId(activeId).fieldName
      const of_ = parseSortableId(overId).fieldName
      const fromIdx = fields.indexOf(af)
      const toIdx = fields.indexOf(of_)
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev
      return { ...prev, [fromContainer]: arrayMove(fields, fromIdx, toIdx) }
    })
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveFieldId(null)
    setActiveGroupId(null)
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)

    // ── Group / slot reorder (includes __ungrouped__ and slot sentinels) ──
    if (activeId.startsWith('group:') || activeId.startsWith('slot:')) {
      const activeKey = activeId.startsWith('slot:')
        ? activeId.replace('slot:', '')
        : activeId.replace('group:', '')
      const overKey = overId.startsWith('slot:')
        ? overId.replace('slot:', '')
        : overId.replace('group:', '')
      const resolveKey = (id: number | '__ungrouped__' | SlotKey | string): string => {
        if (id === '__ungrouped__') return '__ungrouped__'
        if (typeof id === 'string') return id
        return groups.find((g) => g.id === id)?.key ?? ''
      }
      const activeIdx = localGroupOrder.findIndex((id) => resolveKey(id) === activeKey)
      const overIdx = localGroupOrder.findIndex((id) => resolveKey(id) === overKey)
      if (activeIdx === -1 || overIdx === -1 || activeIdx === overIdx) return
      if (layoutId) {
        hasLocalChangeRef.current = true
        changeSeqRef.current++
      }
      const newOrder = arrayMove(localGroupOrder, activeIdx, overIdx)
      setLocalGroupOrder(newOrder)
      reorderGroupsMut.mutate(
        newOrder
          .map((id, pos) => ({ id, pos }))
          .filter((x): x is { id: number; pos: number } => typeof x.id === 'number')
          .map(({ id, pos }) => ({ id, sort: pos }))
      )
      // Persist ungrouped position to DB immediately — reorderGroupsMut only updates group sort values
      if (layoutId) {
        const ungroupedPos = newOrder.indexOf('__ungrouped__')
        api
          .patch(`/collection-layouts/${layoutId}/ungrouped-sort`, { ungrouped_sort: ungroupedPos })
          .catch(() => {
            /* non-fatal */
          })
      }
      return
    }

    // ── Determine target container ──
    let toContainer: string
    if (overId.startsWith('drop:')) {
      toContainer = overId.replace('drop:', '')
    } else if (overId.startsWith('group:')) {
      return
    } else {
      toContainer = findContainer(overId)
    }

    const fromContainer = findContainer(activeId)
    if (!toContainer) return

    if (fromContainer === toContainer) {
      if (fromContainer === '__pool__') return // pool is unsortable
      // Already sorted in onDragOver; mark dirty and nudge state so save effect re-runs
      if (layoutId) {
        hasLocalChangeRef.current = true
        changeSeqRef.current++
        setLocalFieldOrder((prev) => ({ ...prev }))
      } else {
        const fields = localFieldOrder[fromContainer] ?? []
        fields.forEach((f, idx) => {
          api.patch(`/field-config/${tableName}/${f}`, {
            sort: idx,
            group_key: localAssignments[f] ?? null
          })
        })
        invalidateFieldConfig()
      }
      return
    }

    // ── Cross-container drop ──
    // __pool__ = Fields List (static palette) — dragging FROM it copies, never removes
    const activeFN = parseSortableId(activeId).fieldName
    const newGroupKey =
      toContainer === '__unassigned__' || toContainer === '__pool__' ? null : toContainer
    setLocalAssignments((prev) => ({ ...prev, [activeFN]: newGroupKey }))
    setLocalFieldOrder((prev) => {
      const fromFields =
        fromContainer === '__pool__'
          ? (prev[fromContainer] ?? []) // copy: leave pool unchanged
          : (prev[fromContainer] ?? []).filter((f) => f !== activeFN) // move: remove from source
      const toFields = (prev[toContainer] ?? []).includes(activeFN)
        ? (prev[toContainer] ?? []) // already there (multi-group), skip duplicate
        : [...(prev[toContainer] ?? []), activeFN]
      return { ...prev, [fromContainer]: fromFields, [toContainer]: toFields }
    })
    if (layoutId) {
      hasLocalChangeRef.current = true
      changeSeqRef.current++
    } else {
      patchField(activeFN, {
        group_key: newGroupKey,
        sort: (localFieldOrder[toContainer] ?? []).length
      })
    }
  }

  const getColSpan = useCallback(
    (f: string) => {
      if (layoutId) {
        const span = localColSpans[f]
        return span != null ? span : 12
      }
      const field = allFields.find((af) => af.field === f)
      return parseColSpan(field?.options)
    },
    [allFields, layoutId, localColSpans]
  )

  const getFieldSettings = useCallback(
    (f: string): FieldSettings => {
      const fc = fieldConfig.find((c) => c.field === f)
      const rawOpts = (fc as Record<string, unknown> | undefined)?.options
      let opts: Record<string, unknown> = {}
      try {
        opts =
          typeof rawOpts === 'string'
            ? JSON.parse(rawOpts)
            : ((rawOpts as Record<string, unknown>) ?? {})
      } catch {
        /* noop */
      }

      // Merge per-layout overrides optimistically (local state, not yet saved)
      const ov = localOverrides[f] ?? {}
      const ovOpts =
        typeof ov.options === 'object' && ov.options ? (ov.options as Record<string, unknown>) : {}
      const mergedOpts = { ...opts, ...ovOpts }

      return {
        label: ((ov.label !== undefined ? ov.label : fc?.label) as string | null) ?? null,
        interface:
          ((ov.interface !== undefined ? ov.interface : fc?.interface) as string | null) ?? null,
        note: ((ov.note !== undefined ? ov.note : fc?.note) as string | null) ?? null,
        placeholder:
          ((ov.placeholder !== undefined
            ? ov.placeholder
            : (fc as Record<string, unknown> | undefined)?.placeholder) as string | null) ?? null,
        required: ov.required !== undefined ? !!ov.required : !!fc?.required,
        hidden: ov.hidden !== undefined ? !!ov.hidden : !!fc?.hidden,
        readonly: ov.readonly !== undefined ? !!ov.readonly : !!fc?.readonly,
        inline_relation: mergedOpts.inline_relation === true,
        max_values: typeof mergedOpts.max_values === 'number' ? mergedOpts.max_values : null,
        options: Object.keys(mergedOpts).length > 0 ? JSON.stringify(mergedOpts) : null,
        drilldown:
          (ov.drilldown as FieldSettings['drilldown']) ??
          ((
            (fc as Record<string, unknown> | undefined)?._overrides as
              | Record<string, unknown>
              | null
              | undefined
          )?.drilldown as FieldSettings['drilldown']) ??
          null
      }
    },
    [fieldConfig, localOverrides]
  )

  // Base settings for pool chips — reads raw nivaro_fields data, never applies layout overrides
  const getBaseFieldSettings = useCallback(
    (f: string): FieldSettings => {
      // colMeta.fields = raw nivaro_fields rows; label here is never overridden by a layout
      const raw = (colMeta?.fields as Array<Record<string, unknown>> | undefined)?.find(
        (r) => r.field === f
      )
      const rawOpts = raw?.options
      let opts: Record<string, unknown> = {}
      try {
        opts =
          typeof rawOpts === 'string'
            ? JSON.parse(rawOpts as string)
            : ((rawOpts as Record<string, unknown>) ?? {})
      } catch {
        /* noop */
      }
      return {
        label: (raw?.label as string | null) ?? null,
        interface: (raw?.interface as string | null) ?? null,
        note: (raw?.note as string | null) ?? null,
        placeholder: (raw?.placeholder as string | null) ?? null,
        required: !!raw?.required,
        hidden: !!raw?.hidden,
        readonly: !!raw?.readonly,
        inline_relation: opts.inline_relation === true,
        max_values: typeof opts.max_values === 'number' ? opts.max_values : null,
        options:
          typeof rawOpts === 'string'
            ? (rawOpts as string)
            : rawOpts
              ? JSON.stringify(rawOpts)
              : null
      }
    },
    [colMeta]
  )

  const handleFieldSettings = useCallback(
    (f: string, patch: Partial<FieldSettings> & { dependency_config?: string }) => {
      patchField(f, patch)
    },
    [patchField]
  )

  const handleUnassign = useCallback((f: string, containerKey: string) => {
    if (containerKey === '__pool__') return
    setLocalFieldOrder((prev) => ({
      ...prev,
      [containerKey]: (prev[containerKey] ?? []).filter((x) => x !== f)
      // __pool__ (Fields List) always keeps all fields — no change needed
    }))
    hasLocalChangeRef.current = true
    changeSeqRef.current++
  }, [])

  // Add a relation-path field ('purchase_order.workflow.workflow_id') to the
  // Ungrouped zone — rendered read-only by the form, draggable into any group.
  const handleAddRelationPath = useCallback((picked: PickedField) => {
    const path = picked.path.join('.')
    if (picked.path.length < 2) {
      toast.error('Pick a field on a related collection (at least one hop)')
      return
    }
    setLocalFieldOrder((prev) => {
      if ((prev.__unassigned__ ?? []).includes(path)) return prev
      return { ...prev, __unassigned__: [...(prev.__unassigned__ ?? []), path] }
    })
    setLocalAssignments((a) => ({ ...a, [path]: null }))
    hasLocalChangeRef.current = true
    changeSeqRef.current++
  }, [])

  // Bulk: move every field from the Unassigned pool into the Ungrouped zone
  const handleAddAllToUngrouped = useCallback(() => {
    setLocalFieldOrder((prev) => {
      const pool = prev.__pool__ ?? []
      if (pool.length === 0) return prev
      setLocalAssignments((a) => {
        const next = { ...a }
        for (const f of pool) next[f] = null
        return next
      })
      return {
        ...prev,
        __pool__: [],
        __unassigned__: [...(prev.__unassigned__ ?? []), ...pool]
      }
    })
    hasLocalChangeRef.current = true
    changeSeqRef.current++
  }, [])

  // Bulk: move every field from the Ungrouped zone back into the Unassigned pool
  const handleReturnAllToPool = useCallback(() => {
    setLocalFieldOrder((prev) => {
      const ungrouped = prev.__unassigned__ ?? []
      if (ungrouped.length === 0) return prev
      setLocalAssignments((a) => {
        const next = { ...a }
        for (const f of ungrouped) next[f] = null
        return next
      })
      return {
        ...prev,
        __unassigned__: [],
        __pool__: [...(prev.__pool__ ?? []), ...ungrouped]
      }
    })
    hasLocalChangeRef.current = true
    changeSeqRef.current++
  }, [])

  // ── Slot mutators ──
  const markSlotDirty = useCallback(() => {
    if (!layoutId) return
    hasLocalChangeRef.current = true
    changeSeqRef.current++
  }, [layoutId])

  const getExtraControls = useCallback(
    (f: string, opts?: { isM2O?: boolean; relatedCollection?: string | null }): React.ReactNode => {
      if (f === PDF_FIELD) {
        const attachField = (localOverrides[f]?.attach_to_field as string | null) ?? null
        const filenameTemplate = (localOverrides[f]?.filename_template as string | null) ?? null
        return (
          <PdfFieldConfigButton
            tableName={tableName}
            value={attachField}
            filenameTemplate={filenameTemplate}
            onChange={(v) => {
              setLocalOverrides((prev) => ({ ...prev, [f]: { ...prev[f], attach_to_field: v } }))
              hasLocalChangeRef.current = true
              changeSeqRef.current++
            }}
            onFilenameChange={(v) => {
              setLocalOverrides((prev) => ({ ...prev, [f]: { ...prev[f], filename_template: v } }))
              hasLocalChangeRef.current = true
              changeSeqRef.current++
            }}
          />
        )
      }
      if (typeof f === 'string' && f.startsWith('__widget_') && f.endsWith('__')) {
        const meta = widgetSlotMeta[f]
        if (!meta) return undefined
        const wDef = availableWidgets.find((w) => w.id === meta.widget_id)
        const declaredInputs =
          (wDef?.inputs as Array<{
            key: string
            label: string
            type: string
            required?: boolean
          }> | null) ?? []
        const derivedInputs: Array<{ key: string; label: string; type: string }> = (() => {
          if (declaredInputs.length > 0) return []
          const cfg =
            ((wDef as unknown as Record<string, unknown>)?.config as Record<
              string,
              unknown
            > | null) ?? {}
          const pb =
            (cfg.param_bindings as Array<{ param?: string; input_key?: string }> | null) ?? []
          const seen = new Set<string>()
          const out: Array<{ key: string; label: string; type: string }> = []
          for (const b of pb) {
            const k = b.input_key
            if (k && !seen.has(k)) {
              seen.add(k)
              out.push({ key: k, label: k, type: 'string' })
            }
          }
          return out
        })()
        const wInputs = declaredInputs.length > 0 ? declaredInputs : derivedInputs
        const updateBinding = (
          inputKey: string,
          patch: Partial<{ binding_type: string; binding_value: string }>
        ) => {
          setWidgetSlotMeta((prev) => {
            const prevMeta = prev[f]
            const existing = prevMeta.input_bindings.find((b) => b.key === inputKey)
            const updated = {
              key: inputKey,
              binding_type: (patch.binding_type ?? existing?.binding_type ?? 'item_field') as
                | 'item_field'
                | 'static'
                | 'url_param',
              binding_value: patch.binding_value ?? existing?.binding_value ?? ''
            }
            const next = prevMeta.input_bindings.filter((b) => b.key !== inputKey)
            next.push(updated)
            return { ...prev, [f]: { ...prevMeta, input_bindings: next } }
          })
          hasLocalChangeRef.current = true
          changeSeqRef.current++
        }
        return (
          <div className='mt-1.5 space-y-1.5 border-t border-slate-100 pt-1.5'>
            <div className='flex items-center gap-1.5'>
              <input
                type='text'
                placeholder='Label override'
                defaultValue={meta.label_override ?? ''}
                onBlur={(e) => {
                  const v = e.target.value.trim() || null
                  setWidgetSlotMeta((prev) => ({ ...prev, [f]: { ...prev[f], label_override: v } }))
                  hasLocalChangeRef.current = true
                  changeSeqRef.current++
                }}
                className='w-32 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan placeholder:text-slate-300'
              />
              <button
                type='button'
                title='Remove widget'
                onClick={() => {
                  setWidgetSlotMeta((prev) => {
                    const n = { ...prev }
                    delete n[f]
                    return n
                  })
                  setLocalFieldOrder((prev) => {
                    const next: Record<string, string[]> = {}
                    for (const [k, v] of Object.entries(prev)) next[k] = v.filter((x) => x !== f)
                    return next
                  })
                  hasLocalChangeRef.current = true
                  changeSeqRef.current++
                }}
                className='text-[10px] text-slate-300 hover:text-red-400'
              >
                ✕ Remove
              </button>
            </div>
            {wInputs.length > 0 && (
              <div className='space-y-1'>
                <p className='text-[10px] font-medium text-slate-400'>Bindings</p>
                {wInputs.map((inp) => {
                  const binding = meta.input_bindings.find((b) => b.key === inp.key) ?? {
                    key: inp.key,
                    binding_type: 'item_field' as const,
                    binding_value: ''
                  }
                  return (
                    <div key={inp.key} className='space-y-0.5'>
                      <div className='flex items-center gap-1'>
                        <span className='w-16 shrink-0 truncate font-mono text-[9px] text-slate-400'>
                          {inp.label || inp.key}
                        </span>
                        <select
                          value={binding.binding_type}
                          onChange={(e) =>
                            updateBinding(inp.key, {
                              binding_type: e.target.value,
                              binding_value: ''
                            })
                          }
                          className='w-20 shrink-0 rounded border border-slate-200 bg-white px-1 py-px text-[9px]'
                        >
                          <option value='item_field'>Field</option>
                          <option value='static'>Static</option>
                          <option value='url_param'>URL Param</option>
                        </select>
                      </div>
                      {binding.binding_type === 'item_field' ? (
                        <FieldPicker
                          collection={tableName}
                          fields={allFields}
                          relations={relations as CMSRelation[]}
                          value={binding.binding_value}
                          onChange={(picked) =>
                            updateBinding(inp.key, { binding_value: picked.path.join('.') })
                          }
                          onClear={() => updateBinding(inp.key, { binding_value: '' })}
                          placeholder='Select field…'
                        />
                      ) : (
                        <input
                          type='text'
                          value={binding.binding_value}
                          placeholder={
                            binding.binding_type === 'url_param' ? 'param name' : 'value'
                          }
                          onChange={(e) =>
                            updateBinding(inp.key, { binding_value: e.target.value })
                          }
                          className='w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[9px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      }
      return undefined
    },
    [tableName, localOverrides, widgetSlotMeta, availableWidgets]
  )

  const FORMAT_OPTIONS = [
    { value: 'text', label: 'Text (default)' },
    { value: 'currency', label: 'Currency ($)' },
    { value: 'integer', label: 'Integer' },
    { value: 'decimal', label: 'Decimal' },
    { value: 'percent', label: 'Percent' },
    { value: 'date', label: 'Date' },
    { value: 'datetime', label: 'Date & Time' }
  ]

  const getHeaderFieldExtraControls = useCallback(
    (f: string): React.ReactNode => {
      const isWidgetSlot = typeof f === 'string' && f.startsWith('__widget_') && f.endsWith('__')

      if (isWidgetSlot) {
        const wMeta = widgetSlotMeta[f]
        if (!wMeta) return undefined
        const wDef = availableWidgets.find((w) => w.id === wMeta.widget_id)
        const declaredInputs =
          (wDef?.inputs as Array<{
            key: string
            label: string
            type: string
            required?: boolean
          }> | null) ?? []
        const derivedInputs: Array<{ key: string; label: string; type: string }> = (() => {
          if (declaredInputs.length > 0) return []
          const cfg =
            ((wDef as unknown as Record<string, unknown>)?.config as Record<
              string,
              unknown
            > | null) ?? {}
          const pb =
            (cfg.param_bindings as Array<{ param?: string; input_key?: string }> | null) ?? []
          const seen = new Set<string>()
          const out: Array<{ key: string; label: string; type: string }> = []
          for (const b of pb) {
            const k = b.input_key
            if (k && !seen.has(k)) {
              seen.add(k)
              out.push({ key: k, label: k, type: 'string' })
            }
          }
          return out
        })()
        const wInputs = declaredInputs.length > 0 ? declaredInputs : derivedInputs
        const updateBinding = (
          inputKey: string,
          patch: Partial<{ binding_type: string; binding_value: string }>
        ) => {
          setWidgetSlotMeta((prev) => {
            const prevMeta = prev[f]
            const existing = prevMeta.input_bindings.find((b) => b.key === inputKey)
            const updated = {
              key: inputKey,
              binding_type: (patch.binding_type ?? existing?.binding_type ?? 'item_field') as
                | 'item_field'
                | 'static'
                | 'url_param',
              binding_value: patch.binding_value ?? existing?.binding_value ?? ''
            }
            const next = prevMeta.input_bindings.filter((b) => b.key !== inputKey)
            next.push(updated)
            return { ...prev, [f]: { ...prevMeta, input_bindings: next } }
          })
          hasLocalChangeRef.current = true
          changeSeqRef.current++
        }
        return (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type='button'
                className='ml-0.5 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                onClick={(e) => e.stopPropagation()}
              >
                <Settings2 className='h-3 w-3' />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className='w-52 p-2 space-y-2'
              side='bottom'
              align='start'
              onClick={(e) => e.stopPropagation()}
            >
              <div className='space-y-1'>
                <p className='text-[10px] font-medium text-slate-400'>Label override</p>
                <input
                  type='text'
                  placeholder='Use default'
                  defaultValue={wMeta.label_override ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim() || null
                    setWidgetSlotMeta((prev) => ({
                      ...prev,
                      [f]: { ...prev[f], label_override: v }
                    }))
                    hasLocalChangeRef.current = true
                    changeSeqRef.current++
                  }}
                  className='w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan placeholder:text-slate-300'
                />
              </div>
              {wInputs.length > 0 && (
                <div className='space-y-1.5'>
                  <p className='text-[10px] font-medium text-slate-400'>Bindings</p>
                  {wInputs.map((inp) => {
                    const binding = wMeta.input_bindings.find((b) => b.key === inp.key) ?? {
                      key: inp.key,
                      binding_type: 'item_field' as const,
                      binding_value: ''
                    }
                    return (
                      <div key={inp.key} className='space-y-0.5'>
                        <div className='flex items-center gap-1'>
                          <span className='w-16 shrink-0 truncate font-mono text-[9px] text-slate-400'>
                            {inp.label || inp.key}
                          </span>
                          <select
                            value={binding.binding_type}
                            onChange={(e) =>
                              updateBinding(inp.key, {
                                binding_type: e.target.value,
                                binding_value: ''
                              })
                            }
                            className='w-20 shrink-0 rounded border border-slate-200 bg-white px-1 py-px text-[9px]'
                          >
                            <option value='item_field'>Field</option>
                            <option value='static'>Static</option>
                            <option value='url_param'>URL Param</option>
                          </select>
                        </div>
                        {binding.binding_type === 'item_field' ? (
                          <FieldPicker
                            collection={tableName}
                            fields={allFields}
                            relations={relations as CMSRelation[]}
                            value={binding.binding_value}
                            onChange={(picked) =>
                              updateBinding(inp.key, { binding_value: picked.path.join('.') })
                            }
                            onClear={() => updateBinding(inp.key, { binding_value: '' })}
                            placeholder='Select field…'
                          />
                        ) : (
                          <input
                            type='text'
                            value={binding.binding_value}
                            placeholder={
                              binding.binding_type === 'url_param' ? 'param name' : 'value'
                            }
                            onChange={(e) =>
                              updateBinding(inp.key, { binding_value: e.target.value })
                            }
                            className='w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[9px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </PopoverContent>
          </Popover>
        )
      }

      const meta = headerFieldDisplayMeta[f] ?? { label_override: null, display_format: 'text' }
      const update = (patch: Partial<HeaderFieldMeta>) => {
        setHeaderFieldDisplayMeta((prev) => ({ ...prev, [f]: { ...meta, ...patch } }))
        hasLocalChangeRef.current = true
        changeSeqRef.current++
      }
      return (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='ml-0.5 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600'
              onClick={(e) => e.stopPropagation()}
            >
              <Settings2 className='h-3 w-3' />
            </button>
          </PopoverTrigger>
          <PopoverContent
            className='w-52 p-2 space-y-2'
            side='bottom'
            align='start'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='space-y-1'>
              <p className='text-[10px] text-slate-400 font-medium'>Label override</p>
              <input
                type='text'
                placeholder='Use default'
                defaultValue={meta.label_override ?? ''}
                onBlur={(e) => update({ label_override: e.target.value.trim() || null })}
                className='w-full rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan placeholder:text-slate-300'
              />
            </div>
            <div className='space-y-1'>
              <p className='text-[10px] text-slate-400 font-medium'>Display format</p>
              <select
                value={meta.display_format}
                onChange={(e) => update({ display_format: e.target.value })}
                className='w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
              >
                {FORMAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className='space-y-1'>
              <p className='text-[10px] text-slate-400 font-medium'>Color</p>
              <div className='flex flex-wrap gap-1'>
                {(['default', 'cyan', 'blue', 'green', 'amber', 'red', 'purple'] as const).map(
                  (c) => (
                    <button
                      key={c}
                      type='button'
                      onClick={() => update({ color: c === 'default' ? undefined : c })}
                      className={[
                        'w-5 h-5 rounded-full border-2 transition-all',
                        meta.color === c || (!meta.color && c === 'default')
                          ? 'border-nvr-cyan scale-110'
                          : 'border-transparent',
                        c === 'default'
                          ? 'bg-slate-300'
                          : c === 'cyan'
                            ? 'bg-nvr-cyan'
                            : c === 'blue'
                              ? 'bg-blue-500'
                              : c === 'green'
                                ? 'bg-emerald-500'
                                : c === 'amber'
                                  ? 'bg-amber-500'
                                  : c === 'red'
                                    ? 'bg-red-500'
                                    : 'bg-purple-500'
                      ].join(' ')}
                    />
                  )
                )}
              </div>
            </div>
            <div className='space-y-1'>
              <p className='text-[10px] text-slate-400 font-medium'>Weight</p>
              <div className='flex gap-1'>
                {(['normal', 'medium', 'semibold', 'bold'] as const).map((w) => (
                  <button
                    key={w}
                    type='button'
                    onClick={() => update({ weight: w === 'normal' ? undefined : w })}
                    className={[
                      'rounded px-1.5 py-0.5 text-[10px] border transition-colors',
                      meta.weight === w || (!meta.weight && w === 'normal')
                        ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    ].join(' ')}
                  >
                    {w[0].toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className='space-y-1'>
              <p className='text-[10px] text-slate-400 font-medium'>Display as</p>
              <div className='flex gap-1'>
                {(['text', 'pill', 'tag'] as const).map((d) => (
                  <button
                    key={d}
                    type='button'
                    onClick={() => update({ display_as: d === 'text' ? undefined : d })}
                    className={[
                      'rounded px-1.5 py-0.5 text-[10px] border transition-colors',
                      meta.display_as === d || (!meta.display_as && d === 'text')
                        ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    ].join(' ')}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      )
    },
    [headerFieldDisplayMeta, widgetSlotMeta, availableWidgets, tableName, allFields, relations]
  )

  const updateSlot = useCallback(
    (key: SlotKey, patch: Partial<SlotState>) => {
      setSlots((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))
      markSlotDirty()
    },
    [markSlotDirty]
  )

  // Move a slot up/down within the combined ordering of groups + ungrouped + slots.
  // We only renumber the slots' sort values; group/ungrouped positions are untouched.
  const moveSlot = useCallback(
    (key: SlotKey, dir: -1 | 1) => {
      setSlots((prev) => {
        const ordered = [...SLOT_KEYS].sort((a, b) => prev[a].sort - prev[b].sort)
        const idx = ordered.indexOf(key)
        const swapIdx = idx + dir
        if (swapIdx < 0 || swapIdx >= ordered.length) return prev
        const other = ordered[swapIdx]
        return {
          ...prev,
          [key]: { ...prev[key], sort: prev[other].sort },
          [other]: { ...prev[other], sort: prev[key].sort }
        }
      })
      markSlotDirty()
    },
    [markSlotDirty]
  )

  const slotLabel = useCallback(
    (key: SlotKey) => slots[key].label_override?.trim() || SLOT_META[key].defaultLabel,
    [slots]
  )
  const orderedSlots = useMemo(
    () => [...SLOT_KEYS].sort((a, b) => slots[a].sort - slots[b].sort),
    [slots]
  )

  // M2O helpers for cascade filter editor
  const getM2OFields = useCallback(
    (): CascadeParentField[] =>
      allFields
        .filter((f) => relKind(f.field) === 'M2O' || relKind(f.field) === 'M2M')
        .map((f) => ({
          field: f.field,
          label: getFieldSettings(f.field).label ?? titleCase(f.field),
          kind: relKind(f.field) as 'M2O' | 'M2M'
        })),
    [allFields, relKind, getFieldSettings]
  )

  const getDependencyConfig = useCallback(
    (f: string): Record<string, unknown> | null =>
      (fieldConfig.find((c) => c.field === f)?.dependency_config ?? null) as Record<
        string,
        unknown
      > | null,
    [fieldConfig]
  )

  // Returns the far-end related collection for M2O or M2M fields (used for filter_column suggestions)
  const getRelatedCollection = useCallback(
    (fieldName: string): string | null => {
      const kind = relKind(fieldName)
      if (kind === 'M2O') {
        return relations.find((r) => r.many_field === fieldName)?.one_collection ?? null
      }
      if (kind === 'M2M') {
        const junction = relations.find(
          (r) => r.one_field === fieldName && r.junction_field !== null
        )
        if (!junction) return null
        return (
          relations.find(
            (r) =>
              r.many_collection === junction.many_collection &&
              r.many_field === junction.junction_field &&
              r.one_field !== fieldName
          )?.one_collection ?? null
        )
      }
      if (kind === 'O2M') {
        const rel = relations.find(
          (r) =>
            !r.junction_field &&
            (r.one_field === fieldName || (r.one_field === 'id' && r.many_collection === fieldName))
        )
        return rel?.many_collection ?? null
      }
      return null
    },
    [relations, relKind]
  )

  const activeFieldData = activeFieldId ? allFields.find((f) => f.field === activeFieldId) : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => {
        const id = String(args.active.id)
        if (id.startsWith('group:') || id.startsWith('slot:')) {
          // Use pointer position for group/slot — makes it feel natural with variable-height items
          const pointer = pointerWithin(args)
          return pointer.length > 0 ? pointer : closestCenter(args)
        }
        const pointer = pointerWithin(args)
        return pointer.length > 0 ? pointer : rectIntersection(args)
      }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className='flex gap-4 items-start'>
        {/* Left sidebar — unassigned field pool; also a drop target so dragging chips back here unassigns them */}
        <div
          className='w-60 shrink-0 self-start sticky'
          style={{ top: 100, height: 'calc(100dvh - 220px)' }}
        >
          <DroppableFieldZone containerId='__pool__' className='h-full'>
            <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card flex flex-col h-full overflow-hidden'>
              {/* Header */}
              <div className='shrink-0 border-b border-slate-100 dark:border-border px-3 pt-2.5 pb-2 space-y-2'>
                <div className='flex items-center justify-between'>
                  <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
                    Fields
                  </span>
                  <span className='rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 py-px text-[10px] font-medium text-slate-500 dark:text-slate-400 tabular-nums'>
                    {(localFieldOrder.__pool__ ?? []).length}
                  </span>
                </div>
                {/* Search */}
                <div className='relative'>
                  <Search className='absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-400 pointer-events-none' />
                  <input
                    type='text'
                    value={poolSearch}
                    onChange={(e) => setPoolSearch(e.target.value)}
                    placeholder='Search fields…'
                    className='w-full rounded-md border border-slate-200 dark:border-border bg-slate-50 dark:bg-slate-900 pl-6 pr-2 py-1 text-[11px] text-slate-700 dark:text-slate-200 placeholder:text-slate-400 outline-none focus:border-nvr-cyan focus:ring-1 focus:ring-nvr-cyan/30'
                  />
                  {poolSearch && (
                    <button
                      type='button'
                      onClick={() => setPoolSearch('')}
                      className='absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600'
                    >
                      <X className='h-2.5 w-2.5' />
                    </button>
                  )}
                </div>
                {/* Relation-path field: pull a field from a related collection (any depth) */}
                <div className='mt-1.5'>
                  <CollectionFieldPicker
                    collection={tableName}
                    value=''
                    onChange={handleAddRelationPath}
                    placeholder='＋ Related field…'
                  />
                </div>
                {/* Category filter pills */}
                {(() => {
                  const all = localFieldOrder.__pool__ ?? []
                  const wk = all.filter(
                    (f) => typeof f === 'string' && f.startsWith('__widget_') && f.endsWith('__')
                  )
                  const nw = all.filter((f) => !wk.includes(f))
                  const rl = nw.filter((f) => relKind(f) !== null)
                  const pl = nw.filter((f) => relKind(f) === null)
                  const cats: Array<{ id: typeof poolCategory; label: string; count: number }> = [
                    { id: 'all', label: 'All', count: all.length },
                    { id: 'fields', label: 'Fields', count: pl.length },
                    { id: 'relations', label: 'Relations', count: rl.length },
                    ...(wk.length > 0
                      ? [{ id: 'widgets' as const, label: 'Widgets', count: wk.length }]
                      : [])
                  ]
                  return (
                    <div className='flex gap-1'>
                      {cats.map((c) => (
                        <button
                          key={c.id}
                          type='button'
                          onClick={() => setPoolCategory(c.id)}
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                            poolCategory === c.id
                              ? 'bg-nvr-cyan/10 text-nvr-cyan'
                              : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
                          )}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  )
                })()}
              </div>
              {/* Field list */}
              <div className='flex-1 min-h-0 overflow-y-auto'>
                {(() => {
                  const all = localFieldOrder.__pool__ ?? []
                  const getLabel = (f: string) => titleCase(f)
                  const widgetKeys = all.filter(
                    (f) => typeof f === 'string' && f.startsWith('__widget_') && f.endsWith('__')
                  )
                  const nonWidgets = all.filter((f) => !widgetKeys.includes(f))
                  const relFields = nonWidgets
                    .filter((f) => relKind(f) !== null)
                    .sort((a, b) => getLabel(a).localeCompare(getLabel(b)))
                  const plainFields = nonWidgets
                    .filter((f) => relKind(f) === null)
                    .sort((a, b) => getLabel(a).localeCompare(getLabel(b)))

                  const applySearch = (fields: string[]) =>
                    poolSearch.trim()
                      ? fields.filter((f) =>
                          getLabel(f).toLowerCase().includes(poolSearch.toLowerCase())
                        )
                      : fields

                  const visiblePlain =
                    poolCategory === 'all' || poolCategory === 'fields'
                      ? applySearch(plainFields)
                      : []
                  const visibleRel =
                    poolCategory === 'all' || poolCategory === 'relations'
                      ? applySearch(relFields)
                      : []
                  const visibleWidgets =
                    poolCategory === 'all' || poolCategory === 'widgets'
                      ? applySearch(widgetKeys)
                      : []
                  const totalVisible =
                    visiblePlain.length + visibleRel.length + visibleWidgets.length

                  const renderRow = (f: string) => {
                    if (f === OWNERS_FIELD) {
                      return (
                        <SortableFieldChip
                          key={f}
                          sortableId={`f::__pool__::${f}`}
                          fieldName={f}
                          displayName='Owners'
                          fieldType='owners'
                          colSpan={12}
                          compact
                        />
                      )
                    }
                    if (f === PDF_FIELD) {
                      return (
                        <SortableFieldChip
                          key={f}
                          sortableId={`f::__pool__::${f}`}
                          fieldName={f}
                          displayName='PDF Button'
                          fieldType='pdf'
                          colSpan={12}
                          compact
                        />
                      )
                    }
                    if (typeof f === 'string' && f.startsWith('__widget_') && f.endsWith('__')) {
                      const meta = widgetSlotMeta[f]
                      return (
                        <SortableFieldChip
                          key={f}
                          sortableId={`f::__pool__::${f}`}
                          fieldName={f}
                          displayName={meta?.label_override || meta?.name || 'Widget'}
                          fieldType='widget'
                          colSpan={12}
                          compact
                        />
                      )
                    }
                    const ft = allFields.find((af) => af.field === f)
                    const kind = relKind(f)
                    return (
                      <SortableFieldChip
                        key={f}
                        sortableId={`f::__pool__::${f}`}
                        fieldName={f}
                        displayName={titleCase(f)}
                        fieldType={kind ?? friendlyType(ft?.type, f)}
                        abstractType={kind ? kind.toLowerCase() : ft?.type}
                        isM2O={kind === 'M2O'}
                        isM2M={kind === 'M2M'}
                        colSpan={12}
                        compact
                      />
                    )
                  }

                  if (totalVisible === 0) {
                    return (
                      <div className='px-3 py-6 text-center text-[11px] text-slate-400'>
                        {poolSearch ? `No fields matching "${poolSearch}"` : 'All fields assigned'}
                      </div>
                    )
                  }

                  return (
                    <div className='py-1'>
                      {visiblePlain.length > 0 &&
                        (poolCategory === 'all' || poolCategory === 'fields') && (
                          <div>
                            {poolCategory === 'all' && (
                              <p className='px-3 pt-2 pb-0.5 text-[10px] font-semibold text-slate-400 dark:text-slate-500'>
                                Fields
                              </p>
                            )}
                            {visiblePlain.map(renderRow)}
                          </div>
                        )}
                      {visibleRel.length > 0 &&
                        (poolCategory === 'all' || poolCategory === 'relations') && (
                          <div>
                            {poolCategory === 'all' && (
                              <p className='px-3 pt-2 pb-0.5 text-[10px] font-semibold text-slate-400 dark:text-slate-500'>
                                Relations
                              </p>
                            )}
                            {visibleRel.map(renderRow)}
                          </div>
                        )}
                      {visibleWidgets.length > 0 &&
                        (poolCategory === 'all' || poolCategory === 'widgets') && (
                          <div>
                            {poolCategory === 'all' && (
                              <p className='px-3 pt-2 pb-0.5 text-[10px] font-semibold text-slate-400 dark:text-slate-500'>
                                Widgets
                              </p>
                            )}
                            {visibleWidgets.map(renderRow)}
                          </div>
                        )}
                    </div>
                  )
                })()}
              </div>
            </div>
          </DroppableFieldZone>
        </div>

        {/* Main area — groups */}
        <div className='min-w-0 flex-1 space-y-3'>
          <div className='flex items-center justify-between'>
            <p className='text-[12px] text-slate-500'>
              {layoutType === 'table'
                ? 'Drag fields into the Columns zone to define table column order. No groups or col widths in table mode.'
                : 'Drag fields into groups and set column widths for side-by-side layout.'}
            </p>
            {layoutType !== 'table' && (
              <div className='flex gap-2'>
                {availableWidgets.length > 0 && (
                  <Popover open={addingWidget} onOpenChange={setAddingWidget}>
                    <PopoverTrigger asChild>
                      <Button size='sm' variant='outline' className='h-7 text-[12px]'>
                        <Plus className='mr-1 h-3 w-3' />
                        Add Widget
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className='w-56 p-1' align='end'>
                      {availableWidgets.map((w) => {
                        const key = `__widget_${w.id}__`
                        const alreadyAdded = widgetSlotMeta[key] !== undefined
                        return (
                          <button
                            key={w.id}
                            type='button'
                            disabled={alreadyAdded}
                            onClick={() => {
                              if (alreadyAdded) return
                              setWidgetSlotMeta((prev) => ({
                                ...prev,
                                [key]: {
                                  widget_id: w.id,
                                  name: w.name,
                                  label_override: null,
                                  is_visible: true,
                                  input_bindings: []
                                }
                              }))
                              setLocalFieldOrder((prev) => ({
                                ...prev,
                                __pool__: [...(prev.__pool__ ?? []), key],
                                __unassigned__: [...(prev.__unassigned__ ?? []), key]
                              }))
                              hasLocalChangeRef.current = true
                              changeSeqRef.current++
                              setAddingWidget(false)
                            }}
                            className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-50 disabled:opacity-40'
                          >
                            <span className='flex-1'>{w.name}</span>
                            <span className='rounded bg-nvr-cyan/10 px-1 py-px text-[10px] text-nvr-cyan'>
                              {w.widget_type}
                            </span>
                          </button>
                        )
                      })}
                    </PopoverContent>
                  </Popover>
                )}
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7 text-[12px]'
                  onClick={() => setAdding(true)}
                >
                  <Plus className='mr-1 h-3 w-3' />
                  Add Group
                </Button>
              </div>
            )}
          </div>

          {/* Subtitle config */}
          {layoutType !== 'table' && layoutId && (
            <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              <div className='flex items-center justify-between border-b border-slate-100 dark:border-border px-3 py-2'>
                <p className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                  Header Subtitle
                </p>
                <input
                  type='checkbox'
                  checked={!!subtitleConfig}
                  onChange={(e) => {
                    hasLocalChangeRef.current = true
                    changeSeqRef.current++
                    setSubtitleConfig(e.target.checked ? { fields: [], separator: ' | ' } : null)
                  }}
                  className='h-3.5 w-3.5 rounded accent-nvr-cyan'
                />
              </div>
              {!!subtitleConfig && (
                <div className='p-3 space-y-2'>
                  <p className='text-[10px] text-slate-400'>
                    Fields shown inline below the item title in the form header.
                  </p>
                  <div className='flex items-center gap-2'>
                    <span className='text-[10px] text-slate-400 shrink-0'>Separator</span>
                    <input
                      type='text'
                      value={subtitleConfig.separator}
                      onChange={(e) => {
                        hasLocalChangeRef.current = true
                        changeSeqRef.current++
                        setSubtitleConfig((c) => (c ? { ...c, separator: e.target.value } : null))
                      }}
                      className='w-24 h-6 rounded border border-slate-200 bg-white px-2 text-[11px] text-slate-700 dark:border-border dark:bg-background dark:text-slate-300'
                    />
                  </div>
                  <div className='flex flex-wrap gap-1.5'>
                    {subtitleConfig.fields.map((sf, i) => (
                      <span
                        key={i}
                        className='relative inline-flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-2 py-0.5 text-[11px] text-nvr-navy dark:text-nvr-cyan'
                      >
                        {sf.label ?? sf.field}
                        <button
                          type='button'
                          onClick={() => setSubtitleStyleOpen(subtitleStyleOpen === i ? null : i)}
                          className='hover:text-nvr-cyan ml-0.5 opacity-50 hover:opacity-100'
                        >
                          ⚙
                        </button>
                        <button
                          type='button'
                          onClick={() => {
                            hasLocalChangeRef.current = true
                            changeSeqRef.current++
                            setSubtitleConfig((c) =>
                              c ? { ...c, fields: c.fields.filter((_, j) => j !== i) } : null
                            )
                          }}
                          className='hover:text-red-500 opacity-50 hover:opacity-100'
                        >
                          ✕
                        </button>
                        {subtitleStyleOpen === i && (
                          <>
                            <div
                              className='fixed inset-0 z-40'
                              onClick={() => setSubtitleStyleOpen(null)}
                            />
                            <div className='absolute left-0 top-full z-50 mt-1 w-44 rounded-lg border border-slate-200 bg-white shadow-lg dark:border-border dark:bg-card p-2 space-y-2'>
                              <div className='space-y-1'>
                                <p className='text-[10px] font-medium text-slate-400'>Color</p>
                                <div className='flex flex-wrap gap-1'>
                                  {(
                                    [
                                      'default',
                                      'cyan',
                                      'blue',
                                      'green',
                                      'amber',
                                      'red',
                                      'purple'
                                    ] as const
                                  ).map((c) => (
                                    <button
                                      key={c}
                                      type='button'
                                      onClick={() => {
                                        hasLocalChangeRef.current = true
                                        changeSeqRef.current++
                                        setSubtitleConfig((cfg) =>
                                          cfg
                                            ? {
                                                ...cfg,
                                                fields: cfg.fields.map((f, j) =>
                                                  j === i
                                                    ? {
                                                        ...f,
                                                        color: c === 'default' ? undefined : c
                                                      }
                                                    : f
                                                )
                                              }
                                            : null
                                        )
                                      }}
                                      className={[
                                        'w-5 h-5 rounded-full border-2 transition-all',
                                        sf.color === c || (!sf.color && c === 'default')
                                          ? 'border-nvr-cyan scale-110'
                                          : 'border-transparent',
                                        c === 'default'
                                          ? 'bg-slate-300'
                                          : c === 'cyan'
                                            ? 'bg-nvr-cyan'
                                            : c === 'blue'
                                              ? 'bg-blue-500'
                                              : c === 'green'
                                                ? 'bg-emerald-500'
                                                : c === 'amber'
                                                  ? 'bg-amber-500'
                                                  : c === 'red'
                                                    ? 'bg-red-500'
                                                    : 'bg-purple-500'
                                      ].join(' ')}
                                    />
                                  ))}
                                </div>
                              </div>
                              <div className='space-y-1'>
                                <p className='text-[10px] font-medium text-slate-400'>Weight</p>
                                <div className='flex gap-1'>
                                  {(['normal', 'medium', 'semibold', 'bold'] as const).map((w) => (
                                    <button
                                      key={w}
                                      type='button'
                                      onClick={() => {
                                        hasLocalChangeRef.current = true
                                        changeSeqRef.current++
                                        setSubtitleConfig((cfg) =>
                                          cfg
                                            ? {
                                                ...cfg,
                                                fields: cfg.fields.map((f, j) =>
                                                  j === i
                                                    ? {
                                                        ...f,
                                                        weight: w === 'normal' ? undefined : w
                                                      }
                                                    : f
                                                )
                                              }
                                            : null
                                        )
                                      }}
                                      className={[
                                        'rounded px-1.5 py-0.5 text-[10px] border transition-colors',
                                        sf.weight === w || (!sf.weight && w === 'normal')
                                          ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan'
                                          : 'border-slate-200 text-slate-500 hover:border-slate-300'
                                      ].join(' ')}
                                    >
                                      {w[0].toUpperCase()}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div className='space-y-1'>
                                <p className='text-[10px] font-medium text-slate-400'>Display as</p>
                                <div className='flex gap-1'>
                                  {(['text', 'pill', 'tag'] as const).map((d) => (
                                    <button
                                      key={d}
                                      type='button'
                                      onClick={() => {
                                        hasLocalChangeRef.current = true
                                        changeSeqRef.current++
                                        setSubtitleConfig((cfg) =>
                                          cfg
                                            ? {
                                                ...cfg,
                                                fields: cfg.fields.map((f, j) =>
                                                  j === i
                                                    ? {
                                                        ...f,
                                                        display_as: d === 'text' ? undefined : d
                                                      }
                                                    : f
                                                )
                                              }
                                            : null
                                        )
                                      }}
                                      className={[
                                        'rounded px-1.5 py-0.5 text-[10px] border transition-colors',
                                        sf.display_as === d || (!sf.display_as && d === 'text')
                                          ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan'
                                          : 'border-slate-200 text-slate-500 hover:border-slate-300'
                                      ].join(' ')}
                                    >
                                      {d}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </>
                        )}
                      </span>
                    ))}
                  </div>
                  <div className='relative'>
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-6 w-full justify-start text-[11px] font-normal text-slate-500 border-dashed'
                      onClick={() => setSubtitlePickerOpen((v) => !v)}
                    >
                      <Plus className='mr-1 h-3 w-3' />
                      Add field…
                    </Button>
                    {subtitlePickerOpen && (
                      <>
                        <div
                          className='fixed inset-0 z-40'
                          onClick={() => setSubtitlePickerOpen(false)}
                        />
                        <div className='absolute left-0 top-full z-50 mt-1'>
                          <FieldPickerPanel
                            collection={tableName}
                            fields={
                              allFields.filter(
                                (f) =>
                                  !f.field.startsWith('__') &&
                                  !subtitleConfig.fields.some((sf) => sf.field === f.field)
                              ) as CMSField[]
                            }
                            relations={relations as CMSRelation[]}
                            onSelect={(picked) => {
                              hasLocalChangeRef.current = true
                              changeSeqRef.current++
                              setSubtitleConfig((c) =>
                                c
                                  ? {
                                      ...c,
                                      fields: [
                                        ...c.fields,
                                        {
                                          field: picked.path.join('.'),
                                          label: picked.pathLabels.join(' › ')
                                        }
                                      ]
                                    }
                                  : null
                              )
                              setSubtitlePickerOpen(false)
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Header zone — widgets dragged here render in the ItemEdit page header */}
          {layoutType !== 'table' && (
            <div className='rounded-lg border border-slate-200 bg-white'>
              <div className='flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2'>
                <span className='text-[11px] font-medium text-slate-500'>Item Header</span>
                <span className='text-[10px] text-slate-300'>
                  — items dropped here appear in a strip below the header bar
                </span>
              </div>
              <DroppableFieldZone containerId='__header__'>
                <SortableContext
                  items={(localFieldOrder.__header__ ?? []).map((f) =>
                    toSortableId('__header__', f)
                  )}
                  strategy={rectSortingStrategy}
                >
                  <div
                    className={cn(
                      'min-h-[44px] p-2',
                      (localFieldOrder.__header__ ?? []).length === 0
                        ? 'flex items-center justify-center'
                        : 'flex flex-wrap gap-2'
                    )}
                  >
                    {(localFieldOrder.__header__ ?? []).length === 0 ? (
                      <p className='text-[11px] text-slate-300'>Drop widgets or fields here</p>
                    ) : (
                      (localFieldOrder.__header__ ?? []).map((f) => {
                        const isWidget =
                          typeof f === 'string' && f.startsWith('__widget_') && f.endsWith('__')
                        const meta = isWidget ? widgetSlotMeta[f] : undefined
                        const fieldMeta = !isWidget
                          ? allFields.find((af) => af.field === f)
                          : undefined
                        return (
                          <SortableFieldChip
                            key={toSortableId('__header__', f)}
                            sortableId={toSortableId('__header__', f)}
                            fieldName={f}
                            displayName={
                              isWidget
                                ? meta?.label_override || meta?.name || 'Widget'
                                : headerFieldDisplayMeta[f]?.label_override ||
                                  (f === '__owners__'
                                    ? 'Owners'
                                    : f === '__pdf__'
                                      ? 'PDF'
                                      : null) ||
                                  titleCase(fieldConfig.find((fc) => fc.field === f)?.label ?? f)
                            }
                            fieldType={
                              isWidget
                                ? 'widget'
                                : (fieldMeta?.interface ?? fieldMeta?.type ?? 'text')
                            }
                            colSpan={12}
                            onUnassign={() => {
                              setLocalFieldOrder((prev) => ({
                                ...prev,
                                __header__: (prev.__header__ ?? []).filter((x) => x !== f),
                                __unassigned__: [...(prev.__unassigned__ ?? []), f]
                              }))
                              hasLocalChangeRef.current = true
                              changeSeqRef.current++
                            }}
                            extraControls={
                              f === PDF_FIELD ? getExtraControls(f) : getHeaderFieldExtraControls(f)
                            }
                            inGrid={false}
                          />
                        )
                      })
                    )}
                  </div>
                </SortableContext>
              </DroppableFieldZone>
            </div>
          )}

          {/* Groups + Ungrouped — unified sortable list */}
          {adding && layoutType !== 'table' && (
            <div className='rounded-lg border border-slate-200 bg-white p-4 space-y-3'>
              <p className='text-[12px] font-medium text-slate-700'>New Group</p>
              <div className='grid grid-cols-3 gap-3'>
                <div>
                  <Label className='mb-1 block text-[11px]'>Key (slug)</Label>
                  <Input
                    value={newKey}
                    onChange={(e) =>
                      setNewKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))
                    }
                    placeholder='details'
                    className='h-7 font-mono text-[12px]'
                  />
                </div>
                <div>
                  <Label className='mb-1 block text-[11px]'>Label</Label>
                  <Input
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder='Details'
                    className='h-7 text-[12px]'
                  />
                </div>
                <div>
                  <Label className='mb-1 block text-[11px]'>Type</Label>
                  <Sel
                    value={newType}
                    onChange={(v) => setNewType(v as 'section' | 'tab' | 'metadata' | 'container')}
                    options={[
                      { value: 'section', label: 'Section' },
                      { value: 'tab', label: 'Tab' },
                      { value: 'metadata', label: 'Record Info (read-only)' },
                      { value: 'container', label: 'Container (tabs/steps)' }
                    ]}
                  />
                </div>
              </div>
              <div className='flex justify-end gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  className='h-7 text-[12px]'
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </Button>
                <Button
                  type='button'
                  size='sm'
                  className='h-7 bg-nvr-cyan text-[12px] text-white'
                  disabled={!newKey.trim() || !newLabel.trim() || createMut.isPending}
                  onClick={() =>
                    createMut.mutate({
                      collection: tableName,
                      key: newKey.trim(),
                      label: newLabel.trim(),
                      type: newType
                    })
                  }
                >
                  Create
                </Button>
              </div>
            </div>
          )}

          {groupsLoading ? (
            <div className='space-y-2'>
              {[1, 2].map((k) => (
                <Skeleton key={k} className='h-24 w-full rounded-lg' />
              ))}
            </div>
          ) : (
            <SortableContext
              items={orderedItems.map((x) =>
                x === '__ungrouped__'
                  ? 'group:__ungrouped__'
                  : SLOT_KEYS.includes(x as SlotKey)
                    ? `slot:${x}`
                    : `group:${(x as FieldGroup).key}`
              )}
              strategy={verticalListSortingStrategy}
            >
              <div className='space-y-3'>
                {orderedItems.map((item) => {
                  if (item === '__ungrouped__')
                    return (
                      <SortableUngroupedZone
                        key='__ungrouped__'
                        localFieldOrder={localFieldOrder}
                        allFields={allFields}
                        getColSpan={getColSpan}
                        patchField={patchField}
                        getFieldSettings={getFieldSettings}
                        handleFieldSettings={handleFieldSettings}
                        relKind={relKind}
                        friendlyType={friendlyType}
                        getM2OFields={getM2OFields}
                        getDependencyConfig={getDependencyConfig}
                        getRelatedCollection={getRelatedCollection}
                        onUnassign={handleUnassign}
                        isTableMode={layoutType === 'table'}
                        getExtraControls={getExtraControls}
                        widgetSlotMeta={widgetSlotMeta}
                        getInlineDisplay={(f) => inlineDisplayMeta[f]}
                        onInlineDisplayChange={(f, config) => {
                          setInlineDisplayMeta((prev) => ({ ...prev, [f]: config }))
                          hasLocalChangeRef.current = true
                          changeSeqRef.current++
                        }}
                        getLockConditions={(f) => localLockConditions[f] ?? []}
                        onLockConditions={(f, v) => {
                          setLocalLockConditions((prev) => ({ ...prev, [f]: v }))
                          hasLocalChangeRef.current = true
                          changeSeqRef.current++
                        }}
                        collection={tableName}
                        getPrefillFromParent={
                          layoutType === 'addendum'
                            ? (f) =>
                                (localOverrides[f]?.prefill_from_parent as boolean | undefined) ??
                                true
                            : undefined
                        }
                        onPrefillFromParent={
                          layoutType === 'addendum'
                            ? (f, v) => {
                                setLocalOverrides((prev) => ({
                                  ...prev,
                                  [f]: { ...(prev[f] ?? {}), prefill_from_parent: v }
                                }))
                                hasLocalChangeRef.current = true
                                changeSeqRef.current++
                              }
                            : undefined
                        }
                      />
                    )
                  if (layoutType === 'table') return null
                  if (SLOT_KEYS.includes(item as SlotKey))
                    return (
                      <SortableSlotCard
                        key={item as SlotKey}
                        slotKey={item as SlotKey}
                        slots={slots}
                        updateSlot={updateSlot}
                        editingSlot={editingSlot}
                        setEditingSlot={setEditingSlot}
                        slotLabelDraft={slotLabelDraft}
                        setSlotLabelDraft={setSlotLabelDraft}
                        tableName={tableName}
                      />
                    )
                  const g = item as FieldGroup
                  // Skip tabs nested inside a container — container card renders them
                  if (g.type === 'tab' && g.container_id) return null
                  const childTabs =
                    g.type === 'container'
                      ? groups
                          .filter((ch) => ch.container_id === g.id)
                          .sort((a, b) => a.sort - b.sort)
                      : []
                  return (
                    <div key={g.id} className='space-y-1.5'>
                      <SortableGroupCard
                        group={g}
                        fieldNames={localFieldOrder[g.key] ?? []}
                        allFields={allFields}
                        getColSpan={getColSpan}
                        onColSpan={(f, span) => patchField(f, { col_span: span })}
                        onToggleType={() =>
                          patchTypeMut.mutate({
                            id: g.id,
                            type:
                              g.type === 'section'
                                ? 'tab'
                                : g.type === 'tab'
                                  ? 'metadata'
                                  : g.type === 'metadata'
                                    ? 'container'
                                    : 'section'
                          })
                        }
                        onDelete={() => {
                          if (confirm(`Delete "${g.label}"? Fields will be unassigned.`))
                            deleteMut.mutate(g.id)
                        }}
                        onRename={(label) => renameMut.mutate({ id: g.id, label })}
                        onIconChange={(icon) => iconMut.mutate({ id: g.id, icon })}
                        getRelKind={relKind}
                        getFriendlyType={friendlyType}
                        getFieldSettings={getFieldSettings}
                        onFieldSettings={handleFieldSettings}
                        getM2OFields={getM2OFields}
                        getDependencyConfig={getDependencyConfig}
                        getRelatedCollection={getRelatedCollection}
                        onUnassign={handleUnassign}
                        onPatchTabMode={(id, tab_mode) => patchTabModeMut.mutate({ id, tab_mode })}
                        containerGroups={groups.filter((cg) => cg.type === 'container')}
                        onSetContainer={(id, container_id) =>
                          setContainerMut.mutate({ id, container_id })
                        }
                        onToggleCollapsed={(id) =>
                          patchCollapsedMut.mutate({
                            id,
                            is_collapsed: !groups.find((g) => g.id === id)?.is_collapsed
                          })
                        }
                        onGroupSettings={(id, patch) => patchGroupSettingsMut.mutate({ id, patch })}
                        getRowRevisions={(f) => localRowRevisions[f] ?? false}
                        onRowRevisions={(f, v) => {
                          setLocalRowRevisions((prev) => ({ ...prev, [f]: v }))
                          hasLocalChangeRef.current = true
                          changeSeqRef.current++
                        }}
                        getAllowRevisionRestore={(f) => localAllowRevisionRestore[f] ?? true}
                        onAllowRevisionRestore={(f, v) => {
                          setLocalAllowRevisionRestore((prev) => ({ ...prev, [f]: v }))
                          hasLocalChangeRef.current = true
                          changeSeqRef.current++
                        }}
                        getLockConditions={(f) => localLockConditions[f] ?? []}
                        onLockConditions={(f, v) => {
                          setLocalLockConditions((prev) => ({ ...prev, [f]: v }))
                          hasLocalChangeRef.current = true
                          changeSeqRef.current++
                        }}
                        getExtraControls={getExtraControls}
                        widgetSlotMeta={widgetSlotMeta}
                        getInlineDisplay={(f) => inlineDisplayMeta[f]}
                        onInlineDisplayChange={(f, config) => {
                          setInlineDisplayMeta((prev) => ({ ...prev, [f]: config }))
                          hasLocalChangeRef.current = true
                          changeSeqRef.current++
                        }}
                        collection={tableName}
                        getPrefillFromParent={
                          layoutType === 'addendum'
                            ? (f) =>
                                (localOverrides[f]?.prefill_from_parent as boolean | undefined) ??
                                true
                            : undefined
                        }
                        onPrefillFromParent={
                          layoutType === 'addendum'
                            ? (f, v) => {
                                setLocalOverrides((prev) => ({
                                  ...prev,
                                  [f]: { ...(prev[f] ?? {}), prefill_from_parent: v }
                                }))
                                hasLocalChangeRef.current = true
                                changeSeqRef.current++
                              }
                            : undefined
                        }
                      />
                      {childTabs.length > 0 && (
                        <div className='ml-4 border-l-2 border-slate-200 pl-3 space-y-1.5'>
                          {childTabs.map((ch) => (
                            <SortableGroupCard
                              key={ch.id}
                              group={ch}
                              fieldNames={localFieldOrder[ch.key] ?? []}
                              allFields={allFields}
                              getColSpan={getColSpan}
                              onColSpan={(f, span) => patchField(f, { col_span: span })}
                              onToggleType={() => {}}
                              onDelete={() => {
                                if (confirm(`Delete "${ch.label}"?`)) deleteMut.mutate(ch.id)
                              }}
                              onRename={(label) => renameMut.mutate({ id: ch.id, label })}
                              onIconChange={(icon) => iconMut.mutate({ id: ch.id, icon })}
                              getRelKind={relKind}
                              getFriendlyType={friendlyType}
                              getFieldSettings={getFieldSettings}
                              onFieldSettings={handleFieldSettings}
                              getM2OFields={getM2OFields}
                              getDependencyConfig={getDependencyConfig}
                              getRelatedCollection={getRelatedCollection}
                              onUnassign={handleUnassign}
                              containerGroups={groups.filter((cg) => cg.type === 'container')}
                              onSetContainer={(id, container_id) =>
                                setContainerMut.mutate({ id, container_id })
                              }
                              onToggleCollapsed={(id) =>
                                patchCollapsedMut.mutate({
                                  id,
                                  is_collapsed: !groups.find((g) => g.id === id)?.is_collapsed
                                })
                              }
                              onGroupSettings={(id, patch) =>
                                patchGroupSettingsMut.mutate({ id, patch })
                              }
                              getRowRevisions={(f) => localRowRevisions[f] ?? false}
                              onRowRevisions={(f, v) => {
                                setLocalRowRevisions((prev) => ({ ...prev, [f]: v }))
                                hasLocalChangeRef.current = true
                                changeSeqRef.current++
                              }}
                              getAllowRevisionRestore={(f) => localAllowRevisionRestore[f] ?? true}
                              onAllowRevisionRestore={(f, v) => {
                                setLocalAllowRevisionRestore((prev) => ({ ...prev, [f]: v }))
                                hasLocalChangeRef.current = true
                                changeSeqRef.current++
                              }}
                              getLockConditions={(f) => localLockConditions[f] ?? []}
                              onLockConditions={(f, v) => {
                                setLocalLockConditions((prev) => ({ ...prev, [f]: v }))
                                hasLocalChangeRef.current = true
                                changeSeqRef.current++
                              }}
                              getExtraControls={getExtraControls}
                              widgetSlotMeta={widgetSlotMeta}
                              getInlineDisplay={(f) => inlineDisplayMeta[f]}
                              onInlineDisplayChange={(f, config) => {
                                setInlineDisplayMeta((prev) => ({ ...prev, [f]: config }))
                                hasLocalChangeRef.current = true
                                changeSeqRef.current++
                              }}
                              collection={tableName}
                              getPrefillFromParent={
                                layoutType === 'addendum'
                                  ? (f) =>
                                      (localOverrides[f]?.prefill_from_parent as
                                        | boolean
                                        | undefined) ?? true
                                  : undefined
                              }
                              onPrefillFromParent={
                                layoutType === 'addendum'
                                  ? (f, v) => {
                                      setLocalOverrides((prev) => ({
                                        ...prev,
                                        [f]: { ...(prev[f] ?? {}), prefill_from_parent: v }
                                      }))
                                      hasLocalChangeRef.current = true
                                      changeSeqRef.current++
                                    }
                                  : undefined
                              }
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {orderedItems.length === 0 && !adding && (
                  <div className='rounded-lg border border-dashed border-slate-200 py-8 text-center text-[12px] text-slate-400'>
                    No groups yet. Add a group to organize form fields.
                  </div>
                )}
              </div>
            </SortableContext>
          )}

          {/* Table-mode special zones */}
          {layoutType === 'table' && (
            <div className='space-y-3 mt-3'>
              <div className='rounded-lg border border-slate-200 bg-white'>
                <div className='border-b border-slate-100 bg-slate-50 px-3 py-2'>
                  <p className='text-[12px] font-medium text-slate-700'>Apply Values</p>
                  <p className='text-[10px] text-slate-400 mt-0.5'>
                    Fields shown in the "apply to all rows" form
                  </p>
                </div>
                <DroppableFieldZone containerId='__apply_values__'>
                  <SortableContext
                    items={(localFieldOrder['__apply_values__'] ?? []).map((f) =>
                      toSortableId('__apply_values__', f)
                    )}
                    strategy={rectSortingStrategy}
                  >
                    <div
                      className={cn(
                        'min-h-[48px] p-3',
                        (localFieldOrder['__apply_values__'] ?? []).length === 0
                          ? 'flex items-center justify-center'
                          : 'grid grid-cols-12 gap-2 auto-rows-auto'
                      )}
                    >
                      {(localFieldOrder['__apply_values__'] ?? []).length === 0 ? (
                        <p className='text-[11px] text-slate-300'>Drop fields here</p>
                      ) : (
                        (localFieldOrder['__apply_values__'] ?? []).map((f) => {
                          const settings = getFieldSettings(f)
                          return (
                            <SortableFieldChip
                              key={toSortableId('__apply_values__', f)}
                              sortableId={toSortableId('__apply_values__', f)}
                              fieldName={f}
                              displayName={settings.label || titleCase(f)}
                              colSpan={12}
                              fieldSettings={settings}
                              onSettings={(patch) => handleFieldSettings(f, patch)}
                              onUnassign={() => handleUnassign(f, '__apply_values__')}
                              inGrid
                            />
                          )
                        })
                      )}
                    </div>
                  </SortableContext>
                </DroppableFieldZone>
              </div>

              <div className='rounded-lg border border-slate-200 bg-white'>
                <div className='border-b border-slate-100 bg-slate-50 px-3 py-2'>
                  <p className='text-[12px] font-medium text-slate-700'>Create with Defaults</p>
                  <p className='text-[10px] text-slate-400 mt-0.5'>
                    Fields shown in the "with defaults" form when bulk-adding rows
                  </p>
                </div>
                <DroppableFieldZone containerId='__create_with_defaults__'>
                  <SortableContext
                    items={(localFieldOrder['__create_with_defaults__'] ?? []).map((f) =>
                      toSortableId('__create_with_defaults__', f)
                    )}
                    strategy={rectSortingStrategy}
                  >
                    <div
                      className={cn(
                        'min-h-[48px] p-3',
                        (localFieldOrder['__create_with_defaults__'] ?? []).length === 0
                          ? 'flex items-center justify-center'
                          : 'grid grid-cols-12 gap-2 auto-rows-auto'
                      )}
                    >
                      {(localFieldOrder['__create_with_defaults__'] ?? []).length === 0 ? (
                        <p className='text-[11px] text-slate-300'>Drop fields here</p>
                      ) : (
                        (localFieldOrder['__create_with_defaults__'] ?? []).map((f) => {
                          const settings = getFieldSettings(f)
                          return (
                            <SortableFieldChip
                              key={toSortableId('__create_with_defaults__', f)}
                              sortableId={toSortableId('__create_with_defaults__', f)}
                              fieldName={f}
                              displayName={settings.label || titleCase(f)}
                              colSpan={12}
                              fieldSettings={settings}
                              onSettings={(patch) => handleFieldSettings(f, patch)}
                              onUnassign={() => handleUnassign(f, '__create_with_defaults__')}
                              inGrid
                            />
                          )
                        })
                      )}
                    </div>
                  </SortableContext>
                </DroppableFieldZone>
              </div>
            </div>
          )}
        </div>
        {/* end main area */}
      </div>
      {/* end flex row */}

      <DragOverlay
        dropAnimation={{ duration: 150, easing: 'ease' }}
        modifiers={[snapLeftEdgeToCursor]}
      >
        {activeFieldId && (
          <FieldChip
            fieldName={activeFieldId}
            displayName={
              activeFieldId === OWNERS_FIELD
                ? 'Owners'
                : activeFieldId === PDF_FIELD
                  ? 'PDF Button'
                  : undefined
            }
            fieldType={
              activeFieldId === OWNERS_FIELD
                ? 'owners'
                : activeFieldId === PDF_FIELD
                  ? 'pdf'
                  : activeFieldData?.type
            }
            colSpan={getColSpan(activeFieldId)}
            isDragging
          />
        )}
        {activeGroupId &&
          (() => {
            if (activeGroupId.startsWith('slot:')) {
              const key = activeGroupId.replace('slot:', '') as SlotKey
              const label = slots[key].label_override?.trim() || SLOT_META[key].defaultLabel
              return (
                <div className='flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 shadow-md text-[12px] font-medium text-slate-700 w-48'>
                  <GripVertical className='h-3.5 w-3.5 text-slate-300 shrink-0' />
                  {label}
                </div>
              )
            }
            const key = activeGroupId.replace('group:', '')
            const label =
              key === '__ungrouped__'
                ? 'Ungrouped'
                : (groups.find((g) => g.key === key)?.label ?? key)
            return (
              <div className='flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 shadow-md text-[12px] font-medium text-slate-700 w-48'>
                <GripVertical className='h-3.5 w-3.5 text-slate-300 shrink-0' />
                {label}
              </div>
            )
          })()}
      </DragOverlay>
    </DndContext>
  )
}

// ─── Behavior tab ─────────────────────────────────────────────────────────────

type BehaviorSection =
  | 'visibility'
  | 'locking'
  | 'validation'
  | 'dependencies'
  | 'defaults'
  | 'remote-options'

function useFieldConfig(tableName: string) {
  const qc = useQueryClient()
  const { data: fieldConfig = [], isLoading } = useQuery({
    queryKey: ['field-config', tableName],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            field: string
            visibility_rules: string | null
            lock_condition: string | null
            validation_rules: string | null
            dependency_config: string | null
            default_formula: string | null
            cross_record_defaults: string | null
            remote_options_config: string | null
            repeater_schema: string | null
            is_translatable: boolean
            group_key: string | null
          }>
        }>(`/field-config/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 30_000
  })

  const patchField = async (fieldName: string, patch: Record<string, unknown>) => {
    await api.patch(`/field-config/${tableName}/${fieldName}`, patch)
    qc.invalidateQueries({ queryKey: ['field-config', tableName] })
  }

  return { fieldConfig, isLoading, patchField }
}

function useCollectionFields(tableName: string) {
  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', tableName],
    queryFn: () => api.get(`/collections/${tableName}`).then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 30_000
  })
  return (colMeta?.fields ?? []) as Array<{ field: string; type: string; hidden?: boolean }>
}

function VisibilityRuleEditor({
  fieldName,
  current,
  availableFields,
  onSave
}: {
  fieldName: string
  current: string | null
  availableFields: Array<{ field: string }>
  onSave: (rule: string) => void
}) {
  const parsed = (() => {
    try {
      return current
        ? (JSON.parse(current) as {
            operator: 'AND' | 'OR'
            conditions: Array<{ field: string; op: string; value: string }>
          })
        : { operator: 'AND' as const, conditions: [{ field: '', op: 'eq', value: '' }] }
    } catch {
      return { operator: 'AND' as const, conditions: [{ field: '', op: 'eq', value: '' }] }
    }
  })()

  const [operator, setOperator] = useState<'AND' | 'OR'>(parsed.operator)
  const [conditions, setConditions] = useState(parsed.conditions)

  const OPS = [
    { value: 'eq', label: 'equals' },
    { value: 'neq', label: 'not equals' },
    { value: 'null', label: 'is empty' },
    { value: 'nnull', label: 'is not empty' },
    { value: 'contains', label: 'contains' }
  ]

  const updateCond = (idx: number, patch: Partial<(typeof conditions)[0]>) => {
    setConditions(conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)))
  }

  return (
    <div className='mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 space-y-3'>
      <p className='text-[11px] text-slate-500'>
        Show <strong>{fieldName}</strong> when:
      </p>
      <div className='flex items-center gap-2 text-[12px]'>
        <span>Match</span>
        <Combobox
          value={operator}
          onChange={(v) => setOperator(v as 'AND' | 'OR')}
          options={[
            { value: 'AND', label: 'ALL conditions' },
            { value: 'OR', label: 'ANY condition' }
          ]}
        />
      </div>
      {conditions.map((cond, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order-stable condition list
        <div key={idx} className='flex items-center gap-2'>
          <Combobox
            value={cond.field}
            onChange={(v) => updateCond(idx, { field: v })}
            options={availableFields.map((f) => ({ value: f.field, label: f.field }))}
            placeholder='Field…'
          />
          <Combobox value={cond.op} onChange={(v) => updateCond(idx, { op: v })} options={OPS} />
          {cond.op !== 'null' && cond.op !== 'nnull' && (
            <Input
              value={cond.value}
              onChange={(e) => updateCond(idx, { value: e.target.value })}
              placeholder='value'
              className='h-7 text-[12px] w-32'
            />
          )}
          {conditions.length > 1 && (
            <button
              type='button'
              onClick={() => setConditions(conditions.filter((_, i) => i !== idx))}
              className='text-slate-400 hover:text-red-500'
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>
      ))}
      <div className='flex items-center justify-between'>
        <button
          type='button'
          onClick={() => setConditions([...conditions, { field: '', op: 'eq', value: '' }])}
          className='flex items-center gap-1 text-[12px] text-slate-400 hover:text-nvr-cyan'
        >
          <Plus className='h-3.5 w-3.5' />
          Add condition
        </button>
        <Button
          type='button'
          size='sm'
          className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
          onClick={() => onSave(JSON.stringify({ operator, conditions }))}
        >
          Save rule
        </Button>
      </div>
    </div>
  )
}

function VisibilitySection({ tableName }: { tableName: string }) {
  const { fieldConfig, isLoading, patchField } = useFieldConfig(tableName)
  const fields = useCollectionFields(tableName)
  const [editing, setEditing] = useState<string | null>(null)
  const visibleFields = fields.filter((f) => !f.hidden)

  if (isLoading)
    return (
      <div className='space-y-2'>
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className='h-10 w-full' />
        ))}
      </div>
    )

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[12px] text-slate-500'>
          Define when each field is shown or hidden in the item editor. Fields with no rule are
          always visible.
        </p>
      </div>
      <div className='divide-y divide-slate-100'>
        {visibleFields.map((f) => {
          const cfg = fieldConfig.find((fc) => fc.field === f.field)
          const hasRule = !!cfg?.visibility_rules
          const isEdit = editing === f.field
          return (
            <div key={f.field} className='px-4 py-3'>
              <div className='flex items-center gap-3'>
                <span className='flex-1 font-mono text-[12px] text-slate-700'>{f.field}</span>
                {hasRule && <span className='text-[11px] text-nvr-cyan'>rule active</span>}
                <button
                  type='button'
                  onClick={() => setEditing(isEdit ? null : f.field)}
                  className='text-[12px] text-slate-400 hover:text-slate-700'
                >
                  {isEdit ? 'Close' : 'Configure'}
                </button>
                {hasRule && (
                  <button
                    type='button'
                    onClick={() => {
                      patchField(f.field, { visibility_rules: null })
                      if (editing === f.field) setEditing(null)
                    }}
                    className='text-[12px] text-slate-400 hover:text-red-500'
                  >
                    Remove
                  </button>
                )}
              </div>
              {isEdit && (
                <VisibilityRuleEditor
                  fieldName={f.field}
                  current={cfg?.visibility_rules ?? null}
                  availableFields={visibleFields.filter((ff) => ff.field !== f.field)}
                  onSave={(rule) => {
                    patchField(f.field, { visibility_rules: rule })
                    setEditing(null)
                    toast.success('Visibility rule saved')
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function LockConditionEditor({
  current,
  availableFields,
  onSave
}: {
  current: string | null
  availableFields: Array<{ field: string }>
  onSave: (cond: string) => void
}) {
  const parsed = (() => {
    try {
      return current
        ? (JSON.parse(current) as { field: string; op: string; value: string })
        : { field: '', op: 'eq', value: '' }
    } catch {
      return { field: '', op: 'eq', value: '' }
    }
  })()
  const [field, setField] = useState(parsed.field)
  const [op, setOp] = useState(parsed.op)
  const [value, setValue] = useState(parsed.value)

  const OPS = [
    { value: 'eq', label: 'equals' },
    { value: 'neq', label: 'not equals' },
    { value: 'null', label: 'is empty' },
    { value: 'nnull', label: 'is not empty' }
  ]

  return (
    <div className='mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 space-y-3'>
      <p className='text-[11px] text-slate-500'>Lock this field when:</p>
      <div className='flex items-center gap-2'>
        <Combobox
          value={field}
          onChange={setField}
          options={availableFields.map((f) => ({ value: f.field, label: f.field }))}
          placeholder='Field…'
        />
        <Combobox value={op} onChange={setOp} options={OPS} />
        {op !== 'null' && op !== 'nnull' && (
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder='value'
            className='h-7 text-[12px] w-32'
          />
        )}
      </div>
      <div className='flex justify-end'>
        <Button
          type='button'
          size='sm'
          className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
          disabled={!field}
          onClick={() => onSave(JSON.stringify({ field, op, value }))}
        >
          Save condition
        </Button>
      </div>
    </div>
  )
}

function FieldLockingSection({ tableName }: { tableName: string }) {
  const { fieldConfig, isLoading, patchField } = useFieldConfig(tableName)
  const fields = useCollectionFields(tableName)
  const [editing, setEditing] = useState<string | null>(null)
  const visibleFields = fields.filter((f) => !f.hidden)

  if (isLoading)
    return (
      <div className='space-y-2'>
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className='h-10 w-full' />
        ))}
      </div>
    )

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[12px] text-slate-500'>
          Lock a field to read-only when a condition is met. Enforced at API and UI level.
        </p>
      </div>
      <div className='divide-y divide-slate-100'>
        {visibleFields.map((f) => {
          const cfg = fieldConfig.find((fc) => fc.field === f.field)
          const hasLock = !!cfg?.lock_condition
          const isEdit = editing === f.field
          let lockDesc = ''
          if (hasLock && cfg?.lock_condition) {
            try {
              const lc = JSON.parse(cfg.lock_condition) as {
                field: string
                op: string
                value: unknown
              }
              lockDesc = `when ${lc.field} ${lc.op} ${lc.value ?? ''}`
            } catch {
              lockDesc = 'rule active'
            }
          }
          return (
            <div key={f.field} className='px-4 py-3'>
              <div className='flex items-center gap-3'>
                <span className='flex-1 font-mono text-[12px] text-slate-700'>{f.field}</span>
                {hasLock && (
                  <span className='flex items-center gap-1 text-[11px] text-amber-600'>
                    <Lock className='h-3 w-3' />
                    {lockDesc}
                  </span>
                )}
                <button
                  type='button'
                  onClick={() => setEditing(isEdit ? null : f.field)}
                  className='text-[12px] text-slate-400 hover:text-slate-700'
                >
                  {isEdit ? 'Close' : 'Configure'}
                </button>
                {hasLock && (
                  <button
                    type='button'
                    onClick={() => patchField(f.field, { lock_condition: null })}
                    className='text-[12px] text-slate-400 hover:text-red-500'
                  >
                    Remove
                  </button>
                )}
              </div>
              {isEdit && (
                <LockConditionEditor
                  current={cfg?.lock_condition ?? null}
                  availableFields={visibleFields.filter((ff) => ff.field !== f.field)}
                  onSave={(cond) => {
                    patchField(f.field, { lock_condition: cond })
                    setEditing(null)
                    toast.success('Lock condition saved')
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ValidationRulesEditor({
  current,
  onSave
}: {
  current: Array<{ type: string; value?: string; message?: string }>
  onSave: (rules: Array<{ type: string; value?: string; message?: string }>) => void
}) {
  const [rules, setRules] = useState(
    current.length ? current : [{ type: 'min_length', value: '', message: '' }]
  )

  const RULE_TYPES = [
    { value: 'min_length', label: 'Min length' },
    { value: 'max_length', label: 'Max length' },
    { value: 'regex', label: 'Regex pattern' },
    { value: 'required_if', label: 'Required if not empty' },
    { value: 'unique', label: 'Unique in collection' }
  ]

  const updateRule = (idx: number, patch: Partial<(typeof rules)[0]>) => {
    setRules(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  return (
    <div className='mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 space-y-3'>
      {rules.map((rule, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order-stable rule list
        <div key={idx} className='flex items-start gap-2'>
          <Combobox
            value={rule.type}
            onChange={(v) => updateRule(idx, { type: v })}
            options={RULE_TYPES}
          />
          {(rule.type === 'min_length' || rule.type === 'max_length' || rule.type === 'regex') && (
            <Input
              value={rule.value ?? ''}
              onChange={(e) => updateRule(idx, { value: e.target.value })}
              placeholder={rule.type === 'regex' ? '^[A-Z].*' : '10'}
              className='h-7 text-[12px] w-28'
            />
          )}
          <Input
            value={rule.message ?? ''}
            onChange={(e) => updateRule(idx, { message: e.target.value })}
            placeholder='Error message (optional)'
            className='h-7 text-[12px] flex-1'
          />
          {rules.length > 1 && (
            <button
              type='button'
              onClick={() => setRules(rules.filter((_, i) => i !== idx))}
              className='mt-0.5 text-slate-400 hover:text-red-500'
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>
      ))}
      <div className='flex items-center justify-between'>
        <button
          type='button'
          onClick={() => setRules([...rules, { type: 'min_length', value: '', message: '' }])}
          className='flex items-center gap-1 text-[12px] text-slate-400 hover:text-nvr-cyan'
        >
          <Plus className='h-3.5 w-3.5' />
          Add rule
        </button>
        <Button
          type='button'
          size='sm'
          className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
          onClick={() => onSave(rules)}
        >
          Save rules
        </Button>
      </div>
    </div>
  )
}

function ValidationSection({ tableName }: { tableName: string }) {
  const { fieldConfig, isLoading, patchField } = useFieldConfig(tableName)
  const fields = useCollectionFields(tableName)
  const [editing, setEditing] = useState<string | null>(null)
  const visibleFields = fields.filter((f) => !f.hidden)

  if (isLoading)
    return (
      <div className='space-y-2'>
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className='h-10 w-full' />
        ))}
      </div>
    )

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[12px] text-slate-500'>
          Add validation rules: min/max length, regex pattern, custom message. Enforced on save at
          API level.
        </p>
      </div>
      <div className='divide-y divide-slate-100'>
        {visibleFields.map((f) => {
          const cfg = fieldConfig.find((fc) => fc.field === f.field)
          let vRules: Array<{ type: string; value?: string; message?: string }> = []
          try {
            if (cfg?.validation_rules) vRules = JSON.parse(cfg.validation_rules)
          } catch {
            /* */
          }
          const isEdit = editing === f.field
          return (
            <div key={f.field} className='px-4 py-3'>
              <div className='flex items-center gap-3'>
                <span className='flex-1 font-mono text-[12px] text-slate-700'>{f.field}</span>
                {vRules.length > 0 && (
                  <span className='text-[11px] text-nvr-cyan'>
                    {vRules.length} rule{vRules.length !== 1 ? 's' : ''}
                  </span>
                )}
                <button
                  type='button'
                  onClick={() => setEditing(isEdit ? null : f.field)}
                  className='text-[12px] text-slate-400 hover:text-slate-700'
                >
                  {isEdit ? 'Close' : 'Configure'}
                </button>
                {vRules.length > 0 && (
                  <button
                    type='button'
                    onClick={() => patchField(f.field, { validation_rules: null })}
                    className='text-[12px] text-slate-400 hover:text-red-500'
                  >
                    Clear
                  </button>
                )}
              </div>
              {isEdit && (
                <ValidationRulesEditor
                  current={vRules}
                  onSave={(r) => {
                    patchField(f.field, { validation_rules: r.length ? JSON.stringify(r) : null })
                    setEditing(null)
                    toast.success('Validation rules saved')
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DependencyEditor({
  current,
  availableFields,
  onSave
}: {
  current: string | null
  availableFields: Array<{ field: string }>
  onSave: (v: string) => void
}) {
  const parsed = (() => {
    try {
      return current
        ? (JSON.parse(current) as { depends_on: string[]; clear_on_change: boolean })
        : { depends_on: [], clear_on_change: true }
    } catch {
      return { depends_on: [] as string[], clear_on_change: true }
    }
  })()
  const [dependsOn, setDependsOn] = useState<string[]>(parsed.depends_on ?? [])
  const [clearOnChange, setClearOnChange] = useState(parsed.clear_on_change ?? true)

  const toggleDep = (field: string) => {
    setDependsOn((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
    )
  }

  return (
    <div className='mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 space-y-3'>
      <div>
        <p className='mb-2 text-[11px] text-slate-500'>
          This field depends on (changes when these change):
        </p>
        <div className='flex flex-wrap gap-2'>
          {availableFields.map((f) => (
            <label key={f.field} className='flex items-center gap-1.5 text-[12px]'>
              <input
                type='checkbox'
                checked={dependsOn.includes(f.field)}
                onChange={() => toggleDep(f.field)}
                className='rounded'
              />
              <span className='font-mono'>{f.field}</span>
            </label>
          ))}
        </div>
      </div>
      <label className='flex items-center gap-1.5 text-[12px]'>
        <input
          type='checkbox'
          checked={clearOnChange}
          onChange={(e) => setClearOnChange(e.target.checked)}
          className='rounded'
        />
        Clear this field's value when a dependency changes
      </label>
      <div className='flex justify-end'>
        <Button
          type='button'
          size='sm'
          className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
          disabled={dependsOn.length === 0}
          onClick={() =>
            onSave(JSON.stringify({ depends_on: dependsOn, clear_on_change: clearOnChange }))
          }
        >
          Save dependency
        </Button>
      </div>
    </div>
  )
}

function DependenciesSection({ tableName }: { tableName: string }) {
  const { fieldConfig, isLoading, patchField } = useFieldConfig(tableName)
  const fields = useCollectionFields(tableName)
  const [editing, setEditing] = useState<string | null>(null)
  const visibleFields = fields.filter((f) => !f.hidden)

  if (isLoading)
    return (
      <div className='space-y-2'>
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className='h-10 w-full' />
        ))}
      </div>
    )

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[12px] text-slate-500'>
          When a field changes, automatically clear or filter dependent fields. E.g., changing
          Country clears City.
        </p>
      </div>
      <div className='divide-y divide-slate-100'>
        {visibleFields.map((f) => {
          const cfg = fieldConfig.find((fc) => fc.field === f.field)
          let dep: { depends_on?: string[]; clear_on_change?: boolean } | null = null
          try {
            if (cfg?.dependency_config) dep = JSON.parse(cfg.dependency_config)
          } catch {
            /* */
          }
          const isEdit = editing === f.field
          return (
            <div key={f.field} className='px-4 py-3'>
              <div className='flex items-center gap-3'>
                <span className='flex-1 font-mono text-[12px] text-slate-700'>{f.field}</span>
                {dep?.depends_on?.length ? (
                  <span className='text-[11px] text-nvr-cyan'>
                    depends on: {dep.depends_on.join(', ')}
                  </span>
                ) : null}
                <button
                  type='button'
                  onClick={() => setEditing(isEdit ? null : f.field)}
                  className='text-[12px] text-slate-400 hover:text-slate-700'
                >
                  {isEdit ? 'Close' : 'Configure'}
                </button>
                {dep && (
                  <button
                    type='button'
                    onClick={() => patchField(f.field, { dependency_config: null })}
                    className='text-[12px] text-slate-400 hover:text-red-500'
                  >
                    Clear
                  </button>
                )}
              </div>
              {isEdit && (
                <DependencyEditor
                  current={cfg?.dependency_config ?? null}
                  availableFields={visibleFields.filter((ff) => ff.field !== f.field)}
                  onSave={(v) => {
                    patchField(f.field, { dependency_config: v })
                    setEditing(null)
                    toast.success('Dependency saved')
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function FormulaEditor({ current, onSave }: { current: string; onSave: (v: string) => void }) {
  const [formula, setFormula] = useState(current)
  return (
    <div className='mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 space-y-3'>
      <div>
        <Label className='mb-1 block text-[11px]'>Formula</Label>
        <Input
          value={formula}
          onChange={(e) => setFormula(e.target.value)}
          placeholder="TODAY() or UPPER(name) or CONCAT(first_name, ' ', last_name)"
          className='h-7 font-mono text-[12px]'
        />
      </div>
      <p className='text-[11px] text-slate-400'>
        Supported: TODAY(), UPPER(field), LOWER(field), CONCAT(field1, 'sep', field2)
      </p>
      <div className='flex justify-end'>
        <Button
          type='button'
          size='sm'
          className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
          onClick={() => onSave(formula)}
        >
          Save formula
        </Button>
      </div>
    </div>
  )
}

function ComputedDefaultsSection({ tableName }: { tableName: string }) {
  const { fieldConfig, isLoading, patchField } = useFieldConfig(tableName)
  const fields = useCollectionFields(tableName)
  const [editing, setEditing] = useState<string | null>(null)
  const visibleFields = fields.filter((f) => !f.hidden)

  if (isLoading)
    return (
      <div className='space-y-2'>
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className='h-10 w-full' />
        ))}
      </div>
    )

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[12px] text-slate-500'>
          Auto-populate a field from a formula when another field changes. User can override the
          computed value.
        </p>
      </div>
      <div className='divide-y divide-slate-100'>
        {visibleFields.map((f) => {
          const cfg = fieldConfig.find((fc) => fc.field === f.field)
          const isEdit = editing === f.field
          return (
            <div key={f.field} className='px-4 py-3'>
              <div className='flex items-center gap-3'>
                <span className='flex-1 font-mono text-[12px] text-slate-700'>{f.field}</span>
                {cfg?.default_formula && (
                  <code className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600'>
                    {cfg.default_formula}
                  </code>
                )}
                <button
                  type='button'
                  onClick={() => setEditing(isEdit ? null : f.field)}
                  className='text-[12px] text-slate-400 hover:text-slate-700'
                >
                  {isEdit ? 'Close' : 'Configure'}
                </button>
                {cfg?.default_formula && (
                  <button
                    type='button'
                    onClick={() => patchField(f.field, { default_formula: null })}
                    className='text-[12px] text-slate-400 hover:text-red-500'
                  >
                    Remove
                  </button>
                )}
              </div>
              {isEdit && (
                <FormulaEditor
                  current={cfg?.default_formula ?? ''}
                  onSave={(v) => {
                    patchField(f.field, { default_formula: v || null })
                    setEditing(null)
                    toast.success('Default formula saved')
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RemoteOptionsEditor({
  current,
  externalApis,
  onSave
}: {
  current: string | null
  externalApis: Array<{ id: number; name: string }>
  onSave: (v: string) => void
}) {
  const parsed = (() => {
    try {
      return current
        ? (JSON.parse(current) as {
            external_api_id: string | number
            response_path: string
            value_field: string
            label_field: string
          })
        : { external_api_id: '', response_path: '', value_field: 'id', label_field: 'name' }
    } catch {
      return { external_api_id: '', response_path: '', value_field: 'id', label_field: 'name' }
    }
  })()
  const [apiId, setApiId] = useState(String(parsed.external_api_id ?? ''))
  const [path, setPath] = useState(parsed.response_path ?? '')
  const [valueField, setValueField] = useState(parsed.value_field ?? 'id')
  const [labelField, setLabelField] = useState(parsed.label_field ?? 'name')

  return (
    <div className='mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 space-y-3'>
      <div className='grid grid-cols-2 gap-3'>
        <div className='col-span-2'>
          <Label className='mb-1 block text-[11px]'>External API</Label>
          <Combobox
            value={apiId}
            onChange={setApiId}
            options={externalApis.map((a) => ({ value: String(a.id), label: a.name }))}
            placeholder='Select API…'
          />
        </div>
        <div className='col-span-2'>
          <Label className='mb-1 block text-[11px]'>Response path (dot notation)</Label>
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder='data.items'
            className='h-7 font-mono text-[12px]'
          />
        </div>
        <div>
          <Label className='mb-1 block text-[11px]'>Value field</Label>
          <Input
            value={valueField}
            onChange={(e) => setValueField(e.target.value)}
            placeholder='id'
            className='h-7 font-mono text-[12px]'
          />
        </div>
        <div>
          <Label className='mb-1 block text-[11px]'>Label field</Label>
          <Input
            value={labelField}
            onChange={(e) => setLabelField(e.target.value)}
            placeholder='name'
            className='h-7 font-mono text-[12px]'
          />
        </div>
      </div>
      <div className='flex justify-end'>
        <Button
          type='button'
          size='sm'
          className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
          disabled={!apiId}
          onClick={() =>
            onSave(
              JSON.stringify({
                external_api_id: Number(apiId),
                response_path: path,
                value_field: valueField,
                label_field: labelField
              })
            )
          }
        >
          Save config
        </Button>
      </div>
    </div>
  )
}

function RemoteOptionsSection({ tableName }: { tableName: string }) {
  const { fieldConfig, isLoading, patchField } = useFieldConfig(tableName)
  const fields = useCollectionFields(tableName)
  const [editing, setEditing] = useState<string | null>(null)

  const { data: externalApis = [] } = useQuery({
    queryKey: ['external-apis'],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: number; name: string }> }>('/external-apis')
        .then((r) => r.data.data),
    staleTime: 60_000
  })

  const visibleFields = fields.filter((f) => !f.hidden)

  if (isLoading)
    return (
      <div className='space-y-2'>
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className='h-10 w-full' />
        ))}
      </div>
    )

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[12px] text-slate-500'>
          Populate a select field's options from an External API response at form load time.
        </p>
      </div>
      <div className='divide-y divide-slate-100'>
        {visibleFields.map((f) => {
          const cfg = fieldConfig.find((fc) => fc.field === f.field)
          let remoteOpts: {
            external_api_id?: number
            response_path?: string
            value_field?: string
            label_field?: string
          } | null = null
          try {
            if (cfg?.remote_options_config) remoteOpts = JSON.parse(cfg.remote_options_config)
          } catch {
            /* */
          }
          const isEdit = editing === f.field
          return (
            <div key={f.field} className='px-4 py-3'>
              <div className='flex items-center gap-3'>
                <span className='flex-1 font-mono text-[12px] text-slate-700'>{f.field}</span>
                {remoteOpts?.external_api_id && (
                  <span className='text-[11px] text-nvr-cyan'>
                    API #{remoteOpts.external_api_id}
                  </span>
                )}
                <button
                  type='button'
                  onClick={() => setEditing(isEdit ? null : f.field)}
                  className='text-[12px] text-slate-400 hover:text-slate-700'
                >
                  {isEdit ? 'Close' : 'Configure'}
                </button>
                {remoteOpts && (
                  <button
                    type='button'
                    onClick={() => patchField(f.field, { remote_options_config: null })}
                    className='text-[12px] text-slate-400 hover:text-red-500'
                  >
                    Remove
                  </button>
                )}
              </div>
              {isEdit && (
                <RemoteOptionsEditor
                  current={cfg?.remote_options_config ?? null}
                  externalApis={externalApis}
                  onSave={(v) => {
                    patchField(f.field, { remote_options_config: v })
                    setEditing(null)
                    toast.success('Remote options configured')
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function BehaviorTab({
  tableName,
  tableData: _tableData
}: {
  tableName: string
  tableData: DBTableDetail
}) {
  const [section, setSection] = useState<BehaviorSection>('visibility')

  const SECTIONS: { id: BehaviorSection; label: string }[] = [
    { id: 'visibility', label: 'Visibility' },
    { id: 'locking', label: 'Field Locking' },
    { id: 'validation', label: 'Validation' },
    { id: 'dependencies', label: 'Dependencies' },
    { id: 'defaults', label: 'Computed Defaults' },
    { id: 'remote-options', label: 'Remote Options' }
  ]

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-2'>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type='button'
            onClick={() => setSection(s.id)}
            className={cn(
              'rounded px-3 py-1.5 text-[12px] font-medium transition-colors',
              section === s.id
                ? 'bg-nvr-cyan/10 text-nvr-cyan'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'visibility' && <VisibilitySection tableName={tableName} />}
      {section === 'locking' && <FieldLockingSection tableName={tableName} />}
      {section === 'validation' && <ValidationSection tableName={tableName} />}
      {section === 'dependencies' && <DependenciesSection tableName={tableName} />}
      {section === 'defaults' && <ComputedDefaultsSection tableName={tableName} />}
      {section === 'remote-options' && <RemoteOptionsSection tableName={tableName} />}
    </div>
  )
}

// ─── Content tab ──────────────────────────────────────────────────────────────

type ContentSection = 'draft-publish' | 'i18n' | 'field-types'

function DraftPublishSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const { data: config } = useQuery({
    queryKey: ['draft-publish-config', tableName],
    queryFn: () =>
      api
        .get<{ data: { draft_publish_enabled: boolean } }>(`/draft-publish/${tableName}/config`)
        .then((r) => r.data.data),
    enabled: !!tableName
  })

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch(`/draft-publish/${tableName}/config`, { draft_publish_enabled: enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['draft-publish-config', tableName] })
      toast.success('Draft/publish settings updated')
    },
    onError: () => toast.error('Failed to update settings')
  })

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='border-b border-slate-100 px-4 py-3 flex items-center justify-between'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Draft / Publish States</p>
          <p className='text-[12px] text-slate-500 mt-0.5'>
            Adds a <code className='font-mono text-[11px]'>_status</code> field with draft → review
            → published lifecycle.
          </p>
        </div>
        <Switch
          checked={config?.draft_publish_enabled ?? false}
          onCheckedChange={(v) => toggleMut.mutate(v)}
          disabled={toggleMut.isPending}
        />
      </div>
      {config?.draft_publish_enabled && (
        <div className='px-4 py-3 text-[12px] text-slate-500'>
          <p>
            When enabled, items have a <code className='font-mono text-[11px]'>_status</code> field
            that editors can set to <strong>Draft</strong>, <strong>Review</strong>, or{' '}
            <strong>Published</strong>. Status buttons appear in the item editor header.
          </p>
        </div>
      )}
    </div>
  )
}

function I18nSection({ tableName }: { tableName: string }) {
  const { fieldConfig, isLoading, patchField } = useFieldConfig(tableName)
  const fields = useCollectionFields(tableName)
  const visibleFields = fields.filter((f) => !f.hidden)

  if (isLoading)
    return (
      <div className='space-y-2'>
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className='h-10 w-full' />
        ))}
      </div>
    )

  return (
    <div className='space-y-4'>
      <div className='rounded-lg border border-slate-200 bg-white p-4'>
        <p className='text-[12px] text-slate-500'>
          Mark fields as translatable. Translated values are stored separately and returned based on
          the <code className='font-mono text-[11px]'>Accept-Language</code> header or locale
          parameter.
        </p>
      </div>
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
        <div className='border-b border-slate-100 px-4 py-2.5'>
          <p className='text-[12px] font-medium text-slate-600'>Translatable Fields</p>
        </div>
        <div className='divide-y divide-slate-100'>
          {visibleFields.map((f) => {
            const cfg = fieldConfig.find((fc) => fc.field === f.field)
            return (
              <div key={f.field} className='flex items-center gap-3 px-4 py-2.5'>
                <Languages className='h-3.5 w-3.5 shrink-0 text-slate-300' />
                <span className='flex-1 font-mono text-[12px] text-slate-700'>{f.field}</span>
                <Switch
                  checked={cfg?.is_translatable ?? false}
                  onCheckedChange={(v) => {
                    patchField(f.field, { is_translatable: v })
                    toast.success(`${f.field} ${v ? 'marked as translatable' : 'unmarked'}`)
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function RepeaterSchemaEditor({
  current,
  onSave
}: {
  current: Array<{ key: string; label: string; type: string }>
  onSave: (schema: Array<{ key: string; label: string; type: string }>) => void
}) {
  const [cols, setCols] = useState(
    current.length ? current : [{ key: 'value', label: 'Value', type: 'string' }]
  )

  const updateCol = (idx: number, patch: Partial<(typeof cols)[0]>) => {
    setCols(cols.map((c, i) => (i === idx ? { ...c, ...patch } : c)))
  }

  const COL_TYPES = [
    { value: 'string', label: 'Text' },
    { value: 'number', label: 'Number' },
    { value: 'boolean', label: 'Boolean' },
    { value: 'date', label: 'Date' }
  ]

  return (
    <div className='mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 space-y-3'>
      <p className='text-[11px] text-slate-500'>
        Define columns for each row in this repeater field
      </p>
      {cols.map((col, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order-stable column list
        <div key={idx} className='flex items-center gap-2'>
          <Input
            value={col.key}
            onChange={(e) =>
              updateCol(idx, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })
            }
            placeholder='key'
            className='h-7 w-28 font-mono text-[12px]'
          />
          <Input
            value={col.label}
            onChange={(e) => updateCol(idx, { label: e.target.value })}
            placeholder='Label'
            className='h-7 flex-1 text-[12px]'
          />
          <Combobox
            value={col.type}
            onChange={(v) => updateCol(idx, { type: v })}
            options={COL_TYPES}
          />
          {cols.length > 1 && (
            <button
              type='button'
              onClick={() => setCols(cols.filter((_, i) => i !== idx))}
              className='text-slate-400 hover:text-red-500'
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>
      ))}
      <div className='flex items-center justify-between'>
        <button
          type='button'
          onClick={() => setCols([...cols, { key: '', label: '', type: 'string' }])}
          className='flex items-center gap-1 text-[12px] text-slate-400 hover:text-nvr-cyan'
        >
          <Plus className='h-3.5 w-3.5' />
          Add column
        </button>
        <Button
          type='button'
          size='sm'
          className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
          onClick={() => onSave(cols)}
        >
          Save schema
        </Button>
      </div>
    </div>
  )
}

function FieldTypesSection({ tableName }: { tableName: string }) {
  const { fieldConfig, isLoading, patchField } = useFieldConfig(tableName)
  const fields = useCollectionFields(tableName)
  const [editingRepeater, setEditingRepeater] = useState<string | null>(null)
  const visibleFields = fields.filter((f) => !f.hidden)

  if (isLoading)
    return (
      <div className='space-y-2'>
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className='h-10 w-full' />
        ))}
      </div>
    )

  return (
    <div className='space-y-4'>
      <div className='rounded-lg border border-slate-200 bg-white p-4'>
        <p className='text-[12px] text-slate-500'>
          Configure special field type interfaces: Repeater (structured sub-rows), Rich Text (block
          editor), Line Items (BOM), and % Complete. The interface is set in the Fields tab;
          configure schemas here.
        </p>
      </div>
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
        <div className='border-b border-slate-100 px-4 py-3'>
          <p className='text-[12px] font-medium text-slate-700'>Repeater Field Schemas</p>
          <p className='text-[11px] text-slate-400 mt-0.5'>
            Define columns for fields with interface "repeater"
          </p>
        </div>
        {visibleFields.map((f) => {
          const cfg = fieldConfig.find((fc) => fc.field === f.field)
          const isEdit = editingRepeater === f.field
          let schema: Array<{ key: string; label: string; type: string }> = []
          try {
            if (cfg?.repeater_schema) schema = JSON.parse(cfg.repeater_schema)
          } catch {
            /* */
          }
          return (
            <div key={f.field} className='border-b border-slate-100 px-4 py-3 last:border-0'>
              <div className='flex items-center gap-3'>
                <span className='flex-1 font-mono text-[12px] text-slate-700'>{f.field}</span>
                {schema.length > 0 && (
                  <span className='text-[11px] text-nvr-cyan'>
                    {schema.length} column{schema.length !== 1 ? 's' : ''}
                  </span>
                )}
                <button
                  type='button'
                  onClick={() => setEditingRepeater(isEdit ? null : f.field)}
                  className='text-[12px] text-slate-400 hover:text-slate-700'
                >
                  {isEdit ? 'Close' : 'Edit schema'}
                </button>
              </div>
              {isEdit && (
                <RepeaterSchemaEditor
                  current={schema}
                  onSave={(s) => {
                    patchField(f.field, { repeater_schema: s.length ? JSON.stringify(s) : null })
                    setEditingRepeater(null)
                    toast.success('Repeater schema saved')
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ContentTab({
  tableName,
  tableData: _tableData,
  onRefresh: _onRefresh
}: {
  tableName: string
  tableData: DBTableDetail
  onRefresh: () => void
}) {
  const [section, setSection] = useState<ContentSection>('draft-publish')

  const SECTIONS: { id: ContentSection; label: string }[] = [
    { id: 'draft-publish', label: 'Draft / Publish' },
    { id: 'i18n', label: 'Translations (i18n)' },
    { id: 'field-types', label: 'Field Types' }
  ]

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-2'>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type='button'
            onClick={() => setSection(s.id)}
            className={cn(
              'rounded px-3 py-1.5 text-[12px] font-medium transition-colors',
              section === s.id
                ? 'bg-nvr-cyan/10 text-nvr-cyan'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'draft-publish' && <DraftPublishSection tableName={tableName} />}
      {section === 'i18n' && <I18nSection tableName={tableName} />}
      {section === 'field-types' && <FieldTypesSection tableName={tableName} />}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Tab =
  | 'fields'
  | 'relations'
  | 'attributes'
  | 'groups'
  | 'behavior'
  | 'rules'
  | 'imports'
  | 'tree'
  | 'content'
  | 'settings'

export function TableEditorPage() {
  const { table } = useParams<{ table: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = usePersistedTab<Tab>(`nvr_tab_tableeditor_${table ?? ''}`, 'fields')
  const { user } = useAuth()
  const isAdmin = (user as { is_admin?: boolean } | null)?.is_admin ?? false
  const [showDrop, setShowDrop] = useState(false)
  const [dropConfirm, setDropConfirm] = useState('')
  const [extendMode, setExtendMode] = useState(false)
  const isSystem = (table ?? '').startsWith('nivaro_')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['data-model-table', table],
    queryFn: () => (table ? schemaApi.getTable(table) : Promise.reject('No table')),
    enabled: !!table
  })

  const tableData = data?.data

  const registerMutation = useMutation({
    mutationFn: () =>
      table ? schemaApi.registerCollection(table, {}) : Promise.reject('No table'),
    onSuccess: () => {
      toast.success('Table registered as collection')
      qc.invalidateQueries({ queryKey: ['data-model-table', table] })
      qc.invalidateQueries({ queryKey: ['data-model-tables'] })
      refetch()
    },
    onError: () => toast.error('Failed to register')
  })

  const unregisterMutation = useMutation({
    mutationFn: () => (table ? schemaApi.unregisterCollection(table) : Promise.reject('No table')),
    onSuccess: () => {
      toast.success('Collection unregistered')
      qc.invalidateQueries({ queryKey: ['data-model-table', table] })
      qc.invalidateQueries({ queryKey: ['data-model-tables'] })
      refetch()
    },
    onError: () => toast.error('Failed to unregister')
  })

  const dropTableMutation = useMutation({
    mutationFn: () => (table ? schemaApi.dropTable(table) : Promise.reject('No table')),
    onSuccess: () => {
      toast.success(`Table "${table}" dropped`)
      qc.invalidateQueries({ queryKey: ['data-model-tables'] })
      navigate('/data-model')
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to drop table'
      toast.error(msg)
    }
  })

  return (
    <>
      {/* Sticky header */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-6 py-3.5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2 text-[13px]'>
            <Link
              to='/data-model'
              className='flex items-center gap-1 text-slate-400 transition-colors hover:text-slate-700'
            >
              <ArrowLeft className='h-3.5 w-3.5' />
              Data Model
            </Link>
            <span className='text-slate-300'>/</span>
            <span className='font-mono font-medium text-slate-900'>{table}</span>
            {tableData?.registered && (
              <Badge className='border-0 bg-emerald-50 text-[10px] text-emerald-700'>
                registered
              </Badge>
            )}
          </div>

          <div className='flex items-center gap-2'>
            {tableData && (
              <>
                {!isSystem &&
                  (tableData.registered ? (
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-7 text-[12px]'
                      disabled={unregisterMutation.isPending}
                      onClick={() => {
                        if (
                          confirm(
                            'Unregister this table? This removes CMS metadata but does not drop the table.'
                          )
                        ) {
                          unregisterMutation.mutate()
                        }
                      }}
                    >
                      <EyeOff className='mr-1.5 h-3 w-3' />
                      Unregister
                    </Button>
                  ) : (
                    <Button
                      size='sm'
                      className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
                      disabled={registerMutation.isPending}
                      onClick={() => registerMutation.mutate()}
                    >
                      <Eye className='mr-1.5 h-3 w-3' />
                      Register
                    </Button>
                  ))}
                {!isSystem && (
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-7 text-[12px] text-red-400 hover:text-red-600'
                    onClick={() => setShowDrop(true)}
                  >
                    <Trash2 className='mr-1.5 h-3 w-3' />
                    Drop Table
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className='mt-3 flex gap-0.5'>
          {(isSystem
            ? (['fields', 'relations'] as const)
            : ([
                'fields',
                'relations',
                'groups',
                'behavior',
                'rules',
                'imports',
                'tree',
                'content',
                'attributes',
                'settings'
              ] as const)
          ).map((t) => (
            <button
              key={t}
              type='button'
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12px] font-medium capitalize transition-colors',
                tab === t
                  ? 'bg-nvr-cyan/10 text-nvr-cyan'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
              )}
            >
              {t === 'groups'
                ? 'Layout'
                : t === 'behavior'
                  ? 'Behavior'
                  : t === 'rules'
                    ? 'Field Rules'
                    : t === 'imports'
                      ? 'Imports'
                      : t === 'content'
                        ? 'Content'
                        : t}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className={cn('p-6', tab === 'groups' && 'pb-32')}>
        {isLoading || !tableData ? (
          <div className='space-y-2'>
            {Array.from({ length: 6 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
              <Skeleton key={i} className='h-10 w-full rounded-lg' />
            ))}
          </div>
        ) : (
          <>
            {tab === 'fields' && (
              <FieldsTab
                tableData={tableData}
                tableName={table ?? ''}
                onRefresh={() => refetch()}
                isSystem={isSystem}
                extendMode={extendMode}
                onExtendModeChange={setExtendMode}
              />
            )}
            {tab === 'relations' && (
              <RelationsTab
                tableData={tableData}
                tableName={table ?? ''}
                onRefresh={() => refetch()}
              />
            )}
            {tab === 'groups' && (
              <LayoutsTab tableName={table ?? ''} dbColumns={tableData?.columns ?? []} />
            )}
            {tab === 'behavior' && <BehaviorTab tableName={table ?? ''} tableData={tableData} />}
            {tab === 'content' && (
              <ContentTab
                tableName={table ?? ''}
                tableData={tableData}
                onRefresh={() => refetch()}
              />
            )}
            {tab === 'rules' && <FieldRulesSection collection={table ?? ''} isAdmin={isAdmin} />}
            {tab === 'imports' && <ImportTemplatesSection collection={table ?? ''} />}
            {tab === 'tree' && <TreeSection collection={table ?? ''} isAdmin={isAdmin} />}
            {tab === 'attributes' && <AttributesTab tableName={table ?? ''} />}
            {tab === 'settings' && (
              <SettingsTab
                tableData={tableData}
                tableName={table ?? ''}
                onRefresh={() => refetch()}
              />
            )}
          </>
        )}
      </div>

      {/* Drop table confirmation dialog */}
      <Dialog
        open={showDrop}
        onOpenChange={(o) => {
          setShowDrop(o)
          setDropConfirm('')
        }}
      >
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle className='text-[15px] text-red-600'>Drop Table</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className='space-y-3'>
              <p className='text-[13px] text-slate-700'>
                This will permanently delete the table{' '}
                <code className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[12px]'>
                  {table}
                </code>{' '}
                and all its data. This action cannot be undone.
              </p>
              <div>
                <label
                  htmlFor='drop-table-confirm'
                  className='mb-1.5 block text-[12px] font-medium text-slate-700'
                >
                  Type <strong>{table}</strong> to confirm
                </label>
                <Input
                  id='drop-table-confirm'
                  value={dropConfirm}
                  onChange={(e) => setDropConfirm(e.target.value)}
                  placeholder={table}
                  className='font-mono text-[13px]'
                />
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant='outline'
              size='sm'
              onClick={() => {
                setShowDrop(false)
                setDropConfirm('')
              }}
            >
              Cancel
            </Button>
            <Button
              size='sm'
              variant='destructive'
              disabled={dropConfirm !== table || dropTableMutation.isPending}
              onClick={() => dropTableMutation.mutate()}
            >
              {dropTableMutation.isPending ? 'Dropping…' : 'Drop Table'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
