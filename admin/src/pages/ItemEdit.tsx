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
  Copy,
  ExternalLink,
  FunctionSquare,
  LayoutTemplate,
  Loader2,
  Network,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { ApprovalPanel } from '@/components/approval-panel'
import { CommentPanel } from '@/components/comment-panel'
import { ErpStatusBadge } from '@/components/erp-status-badge'
import { FieldHistorySparkline } from '@/components/field-history-sparkline'
import { InlineRelationEditor } from '@/components/inline-relation-editor'
import { ItemLockBanner, useItemLock } from '@/components/item-lock-banner'
import { PipelinePanel } from '@/components/pipeline-panel'
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
import { WorkflowPanel } from '@/components/workflow-panel'
import {
  type Addendum,
  api,
  type CMSField,
  type CMSRelation,
  type LineItem,
  type RecordTemplate
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { extractTemplateFields, findM2ORelation, renderDisplayTemplate } from '@/lib/relations'
import { cn, titleCase } from '@/lib/utils'

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

interface LineItemTemplate {
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

function FieldInput({
  field,
  value,
  onChange,
  relations,
  collection,
  id: itemId
}: {
  field: CMSField
  value: unknown
  onChange: (v: unknown) => void
  relations: CMSRelation[]
  collection: string
  id?: string
}) {
  const m2oRelation = findM2ORelation(relations, collection, field.field)
  if (m2oRelation) {
    return (
      <InlineRelationEditor relatedCollection={m2oRelation.one_collection!} relatedId={value}>
        <RelationPicker
          relatedCollection={m2oRelation.one_collection!}
          value={value}
          onChange={onChange}
          disabled={field.readonly}
        />
      </InlineRelationEditor>
    )
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

  if (field.type === 'integer' || field.type === 'float') {
    return (
      <Input
        type='number'
        step={field.type === 'float' ? 'any' : '1'}
        value={strVal}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
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

  if (field.interface === 'rich_text' || field.type === 'rich_text') {
    return (
      <RichTextField
        value={typeof value === 'string' ? value : value ? JSON.stringify(value) : ''}
        onChange={onChange}
        disabled={field.readonly}
      />
    )
  }

  if (field.interface === 'line_items' || field.type === 'line_items') {
    return (
      <LineItemsField
        collection={collection}
        itemId={itemId ?? ''}
        field={field.field}
        disabled={field.readonly}
      />
    )
  }

  if (field.type === 'text' || (field.interface ?? '').includes('textarea')) {
    return <Textarea value={strVal} rows={3} onChange={(e) => onChange(e.target.value || null)} />
  }

  return <Input value={strVal} onChange={(e) => onChange(e.target.value || null)} />
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
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

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 10 * 60 * 1000
  })

  const { data: itemData, isLoading } = useQuery({
    queryKey: ['item', collection, id],
    queryFn: () => api.get(`/items/${collection}/${id}`).then((r) => r.data.data),
    enabled: !!collection && !!id
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
            type: 'section' | 'tab'
            icon: string | null
            sort: number
            is_collapsed: boolean
          }>
        }>(`/field-groups/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 60_000
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
        const rules = JSON.parse(fc.visibility_rules) as {
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
        const cond = JSON.parse(fc.lock_condition) as {
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

  const allFields: CMSField[] = colMeta?.fields ?? []
  const relations: CMSRelation[] = colMeta?.relations ?? []

  const groupedFields = useMemo(() => {
    const groups = fieldGroups ?? []
    if (groups.length === 0) return null
    const ungrouped = allFields.filter((f) => !fieldConfigMap[f.field]?.group_key && !f.hidden)
    const groupedMap: Record<string, CMSField[]> = {}
    for (const g of groups) groupedMap[g.key] = []
    for (const f of allFields) {
      const gk = fieldConfigMap[f.field]?.group_key
      if (gk && groupedMap[gk]) groupedMap[gk].push(f)
    }
    return { ungrouped, groups, groupedMap }
  }, [allFields, fieldGroups, fieldConfigMap])

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Virtual field names defined by O2M/M2M relations — these have no real DB column
  const virtualFieldNames = new Set(
    relations
      .filter((r) => r.one_collection === collection && r.one_field !== null)
      .map((r) => r.one_field!)
  )

  const computedFields = allFields.filter(
    (f) =>
      f.computed_formula &&
      !f.hidden &&
      !SYSTEM_FIELDS.has(f.field) &&
      !virtualFieldNames.has(f.field)
  )
  const computedFieldNames = new Set(computedFields.map((f) => f.field))

  // Path-maintained tree collections gain server-managed `path` + `depth`
  // columns — treat them like system columns (read-only, never editable).
  const pathFieldNames: Set<string> = treeConfig?.maintain_path
    ? new Set(['path', 'depth'])
    : new Set()

  const editableFields = allFields.filter(
    (f) =>
      !f.hidden &&
      !f.readonly &&
      !SYSTEM_FIELDS.has(f.field) &&
      !pathFieldNames.has(f.field) &&
      !virtualFieldNames.has(f.field) &&
      !computedFieldNames.has(f.field)
  )
  const systemFields = allFields.filter(
    (f) => SYSTEM_FIELDS.has(f.field) || f.readonly || pathFieldNames.has(f.field)
  )

  // Inherited field values — sidecar map of { field: ancestorId } returned by
  // item reads when the collection has inheritable fields (nivaro_fields.is_inheritable).
  const inheritedMap =
    ((itemData as Record<string, unknown> | undefined)?._inherited as
      | Record<string, unknown>
      | undefined) ?? undefined

  const displayName = colMeta?.display_name ?? titleCase(collection ?? '')

  const o2mRelations: CMSRelation[] = relations.filter(
    (r) => r.one_collection === collection && r.junction_field === null
  )

  const m2mRelations: CMSRelation[] = relations.filter(
    (r) => r.one_collection === collection && r.junction_field !== null
  )

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

  const handleSave = async (opts?: { skipValidation?: boolean; skipDuplicates?: boolean }) => {
    const patch: Record<string, unknown> = {}
    for (const f of editableFields) {
      patch[f.field] = draft[f.field] ?? null
    }

    setAiWarning(null)
    setAiDuplicates(null)

    const needValidate = !opts?.skipValidation && !!aiSettings?.validation_enabled
    const needDupCheck =
      !opts?.skipDuplicates && id === 'new' && !!aiSettings?.duplicate_detection_enabled

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

    mutation.mutate(patch)
  }

  // Apply dependency cascade for fields that depend on the changed one
  const applyFieldChange = useCallback(
    (fieldName: string, value: unknown) => {
      const next = { ...draft, [fieldName]: value }
      const cascade: Record<string, unknown> = {}
      for (const fc of fieldConfig ?? []) {
        if (!fc.dependency_config) continue
        try {
          const cfg = JSON.parse(fc.dependency_config) as {
            depends_on: string[]
            options_filter?: { field: string; value_from: string }
            clear_on_change?: boolean
          }
          if (cfg.depends_on?.includes(fieldName) && cfg.clear_on_change) {
            cascade[fc.field] = null
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

  return (
    <div className='p-8'>
      {/* Header */}
      <div className='flex items-center gap-4 mb-8'>
        <Button variant='ghost' size='icon' onClick={() => navigate(`/collections/${collection}`)}>
          <ArrowLeft className='h-4 w-4' />
        </Button>
        <div className='flex-1'>
          <div className='flex items-center gap-2'>
            <h1 className='text-2xl font-bold text-slate-900'>{displayName}</h1>
            <Badge variant='secondary' className='font-mono text-xs'>
              #{id}
            </Badge>
          </div>
          <p className='text-muted-foreground text-sm font-mono mt-0.5'>{collection}</p>
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
        <RevisionsPanel
          collection={collection!}
          item={id!}
          onRollback={() => {
            queryClient.invalidateQueries({ queryKey: ['item', collection, id] })
            setInitialized(false)
          }}
        />
        {id !== 'new' && (
          <Button
            size='sm'
            variant='outline'
            className='h-8 text-[12px]'
            onClick={async () => {
              try {
                const res = await api.post<{ data: { id: string | number } }>(
                  `/items/${collection}/${id}/clone`
                )
                toast.success('Item cloned')
                navigate(`/collections/${collection}/${res.data.data.id}`)
              } catch {
                toast.error('Failed to clone item')
              }
            }}
          >
            <Copy className='mr-1.5 h-3.5 w-3.5' />
            Clone
          </Button>
        )}
        {id !== 'new' && (
          <ScheduleChangeDialog
            collection={collection!}
            itemId={id!}
            currentValues={draft}
            fields={allFields}
          />
        )}
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
        {user?.is_admin && (
          <Button variant='outline' onClick={handleSummarize} disabled={summarizing} size='sm'>
            {summarizing ? (
              <Loader2 className='h-4 w-4 mr-1.5 animate-spin' />
            ) : (
              <Sparkles className='h-4 w-4 mr-1.5' />
            )}
            Summarize
          </Button>
        )}
        <Button
          onClick={() => handleSave()}
          disabled={mutation.isPending || aiChecking || isReadOnly}
        >
          {aiChecking ? (
            <Loader2 className='h-4 w-4 mr-1.5 animate-spin' />
          ) : (
            <Save className='h-4 w-4 mr-1.5' />
          )}
          {aiChecking ? 'Checking…' : mutation.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>

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

      {isLoading ? (
        <div className='space-y-4'>
          {[...Array(5)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
            <Skeleton key={i} className='h-16 rounded-xl' />
          ))}
        </div>
      ) : (
        <div className='space-y-6'>
          {/* Pipeline state machine panel — shown only when a pipeline is bound to this collection */}
          {id && <PipelinePanel collection={collection!} item={id} />}

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
                <CardHeader className='pb-2'>
                  <CardTitle className='text-sm font-medium text-slate-500'>Fields</CardTitle>
                </CardHeader>
                <CardContent className='space-y-5'>
                  {/* Template picker for new items */}
                  {id === 'new' && (
                    <TemplatePicker
                      collection={collection!}
                      onApply={(data) => setDraft((d) => ({ ...d, ...data }))}
                    />
                  )}

                  {groupedFields ? (
                    // Render with field groups
                    <>
                      {/* Ungrouped fields first */}
                      {groupedFields.ungrouped
                        .filter(
                          (f) =>
                            !f.hidden &&
                            !SYSTEM_FIELDS.has(f.field) &&
                            !pathFieldNames.has(f.field) &&
                            !hiddenFields.has(f.field)
                        )
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
                          />
                        ))}
                      {/* Grouped sections / tabs */}
                      {groupedFields.groups.map((group) => {
                        const groupFieldList = (groupedFields.groupedMap[group.key] ?? []).filter(
                          (f) =>
                            !f.hidden && !pathFieldNames.has(f.field) && !hiddenFields.has(f.field)
                        )
                        if (groupFieldList.length === 0) return null
                        const isCollapsed = collapsedGroups.has(group.key)
                        return (
                          <div
                            key={group.key}
                            className='overflow-hidden rounded-lg border border-slate-200 bg-white'
                          >
                            <button
                              type='button'
                              onClick={() => toggleGroup(group.key)}
                              className='flex w-full items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200 text-[13px] font-medium text-slate-700'
                            >
                              {group.label}
                              <ChevronDown
                                className={cn(
                                  'h-4 w-4 text-slate-400 transition-transform',
                                  isCollapsed ? '' : 'rotate-180'
                                )}
                              />
                            </button>
                            {!isCollapsed && (
                              <div className='p-4 space-y-4'>
                                {groupFieldList.map((field) => (
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
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </>
                  ) : (
                    // No groups — render flat list
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
                        <Label className='text-slate-600'>{titleCase(field.field)}</Label>
                        <span className='inline-flex items-center gap-0.5 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:bg-violet-900/30 dark:text-violet-400'>
                          {field.computed_type === 'write' ? 'write-time' : 'read-time'}
                        </span>
                      </div>
                      {field.note && <p className='text-xs text-muted-foreground'>{field.note}</p>}
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
                    <span className='text-sm text-muted-foreground'>{titleCase(field.field)}</span>
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

          {/* M2M relation panels */}
          {m2mRelations.map((rel) => (
            <M2MPanel
              key={`${rel.many_collection}-${rel.junction_field}`}
              relation={rel}
              parentId={id!}
              onNavigate={(col) => navigate(`/collections/${col}`)}
            />
          ))}

          {/* Comments & mentions */}
          {id && (
            <div className='mt-6'>
              <CommentPanel collection={collection!} item={id} />
            </div>
          )}

          {/* Tasks attached to this record */}
          {id && id !== 'new' && <TaskPanel collection={collection!} item={id} />}

          {/* Addenda & Amendments */}
          {id && id !== 'new' && colMeta?.addendums_enabled && (
            <AddendumPanel collection={collection!} itemId={id} />
          )}
        </div>
      )}
    </div>
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
  handleGenerateField
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
}) {
  if (treeConfig && field.field === treeConfig.parent_field) {
    return (
      <div className='space-y-1.5'>
        <Label>
          {titleCase(field.field)}
          {field.required && <span className='text-red-500 ml-0.5'>*</span>}
        </Label>
        {field.note && <p className='text-xs text-muted-foreground'>{field.note}</p>}
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
    <div className='space-y-1.5'>
      <div className='flex flex-wrap items-center gap-1.5'>
        <Label htmlFor={field.field}>
          {field.field === 'id' ? 'ID' : titleCase(field.field)}
          {field.required && <span className='text-red-500 ml-0.5'>*</span>}
        </Label>
        {isLocked && <span className='text-[10px] text-slate-400 italic'>locked</span>}
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
        {isTextual && user?.is_admin && (
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
      </div>
      {field.note && <p className='text-xs text-muted-foreground'>{field.note}</p>}
      <FieldInput
        field={{ ...field, readonly: field.readonly || isLocked }}
        value={draft[field.field]}
        onChange={(v) => handleFieldChange(field.field, v)}
        relations={colMeta?.relations ?? []}
        collection={collection}
        id={id}
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
  disabled
}: {
  value: string
  onChange: (v: unknown) => void
  disabled?: boolean
}) {
  const [text, setText] = useState(() => {
    try {
      const parsed = JSON.parse(value) as { text?: string }
      return typeof parsed === 'object' && parsed?.text ? parsed.text : value
    } catch {
      return value || ''
    }
  })

  const handleChange = (v: string) => {
    setText(v)
    onChange(JSON.stringify({ type: 'doc', text: v, html: v }))
  }

  return (
    <div className='rounded-md border border-input overflow-hidden'>
      <div className='flex items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-2 py-1'>
        <span className='text-[10px] text-slate-400'>Rich Text</span>
      </div>
      <Textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        rows={6}
        className='border-0 rounded-none focus-visible:ring-0 text-[13px]'
        placeholder='Enter rich text content…'
      />
    </div>
  )
}

// ─── LineItemsField ───────────────────────────────────────────────────────────

function LineItemsField({
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

  const { data: lineItems = [] } = useQuery({
    queryKey: ['line-items', collection, itemId, field],
    queryFn: () =>
      api
        .get<{ data: LineItem[] }>(`/line-items/${collection}/${itemId}/${field}`)
        .then((r) => r.data.data),
    enabled: !!itemId && itemId !== 'new'
  })

  const [localItems, setLocalItems] = useState<
    Array<{ id?: number; sort: number; data: Record<string, unknown> }>
  >([])
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    if (lineItems.length > 0 && !initialized) {
      setLocalItems(lineItems)
      setInitialized(true)
    }
  }, [lineItems, initialized])

  const saveMut = useMutation({
    mutationFn: (items: Array<{ id?: number; sort: number; data: Record<string, unknown> }>) =>
      api.patch(`/line-items/${collection}/${itemId}/${field}`, { items }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['line-items', collection, itemId, field] })
      toast.success('Line items saved')
    },
    onError: () => toast.error('Failed to save line items')
  })

  // ─── Line item templates ───
  const [tplOpen, setTplOpen] = useState(false)
  const [tplSaving, setTplSaving] = useState(false) // inline "save as template" name form
  const [tplName, setTplName] = useState('')
  const [tplConfirmDelete, setTplConfirmDelete] = useState<number | null>(null)

  const { data: templates = [] } = useQuery({
    queryKey: ['line-item-templates', collection, field],
    queryFn: () =>
      api
        .get<{ data: LineItemTemplate[] }>(`/line-items/templates/${collection}/${field}`)
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
    mutationFn: (tpl: LineItemTemplate) =>
      api
        .post<{ items: unknown[] }>(`/line-items/templates/${tpl.id}/apply`)
        .then((r) => ({ tpl, items: r.data.items })),
    onSuccess: ({ tpl, items }) => {
      appendTemplateRows(Array.isArray(items) ? items : [], tpl.name)
      setTplOpen(false)
    },
    onError: () => toast.error('Failed to apply template')
  })

  const createTplMut = useMutation({
    mutationFn: (name: string) =>
      api.post('/line-items/templates', {
        collection,
        field,
        name,
        items: localItems.map((i) => i.data)
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['line-item-templates', collection, field] })
      setTplName('')
      setTplSaving(false)
      toast.success('Template saved')
    },
    onError: () => toast.error('Failed to save template')
  })

  const deleteTplMut = useMutation({
    mutationFn: (tplId: number) => api.delete(`/line-items/templates/${tplId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['line-item-templates', collection, field] })
      setTplConfirmDelete(null)
      toast.success('Template deleted')
    },
    onError: () => toast.error('Failed to delete template')
  })

  if (itemId === 'new') {
    return <p className='text-[12px] text-slate-400'>Save the item first to add line items.</p>
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
              Add line
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
            {saveMut.isPending ? 'Saving…' : 'Save lines'}
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
  fields
}: {
  collection: string
  itemId: string
  currentValues: Record<string, unknown>
  fields: CMSField[]
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
        <Button size='sm' variant='outline' className='h-8 text-[12px]'>
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
      r.junction_field === null
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
