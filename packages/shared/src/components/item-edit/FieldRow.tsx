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
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient, useParentDraft } from '../../context'
import { AUTOFILL_CHECK_KEY, readAiFill, showsAiButton } from '../../lib/ai-fill'
import { del, get, post } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import { GlossaryLabel } from '../ai/GlossaryText'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { useAddendumFields } from './AddendumFieldContext'
import { AutoIdPreviewField } from './AutoIdPreviewField'
import {
  LockReasonBadge,
  PresenceSoftLockStrip,
  RemoteChangeGhost,
  useFieldAffordances,
  useFieldContextMenu,
  usePresenceSoftLock
} from './FieldAffordances'
import { FieldRenderer, resolveOptionFilterTokens } from './FieldRenderer'
import { FormHelpVideoButton } from './FormHelpVideoButton'
import {
  buildCascadeFilter,
  CascadeEffectController,
  getCascadeFilters,
  getColSpanClass,
  parseJson,
  SYSTEM_FIELDS
} from './helpers'
import { isDerivedForRecord } from './live-rollups'
import { useM2MStaging } from './M2MStagingContext'
import { PersonalDefaultHint, PersonalDefaultPill } from './PersonalDefaultPill'
import {
  DisplayFormulaValue,
  FieldCounter,
  fieldCounterConfig,
  fieldIsRecommended,
  isDisplayFormulaRow,
  placementFieldText,
  RecommendedMarker,
  RepeatLastButton,
  usePlacementTextContext
} from './placement-behaviour'
import { jsonEqual, keepIfEqual } from './render-stability'
import type { CMSField, CMSRelation, RenderFieldProps } from './types'
import { usePersonalDefaultsApi } from './usePersonalDefaults'

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

const FILE_INTERFACES = new Set(['file', 'file-image', 'files-m2m', 'files', 'image'])

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
export interface LineageData {
  kind: 'rollup' | 'write' | 'read'
  stored_value?: unknown
  formula?: string
  inputs?: Record<string, unknown>
  sources?: Array<{
    collection: string
    aggregate?: string
    value_field?: string | null
    value_formula?: string | null
    filtered?: boolean
    filter?: Record<string, unknown> | null
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
    /** Rows the source filter left out, with the reason. */
    excluded?: Array<{ id: string; label: string; value: number | null; reason: string }>
  }>
}

/** Lineage of a computed field, fetched only while `enabled`. */
export function useFieldLineage(
  collection: string,
  itemId: string,
  field: string,
  enabled: boolean
) {
  const client = useNivaroClient()
  return useQuery<LineageData>({
    queryKey: ['field-lineage', collection, itemId, field],
    queryFn: () =>
      client
        .request<{ data: LineageData }>(
          get(`/lineage/${collection}/${encodeURIComponent(itemId)}/${field}`)
        )
        .then((r) => r.data),
    enabled,
    staleTime: 30_000
  })
}

/** One-line summary for a rollup: "= 5 lines · 1 excluded (line type is not 4)". */
export function lineageSummary(data: LineageData | undefined, noun = 'rows'): string | null {
  // #15 — a computed figure's derivation: the formula with its inputs
  // substituted ("= 3,401 − 3,394").
  if (data && (data.kind === 'write' || data.kind === 'read') && data.formula) {
    const fmt = (v: unknown) =>
      typeof v === 'number'
        ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : v == null || v === ''
          ? '∅'
          : String(v)
    const expr = data.formula
      .replace(/item\.([A-Za-z_][A-Za-z0-9_]*)/g, (_m, k: string) => fmt(data.inputs?.[k]))
      .replace(/\s*-\s*/g, ' − ')
      .replace(/\s*\*\s*/g, ' × ')
      .replace(/\s*\/\s*/g, ' ÷ ')
    return `= ${expr}`
  }
  if (!data || data.kind !== 'rollup') return null
  const rows = (data.sources ?? []).reduce((a, s) => a + s.rows.length, 0)
  const excluded = (data.sources ?? []).reduce((a, s) => a + (s.excluded?.length ?? 0), 0)
  const reason = (data.sources ?? []).find((s) => s.excluded?.length)?.excluded?.[0]?.reason
  const parts = [`= ${rows} ${rows === 1 ? noun.replace(/s$/, '') : noun}`]
  if (excluded)
    parts.push(
      `${excluded} excluded${reason ? ` (${reason.replace(/^does not match: /, '')})` : ''}`
    )
  return parts.join(' · ')
}

function FieldLineageButton({
  collection,
  itemId,
  field
}: {
  collection: string
  itemId: string
  field: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const { data, isLoading } = useFieldLineage(collection, itemId, field, open)
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
                {(src.excluded?.length ?? 0) > 0 && (
                  <div className='mt-1 rounded bg-slate-50 px-1 py-1 dark:bg-muted/40'>
                    <p className='text-[10.5px] text-slate-500 dark:text-muted-foreground'>
                      {src.excluded!.length} excluded —{' '}
                      {src.excluded![0].reason.replace(/^does not match: /, '')}
                    </p>
                    {src.excluded!.slice(0, 8).map((r) => (
                      <div
                        key={r.id}
                        className='flex items-baseline gap-2 px-0.5 text-[11px] text-slate-400'
                      >
                        <span className='min-w-0 flex-1 truncate line-through decoration-slate-300'>
                          {r.label}
                        </span>
                        <span className='shrink-0 font-mono tabular-nums'>{num(r.value)}</span>
                      </div>
                    ))}
                    {src.excluded!.length > 8 && (
                      <p className='px-0.5 text-[10.5px] text-slate-400'>
                        +{src.excluded!.length - 8} more
                      </p>
                    )}
                  </div>
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

/** The control a field label names: its first input (a rich-text body, not
 *  the toolbar above it), else a picker's trigger button. */
function primaryControl(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null
  return (
    root.querySelector<HTMLElement>(
      'input:not([type=hidden]), textarea, [role="combobox"], [contenteditable="true"]'
    ) ?? root.querySelector<HTMLElement>('button')
  )
}

/** One field of the record form. Memoized: the form re-renders for many
 *  reasons that change nothing a row shows (presence, lock polls, save
 *  state), and every prop it passes is kept stable for that. A row still
 *  re-renders on every draft change through ParentDraftContext. */
export const FieldRow = memo(function FieldRow({
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
  const isFileField = FILE_INTERFACES.has(field.interface ?? '')
  const parentDraftCtx = useParentDraft()
  const m2mStaging = useM2MStaging()
  const queryClient = useQueryClient()
  const client = useNivaroClient()
  const [isGenerating, setIsGenerating] = useState(false)
  // Per-field affordances handed down by the record form (remote ghosts,
  // lock reasons, apply-to-lines, related-record opener) — null in hosts that
  // render FieldRow outside ItemEditForm.
  const affordances = useFieldAffordances()
  const wrapperRef = useRef<HTMLDivElement>(null)
  // The visible label names the field's control for screen readers: every
  // picker announced itself as just "Select…". The control is whatever the
  // interface renders, so it is named after paint (each render, a few reads).
  const labelId = useId()
  const controlRef = useRef<HTMLDivElement>(null)
  const hasLabelRef = useRef(false)
  useEffect(() => {
    const el = hasLabelRef.current ? primaryControl(controlRef.current) : null
    if (!el || el.hasAttribute('aria-label')) return
    if (!el.id) el.id = `${labelId}-control`
    // A text box is the field itself; a picker button keeps its own text
    // after the label ("Zone, Select…" / "Zone, Zone 1").
    const want = el.tagName === 'BUTTON' ? `${labelId} ${el.id}` : labelId
    if (el.getAttribute('aria-labelledby') !== want) el.setAttribute('aria-labelledby', want)
  })
  // A locked field is locked for the keyboard too: the overlay below only
  // swallowed the mouse, so Tab + typing still edited a locked record, stored
  // a draft and lit "Save all". `inert` (set by hand — React 18 hosts do not
  // know the prop) takes the control out of focus and input; a caret already
  // inside is let go first, so presence stops reporting the field as edited.
  const inputLocked = locked && !isFileField
  const lockedBoxRef = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: autoFillTick remounts the box (its key)
  useEffect(() => {
    const el = lockedBoxRef.current
    if (!el) return
    if (!inputLocked) {
      el.removeAttribute('inert')
      return
    }
    const active = typeof document !== 'undefined' ? document.activeElement : null
    if (active instanceof HTMLElement && el.contains(active)) active.blur()
    el.setAttribute('inert', '')
  }, [inputLocked, autoFillTick])
  const fieldKey = field.field
  // Stable for the memoized FieldRenderer below (a fresh closure per render
  // made it re-render with every row).
  const commit = useCallback(
    (v: unknown) => {
      if (!locked) onChange(fieldKey, v)
    },
    [locked, onChange, fieldKey]
  )
  const rendererCountChange = useCallback(
    (count: number) => onCountChange?.(fieldKey, count),
    [onCountChange, fieldKey]
  )
  // Keep-if-same refs for values computed after the early return below.
  const cascadeFilterRef = useRef<Record<string, unknown> | undefined>(undefined)
  const narrowedByRef = useRef<
    | {
        sig: string
        onChange: typeof onChange
        value: { labels: string[]; keys: string[]; onClear?: (key: string) => void }
      }
    | undefined
  >(undefined)
  const readonlyFileFieldRef = useRef<{ src: CMSField; value: CMSField } | undefined>(undefined)
  const {
    onContextMenu: onFieldContextMenu,
    onKeyDown: onFieldMenuKeyDown,
    menu: fieldContextMenu
  } = useFieldContextMenu({
    wrapperRef,
    field,
    value: draft[field.field],
    relations,
    collection,
    itemId,
    openRelated: affordances?.openRelated,
    // Only a field the person can edit here may carry a personal default.
    editable:
      !locked &&
      !field.readonly &&
      !field.computed_formula &&
      !(field.hidden && !field.layout_assigned) &&
      !isDisplayFormulaRow(field)
  })
  const softLock = usePresenceSoftLock(wrapperRef)
  // #2703: labels and help that change with the record's state or the viewer's role.
  const textCtx = usePlacementTextContext()
  const remoteChange = affordances?.remoteChanges[field.field]
  const lockReason = affordances?.lockReasons[field.field]
  const applyToLines = affordances?.applyToLines[field.field]
  // Personal defaults (new records): pill + undo while the field holds its default, or a
  // quiet hint saying why the saved default was not applied.
  const personalDefaults = usePersonalDefaultsApi()
  const personalDefaultApplied = personalDefaults?.applied(field.field) ?? false
  const personalDefaultHint = personalDefaults?.hintFor(field.field) ?? null

  // AI button: the field's own setting (#2692), else the form-wide switch.
  const aiButton = showsAiButton(field._overrides, layoutAiEnabled, isAiEligible(field))
  const autofillCheck =
    !!affordances?.fromAutofill &&
    !!field._overrides &&
    (field._overrides as Record<string, unknown>)[AUTOFILL_CHECK_KEY] === true

  async function handleGenerate() {
    if (aiButton.perField) return handleFieldFill()
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

  // The layout's prompt runs on the server; only the values its {{tokens}} name go along.
  async function handleFieldFill() {
    const values: Record<string, unknown> = {}
    for (const t of readAiFill(field._overrides)?.tokens ?? []) if (t in draft) values[t] = draft[t]
    setIsGenerating(true)
    try {
      const res = await client.request<{ data: { value: string; missing?: string[] } }>(
        post('/ai/field-fill', {
          collection,
          layout_id: affordances?.layoutId ?? null,
          field: field.field,
          item_id: itemId && itemId !== 'new' ? itemId : null,
          values
        })
      )
      const v = res.data?.value
      if (typeof v === 'string' && v !== '') onChange(field.field, v)
      else toast.info('The AI had nothing to write here')
      if (res.data?.missing?.length)
        toast.info(`Filled without ${res.data.missing.join(', ')} (empty or not visible to you)`)
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } }; message?: string }
      toast.error(e?.response?.data?.error ?? e?.message ?? 'AI fill failed')
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
  const shownText = placementFieldText(field, textCtx)
  const label = shownText.label ?? titleCase(field.field)
  hasLabelRef.current = label !== ''
  // #2712: a display formula has no column — no history, watch, AI or input.
  const isCalc = isDisplayFormulaRow(field)
  const counter = isCalc ? null : fieldCounterConfig(field)
  const repeatLast =
    !isCalc &&
    !locked &&
    !field.readonly &&
    (field._overrides as { repeat_last?: unknown } | null | undefined)?.repeat_last === true
  // A rollup with a parent_filter is only derived for records that MATCH it
  // (a hand-entered total is typed in — no lines to sum). The lineage
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

  // Cascade filter computation — compiled by the SAME builder the quick
  // picker uses (helpers.buildCascadeFilter); this component only resolves
  // parent values (scalars off the draft, M2M parents from staging ±
  // committed junction rows) and labels.
  // Layout-effective parent labels — 'division' reads as 'Zone' when the
  // layout renames it; only trustworthy when the context describes THIS
  // collection (grid cells carry the parent record's labels instead).
  const parentFieldLabel = (f: string): string =>
    (parentDraftCtx?.collection === collection ? parentDraftCtx?.fieldLabels?.[f] : undefined) ??
    titleCase(String(f))
  const cascadeCompiled = buildCascadeFilter({
    rules: cascadeRules,
    // A parent whose value THIS field's own pick derived must not narrow this
    // field's options — otherwise picking a region locks the region picker
    // into the zone the pick itself filled, and cross-zone changes read as
    // "No results".
    skipParent: (p) => m2mStaging?.getDerivedOrigin?.(p) === field.field,
    parentValue: (p) => {
      if (draft[p] != null) return draft[p]
      const r = relations.find((r) => r.one_collection === collection && r.one_field === p)
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
      const committed = m2mParentCommitted[p] ?? []
      const all = [...new Set([...staged, ...committed].map((v) => String(v)))]
      if (all.length === 0) return null
      return all.length === 1 ? all[0] : all
    },
    parentOptionFilter: (p) => {
      const raw =
        parentDraftCtx?.collection === collection
          ? parentDraftCtx.fieldOptionFilters?.[p]
          : undefined
      return raw ? resolveOptionFilterTokens(raw, draft, itemId) : undefined
    }
  })
  // Same filter content keeps the same object (the memoized renderer and the
  // cascade controller compare by identity).
  const cascadeFilter = cascadeCompiled.filter
    ? keepIfEqual(cascadeFilterRef, cascadeCompiled.filter as Record<string, unknown>, jsonEqual)
    : cascadeCompiled.filter
  const cascadeParentLabels = cascadeCompiled.satisfiedParents.map(parentFieldLabel)
  const cascadeParentFieldKeys = cascadeCompiled.satisfiedParents
  const unsatisfiedParentLabel: string | null = cascadeCompiled.unsatisfiedParents.length
    ? parentFieldLabel(cascadeCompiled.unsatisfiedParents[0])
    : null
  // Required parents (show_all_if_no_parent false) that hold NO value right
  // now — a child that cannot be picked without them cannot keep a value
  // once the user empties one (Project cleared → Sub Type must go too).
  const missingRequiredParents = cascadeCompiled.missingRequiredParents
  const requiredParentLabel: string | null = missingRequiredParents.length
    ? parentFieldLabel(missingRequiredParents[0])
    : null

  // The renderer's derived props, kept the same object while unchanged.
  function readonlyFileField(): CMSField {
    const cur = readonlyFileFieldRef.current
    if (cur && cur.src === field) return cur.value
    const value = { ...field, readonly: true }
    readonlyFileFieldRef.current = { src: field, value }
    return value
  }
  function narrowedBy() {
    const sig = JSON.stringify([cascadeParentLabels, cascadeParentFieldKeys])
    const cur = narrowedByRef.current
    if (cur && cur.sig === sig && cur.onChange === onChange) return cur.value
    const value = {
      labels: cascadeParentLabels,
      keys: cascadeParentFieldKeys,
      onClear: (k: string) => onChange(k, null)
    }
    narrowedByRef.current = { sig, onChange, value }
    return value
  }

  function flashParentFields() {
    for (const key of cascadeParentFieldKeys) {
      const el = document.querySelector<HTMLElement>(`[data-field="${key}"]`)
      if (!el) continue
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.style.transition = 'box-shadow 0.15s ease'
      el.style.boxShadow =
        '0 0 0 2px rgb(var(--nvr-cyan-rgb, 0 206 255)), 0 0 0 5px rgb(var(--nvr-cyan-rgb, 0 206 255) / 0.25)'
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
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only hosts the field context menu (right-click / Shift+F10); the inputs inside stay the controls
    <div
      ref={wrapperRef}
      data-field={field.field}
      // Session replay masking (#1361): which collection the field belongs to
      // and what kind of value it holds — see lib/replay-masking.ts.
      data-field-collection={collection}
      data-field-interface={field.interface ?? undefined}
      data-autofill-check={autofillCheck ? '' : undefined}
      className={cn(
        'group/fieldrow space-y-1.5',
        autofillCheck &&
          'rounded-md bg-amber-50/60 p-1.5 ring-1 ring-amber-300 dark:bg-amber-500/10 dark:ring-amber-500/40'
      )}
      onContextMenu={onFieldContextMenu}
      onKeyDown={onFieldMenuKeyDown}
      onFocusCapture={softLock.onFocusCapture}
    >
      {fieldContextMenu}
      {cascadeRules.length > 0 && (
        <CascadeEffectController
          cascadeRules={cascadeRules}
          cascadeFilter={cascadeFilter}
          currentValue={cascadeCurrentValue}
          relatedCollection={cascadeRelatedCollection}
          missingRequiredParents={missingRequiredParents}
          onClear={handleCascadeClear}
        />
      )}
      {(label !== '' || addendumHints.length > 0) && (
        <div className='flex flex-wrap items-center gap-1.5 min-h-[1.5rem]'>
          {label !== '' && (
            <Label id={labelId} data-field-label className='text-sm font-medium'>
              <GlossaryLabel text={label} collection={collection} />
              {field.required && <span className='ml-0.5 text-destructive'>*</span>}
              {fieldIsRecommended(field) && <RecommendedMarker />}
            </Label>
          )}
          {shownText.note && (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className='h-3.5 w-3.5 shrink-0 cursor-help text-slate-400 hover:text-slate-600' />
                </TooltipTrigger>
                <TooltipContent side='top' className='max-w-[240px] text-[12px]'>
                  {affordances?.glossaryHelp === false ? (
                    shownText.note
                  ) : (
                    <GlossaryLabel text={shownText.note} collection={collection} />
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {!isCalc && itemId && itemId !== 'new' && (
            <FieldHistoryButton
              collection={collection}
              itemId={itemId}
              field={field.field}
              onRestore={field.readonly ? undefined : (v) => onChange(field.field, v)}
            />
          )}
          {!isCalc && itemId && itemId !== 'new' && (
            <FieldWatchButton collection={collection} itemId={itemId} field={field.field} />
          )}
          {itemId && itemId !== 'new' && isActuallyComputed && (
            <FieldLineageButton collection={collection} itemId={itemId} field={field.field} />
          )}
          {repeatLast && (
            <RepeatLastButton
              collection={collection}
              itemId={itemId}
              field={field.field}
              label={label || titleCase(field.field)}
              onFill={(v) => onChange(field.field, v)}
            />
          )}
          {!isCalc && aiButton.show && !(aiButton.perField && (locked || field.readonly)) && (
            <button
              type='button'
              onClick={handleGenerate}
              disabled={isGenerating}
              data-ai-fill={aiButton.perField ? field.field : undefined}
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
          {autofillCheck && (
            <span
              data-tip='People often change what the AI read from the document here — check it'
              className='inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium text-amber-800 bg-amber-100 dark:bg-amber-500/15 dark:text-amber-200'
            >
              Check this
            </span>
          )}
          {personalDefaultApplied && (
            <PersonalDefaultPill
              field={field.field}
              label={label}
              onUndo={() => personalDefaults?.undo(field.field)}
            />
          )}
          {swapButton}
          {applyToLines && !locked && !field.readonly && (
            <button
              type='button'
              onClick={() => applyToLines.onApply(draft[field.field] ?? null)}
              disabled={
                draft[field.field] == null || draft[field.field] === '' || applyToLines.count === 0
              }
              data-apply-to-lines={field.field}
              data-tip={
                applyToLines.count === 0
                  ? 'No lines yet — add lines first'
                  : draft[field.field] == null || draft[field.field] === ''
                    ? 'Pick a value first'
                    : applyToLines.count != null
                      ? `Copy this value onto all ${applyToLines.count} lines (staged until you save)`
                      : 'Copy this value onto every line (staged until you save)'
              }
              className='inline-flex items-center gap-1 rounded border border-nvr-cyan/40 px-1.5 py-0.5 text-[10.5px] font-medium text-[#0e7490] transition-colors hover:bg-nvr-cyan/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-nvr-cyan'
            >
              {applyToLines.label ?? 'Apply to lines'} ↓
            </button>
          )}
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
          <FormHelpVideoButton
            collection={collection}
            kind='field'
            name={field.field}
            label={label}
          />
          {(locked || field.readonly) && lockReason ? (
            <LockReasonBadge reason={lockReason} onHover={affordances?.onLockHover} />
          ) : locked ? (
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
          ) : null}
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
                        aria-label={`Show the fields that narrow ${label || 'this list'}`}
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
      {softLock.editor && !locked && (
        <PresenceSoftLockStrip
          editor={softLock.editor}
          confirming={softLock.confirming}
          onConfirm={softLock.confirm}
          onCancel={softLock.cancel}
        />
      )}
      {swapContent ?? (
        <div
          ref={controlRef}
          className={cn(locked && !isFileField && 'cursor-not-allowed')}
          data-tip={(locked || field.readonly) && lockReason ? lockReason : undefined}
          onPointerEnter={
            (locked || field.readonly) && lockReason ? affordances?.onLockHover : undefined
          }
        >
          <div
            key={autoFillTick ?? 0}
            ref={lockedBoxRef}
            className={cn(
              // A locked FILE field stays interactive: its chips keep the
              // download link and preview click (the component itself hides
              // upload/replace/remove when readonly) — blocking pointer events
              // made attachments unopenable on every locked form (addendum
              // view, terminal states).
              locked && !isFileField && 'pointer-events-none opacity-60',
              // The ring lands with a 2px shake so the eye finds the field;
              // the animation runs once when the class is added.
              error && 'nvr-shake ring-1 ring-red-400 rounded-md',
              autoFillTick && 'nvr-autofill-glow'
            )}
          >
            {isCalc ? (
              <DisplayFormulaValue field={field} values={draft} />
            ) : autoIdPattern ? (
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
                onChange: commit,
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
                field={locked && isFileField ? readonlyFileField() : field}
                value={value}
                onChange={commit}
                relations={relations}
                collection={collection}
                itemId={itemId}
                cascadeFilter={cascadeFilter}
                requiredParentLabel={requiredParentLabel}
                narrowedBy={cascadeParentLabels.length > 0 ? narrowedBy() : undefined}
                onCountChange={onCountChange ? rendererCountChange : undefined}
              />
            )}
          </div>
        </div>
      )}
      {counter && <FieldCounter value={draft[field.field]} config={counter} />}
      {personalDefaultHint && !personalDefaultApplied && (
        <PersonalDefaultHint field={field.field} text={personalDefaultHint} />
      )}
      {remoteChange && (
        <RemoteChangeGhost
          change={remoteChange}
          onDismiss={() => affordances?.dismissRemoteChange(field.field)}
          onTakeTheirs={
            affordances?.takeRemoteChange
              ? () => affordances.takeRemoteChange?.(field.field)
              : undefined
          }
        />
      )}
    </div>
  )
})

// ─── re-export getColSpanClass for GroupSection usage ─────────────────────────
export { getColSpanClass }
