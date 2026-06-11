import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Eye,
  EyeOff,
  GripVertical,
  Key,
  Languages,
  Lock,
  Pencil,
  Plus,
  Settings2,
  Trash2
} from 'lucide-react'
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  useDroppable,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS as DndCSS } from '@dnd-kit/utilities'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { CollectionFieldPickerPanel, type PickedField } from '@/components/field-picker'
import { IconPicker } from '@/components/icon-picker'
import { FormulaBuilder } from '@/components/formula-builder'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
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

// ─── Rollup computed config ────────────────────────────────────────────────────

type RollupAggregate = 'sum' | 'count' | 'avg' | 'min' | 'max'

interface RollupConfig {
  related_collection: string
  fk_field: string
  aggregate: RollupAggregate
  value_field: string
  recursive?: boolean
}

const ROLLUP_AGGREGATE_OPTIONS: { value: RollupAggregate; label: string }[] = [
  { value: 'sum', label: 'sum' },
  { value: 'count', label: 'count' },
  { value: 'avg', label: 'avg' },
  { value: 'min', label: 'min' },
  { value: 'max', label: 'max' }
]

const EMPTY_ROLLUP: RollupConfig = {
  related_collection: '',
  fk_field: '',
  aggregate: 'sum',
  value_field: '',
  recursive: false
}

function parseRollup(formula: string | null | undefined): RollupConfig {
  if (!formula) return { ...EMPTY_ROLLUP }
  try {
    const parsed = JSON.parse(formula) as Partial<RollupConfig>
    return { ...EMPTY_ROLLUP, ...parsed }
  } catch {
    return { ...EMPTY_ROLLUP }
  }
}

function isRollupValid(cfg: RollupConfig): boolean {
  if (!cfg.related_collection || !cfg.fk_field) return false
  if (cfg.aggregate !== 'count' && !cfg.value_field) return false
  return true
}

function RollupConfigEditor({
  config,
  currentCollection,
  onChange
}: {
  config: RollupConfig
  currentCollection: string
  onChange: (next: RollupConfig) => void
}) {
  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () =>
      api.get<{ data: { collection: string }[] }>('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })

  const { data: relatedMeta } = useQuery({
    queryKey: ['collection-meta', config.related_collection],
    queryFn: () =>
      api
        .get<{ data: { fields: { field: string; type: string; hidden?: boolean }[] } }>(
          `/collections/${config.related_collection}`
        )
        .then((r) => r.data.data),
    enabled: !!config.related_collection,
    staleTime: 30_000
  })

  const collections = collectionsData ?? []
  const relatedFields = (relatedMeta?.fields ?? []).filter((f) => !f.hidden)
  const fieldOptions = relatedFields.map((f) => ({
    value: f.field,
    label: `${f.field} (${f.type})`
  }))
  const isSameCollection =
    !!config.related_collection && config.related_collection === currentCollection

  return (
    <div className='space-y-3'>
      <p className='text-[11px] text-slate-400'>
        Aggregate values from related items in another collection. The value is computed fresh on
        every read.
      </p>

      <div className='grid grid-cols-2 gap-3'>
        {/* Related collection */}
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Related collection</Label>
          <Combobox
            value={config.related_collection}
            onChange={(v) =>
              onChange({
                ...config,
                related_collection: v,
                fk_field: '',
                value_field: '',
                // recursive only valid when same collection — clear if it no longer applies
                recursive: v === currentCollection ? config.recursive : false
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
            value={config.fk_field}
            onChange={(v) => onChange({ ...config, fk_field: v })}
            options={fieldOptions}
            placeholder={config.related_collection ? 'Select field…' : 'Select collection first'}
            disabled={!config.related_collection}
          />
        </div>

        {/* Aggregate function */}
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Aggregate</Label>
          <Combobox
            value={config.aggregate}
            onChange={(v) => onChange({ ...config, aggregate: (v || 'sum') as RollupAggregate })}
            options={ROLLUP_AGGREGATE_OPTIONS}
            placeholder='Select function…'
          />
        </div>

        {/* Value field */}
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Value field</Label>
          <Combobox
            value={config.value_field}
            onChange={(v) => onChange({ ...config, value_field: v })}
            options={fieldOptions}
            placeholder={
              config.aggregate === 'count'
                ? 'Not used for count'
                : config.related_collection
                  ? 'Select field…'
                  : 'Select collection first'
            }
            disabled={config.aggregate === 'count' || !config.related_collection}
          />
        </div>
      </div>

      {/* Recursive — only when aggregating the same collection (tree) */}
      {isSameCollection && (
        <label className='flex cursor-pointer items-center gap-1.5 text-[12px]'>
          <input
            type='checkbox'
            checked={!!config.recursive}
            onChange={(e) => onChange({ ...config, recursive: e.target.checked })}
            className='rounded'
          />
          Recursive — aggregate all descendants at any depth (same-collection tree)
        </label>
      )}

      <p className='text-[11px] text-slate-400'>
        FK field is the column on{' '}
        <code className='rounded bg-slate-100 px-1'>
          {config.related_collection || 'the related collection'}
        </code>{' '}
        that points to this item's id.
      </p>
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
  const [rollup, setRollup] = useState<RollupConfig>({ ...EMPTY_ROLLUP })
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

  // Read-time + rollup computed = virtual; no DB column needed
  const isVirtual = computedEnabled && (computedType === 'read' || computedType === 'rollup')
  const isRollup = computedEnabled && computedType === 'rollup'

  // Stored value of computed_formula depends on type (JSON for rollup).
  const computedFormulaValue = isRollup ? JSON.stringify(rollup) : computedFormula.trim()
  const computedReady = isRollup ? isRollupValid(rollup) : !!computedFormula.trim()

  const addInterfaces = getInterfaces(form.type)

  const handleSubmit = async () => {
    if (!form.name) return
    setSaving(true)
    try {
      if (!isVirtual) {
        await schemaApi.addColumn(table, form)
      }
      // Always save field metadata (interface, note, visibility flags)
      await api.post(`/collections/${table}/fields`, {
        field: form.name,
        type: form.type,
        interface: fieldInterface || null,
        note: note || null,
        hidden,
        readonly,
        required,
        ...(computedEnabled && computedReady
          ? {
              computed_formula: computedFormulaValue,
              computed_type: computedType,
              computed_store: computedType === 'write' ? computedStore : false,
            }
          : {}),
      })
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
            options={FIELD_TYPES.map((ft) => ({ value: ft.value, label: ft.label, group: ft.group }))}
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
              onChange={(e) =>
                set('scale', e.target.value ? Number(e.target.value) : undefined)
              }
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
              <RollupConfigEditor config={rollup} currentCollection={table} onChange={setRollup} />
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
            <p className='text-[12px] font-medium text-amber-800'>System table — schema changes restricted</p>
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
      {(!isSystem || extendMode) && (
        addingColumn ? (
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
        )
      )}
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
      <div className={cn(
        'group flex items-center gap-3 px-4 py-2.5',
        isProtected ? 'opacity-40 cursor-default' : 'hover:bg-slate-50'
      )}>
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
          onSave={(body) => addFieldMeta.mutate(body)}
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
    if (o.group) { (groups[o.group] ??= []).push(o) }
    else ungrouped.push(o)
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
            <CommandEmpty className='py-2 text-center text-[12px] text-slate-400'>No results</CommandEmpty>
            {hasGroups
              ? Object.entries(groups).map(([group, items]) => (
                  <CommandGroup key={group} heading={group}>
                    {items.map((o) => (
                      <CommandItem
                        key={o.value}
                        value={`${o.label} ${o.value}`}
                        onSelect={() => { onChange(o.value); setOpen(false) }}
                        className='text-[12px]'
                      >
                        <Check className={cn('mr-1.5 h-3 w-3 shrink-0', value === o.value ? 'opacity-100' : 'opacity-0')} />
                        {o.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))
              : ungrouped.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={`${o.label} ${o.value}`}
                    onSelect={() => { onChange(o.value); setOpen(false) }}
                    className='text-[12px]'
                  >
                    <Check className={cn('mr-1.5 h-3 w-3 shrink-0', value === o.value ? 'opacity-100' : 'opacity-0')} />
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
  onSave: (body: Record<string, unknown>) => void
  onRemove?: () => void
  saving: boolean
}) {
  const fm = col.field_meta
  const abstractType = fm?.type ?? normalizeDataType(col)

  const [fieldType, setFieldTypeRaw] = useState(abstractType)
  const [fieldInterface, setFieldInterface] = useState(
    fm?.interface ?? getDefaultInterface(abstractType)
  )
  const [display, setDisplay] = useState(
    fm?.display ?? getDefaultDisplay(abstractType)
  )
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
    fm?.computed_type === 'rollup' ? parseRollup(fm?.computed_formula) : { ...EMPTY_ROLLUP }
  )
  const [formulaMode, setFormulaMode] = useState<'builder' | 'raw'>('builder')

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
        on_update: dtOnUpdate !== 'do_nothing' ? dtOnUpdate : undefined,
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
            computedType === 'rollup' ? JSON.stringify(rollup) : computedFormula.trim(),
          computed_type: computedType,
          computed_store: computedType === 'write' ? computedStore : false
        }
      : { computed_formula: null, computed_type: null, computed_store: false }

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
            options={FIELD_TYPES.map((ft) => ({ value: ft.value, label: ft.label, group: ft.group }))}
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
                  { value: 'datetime', label: 'Date & Time' },
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
                  { value: 'now', label: 'Save Current Date/Time' },
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
                  { value: 'now', label: 'Save Current Date/Time' },
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
            disabled={saving}
            onClick={() =>
              onSave({
                field: col.name,
                type: fieldType,
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
            }
          >
            {saving ? (
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
        label: t.display_name && t.display_name !== t.name ? `${t.name} — ${t.display_name}` : t.name
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
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={isDisabled}
          className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-left text-[12px] text-slate-800 focus:outline-none focus:ring-1 focus:ring-nvr-cyan disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground'
        >
          <span className={cn('flex min-w-0 flex-1 items-center gap-1 truncate', !value && 'text-slate-400')}>
            {isFetching
              ? 'Loading…'
              : value
                ? (
                  <>
                    <span className={cn('font-mono truncate', isNew && 'text-nvr-cyan')}>{value}</span>
                    {isNew && (
                      <span className='shrink-0 rounded bg-nvr-cyan/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-nvr-cyan'>NEW</span>
                    )}
                    {selected && <span className='shrink-0 text-slate-400'>({selected.data_type})</span>}
                  </>
                )
                : (placeholder ?? 'Select column…')}
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
            <CommandEmpty className={cn('py-2 text-center text-[12px] text-slate-400', showCreate && 'hidden')}>
              No columns
            </CommandEmpty>
            {cols.map((c) => (
              <CommandItem
                key={c.name}
                value={`${c.name} ${c.data_type}`}
                onSelect={() => { onChange(c.name); onNewColumn?.(''); setOpen(false); setSearch('') }}
                className='text-[12px]'
              >
                <Check className={cn('mr-1.5 h-3 w-3 shrink-0', value === c.name ? 'opacity-100' : 'opacity-0')} />
                <span className='font-mono'>{c.name}</span>
                <span className='ml-1.5 text-slate-400'>({c.data_type})</span>
              </CommandItem>
            ))}
            {showCreate && (
              <CommandItem
                key='__create__'
                value={`__create__ ${trimmed}`}
                onSelect={() => { onChange(trimmed); onNewColumn?.(trimmed); setOpen(false); setSearch('') }}
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
    return (
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
        one_field: 'id'
      }
    if (selectedType === 'm2m')
      return {
        many_collection: form.m2m_junction,
        many_field: form.m2m_many_field,
        one_collection: form.m2m_one_collection,
        one_field: form.m2m_one_field || 'id',
        junction_field: form.m2m_junction_field
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
    if (selectedType === 'm2m')
      return (
        !!form.m2m_junction &&
        !!form.m2m_many_field &&
        !!form.m2m_junction_field &&
        !!form.m2m_one_collection
      )
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
        (r) => r.many_collection === rel.many_collection && r.many_field === rel.junction_field && r.id !== rel.id
      )
      const target = companion?.one_collection ?? rel.one_collection
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
      base.m2m_junction = rel.many_collection
      base.m2m_many_field = rel.many_field
      base.m2m_junction_field = rel.junction_field ?? ''
      // rel.one_collection is the SOURCE (this) table — target must be resolved
      // from the companion relation where many_field === junction_field
      const companion = cmsRelations.find(
        (r) => r.many_collection === rel.many_collection &&
               r.many_field === rel.junction_field &&
               r.id !== rel.id
      )
      base.m2m_one_collection = companion?.one_collection ?? ''
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
        one_collection: editForm.m2m_one_collection,
        one_field: editForm.m2m_one_field || 'id'
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
        await schemaApi.addColumn(tableName, { name: form.m2o_many_field, type: form.m2o_new_field_type, nullable: true })
      }
      if (selectedType === 'm2a' && form.m2a_is_new_field && form.m2a_many_field) {
        await schemaApi.addColumn(tableName, { name: form.m2a_many_field, type: form.m2a_new_field_type, nullable: true })
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
            {cmsRelations.filter(rel =>
              // Only show relations directly involving this table.
              // Junction companion rows (many_collection=junction, one_collection=other)
              // stay in cmsRelations for M2M resolution but aren't table-level relations.
              rel.many_collection === tableName ||
              rel.one_collection === tableName
            ).map((rel, i) => {
              const t = detectRelationType(rel, tableName)
              const isDeleting = deleteId === rel.id
              const isEditing = editingId === rel.id
              return (
                <div key={rel.id} className={cn('px-4 py-3', i > 0 && 'border-t border-slate-100')}>
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

type TemplateToken = { type: 'text'; value: string } | { type: 'field'; value: string }

function parseTemplate(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = []
  const re = /\{\{([\w.]+)\}\}/g
  let last = 0
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: regex loop pattern
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', value: template.slice(last, m.index) })
    tokens.push({ type: 'field', value: m[1] })
    last = m.index + m[0].length
  }
  if (last < template.length) tokens.push({ type: 'text', value: template.slice(last) })
  return tokens
}

function serializeTemplate(tokens: TemplateToken[]): string {
  return tokens.map((t) => (t.type === 'field' ? `{{${t.value}}}` : t.value)).join('')
}

function DisplayTemplateEditor({
  value,
  onChange,
  collection
}: {
  value: string
  onChange: (v: string) => void
  collection: string
}) {
  const tokens = parseTemplate(value)
  const [pickerOpen, setPickerOpen] = useState(false)

  function updateToken(idx: number, text: string) {
    const next = tokens.map((t, i) => (i === idx ? { ...t, value: text } : t))
    onChange(serializeTemplate(next))
  }

  function removeToken(idx: number) {
    onChange(serializeTemplate(tokens.filter((_, i) => i !== idx)))
  }

  function insertField(picked: PickedField) {
    const field = picked.path.join('.')
    const last = tokens[tokens.length - 1]
    const next: TemplateToken[] =
      last?.type === 'text'
        ? [...tokens.slice(0, -1), last, { type: 'field', value: field }, { type: 'text', value: '' }]
        : [...tokens, { type: 'field', value: field }, { type: 'text', value: '' }]
    onChange(serializeTemplate(next))
    setPickerOpen(false)
  }

  return (
    <div className='flex flex-wrap items-center gap-1 min-h-8 rounded-md border border-slate-200 bg-white px-2 py-1'>
      {tokens.length === 0 && (
        <span className='text-[12px] text-slate-400'>e.g. {'{{name}}'} — {'{{status}}'}</span>
      )}
      {tokens.map((tok, idx) =>
        tok.type === 'field' ? (
          <span
            key={`f-${idx}`}
            className='inline-flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-2 py-0.5 text-[12px] font-medium text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
          >
            {tok.value.split('.').map(titleCase).join(' → ')}
            <button
              type='button'
              onClick={() => removeToken(idx)}
              className='text-nvr-navy/50 hover:text-red-500 dark:text-nvr-cyan/50'
            >
              ×
            </button>
          </span>
        ) : (
          <input
            key={`t-${idx}`}
            value={tok.value}
            onChange={(e) => updateToken(idx, e.target.value)}
            placeholder={idx === 0 && tokens.length <= 1 ? 'text…' : undefined}
            size={Math.max(1, tok.value.length || (idx === 0 && tokens.length <= 1 ? 6 : 1))}
            className='flex-shrink bg-transparent text-[13px] text-slate-700 outline-none placeholder-slate-300'
          />
        )
      )}
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='inline-flex items-center gap-0.5 rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-400 hover:border-nvr-cyan hover:text-nvr-cyan'
          >
            <Plus className='h-3 w-3' /> field
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-auto p-0' sideOffset={6}>
          <CollectionFieldPickerPanel
            collection={collection}
            onSelect={(picked) => insertField(picked)}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

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
  const [displayName, setDisplayName] = useState(meta?.display_name ?? '')
  const [icon, setIcon] = useState(meta?.icon ?? '')
  const [note, setNote] = useState(meta?.note ?? '')
  const [displayTemplate, setDisplayTemplate] = useState(meta?.display_template ?? '')

  const registerMutation = useMutation({
    mutationFn: () =>
      schemaApi.registerCollection(tableName, {
        display_name: displayName || undefined,
        icon: icon || undefined,
        note: note || undefined,
        display_template: displayTemplate || null
      }),
    onSuccess: () => {
      toast.success('Collection settings saved')
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
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={tableName}
              className='text-[13px]'
            />
          </div>
          <div>
            <Label className='mb-1 block text-[12px]'>Icon</Label>
            <IconPicker value={icon} onChange={setIcon} />
          </div>
          <div>
            <Label className='mb-1 block text-[12px]'>Note</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder='A short description of this collection'
              className='text-[13px]'
            />
          </div>
          <div>
            <Label className='mb-1 block text-[12px]'>Display template</Label>
            <DisplayTemplateEditor
              value={displayTemplate}
              onChange={setDisplayTemplate}
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

// ─── Addendums toggle (Settings tab) ───────────────────────────────────────────

function AddendumsSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()

  const { data: col } = useQuery({
    queryKey: ['collection-meta', tableName],
    queryFn: () =>
      api
        .get<{ data: { addendums_enabled: boolean } }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 10 * 60 * 1000
  })

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch(`/collections/${tableName}`, { addendums_enabled: enabled ? 1 : 0 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection-meta', tableName] })
      toast.success('Addendums setting saved')
    },
    onError: () => toast.error('Failed to update setting')
  })

  const enabled = col?.addendums_enabled === true || (col?.addendums_enabled as unknown) === 1

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='flex items-center justify-between px-4 py-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Addendums</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Allow amendment records (addendums) to be created against items in this collection, with
            optional cost and timeline impact tracking.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => toggleMut.mutate(v)}
          disabled={toggleMut.isPending || col === undefined}
        />
      </div>
    </div>
  )
}

// ─── AI Features card (Settings tab) ───────────────────────────────────────────

interface AiCollectionSettings {
  collection: string
  validation_enabled: boolean
  validation_mode: 'soft' | 'hard'
  validation_rules: string[]
  duplicate_detection_enabled: boolean
  duplicate_threshold: number
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
  const [rules, setRules] = useState<string[]>([])
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
        validation_rules: rules.map((r) => r.trim()).filter((r) => r.length > 0),
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
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='h-6 px-2 text-[11px]'
                    onClick={() => setRules((prev) => [...prev, ''])}
                  >
                    <Plus className='mr-1 h-3 w-3' />
                    Add Rule
                  </Button>
                </div>
                {rules.length === 0 ? (
                  <p className='text-[11px] text-slate-400'>
                    No rules yet — e.g. "description must be at least 50 words"
                  </p>
                ) : (
                  <div className='space-y-2'>
                    {rules.map((rule, i) => (
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
                    ))}
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
          onClick={() => saveMutation.mutate()}
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

interface FieldGroup {
  id: number
  collection: string
  key: string
  label: string
  type: 'section' | 'tab'
  icon: string | null
  sort: number
  is_collapsed: boolean
}

// ── Width options ──────────────────────────────────────────────────────────────
const WIDTH_OPTIONS = [
  { span: 12, label: 'Full' },
  { span: 6,  label: '1/2'  },
  { span: 4,  label: '1/3'  },
  { span: 3,  label: '1/4'  },
] as const

function parseColSpan(options: unknown): number {
  try {
    const obj = typeof options === 'string' ? JSON.parse(options) : options
    const span = (obj as Record<string, unknown>)?.col_span
    return typeof span === 'number' ? span : 12
  } catch { return 12 }
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
}

function FieldSettingsPopover({
  fieldName,
  abstractType,
  isM2O,
  isM2M,
  settings,
  onSave,
}: {
  fieldName: string
  abstractType?: string
  isM2O?: boolean
  isM2M?: boolean
  settings: FieldSettings
  onSave: (patch: Partial<FieldSettings>) => void
}) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState(settings.label ?? '')
  const [iface, setIface] = useState(settings.interface ?? '')
  const [note, setNote] = useState(settings.note ?? '')
  const [required, setRequired] = useState(settings.required)
  const [hidden, setHidden] = useState(settings.hidden)
  const [readonly, setReadonly] = useState(settings.readonly)
  const [inlineRelation, setInlineRelation] = useState(settings.inline_relation)
  const [maxValues, setMaxValues] = useState<string>(settings.max_values != null ? String(settings.max_values) : '')

  // Reset local state when popover opens
  function handleOpenChange(next: boolean) {
    if (next) {
      setLabel(settings.label ?? '')
      setIface(settings.interface ?? '')
      setNote(settings.note ?? '')
      setRequired(settings.required)
      setHidden(settings.hidden)
      setReadonly(settings.readonly)
      setInlineRelation(settings.inline_relation)
      setMaxValues(settings.max_values != null ? String(settings.max_values) : '')
    }
    setOpen(next)
  }

  function save() {
    const maxV = maxValues.trim() ? parseInt(maxValues, 10) : null
    onSave({
      label: label.trim() || null,
      interface: iface || null,
      note: note.trim() || null,
      required,
      hidden,
      readonly,
      inline_relation: inlineRelation,
      max_values: maxV && maxV > 0 ? maxV : null,
    })
    setOpen(false)
  }

  const interfaceOptions = abstractType
    ? getInterfaces(abstractType).map(i => ({ value: i.value, label: i.label }))
    : []

  const hasOverrides = !!settings.label || !!settings.interface || !!settings.note || settings.hidden || settings.readonly || settings.required

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type='button'
          title='Display settings'
          onPointerDown={e => e.stopPropagation()}
          className={cn(
            'shrink-0 rounded p-0.5 transition-colors',
            hasOverrides
              ? 'text-nvr-cyan hover:text-nvr-cyan/80'
              : 'text-slate-300 opacity-0 group-hover:opacity-100 hover:text-slate-500'
          )}
        >
          <Settings2 className='h-3.5 w-3.5' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className='w-72 p-0'
        align='end'
        onPointerDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
      >
        <div className='border-b border-slate-100 px-3 py-2'>
          <p className='text-[12px] font-medium text-slate-800'>Display settings</p>
          <p className='text-[11px] text-slate-400 font-mono'>{fieldName}</p>
        </div>
        <div className='space-y-3 p-3'>
          {/* Label override */}
          <div className='space-y-1'>
            <Label className='text-[11px] text-slate-600'>Label</Label>
            <Input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={titleCase(fieldName)}
              className='h-7 text-[12px]'
            />
          </div>

          {/* Interface override */}
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

          {/* Note */}
          <div className='space-y-1'>
            <Label className='text-[11px] text-slate-600'>Note</Label>
            <Textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder='Helper text shown below the field'
              className='min-h-[56px] resize-none text-[12px]'
            />
          </div>

          {/* Toggles */}
          <div className='space-y-2 rounded-md border border-slate-100 bg-slate-50 px-3 py-2'>
            {([
              { key: 'required', label: 'Required', value: required, set: setRequired },
              { key: 'hidden', label: 'Hidden', value: hidden, set: setHidden },
              { key: 'readonly', label: 'Read-only', value: readonly, set: setReadonly },
            ] as const).map(row => (
              <div key={row.key} className='flex items-center justify-between'>
                <span className='text-[12px] text-slate-600'>{row.label}</span>
                <Switch checked={row.value} onCheckedChange={row.set} className='scale-90' />
              </div>
            ))}
            {isM2O && (
              <div className='flex items-center justify-between border-t border-slate-200 pt-2'>
                <span className='text-[12px] text-slate-600'>Inline edit</span>
                <Switch checked={inlineRelation} onCheckedChange={setInlineRelation} className='scale-90' />
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
                onChange={e => setMaxValues(e.target.value)}
                placeholder='Unlimited'
                className='h-7 text-[12px]'
              />
              <p className='text-[10px] text-slate-400'>Leave blank for unlimited. Set to 1 for single-select.</p>
            </div>
          )}

          <div className='flex gap-2 pt-1'>
            <Button size='sm' className='h-7 flex-1 text-[12px]' onClick={save}>
              Save
            </Button>
            <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
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
  dragHandleProps = {},
  style = {},
  isDragging = false,
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
  onSettings?: (patch: Partial<FieldSettings>) => void
  dragHandleProps?: Record<string, unknown>
  style?: React.CSSProperties
  isDragging?: boolean
}) {
  const [open, setOpen] = useState(false)
  const widthLabel = WIDTH_OPTIONS.find(w => w.span === colSpan)?.label ?? 'Full'

  return (
    <div
      style={style}
      className={cn(
        'group flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[12px] select-none',
        isDragging ? 'shadow-lg opacity-80 ring-2 ring-nvr-cyan/40' : 'shadow-sm hover:border-slate-300'
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
        <span className={cn(
          'shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]',
          FRIENDLY_TYPE_STYLES[fieldType] ?? 'bg-slate-100 text-slate-500'
        )}>
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
          onSave={onSettings}
        />
      )}

      {/* width selector — stopPropagation prevents dnd-kit from capturing pointer events */}
      {onColSpan && (
        <div className='relative shrink-0' onPointerDown={e => e.stopPropagation()}>
          <button
            type='button'
            onClick={() => setOpen(o => !o)}
            className='flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-200'
          >
            {widthLabel}
            <ChevronDown className='h-2.5 w-2.5' />
          </button>
          {open && (
            <div className='absolute right-0 top-full z-20 mt-1 rounded-md border border-slate-200 bg-white py-1 shadow-md'>
              {WIDTH_OPTIONS.map(w => (
                <button
                  key={w.span}
                  type='button'
                  onClick={() => { onColSpan(w.span); setOpen(false) }}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-1.5 text-[12px] hover:bg-slate-50',
                    w.span === colSpan ? 'font-medium text-nvr-cyan' : 'text-slate-700'
                  )}
                >
                  <span className='inline-flex h-2.5 w-12 overflow-hidden rounded-sm bg-slate-100'>
                    <span className='h-full rounded-sm bg-nvr-cyan/50' style={{ width: `${(w.span / 12) * 100}%` }} />
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
  inGrid = false,
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
  onSettings?: (patch: Partial<FieldSettings>) => void
  inGrid?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: fieldName,
    data: { type: 'field' },
  })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      style={{
        transform: DndCSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.3 : 1,
        gridColumn: inGrid ? `span ${colSpan}` : undefined,
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
        dragHandleProps={listeners ?? {}}
      />
    </div>
  )
}

// ── SortableGroupCard ─────────────────────────────────────────────────────────

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
  onFieldSettings?: (f: string, patch: Partial<FieldSettings>) => void
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
    data: { type: 'group' },
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Transform.toString(transform), transition }}
      className={cn('rounded-lg border border-slate-200 bg-white', isDragging && 'opacity-50 ring-2 ring-nvr-cyan/40')}
    >
      {/* Group header */}
      <div className='group flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2.5'>
        <span className='shrink-0 cursor-grab text-slate-300 hover:text-slate-500 active:cursor-grabbing' {...attributes} {...listeners}>
          <GripVertical className='h-3.5 w-3.5' />
        </span>
        {/* Icon picker */}
        <div className='flex items-center' onPointerDown={e => e.stopPropagation()}>
          {(() => {
            const GroupIcon = group.icon ? resolveCollectionIcon(group.icon) : null
            return (
              <IconPicker
                value={group.icon ?? ''}
                onChange={v => onIconChange(v || null)}
                trigger={
                  GroupIcon ? (
                    <button type='button' title='Change icon' className='shrink-0 rounded p-0.5 text-slate-400 hover:text-nvr-cyan transition-colors'>
                      <GroupIcon className='h-3.5 w-3.5' />
                    </button>
                  ) : (
                    <button type='button' title='Add icon' className='shrink-0 rounded p-0.5 text-slate-300 hover:text-slate-500 transition-all'>
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
            onChange={e => setLabelDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setLabelDraft(group.label); setEditing(false) } }}
            onPointerDown={e => e.stopPropagation()}
            className='flex-1 rounded border border-nvr-cyan/50 bg-white px-1.5 py-0.5 text-[13px] font-medium text-slate-800 outline-none ring-1 ring-nvr-cyan/30'
          />
        ) : (
          <button
            type='button'
            onClick={() => { setLabelDraft(group.label); setEditing(true) }}
            title='Click to rename'
            className='group/label flex flex-1 items-center gap-1 truncate text-left text-[13px] font-medium text-slate-800 hover:text-nvr-cyan'
          >
            <span className='truncate'>{group.label}</span>
            <Pencil className='h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/label:opacity-50' />
          </button>
        )}
        <span className='font-mono text-[10px] text-slate-400'>{group.key}</span>
        <button
          type='button'
          title='Click to toggle section / tab'
          onClick={onToggleType}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:opacity-80',
            group.type === 'tab' ? 'bg-nvr-cyan/10 text-nvr-cyan' : 'bg-slate-100 text-slate-500'
          )}
        >
          {group.type}
        </button>
        <button type='button' onClick={onDelete} className='rounded p-1 text-slate-300 hover:text-red-500'>
          <Trash2 className='h-3.5 w-3.5' />
        </button>
      </div>

      {/* Field drop zone — useDroppable registers this as a dnd-kit target */}
      <DroppableFieldZone containerId={group.key}>
      <SortableContext items={fieldNames} strategy={rectSortingStrategy}>
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
            fieldNames.map(f => {
              const ft = allFields.find(af => af.field === f)
              const settings = getFieldSettings?.(f)
              const kind = getRelKind?.(f)
              return (
                <SortableFieldChip
                  key={f}
                  fieldName={f}
                  displayName={settings?.label ?? titleCase(f)}
                  fieldType={kind ?? getFriendlyType?.(ft?.type, f)}
                  abstractType={kind ? kind.toLowerCase() : ft?.type}
                  isM2O={kind === 'M2O'}
                  isM2M={kind === 'M2M'}
                  colSpan={getColSpan(f)}
                  onColSpan={span => onColSpan(f, span)}
                  fieldSettings={settings}
                  onSettings={onFieldSettings ? patch => onFieldSettings(f, patch) : undefined}
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

// ── DroppableFieldZone ────────────────────────────────────────────────────────

function DroppableFieldZone({ containerId, children }: { containerId: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `drop:${containerId}` })
  return (
    <div ref={setNodeRef} className={cn('transition-colors', isOver && 'bg-nvr-cyan/[0.04]')}>
      {children}
    </div>
  )
}

// ─── Layouts tab ─────────────────────────────────────────────────────────────

interface CollectionLayout {
  id: number
  collection: string
  name: string
  is_active: boolean | number
  sort: number
}

function LayoutsTab({ tableName, dbColumns }: { tableName: string; dbColumns: Array<{ name: string; data_type: string }> }) {
  const qc = useQueryClient()
  const invalidateLayouts = useCallback(
    () => qc.invalidateQueries({ queryKey: ['collection-layouts', tableName] }),
    [qc, tableName]
  )

  const { data: layouts = [], isSuccess: layoutsLoaded } = useQuery<CollectionLayout[]>({
    queryKey: ['collection-layouts', tableName],
    queryFn: () =>
      api.get<{ data: CollectionLayout[] }>('/collection-layouts', { params: { collection: tableName } })
        .then((r) => r.data.data ?? []),
    enabled: !!tableName
  })

  // Auto-seed "Default" layout for collections that have none yet
  useEffect(() => {
    if (layoutsLoaded && layouts.length === 0 && tableName) {
      api.post('/collection-layouts', { collection: tableName, name: 'Default' })
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

  const createMut = useMutation({
    mutationFn: (name: string) => api.post('/collection-layouts', { collection: tableName, name }),
    onSuccess: () => { invalidateLayouts(); setAdding(false); setNewName('') },
    onError: () => toast.error('Failed to create layout')
  })

  const activateMut = useMutation({
    mutationFn: (id: number) => api.post(`/collection-layouts/${id}/activate`),
    onSuccess: () => { invalidateLayouts(); toast.success('Layout activated') }
  })

  const cloneMut = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.post<{ data: CollectionLayout }>(`/collection-layouts/${id}/clone`, { name }),
    onSuccess: (res) => {
      invalidateLayouts()
      setSelectedId(res.data.data.id)
      toast.success('Layout cloned')
    }
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/collection-layouts/${id}`),
    onSuccess: () => { invalidateLayouts(); setSelectedId(null) },
    onError: () => toast.error('Cannot delete the only layout')
  })

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.patch(`/collection-layouts/${id}`, { name }),
    onSuccess: () => { invalidateLayouts(); setEditingId(null) }
  })

  const selected = layouts.find((l) => l.id === effectiveId) ?? null

  return (
    <div className='flex min-h-0 gap-4'>
      {/* Left sidebar */}
      <div className='flex w-[140px] shrink-0 flex-col gap-0.5 border-r border-slate-200 pr-3 dark:border-border'>
        <p className='mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400'>Layouts</p>
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
                <button type='button' onClick={() => setSelectedId(l.id)} className='flex min-w-0 flex-1 items-center gap-1.5'>
                  {l.is_active ? (
                    <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-nvr-cyan' />
                  ) : (
                    <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-transparent' />
                  )}
                  <span className='truncate'>{l.name}</span>
                </button>
                <button
                  type='button'
                  onClick={() => { setEditingId(l.id); setEditingName(l.name) }}
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
              onBlur={() => { setAdding(false); setNewName('') }}
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
            <span className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>{selected.name}</span>
            {selected.is_active ? (
              <span className='rounded bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-cyan'>Active</span>
            ) : (
              <button
                type='button'
                onClick={() => activateMut.mutate(selected.id)}
                className='rounded bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-cyan hover:bg-nvr-cyan/20'
              >
                Set active
              </button>
            )}
            <div className='ml-auto flex items-center gap-1'>
              <button
                type='button'
                onClick={() => cloneMut.mutate({ id: selected.id, name: `${selected.name} (copy)` })}
                className='rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
              >
                Clone
              </button>
              {confirmDeleteId === selected.id ? (
                <>
                  <span className='text-[10px] text-slate-500'>Delete?</span>
                  <button
                    type='button'
                    onClick={() => { deleteMut.mutate(selected.id); setConfirmDeleteId(null) }}
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
        <FieldGroupsTab tableName={tableName} dbColumns={dbColumns} layoutId={effectiveId} />
      </div>
    </div>
  )
}

// ── LayoutTab ─────────────────────────────────────────────────────────────────

function FieldGroupsTab({ tableName, dbColumns = [], layoutId }: { tableName: string; dbColumns?: Array<{ name: string; data_type: string }>; layoutId: number | null }) {
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
    queryFn: () => api.get(`/collections/${tableName}`).then(r => r.data.data),
    enabled: !!tableName,
    staleTime: 30_000
  })

  const { data: fieldConfig = [] } = useQuery({
    queryKey: ['field-config', tableName, layoutId],
    queryFn: () =>
      api
        .get<{ data: Array<{
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
        }> }>(
          `/field-config/${tableName}`,
          { params: layoutId ? { layout_id: layoutId } : {} }
        )
        .then((r) => r.data.data ?? []),
    enabled: !!tableName,
    staleTime: 30_000
  })

  const allFields: Array<{ field: string; type?: string; options?: string | null }> = colMeta?.fields ?? []
  const relations: Array<{ many_field: string; one_collection: string | null; one_field?: string | null; junction_field: string | null }> = colMeta?.relations ?? []

  // field → relation kind label
  const relKind = (fieldName: string): string | null => {
    // Virtual M2M field — this collection is the "one" side of the junction
    const m2m = relations.find(r => r.one_field === fieldName && r.junction_field !== null)
    if (m2m) return 'M2M'
    // Virtual O2M field
    const o2m = relations.find(r => r.one_field === fieldName && r.junction_field === null)
    if (o2m) return 'O2M'
    // M2O FK column on this collection
    const r = relations.find(r => r.many_field === fieldName)
    if (!r) return null
    return r.one_collection ? 'M2O' : null
  }

  const DB_TYPE_LABELS: Record<string, string> = {
    nvarchar: 'text', varchar: 'text', ntext: 'text', text: 'text',
    int: 'num', bigint: 'bigint', tinyint: 'bool',
    bit: 'bool', float: 'float', real: 'float',
    decimal: 'decimal', numeric: 'decimal', money: 'money',
    date: 'date', datetime: 'datetime', datetime2: 'datetime', time: 'time',
    uniqueidentifier: 'uuid',
  }
  const ABSTRACT_TYPE_LABELS: Record<string, string> = {
    string: 'text', text: 'text', integer: 'num', bigInteger: 'bigint',
    float: 'float', decimal: 'decimal', boolean: 'bool',
    date: 'date', datetime: 'datetime', uuid: 'uuid', json: 'json',
  }
  const friendlyType = (abstractType?: string, fieldName?: string): string | undefined => {
    // Prefer actual DB column type when available
    if (fieldName) {
      const col = dbColumns.find(c => c.name === fieldName)
      if (col) return DB_TYPE_LABELS[col.data_type.toLowerCase()] ?? col.data_type
    }
    return abstractType ? (ABSTRACT_TYPE_LABELS[abstractType] ?? abstractType) : undefined
  }

  // ── Local optimistic state ──
  const [localGroupOrder, setLocalGroupOrder] = useState<number[]>([])
  const [localAssignments, setLocalAssignments] = useState<Record<string, string | null>>({})
  const [localFieldOrder, setLocalFieldOrder] = useState<Record<string, string[]>>({})
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null)

  useEffect(() => {
    if (!groups.length && !allFields.length) return
    setLocalGroupOrder(groups.map(g => g.id))
    const assignments: Record<string, string | null> = {}
    const fieldOrder: Record<string, string[]> = { __unassigned__: [] }
    for (const g of groups) fieldOrder[g.key] = []
    const sorted = [...allFields].sort((a, b) => {
      const as_ = fieldConfig.find(fc => fc.field === a.field)?.sort ?? 9999
      const bs_ = fieldConfig.find(fc => fc.field === b.field)?.sort ?? 9999
      return as_ - bs_
    })
    for (const f of sorted) {
      const gk = fieldConfig.find(fc => fc.field === f.field)?.group_key ?? null
      assignments[f.field] = gk
      if (gk && fieldOrder[gk] !== undefined) fieldOrder[gk].push(f.field)
      else fieldOrder.__unassigned__.push(f.field)
    }
    setLocalAssignments(assignments)
    setLocalFieldOrder(fieldOrder)
  }, [groups, fieldConfig, allFields])

  // ── Mutations ──
  const invalidateGroups = useCallback(() => qc.invalidateQueries({ queryKey: ['field-groups', tableName] }), [qc, tableName])
  const invalidateFieldConfig = useCallback(() => qc.invalidateQueries({ queryKey: ['field-config', tableName] }), [qc, tableName])
  const invalidateMeta = useCallback(() => qc.invalidateQueries({ queryKey: ['collection-meta', tableName] }), [qc, tableName])

  const createMut = useMutation({
    mutationFn: (body: { collection: string; key: string; label: string; type: 'section' | 'tab' }) =>
      api.post('/field-groups', { ...body, layout_id: layoutId }),
    onSuccess: () => { invalidateGroups(); setAdding(false); setNewKey(''); setNewLabel(''); toast.success('Group created') },
    onError: () => toast.error('Failed to create group')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/field-groups/${id}`),
    onSuccess: () => { invalidateGroups(); invalidateFieldConfig(); toast.success('Group deleted') }
  })

  const patchTypeMut = useMutation({
    mutationFn: ({ id, type }: { id: number; type: 'section' | 'tab' }) => api.patch(`/field-groups/${id}`, { type }),
    onSuccess: () => invalidateGroups()
  })

  const renameMut = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) => api.patch(`/field-groups/${id}`, { label }),
    onSuccess: () => invalidateGroups()
  })

  const iconMut = useMutation({
    mutationFn: ({ id, icon }: { id: number; icon: string | null }) => api.patch(`/field-groups/${id}`, { icon }),
    onSuccess: () => invalidateGroups()
  })

  const reorderGroupsMut = useMutation({
    mutationFn: (order: Array<{ id: number; sort: number }>) =>
      api.post('/field-groups/reorder', { collection: tableName, order })
  })

  const patchField = useCallback((field: string, patch: Record<string, unknown>) => {
    if (layoutId && ('group_key' in patch || 'sort' in patch)) {
      // Build full assignments from current local state and flush to backend
      const allAssignments = Object.entries(localAssignments).flatMap(([f, gk]) => {
        const groupFields = localFieldOrder[gk ?? '__unassigned__'] ?? []
        const sortIdx = groupFields.indexOf(f)
        return [{ field: f, group_key: gk ?? null, sort: sortIdx >= 0 ? sortIdx : 0 }]
      })
      // Also include the field being patched with its new values
      const patchedAssignment = {
        field,
        group_key: ('group_key' in patch ? patch.group_key : localAssignments[field]) as string | null,
        sort: ('sort' in patch ? patch.sort : 0) as number
      }
      const merged = allAssignments.map(a => a.field === field ? patchedAssignment : a)
      if (!merged.find(a => a.field === field)) merged.push(patchedAssignment)
      api.put(`/collection-layouts/${layoutId}/assignments`, { assignments: merged })
        .then(() => { invalidateFieldConfig() })
        .catch(() => toast.error('Failed to save field order'))
    } else {
      api.patch(`/field-config/${tableName}/${field}`, patch)
        .then(() => { invalidateFieldConfig(); invalidateMeta() })
    }
  }, [tableName, layoutId, localAssignments, localFieldOrder, invalidateFieldConfig, invalidateMeta])

  // ── Add group form ──
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newType, setNewType] = useState<'section' | 'tab'>('section')

  // ── dnd ──
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const orderedGroups = useMemo(
    () => localGroupOrder.map(id => groups.find(g => g.id === id)).filter(Boolean) as FieldGroup[],
    [localGroupOrder, groups]
  )

  function findContainer(id: string): string {
    if (id.startsWith('group:')) return '__groups__'
    for (const [container, fields] of Object.entries(localFieldOrder)) {
      if (fields.includes(id)) return container
    }
    return '__unassigned__'
  }

  function handleDragStart({ active }: DragStartEvent) {
    if (!String(active.id).startsWith('group:')) setActiveFieldId(String(active.id))
  }

  function handleDragOver({ active, over }: DragOverEvent) {
    // Only handle same-container sorting here — cross-container done in onDragEnd
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId.startsWith('group:') || overId.startsWith('drop:') || overId.startsWith('group:')) return

    const fromContainer = findContainer(activeId)
    const toContainer = findContainer(overId)
    if (!toContainer || fromContainer !== toContainer) return

    const fields = localFieldOrder[fromContainer] ?? []
    const fromIdx = fields.indexOf(activeId)
    const toIdx = fields.indexOf(overId)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return

    setLocalFieldOrder(prev => ({
      ...prev,
      [fromContainer]: arrayMove(prev[fromContainer] ?? [], fromIdx, toIdx),
    }))
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveFieldId(null)
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)

    // ── Group reorder ──
    if (activeId.startsWith('group:')) {
      const activeKey = activeId.replace('group:', '')
      const overKey = overId.replace('group:', '')
      const activeIdx = orderedGroups.findIndex(g => g.key === activeKey)
      const overIdx = orderedGroups.findIndex(g => g.key === overKey)
      if (activeIdx === -1 || overIdx === -1 || activeIdx === overIdx) return
      const newOrder = arrayMove(localGroupOrder, activeIdx, overIdx)
      setLocalGroupOrder(newOrder)
      reorderGroupsMut.mutate(newOrder.map((id, sort) => ({ id, sort })))
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
      // Same container — already sorted in onDragOver, commit sort order to API
      const fields = localFieldOrder[fromContainer] ?? []
      if (layoutId) {
        // Layout-aware: flush full assignment list
        const allFields = Object.keys(localAssignments)
        const assignments = allFields.map((f) => {
          const gk = localAssignments[f] ?? null
          const order = localFieldOrder[gk ?? '__unassigned__'] ?? []
          return { field: f, group_key: gk, sort: order.indexOf(f) >= 0 ? order.indexOf(f) : 0 }
        })
        api.put(`/collection-layouts/${layoutId}/assignments`, { assignments })
          .then(() => invalidateFieldConfig())
          .catch(() => toast.error('Failed to save field order'))
      } else {
        fields.forEach((f, idx) => {
          api.patch(`/field-config/${tableName}/${f}`, { sort: idx, group_key: localAssignments[f] ?? null })
        })
        invalidateFieldConfig()
      }
      return
    }

    // ── Cross-container drop — single state update, no jumping ──
    const newGroupKey = toContainer === '__unassigned__' ? null : toContainer
    setLocalAssignments(prev => ({ ...prev, [activeId]: newGroupKey }))
    setLocalFieldOrder(prev => ({
      ...prev,
      [fromContainer]: (prev[fromContainer] ?? []).filter(f => f !== activeId),
      [toContainer]: [...(prev[toContainer] ?? []), activeId],
    }))
    patchField(activeId, {
      group_key: newGroupKey,
      sort: (localFieldOrder[toContainer] ?? []).length,
    })
  }

  const getColSpan = useCallback((f: string) => {
    const field = allFields.find(af => af.field === f)
    return parseColSpan(field?.options)
  }, [allFields])

  const getFieldSettings = useCallback((f: string): FieldSettings => {
    const fc = fieldConfig.find(c => c.field === f)
    // Read options from fieldConfig (field-config endpoint now returns parsed options)
    // This ensures max_values/inline_relation are fresh after every patch without
    // waiting for collection-meta to refetch.
    const rawOpts = (fc as Record<string, unknown> | undefined)?.options
    let opts: Record<string, unknown> = {}
    try {
      opts = typeof rawOpts === 'string' ? JSON.parse(rawOpts) : ((rawOpts as Record<string, unknown>) ?? {})
    } catch { /* noop */ }
    return {
      label: fc?.label ?? null,
      interface: fc?.interface ?? null,
      note: fc?.note ?? null,
      required: !!fc?.required,
      hidden: !!fc?.hidden,
      readonly: !!fc?.readonly,
      inline_relation: opts.inline_relation !== false,
      max_values: typeof opts.max_values === 'number' ? opts.max_values : null,
    }
  }, [fieldConfig])

  const handleFieldSettings = useCallback((f: string, patch: Partial<FieldSettings>) => {
    patchField(f, patch)
  }, [patchField])

  const activeFieldData = activeFieldId ? allFields.find(f => f.field === activeFieldId) : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => {
        if (String(args.active.id).startsWith('group:')) return closestCenter(args)
        const pointer = pointerWithin(args)
        return pointer.length > 0 ? pointer : rectIntersection(args)
      }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className='flex gap-4 items-start'>
        {/* Left sidebar — unassigned field pool */}
        <div className='w-64 shrink-0'>
          <div className='rounded-lg border border-dashed border-slate-200 bg-slate-50 sticky top-0'>
            <div className='border-b border-slate-200 px-3 py-2'>
              <p className='text-[11px] font-medium text-slate-400'>
                Unassigned
                {(localFieldOrder.__unassigned__ ?? []).length > 0 && (
                  <span className='ml-1 text-slate-300'>({(localFieldOrder.__unassigned__ ?? []).length})</span>
                )}
              </p>
            </div>
            <DroppableFieldZone containerId='__unassigned__'>
            <SortableContext items={localFieldOrder.__unassigned__ ?? []} strategy={verticalListSortingStrategy}>
              <div className='overflow-y-auto min-h-[40px] space-y-1.5 p-2' style={{ maxHeight: 'calc(100vh - 220px)' }}>
                {(localFieldOrder.__unassigned__ ?? []).length === 0 ? (
                  <p className='py-2 text-center text-[10px] text-slate-300'>All fields assigned</p>
                ) : (localFieldOrder.__unassigned__ ?? []).map(f => {
                  const ft = allFields.find(af => af.field === f)
                  const settings = getFieldSettings(f)
                  const kind = relKind(f)
                  return (
                    <SortableFieldChip
                      key={f}
                      fieldName={f}
                      displayName={settings.label ?? titleCase(f)}
                      fieldType={kind ?? friendlyType(ft?.type, f)}
                      abstractType={kind ? kind.toLowerCase() : ft?.type}
                      isM2O={kind === 'M2O'}
                      isM2M={kind === 'M2M'}
                      colSpan={getColSpan(f)}
                      fieldSettings={settings}
                      onSettings={patch => handleFieldSettings(f, patch)}
                    />
                  )
                })}
              </div>
            </SortableContext>
            </DroppableFieldZone>
          </div>
        </div>

        {/* Main area — groups */}
        <div className='min-w-0 flex-1 space-y-3'>
          <div className='flex items-center justify-between'>
            <p className='text-[12px] text-slate-500'>
              Drag fields into groups and set column widths for side-by-side layout.
            </p>
            <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={() => setAdding(true)}>
              <Plus className='mr-1 h-3 w-3' />
              Add Group
            </Button>
          </div>

        {/* Groups */}
        {groupsLoading ? (
          <div className='space-y-2'>{[1,2].map(k => <Skeleton key={k} className='h-24 w-full rounded-lg' />)}</div>
        ) : (
          <SortableContext items={orderedGroups.map(g => `group:${g.key}`)} strategy={verticalListSortingStrategy}>
            <div className='space-y-3'>
              {orderedGroups.map(g => (
                <SortableGroupCard
                  key={g.id}
                  group={g}
                  fieldNames={localFieldOrder[g.key] ?? []}
                  allFields={allFields}
                  getColSpan={getColSpan}
                  onColSpan={(f, span) => patchField(f, { col_span: span })}
                  onToggleType={() => patchTypeMut.mutate({ id: g.id, type: g.type === 'tab' ? 'section' : 'tab' })}
                  onDelete={() => { if (confirm(`Delete "${g.label}"? Fields will be unassigned.`)) deleteMut.mutate(g.id) }}
                  onRename={(label) => renameMut.mutate({ id: g.id, label })}
                  onIconChange={(icon) => iconMut.mutate({ id: g.id, icon })}
                  getRelKind={relKind}
                  getFriendlyType={friendlyType}
                  getFieldSettings={getFieldSettings}
                  onFieldSettings={handleFieldSettings}
                />
              ))}
              {orderedGroups.length === 0 && !adding && (
                <div className='rounded-lg border border-dashed border-slate-200 py-8 text-center text-[12px] text-slate-400'>
                  No groups yet. Add a group to organize form fields.
                </div>
              )}
            </div>
          </SortableContext>
        )}

        {/* Add group form */}
        {adding && (
          <div className='rounded-lg border border-slate-200 bg-white p-4 space-y-3'>
            <p className='text-[12px] font-medium text-slate-700'>New Group</p>
            <div className='grid grid-cols-3 gap-3'>
              <div>
                <Label className='mb-1 block text-[11px]'>Key (slug)</Label>
                <Input value={newKey} onChange={e => setNewKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} placeholder='details' className='h-7 font-mono text-[12px]' />
              </div>
              <div>
                <Label className='mb-1 block text-[11px]'>Label</Label>
                <Input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder='Details' className='h-7 text-[12px]' />
              </div>
              <div>
                <Label className='mb-1 block text-[11px]'>Type</Label>
                <Sel value={newType} onChange={v => setNewType(v as 'section' | 'tab')} options={[{ value: 'section', label: 'Section' }, { value: 'tab', label: 'Tab' }]} />
              </div>
            </div>
            <div className='flex justify-end gap-2'>
              <Button type='button' variant='outline' size='sm' className='h-7 text-[12px]' onClick={() => setAdding(false)}>Cancel</Button>
              <Button type='button' size='sm' className='h-7 bg-nvr-cyan text-[12px] text-white' disabled={!newKey.trim() || !newLabel.trim() || createMut.isPending}
                onClick={() => createMut.mutate({ collection: tableName, key: newKey.trim(), label: newLabel.trim(), type: newType })}>
                Create
              </Button>
            </div>
          </div>
        )}
        </div>{/* end main area */}
      </div>{/* end flex row */}

      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease' }}>
        {activeFieldId && (
          <FieldChip
            fieldName={activeFieldId}
            fieldType={activeFieldData?.type}
            colSpan={getColSpan(activeFieldId)}
            isDragging
          />
        )}
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

type Tab = 'fields' | 'relations' | 'attributes' | 'groups' | 'behavior' | 'content' | 'settings'

export function TableEditorPage() {
  const { table } = useParams<{ table: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('fields')
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
                {!isSystem && (tableData.registered ? (
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
          {(
            (isSystem
              ? ['fields', 'relations'] as const
              : ['fields', 'relations', 'groups', 'behavior', 'content', 'attributes', 'settings'] as const)
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
            {tab === 'groups' && <LayoutsTab tableName={table ?? ''} dbColumns={tableData?.columns ?? []} />}
            {tab === 'behavior' && <BehaviorTab tableName={table ?? ''} tableData={tableData} />}
            {tab === 'content' && (
              <ContentTab
                tableName={table ?? ''}
                tableData={tableData}
                onRefresh={() => refetch()}
              />
            )}
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
