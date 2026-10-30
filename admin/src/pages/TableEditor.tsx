import {
  Combobox,
  DataGuideCard,
  IconPicker,
  LayoutEditor,
  LayoutOverview,
  TipLayer
} from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Eye,
  EyeOff,
  Key,
  Languages,
  Lock,
  Pencil,
  Plus,
  Rows3,
  Settings2,
  Trash2,
  X
} from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { HelpTextDraftsSection } from '@/components/ai-help-text-drafts'
import { BulkActionsPicker, BulkActionsSection } from '@/components/bulk-actions-section'
import { DisplayTemplateEditor } from '@/components/display-template-editor'
import { FormulaBuilder, RawFormulaEditor } from '@/components/formula-builder'
import { LabelSearchFieldsSetting } from '@/components/label-search-fields-setting'
import { PagePresence } from '@/components/page-presence'
import { type QuickFilterDef, QuickFiltersEditor } from '@/components/quick-filters-editor'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { usePersistedTab } from '@/hooks/usePersistedTab'
import { api } from '@/lib/api'
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
  type InterfaceOption,
  type LabelChoice,
  parseJson,
  SLIDER_INTERFACES
} from '@/lib/field-config'
import { AdminLayoutEditorHost } from '@/lib/layout-editor-host'
import { useGoBack } from '@/lib/nav'
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
import { cn, formatRelative, titleCase } from '@/lib/utils'
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

// ─── Field interface pack (#663 / #520 / #518) ────────────────────────────────
// Extra interfaces offered on top of the base lib/field-config lists — kept
// LOCAL to TableEditor (field-config.ts stays untouched); the shared
// FieldRenderer dispatches every one of these.

const EXTRA_INTERFACES_BY_TYPE: Record<string, InterfaceOption[]> = {
  string: [
    { value: 'checklist', label: 'Checklist (todo list)' },
    { value: 'phone', label: 'Phone number' },
    { value: 'email', label: 'Email address' },
    { value: 'address-autocomplete', label: 'Address (autocomplete)' }
  ],
  text: [
    { value: 'phone', label: 'Phone number' },
    { value: 'email', label: 'Email address' },
    { value: 'address-autocomplete', label: 'Address (autocomplete)' }
  ],
  integer: [{ value: 'progress', label: 'Progress (0–100 %)' }]
}

function ifaceOptions(type: string): InterfaceOption[] {
  const base = getInterfaces(type)
  const extras = (EXTRA_INTERFACES_BY_TYPE[type] ?? []).filter(
    (e) => !base.some((b) => b.value === e.value)
  )
  return extras.length > 0 ? [...base, ...extras] : base
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

// ─── Report-widget slot config ────────────────────────────────────────────────

// ─── O2MAggFieldCombobox ──────────────────────────────────────────────────────

// ─── Rollup computed config ────────────────────────────────────────────────────

type RollupAggregate =
  | 'sum'
  | 'count'
  | 'avg'
  | 'min'
  | 'max'
  | 'median'
  | 'distinct_count'
  | 'weighted_avg'

interface RollupSourceConfig {
  related_collection: string
  fk_field: string
  aggregate: RollupAggregate
  value_field: string
  /** weighted_avg only: the per-row weight column. */
  weight_field?: string
  recursive?: boolean
}

interface RollupConfig {
  sources: RollupSourceConfig[]
  /** Optional parent-row condition as JSON text — rows that don't match keep
   *  a plain, hand-entered value (see api rollups.ts NormalizedRollup). */
  parent_filter?: string
}

const ROLLUP_AGGREGATE_OPTIONS: { value: RollupAggregate; label: string }[] = [
  { value: 'sum', label: 'sum' },
  { value: 'count', label: 'count' },
  { value: 'avg', label: 'avg' },
  { value: 'min', label: 'min' },
  { value: 'max', label: 'max' },
  { value: 'median', label: 'median' },
  { value: 'distinct_count', label: 'distinct count' },
  { value: 'weighted_avg', label: 'weighted avg' }
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
    const pf = parsed?.parent_filter
    const parent_filter =
      pf && typeof pf === 'object' && !Array.isArray(pf) && Object.keys(pf).length > 0
        ? JSON.stringify(pf)
        : undefined
    return {
      sources: sources.length ? sources : [{ ...EMPTY_ROLLUP_SOURCE }],
      ...(parent_filter ? { parent_filter } : {})
    }
  } catch {
    return emptyRollup()
  }
}

// Serializes back to the legacy single-source object when there's exactly one
// source (round-trip safe with older formulas), else `{ sources: [...] }`.
function serializeRollup(cfg: RollupConfig): string {
  let parentFilter: Record<string, unknown> | undefined
  if (cfg.parent_filter?.trim()) {
    try {
      const parsed = JSON.parse(cfg.parent_filter)
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).length
      )
        parentFilter = parsed
    } catch {
      /* invalid JSON is dropped — isRollupValid blocks the save first */
    }
  }
  if (parentFilter) return JSON.stringify({ sources: cfg.sources, parent_filter: parentFilter })
  if (cfg.sources.length === 1) return JSON.stringify(cfg.sources[0])
  return JSON.stringify({ sources: cfg.sources })
}

function isParentFilterValid(text: string | undefined): boolean {
  if (!text?.trim()) return true
  try {
    const parsed = JSON.parse(text)
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function isRollupSourceValid(cfg: RollupSourceConfig): boolean {
  if (!cfg.related_collection || !cfg.fk_field) return false
  if (cfg.aggregate !== 'count' && !cfg.value_field) return false
  return true
}

function isRollupValid(cfg: RollupConfig): boolean {
  return (
    cfg.sources.length > 0 &&
    cfg.sources.every(isRollupSourceValid) &&
    isParentFilterValid(cfg.parent_filter)
  )
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

        {source.aggregate === 'weighted_avg' && (
          <div className='space-y-1'>
            <Label className='text-[11px] text-slate-500'>Weight field</Label>
            <Combobox
              value={source.weight_field ?? ''}
              onChange={(v) => onChange({ ...source, weight_field: v })}
              options={fieldOptions}
              placeholder='e.g. quantity'
              disabled={!source.related_collection}
            />
          </div>
        )}
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
    onChange({ ...config, sources: config.sources.map((s, idx) => (idx === i ? next : s)) })
  }
  const addSource = () => {
    onChange({ ...config, sources: [...config.sources, { ...EMPTY_ROLLUP_SOURCE }] })
  }
  const removeSource = (i: number) => {
    onChange({ ...config, sources: config.sources.filter((_, idx) => idx !== i) })
  }

  return (
    <div className='space-y-3'>
      <p className='text-[11px] text-slate-400'>
        Aggregate values from related items in one or more collections — each source's aggregate is
        summed together.
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

      <div className='space-y-1'>
        <Label className='text-[11px] font-medium text-slate-600'>
          Only roll up for records matching (JSON, optional)
        </Label>
        <Textarea
          value={config.parent_filter ?? ''}
          onChange={(e) => onChange({ ...config, parent_filter: e.target.value })}
          placeholder='{"workflow_type": {"_neq": 2}}'
          className={cn(
            'min-h-[56px] font-mono text-[11.5px]',
            !isParentFilterValid(config.parent_filter) && 'border-red-400'
          )}
          spellCheck={false}
        />
        <p className='text-[11px] text-slate-400'>
          Records that don't match are never recalculated — the column keeps whatever was typed in.
          Same operators as a source filter (_eq, _neq, _in, _gt…).
        </p>
      </div>

      <div className='flex items-center justify-between rounded-md border border-slate-200 bg-white p-3'>
        <div>
          <p className='text-[11px] font-medium text-slate-600'>
            Store value (recalculate on writes)
          </p>
          <p className='text-[11px] text-slate-400'>
            Off: computed fresh on every read. On: cached in the DB column and recalculated whenever
            a contributing row changes.
          </p>
        </div>
        <Switch checked={computedStore} onCheckedChange={onComputedStoreChange} />
      </div>
    </div>
  )
}

// ─── Lookup fields (#349): write-time copy from an M2O target ────────────────

interface LookupConfig {
  fk_field: string
  source_field: string
}

function parseLookup(formula: string | null | undefined): LookupConfig {
  try {
    const cfg = JSON.parse(formula ?? '') as LookupConfig
    return { fk_field: cfg.fk_field ?? '', source_field: cfg.source_field ?? '' }
  } catch {
    return { fk_field: '', source_field: '' }
  }
}

function LookupConfigEditor({
  collection,
  config,
  onChange
}: {
  collection: string
  config: LookupConfig
  onChange: (next: LookupConfig) => void
}) {
  const { data: rels } = useQuery({
    queryKey: ['relations-for', collection],
    queryFn: () => api.get(`/data-model/relations/for/${collection}`).then((r) => r.data.data),
    enabled: !!collection
  })
  const m2o = (
    (rels ?? []) as Array<{
      many_collection: string
      many_field: string
      one_collection: string | null
      junction_field: string | null
    }>
  ).filter((r) => r.many_collection === collection && r.one_collection && !r.junction_field)
  const target = m2o.find((r) => r.many_field === config.fk_field)?.one_collection ?? null
  const { data: targetMeta } = useQuery({
    queryKey: ['collection-meta', target],
    queryFn: () => api.get(`/collections/${target}`).then((r) => r.data.data),
    enabled: !!target
  })
  const targetFields = ((targetMeta?.fields ?? []) as Array<{ field: string; hidden?: boolean }>)
    .filter((f) => !f.hidden && f.field !== 'id')
    .map((f) => ({ value: f.field, label: f.field }))
  return (
    <div className='space-y-2'>
      <p className='text-[11px] text-slate-400'>
        When the relation below is set or changed, the target record's field is copied into this
        column — a snapshot at link time (price-at-order semantics), not a live reference. Clearing
        the relation clears the copy.
      </p>
      <div className='grid grid-cols-2 gap-2'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Relation (M2O field)</Label>
          <Combobox
            value={config.fk_field}
            onChange={(v) => onChange({ fk_field: v, source_field: '' })}
            options={m2o.map((r) => ({
              value: r.many_field,
              label: `${r.many_field} → ${r.one_collection}`
            }))}
            placeholder='Select relation…'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Copy this field</Label>
          <Combobox
            value={config.source_field}
            onChange={(v) => onChange({ ...config, source_field: v })}
            options={targetFields}
            placeholder={target ? 'Select field…' : 'Pick a relation first'}
            disabled={!target}
          />
        </div>
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
    const ifaces = ifaceOptions(t)
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

  const addInterfaces = ifaceOptions(form.type)

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
              computed_store:
                computedType === 'write' || computedType === 'rollup' ? computedStore : false
            }
          : {})
      })
      if (isStoredRollup && computedReady) {
        // Fire-and-forget backfill — the column starts NULL/0 otherwise until
        // the next write to a contributing row triggers a recalc.
        api.post(`/data-model/${table}/fields/${form.name}/rollup-recalc`).catch(() => {
          toast.error(
            `"${form.name}" was added, but backfilling existing rows failed — recalc it manually`
          )
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
                    <RawFormulaEditor
                      collection={table}
                      value={computedFormula}
                      onChange={setComputedFormula}
                      placeholder={
                        computedType === 'read'
                          ? 'e.g. item.price * 1.2'
                          : 'e.g. concat(item.first_name, " ", item.last_name)'
                      }
                      serverEvaluated={computedType === 'write'}
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

  // Field filter (#228): search over the column list — 100-column tables
  // made "where is vendor" a scroll hunt. ?field=<name> (config search's deep
  // link, search item 24) opens the tab filtered to that field.
  const [fieldFilter, setFieldFilter] = useState(
    () => new URLSearchParams(window.location.search).get('field') ?? ''
  )
  const columns = fieldFilter.trim()
    ? tableData.columns.filter((c) => {
        const q = fieldFilter.trim().toLowerCase()
        return c.name.toLowerCase().includes(q) || (c.data_type ?? '').toLowerCase().includes(q)
      })
    : tableData.columns

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
            <input
              value={fieldFilter}
              onChange={(e) => setFieldFilter(e.target.value)}
              placeholder='Find a field… (name, label, or type)'
              className='mt-2 h-8 w-72 rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] outline-none focus:border-[#00ceff80]'
            />
            <p className='hidden'>{''}</p>
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
            onDrop={async () => {
              // Impact scan first: a field is referenced by layouts, formulas,
              // rules, queues, owner filters, reports — and none of those fail
              // loudly when the column vanishes. The confirm names what breaks.
              let impactNote = ''
              try {
                const res = await api.get<{
                  data: {
                    total: number
                    surfaces: Array<{
                      surface: string
                      hits: Array<{ ref: string; detail?: string }>
                    }>
                  }
                }>(`/schema/impact/${tableName}/${col.name}`)
                const impact = res.data.data
                // Integrations that named the field in the request log (#608)
                // are callers, not configuration — listed apart, with detail.
                const callers = impact.surfaces.find((sf) => sf.surface === 'api-callers')
                const config = impact.surfaces.filter((sf) => sf.surface !== 'api-callers')
                const configTotal = config.reduce((n, sf) => n + sf.hits.length, 0)
                if (callers && callers.hits.length > 0) {
                  impactNote += `\n\n⚠ ${callers.hits.length} API caller(s) used this field in the last 14 days:\n${callers.hits
                    .slice(0, 8)
                    .map((h) => `  • ${h.ref}${h.detail ? ` (${h.detail})` : ''}`)
                    .join(
                      '\n'
                    )}${callers.hits.length > 8 ? `\n  +${callers.hits.length - 8} more` : ''}\n`
                }
                if (configTotal > 0) {
                  const lines = config
                    .map(
                      (sf) =>
                        `  • ${sf.surface}: ${sf.hits
                          .slice(0, 3)
                          .map((h) => h.ref)
                          .join(', ')}${sf.hits.length > 3 ? ` +${sf.hits.length - 3} more` : ''}`
                    )
                    .join('\n')
                  impactNote += `\n\n⚠ ${configTotal} configuration reference(s) will break:\n${lines}\n`
                }
              } catch {
                impactNote = '\n\n(Impact scan unavailable — references were not checked.)'
              }
              if (confirm(`Drop column "${col.name}"? This cannot be undone.${impactNote}`)) {
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
  const [renaming, setRenaming] = useState(false)
  const [renameTo, setRenameTo] = useState('')
  const qc = useQueryClient()

  const renameField = useMutation({
    mutationFn: (newName: string) =>
      api
        .post<{
          data: { remaining_references?: { total?: number } | null }
        }>(`/data-model/collections/${tableName}/fields/${col.name}/rename`, {
          new_name: newName
        })
        .then((r) => r.data.data),
    onSuccess: (d) => {
      const left = d.remaining_references?.total ?? 0
      toast.success(
        left > 0
          ? `Renamed — column, relations and layouts updated. ${left} other config reference(s) still use the old name (see field impact).`
          : 'Renamed — column, relations and layouts updated'
      )
      setRenaming(false)
      qc.invalidateQueries({ queryKey: ['data-model-table', tableName] })
      onRefresh()
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Rename failed')
  })

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
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to save field metadata'
      toast.error(msg)
    }
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

        {renaming && (
          <div className='ml-auto flex items-center gap-1.5'>
            <input
              value={renameTo}
              onChange={(e) => setRenameTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renameTo && renameTo !== col.name)
                  renameField.mutate(renameTo)
                if (e.key === 'Escape') setRenaming(false)
              }}
              // biome-ignore lint/a11y/noAutofocus: the strip only exists after an explicit click
              autoFocus
              spellCheck={false}
              className='h-6 w-44 rounded border border-slate-300 px-1.5 font-mono text-[12px] dark:border-border'
            />
            <button
              type='button'
              disabled={renameField.isPending || !renameTo || renameTo === col.name}
              onClick={() => renameField.mutate(renameTo)}
              className='h-6 rounded bg-nvr-cyan px-2 text-[11px] font-semibold text-white disabled:opacity-40'
            >
              {renameField.isPending ? '…' : 'Rename'}
            </button>
            <button
              type='button'
              onClick={() => setRenaming(false)}
              className='h-6 rounded border border-slate-200 px-2 text-[11px] text-slate-500 dark:border-border'
            >
              Cancel
            </button>
          </div>
        )}
        {!renaming && null}
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

            {!col.is_primary_key && !col.is_virtual && !isSystem && (
              <button
                type='button'
                onClick={() => {
                  setRenameTo(col.name)
                  setRenaming(true)
                }}
                className='rounded p-1 text-slate-400 hover:text-slate-700'
                title='Rename column — carries the column, relations and layout assignments along, then reports any config still using the old name'
              >
                <Pencil className='h-3.5 w-3.5' />
              </button>
            )}
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
  // Interface pack options (#663 / #518)
  const [ratingMax, setRatingMax] = useState<number | ''>(
    () => parseJson<{ rating_max?: number }>(fm?.options)?.rating_max ?? ''
  )
  const [addrLatField, setAddrLatField] = useState(
    () =>
      parseJson<{ address_latlng_fields?: { lat?: string } }>(fm?.options)?.address_latlng_fields
        ?.lat ?? ''
  )
  const [addrLngField, setAddrLngField] = useState(
    () =>
      parseJson<{ address_latlng_fields?: { lng?: string } }>(fm?.options)?.address_latlng_fields
        ?.lng ?? ''
  )

  // Computed formula state
  const [computedEnabled, setComputedEnabled] = useState(() => !!fm?.computed_formula)
  const [computedType, setComputedType] = useState<'read' | 'write' | 'rollup' | 'lookup'>(() =>
    fm?.computed_type === 'write'
      ? 'write'
      : fm?.computed_type === 'rollup'
        ? 'rollup'
        : fm?.computed_type === 'lookup'
          ? 'lookup'
          : 'read'
  )
  const [lookup, setLookup] = useState<LookupConfig>(() =>
    fm?.computed_type === 'lookup'
      ? parseLookup(fm?.computed_formula)
      : { fk_field: '', source_field: '' }
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

  // Auto ID (generated ID pattern) state
  const [autoIdPattern, setAutoIdPattern] = useState(
    () => parseJson<{ auto_id?: { pattern?: string } }>(fm?.options)?.auto_id?.pattern ?? ''
  )
  const [autoIdPadding, setAutoIdPadding] = useState(
    () => parseJson<{ auto_id?: { padding?: number } }>(fm?.options)?.auto_id?.padding ?? 0
  )
  // Conditional patterns: [{when: {field, op?, value?}, pattern}] — first match wins.
  const [autoIdVariants, setAutoIdVariants] = useState(() => {
    const v = parseJson<{ auto_id?: { variants?: unknown[] } }>(fm?.options)?.auto_id?.variants
    return Array.isArray(v) && v.length ? JSON.stringify(v, null, 2) : ''
  })
  const autoIdVariantsValid = (() => {
    if (!autoIdVariants.trim()) return true
    try {
      const v = JSON.parse(autoIdVariants)
      return (
        Array.isArray(v) &&
        v.every((x) => x && typeof x.pattern === 'string' && typeof x?.when?.field === 'string')
      )
    } catch {
      return false
    }
  })()
  const [autoIdSeed, setAutoIdSeed] = useState<number | null>(null)

  const { data: seedInfo } = useQuery({
    queryKey: ['auto-id-seed', tableName, col.name],
    enabled: !!autoIdPattern,
    queryFn: () =>
      api
        .get<{ current: number | null; suggested: number }>(
          `/data-model/${tableName}/fields/${col.name}/auto-id-seed`
        )
        .then((r) => r.data)
  })

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
    const ifaces = ifaceOptions(t)
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
    if (fieldInterface === 'rating' && ratingMax !== '' && Number(ratingMax) >= 2) {
      extra.rating_max = Math.min(10, Number(ratingMax))
    }
    if (fieldInterface === 'address-autocomplete') {
      const map: Record<string, string> = {}
      if (addrLatField.trim()) map.lat = addrLatField.trim()
      if (addrLngField.trim()) map.lng = addrLngField.trim()
      if (Object.keys(map).length > 0) extra.address_latlng_fields = map
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

  // Merge (or remove) the auto_id key on top of whatever buildOptions() produced,
  // without disturbing the interface-specific options it already builds.
  function withAutoId(base: string | null): string | null {
    const raw = base ? (JSON.parse(base) as unknown) : {}
    // Choice interfaces serialize options as a bare choices ARRAY — auto_id has no
    // home there (stringify silently drops non-index props). Leave those untouched.
    if (Array.isArray(raw)) return base
    const parsed = raw as Record<string, unknown>
    if (autoIdPattern) {
      let variants: unknown[] | undefined
      if (autoIdVariants.trim() && autoIdVariantsValid) {
        try {
          variants = JSON.parse(autoIdVariants)
        } catch {
          variants = undefined
        }
      }
      parsed.auto_id = {
        pattern: autoIdPattern,
        ...(autoIdPadding ? { padding: autoIdPadding } : {}),
        ...(variants?.length ? { variants } : {})
      }
    } else {
      delete parsed.auto_id
    }
    return Object.keys(parsed).length ? JSON.stringify(parsed) : null
  }

  // Build the computed_* payload depending on the selected compute type.
  // Rollup serializes its config to JSON; read/write use the raw formula.
  const computedReady = computedType === 'rollup' ? isRollupValid(rollup) : !!computedFormula.trim()
  const computedPayload =
    computedEnabled && computedReady
      ? {
          computed_formula:
            computedType === 'rollup'
              ? serializeRollup(rollup)
              : computedType === 'lookup'
                ? JSON.stringify(lookup)
                : computedFormula.trim(),
          computed_type: computedType,
          computed_store:
            computedType === 'write' || computedType === 'rollup'
              ? computedStore
              : computedType === 'lookup'
        }
      : { computed_formula: null, computed_type: null, computed_store: false }

  // col.is_virtual is the DB's own truth about whether a physical column
  // exists yet (see data-model.ts: only computed fields with no matching
  // dbColumnNames entry are marked virtual) — toggling store on for a rollup
  // that's still virtual means we must provision the column before saving
  // metadata, or every recalc write silently fails against a nonexistent column.
  const isStoredRollup =
    computedEnabled && computedReady && computedType === 'rollup' && computedStore
  const needsColumnProvisioning = isStoredRollup && col.is_virtual
  const columnType = isStoredRollup
    ? rollupColumnType(fieldType)
    : (fieldType as CreateColumnBody['type'])

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
        options: withAutoId(buildOptions()),
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

    if (autoIdPattern && autoIdSeed != null && autoIdSeed !== seedInfo?.current) {
      try {
        await api.put(`/data-model/${tableName}/fields/${col.name}/auto-id-seed`, {
          next_val: autoIdSeed
        })
      } catch {
        toast.error(`"${col.name}" saved, but updating the next-ID seed failed`)
      }
    }

    if (isStoredRollup) {
      // Fire-and-forget backfill — the column starts NULL/0 otherwise until the
      // next write to a contributing row triggers a recalc. Only reachable once
      // the metadata save above actually succeeded, so nivaro_fields is current.
      api.post(`/data-model/${tableName}/fields/${col.name}/rollup-recalc`).catch(() => {
        toast.error(
          `"${col.name}" saved, but backfilling existing rows failed — recalc it manually`
        )
      })
    }
  }

  const interfaces = ifaceOptions(fieldType)
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
              Use Settings → Convert column type to alter the DB column.
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

      {fieldInterface === 'rating' && (
        <div className='mt-3 rounded-md border border-slate-200 bg-white p-3'>
          <Label className='mb-1 block text-[11px]'>Max stars (2–10, default 5)</Label>
          <Input
            type='number'
            min={2}
            max={10}
            value={ratingMax}
            onChange={(e) => setRatingMax(e.target.value ? Number(e.target.value) : '')}
            className='h-7 w-24 text-[12px]'
            placeholder='5'
          />
        </div>
      )}

      {fieldInterface === 'address-autocomplete' && (
        <div className='mt-3 rounded-md border border-slate-200 bg-white p-3'>
          <Label className='mb-1 block text-[11px]'>Coordinate fields (optional)</Label>
          <p className='mb-2 text-[11px] text-slate-400'>
            Picking a suggestion also writes its latitude/longitude onto these sibling columns.
          </p>
          <div className='grid grid-cols-2 gap-3'>
            <div>
              <Label className='mb-1 block text-[10.5px] text-slate-500'>Latitude field</Label>
              <Input
                value={addrLatField}
                onChange={(e) => setAddrLatField(e.target.value)}
                className='h-7 font-mono text-[12px]'
                placeholder='latitude'
              />
            </div>
            <div>
              <Label className='mb-1 block text-[10.5px] text-slate-500'>Longitude field</Label>
              <Input
                value={addrLngField}
                onChange={(e) => setAddrLngField(e.target.value)}
                className='h-7 font-mono text-[12px]'
                placeholder='longitude'
              />
            </div>
          </div>
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
              <label className='flex cursor-pointer items-center gap-1.5'>
                <input
                  type='radio'
                  name={`computed-type-${col.name}`}
                  value='lookup'
                  checked={computedType === 'lookup'}
                  onChange={() => setComputedType('lookup')}
                />
                Lookup (copy from relation)
              </label>
            </div>

            {computedType === 'lookup' ? (
              <LookupConfigEditor collection={tableName} config={lookup} onChange={setLookup} />
            ) : computedType === 'rollup' ? (
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
                    <RawFormulaEditor
                      collection={tableName}
                      value={computedFormula}
                      onChange={setComputedFormula}
                      placeholder={
                        computedType === 'read'
                          ? 'e.g. item.price * 1.2'
                          : 'e.g. concat(item.first_name, " ", item.last_name)'
                      }
                      serverEvaluated={computedType === 'write'}
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

      {/* ── Auto ID ── (hidden for choice interfaces: their options are a bare array) */}
      {!CHOICE_INTERFACES.has(fieldInterface) && (
        <div className='mt-3 rounded-md border border-slate-200 bg-white p-3'>
          <p className='mb-2 text-[11px] font-medium text-slate-600'>Auto ID</p>
          <div className='space-y-2'>
            <div>
              <Label className='mb-1 block text-[11px]'>Pattern</Label>
              <Input
                value={autoIdPattern}
                onChange={(e) => setAutoIdPattern(e.target.value)}
                placeholder='{project.project_type.short_code}{funding_years[0] % 100}-{seq}'
                className='h-7 text-[12px] font-mono'
              />
            </div>
            {autoIdPattern && (
              <button
                type='button'
                onClick={() => {
                  void api
                    .post(`/data-model/${tableName}/fields/${col.name}/auto-id-backfill`, {})
                    .then((r) => {
                      const d = r.data.data as { filled: number; scanned: number; more: boolean }
                      toast.success(
                        `${d.filled} of ${d.scanned} empty row(s) filled${d.more ? ' — run again for more' : ''}`
                      )
                    })
                    .catch((e) => toast.error(e?.response?.data?.error ?? 'Backfill failed'))
                }}
                data-tip='Auto-ID backfill (#378): generate ids for pre-pattern rows where this field is empty — sequence-safe'
                className='rounded-md border border-dashed border-slate-300 px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-50'
              >
                Backfill empty rows…
              </button>
            )}
            {autoIdPattern && (
              <div>
                <Label className='mb-1 block text-[11px]'>Pattern variants (JSON, optional)</Label>
                <Textarea
                  value={autoIdVariants}
                  onChange={(e) => setAutoIdVariants(e.target.value)}
                  placeholder={
                    '[{"when": {"field": "workflow_type", "op": "eq", "value": "2"},\n  "pattern": "{regions[0].short_code}{funding_years[0] % 100}{project_type.short_code} {description}"}]'
                  }
                  className={cn(
                    'min-h-[72px] font-mono text-[11px]',
                    !autoIdVariantsValid && 'border-red-400'
                  )}
                  spellCheck={false}
                />
                <p className='mt-1 text-[11px] text-slate-400'>
                  First variant whose condition matches the record wins; otherwise the pattern
                  above. Ops: eq (default), neq, in, null, nnull.
                </p>
              </div>
            )}
            {autoIdPattern && (
              <div className='grid grid-cols-2 gap-3'>
                <div>
                  <Label className='mb-1 block text-[11px]'>Padding</Label>
                  <Input
                    type='number'
                    min={0}
                    value={autoIdPadding}
                    onChange={(e) => setAutoIdPadding(Math.max(0, Number(e.target.value) || 0))}
                    className='h-7 text-[12px]'
                  />
                </div>
                <div>
                  <Label className='mb-1 block text-[11px]'>
                    Next number
                    {seedInfo && (
                      <span className='ml-1 font-normal text-slate-400'>
                        (current: {seedInfo.current ?? '—'}, suggested: {seedInfo.suggested})
                      </span>
                    )}
                  </Label>
                  <Input
                    type='number'
                    min={1}
                    value={autoIdSeed ?? seedInfo?.current ?? seedInfo?.suggested ?? 1}
                    onChange={(e) => setAutoIdSeed(Math.max(1, Number(e.target.value) || 1))}
                    className='h-7 text-[12px]'
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

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
  const [quickBuilder, setQuickBuilder] = useState<'users' | 'm2a' | null>(null)

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

        {/* Quick builders: multi-user field (#243) + M2A (#242) */}
        <div className='flex flex-wrap gap-2'>
          <button
            type='button'
            onClick={() => setQuickBuilder('users')}
            className='rounded-md border border-dashed border-slate-300 px-2.5 py-1 text-[12px] text-slate-500 hover:bg-slate-50 dark:border-border'
          >
            ＋ Multi-user field…
          </button>
          <button
            type='button'
            onClick={() => setQuickBuilder('m2a')}
            className='rounded-md border border-dashed border-slate-300 px-2.5 py-1 text-[12px] text-slate-500 hover:bg-slate-50 dark:border-border'
          >
            ＋ Polymorphic (M2A) relation…
          </button>
        </div>
        {quickBuilder && (
          <QuickRelationBuilder
            kind={quickBuilder}
            table={tableName}
            tables={allTables.map((t) => t.name)}
            onClose={() => setQuickBuilder(null)}
            onCreated={() => {
              setQuickBuilder(null)
              invalidate()
            }}
          />
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
                          <RelationUsageChip relId={rel.id} />
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

// ─── Relation usage (#357): rows actually using it, on demand ────────────────

function RelationUsageChip({ relId }: { relId: number }) {
  const [wanted, setWanted] = useState(false)
  const { data, isLoading } = useQuery<{ used: number; total: number }>({
    queryKey: ['relation-usage', relId],
    queryFn: () =>
      api
        .get<{ data: { used: number; total: number } }>(`/data-model/relations/${relId}/usage`)
        .then((r) => r.data.data),
    enabled: wanted,
    staleTime: 5 * 60_000
  })
  if (!wanted) {
    return (
      <button
        type='button'
        onClick={() => setWanted(true)}
        title='Count rows actually using this relation'
        className='rounded border border-slate-200 px-1.5 py-0.5 text-[10.5px] text-slate-400 hover:text-slate-600'
      >
        usage?
      </button>
    )
  }
  if (isLoading) return <span className='text-[10.5px] text-slate-400'>counting…</span>
  if (!data) return <span className='text-[10.5px] text-slate-400'>n/a</span>
  const pct = data.total > 0 ? Math.round((data.used / data.total) * 100) : 0
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums',
        data.used === 0 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'
      )}
      title={`${data.used.toLocaleString()} of ${data.total.toLocaleString()} rows carry a value`}
    >
      {data.used === 0 ? 'unused' : `${pct}%`}
    </span>
  )
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

// ─── Display template chip editor ────────────────────────────────────────────

function SettingsTab({
  tableData,
  tableName,
  onRefresh,
  onGoToLayouts
}: {
  tableData: DBTableDetail
  tableName: string
  onRefresh: () => void
  /** Switches the editor to the Layouts tab (the Form UX card links there). */
  onGoToLayouts?: () => void
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
      <BrowserSettingsSection tableName={tableName} />
      <EmptyStateSlugSection tableName={tableName} />
      <RenameCollectionSection tableName={tableName} />
      <AuditDepthSection tableName={tableName} />
      <IntegrityBadgeSection tableName={tableName} />
      <FormUxSection tableName={tableName} onGoToLayouts={onGoToLayouts} />
      <DataProtectionSection tableName={tableName} />
      <CastCheckSection tableName={tableName} />
      <GenerateTestDataCard tableName={tableName} />
      <FieldUsageSection tableName={tableName} />
      <EditFrequencySection tableName={tableName} />
      <ChangeReasonSection tableName={tableName} />
      <CustomActionsSection tableName={tableName} />
      <BulkActionsSection tableName={tableName} />
      <DeleteGuardSection tableName={tableName} />
      <SyntheticRecordsSection tableName={tableName} />
      <UpsertKeysSection tableName={tableName} />
      <SnapshotsSection tableName={tableName} />
      <DependencyMapSection tableName={tableName} />
      <UrlAliasSection tableName={tableName} />
      <AiFeaturesCard tableName={tableName} />
      <HelpTextDraftsSection tableName={tableName} />
    </div>
  )
}

// ─── Audit depth (Settings tab) ───────────────────────────────────────────────
// nivaro_collections.accountability: 'all' = activity + revisions (default),
// 'activity' = activity rows only, ''/null-equivalent = neither. Rendered as
// two switches so "turn off revisioning" doesn't silently kill the audit log.

function AuditDepthSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()

  const { data: meta } = useQuery({
    queryKey: ['collection-meta-audit', tableName],
    queryFn: () =>
      api
        .get<{ data: { accountability?: string | null } }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName
  })

  const saveMut = useMutation({
    mutationFn: (accountability: string) =>
      api.patch(`/collections/${tableName}`, { accountability }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection-meta-audit', tableName] })
      toast.success('Audit setting saved')
    },
    onError: () => toast.error('Failed to update audit setting')
  })

  // null/undefined mean "never configured", which the hooks treat as 'all'.
  const level = meta === undefined ? undefined : (meta.accountability ?? 'all') || 'none'
  const activityOn = level === 'all' || level === 'activity'
  const revisionsOn = level === 'all'
  const compose = (activity: boolean, revisions: boolean) =>
    saveMut.mutate(activity ? (revisions ? 'all' : 'activity') : '')

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='flex items-center justify-between px-4 py-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Activity log</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Records who created, changed or deleted each item — the audit trail on the record
            timeline and Activity page.
          </p>
        </div>
        <Switch
          checked={activityOn}
          onCheckedChange={(v) => compose(v, v && revisionsOn)}
          disabled={saveMut.isPending || level === undefined}
        />
      </div>
      <div
        className={`flex items-center justify-between border-t border-slate-100 px-4 py-3 ${activityOn ? '' : 'opacity-50'}`}
      >
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Revision history</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Stores a full snapshot + field-level delta per change — powers the Revisions panel,
            field history and time travel. Needs the activity log.
          </p>
        </div>
        <Switch
          checked={revisionsOn}
          onCheckedChange={(v) => compose(true, v)}
          disabled={saveMut.isPending || level === undefined || !activityOn}
        />
      </div>
      {level === 'none' && (
        <div className='border-t border-slate-100 bg-amber-50 px-4 py-2.5'>
          <p className='text-[11px] text-amber-700'>
            No audit trail — writes to this collection leave no activity or revision records.
            Webhooks and flows still fire.
          </p>
        </div>
      )}
      {level === 'activity' && (
        <div className='border-t border-slate-100 bg-slate-50 px-4 py-2.5'>
          <p className='text-[11px] text-slate-500'>
            Changes are logged without snapshots — the Revisions panel and field history stay empty
            for new writes.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Integrity badge toggle (Settings tab) ────────────────────────────────────

function IntegrityBadgeSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const { data: meta } = useQuery({
    queryKey: ['collection-meta-integrity', tableName],
    queryFn: () =>
      api
        .get<{ data: { integrity_badge?: boolean } }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName
  })
  const saveMut = useMutation({
    mutationFn: (integrity_badge: boolean) =>
      api.patch(`/collections/${tableName}`, { integrity_badge }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection-meta-integrity', tableName] })
      toast.success('Integrity banner setting saved')
    },
    onError: () => toast.error('Failed to update setting')
  })
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='flex items-center justify-between px-4 py-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Data integrity banner</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Shows this collection&rsquo;s latest Data Integrity findings as a banner on the record
            form, so editors fix issues where they live.
          </p>
        </div>
        <Switch
          checked={meta?.integrity_badge !== false}
          onCheckedChange={(v) => saveMut.mutate(v)}
          disabled={saveMut.isPending || meta === undefined}
        />
      </div>
    </div>
  )
}

/** Form UX card: the per-collection record-form switches that are not
 *  per-layout — the Summary-mode toggle (migration 306) and the Summary Mode
 *  rules (migration 310: `summary_mode_rules` — which mode the form OPENS in,
 *  by viewer role and/or the record's pipeline state; first match wins, new
 *  records always Edit). The changes tray is per layout and lives on the
 *  Layouts tab. */
type SummaryConditionDraft = {
  field: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'null' | 'nnull'
  value?: string | number | boolean | null
}
type SummaryModeRuleDraft = {
  roles: string[] | null
  states: string[] | null
  states_op: 'in' | 'not_in'
  conditions: SummaryConditionDraft[] | null
  mode: 'summary' | 'edit'
}
const SUMMARY_CONDITION_OPS: Array<[SummaryConditionDraft['op'], string]> = [
  ['eq', 'is'],
  ['neq', 'is not'],
  ['gt', 'is over'],
  ['gte', 'is at least'],
  ['lt', 'is under'],
  ['lte', 'is at most'],
  ['contains', 'contains'],
  ['null', 'is empty'],
  ['nnull', 'is filled']
]

/** "true"/"false" as booleans, plain numbers as numbers, the rest as typed. */
function conditionValue(raw: string): string | number | boolean {
  const t = raw.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (t !== '' && !Number.isNaN(Number(t)) && !t.startsWith('{{')) return Number(t)
  return raw
}

/** #737 — the record-value half of a Summary Mode rule: ALL must hold. */
function SummaryConditionsEditor({
  conditions,
  fields,
  disabled,
  onChange
}: {
  conditions: SummaryConditionDraft[] | null
  fields: Array<{ field: string; label: string }>
  disabled: boolean
  onChange: (next: SummaryConditionDraft[] | null) => void
}) {
  const list = conditions ?? []
  const [picking, setPicking] = useState<number | 'new' | null>(null)
  const labelOf = (f: string) => fields.find((x) => x.field === f)?.label ?? f
  const set = (i: number, patch: Partial<SummaryConditionDraft>) =>
    onChange(list.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const fieldPicker = (idx: number | 'new', current: string | null) => (
    <Popover open={picking === idx} onOpenChange={(o) => setPicking(o ? idx : null)}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          role='combobox'
          disabled={disabled}
          className='h-6 gap-1 px-2 text-[11.5px] font-normal'
          data-summary-condition-field={current ?? 'new'}
        >
          {current ? (
            labelOf(current)
          ) : (
            <>
              <Plus className='h-3 w-3' /> Add field
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No such field
            </CommandEmpty>
            <CommandGroup>
              {fields.map((f) => (
                <CommandItem
                  key={f.field}
                  value={`${f.label} ${f.field}`}
                  onSelect={() => {
                    setPicking(null)
                    if (idx === 'new') onChange([...list, { field: f.field, op: 'eq', value: '' }])
                    else set(idx, { field: f.field })
                  }}
                  className='text-[12px]'
                >
                  {f.label}
                  <span className='ml-auto font-mono text-[10.5px] text-slate-400'>{f.field}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
  return (
    <div className='flex min-w-0 flex-wrap items-center gap-1.5' data-summary-conditions>
      <span className='text-[11.5px] text-slate-500'>record</span>
      {list.length === 0 && <span className='text-[11.5px] italic text-slate-400'>any record</span>}
      {list.map((c, i) => (
        <span
          key={`${i}-${c.field}`}
          data-summary-condition
          className='inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1 py-0.5'
        >
          {fieldPicker(i, c.field)}
          <Select
            value={c.op}
            onValueChange={(v) => set(i, { op: v as SummaryConditionDraft['op'] })}
            disabled={disabled}
          >
            <SelectTrigger className='h-6 w-[96px] text-[11.5px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUMMARY_CONDITION_OPS.map(([op, label]) => (
                <SelectItem key={op} value={op}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {c.op !== 'null' && c.op !== 'nnull' && (
            <Input
              defaultValue={c.value == null ? '' : String(c.value)}
              key={`${c.field}-${String(c.value)}`}
              disabled={disabled}
              placeholder='value'
              aria-label={`${labelOf(c.field)} value`}
              onBlur={(e) => {
                const v = conditionValue(e.target.value)
                if (v !== c.value) set(i, { value: v })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className='h-6 w-[110px] px-1.5 text-[11.5px]'
            />
          )}
          <button
            type='button'
            aria-label='Remove condition'
            disabled={disabled}
            onClick={() => {
              const next = list.filter((_, j) => j !== i)
              onChange(next.length > 0 ? next : null)
            }}
            className='rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}
      {list.length < 10 && fieldPicker('new', null)}
    </div>
  )
}
type SummaryModeRulesDraft = {
  default: 'summary' | 'edit'
  rules: SummaryModeRuleDraft[]
  /** Server-enforced edit lock (api services/edit-lock.ts) — carried through, not edited here. */
  edit_lock?: unknown
}
const NO_STATE_KEY = '__none__'

function FormUxSection({
  tableName,
  onGoToLayouts
}: {
  tableName: string
  onGoToLayouts?: () => void
}) {
  const qc = useQueryClient()
  const { data: meta } = useQuery({
    queryKey: ['collection-meta-read-mode', tableName],
    queryFn: () =>
      api
        .get<{
          data: {
            read_mode_toggle?: boolean
            summary_mode_rules?: SummaryModeRulesDraft | null
            fields?: Array<{
              field: string
              type?: string | null
              interface?: string | null
              label?: string | null
              hidden?: boolean
            }>
          }
        }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName
  })
  const { data: roles = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['roles-list-form-ux'],
    queryFn: () => api.get('/roles').then((r) => r.data.data ?? []),
    enabled: !!tableName
  })
  const { data: states = [] } = useQuery<Array<{ key: string; label: string; color?: string }>>({
    queryKey: ['collection-states-form-ux', tableName],
    queryFn: () => api.get(`/queues/collection-states/${tableName}`).then((r) => r.data.data ?? []),
    enabled: !!tableName
  })
  const saveMut = useMutation({
    mutationFn: (patch: {
      read_mode_toggle?: boolean
      summary_mode_rules?: SummaryModeRulesDraft
    }) => api.patch(`/collections/${tableName}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection-meta-read-mode', tableName] })
      toast.success('Form UX setting saved')
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg || 'Failed to update setting')
    }
  })
  const cfg: SummaryModeRulesDraft = useMemo(() => {
    const raw = meta?.summary_mode_rules
    return {
      default: raw?.default === 'summary' ? 'summary' : 'edit',
      rules: Array.isArray(raw?.rules)
        ? raw.rules.map((r) => ({
            roles: Array.isArray(r.roles) && r.roles.length > 0 ? r.roles : null,
            states: Array.isArray(r.states) && r.states.length > 0 ? r.states : null,
            states_op: r.states_op === 'not_in' ? 'not_in' : 'in',
            conditions:
              Array.isArray(r.conditions) && r.conditions.length > 0 ? r.conditions : null,
            mode: r.mode === 'summary' ? 'summary' : 'edit'
          }))
        : [],
      ...(raw?.edit_lock ? { edit_lock: raw.edit_lock } : {})
    }
  }, [meta])
  const save = (next: SummaryModeRulesDraft) => saveMut.mutate({ summary_mode_rules: next })
  const updateRule = (i: number, patch: Partial<SummaryModeRuleDraft>) =>
    save({ ...cfg, rules: cfg.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const removeRule = (i: number) => save({ ...cfg, rules: cfg.rules.filter((_, j) => j !== i) })
  const addRule = () =>
    save({
      ...cfg,
      rules: [
        ...cfg.rules,
        {
          roles: null,
          states: null,
          states_op: 'in',
          conditions: null,
          mode: cfg.default === 'summary' ? 'edit' : 'summary'
        }
      ]
    })
  const roleName = (id: string) =>
    roles.find((r) => r.id.toLowerCase() === id.toLowerCase())?.name ?? id
  const stateLabel = (key: string) =>
    key === NO_STATE_KEY ? 'No state yet' : (states.find((s) => s.key === key)?.label ?? key)
  const stateOptions = [{ key: NO_STATE_KEY, label: 'No state yet' }, ...states]
  // Plain columns a rule can judge (#737) — no alias lists, nothing hidden.
  const conditionFields = useMemo(
    () =>
      (meta?.fields ?? [])
        .filter(
          (f) =>
            !f.hidden &&
            f.field !== 'id' &&
            f.type !== 'alias' &&
            !String(f.interface ?? '').startsWith('list-')
        )
        .map((f) => ({ field: f.field, label: f.label || titleCase(f.field) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [meta]
  )
  const busy = saveMut.isPending || meta === undefined
  const toggleOn = meta?.read_mode_toggle === true

  const ModeSeg = ({
    value,
    onChange,
    small
  }: {
    value: 'summary' | 'edit'
    onChange: (v: 'summary' | 'edit') => void
    small?: boolean
  }) => (
    <div
      role='radiogroup'
      className={cn(
        'inline-flex shrink-0 items-center rounded-md border border-slate-300 bg-white p-0.5 font-medium',
        small ? 'h-7 text-[11px]' : 'h-8 text-[11.5px]'
      )}
    >
      {(['summary', 'edit'] as const).map((m) => (
        <button
          key={m}
          type='button'
          role='radio'
          aria-checked={value === m}
          disabled={busy}
          onClick={() => onChange(m)}
          className={cn(
            'inline-flex h-full items-center rounded px-2.5 transition-colors',
            value === m ? 'bg-nvr-cyan text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
          )}
        >
          {m === 'summary' ? 'Summary' : 'Edit'}
        </button>
      ))}
    </div>
  )

  const ChipPicker = ({
    values,
    options,
    labelOf,
    onChange,
    addLabel,
    anyLabel,
    searchPlaceholder
  }: {
    values: string[] | null
    options: Array<{ id: string; name: string }>
    labelOf: (id: string) => string
    onChange: (next: string[] | null) => void
    addLabel: string
    anyLabel: string
    searchPlaceholder: string
  }) => {
    const [open, setOpen] = useState(false)
    const selected = values ?? []
    const selLower = new Set(selected.map((v) => v.toLowerCase()))
    const addable = options.filter((o) => !selLower.has(o.id.toLowerCase()))
    return (
      <div className='flex min-w-0 flex-wrap items-center gap-1'>
        {selected.length === 0 && (
          <span className='text-[11.5px] italic text-slate-400'>{anyLabel}</span>
        )}
        {selected.map((id) => (
          <span
            key={id}
            className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2 pr-1 text-[11.5px] text-slate-700'
          >
            {labelOf(id)}
            <button
              type='button'
              aria-label={`Remove ${labelOf(id)}`}
              disabled={busy}
              onClick={() => {
                const next = selected.filter((v) => v !== id)
                onChange(next.length > 0 ? next : null)
              }}
              className='rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700'
            >
              <X className='h-3 w-3' />
            </button>
          </span>
        ))}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant='outline'
              size='sm'
              role='combobox'
              aria-expanded={open}
              disabled={busy || addable.length === 0}
              className='h-6 gap-1 px-2 text-[11.5px] font-normal'
            >
              <Plus className='h-3 w-3' />
              {addLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent className='w-[240px] p-0' align='start'>
            <Command>
              <CommandInput placeholder={searchPlaceholder} className='h-8 text-[12px]' />
              <CommandList>
                <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                  Nothing to add
                </CommandEmpty>
                <CommandGroup>
                  {addable.map((o) => (
                    <CommandItem
                      key={o.id}
                      value={o.name}
                      onSelect={() => {
                        onChange([...selected, o.id])
                        setOpen(false)
                      }}
                      className='text-[12px]'
                    >
                      {o.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    )
  }

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white' data-form-ux-card>
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[13px] font-medium text-slate-800'>Form UX</p>
        <p className='mt-0.5 text-[12px] text-slate-500'>
          How the record form behaves for reviewers on this collection.
        </p>
      </div>
      <div className='divide-y divide-slate-100'>
        {/* Summary-mode toggle */}
        <div className='flex items-center justify-between px-4 py-3'>
          <div>
            <p className='text-[12.5px] font-medium text-slate-700'>Summary mode</p>
            <p className='mt-0.5 text-[12px] text-slate-500'>
              Show the Summary / Edit switch on the record form. Summary mode is a read-only view of
              the record (notes and tasks stay live). Off by default.
            </p>
          </div>
          <Switch
            checked={toggleOn}
            onCheckedChange={(v) => saveMut.mutate({ read_mode_toggle: v })}
            disabled={busy}
            data-summary-mode-switch
          />
        </div>
        {/* Opening-mode rules */}
        <div className={cn('px-4 py-3', !toggleOn && 'opacity-60')} data-summary-mode-rules>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div>
              <p className='text-[12.5px] font-medium text-slate-700'>Opens in</p>
              <p className='mt-0.5 text-[12px] text-slate-500'>
                Which mode a saved record opens in, by role, pipeline state and the record's own
                values (on hold, an amount over a line). Rules run top to bottom, the first match
                wins, otherwise the default. New records always open in Edit.
              </p>
            </div>
            <div className='flex items-center gap-2'>
              <span className='text-[11.5px] text-slate-500'>Default</span>
              <ModeSeg value={cfg.default} onChange={(v) => save({ ...cfg, default: v })} />
            </div>
          </div>
          {!toggleOn && (
            <p className='mt-2 text-[11.5px] text-amber-700'>
              Rules only apply while the Summary mode switch above is on.
            </p>
          )}
          <div className='mt-3 space-y-2'>
            {cfg.rules.map((r, i) => (
              <div
                key={i}
                data-summary-mode-rule
                className='flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2'
              >
                <span className='text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
                  When
                </span>
                <div className='flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2'>
                  <div className='flex items-center gap-1.5'>
                    <span className='text-[11.5px] text-slate-500'>role</span>
                    <ChipPicker
                      values={r.roles}
                      options={roles}
                      labelOf={roleName}
                      onChange={(next) => updateRule(i, { roles: next })}
                      addLabel='Add role'
                      anyLabel='any role'
                      searchPlaceholder='Search roles…'
                    />
                  </div>
                  <div className='flex items-center gap-1.5'>
                    <span className='text-[11.5px] text-slate-500'>state</span>
                    <Select
                      value={r.states_op}
                      onValueChange={(v) => updateRule(i, { states_op: v as 'in' | 'not_in' })}
                      disabled={busy}
                    >
                      <SelectTrigger className='h-6 w-[76px] text-[11.5px]'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='in'>is</SelectItem>
                        <SelectItem value='not_in'>is not</SelectItem>
                      </SelectContent>
                    </Select>
                    <ChipPicker
                      values={r.states}
                      options={stateOptions.map((s) => ({ id: s.key, name: s.label }))}
                      labelOf={stateLabel}
                      onChange={(next) => updateRule(i, { states: next })}
                      addLabel='Add state'
                      anyLabel='any state'
                      searchPlaceholder='Search states…'
                    />
                  </div>
                  <SummaryConditionsEditor
                    conditions={r.conditions}
                    fields={conditionFields}
                    disabled={busy}
                    onChange={(next) => updateRule(i, { conditions: next })}
                  />
                </div>
                <span className='text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
                  open in
                </span>
                <ModeSeg value={r.mode} onChange={(v) => updateRule(i, { mode: v })} small />
                <button
                  type='button'
                  aria-label='Remove rule'
                  disabled={busy}
                  onClick={() => removeRule(i)}
                  className='rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </div>
            ))}
            {cfg.rules.length === 0 && (
              <p className='text-[11.5px] text-slate-400'>
                No rules — every saved record opens in{' '}
                {cfg.default === 'summary' ? 'Summary' : 'Edit'} mode.
              </p>
            )}
            <Button
              variant='outline'
              size='sm'
              disabled={busy || cfg.rules.length >= 20}
              onClick={addRule}
              className='h-7 gap-1 text-[11.5px]'
              data-summary-mode-add-rule
            >
              <Plus className='h-3 w-3' />
              Add rule
            </Button>
          </div>
          {states.length === 0 && (
            <p className='mt-2 text-[11.5px] text-slate-400'>
              This collection is not bound to a pipeline, so state rules only match "No state yet".
            </p>
          )}
        </div>
        {/* Changes tray pointer */}
        <div className='px-4 py-2.5 text-[12px] text-slate-500'>
          Changes tray is configured per layout →{' '}
          {onGoToLayouts ? (
            <button
              type='button'
              onClick={onGoToLayouts}
              className='font-medium text-nvr-navy hover:underline dark:text-[#00ceff]'
            >
              Layouts tab
            </button>
          ) : (
            <span className='font-medium text-slate-600'>Layouts tab</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Custom action buttons (#39): admin-defined no-code record buttons for this
 *  collection — run a flow, call an external API, or write fields. */
function CustomActionsSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [actionType, setActionType] = useState<'flow' | 'external_api' | 'update_fields'>(
    'update_fields'
  )
  const [configText, setConfigText] = useState('{\n  "set": { "status": "done" }\n}')
  const [guardText, setGuardText] = useState('')
  const [confirmText, setConfirmText] = useState('')

  const { data: actions = [] } = useQuery<
    Array<{ id: number; label: string; action_type: string; is_active: boolean }>
  >({
    queryKey: ['custom-actions-admin', tableName],
    queryFn: () =>
      api.get('/custom-actions', { params: { collection: tableName } }).then((r) => r.data.data),
    enabled: !!tableName
  })
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['custom-actions-admin', tableName] })
    void qc.invalidateQueries({ queryKey: ['custom-actions', tableName] })
  }
  const createMutCA = useMutation({
    mutationFn: () => {
      let config: unknown
      let guard: unknown = null
      try {
        config = JSON.parse(configText)
      } catch {
        throw new Error('Config must be valid JSON')
      }
      if (guardText.trim()) {
        try {
          guard = JSON.parse(guardText)
        } catch {
          throw new Error('Guard must be valid JSON')
        }
      }
      return api.post('/custom-actions', {
        collection: tableName,
        label: label.trim(),
        action_type: actionType,
        config,
        guard,
        confirm_text: confirmText.trim() || null
      })
    },
    onSuccess: () => {
      toast.success('Action created')
      setAdding(false)
      setLabel('')
      invalidate()
    },
    onError: (e: Error & { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? e.message ?? 'Failed to create action')
  })
  const delMutCA = useMutation({
    mutationFn: (id: number) => api.delete(`/custom-actions/${id}`),
    onSuccess: invalidate
  })

  const CONFIG_HINTS: Record<string, string> = {
    update_fields: '{"set": {"field": "value or {{other_field}}"}}',
    flow: '{"flow_id": "<flow uuid>"}',
    external_api:
      '{"api_id": 1, "endpoint_path": "/path/{{id}}", "method": "POST", "body_template": "{\\"id\\": \\"{{id}}\\"}"}'
  }

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='flex items-center justify-between border-b border-slate-100 px-4 py-3'>
        <div>
          <p className='text-[13px] font-semibold text-slate-800'>Custom actions</p>
          <p className='mt-0.5 text-[11.5px] text-slate-500'>
            No-code record buttons — run a flow, call an external API endpoint, or write fields,
            with optional guard conditions and confirm text. Shown in the record header.
          </p>
        </div>
        <Button
          size='sm'
          variant='outline'
          className='h-7 text-[12px]'
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? 'Close' : '+ Add action'}
        </Button>
      </div>
      {adding && (
        <div className='space-y-2 border-b border-slate-100 bg-slate-50/60 px-4 py-3'>
          <div className='flex flex-wrap items-center gap-2'>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder='Button label'
              className='h-7 w-52 text-[12px]'
            />
            <Sel
              value={actionType}
              onChange={(v) => {
                setActionType(v as typeof actionType)
                setConfigText(
                  v === 'flow'
                    ? '{\n  "flow_id": ""\n}'
                    : v === 'external_api'
                      ? '{\n  "api_id": 1,\n  "endpoint_path": "",\n  "method": "POST"\n}'
                      : '{\n  "set": { "status": "done" }\n}'
                )
              }}
              options={[
                { value: 'update_fields', label: 'Write fields' },
                { value: 'flow', label: 'Run a flow' },
                { value: 'external_api', label: 'Call external API' }
              ]}
            />
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder='Confirm text (optional)'
              className='h-7 flex-1 min-w-[200px] text-[12px]'
            />
          </div>
          <div>
            <Label className='mb-1 block text-[11px]'>Config — {CONFIG_HINTS[actionType]}</Label>
            <textarea
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
              rows={4}
              className='w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-[11.5px]'
            />
          </div>
          <div>
            <Label className='mb-1 block text-[11px]'>
              Guard (optional JSON) — [{'{'}"field": "status", "op": "eq", "value": "open"{'}'}]
              hides the button when unmet
            </Label>
            <textarea
              value={guardText}
              onChange={(e) => setGuardText(e.target.value)}
              rows={2}
              className='w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-[11.5px]'
            />
          </div>
          <div className='flex justify-end'>
            <Button
              size='sm'
              className='h-7 bg-nvr-cyan text-[12px] text-white'
              disabled={!label.trim() || createMutCA.isPending}
              onClick={() => createMutCA.mutate()}
            >
              Create action
            </Button>
          </div>
        </div>
      )}
      <div className='divide-y divide-slate-100'>
        {actions.length === 0 && (
          <p className='px-4 py-3 text-[12px] text-slate-400'>No custom actions yet.</p>
        )}
        {actions.map((a) => (
          <div key={a.id} className='flex items-center gap-2 px-4 py-2'>
            <span className='text-[12.5px] font-medium text-slate-700'>{a.label}</span>
            <span className='rounded bg-slate-100 px-1.5 py-px text-[10px] uppercase text-slate-500'>
              {a.action_type.replace('_', ' ')}
            </span>
            <span className='flex-1' />
            <button
              type='button'
              onClick={() => {
                if (window.confirm(`Delete the action "${a.label}"?`)) delMutCA.mutate(a.id)
              }}
              className='rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500'
              aria-label={`Delete ${a.label}`}
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Field dependency map (#95): what feeds what — formulas, rollups, field
 *  rules, cascades, auto-id tokens, copy-defaults — as one SVG. Nodes down
 *  the left, edges as arcs colored by kind. Config-driven; loads on open. */
function DependencyMapSection({ tableName }: { tableName: string }) {
  const [open, setOpen] = useState(false)
  const { data } = useQuery<{
    nodes: Array<{ id: string; label: string; external: boolean }>
    edges: Array<{ from: string; to: string; kind: string }>
  }>({
    queryKey: ['dependency-map', tableName],
    queryFn: () => api.get(`/data-model/${tableName}/dependency-map`).then((r) => r.data.data),
    enabled: open
  })
  const KIND_COLOR: Record<string, string> = {
    formula: '#00a5cc',
    rollup: '#8b5cf6',
    rule: '#f59e0b',
    cascade: '#10b981',
    auto_id: '#64748b',
    copy: '#ec4899',
    default: '#0ea5e9'
  }
  const KIND_LABEL: Record<string, string> = {
    formula: 'Formula',
    rollup: 'Rollup (from child rows)',
    rule: 'Field rule',
    cascade: 'Cascade filter',
    auto_id: 'Auto-ID token',
    copy: 'Copy default',
    default: 'Default formula'
  }
  const nodes = data?.nodes ?? []
  const edges = data?.edges ?? []
  // Sources first, then mixed, then pure targets — reads top-down as "flows".
  const inDeg = new Map<string, number>()
  const outDeg = new Map<string, number>()
  for (const e of edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1)
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1)
  }
  const ordered = [...nodes].sort(
    (a, b) =>
      (inDeg.get(a.id) ?? 0) -
      (outDeg.get(a.id) ?? 0) -
      ((inDeg.get(b.id) ?? 0) - (outDeg.get(b.id) ?? 0))
  )
  const ROW = 30
  const LEFT = 250
  const H = ordered.length * ROW + 12
  const W = 640
  const yOf = new Map(ordered.map((n, i) => [n.id, 6 + i * ROW + ROW / 2]))
  const kindsPresent = [...new Set(edges.map((e) => e.kind))]

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center justify-between px-4 py-3 text-left'
      >
        <span>
          <span className='block text-[13px] font-semibold text-slate-800'>Dependency map</span>
          <span className='mt-0.5 block text-[11.5px] text-slate-500'>
            What feeds what — formulas, rollups, field rules, cascades, auto-ID tokens,
            copy-defaults — in one picture.
          </span>
        </span>
        <span className='text-slate-400'>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className='border-t border-slate-100 px-4 py-3'>
          {!data ? (
            <p className='text-[12px] text-slate-400'>Loading…</p>
          ) : edges.length === 0 ? (
            <p className='text-[12px] text-slate-400'>
              No configured dependencies on this collection.
            </p>
          ) : (
            <>
              <div className='mb-2 flex flex-wrap gap-3'>
                {kindsPresent.map((k) => (
                  <span key={k} className='flex items-center gap-1 text-[10.5px] text-slate-500'>
                    <span
                      className='inline-block h-2 w-2 rounded-full'
                      style={{ backgroundColor: KIND_COLOR[k] ?? '#94a3b8' }}
                    />
                    {KIND_LABEL[k] ?? k}
                  </span>
                ))}
              </div>
              <div className='overflow-x-auto'>
                <svg
                  width={W}
                  height={H}
                  viewBox={`0 0 ${W} ${H}`}
                  role='img'
                  aria-label='Field dependency map'
                  className='min-w-[520px]'
                >
                  {edges.map((e) => {
                    const y1 = yOf.get(e.from)
                    const y2 = yOf.get(e.to)
                    if (y1 == null || y2 == null) return null
                    const dx = 60 + Math.abs(y2 - y1) * 0.3
                    return (
                      <path
                        key={`${e.from}-${e.to}-${e.kind}`}
                        d={`M ${LEFT + 10} ${y1} C ${LEFT + 10 + dx} ${y1}, ${LEFT + 10 + dx} ${y2}, ${LEFT + 10} ${y2}`}
                        fill='none'
                        stroke={KIND_COLOR[e.kind] ?? '#94a3b8'}
                        strokeOpacity={0.55}
                        strokeWidth={1.75}
                        markerEnd='url(#dep-arrow)'
                      >
                        <title>{`${e.from} → ${e.to} (${KIND_LABEL[e.kind] ?? e.kind})`}</title>
                      </path>
                    )
                  })}
                  <defs>
                    <marker
                      id='dep-arrow'
                      viewBox='0 0 6 6'
                      refX='5'
                      refY='3'
                      markerWidth='5'
                      markerHeight='5'
                      orient='auto-start-reverse'
                    >
                      <path d='M 0 0 L 6 3 L 0 6 z' fill='#94a3b8' />
                    </marker>
                  </defs>
                  {ordered.map((n) => {
                    const y = yOf.get(n.id) ?? 0
                    return (
                      <g key={n.id}>
                        <circle
                          cx={LEFT + 10}
                          cy={y}
                          r={4}
                          fill={n.external ? '#8b5cf6' : '#00ceff'}
                        />
                        <text
                          x={LEFT}
                          y={y + 3.5}
                          textAnchor='end'
                          className={
                            n.external
                              ? 'fill-violet-600 text-[10.5px] italic'
                              : 'fill-slate-700 text-[11px] font-medium dark:fill-slate-200'
                          }
                        >
                          {n.label.length > 38 ? `${n.label.slice(0, 38)}…` : n.label}
                        </text>
                      </g>
                    )
                  })}
                </svg>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Collection snapshots (#78): point-in-time checkpoints for small reference
 *  tables. Restore upserts by id and reports newer rows it left alone. */
function SnapshotsSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null)
  const { data: snaps = [] } = useQuery<
    Array<{
      id: number
      name: string
      row_count: number
      created_at: string
      created_by_name: string | null
    }>
  >({
    queryKey: ['collection-snapshots', tableName],
    queryFn: () =>
      api
        .get('/collection-snapshots', { params: { collection: tableName } })
        .then((r) => r.data.data)
  })
  const create = useMutation({
    mutationFn: () => api.post('/collection-snapshots', { collection: tableName, name }),
    onSuccess: () => {
      toast.success('Snapshot captured')
      setName('')
      qc.invalidateQueries({ queryKey: ['collection-snapshots', tableName] })
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Snapshot failed')
  })
  const restore = useMutation({
    mutationFn: (id: number) =>
      api.post<{ data: { updated: number; inserted: number; extra_rows: number } }>(
        `/collection-snapshots/${id}/restore`
      ),
    onSuccess: (r) => {
      const d = r.data.data
      toast.success(
        `Restored — ${d.updated} updated, ${d.inserted} re-inserted${d.extra_rows > 0 ? `, ${d.extra_rows} newer row(s) left alone` : ''}`
      )
      setConfirmRestore(null)
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Restore failed')
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/collection-snapshots/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collection-snapshots', tableName] })
  })
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[13px] font-semibold text-slate-800'>Snapshots</p>
        <p className='mt-0.5 text-[11.5px] text-slate-500'>
          Point-in-time checkpoints for small reference tables (up to 5,000 rows) — capture one
          before a risky edit. Restore updates changed rows and re-inserts deleted ones by id; rows
          created AFTER the snapshot are left alone and reported.
        </p>
      </div>
      <div className='space-y-2.5 px-4 py-3'>
        <div className='flex items-center gap-2'>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Snapshot name (e.g. "before FY27 cleanup")'
            className='h-7 flex-1 text-[12px]'
          />
          <Button
            size='sm'
            className='h-7 bg-nvr-cyan text-[12px] text-white'
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            Capture now
          </Button>
        </div>
        {snaps.length === 0 ? (
          <p className='text-[12px] text-slate-400'>No snapshots yet.</p>
        ) : (
          <div className='divide-y divide-slate-50'>
            {snaps.map((sn) => (
              <div key={sn.id} className='flex items-center gap-2 py-1.5 text-[12px]'>
                <span className='min-w-0 flex-1 truncate font-medium text-slate-700'>
                  {sn.name}
                </span>
                <span className='shrink-0 tabular-nums text-slate-400'>
                  {sn.row_count} rows · {new Date(sn.created_at).toLocaleString()}
                </span>
                {confirmRestore === sn.id ? (
                  <span className='flex shrink-0 items-center gap-1'>
                    <Button
                      size='sm'
                      variant='destructive'
                      className='h-6 px-2 text-[11px]'
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(sn.id)}
                    >
                      {restore.isPending ? 'Restoring…' : 'Yes, restore'}
                    </Button>
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-6 px-2 text-[11px]'
                      onClick={() => setConfirmRestore(null)}
                    >
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <span className='flex shrink-0 items-center gap-1'>
                    <button
                      type='button'
                      onClick={() => setConfirmRestore(sn.id)}
                      className='rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                    >
                      Restore
                    </button>
                    <button
                      type='button'
                      onClick={() => remove.mutate(sn.id)}
                      className='rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-red-500'
                    >
                      Delete
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Natural-key upsert: columns that identify a record. A create that matches
 *  an existing row on every key updates that row instead of inserting a
 *  duplicate — one row per key regardless of which client writes. */
function UpsertKeysSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const { data: meta } = useQuery({
    queryKey: ['collection-meta-upsert', tableName],
    queryFn: () =>
      api
        .get<{ data: { upsert_keys?: string[] | null } }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName
  })
  useEffect(() => {
    if (meta && !loaded) {
      setText((meta.upsert_keys ?? []).join(', '))
      setLoaded(true)
    }
  }, [meta, loaded])
  const saveMut = useMutation({
    mutationFn: () =>
      api.patch(`/collections/${tableName}`, {
        upsert_keys: text
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      }),
    onSuccess: () => {
      toast.success('Upsert keys saved')
      qc.invalidateQueries({ queryKey: ['collection-meta-upsert', tableName] })
    },
    onError: (e: Error & { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? e.message ?? 'Save failed')
  })
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[13px] font-semibold text-slate-800'>Natural key (upsert)</p>
        <p className='mt-0.5 text-[11.5px] text-slate-500'>
          Comma-separated columns that identify a record — e.g.{' '}
          <code className='text-[10.5px]'>workflow, year</code>. A create whose payload matches an
          existing row on every key becomes an update of that row, so the collection stays
          one-row-per-key whether the write comes from a form grid, the REST API or a GraphQL
          integration. End a column with <code className='text-[10.5px]'>?</code> to make it
          optional — a create that leaves it blank matches the row where it is blank too. Empty =
          plain inserts.
        </p>
      </div>
      <div className='space-y-2 px-4 py-3'>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='workflow, year'
          className='h-8 font-mono text-[12px]'
        />
        <div className='flex justify-end'>
          <Button
            size='sm'
            className='h-7 bg-nvr-cyan text-[12px] text-white'
            disabled={saveMut.isPending}
            onClick={() => saveMut.mutate()}
          >
            Save keys
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Synthetic records (#72): test rows built from the collection's own field
 *  metadata, written through the items service, traceable and deletable per
 *  batch via the `synthetic:<batch>` change reason. */
function SyntheticRecordsSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const [count, setCount] = useState('10')
  const [confirmBatch, setConfirmBatch] = useState<string | null>(null)
  const [showPlan, setShowPlan] = useState(false)
  const { data } = useQuery({
    queryKey: ['synthetic-records', tableName],
    queryFn: () =>
      api
        .get<{
          data: {
            plan: {
              fields: Array<{ field: string; strategy: string }>
              skipped: Array<{ field: string; reason: string }>
            }
            batches: Array<{
              batch: string
              count: number
              first_at: string | null
              by: string | null
            }>
          }
        }>(`/data-model/${tableName}/synthetic`)
        .then((r) => r.data.data),
    enabled: !!tableName
  })
  const gen = useMutation({
    mutationFn: () =>
      api
        .post<{
          data: {
            batch: string
            created: number
            requested: number
            failed: Array<{ index: number; error: string }>
          }
        }>(`/data-model/${tableName}/synthetic`, { count: Number(count) })
        .then((r) => r.data.data),
    onSuccess: (r) => {
      if (r.created === 0)
        toast.error(`Nothing created — ${r.failed[0]?.error ?? 'every row failed'}`)
      else
        toast.success(
          `Batch ${r.batch}: ${r.created} of ${r.requested} created${r.failed.length ? ` — first failure: ${r.failed[0].error}` : ''}`
        )
      qc.invalidateQueries({ queryKey: ['synthetic-records', tableName] })
    },
    onError: (e: Error & { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? e.message ?? 'Generate failed')
  })
  const del = useMutation({
    mutationFn: (batch: string) =>
      api
        .delete<{ data: { deleted: number; failed: number; missing: number } }>(
          `/data-model/${tableName}/synthetic/${batch}`
        )
        .then((r) => r.data.data),
    onSuccess: (r) => {
      toast.success(`${r.deleted} deleted to trash${r.failed ? `, ${r.failed} failed` : ''}`)
      setConfirmBatch(null)
      qc.invalidateQueries({ queryKey: ['synthetic-records', tableName] })
    },
    onError: (e: Error & { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? e.message ?? 'Delete failed')
  })
  const plan = data?.plan
  return (
    <div
      className='overflow-hidden rounded-lg border border-slate-200 bg-white'
      data-synthetic-records
    >
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[13px] font-semibold text-slate-800'>Synthetic records</p>
        <p className='mt-0.5 text-[11.5px] text-slate-500'>
          Test rows built from this collection&apos;s field types, choices, relations and validation
          rules — written like any other record (rules, auto-ids and revisions apply), each stamped
          with the change reason <code className='text-[10.5px]'>synthetic:&lt;batch&gt;</code> so a
          whole batch can be sent to the trash later. For staging, not production data.
        </p>
      </div>
      <div className='space-y-3 px-4 py-3'>
        <div className='flex items-center gap-2'>
          <Input
            type='number'
            min={1}
            max={200}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            className='h-8 w-24 text-[12px]'
            aria-label='How many records'
          />
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-[12px] text-white'
            disabled={gen.isPending || !plan || plan.fields.length === 0}
            onClick={() => gen.mutate()}
            data-synthetic-generate
          >
            {gen.isPending ? 'Generating…' : 'Generate'}
          </Button>
          {plan && (
            <button
              type='button'
              onClick={() => setShowPlan((v) => !v)}
              className='text-[11.5px] text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-800'
            >
              {plan.fields.length} fields filled · {plan.skipped.length} skipped
            </button>
          )}
        </div>
        {showPlan && plan && (
          <div className='grid gap-x-4 gap-y-0.5 text-[11.5px] sm:grid-cols-2' data-synthetic-plan>
            {plan.fields.map((f) => (
              <p key={f.field} className='truncate text-slate-700'>
                <code className='text-[10.5px]'>{f.field}</code>{' '}
                <span className='text-slate-500'>{f.strategy}</span>
              </p>
            ))}
            {plan.skipped.map((f) => (
              <p key={f.field} className='truncate text-slate-400'>
                <code className='text-[10.5px]'>{f.field}</code> <span>{f.reason}</span>
              </p>
            ))}
          </div>
        )}
        {data && data.batches.length > 0 && (
          <div className='divide-y divide-slate-100 rounded-md border border-slate-200'>
            {data.batches.map((b) => (
              <div
                key={b.batch}
                className='flex items-center gap-3 px-3 py-1.5 text-[12px]'
                data-synthetic-batch={b.batch}
              >
                <code className='text-[11px] text-slate-700'>{b.batch}</code>
                <span className='tabular-nums text-slate-600'>{b.count} rows</span>
                <span className='text-slate-400'>
                  {b.first_at ? formatRelative(b.first_at) : ''}
                  {b.by ? ` · ${b.by}` : ''}
                </span>
                <span className='flex-1' />
                {confirmBatch === b.batch ? (
                  <>
                    <Button
                      size='sm'
                      variant='destructive'
                      className='h-6 text-[11px]'
                      disabled={del.isPending}
                      onClick={() => del.mutate(b.batch)}
                      data-synthetic-delete-confirm
                    >
                      Send {b.count} to trash
                    </Button>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-6 text-[11px]'
                      onClick={() => setConfirmBatch(null)}
                    >
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-6 text-[11px]'
                    onClick={() => setConfirmBatch(b.batch)}
                    data-synthetic-delete
                  >
                    Delete batch
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Deletion protection rules (#64): guards that BLOCK deletes with their own
 *  message. JSON config — same admin-textarea posture as picker_filter. */
function DeleteGuardSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const { data: meta } = useQuery({
    queryKey: ['collection-meta-delguard', tableName],
    queryFn: () =>
      api
        .get<{ data: { delete_guard?: unknown } }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName
  })
  useEffect(() => {
    if (meta && !loaded) {
      setText(meta.delete_guard ? JSON.stringify(meta.delete_guard, null, 2) : '')
      setLoaded(true)
    }
  }, [meta, loaded])
  const saveMut = useMutation({
    mutationFn: () => {
      let parsed: unknown = null
      if (text.trim()) {
        parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) throw new Error('Guard must be a JSON array of rules')
      }
      return api.patch(`/collections/${tableName}`, { delete_guard: parsed })
    },
    onSuccess: () => {
      toast.success('Deletion guards saved')
      qc.invalidateQueries({ queryKey: ['collection-meta-delguard', tableName] })
    },
    onError: (e: Error & { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? e.message ?? 'Save failed')
  })
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='border-b border-slate-100 px-4 py-3'>
        <p className='text-[13px] font-semibold text-slate-800'>Deletion protection</p>
        <p className='mt-0.5 text-[11.5px] text-slate-500'>
          Rules that BLOCK deleting a record, with their own message. Applies to everyone — admins
          included. Rule shapes:{' '}
          <code className='text-[10.5px]'>
            {'{'}
            "type":"children","collection":"purchase_orders","fk_field":"workflow","message":"…"
            {'}'}
          </code>{' '}
          (blocks when linked rows exist) and{' '}
          <code className='text-[10.5px]'>
            {'{'}"type":"condition","field":"status","op":"eq","value":"posted","message":"…"{'}'}
          </code>
          . Empty = no guards.
        </p>
      </div>
      <div className='space-y-2 px-4 py-3'>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder='[]'
          spellCheck={false}
          className='w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-[11.5px]'
        />
        <div className='flex justify-end'>
          <Button
            size='sm'
            className='h-7 bg-nvr-cyan text-[12px] text-white'
            disabled={saveMut.isPending}
            onClick={() => saveMut.mutate()}
          >
            Save guards
          </Button>
        </div>
      </div>
    </div>
  )
}

function DataProtectionSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const { data: meta } = useQuery({
    queryKey: ['collection-meta-protection', tableName],
    queryFn: () =>
      api
        .get<{
          data: {
            read_logging?: boolean
            export_watermark?: boolean
            collision_detection?: boolean
            activity_retention_days?: number | null
            trash_retention_days?: number | null
          }
        }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName
  })
  const saveMut = useMutation({
    mutationFn: (patch: Record<string, boolean | number | null>) =>
      api.patch(`/collections/${tableName}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection-meta-protection', tableName] })
      toast.success('Data protection setting saved')
    },
    onError: () => toast.error('Failed to update setting')
  })
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='flex items-center justify-between border-b border-slate-100 px-4 py-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Read-access logging</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Log who opens each record (one entry per person per record per hour), shown in the
            record&rsquo;s history. For sensitive collections — activity normally covers writes
            only.
          </p>
        </div>
        <Switch
          checked={meta?.read_logging === true}
          onCheckedChange={(v) => saveMut.mutate({ read_logging: v })}
          disabled={saveMut.isPending || meta === undefined}
        />
      </div>
      <div className='flex items-center justify-between border-b border-slate-100 px-4 py-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Export watermark</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Stamp CSV exports of this collection with the export timestamp and row count, so the
            file itself says where it came from. Every export is audit-logged either way.
          </p>
        </div>
        <Switch
          checked={meta?.export_watermark === true}
          onCheckedChange={(v) => saveMut.mutate({ export_watermark: v })}
          disabled={saveMut.isPending || meta === undefined}
        />
      </div>
      <div className='flex items-center justify-between px-4 py-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Mid-air collision detection</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            When two people edit the same record, a save touching fields someone else just changed
            pauses into a merge dialog instead of silently overwriting. Turn off to restore
            last-write-wins for this collection.
          </p>
        </div>
        <Switch
          checked={meta?.collision_detection !== false}
          onCheckedChange={(v) => saveMut.mutate({ collision_detection: v })}
          disabled={saveMut.isPending || meta === undefined}
        />
      </div>
      {/* Per-collection retention overrides (#257/#258): purge this
          collection's activity / trash on its own schedule; blank = follow
          the instance-wide settings. */}
      <div className='flex items-center justify-between border-t border-slate-100 px-4 py-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Retention overrides</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Days to keep this collection&rsquo;s activity log and trash before the nightly purge —
            blank follows the instance-wide settings. Imported legacy history is never purged.
          </p>
        </div>
        <div className='flex items-center gap-3'>
          {(
            [
              ['Activity', 'activity_retention_days'],
              ['Trash', 'trash_retention_days']
            ] as const
          ).map(([label, key]) => (
            <label key={key} className='flex items-center gap-1.5 text-[11.5px] text-slate-500'>
              {label}
              <Input
                type='number'
                min={1}
                defaultValue={meta?.[key] ?? ''}
                onBlur={(e) =>
                  saveMut.mutate({ [key]: e.target.value === '' ? null : Number(e.target.value) })
                }
                className='h-7 w-20 text-[12px]'
                placeholder='—'
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Safe collection rename (#154) ───────────────────────────────────────────

function RenameCollectionSection({ tableName }: { tableName: string }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [report, setReport] = useState<Array<{ surface: string; hits: unknown[] }> | null>(null)
  const rename = useMutation({
    mutationFn: () =>
      api
        .post<{
          data: {
            renamed: boolean
            new_name: string
            remaining_references: Array<{ surface: string; hits: unknown[] }>
          }
        }>(`/data-model/${tableName}/rename`, { new_name: newName.trim() })
        .then((r) => r.data.data),
    onSuccess: (d) => {
      toast.success(`Renamed to ${d.new_name}`)
      setReport(d.remaining_references)
      setConfirming(false)
      // Registry rows repointed — land on the renamed editor.
      setTimeout(() => navigate(`/data-model/${d.new_name}`), 1500)
    },
    onError: (e: unknown) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Rename failed'
      )
  })
  return (
    <div className='overflow-hidden rounded-lg border border-amber-200 bg-white'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center justify-between px-4 py-3 text-left'
      >
        <div>
          <p className='text-[13px] font-medium text-amber-700'>Rename collection</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Renames the table and repoints layouts, queues, policies, views, relations and registry
            rows. Free-text references (formulas, filter JSON) are REPORTED, not rewritten.
          </p>
        </div>
        <span className='text-[11px] text-slate-400'>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className='space-y-2 border-t border-amber-100 px-4 py-3'>
          <div className='flex items-center gap-2'>
            <Input
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value)
                setConfirming(false)
              }}
              placeholder='new_table_name'
              className='h-8 w-64 font-mono text-[12.5px]'
            />
            {confirming ? (
              <>
                <Button
                  type='button'
                  size='sm'
                  variant='destructive'
                  className='h-8 text-[12px]'
                  disabled={rename.isPending}
                  onClick={() => rename.mutate()}
                >
                  {rename.isPending ? 'Renaming…' : `Yes — rename to ${newName.trim()}`}
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  className='h-8 text-[12px]'
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type='button'
                size='sm'
                variant='outline'
                className='h-8 border-amber-300 text-[12px] text-amber-700'
                disabled={
                  !/^[a-z_][a-z0-9_]*$/.test(newName.trim()) || newName.trim() === tableName
                }
                onClick={() => setConfirming(true)}
              >
                Rename…
              </Button>
            )}
          </div>
          {report && report.length > 0 && (
            <div className='rounded border border-amber-200 bg-amber-50/50 p-2 text-[11.5px] text-amber-800'>
              <p className='font-medium'>Remaining references to review:</p>
              {report.map((g) => (
                <p key={g.surface}>
                  {g.surface}: {g.hits.length} hit{g.hits.length === 1 ? '' : 's'}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Type-change dry-run (#153) ──────────────────────────────────────────────

function CastCheckSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [col, setCol] = useState('')
  const [toType, setToType] = useState('integer')
  const [maxLen, setMaxLen] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [result, setResult] = useState<{
    total: number
    failures: number
    samples: Array<{ id: unknown; value: string }>
  } | null>(null)
  const { data: table } = useQuery({
    queryKey: ['data-model-table', tableName],
    queryFn: () => schemaApi.getTable(tableName).then((r) => r.data),
    enabled: open && !!tableName
  })
  const lenNum = Number(maxLen)
  const lenBody =
    toType === 'string' && Number.isInteger(lenNum) && lenNum > 0 && lenNum <= 4000
      ? lenNum
      : undefined
  const run = useMutation({
    mutationFn: () =>
      api
        .post<{
          data: { total: number; failures: number; samples: Array<{ id: unknown; value: string }> }
        }>(`/data-model/${tableName}/columns/${col}/cast-check`, {
          to_type: toType,
          max_length: lenBody
        })
        .then((r) => r.data.data),
    onSuccess: (d) => {
      setResult(d)
      setConfirmText('')
    },
    onError: (e: unknown) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Check failed'
      )
  })
  // Convert type (#510): executes the previewed conversion via the change-type
  // route. force only when the preview showed failures the operator has seen;
  // expected_failures makes the server 409 (CAST_DRIFT) if the count moved.
  const convert = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { new_type: string; nulled_rows: number } }>(
          `/data-model/collections/${tableName}/fields/${col}/change-type`,
          {
            new_type: toType,
            max_length: lenBody,
            force: (result?.failures ?? 0) > 0,
            expected_failures: result?.failures ?? 0
          }
        )
        .then((r) => r.data.data),
    onSuccess: (d) => {
      toast.success(
        `"${col}" converted to ${d.new_type}${d.nulled_rows > 0 ? ` — ${d.nulled_rows} unconvertible value(s) set to NULL` : ''}`
      )
      setResult(null)
      setConfirmText('')
      qc.invalidateQueries({ queryKey: ['data-model-table', tableName] })
    },
    onError: (e: unknown) => {
      const data = (e as { response?: { data?: { error?: string; code?: string } } })?.response
        ?.data
      toast.error(data?.error ?? 'Conversion failed')
      if (data?.code === 'CAST_DRIFT') setResult(null)
    }
  })
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center justify-between px-4 py-3 text-left'
      >
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Convert column type</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Preview which values survive the cast, then convert the column in place. Primary keys,
            FK-constrained and computed/auto-ID columns are refused.
          </p>
        </div>
        <span className='text-[11px] text-slate-400'>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className='space-y-2 border-t border-slate-100 px-4 py-3'>
          <div className='flex items-center gap-2'>
            <Combobox
              value={col}
              onChange={(v) => {
                setCol(v)
                setResult(null)
              }}
              options={(table?.columns ?? []).map((c) => ({ value: c.name, label: c.name }))}
              placeholder='Column…'
            />
            <Combobox
              value={toType}
              onChange={(v) => {
                setToType(v)
                setResult(null)
              }}
              options={[
                'integer',
                'bigInteger',
                'decimal',
                'float',
                'boolean',
                'date',
                'datetime',
                'uuid',
                'string',
                'text'
              ].map((t) => ({ value: t, label: t }))}
            />
            {toType === 'string' && (
              <Input
                type='number'
                min={1}
                max={4000}
                value={maxLen}
                onChange={(e) => {
                  setMaxLen(e.target.value)
                  setResult(null)
                }}
                placeholder='255'
                title='nvarchar length (default 255)'
                className='h-7 w-20 text-[11.5px]'
              />
            )}
            <Button
              type='button'
              size='sm'
              className='h-7 text-[11.5px]'
              disabled={!col || run.isPending}
              onClick={() => run.mutate()}
            >
              {run.isPending ? 'Scanning…' : 'Preview'}
            </Button>
          </div>
          {result && (
            <div className='text-[12px]'>
              {result.failures === 0 ? (
                <p className='text-emerald-600'>
                  All {result.total.toLocaleString()} non-null values survive the cast to {toType}.
                </p>
              ) : (
                <>
                  <p className='font-medium text-red-600'>
                    {result.failures.toLocaleString()} of {result.total.toLocaleString()} values
                    would NOT survive — the alter would fail or null them.
                  </p>
                  <div className='mt-1 max-h-32 overflow-y-auto rounded border border-red-100 bg-red-50/40 p-2 font-mono text-[11px] text-slate-600'>
                    {result.samples.map((sm) => (
                      <p key={String(sm.id)}>
                        #{String(sm.id)}: {sm.value}
                      </p>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {result && (
            <div className='space-y-1.5 rounded-md border border-amber-200 bg-amber-50/50 p-2.5'>
              <p className='text-[12px] font-medium text-amber-800'>
                Convert <span className='font-mono'>{col}</span> to {toType}
                {toType === 'string' ? `(${lenBody ?? 255})` : ''}
                {result.failures > 0 &&
                  ` — ${result.failures.toLocaleString()} unconvertible value(s) will be set to NULL`}
              </p>
              <p className='text-[11.5px] text-amber-700'>
                This alters the physical column and cannot be undone. Type CONVERT to confirm.
              </p>
              <div className='flex items-center gap-2'>
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder='CONVERT'
                  spellCheck={false}
                  className='h-7 w-32 font-mono text-[12px]'
                />
                <Button
                  type='button'
                  size='sm'
                  variant='destructive'
                  className='h-7 text-[11.5px]'
                  disabled={confirmText !== 'CONVERT' || convert.isPending}
                  onClick={() => convert.mutate()}
                >
                  {convert.isPending ? 'Converting…' : 'Convert'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Test data generator (#512, Settings tab) ────────────────────────────────

function GenerateTestDataCard({ tableName }: { tableName: string }) {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState('10')
  const [seed, setSeed] = useState('')
  const [allowNonEmpty, setAllowNonEmpty] = useState(false)
  const [lastResult, setLastResult] = useState<{
    created: unknown[]
    errors: Array<{ row: number; error: string }>
  } | null>(null)
  const gen = useMutation({
    mutationFn: () => {
      const seedNum = Number(seed)
      return api
        .post<{ data: { created: unknown[]; errors: Array<{ row: number; error: string }> } }>(
          `/test-data/${tableName}`,
          {
            count: Math.max(1, Math.min(100, Number(count) || 10)),
            respect_required: true,
            allow_nonempty: allowNonEmpty || undefined,
            seed: seed.trim() && Number.isFinite(seedNum) ? seedNum : undefined
          }
        )
        .then((r) => r.data.data)
    },
    onSuccess: (d) => {
      setLastResult(d)
      if (d.errors.length === 0) toast.success(`${d.created.length} sample row(s) created`)
      else
        toast.warning(
          `${d.created.length} created, ${d.errors.length} failed — first: ${d.errors[0].error}`
        )
    },
    onError: (e: unknown) => {
      const data = (e as { response?: { data?: { error?: string; existing_rows?: number } } })
        ?.response?.data
      if (data?.existing_rows != null) {
        setAllowNonEmpty(true)
        toast.warning(`${data.error} — press Generate again to proceed`)
      } else {
        toast.error(data?.error ?? 'Generation failed')
      }
    }
  })
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center justify-between px-4 py-3 text-left'
      >
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Generate test data</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Seed sample rows (name-aware fakers, FKs sampled from existing targets) — rows go
            through the normal create path, so hooks and validation apply.
          </p>
        </div>
        <span className='text-[11px] text-slate-400'>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className='space-y-2 border-t border-slate-100 px-4 py-3'>
          <p className='rounded border border-amber-200 bg-amber-50/50 p-2 text-[11.5px] text-amber-800'>
            Development affordance — generated rows are fake. Refused on collections that already
            hold data unless you confirm.
          </p>
          <div className='flex items-center gap-2'>
            <div>
              <Label className='mb-1 block text-[10.5px] text-slate-500'>Rows (max 100)</Label>
              <Input
                type='number'
                min={1}
                max={100}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                className='h-7 w-24 text-[12px]'
              />
            </div>
            <div>
              <Label className='mb-1 block text-[10.5px] text-slate-500'>Seed (optional)</Label>
              <Input
                type='number'
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                placeholder='random'
                title='Same seed = same rows, reproducible across environments'
                className='h-7 w-28 text-[12px]'
              />
            </div>
            <Button
              type='button'
              size='sm'
              className='mt-4 h-7 text-[11.5px]'
              disabled={gen.isPending}
              onClick={() => gen.mutate()}
            >
              {gen.isPending ? 'Generating…' : 'Generate'}
            </Button>
          </div>
          {lastResult && lastResult.errors.length > 0 && (
            <div className='max-h-32 overflow-y-auto rounded border border-red-100 bg-red-50/40 p-2 text-[11px] text-slate-600'>
              {lastResult.errors.slice(0, 10).map((er) => (
                <p key={er.row}>
                  Row {er.row}: {er.error}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Field edit-frequency (#405) ─────────────────────────────────────────────

function EditFrequencySection({ tableName }: { tableName: string }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery<{
    days: number
    sampled_revisions: number
    fields: Array<{ field: string; edits: number }>
  }>({
    queryKey: ['edit-frequency', tableName],
    queryFn: () =>
      api
        .get<{
          data: {
            days: number
            sampled_revisions: number
            fields: Array<{ field: string; edits: number }>
          }
        }>(`/data-model/${tableName}/edit-frequency`)
        .then((r) => r.data.data),
    enabled: open && !!tableName,
    staleTime: 5 * 60_000
  })
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center justify-between px-4 py-3 text-left'
      >
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Edit frequency</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Which fields people actually EDIT (revision deltas, last 90 days) — the behavioral layer
            over fill rates.
          </p>
        </div>
        <span className='text-[11px] text-slate-400'>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className='border-t border-slate-100 px-4 py-3'>
          {isLoading ? (
            <p className='text-[12px] text-slate-400'>Scanning revisions…</p>
          ) : !data || data.fields.length === 0 ? (
            <p className='text-[12px] text-slate-400'>No edits recorded in the window.</p>
          ) : (
            <>
              <p className='mb-2 text-[11px] text-slate-400'>
                {data.sampled_revisions.toLocaleString()} revisions sampled over {data.days} days
              </p>
              <div className='max-h-64 overflow-y-auto'>
                {data.fields.slice(0, 40).map((f) => (
                  <div
                    key={f.field}
                    className='flex items-center gap-2 border-b border-slate-50 py-1 last:border-b-0'
                  >
                    <span className='w-48 truncate font-mono text-[11.5px] text-slate-600'>
                      {f.field}
                    </span>
                    <span className='relative h-2 flex-1 overflow-hidden rounded-full bg-slate-100'>
                      <span
                        className='absolute inset-y-0 left-0 rounded-full bg-[#00a5cc]'
                        style={{
                          width: `${Math.min(100, (f.edits / data.fields[0].edits) * 100)}%`
                        }}
                      />
                    </span>
                    <span className='w-14 text-right text-[11px] tabular-nums text-slate-500'>
                      {f.edits.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Field usage (Settings tab) ───────────────────────────────────────────────

function FieldUsageSection({ tableName }: { tableName: string }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery<{
    total: number
    fields: Array<{ field: string; populated: number; pct: number }>
  }>({
    queryKey: ['field-usage', tableName],
    queryFn: () =>
      api
        .get<{
          data: { total: number; fields: Array<{ field: string; populated: number; pct: number }> }
        }>(`/data-model/${tableName}/field-usage`)
        .then((r) => r.data.data),
    enabled: open && !!tableName,
    staleTime: 5 * 60_000
  })
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center justify-between px-4 py-3 text-left'
      >
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Field usage</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            How populated each column actually is — dead fields worth pruning float to the top.
          </p>
        </div>
        <span className='text-[11px] text-slate-400'>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className='border-t border-slate-100 px-4 py-3'>
          {isLoading && <p className='text-[12px] text-slate-400'>Scanning…</p>}
          {data && (
            <>
              <p className='mb-2 text-[11.5px] text-slate-400'>
                {data.total.toLocaleString()} row{data.total === 1 ? '' : 's'} · least-populated
                first
              </p>
              <div className='grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2'>
                {data.fields.map((f) => (
                  <div key={f.field} className='flex items-center gap-2 text-[12px]'>
                    <span className='w-[180px] shrink-0 truncate font-mono text-[11px] text-slate-600'>
                      {f.field}
                    </span>
                    <span className='h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100'>
                      <span
                        className={
                          f.pct < 5
                            ? 'block h-full bg-red-400'
                            : f.pct < 40
                              ? 'block h-full bg-amber-400'
                              : 'block h-full bg-emerald-400'
                        }
                        style={{ width: `${Math.max(f.pct, 1.5)}%` }}
                      />
                    </span>
                    <span className='w-[48px] shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-500'>
                      {f.pct}%
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
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

function AddendumStartStateRow({
  pipeline,
  stateKey,
  onStateKeyChange
}: {
  pipeline: { id: string; name: string }
  stateKey: string | null
  onStateKeyChange: (key: string | null) => void
}) {
  const { data: detail } = useQuery<{
    states: Array<{ id: string; key: string; label: string; color?: string; is_initial?: boolean }>
  }>({
    queryKey: ['pipeline-detail-lock', pipeline.id],
    queryFn: () => api.get(`/pipelines/${pipeline.id}`).then((r) => r.data.data),
    staleTime: 60_000
  })
  const states = detail?.states ?? []

  return (
    <div className='mt-3 flex items-center justify-between gap-4'>
      <p className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
        {pipeline.name}
      </p>
      <SimpleSelect
        className='h-7 w-auto rounded-md border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'
        value={stateKey ?? ''}
        onChange={(v) => onStateKeyChange(v || null)}
        options={[
          { value: '', label: 'Initial state (default)' },
          ...states.map((s) => ({ value: s.key, label: s.label }))
        ]}
      />
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
            addendum_start_states?: string | null
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

  // Start states — which state a new addendum's workflow instance begins in,
  // per pipeline connected through this collection's addendum-form layouts.
  const [startRules, setStartRules] = useState<Array<{ pipeline_id: string; state_key: string }>>(
    []
  )
  const [startInit, setStartInit] = useState(false)

  useEffect(() => {
    if (col !== undefined && !startInit) {
      try {
        const parsed = col.addendum_start_states ? JSON.parse(col.addendum_start_states) : []
        setStartRules(Array.isArray(parsed) ? parsed : [])
      } catch {
        setStartRules([])
      }
      setStartInit(true)
    }
  }, [col, startInit])

  const saveStartMut = useMutation({
    mutationFn: (rules: typeof startRules) =>
      api.patch(`/collections/${tableName}`, {
        addendum_start_states: rules.length ? JSON.stringify(rules) : null
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection-meta', tableName] })
      toast.success('Start states saved')
    },
    onError: () => toast.error('Failed to save start states')
  })

  // Pipelines connected to addendums via this collection's addendum-form
  // layouts (their workflow_template_id) — the instances whose start state
  // this setting overrides.
  const { data: addendumLayouts } = useQuery<
    Array<{ id: number; workflow_template_id: string | null }>
  >({
    queryKey: ['addendum-layouts-start', tableName],
    queryFn: () =>
      api
        .get('/collection-layouts', { params: { collection: tableName, layout_type: 'addendum' } })
        .then((r) => r.data.data ?? []),
    staleTime: 60_000,
    enabled: enabled && !!tableName
  })
  const connectedPipelineIds = [
    ...new Set((addendumLayouts ?? []).map((l) => l.workflow_template_id).filter(Boolean))
  ] as string[]
  const connectedPipelines = (pipelinesData ?? []).filter((p) =>
    connectedPipelineIds.includes(p.id)
  )

  const updateStartRule = (pipelineId: string, stateKey: string | null) => {
    setStartRules((prev) => {
      const next = prev.filter((r) => r.pipeline_id !== pipelineId)
      if (stateKey) next.push({ pipeline_id: pipelineId, state_key: stateKey })
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
                  Start state
                </p>
                <p className='text-[11px] text-slate-500 dark:text-slate-400 mt-0.5'>
                  Which state a new addendum's pipeline starts in, per pipeline connected through an
                  addendum form layout. Default is the pipeline's initial state.
                </p>
              </div>
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-[11px] shrink-0 ml-4'
                onClick={() => saveStartMut.mutate(startRules)}
                disabled={saveStartMut.isPending}
              >
                Save
              </Button>
            </div>
            {connectedPipelines.length === 0 ? (
              <p className='mt-2 text-[11px] text-slate-400 italic'>
                No addendum form layout is connected to a pipeline.
              </p>
            ) : (
              connectedPipelines.map((pipeline) => (
                <AddendumStartStateRow
                  key={pipeline.id}
                  pipeline={pipeline}
                  stateKey={
                    startRules.find((r) => r.pipeline_id === pipeline.id)?.state_key ?? null
                  }
                  onStateKeyChange={(key) => updateStartRule(pipeline.id, key)}
                />
              ))
            )}
          </div>

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

// ─── Browser Settings card (Settings tab) ─────────────────────────────────────

// nivaro_collections.url_alias_fields — address records in the URL by
// something people recognise ("CM26-79826") instead of the primary key.
function UrlAliasSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const { data: col } = useQuery({
    queryKey: ['collection-meta-alias', tableName],
    queryFn: () =>
      api
        .get<{
          data: {
            url_alias_fields: string[] | null
            slug_field?: string | null
            friendly_id_field?: string | null
          }
        }>(`/collections/${tableName}`)
        .then((r) => r.data.data)
  })
  const [draft, setDraft] = useState('')
  const [friendlyDraft, setFriendlyDraft] = useState('')
  const loadedRef = useRef(false)
  useEffect(() => {
    if (loadedRef.current || !col) return
    loadedRef.current = true
    setDraft((col.url_alias_fields ?? []).join(', '))
    setFriendlyDraft(col.friendly_id_field ?? '')
  }, [col])
  async function saveFriendly() {
    try {
      await api.patch(`/collections/${tableName}`, {
        friendly_id_field: friendlyDraft.trim() || null
      })
      qc.invalidateQueries({ queryKey: ['collection-meta-alias', tableName] })
      toast.success(friendlyDraft.trim() ? 'Human id field saved' : 'Human id field cleared')
    } catch (e) {
      toast.error(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Save failed'
      )
    }
  }

  async function save() {
    const fields = draft
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)
    await api.patch(`/collections/${tableName}`, { url_alias_fields: fields })
    qc.invalidateQueries({ queryKey: ['collection-meta-alias', tableName] })
    toast.success(fields.length > 0 ? 'URL alias saved' : 'URL alias removed')
  }

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='px-4 py-3 space-y-3'>
        <div data-friendly-id-field>
          <p className='text-[13px] font-medium text-slate-800'>Human id field</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            The column that names a record to people — in notifications, mail subjects, event paths,
            chat rooms and alias URLs (<span className='font-mono'>CM26-79811</span>, never the
            internal id). Blank falls back to the chat room registry, then the display label.
          </p>
          <div className='mt-2 flex items-center gap-2'>
            <input
              value={friendlyDraft}
              onChange={(e) => setFriendlyDraft(e.target.value)}
              placeholder='e.g. workflow_id'
              className='h-8 w-64 rounded-md border border-slate-200 px-2 font-mono text-[12px] dark:border-border dark:bg-background'
              data-friendly-id-input
            />
            <button
              type='button'
              onClick={saveFriendly}
              className='h-8 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-foreground'
            >
              Save
            </button>
          </div>
        </div>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>URL alias</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Lets a record be opened by a recognisable value instead of its internal id — with{' '}
            <span className='font-mono'>workflow_id</span> set, /records/{tableName}/CM26-79826
            resolves the same record as /records/{tableName}/371373. Matching is case-insensitive
            and primary keys keep working. The same alias also powers{' '}
            <span className='font-mono'>/collections/{tableName}/s/&lt;value&gt;</span> and{' '}
            <span className='font-mono'>/api/items/{tableName}/by-slug/&lt;value&gt;</span>. List
            several fields to combine them; their values are joined by a dash. If a value matches
            more than one record the lowest id wins, so prefer a field that is genuinely unique.
          </p>
          {col?.slug_field && (
            <div className='mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 dark:border-amber-500/30 dark:bg-amber-500/10'>
              <span className='text-[11.5px] text-amber-700 dark:text-amber-400'>
                Legacy slug field <span className='font-mono'>{col.slug_field}</span> still resolves
                as a fallback — aliases are the one engine now.
              </span>
              <button
                type='button'
                onClick={async () => {
                  const merged = [
                    ...new Set([...(col.url_alias_fields ?? []), col.slug_field as string])
                  ]
                  await api.patch(`/collections/${tableName}`, {
                    url_alias_fields: merged,
                    slug_field: null
                  })
                  setDraft(merged.join(', '))
                  qc.invalidateQueries({ queryKey: ['collection-meta-alias', tableName] })
                  toast.success('Slug field folded into the URL alias')
                }}
                className='rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-400'
              >
                Migrate
              </button>
            </div>
          )}
        </div>
        <div>
          <p className='mb-1 text-[12.5px] font-medium text-slate-700'>Fields (comma-separated)</p>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder='workflow_id'
            className='h-8 text-[12px] font-mono'
          />
        </div>
        <button
          type='button'
          onClick={save}
          className='rounded-md bg-nvr-cyan px-3 py-1.5 text-[12px] font-medium text-white hover:bg-nvr-cyan/90'
        >
          Save
        </button>
      </div>
    </div>
  )
}

// nivaro_collections.change_reason_config — require a justification when the
// listed fields change; the reason lands on the activity row + revision trail.
function ChangeReasonSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const { data: col } = useQuery({
    queryKey: ['collection-meta-cr', tableName],
    queryFn: () =>
      api
        .get<{
          data: {
            change_reason_config: {
              fields?: string[]
              reasons?: string[]
              allow_free_text?: boolean
            } | null
            fields?: { field: string; label?: string | null; hidden?: boolean }[]
          }
        }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 60 * 1000
  })
  const cfg = col?.change_reason_config ?? null
  const [fieldsDraft, setFieldsDraft] = useState('')
  const [reasonsDraft, setReasonsDraft] = useState('')
  const [freeText, setFreeText] = useState(true)
  const [init, setInit] = useState(false)
  useEffect(() => {
    if (col !== undefined && !init) {
      setFieldsDraft((cfg?.fields ?? []).join(', '))
      setReasonsDraft((cfg?.reasons ?? []).join('\n'))
      setFreeText(cfg?.allow_free_text !== false)
      setInit(true)
    }
  }, [col, init, cfg])

  const save = async () => {
    const fields = fieldsDraft
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)
    const reasons = reasonsDraft
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
    const body = fields.length > 0 ? { fields, reasons, allow_free_text: freeText } : null
    await api.patch(`/collections/${tableName}`, { change_reason_config: body })
    qc.invalidateQueries({ queryKey: ['collection-meta-cr', tableName] })
    toast.success(
      fields.length > 0 ? 'Change-reason requirement saved' : 'Change-reason requirement removed'
    )
  }

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='px-4 py-3 space-y-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Change reason</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            When any of the listed fields is edited, the user must supply a justification before the
            save goes through. The reason is stored on the activity entry and shows in the revision
            history. Leave the field list empty to disable.
          </p>
        </div>
        <div>
          <p className='mb-1 text-[12.5px] font-medium text-slate-700'>Fields (comma-separated)</p>
          <Input
            value={fieldsDraft}
            onChange={(e) => setFieldsDraft(e.target.value)}
            placeholder='january, february, march, total'
            className='h-8 text-[12px] font-mono'
          />
        </div>
        <div>
          <p className='mb-1 text-[12.5px] font-medium text-slate-700'>
            Preset reasons (one per line)
          </p>
          <textarea
            value={reasonsDraft}
            onChange={(e) => setReasonsDraft(e.target.value)}
            rows={4}
            placeholder={'Material lead time shifted\nProject resequenced\nVendor delay'}
            className='w-full rounded-md border border-slate-200 px-3 py-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#00ceff]'
          />
        </div>
        <div className='flex items-center justify-between gap-4'>
          <div>
            <p className='text-[12.5px] font-medium text-slate-700'>Allow free text</p>
            <p className='text-[11.5px] text-slate-500'>Let users type their own justification</p>
          </div>
          <Switch checked={freeText} onCheckedChange={setFreeText} />
        </div>
        <div className='flex justify-end'>
          <Button size='sm' onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

// nivaro_collections.browser_config — CollectionBrowserView behavior:
// checkbox selection, row actions, create button, page size, quick filters.

interface BrowserConfig {
  checkbox_selection?: boolean
  show_actions?: boolean
  allow_create?: boolean
  copy_as?: boolean
  page_size?: number
  quick_filters?: unknown[]
  default_sort?: string
  /** Record workspace tabs in the portal: open records stack as tabs above
   *  the form, unsaved edits survive switching. Opt-in. */
  record_tabs?: boolean
  /** Registry bulk actions (keys) the bar shows; null/absent = all. */
  bulk_actions?: string[] | null
  /** #2490 — live record events: on (default), batched id lists, or off (lists poll). */
  live_events?: 'on' | 'batched' | 'off'
  /** List search (`?search=`) only over these columns; absent = every string/text field. */
  search_fields?: string[]
  /** Search item 23 — extra text fields a labels-only global search also matches. */
  label_search_fields?: string[]
  /** Keys edited elsewhere (export_filename, fulfilment, …) ride along untouched. */
  [key: string]: unknown
}

// #620 — custom collection empty state. (The slug picker that briefly lived
// here merged into the URL alias card — one engine for human record URLs.)
function EmptyStateSlugSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const { data: col } = useQuery({
    queryKey: ['collection-meta-es', tableName],
    queryFn: () =>
      api
        .get<{
          data: {
            empty_state?: {
              title?: string
              message?: string
              cta_label?: string
              cta_url?: string
            } | null
          }
        }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName
  })
  const [draft, setDraft] = useState<{
    title: string
    message: string
    cta_label: string
    cta_url: string
  } | null>(null)
  const es = col?.empty_state ?? {}
  const eff = draft ?? {
    title: es.title ?? '',
    message: es.message ?? '',
    cta_label: es.cta_label ?? '',
    cta_url: es.cta_url ?? ''
  }
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/collections/${tableName}`, body),
    onSuccess: () => {
      toast.success('Saved')
      setDraft(null)
      void qc.invalidateQueries({ queryKey: ['collection-meta-es', tableName] })
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Save failed'
      )
  })
  return (
    <div className='mt-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>Empty state</p>
      <p className='mt-0.5 text-[11.5px] text-slate-400'>
        Replaces the default &quot;no records&quot; panel when the collection has no rows — say what
        this collection is for and where to start. (Human record URLs live in the URL alias card
        above.)
      </p>
      <div className='mt-3 space-y-2'>
        {(
          [
            ['title', 'Empty title', 'Nothing here yet'],
            ['message', 'Message', 'What this collection is for and where to start'],
            ['cta_label', 'Button label', 'Create the first record'],
            ['cta_url', 'Button URL', `/collections/${tableName}/new or https://…`]
          ] as const
        ).map(([key, label, ph]) => (
          <div key={key} className='flex items-center gap-2'>
            <span className='w-24 shrink-0 text-[11.5px] text-slate-500'>{label}</span>
            <Input
              value={eff[key]}
              placeholder={ph}
              onChange={(e) => setDraft({ ...eff, [key]: e.target.value })}
              className='h-7 text-[12px]'
            />
          </div>
        ))}
        {draft && (
          <div className='flex justify-end gap-2 pt-1'>
            <Button
              size='sm'
              variant='ghost'
              className='h-7 text-[11.5px]'
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Button
              size='sm'
              className='h-7 text-[11.5px]'
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  empty_state:
                    eff.title || eff.message || eff.cta_label
                      ? {
                          title: eff.title || null,
                          message: eff.message || null,
                          cta_label: eff.cta_label || null,
                          cta_url: eff.cta_url || null
                        }
                      : null
                })
              }
            >
              Save empty state
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

const LIVE_EVENT_CHOICES: Array<{ value: 'on' | 'batched' | 'off'; label: string; hint: string }> =
  [
    {
      value: 'on',
      label: 'Every change',
      hint: 'Open lists and records hear each change the moment it is saved.'
    },
    {
      value: 'batched',
      label: 'Batched',
      hint: 'Changes are gathered for 2 seconds and sent as one list of ids — for collections that change in bursts.'
    },
    {
      value: 'off',
      label: 'Off',
      hint: 'No live updates for this collection; lists refresh every 30 seconds instead. For import staging tables and other rows nobody watches live.'
    }
  ]

/** #2490 — the collection's live record events: every change, batched id lists, or none. */
// browser_config.search_fields — which columns a list search reads. Every
// string/text field by default; long narrative columns make each search read
// every LOB page (EFP workflows: 2.4 s → 1.2 s with the key columns only).
function SearchFieldsSetting({
  fields,
  value,
  onChange
}: {
  fields: Array<{ field: string; type: string }>
  value: string[] | undefined
  onChange: (next: string[] | undefined) => void
}) {
  const id = useId()
  const textFields = fields.filter((f) => f.type === 'string' || f.type === 'text')
  const explicit = Array.isArray(value) && value.length > 0
  if (textFields.length === 0) return null
  return (
    <div className='space-y-1.5'>
      <div>
        <p className='text-[12.5px] font-medium text-slate-700'>Search columns</p>
        <p className='text-[11.5px] text-slate-500'>
          What the list search box matches. Leave long notes and descriptions out on big tables —
          each one makes every search slower
        </p>
      </div>
      <label
        htmlFor={`sf-all-${id}`}
        className='flex items-center gap-2 text-[12px] text-slate-600'
      >
        <Switch
          id={`sf-all-${id}`}
          checked={!explicit}
          onCheckedChange={(all) =>
            onChange(
              all ? undefined : textFields.filter((f) => f.type === 'string').map((f) => f.field)
            )
          }
        />
        Search every text field
      </label>
      {explicit && (
        <div className='flex flex-wrap gap-x-4 gap-y-1 pl-1'>
          {textFields.map((f) => (
            <label
              key={f.field}
              htmlFor={`sf-pick-${id}-${f.field}`}
              className='flex cursor-pointer items-center gap-1.5 text-[12.5px] text-slate-700'
            >
              <Checkbox
                id={`sf-pick-${id}-${f.field}`}
                checked={value!.includes(f.field)}
                onCheckedChange={(on) => {
                  const next = on ? [...value!, f.field] : value!.filter((k) => k !== f.field)
                  // Unticking the last one means "every field", never "none".
                  onChange(next.length ? next : undefined)
                }}
              />
              <span className='font-mono text-[12px]'>{f.field}</span>
              {f.type === 'text' && <span className='text-[10.5px] text-slate-400'>long text</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function LiveEventsSetting({
  value,
  onChange
}: {
  value: 'on' | 'batched' | 'off'
  onChange: (v: 'on' | 'batched' | 'off') => void
}) {
  const current = LIVE_EVENT_CHOICES.find((c) => c.value === value) ?? LIVE_EVENT_CHOICES[0]
  return (
    <div className='flex items-start justify-between gap-4' data-live-events={value}>
      <div className='min-w-0'>
        <p className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
          Live updates
        </p>
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>{current.hint}</p>
      </div>
      <fieldset className='inline-flex shrink-0 rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-border dark:bg-muted/40'>
        <legend className='sr-only'>Live updates</legend>
        {LIVE_EVENT_CHOICES.map((c) => (
          <button
            key={c.value}
            type='button'
            aria-pressed={value === c.value}
            onClick={() => value !== c.value && onChange(c.value)}
            className={cn(
              'rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
              value === c.value
                ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
                : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
            )}
          >
            {c.label}
          </button>
        ))}
      </fieldset>
    </div>
  )
}

function BrowserSettingsSection({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const { data: col } = useQuery({
    queryKey: ['collection-meta', tableName],
    queryFn: () =>
      api
        .get<{
          data: {
            browser_config: BrowserConfig | null
            color?: string | null
            display_template?: string | null
            fields?: Array<{ field: string; type: string }>
          }
        }>(`/collections/${tableName}`)
        .then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 10 * 60 * 1000
  })
  const cfg = col?.browser_config ?? {}
  const [pageSize, setPageSize] = useState('')
  const [defaultSort, setDefaultSort] = useState('')
  const [accentColor, setAccentColor] = useState('')
  const [qfRows, setQfRows] = useState<QuickFilterDef[]>([])
  const [qfDirty, setQfDirty] = useState(false)
  const [initialised, setInitialised] = useState(false)
  useEffect(() => {
    if (col !== undefined && !initialised) {
      setPageSize(cfg.page_size ? String(cfg.page_size) : '')
      setDefaultSort(cfg.default_sort ?? '')
      setAccentColor((col as { color?: string | null } | undefined)?.color ?? '')
      setQfRows((cfg.quick_filters ?? []) as QuickFilterDef[])
      setInitialised(true)
    }
  }, [col, initialised, cfg])

  const patch = async (partial: BrowserConfig) => {
    const next = { ...cfg, ...partial }
    // Drop defaults so the stored JSON stays minimal. Keys this card does not edit
    // (export_filename, fulfilment, …) are kept as they are.
    const OWN = new Set([
      'checkbox_selection',
      'show_actions',
      'allow_create',
      'copy_as',
      'page_size',
      'quick_filters',
      'default_sort',
      'record_tabs',
      'bulk_actions',
      'live_events',
      'search_fields',
      'label_search_fields'
    ])
    const clean: BrowserConfig = {}
    for (const [k, v] of Object.entries(next)) if (!OWN.has(k) && v !== undefined) clean[k] = v
    if (next.checkbox_selection === false) clean.checkbox_selection = false
    if (next.show_actions === false) clean.show_actions = false
    if (next.allow_create === false) clean.allow_create = false
    if (next.copy_as === false) clean.copy_as = false
    if (next.page_size && next.page_size > 0) clean.page_size = next.page_size
    if (next.quick_filters?.length) clean.quick_filters = next.quick_filters
    if (next.default_sort?.trim()) clean.default_sort = next.default_sort.trim()
    if (next.record_tabs === true) clean.record_tabs = true
    if (Array.isArray(next.bulk_actions)) clean.bulk_actions = next.bulk_actions
    if (next.live_events === 'batched' || next.live_events === 'off')
      clean.live_events = next.live_events
    if (next.search_fields?.length) clean.search_fields = next.search_fields
    if (next.label_search_fields?.length) clean.label_search_fields = next.label_search_fields
    await api.patch(`/collections/${tableName}`, {
      browser_config: Object.keys(clean).length > 0 ? clean : null
    })
    qc.invalidateQueries({ queryKey: ['collection-meta', tableName] })
    toast.success('Browser settings saved')
  }

  const row = (
    label: string,
    desc: string,
    key: 'checkbox_selection' | 'show_actions' | 'allow_create' | 'copy_as'
  ) => (
    <div className='flex items-center justify-between gap-4'>
      <div>
        <p className='text-[12.5px] font-medium text-slate-700'>{label}</p>
        <p className='text-[11.5px] text-slate-500'>{desc}</p>
      </div>
      <Switch checked={cfg[key] !== false} onCheckedChange={(v) => void patch({ [key]: v })} />
    </div>
  )

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='px-4 py-3 space-y-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-800'>Collection Browser</p>
          <p className='mt-0.5 text-[12px] text-slate-500'>
            Behavior of the embeddable collection browser (CollectionBrowserView) for this
            collection. Also editable via{' '}
            <code className='text-[11px]'>PATCH /collections/{tableName}</code> with{' '}
            <code className='text-[11px]'>browser_config</code>.
          </p>
        </div>
        {row('Row selection', 'Checkbox column + bulk actions bar', 'checkbox_selection')}
        {cfg.checkbox_selection !== false && (
          <div className='ml-4 border-l-2 border-slate-100 pl-3'>
            <p className='text-[12px] font-medium text-slate-600'>Bulk actions shown</p>
            <div className='mt-1'>
              <BulkActionsPicker
                collections={[tableName]}
                value={cfg.bulk_actions ?? null}
                onChange={(next) => void patch({ bulk_actions: next })}
              />
            </div>
          </div>
        )}
        {row(
          'Row actions menu',
          'Per-row Actions dropdown (transitions, audit log…)',
          'show_actions'
        )}
        {row('New item button', 'Allow creating records from the browser', 'allow_create')}
        {row(
          'Copy as… button',
          'Copy the list or a record as curl / SDK / GraphQL. Administrators only; off hides it for them too',
          'copy_as'
        )}
        <div className='flex items-center justify-between gap-4'>
          <div>
            <p className='text-[12.5px] font-medium text-slate-700'>Record workspace tabs</p>
            <p className='text-[11.5px] text-slate-500'>
              Portal record pages stack open records as tabs — unsaved edits survive switching
            </p>
          </div>
          <Switch
            checked={cfg.record_tabs === true}
            onCheckedChange={(v) => void patch({ record_tabs: v })}
          />
        </div>
        <LiveEventsSetting
          value={cfg.live_events ?? 'on'}
          onChange={(v) => void patch({ live_events: v })}
        />
        <SearchFieldsSetting
          fields={col?.fields ?? []}
          value={cfg.search_fields}
          onChange={(v) => void patch({ search_fields: v })}
        />
        <LabelSearchFieldsSetting
          fields={col?.fields ?? []}
          displayTemplate={col?.display_template}
          value={cfg.label_search_fields}
          onChange={(v) => void patch({ label_search_fields: v })}
        />
        <div className='flex items-center justify-between gap-4'>
          <div>
            <p className='text-[12.5px] font-medium text-slate-700'>Page size</p>
            <p className='text-[11.5px] text-slate-500'>Rows per page (default 25, max 200)</p>
          </div>
          <Input
            type='number'
            value={pageSize}
            onChange={(e) => setPageSize(e.target.value)}
            onBlur={() => {
              const n = Number(pageSize)
              void patch({ page_size: n > 0 ? Math.min(n, 200) : undefined })
            }}
            placeholder='25'
            className='h-7 w-20 text-[12px]'
          />
        </div>
        <div className='flex items-center justify-between gap-4'>
          <div>
            <p className='text-[12.5px] font-medium text-slate-700'>Default sort</p>
            <p className='text-[11.5px] text-slate-500'>
              Field name, '-' prefix for descending (e.g. <code>-created</code>) — applied when the
              viewer has no view or sort of their own
            </p>
          </div>
          <Input
            value={defaultSort}
            onChange={(e) => setDefaultSort(e.target.value)}
            onBlur={() => void patch({ default_sort: defaultSort.trim() || undefined })}
            placeholder='-created'
            className='h-7 w-36 font-mono text-[12px]'
          />
        </div>
        <div className='flex items-center justify-between gap-4'>
          <div>
            <p className='text-[12.5px] font-medium text-slate-700'>Accent color</p>
            <p className='text-[11.5px] text-slate-500'>
              Identity chip in the browser toolbar — tells this collection's tabs apart at a glance
            </p>
          </div>
          <div className='flex items-center gap-1.5'>
            <input
              type='color'
              value={/^#[0-9a-fA-F]{6}$/.test(accentColor) ? accentColor : '#00ceff'}
              onChange={(e) => setAccentColor(e.target.value)}
              className='h-7 w-9 cursor-pointer rounded border border-slate-200 bg-white p-0.5'
              aria-label='Accent color'
            />
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='h-7 text-[11.5px]'
              onClick={() => {
                void api
                  .patch(`/collections/${tableName}`, { color: accentColor || null })
                  .then(() => {
                    qc.invalidateQueries({ queryKey: ['collection-meta', tableName] })
                    toast.success('Accent color saved')
                  })
              }}
            >
              Save
            </Button>
            {accentColor && (
              <button
                type='button'
                onClick={() => {
                  setAccentColor('')
                  void api.patch(`/collections/${tableName}`, { color: null }).then(() => {
                    qc.invalidateQueries({ queryKey: ['collection-meta', tableName] })
                  })
                }}
                className='text-[11px] text-slate-400 hover:text-red-500'
              >
                Clear
              </button>
            )}
          </div>
        </div>
        <div>
          <p className='text-[12.5px] font-medium text-slate-700'>Quick filters</p>
          <p className='mb-1.5 text-[11.5px] text-slate-500'>
            Facet dropdowns above the table. Drag to reorder — that is the order they appear in.
          </p>
          <QuickFiltersEditor
            collection={tableName}
            value={qfRows}
            onChange={(next) => {
              setQfRows(next)
              setQfDirty(true)
            }}
          />
          {qfDirty && (
            <div className='mt-2 flex items-center gap-2'>
              <Button
                size='sm'
                className='h-7 text-[12px]'
                onClick={async () => {
                  // Incomplete rows would render a dropdown that filters
                  // nothing, so they are dropped rather than saved half-built.
                  const clean = qfRows.filter(
                    (f) =>
                      f.key?.trim() &&
                      f.label?.trim() &&
                      f.collection?.trim() &&
                      f.label_field?.trim() &&
                      (f.path?.length || f.or_paths?.some((p) => p.length))
                  )
                  await patch({ quick_filters: clean.length > 0 ? clean : undefined })
                  setQfRows(clean)
                  setQfDirty(false)
                }}
              >
                Save quick filters
              </Button>
              <span className='text-[11px] text-slate-400'>
                {qfRows.length} filter{qfRows.length === 1 ? '' : 's'} — unsaved
              </span>
            </div>
          )}
        </div>
      </div>
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
  review_enabled?: boolean
  duplicate_detection_enabled: boolean
  document_autofill?: boolean
  autofill_hints?: string | null
  autofill_keyed_hints?: Array<{ field: string; match: string; hints: string }>
  autofill_thresholds?: Record<string, number>
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
  const [reviewEnabled, setReviewEnabled] = useState(false)
  const [dupEnabled, setDupEnabled] = useState(false)
  const [dupThreshold, setDupThreshold] = useState(0.85)
  const [docAutofill, setDocAutofill] = useState(false)
  const [autofillHints, setAutofillHints] = useState('')
  const [keyedHints, setKeyedHints] = useState<
    Array<{ field: string; match: string; hints: string }>
  >([])
  const [askThreshold, setAskThreshold] = useState('')
  const [fieldThresholds, setFieldThresholds] = useState<Array<{ field: string; value: string }>>(
    []
  )
  const [seeded, setSeeded] = useState(false)

  useEffect(() => {
    if (settings && !seeded) {
      setValidationEnabled(settings.validation_enabled)
      setReviewEnabled(!!settings.review_enabled)
      setValidationMode(settings.validation_mode)
      setRules(settings.validation_rules)
      setDupEnabled(settings.duplicate_detection_enabled)
      setDupThreshold(settings.duplicate_threshold)
      setDocAutofill(!!settings.document_autofill)
      setAutofillHints(settings.autofill_hints ?? '')
      setKeyedHints(settings.autofill_keyed_hints ?? [])
      const th = settings.autofill_thresholds ?? {}
      setAskThreshold(th._default == null ? '' : String(Math.round(th._default * 100)))
      setFieldThresholds(
        Object.entries(th)
          .filter(([k]) => k !== '_default')
          .map(([field, v]) => ({ field, value: String(Math.round(v * 100)) }))
      )
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
        review_enabled: reviewEnabled,
        duplicate_detection_enabled: dupEnabled,
        duplicate_threshold: Number(dupThreshold),
        document_autofill: docAutofill,
        autofill_hints: autofillHints.trim() || null,
        autofill_keyed_hints: keyedHints.filter((k) => k.field && k.match && k.hints),
        autofill_thresholds: (() => {
          const out: Record<string, number> = {}
          const d = Number(askThreshold)
          if (askThreshold.trim() !== '' && Number.isFinite(d))
            out._default = Math.min(1, Math.max(0, d / 100))
          for (const t of fieldThresholds) {
            const n = Number(t.value)
            if (t.field.trim() && t.value.trim() !== '' && Number.isFinite(n))
              out[t.field.trim()] = Math.min(1, Math.max(0, n / 100))
          }
          return out
        })()
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
          {/* Separate from the save-time check below: rules can back a review
              people ASK for without one running on every save. */}
          <div className='flex items-center gap-3'>
            <Switch
              id='ai-document-autofill'
              checked={docAutofill}
              onCheckedChange={setDocAutofill}
              data-ai-document-autofill
            />
            <Label htmlFor='ai-document-autofill' className='cursor-pointer text-[12px]'>
              Fill from document
            </Label>
            <span className='text-[11px] text-slate-400'>
              New-record form offers an upload (SOW, quote, spreadsheet) and proposes fields + lines
              to review
            </span>
          </div>
          {docAutofill && (
            <div
              className='space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/30'
              data-ai-autofill-config
            >
              <div>
                <Label className='mb-1 block text-[12px]'>Hints for the reader</Label>
                <Textarea
                  value={autofillHints}
                  onChange={(e) => setAutofillHints(e.target.value)}
                  rows={3}
                  className='text-[12px]'
                  placeholder='e.g. The fee table lists monthly amounts; the term is in section 3; "PO" in a quote means the customer reference, not ours.'
                  data-ai-autofill-hints
                />
                <p className='mt-1 text-[11px] text-slate-400'>
                  Plain sentences the model reads before every document of this collection.
                </p>
              </div>
              <div>
                <Label className='mb-1 block text-[12px]'>
                  Hints for a particular vendor, project type…
                </Label>
                <div className='space-y-1.5'>
                  {keyedHints.map((k, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: editable rows
                    <div
                      key={i}
                      className='grid grid-cols-[120px_140px_1fr_auto] items-start gap-1.5'
                    >
                      <Input
                        value={k.field}
                        onChange={(e) =>
                          setKeyedHints((l) =>
                            l.map((x, j) => (j === i ? { ...x, field: e.target.value } : x))
                          )
                        }
                        placeholder='field (vendor)'
                        className='h-7 font-mono text-[11px]'
                      />
                      <Input
                        value={k.match}
                        onChange={(e) =>
                          setKeyedHints((l) =>
                            l.map((x, j) => (j === i ? { ...x, match: e.target.value } : x))
                          )
                        }
                        placeholder='label contains…'
                        className='h-7 text-[11px]'
                      />
                      <Input
                        value={k.hints}
                        onChange={(e) =>
                          setKeyedHints((l) =>
                            l.map((x, j) => (j === i ? { ...x, hints: e.target.value } : x))
                          )
                        }
                        placeholder='their SOWs list rates in an appendix table'
                        className='h-7 text-[11px]'
                      />
                      <button
                        type='button'
                        onClick={() => setKeyedHints((l) => l.filter((_, j) => j !== i))}
                        className='h-7 px-1 text-[12px] text-slate-400 hover:text-red-500'
                        aria-label='Remove hint'
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type='button'
                    onClick={() =>
                      setKeyedHints((l) => [...l, { field: '', match: '', hints: '' }])
                    }
                    className='text-[11.5px] text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
                    data-ai-autofill-add-keyed
                  >
                    + Add a keyed hint
                  </button>
                </div>
                <p className='mt-1 text-[11px] text-slate-400'>
                  Once the named field resolves to a record whose label contains the text, these
                  hints join the run.
                </p>
              </div>
              <div>
                <Label className='mb-1 block text-[12px]'>Confidence needed to fill a field</Label>
                <div className='flex flex-wrap items-center gap-2'>
                  <Input
                    value={askThreshold}
                    onChange={(e) => setAskThreshold(e.target.value)}
                    placeholder='40'
                    inputMode='numeric'
                    className='h-7 w-20 text-[12px]'
                    data-ai-autofill-threshold
                  />
                  <span className='text-[11px] text-slate-500'>
                    % by default; below it the value is offered as an ask, not filled
                  </span>
                </div>
                <div className='mt-1.5 space-y-1.5'>
                  {fieldThresholds.map((t, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: editable rows
                    <div key={i} className='flex items-center gap-1.5'>
                      <Input
                        value={t.field}
                        onChange={(e) =>
                          setFieldThresholds((l) =>
                            l.map((x, j) => (j === i ? { ...x, field: e.target.value } : x))
                          )
                        }
                        placeholder='field'
                        className='h-7 w-44 font-mono text-[11px]'
                      />
                      <Input
                        value={t.value}
                        onChange={(e) =>
                          setFieldThresholds((l) =>
                            l.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))
                          )
                        }
                        placeholder='80'
                        inputMode='numeric'
                        className='h-7 w-16 text-[11px]'
                      />
                      <span className='text-[11px] text-slate-500'>%</span>
                      <button
                        type='button'
                        onClick={() => setFieldThresholds((l) => l.filter((_, j) => j !== i))}
                        className='h-7 px-1 text-[12px] text-slate-400 hover:text-red-500'
                        aria-label='Remove threshold'
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type='button'
                    onClick={() => setFieldThresholds((l) => [...l, { field: '', value: '' }])}
                    className='text-[11.5px] text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
                    data-ai-autofill-add-threshold
                  >
                    + Per-field threshold
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className='flex items-center gap-3'>
            <Switch
              id='ai-review-enabled'
              checked={reviewEnabled}
              onCheckedChange={setReviewEnabled}
            />
            <Label htmlFor='ai-review-enabled' className='cursor-pointer text-[12px]'>
              AI Review button
            </Label>
            <span className='text-[11px] text-slate-400'>
              Offers a review on the record, run on demand — never on save
            </span>
          </div>
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

          {/* Rules feed BOTH the save-time check and the on-demand button, so
              they stay visible whenever either is on — hiding them behind the
              save-time switch made 'rules but no automatic run' unreachable. */}
          {(validationEnabled || reviewEnabled) && (
            <div className='space-y-3 pl-1'>
              {/* Mode describes the save-time check only. */}
              {validationEnabled && (
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
              )}

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

// ─── Layouts tab ─────────────────────────────────────────────────────────────

/**
 * The Layouts tab: "Which form does each record get?" first (LayoutOverview),
 * `?layout=<id>` opens the editor.
 */
function LayoutsHost({ tableName }: { tableName: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null)
  const layoutId = num(searchParams.get('layout'))
  const go = (next: { layout?: number | null }, replace = false) =>
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        p.set('tab', 'groups')
        p.delete('layout')
        p.delete('classic')
        if (next.layout != null) p.set('layout', String(next.layout))
        return p
      },
      { replace }
    )

  let body: ReactNode
  if (layoutId != null) {
    body = (
      <LayoutEditor
        key={tableName}
        collection={tableName}
        layoutId={layoutId}
        mode='page'
        onBack={() => go({})}
        onLayoutChange={(id) => go({ layout: id }, true)}
      />
    )
  } else {
    body = (
      <LayoutOverview
        collection={tableName}
        onOpen={(id) => go({ layout: id })}
        onCreate={(_type, id) => go({ layout: id })}
      />
    )
  }
  // The shared editor's NivaroProvider is AppLayout's (HelpVideoHost wraps every page).
  return <AdminLayoutEditorHost collection={tableName}>{body}</AdminLayoutEditorHost>
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
    qc.invalidateQueries({ queryKey: ['layout-field-config', tableName] })
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
  onSave,
  collection,
  field
}: {
  current: Array<{ type: string; value?: string; message?: string }>
  onSave: (rules: Array<{ type: string; value?: string; message?: string }>) => void
  collection?: string
  field?: string
}) {
  const [rules, setRules] = useState(
    current.length ? current : [{ type: 'min_length', value: '', message: '' }]
  )
  const [impact, setImpact] = useState<{
    scanned: number
    newly_failing: number
    newly_passing: number
    samples: Array<{ id: string | number; label: string; message: string }>
  } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewImpact = async () => {
    if (!collection || !field) return
    setPreviewing(true)
    setImpact(null)
    try {
      const r = await api.post('/config-conformance/impact', {
        collection,
        field,
        proposed_rules: rules.filter((x) => x.type)
      })
      setImpact(r.data.data)
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Preview failed'
      )
    } finally {
      setPreviewing(false)
    }
  }

  // Regex preset library (#391): the patterns people reach for — picking one
  // fills the pattern AND a default message (kept if the author already wrote one).
  const REGEX_PRESETS = [
    {
      value: 'phone_us',
      label: 'US phone',
      pattern: '^\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}$',
      message: 'Enter a 10-digit US phone number'
    },
    {
      value: 'zip_us',
      label: 'US ZIP',
      pattern: '^\\d{5}(-\\d{4})?$',
      message: 'Enter a 5-digit ZIP (or ZIP+4)'
    },
    {
      value: 'email',
      label: 'Email',
      pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
      message: 'Enter a valid email address'
    },
    {
      value: 'url_https',
      label: 'HTTPS URL',
      pattern: '^https://\\S+$',
      message: 'Enter a full https:// link'
    },
    {
      value: 'uuid',
      label: 'UUID',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      message: 'Enter a valid UUID'
    },
    { value: 'digits', label: 'Digits only', pattern: '^\\d+$', message: 'Digits only' },
    {
      value: 'alnum',
      label: 'Letters & numbers',
      pattern: '^[A-Za-z0-9]+$',
      message: 'Letters and numbers only'
    },
    {
      value: 'currency',
      label: 'Dollar amount',
      pattern: '^\\$?\\d{1,3}(,?\\d{3})*(\\.\\d{2})?$',
      message: 'Enter a dollar amount'
    },
    {
      value: 'ein',
      label: 'EIN (tax id)',
      pattern: '^\\d{2}-\\d{7}$',
      message: 'Enter an EIN like 12-3456789'
    },
    {
      value: 'po_number',
      label: 'PO number (alnum-dash)',
      pattern: '^[A-Z0-9][A-Z0-9-]{2,}$',
      message: 'Uppercase letters, numbers, dashes'
    }
  ]

  const RULE_TYPES = [
    { value: 'min_length', label: 'Min length' },
    { value: 'max_length', label: 'Max length' },
    { value: 'regex', label: 'Regex pattern' },
    { value: 'email', label: 'Email address' },
    { value: 'phone', label: 'Phone number' },
    { value: 'required_if', label: 'Required if…' },
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
              className={
                rule.type === 'regex' ? 'h-7 w-52 font-mono text-[12px]' : 'h-7 text-[12px] w-28'
              }
            />
          )}
          {rule.type === 'regex' && (
            <Combobox
              value=''
              onChange={(v) => {
                const preset = REGEX_PRESETS.find((r) => r.value === v)
                if (preset)
                  updateRule(idx, {
                    value: preset.pattern,
                    message: rule.message || preset.message
                  })
              }}
              options={REGEX_PRESETS.map((r) => ({ value: r.value, label: r.label }))}
              placeholder='Presets…'
            />
          )}
          {rule.type === 'required_if' && (
            <>
              <Input
                value={(rule as { field?: string }).field ?? ''}
                onChange={(e) => updateRule(idx, { field: e.target.value } as never)}
                placeholder='other field'
                className='h-7 w-32 font-mono text-[12px]'
              />
              <Combobox
                value={(rule as { op?: string }).op ?? 'eq'}
                onChange={(v) => updateRule(idx, { op: v } as never)}
                options={[
                  { value: 'eq', label: 'equals' },
                  { value: 'neq', label: 'not equals' },
                  { value: 'in', label: 'in list' },
                  { value: 'nnull', label: 'is set' },
                  { value: 'null', label: 'is empty' }
                ]}
              />
              {['eq', 'neq', 'in'].includes((rule as { op?: string }).op ?? 'eq') && (
                <Input
                  value={rule.value ?? ''}
                  onChange={(e) => updateRule(idx, { value: e.target.value })}
                  placeholder='value'
                  className='h-7 w-24 text-[12px]'
                />
              )}
            </>
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
        <div className='flex items-center gap-2'>
          {collection && field && (
            <button
              type='button'
              disabled={previewing}
              onClick={() => void previewImpact()}
              className='h-7 rounded-md border border-slate-200 px-2.5 text-[12px] text-slate-600 hover:border-slate-300 disabled:opacity-50'
            >
              {previewing ? 'Checking…' : 'Preview impact'}
            </button>
          )}
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
      {impact && (
        <div
          className={cn(
            'rounded-md border px-3 py-2 text-[12px]',
            impact.newly_failing > 0
              ? 'border-amber-200 bg-amber-50 text-amber-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          )}
        >
          <p className='font-medium'>
            {impact.newly_failing > 0
              ? `${impact.newly_failing} of ${impact.scanned} existing records would NEWLY fail these rules`
              : `No existing records newly fail (${impact.scanned} checked)`}
            {impact.newly_passing > 0 && ` · ${impact.newly_passing} would newly pass`}
          </p>
          {impact.samples.length > 0 && (
            <ul className='mt-1 space-y-0.5'>
              {impact.samples.slice(0, 5).map((sm) => (
                <li key={String(sm.id)} className='text-[11.5px]'>
                  <span className='font-mono'>{sm.label}</span> — {sm.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
                  collection={tableName}
                  field={f.field}
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
  const goBack = useGoBack('/collections')
  const qc = useQueryClient()
  const [tab, setTab] = usePersistedTab<Tab>(`nvr_tab_tableeditor_${table ?? ''}`, 'fields')
  // Deep links (config review findings) open a named tab: ?tab=rules.
  const [searchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  useEffect(() => {
    const known: Tab[] = [
      'fields',
      'relations',
      'attributes',
      'groups',
      'behavior',
      'rules',
      'imports',
      'tree',
      'content',
      'settings'
    ]
    if (tabParam && known.includes(tabParam as Tab)) setTab(tabParam as Tab)
  }, [tabParam, setTab])
  // ?layout=<id> (the editor) always lands on the Layouts tab.
  const layoutParam = searchParams.get('layout')
  useEffect(() => {
    if (layoutParam) setTab('groups')
  }, [layoutParam, setTab])
  const editorOpen = tab === 'groups' && /^\d+$/.test(searchParams.get('layout') ?? '')
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
      navigate('/collections')
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
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-6 py-3.5 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2 text-[13px]'>
            <Link
              to='/collections'
              onClick={(e) => {
                e.preventDefault()
                goBack()
              }}
              className='flex items-center gap-1 text-slate-400 transition-colors hover:text-slate-700'
            >
              <ArrowLeft className='h-3.5 w-3.5' />
              Collections
            </Link>
            <span className='text-slate-300'>/</span>
            <span className='font-mono font-medium text-slate-900'>{table}</span>
            {tableData?.registered && (
              <Badge className='border-0 bg-emerald-50 text-[10px] text-emerald-700'>
                registered
              </Badge>
            )}
            {/* #42 — who else is on this editor right now */}
            <PagePresence />
          </div>

          <div className='flex items-center gap-2'>
            {tableData && (
              <>
                {tableData.registered && (
                  <Button size='sm' variant='outline' className='h-7 text-[12px]' asChild>
                    <Link to={`/collections/${table}`}>
                      <Rows3 className='mr-1.5 h-3 w-3' />
                      Open records
                    </Link>
                  </Button>
                )}
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

      {/* Content — the layout editor fills it edge to edge and scrolls its own panes */}
      <div
        className={
          editorOpen ? 'flex min-h-0 flex-1 flex-col' : cn('p-6', tab === 'groups' && 'pb-32')
        }
      >
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
              <>
                {/* The moved layout editors show their hints with data-tip. */}
                <TipLayer />
                <LayoutsHost tableName={table ?? ''} />
              </>
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
                onGoToLayouts={() => setTab('groups')}
              />
            )}
            {tab === 'settings' && isAdmin && !isSystem && table && (
              <DataGuideCard
                collection={table}
                className='mt-6 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
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

// ─── Quick relation builders (#242 M2A / #243 multi-user) ────────────────────
function QuickRelationBuilder({
  kind,
  table,
  tables,
  onClose,
  onCreated
}: {
  kind: 'users' | 'm2a'
  table: string
  tables: string[]
  onClose: () => void
  onCreated: () => void
}) {
  const [field, setField] = useState('')
  const [allowed, setAllowed] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const submit = () => {
    setBusy(true)
    const req =
      kind === 'users'
        ? api.post(`/data-model/${table}/multi-user-field`, { field })
        : api.post(`/data-model/${table}/m2a-field`, { field, allowed_collections: allowed })
    void req
      .then(() => {
        toast.success(kind === 'users' ? 'Multi-user field created' : 'M2A relation created')
        onCreated()
      })
      .catch((err) => toast.error(err?.response?.data?.error ?? 'Create failed'))
      .finally(() => setBusy(false))
  }
  return (
    <div className='space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-border dark:bg-muted/30'>
      <p className='text-[12.5px] font-medium'>
        {kind === 'users' ? 'New multi-user field' : 'New polymorphic (M2A) relation'}
      </p>
      <p className='text-[11px] text-slate-400'>
        {kind === 'users'
          ? `Creates ${table}_<field>_users (junction to users), the relation pair and the alias field — one click, no manual junction setup.`
          : `Creates ${table}_<field> with a collection discriminator — one field linking to records of several collections.`}
      </p>
      <input
        value={field}
        onChange={(e) => setField(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
        placeholder='field name (e.g. reviewers)'
        className='h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 font-mono text-[12.5px] dark:border-border'
      />
      {kind === 'm2a' && (
        <div className='flex max-h-40 flex-wrap gap-1 overflow-y-auto'>
          {tables
            .filter((t) => !t.startsWith('nivaro_') && t !== table)
            .map((t) => (
              <button
                key={t}
                type='button'
                onClick={() =>
                  setAllowed((prev) =>
                    prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
                  )
                }
                className={
                  allowed.includes(t)
                    ? 'rounded-full bg-nvr-cyan/15 px-2 py-0.5 font-mono text-[11px] font-medium text-nvr-navy dark:text-nvr-cyan'
                    : 'rounded-full border border-slate-200 px-2 py-0.5 font-mono text-[11px] text-slate-500 hover:border-nvr-cyan/50 dark:border-border'
                }
              >
                {t}
              </button>
            ))}
        </div>
      )}
      <div className='flex justify-end gap-2'>
        <Button size='sm' variant='outline' onClick={onClose}>
          Cancel
        </Button>
        <Button
          size='sm'
          onClick={submit}
          disabled={busy || !field || (kind === 'm2a' && allowed.length === 0)}
        >
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
