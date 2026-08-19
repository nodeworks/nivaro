import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, BellOff, ChevronDown, ChevronsLeft, ChevronsRight, Pin, Rows2, Rows3, RotateCw, Search, Sparkles, X } from 'lucide-react'
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import {
  type DrilldownTarget,
  useItemEditAuth,
  useItemNavigation,
  useNivaroClient,
  useOverlayState
} from '../context'
import { useDebounced } from '../hooks/useDebounced'
import { del, get, patch, post } from '../lib/commands'
import { effectiveScopeSeedIds, matchScopeDimension, translateScopeValues, useMyScopes } from '../lib/use-my-scopes'
import { type ColumnFormatConfig, formatMultiValue, formatValue } from '../lib/format-value'
import { rowHighlightClass } from '../lib/row-highlight'
import { cn } from '../lib/utils'
import { useNewItemLayouts } from '../lib/use-new-item-layouts'
import { RowHighlightLegend } from './RowHighlightLegend'
import { HScrollProxy } from './HScrollProxy'
import { UserChip, UserRosterCluster } from './item-edit/GroupSection'
import { RevisionsPanel } from './panels'
import { RecordDrilldownSheet } from './RecordDrilldownSheet'
import { SimpleSelect, SimpleSelectXs } from './ui/SimpleSelect'
import { CellCopyLayer } from './CellCopyLayer'
import { TipLayer } from './TipLayer'

/**
 * CollectionBrowserView — the admin `/collections/:collection` browser as an
 * embeddable component (counterpart to ItemEditForm / QueueWorklist).
 *
 * Mirrors the admin page's look and operation: field-config columns with
 * M2O display-template labels, the three-stage filter dropdown (field →
 * operator → value, relation drill-down to depth 3), server `search` +
 * `conditions` dialect, saved views, column picker, row selection with the
 * bulk bar (delete / update field / pipeline transition), pipeline state
 * badges, total-count pagination, and CSV export.
 *
 * Deliberately skipped from admin: grid/tree/calendar/gantt view modes,
 * hierarchy scoping, AI query, at-risk/SLA columns, presets, merge,
 * picker-exclusions, imports, extension bulk actions.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface CMSField {
  field: string
  type: string | null
  interface?: string | null
  hidden: boolean
  computed_formula?: string | null
  computed_store?: boolean
}
export interface CollectionBrowserConfig {
  /** Row selection checkboxes + bulk bar (default true). */
  checkbox_selection?: boolean
  /** Per-row Actions menu column (default true). */
  show_actions?: boolean
  /** "+ New item" button (default true; the host's showCreate prop also gates it). */
  allow_create?: boolean
  /** Server page size (default 25, capped 200). */
  page_size?: number
  /** Quick-filter facet bar — same shape as the quickFilters prop; the prop
   *  wins when both are set. */
  quick_filters?: QuickFilterDef[]
}

interface CMSRelation {
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field?: string | null
  junction_field: string | null
}

/** Relation behind an alias field on `collection` (O2M child set or M2M via
 *  junction). Returns the relation whose one-side alias is this field. */
function aliasRelationFor(
  relations: CMSRelation[],
  collection: string,
  field: string
): { kind: 'o2m' | 'm2m'; relation: CMSRelation } | undefined {
  const rel = relations.find((r) => r.one_collection === collection && r.one_field === field)
  if (!rel?.many_collection) return undefined
  return { kind: rel.junction_field ? 'm2m' : 'o2m', relation: rel }
}

/** Best label column for a collection: first {{token}} of its display
 *  template that is a real field, else the first LABEL_FALLBACK field, else id. */
function labelFieldFor(meta: CollectionMeta | undefined): string {
  if (!meta) return 'id'
  const fieldSet = new Set(meta.fields.map((f) => f.field))
  const tokens = [...(meta.display_template ?? '').matchAll(/\{\{(\w+)/g)].map((m) => m[1])
  for (const t of tokens) if (fieldSet.has(t)) return t
  for (const f of LABEL_FALLBACK_FIELDS) if (fieldSet.has(f)) return f
  return 'id'
}
interface CollectionMeta {
  browser_config?: CollectionBrowserConfig | null
  collection: string
  display_name: string | null
  display_template: string | null
  singleton?: boolean
  fields: CMSField[]
  relations: CMSRelation[]
}
interface PipelineInstancesMap {
  binding: { template: string } | null
  instances: Record<string, { state_key?: string; state_label?: string; state_color?: string }>
}

export interface ActiveFilter {
  id: string
  path: string[]
  pathLabels: string[]
  fieldType: string
  op: string
  value: string | Array<string | number>
  /** Display labels for relation (_in) selections. */
  valueLabels?: string[]
  /** Target collection of a relation filter — lets chip-editing reopen the
   *  record checklist. */
  relTarget?: string
}

type SavedViewColumn =
  | string
  | { key: string; label?: string; format?: ColumnFormatConfig; pin?: 'left' | 'right' }

interface SavedView {
  id: number
  name: string
  user: string
  is_shared: boolean
  is_default?: boolean
  filters: ActiveFilter[] | null
  sort: string | null
  columns: SavedViewColumn[] | null
}

const viewColumnKey = (c: SavedViewColumn) => (typeof c === 'string' ? c : c.key)

const FORMAT_PRESETS: Array<{ label: string; cfg: ColumnFormatConfig | null }> = [
  { label: 'None', cfg: null },
  { label: 'Currency', cfg: { type: 'number', decimals: 2, thousands: true, prefix: '$' } },
  { label: 'Number', cfg: { type: 'number', thousands: true } },
  { label: 'Number (2dp)', cfg: { type: 'number', decimals: 2, thousands: true } },
  { label: 'Date', cfg: { type: 'datetime', template: 'MM/DD/YYYY' } },
  { label: 'Date + time', cfg: { type: 'datetime', template: 'MM/DD/YYYY hh:mm A' } },
  { label: 'Relative time', cfg: { type: 'datetime', template: 'relative' } },
  { label: 'Yes / No', cfg: { type: 'boolean', true_label: 'Yes', false_label: 'No' } }
]

export interface QuickFilterDef {
  /** Unique key for this filter's selection state. */
  key: string
  label: string
  /** Server condition path — supports M2O chains and O2M/M2M alias hops
   *  (e.g. ['funding_years'], ['project', 'project_type']). */
  path: string[]
  /** When set, the selection matches if ANY of these paths hits (server _or
   *  group) — e.g. project.project_type OR car_project_type. Overrides path. */
  or_paths?: string[][]
  /** Collection the options list loads from. */
  collection: string
  /** Option value column (default 'id'). */
  value_field?: string
  /** Option label column. */
  label_field: string
  sort?: string
}

export interface CollectionBrowserViewProps {
  collection: string
  /** Persistent facet dropdowns above the table (multi-select + Apply/Clear);
   *  selections filter server-side over the entire record set. */
  quickFilters?: QuickFilterDef[]
  /** Initial visible columns (plain field keys). Defaults to the first 7
   *  non-hidden fields. */
  initialColumns?: string[]
  /** Default sort until a header is clicked (e.g. '-created'). */
  initialSort?: string
  pageSize?: number
  /** Initial quick-search value (deep links). */
  initialSearch?: string
  /** Contextual deep-link conditions (e.g. a dashboard tile linking to "my
   *  drafts"): ANDed into every fetch until the user clears the context chip.
   *  `label` is what the chip displays for that condition. */
  initialConditions?: Array<{ path: string[]; op: string; value: unknown; label?: string }>
  /** Override row-open behavior; defaults to NavigationContext itemUrl. */
  onOpenItem?: (id: string | number) => void
  showCreate?: boolean
  className?: string
}

// ─── Helpers (ports of admin lib/relations + lib/utils) ───────────────────────

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

const LABEL_FALLBACK_FIELDS = ['name', 'title', 'label', 'display_name', 'subject', 'email', 'slug']

/** Narrow an option-list fetch to the columns the label actually needs.
 *  A relation filter only ever renders `id` + a label, but an unscoped
 *  `/items` read returns every column — 269KB for 500 vendors, measured.
 *  Dotted template tokens would need nested expansion (and 500 on a stale
 *  path), so those fall back to the full row rather than risk the request. */
function optionFieldsFor(template: string | null, labelField: string): string | null {
  if (!template) return ['id', labelField, ...LABEL_FALLBACK_FIELDS].join(',')
  const tokens = [...template.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1])
  if (tokens.some((t) => t.includes('.'))) return null
  return [...new Set(['id', labelField, ...tokens])].join(',')
}

function renderDisplayTemplate(template: string | null, item: Record<string, unknown>): string {
  if (!template) {
    for (const f of LABEL_FALLBACK_FIELDS) {
      const v = item[f]
      if (v != null && v !== '') return String(v)
    }
    return String(item.id ?? '')
  }
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, path: string) => {
    const v = path
      .split('.')
      .reduce<unknown>((acc, k) => (acc as Record<string, unknown> | null)?.[k], item)
    return v == null ? '' : String(v)
  })
}

function findM2ORelation(
  relations: CMSRelation[],
  collection: string,
  field: string
): CMSRelation | undefined {
  return relations.find(
    (r) =>
      r.many_collection === collection &&
      r.many_field === field &&
      r.junction_field === null &&
      r.one_collection !== null
  )
}

function formatRelative(value: unknown): string {
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return String(value)
  const diff = Date.now() - d.getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const fmtNum = (n: number) => n.toLocaleString('en-US')



const USER_SYSTEM_COLS = new Set(['nivaro_users', 'directus_users'])
const isSystemCol = (c: string) => c.startsWith('directus_') || c.startsWith('nivaro_')

// ─── RelationLabel (admin components/relation-label.tsx port) ─────────────────

/** Coalesces the per-cell relation lookups a table page fires into one request
 *  per collection. Every M2O cell wants a different id, so each rendered its
 *  own `/items/<col>/<id>` — 25 rows of vendors meant 25 requests competing for
 *  the browser's 6 connections. Callers still key their query per id (so the
 *  cache stays per-record and survives paging); only the transport is shared. */
const relBatches = new Map<
  string,
  { ids: Set<string>; waiters: Array<() => void>; promise: Promise<Map<string, Record<string, unknown>>> | null }
>()

function fetchRelationRow(
  client: ReturnType<typeof useNivaroClient>,
  collection: string,
  id: string
): Promise<Record<string, unknown> | null> {
  let batch = relBatches.get(collection)
  if (!batch) {
    batch = { ids: new Set(), waiters: [], promise: null }
    relBatches.set(collection, batch)
  }
  const current = batch
  current.ids.add(id)
  if (!current.promise) {
    current.promise = new Promise((resolve) => {
      // One tick of collection: every cell in the committed render lands here
      // before the request goes out.
      setTimeout(() => {
        relBatches.delete(collection)
        const ids = [...current.ids]
        // Chunked so a wide page can't blow past the bound-parameter ceiling.
        const chunks: string[][] = []
        for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200))
        Promise.all(
          chunks.map((chunk) =>
            client
              .request<{ data: Array<Record<string, unknown>> }>(
                get(`/items/${collection}`, {
                  filter: JSON.stringify({ id: { _in: chunk } }),
                  limit: chunk.length,
                  fields: '*'
                })
              )
              .then((r) => r.data ?? [])
              .catch(() => [])
          )
        ).then((results) => {
          const map = new Map<string, Record<string, unknown>>()
          for (const row of results.flat()) map.set(String(row.id), row)
          resolve(map)
        })
      }, 0)
    })
  }
  return current.promise.then((map) => map.get(id) ?? null)
}

function RelationLabel({ relatedCollection, id }: { relatedCollection: string; id: unknown }) {
  const client = useNivaroClient()
  const userCol = USER_SYSTEM_COLS.has(relatedCollection)
  const hasId = id != null && id !== ''

  const { data: meta } = useQuery({
    queryKey: ['cbv-collection-meta', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: CollectionMeta }>(get(`/collections/${relatedCollection}`))
        .then((r) => r.data),
    staleTime: 10 * 60_000,
    enabled: !isSystemCol(relatedCollection),
    retry: false
  })

  const { data: item, isLoading } = useQuery({
    queryKey: ['cbv-relation-item', relatedCollection, String(id)],
    queryFn: () =>
      userCol
        ? client
            .request<{ data: Record<string, unknown> }>(get(`/users/${id}`))
            .then((r) => r.data)
        : fetchRelationRow(client, relatedCollection, String(id)),
    enabled: hasId && (userCol || !isSystemCol(relatedCollection)),
    staleTime: 30 * 60_000,
    retry: false
  })

  if (!hasId) return <span className='text-[12px] text-slate-300'>—</span>
  if (isLoading)
    return <span className='inline-block h-3.5 w-24 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
  if (!item) return <span className='font-mono text-[12px] text-slate-400'>{String(id)}</span>
  const label = userCol
    ? String(
        [item.first_name, item.last_name].filter(Boolean).join(' ') || item.email || item.id || ''
      )
    : renderDisplayTemplate(meta?.display_template ?? null, item)
  return <span className='text-[12px] text-slate-700 dark:text-slate-200'>{label}</span>
}

// ─── Cell renderer (admin CellValue port, same precedence) ────────────────────

/** Per-row Actions menu — labeled trigger (people know what "Actions" means),
 *  portal menu clamped to the viewport, with live pipeline transitions
 *  fetched lazily when opened. */
export function RowActionsMenu({
  collection,
  id,
  hasPipeline,
  onOpen,
  onPeek,
  onAudit,
  urlFor,
  onDeleted,
  onAfterTransition
}: {
  collection: string
  id: string | number
  hasPipeline: boolean
  onOpen: () => void
  /** Optional — item hidden when absent (hosts without a peek sheet). */
  onPeek?: () => void
  /** Optional — item hidden when absent (hosts without an audit surface). */
  onAudit?: () => void
  urlFor: (t: { collection: string; itemId: string }) => string
  onDeleted: () => void
  /** Extra refresh after a transition lands (CBV query invalidations always run). */
  onAfterTransition?: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!panelRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  type RowTransition = {
    id: string
    label: string
    color?: string | null
    group_label?: string | null
    to_state?: string | null
  }
  type RowState = { id: string; label: string; color?: string | null }
  const { data: instance } = useQuery<{
    available_transitions?: RowTransition[]
    states?: RowState[]
  } | null>({
    queryKey: ['cbv-row-instance', collection, String(id)],
    queryFn: () =>
      client
        .request<{
          data: { available_transitions?: RowTransition[]; states?: RowState[] } | null
        }>(get(`/pipelines/instance/${collection}/${id}`))
        .then((r) => r.data)
        .catch(() => null),
    enabled: open && hasPipeline,
    staleTime: 15_000
  })
  const transitions = instance?.available_transitions ?? []
  const stateById = useMemo(
    () => new Map((instance?.states ?? []).map((st) => [st.id, st])),
    [instance]
  )
  // Group by group_label, falling back to the transition LABEL — templates
  // often model multi-target routes as several transitions named "Send Back"
  // (PipelinePanel semantics). Options display their TARGET state.
  const stateOrder = useMemo(() => {
    const m = new Map<string, number>()
    ;(instance?.states ?? []).forEach((st, i) => m.set(st.id, i))
    return m
  }, [instance])
  const transitionEntries = useMemo(() => {
    const groups = new Map<string, RowTransition[]>()
    const out: Array<{ key: string; label: string; options: RowTransition[] }> = []
    for (const t of transitions) {
      const g = (t.group_label?.trim() || t.label).trim()
      if (groups.has(g)) {
        groups.get(g)!.push(t)
      } else {
        const list: RowTransition[] = [t]
        groups.set(g, list)
        out.push({ key: `g:${g}`, label: g, options: list })
      }
    }
    // Multi-target groups list options in PIPELINE ORDER (the states' own
    // sort), not the arbitrary transition-row order.
    for (const e of out) {
      if (e.options.length > 1)
        e.options.sort(
          (a, b) =>
            (stateOrder.get(a.to_state ?? '') ?? 999) - (stateOrder.get(b.to_state ?? '') ?? 999)
        )
    }
    return out
  }, [transitions, stateOrder])
  const optionLabel = (t: RowTransition) => {
    const target = t.to_state ? stateById.get(t.to_state) : null
    return target?.label ?? t.label
  }
  const optionColor = (t: RowTransition) => {
    const target = t.to_state ? stateById.get(t.to_state) : null
    return target?.color ?? t.color ?? '#94a3b8'
  }
  const [confirm, setConfirm] = useState<{ label: string; options: RowTransition[]; picked: string | null } | null>(null)
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (!open) {
      setConfirm(null)
      setReason('')
    }
  }, [open])
  // Clamp to viewport — re-runs when the panel grows (transitions load in,
  // the confirm view swaps in with options + textarea).
  // biome-ignore lint/correctness/useExhaustiveDependencies: content growth triggers
  React.useLayoutEffect(() => {
    if (!open) return
    const el = panelRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let { x, y } = pos
    if (r.right > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8)
    if (r.bottom > window.innerHeight - 8) {
      const a = btnRef.current?.getBoundingClientRect()
      const above = (a?.top ?? y) - r.height - 4
      // Above the trigger when it fits, else pinned to the viewport bottom.
      y = above >= 8 ? above : Math.max(8, window.innerHeight - r.height - 8)
    }
    if (x !== pos.x || y !== pos.y) setPos({ x, y })
  }, [open, pos, confirm, transitions.length])

  const transitionMut = useMutation({
    mutationFn: ({ transitionId, comment }: { transitionId: string; comment?: string }) =>
      client.request(
        post(`/pipelines/instance/${collection}/${id}/transition`, {
          transition_id: transitionId,
          ...(comment?.trim() ? { comment: comment.trim() } : {})
        })
      ),
    onSuccess: () => {
      setOpen(false)
      toast.success('Transitioned')
      void qc.invalidateQueries({ queryKey: ['cbv-items', collection] })
      void qc.invalidateQueries({ queryKey: ['cbv-pipeline-instances', collection] })
      void qc.invalidateQueries({ queryKey: ['cbv-owners', collection] })
      void qc.invalidateQueries({ queryKey: ['cbv-row-instance', collection, String(id)] })
      onAfterTransition?.()
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Transition failed')
  })

  const item = (label: string, onClick: () => void, danger = false) => (
    <button
      type='button'
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-[12px] ${
        danger
          ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-950'
          : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
      }`}
    >
      {label}
    </button>
  )
  const divider = <div className='my-1 border-t border-slate-100 dark:border-slate-800' />

  return (
    <>
      <button
        ref={btnRef}
        type='button'
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect()
          if (r) setPos({ x: r.right - 176, y: r.bottom + 4 })
          setOpen((o) => !o)
        }}
        aria-label={`Actions for ${id}`}
        className='inline-flex h-6 items-center gap-1 rounded border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:text-slate-100'
      >
        Actions
        <ChevronDown aria-hidden className='h-3 w-3 text-slate-400' />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 60 }}
            className={`${confirm ? 'w-64' : 'w-44'} rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900`}
          >
            {confirm ? (
              <div className='px-2 pb-2'>
                <button
                  type='button'
                  onClick={() => setConfirm(null)}
                  className='mb-1 flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11.5px] font-medium text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'
                >
                  ‹ {confirm.label}
                </button>
                {confirm.options.length > 1 && (
                  <div className='mb-1.5 space-y-0.5'>
                    {confirm.options.map((t) => (
                      <button
                        key={t.id}
                        type='button'
                        onClick={() => setConfirm((c) => (c ? { ...c, picked: t.id } : c))}
                        className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[12px] ${
                          confirm.picked === t.id
                            ? 'border-[#00ceff66] bg-[#00ceff14] font-medium text-slate-800 dark:text-slate-100'
                            : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <span
                          aria-hidden
                          className='h-1.5 w-1.5 shrink-0 rounded-full'
                          style={{ backgroundColor: optionColor(t) }}
                        />
                        {optionLabel(t)}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder='Reason (optional)…'
                  rows={2}
                  className='w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12px] outline-none focus:border-[#00ceff80] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
                />
                <div className='mt-1.5 flex gap-1.5'>
                  <button
                    type='button'
                    disabled={!confirm.picked || transitionMut.isPending}
                    onClick={() => {
                      if (confirm.picked)
                        transitionMut.mutate({ transitionId: confirm.picked, comment: reason })
                    }}
                    className='h-7 flex-1 rounded-md bg-[#00ceff] text-[12px] font-semibold text-white disabled:opacity-40'
                  >
                    {transitionMut.isPending ? 'Applying…' : 'Confirm'}
                  </button>
                  <button
                    type='button'
                    onClick={() => setConfirm(null)}
                    className='h-7 rounded-md border border-slate-200 px-2.5 text-[12px] text-slate-500 dark:border-slate-700 dark:text-slate-400'
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
            {item('Open', () => {
              setOpen(false)
              onOpen()
            })}
            {item('Open in new tab', () => {
              setOpen(false)
              window.open(urlFor({ collection, itemId: String(id) }), '_blank')
            })}
            {onPeek &&
              item('Peek details', () => {
                setOpen(false)
                onPeek()
              })}
            {onAudit &&
              item('Audit log', () => {
                setOpen(false)
                onAudit()
              })}
            {hasPipeline && transitionEntries.length > 0 && (
              <>
                {divider}
                <p className='px-3 pb-0.5 pt-1 text-[9.5px] font-bold uppercase tracking-wider text-slate-400'>
                  Transitions
                </p>
                {transitionEntries.map((entry) => (
                  <button
                    key={entry.key}
                    type='button'
                    onClick={() =>
                      setConfirm({
                        label: entry.label,
                        options: entry.options,
                        picked: entry.options.length === 1 ? entry.options[0].id : null
                      })
                    }
                    className='flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
                  >
                    <span
                      aria-hidden
                      className='h-1.5 w-1.5 shrink-0 rounded-full'
                      style={{ backgroundColor: entry.options[0]?.color ?? '#94a3b8' }}
                    />
                    <span className='min-w-0 flex-1 truncate'>{entry.label}</span>
                    {entry.options.length > 1 && (
                      <span aria-hidden className='text-[10px] text-slate-400'>
                        ▸ {entry.options.length}
                      </span>
                    )}
                  </button>
                ))}
              </>
            )}
            {divider}
            {item('Copy ID', () => {
              setOpen(false)
              void navigator.clipboard?.writeText(String(id))
              toast.success('ID copied')
            })}
            {item('Copy link', () => {
              setOpen(false)
              void navigator.clipboard?.writeText(
                window.location.origin + urlFor({ collection, itemId: String(id) })
              )
              toast.success('Link copied')
            })}
            {divider}
            {item(
              'Delete',
              () => {
                setOpen(false)
                if (window.confirm(`Delete record ${id}? It moves to trash.`)) onDeleted()
              },
              true
            )}
              </>
            )}
          </div>,
          document.body
        )}
    </>
  )
}

/**
 * Mono is for machine values — identifiers, keys, tokens — not for prose.
 * Every string cell used to render in JetBrains Mono, which made a vendor name
 * or a status word ("good") read like terminal output. There is no semantic
 * type to test, so go by the field name: an id column earns mono, a name does
 * not.
 */
function isMachineValue(field: string): boolean {
  return field === 'id' || /(^|_)id$/i.test(field) || /(^|_)uuid$/i.test(field)
}

function CellValue({
  collection,
  field,
  fieldType,
  value,
  relations
}: {
  collection: string
  field: string
  fieldType: string | null
  value: unknown
  relations: CMSRelation[]
}) {
  const rel = findM2ORelation(relations, collection, field)
  if (rel?.one_collection) return <RelationLabel relatedCollection={rel.one_collection} id={value} />
  if (value == null) return <span className='text-[12px] text-slate-300'>—</span>
  if (fieldType === 'boolean') {
    return (
      <span
        className={`inline-flex h-4 items-center rounded-full px-1.5 text-[10px] font-medium ${
          value
            ? 'bg-emerald-100 text-emerald-700'
            : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
        }`}
      >
        {value ? 'Yes' : 'No'}
      </span>
    )
  }
  if (fieldType === 'timestamp' || fieldType === 'datetime' || fieldType === 'date') {
    // A date-only value (bare yyyy-mm-dd, or the UTC-midnight ISO form MSSQL
    // `date` columns serialize to) must render its stored calendar day —
    // local conversion of UTC midnight shifts it a day back.
    const dm = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/)
    if (dm) {
      const label = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])).toLocaleDateString(
        'en-US',
        { month: 'short', day: 'numeric', year: 'numeric' }
      )
      return <span className='text-[12px] tabular-nums text-slate-400'>{label}</span>
    }
    // Rendered as human text ("2 days ago", "08/05/2026"), so it reads as prose;
    // tabular figures keep the column's digits aligned.
    return (
      <span className='text-[12px] tabular-nums text-slate-400'>{formatRelative(value)}</span>
    )
  }
  if (typeof value === 'string') {
    // Long text (names, descriptions) ellipses at a sane width — the full
    // value rides the hover tooltip instead of stretching the column.
    return (
      <span
        className={cn(
          'block max-w-[240px] truncate text-[12px] text-slate-700 dark:text-slate-200',
          isMachineValue(field) && 'font-mono',
          // An id cell opens the record. Underline it so that is legible
          // before you click rather than after.
          isMachineValue(field) &&
            'underline decoration-slate-300 decoration-dotted underline-offset-2 group-hover:decoration-nvr-cyan dark:decoration-slate-600'
        )}
        data-tip={value.length > 28 ? value : undefined}
      >
        {value}
      </span>
    )
  }
  if (typeof value === 'object') {
    // Genuinely machine output — the one place mono is the right answer.
    return (
      <span className='font-mono text-[12px] text-slate-400'>{JSON.stringify(value).slice(0, 40)}</span>
    )
  }
  return (
    <span
      className={cn(
        'text-[12px] tabular-nums text-slate-700 dark:text-slate-200',
        isMachineValue(field) && 'font-mono'
      )}
    >
      {String(value)}
    </span>
  )
}

// ─── Multi-select + column-filter primitives ─────────────────────────────────

function MultiPick({
  label,
  options,
  selected,
  onChange,
  loading,
  block,
  onOpenChange,
  badge
}: {
  label: string
  options: Array<{ value: string | number; label: string }>
  selected: Array<string | number>
  onChange: (vals: Array<string | number>) => void
  loading?: boolean
  /** Full-width trigger (column filter rows). */
  block?: boolean
  /** Fires when the dropdown opens — lets the parent defer its option fetch
   *  until the control is actually used. A collection browser renders one
   *  filter per relation column, and eagerly fetching every option list put
   *  ~13 requests on the critical path that nobody had asked for yet. */
  onOpenChange?: (open: boolean) => void
  /** User-scope marker: 'default' (selection seeded from the user's default
   *  scopes) or 'restricted' (options narrowed to their restricted values). */
  badge?: { label: string; cls: string; title: string } | null
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    onOpenChange?.(open)
    // onOpenChange is a parent setter — re-running on identity churn would
    // fire an extra notification per render with no state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options
  const selSet = new Set(selected.map(String))
  const firstLabel = options.find((o) => String(o.value) === String(selected[0]))?.label ?? String(selected[0] ?? '')
  const summary =
    selected.length === 0 ? label : selected.length === 1 ? firstLabel : `${firstLabel} +${selected.length - 1}`
  return (
    <div ref={ref} className={block ? 'relative w-full' : 'relative'}>
      <button
        type='button'
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        title={label}
        className={`inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[11px] font-normal normal-case tracking-normal ${
          block ? 'w-full min-w-[64px]' : 'max-w-[150px]'
        } ${
          selected.length
            ? 'border-[#00ceff66] bg-[#00ceff14] text-slate-800 dark:text-slate-100'
            : 'border-slate-200 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'
        }`}
      >
        {badge && (
          <span
            title={badge.title}
            className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${badge.cls}`}
          >
            {badge.label}
          </span>
        )}
        <span className='min-w-0 flex-1 truncate text-left'>{summary}</span>
        {selected.length > 0 && (
          <span
            role='button'
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              onChange([])
            }}
            aria-label={`Clear ${label}`}
            className='text-slate-400 hover:text-slate-600'
          >
            ✕
          </span>
        )}
        <ChevronDown aria-hidden className='h-3 w-3 shrink-0 text-slate-400' />
      </button>
      {open && (
        <div className='absolute left-0 top-full z-50 mt-1 flex max-h-72 w-52 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white text-left shadow-lg dark:border-slate-700 dark:bg-slate-900'>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder='Search…'
            className='m-1.5 h-6 shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 text-[11px] font-normal normal-case outline-none focus:border-[#00ceff80] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
          />
          <div className='min-h-0 flex-1 overflow-y-auto p-1'>
            {loading ? (
              <p className='px-2 py-1 text-[11px] text-slate-400'>Loading…</p>
            ) : shown.length === 0 ? (
              <p className='px-2 py-1 text-[11px] text-slate-400'>No options</p>
            ) : (
              shown.slice(0, 300).map((o) => (
                <label
                  key={String(o.value)}
                  className='flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-[11.5px] font-normal normal-case tracking-normal text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
                >
                  <input
                    type='checkbox'
                    checked={selSet.has(String(o.value))}
                    onChange={() =>
                      onChange(
                        selSet.has(String(o.value))
                          ? selected.filter((v) => String(v) !== String(o.value))
                          : [...selected, o.value]
                      )
                    }
                  />
                  <span className='truncate'>{o.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Options for a relation-target dropdown: id + rendered display label. */
function RelationColFilter({
  target,
  label,
  selected,
  onChange
}: {
  target: string
  label?: string
  selected: Array<string | number>
  onChange: (vals: Array<string | number>) => void
}) {
  const client = useNivaroClient()
  // Nothing here is needed until the dropdown opens — except when a value is
  // already selected, since MultiPick renders the raw id without its label.
  const [armed, setArmed] = useState(false)
  const active = armed || selected.length > 0
  const { data: meta } = useQuery({
    queryKey: ['cbv-collection-meta', target],
    queryFn: () =>
      client.request<{ data: CollectionMeta }>(get(`/collections/${target}`)).then((r) => r.data),
    staleTime: 10 * 60_000,
    enabled: active,
    retry: false
  })
  const labelField = labelFieldFor(meta)
  const template = meta?.display_template ?? null
  const { data: options = [], isLoading } = useQuery({
    queryKey: ['cbv-filter-options', target, labelField, template ?? ''],
    queryFn: () => {
      const fields = optionFieldsFor(template, labelField)
      return client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${target}`, { limit: 500, sort: labelField, ...(fields ? { fields } : {}) })
        )
        .then((r) =>
          (r.data ?? [])
            .map((row) => ({
              value: row.id as string | number,
              label:
                (template ? renderDisplayTemplate(template, row) : '') ||
                String(row[labelField] ?? row.id ?? '')
            }))
            .filter((o) => o.value != null && o.label !== '')
        )
    },
    staleTime: 10 * 60_000,
    enabled: active && !!meta,
    retry: false
  })
  // Selected ids missing from the alphabetical options page would render as
  // raw internal ids — fetch their labels explicitly and merge them in.
  const missing = selected.filter((v) => !options.some((o) => String(o.value) === String(v)))
  const missingKey = missing.map(String).join(',')
  const { data: selectedOpts = [] } = useQuery({
    queryKey: ['cbv-filter-selected-labels', target, labelField, template ?? '', missingKey],
    queryFn: () => {
      const fields = optionFieldsFor(template, labelField)
      return client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${target}`, {
            limit: missing.length,
            filter: JSON.stringify({ id: { _in: missing } }),
            ...(fields ? { fields } : {})
          })
        )
        .then((r) =>
          (r.data ?? []).map((row) => ({
            value: row.id as string | number,
            label:
              (template ? renderDisplayTemplate(template, row) : '') ||
              String(row[labelField] ?? row.id ?? '')
          }))
        )
    },
    enabled: active && !!meta && !isLoading && missing.length > 0,
    staleTime: 10 * 60_000,
    retry: false
  })
  const mergedOptions =
    selectedOpts.length > 0
      ? [...options, ...selectedOpts.filter((o) => !options.some((x) => String(x.value) === String(o.value)))]
      : options
  return (
    <MultiPick
      block
      label={label ?? 'All'}
      options={mergedOptions}
      selected={selected}
      onChange={onChange}
      loading={isLoading}
      onOpenChange={(o) => {
        if (o) setArmed(true)
      }}
    />
  )
}

/** Distinct-values dropdown for enum-ish plain columns. */
function EnumColFilter({
  collection,
  field,
  selected,
  onChange
}: {
  collection: string
  field: string
  selected: Array<string | number>
  onChange: (vals: Array<string | number>) => void
}) {
  const client = useNivaroClient()
  // Distinct values label themselves (titleCase of the raw value), so unlike
  // the relation filter this can stay deferred even with a selection.
  const [armed, setArmed] = useState(false)
  const { data: values = [], isLoading } = useQuery({
    queryKey: ['cbv-distinct', collection, field],
    queryFn: () =>
      client
        .request<{ data: unknown[] }>(get(`/items/${collection}/distinct`, { field }))
        .then((r) => r.data ?? []),
    staleTime: 5 * 60_000,
    enabled: armed,
    retry: false
  })
  return (
    <MultiPick
      block
      label='All'
      options={values.map((v) => ({ value: String(v), label: titleCase(String(v)) }))}
      selected={selected}
      onChange={onChange}
      loading={isLoading}
      onOpenChange={(o) => {
        if (o) setArmed(true)
      }}
    />
  )
}

/** Date column filter: combobox-style dropdown — presets, a single day, or a
 *  custom range. Stored as a preset key or 'r:<from>..<to>'. */
function DateColFilter({
  value,
  onChange
}: {
  value: string
  onChange: (v: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  useEffect(() => {
    if (open && value.startsWith('r:')) {
      const [a, b] = value.slice(2).split('..')
      setFrom(a ?? '')
      setTo(b ?? '')
    }
  }, [open, value])
  const fmtD = (d: string) => {
    const [y, m, dd] = d.split('-')
    return y && m && dd ? `${m}/${dd}/${y.slice(2)}` : d
  }
  const summary = (() => {
    if (!value) return 'All'
    if (value.startsWith('r:')) {
      const [a, b] = value.slice(2).split('..')
      return a === b ? fmtD(a) : `${fmtD(a)}–${fmtD(b)}`
    }
    return DATE_PRESETS.find((d) => d.value === value)?.label ?? value
  })()
  const applyRange = () => {
    const a = from || to
    const b = to || from
    if (!a) return
    onChange(`r:${a}..${b}`)
    setOpen(false)
  }
  return (
    <div ref={ref} className='relative w-full'>
      <button
        type='button'
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className={`inline-flex h-6 w-full min-w-[64px] items-center gap-1 rounded border px-1.5 text-[11px] font-normal normal-case tracking-normal ${
          value
            ? 'border-[#00ceff66] bg-[#00ceff14] text-slate-800 dark:text-slate-100'
            : 'border-slate-200 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'
        }`}
      >
        <span className='min-w-0 flex-1 truncate text-left'>{summary}</span>
        {value && (
          <span
            role='button'
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              onChange(null)
            }}
            aria-label='Clear date filter'
            className='text-slate-400 hover:text-slate-600'
          >
            ✕
          </span>
        )}
        <ChevronDown aria-hidden className='h-3 w-3 shrink-0 text-slate-400' />
      </button>
      {open && (
        <div className='absolute left-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white text-left shadow-lg dark:border-slate-700 dark:bg-slate-900'>
          <div className='p-1'>
            {DATE_PRESETS.map((d) => (
              <button
                key={d.value || 'all'}
                type='button'
                onClick={() => {
                  onChange(d.value || null)
                  setOpen(false)
                }}
                className={`block w-full rounded px-2 py-1 text-left text-[11.5px] font-normal normal-case tracking-normal ${
                  value === d.value || (!value && !d.value)
                    ? 'bg-[#00ceff14] font-medium text-slate-800 dark:text-slate-100'
                    : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div className='border-t border-slate-100 p-2 dark:border-slate-800'>
            <p className='pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
              Date or range
            </p>
            <div className='flex items-center gap-1'>
              <input
                type='date'
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-label='From date'
                className='h-6 min-w-0 flex-1 rounded border border-slate-200 bg-white px-1 text-[10.5px] font-normal dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
              />
              <span className='text-[10px] text-slate-400'>–</span>
              <input
                type='date'
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-label='To date'
                className='h-6 min-w-0 flex-1 rounded border border-slate-200 bg-white px-1 text-[10.5px] font-normal dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
              />
            </div>
            <button
              type='button'
              disabled={!from && !to}
              onClick={applyRange}
              className='mt-1.5 h-6 w-full rounded bg-[#00ceff] text-[11px] font-semibold text-white disabled:opacity-40'
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function QuickFilterSelect({
  def,
  selected,
  onChange,
  allowedIds,
  scopeDefault
}: {
  def: QuickFilterDef
  selected: Array<string | number>
  onChange: (vals: Array<string | number>) => void
  allowedIds?: Array<string | number>
  /** True when this chip's selection was seeded from the user's default scopes. */
  scopeDefault?: boolean
}) {
  const client = useNivaroClient()
  const valueField = def.value_field ?? 'id'
  // Deferred like the column filters, but a scope-seeded selection needs its
  // labels immediately — an unlabelled chip would read as a raw id.
  const [armed, setArmed] = useState(false)
  const { data: options = [], isLoading } = useQuery({
    queryKey: ['cbv-quick-options', def.collection, valueField, def.label_field, def.sort ?? ''],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${def.collection}`, {
            limit: 1000,
            ...(def.sort ? { sort: def.sort } : {}),
            fields: [...new Set(['id', valueField, def.label_field])].join(',')
          })
        )
        .then((r) =>
          (r.data ?? [])
            .map((row) => ({
              value: row[valueField] as string | number,
              label: String(row[def.label_field] ?? row[valueField] ?? ''),
              id: row.id as string | number
            }))
            .filter((o) => o.value != null && o.label !== '')
        ),
    staleTime: 10 * 60_000,
    enabled: armed || selected.length > 0,
    retry: false
  })
  // Restricted scope values narrow the visible options (server enforces anyway)
  const visible = allowedIds?.length
    ? options.filter((o) => allowedIds.some((id) => String(id) === String(o.id)))
    : options
  // Restricted wins the badge slot — it's the harder constraint; the title
  // still mentions a default seed when both apply.
  const badge = allowedIds?.length
    ? {
        label: 'restricted',
        cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
        title: `Options limited to your restricted ${def.label} scope${scopeDefault ? '; selection seeded from your defaults' : ''}`
      }
    : scopeDefault && selected.length > 0
      ? {
          label: 'default',
          cls: 'bg-[#00ceff1f] text-[#0284a8] dark:text-[#00ceff]',
          title: `Pre-selected from your default ${def.label} scope — adjust freely`
        }
      : null
  return (
    <MultiPick
      label={def.label}
      options={visible}
      selected={selected}
      onChange={onChange}
      loading={isLoading}
      badge={badge}
      onOpenChange={(o) => {
        if (o) setArmed(true)
      }}
    />
  )
}

const NUM_FILTER_OPS = [
  { value: '_eq', label: '=' },
  { value: '_neq', label: '≠' },
  { value: '_gt', label: '>' },
  { value: '_gte', label: '≥' },
  { value: '_lt', label: '<' },
  { value: '_lte', label: '≤' }
]
const DATE_PRESETS = [
  { value: '', label: 'All' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'year', label: 'This year' }
]
function dateRangeFor(preset: string): { from: string; to: string } | null {
  const now = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const to = iso(now)
  if (preset === 'today') return { from: to, to }
  if (preset === '7d' || preset === '30d' || preset === '90d') {
    const days = Number(preset.slice(0, -1))
    return { from: iso(new Date(now.getTime() - days * 86_400_000)), to }
  }
  if (preset === 'year') return { from: `${now.getFullYear()}-01-01`, to }
  return null
}

type ColFilterVal =
  | { kind: 'in'; value: Array<string | number> }
  | { kind: 'text'; value: string; path: string[] }
  | { kind: 'num'; op: string; value: string }
  | { kind: 'bool'; value: 'true' | 'false' }
  | { kind: 'date'; value: string }
  | { kind: 'state'; value: string[] }

// ─── FilterBar (admin components/filter-bar.tsx port) ─────────────────────────

interface OpDef {
  label: string
  value: string
}
const OPS_STRING: OpDef[] = [
  { label: 'Contains', value: '_contains' },
  { label: "Doesn't contain", value: '_ncontains' },
  { label: 'Equals', value: '_eq' },
  { label: 'Not equals', value: '_neq' },
  { label: 'Starts with', value: '_starts_with' },
  { label: 'Ends with', value: '_ends_with' },
  { label: 'Is empty', value: '_null' },
  { label: 'Is not empty', value: '_nnull' }
]
const OPS_NUMBER: OpDef[] = [
  { label: 'Equals', value: '_eq' },
  { label: 'Not equals', value: '_neq' },
  { label: 'Less than', value: '_lt' },
  { label: '≤', value: '_lte' },
  { label: 'Greater than', value: '_gt' },
  { label: '≥', value: '_gte' },
  { label: 'Is empty', value: '_null' },
  { label: 'Is not empty', value: '_nnull' }
]
const OPS_DATE: OpDef[] = [
  { label: 'Equals', value: '_eq' },
  { label: 'Before', value: '_lt' },
  { label: 'After', value: '_gt' },
  { label: 'Is empty', value: '_null' },
  { label: 'Is not empty', value: '_nnull' }
]
const OPS_BY_TYPE: Record<string, OpDef[]> = {
  string: OPS_STRING,
  text: OPS_STRING,
  integer: OPS_NUMBER,
  decimal: OPS_NUMBER,
  float: OPS_NUMBER,
  date: OPS_DATE,
  datetime: OPS_DATE,
  timestamp: OPS_DATE,
  boolean: [
    { label: 'Is true', value: '_eq:true' },
    { label: 'Is false', value: '_eq:false' },
    { label: 'Is empty', value: '_null' }
  ],
  uuid: [
    { label: 'Equals', value: '_eq' },
    { label: 'Not equals', value: '_neq' },
    { label: 'Is empty', value: '_null' },
    { label: 'Is not empty', value: '_nnull' }
  ]
}
const getOps = (type: string | null) => OPS_BY_TYPE[type ?? ''] ?? OPS_STRING
const needsNoValue = (op: string) => op === '_null' || op === '_nnull' || op.includes(':')
function opLabel(op: string): string {
  for (const list of Object.values(OPS_BY_TYPE)) {
    const hit = list.find((o) => o.value === op)
    if (hit) return hit.label
  }
  return op
}

function isM2OField(relations: CMSRelation[], collection: string, field: string) {
  return relations.find(
    (r) => r.many_collection === collection && r.many_field === field && r.one_collection
  )
}

function RelatedFieldRows({
  relatedCollection,
  depth,
  path,
  pathLabels,
  filterText,
  includeAliases = false,
  onPick
}: {
  relatedCollection: string
  depth: number
  path: string[]
  pathLabels: string[]
  filterText: string
  /** Also allow drilling through O2M/M2M alias fields (column picker mode). */
  includeAliases?: boolean
  onPick: (path: string[], pathLabels: string[], fieldType: string) => void
}) {
  const client = useNivaroClient()
  const { data: meta } = useQuery({
    queryKey: ['cbv-collection-meta', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: CollectionMeta }>(get(`/collections/${relatedCollection}`))
        .then((r) => r.data),
    staleTime: 10 * 60_000,
    retry: false
  })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  if (!meta) {
    return (
      <div className='px-3 py-1.5' style={{ paddingLeft: `${0.5 + depth}rem` }}>
        <span className='inline-block h-3 w-20 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
      </div>
    )
  }
  const allowDeeper = depth < 2
  return (
    <>
      {meta.fields
        .filter((f) => !f.hidden && (!filterText || f.field.includes(filterText)))
        .map((f) => {
          const m2oRel = allowDeeper
            ? isM2OField(meta.relations, relatedCollection, f.field)
            : undefined
          const aliasRel =
            allowDeeper && includeAliases
              ? aliasRelationFor(meta.relations, relatedCollection, f.field)
              : undefined
          const expandTarget = m2oRel?.one_collection ?? null
          const isOpen = expanded.has(f.field)
          return (
            <div key={f.field}>
              <button
                type='button'
                onClick={() => {
                  if (expandTarget || aliasRel) {
                    setExpanded((s) => {
                      const next = new Set(s)
                      if (next.has(f.field)) next.delete(f.field)
                      else next.add(f.field)
                      return next
                    })
                  } else {
                    onPick([...path, f.field], [...pathLabels, titleCase(f.field)], f.type ?? 'string')
                  }
                }}
                className='flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
                style={{ paddingLeft: `${0.5 + depth}rem` }}
              >
                {expandTarget || aliasRel ? (isOpen ? '▾ ' : '▸ ') : ''}
                {titleCase(f.field)}
                {aliasRel && <span className='text-[10px] text-slate-400'>{aliasRel.kind}</span>}
              </button>
              {expandTarget && isOpen && (
                <RelatedFieldRows
                  relatedCollection={expandTarget}
                  depth={depth + 1}
                  path={[...path, f.field]}
                  pathLabels={[...pathLabels, titleCase(f.field)]}
                  filterText=''
                  includeAliases={includeAliases}
                  onPick={onPick}
                />
              )}
              {aliasRel && isOpen && (
                <AliasChildRows
                  aliasInfo={aliasRel}
                  depth={depth + 1}
                  path={[...path, f.field]}
                  pathLabels={[...pathLabels, titleCase(f.field)]}
                  includeAliases={includeAliases}
                  onPick={onPick}
                />
              )}
            </div>
          )
        })}
    </>
  )
}

/** Drill into an alias (O2M/M2M) field: O2M children come straight from the
 *  child collection; M2M resolves the junction's sibling relation to find the
 *  real target collection first. */
function AliasChildRows({
  aliasInfo,
  depth,
  path,
  pathLabels,
  includeAliases,
  onPick
}: {
  aliasInfo: { kind: 'o2m' | 'm2m'; relation: CMSRelation }
  depth: number
  path: string[]
  pathLabels: string[]
  includeAliases: boolean
  onPick: (path: string[], pathLabels: string[], fieldType: string) => void
}) {
  const client = useNivaroClient()
  const junction = aliasInfo.relation.many_collection ?? ''
  const { data: junctionMeta } = useQuery({
    queryKey: ['cbv-collection-meta', junction],
    queryFn: () =>
      client.request<{ data: CollectionMeta }>(get(`/collections/${junction}`)).then((r) => r.data),
    staleTime: 10 * 60_000,
    enabled: aliasInfo.kind === 'm2m' && !!junction,
    retry: false
  })
  let target: string | null = null
  if (aliasInfo.kind === 'o2m') target = junction || null
  else {
    const sibling = junctionMeta?.relations.find(
      (r) => r.many_collection === junction && r.many_field === aliasInfo.relation.junction_field
    )
    target = sibling?.one_collection ?? null
  }
  if (!target) {
    return (
      <div className='px-3 py-1.5' style={{ paddingLeft: `${0.5 + depth}rem` }}>
        <span className='inline-block h-3 w-20 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
      </div>
    )
  }
  return (
    <RelatedFieldRows
      relatedCollection={target}
      depth={depth}
      path={path}
      pathLabels={pathLabels}
      filterText=''
      includeAliases={includeAliases}
      onPick={onPick}
    />
  )
}

// ─── FilterBar v2 — drillable, searchable, smart value editors ────────────────
//
// Field stage: search-as-you-type across this collection's fields AND
// one-level-nested related fields; relation rows (M2O + O2M/M2M alias) drill
// inline via the chevron, or click the row to filter by related records
// directly (multi-select of the target collection). Value stage adapts to the
// leaf: relation checklist, number/date ops incl. between, boolean one-click,
// date presets. Chips are editable in place. Everything compiles into server
// `conditions` — filters always cover the entire record set.

type PickedLeaf = {
  path: string[]
  pathLabels: string[]
  fieldType: string
  /** Set when the leaf itself is a relation — value stage shows a record
   *  checklist of this collection instead of a text input. */
  relTarget?: string
}

function fieldKindHint(f: CMSField, rel: CMSRelation | undefined, alias: boolean): string {
  if (rel) return 'relation'
  if (alias) return 'list'
  const t = f.type ?? 'string'
  if (t === 'integer' || t === 'decimal' || t === 'float') return 'number'
  if (t === 'datetime' || t === 'timestamp') return 'date'
  return t
}

/** One drill level of the field picker. */
function FieldLevel({
  collection,
  path,
  pathLabels,
  search,
  depth,
  onDrill,
  onPick
}: {
  collection: string
  path: string[]
  pathLabels: string[]
  search: string
  depth: number
  onDrill: (collection: string, path: string[], pathLabels: string[]) => void
  onPick: (leaf: PickedLeaf) => void
}) {
  const client = useNivaroClient()
  const { data: meta } = useQuery({
    queryKey: ['cbv-collection-meta', collection],
    queryFn: () =>
      client.request<{ data: CollectionMeta }>(get(`/collections/${collection}`)).then((r) => r.data),
    staleTime: 10 * 60_000,
    retry: false
  })
  // Pre-load first-level relation targets so search can surface nested fields.
  const relTargets = useMemo(() => {
    if (!meta) return []
    const out = new Set<string>()
    for (const f of meta.fields) {
      if (f.hidden) continue
      const rel = isM2OField(meta.relations, collection, f.field)
      if (rel?.one_collection && !isSystemCol(rel.one_collection)) out.add(rel.one_collection)
      const alias = aliasRelationFor(meta.relations, collection, f.field)
      if (alias) {
        const child = alias.relation.many_collection
        if (child && !isSystemCol(child)) out.add(child)
      }
    }
    return [...out].slice(0, 12)
  }, [meta, collection])
  const relMetaQueries = useQueries({
    queries: relTargets.map((c) => ({
      queryKey: ['cbv-collection-meta', c],
      queryFn: () =>
        client.request<{ data: CollectionMeta }>(get(`/collections/${c}`)).then((r) => r.data),
      staleTime: 10 * 60_000,
      retry: false,
      enabled: !!search
    }))
  })
  const relMetaMapLocal = useMemo(() => {
    const m = new Map<string, CollectionMeta | undefined>()
    relTargets.forEach((c, i) => m.set(c, relMetaQueries[i]?.data))
    return m
  }, [relTargets, relMetaQueries])

  if (!meta)
    return (
      <div className='px-3 py-2'>
        <span className='inline-block h-3 w-24 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
      </div>
    )

  const q = search.trim().toLowerCase()
  const match = (label: string) => !q || label.toLowerCase().includes(q) || label.toLowerCase().replace(/ /g, '_').includes(q)

  type Row = {
    key: string
    label: string
    breadcrumb?: string
    hint: string
    drillTo?: { collection: string; path: string[]; pathLabels: string[] }
    leaf?: PickedLeaf
  }
  const rows: Row[] = []
  for (const f of meta.fields) {
    if (f.hidden) continue
    const label = titleCase(f.field)
    const rel = isM2OField(meta.relations, collection, f.field)
    const alias = aliasRelationFor(meta.relations, collection, f.field)
    const fullPath = [...path, f.field]
    const fullLabels = [...pathLabels, label]
    if (rel?.one_collection && !isSystemCol(rel.one_collection)) {
      if (match(label))
        rows.push({
          key: f.field,
          label,
          hint: 'relation',
          drillTo: depth < 2 ? { collection: rel.one_collection, path: fullPath, pathLabels: fullLabels } : undefined,
          leaf: { path: fullPath, pathLabels: fullLabels, fieldType: 'relation', relTarget: rel.one_collection }
        })
    } else if (alias) {
      const child = alias.relation.many_collection
      if (match(label) && child)
        rows.push({
          key: f.field,
          label,
          hint: alias.kind === 'm2m' ? 'list' : 'items',
          drillTo: depth < 2 ? { collection: child, path: fullPath, pathLabels: fullLabels } : undefined,
          leaf:
            alias.kind === 'm2m'
              ? { path: fullPath, pathLabels: fullLabels, fieldType: 'relation', relTarget: '' }
              : undefined
        })
    } else if (match(label)) {
      rows.push({
        key: f.field,
        label,
        hint: fieldKindHint(f, undefined, false),
        leaf: { path: fullPath, pathLabels: fullLabels, fieldType: f.type ?? 'string' }
      })
    }
  }
  // Deep search: nested fields of first-level relation targets.
  const nested: Row[] = []
  if (q) {
    for (const f of meta.fields) {
      if (f.hidden) continue
      const rel = isM2OField(meta.relations, collection, f.field)
      if (!rel?.one_collection || isSystemCol(rel.one_collection)) continue
      const childMeta = relMetaMapLocal.get(rel.one_collection)
      if (!childMeta) continue
      const parentLabel = titleCase(f.field)
      for (const cf of childMeta.fields) {
        if (cf.hidden) continue
        const childLabel = titleCase(cf.field)
        if (!match(childLabel)) continue
        const childRel = isM2OField(childMeta.relations, rel.one_collection, cf.field)
        nested.push({
          key: `${f.field}.${cf.field}`,
          label: childLabel,
          breadcrumb: parentLabel,
          hint: fieldKindHint(cf, childRel ?? undefined, false),
          leaf: {
            path: [...path, f.field, cf.field],
            pathLabels: [...pathLabels, parentLabel, childLabel],
            fieldType: childRel?.one_collection ? 'relation' : (cf.type ?? 'string'),
            relTarget: childRel?.one_collection ?? undefined
          }
        })
      }
    }
  }
  const shown = [...rows, ...nested.slice(0, 12)]
  if (shown.length === 0)
    return <p className='px-3 py-2 text-[12px] text-slate-400'>No matching fields</p>
  return (
    <>
      {shown.map((r) => (
        <div
          key={r.key}
          className='group/frow flex w-full items-center gap-1 px-1.5 hover:bg-slate-50 dark:hover:bg-slate-800'
        >
          <button
            type='button'
            onClick={() => {
              if (r.leaf) onPick(r.leaf)
              else if (r.drillTo) onDrill(r.drillTo.collection, r.drillTo.path, r.drillTo.pathLabels)
            }}
            className='flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1.5 text-left text-[12.5px] text-slate-700 dark:text-slate-200'
          >
            {r.breadcrumb && <span className='shrink-0 text-slate-400'>{r.breadcrumb} ›</span>}
            <span className='truncate'>{r.label}</span>
            <span className='ml-auto shrink-0 pl-2 text-[10px] text-slate-300 group-hover/frow:text-slate-400'>
              {r.hint}
            </span>
          </button>
          {r.drillTo && (
            <button
              type='button'
              onClick={() => onDrill(r.drillTo!.collection, r.drillTo!.path, r.drillTo!.pathLabels)}
              aria-label={`Drill into ${r.label}`}
              className='shrink-0 rounded px-1.5 py-1 text-[11px] text-slate-300 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700'
            >
              ▸
            </button>
          )}
        </div>
      ))}
    </>
  )
}

/** Inline record checklist for relation-valued filters. */
function RelationValueList({
  target,
  selected,
  labels,
  onToggle
}: {
  target: string
  selected: Array<string | number>
  labels: Record<string, string>
  onToggle: (id: string | number, label: string) => void
}) {
  const client = useNivaroClient()
  const [q, setQ] = useState('')
  const { data: meta } = useQuery({
    queryKey: ['cbv-collection-meta', target],
    queryFn: () =>
      client.request<{ data: CollectionMeta }>(get(`/collections/${target}`)).then((r) => r.data),
    staleTime: 10 * 60_000,
    retry: false
  })
  const labelField = labelFieldFor(meta)
  const template = meta?.display_template ?? null
  const { data: options = [], isLoading } = useQuery({
    queryKey: ['cbv-filter-options', target, labelField, template ?? ''],
    queryFn: () => {
      const fields = optionFieldsFor(template, labelField)
      return client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${target}`, { limit: 500, sort: labelField, ...(fields ? { fields } : {}) })
        )
        .then((r) =>
          (r.data ?? [])
            .map((row) => ({
              value: row.id as string | number,
              label:
                (template ? renderDisplayTemplate(template, row) : '') ||
                String(row[labelField] ?? row.id ?? '')
            }))
            .filter((o) => o.value != null && o.label !== '')
        )
    },
    staleTime: 10 * 60_000,
    enabled: !!meta,
    retry: false
  })
  const selSet = new Set(selected.map(String))
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options
  return (
    <div className='flex max-h-64 flex-col'>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${titleCase(target)}…`}
        className='mx-2 mb-1 h-7 shrink-0 rounded border border-slate-200 bg-slate-50 px-2 text-[12px] outline-none focus:border-[#00ceff80] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
      />
      <div className='min-h-0 flex-1 overflow-y-auto px-1 pb-1'>
        {isLoading ? (
          <p className='px-2 py-1 text-[11px] text-slate-400'>Loading…</p>
        ) : shown.length === 0 ? (
          <p className='px-2 py-1 text-[11px] text-slate-400'>No matches</p>
        ) : (
          shown.slice(0, 300).map((o) => (
            <label
              key={String(o.value)}
              className='flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[12px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
            >
              <input
                type='checkbox'
                checked={selSet.has(String(o.value))}
                onChange={() => onToggle(o.value, o.label)}
              />
              <span className='truncate'>{o.label}</span>
            </label>
          ))
        )}
      </div>
      {selected.length > 0 && (
        <p className='shrink-0 border-t border-slate-100 px-3 py-1 text-[11px] text-slate-400 dark:border-slate-800'>
          {selected.length} selected · {selected.map((v) => labels[String(v)] ?? v).slice(0, 3).join(', ')}
          {selected.length > 3 ? '…' : ''}
        </p>
      )}
    </div>
  )
}

function filterChipText(f: ActiveFilter): { field: string; op: string; value: string } {
  const field = f.pathLabels.join(' › ')
  if (Array.isArray(f.value)) {
    const labels = f.valueLabels ?? f.value.map(String)
    return {
      field,
      op: 'any of',
      value: labels.length <= 2 ? labels.join(', ') : `${labels[0]} +${labels.length - 1}`
    }
  }
  if (f.op === '_between') {
    const [a, b] = String(f.value).split('..')
    return { field, op: 'between', value: `${a} – ${b}` }
  }
  return { field, op: opLabel(f.op).toLowerCase(), value: String(f.value ?? '') }
}

function FilterBar({
  collection,
  meta,
  search,
  onSearch,
  filters,
  onFiltersChange
}: {
  collection: string
  meta: CollectionMeta | undefined
  search: string
  onSearch: (v: string) => void
  filters: ActiveFilter[]
  onFiltersChange: (f: ActiveFilter[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [fieldFilter, setFieldFilter] = useState('')
  const [level, setLevel] = useState<{ collection: string; path: string[]; pathLabels: string[] }>({
    collection,
    path: [],
    pathLabels: []
  })
  const [picked, setPicked] = useState<PickedLeaf | null>(null)
  const [pickedOp, setPickedOp] = useState<string>('_contains')
  const [value, setValue] = useState('')
  const [value2, setValue2] = useState('')
  const [relSel, setRelSel] = useState<Array<string | number>>([])
  const [relLabels, setRelLabels] = useState<Record<string, string>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const reset = () => {
    setFieldFilter('')
    setLevel({ collection, path: [], pathLabels: [] })
    setPicked(null)
    setPickedOp('_contains')
    setValue('')
    setValue2('')
    setRelSel([])
    setRelLabels({})
    setEditingId(null)
  }
  const openFresh = () => {
    reset()
    setOpen(true)
  }
  const commit = (entry: Omit<ActiveFilter, 'id'>) => {
    if (editingId) {
      onFiltersChange(filters.map((f) => (f.id === editingId ? { ...entry, id: editingId } : f)))
    } else {
      onFiltersChange([...filters, { ...entry, id: crypto.randomUUID() }])
    }
    setOpen(false)
    reset()
  }
  const applyScalar = (op: string, val: string) => {
    if (!picked) return
    commit({ path: picked.path, pathLabels: picked.pathLabels, fieldType: picked.fieldType, op, value: val })
  }
  const applyRelation = () => {
    if (!picked || relSel.length === 0) return
    commit({
      path: picked.path,
      pathLabels: picked.pathLabels,
      fieldType: 'relation',
      op: '_in',
      value: relSel,
      valueLabels: relSel.map((v) => relLabels[String(v)] ?? String(v)),
      relTarget: picked.relTarget
    })
  }
  const editChip = (f: ActiveFilter) => {
    setOpen(true)
    setFieldFilter('')
    setLevel({ collection, path: [], pathLabels: [] })
    setEditingId(f.id)
    if (Array.isArray(f.value)) {
      // Relation chip: reconstruct the target from the picked path — we stored
      // no target, so reopen as a fresh relation pick isn't possible; fall back
      // to keeping selection editable via labels only.
      setPicked({ path: f.path, pathLabels: f.pathLabels, fieldType: 'relation', relTarget: f.relTarget })
      setRelSel(f.value)
      const labels: Record<string, string> = {}
      f.value.forEach((v, i) => {
        labels[String(v)] = f.valueLabels?.[i] ?? String(v)
      })
      setRelLabels(labels)
    } else {
      setPicked({ path: f.path, pathLabels: f.pathLabels, fieldType: f.fieldType })
      setPickedOp(f.op)
      if (f.op === '_between') {
        const [a, b] = String(f.value).split('..')
        setValue(a ?? '')
        setValue2(b ?? '')
      } else {
        setValue(String(f.value ?? ''))
      }
    }
  }

  const leafKind = (() => {
    if (!picked) return null
    if (picked.relTarget !== undefined) return 'relation'
    const t = picked.fieldType
    if (t === 'integer' || t === 'decimal' || t === 'float') return 'number'
    if (t === 'date' || t === 'datetime' || t === 'timestamp') return 'date'
    if (t === 'boolean') return 'boolean'
    return 'string'
  })()

  const numberOps = NUM_FILTER_OPS
  const stringOps = [
    { value: '_contains', label: 'Contains' },
    { value: '_ncontains', label: "Doesn't contain" },
    { value: '_eq', label: 'Equals' },
    { value: '_neq', label: 'Not equals' },
    { value: '_starts_with', label: 'Starts with' },
    { value: '_ends_with', label: 'Ends with' }
  ]

  return (
    <div className='flex min-w-0 flex-1 flex-wrap items-center gap-2'>
      {/* Search */}
      <div className='relative'>
        <Search
          aria-hidden
          className='pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400'
        />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder='Search…'
          aria-label={`Search ${collection}`}
          className='h-8 w-48 rounded-md border border-slate-200 bg-white pl-8 pr-3 text-[13px] outline-none focus:border-[#00ceff80] focus:ring-2 focus:ring-[#00ceff4d] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
        />
      </div>

      {/* Applied chips — click to edit in place */}
      {filters.map((f) => {
        const chip = filterChipText(f)
        return (
          <span
            key={f.id}
            className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] transition-colors hover:border-[#00ceff66] dark:border-slate-700 dark:bg-slate-900'
          >
            <button type='button' onClick={() => editChip(f)} className='inline-flex items-center gap-1.5'>
              <span className='text-slate-500'>{chip.field}</span>
              <span className='font-semibold text-slate-700 dark:text-slate-200'>{chip.op}</span>
              {chip.value && <span className='text-[#00a5cc] dark:text-[#00ceff]'>{chip.value}</span>}
            </button>
            <button
              type='button'
              onClick={() => onFiltersChange(filters.filter((x) => x.id !== f.id))}
              aria-label='Remove filter'
              className='text-slate-400 hover:text-red-500'
            >
              ✕
            </button>
          </span>
        )
      })}

      {/* Add filter */}
      <div className='relative' ref={rootRef}>
        <button
          type='button'
          onClick={() => (open ? setOpen(false) : openFresh())}
          className='inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-slate-300 px-2.5 text-[12.5px] text-slate-500 hover:border-slate-400 hover:text-slate-700 dark:border-slate-600 dark:text-slate-400'
        >
          + Add Filter
        </button>
        {open && (
          <div className='absolute left-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900'>
            {picked == null ? (
              <>
                {level.path.length > 0 && (
                  <button
                    type='button'
                    onClick={() => setLevel({ collection, path: [], pathLabels: [] })}
                    className='flex w-full items-center gap-1 border-b border-slate-100 px-3 py-2 text-left text-[12px] font-medium text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800'
                  >
                    ‹ {level.pathLabels.join(' › ')}
                  </button>
                )}
                <div className='p-2 pb-1'>
                  <input
                    autoFocus
                    value={fieldFilter}
                    onChange={(e) => setFieldFilter(e.target.value)}
                    placeholder='Find field…'
                    className='h-8 w-full rounded-lg border-2 border-[#00ceff80] bg-white px-2.5 text-[12.5px] outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-[#00ceff33] dark:border-[#00ceff66] dark:bg-slate-800 dark:text-slate-100'
                  />
                </div>
                <div className='max-h-80 overflow-y-auto py-1'>
                  <FieldLevel
                    collection={level.collection}
                    path={level.path}
                    pathLabels={level.pathLabels}
                    search={fieldFilter}
                    depth={level.path.length}
                    onDrill={(c, pth, lbls) => {
                      setLevel({ collection: c, path: pth, pathLabels: lbls })
                      setFieldFilter('')
                    }}
                    onPick={(leaf) => {
                      setPicked(leaf)
                      setPickedOp(
                        leaf.fieldType === 'integer' || leaf.fieldType === 'decimal' || leaf.fieldType === 'float'
                          ? '_eq'
                          : '_contains'
                      )
                    }}
                  />
                </div>
              </>
            ) : (
              <>
                <button
                  type='button'
                  onClick={() => {
                    setPicked(null)
                    setRelSel([])
                    setValue('')
                    setValue2('')
                  }}
                  className='flex w-full items-center gap-1 border-b border-slate-100 px-3 py-2 text-left text-[12px] font-medium text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800'
                >
                  ‹ {picked.pathLabels.join(' › ')}
                </button>

                {leafKind === 'relation' && picked.relTarget ? (
                  <div className='pt-2'>
                    <RelationValueList
                      target={picked.relTarget}
                      selected={relSel}
                      labels={relLabels}
                      onToggle={(id, label) => {
                        setRelSel((sel) =>
                          sel.map(String).includes(String(id))
                            ? sel.filter((v) => String(v) !== String(id))
                            : [...sel, id]
                        )
                        setRelLabels((l) => ({ ...l, [String(id)]: label }))
                      }}
                    />
                    <div className='border-t border-slate-100 p-2 dark:border-slate-800'>
                      <button
                        type='button'
                        disabled={relSel.length === 0}
                        onClick={applyRelation}
                        className='h-8 w-full rounded-md bg-[#00ceff] text-[13px] font-medium text-white disabled:opacity-40'
                      >
                        Apply{relSel.length > 0 ? ` (${relSel.length})` : ''}
                      </button>
                    </div>
                  </div>
                ) : leafKind === 'boolean' ? (
                  <div className='flex gap-1.5 p-3'>
                    {[
                      { label: 'Yes', op: '_eq:true' },
                      { label: 'No', op: '_eq:false' },
                      { label: 'Empty', op: '_null' }
                    ].map((b) => (
                      <button
                        key={b.op}
                        type='button'
                        onClick={() => applyScalar(b.op.includes(':') ? b.op.split(':')[0] : b.op, b.op.includes(':') ? b.op.split(':')[1] : '')}
                        className='h-8 flex-1 rounded-md border border-slate-200 text-[12.5px] text-slate-600 hover:border-[#00ceff66] hover:bg-[#00ceff0d] dark:border-slate-700 dark:text-slate-300'
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                ) : leafKind === 'date' ? (
                  <div className='space-y-2 p-3'>
                    <div className='flex flex-wrap gap-1'>
                      {DATE_PRESETS.filter((d) => d.value).map((d) => (
                        <button
                          key={d.value}
                          type='button'
                          onClick={() => {
                            const r = dateRangeFor(d.value)
                            if (r) applyScalar('_between', `${r.from}..${r.to}`)
                          }}
                          className='rounded-md border border-slate-200 px-2 py-1 text-[11.5px] text-slate-600 hover:border-[#00ceff66] hover:bg-[#00ceff0d] dark:border-slate-700 dark:text-slate-300'
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                    <div className='flex items-center gap-1.5'>
                      <input
                        type='date'
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        aria-label='From date'
                        className='h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
                      />
                      <span className='text-[11px] text-slate-400'>to</span>
                      <input
                        type='date'
                        value={value2}
                        onChange={(e) => setValue2(e.target.value)}
                        aria-label='To date'
                        className='h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
                      />
                    </div>
                    <button
                      type='button'
                      disabled={!value && !value2}
                      onClick={() => {
                        if (value && value2) applyScalar('_between', `${value}..${value2}`)
                        else if (value) applyScalar('_gte', value)
                        else if (value2) applyScalar('_lte', value2)
                      }}
                      className='h-8 w-full rounded-md bg-[#00ceff] text-[13px] font-medium text-white disabled:opacity-40'
                    >
                      Apply
                    </button>
                  </div>
                ) : (
                  <form
                    className='space-y-2 p-3'
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (leafKind === 'number' && pickedOp === '_between') {
                        if (value !== '' && value2 !== '') applyScalar('_between', `${value}..${value2}`)
                      } else if (value.trim()) applyScalar(pickedOp, value.trim())
                    }}
                  >
                    <div className='flex flex-wrap gap-1'>
                      {(leafKind === 'number' ? [...numberOps, { value: '_between', label: 'Between' }] : stringOps).map(
                        (o) => (
                          <button
                            key={o.value}
                            type='button'
                            onClick={() => setPickedOp(o.value)}
                            className={`rounded-md border px-2 py-1 text-[11.5px] ${
                              pickedOp === o.value
                                ? 'border-[#00ceff66] bg-[#00ceff14] font-medium text-slate-800 dark:text-slate-100'
                                : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400'
                            }`}
                          >
                            {o.label}
                          </button>
                        )
                      )}
                      <button
                        type='button'
                        onClick={() => applyScalar('_null', '')}
                        className='rounded-md border border-slate-200 px-2 py-1 text-[11.5px] text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400'
                      >
                        Empty
                      </button>
                      <button
                        type='button'
                        onClick={() => applyScalar('_nnull', '')}
                        className='rounded-md border border-slate-200 px-2 py-1 text-[11.5px] text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400'
                      >
                        Not empty
                      </button>
                    </div>
                    <div className='flex items-center gap-1.5'>
                      <input
                        autoFocus
                        type={leafKind === 'number' ? 'number' : 'text'}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder='Value…'
                        className='h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] outline-none focus:border-[#00ceff80] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
                      />
                      {leafKind === 'number' && pickedOp === '_between' && (
                        <>
                          <span className='text-[11px] text-slate-400'>to</span>
                          <input
                            type='number'
                            value={value2}
                            onChange={(e) => setValue2(e.target.value)}
                            placeholder='To…'
                            className='h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] outline-none focus:border-[#00ceff80] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
                          />
                        </>
                      )}
                    </div>
                    <button
                      type='submit'
                      disabled={pickedOp === '_between' ? value === '' || value2 === '' : !value.trim()}
                      className='h-8 w-full rounded-md bg-[#00ceff] text-[13px] font-medium text-white disabled:opacity-40'
                    >
                      {editingId ? 'Update' : 'Apply'}
                    </button>
                  </form>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Related-column drill (column picker: add dotted display columns) ────────

function RelatedColumnRoot({
  collection,
  meta,
  onPick
}: {
  collection: string
  meta: CollectionMeta
  onPick: (path: string[], pathLabels: string[]) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const pick = (path: string[], pathLabels: string[]) => onPick(path, pathLabels)
  return (
    <div className='max-h-56 overflow-y-auto'>
      {meta.fields
        .filter((f) => !f.hidden)
        .map((f) => {
          const m2o = isM2OField(meta.relations, collection, f.field)
          const alias = aliasRelationFor(meta.relations, collection, f.field)
          if (!m2o?.one_collection && !alias) return null
          const isOpen = expanded.has(f.field)
          return (
            <div key={f.field}>
              <button
                type='button'
                onClick={() =>
                  setExpanded((s) => {
                    const next = new Set(s)
                    if (next.has(f.field)) next.delete(f.field)
                    else next.add(f.field)
                    return next
                  })
                }
                className='flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
              >
                {isOpen ? '▾' : '▸'} {titleCase(f.field)}
                {alias && <span className='text-[10px] text-slate-400'>{alias.kind}</span>}
              </button>
              {isOpen && m2o?.one_collection && (
                <RelatedFieldRows
                  relatedCollection={m2o.one_collection}
                  depth={1}
                  path={[f.field]}
                  pathLabels={[titleCase(f.field)]}
                  filterText=''
                  includeAliases
                  onPick={pick}
                />
              )}
              {isOpen && alias && (
                <AliasChildRows
                  aliasInfo={alias}
                  depth={1}
                  path={[f.field]}
                  pathLabels={[titleCase(f.field)]}
                  includeAliases
                  onPick={pick}
                />
              )}
            </div>
          )
        })}
    </div>
  )
}

// ─── Bulk bar (admin components/bulk-action-bar.tsx port) ─────────────────────

function BulkBar({
  collection,
  selectedIds,
  transitions,
  onClear,
  onSuccess
}: {
  collection: string
  selectedIds: Array<string | number>
  transitions: Array<{ id: string; label: string }>
  onClear: () => void
  onSuccess: () => void
}) {
  const client = useNivaroClient()
  const [mode, setMode] = useState<'actions' | 'update' | 'transition' | 'confirm-delete'>('actions')
  const [field, setField] = useState('')
  const [value, setValue] = useState('')
  const [transitionId, setTransitionId] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    setNote(null)
    try {
      const msg = await fn()
      setNote(msg)
      onSuccess()
      onClear()
      setMode('actions')
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Bulk action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-cbv-bulkbar
      className='flex shrink-0 flex-wrap items-center gap-3 border-t border-[#16233c] bg-[#0f1e2d] px-4 py-2.5 text-white shadow-[0_-2px_12px_rgba(0,0,0,0.25)]'
    >
      <button type='button' onClick={onClear} aria-label='Clear selection' className='text-slate-400 hover:text-white'>
        ✕
      </button>
      <span className='text-[13px] font-medium text-[#00ceff]'>
        {selectedIds.length} item{selectedIds.length === 1 ? '' : 's'} selected
      </span>
      {note && <span className='text-[12px] text-slate-300'>{note}</span>}
      <span className='flex-1' />
      {mode === 'actions' && (
        <span className='flex items-center gap-1.5'>
          <button
            type='button'
            onClick={() => setMode('update')}
            className='h-8 rounded-md border border-white/20 px-3 text-[12.5px] font-medium hover:bg-white/10'
          >
            Update Field
          </button>
          {transitions.length > 0 && (
            <button
              type='button'
              onClick={() => setMode('transition')}
              className='h-8 rounded-md border border-white/20 px-3 text-[12.5px] font-medium hover:bg-white/10'
            >
              Transition
            </button>
          )}
          <button
            type='button'
            onClick={() => setMode('confirm-delete')}
            className='h-8 rounded-md bg-red-600 px-3 text-[12.5px] font-medium hover:bg-red-700'
          >
            Delete
          </button>
        </span>
      )}
      {mode === 'update' && (
        <form
          className='flex items-center gap-1.5'
          onSubmit={(e) => {
            e.preventDefault()
            if (!field.trim()) return
            void run(async () => {
              const res = await client.request<{ updated: number }>(
                post(`/items/${collection}/bulk-update`, {
                  ids: selectedIds,
                  data: { [field.trim()]: value }
                })
              )
              return `Updated ${res.updated} items`
            })
          }}
        >
          <input
            autoFocus
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder='field'
            className='h-8 w-32 rounded-md border border-white/20 bg-white/10 px-2 text-[12.5px] text-white placeholder:text-slate-400'
          />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder='value'
            className='h-8 w-32 rounded-md border border-white/20 bg-white/10 px-2 text-[12.5px] text-white placeholder:text-slate-400'
          />
          <button type='submit' disabled={busy} className='h-8 rounded-md bg-[#00ceff] px-3 text-[12.5px] font-semibold text-[#0f1e2d] disabled:opacity-50'>
            Apply
          </button>
          <button type='button' onClick={() => setMode('actions')} className='h-8 px-2 text-[12.5px] text-slate-300 hover:text-white'>
            Cancel
          </button>
        </form>
      )}
      {mode === 'transition' && (
        <form
          className='flex items-center gap-1.5'
          onSubmit={(e) => {
            e.preventDefault()
            if (!transitionId) return
            void run(async () => {
              const res = await client.request<{ succeeded: number; failed: number }>(
                post(`/items/${collection}/bulk-transition`, {
                  ids: selectedIds,
                  transition_id: transitionId
                })
              )
              return res.failed > 0
                ? `Transitioned ${res.succeeded}, ${res.failed} failed`
                : `Transitioned ${res.succeeded} items`
            })
          }}
        >
          <SimpleSelect
            value={transitionId}
            onChange={setTransitionId}
            options={[
              { value: '', label: 'Choose transition…' },
              ...transitions.map((t) => ({ value: t.id, label: t.label }))
            ]}
            ariaLabel='Choose transition'
            className='h-8 w-auto rounded-md border-white/20 bg-[#16233c] px-2 text-[12.5px] text-white focus:ring-0'
          />
          <button type='submit' disabled={busy || !transitionId} className='h-8 rounded-md bg-[#00ceff] px-3 text-[12.5px] font-semibold text-[#0f1e2d] disabled:opacity-50'>
            Run
          </button>
          <button type='button' onClick={() => setMode('actions')} className='h-8 px-2 text-[12.5px] text-slate-300 hover:text-white'>
            Cancel
          </button>
        </form>
      )}
      {mode === 'confirm-delete' && (
        <span className='flex items-center gap-2'>
          <span className='text-[12.5px] text-slate-300'>
            Delete {selectedIds.length} item{selectedIds.length === 1 ? '' : 's'}? Deleted records
            move to Trash for 30 days.
          </span>
          <button
            type='button'
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const res = await client.request<{ deleted: number }>(
                  post(`/items/${collection}/bulk-delete`, { ids: selectedIds })
                )
                return `Deleted ${res.deleted} items`
              })
            }
            className='h-8 rounded-md bg-red-600 px-3 text-[12.5px] font-medium hover:bg-red-700 disabled:opacity-50'
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
          <button type='button' onClick={() => setMode('actions')} className='h-8 px-2 text-[12.5px] text-slate-300 hover:text-white'>
            Cancel
          </button>
        </span>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CollectionBrowserView({
  collection,
  quickFilters = [],
  initialColumns,
  initialSort,
  pageSize = 25,
  initialSearch = '',
  initialConditions,
  onOpenItem,
  showCreate = true,
  className
}: CollectionBrowserViewProps) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { open: openTarget, urlFor } = useItemNavigation()

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState(initialSearch)
  const appliedSearch = useDebounced(search.trim(), 350)
  const [filters, setFilters] = useState<ActiveFilter[]>([])
  const [sort, setSort] = useState<string>(initialSort ?? '')
  const [displayColumns, setDisplayColumns] = useState<string[] | null>(initialColumns ?? null)
  const [columnLabels, setColumnLabels] = useState<Record<string, string>>({})
  const [renamingCol, setRenamingCol] = useState<string | null>(null)
  const [columnFormats, setColumnFormats] = useState<Record<string, ColumnFormatConfig>>({})
  const [formattingCol, setFormattingCol] = useState<string | null>(null)
  const [presetOpen, setPresetOpen] = useState(false)
  const dragIdxRef = useRef<number | null>(null)
  const [quickSel, setQuickSel] = useState<Record<string, Array<string | number>>>({})
  const [appliedQuick, setAppliedQuick] = useState<Record<string, Array<string | number>>>({})
  // Deep-link context (dashboard tiles etc.) — ANDed into every fetch until
  // the user clears the chip; separate from user-built filters on purpose.
  const [linkConds, setLinkConds] = useState(initialConditions ?? [])
  // User Scopes: seed quick filters from the user's DEFAULTS once (skipped for
  // keys the user/view already set); RESTRICTED values narrow facet options.
  const { scopes: myScopes, ready: scopesReady } = useMyScopes()
  // Items query waits behind this gate so the first fetch already carries the
  // seeded default filters (no unfiltered flash-load + refetch).
  const [scopeGateOpen, setScopeGateOpen] = useState(false)
  // Which quick-filter keys got their selection from default scopes — drives
  // the chip's "default" badge so the seeding is visible, not silent.
  const [scopeSeededKeys, setScopeSeededKeys] = useState<ReadonlySet<string>>(new Set())
  const [colFilters, setColFilters] = useState<Record<string, ColFilterVal>>({})
  // The whole drill stack lives in the host's overlay history when one is
  // provided, so the browser's Back button steps down a level instead of
  // abandoning the browser behind the sheet. Without a host adapter this is
  // plain state and behaves exactly as it did. Named apart from the per-cell
  // `drill` (a resolved column target) further down, which it would shadow.
  const recordDrill = useOverlayState<DrilldownTarget[]>('drill.browser')
  const drillStack = recordDrill.value
  const [auditId, setAuditId] = useState<string | null>(null)
  const [colsOpen, setColsOpen] = useState(false)
  // Row density — a per-browser preference shared by every table surface.
  const [density, setDensity] = useState<'compact' | 'comfortable'>(() => {
    try {
      return localStorage.getItem('nvr_table_density') === 'comfortable' ? 'comfortable' : 'compact'
    } catch {
      return 'compact'
    }
  })
  const toggleDensity = () => {
    const next = density === 'compact' ? 'comfortable' : 'compact'
    setDensity(next)
    try {
      localStorage.setItem('nvr_table_density', next)
    } catch {
      /* private mode */
    }
  }
  // Group rows under collapsible section headers by one column's value.
  // Per-collection preference; grouping fetches up to 500 rows in one page so
  // sections cover the (filtered) set rather than one page of it.
  const [groupBy, setGroupBy] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`nvr_cbv_group_${collection}`) || null
    } catch {
      return null
    }
  })
  const [groupOpen, setGroupOpen] = useState(false)
  const groupRef = useRef<HTMLDivElement>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const pickGroupBy = (k: string | null) => {
    setGroupBy(k)
    setCollapsedGroups(new Set())
    setGroupOpen(false)
    setPage(1)
    try {
      if (k) localStorage.setItem(`nvr_cbv_group_${collection}`, k)
      else localStorage.removeItem(`nvr_cbv_group_${collection}`)
    } catch {
      /* private mode */
    }
  }
  // Ask the table — natural language → the server's /ai/query filter DSL,
  // rendered as a one-off overlay result set (same posture as the admin
  // classic browser's AI mode). Clearing the chip returns to the live query.
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiResult, setAiResult] = useState<{
    rows: Array<Record<string, unknown>>
    interpreted: string
    total: number
  } | null>(null)
  const aiAsk = useMutation({
    mutationFn: (prompt: string) =>
      client.request<{
        data: Array<Record<string, unknown>>
        total: number
        interpreted: string
      }>(post('/ai/query', { collection, prompt, limit: 200 })),
    onSuccess: (res) => {
      setAiResult({
        rows: res.data ?? [],
        interpreted: res.interpreted ?? '',
        total: res.total ?? res.data?.length ?? 0
      })
      setSelectedIds([])
      setPage(1)
    },
    onError: (err) => {
      const status = (err as { status?: number }).status
      const msg = (err as { response?: { error?: string } }).response?.error
      if (status === 503) {
        toast.error('AI is not configured — add an Anthropic API key in Settings.')
      } else {
        toast.error(msg ?? 'Could not answer that question')
      }
    }
  })
  const clearAi = () => {
    setAiResult(null)
    setAiPrompt('')
  }
  // Right-click a cell → filter to / exclude / group by. Exclusions live in
  // their own list because MSSQL's _neq/_ncontains drop NULL rows — each one
  // compiles to an OR with _null so "everything except X" keeps blanks.
  const [cellMenu, setCellMenu] = useState<{
    x: number
    y: number
    key: string
    row: Record<string, unknown>
    cellText: string
  } | null>(null)
  const [cellExcludes, setCellExcludes] = useState<
    Array<{ id: string; path: string[]; op: '_neq' | '_ncontains'; value: unknown; label: string; field: string }>
  >([])
  useEffect(() => {
    if (!cellMenu) return
    const close = () => setCellMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', close)
    }
  }, [cellMenu])
  const [selectedIds, setSelectedIds] = useState<Array<string | number>>([])
  const [activeViewId, setActiveViewId] = useState<number | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [exporting, setExporting] = useState(false)
  const colsRef = useRef<HTMLDivElement>(null)
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const defaultAppliedRef = useRef(false)
  const { isAdmin } = useItemEditAuth()

  // Reset ONLY when the collection actually changes. A plain [collection]
  // effect also fires on mount (twice under StrictMode), and that wiped the
  // deep-link initialConditions before the first fetch; a boolean "first run"
  // ref is not enough because StrictMode's second invoke sails past it.
  const prevCollectionRef = useRef(collection)
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    if (prevCollectionRef.current === collection) return
    prevCollectionRef.current = collection
    setPage(1)
    setSearch(initialSearch)
    setFilters([])
    setSort(initialSort ?? '')
    setDisplayColumns(initialColumns ?? null)
    setColumnLabels({})
    setColumnFormats({})
    setSelectedIds([])
    setActiveViewId(null)
    setQuickSel({})
    setAppliedQuick({})
    setColFilters({})
    setLinkConds([])
    // A sheet left open would be showing a record from the old collection.
    // Closing it is now an unwind of every level, not a single clear.
    if (drillStack?.length) recordDrill.back(drillStack.length)
    setAuditId(null)
    defaultAppliedRef.current = false
  }, [collection])

  useEffect(() => {
    if (!colsOpen) return
    const onDown = (e: MouseEvent) => {
      if (!colsRef.current?.contains(e.target as Node)) setColsOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [colsOpen])
  useEffect(() => {
    if (!groupOpen) return
    const onDown = (e: MouseEvent) => {
      if (!groupRef.current?.contains(e.target as Node)) setGroupOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [groupOpen])

  // ── Collection metadata (fields + relations + display info) ───────────────
  const { data: meta } = useQuery({
    queryKey: ['cbv-collection-meta', collection],
    queryFn: () =>
      client.request<{ data: CollectionMeta }>(get(`/collections/${collection}`)).then((r) => r.data),
    staleTime: 10 * 60_000,
    retry: false
  })
  const nonHidden = useMemo(() => (meta?.fields ?? []).filter((f) => !f.hidden), [meta])
  // Per-collection browser settings (nivaro_collections.browser_config) —
  // editable via PATCH /collections/:collection {browser_config: {...}}.
  const bc = meta?.browser_config ?? {}
  const enableCheckboxes = bc.checkbox_selection !== false
  const enableActions = bc.show_actions !== false
  const canCreate = showCreate && bc.allow_create !== false
  // Layout choices for the New-item button (slug-opt-in, same rules as the
  // classic admin browser) — plain button when none exist.
  const newItemLayouts = useNewItemLayouts(canCreate && !meta?.singleton ? collection : null)
  const [newItemMenuOpen, setNewItemMenuOpen] = useState(false)
  const newItemMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!newItemMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!newItemMenuRef.current?.contains(e.target as Node)) setNewItemMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [newItemMenuOpen])
  const effPageSize = bc.page_size && bc.page_size > 0 ? Math.min(bc.page_size, 200) : pageSize
  const effQuickFilters = quickFilters.length > 0 ? quickFilters : (bc.quick_filters ?? [])

  useEffect(() => {
    if (scopeGateOpen) return
    if (!scopesReady) return
    // quick-filter defs may come from browser_config — wait for meta unless the
    // host passed static quickFilters
    if (quickFilters.length === 0 && !meta) return
    const scopes = myScopes
    const hasSeedMaterial =
      Object.values(scopes?.defaults ?? {}).some((v) => v.length > 0) ||
      Object.values(scopes?.restricted ?? {}).some((v) => v.length > 0)
    if (!scopes || effQuickFilters.length === 0 || !hasSeedMaterial) {
      setScopeGateOpen(true)
      return
    }
    void (async () => {
      const seedSel: Record<string, Array<string | number>> = {}
      for (const qf of effQuickFilters) {
        const dim = matchScopeDimension(scopes, { key: qf.key, collection: qf.collection })
        if (!dim) continue
        const ids = effectiveScopeSeedIds(scopes, dim.name)
        if (ids.length === 0) continue
        const vals = await translateScopeValues(client as never, dim, ids, qf.value_field).catch(
          () => [] as Array<string | number>
        )
        if (vals.length > 0) seedSel[qf.key] = vals
      }
      if (Object.keys(seedSel).length > 0) {
        const merge = (prev: Record<string, Array<string | number>>) => {
          const next = { ...prev }
          for (const [k, v] of Object.entries(seedSel)) {
            if (!((next[k]?.length ?? 0) > 0)) next[k] = v
          }
          return next
        }
        setQuickSel(merge)
        setAppliedQuick(merge)
        setScopeSeededKeys(new Set(Object.keys(seedSel)))
      }
      // batched with the seed setters — first items fetch is already filtered
      setScopeGateOpen(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeGateOpen, scopesReady, myScopes, meta, effQuickFilters])

  const restrictedIdsFor = (qf: QuickFilterDef): Array<string | number> | undefined => {
    const dim = matchScopeDimension(myScopes, { key: qf.key, collection: qf.collection })
    const ids = dim ? (myScopes?.restricted[dim.name] ?? []) : []
    return ids.length > 0 ? ids : undefined
  }
  const fieldByName = useMemo(() => new Map(nonHidden.map((f) => [f.field, f])), [nonHidden])
  const relations = meta?.relations ?? []
  const effectiveColumns = useMemo(() => {
    const wanted = displayColumns ?? nonHidden.slice(0, 7).map((f) => f.field)
    // Dotted keys are related-value columns resolved server-side; plain keys
    // must exist on the collection.
    return wanted.filter((k) => k.includes('.') || fieldByName.has(k))
  }, [displayColumns, nonHidden, fieldByName])

  // ── Column pinning ─────────────────────────────────────────────────────────
  // Per-column pin (left/right/none), incl. the synthetic State / Owners /
  // Actions columns ('__state__' / '__owners__' / '__actions__'). null =
  // untouched → historic default of the first visible column pinned left.
  // Persisted in saved-view column entries as `pin` (synthetic keys ride as
  // {key, pin}-only entries — applyView drops them from displayColumns).
  const [columnPins, setColumnPins] = useState<Record<string, 'left' | 'right'> | null>(null)
  const effectivePins = useMemo<Record<string, 'left' | 'right'>>(
    () => columnPins ?? (effectiveColumns[0] ? { [effectiveColumns[0]]: 'left' } : {}),
    [columnPins, effectiveColumns]
  )
  const pinOf = (k: string): 'left' | 'right' | undefined => effectivePins[k]
  const cyclePin = (k: string) => {
    const next = { ...effectivePins }
    const cur = next[k]
    if (!cur) next[k] = 'left'
    else if (cur === 'left') next[k] = 'right'
    else delete next[k]
    setColumnPins(next)
  }

  /** Header label: user rename → dotted breadcrumb → title-cased field. */
  const columnLabel = (key: string) =>
    columnLabels[key] ??
    (key.includes('.')
      ? key.split('.').map(titleCase).join(' › ')
      : key === 'id'
        ? 'ID'
        : titleCase(key))

  // ── Alias (O2M/M2M) + dotted related columns → bulk resolve-paths ─────────
  const aliasInfos = useMemo(
    () =>
      effectiveColumns
        .filter((k) => !k.includes('.'))
        .map((k) => ({ field: k, info: aliasRelationFor(relations, collection, k) }))
        .filter((x): x is { field: string; info: NonNullable<ReturnType<typeof aliasRelationFor>> } => !!x.info),
    [effectiveColumns, fieldByName, relations, collection]
  )
  // Metas needed to derive each alias target's label field: the O2M child
  // collection directly, plus junction metas (to find the M2M sibling).
  const neededMetaCols = useMemo(
    () => [...new Set(aliasInfos.map((a) => a.info.relation.many_collection ?? '').filter(Boolean))],
    [aliasInfos]
  )
  const neededMetaQueries = useQueries({
    queries: neededMetaCols.map((c) => ({
      queryKey: ['cbv-collection-meta', c],
      queryFn: () =>
        client.request<{ data: CollectionMeta }>(get(`/collections/${c}`)).then((r) => r.data),
      staleTime: 10 * 60_000,
      retry: false
    }))
  })
  const metaMap = useMemo(() => {
    const m = new Map<string, CollectionMeta | undefined>()
    neededMetaCols.forEach((c, i) => m.set(c, neededMetaQueries[i]?.data))
    return m
  }, [neededMetaCols, neededMetaQueries])
  const m2mTargetCols = useMemo(
    () =>
      [
        ...new Set(
          aliasInfos
            .filter((a) => a.info.kind === 'm2m')
            .map((a) => {
              const junction = a.info.relation.many_collection ?? ''
              const jm = metaMap.get(junction)
              const sibling = jm?.relations.find(
                (r) => r.many_collection === junction && r.many_field === a.info.relation.junction_field
              )
              return sibling?.one_collection ?? ''
            })
            .filter(Boolean)
        )
      ],
    [aliasInfos, metaMap]
  )
  const targetMetaQueries = useQueries({
    queries: m2mTargetCols.map((c) => ({
      queryKey: ['cbv-collection-meta', c],
      queryFn: () =>
        client.request<{ data: CollectionMeta }>(get(`/collections/${c}`)).then((r) => r.data),
      staleTime: 10 * 60_000,
      retry: false
    }))
  })
  const targetMetaMap = useMemo(() => {
    const m = new Map<string, CollectionMeta | undefined>()
    m2mTargetCols.forEach((c, i) => m.set(c, targetMetaQueries[i]?.data))
    return m
  }, [m2mTargetCols, targetMetaQueries])
  /** alias field → dotted resolve path (`regions.short_name`). */
  const aliasPathByField = useMemo(() => {
    const out: Record<string, string> = {}
    for (const a of aliasInfos) {
      const junction = a.info.relation.many_collection ?? ''
      if (a.info.kind === 'o2m') {
        out[a.field] = `${a.field}.${labelFieldFor(metaMap.get(junction))}`
      } else {
        const jm = metaMap.get(junction)
        const sibling = jm?.relations.find(
          (r) => r.many_collection === junction && r.many_field === a.info.relation.junction_field
        )
        const target = sibling?.one_collection ?? ''
        out[a.field] = `${a.field}.${labelFieldFor(target ? targetMetaMap.get(target) : undefined)}`
      }
    }
    return out
  }, [aliasInfos, metaMap, targetMetaMap])
  /** alias field → filter target: M2M = related collection (id dropdown),
   *  O2M = text filter routed through the alias label path. */
  const aliasTargetByField = useMemo(() => {
    const out: Record<string, { kind: 'm2m'; target: string } | { kind: 'o2m' }> = {}
    for (const a of aliasInfos) {
      if (a.info.kind === 'o2m') {
        out[a.field] = { kind: 'o2m' }
      } else {
        const junction = a.info.relation.many_collection ?? ''
        const jm = metaMap.get(junction)
        const sibling = jm?.relations.find(
          (r) => r.many_collection === junction && r.many_field === a.info.relation.junction_field
        )
        if (sibling?.one_collection) out[a.field] = { kind: 'm2m', target: sibling.one_collection }
      }
    }
    return out
  }, [aliasInfos, metaMap])

  // ── Rows (admin dialect: search + conditions + total) ─────────────────────
  const debouncedColFilters = useDebounced(colFilters, 350)
  const conditionsParam = useMemo(() => {
    const conds: Array<{ path: string[]; op: string; value: unknown }> = []
    for (const f of filters) {
      const isDateType = f.fieldType === 'date' || f.fieldType === 'datetime' || f.fieldType === 'timestamp'
      if (f.op === '_between') {
        const [a, b] = String(f.value).split('..')
        if (a) conds.push({ path: f.path, op: '_gte', value: a })
        if (b) conds.push({ path: f.path, op: '_lte', value: isDateType ? `${b}T23:59:59` : b })
        continue
      }
      const op = f.op.includes(':') ? f.op.split(':')[0] : f.op
      let value: unknown = f.op.includes(':') ? f.op.split(':')[1] : f.value || null
      if (f.fieldType === 'boolean' && (value === 'true' || value === 'false')) value = value === 'true'
      conds.push({ path: f.path, op, value })
    }
    for (const qf of effQuickFilters) {
      const vals = appliedQuick[qf.key] ?? []
      if (vals.length === 0) continue
      if (qf.or_paths?.length) {
        ;(conds as unknown[]).push({ or: qf.or_paths.map((p) => ({ path: p, op: '_in', value: vals })) })
      } else {
        conds.push({ path: qf.path, op: '_in', value: vals })
      }
    }
    for (const [key, f] of Object.entries(debouncedColFilters)) {
      if (!f) continue
      if (f.kind === 'in' && f.value.length) conds.push({ path: [key], op: '_in', value: f.value })
      else if (f.kind === 'state' && f.value.length) conds.push({ path: ['$state'], op: '_in', value: f.value })
      else if (f.kind === 'text' && f.value.trim())
        conds.push({ path: f.path, op: '_contains', value: f.value.trim() })
      else if (f.kind === 'num' && f.value !== '' && !Number.isNaN(Number(f.value)))
        conds.push({ path: [key], op: f.op, value: Number(f.value) })
      else if (f.kind === 'bool') conds.push({ path: [key], op: '_eq', value: f.value === 'true' })
      else if (f.kind === 'date' && f.value) {
        const r = f.value.startsWith('r:')
          ? (() => {
              const [a, b] = f.value.slice(2).split('..')
              return a ? { from: a, to: b || a } : null
            })()
          : dateRangeFor(f.value)
        if (r) {
          conds.push({ path: [key], op: '_gte', value: r.from })
          conds.push({ path: [key], op: '_lte', value: `${r.to}T23:59:59` })
        }
      }
    }
    for (const c of linkConds) conds.push({ path: c.path, op: c.op, value: c.value })
    for (const ex of cellExcludes) {
      // OR with _null: MSSQL's != / NOT LIKE silently drop NULL rows, and an
      // exclusion must keep records that have no value at all.
      ;(conds as unknown[]).push({
        or: [
          { path: ex.path, op: ex.op, value: ex.value },
          { path: ex.path, op: '_null', value: true }
        ]
      })
    }
    return conds.length > 0 ? JSON.stringify(conds) : undefined
  }, [filters, effQuickFilters, appliedQuick, debouncedColFilters, linkConds, cellExcludes])
  // Any filter change resets to page 1 (the query key already refetches).
  const prevCondRef = useRef(conditionsParam)
  useEffect(() => {
    if (prevCondRef.current !== conditionsParam) {
      prevCondRef.current = conditionsParam
      setPage(1)
    }
  }, [conditionsParam])

  const {
    data: itemsRes,
    isLoading,
    isFetching,
    refetch,
    error
  } = useQuery({
    queryKey: ['cbv-items', collection, appliedSearch, sort, groupBy ? 'grouped' : page, groupBy ? 500 : effPageSize, conditionsParam],
    queryFn: () =>
      client.request<{ data: Array<Record<string, unknown>>; total: number }>(
        get(`/items/${collection}`, {
          limit: groupBy ? 500 : effPageSize,
          page: groupBy ? 1 : page,
          ...(appliedSearch ? { search: appliedSearch } : {}),
          ...(sort ? { sort } : {}),
          ...(conditionsParam ? { conditions: conditionsParam } : {})
        })
      ),
    enabled: !!collection && scopeGateOpen,
    placeholderData: (prev) => prev,
    retry: false
  })
  const rows = aiResult ? aiResult.rows : (itemsRes?.data ?? [])
  const total = aiResult ? aiResult.total : (itemsRes?.total ?? 0)
  const totalPages = Math.max(1, Math.ceil(total / effPageSize))

  // ── At-risk row highlighting (nivaro_at_risk_rules) ───────────────────────
  // One rules probe per collection; when any active rule exists, the visible
  // page's ids run through POST /at-risk/evaluate (cap 500 ≫ page size) and
  // matching rows tint via the rule's highlight_color.
  const { data: riskRules = [] } = useQuery({
    queryKey: ['cbv-risk-rules', collection],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number }> }>(
          get('/at-risk/rules/active', { collection })
        )
        .then((r) => r.data ?? [])
        .catch(() => []),
    enabled: !!collection,
    staleTime: 60_000,
    retry: false
  })
  const riskIdsKey = rows.map((r) => String(r.id)).join(',')
  const { data: riskMap = {} as Record<string, { at_risk: boolean; rule: string; color: string }> } =
    useQuery({
    queryKey: ['cbv-risk', collection, riskIdsKey],
    queryFn: () =>
      client
        .request<{ data: Record<string, { at_risk: boolean; rule: string; color: string }> }>(
          post('/at-risk/evaluate', {
            collection,
            ids: rows.map((r) => String(r.id))
          })
        )
        .then((r) => r.data ?? {})
        .catch(() => ({}) as Record<string, { at_risk: boolean; rule: string; color: string }>),
    enabled: !!collection && riskRules.length > 0 && rows.length > 0,
    staleTime: 30_000,
    retry: false
  })

  // Ids of the rows currently rendered — pipeline state, owners and at-risk
  // are all resolved for just this page rather than the whole collection.
  const pageIdsKey = rows.map((r) => String(r.id)).join(',')

  // ── Pipeline state column + bulk transitions ──────────────────────────────
  // Scoped to the visible page's ids: the unscoped endpoint returns every
  // instance in the collection (13s on 88k workflows) to fill 25 state badges.
  const { data: pipelineData } = useQuery({
    queryKey: ['cbv-pipeline-instances', collection, pageIdsKey],
    queryFn: () =>
      client
        .request<{ data: PipelineInstancesMap | null }>(
          get(`/pipelines/instances/${collection}`, pageIdsKey ? { ids: pageIdsKey } : undefined)
        )
        .then((r) => r.data),
    enabled: !!collection && pageIdsKey.length > 0,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: false
  })
  const templateId = pipelineData?.binding?.template
  const { data: pipelineTemplate } = useQuery({
    queryKey: ['cbv-pipeline-template', templateId],
    queryFn: () =>
      client
        .request<{
          data: {
            transitions: Array<{ id: string; label: string }>
            states?: Array<{ id: string; key: string; label: string; color?: string | null }>
          }
        }>(get(`/pipelines/${templateId}`))
        .then((r) => r.data),
    enabled: !!templateId,
    retry: false
  })

  // ── Owners column (pipeline-bound collections): one batched engine pass ───
  const hasPipelineBinding = !!pipelineData?.binding
  const { data: ownersByItem } = useQuery({
    queryKey: ['cbv-owners', collection, pageIdsKey],
    queryFn: () =>
      client
        .request<{ data: Record<string, Array<{ id: string; name: string }>> }>(
          post(`/pipelines/instance/${collection}/owners/batch`, {
            ids: pageIdsKey.split(',').filter(Boolean)
          })
        )
        .then((r) => r.data ?? {}),
    enabled: hasPipelineBinding && pageIdsKey.length > 0,
    staleTime: 60_000,
    retry: false
  })

  // ── Bulk resolve of dotted + alias column values for the current page ─────
  const dottedCols = useMemo(() => effectiveColumns.filter((k) => k.includes('.')), [effectiveColumns])
  const resolveList = useMemo(
    () => [...new Set([...dottedCols, ...Object.values(aliasPathByField)])].slice(0, 20),
    [dottedCols, aliasPathByField]
  )
  const rowIdsKey = rows.map((r) => String(r.id)).join(',')
  const { data: resolvedData } = useQuery({
    queryKey: ['cbv-resolved', collection, rowIdsKey, resolveList.join(',')],
    queryFn: () =>
      client
        .request<{
          data: {
            rows: Record<string, Record<string, { value: string; ids?: string[] }>>
            targets?: Record<string, string | null>
          }
        }>(get(`/items/${collection}/resolve-paths`, { ids: rowIdsKey, paths: resolveList.join(',') }))
        .then((r) => r.data ?? { rows: {}, targets: {} }),
    enabled: rows.length > 0 && resolveList.length > 0,
    staleTime: 30_000,
    retry: false
  })
  const resolvedFor = (rowId: unknown, key: string): string | null => {
    const path = key.includes('.') ? key : aliasPathByField[key]
    if (!path) return null
    const v = resolvedData?.rows?.[String(rowId)]?.[path]?.value
    return v == null || v === '' ? '—' : v
  }
  const resolvedTargetFor = (key: string): string | null => {
    const path = key.includes('.') ? key : aliasPathByField[key]
    return path ? (resolvedData?.targets?.[path] ?? null) : null
  }
  const resolvedDrill = (rowId: unknown, key: string): { target: string; id: string } | null => {
    const path = key.includes('.') ? key : aliasPathByField[key]
    if (!path) return null
    const target = resolvedData?.targets?.[path]
    const ids = resolvedData?.rows?.[String(rowId)]?.[path]?.ids ?? []
    if (!target || isSystemCol(target) || ids.length === 0) return null
    return { target, id: String(ids[0]) }
  }
  const isResolvedCol = (key: string) => key.includes('.') || key in aliasPathByField

  // ── Column-level filters (all server-side via conditions) ─────────────────
  type ColFilterKind =
    | { kind: 'in'; target: string }
    | { kind: 'text'; path: string[] }
    | { kind: 'num' }
    | { kind: 'bool' }
    | { kind: 'date' }
    | { kind: 'enum' }
    | null
  const classifyColFilter = (key: string): ColFilterKind => {
    if (key.includes('.')) return { kind: 'text', path: key.split('.') }
    const rel = isM2OField(relations, collection, key)
    if (rel?.one_collection) {
      if (isSystemCol(rel.one_collection) && rel.one_collection !== 'nivaro_users') return null
      return { kind: 'in', target: rel.one_collection }
    }
    const at = aliasTargetByField[key]
    if (at) {
      if (at.kind === 'm2m') return { kind: 'in', target: at.target }
      const path = aliasPathByField[key]
      return path ? { kind: 'text', path: path.split('.') } : null
    }
    const f = fieldByName.get(key)
    if (!f) return null
    // Virtual computed fields have no physical column — not SQL-filterable.
    // Stored ones (computed_store) are real columns: filter/sort freely.
    if (f.computed_formula && !f.computed_store) return null
    if (f.type === 'integer' || f.type === 'decimal' || f.type === 'float') return { kind: 'num' }
    if (f.type === 'boolean') return { kind: 'bool' }
    if (f.type === 'date' || f.type === 'datetime' || f.type === 'timestamp') return { kind: 'date' }
    if (f.interface === 'select-dropdown') return { kind: 'enum' }
    if (f.type === 'string' || f.type === 'text') return { kind: 'text', path: [key] }
    return null
  }
  const setColFilter = (key: string, v: ColFilterVal | null) =>
    setColFilters((s) => {
      const next = { ...s }
      if (v) next[key] = v
      else delete next[key]
      return next
    })
  /** "Filter to this value" from a right-clicked cell — routes through the
   *  column-filter machinery so each column kind keeps its own semantics. */
  const filterToCell = (m: NonNullable<typeof cellMenu>) => {
    const { key, row, cellText } = m
    const id = row.id as string | number
    if (key === '__state__') {
      const st = pipelineData?.instances?.[String(id)]
      if (!st?.state_key) return
      const cur = colFilters.__state__
      const existing = cur?.kind === 'state' ? cur.value : []
      setColFilter('__state__', { kind: 'state', value: [...new Set([...existing, st.state_key])] })
      return
    }
    const cls = classifyColFilter(key)
    if (!cls) return
    if (cls.kind === 'in') {
      const rel = isM2OField(relations, collection, key)
      const vals: Array<string | number> = rel
        ? row[key] != null
          ? [row[key] as string | number]
          : []
        : ((resolvedData?.rows?.[String(id)]?.[aliasPathByField[key]]?.ids ?? []) as Array<
            string | number
          >)
      if (vals.length === 0) return
      const cur = colFilters[key]
      const existing = cur?.kind === 'in' ? cur.value : []
      setColFilter(key, { kind: 'in', value: [...new Set([...existing, ...vals])] })
      return
    }
    if (cls.kind === 'enum') {
      if (row[key] == null || row[key] === '') return
      const cur = colFilters[key]
      const existing = cur?.kind === 'in' ? cur.value : []
      setColFilter(key, { kind: 'in', value: [...new Set([...existing, row[key] as string])] })
      return
    }
    if (cls.kind === 'text') {
      const v = key.includes('.') || key in aliasPathByField ? resolvedFor(id, key) : String(row[key] ?? '')
      if (v && v !== '—') setColFilter(key, { kind: 'text', value: v, path: cls.path })
      return
    }
    if (cls.kind === 'num') {
      if (row[key] == null || row[key] === '') return
      setColFilter(key, { kind: 'num', op: '_eq', value: String(row[key]) })
      return
    }
    if (cls.kind === 'bool') {
      if (row[key] == null) return
      setColFilter(key, { kind: 'bool', value: row[key] ? 'true' : 'false' })
      return
    }
    if (cls.kind === 'date') {
      const d = String(row[key] ?? '').slice(0, 10)
      if (d) setColFilter(key, { kind: 'date', value: `r:${d}..${d}` })
    }
    void cellText
  }
  /** Which cells can offer "Exclude" — value-equality kinds only. */
  const canExcludeCell = (key: string, row: Record<string, unknown>): boolean => {
    if (key === '__state__') return false
    const cls = classifyColFilter(key)
    if (!cls) return false
    if (cls.kind === 'in') return !!isM2OField(relations, collection, key) && row[key] != null
    if (cls.kind === 'enum' || cls.kind === 'num') return row[key] != null && row[key] !== ''
    if (cls.kind === 'text') return true
    return false
  }
  const excludeCell = (m: NonNullable<typeof cellMenu>) => {
    const { key, row, cellText } = m
    const id = row.id as string | number
    const cls = classifyColFilter(key)
    if (!cls) return
    let entry: (typeof cellExcludes)[number] | null = null
    const eid = `${key}:${Date.now().toString(36)}`
    if (cls.kind === 'in' && isM2OField(relations, collection, key) && row[key] != null) {
      entry = { id: eid, path: [key], op: '_neq', value: row[key], label: cellText, field: key }
    } else if ((cls.kind === 'enum' || cls.kind === 'num') && row[key] != null && row[key] !== '') {
      entry = { id: eid, path: [key], op: '_neq', value: row[key], label: cellText, field: key }
    } else if (cls.kind === 'text') {
      const v = key.includes('.') || key in aliasPathByField ? resolvedFor(id, key) : String(row[key] ?? '')
      if (v && v !== '—') entry = { id: eid, path: cls.path, op: '_ncontains', value: v, label: v, field: key }
    }
    if (entry) setCellExcludes((prev) => [...prev, entry])
  }
  const renderColFilter = (key: string) => {
    const cls = classifyColFilter(key)
    if (!cls) return null
    const cur = colFilters[key]
    if (cls.kind === 'in')
      return (
        <RelationColFilter
          target={cls.target}
          selected={cur?.kind === 'in' ? cur.value : []}
          onChange={(vals) => setColFilter(key, vals.length ? { kind: 'in', value: vals } : null)}
        />
      )
    if (cls.kind === 'enum')
      return (
        <EnumColFilter
          collection={collection}
          field={key}
          selected={cur?.kind === 'in' ? cur.value : []}
          onChange={(vals) => setColFilter(key, vals.length ? { kind: 'in', value: vals } : null)}
        />
      )
    if (cls.kind === 'text')
      return (
        <input
          value={cur?.kind === 'text' ? cur.value : ''}
          onChange={(e) =>
            setColFilter(key, e.target.value ? { kind: 'text', value: e.target.value, path: cls.path } : null)
          }
          placeholder='Filter…'
          aria-label={`Filter ${key}`}
          className='h-6 w-full min-w-[64px] rounded border border-slate-200 bg-white px-1.5 text-[11px] font-normal normal-case tracking-normal outline-none focus:border-[#00ceff80] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
        />
      )
    if (cls.kind === 'num') {
      const op = cur?.kind === 'num' ? cur.op : '_eq'
      const val = cur?.kind === 'num' ? cur.value : ''
      return (
        <span className='flex items-center gap-0.5'>
          <SimpleSelectXs
            value={op}
            onChange={(v) => setColFilter(key, { kind: 'num', op: v, value: val })}
            options={NUM_FILTER_OPS.map((o) => ({ value: o.value, label: o.label }))}
            ariaLabel={`Filter operator ${key}`}
          />
          <input
            type='number'
            value={val}
            onChange={(e) =>
              setColFilter(key, e.target.value ? { kind: 'num', op, value: e.target.value } : null)
            }
            aria-label={`Filter value ${key}`}
            className='h-6 w-full min-w-[52px] rounded border border-slate-200 bg-white px-1.5 text-[11px] font-normal outline-none focus:border-[#00ceff80] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
          />
        </span>
      )
    }
    if (cls.kind === 'bool')
      return (
        <SimpleSelectXs
          value={cur?.kind === 'bool' ? cur.value : ''}
          onChange={(v) =>
            setColFilter(key, v ? { kind: 'bool', value: v as 'true' | 'false' } : null)
          }
          options={[
            { value: '', label: 'All' },
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' }
          ]}
          ariaLabel={`Filter ${key}`}
          className='w-full'
        />
      )
    if (cls.kind === 'date')
      return (
        <DateColFilter
          value={cur?.kind === 'date' ? cur.value : ''}
          onChange={(v) => setColFilter(key, v ? { kind: 'date', value: v } : null)}
        />
      )
    return null
  }
  const anyColFilterable = effectiveColumns.some((k) => classifyColFilter(k) != null)
  const isNumericCol = (key: string) => {
    if (columnFormats[key]?.type === 'number') return true
    if (key.includes('.') || key in aliasPathByField) return false
    // Relation FKs are integers but render labels — never right-align those.
    if (isM2OField(relations, collection, key)) return false
    const t = fieldByName.get(key)?.type
    return t === 'integer' || t === 'decimal' || t === 'float'
  }
  /** Apply a column's ColumnFormatConfig to a resolved display string
   *  (multi-value aware — preserves ', ' joins and '+N more'). */
  const fmtCell = (val: string, key: string) => {
    const cfg = columnFormats[key]
    return cfg && val && val !== '—' ? formatMultiValue(val, cfg) : val
  }

  // ── Saved views ───────────────────────────────────────────────────────────
  const { data: views = [] } = useQuery({
    queryKey: ['cbv-views', collection],
    queryFn: () =>
      client.request<{ data: SavedView[] }>(get('/saved-views', { collection })).then((r) => r.data ?? []),
    staleTime: 30_000
  })
  const invalidateViews = () => qc.invalidateQueries({ queryKey: ['cbv-views', collection] })
  const applyView = (v: SavedView) => {
    setActiveViewId(v.id)
    setFilters(v.filters ?? [])
    setSort(v.sort ?? '')
    if (v.columns?.length) {
      const keys = v.columns.map(viewColumnKey)
      const valid = keys.filter((k) => k.includes('.') || fieldByName.has(k))
      if (valid.length > 0) setDisplayColumns(valid)
      const labels: Record<string, string> = {}
      const formats: Record<string, ColumnFormatConfig> = {}
      const pins: Record<string, 'left' | 'right'> = {}
      for (const c of v.columns) {
        if (typeof c !== 'string' && c.label) labels[c.key] = c.label
        if (typeof c !== 'string' && c.format) formats[c.key] = c.format
        if (typeof c !== 'string' && c.pin) pins[c.key] = c.pin
      }
      setColumnLabels(labels)
      setColumnFormats(formats)
      setColumnPins(Object.keys(pins).length ? pins : null)
    } else {
      setColumnPins(null)
    }
    setPage(1)
  }
  // "Default" = the collection's server-set default view when one exists,
  // else the built-in baseline (initialColumns / first-N fields).
  const clearView = () => {
    const def = views.find((v) => v.is_default)
    if (def) {
      applyView(def)
      return
    }
    setActiveViewId(null)
    setFilters([])
    setSort(initialSort ?? '')
    setDisplayColumns(initialColumns ?? null)
    setColumnLabels({})
    setColumnFormats({})
    setColumnPins(null)
    setPage(1)
  }
  const viewState = () => ({
    filters,
    sort,
    columns: [
      ...effectiveColumns.map((k) => {
        const label = columnLabels[k]
        const format = columnFormats[k]
        const pin = effectivePins[k]
        if (!label && !format && !pin) return k
        return {
          key: k,
          ...(label ? { label } : {}),
          ...(format ? { format } : {}),
          ...(pin ? { pin } : {})
        }
      }),
      // Synthetic columns (State/Owners/Actions) persist pins as pin-only
      // entries; applyView drops them from the display-column list.
      ...['__state__', '__owners__', '__actions__']
        .filter((k) => effectivePins[k])
        .map((k) => ({ key: k, pin: effectivePins[k] }))
    ]
  })
  // Auto-apply the collection's server-set default view once per mount —
  // admin edits it via POST/PATCH /saved-views with is_default.
  useEffect(() => {
    if (defaultAppliedRef.current || views.length === 0 || nonHidden.length === 0) return
    defaultAppliedRef.current = true
    const def = views.find((v) => v.is_default)
    if (def && activeViewId == null) applyView(def)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, nonHidden])
  const saveView = useMutation({
    mutationFn: () =>
      client.request<{ data: SavedView }>(
        post('/saved-views', { collection, name: saveName.trim(), ...viewState() })
      ),
    onSuccess: (r) => {
      setSaveOpen(false)
      setSaveName('')
      setActiveViewId(r.data.id)
      invalidateViews()
    }
  })
  const updateView = useMutation({
    mutationFn: (id: number) => client.request(patch(`/saved-views/${id}`, viewState())),
    onSuccess: invalidateViews
  })
  const setDefaultView = useMutation({
    mutationFn: ({ id, on }: { id: number; on: boolean }) =>
      client.request(patch(`/saved-views/${id}`, { is_default: on })),
    onSuccess: invalidateViews
  })
  // "Set default" in the column picker: write the CURRENT state onto the
  // collection's is_default view (creating one named "Default" if none).
  const upsertDefault = useMutation({
    mutationFn: () => {
      const def = views.find((v) => v.is_default)
      return def
        ? client.request(patch(`/saved-views/${def.id}`, { ...viewState(), is_default: true }))
        : client.request<{ data: SavedView }>(
            post('/saved-views', { collection, name: 'Default', is_default: true, ...viewState() })
          )
    },
    onSuccess: () => {
      setColsOpen(false)
      invalidateViews()
    }
  })
  const deleteRow = useMutation({
    mutationFn: (id: string | number) => client.request(del(`/items/${collection}/${id}`)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cbv-items', collection] })
  })
  const deleteView = useMutation({
    mutationFn: (id: number) => client.request(del(`/saved-views/${id}`)),
    onSuccess: (_d, id) => {
      if (activeViewId === id) clearView()
      invalidateViews()
    }
  })

  // ── View subscriptions — "tell me what enters this view" ──────────────────
  // Backed by /view-subscriptions (migration 209): the nightly digest diffs
  // the view's matched-id set and reports records that entered since the last
  // run. The bell on an active view pill toggles it.
  const { data: viewSubs = [] } = useQuery({
    queryKey: ['cbv-view-subs'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number; view_id: number }> }>(get('/view-subscriptions'))
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 60_000
  })
  const subForView = (viewId: number) => viewSubs.find((s) => s.view_id === viewId)
  const toggleViewSub = useMutation({
    mutationFn: async (viewId: number) => {
      const existing = subForView(viewId)
      if (existing) return client.request(del(`/view-subscriptions/${existing.id}`))
      return client.request(post('/view-subscriptions', { view_id: viewId, digest: 'daily' }))
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cbv-view-subs'] })
  })

  // ── CSV export (current filter, up to 2000 rows) ──────────────────────────
  const exportCsv = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const all = await client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${collection}`, {
            limit: 2000,
            ...(appliedSearch ? { search: appliedSearch } : {}),
            ...(sort ? { sort } : {}),
            ...(conditionsParam ? { conditions: conditionsParam } : {})
          })
        )
        .then((r) => r.data ?? [])
      const cols = effectiveColumns
      // Resolve related-value columns for the export set (500-id server cap).
      let exportResolved: Record<string, Record<string, { value: string }>> = {}
      if (resolveList.length > 0) {
        try {
          exportResolved = await client
            .request<{ data: { rows: Record<string, Record<string, { value: string }>> } }>(
              get(`/items/${collection}/resolve-paths`, {
                ids: all.slice(0, 500).map((r) => String(r.id)).join(','),
                paths: resolveList.join(',')
              })
            )
            .then((r) => r.data?.rows ?? {})
        } catch {
          exportResolved = {}
        }
      }
      const esc = (v: unknown) => {
        const s = v == null ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }
      const cellFor = (r: Record<string, unknown>, c: string) => {
        const cfg = columnFormats[c]
        if (c.includes('.') || c in aliasPathByField) {
          const path = c.includes('.') ? c : aliasPathByField[c]
          const v = exportResolved[String(r.id)]?.[path]?.value ?? ''
          return cfg && v ? formatMultiValue(v, cfg) : v
        }
        const v = r[c]
        return cfg && v != null ? formatValue(String(v), cfg) : v
      }
      const lines = [
        ['id', ...cols.map((c) => columnLabel(c))].map(esc).join(','),
        ...all.map((r) => [r.id, ...cols.map((c) => cellFor(r, c))].map(esc).join(','))
      ]
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${collection}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  const openRow = (id: string | number) => {
    if (onOpenItem) onOpenItem(id)
    else openTarget({ collection, itemId: String(id) })
  }

  const nextSort = (field: string) => {
    if (sort === field) setSort(`-${field}`)
    else if (sort === `-${field}`) setSort('')
    else setSort(field)
    setPage(1)
  }

  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.includes(r.id as string))
  const toggleAll = () =>
    setSelectedIds(
      allSelected
        ? selectedIds.filter((id) => !rows.some((r) => r.id === id))
        : [...new Set([...selectedIds, ...rows.map((r) => r.id as string | number)])]
    )
  const toggleRow = (id: string | number) =>
    setSelectedIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const start = total === 0 ? 0 : (page - 1) * effPageSize + 1
  const end = Math.min(page * effPageSize, total)
  const hasPipeline = !!pipelineData?.instances
  const extraCols =
    (enableCheckboxes ? 1 : 0) + (hasPipeline ? 2 : 0) + (enableActions ? 1 : 0)

  // ── Pinned-column layout ───────────────────────────────────────────────────
  // Left-pinned columns render first (checkbox always hard-left), right-pinned
  // last; sticky offsets come from live header-cell width measurement.
  type CbvColDesc = { key: string; kind: 'data' | 'state' | 'owners' | 'actions' }
  const baseColDescs: CbvColDesc[] = [
    ...effectiveColumns.map((k) => ({ key: k, kind: 'data' as const })),
    ...(hasPipeline
      ? [
          { key: '__state__', kind: 'state' as const },
          { key: '__owners__', kind: 'owners' as const }
        ]
      : []),
    ...(enableActions ? [{ key: '__actions__', kind: 'actions' as const }] : [])
  ]
  const orderedCols: CbvColDesc[] = [
    ...baseColDescs.filter((c) => pinOf(c.key) === 'left'),
    ...baseColDescs.filter((c) => !pinOf(c.key)),
    ...baseColDescs.filter((c) => pinOf(c.key) === 'right')
  ]
  // Which columns make sense as group headers: the State pill, resolved
  // relation columns (already display labels), and plain non-FK data columns.
  // Raw M2O FK columns are excluded — the header would show an internal id;
  // add the resolved related column and group by that instead.
  const groupableCols: Array<{ key: string; label: string }> = [
    ...(hasPipeline ? [{ key: '__state__', label: 'State' }] : []),
    ...effectiveColumns
      .filter((k) => isResolvedCol(k) || !isM2OField(relations, collection, k))
      .map((k) => ({ key: k, label: columnLabel(k) }))
  ]
  const groupValueOf = (row: Record<string, unknown>): string => {
    if (!groupBy) return ''
    const id = row.id as string | number
    if (groupBy === '__state__') {
      const st = pipelineData?.instances?.[String(id)]
      return st?.state_label ?? st?.state_key ?? '(no state)'
    }
    if (isResolvedCol(groupBy)) return resolvedFor(id, groupBy) || '(empty)'
    const v = row[groupBy]
    if (v === null || v === undefined || v === '') return '(empty)'
    if (typeof v === 'boolean') return v ? 'Yes' : 'No'
    return fmtCell(String(v), groupBy) || String(v)
  }
  type CbvEntry =
    | { kind: 'header'; gkey: string; label: string; count: number }
    | { kind: 'row'; row: Record<string, unknown> }
  const renderList: CbvEntry[] = (() => {
    if (!groupBy) return rows.map((row) => ({ kind: 'row' as const, row }))
    const buckets = new Map<string, Array<Record<string, unknown>>>()
    for (const row of rows) {
      const g = groupValueOf(row)
      const arr = buckets.get(g) ?? []
      arr.push(row)
      buckets.set(g, arr)
    }
    const keys = [...buckets.keys()].sort((a, b) => {
      if (a === '(empty)') return 1
      if (b === '(empty)') return -1
      return a.localeCompare(b, undefined, { numeric: true })
    })
    const out: CbvEntry[] = []
    for (const g of keys) {
      const bucket = buckets.get(g) ?? []
      out.push({ kind: 'header', gkey: g, label: g, count: bucket.length })
      if (!collapsedGroups.has(g)) for (const row of bucket) out.push({ kind: 'row', row })
    }
    return out
  })()

  const leftPinnedKeys = orderedCols.filter((c) => pinOf(c.key) === 'left').map((c) => c.key)
  const rightPinnedKeys = orderedCols.filter((c) => pinOf(c.key) === 'right').map((c) => c.key)

  const pinCellRefs = useRef(new Map<string, HTMLTableCellElement>())
  const [pinWidths, setPinWidths] = useState<Record<string, number>>({})
  // Measure every render, set state only on real change — offsets stay correct
  // as data/labels change column widths.
  useLayoutEffect(() => {
    const next: Record<string, number> = {}
    for (const [k, el] of pinCellRefs.current) {
      // getBoundingClientRect, not offsetWidth: the latter rounds to an integer,
      // and table cells lay out at fractional widths. Summing rounded widths
      // drifts the pin offset a fraction of a pixel off the real edge, which
      // opens a hairline between two adjacent pinned columns for the scrolled
      // content to show through.
      if (el?.isConnected) next[k] = el.getBoundingClientRect().width
    }
    const keys = new Set([...Object.keys(next), ...Object.keys(pinWidths)])
    for (const k of keys) {
      if (Math.abs((next[k] ?? -1) - (pinWidths[k] ?? -1)) > 0.5) {
        setPinWidths(next)
        return
      }
    }
  })
  const CHECKBOX_W = 36
  /**
   * Offsets FLOOR on both sides so adjacent pinned cells overlap by a sub-pixel
   * instead of meeting exactly — meeting on a fractional boundary is what let a
   * sliver of the scrolling content show between them. Both are floor because
   * the offset always measures from the container edge the cells stack away
   * from: a smaller `left` starts the cell earlier, and a smaller `right` ends
   * it further right, so in both directions less offset means more overlap with
   * the neighbour. The overlap is invisible — both paint the same opaque row
   * background.
   */
  const pinOffset = (key: string): number => {
    const pin = pinOf(key)
    if (pin === 'left') {
      let x = enableCheckboxes ? (pinWidths.__checkbox__ ?? CHECKBOX_W) : 0
      for (const k of leftPinnedKeys) {
        if (k === key) break
        x += pinWidths[k] ?? 0
      }
      return Math.floor(x)
    }
    let x = 0
    for (const k of [...rightPinnedKeys].reverse()) {
      if (k === key) break
      x += pinWidths[k] ?? 0
    }
    return Math.floor(x)
  }
  /** Sticky class + inline offset for a pinned column's cells. */
  const pinCls = (key: string, z: string, bg: string): string => {
    const pin = pinOf(key)
    if (!pin) return ''
    const seam =
      pin === 'left' && leftPinnedKeys[leftPinnedKeys.length - 1] === key
        ? 'border-r border-slate-200 dark:border-slate-700'
        : pin === 'right' && rightPinnedKeys[0] === key
          ? 'border-l border-slate-200 dark:border-slate-700'
          : ''
    return `sticky ${z} ${bg} ${seam}`
  }
  const pinStyle = (key: string): React.CSSProperties | undefined => {
    const pin = pinOf(key)
    if (!pin) return undefined
    return pin === 'left' ? { left: pinOffset(key) } : { right: pinOffset(key) }
  }
  const pinRef = (key: string) => (el: HTMLTableCellElement | null) => {
    if (el) pinCellRefs.current.set(key, el)
    else pinCellRefs.current.delete(key)
  }
  const PIN_TITLES: Record<string, string> = {
    left: 'Pinned left — click to pin right',
    right: 'Pinned right — click to unpin',
    none: 'Pin column left'
  }
  const pinButton = (key: string) => {
    const pin = pinOf(key)
    return (
      <button
        type='button'
        onClick={(e) => {
          e.stopPropagation()
          cyclePin(key)
        }}
        title={PIN_TITLES[pin ?? 'none']}
        aria-label={PIN_TITLES[pin ?? 'none']}
        className={`ml-1 inline-flex align-middle transition-opacity ${
          pin
            ? 'text-[#00a5cc] opacity-100'
            : 'text-slate-300 opacity-0 group-hover/hcell:opacity-100 dark:text-slate-600'
        }`}
      >
        <Pin
          className='h-3 w-3'
          style={pin === 'right' ? { transform: 'scaleX(-1)' } : undefined}
        />
      </button>
    )
  }

  return (
    <div data-cbv className={className ?? 'flex h-full min-h-0 flex-col bg-slate-50 text-[13px] dark:bg-slate-950'}>
      {/* Persistent, prominent scrollbars for the table region — custom
          WebKit scrollbars opt out of the OS overlay auto-hide, so the
          horizontal bar stays visible whenever columns overflow. */}
      <style>{`
        /* Horizontal overflow is hidden (HScrollProxy is the only h-bar);
           vertical stays native, styled on WebKit. */
        [data-cbv-scroll]::-webkit-scrollbar { width: 11px; }
        [data-cbv-scroll]::-webkit-scrollbar-track { background: #f1f5f9; }
        [data-cbv-scroll]::-webkit-scrollbar-thumb {
          background: #94a3b8; border-radius: 8px;
          border: 2px solid #f1f5f9; background-clip: padding-box;
        }
        [data-cbv-scroll]::-webkit-scrollbar-thumb:hover { background-color: #64748b; }
        [data-cbv-scroll]::-webkit-scrollbar-corner { background: transparent; }
        .dark [data-cbv-scroll]::-webkit-scrollbar-track { background: #1e293b; }
        .dark [data-cbv-scroll]::-webkit-scrollbar-thumb {
          background: #475569; border-color: #1e293b;
        }
        .dark [data-cbv-scroll]::-webkit-scrollbar-thumb:hover { background-color: #64748b; }
        @keyframes cbv-shimmer {
          0% { background-position: -400px 0; }
          100% { background-position: 400px 0; }
        }
        /* Token-driven so the dark ramp is neutral — the hardcoded #1e293b /
           #263449 pair here was slate-800, which rendered loading rows blue. */
        [data-cbv] .cbv-shimmer {
          background: linear-gradient(
            90deg,
            hsl(var(--nvr-skeleton)) 25%,
            hsl(var(--nvr-skeleton-hi)) 37%,
            hsl(var(--nvr-skeleton)) 63%
          );
          background-size: 800px 100%;
          animation: cbv-shimmer 1.4s ease-in-out infinite;
        }
        @keyframes cbv-progress {
          0% { left: -35%; width: 35%; }
          60% { left: 55%; width: 45%; }
          100% { left: 105%; width: 30%; }
        }
        [data-cbv] .cbv-progress::after {
          content: '';
          position: absolute;
          top: 0; bottom: 0;
          border-radius: 2px;
          background: #00ceff;
          animation: cbv-progress 1.1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        @keyframes cbv-overlay-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        [data-cbv] .cbv-overlay {
          opacity: 0;
          animation: cbv-overlay-in 0.2s ease-out 0.18s forwards;
        }
        @media (prefers-reduced-motion: reduce) {
          [data-cbv] .cbv-shimmer { animation: none; }
          [data-cbv] .cbv-progress::after { animation: none; left: 0; width: 100%; opacity: 0.5; }
          [data-cbv] .cbv-overlay { animation: none; opacity: 1; }
        }
      `}</style>
      <TipLayer />
      <CellCopyLayer />
      {cellMenu &&
        createPortal(
        <div
          style={{
            position: 'fixed',
            left: Math.min(cellMenu.x, window.innerWidth - 236),
            top: Math.min(cellMenu.y, window.innerHeight - 132),
            zIndex: 125
          }}
          className='w-56 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900'
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(cellMenu.key === '__state__' || classifyColFilter(cellMenu.key)) && cellMenu.cellText && cellMenu.cellText !== '—' && (
            <button
              type='button'
              onClick={() => {
                filterToCell(cellMenu)
                setCellMenu(null)
              }}
              className='block w-full truncate px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
            >
              Filter: <span className='font-medium'>{cellMenu.cellText.slice(0, 40)}</span>
            </button>
          )}
          {canExcludeCell(cellMenu.key, cellMenu.row) && cellMenu.cellText && cellMenu.cellText !== '—' && (
            <button
              type='button'
              onClick={() => {
                excludeCell(cellMenu)
                setCellMenu(null)
              }}
              className='block w-full truncate px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
            >
              Exclude: <span className='font-medium'>{cellMenu.cellText.slice(0, 40)}</span>
            </button>
          )}
          {(cellMenu.key === '__state__' || groupableCols.some((g) => g.key === cellMenu.key)) &&
            groupBy !== cellMenu.key && (
              <button
                type='button'
                onClick={() => {
                  pickGroupBy(cellMenu.key)
                  setCellMenu(null)
                }}
                className='block w-full truncate px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
              >
                Group by {cellMenu.key === '__state__' ? 'State' : columnLabel(cellMenu.key)}
              </button>
            )}
        </div>,
        document.body
      )}
      {/* Toolbar */}
      <div className='flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-700 dark:bg-slate-900'>
        <FilterBar
          collection={collection}
          meta={meta}
          search={search}
          onSearch={(v) => {
            setSearch(v)
            setPage(1)
          }}
          filters={filters}
          onFiltersChange={(f) => {
            setFilters(f)
            setPage(1)
          }}
        />
        <button
          type='button'
          onClick={() => void refetch()}
          aria-label='Refresh'
          title='Refresh'
          className='flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'
        >
          <RotateCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
        <button
          type='button'
          onClick={() => setAiOpen((o) => !o)}
          title='Ask the table a question'
          className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium ${
            aiOpen || aiResult
              ? 'border-[#00ceff66] bg-[#00ceff14] text-[#007a99] dark:text-nvr-cyan'
              : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400'
          }`}
        >
          <Sparkles className='h-3.5 w-3.5' />
          Ask
        </button>
        {aiOpen && (
          <div className='order-last flex w-full items-center gap-2'>
            <Sparkles className='h-4 w-4 shrink-0 text-[#00a5cc]' />
            <input
              autoFocus
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && aiPrompt.trim() && !aiAsk.isPending) {
                  aiAsk.mutate(aiPrompt.trim())
                }
                if (e.key === 'Escape') setAiOpen(false)
              }}
              placeholder='Ask in plain language — "over 50k in Zone 1 still waiting on approval"'
              className='h-8 flex-1 rounded-md border border-slate-200 bg-white px-3 text-[12.5px] outline-none focus:border-[#00ceff80] focus:ring-2 focus:ring-[#00ceff4d] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
            />
            <button
              type='button'
              disabled={!aiPrompt.trim() || aiAsk.isPending}
              onClick={() => aiAsk.mutate(aiPrompt.trim())}
              className='flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-40'
            >
              {aiAsk.isPending ? <RotateCw className='h-3.5 w-3.5 animate-spin' /> : 'Ask'}
            </button>
          </div>
        )}
        {cellExcludes.map((ex) => (
          <span
            key={ex.id}
            className='order-last inline-flex max-w-full items-center gap-1.5 rounded-full border border-red-200 bg-red-50 py-1 pl-2.5 pr-1.5 text-[12px] text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300'
          >
            <span className='min-w-0 truncate'>
              {columnLabel(ex.field)} ≠ {ex.label}
            </span>
            <button
              type='button'
              onClick={() => setCellExcludes((prev) => prev.filter((e2) => e2.id !== ex.id))}
              aria-label='Remove exclusion'
              className='rounded-full p-0.5 hover:bg-red-100 dark:hover:bg-red-500/20'
            >
              <X className='h-3 w-3' />
            </button>
          </span>
        ))}
        {aiResult && (
          <span className='order-last inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#00ceff66] bg-[#00ceff14] py-1 pl-2.5 pr-1.5 text-[12px] text-[#007a99] dark:text-nvr-cyan'>
            <Sparkles className='h-3 w-3 shrink-0' />
            <span className='min-w-0 truncate'>
              {aiResult.interpreted || 'AI result'} · {fmtNum(aiResult.total)} match
              {aiResult.total === 1 ? '' : 'es'}
              {aiResult.total > aiResult.rows.length ? ` (showing first ${aiResult.rows.length})` : ''}
            </span>
            <button
              type='button'
              onClick={clearAi}
              aria-label='Clear AI result'
              className='rounded-full p-0.5 hover:bg-[#00ceff29]'
            >
              <X className='h-3 w-3' />
            </button>
          </span>
        )}
        <div className='relative' ref={groupRef}>
          <button
            type='button'
            onClick={() => setGroupOpen((o) => !o)}
            className={`flex h-8 items-center gap-1 rounded-md border px-2.5 text-[12px] font-medium ${
              groupBy
                ? 'border-[#00ceff66] bg-[#00ceff14] text-[#007a99] dark:text-nvr-cyan'
                : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400'
            }`}
          >
            <Rows3 className='h-3.5 w-3.5' />
            {groupBy
              ? `Group: ${groupBy === '__state__' ? 'State' : columnLabel(groupBy)}`
              : 'Group'}
          </button>
          {groupOpen && (
            <div className='absolute right-0 top-full z-50 mt-1 max-h-[360px] w-56 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-slate-900'>
              <button
                type='button'
                onClick={() => pickGroupBy(null)}
                className={`block w-full rounded px-2 py-1.5 text-left text-[12px] ${
                  groupBy === null
                    ? 'bg-[#00ceff14] font-semibold text-slate-800 dark:text-slate-100'
                    : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                No grouping
              </button>
              {groupableCols.map((c) => (
                <button
                  key={c.key}
                  type='button'
                  onClick={() => pickGroupBy(c.key)}
                  className={`block w-full truncate rounded px-2 py-1.5 text-left text-[12px] ${
                    groupBy === c.key
                      ? 'bg-[#00ceff14] font-semibold text-slate-800 dark:text-slate-100'
                      : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type='button'
          onClick={toggleDensity}
          aria-label='Row density'
          title={density === 'compact' ? 'Switch to comfortable rows' : 'Switch to compact rows'}
          className='flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'
        >
          {density === 'compact' ? <Rows3 className='h-4 w-4' /> : <Rows2 className='h-4 w-4' />}
        </button>
        {/* Column picker */}
        <div className='relative' ref={colsRef}>
          <button
            type='button'
            onClick={() => setColsOpen((o) => !o)}
            className='h-8 rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400'
          >
            Columns
          </button>
          {colsOpen && (
            <div className='absolute right-0 top-full z-50 mt-1 flex max-h-[440px] w-72 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900'>
              <div className='flex-1 overflow-y-auto p-1.5'>
                <p className='px-1.5 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                  Visible columns
                </p>
                {effectiveColumns.map((k, idx) => (
                  <div key={k}>
                  <div
                    draggable={renamingCol !== k}
                    onDragStart={() => {
                      dragIdxRef.current = idx
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault()
                      const from = dragIdxRef.current
                      dragIdxRef.current = null
                      if (from == null || from === idx) return
                      const next = [...effectiveColumns]
                      const [moved] = next.splice(from, 1)
                      next.splice(idx, 0, moved)
                      setDisplayColumns(next)
                    }}
                    className='group flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-slate-50 dark:hover:bg-slate-800'
                  >
                    <span aria-hidden className='cursor-grab text-[10px] leading-none text-slate-300 group-hover:text-slate-400'>
                      ⠿
                    </span>
                    {renamingCol === k ? (
                      <input
                        autoFocus
                        value={columnLabels[k] ?? ''}
                        placeholder={
                          k.includes('.') ? k.split('.').map(titleCase).join(' › ') : titleCase(k)
                        }
                        onChange={(e) =>
                          setColumnLabels((l) => {
                            const next = { ...l }
                            if (e.target.value) next[k] = e.target.value
                            else delete next[k]
                            return next
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === 'Escape') setRenamingCol(null)
                        }}
                        onBlur={() => setRenamingCol(null)}
                        className='h-5 w-full min-w-0 flex-1 rounded border border-slate-200 bg-slate-50 px-1 text-[11.5px] outline-none focus:border-[#00ceff80] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
                      />
                    ) : (
                      <span className='min-w-0 flex-1 truncate text-[12px] text-slate-700 dark:text-slate-200'>
                        {columnLabel(k)}
                      </span>
                    )}
                    {renamingCol !== k && (
                      <button
                        type='button'
                        onClick={() => setRenamingCol(k)}
                        title='Rename column'
                        aria-label={`Rename ${k}`}
                        className='text-slate-300 opacity-0 hover:text-slate-500 group-hover:opacity-100'
                      >
                        ✎
                      </button>
                    )}
                    <button
                      type='button'
                      onClick={() => setFormattingCol(formattingCol === k ? null : k)}
                      title='Format column'
                      aria-label={`Format ${k}`}
                      className={
                        columnFormats[k]
                          ? 'text-[11px] font-bold text-[#00a5cc]'
                          : 'text-[11px] text-slate-300 opacity-0 hover:text-slate-500 group-hover:opacity-100'
                      }
                    >
                      $
                    </button>
                    <button
                      type='button'
                      onClick={() => setDisplayColumns(effectiveColumns.filter((x) => x !== k))}
                      title='Remove column'
                      aria-label={`Remove ${k}`}
                      className='text-slate-300 hover:text-slate-500'
                    >
                      ✕
                    </button>
                  </div>
                  {formattingCol === k && (
                    <div className='mb-1 ml-5 mr-1 rounded-md border border-slate-100 bg-slate-50 p-1.5 dark:border-slate-800 dark:bg-slate-800/60'>
                      <div className='flex flex-wrap gap-1'>
                        {FORMAT_PRESETS.map((pz) => {
                          const active = JSON.stringify(columnFormats[k] ?? null) === JSON.stringify(pz.cfg)
                          return (
                            <button
                              key={pz.label}
                              type='button'
                              onClick={() => {
                                setColumnFormats((f) => {
                                  const next = { ...f }
                                  if (pz.cfg) next[k] = pz.cfg
                                  else delete next[k]
                                  return next
                                })
                                setFormattingCol(null)
                              }}
                              className={`rounded border px-1.5 py-0.5 text-[10.5px] ${
                                active
                                  ? 'border-[#00ceff66] bg-[#00ceff14] text-slate-800 dark:text-slate-100'
                                  : 'border-slate-200 bg-white text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'
                              }`}
                            >
                              {pz.label}
                            </button>
                          )
                        })}
                      </div>
                      <input
                        placeholder='Custom date… e.g. DD MMM YY hh:mm A — Enter'
                        defaultValue={
                          columnFormats[k]?.type === 'datetime' ? (columnFormats[k] as { template: string }).template : ''
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const t = (e.target as HTMLInputElement).value.trim()
                            if (t) setColumnFormats((f) => ({ ...f, [k]: { type: 'datetime', template: t } }))
                            setFormattingCol(null)
                          }
                          if (e.key === 'Escape') setFormattingCol(null)
                        }}
                        className='mt-1 h-5 w-full rounded border border-slate-200 bg-white px-1 text-[10.5px] outline-none focus:border-[#00ceff80] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
                      />
                    </div>
                  )}
                  </div>
                ))}
                <p className='mt-2 border-t border-slate-100 px-1.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800'>
                  Add column
                </p>
                {nonHidden
                  .filter((f) => !effectiveColumns.includes(f.field))
                  .map((f) => (
                    <button
                      key={f.field}
                      type='button'
                      onClick={() => setDisplayColumns([...effectiveColumns, f.field])}
                      className='flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
                    >
                      <span aria-hidden className='text-slate-400'>＋</span>
                      <span className='truncate'>{titleCase(f.field)}</span>
                    </button>
                  ))}
                {meta && (
                  <div className='mt-1 border-t border-slate-100 pt-1.5 dark:border-slate-800'>
                    <p className='px-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                      ＋ Related column
                    </p>
                    <RelatedColumnRoot
                      collection={collection}
                      meta={meta}
                      onPick={(path) => {
                        const key = path.join('.')
                        if (!effectiveColumns.includes(key)) {
                          setDisplayColumns([...effectiveColumns, key])
                        }
                        setColsOpen(false)
                      }}
                    />
                  </div>
                )}
              </div>
              {/* Presets footer — save current layout, or write it as the collection default */}
              <div className='shrink-0 border-t border-slate-100 p-1.5 dark:border-slate-800'>
                <p className='px-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                  Presets
                </p>
                {presetOpen ? (
                  <div className='flex items-center gap-1.5 px-1.5 pb-0.5'>
                    <input
                      autoFocus
                      value={saveName}
                      placeholder='Preset name…'
                      onChange={(e) => setSaveName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && saveName.trim()) {
                          saveView.mutate()
                          setPresetOpen(false)
                        }
                        if (e.key === 'Escape') setPresetOpen(false)
                      }}
                      className='h-6 w-full min-w-0 flex-1 rounded border border-slate-200 bg-slate-50 px-1.5 text-[11.5px] outline-none focus:border-[#00ceff80] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
                    />
                    <button
                      type='button'
                      disabled={!saveName.trim() || saveView.isPending}
                      onClick={() => {
                        saveView.mutate()
                        setPresetOpen(false)
                      }}
                      className='text-[11.5px] font-medium text-[#00a5cc] disabled:opacity-40'
                    >
                      Save
                    </button>
                  </div>
                ) : (
                  <div className='flex items-center justify-between px-1.5 pb-0.5'>
                    <button
                      type='button'
                      onClick={() => setPresetOpen(true)}
                      className='inline-flex items-center gap-1 text-[11.5px] text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                    >
                      <span aria-hidden>🖫</span> Save as preset…
                    </button>
                    {isAdmin && (
                      <button
                        type='button'
                        onClick={() => upsertDefault.mutate()}
                        disabled={upsertDefault.isPending}
                        title='Save the current columns/filters/sort as the collection default view'
                        className='inline-flex items-center gap-1 text-[11.5px] text-slate-500 hover:text-[#00a5cc] disabled:opacity-40 dark:text-slate-400'
                      >
                        <span aria-hidden>☆</span> Set default
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <button
          type='button'
          onClick={() => void exportCsv()}
          disabled={exporting}
          className='h-8 rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-400'
        >
          {exporting ? 'Exporting…' : 'Export'}
        </button>
        {canCreate && !meta?.singleton && (
          newItemLayouts ? (
            <div className='relative' data-cbv-newitem-menu ref={newItemMenuRef}>
              <button
                type='button'
                onClick={() => setNewItemMenuOpen((v) => !v)}
                className='flex h-8 items-center gap-1 rounded-md bg-[#00ceff] px-3 text-[12.5px] font-semibold text-white hover:brightness-105'
              >
                + New item
                <ChevronDown className='h-3.5 w-3.5' />
              </button>
              {newItemMenuOpen && (
                <div className='absolute right-0 top-9 z-[60] w-60 rounded-md border border-slate-200 bg-white p-1 shadow-lg dark:border-border dark:bg-card'>
                  <button
                    type='button'
                    onClick={() => {
                      setNewItemMenuOpen(false)
                      openRow('new')
                    }}
                    className='flex w-full items-center rounded px-2 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-muted'
                  >
                    {newItemLayouts.active?.create_label ?? newItemLayouts.active?.name ?? 'Default layout'}
                    <span className='ml-auto pl-3 text-[10px] text-slate-400 dark:text-slate-500'>default</span>
                  </button>
                  {newItemLayouts.options.map((l) => (
                    <button
                      key={l.id}
                      type='button'
                      onClick={() => {
                        setNewItemMenuOpen(false)
                        // Goes through openTarget (not onOpenItem) so the
                        // layout slug rides the host's itemUrl mapping.
                        openTarget({ collection, itemId: 'new', layoutSlug: l.slug })
                      }}
                      className='flex w-full items-center rounded px-2 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-muted'
                    >
                      {l.create_label ?? l.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              type='button'
              onClick={() => openRow('new')}
              className='h-8 rounded-md bg-[#00ceff] px-3 text-[12.5px] font-semibold text-white hover:brightness-105'
            >
              + New item
            </button>
          )
        )}
      </div>

      {/* Deep-link context (dashboard tiles etc.) — visible + dismissable so a
          contextual landing never reads as "the list is mysteriously short". */}
      {linkConds.length > 0 && (
        <div className='flex shrink-0 flex-wrap items-center gap-1.5 border-b border-slate-100 bg-[#00ceff08] px-4 py-1.5 dark:border-slate-800'>
          <span className='text-[11px] font-medium text-slate-500 dark:text-slate-400'>Showing:</span>
          {linkConds.map((c, i) => (
            <span
              key={i}
              className='rounded border border-[#00ceff66] bg-[#00ceff14] px-1.5 py-px text-[11px] text-slate-800 dark:text-slate-100'
            >
              {c.label ?? c.path.join('.')}
            </span>
          ))}
          <button
            type='button'
            onClick={() => setLinkConds([])}
            className='ml-1 text-[11px] text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline dark:text-slate-400 dark:hover:text-slate-200'
          >
            Show all
          </button>
        </div>
      )}

      {/* Quick filters — persistent facet dropdowns; Apply commits to the
          server query (entire record set), Clear resets facets + column filters */}
      {effQuickFilters.length > 0 && (
        <div className='flex shrink-0 flex-wrap items-center gap-1.5 border-b border-slate-100 bg-white px-4 py-1.5 dark:border-slate-800 dark:bg-slate-900'>
          {effQuickFilters.map((qf) => (
            <QuickFilterSelect
              key={qf.key}
              def={qf}
              allowedIds={restrictedIdsFor(qf)}
              scopeDefault={scopeSeededKeys.has(qf.key)}
              selected={quickSel[qf.key] ?? []}
              onChange={(vals) => setQuickSel((sel) => ({ ...sel, [qf.key]: vals }))}
            />
          ))}
          <button
            type='button'
            onClick={() => {
              setAppliedQuick(quickSel)
              setPage(1)
            }}
            className='h-6 rounded bg-[#00ceff] px-2.5 text-[11px] font-semibold text-white'
          >
            Apply
          </button>
          <button
            type='button'
            onClick={() => {
              setQuickSel({})
              setAppliedQuick({})
              setColFilters({})
              setPage(1)
            }}
            className='h-6 rounded border border-slate-200 px-2 text-[11px] text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400'
          >
            Clear
          </button>
          <span className='ml-auto text-[11px] text-slate-400'>
            {fmtNum(total)} item{total === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {/* Saved views — the baseline "Default" pill only renders while no
          is_default view exists (once one does, its own ★ pill IS the default) */}
      <div className='flex shrink-0 flex-wrap items-center gap-1.5 border-b border-slate-100 bg-white px-4 py-1.5 dark:border-slate-800 dark:bg-slate-900'>
        {!views.some((v) => v.is_default) && (
          <button
            type='button'
            onClick={clearView}
            className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[12px] transition-colors ${
              activeViewId == null
                ? 'border-[#00ceff66] bg-[#00ceff1a] text-slate-900 dark:text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
            }`}
          >
            Default
          </button>
        )}
        {views.map((v) => (
          <span
            key={v.id}
            className={`inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[12px] transition-colors ${
              activeViewId === v.id
                ? 'border-[#00ceff66] bg-[#00ceff1a] text-slate-900 dark:text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
            }`}
          >
            {v.is_default && (
              <span title='Collection default view' className='text-[#00a5cc]'>
                ★
              </span>
            )}
            {v.is_shared && !v.is_default && <span title='Shared'>⚭</span>}
            <button type='button' onClick={() => applyView(v)}>
              {v.name}
            </button>
            {activeViewId === v.id && (
              <>
                <button
                  type='button'
                  onClick={() => toggleViewSub.mutate(v.id)}
                  title={
                    subForView(v.id)
                      ? 'Subscribed — a daily digest reports records that enter this view. Click to unsubscribe.'
                      : 'Subscribe — get a daily digest of records that enter this view'
                  }
                  aria-label={`Toggle digest subscription for ${v.name}`}
                  className={
                    subForView(v.id) ? 'text-[#00a5cc]' : 'text-slate-400 hover:text-[#00a5cc]'
                  }
                >
                  {subForView(v.id) ? (
                    <Bell className='h-3 w-3' fill='currentColor' />
                  ) : (
                    <BellOff className='h-3 w-3' />
                  )}
                </button>
                <button type='button' onClick={() => updateView.mutate(v.id)} title='Update with current state' aria-label={`Update ${v.name}`}>
                  ↺
                </button>
                {isAdmin && (
                  <button
                    type='button'
                    onClick={() => setDefaultView.mutate({ id: v.id, on: !v.is_default })}
                    title={v.is_default ? 'Unset collection default' : 'Make collection default'}
                    aria-label={`Toggle default ${v.name}`}
                    className={v.is_default ? 'text-[#00a5cc]' : 'text-slate-400 hover:text-[#00a5cc]'}
                  >
                    ★
                  </button>
                )}
                <button type='button' onClick={() => deleteView.mutate(v.id)} title='Delete view' aria-label={`Delete ${v.name}`} className='hover:text-red-500'>
                  ✕
                </button>
              </>
            )}
          </span>
        ))}
        {saveOpen ? (
          <form
            className='flex items-center gap-1'
            onSubmit={(e) => {
              e.preventDefault()
              if (saveName.trim()) saveView.mutate()
            }}
          >
            <input
              autoFocus
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder='View name…'
              className='h-6 w-32 rounded border border-slate-200 bg-slate-50 px-1.5 text-[11.5px] outline-none focus:border-[#00ceff80] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
            />
            <button type='submit' disabled={!saveName.trim()} className='rounded bg-[#00ceff] px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-40'>
              Save
            </button>
            <button type='button' onClick={() => setSaveOpen(false)} aria-label='Cancel' className='text-slate-400'>
              ✕
            </button>
          </form>
        ) : (
          <button type='button' onClick={() => setSaveOpen(true)} className='text-[12px] font-medium text-slate-400 hover:text-[#00a5cc]'>
            ☆ Save view
          </button>
        )}
      </div>

      {/* Error */}
      {error != null && (
        <div className='mx-4 mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700'>
          {error instanceof Error ? error.message : 'Failed to load records'}
        </div>
      )}

      {/* Table card — fills the remaining page height; the table scrolls
          inside it with sticky headers, pagination pinned at the bottom */}
      <div className='flex min-h-0 flex-1 flex-col p-4 pt-3'>
        <div className='relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900'>
          {/* Refetch overlay — rows stay visible (placeholderData) but dim so
              paginate/sort/filter visibly does something */}
          {isFetching && !isLoading && (
            <>
              <div className='cbv-progress pointer-events-none absolute inset-x-0 top-0 z-[6] h-[3px] overflow-hidden' />
              <div className='cbv-overlay pointer-events-none absolute inset-0 z-[5] flex items-start justify-center bg-white/40 pt-24 dark:bg-slate-950/35'>
                <span className='flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'>
                  <RotateCw aria-hidden className='h-3.5 w-3.5 animate-spin text-[#00a5cc]' />
                  Loading…
                </span>
              </div>
            </>
          )}
          <div
            ref={tableScrollRef}
            data-cbv-scroll
            className='min-h-0 flex-1 overflow-y-auto overflow-x-hidden'
          >
            {effectiveColumns.length === 0 ? (
              <div className='p-0'>
                <div className='flex h-8 items-center gap-6 border-b border-slate-200 bg-slate-50 px-4 dark:border-slate-700 dark:bg-slate-800'>
                  {[64, 90, 140, 80, 110, 70, 96, 120].map((w, i) => (
                    <span key={i} className='cbv-shimmer h-2.5 rounded' style={{ width: w }} />
                  ))}
                </div>
                {Array.from({ length: 14 }, (_, r) => (
                  <div
                    key={r}
                    className='flex h-8 items-center gap-6 border-b border-slate-100 px-4 dark:border-slate-800'
                  >
                    {[64, 90, 140, 80, 110, 70, 96, 120].map((w, i) => (
                      <span
                        key={i}
                        className='cbv-shimmer h-3 rounded'
                        style={{ width: w * (0.6 + ((r * 7 + i * 3) % 5) * 0.12) }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ) : (
            <table
              data-copy-cells=''
              className={`w-full ${density === 'comfortable' ? '[&_tbody_td]:py-2.5 [&_tbody_tr]:h-11 [&_tbody]:text-[12.5px]' : ''}`}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              <thead>
                <tr className='border-b border-slate-200 dark:border-slate-700'>
                  {enableCheckboxes && (
                    <th
                      // Measured like any other pinned column — a hardcoded 36
                      // would drift from the real width and reopen the gap.
                      ref={pinRef('__checkbox__')}
                      className='sticky left-0 top-0 z-[4] h-8 w-9 bg-slate-50 px-3 py-0 dark:bg-slate-800'
                    >
                      <input type='checkbox' checked={allSelected} onChange={toggleAll} aria-label='Select all' />
                    </th>
                  )}
                  {orderedCols.map((col) => {
                    const key = col.key
                    const pinned = !!pinOf(key)
                    const baseTh = `group/hcell sticky top-0 h-8 select-none whitespace-nowrap bg-slate-50 px-3 py-0 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400 ${pinned ? 'z-[4]' : 'z-[2]'}`
                    const pinPart = pinCls(key, '', '')
                    if (col.kind !== 'data') {
                      const label =
                        col.kind === 'state' ? 'State' : col.kind === 'owners' ? 'Owners' : ''
                      return (
                        <th
                          key={key}
                          ref={pinned ? pinRef(key) : undefined}
                          style={pinStyle(key)}
                          className={`${baseTh} text-left ${col.kind === 'actions' ? 'w-20 px-2' : ''} ${pinPart}`}
                        >
                          {label}
                          {pinButton(key)}
                        </th>
                      )
                    }
                    const f0 = fieldByName.get(key)
                    const resolved =
                      isResolvedCol(key) || !!(f0?.computed_formula && !f0.computed_store)
                    const active = !resolved && (sort === key || sort === `-${key}`)
                    const desc = sort === `-${key}`
                    const f = fieldByName.get(key)
                    const label = columnLabel(key)
                    return (
                      <th
                        key={key}
                        ref={pinned ? pinRef(key) : undefined}
                        style={pinStyle(key)}
                        onClick={() => {
                          if (!resolved) nextSort(key)
                        }}
                        className={`${baseTh} ${isNumericCol(key) ? 'text-right' : 'text-left'} ${resolved ? '' : 'cursor-pointer hover:text-slate-600'} ${pinPart}`}
                      >
                        {label}
                        {f?.computed_formula && (
                          <span title={`Computed: ${f.computed_formula}`} className='ml-1 text-violet-400'>
                            ƒ
                          </span>
                        )}
                        {!resolved && (
                          <span className={active ? 'ml-1 text-[#00a5cc]' : 'ml-1 text-slate-300'}>
                            {active ? (desc ? '▼' : '▲') : '⇅'}
                          </span>
                        )}
                        {pinButton(key)}
                      </th>
                    )
                  })}
                </tr>
                {/* Column-level filters — every control commits to the server
                    conditions, so filtering covers the entire record set */}
                {(anyColFilterable || hasPipeline) && (
                  <tr className='border-b border-slate-200 dark:border-slate-700'>
                    {enableCheckboxes && (
                      <th className='sticky left-0 top-8 z-[4] w-9 bg-slate-50 px-3 py-1 dark:bg-slate-800' />
                    )}
                    {orderedCols.map((col) => {
                      const key = col.key
                      const pinned = !!pinOf(key)
                      const baseTh = `sticky top-8 bg-slate-50 px-2 py-1 text-left font-normal dark:bg-slate-800 ${pinned ? 'z-[4]' : 'z-[2]'} ${pinCls(key, '', '')}`
                      if (col.kind === 'state') {
                        return (
                          <th key={key} style={pinStyle(key)} className={baseTh}>
                            <MultiPick
                              block
                              label='All'
                              options={(pipelineTemplate?.states ?? []).map((st) => ({
                                value: st.key,
                                label: st.label ?? st.key
                              }))}
                              selected={
                                colFilters.__state__?.kind === 'state' ? colFilters.__state__.value : []
                              }
                              onChange={(vals) =>
                                setColFilter(
                                  '__state__',
                                  vals.length ? { kind: 'state', value: vals.map(String) } : null
                                )
                              }
                            />
                          </th>
                        )
                      }
                      if (col.kind !== 'data') {
                        return (
                          <th
                            key={key}
                            style={pinStyle(key)}
                            className={`${baseTh} ${col.kind === 'actions' ? 'w-20' : ''}`}
                          />
                        )
                      }
                      return (
                        <th key={key} style={pinStyle(key)} className={baseTh}>
                          {renderColFilter(key)}
                        </th>
                      )
                    })}
                  </tr>
                )}
              </thead>
              {/* Tabular figures (proportional ones leave numeric columns ragged)
                  and an explicit 12px base — cells with no size of their own were
                  inheriting the table's 13px and reading a step larger than the rest. */}
              <tbody className='text-[12px] tabular-nums'>
                {isLoading ? (
                  Array.from({ length: 12 }, (_, i) => (
                    <tr key={i} className='border-b border-slate-100 dark:border-slate-800'>
                      <td className='px-3 py-2' colSpan={effectiveColumns.length + extraCols}>
                        <span
                          className='cbv-shimmer block h-3.5 rounded'
                          style={{ width: `${55 + ((i * 17) % 40)}%` }}
                        />
                      </td>
                    </tr>
                  ))
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={effectiveColumns.length + extraCols} className='py-16'>
                      <div className='flex flex-col items-center gap-2 text-center'>
                        <span className='flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800'>
                          <Search aria-hidden className='h-4.5 w-4.5 h-5 w-5 text-slate-400' />
                        </span>
                        <p className='text-[13.5px] font-medium text-slate-600 dark:text-slate-300'>
                          No records match
                        </p>
                        <p className='text-[12px] text-slate-400'>
                          Try adjusting your search or filters.
                        </p>
                        {(filters.length > 0 ||
                          Object.keys(colFilters).length > 0 ||
                          Object.values(appliedQuick).some((v) => v.length > 0) ||
                          appliedSearch) && (
                          <button
                            type='button'
                            onClick={() => {
                              setFilters([])
                              setColFilters({})
                              setQuickSel({})
                              setAppliedQuick({})
                              setSearch('')
                              setPage(1)
                            }}
                            className='mt-1 h-7 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-600 hover:border-[#00ceff66] hover:text-[#00a5cc] dark:border-slate-700 dark:text-slate-300'
                          >
                            Clear all filters
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  renderList.map((entry) => {
                    if (entry.kind === 'header') {
                      return (
                        <tr
                          key={`__group__${entry.gkey}`}
                          onClick={() =>
                            setCollapsedGroups((prev) => {
                              const next = new Set(prev)
                              if (next.has(entry.gkey)) next.delete(entry.gkey)
                              else next.add(entry.gkey)
                              return next
                            })
                          }
                          className='cursor-pointer border-b border-slate-200 bg-slate-50/80 hover:bg-slate-100/80 dark:border-slate-700 dark:bg-muted/40'
                        >
                          <td className='px-3 py-1.5' colSpan={effectiveColumns.length + extraCols}>
                            <span className='flex items-center gap-1.5 text-[12px] font-medium text-slate-600 dark:text-slate-200'>
                              {collapsedGroups.has(entry.gkey) ? (
                                <ChevronDown className='h-3.5 w-3.5 -rotate-90 text-slate-400' />
                              ) : (
                                <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
                              )}
                              {entry.label}
                              <span className='rounded-full bg-slate-200/70 px-1.5 text-[10.5px] font-semibold tabular-nums text-slate-500 dark:bg-muted dark:text-slate-400'>
                                {entry.count}
                              </span>
                            </span>
                          </td>
                        </tr>
                      )
                    }
                    const row = entry.row
                    const id = row.id as string | number
                    const isSelected = selectedIds.includes(id)
                    const state = pipelineData?.instances?.[String(id)]
                    const risk = riskMap[String(id)]
                    const riskTint = !isSelected && risk ? rowHighlightClass(risk.color) : undefined
                    // Pinned cells need an OPAQUE bg — tinted rows carry the tint
                    // into their sticky cells so pinned columns match the row.
                    const stickyBg = isSelected
                      ? 'bg-[#e6fafe] dark:bg-[#0c2a33]'
                      : (riskTint ??
                        'bg-white group-hover:bg-[#f2fcff] dark:bg-slate-900 dark:group-hover:bg-[#0e2d3a]')
                    return (
                      <tr
                        key={String(id)}
                        onClick={() => openRow(id)}
                        title={risk ? `At risk — ${risk.rule}` : undefined}
                        className={`group h-8 cursor-pointer border-b border-slate-100 transition-colors duration-75 hover:bg-[#00ceff0a] dark:border-slate-800 dark:hover:bg-[#00ceff14] ${
                          isSelected ? 'bg-[#00ceff14]' : (riskTint ?? '')
                        }`}
                      >
                        {/* stopPropagation only — the checkbox's own onChange
                            toggles; toggling here too would double-toggle. */}
                        {enableCheckboxes && (
                          <td
                            className={`sticky left-0 z-[1] w-9 px-3 py-1.5 ${stickyBg}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type='checkbox'
                              checked={isSelected}
                              onChange={() => toggleRow(id)}
                              aria-label={`Select ${id}`}
                            />
                          </td>
                        )}
                        {orderedCols.map((col) => {
                          const key = col.key
                          if (col.kind === 'state') {
                            return (
                              <td
                                key={key}
                                style={pinStyle(key)}
                                onContextMenu={(e) => {
                                  e.preventDefault()
                                  setCellMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    key,
                                    row,
                                    cellText: (e.currentTarget as HTMLElement).innerText.trim()
                                  })
                                }}
                                className={`whitespace-nowrap px-3 py-1.5 ${pinCls(key, 'z-[1]', stickyBg)}`}
                              >
                                {state ? (
                                  <span
                                    className='inline-flex items-center gap-1.5 rounded-full py-0.5 pl-2 pr-2.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200'
                                    style={{ backgroundColor: `${state.state_color ?? '#6b7280'}1f` }}
                                  >
                                    <span
                                      aria-hidden
                                      className='h-1.5 w-1.5 shrink-0 rounded-full'
                                      style={{ backgroundColor: state.state_color ?? '#6b7280' }}
                                    />
                                    {state.state_label ?? state.state_key ?? '?'}
                                  </span>
                                ) : (
                                  <span className='text-[12px] text-slate-300'>—</span>
                                )}
                              </td>
                            )
                          }
                          if (col.kind === 'owners') {
                            return (
                              <td
                                key={key}
                                style={pinStyle(key)}
                                className={`whitespace-nowrap px-3 py-1 ${pinCls(key, 'z-[1]', stickyBg)}`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <UserRosterCluster
                                  users={ownersByItem?.[String(id)] ?? []}
                                  showSingleName={false}
                                />
                              </td>
                            )
                          }
                          if (col.kind === 'actions') {
                            return (
                              <td
                                key={key}
                                style={pinStyle(key)}
                                className={`w-20 whitespace-nowrap px-2 py-1 text-right ${pinCls(key, 'z-[1]', stickyBg)}`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <RowActionsMenu
                                  collection={collection}
                                  id={id}
                                  hasPipeline={hasPipeline}
                                  onOpen={() => openRow(id)}
                                  onPeek={() => recordDrill.push([{ collection, itemId: String(id) }])}
                                  onAudit={() => setAuditId(String(id))}
                                  urlFor={urlFor}
                                  onDeleted={() => deleteRow.mutate(id)}
                                />
                              </td>
                            )
                          }
                          const drill = isResolvedCol(key) ? resolvedDrill(id, key) : null
                          const m2oRel = !isResolvedCol(key) ? isM2OField(relations, collection, key) : null
                          return (
                            <td
                              key={key}
                              style={pinStyle(key)}
                              onContextMenu={(e) => {
                                e.preventDefault()
                                setCellMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  key,
                                  row,
                                  cellText: (e.currentTarget as HTMLElement).innerText.trim()
                                })
                              }}
                              className={`whitespace-nowrap px-3 py-1.5 ${isNumericCol(key) ? 'text-right' : ''} ${pinCls(key, 'z-[1]', stickyBg)}`}
                            >
                              {isResolvedCol(key) ? (
                                resolvedTargetFor(key) === 'nivaro_users' ? (
                                  (() => {
                                    const upath = key.includes('.') ? key : aliasPathByField[key]
                                    const uids = resolvedData?.rows?.[String(id)]?.[upath]?.ids ?? []
                                    const val = resolvedFor(id, key) ?? ''
                                    if (uids.length === 0 || !val || val === '—')
                                      return <span className='text-[12px] text-slate-300'>—</span>
                                    if (uids.length === 1)
                                      return (
                                        <span onClick={(e) => e.stopPropagation()}>
                                          <UserChip userId={String(uids[0])} size='compact' />
                                        </span>
                                      )
                                    const names = val.split(', ')
                                    return (
                                      <UserRosterCluster
                                        users={uids.map((uid, i) => ({
                                          id: String(uid),
                                          name: names[i] ?? String(uid)
                                        }))}
                                        showSingleName={false}
                                      />
                                    )
                                  })()
                                ) : drill && resolvedFor(id, key) !== '—' ? (
                                  <button
                                    type='button'
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      recordDrill.push([{ collection: drill.target, itemId: drill.id }])
                                    }}
                                    data-tip={resolvedFor(id, key) ?? undefined}
                                    className='block max-w-[260px] truncate text-left text-[12px] font-medium text-slate-700 underline decoration-slate-300 underline-offset-2 transition-colors hover:text-[#0284c7] hover:decoration-[#0284c7] dark:text-slate-200 dark:decoration-slate-600 dark:hover:text-[#38bdf8]'
                                  >
                                    {fmtCell(resolvedFor(id, key) ?? '', key)}
                                  </button>
                                ) : (
                                  <span
                                    className='block max-w-[260px] truncate text-[12px] text-slate-700 dark:text-slate-200'
                                    data-tip={resolvedFor(id, key) ?? undefined}
                                  >
                                    {resolvedFor(id, key) != null ? (
                                      fmtCell(resolvedFor(id, key) ?? '', key)
                                    ) : (
                                      <span className='inline-block h-3.5 w-16 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
                                    )}
                                  </span>
                                )
                              ) : m2oRel?.one_collection === 'nivaro_users' && row[key] != null ? (
                                <span onClick={(e) => e.stopPropagation()}>
                                  <UserChip userId={String(row[key])} size='compact' />
                                </span>
                              ) : m2oRel?.one_collection && row[key] != null && !isSystemCol(m2oRel.one_collection) ? (
                                <button
                                  type='button'
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    recordDrill.push([
                                      {
                                        collection: m2oRel.one_collection as string,
                                        itemId: String(row[key])
                                      }
                                    ])
                                  }}
                                  className='text-left text-[12px] font-medium text-slate-700 underline decoration-slate-300 underline-offset-2 transition-colors hover:text-[#0284c7] hover:decoration-[#0284c7] dark:text-slate-200 dark:decoration-slate-600 dark:hover:text-[#38bdf8]'
                                >
                                  <RelationLabel relatedCollection={m2oRel.one_collection as string} id={row[key]} />
                                </button>
                              ) : columnFormats[key] && row[key] != null ? (
                                <span className='text-[12px] tabular-nums text-slate-700 dark:text-slate-200'>
                                  {formatValue(String(row[key]), columnFormats[key])}
                                </span>
                              ) : (
                                <CellValue
                                  collection={collection}
                                  field={key}
                                  fieldType={fieldByName.get(key)?.type ?? null}
                                  value={row[key]}
                                  relations={relations}
                                />
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
            )}
          </div>
          <HScrollProxy scrollerRef={tableScrollRef} />
          <RowHighlightLegend
            collections={collection ? [collection] : []}
            className='shrink-0 border-t border-slate-100 bg-white px-3 py-1.5 dark:border-slate-800 dark:bg-slate-900'
          />
          {groupBy && total > 500 && (
            <p className='shrink-0 border-t border-slate-100 bg-white px-3 py-2 text-[12px] text-slate-500 dark:border-slate-800 dark:bg-slate-900'>
              Grouping the first {fmtNum(500)} of {fmtNum(total)} records — narrow the filters to
              group everything.
            </p>
          )}
          {/* Pagination */}
          {!groupBy && !aiResult && total > effPageSize && (
            <div className='flex shrink-0 items-center justify-between border-t border-slate-100 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900'>
              <p className='text-[12px] tabular-nums text-slate-500 dark:text-slate-400'>
                <span className='font-semibold text-slate-700 dark:text-slate-200'>
                  {fmtNum(start)}–{fmtNum(end)}
                </span>{' '}
                of {fmtNum(total)} records
              </p>
              <span className='flex items-center gap-0.5'>
                <button
                  type='button'
                  disabled={page <= 1}
                  onClick={() => setPage(1)}
                  aria-label='First page'
                  className='h-7 rounded px-2 text-[12px] text-slate-600 hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-800'
                >
                  «
                </button>
                <button
                  type='button'
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className='h-7 rounded px-2.5 text-[12px] text-slate-600 hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-800'
                >
                  ← Prev
                </button>
                <span className='min-w-[64px] text-center text-[12px] tabular-nums text-slate-500'>
                  {fmtNum(page)} / {fmtNum(totalPages)}
                </span>
                <button
                  type='button'
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className='h-7 rounded px-2.5 text-[12px] text-slate-600 hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-800'
                >
                  Next →
                </button>
                <button
                  type='button'
                  disabled={page >= totalPages}
                  onClick={() => setPage(totalPages)}
                  aria-label='Last page'
                  className='h-7 rounded px-2 text-[12px] text-slate-600 hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-800'
                >
                  »
                </button>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Drill-down sheet — 85% panel; detail layout when the target
          collection has one, read-only grouped layout otherwise */}
      {drillStack?.length ? (
        <RecordDrilldownSheet
          collection={drillStack[0].collection}
          itemId={drillStack[0].itemId}
          width='85%'
          stack={drillStack}
          onPush={(target) => recordDrill.push([...drillStack, target])}
          onPop={() => recordDrill.back()}
          // Explicit dismissal unwinds every level in one go.
          onClose={() => recordDrill.back(drillStack.length)}
        />
      ) : null}

      {/* Audit log sheet (revision history for one row) */}
      {auditId && (
        <RevisionsPanel
          collection={collection}
          item={auditId}
          open
          onOpenChange={(o) => {
            if (!o) setAuditId(null)
          }}
        />
      )}

      {/* Bulk bar */}
      {enableCheckboxes && selectedIds.length > 0 && (
        <BulkBar
          collection={collection}
          selectedIds={selectedIds}
          transitions={pipelineTemplate?.transitions ?? []}
          onClear={() => setSelectedIds([])}
          onSuccess={() => void qc.invalidateQueries({ queryKey: ['cbv-items', collection] })}
        />
      )}
    </div>
  )
}

/** @deprecated Column model changed to plain field keys — kept for source
 *  compatibility with early adopters; maps `path` to a field key. */
export interface CollectionBrowserColumn {
  path: string
  label?: string
  format?: 'currency' | 'date' | 'datetime' | 'text'
  filterable?: boolean
}
