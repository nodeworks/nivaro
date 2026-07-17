import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChartLine, Info, Lock, Loader2, SlidersHorizontal, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { AutoIdPreviewField } from './AutoIdPreviewField'
import { FieldRenderer } from './FieldRenderer'
import {
  CascadeEffectController,
  getCascadeFilters,
  getColSpanClass,
  parseJson,
  SYSTEM_FIELDS
} from './helpers'
import { useM2MStaging } from './M2MStagingContext'
import { useAddendumFields } from './AddendumFieldContext'
import type { CMSField, CMSRelation, RenderFieldProps } from './types'

const NUMERIC_TYPES = new Set(['integer', 'float', 'decimal', 'bigInteger', 'number'])
const TEXTUAL_TYPES = new Set(['string', 'text', 'richtext', 'textarea', 'markdown', 'json', 'csv'])
const TEXTUAL_INTERFACES = new Set(['input', 'textarea', 'wysiwyg', 'markdown', 'input-rich-text-html', 'rich_text', 'extension-editorjs'])
const RELATION_INTERFACES = new Set(['relation-m2o', 'relation-m2m', 'select-multiple-m2m', 'list-o2m', 'relation-list', 'inline-grid', 'inline-table', 'file', 'files', 'image'])

function isAiEligible(field: { type?: string; interface?: string | null }): boolean {
  const iface = field.interface ?? ''
  if (RELATION_INTERFACES.has(iface) || iface.startsWith('relation-') || iface.endsWith('-m2o') || iface.endsWith('-m2m')) return false
  if (TEXTUAL_TYPES.has(field.type ?? '') || TEXTUAL_INTERFACES.has(iface)) return true
  // Fallback: no interface + scalar type → renders as text Input
  if (!iface && field.type && !NUMERIC_TYPES.has(field.type)) return true
  return false
}

function FieldSparkline({ collection, itemId, field }: { collection: string; itemId: string; field: string }) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['field-history', collection, itemId, field],
    queryFn: () =>
      client
        .request<{ data: Array<{ timestamp: string; value: unknown }> }>(
          get(`/items/${encodeURIComponent(collection)}/${encodeURIComponent(itemId)}/field-history/${encodeURIComponent(field)}`)
        )
        .then((r) => r.data ?? []),
    enabled: open,
    staleTime: 30_000
  })

  const W = 120, H = 28, PAD = 3
  const points = (data ?? [])
    .slice()
    .reverse()
    .filter((e) => e.value !== null && e.value !== undefined && !Number.isNaN(Number(e.value)))
    .map((e) => ({ v: Number(e.value) }))

  let chart: ReactNode = null
  if (open) {
    if (isLoading) {
      chart = <Loader2 className='h-3 w-3 animate-spin text-slate-400' />
    } else if (points.length < 2) {
      chart = <span className='text-[10px] text-slate-400 italic'>{points.length === 0 ? 'No history' : 'One value only'}</span>
    } else {
      const vals = points.map((p) => p.v)
      const min = Math.min(...vals), max = Math.max(...vals)
      const range = max - min || 1
      const stepX = (W - PAD * 2) / (points.length - 1)
      const coords = points.map((p, i) => ({
        x: PAD + i * stepX,
        y: PAD + (1 - (p.v - min) / range) * (H - PAD * 2)
      }))
      const poly = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
      const last = coords[coords.length - 1]
      chart = (
        <span className='inline-flex items-center gap-1.5' title={`min ${min} · max ${max} · current ${vals[vals.length - 1]}`}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className='overflow-visible'>
            <polyline points={poly} fill='none' stroke='#00ceff' strokeWidth={1.5} strokeLinejoin='round' strokeLinecap='round' />
            <circle cx={last.x} cy={last.y} r={2.5} fill='#00ceff' />
          </svg>
          <span className='font-mono text-[10px] text-slate-400'>{min}–{max}</span>
        </span>
      )
    }
  }

  return (
    <>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center rounded px-1 py-0.5 transition-colors',
          open ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan' : 'text-slate-400 hover:bg-nvr-cyan/10 hover:text-nvr-cyan'
        )}
        title='Field change history'
      >
        <ChartLine className='h-3 w-3' />
      </button>
      {open && <span className='inline-flex items-center'>{chart}</span>}
    </>
  )
}

export function FieldRow({
  field,
  draft,
  onChange,
  relations,
  collection,
  itemId,
  error,
  visible,
  locked,
  layoutAiEnabled,
  renderField,
  onCountChange,
  swapButton,
  swapContent,
  forceVisible
}: {
  field: CMSField
  draft: Record<string, unknown>
  onChange: (field: string, value: unknown) => void
  relations: CMSRelation[]
  collection: string
  itemId: string
  error?: string
  visible: boolean
  locked: boolean
  layoutAiEnabled?: boolean
  renderField?: (props: RenderFieldProps) => ReactNode
  onCountChange?: (field: string, count: number) => void
  swapButton?: ReactNode
  swapContent?: ReactNode
  forceVisible?: boolean
}) {
  // Hooks must be called before any early return
  const m2mStaging = useM2MStaging()
  const queryClient = useQueryClient()
  const client = useNivaroClient()
  const [isGenerating, setIsGenerating] = useState(false)

  async function handleGenerate() {
    setIsGenerating(true)
    try {
      const res = await client.request<{ data: { value: string } }>(
        post('/ai/generate', { collection, item_id: itemId !== 'new' ? itemId : undefined, field: field.field })
      )
      if (res.data?.value != null) onChange(field.field, res.data.value)
    } catch { /* silently ignore — API returns 503 when no key configured */ }
    finally { setIsGenerating(false) }
  }

  // Compute cascade rules before early return so useQueries can subscribe
  const cascadeRules = getCascadeFilters(field.dependency_config)
  const parentM2mRelPairs = cascadeRules.flatMap((rule) => {
    const r = relations.find(
      (r) => r.one_collection === collection && r.one_field === rule.parent_field
    )
    if (!r) return []
    if (r.junction_field) return [{ rule, rel: r }]
    const companion = relations.find(
      (c) => c.many_collection === r.many_collection && c.id !== r.id
    )
    if (!companion?.many_field) return []
    return [{ rule, rel: { ...r, junction_field: companion.many_field } }]
  })
  const m2mParentResults = useQueries({
    queries: parentM2mRelPairs.map(({ rel }) => ({
      queryKey: ['m2m-items', rel.many_collection, rel.many_field, itemId],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${rel.many_collection}`, {
              filter: JSON.stringify({ [rel.many_field!]: { _eq: itemId } }),
              limit: 1,
              fields: `id,${rel.junction_field}`
            })
          )
          .then((r) => r.data ?? []),
      enabled: !!itemId && itemId !== 'new',
      staleTime: 30_000
    }))
  })
  const m2mParentCommitted = Object.fromEntries(
    parentM2mRelPairs.map(({ rule, rel }, i) => [
      rule.parent_field,
      (m2mParentResults[i]?.data ?? []).map((ji) => ji[rel.junction_field!])
    ])
  )

  const addendumHints = useAddendumFields()[field.field] ?? []

  if (!forceVisible && (!visible || (!field.layout_assigned && (field.hidden || SYSTEM_FIELDS.has(field.field))))) return null
  const value = draft[field.field] ?? null
  const label = field.label ?? titleCase(field.field)
  const autoIdPattern = parseJson<{ auto_id?: { pattern?: string } }>(field.options)?.auto_id
    ?.pattern

  // Resolve M2M / M2O relation for this field (for cascade clear logic)
  const m2mRelForField = (() => {
    const r = relations.find(
      (rel) => rel.one_collection === collection && rel.one_field === field.field
    )
    if (!r) return null
    if (r.junction_field) return r
    const companion = relations.find(
      (c) => c.many_collection === r.many_collection && c.id !== r.id
    )
    return companion ? { ...r, junction_field: companion.many_field } : null
  })()
  const m2oRelForField = m2mRelForField
    ? null
    : (relations.find((r) => r.many_collection === collection && r.many_field === field.field) ??
      null)
  const m2mFarEndRel = m2mRelForField
    ? (relations.find(
        (r) =>
          r.many_collection === m2mRelForField.many_collection &&
          r.many_field === m2mRelForField.junction_field &&
          r.id !== m2mRelForField.id
      ) ?? null)
    : null
  const m2mStagingKey = m2mRelForField
    ? (m2mRelForField.one_field ??
      `${m2mRelForField.many_collection}.${m2mRelForField.junction_field}`)
    : null
  const m2mStagedForCascade = m2mStagingKey
    ? (m2mStaging?.getStagedLinks(m2mStagingKey) ?? [])
    : []
  const m2mCommittedForCascade = m2mRelForField
    ? (
        queryClient.getQueryData<Record<string, unknown>[]>([
          'm2m-items',
          m2mRelForField.many_collection,
          m2mRelForField.many_field,
          itemId
        ]) ?? []
      ).map((ji) => ji[m2mRelForField.junction_field!])
    : []
  const cascadeCurrentValue = m2mRelForField
    ? (m2mStagedForCascade[0] ?? m2mCommittedForCascade[0] ?? null)
    : value
  const cascadeRelatedCollection =
    m2mFarEndRel?.one_collection ?? m2oRelForField?.one_collection ?? undefined

  // Cascade filter computation
  let cascadeFilter: Record<string, unknown> | undefined
  const cascadeParentLabels: string[] = []
  const cascadeParentFieldKeys: string[] = []
  let unsatisfiedParentLabel: string | null = null
  let requiredParentLabel: string | null = null
  for (const rule of cascadeRules) {
    const parentVal =
      draft[rule.parent_field] ??
      (() => {
        const r = relations.find(
          (r) => r.one_collection === collection && r.one_field === rule.parent_field
        )
        if (!r) return null
        let parentM2mRel = r
        if (!parentM2mRel.junction_field) {
          const companion = relations.find(
            (c) => c.many_collection === r.many_collection && c.id !== r.id
          )
          if (companion?.many_field) parentM2mRel = { ...r, junction_field: companion.many_field }
          else return null
        }
        const key =
          parentM2mRel.one_field ??
          `${parentM2mRel.many_collection}.${parentM2mRel.junction_field}`
        const staged = m2mStaging?.getStagedLinks(key) ?? []
        if (staged.length > 0) return staged[0]
        const committed = m2mParentCommitted[rule.parent_field] ?? []
        if (committed.length > 0) return committed[0]
        return null
      })()
    if (parentVal != null && parentVal !== '') {
      if (!cascadeFilter) cascadeFilter = {}
      cascadeFilter[rule.filter_column] = rule.filter_is_m2m
        ? { _some: { id: { _eq: parentVal } } }
        : { _eq: parentVal }
      cascadeParentLabels.push(titleCase(String(rule.parent_field)))
      cascadeParentFieldKeys.push(String(rule.parent_field))
    } else {
      if (!unsatisfiedParentLabel) unsatisfiedParentLabel = titleCase(String(rule.parent_field))
      if (rule.show_all_if_no_parent === false && !requiredParentLabel) {
        requiredParentLabel = titleCase(String(rule.parent_field))
      }
    }
  }

  function flashParentFields() {
    for (const key of cascadeParentFieldKeys) {
      const el = document.querySelector<HTMLElement>(`[data-field="${key}"]`)
      if (!el) continue
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.style.transition = 'box-shadow 0.15s ease'
      el.style.boxShadow = '0 0 0 2px #00ceff, 0 0 0 5px rgba(0,206,255,0.25)'
      el.style.borderRadius = '12px'
      setTimeout(() => {
        el.style.boxShadow = 'none'
        setTimeout(() => { el.style.transition = ''; el.style.borderRadius = '' }, 300)
      }, 900)
    }
  }

  const handleCascadeClear = () => {
    if (m2mRelForField && m2mStagingKey) {
      for (const rid of m2mStagedForCascade) m2mStaging?.unstageLink(m2mStagingKey, rid)
      const junctionItems =
        queryClient.getQueryData<Record<string, unknown>[]>([
          'm2m-items',
          m2mRelForField.many_collection,
          m2mRelForField.many_field,
          itemId
        ]) ?? []
      for (const ji of junctionItems) m2mStaging?.stageUnlink(m2mStagingKey, ji.id)
    } else {
      onChange(field.field, null)
    }
  }

  return (
    <div data-field={field.field} className='space-y-1.5'>
      {cascadeRules.length > 0 && (
        <CascadeEffectController
          cascadeRules={cascadeRules}
          cascadeFilter={cascadeFilter}
          currentValue={cascadeCurrentValue}
          relatedCollection={cascadeRelatedCollection}
          onClear={handleCascadeClear}
        />
      )}
      {(label !== '' || addendumHints.length > 0) && <div className='flex flex-wrap items-center gap-1.5 min-h-[1.5rem]'>
        {label !== '' && <Label className='text-sm font-medium'>
          {label}
          {field.required && <span className='ml-0.5 text-destructive'>*</span>}
        </Label>}
        {field.note && (
          <TooltipProvider delayDuration={100}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className='h-3.5 w-3.5 shrink-0 cursor-help text-slate-400 hover:text-slate-600' />
              </TooltipTrigger>
              <TooltipContent side='top' className='max-w-[240px] text-[12px]'>
                {field.note}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {/*{NUMERIC_TYPES.has(field.type) && itemId && itemId !== 'new' && (*/}
        {/*  <FieldSparkline collection={collection} itemId={itemId} field={field.field} />*/}
        {/*)}*/}
        {isAiEligible(field) && layoutAiEnabled && (
          <button
            type='button'
            onClick={handleGenerate}
            disabled={isGenerating}
            className='inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-nvr-cyan hover:bg-nvr-cyan/10 disabled:opacity-50 transition-colors'
            title='Generate with AI'
          >
            {isGenerating ? <Loader2 className='h-3 w-3 animate-spin' /> : <Sparkles className='h-3 w-3' />}
            AI
          </button>
        )}
        {swapButton}
        {addendumHints.length > 0 && (
          <TooltipProvider delayDuration={100}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className='inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20 cursor-default'>
                  <span className='h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0' />
                  addendum
                </span>
              </TooltipTrigger>
              <TooltipContent side='top' className='max-w-[220px] text-[12px]'>
                <p className='font-medium mb-1'>In active addendum{addendumHints.length > 1 ? 's' : ''}:</p>
                {addendumHints.map((h) => (
                  <p key={h.id} className='text-slate-400'>{h.title} <span className='capitalize'>({h.status})</span></p>
                ))}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {locked && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className='inline-flex items-center text-amber-400 dark:text-amber-500'>
                  <Lock className='h-3 w-3' />
                </span>
              </TooltipTrigger>
              <TooltipContent side='top' className='text-[12px]'>
                This field is locked
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {cascadeFilter && Object.keys(cascadeFilter).length > 0 && cascadeParentLabels.length > 0 && (
          <TooltipProvider delayDuration={100}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type='button'
                  onClick={flashParentFields}
                  className='inline-flex items-center text-slate-300 hover:text-nvr-cyan dark:text-slate-600 dark:hover:text-nvr-cyan transition-colors'
                >
                  <SlidersHorizontal className='h-3 w-3' />
                </button>
              </TooltipTrigger>
              <TooltipContent side='top' className='text-[12px]'>
                Filtered by {cascadeParentLabels.join(', ')} — click to highlight
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>}
      {swapContent ?? <div className={cn(locked && 'cursor-not-allowed')}><div className={cn(locked && 'pointer-events-none opacity-60', error && 'ring-1 ring-red-400 rounded-md')}>
        {autoIdPattern ? (
          <AutoIdPreviewField collection={collection} field={field} draft={draft} itemId={itemId} />
        ) : renderField ? (
          renderField({
            field,
            value,
            onChange: (v) => onChange(field.field, v),
            disabled: locked,
            collection,
            itemId,
            relations,
            cascadeFilter,
            unsatisfiedParentLabel,
            requiredParentLabel
          })
        ) : (
          <FieldRenderer
            field={field}
            value={value}
            onChange={(v) => onChange(field.field, v)}
            relations={relations}
            collection={collection}
            itemId={itemId}
            cascadeFilter={cascadeFilter}
            requiredParentLabel={requiredParentLabel}
            onCountChange={onCountChange ? (count) => onCountChange(field.field, count) : undefined}
          />
        )}
      </div></div>}
    </div>
  )
}

// ─── re-export getColSpanClass for GroupSection usage ─────────────────────────
export { getColSpanClass }
