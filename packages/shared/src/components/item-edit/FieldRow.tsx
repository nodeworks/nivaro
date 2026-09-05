import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell,
  BellRing,
  ChartLine,
  History,
  Info,
  Loader2,
  Lock,
  Sigma,
  SlidersHorizontal,
  Sparkles
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient, useParentDraft } from '../../context'
import { del, get, post } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { useAddendumFields } from './AddendumFieldContext'
import { AutoIdPreviewField } from './AutoIdPreviewField'
import { FieldRenderer, resolveOptionFilterTokens } from './FieldRenderer'
import {
  CascadeEffectController,
  getCascadeFilters,
  getColSpanClass,
  parseJson,
  SYSTEM_FIELDS
} from './helpers'
import { isDerivedForRecord } from './live-rollups'
import { useM2MStaging } from './M2MStagingContext'
import type { CMSField, CMSRelation, RenderFieldProps } from './types'

const NUMERIC_TYPES = new Set(['integer', 'float', 'decimal', 'bigInteger', 'number'])
const TEXTUAL_TYPES = new Set(['string', 'text', 'richtext', 'textarea', 'markdown', 'json', 'csv'])
const TEXTUAL_INTERFACES = new Set([
  'input',
  'textarea',
  'wysiwyg',
  'markdown',
  'input-rich-text-html',
  'rich_text',
  'extension-editorjs'
])
const RELATION_INTERFACES = new Set([
  'relation-m2o',
  'relation-m2m',
  'select-multiple-m2m',
  'list-o2m',
  'relation-list',
  'inline-grid',
  'inline-table',
  'file',
  'files',
  'image'
])

function isAiEligible(field: { type?: string; interface?: string | null }): boolean {
  const iface = field.interface ?? ''
  if (
    RELATION_INTERFACES.has(iface) ||
    iface.startsWith('relation-') ||
    iface.endsWith('-m2o') ||
    iface.endsWith('-m2m')
  )
    return false
  if (TEXTUAL_TYPES.has(field.type ?? '') || TEXTUAL_INTERFACES.has(iface)) return true
  // Fallback: no interface + scalar type → renders as text Input
  if (!iface && field.type && !NUMERIC_TYPES.has(field.type)) return true
  return false
}

function FieldSparkline({
  collection,
  itemId,
  field
}: {
  collection: string
  itemId: string
  field: string
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['field-history', collection, itemId, field],
    queryFn: () =>
      client
        .request<{ data: Array<{ timestamp: string; value: unknown }> }>(
          get(
            `/items/${encodeURIComponent(collection)}/${encodeURIComponent(itemId)}/field-history/${encodeURIComponent(field)}`
          )
        )
        .then((r) => r.data ?? []),
    enabled: open,
    staleTime: 30_000
  })

  const W = 120,
    H = 28,
    PAD = 3
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
      chart = (
        <span className='text-[10px] text-slate-400 italic'>
          {points.length === 0 ? 'No history' : 'One value only'}
        </span>
      )
    } else {
      const vals = points.map((p) => p.v)
      const min = Math.min(...vals),
        max = Math.max(...vals)
      const range = max - min || 1
      const stepX = (W - PAD * 2) / (points.length - 1)
      const coords = points.map((p, i) => ({
        x: PAD + i * stepX,
        y: PAD + (1 - (p.v - min) / range) * (H - PAD * 2)
      }))
      const poly = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
      const last = coords[coords.length - 1]
      chart = (
        <span
          className='inline-flex items-center gap-1.5'
          title={`min ${min} · max ${max} · current ${vals[vals.length - 1]}`}
        >
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className='overflow-visible'>
            <polyline
              points={poly}
              fill='none'
              stroke='#00ceff'
              strokeWidth={1.5}
              strokeLinejoin='round'
              strokeLinecap='round'
            />
            <circle cx={last.x} cy={last.y} r={2.5} fill='#00ceff' />
          </svg>
          <span className='font-mono text-[10px] text-slate-400'>
            {min}–{max}
          </span>
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
          open
            ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
            : 'text-slate-400 hover:bg-nvr-cyan/10 hover:text-nvr-cyan'
        )}
        title='Field change history'
      >
        <ChartLine className='h-3 w-3' />
      </button>
      {open && <span className='inline-flex items-center'>{chart}</span>}
    </>
  )
}

/**
 * "What was this before?" — the field's value history in a popover: became
 * <value> at <time> by <who>, newest first, from the revision deltas. Fetches
 * only when opened. Every field type, not just numerics (the old sparkline
 * covered numbers only and was never enabled).
 */
/**
 * "Why is this number what it is?" — lineage for computed fields. A rollup
 * shows the actual contributing child rows (label, value, who last touched
 * each) and whether their sum still matches the stored figure; a
 * write-computed field shows its formula and the current inputs.
 */
function FieldLineageButton({
  collection,
  itemId,
  field
}: {
  collection: string
  itemId: string
  field: string
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const { data, isLoading } = useQuery<{
    kind: 'rollup' | 'write'
    stored_value?: unknown
    formula?: string
    inputs?: Record<string, unknown>
    sources?: Array<{
      collection: string
      aggregate?: string
      value_field?: string | null
      value_formula?: string | null
      filtered?: boolean
      note?: string
      error?: string
      subtotal?: number
      truncated?: boolean
      rows: Array<{
        id: string
        label: string
        value: number | null
        updated_at: string | null
        updated_by: string | null
      }>
    }>
  }>({
    queryKey: ['field-lineage', collection, itemId, field],
    queryFn: () =>
      client
        .request<{ data: never }>(
          get(`/lineage/${collection}/${encodeURIComponent(itemId)}/${field}`)
        )
        .then((r) => r.data),
    enabled: open,
    staleTime: 30_000
  })
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const num = (v: unknown): string =>
    v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })
  const stored = data?.stored_value != null ? Number(data.stored_value) : null
  return (
    <div ref={rootRef} className='relative inline-flex'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        title='Where does this number come from?'
        className={cn(
          'inline-flex items-center rounded p-0.5 transition-opacity',
          open
            ? 'text-nvr-cyan opacity-100'
            : 'text-slate-400 hover:text-nvr-cyan dark:text-slate-300 dark:hover:text-nvr-cyan'
        )}
        data-field-lineage
      >
        <Sigma className='h-3 w-3' />
      </button>
      {open && (
        <div className='absolute left-0 top-full z-40 mt-1 max-h-[340px] w-[360px] overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-border dark:bg-card'>
          <p className='mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
            Where this number comes from
          </p>
          {isLoading && <p className='px-1 py-2 text-[11.5px] text-slate-400'>Loading…</p>}
          {data?.kind === 'write' && (
            <div className='space-y-1 px-1 py-1'>
              <p className='font-mono text-[11px] text-slate-600 dark:text-slate-300'>
                {data.formula}
              </p>
              {Object.entries(data.inputs ?? {}).map(([k, v]) => (
                <p key={k} className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  <span className='font-mono'>{k}</span> = {num(v)}
                </p>
              ))}
              <p className='pt-1 text-[11.5px] font-medium text-slate-700 dark:text-slate-200'>
                = {num(data.stored_value)}
              </p>
            </div>
          )}
          {data?.kind === 'rollup' &&
            (data.sources ?? []).map((src, i) => (
              <div key={i} className='mb-1.5'>
                <p className='px-1 text-[10.5px] text-slate-400'>
                  {(src.aggregate ?? 'sum').toUpperCase()}
                  {src.value_field ? ` of ${src.value_field}` : ''} across {src.collection}
                  {src.filtered ? ' (filtered)' : ''}
                </p>
                {src.error && (
                  <p className='px-1 py-1 text-[11.5px] text-amber-600 dark:text-amber-400'>
                    {src.error}
                  </p>
                )}
                {src.note && <p className='px-1 py-1 text-[11.5px] text-slate-400'>{src.note}</p>}
                {src.rows.length > 0 && (
                  <div className='mt-0.5 space-y-px'>
                    {src.rows.map((r) => (
                      <div
                        key={r.id}
                        className='flex items-baseline gap-2 rounded px-1 py-0.5 text-[11.5px] hover:bg-slate-50 dark:hover:bg-muted'
                      >
                        <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'>
                          {r.label}
                        </span>
                        <span className='shrink-0 font-mono tabular-nums text-slate-800 dark:text-slate-100'>
                          {num(r.value)}
                        </span>
                        <span
                          className='w-[88px] shrink-0 truncate text-right text-[10px] text-slate-400'
                          data-tip={
                            r.updated_at
                              ? `${r.updated_by ?? 'unknown'} · ${new Date(r.updated_at).toLocaleString()}`
                              : undefined
                          }
                        >
                          {r.updated_by ?? ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {src.truncated && (
                  <p className='px-1 pt-0.5 text-[10.5px] text-amber-600 dark:text-amber-400'>
                    Showing the first 200 rows — the subtotal covers only these.
                  </p>
                )}
                {src.subtotal != null && (
                  <p className='border-t border-slate-100 px-1 pt-1 text-right text-[11.5px] font-medium text-slate-700 dark:border-border dark:text-slate-200'>
                    subtotal {num(src.subtotal)}
                  </p>
                )}
              </div>
            ))}
          {data?.kind === 'rollup' && stored != null && (
            <p className='px-1 pt-0.5 text-right text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              stored {num(stored)}
              {(() => {
                const sum = (data.sources ?? []).reduce((a, s) => a + (s.subtotal ?? 0), 0)
                const truncated = (data.sources ?? []).some((s) => s.truncated)
                if (truncated) return null
                return Math.abs(sum - stored) < 0.01 ? (
                  <span className='ml-1 text-emerald-600 dark:text-emerald-400'>✓ matches</span>
                ) : (
                  <span className='ml-1 text-amber-600 dark:text-amber-400'>
                    ✕ differs from contributions
                  </span>
                )
              })()}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function FieldHistoryButton({
  collection,
  itemId,
  field,
  formatValue,
  onRestore
}: {
  collection: string
  itemId: string
  field: string
  formatValue?: (v: unknown) => string
  /** Field-level revert (#140): restore a historical value into the draft. */
  onRestore?: (value: unknown) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['field-value-history', collection, itemId, field],
    queryFn: () =>
      client
        .request<{
          data: Array<{
            value: unknown
            display: string | null
            timestamp: string | null
            user_name: string | null
            action: string
            origin?: { kind: string; label: string | null }
            note?: string | null
          }>
        }>(get(`/field-history/${collection}/${encodeURIComponent(itemId)}/${field}`))
        .then((r) => r.data ?? []),
    enabled: open,
    staleTime: 60_000
  })
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const fmt = (v: unknown, display?: string | null): string => {
    // Server-resolved display label (relation record, choice text) wins —
    // never show an internal id when the human name is known.
    if (display) return display
    if (v === null || v === undefined || v === '') return '—'
    if (formatValue) return formatValue(v)
    if (typeof v === 'boolean' || v === 'true' || v === 'false') {
      return v === true || v === 'true' ? 'Yes' : 'No'
    }
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
      return new Date(v).toLocaleString()
    }
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 60)
    return String(v).slice(0, 80)
  }
  return (
    <div ref={rootRef} className='relative inline-flex'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        title='Value history'
        className={cn(
          'inline-flex items-center rounded p-0.5 transition-opacity',
          open
            ? 'text-nvr-cyan opacity-100'
            : 'text-slate-400 hover:text-nvr-cyan dark:text-slate-300 dark:hover:text-nvr-cyan'
        )}
        data-field-history
      >
        <History className='h-3 w-3' />
      </button>
      {open && (
        <div className='absolute left-0 top-full z-40 mt-1 max-h-64 w-[300px] overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-border dark:bg-card'>
          <p className='mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
            Value history
          </p>
          {isLoading ? (
            <p className='px-1 py-2 text-[11.5px] text-slate-400'>Loading…</p>
          ) : (data ?? []).length === 0 ? (
            <p className='px-1 py-2 text-[11.5px] text-slate-400'>
              No recorded changes for this field.
            </p>
          ) : (
            <div className='space-y-1'>
              {(data ?? []).map((e, i) => (
                <div
                  key={i}
                  className='rounded px-1 py-1 text-[11.5px] leading-snug hover:bg-slate-50 dark:hover:bg-muted'
                >
                  <span className='flex items-baseline justify-between gap-2'>
                    <span className='font-medium text-slate-700 dark:text-slate-200'>
                      {fmt(e.value, e.display)}
                    </span>
                    {onRestore && i > 0 && (
                      <button
                        type='button'
                        onClick={() => {
                          onRestore(e.value ?? null)
                          setOpen(false)
                        }}
                        className='shrink-0 rounded border border-slate-200 px-1.5 py-px text-[10px] text-slate-500 hover:border-nvr-cyan/60 hover:text-nvr-navy dark:border-border dark:hover:text-nvr-cyan'
                      >
                        Restore
                      </button>
                    )}
                  </span>
                  <span className='block text-[10.5px] text-slate-400'>
                    {e.action === 'create' ? 'initial value' : 'changed'}
                    {e.timestamp ? ` · ${new Date(e.timestamp).toLocaleString()}` : ''}
                    {e.user_name ? ` · ${e.user_name}` : ''}
                    {/* Lineage: WHERE the value came from, when it wasn't a
                        plain user edit — import, integration, automation. */}
                    {e.origin && e.origin.kind !== 'user' && (
                      <span
                        className={
                          e.origin.kind === 'integration'
                            ? 'ml-1 rounded bg-purple-500/10 px-1 py-px text-[9.5px] font-medium text-purple-700 dark:text-purple-400'
                            : e.origin.kind === 'import'
                              ? 'ml-1 rounded bg-sky-500/10 px-1 py-px text-[9.5px] font-medium text-sky-700 dark:text-sky-400'
                              : 'ml-1 rounded bg-amber-500/10 px-1 py-px text-[9.5px] font-medium text-amber-700 dark:text-amber-400'
                        }
                      >
                        {e.origin.label ?? e.origin.kind}
                      </span>
                    )}
                  </span>
                  {e.note && (
                    <span className='block text-[10.5px] italic text-slate-500 dark:text-slate-400'>
                      “{e.note}”
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Field-level record watch (#58): a bell on the field label that subscribes
 * the viewer to changes of THIS field on THIS record. Renders only when the
 * instance feature flag (nivaro_settings.field_watch_enabled) is on — off by
 * default. Queries are shared per record, so fifty fields cost two requests.
 */
function FieldWatchButton({
  collection,
  itemId,
  field
}: {
  collection: string
  itemId: string
  field: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: cfg } = useQuery({
    queryKey: ['field-watch-config'],
    queryFn: () =>
      client
        .request<{ data: { enabled: boolean } }>(get('/field-watches/config'))
        .then((r) => r.data)
        .catch(() => ({ enabled: false })),
    staleTime: 5 * 60_000
  })
  const watchedKey = ['field-watch-self', collection, itemId]
  const { data: watched = [] } = useQuery({
    queryKey: watchedKey,
    queryFn: () =>
      client
        .request<{ data: string[] }>(get('/field-watches/self', { collection, item_id: itemId }))
        .then((r) => r.data ?? [])
        .catch(() => [] as string[]),
    enabled: !!cfg?.enabled,
    staleTime: 60_000
  })
  const isWatching = watched.includes(field)
  const toggle = useMutation({
    mutationFn: () =>
      isWatching
        ? client.request(
            del(
              `/field-watches/self?collection=${encodeURIComponent(collection)}&field=${encodeURIComponent(field)}&item_id=${encodeURIComponent(itemId)}`
            )
          )
        : client.request(post('/field-watches/self', { collection, field, item_id: itemId })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: watchedKey })
      toast.success(
        isWatching
          ? 'No longer watching this field'
          : 'Watching — you will be notified when it changes'
      )
    },
    onError: () => toast.error('Could not update the watch')
  })
  if (!cfg?.enabled) return null
  return (
    <button
      type='button'
      onClick={() => toggle.mutate()}
      title={
        isWatching ? 'Stop watching this field on this record' : 'Watch this field on this record'
      }
      data-field-watch={field}
      className={`rounded p-0.5 transition-colors ${
        isWatching ? 'text-nvr-navy dark:text-nvr-cyan' : 'text-slate-300 hover:text-slate-500'
      }`}
    >
      {isWatching ? <BellRing className='h-3 w-3' /> : <Bell className='h-3 w-3' />}
    </button>
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
  forceVisible,
  autoFillTick
}: {
  field: CMSField
  draft: Record<string, unknown>
  onChange: (field: string, value: unknown) => void
  relations: CMSRelation[]
  collection: string
  itemId: string
  error?: string
  /** Bumped by the form when a rule / autofill wrote this field — glows once per bump. */
  autoFillTick?: number
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
  const parentDraftCtx = useParentDraft()
  const m2mStaging = useM2MStaging()
  const queryClient = useQueryClient()
  const client = useNivaroClient()
  const [isGenerating, setIsGenerating] = useState(false)

  async function handleGenerate() {
    setIsGenerating(true)
    try {
      const res = await client.request<{ data: { value: string } }>(
        post('/ai/generate', {
          collection,
          item_id: itemId !== 'new' ? itemId : undefined,
          field: field.field
        })
      )
      if (res.data?.value != null) onChange(field.field, res.data.value)
    } catch {
      /* silently ignore — API returns 503 when no key configured */
    } finally {
      setIsGenerating(false)
    }
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
              limit: 200,
              fields: `id,${rel.junction_field}`
            })
          )
          .then((r) => r.data ?? []),
      enabled: !!itemId && itemId !== 'new',
      staleTime: 30_000
    }))
  })
  // Committed rows keep their junction ROW id so pending unlinks (which are
  // staged by junction id) can subtract them — replacing the single allowed
  // region must not leave the OLD one in the cascade filter.
  const m2mParentCommitted = Object.fromEntries(
    parentM2mRelPairs.map(({ rule, rel }, i) => {
      const key = rel.one_field ?? `${rel.many_collection}.${rel.junction_field}`
      const unlinked = m2mStaging?.getStagedUnlinks(key) ?? new Set()
      return [
        rule.parent_field,
        (m2mParentResults[i]?.data ?? [])
          .filter((ji) => !unlinked.has(ji.id))
          .map((ji) => ji[rel.junction_field!])
      ]
    })
  )

  const addendumHints = useAddendumFields()[field.field] ?? []

  if (
    !forceVisible &&
    (!visible || (!field.layout_assigned && (field.hidden || SYSTEM_FIELDS.has(field.field))))
  )
    return null
  const value = draft[field.field] ?? null
  const label = field.label ?? titleCase(field.field)
  // A rollup with a parent_filter is only derived for records that MATCH it
  // (a CAR's Total REQ Amount is typed in — no lines to sum). The lineage
  // (Σ) affordance is a lie on those records, so it follows the same test.
  const isActuallyComputed = isDerivedForRecord(field, draft)

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
  const m2mStagedForCascade = m2mStagingKey ? (m2mStaging?.getStagedLinks(m2mStagingKey) ?? []) : []
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
  // Layout-effective parent labels — 'division' reads as 'Zone' when the
  // layout renames it; only trustworthy when the context describes THIS
  // collection (grid cells carry the parent record's labels instead).
  const parentFieldLabel = (f: string): string =>
    (parentDraftCtx?.collection === collection ? parentDraftCtx?.fieldLabels?.[f] : undefined) ??
    titleCase(String(f))
  const cascadeParentLabels: string[] = []
  const cascadeParentFieldKeys: string[] = []
  let unsatisfiedParentLabel: string | null = null
  let requiredParentLabel: string | null = null
  for (const rule of cascadeRules) {
    // A parent whose value THIS field's own pick derived must not narrow this
    // field's options — otherwise picking a region locks the region picker
    // into the zone the pick itself filled, and cross-zone changes read as
    // "No results".
    if (m2mStaging?.getDerivedOrigin?.(rule.parent_field) === field.field) continue
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
          parentM2mRel.one_field ?? `${parentM2mRel.many_collection}.${parentM2mRel.junction_field}`
        // EVERY linked value counts — two linked regions filter options to
        // records reachable from either, not silently just the first.
        const staged = m2mStaging?.getStagedLinks(key) ?? []
        const committed = m2mParentCommitted[rule.parent_field] ?? []
        const all = [...new Set([...staged, ...committed].map((v) => String(v)))]
        if (all.length === 0) return null
        return all.length === 1 ? all[0] : all
      })()
    if (parentVal != null && parentVal !== '') {
      if (!cascadeFilter) cascadeFilter = {}
      // value_map: parent value → derived filter value(s); arrays become _in
      let filterVal: unknown = parentVal
      if (rule.value_map && typeof rule.value_map === 'object') {
        const vm = rule.value_map
        const mapOne = (v: unknown) => vm[String(v)] ?? rule.value_map_default ?? v
        filterVal = Array.isArray(parentVal)
          ? [
              ...new Set(
                parentVal.flatMap((v) => {
                  const m = mapOne(v)
                  return Array.isArray(m) ? m : [m]
                })
              )
            ]
          : mapOne(parentVal)
      }
      const clause = Array.isArray(filterVal) ? { _in: filterVal } : { _eq: filterVal }
      if (rule.filter_is_m2m) {
        cascadeFilter[rule.filter_column] = { _some: { id: clause } }
      } else if (rule.filter_column.includes('.')) {
        // Dotted path: fold right into nested relation filter; wrap the first
        // hop in _some when it traverses a to-many alias (filter_via_many).
        const segs = rule.filter_column.split('.')
        let nested: Record<string, unknown> = clause
        for (let i = segs.length - 1; i >= 1; i--) nested = { [segs[i]]: nested }
        cascadeFilter[segs[0]] = rule.filter_via_many ? { _some: nested } : nested
      } else {
        cascadeFilter[rule.filter_column] = clause
      }
      cascadeParentLabels.push(parentFieldLabel(String(rule.parent_field)))
      cascadeParentFieldKeys.push(String(rule.parent_field))
    } else {
      if (!unsatisfiedParentLabel)
        unsatisfiedParentLabel = parentFieldLabel(String(rule.parent_field))
      if (rule.show_all_if_no_parent === false && !requiredParentLabel) {
        requiredParentLabel = parentFieldLabel(String(rule.parent_field))
      }
      // Parent unset but the parent's OWN picker curates its options
      // (option_filter): inherit that filter through the cascade relation, so
      // this picker never offers records the parent could not hold. E.g. Unit
      // Form: project_type filtered to unit-tracking types → with no type
      // picked yet, projects narrow to those whose type is unit-tracking.
      // value_map rules are value arithmetic, not relational — skipped.
      const parentFilterRaw =
        parentDraftCtx?.collection === collection
          ? parentDraftCtx.fieldOptionFilters?.[rule.parent_field]
          : undefined
      const parentFilter =
        parentFilterRaw && !rule.value_map
          ? resolveOptionFilterTokens(parentFilterRaw, draft, itemId)
          : undefined
      if (parentFilter) {
        if (!cascadeFilter) cascadeFilter = {}
        if (rule.filter_is_m2m) {
          cascadeFilter[rule.filter_column] = { _some: parentFilter }
        } else if (rule.filter_column.includes('.')) {
          const segs = rule.filter_column.split('.')
          let nested: Record<string, unknown> = parentFilter
          for (let i = segs.length - 1; i >= 1; i--) nested = { [segs[i]]: nested }
          cascadeFilter[segs[0]] = rule.filter_via_many ? { _some: nested } : nested
        } else {
          cascadeFilter[rule.filter_column] = parentFilter
        }
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
        setTimeout(() => {
          el.style.transition = ''
          el.style.borderRadius = ''
        }, 300)
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
    <div data-field={field.field} className='group/fieldrow space-y-1.5'>
      {cascadeRules.length > 0 && (
        <CascadeEffectController
          cascadeRules={cascadeRules}
          cascadeFilter={cascadeFilter}
          currentValue={cascadeCurrentValue}
          relatedCollection={cascadeRelatedCollection}
          onClear={handleCascadeClear}
        />
      )}
      {(label !== '' || addendumHints.length > 0) && (
        <div className='flex flex-wrap items-center gap-1.5 min-h-[1.5rem]'>
          {label !== '' && (
            <Label className='text-sm font-medium'>
              {label}
              {field.required && <span className='ml-0.5 text-destructive'>*</span>}
            </Label>
          )}
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
          {itemId && itemId !== 'new' && (
            <FieldHistoryButton
              collection={collection}
              itemId={itemId}
              field={field.field}
              onRestore={field.readonly ? undefined : (v) => onChange(field.field, v)}
            />
          )}
          {itemId && itemId !== 'new' && (
            <FieldWatchButton collection={collection} itemId={itemId} field={field.field} />
          )}
          {itemId && itemId !== 'new' && isActuallyComputed && (
            <FieldLineageButton collection={collection} itemId={itemId} field={field.field} />
          )}
          {isAiEligible(field) && layoutAiEnabled && (
            <button
              type='button'
              onClick={handleGenerate}
              disabled={isGenerating}
              className='inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-nvr-cyan hover:bg-nvr-cyan/10 disabled:opacity-50 transition-colors'
              title='Generate with AI'
            >
              {isGenerating ? (
                <Loader2 className='h-3 w-3 animate-spin' />
              ) : (
                <Sparkles className='h-3 w-3' />
              )}
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
                  <p className='font-medium mb-1'>
                    In active addendum{addendumHints.length > 1 ? 's' : ''}:
                  </p>
                  {addendumHints.map((h) => (
                    <p key={h.id} className='text-slate-400'>
                      {h.title} <span className='capitalize'>({h.status})</span>
                    </p>
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
          {cascadeRules.length > 0 &&
            (() => {
              // Icon always shows for a cascade-configured field: cyan when the
              // filter is actively narrowing options, gray when parents are unset.
              const cascadeActive =
                !!cascadeFilter &&
                Object.keys(cascadeFilter).length > 0 &&
                cascadeParentLabels.length > 0
              const allParentLabels = cascadeRules.map((r) =>
                parentFieldLabel(String(r.parent_field))
              )
              return (
                <TooltipProvider delayDuration={100}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type='button'
                        onClick={flashParentFields}
                        className={cn(
                          'inline-flex items-center transition-colors',
                          cascadeActive
                            ? 'text-nvr-cyan hover:text-nvr-cyan'
                            : 'text-slate-300 hover:text-nvr-cyan dark:text-slate-600 dark:hover:text-nvr-cyan'
                        )}
                      >
                        <SlidersHorizontal className='h-3 w-3' />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side='top' className='text-[12px]'>
                      {cascadeActive
                        ? `Filtered by ${cascadeParentLabels.join(', ')} — click to highlight`
                        : `Options filter by ${allParentLabels.join(', ')} once set`}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )
            })()}
        </div>
      )}
      {swapContent ?? (
        <div className={cn(locked && 'cursor-not-allowed')}>
          <div
            key={autoFillTick ?? 0}
            className={cn(
              locked && 'pointer-events-none opacity-60',
              // The ring lands with a 2px shake so the eye finds the field;
              // the animation runs once when the class is added.
              error && 'nvr-shake ring-1 ring-red-400 rounded-md',
              autoFillTick && 'nvr-autofill-glow'
            )}
          >
            {autoIdPattern ? (
              <AutoIdPreviewField
                collection={collection}
                field={field}
                draft={draft}
                itemId={itemId}
              />
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
                onCountChange={
                  onCountChange ? (count) => onCountChange(field.field, count) : undefined
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── re-export getColSpanClass for GroupSection usage ─────────────────────────
export { getColSpanClass }
