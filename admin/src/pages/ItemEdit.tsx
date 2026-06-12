import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  ExternalLink,
  FunctionSquare,
  LayoutTemplate,
  Loader2,
  Info,
  Network,
  EyeOff,
  PanelRight,
  Play,
  Plus,
  Save,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { ApprovalPanel } from '@/components/approval-panel'
import { CloneDialog } from '@/components/clone-dialog'
import { RichTextEditor } from '@/components/rich-text-editor'
import { CommentPanel } from '@/components/comment-panel'
import { ErpStatusBadge } from '@/components/erp-status-badge'
import { FieldHistorySparkline } from '@/components/field-history-sparkline'
import { InlineRelationEditor } from '@/components/inline-relation-editor'
import { ItemLockBanner, useItemLock } from '@/components/item-lock-banner'
import { PipelinePanel, PipelineTransitionButtons } from '@/components/pipeline-panel'
import { RelationLabel } from '@/components/relation-label'
import { RelationPicker } from '@/components/relation-picker'
import { RevisionsPanel } from '@/components/revisions-panel'
import { TaskPanel } from '@/components/task-panel'
import { TranslationEditor } from '@/components/translation-editor'
import { TreePicker } from '@/components/tree-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { WorkflowPanel } from '@/components/workflow-panel'
import {
  type Addendum,
  api,
  type CMSField,
  type CMSRelation,
  type SubRow,
  type RecordTemplate
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import {
  extractTemplateFields,
  findM2ORelation,
  renderDisplayTemplate,
  USER_SYSTEM_COLS,
  userDisplayLabel
} from '@/lib/relations'
import { cn, resolveCollectionIcon, titleCase } from '@/lib/utils'

interface TreeConfig {
  id: number
  collection: string
  parent_field: string
  label_field: string
  order_field: string | null
  maintain_path?: boolean
}

interface HierarchyConfig {
  id: number
  name: string
  levels: {
    collection: string
    label_field: string
    parent_fk: string | null
    junction_table?: string | null
    junction_child_fk?: string | null
    junction_parent_fk?: string | null
  }[]
}

interface HierarchyAncestor {
  id: number | string
  collection: string
  label: string
  level_index: number
}

interface AiViolation {
  rule: string
  explanation: string
}

interface AiDuplicate {
  id: number | string
  score: number
  label: string
  fields?: Record<string, unknown>
}

interface AiCollectionSettings {
  collection: string
  validation_enabled: boolean
  validation_mode: 'soft' | 'hard'
  validation_rules: string[]
  duplicate_detection_enabled: boolean
  duplicate_threshold: number
}

interface SubRowTemplate {
  id: number
  name: string
  items: unknown[]
}

function toLocalDatetime(value: unknown): string {
  if (!value) return ''
  try {
    return new Date(String(value)).toISOString().slice(0, 16)
  } catch {
    return ''
  }
}

interface CascadeFilterRule {
  parent_field: string
  filter_column: string
  clear_on_parent_change?: boolean
  clear_on_unavailable?: boolean
  filter_is_m2m?: boolean
}

function getCascadeFilters(depConfig: string | null | undefined): CascadeFilterRule[] {
  if (!depConfig) return []
  try {
    const parsed = typeof depConfig === 'string' ? JSON.parse(depConfig) : depConfig
    return Array.isArray(parsed?.cascade_filters) ? (parsed.cascade_filters as CascadeFilterRule[]) : []
  } catch { return [] }
}

// Null-rendering component that fires cascade clear effects when the parent field value changes.
// Works for both M2O children (clears draft via onClear) and M2M children (onClear unstages links).
// For "clear if unavailable": fetches the related collection and removes value only if not in options.
function CascadeEffectController({
  cascadeRules,
  cascadeFilter,
  currentValue,
  relatedCollection,
  onClear,
}: {
  cascadeRules: CascadeFilterRule[]
  cascadeFilter?: Record<string, unknown>
  currentValue?: unknown
  relatedCollection?: string   // for clear_on_unavailable only
  onClear: () => void
}) {
  const cascadeFilterStr = JSON.stringify(cascadeFilter)
  // undefined = not yet seen (mount or remount) — never clear on mount/remount
  const prevFilterRef = useRef<string | undefined>(undefined)
  const handleClearRef = useRef(onClear)
  handleClearRef.current = onClear

  useEffect(() => {
    const prev = prevFilterRef.current
    prevFilterRef.current = cascadeFilterStr
    // Skip mount and remount (prev is undefined when component first renders or re-mounts after tab switch)
    if (prev === undefined) return
    // Skip if filter didn't actually change
    if (prev === cascadeFilterStr) return
    if (cascadeRules.some(r => r.clear_on_parent_change)) {
      handleClearRef.current()
    }
  // Only re-run when the filter value actually changes (parent changed)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cascadeFilterStr])

  useEffect(() => {
    if (!cascadeFilter || Object.keys(cascadeFilter).length === 0) return
    if (!cascadeRules.some(r => r.clear_on_unavailable)) return
    if (currentValue == null || !relatedCollection) return
    api.get(`/items/${relatedCollection}`, {
      params: {
        filter: JSON.stringify({ ...cascadeFilter, id: { _eq: currentValue } }),
        limit: 1, fields: 'id',
      },
    }).then(res => {
      if (((res.data.data ?? []) as unknown[]).length === 0) handleClearRef.current()
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cascadeFilterStr])

  return null
}

function FieldInput({
  field,
  value,
  onChange,
  relations,
  collection,
  id: itemId,
  cascadeFilter,
  unsatisfiedParentLabel,
  cascadeParentLabel,
  placeholder
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
  relations: CMSRelation[]
  collection: string
  id?: string
  cascadeFilter?: Record<string, unknown>
  unsatisfiedParentLabel?: string | null
  cascadeParentLabel?: string | null
  placeholder?: string | null
}) {
  const iface = field.interface ?? ''
  // Relation interfaces: anything starting with 'relation-', the legacy
  // 'select-multiple-m2m' interface, or no interface at all (auto-detect).
  const isRelationInterface = !iface || iface.startsWith('relation-') || iface === 'select-multiple-m2m'
  const m2oRelation = isRelationInterface
    ? findM2ORelation(relations, collection, field.field)
    : null
  if (m2oRelation) {
    const opts = (() => { try { return typeof field.options === 'string' ? JSON.parse(field.options) : (field.options ?? {}) } catch { return {} } })()
    const inlineEdit = opts.inline_relation === true
    const hasActiveFilter = cascadeFilter && Object.keys(cascadeFilter).length > 0
    const isUnsatisfied = !!unsatisfiedParentLabel
    const picker = (
      <RelationPicker
        relatedCollection={m2oRelation.one_collection!}
        value={value}
        onChange={onChange}
        disabled={field.readonly || isUnsatisfied}
        extraFilter={hasActiveFilter ? cascadeFilter : undefined}
        placeholder={isUnsatisfied ? `Select ${unsatisfiedParentLabel} first` : undefined}
      />
    )
    return inlineEdit && !isUnsatisfied ? (
      <InlineRelationEditor relatedCollection={m2oRelation.one_collection!} relatedId={value}>
        {picker}
      </InlineRelationEditor>
    ) : picker
  }

  // M2M interface override check — skip inline picker if overridden to non-relation.
  // Don't require junction_field to be set — infer it from the companion row if
  // missing (handles DB state where the migration hasn't populated junction_field).
  const m2mRelation = (() => {
    if (!isRelationInterface) return null
    const r = relations.find(
      (rel) => rel.one_collection === collection && rel.one_field === field.field
    )
    if (!r) return null
    if (r.junction_field) return r
    const companion = relations.find(
      (c) => c.many_collection === r.many_collection && c.id !== r.id
    )
    if (!companion) return null
    return { ...r, junction_field: companion.many_field }
  })()

  if (m2mRelation) {
    if (!itemId || itemId === 'new') {
      return <p className='text-[12px] text-slate-400 py-1'>Save the record first to manage related items</p>
    }
    const hasActiveFilter = !!(cascadeFilter && Object.keys(cascadeFilter).length > 0)
    if (field.interface === 'relation-m2m') {
      return <InlineM2MPicker relation={m2mRelation} parentId={itemId} allRelations={relations} />
    }
    const fieldOpts = (() => { try { return typeof field.options === 'string' ? JSON.parse(field.options) : (field.options ?? {}) } catch { return {} } })()
    if (fieldOpts.max_values === 1) {
      return <M2MSingleSelectCombobox relation={m2mRelation} parentId={itemId} allRelations={relations} extraFilter={hasActiveFilter ? cascadeFilter : undefined} />
    }
    return <M2MMultiSelectCombobox relation={m2mRelation} parentId={itemId} allRelations={relations} extraFilter={hasActiveFilter ? cascadeFilter : undefined} />
  }

  const strVal = value === null || value === undefined ? '' : String(value)

  if (field.type === 'boolean') {
    return (
      <div className='flex items-center gap-2'>
        <input
          type='checkbox'
          id={field.field}
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className='h-4 w-4 accent-nvr-cyan rounded'
        />
        <Label htmlFor={field.field} className='font-normal cursor-pointer'>
          {value ? 'Yes' : 'No'}
        </Label>
      </div>
    )
  }

  if (field.type === 'datetime' || field.interface === 'datetime') {
    return (
      <Input
        type='datetime-local'
        value={toLocalDatetime(value)}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
      />
    )
  }

  const isNumeric = ['integer', 'bigInteger', 'float', 'decimal', 'numeric'].includes(field.type)
  if (isNumeric) {
    const isInt = field.type === 'integer' || field.type === 'bigInteger'
    return (
      <Input
        type='number'
        step={isInt ? '1' : 'any'}
        value={strVal}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        placeholder={placeholder ?? undefined}
      />
    )
  }

  if (field.type === 'json') {
    return (
      <Textarea
        className='font-mono text-xs'
        rows={4}
        value={typeof value === 'object' ? JSON.stringify(value, null, 2) : strVal}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value))
          } catch {
            onChange(e.target.value)
          }
        }}
      />
    )
  }

  if (field.interface === 'percent_complete' || field.type === 'percent_complete') {
    const pct = Math.min(100, Math.max(0, Number(value ?? 0)))
    return (
      <div className='space-y-1.5'>
        <div className='flex items-center gap-3'>
          <Input
            type='number'
            min={0}
            max={100}
            value={strVal}
            onChange={(e) => onChange(Math.min(100, Math.max(0, Number(e.target.value))))}
            className='w-20'
            disabled={field.readonly}
          />
          <span className='text-sm text-muted-foreground'>%</span>
        </div>
        <div className='h-2 w-full rounded-full bg-slate-100 overflow-hidden'>
          <div
            className={cn(
              'h-full rounded-full transition-all',
              pct >= 100 ? 'bg-emerald-500' : pct >= 50 ? 'bg-nvr-cyan' : 'bg-amber-400'
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    )
  }

  if (field.interface === 'repeater' || field.type === 'repeater') {
    const schema: Array<{ key: string; label: string; type: string }> = (() => {
      try {
        return field.repeater_schema ? JSON.parse(field.repeater_schema) : []
      } catch {
        return []
      }
    })()
    const rows: Record<string, unknown>[] = (() => {
      try {
        return Array.isArray(value) ? value : value ? JSON.parse(String(value)) : []
      } catch {
        return []
      }
    })()
    return (
      <RepeaterField
        schema={schema}
        rows={rows}
        onChange={(next) => onChange(next)}
        disabled={field.readonly}
      />
    )
  }

  if (
    field.interface === 'rich_text' ||
    field.interface === 'input-rich-text-html' ||
    field.type === 'rich_text'
  ) {
    return (
      <RichTextField
        value={typeof value === 'string' ? value : value ? JSON.stringify(value) : ''}
        onChange={onChange}
        disabled={field.readonly}
        placeholder={placeholder}
      />
    )
  }

  if (field.interface === 'sub_rows' || field.type === 'sub_rows') {
    return (
      <SubRowsField
        collection={collection}
        itemId={itemId ?? ''}
        field={field.field}
        disabled={field.readonly}
      />
    )
  }

  if (field.interface === 'input') {
    return <Input value={strVal} onChange={(e) => onChange(e.target.value || null)} placeholder={placeholder ?? undefined} />
  }

  if (field.type === 'text' || (field.interface ?? '').includes('textarea')) {
    return <Textarea value={strVal} rows={3} onChange={(e) => onChange(e.target.value || null)} placeholder={placeholder ?? undefined} />
  }

  // O2M interface: match relation by field name OR by many_collection (backward compat when one_field='id')
  if (field.type === 'o2m' || iface === 'relation-list') {
    const rel = relations.find(
      (r) => r.one_collection === collection && !r.junction_field &&
        (r.one_field === field.field || r.many_collection === field.field)
    )
    if (rel) {
      if (!itemId || itemId === 'new') {
        return <p className='text-[12px] text-slate-400 py-1'>Save the record first to manage related items</p>
      }
      return <O2MPanel relation={rel} parentId={itemId} onNavigate={() => {}} />
    }
  }

  return <Input value={strVal} onChange={(e) => onChange(e.target.value || null)} placeholder={placeholder ?? undefined} />
}

interface AttributeDef {
  id: number
  collection: string
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'date' | 'select'
  options: string[] | null
  required: boolean
  value: string | null
}

function AttributeSelect({
  value,
  options,
  onChange
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='w-full justify-between font-normal'
        >
          <span className={value ? '' : 'text-muted-foreground'}>{value || 'Select…'}</span>
          <ChevronsUpDown className='ml-1 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[--radix-popover-trigger-width] p-0' align='start'>
        <Command>
          <CommandList>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={() => {
                    onChange(opt === value ? '' : opt)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn('mr-2 h-4 w-4', value === opt ? 'opacity-100' : 'opacity-0')}
                  />
                  {opt}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function AttributeField({
  def,
  onSave,
  saving
}: {
  def: AttributeDef
  onSave: (value: unknown) => void
  saving: boolean
}) {
  const [draft, setDraft] = useState<string>(def.value ?? '')

  useEffect(() => {
    setDraft(def.value ?? '')
  }, [def.value])

  const dirty = (draft || '') !== (def.value || '')

  if (def.type === 'boolean') {
    const checked = draft === 'true'
    return (
      <div className='space-y-1.5'>
        <Label>
          {def.label}
          {def.required && <span className='text-red-500 ml-0.5'>*</span>}
        </Label>
        <div className='flex items-center gap-2'>
          <Switch
            checked={checked}
            onCheckedChange={(c) => {
              const next = c ? 'true' : 'false'
              setDraft(next)
              onSave(c)
            }}
          />
          <span className='text-sm text-muted-foreground'>{checked ? 'Yes' : 'No'}</span>
        </div>
      </div>
    )
  }

  let input: React.ReactNode
  if (def.type === 'number') {
    input = (
      <Input
        type='number'
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => dirty && onSave(draft === '' ? null : draft)}
      />
    )
  } else if (def.type === 'date') {
    input = (
      <Input
        type='date'
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => dirty && onSave(draft || null)}
      />
    )
  } else if (def.type === 'select') {
    input = (
      <AttributeSelect
        value={draft}
        options={def.options ?? []}
        onChange={(v) => {
          setDraft(v)
          onSave(v || null)
        }}
      />
    )
  } else {
    input = (
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => dirty && onSave(draft || null)}
      />
    )
  }

  return (
    <div className='space-y-1.5'>
      <div className='flex items-center gap-2'>
        <Label>
          {def.label}
          {def.required && <span className='text-red-500 ml-0.5'>*</span>}
        </Label>
        {saving && <Loader2 className='h-3 w-3 animate-spin text-slate-400' />}
      </div>
      {input}
    </div>
  )
}

const SYSTEM_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated'
])

// ── StepperStrip ─────────────────────────────────────────────────────────────

interface StepDef { key: string; label: string; icon: string | null }

function StepperStrip({
  steps,
  activeKey,
  completedKeys,
  errorKeys,
  onStep,
}: {
  steps: StepDef[]
  activeKey: string
  completedKeys: Set<string>
  errorKeys: Set<string>
  onStep: (key: string) => void
}) {
  return (
    <div className='mb-6 -mt-1 w-full'>
      <div
        className='grid w-full'
        style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}
      >
        {steps.map((step, idx) => {
          const isActive = step.key === activeKey
          const isDone = completedKeys.has(step.key) && !isActive
          const hasErr = errorKeys.has(step.key)
          return (
            <div key={step.key} className='relative flex flex-col items-center gap-1.5 px-1'>
              {/* connector line: from this step's center to the next step's center */}
              {idx < steps.length - 1 && (
                <div className='absolute top-3.5 left-1/2 w-full -translate-y-1/2 px-0' style={{ right: 0 }}>
                  <div className={cn('h-px w-full transition-colors duration-300', isDone ? 'bg-emerald-400' : 'bg-slate-200 dark:bg-border')} />
                </div>
              )}
              <button
                type='button'
                onClick={() => onStep(step.key)}
                className={cn(
                  'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00ceff] focus-visible:ring-offset-2',
                  isActive
                    ? 'border-[#00ceff] bg-[#00ceff] text-[#172940]'
                    : hasErr
                      ? 'border-red-500 bg-red-500 text-white'
                      : isDone
                        ? 'border-emerald-500 bg-emerald-500 text-white'
                        : 'border-slate-200 bg-white text-slate-400 hover:border-slate-300 dark:bg-background'
                )}
              >
                {isDone && !hasErr ? (
                  <Check className='h-3.5 w-3.5' strokeWidth={2.5} />
                ) : (
                  <span>{idx + 1}</span>
                )}
              </button>
              <span className={cn(
                'text-center text-[11px] font-medium leading-tight',
                isActive ? 'text-slate-900 dark:text-slate-100' : isDone ? 'text-slate-600 dark:text-slate-400' : 'text-slate-400'
              )}>
                {step.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── SummaryPanel ──────────────────────────────────────────────────────────────

const WYSIWYG_INTERFACES = new Set(['wysiwyg', 'rich-text', 'input-rich-text-html', 'input-rich-text-md', 'markdown'])

function SummaryFieldRow({
  f, kind, val, m2mIds, formatted, isEmpty, isRequiredEmpty,
  m2oRelMap, m2mRelMap, relations, onNavigate,
}: {
  f: { field: string; label?: string | null; required?: boolean; type?: string; interface?: string | null }
  kind: 'm2o' | 'm2m' | 'wysiwyg' | 'scalar'
  val: unknown
  m2mIds: unknown[]
  formatted: string | null
  isEmpty: boolean
  isRequiredEmpty: boolean
  m2oRelMap: Map<string, string>
  m2mRelMap: Map<string, CMSRelation>
  relations: CMSRelation[]
  onNavigate?: () => void
}) {
  const valueRef = useRef<HTMLDivElement>(null)

  function stripHtml(html: string) {
    return html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
  }

  const [copied, setCopied] = useState(false)

  function handleCopy() {
    const text = valueRef.current?.innerText?.trim() ?? ''
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  const fieldLbl = f.label || titleCase(f.field)

  return (
    <div
      onClick={() => onNavigate?.()}
      className={cn(
        'group border-b border-slate-100 px-4 py-2 transition-colors last:border-b-0 hover:bg-slate-50 dark:border-border dark:hover:bg-muted/40',
        onNavigate && 'cursor-pointer',
        isRequiredEmpty && 'bg-red-50 dark:bg-red-900/10'
      )}
    >
      <div className='flex items-center gap-1'>
        {isRequiredEmpty && <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-red-400' />}
        <span className={cn('flex-1 truncate text-[10px] font-medium', isRequiredEmpty ? 'text-red-500 dark:text-red-400' : 'text-slate-400 dark:text-slate-500')}>
          {fieldLbl}
        </span>
        {!isEmpty && (
          <button
            type='button'
            onClick={(e) => { e.stopPropagation(); handleCopy() }}
            title='Copy'
            className={cn(
            'shrink-0 rounded p-0.5 transition-all',
            copied
              ? 'opacity-100 text-emerald-500'
              : 'opacity-0 group-hover:opacity-100 text-slate-300 hover:text-slate-500 dark:hover:text-slate-300'
          )}
          >
            {copied ? (
              <Check className='h-3 w-3' strokeWidth={2.5} />
            ) : (
              <svg className='h-3 w-3' viewBox='0 0 16 16' fill='none' stroke='currentColor' strokeWidth='1.5'>
                <rect x='5' y='5' width='9' height='9' rx='1.5' />
                <path d='M3 11V3a1 1 0 011-1h8' />
              </svg>
            )}
          </button>
        )}
      </div>
      <div ref={valueRef} className='mt-0.5 text-[12px] text-slate-900 dark:text-slate-100'>
        {isEmpty ? (
          <span className='text-slate-300 dark:text-slate-600'>—</span>
        ) : kind === 'm2o' ? (
          <RelationLabel relatedCollection={m2oRelMap.get(f.field)!} id={val} />
        ) : kind === 'm2m' ? (
          <div className='flex flex-wrap gap-x-1.5 gap-y-0.5'>
            {m2mIds.map((id, i) => {
              const rel = m2mRelMap.get(f.field)!
              const farEndCol = relations.find(r => r.many_collection === rel.many_collection && r.many_field === rel.junction_field && r.id !== rel.id)?.one_collection
              return farEndCol
                ? <RelationLabel key={i} relatedCollection={farEndCol} id={id} />
                : <span key={i} className='font-mono text-[11px]'>{String(id)}</span>
            })}
          </div>
        ) : kind === 'wysiwyg' && formatted ? (
          <span className='line-clamp-3 text-[11px] leading-snug text-slate-600 dark:text-slate-300'>
            {stripHtml(formatted)}
          </span>
        ) : (
          <span className='break-words'>{formatted}</span>
        )}
      </div>
    </div>
  )
}

function SummaryPanel({
  groups,
  groupedMap,
  ungrouped,
  draft,
  hiddenFields,
  showAll,
  onClose,
  relations,
  collection,
  allM2mRelations,
  m2mLinks,
  m2mUnlinks,
  itemId,
  isReady,
  onNavigateToField,
}: {
  groups: Array<{ key: string; label: string; type: string }>
  groupedMap: Record<string, Array<{ field: string; label?: string | null; required?: boolean; hidden?: boolean; type?: string; interface?: string | null }>>
  ungrouped: Array<{ field: string; label?: string | null; required?: boolean; hidden?: boolean; type?: string; interface?: string | null }>
  draft: Record<string, unknown>
  hiddenFields: Set<string>
  showAll: boolean
  onClose: () => void
  relations: CMSRelation[]
  collection: string
  allM2mRelations: CMSRelation[]
  m2mLinks: Map<string, unknown[]>
  m2mUnlinks: Map<string, Set<unknown>>
  itemId: string | undefined
  isReady: boolean
  onNavigateToField?: (fieldName: string, groupKey: string | null) => void
}) {
  const m2oRelMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of relations) {
      if (r.many_collection === collection && r.many_field && r.one_collection && !r.junction_field)
        map.set(r.many_field, r.one_collection)
    }
    return map
  }, [relations, collection])

  const m2mRelMap = useMemo(() => {
    const map = new Map<string, CMSRelation>()
    for (const r of allM2mRelations) {
      if (r.one_field) map.set(r.one_field, r)
    }
    return map
  }, [allM2mRelations])

  // Subscribe to junction data for all M2M relations so panel updates live
  const m2mJunctionQueries = useQueries({
    queries: allM2mRelations
      .filter(r => r.one_field && !!itemId)
      .map(r => ({
        queryKey: ['m2m-items', r.many_collection, r.many_field, itemId],
        queryFn: () => api.get(`/items/${r.many_collection}`, {
          params: { filter: JSON.stringify({ [r.many_field]: { _eq: itemId } }), limit: 200, fields: `id,${r.junction_field}` }
        }).then(res => (res.data.data ?? []) as Record<string, unknown>[]),
        staleTime: 30_000,
        enabled: !!itemId,
      }))
  })

  const m2mJunctionMap = useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>()
    allM2mRelations.filter(r => r.one_field).forEach((r, i) => {
      map.set(r.one_field!, m2mJunctionQueries[i]?.data ?? [])
    })
    return map
  }, [allM2mRelations, m2mJunctionQueries])

  function getM2MIds(rel: CMSRelation): unknown[] {
    const key = rel.one_field ?? `${rel.many_collection}.${rel.junction_field}`
    const unlinks = m2mUnlinks.get(key) ?? new Set()
    const committed = (m2mJunctionMap.get(rel.one_field!) ?? [])
      .filter(ji => !unlinks.has(ji.id))
      .map(ji => ji[rel.junction_field!])
    const staged = m2mLinks.get(key) ?? []
    return [...committed, ...staged]
  }

  function formatVal(val: unknown, type?: string): string | null {
    if (val === null || val === undefined || val === '') return null
    if (typeof val === 'boolean') return val ? 'Yes' : 'No'
    if (typeof val === 'object') {
      const obj = val as Record<string, unknown>
      return obj.id != null ? String(obj.id) : null
    }
    const s = String(val)
    if ((type === 'date' || type === 'datetime') && s.length >= 10) {
      try { return new Date(s).toLocaleDateString(undefined, { dateStyle: 'medium' }) } catch { return s }
    }
    return s
  }

  const tabGroups = groups.filter(g => g.type === 'tab')
  const sectionGroups = groups.filter(g => g.type === 'section')

  const sections: Array<{ label: string; groupKey: string | null; fields: typeof ungrouped }> = []
  if (ungrouped.length > 0 || sectionGroups.length > 0) {
    const gFields = [...ungrouped, ...sectionGroups.flatMap(g => groupedMap[g.key] ?? [])].filter(f => !f.hidden && !hiddenFields.has(f.field))
    if (gFields.length > 0) sections.push({ label: 'General', groupKey: null, fields: gFields })
  }
  for (const g of tabGroups) {
    const gFields = (groupedMap[g.key] ?? []).filter(f => !f.hidden && !hiddenFields.has(f.field))
    if (gFields.length > 0) sections.push({ label: g.label, groupKey: g.key, fields: gFields })
  }

  return (
    <div className='flex w-[260px] shrink-0 flex-col border-l border-slate-200 bg-white dark:border-border dark:bg-background'>
      <div className='flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-border'>
        <span className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>Summary</span>
        <button type='button' onClick={onClose} className='rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'>
          <X className='h-3.5 w-3.5' />
        </button>
      </div>

      <div className='flex-1 overflow-y-auto'>
        {(!isReady || m2mJunctionQueries.some(q => q.isLoading)) && (
          <div className='space-y-3 p-4'>
            {[...Array(6)].map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
              <div key={i} className='space-y-1.5'>
                <Skeleton className='h-2.5 w-20 rounded' />
                <Skeleton className='h-4 w-full rounded' />
              </div>
            ))}
          </div>
        )}
        {(isReady && !m2mJunctionQueries.some(q => q.isLoading)) && sections.map((sec, secIdx) => {
          type RowData = { f: typeof ungrouped[number]; kind: 'm2o' | 'm2m' | 'wysiwyg' | 'scalar'; val: unknown; m2mIds: unknown[]; formatted: string | null; isEmpty: boolean; isRequiredEmpty: boolean }
          const rows: RowData[] = sec.fields.flatMap((f) => {
            const val = draft[f.field]
            const isWysiwyg = WYSIWYG_INTERFACES.has(f.interface ?? '')
            const m2mRel = m2mRelMap.get(f.field)

            let kind: RowData['kind'] = 'scalar'
            let m2mIds: unknown[] = []
            let formatted: string | null = null
            let isEmpty = false

            if (m2mRel) {
              kind = 'm2m'
              m2mIds = getM2MIds(m2mRel)
              isEmpty = m2mIds.length === 0
            } else if (!m2mRel && m2oRelMap.has(f.field)) {
              kind = 'm2o'
              isEmpty = val === null || val === undefined || val === ''
            } else if (isWysiwyg) {
              kind = 'wysiwyg'
              formatted = typeof val === 'string' && val.trim() ? val : null
              isEmpty = formatted === null
            } else {
              kind = 'scalar'
              formatted = formatVal(val, f.type)
              isEmpty = formatted === null
            }

            const isRequiredEmpty = isEmpty && !!f.required
            if (!showAll && isEmpty && !isRequiredEmpty) return []
            return [{ f, kind, val, m2mIds, formatted, isEmpty, isRequiredEmpty }]
          })
          if (rows.length === 0 && !showAll) return null
          return (
            <div key={sec.label}>
              <div className={cn(
                'sticky top-0 z-10 border-b border-slate-200 bg-slate-100 px-4 py-2 dark:border-border dark:bg-muted/60',
                secIdx > 0 && 'border-t'
              )}>
                <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>{sec.label}</span>
              </div>
              {rows.map(({ f, kind, val, m2mIds, formatted, isEmpty, isRequiredEmpty }) => (
                <SummaryFieldRow
                  key={f.field}
                  f={f} kind={kind} val={val} m2mIds={m2mIds}
                  formatted={formatted} isEmpty={isEmpty} isRequiredEmpty={isRequiredEmpty}
                  m2oRelMap={m2oRelMap} m2mRelMap={m2mRelMap} relations={relations}
                  onNavigate={onNavigateToField ? () => onNavigateToField(f.field, sec.groupKey) : undefined}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ItemEditPage() {
  const { collection, id } = useParams<{ collection: string; id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [initialized, setInitialized] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const [generatingField, setGeneratingField] = useState<string | null>(null)
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})
  const [summaryOpen, setSummaryOpen] = useState(true)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // M2M deferred staging — links/unlinks committed only on save
  const [m2mLinks, setM2mLinks] = useState<Map<string, unknown[]>>(new Map())
  const [m2mUnlinks, setM2mUnlinks] = useState<Map<string, Set<unknown>>>(new Map())

  const m2mStagingCtx: M2MStagingCtx = useMemo(() => ({
    getStagedLinks: (key) => m2mLinks.get(key) ?? [],
    getStagedUnlinks: (key) => m2mUnlinks.get(key) ?? new Set(),
    stageLink: (key, relatedId) => setM2mLinks(prev => {
      const next = new Map(prev)
      next.set(key, [...(next.get(key) ?? []), relatedId])
      return next
    }),
    stageUnlink: (key, junctionId) => setM2mUnlinks(prev => {
      const next = new Map(prev)
      const s = new Set(next.get(key))
      s.add(junctionId)
      next.set(key, s)
      return next
    }),
    unstageLink: (key, relatedId) => setM2mLinks(prev => {
      const next = new Map(prev)
      next.set(key, (next.get(key) ?? []).filter(id => id !== relatedId))
      return next
    }),
    unstageUnlink: (key, junctionId) => setM2mUnlinks(prev => {
      const next = new Map(prev)
      const s = new Set(next.get(key))
      s.delete(junctionId)
      next.set(key, s)
      return next
    }),
  }), [m2mLinks, m2mUnlinks])
  // O2M inline grid — batch save coordination
  const o2mFlushMap = useRef(new Map<string, () => Promise<void>>())
  const o2mGridCtx = useMemo(() => ({
    register: (key: string, flush: () => Promise<void>) => { o2mFlushMap.current.set(key, flush) },
    unregister: (key: string) => { o2mFlushMap.current.delete(key) },
    flushAll: async () => { for (const flush of o2mFlushMap.current.values()) await flush() },
  }), [])

  // Pre-save AI checks — content rule violations + possible duplicates (new items only)
  const [aiWarning, setAiWarning] = useState<{
    violations: AiViolation[]
    mode: 'soft' | 'hard'
  } | null>(null)
  const [aiDuplicates, setAiDuplicates] = useState<AiDuplicate[] | null>(null)
  const [aiChecking, setAiChecking] = useState(false)

  // Item edit lock — acquired on mount for existing items; read-only when another user holds it
  const { lockHolder, isReadOnly, takeOver, takingOver } = useItemLock(
    collection,
    id,
    !!collection && !!id && id !== 'new'
  )

  const { data: colMeta, isLoading: colMetaLoading } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 10 * 60 * 1000
  })

  const { data: itemData, isLoading } = useQuery({
    queryKey: ['item', collection, id],
    queryFn: () => api.get(`/items/${collection}/${id}`).then((r) => r.data.data),
    enabled: !!collection && !!id && id !== 'new'
  })

  const { data: treeConfig } = useQuery({
    queryKey: ['tree-config', collection],
    queryFn: () =>
      api
        .get<{ data: TreeConfig | null }>(`/tree-configs/by-collection/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })

  const { data: ancestors } = useQuery({
    queryKey: ['tree-ancestors', collection, id],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string | number; label: string; depth: number }> }>(
          `/tree/${collection}/${id}/ancestors`
        )
        .then((r) => r.data.data),
    enabled: !!id && !!treeConfig && id !== 'new',
    staleTime: 30_000
  })

  const { data: hierarchyConfigs } = useQuery({
    queryKey: ['hierarchy-configs'],
    queryFn: () =>
      api.get<{ data: HierarchyConfig[] }>('/hierarchy-configs').then((r) => r.data.data),
    staleTime: 60_000,
    enabled: !!id && id !== 'new'
  })

  const { data: fieldConfig } = useQuery({
    queryKey: ['field-config', collection],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            field: string
            group_key: string | null
            visibility_rules: string | null
            dependency_config: string | null
            validation_rules: string | null
            lock_condition: string | null
            default_formula: string | null
            cross_record_defaults: string | null
            remote_options_config: string | null
            repeater_schema: string | null
            is_translatable: boolean
            layout_assigned: boolean
            sort: number | null
            placeholder: string | null
          }>
        }>(`/field-config/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 60_000
  })

  const { data: fieldGroups } = useQuery({
    queryKey: ['field-groups', collection],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            id: number
            key: string
            label: string
            type: 'section' | 'tab' | 'metadata'
            icon: string | null
            sort: number
            is_collapsed: boolean
          }>
        }>(`/field-groups/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 0
  })

  const { data: activeLayoutData } = useQuery({
    queryKey: ['active-layout', collection],
    queryFn: () =>
      api
        .get<{ data: { layout: { id: number; disable_comments?: boolean | number; disable_tasks?: boolean | number; tab_mode?: string; validate_before_next?: boolean | number; summary_enabled?: boolean | number; summary_show_all?: boolean | number; ai_enabled?: boolean | number }; groups?: Array<{ key: string; label: string; type: string; icon?: string | null; sort?: number }>; assignments?: Array<{ field: string; group_key: string | null; sort: number; label_override?: string | null; is_visible?: boolean | number; default_expanded?: boolean | number }>; ungrouped_sort?: number | null } }>(`/collection-layouts/active`, { params: { collection } })
        .then((r) => r.data.data)
        .catch(() => null),
    enabled: !!collection,
    staleTime: 0
  })

  const { data: dpConfig } = useQuery({
    queryKey: ['draft-publish-config', collection],
    queryFn: () =>
      api
        .get<{ data: { draft_publish_enabled: boolean } }>(`/draft-publish/${collection}/config`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 60_000
  })

  // Per-collection AI settings — gates pre-save validation / duplicate checks.
  // Fetched once (60s stale); 403 (non-admin) or missing config resolves to null,
  // which disables both checks so saving costs zero extra requests.
  const { data: aiSettings } = useQuery({
    queryKey: ['ai-settings', collection],
    queryFn: () =>
      api
        .get<{ data: AiCollectionSettings }>(`/ai-settings/${collection}`)
        .then((r) => r.data.data)
        .catch(() => null),
    enabled: !!collection,
    staleTime: 60_000
  })

  // Which hierarchies include this collection at a non-root level
  const relevantHierarchies = useMemo(
    () =>
      (hierarchyConfigs ?? []).filter(
        (hc) => hc.levels.findIndex((l) => l.collection === collection) > 0
      ),
    [hierarchyConfigs, collection]
  )

  // Fetch ancestors for each relevant hierarchy
  const hierarchyAncestorResults = useQueries({
    queries: relevantHierarchies.map((hc) => ({
      queryKey: ['hierarchy-ancestors', hc.id, collection, id],
      queryFn: () =>
        api
          .get<{ data: HierarchyAncestor[] }>(
            `/hierarchy/${hc.id}/node/${collection}/${id}/ancestors`
          )
          .then((r) => r.data.data),
      enabled: !!id && id !== 'new' && relevantHierarchies.length > 0,
      staleTime: 30_000
    }))
  })

  // Parse field config into lookup map
  const fieldConfigMap = useMemo(() => {
    type FC = NonNullable<typeof fieldConfig>[number]
    const map: Record<string, FC> = {}
    for (const fc of fieldConfig ?? []) map[fc.field] = fc
    return map
  }, [fieldConfig])

  // Evaluate visibility rules against current draft values — hide if conditions fail
  const hiddenFields = useMemo(() => {
    const hidden = new Set<string>()
    for (const fc of fieldConfig ?? []) {
      if (!fc.visibility_rules) continue
      try {
        const rules = (typeof fc.visibility_rules === 'string'
          ? JSON.parse(fc.visibility_rules)
          : fc.visibility_rules) as {
          operator: 'AND' | 'OR'
          conditions: Array<{
            field: string
            op: 'eq' | 'neq' | 'null' | 'nnull' | 'contains'
            value: unknown
          }>
        }
        const results = rules.conditions.map((cond) => {
          const v = draft[cond.field]
          switch (cond.op) {
            case 'eq':
              // biome-ignore lint/suspicious/noDoubleEquals: intentional loose equality for type-coerced comparison
              return v == cond.value
            case 'neq':
              // biome-ignore lint/suspicious/noDoubleEquals: intentional loose equality for type-coerced comparison
              return v != cond.value
            case 'null':
              return v === null || v === undefined || v === ''
            case 'nnull':
              return v !== null && v !== undefined && v !== ''
            case 'contains':
              return String(v ?? '').includes(String(cond.value))
            default:
              return false
          }
        })
        const passes = rules.operator === 'AND' ? results.every(Boolean) : results.some(Boolean)
        if (!passes) hidden.add(fc.field)
      } catch {
        /* ignore parse errors */
      }
    }
    return hidden
  }, [fieldConfig, draft])

  // Evaluate lock conditions against current draft values
  const lockedFields = useMemo(() => {
    const locked = new Set<string>()
    for (const fc of fieldConfig ?? []) {
      if (!fc.lock_condition) continue
      try {
        const cond = (typeof fc.lock_condition === 'string'
          ? JSON.parse(fc.lock_condition)
          : fc.lock_condition) as {
          field: string
          op: 'eq' | 'neq' | 'null' | 'nnull'
          value: unknown
        }
        const v = draft[cond.field]
        let matches = false
        switch (cond.op) {
          case 'eq':
            // biome-ignore lint/suspicious/noDoubleEquals: intentional loose equality for type-coerced comparison
            matches = v == cond.value
            break
          case 'neq':
            // biome-ignore lint/suspicious/noDoubleEquals: intentional loose equality for type-coerced comparison
            matches = v != cond.value
            break
          case 'null':
            matches = v === null || v === undefined || v === ''
            break
          case 'nnull':
            matches = v !== null && v !== undefined && v !== ''
            break
        }
        if (matches) locked.add(fc.field)
      } catch {
        /* ignore */
      }
    }
    return locked
  }, [fieldConfig, draft])

  // Render-phase init so draft is populated on the same commit that mounts
  // child pickers — avoids them firing with value=undefined then re-queuing.
  if (itemData && !initialized) {
    setDraft(itemData as Record<string, unknown>)
    setInitialized(true)
  }

  // Pre-populate parent field when navigating from tree "Add child"
  useEffect(() => {
    if (id !== 'new') return
    const parentField = searchParams.get('parentField')
    const parentId = searchParams.get('parentId')
    if (parentField && parentId) {
      setDraft((d) => ({ ...d, [parentField]: parentId }))
    }
  }, [id, searchParams])

  const { data: exclusionData, refetch: refetchExclusion } = useQuery({
    queryKey: ['picker-exclusion', collection, id],
    queryFn: () => api.get(`/picker-exclusions/status/${collection}/${id}`).then(r => (r.data.data as { excluded: boolean })),
    enabled: !!collection && !!id && id !== 'new',
    staleTime: 60_000,
  })
  const isExcluded = exclusionData?.excluded ?? false
  const toggleExclusion = useMutation({
    mutationFn: () => isExcluded
      ? api.delete('/picker-exclusions', { data: { collection, item_id: id } })
      : api.post('/picker-exclusions', { collection, item_id: id }),
    onSuccess: () => {
      refetchExclusion()
      toast.success(isExcluded ? 'Record re-enabled in pickers' : 'Record excluded from pickers')
    },
    onError: () => toast.error('Failed to update picker status'),
  })

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      id === 'new'
        ? api.post(`/items/${collection}`, body).then((r) => r.data.data)
        : api.patch(`/items/${collection}/${id}`, body).then((r) => r.data.data),
    onSuccess: (updated) => {
      setValidationErrors({})
      setDraft(updated as Record<string, unknown>)
      queryClient.invalidateQueries({ queryKey: ['items', collection] })
      queryClient.invalidateQueries({ queryKey: ['item', collection, id] })
      toast.success('Saved')
      if (id === 'new') {
        const newId = (updated as Record<string, unknown>).id
        if (newId) navigate(`/collections/${collection}/${newId}`)
      }
    },
    onError: (err: unknown) => {
      const resp = (
        err as {
          response?: {
            status?: number
            data?: { error?: string; message?: string; validation?: Record<string, string> }
          }
        }
      )?.response
      const apiErr = resp?.data
      if (resp?.status === 422) {
        // Server-side AI content validation (hard mode) — enforced independently of
        // the pre-save check; surface the rule explanation rather than a raw error.
        toast.error(apiErr?.message ?? apiErr?.error ?? 'Blocked by content rules')
      } else if (apiErr?.validation) {
        setValidationErrors(apiErr.validation)
        toast.error('Please fix validation errors before saving')
      } else {
        toast.error(apiErr?.error ?? 'Failed to save')
      }
    }
  })

  const { data: attributeDefs } = useQuery({
    queryKey: ['attribute-values', collection, id],
    queryFn: () =>
      api.get<{ data: AttributeDef[] }>(`/attributes/${collection}/${id}`).then((r) => r.data.data),
    enabled: !!collection && !!id && id !== 'new'
  })

  const saveAttributes = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.patch(`/attributes/${collection}/${id}`, values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attribute-values', collection, id] })
      toast.success('Attribute saved')
    },
    onError: () => toast.error('Failed to save attribute')
  })

  const relations: CMSRelation[] = colMeta?.relations ?? []
  // O2M virtual fields have no DB column — synthesize CMSField entries so they
  // participate in the layout system (pool → group/ungrouped → render at position)
  // When one_field='id' (legacy hardcoded value), use many_collection as the effective field name
  const o2mVirtualEntries: CMSField[] = (() => {
    const seen = new Set<string>()
    return (relations as CMSRelation[])
      .filter(r => {
        if (!(r.one_collection === collection && r.one_field && !r.junction_field)) return false
        const effectiveName = r.one_field === 'id' ? r.many_collection! : r.one_field
        return !colMeta?.fields?.find((f: CMSField) => f.field === effectiveName)
      })
      .map(r => {
        const fieldName = r.one_field === 'id' ? r.many_collection! : r.one_field!
        return { field: fieldName, type: 'o2m', label: null, hidden: false, readonly: true } as unknown as CMSField
      })
      .filter(e => {
        if (seen.has(e.field)) return false
        seen.add(e.field)
        return true
      })
  })()
  const allFields: CMSField[] = [...(colMeta?.fields ?? []), ...o2mVirtualEntries]

  const groupedFields = useMemo(() => {
    const groups = fieldGroups ?? []
    if (groups.length === 0) return null
    // Only show fields explicitly placed in Ungrouped (layout_assigned=true, no group_key).
    // Fields with layout_assigned=false are still in the Unassigned pool — hide them.
    // If no active layout exists (layout_assigned undefined), fall back to old behaviour.
    const ungrouped = allFields.filter((f) => {
      const fc = fieldConfigMap[f.field]
      if (!fc || f.hidden) return false
      if (fc.group_key) return false
      if ('layout_assigned' in fc) return fc.layout_assigned === true
      return true
    })
    const groupedMap: Record<string, CMSField[]> = {}
    for (const g of groups) groupedMap[g.key] = []
    for (const f of allFields) {
      const gk = fieldConfigMap[f.field]?.group_key
      if (gk && groupedMap[gk]) groupedMap[gk].push(f)
    }
    const getSort = (f: CMSField) => (fieldConfigMap[f.field] as { sort?: number } | undefined)?.sort ?? 9999
    for (const key of Object.keys(groupedMap)) groupedMap[key].sort((a, b) => getSort(a) - getSort(b))
    const ungroupedSorted = [...ungrouped].sort((a, b) => getSort(a) - getSort(b))
    return { ungrouped: ungroupedSorted, groups, groupedMap }
  }, [allFields, fieldGroups, fieldConfigMap])

  const COL_SPAN_CLASS: Record<number, string> = {
    3: 'col-span-12 sm:col-span-3',
    4: 'col-span-12 sm:col-span-4',
    6: 'col-span-12 sm:col-span-6',
    12: 'col-span-12',
  }

  const getFieldColSpanClass = (field: CMSField): string => {
    try {
      const opts = field.options
      const obj = typeof opts === 'string' ? JSON.parse(opts) : opts
      const span = (obj as Record<string, unknown>)?.col_span
      return COL_SPAN_CLASS[span as number] ?? 'col-span-12'
    } catch { return 'col-span-12' }
  }

  // Renders a field as O2MPanel if it's a layout-placed virtual O2M, else as FieldRow
  const renderFieldOrPanel = (field: CMSField) => {
    let o2mRel = o2mRelationMap.get(field.field)
    // Fallback: field has O2M interface but one_field doesn't match field name (e.g. one_field='id')
    if (!o2mRel && (field.type === 'o2m' || field.interface === 'relation-list')) {
      o2mRel = relations.find(
        (r: CMSRelation) => r.one_collection === collection && !r.junction_field &&
          (r.one_field === field.field || r.many_collection === field.field)
      ) as CMSRelation | undefined
    }
    if (o2mRel) {
      if (!id || id === 'new') return null
      // Check for inline-grid interface
      const fieldCfg = fieldConfigMap[field.field] as Record<string, unknown> | undefined
      const fieldIface = fieldCfg?.interface as string | null
      if (field.interface === 'inline-grid' || fieldIface === 'inline-grid') {
        const opts = (() => { try { return JSON.parse(fieldCfg?.options as string ?? '{}') as Record<string, unknown> } catch { return {} } })()
        return (
          <div key={field.field} className='col-span-12 space-y-1.5'>
            <Label className='text-slate-600'>{field.label ?? titleCase(field.field)}</Label>
            <O2MInlineGrid
              relation={o2mRel}
              parentId={id}
              layoutId={(opts.grid_layout_id as number | null) ?? null}
              showTotals={!!(opts.grid_show_totals)}
            />
          </div>
        )
      }
      return (
        <div key={field.field} className='col-span-12'>
          <O2MPanel relation={o2mRel} parentId={id} onNavigate={(col) => navigate(`/collections/${col}`)} />
        </div>
      )
    }
    return (
      <div key={field.field} className={getFieldColSpanClass(field)}>
        <FieldRow field={field} draft={draft} inheritedMap={inheritedMap}
          original={itemData as Record<string, unknown> | undefined}
          lockedFields={lockedFields} validationErrors={validationErrors}
          treeConfig={treeConfig ?? null} collection={collection!} id={id}
          colMeta={colMeta} user={user} generatingField={generatingField}
          handleFieldChange={handleFieldChange} handleGenerateField={handleGenerateField}
          fieldConfigMap={fieldConfigMap} m2mParentCommitted={m2mParentCommitted}
          layoutAiEnabled={layoutAiEnabled} />
      </div>
    )
  }

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // ── Tab groups ──────────────────────────────────────────────────────────────
  const tabGroups = useMemo(
    () => (groupedFields?.groups ?? []).filter((g) => g.type === 'tab'),
    [groupedFields]
  )
  const sectionGroups = useMemo(
    () => (groupedFields?.groups ?? []).filter((g) => g.type === 'section'),
    [groupedFields]
  )
  const hasTabs = tabGroups.length > 0
  const layoutMeta = activeLayoutData?.layout
  const isStepsMode = hasTabs && layoutMeta?.tab_mode === 'steps'
  const validateBeforeNext = !!layoutMeta?.validate_before_next
  const summaryEnabled = !!layoutMeta?.summary_enabled
  const summaryShowAll = !!layoutMeta?.summary_show_all
  // When a layout is active, AI defaults OFF unless explicitly enabled. No layout = AI on.
  const layoutAiEnabled = layoutMeta ? !!layoutMeta.ai_enabled : true

  // Positioned sentinel slots — pipeline / comments / tasks placed in the layout.
  // When present, these render inside the section loop at their configured sort.
  const layoutAssignments = activeLayoutData?.assignments ?? []
  const pipelineSlot = layoutAssignments.find((a) => a.field === '__pipeline__')
  const commentsSlot = layoutAssignments.find((a) => a.field === '__comments__')
  const tasksSlot = layoutAssignments.find((a) => a.field === '__tasks__')

  // General tab only exists when there are section-type groups alongside tab groups.
  // Ungrouped fields render above the tab strip in their own inline block, not inside a tab.
  const hasGeneralContent = hasTabs && sectionGroups.length > 0

  const allSteps = useMemo((): StepDef[] => {
    if (!hasTabs) return []
    return [
      ...(hasGeneralContent ? [{ key: '__general__', label: 'General', icon: null }] : []),
      ...tabGroups.map(g => ({ key: g.key, label: g.label, icon: g.icon ?? null }))
    ]
  }, [hasTabs, hasGeneralContent, tabGroups])

  const getStepFields = useCallback((stepKey: string) => {
    if (stepKey === '__general__') {
      return [
        ...(groupedFields?.ungrouped ?? []),
        ...sectionGroups.flatMap(g => groupedFields?.groupedMap[g.key] ?? [])
      ]
    }
    return groupedFields?.groupedMap[stepKey] ?? []
  }, [groupedFields, sectionGroups])

  const completedStepKeys = useMemo(() => {
    const out = new Set<string>()
    for (const s of allSteps) {
      const fields = getStepFields(s.key)
      const allFilled = fields
        .filter(f => f.required && !f.hidden && !SYSTEM_FIELDS.has(f.field) && !hiddenFields.has(f.field))
        .every(f => {
          const v = draft[f.field]
          return v !== null && v !== undefined && v !== ''
        })
      if (allFilled) out.add(s.key)
    }
    return out
  }, [allSteps, getStepFields, draft, hiddenFields])

  function handleNext() {
    if (validateBeforeNext) {
      const fields = getStepFields(activeTab)
      const errs: Record<string, string> = {}
      for (const f of fields) {
        if (f.required && !f.hidden && !SYSTEM_FIELDS.has(f.field) && !hiddenFields.has(f.field)) {
          const v = draft[f.field]
          if (v === null || v === undefined || v === '') errs[f.field] = 'This field is required'
        }
      }
      if (Object.keys(errs).length > 0) {
        setValidationErrors(prev => ({ ...prev, ...errs }))
        return
      }
    }
    const idx = allSteps.findIndex(s => s.key === activeTab)
    if (idx < allSteps.length - 1) setActiveTab(allSteps[idx + 1].key)
  }

  function handlePrev() {
    const idx = allSteps.findIndex(s => s.key === activeTab)
    if (idx > 0) setActiveTab(allSteps[idx - 1].key)
  }

  // Ordered items for section mode — groups + '__ungrouped__' + positioned sentinel
  // slots ('__pipeline__' / '__comments__' / '__tasks__') interleaved by sort.
  const orderedSectionItems = useMemo(() => {
    type SentinelKey = '__ungrouped__' | '__pipeline__' | '__comments__' | '__tasks__'
    type SectionItem = NonNullable<typeof groupedFields>['groups'][number] | SentinelKey
    const groups = groupedFields?.groups ?? []
    const assignments = activeLayoutData?.assignments ?? []
    const findSlot = (field: string) => assignments.find((a) => a.field === field)

    // Each entry carries a sort key used to interleave it with the groups.
    // Groups keep their natural order (index used as their effective sort).
    const entries: Array<{ item: SectionItem; sort: number; tie: number }> = groups.map(
      (g) => ({ item: g, sort: g.sort, tie: 0 })
    )

    // Ungrouped — existing behaviour: ungrouped_sort position, else after all groups.
    const ungroupedPos = activeLayoutData?.ungrouped_sort
    entries.push({
      item: '__ungrouped__',
      sort: ungroupedPos != null ? ungroupedPos : groups.length,
      tie: 1
    })

    // Sentinel slots — use assignment sort when positioned, else default position.
    // Defaults: pipeline before all groups; tasks then comments after all groups.
    // is_visible === 0 / false skips the slot entirely.
    const visible = (s: { is_visible?: boolean | number } | undefined) =>
      !(s && (s.is_visible === 0 || s.is_visible === false))
    const pipeline = findSlot('__pipeline__')
    if (visible(pipeline)) {
      entries.push({ item: '__pipeline__', sort: pipeline ? pipeline.sort : -1, tie: 2 })
    }
    const tasks = findSlot('__tasks__')
    if (visible(tasks)) {
      entries.push({ item: '__tasks__', sort: tasks ? tasks.sort : 99998, tie: 3 })
    }
    const comments = findSlot('__comments__')
    if (visible(comments)) {
      entries.push({ item: '__comments__', sort: comments ? comments.sort : 99999, tie: 4 })
    }

    entries.sort((a, b) => a.sort - b.sort || a.tie - b.tie)
    return entries.map((e) => e.item)
  }, [groupedFields, activeLayoutData])

  // Tab mode has no per-group interleaving — the Ungrouped block is binary:
  // above the tab strip (default) or below the tab content when the Layout tab
  // placed the Ungrouped zone after all groups
  const ungroupedBelowTabs = useMemo(() => {
    const savedPos = activeLayoutData?.ungrouped_sort
    return savedPos != null && savedPos >= (groupedFields?.groups.length ?? 0)
  }, [groupedFields, activeLayoutData])

  const [activeTab, setActiveTabRaw] = useState<string>(() => {
    try {
      return localStorage.getItem(`nvr_tab_${collection}`) ?? '__general__'
    } catch {
      return '__general__'
    }
  })

  const setActiveTab = (key: string) => {
    setActiveTabRaw(key)
    try { localStorage.setItem(`nvr_tab_${collection}`, key) } catch { /* noop */ }
  }

  // Reset to first valid tab when tab structure changes
  useEffect(() => {
    if (!hasTabs) return
    const valid = new Set([
      ...(hasGeneralContent ? ['__general__'] : []),
      ...tabGroups.map((g) => g.key)
    ])
    if (!valid.has(activeTab)) {
      setActiveTabRaw(tabGroups[0]?.key ?? '__general__')
    }
  }, [hasTabs, tabGroups, hasGeneralContent, activeTab])

  // Error dot: which tabs contain a validation error
  const tabsWithErrors = useMemo(() => {
    const out = new Set<string>()
    for (const [field, err] of Object.entries(validationErrors)) {
      if (!err) continue
      const gk = fieldConfigMap[field]?.group_key
      if (!gk) { out.add('__general__'); continue }
      const grp = groupedFields?.groups.find((g) => g.key === gk)
      if (!grp || grp.type !== 'tab') out.add('__general__')
      else out.add(gk)
    }
    return out
  }, [validationErrors, fieldConfigMap, groupedFields])

  // Summary panel field-click navigation: switch to the field's tab then scroll + highlight
  const navigateToField = useCallback((fieldName: string, groupKey: string | null) => {
    if (groupKey) {
      const group = groupedFields?.groups.find((g) => g.key === groupKey)
      if (group?.type === 'tab') {
        setActiveTab(groupKey)
      }
    }
    setTimeout(() => {
      const el = document.querySelector(`[data-field="${fieldName}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('ring-2', 'ring-nvr-cyan', 'ring-offset-2', 'rounded-md')
        setTimeout(() => el.classList.remove('ring-2', 'ring-nvr-cyan', 'ring-offset-2', 'rounded-md'), 1500)
      }
    }, 150)
    // setActiveTab is stable enough (writes localStorage + setState); groupedFields drives lookup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedFields])

  // O2M virtual fields have no DB column and are handled by O2MPanel — exclude from editable fields
  // M2M virtual fields are now rendered inline by InlineM2MPicker so they stay in editable fields
  const virtualFieldNames = new Set(
    relations
      .filter((r) => r.one_collection === collection && r.one_field !== null && r.junction_field === null)
      .map((r) => r.one_field!)
  )

  // Pool = fields not yet placed in any group or Ungrouped zone.
  // Only applies when an active layout has at least one placement (layout_assigned=true).
  // If no layout or nothing placed yet, show everything (backward compat).
  const hasActiveLayout = (fieldConfig ?? []).some(fc => (fc as Record<string, unknown>).layout_assigned === true)
  const poolFieldNames: Set<string> = hasActiveLayout
    ? new Set(
        (fieldConfig ?? [])
          .filter(fc => (fc as Record<string, unknown>).layout_assigned !== true)
          .map(fc => fc.field)
      )
    : new Set()

  const computedFields = allFields.filter(
    (f) =>
      f.computed_formula &&
      !f.hidden &&
      !SYSTEM_FIELDS.has(f.field) &&
      !virtualFieldNames.has(f.field) &&
      !poolFieldNames.has(f.field)
  )
  const computedFieldNames = new Set(computedFields.map((f) => f.field))

  // Path-maintained tree collections gain server-managed `path` + `depth`
  // columns — treat them like system columns (read-only, never editable).
  const pathFieldNames: Set<string> = treeConfig?.maintain_path
    ? new Set(['path', 'depth'])
    : new Set()

  // Detect all M2M relations for this collection.
  // Don't require junction_field to be set — infer it from the companion row if missing.
  // This handles DB state where migration hasn't yet populated junction_field.
  const allM2mRelations: CMSRelation[] = relations
    .filter((r) => r.one_collection === collection)
    .map((r) => {
      if (r.junction_field) return r
      // Infer junction_field from companion row in the same junction table
      const companion = relations.find(
        (c) => c.many_collection === r.many_collection && c.id !== r.id
      )
      if (!companion) return null
      return { ...r, junction_field: companion.many_field }
    })
    .filter((r): r is CMSRelation => r !== null)

  const namedM2mFields = new Set(allM2mRelations.map((r) => r.one_field).filter(Boolean) as string[])

  // Fetch committed junction items for M2M fields used as cascade parents so existing items pre-filter
  const m2mCascadeParentFields = useMemo(() => {
    const parents = new Set<string>()
    for (const fc of fieldConfig ?? []) {
      for (const rule of getCascadeFilters(fc.dependency_config)) parents.add(rule.parent_field)
    }
    return [...parents]
  }, [fieldConfig])

  const m2mParentQueries = useQueries({
    queries: m2mCascadeParentFields.map(parentField => {
      const rel = allM2mRelations.find(r => r.one_field === parentField)
      return {
        queryKey: ['m2m-cascade-parent', rel?.many_collection, rel?.many_field, id],
        queryFn: async () => {
          if (!rel || !id || id === 'new') return []
          const res = await api.get(`/items/${rel.many_collection}`, {
            params: {
              filter: JSON.stringify({ [rel.many_field]: { _eq: id } }),
              fields: `id,${rel.junction_field}`,
              limit: 200,
            },
          })
          return ((res.data.data ?? []) as Record<string, unknown>[]).map(item => item[rel.junction_field!])
        },
        enabled: !!rel && !!id && id !== 'new',
        staleTime: 30_000,
      }
    })
  })

  const m2mParentCommitted: Record<string, unknown[]> = useMemo(() => {
    const map: Record<string, unknown[]> = {}
    m2mCascadeParentFields.forEach((f, i) => { map[f] = m2mParentQueries[i]?.data ?? [] })
    return map
  }, [m2mCascadeParentFields, m2mParentQueries])

  const editableFields = allFields.filter(
    (f) =>
      !f.hidden &&
      !f.readonly &&
      !SYSTEM_FIELDS.has(f.field) &&
      !pathFieldNames.has(f.field) &&
      !virtualFieldNames.has(f.field) &&
      !computedFieldNames.has(f.field) &&
      !namedM2mFields.has(f.field) &&
      !poolFieldNames.has(f.field)
  )
  const systemFields = allFields.filter(
    (f) => (SYSTEM_FIELDS.has(f.field) || f.readonly || pathFieldNames.has(f.field)) && !poolFieldNames.has(f.field)
  )

  const inheritedMap =
    ((itemData as Record<string, unknown> | undefined)?._inherited as
      | Record<string, unknown>
      | undefined) ?? undefined

  const displayName = colMeta?.display_name ?? titleCase(collection ?? '')

  // O2M relations split into layout-placed (rendered at configured position) vs unplaced (bottom)
  // Key by many_collection when one_field='id' (backward compat for relations created with hardcoded one_field)
  const o2mRelationMap = new Map<string, CMSRelation>(
    relations
      .filter(r => r.one_collection === collection && !r.junction_field && r.one_field)
      .map(r => [r.one_field === 'id' ? r.many_collection! : r.one_field!, r])
  )
  const layoutPlacedO2mFields = new Set(
    [...o2mRelationMap.keys()].filter(k => {
      const fc = fieldConfigMap[k]
      return fc && (fc as Record<string, unknown>).layout_assigned === true
    })
  )
  // When a layout is active, O2M only renders if explicitly placed (layout_assigned=true).
  // Unplaced O2M (pool) are hidden entirely. Without a layout, fall back to showing all at bottom.
  const o2mRelations: CMSRelation[] = [...o2mRelationMap.values()].filter(r => {
    const key = r.one_field ?? `${r.many_collection}.${r.many_field}`
    if (layoutPlacedO2mFields.has(key)) return false  // rendered at layout position, not bottom
    if (hasActiveLayout) return false                  // layout active — unplaced = hidden
    return !r.one_field || !poolFieldNames.has(r.one_field)
  })

  const namedM2mRelations = allM2mRelations.filter((r) => {
    if (!r.one_field) return true
    if (poolFieldNames.has(r.one_field)) return false
    // When a layout is active, exclude M2M fields already rendered by the layout group
    if (hasActiveLayout && (fieldConfigMap[r.one_field] as Record<string, unknown>)?.layout_assigned === true) return false
    return true
  })
  const m2mRelations: CMSRelation[] = []

  const [runningItemAction, setRunningItemAction] = useState<string | null>(null)
  const { data: extItemActions = [] } = useQuery({
    queryKey: ['ext-item-actions', collection],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string; label: string; variant?: string }> }>(
          '/item-actions/registered',
          { params: { collection } }
        )
        .then((r) => r.data.data),
    enabled: !!collection && !!id && id !== 'new',
    staleTime: 60_000
  })

  const handleSummarize = async () => {
    if (!collection || !id) return
    setSummarizing(true)
    try {
      const res = await api.post('/ai/summarize', { collection, item_id: id })
      setSummary(res.data.data.summary)
    } catch {
      toast.error('Failed to summarize — is ANTHROPIC_API_KEY configured?')
    } finally {
      setSummarizing(false)
    }
  }

  const handleGenerateField = async (field: string) => {
    if (!collection || !id) return
    setGeneratingField(field)
    try {
      const res = await api.post('/ai/generate', { collection, item_id: id, field })
      setDraft((d) => ({ ...d, [field]: res.data.data.value }))
      toast.success(`Generated content for "${field}"`)
    } catch {
      toast.error('Failed to generate — is ANTHROPIC_API_KEY configured?')
    } finally {
      setGeneratingField(null)
    }
  }

  const validateForm = useCallback((): boolean => {
    const clientErrors: Record<string, string> = {}
    for (const f of editableFields) {
      if (f.required) {
        const val = draft[f.field]
        if (val === null || val === undefined || val === '') clientErrors[f.field] = 'This field is required'
      }
    }
    for (const rel of [...namedM2mRelations, ...m2mRelations]) {
      const fieldDef = rel.one_field ? allFields.find((f) => f.field === rel.one_field) : undefined
      if (!fieldDef?.required) continue
      const key = rel.one_field ?? `${rel.many_collection}.${rel.junction_field}`
      const cached = queryClient.getQueryData<Record<string, unknown>[]>(
        ['m2m-items', rel.many_collection, rel.many_field, id !== 'new' ? id : undefined]
      ) ?? []
      const unlinks = m2mUnlinks.get(key) ?? new Set()
      const links = m2mLinks.get(key) ?? []
      const total = cached.filter((ji) => !unlinks.has(ji.id)).length + links.length
      if (total === 0) clientErrors[rel.one_field ?? key] = 'This field is required'
    }
    if (Object.keys(clientErrors).length > 0) {
      setValidationErrors(clientErrors)
      toast.error('Please fill in all required fields before transitioning')
      return false
    }
    return true
  }, [editableFields, draft, namedM2mRelations, m2mRelations, allFields, queryClient, id, m2mUnlinks, m2mLinks])

  const handleSave = async (opts?: { skipValidation?: boolean; skipDuplicates?: boolean }) => {
    // Flush all O2M inline grid staged changes before saving the parent
    await o2mGridCtx.flushAll()

    const patch: Record<string, unknown> = {}
    for (const f of editableFields) {
      patch[f.field] = draft[f.field] ?? null
    }

    // Client-side required field validation for M2O and M2M fields
    const clientErrors: Record<string, string> = {}

    for (const f of editableFields) {
      if (f.required) {
        const val = draft[f.field]
        if (val === null || val === undefined || val === '') {
          clientErrors[f.field] = 'This field is required'
        }
      }
    }

    for (const rel of [...namedM2mRelations, ...m2mRelations]) {
      const fieldDef = rel.one_field ? allFields.find((f) => f.field === rel.one_field) : undefined
      if (!fieldDef?.required) continue
      const key = rel.one_field ?? `${rel.many_collection}.${rel.junction_field}`
      const cached = queryClient.getQueryData<Record<string, unknown>[]>(
        ['m2m-items', rel.many_collection, rel.many_field, id !== 'new' ? id : undefined]
      ) ?? []
      const unlinks = m2mUnlinks.get(key) ?? new Set()
      const links = m2mLinks.get(key) ?? []
      const total = cached.filter((ji) => !unlinks.has(ji.id)).length + links.length
      if (total === 0) clientErrors[rel.one_field ?? key] = 'This field is required'
    }

    if (Object.keys(clientErrors).length > 0) {
      setValidationErrors(clientErrors)
      toast.error('Please fill in all required fields')
      return
    }

    setValidationErrors({})
    setAiWarning(null)
    setAiDuplicates(null)

    const needValidate = layoutAiEnabled && !opts?.skipValidation && !!aiSettings?.validation_enabled
    const needDupCheck =
      layoutAiEnabled && !opts?.skipDuplicates && id === 'new' && !!aiSettings?.duplicate_detection_enabled

    if (needValidate || needDupCheck) {
      setAiChecking(true)
      try {
        if (needValidate) {
          const res = await api.post<{
            violations: AiViolation[]
            mode: 'soft' | 'hard'
            enabled: boolean
          }>('/ai/validate', { collection, data: patch })
          const { violations, mode, enabled } = res.data
          if (enabled && violations && violations.length > 0) {
            setAiWarning({ violations, mode: mode === 'hard' ? 'hard' : 'soft' })
            return
          }
        }
        if (needDupCheck) {
          const res = await api.post<{ duplicates: AiDuplicate[]; enabled: boolean }>(
            '/ai/check-duplicates',
            { collection, data: patch }
          )
          const { duplicates, enabled } = res.data
          if (enabled && duplicates && duplicates.length > 0) {
            setAiDuplicates(duplicates)
            return
          }
        }
      } catch {
        // Pre-save AI checks are advisory — never block the save on a check failure.
        // Hard mode is still enforced server-side (422 handled in mutation onError).
      } finally {
        setAiChecking(false)
      }
    }

    try {
      const saved = await mutation.mutateAsync(patch)
      const savedId = id !== 'new' ? id! : String((saved as Record<string, unknown>).id)
      // Commit staged M2M changes now that the parent record exists
      const m2mOps: Promise<unknown>[] = []
      // Commit staged M2M ops for all M2M relations
      for (const rel of [...namedM2mRelations, ...m2mRelations]) {
        const key = rel.one_field ?? `${rel.many_collection}.${rel.junction_field}`
        const links = m2mLinks.get(key) ?? []
        const unlinks = m2mUnlinks.get(key) ?? new Set()
        for (const relatedId of links) {
          m2mOps.push(api.post(`/items/${rel.many_collection}`, {
            [rel.many_field]: savedId,
            [rel.junction_field!]: relatedId,
          }))
        }
        for (const junctionId of unlinks) {
          m2mOps.push(api.delete(`/items/${rel.many_collection}/${junctionId}`))
        }
      }
      if (m2mOps.length > 0) {
        await Promise.all(m2mOps)
        setM2mLinks(new Map())
        setM2mUnlinks(new Map())
        queryClient.invalidateQueries({ queryKey: ['m2m-items'] })
      }
    } catch {
      // mutation.onError already surfaces the error toast
    }
  }

  // Apply dependency cascade for fields that depend on the changed one
  const applyFieldChange = useCallback(
    (fieldName: string, value: unknown) => {
      const next = { ...draft, [fieldName]: value }
      const cascade: Record<string, unknown> = {}
      for (const fc of fieldConfig ?? []) {
        if (!fc.dependency_config) continue
        try {
          const cfg = (typeof fc.dependency_config === 'string'
            ? JSON.parse(fc.dependency_config)
            : fc.dependency_config) as {
            depends_on?: string[]
            clear_on_change?: boolean
            cascade_filters?: CascadeFilterRule[]
          }
          if (cfg.depends_on?.includes(fieldName) && cfg.clear_on_change) {
            cascade[fc.field] = null
          }
          for (const rule of cfg.cascade_filters ?? []) {
            if (rule.parent_field === fieldName && rule.clear_on_parent_change) {
              cascade[fc.field] = null
            }
          }
        } catch {
          /* ignore */
        }
      }
      setDraft({ ...next, ...cascade })
      return { ...next, ...cascade }
    },
    [draft, fieldConfig]
  )

  // Real-time field rules — when a field changes, ask the server which other
  // fields should be auto-set/cleared, then apply those updates to the draft.
  const handleFieldChange = (changedField: string, newValue: unknown) => {
    const newDraft = applyFieldChange(changedField, newValue)
    api
      .post('/field-rules/evaluate', {
        collection,
        data: newDraft,
        changed_field: changedField
      })
      .then((res) => {
        const updates = res.data?.updates as Record<string, unknown> | undefined
        if (updates && Object.keys(updates).length > 0) {
          setDraft((d) => ({ ...d, ...updates }))
        }
      })
      .catch(() => {
        /* non-fatal — field rules are a convenience */
      })
  }

  if (colMetaLoading || isLoading) {
    return (
      <div className='p-8 space-y-4 max-w-3xl'>
        <Skeleton className='h-8 w-48' />
        <Skeleton className='h-4 w-32' />
        <div className='space-y-4 mt-8'>
          {[...Array(6)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
            <div key={i} className='space-y-1.5'>
              <Skeleton className='h-3 w-24' />
              <Skeleton className='h-9 w-full' />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <O2MGridContext.Provider value={o2mGridCtx}>
    <M2MStagingContext.Provider value={m2mStagingCtx}>
    <div className='flex flex-1 min-h-0 flex-col'>
    {/* Sticky header bar */}
    <div className='sticky top-0 z-20 shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-background'>
      <div className='flex items-center gap-4'>
        <Button variant='ghost' size='icon' onClick={() => navigate(`/collections/${collection}`)}>
          <ArrowLeft className='h-4 w-4' />
        </Button>
        <div className='flex-1'>
          <div className='flex items-center gap-2'>
            <h1 className='text-[18px] font-semibold text-slate-900 dark:text-slate-100'>{displayName}</h1>
            <span className='font-mono text-[12px] bg-slate-100 text-slate-500 rounded px-2 py-0.5 dark:bg-muted dark:text-slate-400'>
              #{id}
            </span>
            <span className='text-[12px] text-slate-400 font-mono'>{collection}</span>
          </div>
          {ancestors && ancestors.length > 1 && (
            <nav className='flex items-center gap-1 text-[12px] text-slate-400 mt-1 flex-wrap'>
              {ancestors.slice(0, -1).map((ancestor, i) => (
                <span key={ancestor.id} className='flex items-center gap-1'>
                  {i > 0 && <span className='text-slate-300'>›</span>}
                  <Link
                    to={`/collections/${collection}/${ancestor.id}`}
                    className='hover:text-slate-600 dark:hover:text-slate-300 transition-colors'
                  >
                    {ancestor.label}
                  </Link>
                </span>
              ))}
              <span className='text-slate-300'>›</span>
              <span className='text-slate-600 dark:text-slate-300'>
                {ancestors[ancestors.length - 1]?.label}
              </span>
            </nav>
          )}
        </div>
        {dpConfig?.draft_publish_enabled && id !== 'new' && (
          <div className='flex items-center gap-2'>
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                draft._status === 'published'
                  ? 'bg-emerald-100 text-emerald-700'
                  : draft._status === 'review'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-slate-100 text-slate-600'
              )}
            >
              {String(draft._status ?? 'draft')}
            </span>
            {draft._status !== 'review' && draft._status !== 'published' && (
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-[12px]'
                onClick={() =>
                  api.post(`/draft-publish/${collection}/${id}/submit-review`).then(() => {
                    queryClient.invalidateQueries({ queryKey: ['item', collection, id] })
                    toast.success('Submitted for review')
                  })
                }
              >
                Submit for review
              </Button>
            )}
            {draft._status !== 'published' && (
              <Button
                size='sm'
                className='h-7 bg-emerald-600 text-[12px] text-white hover:bg-emerald-700'
                onClick={() =>
                  api.post(`/draft-publish/${collection}/${id}/publish`).then(() => {
                    queryClient.invalidateQueries({ queryKey: ['item', collection, id] })
                    toast.success('Published')
                  })
                }
              >
                Publish
              </Button>
            )}
            {draft._status === 'published' && (
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-[12px]'
                onClick={() =>
                  api.post(`/draft-publish/${collection}/${id}/unpublish`).then(() => {
                    queryClient.invalidateQueries({ queryKey: ['item', collection, id] })
                    toast.success('Unpublished')
                  })
                }
              >
                Unpublish
              </Button>
            )}
          </div>
        )}
        {extItemActions.map((action) => (
          <Button
            key={action.id}
            size='sm'
            variant={(action.variant as 'default' | 'destructive' | 'outline') ?? 'outline'}
            disabled={runningItemAction !== null || mutation.isPending}
            onClick={async () => {
              setRunningItemAction(action.id)
              try {
                const res = await api.post<{ data: { message: string } }>(
                  `/item-actions/${action.id}/execute`,
                  { collection, itemId: id }
                )
                toast.success(res.data.data.message)
              } catch {
                toast.error(`${action.label} failed`)
              } finally {
                setRunningItemAction(null)
              }
            }}
          >
            {runningItemAction === action.id ? (
              <Loader2 className='h-4 w-4 mr-1.5 animate-spin' />
            ) : (
              <Play className='h-4 w-4 mr-1.5' />
            )}
            {action.label}
          </Button>
        ))}
        <div className='flex overflow-hidden rounded-md'>
          {id !== 'new' && (
            <RevisionsPanel
              collection={collection!}
              item={id!}
              onRollback={() => {
                queryClient.invalidateQueries({ queryKey: ['item', collection, id] })
                setInitialized(false)
              }}
              triggerClassName='gap-1.5 rounded-none border-r-0'
            />
          )}
          {id !== 'new' && (
            <button
              type='button'
              onClick={() => toggleExclusion.mutate()}
              disabled={toggleExclusion.isPending}
              title={isExcluded ? 'Re-enable in pickers' : 'Disable in pickers'}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-none border px-2.5 py-1.5 text-[12px] font-medium transition-colors border-r-0',
                isExcluded
                  ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-border dark:text-muted-foreground'
              )}
            >
              <EyeOff className='h-3.5 w-3.5' />
              {isExcluded ? 'Excluded from pickers' : 'Disable in pickers'}
            </button>
          )}
          {id !== 'new' && (
            <CloneDialog
              collection={collection!}
              itemId={id!}
              fields={allFields}
              relations={relations}
              currentValues={draft}
              onSuccess={(newId) => navigate(`/collections/${collection}/${newId}`)}
              triggerClassName='rounded-none border-r-0'
            />
          )}
          {id !== 'new' && (
            <ScheduleChangeDialog
              collection={collection!}
              itemId={id!}
              currentValues={draft}
              fields={allFields}
              triggerClassName='rounded-none border-r-0'
            />
          )}
          {user?.is_admin && layoutAiEnabled && (
            <Button
              variant='outline'
              size='sm'
              onClick={handleSummarize}
              disabled={summarizing}
              className='rounded-none border-r-0'
            >
              {summarizing ? (
                <Loader2 className='h-3.5 w-3.5 mr-1.5 animate-spin' />
              ) : (
                <Sparkles className='h-3.5 w-3.5 mr-1.5' />
              )}
              Summarize
            </Button>
          )}
          {summaryEnabled && (
            <button
              type='button'
              onClick={() => setSummaryOpen(o => !o)}
              title='Toggle summary panel'
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                summaryOpen
                  ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-nvr-cyan'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-border dark:text-muted-foreground'
              )}
            >
              <PanelRight className='h-3.5 w-3.5' />
              Summary
            </button>
          )}
          <Button
            size='sm'
            onClick={() => handleSave()}
            disabled={mutation.isPending || aiChecking || isReadOnly}
            className='rounded-none'
          >
            {aiChecking ? (
              <Loader2 className='h-3.5 w-3.5 mr-1.5 animate-spin' />
            ) : (
              <Save className='h-3.5 w-3.5 mr-1.5' />
            )}
            {aiChecking ? 'Checking…' : mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div> {/* sticky header bar */}
    <div className='flex flex-1 min-h-0'>
    <div className='flex-1 min-w-0 overflow-y-auto'>
    <div className='p-8'>
      {/* Edit lock banner — shown when another user is editing this item */}
      <ItemLockBanner lockHolder={lockHolder} onTakeOver={takeOver} takingOver={takingOver} />

      {/* AI content validation — soft = overridable warning, hard = save blocked */}
      {aiWarning && (
        <div
          className={cn(
            'mb-4 rounded-lg border px-4 py-3 text-sm',
            aiWarning.mode === 'hard'
              ? 'border-red-200 bg-red-50 text-red-900'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          )}
        >
          <div className='flex items-start gap-3'>
            <AlertTriangle
              className={cn(
                'h-4 w-4 mt-0.5 shrink-0',
                aiWarning.mode === 'hard' ? 'text-red-500' : 'text-amber-500'
              )}
            />
            <div className='flex-1 min-w-0'>
              <p className='font-medium'>
                {aiWarning.mode === 'hard' ? 'Blocked by content rules' : 'Content rule warnings'}
              </p>
              <ul className='mt-1.5 space-y-1'>
                {aiWarning.violations.map((v) => (
                  <li key={v.rule} className='text-[13px]'>
                    <span className='font-medium'>{v.rule}</span>
                    {v.explanation && <span className='opacity-80'> — {v.explanation}</span>}
                  </li>
                ))}
              </ul>
              <div className='mt-3 flex items-center gap-2'>
                {aiWarning.mode === 'soft' && (
                  <Button
                    size='sm'
                    className='h-7 bg-amber-600 text-[12px] text-white hover:bg-amber-700'
                    disabled={mutation.isPending || aiChecking}
                    onClick={() => handleSave({ skipValidation: true })}
                  >
                    Save anyway
                  </Button>
                )}
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7 text-[12px]'
                  onClick={() => setAiWarning(null)}
                >
                  Keep editing
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* AI duplicate detection — possible matches found before creating a new item */}
      {aiDuplicates && (
        <div className='mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900'>
          <div className='flex items-start gap-3'>
            <AlertTriangle className='h-4 w-4 mt-0.5 shrink-0 text-amber-500' />
            <div className='flex-1 min-w-0'>
              <p className='font-medium'>Possible duplicates found</p>
              <ul className='mt-1.5 space-y-1'>
                {aiDuplicates.map((d) => (
                  <li key={String(d.id)} className='flex items-center gap-2 text-[13px]'>
                    <a
                      href={`/collections/${collection}/${d.id}`}
                      target='_blank'
                      rel='noreferrer'
                      className='inline-flex items-center gap-1 font-medium text-amber-800 underline hover:text-amber-950 truncate'
                    >
                      {d.label || `#${d.id}`}
                      <ExternalLink className='h-3 w-3 shrink-0' />
                    </a>
                    <span className='shrink-0 text-[11px] opacity-70'>
                      {Math.round(d.score <= 1 ? d.score * 100 : d.score)}% similar
                    </span>
                  </li>
                ))}
              </ul>
              <div className='mt-3 flex items-center gap-2'>
                <Button
                  size='sm'
                  className='h-7 bg-amber-600 text-[12px] text-white hover:bg-amber-700'
                  disabled={mutation.isPending || aiChecking}
                  onClick={() => handleSave({ skipValidation: true, skipDuplicates: true })}
                >
                  Create anyway
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7 text-[12px]'
                  onClick={() => setAiDuplicates(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
            <button
              type='button'
              onClick={() => setAiDuplicates(null)}
              className='shrink-0 text-amber-400 hover:text-amber-600'
              aria-label='Dismiss duplicates'
            >
              <X className='h-4 w-4' />
            </button>
          </div>
        </div>
      )}

      {summary && (
        <div className='mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900'>
          <Sparkles className='h-4 w-4 mt-0.5 shrink-0 text-amber-500' />
          <span className='flex-1'>{summary}</span>
          <button
            type='button'
            onClick={() => setSummary(null)}
            className='shrink-0 text-amber-400 hover:text-amber-600'
            aria-label='Dismiss summary'
          >
            <X className='h-4 w-4' />
          </button>
        </div>
      )}

      {isLoading || colMetaLoading ? (
        <div className='space-y-4'>
          {[...Array(5)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
            <Skeleton key={i} className='h-16 rounded-xl' />
          ))}
        </div>
      ) : (
        <div className='space-y-6'>
          {/* Pipeline state machine panel — shown only when a pipeline is bound to this
              collection AND not positioned in the layout (positioned renders in the section loop) */}
          {id && activeLayoutData !== undefined && !(pipelineSlot && pipelineSlot.is_visible !== 0 && pipelineSlot.is_visible !== false) && <PipelinePanel collection={collection!} item={id} onBeforeTransition={validateForm} />}

          {/* Parallel workflow branches — renders null when no branches are active */}
          {id && id !== 'new' && <WorkflowPanel collection={collection!} item={id} />}

          {/* ERP submission status — renders null when never submitted */}
          {id && id !== 'new' && <ErpStatusBadge collection={collection!} item={id} />}

          {/* Approval chains — renders null when this collection/item uses no approvals */}
          {id && id !== 'new' && <ApprovalPanel collection={collection!} item={id} />}

          {/* Hierarchy context — shows where this item sits in multi-collection hierarchies */}
          {id && id !== 'new' && relevantHierarchies.length > 0 && (
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm font-medium text-slate-500 flex items-center gap-1.5'>
                  <Network className='h-3.5 w-3.5' />
                  Hierarchy Membership
                </CardTitle>
              </CardHeader>
              <CardContent className='space-y-3'>
                {relevantHierarchies.map((hc, i) => {
                  const hierarchyAncestors = hierarchyAncestorResults[i]?.data ?? []
                  const levelIdx = hc.levels.findIndex((l) => l.collection === collection)
                  const level = hc.levels[levelIdx]
                  const isM2M = !!(
                    level?.junction_table &&
                    level?.junction_child_fk &&
                    level?.junction_parent_fk
                  )
                  return (
                    <div key={hc.id}>
                      <p className='text-[11px] font-medium text-slate-400 uppercase tracking-wide mb-1'>
                        {hc.name}
                      </p>
                      {hierarchyAncestors.length === 0 ? (
                        <p className='text-[12px] text-slate-400 italic'>No parent assigned</p>
                      ) : (
                        <nav className='flex items-center gap-1 flex-wrap text-[12px]'>
                          {hierarchyAncestors.map((anc, ai) => (
                            <span
                              key={`${anc.collection}-${anc.id}`}
                              className='flex items-center gap-1'
                            >
                              {ai > 0 && <span className='text-slate-300'>›</span>}
                              <Link
                                to={`/collections/${anc.collection}/${anc.id}`}
                                className='text-nvr-cyan hover:underline'
                              >
                                {anc.label}
                              </Link>
                            </span>
                          ))}
                          {isM2M && (
                            <span className='text-[10px] text-slate-400 ml-1'>(one path)</span>
                          )}
                        </nav>
                      )}
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          )}

          {/* Editable fields — wrapped in a fieldset so the edit lock can disable all inputs */}
          {editableFields.length > 0 && (
            <fieldset disabled={isReadOnly} className='m-0 min-w-0 border-0 p-0'>
              <Card>
                <CardContent className='space-y-5 pt-6'>
                  {/* Template picker for new items */}
                  {id === 'new' && (
                    <TemplatePicker
                      collection={collection!}
                      onApply={(data) => setDraft((d) => ({ ...d, ...data }))}
                    />
                  )}

                  {/* Ungrouped fields above tab strip — tab mode only, unless Layout places Ungrouped last; section mode places them via orderedSectionItems */}
                  {hasTabs && !ungroupedBelowTabs && groupedFields && groupedFields.ungrouped.filter(
                    (f) => !f.hidden && !SYSTEM_FIELDS.has(f.field) && !pathFieldNames.has(f.field) && !hiddenFields.has(f.field)
                  ).length > 0 && (
                    <div className='grid grid-cols-12 gap-4 items-start'>
                      {groupedFields.ungrouped
                        .filter((f) => !f.hidden && !SYSTEM_FIELDS.has(f.field) && !pathFieldNames.has(f.field) && !hiddenFields.has(f.field))
                        .map((field) => renderFieldOrPanel(field))}
                    </div>
                  )}

                  {hasTabs ? (
                    // ── Tab mode ────────────────────────────────────────────
                    <>
                      {/* Slot panels above tabs — slots whose sort is less than the minimum group sort */}
                      {(() => {
                        const minGroupSort = Math.min(...(groupedFields?.groups ?? []).map((g) => g.sort), 9999)
                        const aboveSlots = [
                          { key: '__pipeline__' as const, slot: pipelineSlot, sort: pipelineSlot ? pipelineSlot.sort : -1 },
                          { key: '__comments__' as const, slot: commentsSlot, sort: commentsSlot ? commentsSlot.sort : 99999 },
                          { key: '__tasks__' as const, slot: tasksSlot, sort: tasksSlot ? tasksSlot.sort : 99998 },
                        ]
                          .filter(({ slot }) => slot !== undefined && !(slot.is_visible === 0 || slot.is_visible === false) && slot.sort < minGroupSort)
                          .sort((a, b) => a.sort - b.sort)
                        if (aboveSlots.length === 0) return null
                        return aboveSlots.map(({ key, slot }) => {
                          if (key === '__pipeline__') {
                            if (!id || id === 'new') return null
                            return <div key='__pipeline__' className='mb-4'><PipelinePanel collection={collection!} item={id} title={slot?.label_override || undefined} defaultExpanded={slot?.default_expanded !== 0 && slot?.default_expanded !== false} onBeforeTransition={validateForm} /></div>
                          }
                          if (key === '__comments__') {
                            if (!id) return null
                            return <div key='__comments__' className='mb-4'><CommentPanel collection={collection!} item={id} title={slot?.label_override || undefined} defaultExpanded={slot?.default_expanded !== 0 && slot?.default_expanded !== false} /></div>
                          }
                          if (key === '__tasks__') {
                            if (!id || id === 'new') return null
                            return <div key='__tasks__' className='mb-4'><TaskPanel collection={collection!} item={id} title={slot?.label_override || undefined} defaultExpanded={slot?.default_expanded !== 0 && slot?.default_expanded !== false} /></div>
                          }
                          return null
                        })
                      })()}
                      {/* Stepper strip (steps mode) or tab strip */}
                      {isStepsMode ? (
                        <StepperStrip
                          steps={allSteps}
                          activeKey={activeTab}
                          completedKeys={completedStepKeys}
                          errorKeys={tabsWithErrors}
                          onStep={setActiveTab}
                        />
                      ) : null}
                      {!isStepsMode && <div className='mb-5 flex items-center gap-0.5 border-b border-slate-200 pb-0 -mt-1'>
                        {hasGeneralContent && (
                          <button
                            type='button'
                            onClick={() => setActiveTab('__general__')}
                            className={cn(
                              'relative flex items-center gap-1.5 rounded-t px-3.5 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                              activeTab === '__general__'
                                ? 'bg-white text-slate-900 shadow-[inset_0_-2px_0_#00ceff]'
                                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                            )}
                          >
                            General
                            {tabsWithErrors.has('__general__') && (
                              <span className='h-1.5 w-1.5 rounded-full bg-red-500' />
                            )}
                          </button>
                        )}
                        {tabGroups.map((g) => (
                          <button
                            key={g.key}
                            type='button'
                            onClick={() => setActiveTab(g.key)}
                            className={cn(
                              'relative flex items-center gap-1.5 rounded-t px-3.5 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                              activeTab === g.key
                                ? 'bg-white text-slate-900 shadow-[inset_0_-2px_0_#00ceff]'
                                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                            )}
                          >
                            {g.icon && (() => { const I = resolveCollectionIcon(g.icon!) as React.ElementType; return <I className='h-3.5 w-3.5 shrink-0 mr-1' /> })()}
                            {g.label}
                            {tabsWithErrors.has(g.key) && (
                              <span className='h-1.5 w-1.5 rounded-full bg-red-500' />
                            )}
                          </button>
                        ))}
                        <div className='ml-auto flex items-center pr-1'>
                          <span className='text-[11px] text-slate-400'>
                            {(hasGeneralContent ? 1 : 0) + tabGroups.length} tabs
                          </span>
                        </div>
                      </div>}

                      {/* General tab content — section groups only; ungrouped fields render above the strip */}
                      {activeTab === '__general__' && hasGeneralContent && (
                        <div className='space-y-4'>
                          {sectionGroups.map((group) => {
                            const gfl = (groupedFields!.groupedMap[group.key] ?? []).filter(
                              (f) => !f.hidden && !pathFieldNames.has(f.field) && !hiddenFields.has(f.field)
                            )
                            if (gfl.length === 0) return null
                            const isCollapsed = collapsedGroups.has(group.key)
                            return (
                              <div key={group.key} className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
                                <button
                                  type='button'
                                  onClick={() => toggleGroup(group.key)}
                                  className='flex w-full items-center justify-between bg-slate-50 border-b border-slate-200 px-4 py-3 text-[13px] font-medium text-slate-700'
                                >
                                  <span className='flex items-center gap-1.5'>
                                    {group.icon && (() => { const I = resolveCollectionIcon(group.icon!) as React.ElementType; return <I className='h-3.5 w-3.5 shrink-0 text-slate-400' /> })()}
                                    {group.label}
                                  </span>
                                  <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', isCollapsed ? '' : 'rotate-180')} />
                                </button>
                                {!isCollapsed && (
                                  <div className='grid grid-cols-12 gap-4 p-4 items-start'>
                                    {gfl.map((field) => renderFieldOrPanel(field))}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {/* Individual tab content */}
                      {tabGroups.map((group) => {
                        if (activeTab !== group.key) return null
                        const gfl = (groupedFields!.groupedMap[group.key] ?? []).filter(
                          (f) => !f.hidden && !pathFieldNames.has(f.field) && !hiddenFields.has(f.field)
                        )
                        if (gfl.length === 0) {
                          return (
                            <div key={group.key} className='flex flex-col items-center justify-center py-12 text-center'>
                              <p className='text-[13px] text-slate-400'>No fields in this tab.</p>
                              <p className='mt-1 text-[12px] text-slate-300'>Assign fields from Data Model → Field Groups.</p>
                            </div>
                          )
                        }
                        return (
                          <div key={group.key} className='grid grid-cols-12 gap-4 items-start'>
                            {gfl.map((field) => renderFieldOrPanel(field))}
                          </div>
                        )
                      })}
                      {/* Ungrouped fields below tab content — Layout tab placed the Ungrouped zone after all groups */}
                      {ungroupedBelowTabs && groupedFields && (() => {
                        const uf = groupedFields.ungrouped.filter(
                          (f) => !f.hidden && !SYSTEM_FIELDS.has(f.field) && !pathFieldNames.has(f.field) && !hiddenFields.has(f.field)
                        )
                        if (uf.length === 0) return null
                        return (
                          <div className='grid grid-cols-12 gap-4 items-start'>
                            {uf.map((field) => renderFieldOrPanel(field))}
                          </div>
                        )
                      })()}
                      {/* Steps Prev / Next */}
                      {isStepsMode && (
                        <div className='mt-6 border-t border-slate-200 pt-4 dark:border-border'>
                          <div className='flex items-center justify-between gap-2'>
                            <button
                              type='button'
                              onClick={handlePrev}
                              disabled={allSteps.findIndex(s => s.key === activeTab) === 0}
                              className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40 dark:border-border dark:bg-background dark:text-slate-300'
                            >
                              <ChevronDown className='h-3.5 w-3.5 rotate-90' />
                              Previous
                            </button>
                            <span className='text-[11px] text-slate-400'>
                              Step {allSteps.findIndex(s => s.key === activeTab) + 1} of {allSteps.length}
                            </span>
                            <div className='flex items-center gap-2'>
                              {allSteps.findIndex(s => s.key === activeTab) === allSteps.length - 1 && id && id !== 'new' && (
                                <PipelineTransitionButtons collection={collection!} item={id} onBeforeTransition={validateForm} />
                              )}
                              {allSteps.findIndex(s => s.key === activeTab) < allSteps.length - 1 ? (
                                <button
                                  type='button'
                                  onClick={handleNext}
                                  className='inline-flex items-center gap-1.5 rounded-md bg-[#00ceff] px-3 py-1.5 text-[12px] font-medium text-[#172940] transition-colors hover:bg-[#00b8e0]'
                                >
                                  Next
                                  <ChevronDown className='h-3.5 w-3.5 -rotate-90' />
                                </button>
                              ) : (
                                <button
                                  type='button'
                                  onClick={() => handleSave()}
                                  disabled={mutation.isPending || isReadOnly}
                                  className='inline-flex h-9 items-center gap-1.5 rounded-md bg-[#00ceff] px-3 text-[12px] font-medium text-[#172940] transition-colors hover:bg-[#00b8e0] disabled:opacity-50'
                                >
                                  <Save className='h-3.5 w-3.5' />
                                  Save
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                      {/* Slot panels below tabs — slots whose sort is >= minGroupSort, or slots with no assignment */}
                      {hasTabs && (() => {
                        const minGroupSort = Math.min(...(groupedFields?.groups ?? []).map((g) => g.sort), 9999)
                        const visibleSlots = [
                          { key: '__pipeline__' as const, slot: pipelineSlot, sort: pipelineSlot ? pipelineSlot.sort : 99997 },
                          { key: '__comments__' as const, slot: commentsSlot, sort: commentsSlot ? commentsSlot.sort : 99999 },
                          { key: '__tasks__' as const, slot: tasksSlot, sort: tasksSlot ? tasksSlot.sort : 99998 },
                        ]
                          .filter(({ slot, sort }) => {
                            if (slot && (slot.is_visible === 0 || slot.is_visible === false)) return false
                            // Only render here if not already rendered above the tab strip
                            if (slot !== undefined && sort < minGroupSort) return false
                            return true
                          })
                          .sort((a, b) => a.sort - b.sort)
                        return visibleSlots.map(({ key, slot }) => {
                          if (key === '__pipeline__') {
                            if (!id || id === 'new') return null
                            return <div key='__pipeline__' className='mt-4'><PipelinePanel collection={collection!} item={id} title={slot?.label_override || undefined} defaultExpanded={slot?.default_expanded !== 0 && slot?.default_expanded !== false} onBeforeTransition={validateForm} /></div>
                          }
                          if (key === '__comments__') {
                            if (!id) return null
                            return <div key='__comments__' className='mt-4'><CommentPanel collection={collection!} item={id} title={slot?.label_override || undefined} defaultExpanded={slot?.default_expanded !== 0 && slot?.default_expanded !== false} /></div>
                          }
                          if (key === '__tasks__') {
                            if (!id || id === 'new') return null
                            return <div key='__tasks__' className='mt-4'><TaskPanel collection={collection!} item={id} title={slot?.label_override || undefined} defaultExpanded={slot?.default_expanded !== 0 && slot?.default_expanded !== false} /></div>
                          }
                          return null
                        })
                      })()}
                    </>
                  ) : groupedFields ? (
                    // ── Section mode — groups + Ungrouped interleaved at Layout-configured position ──
                    <>
                      {orderedSectionItems.map((item) => {
                        if (item === '__ungrouped__') {
                          const uf = groupedFields.ungrouped.filter(
                            (f) => !f.hidden && !SYSTEM_FIELDS.has(f.field) && !pathFieldNames.has(f.field) && !hiddenFields.has(f.field)
                          )
                          if (uf.length === 0) return null
                          return (
                            <div key='__ungrouped__' className='grid grid-cols-12 gap-4 items-start'>
                              {uf.map((field) => renderFieldOrPanel(field))}
                            </div>
                          )
                        }
                        if (item === '__pipeline__') {
                          if (!id || id === 'new') return null
                          return (
                            <div key='__pipeline__' className='mb-4'>
                              <PipelinePanel collection={collection!} item={id} title={pipelineSlot?.label_override || undefined} defaultExpanded={pipelineSlot?.default_expanded !== 0 && pipelineSlot?.default_expanded !== false} onBeforeTransition={validateForm} />
                            </div>
                          )
                        }
                        if (item === '__comments__') {
                          if (!id) return null
                          return (
                            <div key='__comments__' className='mt-4'>
                              <CommentPanel collection={collection!} item={id} title={commentsSlot?.label_override || undefined} defaultExpanded={commentsSlot?.default_expanded !== 0 && commentsSlot?.default_expanded !== false} />
                            </div>
                          )
                        }
                        if (item === '__tasks__') {
                          if (!id || id === 'new') return null
                          return (
                            <div key='__tasks__'>
                              <TaskPanel collection={collection!} item={id} title={tasksSlot?.label_override || undefined} defaultExpanded={tasksSlot?.default_expanded !== 0 && tasksSlot?.default_expanded !== false} />
                            </div>
                          )
                        }
                        const group = item
                        const groupFieldList = (groupedFields.groupedMap[group.key] ?? []).filter(
                          (f) => !f.hidden && !pathFieldNames.has(f.field) && !hiddenFields.has(f.field)
                        )
                        if (groupFieldList.length === 0) return null
                        const isCollapsed = collapsedGroups.has(group.key)
                        // Metadata group — read-only definition list instead of editable fields.
                        if (group.type === 'metadata') {
                          return (
                            <div key={group.key} className='overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/40'>
                              <button type='button' onClick={() => toggleGroup(group.key)} className='flex w-full items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200 text-[13px] font-medium text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-300'>
                                <span className='flex items-center gap-1.5'>
                                  {group.icon && (() => { const I = resolveCollectionIcon(group.icon!) as React.ElementType; return <I className='h-3.5 w-3.5 shrink-0 text-slate-400' /> })()}
                                  {group.label}
                                </span>
                                <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', isCollapsed ? '' : 'rotate-180')} />
                              </button>
                              {!isCollapsed && (
                                <dl className='grid grid-cols-2 gap-x-4 gap-y-2 p-4'>
                                  {groupFieldList.map((field) => {
                                    const val = draft[field.field]
                                    const display =
                                      val === null || val === undefined || val === ''
                                        ? '—'
                                        : typeof val === 'boolean'
                                          ? val ? 'Yes' : 'No'
                                          : field.type === 'date' || field.type === 'datetime'
                                            ? (() => { try { return new Date(String(val)).toLocaleString() } catch { return String(val) } })()
                                            : typeof val === 'object'
                                              ? ((val as Record<string, unknown>).id != null ? String((val as Record<string, unknown>).id) : '—')
                                              : String(val)
                                    return (
                                      <div key={field.field} className='min-w-0'>
                                        <dt className='text-[11px] font-medium text-slate-400'>{field.label ?? titleCase(field.field)}</dt>
                                        <dd className='mt-0.5 truncate text-[12px] text-slate-700 dark:text-slate-300'>{display}</dd>
                                      </div>
                                    )
                                  })}
                                </dl>
                              )}
                            </div>
                          )
                        }
                        return (
                          <div key={group.key} className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
                            <button type='button' onClick={() => toggleGroup(group.key)} className='flex w-full items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200 text-[13px] font-medium text-slate-700'>
                              <span className='flex items-center gap-1.5'>
                                {group.icon && (() => { const I = resolveCollectionIcon(group.icon!) as React.ElementType; return <I className='h-3.5 w-3.5 shrink-0 text-slate-400' /> })()}
                                {group.label}
                              </span>
                              <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', isCollapsed ? '' : 'rotate-180')} />
                            </button>
                            {!isCollapsed && (
                              <div className='grid grid-cols-12 gap-4 p-4 items-start'>
                                {groupFieldList.map((field) => renderFieldOrPanel(field))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </>
                  ) : (
                    // ── No groups — flat list ────────────────────────────────
                    editableFields
                      .filter((f) => !hiddenFields.has(f.field))
                      .map((field) => (
                        <FieldRow
                          key={field.field}
                          field={field}
                          draft={draft}
                          inheritedMap={inheritedMap}
                          original={itemData as Record<string, unknown> | undefined}
                          lockedFields={lockedFields}
                          validationErrors={validationErrors}
                          treeConfig={treeConfig ?? null}
                          collection={collection!}
                          id={id}
                          colMeta={colMeta}
                          user={user}
                          generatingField={generatingField}
                          handleFieldChange={handleFieldChange}
                          handleGenerateField={handleGenerateField}
                          fieldConfigMap={fieldConfigMap}
                          m2mParentCommitted={m2mParentCommitted}
                          layoutAiEnabled={layoutAiEnabled}
                        />
                      ))
                  )}
                </CardContent>
              </Card>
            </fieldset>
          )}

          {/* Custom Attributes — dynamic EAV fields defined per collection */}
          {id && id !== 'new' && attributeDefs && attributeDefs.length > 0 && (
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm font-medium text-slate-500'>
                  Custom Attributes
                </CardTitle>
              </CardHeader>
              <CardContent className='space-y-4'>
                {attributeDefs.map((def) => (
                  <AttributeField
                    key={def.key}
                    def={def}
                    saving={saveAttributes.isPending}
                    onSave={(value) => saveAttributes.mutate({ [def.key]: value })}
                  />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Computed fields — read-only display; values come from server formula evaluation */}
          {computedFields.length > 0 && (
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm font-medium text-slate-500 flex items-center gap-1.5'>
                  <FunctionSquare className='h-3.5 w-3.5' />
                  Computed Values
                </CardTitle>
              </CardHeader>
              <CardContent className='space-y-4'>
                {computedFields.map((field) => {
                  const val = draft[field.field]
                  const display =
                    val === null || val === undefined
                      ? '—'
                      : typeof val === 'object'
                        ? JSON.stringify(val)
                        : String(val)
                  return (
                    <div key={field.field} className='space-y-1'>
                      <div className='flex items-center gap-1.5'>
                        <Label className='text-slate-600'>{field.label ?? titleCase(field.field)}</Label>
                        <span className='inline-flex items-center gap-0.5 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:bg-violet-900/30 dark:text-violet-400'>
                          {field.computed_type === 'write' ? 'write-time' : 'read-time'}
                        </span>
                        {field.note && (
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Info className='h-3.5 w-3.5 shrink-0 cursor-help text-slate-400 hover:text-slate-600 dark:hover:text-slate-300' />
                              </TooltipTrigger>
                              <TooltipContent side='top' className='max-w-[240px] text-[12px]'>{field.note}</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </div>
                      <div className='rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300'>
                        {display}
                      </div>
                      <p
                        className='text-[11px] text-slate-400 font-mono truncate'
                        title={field.computed_formula ?? ''}
                      >
                        = {field.computed_formula}
                      </p>
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          )}

          {/* System / read-only fields */}
          {systemFields.length > 0 && (
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm font-medium text-slate-500'>System</CardTitle>
              </CardHeader>
              <CardContent className='space-y-4'>
                {systemFields.map((field) => (
                  <div
                    key={field.field}
                    className='flex items-center justify-between py-1 border-b last:border-0'
                  >
                    <span className='text-sm text-muted-foreground'>{field.label ?? titleCase(field.field)}</span>
                    <span className='text-sm font-mono text-slate-700 max-w-xs truncate text-right'>
                      {draft[field.field] === null || draft[field.field] === undefined
                        ? '—'
                        : String(draft[field.field])}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {editableFields.length === 0 && systemFields.length === 0 && (
            <Card>
              <CardContent className='py-12 text-center text-muted-foreground text-sm'>
                No fields registered for this collection. Use the collections API or a seed script
                to import field metadata.
              </CardContent>
            </Card>
          )}

          {/* O2M relation panels */}
          {o2mRelations.map((rel) => (
            <O2MPanel
              key={`${rel.many_collection}-${rel.many_field}`}
              relation={rel}
              parentId={id!}
              onNavigate={(col) => navigate(`/collections/${col}`)}
            />
          ))}

          {/* M2M relations — all rendered as inline combobox regardless of one_field */}
          {[...namedM2mRelations, ...m2mRelations].map((rel) => {
            const label = rel.one_field ? titleCase(rel.one_field) : titleCase(rel.many_collection)
            const relField = allFields.find(f => f.field === rel.one_field)
            const relOpts = (() => { try { return typeof relField?.options === 'string' ? JSON.parse(relField.options) : (relField?.options ?? {}) } catch { return {} } })()
            const isSingle = relOpts.max_values === 1
            // Cascade filter: compute from fieldConfigMap for this relation's one_field
            const fieldName = (rel.one_field && rel.one_field !== 'id')
              ? rel.one_field
              : (rel.many_collection ?? `${rel.many_collection}.${rel.junction_field}`)
            const cascadeRules = getCascadeFilters(fieldConfigMap[fieldName]?.dependency_config)
            let m2mCascadeFilter: Record<string, unknown> | undefined
            let m2mCascadeParentLabel: string | null = null
            for (const rule of cascadeRules) {
              const parentVal = draft[rule.parent_field] ?? (() => {
                // M2M parent: staged first, then committed (for existing items)
                const parentRel = (relations as CMSRelation[]).find(
                  r => r.one_field === rule.parent_field && r.junction_field
                )
                if (parentRel) {
                  const key = parentRel.one_field ?? `${parentRel.many_collection}.${parentRel.junction_field}`
                  const staged = m2mLinks.get(key) ?? []
                  if (staged.length > 0) return staged[0]
                }
                const committed = m2mParentCommitted[rule.parent_field] ?? []
                return committed.length > 0 ? committed[0] : null
              })()
              if (parentVal != null && parentVal !== '') {
                if (!m2mCascadeFilter) m2mCascadeFilter = {}
                m2mCascadeFilter[rule.filter_column] = { _eq: parentVal }
                if (!m2mCascadeParentLabel) m2mCascadeParentLabel = titleCase(rule.parent_field)
              }
            }
            const hasM2MCascade = !!m2mCascadeFilter && Object.keys(m2mCascadeFilter).length > 0
            const m2mStagingKey = rel.one_field ?? `${rel.many_collection}.${rel.junction_field}`
            // Far-end collection for clear_on_unavailable checks
            const m2mFarEndRel = (relations as CMSRelation[]).find(
              r => r.many_collection === rel.many_collection && r.many_field === rel.junction_field && r.id !== rel.id
            )
            const m2mFarEndCollection = m2mFarEndRel?.one_collection ?? undefined
            const stagedIds = m2mLinks.get(m2mStagingKey) ?? []
            return (
              <div key={`${rel.many_collection}-${rel.junction_field}`} className='space-y-1.5'>
              {cascadeRules.length > 0 && (
                <CascadeEffectController
                  cascadeRules={cascadeRules}
                  cascadeFilter={m2mCascadeFilter}
                  currentValue={stagedIds[0] ?? (queryClient.getQueryData<Record<string, unknown>[]>(
                    ['m2m-items', rel.many_collection, rel.many_field, id]
                  ) ?? [])[0]?.[rel.junction_field!]}
                  relatedCollection={m2mFarEndCollection}
                  onClear={() => {
                    // Clear staged links
                    setM2mLinks(prev => { const next = new Map(prev); next.set(m2mStagingKey, []); return next })
                    // Stage unlinks for committed junction rows
                    const junctionItems = (queryClient.getQueryData<Record<string, unknown>[]>(
                      ['m2m-items', rel.many_collection, rel.many_field, id]
                    ) ?? [])
                    if (junctionItems.length > 0) {
                      setM2mUnlinks(prev => {
                        const next = new Map(prev)
                        const s = new Set(next.get(m2mStagingKey) ?? [])
                        junctionItems.forEach(ji => s.add(ji.id))
                        next.set(m2mStagingKey, s)
                        return next
                      })
                    }
                  }}
                />
              )}
                <div className='flex items-center gap-2'>
                  <Label className='text-slate-600'>{label}</Label>
                  {hasM2MCascade && m2mCascadeParentLabel && (
                    <span className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-[rgba(0,206,255,0.12)] text-[#00ceff]'>
                      <SlidersHorizontal className='h-2.5 w-2.5' />
                      Filtered by {m2mCascadeParentLabel}
                    </span>
                  )}
                </div>
                {!id || id === 'new' ? (
                  <p className='text-[12px] text-slate-400'>Save the record first to manage related items</p>
                ) : isSingle ? (
                  <M2MSingleSelectCombobox relation={rel} parentId={id} allRelations={relations} extraFilter={hasM2MCascade ? m2mCascadeFilter : undefined} />
                ) : (
                  <M2MMultiSelectCombobox relation={rel} parentId={id} allRelations={relations} extraFilter={hasM2MCascade ? m2mCascadeFilter : undefined} />
                )}
              </div>
            )
          })}

          {/* Comments & mentions — hardcoded position only when not positioned in the layout */}
          {id && !commentsSlot && !activeLayoutData?.layout?.disable_comments && (
            <div className='mt-6'>
              <CommentPanel collection={collection!} item={id} />
            </div>
          )}

          {/* Tasks attached to this record — hardcoded position only when not positioned in the layout */}
          {id && id !== 'new' && !tasksSlot && !activeLayoutData?.layout?.disable_tasks && <TaskPanel collection={collection!} item={id} />}

          {/* Addenda & Amendments */}
          {id && id !== 'new' && colMeta?.addendums_enabled && (
            <AddendumPanel collection={collection!} itemId={id} />
          )}
        </div>
      )}
    </div>
    </div> {/* overflow-y-auto scroll container */}
    {summaryEnabled && summaryOpen && groupedFields && (
      <SummaryPanel
        groups={groupedFields.groups}
        groupedMap={groupedFields.groupedMap}
        ungrouped={groupedFields.ungrouped}
        draft={draft}
        hiddenFields={hiddenFields}
        showAll={summaryShowAll}
        onClose={() => setSummaryOpen(false)}
        relations={relations}
        collection={collection!}
        allM2mRelations={allM2mRelations}
        m2mLinks={m2mLinks}
        m2mUnlinks={m2mUnlinks}
        itemId={id !== 'new' ? id : undefined}
        isReady={initialized}
        onNavigateToField={navigateToField}
      />
    )}
    </div> {/* content row flex */}
    </div> {/* outer flex-col */}
    </M2MStagingContext.Provider>
    </O2MGridContext.Provider>
  )
}

// ─── FieldRow helper — renders one editable field with label, AI button, validation ───

function FieldRow({
  field,
  draft,
  inheritedMap,
  original,
  lockedFields,
  validationErrors,
  treeConfig,
  collection,
  id,
  colMeta,
  user,
  generatingField,
  handleFieldChange,
  handleGenerateField,
  layoutAiEnabled = true,
  fieldConfigMap,
  m2mParentCommitted
}: {
  field: CMSField
  draft: Record<string, unknown>
  inheritedMap?: Record<string, unknown>
  original?: Record<string, unknown>
  lockedFields: Set<string>
  validationErrors: Record<string, string>
  treeConfig: { parent_field: string } | null
  collection: string
  id: string | undefined
  colMeta: { relations?: CMSRelation[] } | undefined
  user: { is_admin?: boolean } | null | undefined
  generatingField: string | null
  handleFieldChange: (f: string, v: unknown) => void
  handleGenerateField: (f: string) => void
  layoutAiEnabled?: boolean
  fieldConfigMap?: Record<string, { dependency_config?: string | null }>
  m2mParentCommitted?: Record<string, unknown[]>
}) {
  if (treeConfig && field.field === treeConfig.parent_field) {
    return (
      <div className='space-y-1.5' data-field={field.field}>
        <div className='flex items-center gap-1'>
          <Label>
            {field.label ?? titleCase(field.field)}
            {field.required && <span className='text-red-500 ml-0.5'>*</span>}
          </Label>
          {field.note && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className='h-3.5 w-3.5 shrink-0 cursor-help text-slate-400 hover:text-slate-600 dark:hover:text-slate-300' />
                </TooltipTrigger>
                <TooltipContent side='top' className='max-w-[240px] text-[12px]'>{field.note}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <TreePicker
          collection={collection}
          value={draft[field.field] as string | number | null}
          onChange={(v) => handleFieldChange(field.field, v)}
          excludeId={id !== 'new' ? (id ?? null) : null}
          placeholder='Select parent (leave empty for root)'
        />
        {validationErrors[field.field] && (
          <p className='mt-1 text-[11px] text-red-500'>{validationErrors[field.field]}</p>
        )}
      </div>
    )
  }

  const m2mStaging = useM2MStaging()
  const queryClient = useQueryClient()

  // Compute cascade filter state for this field
  const cascadeRules = getCascadeFilters(fieldConfigMap?.[field.field]?.dependency_config)
  let cascadeFilter: Record<string, unknown> | undefined
  let unsatisfiedParentLabel: string | null = null
  let cascadeParentLabel: string | null = null
  for (const rule of cascadeRules) {
    const parentVal = draft[rule.parent_field] ?? (() => {
      const parentRel = (colMeta?.relations as CMSRelation[] | undefined)?.find(
        r => r.one_field === rule.parent_field && r.junction_field
      )
      if (parentRel) {
        const key = parentRel.one_field ?? `${parentRel.many_collection}.${parentRel.junction_field}`
        const staged = m2mStaging?.getStagedLinks(key) ?? []
        if (staged.length > 0) return staged[0]
      }
      const committed = m2mParentCommitted?.[rule.parent_field] ?? []
      return committed.length > 0 ? committed[0] : null
    })()
    if (parentVal != null && parentVal !== '') {
      if (!cascadeFilter) cascadeFilter = {}
      cascadeFilter[rule.filter_column] = rule.filter_is_m2m
        ? { _some: { id: { _eq: parentVal } } }
        : { _eq: parentVal }
      if (!cascadeParentLabel) cascadeParentLabel = titleCase(rule.parent_field)
    } else if (!unsatisfiedParentLabel) {
      unsatisfiedParentLabel = titleCase(rule.parent_field)
    }
  }

  // Resolve child relation info for cascade controller
  const m2mRelForCascade = (colMeta?.relations as CMSRelation[] | undefined)?.find(
    r => r.one_field === field.field && r.junction_field
  )
  const m2oRelForCascade = m2mRelForCascade ? undefined : (colMeta?.relations as CMSRelation[] | undefined)?.find(
    r => r.many_collection === collection && r.many_field === field.field
  )
  // Far-end collection for M2M (needed for clear_on_unavailable check)
  const m2mFarEndRelForCascade = m2mRelForCascade
    ? (colMeta?.relations as CMSRelation[] | undefined)?.find(
        r => r.many_collection === m2mRelForCascade.many_collection &&
             r.many_field === m2mRelForCascade.junction_field &&
             r.id !== m2mRelForCascade.id
      )
    : undefined
  // Current value: for M2O use draft; for M2M use first staged or first committed junction item
  const m2mStagingKeyForCascade = m2mRelForCascade
    ? (m2mRelForCascade.one_field ?? `${m2mRelForCascade.many_collection}.${m2mRelForCascade.junction_field}`)
    : null
  const m2mStagedForCascade = m2mStagingKeyForCascade ? (m2mStaging?.getStagedLinks(m2mStagingKeyForCascade) ?? []) : []
  const m2mCommittedForCascade = m2mRelForCascade
    ? (queryClient.getQueryData<Record<string, unknown>[]>(
        ['m2m-items', m2mRelForCascade.many_collection, m2mRelForCascade.many_field, id]
      ) ?? []).map(ji => ji[m2mRelForCascade.junction_field!])
    : []
  const cascadeCurrentValue = m2mRelForCascade
    ? (m2mStagedForCascade[0] ?? m2mCommittedForCascade[0] ?? null)
    : draft[field.field]
  const cascadeRelatedCollection = m2mFarEndRelForCascade?.one_collection ?? m2oRelForCascade?.one_collection ?? undefined

  const isTextual =
    field.interface === 'input' ||
    field.interface === 'textarea' ||
    field.type === 'string' ||
    field.type === 'text'
  const isLocked = lockedFields.has(field.field)

  const isNumeric = field.type === 'integer' || field.type === 'float'

  // Inherited value chip — `_inherited` sidecar maps field → ancestor item id.
  // Once the user edits the value locally it becomes an override.
  const inheritedFrom = inheritedMap ? inheritedMap[field.field] : undefined
  const isOverridden =
    inheritedFrom !== undefined &&
    original !== undefined &&
    draft[field.field] !== original[field.field]

  return (
    <div className='space-y-1.5' data-field={field.field}>
      {cascadeRules.length > 0 && (
        <CascadeEffectController
          cascadeRules={cascadeRules}
          cascadeFilter={cascadeFilter}
          currentValue={cascadeCurrentValue}
          relatedCollection={cascadeRelatedCollection}
          onClear={() => {
            // Detect M2M child: has a relation where this field is the alias (one_field)
            const m2mRel = (colMeta?.relations as CMSRelation[] | undefined)?.find(
              r => r.one_field === field.field && r.junction_field
            )
            if (m2mRel) {
              const stagingKey = m2mRel.one_field ?? `${m2mRel.many_collection}.${m2mRel.junction_field}`
              // Unstage staged links
              const staged = m2mStaging?.getStagedLinks(stagingKey) ?? []
              staged.forEach(rid => m2mStaging?.unstageLink(stagingKey, rid))
              // Stage unlinks for committed junction rows (from query cache)
              const junctionItems = (queryClient.getQueryData<Record<string, unknown>[]>(
                ['m2m-items', m2mRel.many_collection, m2mRel.many_field, id]
              ) ?? [])
              junctionItems.forEach(ji => m2mStaging?.stageUnlink(stagingKey, ji.id))
            } else {
              handleFieldChange(field.field, null)
            }
          }}
        />
      )}
      <div className='flex flex-wrap items-center gap-1.5 min-h-[1.5rem]'>
        <Label htmlFor={field.field}>
          {field.field === 'id' ? 'ID' : (field.label ?? titleCase(field.field))}
          {field.required && <span className='text-red-500 ml-0.5'>*</span>}
        </Label>
        {isLocked && <span className='text-[10px] text-slate-400 italic'>locked</span>}
        {cascadeFilter && Object.keys(cascadeFilter).length > 0 && cascadeParentLabel && (
          <span className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-[rgba(0,206,255,0.12)] text-[#00ceff] dark:bg-nvr-cyan/15 dark:text-nvr-cyan'>
            <SlidersHorizontal className='h-2.5 w-2.5' />
            Filtered by {cascadeParentLabel}
          </span>
        )}
        {inheritedFrom !== undefined &&
          (isOverridden ? (
            <span className='inline-flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'>
              <ArrowDownToLine className='h-2.5 w-2.5' />
              Overridden
            </span>
          ) : (
            <span
              title='Value inherited from ancestor — edit to override'
              className='inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-muted dark:text-muted-foreground'
            >
              <ArrowDownToLine className='h-2.5 w-2.5' />
              Inherited
            </span>
          ))}
        {field.is_translatable && id && id !== 'new' && (
          <TranslationEditor
            collection={collection}
            item={id}
            field={field.field}
            type={field.type}
          />
        )}
        {isNumeric && id && id !== 'new' && (
          <FieldHistorySparkline collection={collection} item={id} field={field.field} />
        )}
        {isTextual && user?.is_admin && layoutAiEnabled && (
          <button
            type='button'
            onClick={() => handleGenerateField(field.field)}
            disabled={generatingField === field.field}
            className='inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-nvr-cyan hover:bg-nvr-cyan/10 disabled:opacity-50 transition-colors'
            title='Generate with AI'
          >
            {generatingField === field.field ? (
              <Loader2 className='h-3 w-3 animate-spin' />
            ) : (
              <Sparkles className='h-3 w-3' />
            )}
            AI
          </button>
        )}
        {field.note && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className='h-3.5 w-3.5 shrink-0 cursor-help text-slate-400 hover:text-slate-600 dark:hover:text-slate-300' />
              </TooltipTrigger>
              <TooltipContent side='top' className='max-w-[240px] text-[12px]'>{field.note}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <FieldInput
        field={{ ...field, readonly: field.readonly || isLocked }}
        value={draft[field.field]}
        onChange={(v) => handleFieldChange(field.field, v)}
        relations={colMeta?.relations ?? []}
        collection={collection}
        id={id}
        cascadeFilter={cascadeFilter}
        unsatisfiedParentLabel={unsatisfiedParentLabel}
        cascadeParentLabel={cascadeParentLabel}
        placeholder={(fieldConfigMap?.[field.field] as { placeholder?: string | null } | undefined)?.placeholder}
      />
      {validationErrors[field.field] && (
        <p className='mt-1 text-[11px] text-red-500'>{validationErrors[field.field]}</p>
      )}
    </div>
  )
}

// ─── RepeaterField ────────────────────────────────────────────────────────────

function RepeaterField({
  schema,
  rows,
  onChange,
  disabled
}: {
  schema: Array<{ key: string; label: string; type: string }>
  rows: Record<string, unknown>[]
  onChange: (rows: Record<string, unknown>[]) => void
  disabled?: boolean
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

  const addRow = () => {
    const empty: Record<string, unknown> = {}
    for (const col of schema) empty[col.key] = ''
    onChange([...rows, empty])
  }

  const removeRow = (idx: number) => {
    onChange(rows.filter((_, i) => i !== idx))
  }

  const updateCell = (idx: number, key: string, val: unknown) => {
    const next = rows.map((r, i) => (i === idx ? { ...r, [key]: val } : r))
    onChange(next)
  }

  return (
    <div className='space-y-2'>
      {rows.map((row, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: repeater rows indexed by position
        <div key={idx} className='rounded-lg border border-slate-200 bg-slate-50'>
          <div className='flex items-center justify-between px-3 py-2 border-b border-slate-200'>
            <span className='text-[12px] font-medium text-slate-600'>Row {idx + 1}</span>
            <div className='flex items-center gap-1'>
              <button
                type='button'
                onClick={() => {
                  const next = new Set(collapsed)
                  next.has(idx) ? next.delete(idx) : next.add(idx)
                  setCollapsed(next)
                }}
                className='rounded p-1 text-slate-400 hover:text-slate-600'
              >
                {collapsed.has(idx) ? (
                  <ChevronDown className='h-3.5 w-3.5' />
                ) : (
                  <ChevronUp className='h-3.5 w-3.5' />
                )}
              </button>
              {!disabled && (
                <button
                  type='button'
                  onClick={() => removeRow(idx)}
                  className='rounded p-1 text-slate-400 hover:text-red-500'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              )}
            </div>
          </div>
          {!collapsed.has(idx) && (
            <div className='grid grid-cols-2 gap-3 p-3'>
              {schema.map((col) => (
                <div key={col.key}>
                  <Label
                    className='mb-1 block text-[11px] font-medium text-slate-500'
                    htmlFor={`repeater-${idx}-${col.key}`}
                  >
                    {col.label}
                  </Label>
                  <Input
                    id={`repeater-${idx}-${col.key}`}
                    value={String(row[col.key] ?? '')}
                    onChange={(e) => updateCell(idx, col.key, e.target.value)}
                    disabled={disabled}
                    className='h-7 text-[12px]'
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {!disabled && (
        <button
          type='button'
          onClick={addRow}
          className='flex items-center gap-1.5 text-[12px] text-slate-400 hover:text-nvr-cyan transition-colors'
        >
          <Plus className='h-3.5 w-3.5' />
          Add row
        </button>
      )}
    </div>
  )
}

// ─── RichTextField ────────────────────────────────────────────────────────────

function RichTextField({
  value,
  onChange,
  disabled,
  placeholder
}: {
  value: string
  onChange: (v: unknown) => void
  disabled?: boolean
  placeholder?: string | null
}) {
  return (
    <RichTextEditor
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder={placeholder ?? 'Start writing…'}
    />
  )
}

// ─── SubRowsField ─────────────────────────────────────────────────────────────

function SubRowsField({
  collection,
  itemId,
  field,
  disabled
}: {
  collection: string
  itemId: string
  field: string
  disabled?: boolean
}) {
  const qc = useQueryClient()

  const { data: subRows = [] } = useQuery({
    queryKey: ['sub-rows', collection, itemId, field],
    queryFn: () =>
      api
        .get<{ data: SubRow[] }>(`/sub-rows/${collection}/${itemId}/${field}`)
        .then((r) => r.data.data),
    enabled: !!itemId && itemId !== 'new'
  })

  const [localItems, setLocalItems] = useState<
    Array<{ id?: number; sort: number; data: Record<string, unknown> }>
  >([])
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    if (subRows.length > 0 && !initialized) {
      setLocalItems(subRows)
      setInitialized(true)
    }
  }, [subRows, initialized])

  const saveMut = useMutation({
    mutationFn: (items: Array<{ id?: number; sort: number; data: Record<string, unknown> }>) =>
      api.patch(`/sub-rows/${collection}/${itemId}/${field}`, { items }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sub-rows', collection, itemId, field] })
      toast.success('Sub-rows saved')
    },
    onError: () => toast.error('Failed to save sub-rows')
  })

  // ─── Sub-row templates ───
  const [tplOpen, setTplOpen] = useState(false)
  const [tplSaving, setTplSaving] = useState(false)
  const [tplName, setTplName] = useState('')
  const [tplConfirmDelete, setTplConfirmDelete] = useState<number | null>(null)

  const { data: templates = [] } = useQuery({
    queryKey: ['sub-row-templates', collection, field],
    queryFn: () =>
      api
        .get<{ data: SubRowTemplate[] }>(`/sub-rows/templates/${collection}/${field}`)
        .then((r) => r.data.data),
    enabled: !!collection && !!field && itemId !== 'new'
  })

  // Append template rows to the local (unsaved) items; supports both raw data
  // rows and {sort, data} shaped rows in the stored template.
  const appendTemplateRows = (items: unknown[], name: string) => {
    setLocalItems((prev) => {
      let nextSort = prev.length ? Math.max(...prev.map((i) => i.sort)) + 1 : 1
      const mapped = items.map((raw) => {
        const obj = (raw ?? {}) as Record<string, unknown>
        const data =
          obj.data && typeof obj.data === 'object'
            ? (obj.data as Record<string, unknown>)
            : (obj as Record<string, unknown>)
        return { sort: nextSort++, data }
      })
      return [...prev, ...mapped]
    })
    setInitialized(true) // protect appended rows from the init effect
    toast.success(`Applied ${name}`)
  }

  const applyTplMut = useMutation({
    mutationFn: (tpl: SubRowTemplate) =>
      api
        .post<{ items: unknown[] }>(`/sub-rows/templates/${tpl.id}/apply`)
        .then((r) => ({ tpl, items: r.data.items })),
    onSuccess: ({ tpl, items }) => {
      appendTemplateRows(Array.isArray(items) ? items : [], tpl.name)
      setTplOpen(false)
    },
    onError: () => toast.error('Failed to apply template')
  })

  const createTplMut = useMutation({
    mutationFn: (name: string) =>
      api.post('/sub-rows/templates', {
        collection,
        field,
        name,
        items: localItems.map((i) => i.data)
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sub-row-templates', collection, field] })
      setTplName('')
      setTplSaving(false)
      toast.success('Template saved')
    },
    onError: () => toast.error('Failed to save template')
  })

  const deleteTplMut = useMutation({
    mutationFn: (tplId: number) => api.delete(`/sub-rows/templates/${tplId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sub-row-templates', collection, field] })
      setTplConfirmDelete(null)
      toast.success('Template deleted')
    },
    onError: () => toast.error('Failed to delete template')
  })

  if (itemId === 'new') {
    return <p className='text-[12px] text-slate-400'>Save the item first to add sub-rows.</p>
  }

  const columns = localItems[0]
    ? Object.keys(localItems[0].data)
    : ['description', 'quantity', 'unit_price', 'total']

  const addRow = () => {
    const empty: Record<string, unknown> = {}
    for (const col of columns) empty[col] = ''
    const nextSort = localItems.length ? Math.max(...localItems.map((i) => i.sort)) + 1 : 1
    setLocalItems([...localItems, { sort: nextSort, data: empty }])
  }

  const removeRow = (idx: number) => setLocalItems(localItems.filter((_, i) => i !== idx))

  const updateCell = (idx: number, key: string, val: string) => {
    setLocalItems(
      localItems.map((item, i) =>
        i === idx ? { ...item, data: { ...item.data, [key]: val } } : item
      )
    )
  }

  return (
    <div className='space-y-2'>
      <div className='overflow-x-auto rounded-lg border border-slate-200'>
        <table className='w-full text-[12px]'>
          <thead>
            <tr className='bg-slate-50 border-b border-slate-200'>
              {columns.map((col) => (
                <th key={col} className='px-3 py-2 text-left font-medium text-slate-600 capitalize'>
                  {col.replace(/_/g, ' ')}
                </th>
              ))}
              {!disabled && <th className='w-8' />}
            </tr>
          </thead>
          <tbody>
            {localItems.map((item, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: line items indexed by position
              <tr key={idx} className='border-b border-slate-100 last:border-0'>
                {columns.map((col) => (
                  <td key={col} className='px-2 py-1'>
                    <Input
                      value={String(item.data[col] ?? '')}
                      onChange={(e) => updateCell(idx, col, e.target.value)}
                      disabled={disabled}
                      className='h-7 border-0 focus-visible:ring-1 text-[12px] bg-transparent'
                    />
                  </td>
                ))}
                {!disabled && (
                  <td className='px-2 py-1'>
                    <button
                      type='button'
                      onClick={() => removeRow(idx)}
                      className='text-slate-400 hover:text-red-500'
                    >
                      <X className='h-3.5 w-3.5' />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!disabled && (
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-4'>
            <button
              type='button'
              onClick={addRow}
              className='flex items-center gap-1.5 text-[12px] text-slate-400 hover:text-nvr-cyan transition-colors'
            >
              <Plus className='h-3.5 w-3.5' />
              Add row
            </button>
            {(templates.length > 0 || localItems.length > 0) && (
              <Popover
                open={tplOpen}
                onOpenChange={(o) => {
                  setTplOpen(o)
                  if (!o) {
                    setTplSaving(false)
                    setTplName('')
                    setTplConfirmDelete(null)
                  }
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type='button'
                    className='flex items-center gap-1.5 text-[12px] text-slate-400 hover:text-nvr-cyan transition-colors'
                  >
                    <LayoutTemplate className='h-3.5 w-3.5' />
                    Templates
                    <ChevronsUpDown className='h-3 w-3' />
                  </button>
                </PopoverTrigger>
                <PopoverContent className='w-72 p-0' align='start'>
                  {tplSaving ? (
                    <div className='space-y-2 p-3'>
                      <Label className='text-[11px]' htmlFor={`tpl-name-${field}`}>
                        Template name
                      </Label>
                      <Input
                        id={`tpl-name-${field}`}
                        value={tplName}
                        onChange={(e) => setTplName(e.target.value)}
                        className='h-7 text-[12px]'
                        placeholder='e.g. Standard kit'
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && tplName.trim() && !createTplMut.isPending) {
                            createTplMut.mutate(tplName.trim())
                          }
                        }}
                      />
                      <div className='flex justify-end gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          className='h-7 text-[12px]'
                          onClick={() => {
                            setTplSaving(false)
                            setTplName('')
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size='sm'
                          className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
                          disabled={!tplName.trim() || createTplMut.isPending}
                          onClick={() => createTplMut.mutate(tplName.trim())}
                        >
                          {createTplMut.isPending ? 'Saving…' : 'Save template'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Command>
                      <CommandInput placeholder='Search templates…' className='h-8 text-[12px]' />
                      <CommandList>
                        {templates.length > 0 && (
                          <CommandGroup heading='Apply template'>
                            {templates.map((t) => (
                              <CommandItem
                                key={t.id}
                                value={t.name}
                                disabled={applyTplMut.isPending}
                                onSelect={() => applyTplMut.mutate(t)}
                                className='text-[12px]'
                              >
                                <span className='flex-1 truncate'>{t.name}</span>
                                <span className='mr-1 shrink-0 text-[10px] text-slate-400'>
                                  {Array.isArray(t.items) ? t.items.length : 0} rows
                                </span>
                                {tplConfirmDelete === t.id ? (
                                  <>
                                    <button
                                      type='button'
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        deleteTplMut.mutate(t.id)
                                      }}
                                      disabled={deleteTplMut.isPending}
                                      className='shrink-0 text-[10px] font-medium text-red-500 hover:text-red-600 disabled:opacity-50'
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      type='button'
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setTplConfirmDelete(null)
                                      }}
                                      className='ml-1 shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-600'
                                      aria-label='Cancel delete'
                                    >
                                      <X className='h-3 w-3' />
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type='button'
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setTplConfirmDelete(t.id)
                                    }}
                                    className='shrink-0 rounded p-0.5 text-slate-300 hover:text-red-500'
                                    aria-label={`Delete template ${t.name}`}
                                  >
                                    <Trash2 className='h-3 w-3' />
                                  </button>
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {localItems.length > 0 && (
                          <CommandGroup>
                            <CommandItem
                              value='save-current-as-template'
                              onSelect={() => setTplSaving(true)}
                              className='text-[12px]'
                            >
                              <Plus className='mr-1.5 h-3 w-3' />
                              Save current as template…
                            </CommandItem>
                          </CommandGroup>
                        )}
                      </CommandList>
                    </Command>
                  )}
                </PopoverContent>
              </Popover>
            )}
          </div>
          <Button
            size='sm'
            className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
            disabled={saveMut.isPending}
            onClick={() => saveMut.mutate(localItems)}
          >
            {saveMut.isPending ? 'Saving…' : 'Save rows'}
          </Button>
        </div>
      )}
    </div>
  )
}

// ─── AddendumPanel ────────────────────────────────────────────────────────────

function AddendumPanel({ collection, itemId }: { collection: string; itemId: string }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newCost, setNewCost] = useState('')
  const [newDays, setNewDays] = useState('')

  const { data: addendums = [] } = useQuery({
    queryKey: ['addendums', collection, itemId],
    queryFn: () =>
      api.get<{ data: Addendum[] }>(`/addendums/${collection}/${itemId}`).then((r) => r.data.data)
  })

  const createMut = useMutation({
    mutationFn: (body: {
      title: string
      description?: string
      cost_impact?: number
      timeline_impact_days?: number
    }) => api.post('/addendums', { parent_collection: collection, parent_id: itemId, ...body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['addendums', collection, itemId] })
      setAdding(false)
      setNewTitle('')
      setNewDesc('')
      setNewCost('')
      setNewDays('')
      toast.success('Addendum created')
    },
    onError: () => toast.error('Failed to create addendum')
  })

  const approveMut = useMutation({
    mutationFn: (aId: string) => api.post(`/addendums/${aId}/approve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['addendums', collection, itemId] })
      toast.success('Addendum approved')
    }
  })

  const STATUS_COLORS: Record<string, string> = {
    draft: 'bg-slate-100 text-slate-600',
    review: 'bg-amber-100 text-amber-700',
    approved: 'bg-emerald-100 text-emerald-700',
    rejected: 'bg-red-100 text-red-600'
  }

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='flex items-center justify-between px-4 py-3 border-b border-slate-200'>
        <h3 className='text-[13px] font-medium text-slate-700'>Addenda & Amendments</h3>
        <Button
          size='sm'
          variant='outline'
          className='h-7 text-[12px]'
          onClick={() => setAdding(true)}
        >
          <Plus className='mr-1 h-3.5 w-3.5' />
          New Addendum
        </Button>
      </div>

      {addendums.length === 0 && !adding ? (
        <div className='px-4 py-6 text-center text-[12px] text-slate-400'>
          No addenda attached to this record
        </div>
      ) : (
        <div className='divide-y divide-slate-100'>
          {addendums.map((a) => (
            <div key={a.id} className='flex items-start gap-3 px-4 py-3'>
              <div className='flex-1 min-w-0'>
                <div className='flex items-center gap-2'>
                  <span className='text-[13px] font-medium text-slate-800'>{a.title}</span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium',
                      STATUS_COLORS[a.status] ?? STATUS_COLORS.draft
                    )}
                  >
                    {a.status}
                  </span>
                </div>
                {a.description && (
                  <p className='mt-0.5 text-[12px] text-slate-500 line-clamp-2'>{a.description}</p>
                )}
                <div className='mt-1 flex items-center gap-3 text-[11px] text-slate-400'>
                  {a.cost_impact != null && (
                    <span>
                      Cost: {a.cost_impact >= 0 ? '+' : ''}
                      {a.cost_impact}
                    </span>
                  )}
                  {a.timeline_impact_days != null && (
                    <span>
                      Timeline: {a.timeline_impact_days >= 0 ? '+' : ''}
                      {a.timeline_impact_days}d
                    </span>
                  )}
                </div>
              </div>
              {a.status === 'review' && (
                <Button
                  size='sm'
                  className='h-7 shrink-0 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700'
                  onClick={() => approveMut.mutate(a.id)}
                  disabled={approveMut.isPending}
                >
                  Approve
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div className='border-t border-slate-200 bg-slate-50 p-4 space-y-3'>
          <p className='text-[12px] font-medium text-slate-600'>New Addendum</p>
          <div className='grid grid-cols-2 gap-3'>
            <div className='col-span-2'>
              <Label className='mb-1 block text-[11px]'>Title</Label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className='h-7 text-[12px]'
                placeholder='Amendment title'
              />
            </div>
            <div className='col-span-2'>
              <Label className='mb-1 block text-[11px]'>Description</Label>
              <Textarea
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                rows={2}
                className='text-[12px]'
                placeholder='Describe the amendment…'
              />
            </div>
            <div>
              <Label className='mb-1 block text-[11px]'>Cost Impact</Label>
              <Input
                type='number'
                value={newCost}
                onChange={(e) => setNewCost(e.target.value)}
                className='h-7 text-[12px]'
                placeholder='0.00'
              />
            </div>
            <div>
              <Label className='mb-1 block text-[11px]'>Timeline (days)</Label>
              <Input
                type='number'
                value={newDays}
                onChange={(e) => setNewDays(e.target.value)}
                className='h-7 text-[12px]'
                placeholder='0'
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
              className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
              disabled={!newTitle.trim() || createMut.isPending}
              onClick={() =>
                createMut.mutate({
                  title: newTitle.trim(),
                  description: newDesc || undefined,
                  cost_impact: newCost ? parseFloat(newCost) : undefined,
                  timeline_impact_days: newDays ? parseInt(newDays, 10) : undefined
                })
              }
            >
              {createMut.isPending ? 'Creating…' : 'Create Addendum'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── ScheduleChangeDialog ─────────────────────────────────────────────────────

function ScheduleChangeDialog({
  collection,
  itemId,
  fields,
  triggerClassName
}: {
  collection: string
  itemId: string
  currentValues: Record<string, unknown>
  fields: CMSField[]
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false)
  const [selectedField, setSelectedField] = useState('')
  const [newValue, setNewValue] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')

  const createMut = useMutation({
    mutationFn: () =>
      api.post('/scheduled-changes', {
        collection,
        item_id: itemId,
        change_type: 'field_update',
        changes: { [selectedField]: newValue },
        scheduled_at: scheduledAt
      }),
    onSuccess: () => {
      setOpen(false)
      setSelectedField('')
      setNewValue('')
      setScheduledAt('')
      toast.success('Change scheduled')
    },
    onError: () => toast.error('Failed to schedule change')
  })

  const visibleFields = fields.filter((f) => !f.hidden)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size='sm' variant='outline' className={triggerClassName}>
          <CalendarClock className='mr-1.5 h-3.5 w-3.5' />
          Schedule
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-80 p-4' align='end'>
        <p className='mb-3 text-[13px] font-medium'>Schedule a field change</p>
        <div className='space-y-3'>
          <div>
            <Label className='mb-1 block text-[11px]'>Field</Label>
            <Popover open={fieldPickerOpen} onOpenChange={setFieldPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant='outline'
                  role='combobox'
                  aria-expanded={fieldPickerOpen}
                  className='h-7 w-full justify-between px-2 text-[12px] font-normal'
                >
                  <span className={selectedField ? '' : 'text-muted-foreground'}>
                    {selectedField || 'Select a field…'}
                  </span>
                  <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
                </Button>
              </PopoverTrigger>
              <PopoverContent className='w-[--radix-popover-trigger-width] p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
                  <CommandList>
                    <CommandGroup>
                      {visibleFields.map((f) => (
                        <CommandItem
                          key={f.field}
                          value={f.field}
                          onSelect={() => {
                            setSelectedField(f.field === selectedField ? '' : f.field)
                            setFieldPickerOpen(false)
                          }}
                          className='text-[12px]'
                        >
                          <Check
                            className={cn(
                              'mr-2 h-3.5 w-3.5',
                              selectedField === f.field ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          {f.field}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div>
            <Label className='mb-1 block text-[11px]'>New value</Label>
            <Input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              className='h-7 text-[12px]'
            />
          </div>
          <div>
            <Label className='mb-1 block text-[11px]'>Scheduled at</Label>
            <Input
              type='datetime-local'
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className='h-7 text-[12px]'
            />
          </div>
          <Button
            size='sm'
            className='w-full h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
            disabled={!selectedField || !newValue || !scheduledAt || createMut.isPending}
            onClick={() => createMut.mutate()}
          >
            {createMut.isPending ? 'Scheduling…' : 'Schedule Change'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── TemplatePicker ───────────────────────────────────────────────────────────

function TemplatePicker({
  collection,
  onApply
}: {
  collection: string
  onApply: (data: Record<string, unknown>) => void
}) {
  const [open, setOpen] = useState(false)

  const { data: templates = [] } = useQuery({
    queryKey: ['record-templates', collection],
    queryFn: () =>
      api
        .get<{ data: RecordTemplate[] }>(`/record-templates/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection
  })

  if (templates.length === 0) return null

  return (
    <div className='flex items-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-2'>
      <span className='text-[12px] text-slate-500'>Start from a template?</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size='sm' variant='outline' className='h-6 text-[11px]'>
            Choose template
            <ChevronsUpDown className='ml-1 h-3 w-3' />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-64 p-0' align='start'>
          <Command>
            <CommandInput placeholder='Search templates…' className='h-8 text-[12px]' />
            <CommandList>
              {templates.map((t) => (
                <CommandItem
                  key={t.id}
                  value={t.name}
                  onSelect={() => {
                    onApply(t.data)
                    setOpen(false)
                    toast.success(`Applied template: ${t.name}`)
                  }}
                  className='text-[12px]'
                >
                  <div>
                    <p className='font-medium'>{t.name}</p>
                    {t.description && (
                      <p className='text-[11px] text-muted-foreground'>{t.description}</p>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

const SKELETON_ROWS = [1, 2, 3]

function RelationPanelHeader({
  title,
  subtitle,
  count,
  loading,
  viewAllCollection,
  onNavigate,
  actions
}: {
  title: string
  subtitle: string
  count: number
  loading: boolean
  viewAllCollection: string | null
  onNavigate: (col: string) => void
  actions?: React.ReactNode
}) {
  return (
    <div className='flex items-center justify-between'>
      <CardTitle className='text-sm font-medium text-slate-500'>
        {title}
        <span className='ml-1.5 font-mono text-slate-400 text-[11px] normal-case'>{subtitle}</span>
      </CardTitle>
      <div className='flex items-center gap-2'>
        <Badge variant='secondary' className='text-[11px]'>
          {loading ? '…' : count}
        </Badge>
        {viewAllCollection && (
          <button
            type='button'
            onClick={() => onNavigate(viewAllCollection)}
            className='flex items-center gap-1 text-[12px] text-slate-400 hover:text-nvr-cyan transition-colors'
          >
            <ExternalLink className='h-3 w-3' />
            View all
          </button>
        )}
        {actions}
      </div>
    </div>
  )
}

function LinkRelationPopover({
  collection,
  displayTemplate,
  excludeIds,
  onSelect,
  disabled
}: {
  collection: string
  displayTemplate: string | null
  excludeIds: Set<string>
  onSelect: (id: unknown) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 200)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [search])

  const templateFields = extractTemplateFields(displayTemplate)

  const { data: items, isLoading } = useQuery({
    queryKey: ['link-pick', collection, debouncedSearch],
    queryFn: async () => {
      const res = await api.get(`/items/${collection}`, {
        params: {
          limit: 50,
          fields: templateFields.join(','),
          search: debouncedSearch || undefined
        }
      })
      return (res.data.data ?? []) as Record<string, unknown>[]
    },
    enabled: open,
    staleTime: 30 * 1000
  })

  const filtered = items?.filter((item) => !excludeIds.has(String(item.id)))

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size='sm'
          variant='outline'
          disabled={disabled}
          className='h-7 px-2 text-[12px] border-nvr-cyan/40 text-nvr-cyan hover:bg-nvr-cyan/5'
        >
          <Plus className='h-3 w-3 mr-1' />
          Link
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-2' align='end'>
        <Input
          placeholder='Search…'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='h-8 text-[13px] mb-2'
          autoFocus
        />
        <ScrollArea className='h-[200px]'>
          <div className='space-y-0.5'>
            {isLoading && <div className='px-3 py-2 text-[13px] text-slate-400'>Loading…</div>}
            {!isLoading && (!filtered || filtered.length === 0) && (
              <div className='px-3 py-2 text-[13px] text-slate-400'>No results</div>
            )}
            {filtered?.map((item) => (
              <button
                type='button'
                key={String(item.id)}
                onClick={() => {
                  onSelect(item.id)
                  setOpen(false)
                  setSearch('')
                }}
                className='flex items-center px-3 py-2 text-[13px] text-slate-800 hover:bg-slate-50 cursor-pointer rounded-md w-full text-left truncate'
              >
                {renderDisplayTemplate(displayTemplate, item)}
              </button>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

function O2MInlineGrid({
  relation,
  parentId,
  layoutId,
  showTotals,
}: {
  relation: CMSRelation
  parentId: string
  layoutId: number | null
  showTotals?: boolean
}) {
  const qc = useQueryClient()
  const gridCtx = useO2MGridContext()

  const { data: fieldConfigData = [] } = useQuery({
    queryKey: ['field-config', relation.many_collection, layoutId],
    queryFn: () => api.get(`/field-config/${relation.many_collection}${layoutId ? `?layout_id=${layoutId}` : ''}`).then(r => (r.data.data ?? []) as CMSField[]),
    staleTime: 60_000,
  })
  const columns = fieldConfigData.filter(f => !f.hidden && f.field !== relation.many_field && f.field !== 'id')

  const { data: fetchedRows = [] } = useQuery({
    queryKey: ['o2m-grid', relation.many_collection, relation.many_field, parentId],
    queryFn: () => api.get(`/items/${relation.many_collection}`, {
      params: { filter: JSON.stringify({ [relation.many_field]: { _eq: parentId } }), limit: 200, fields: '*' },
    }).then(r => (r.data.data ?? []) as Record<string, unknown>[]),
    staleTime: 30_000,
  })

  const [stagedEdits, setStagedEdits] = useState<Map<string, Record<string, unknown>>>(new Map())
  const [stagedNew, setStagedNew] = useState<Record<string, unknown>[]>([])
  const [stagedDeletes, setStagedDeletes] = useState<Set<string>>(new Set())

  const hasPending = stagedEdits.size > 0 || stagedNew.length > 0 || stagedDeletes.size > 0
  const stagingKey = `${relation.many_collection}.${relation.many_field}`

  useEffect(() => {
    const flush = async () => {
      for (const id of stagedDeletes) await api.delete(`/items/${relation.many_collection}/${id}`)
      for (const row of stagedNew) await api.post(`/items/${relation.many_collection}`, { ...row, [relation.many_field]: parentId })
      for (const [id, changes] of stagedEdits) {
        if (!stagedDeletes.has(id)) await api.patch(`/items/${relation.many_collection}/${id}`, changes)
      }
      setStagedEdits(new Map()); setStagedNew([]); setStagedDeletes(new Set())
      qc.invalidateQueries({ queryKey: ['o2m-grid', relation.many_collection] })
    }
    gridCtx?.register(stagingKey, flush)
    return () => gridCtx?.unregister(stagingKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagingKey, stagedEdits, stagedNew, stagedDeletes, parentId])

  const visibleRows = fetchedRows.filter(r => !stagedDeletes.has(String(r.id)))
  const allRows = [...visibleRows.map(r => ({ ...r, ...(stagedEdits.get(String(r.id)) ?? {}) })), ...stagedNew]

  function getVal(row: Record<string, unknown>, field: string, isNew: boolean, ni: number) {
    if (isNew) return stagedNew[ni]?.[field] ?? ''
    return stagedEdits.get(String(row.id))?.[field] ?? row[field] ?? ''
  }
  function setVal(row: Record<string, unknown>, field: string, value: unknown, isNew: boolean, ni: number) {
    if (isNew) { setStagedNew(p => p.map((r, i) => i === ni ? { ...r, [field]: value } : r)); return }
    const id = String(row.id)
    setStagedEdits(p => { const n = new Map(p); n.set(id, { ...(n.get(id) ?? {}), [field]: value }); return n })
  }

  function renderCell(col: CMSField, row: Record<string, unknown>, isNew: boolean, ni: number) {
    const val = getVal(row, col.field, isNew, ni)
    const set = (v: unknown) => setVal(row, col.field, v, isNew, ni)
    const cls = 'w-full h-7 rounded border border-transparent bg-transparent px-1.5 text-[12px] focus:border-nvr-cyan focus:bg-white dark:focus:bg-card focus:outline-none'
    const isNum = ['integer', 'bigInteger', 'float', 'decimal', 'numeric'].includes(col.type)
    if (col.type === 'boolean') return <input type='checkbox' checked={!!val} onChange={e => set(e.target.checked)} className='h-4 w-4 accent-nvr-cyan' />
    if (isNum) return <input type='number' value={val === null || val === undefined ? '' : String(val)} onChange={e => set(e.target.value === '' ? null : Number(e.target.value))} className={cls} />
    if (col.type === 'datetime' || col.interface === 'datetime') return <input type='datetime-local' value={val ? String(val).slice(0, 16) : ''} onChange={e => set(e.target.value ? new Date(e.target.value).toISOString() : null)} className={cls} />
    return <input type='text' value={val === null || val === undefined ? '' : String(val)} onChange={e => set(e.target.value || null)} className={cls} />
  }

  return (
    <div className='rounded-lg border border-slate-200 dark:border-border overflow-hidden'>
      {hasPending && (
        <div className='flex items-center gap-1.5 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400'>
          <span className='h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0' />
          Unsaved changes — will save with the record
        </div>
      )}
      <div className='overflow-x-auto'>
        <table className='w-full text-[12px]'>
          <thead>
            <tr className='border-b border-slate-200 dark:border-border bg-slate-50 dark:bg-muted/40'>
              {columns.map(col => (
                <th key={col.field} className='px-2 py-2 text-left text-[11px] font-medium text-slate-500 dark:text-muted-foreground whitespace-nowrap'>
                  {col.label ?? titleCase(col.field)}
                </th>
              ))}
              <th className='w-8' />
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border'>
            {visibleRows.map(row => (
              <tr key={String(row.id)} className='hover:bg-slate-50/50 dark:hover:bg-muted/20'>
                {columns.map(col => <td key={col.field} className='px-2 py-0.5'>{renderCell(col, row, false, -1)}</td>)}
                <td className='px-1'>
                  <button type='button' onClick={() => setStagedDeletes(p => { const n = new Set(p); n.add(String(row.id)); return n })} className='rounded p-1 text-slate-300 hover:text-red-400'>
                    <X className='h-3.5 w-3.5' />
                  </button>
                </td>
              </tr>
            ))}
            {stagedNew.map((row, idx) => (
              <tr key={`new-${idx}`} className='bg-nvr-cyan/5 dark:bg-nvr-cyan/10'>
                {columns.map(col => <td key={col.field} className='px-2 py-0.5'>{renderCell(col, row, true, idx)}</td>)}
                <td className='px-1'>
                  <button type='button' onClick={() => setStagedNew(p => p.filter((_, i) => i !== idx))} className='rounded p-1 text-slate-300 hover:text-red-400'>
                    <X className='h-3.5 w-3.5' />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          {showTotals && columns.some(c => ['integer', 'bigInteger', 'float', 'decimal', 'numeric'].includes(c.type)) && (
            <tfoot>
              <tr className='border-t-2 border-slate-200 dark:border-border bg-slate-50 dark:bg-muted/40'>
                {columns.map(col => {
                  const isNum = ['integer', 'bigInteger', 'float', 'decimal', 'numeric'].includes(col.type)
                  if (!isNum) return <td key={col.field} className='px-2 py-1.5' />
                  const sum = allRows.reduce((a, r) => a + (Number(r[col.field]) || 0), 0)
                  return <td key={col.field} className='px-2 py-1.5 text-right font-medium text-slate-700 dark:text-foreground'>{sum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                })}
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <div className='border-t border-slate-100 dark:border-border px-3 py-2'>
        <button type='button' onClick={() => setStagedNew(p => [...p, {}])} className='inline-flex items-center gap-1.5 text-[12px] font-medium text-[#00ceff] hover:text-[#00ceff]/80'>
          <Plus className='h-3.5 w-3.5' />
          Add row
        </button>
      </div>
    </div>
  )
}

function O2MPanel({
  relation,
  parentId,
  onNavigate
}: {
  relation: CMSRelation
  parentId: string
  onNavigate: (collection: string) => void
}) {
  const queryClient = useQueryClient()

  const { data: relatedColMeta } = useQuery({
    queryKey: ['collection-meta', relation.many_collection],
    queryFn: () => api.get(`/collections/${relation.many_collection}`).then((r) => r.data.data),
    staleTime: 10 * 60 * 1000
  })

  const displayTemplate = relatedColMeta?.display_template ?? null
  const _templateFields = extractTemplateFields(displayTemplate)

  const { data: relatedItems, isLoading } = useQuery({
    queryKey: ['o2m-items', relation.many_collection, relation.many_field, parentId],
    queryFn: async () => {
      const res = await api.get(`/items/${relation.many_collection}`, {
        params: {
          filter: JSON.stringify({ [relation.many_field]: { _eq: parentId } }),
          limit: 100,
          fields: '*'
        }
      })
      return (res.data.data ?? []) as Record<string, unknown>[]
    },
    staleTime: 60 * 1000
  })

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ['o2m-items', relation.many_collection, relation.many_field, parentId]
    })

  const unlinkMutation = useMutation({
    mutationFn: (itemId: unknown) =>
      api.patch(`/items/${relation.many_collection}/${itemId}`, {
        [relation.many_field]: null
      }),
    onSuccess: () => {
      invalidate()
      toast.success('Unlinked')
    },
    onError: () => toast.error('Failed to unlink')
  })

  const linkMutation = useMutation({
    mutationFn: (itemId: unknown) =>
      api.patch(`/items/${relation.many_collection}/${itemId}`, {
        [relation.many_field]: parentId
      }),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['link-pick', relation.many_collection] })
      toast.success('Linked')
    },
    onError: () => toast.error('Failed to link')
  })

  const count = relatedItems?.length ?? 0
  const title = relatedColMeta?.display_name ?? titleCase(relation.many_collection)
  const linkedIds = new Set(relatedItems?.map((i) => String(i.id)) ?? [])

  return (
    <Card>
      <CardHeader className='pb-2'>
        <RelationPanelHeader
          title={title}
          subtitle={`via ${relation.many_field}`}
          count={count}
          loading={isLoading}
          viewAllCollection={relation.many_collection}
          onNavigate={onNavigate}
          actions={
            <LinkRelationPopover
              collection={relation.many_collection}
              displayTemplate={displayTemplate}
              excludeIds={linkedIds}
              onSelect={(id) => linkMutation.mutate(id)}
              disabled={linkMutation.isPending}
            />
          }
        />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className='space-y-2'>
            {SKELETON_ROWS.map((i) => (
              <Skeleton key={i} className='h-8 rounded' />
            ))}
          </div>
        ) : count === 0 ? (
          <p className='text-[13px] text-slate-400 py-2'>No related items</p>
        ) : (
          <div className='divide-y divide-slate-100'>
            {relatedItems?.map((item) => (
              <div key={String(item.id)} className='py-2 flex items-center justify-between gap-2'>
                <span className='text-[13px] text-slate-700 truncate'>
                  {renderDisplayTemplate(displayTemplate, item)}
                </span>
                <button
                  type='button'
                  onClick={() => unlinkMutation.mutate(item.id)}
                  disabled={unlinkMutation.isPending && unlinkMutation.variables === item.id}
                  className='shrink-0 p-1 rounded text-slate-300 hover:text-red-400 hover:bg-red-50 transition-colors disabled:opacity-40'
                  aria-label='Unlink'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── M2MMultiSelectCombobox ────────────────────────────────────────────────────
// Inline combobox for M2M fields: shows selected tags, 200-item initial load,
// server-side search on keypress, staged (committed on form save).

function M2MMultiSelectCombobox({
  relation,
  parentId,
  allRelations,
  extraFilter,
}: {
  relation: CMSRelation
  parentId: string
  allRelations: CMSRelation[]
  extraFilter?: Record<string, unknown>
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 220)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search])

  const otherRelation: CMSRelation | undefined = allRelations.find(
    (r) => r.many_collection === relation.many_collection && r.many_field === relation.junction_field && r.id !== relation.id
  )
  const relatedCollection = otherRelation?.one_collection ?? null

  // Skip collection meta for system tables — they don't have a /collections entry
  const SYSTEM_COLS = new Set(['directus_users', 'directus_files', 'directus_activity', 'directus_roles', 'nivaro_users'])
  const isSystemCol = !!relatedCollection && SYSTEM_COLS.has(relatedCollection)
  // User relations are fetched via /users (not /items/<col> — system tables aren't registered collections)
  const isUserCol = !!relatedCollection && USER_SYSTEM_COLS.has(relatedCollection)

  const { data: relatedColMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    enabled: !!relatedCollection && !isSystemCol,
    staleTime: 10 * 60 * 1000,
    retry: false,
  })

  const templateFields = extractTemplateFields(relatedColMeta?.display_template ?? null)

  const { data: junctionItems, isLoading: junctionLoading } = useQuery({
    queryKey: ['m2m-items', relation.many_collection, relation.many_field, parentId],
    queryFn: async () => {
      const res = await api.get(`/items/${relation.many_collection}`, {
        params: {
          filter: JSON.stringify({ [relation.many_field]: { _eq: parentId } }),
          limit: 200,
          fields: `id,${relation.junction_field}`,
        },
      })
      return (res.data.data ?? []) as Record<string, unknown>[]
    },
    staleTime: 30_000,
  })

  const pickerFilterM2M = !isUserCol
    ? (relatedColMeta?.picker_filter as Record<string, unknown> | null | undefined)
    : null
  const m2mClauses = [pickerFilterM2M, extraFilter].filter(Boolean) as Record<string, unknown>[]
  const filterParam = m2mClauses.length > 0
    ? JSON.stringify(m2mClauses.length === 1 ? m2mClauses[0] : { _and: m2mClauses })
    : undefined

  const { data: options, isLoading: optionsLoading } = useQuery({
    queryKey: ['m2m-options', relatedCollection, debouncedSearch, filterParam],
    queryFn: async () => {
      if (!relatedCollection) return []
      if (isUserCol) {
        const res = await api.get('/users', {
          params: { limit: 200, search: debouncedSearch || undefined },
        })
        return (res.data.data ?? []) as Record<string, unknown>[]
      }
      const res = await api.get(`/items/${relatedCollection}`, {
        params: {
          limit: 200,
          fields: templateFields.join(','),
          search: debouncedSearch || undefined,
          filter: filterParam, picker: '1',
        },
      })
      return (res.data.data ?? []) as Record<string, unknown>[]
    },
    enabled: open && !!relatedCollection && (isUserCol || !isSystemCol),
    retry: false,
    staleTime: 30_000,
  })

  const stagingKey = relation.one_field ?? `${relation.many_collection}.${relation.junction_field}`
  const staging = useM2MStaging()
  const stagedLinks = staging?.getStagedLinks(stagingKey) ?? []
  const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set()

  const committedIds = new Set(
    (junctionItems ?? []).filter(i => !stagedUnlinks.has(i.id)).map(i => String(i[relation.junction_field!]))
  )
  const pendingRemovalItems = (junctionItems ?? []).filter(i => stagedUnlinks.has(i.id))
  const stagedLinkIds = new Set(stagedLinks.map(String))
  const allSelectedIds = new Set([...committedIds, ...stagedLinkIds])

  const displayTemplate = relatedColMeta?.display_template ?? null

  const handleToggle = (optionId: unknown) => {
    const strId = String(optionId)
    if (stagedLinkIds.has(strId)) {
      staging?.unstageLink(stagingKey, optionId)
      return
    }
    const existingJunction = (junctionItems ?? []).find(i => String(i[relation.junction_field!]) === strId)
    if (existingJunction) {
      if (stagedUnlinks.has(existingJunction.id)) {
        staging?.unstageUnlink(stagingKey, existingJunction.id)
      } else {
        staging?.stageUnlink(stagingKey, existingJunction.id)
      }
      return
    }
    staging?.stageLink(stagingKey, optionId)
  }

  if (junctionLoading) return <Skeleton className='h-9 w-full rounded-md' />

  return (
    <div className='space-y-1.5'>
      {/* Selected tags */}
      {(allSelectedIds.size > 0 || pendingRemovalItems.length > 0) && (
        <div className='flex flex-wrap gap-1.5'>
          {/* committed (not staged for removal) */}
          {(junctionItems ?? []).filter(i => !stagedUnlinks.has(i.id)).map(item => {
            const relatedId = item[relation.junction_field!]
            return (
              <span key={String(item.id)} className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 pl-2.5 pr-1.5 py-0.5 text-[12px] text-slate-700'>
                {relatedCollection ? <RelationLabel relatedCollection={relatedCollection} id={relatedId} /> : <span className='font-mono'>{String(relatedId ?? '—')}</span>}
                <button type='button' onClick={() => staging?.stageUnlink(stagingKey, item.id)} className='ml-0.5 rounded-full p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors'>
                  <X className='h-3 w-3' />
                </button>
              </span>
            )
          })}
          {/* staged for removal */}
          {pendingRemovalItems.map(item => {
            const relatedId = item[relation.junction_field!]
            return (
              <span key={String(item.id)} className='inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 pl-2.5 pr-1.5 py-0.5 text-[12px] text-red-400 line-through opacity-60'>
                {relatedCollection ? <RelationLabel relatedCollection={relatedCollection} id={relatedId} /> : <span className='font-mono'>{String(relatedId ?? '—')}</span>}
                <button type='button' onClick={() => staging?.unstageUnlink(stagingKey, item.id)} className='ml-0.5 rounded-full p-0.5 text-red-300 hover:bg-red-100 hover:text-red-500 transition-colors'>
                  <X className='h-3 w-3' />
                </button>
              </span>
            )
          })}
          {/* staged additions */}
          {stagedLinks.map(relatedId => (
            <span key={String(relatedId)} className='inline-flex items-center gap-1 rounded-full border border-dashed border-nvr-cyan/50 bg-nvr-cyan/5 pl-2.5 pr-1.5 py-0.5 text-[12px] text-nvr-cyan'>
              {relatedCollection ? <RelationLabel relatedCollection={relatedCollection} id={relatedId} /> : <span className='font-mono'>{String(relatedId)}</span>}
              <button type='button' onClick={() => staging?.unstageLink(stagingKey, relatedId)} className='ml-0.5 rounded-full p-0.5 text-nvr-cyan/50 hover:bg-nvr-cyan/10 hover:text-nvr-cyan transition-colors'>
                <X className='h-3 w-3' />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Combobox trigger */}
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }}>
        <PopoverTrigger asChild>
          <Button variant='outline' size='sm' className='h-8 w-full justify-start gap-1.5 text-[13px] font-normal text-muted-foreground'>
            <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 opacity-50' />
            {allSelectedIds.size > 0 ? `${allSelectedIds.size} selected — click to change` : 'Select items…'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-[320px] p-0' align='start'>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder='Search…'
              value={search}
              onValueChange={setSearch}
              className='h-9 text-[13px]'
            />
            <CommandList>
              {optionsLoading ? (
                <div className='py-3 text-center text-[12px] text-muted-foreground'>Loading…</div>
              ) : (
                <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>No results</CommandEmpty>
              )}
              <CommandGroup>
                {[...(options ?? [])].sort((a, b) => {
                  const la = isUserCol ? userDisplayLabel(a) : renderDisplayTemplate(displayTemplate, a)
                  const lb = isUserCol ? userDisplayLabel(b) : renderDisplayTemplate(displayTemplate, b)
                  return la.localeCompare(lb)
                }).map(opt => {
                  const optId = String(opt.id)
                  const isSelected = allSelectedIds.has(optId)
                  const isPendingRemoval = !!((junctionItems ?? []).find(i => String(i[relation.junction_field!]) === optId && stagedUnlinks.has(i.id)))
                  return (
                    <CommandItem
                      key={optId}
                      value={optId}
                      onSelect={() => handleToggle(opt.id)}
                      className='flex items-center gap-2 text-[13px]'
                    >
                      <div className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                        isSelected && !isPendingRemoval ? 'border-nvr-cyan bg-nvr-cyan' : isPendingRemoval ? 'border-red-300 bg-red-50' : 'border-slate-300'
                      )}>
                        {isSelected && !isPendingRemoval && <Check className='h-2.5 w-2.5 text-white' />}
                        {isPendingRemoval && <X className='h-2.5 w-2.5 text-red-400' />}
                      </div>
                      <span className={cn('truncate', isPendingRemoval && 'line-through text-slate-400')}>
                        {isUserCol ? userDisplayLabel(opt) : renderDisplayTemplate(displayTemplate, opt)}
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
  )
}

// ── M2M staging context ───────────────────────────────────────────────────────
// Defers junction row create/delete until the main form is saved.

interface M2MStagingCtx {
  getStagedLinks: (key: string) => unknown[]
  getStagedUnlinks: (key: string) => Set<unknown>
  stageLink: (key: string, relatedId: unknown) => void
  stageUnlink: (key: string, junctionId: unknown) => void
  unstageLink: (key: string, relatedId: unknown) => void
  unstageUnlink: (key: string, junctionId: unknown) => void
}

const M2MStagingContext = createContext<M2MStagingCtx | null>(null)

function useM2MStaging() {
  return useContext(M2MStagingContext)
}

// ── O2M Inline Grid — batch save coordination ────────────────────────────────

const O2MGridContext = createContext<{
  register: (key: string, flush: () => Promise<void>) => void
  unregister: (key: string) => void
  flushAll: () => Promise<void>
} | null>(null)

function useO2MGridContext() { return useContext(O2MGridContext) }

// ── M2MSingleSelectCombobox — max_values=1 ────────────────────────────────────
function M2MSingleSelectCombobox({
  relation,
  parentId,
  allRelations,
  extraFilter,
}: {
  relation: CMSRelation
  parentId: string
  allRelations: CMSRelation[]
  extraFilter?: Record<string, unknown>
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 220)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search])

  const otherRelation = allRelations.find(
    (r) => r.many_collection === relation.many_collection && r.many_field === relation.junction_field && r.id !== relation.id
  )
  const relatedCollection = otherRelation?.one_collection ?? null
  const SYSTEM_COLS = new Set(['directus_users', 'directus_files', 'directus_activity', 'directus_roles', 'nivaro_users'])
  const isSystemCol = !!relatedCollection && SYSTEM_COLS.has(relatedCollection)

  const { data: relatedColMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    enabled: !!relatedCollection && !isSystemCol,
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
  const displayTemplate = relatedColMeta?.display_template ?? null
  const templateFields = extractTemplateFields(displayTemplate)

  const { data: junctionItems } = useQuery({
    queryKey: ['m2m-items', relation.many_collection, relation.many_field, parentId],
    queryFn: async () => {
      const res = await api.get(`/items/${relation.many_collection}`, {
        params: { filter: JSON.stringify({ [relation.many_field]: { _eq: parentId } }), limit: 1, fields: `id,${relation.junction_field}` },
      })
      return (res.data.data ?? []) as Record<string, unknown>[]
    },
    staleTime: 30_000,
  })

  const pickerFilterSingle = !isSystemCol
    ? (relatedColMeta?.picker_filter as Record<string, unknown> | null | undefined)
    : null
  const singleClauses = [pickerFilterSingle, extraFilter].filter(Boolean) as Record<string, unknown>[]
  const filterParam = singleClauses.length > 0
    ? JSON.stringify(singleClauses.length === 1 ? singleClauses[0] : { _and: singleClauses })
    : undefined

  const { data: options, isLoading: optionsLoading } = useQuery({
    queryKey: ['m2m-options', relatedCollection, debouncedSearch, filterParam],
    queryFn: async () => {
      if (!relatedCollection) return []
      const res = await api.get(`/items/${relatedCollection}`, {
        params: { limit: 200, fields: templateFields.join(','), search: debouncedSearch || undefined, filter: filterParam },
      })
      return (res.data.data ?? []) as Record<string, unknown>[]
    },
    enabled: open && !!relatedCollection && !isSystemCol,
    staleTime: 30_000,
    retry: false,
  })

  const stagingKey = relation.one_field ?? `${relation.many_collection}.${relation.junction_field}`
  const staging = useM2MStaging()
  const stagedLinks = staging?.getStagedLinks(stagingKey) ?? []
  const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set()

  const committedItem = (junctionItems ?? []).find(i => !stagedUnlinks.has(i.id))
  const committedRelatedId = committedItem ? committedItem[relation.junction_field!] : null
  const stagedRelatedId = stagedLinks.length > 0 ? stagedLinks[stagedLinks.length - 1] : null
  const currentRelatedId = stagedRelatedId ?? committedRelatedId
  const isPendingChange = stagedLinks.length > 0 || stagedUnlinks.size > 0

  const handleSelect = (optId: unknown) => {
    for (const id of stagedLinks) staging?.unstageLink(stagingKey, id)
    if (committedItem && !stagedUnlinks.has(committedItem.id)) staging?.stageUnlink(stagingKey, committedItem.id)
    if (String(optId) === String(committedRelatedId) && committedItem) {
      staging?.unstageUnlink(stagingKey, committedItem.id)
    } else if (String(optId) !== String(currentRelatedId)) {
      staging?.stageLink(stagingKey, optId)
    }
    setOpen(false)
    setSearch('')
  }

  const handleClear = () => {
    for (const id of stagedLinks) staging?.unstageLink(stagingKey, id)
    if (committedItem) staging?.stageUnlink(stagingKey, committedItem.id)
    setOpen(false)
  }

  const { data: currentItemData, isLoading: currentItemLoading } = useQuery({
    queryKey: ['relation-item', relatedCollection, String(currentRelatedId)],
    queryFn: () => api.get(`/items/${relatedCollection}/${currentRelatedId}`, { params: { fields: templateFields.join(',') } }).then(r => r.data.data as Record<string, unknown>),
    enabled: !!relatedCollection && currentRelatedId != null && !isSystemCol,
    staleTime: 30 * 60 * 1000,
    retry: false,
  })

  const currentOpt = options?.find(o => String(o.id) === String(currentRelatedId)) ?? currentItemData
  const currentLabel = currentOpt ? renderDisplayTemplate(displayTemplate, currentOpt) : (currentRelatedId != null ? String(currentRelatedId) : null)
  const labelLoading = currentRelatedId != null && !currentOpt && currentItemLoading

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'w-full h-9 px-3 text-[13px] border rounded-md bg-white text-left flex items-center justify-between hover:bg-slate-50 cursor-pointer',
            isPendingChange ? 'border-nvr-cyan/50' : 'border-slate-200'
          )}
        >
          {labelLoading ? (
            <Skeleton className='h-4 w-32 rounded' />
          ) : (
            <span className={cn('truncate', currentLabel ? (isPendingChange ? 'text-nvr-cyan' : 'text-slate-800') : 'text-slate-400')}>
              {currentLabel ?? 'Select…'}
            </span>
          )}
          <ChevronsUpDown className='h-3.5 w-3.5 text-slate-400 shrink-0 ml-2' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[320px] p-0' align='start'>
        <Command shouldFilter={false}>
          <CommandInput placeholder='Search…' value={search} onValueChange={setSearch} className='h-9 text-[13px]' />
          <CommandList>
            {optionsLoading ? (
              <div className='py-3 text-center text-[12px] text-muted-foreground'>Loading…</div>
            ) : (
              <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>No results</CommandEmpty>
            )}
            <CommandGroup>
              <CommandItem value='__clear__' onSelect={handleClear} className='text-[13px] text-slate-400'>Clear selection</CommandItem>
              {[...(options ?? [])].sort((a, b) =>
                renderDisplayTemplate(displayTemplate, a).localeCompare(renderDisplayTemplate(displayTemplate, b))
              ).map(opt => {
                const optId = String(opt.id)
                const isSelected = String(currentRelatedId) === optId
                return (
                  <CommandItem key={optId} value={optId} onSelect={() => handleSelect(opt.id)} className='flex items-center gap-2 text-[13px]'>
                    <div className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors', isSelected ? 'border-nvr-cyan bg-nvr-cyan' : 'border-slate-300')}>
                      {isSelected && <Check className='h-2.5 w-2.5 text-white' />}
                    </div>
                    <span className='truncate'>{renderDisplayTemplate(displayTemplate, opt)}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function InlineM2MPicker({
  relation,
  parentId,
  allRelations,
}: {
  relation: CMSRelation
  parentId: string
  allRelations: CMSRelation[]
}) {
  const queryClient = useQueryClient()

  // Resolve the related collection from the already-fetched relations array.
  // Don't require junction_field === null — some companion rows have corrupted data
  // where junction_field is incorrectly set. Match by many_collection + many_field only.
  const otherRelation: CMSRelation | undefined = allRelations.find(
    (r) =>
      r.many_collection === relation.many_collection &&
      r.many_field === relation.junction_field &&
      r.id !== relation.id
  )
  const relatedCollection = otherRelation?.one_collection ?? null

  const { data: relatedColMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    enabled: !!relatedCollection,
    staleTime: 10 * 60 * 1000,
  })
  const displayTemplate = relatedColMeta?.display_template ?? null

  const { data: junctionItems, isLoading } = useQuery({
    queryKey: ['m2m-items', relation.many_collection, relation.many_field, parentId],
    queryFn: async () => {
      const res = await api.get(`/items/${relation.many_collection}`, {
        params: {
          filter: JSON.stringify({ [relation.many_field]: { _eq: parentId } }),
          limit: 100,
          fields: `id,${relation.junction_field}`,
        },
      })
      return (res.data.data ?? []) as Record<string, unknown>[]
    },
    staleTime: 30_000,
  })

  const stagingKey = relation.one_field ?? `${relation.many_collection}.${relation.junction_field}`
  const staging = useM2MStaging()
  const stagedLinks = staging?.getStagedLinks(stagingKey) ?? []
  const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set()

  if (isLoading) return <Skeleton className='h-8 w-full rounded' />

  // Committed items not staged for removal
  const visibleCommitted = (junctionItems ?? []).filter(
    (item) => !stagedUnlinks.has(item.id)
  )
  // Committed items staged for removal
  const pendingRemoval = (junctionItems ?? []).filter(
    (item) => stagedUnlinks.has(item.id)
  )

  // All linked related IDs (committed + staged) to exclude from picker
  const linkedRelatedIds = new Set([
    ...(junctionItems?.map((i) => String(i[relation.junction_field!])) ?? []),
    ...stagedLinks.map(String),
  ])

  return (
    <div className='space-y-1.5'>
      <div className='flex flex-wrap gap-1.5'>
        {/* committed items (not pending removal) */}
        {visibleCommitted.map((item) => {
          const relatedId = item[relation.junction_field!]
          return (
            <span
              key={String(item.id)}
              className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 pl-2.5 pr-1.5 py-0.5 text-[12px] text-slate-700'
            >
              {relatedCollection ? (
                <RelationLabel relatedCollection={relatedCollection} id={relatedId} />
              ) : (
                <span className='font-mono'>{String(relatedId ?? '—')}</span>
              )}
              <button
                type='button'
                onClick={() => staging?.stageUnlink(stagingKey, item.id)}
                className='ml-0.5 rounded-full p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors'
              >
                <X className='h-3 w-3' />
              </button>
            </span>
          )
        })}

        {/* items pending removal — show with strikethrough, allow undo */}
        {pendingRemoval.map((item) => {
          const relatedId = item[relation.junction_field!]
          return (
            <span
              key={String(item.id)}
              className='inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 pl-2.5 pr-1.5 py-0.5 text-[12px] text-red-400 line-through opacity-60'
            >
              {relatedCollection ? (
                <RelationLabel relatedCollection={relatedCollection} id={relatedId} />
              ) : (
                <span className='font-mono'>{String(relatedId ?? '—')}</span>
              )}
              <button
                type='button'
                title='Undo removal'
                onClick={() => staging?.unstageUnlink(stagingKey, item.id)}
                className='ml-0.5 rounded-full p-0.5 text-red-300 hover:bg-red-100 hover:text-red-500 no-underline transition-colors'
              >
                <X className='h-3 w-3' />
              </button>
            </span>
          )
        })}

        {/* staged additions — pending, not yet saved */}
        {stagedLinks.map((relatedId) => (
          <span
            key={String(relatedId)}
            className='inline-flex items-center gap-1 rounded-full border border-dashed border-nvr-cyan/50 bg-nvr-cyan/5 pl-2.5 pr-1.5 py-0.5 text-[12px] text-nvr-cyan'
          >
            {relatedCollection ? (
              <RelationLabel relatedCollection={relatedCollection} id={relatedId} />
            ) : (
              <span className='font-mono'>{String(relatedId)}</span>
            )}
            <button
              type='button'
              title='Undo add'
              onClick={() => staging?.unstageLink(stagingKey, relatedId)}
              className='ml-0.5 rounded-full p-0.5 text-nvr-cyan/50 hover:bg-nvr-cyan/10 hover:text-nvr-cyan transition-colors'
            >
              <X className='h-3 w-3' />
            </button>
          </span>
        ))}
      </div>

      {/* add button */}
      {relatedCollection && (
        <LinkRelationPopover
          collection={relatedCollection}
          displayTemplate={displayTemplate}
          excludeIds={linkedRelatedIds}
          onSelect={(id) => staging?.stageLink(stagingKey, id)}
          disabled={false}
        />
      )}

      {!visibleCommitted.length && !stagedLinks.length && !pendingRemoval.length && !relatedCollection && (
        <p className='text-[12px] text-slate-400'>No related items — relation not fully configured</p>
      )}
    </div>
  )
}

function M2MPanel({
  relation,
  parentId,
  onNavigate
}: {
  relation: CMSRelation
  parentId: string
  onNavigate: (collection: string) => void
}) {
  const queryClient = useQueryClient()

  const { data: junctionMeta } = useQuery({
    queryKey: ['collection-meta', relation.many_collection],
    queryFn: () => api.get(`/collections/${relation.many_collection}`).then((r) => r.data.data),
    staleTime: 10 * 60 * 1000
  })

  const otherRelation: CMSRelation | undefined = (junctionMeta?.relations ?? []).find(
    (r: CMSRelation) =>
      r.many_collection === relation.many_collection &&
      r.many_field === relation.junction_field &&
      r.id !== relation.id
  )
  const relatedCollection = otherRelation?.one_collection ?? null

  const { data: relatedColMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    enabled: !!relatedCollection,
    staleTime: 10 * 60 * 1000
  })
  const displayTemplate = relatedColMeta?.display_template ?? null

  const { data: junctionItems, isLoading } = useQuery({
    queryKey: ['m2m-items', relation.many_collection, relation.many_field, parentId],
    queryFn: async () => {
      const res = await api.get(`/items/${relation.many_collection}`, {
        params: {
          filter: JSON.stringify({ [relation.many_field]: { _eq: parentId } }),
          limit: 100,
          fields: `id,${relation.junction_field}`
        }
      })
      return (res.data.data ?? []) as Record<string, unknown>[]
    },
    staleTime: 60 * 1000
  })

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ['m2m-items', relation.many_collection, relation.many_field, parentId]
    })

  const unlinkMutation = useMutation({
    mutationFn: (junctionId: unknown) =>
      api.delete(`/items/${relation.many_collection}/${junctionId}`),
    onSuccess: () => {
      invalidate()
      toast.success('Unlinked')
    },
    onError: () => toast.error('Failed to unlink')
  })

  const linkMutation = useMutation({
    mutationFn: (relatedId: unknown) =>
      api.post(`/items/${relation.many_collection}`, {
        [relation.many_field]: parentId,
        [relation.junction_field!]: relatedId
      }),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['link-pick', relatedCollection] })
      toast.success('Linked')
    },
    onError: () => toast.error('Failed to link')
  })

  const count = junctionItems?.length ?? 0
  const title =
    (relatedCollection ? (relatedColMeta?.display_name ?? titleCase(relatedCollection)) : null) ??
    titleCase(relation.one_field ?? relation.many_collection)

  // IDs of already-linked related items (for excluding from picker)
  const linkedRelatedIds = new Set(
    junctionItems?.map((i) => String(i[relation.junction_field!])) ?? []
  )

  return (
    <Card>
      <CardHeader className='pb-2'>
        <RelationPanelHeader
          title={title}
          subtitle={relation.one_field ?? `via ${relation.many_collection}`}
          count={count}
          loading={isLoading}
          viewAllCollection={relatedCollection}
          onNavigate={onNavigate}
          actions={
            relatedCollection ? (
              <LinkRelationPopover
                collection={relatedCollection}
                displayTemplate={displayTemplate}
                excludeIds={linkedRelatedIds}
                onSelect={(id) => linkMutation.mutate(id)}
                disabled={linkMutation.isPending}
              />
            ) : undefined
          }
        />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className='space-y-2'>
            {SKELETON_ROWS.map((i) => (
              <Skeleton key={i} className='h-8 rounded' />
            ))}
          </div>
        ) : count === 0 ? (
          <p className='text-[13px] text-slate-400 py-2'>No related items</p>
        ) : (
          <div className='divide-y divide-slate-100'>
            {junctionItems?.map((item) => {
              const relatedId = item[relation.junction_field!]
              return (
                <div key={String(item.id)} className='py-2 flex items-center justify-between gap-2'>
                  <div className='truncate'>
                    {relatedCollection ? (
                      <RelationLabel relatedCollection={relatedCollection} id={relatedId} />
                    ) : (
                      <span className='font-mono text-[12px] text-slate-400'>
                        {String(relatedId ?? '—')}
                      </span>
                    )}
                  </div>
                  <button
                    type='button'
                    onClick={() => unlinkMutation.mutate(item.id)}
                    disabled={unlinkMutation.isPending && unlinkMutation.variables === item.id}
                    className='shrink-0 p-1 rounded text-slate-300 hover:text-red-400 hover:bg-red-50 transition-colors disabled:opacity-40'
                    aria-label='Unlink'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
