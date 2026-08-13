import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  DrilldownContext,
  type DrilldownTarget,
  useDrilldown,
  useItemNavigation,
  useNivaroClient,
  useOverlayState
} from '../context'
import { get, post } from '../lib/commands'
import {
  effectiveScopeSeedIds,
  matchScopeDimension,
  translateScopeValues,
  useMyScopes
} from '../lib/use-my-scopes'
import { formatNumber, formatRelative, titleCase } from '../lib/utils'
import { MatrixEditor, type MatrixEditorConfig } from './MatrixEditor'
import { QueryStatStrip, type QueryWidgetStat } from './QueryStatStrip'
import { RecordGridEditor, type RecordGridEditorConfig } from './RecordGridEditor'
import { QueryTable, type QueryTableConfig } from './QueryTable'
import { RecordDrilldownSheet } from './RecordDrilldownSheet'
import { RelationCombobox } from './item-edit/RelationCombobox'

// Headless page-builder renderer: draws a nivaro_pages layout (widget grid)
// through the SDK client, so external apps render pages the same way they
// render forms (LayoutForm) and layouts. Mirrors the admin's PageView widget
// surface: table / kpi / markdown / iframe / recent-activity / query (with
// param filters + row_click picker/drill/matrix) / matrix (inline + drawer).
//
// Host requirements: NivaroProvider (SDK client) + a react-query
// QueryClientProvider. Optional: NavigationContext (row links), an outer
// DrilldownContext (record drills — PageRenderer hosts its own sheet when
// none is provided).

export interface PageRendererWidget {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  config?: Record<string, unknown>
}

export interface PageRendererPage {
  slug: string
  name: string
  layout?: { columns?: number; widgets?: PageRendererWidget[] } | null
}

const ROW_HEIGHT = 76

// ─── Small shared bits ────────────────────────────────────────────────────────

function LoadingRows() {
  return (
    <div className='space-y-1.5 p-3'>
      {[1, 2, 3].map((k) => (
        <div key={k} className='h-5 w-full animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
      ))}
    </div>
  )
}

function WidgetError({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : 'Failed to load widget data'
  return (
    <div className='flex h-full items-center justify-center p-3 text-[12px] text-amber-600 dark:text-amber-500'>
      {msg}
    </div>
  )
}

function cellText(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  const s = String(v)
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

// ─── Markdown (safe subset: headings, lists, bold/italic/code, links) ─────────

function mdInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  text.split(re).forEach((part, i) => {
    const key = `${keyPrefix}-${i}`
    if (!part) return
    if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(<strong key={key}>{part.slice(2, -2)}</strong>)
    } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      nodes.push(<em key={key}>{part.slice(1, -1)}</em>)
    } else if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code key={key} className='rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em] dark:bg-muted'>
          {part.slice(1, -1)}
        </code>
      )
    } else {
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (link && (/^https?:\/\//i.test(link[2]) || link[2].startsWith('/'))) {
        nodes.push(
          <a key={key} href={link[2]} className='text-[#00ceff] underline-offset-2 hover:underline'>
            {link[1]}
          </a>
        )
      } else {
        nodes.push(part)
      }
    }
  })
  return nodes
}

function MarkdownBody({ content }: { content: string }) {
  const blocks: ReactNode[] = []
  let para: string[] = []
  let listItems: string[] = []
  let listOrdered = false
  const flushPara = (key: string) => {
    if (!para.length) return
    blocks.push(
      <p key={key} className='leading-relaxed'>
        {mdInline(para.join(' '), key)}
      </p>
    )
    para = []
  }
  const flushList = (key: string) => {
    if (!listItems.length) return
    const items = listItems.map((li, i) => <li key={`${key}-${i}`}>{mdInline(li, `${key}-${i}`)}</li>)
    blocks.push(
      listOrdered ? (
        <ol key={key} className='list-decimal space-y-0.5 pl-5'>
          {items}
        </ol>
      ) : (
        <ul key={key} className='list-disc space-y-0.5 pl-5'>
          {items}
        </ul>
      )
    )
    listItems = []
  }
  content.split('\n').forEach((line, idx) => {
    const key = `md-${idx}`
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    const ul = line.match(/^[-*]\s+(.*)$/)
    const ol = line.match(/^\d+\.\s+(.*)$/)
    if (heading) {
      flushList(`${key}-fl`)
      flushPara(`${key}-fp`)
      const level = heading[1].length
      const cls =
        level === 1 ? 'text-[17px] font-semibold' : level === 2 ? 'text-[15px] font-semibold' : 'text-[13.5px] font-semibold'
      blocks.push(
        <div key={key} className={`${cls} text-slate-900 dark:text-slate-100`}>
          {mdInline(heading[2], `${key}-h`)}
        </div>
      )
    } else if (ul || ol) {
      flushPara(`${key}-fp`)
      const ordered = !!ol
      if (listItems.length && listOrdered !== ordered) flushList(`${key}-fl`)
      listOrdered = ordered
      listItems.push((ul?.[1] ?? ol?.[1]) as string)
    } else if (line.trim() === '') {
      flushList(`${key}-fl`)
      flushPara(`${key}-fp`)
    } else {
      flushList(`${key}-fl`)
      para.push(line.trim())
    }
  })
  flushList('md-end-l')
  flushPara('md-end-p')
  return <div className='space-y-2 p-4 text-[13px] text-slate-700 dark:text-slate-300'>{blocks}</div>
}

// ─── Widget data (table / kpi / recent-activity) ──────────────────────────────

type WidgetData = { rows?: Record<string, unknown>[]; value?: number | null; label?: string | null }

function useWidgetData(slug: string, widget: PageRendererWidget, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<WidgetData>({
    queryKey: ['page-renderer-widget-data', slug, widget.id],
    queryFn: () =>
      client
        .request<{ data: WidgetData }>(post(`/pages/${slug}/widget-data`, { widget_id: widget.id }))
        .then((r) => r.data),
    enabled,
    retry: false,
    staleTime: 30_000
  })
}

function TableWidgetBody({ slug, widget }: { slug: string; widget: PageRendererWidget }) {
  const cfg = (widget.config ?? {}) as { collection?: string; columns?: string[] }
  const { data, isLoading, error } = useWidgetData(slug, widget, !!cfg.collection)
  const nav = useItemNavigation()
  if (!cfg.collection) return <div className='p-3 text-[12px] text-slate-400'>Select a collection</div>
  if (isLoading) return <LoadingRows />
  if (error) return <WidgetError error={error} />
  const rows = data?.rows ?? []
  if (!rows.length) return <div className='p-3 text-[12px] text-slate-400'>No records</div>
  const cols =
    cfg.columns?.length
      ? cfg.columns
      : Object.keys(rows[0])
          .filter((k) => {
            const v = rows[0][k]
            return v === null || ['string', 'number', 'boolean'].includes(typeof v)
          })
          .slice(0, 5)
  return (
    <div className='h-full overflow-auto'>
      <table className='w-full text-[12px]'>
        <thead>
          <tr className='border-b border-slate-100 dark:border-border'>
            {cols.map((c) => (
              <th key={c} className='whitespace-nowrap px-3 py-1.5 text-left font-medium text-slate-400'>
                {titleCase(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.id != null ? `${row.id}-${i}` : i}
              onClick={
                row.id != null
                  ? () => nav.open({ collection: cfg.collection as string, itemId: String(row.id) })
                  : undefined
              }
              className={`border-b border-slate-50 last:border-0 dark:border-border/50 ${
                row.id != null ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-muted/40' : ''
              }`}
            >
              {cols.map((c) => (
                <td key={c} className='whitespace-nowrap px-3 py-1.5 text-slate-700 dark:text-slate-300'>
                  {cellText(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function KpiWidgetBody({ slug, widget }: { slug: string; widget: PageRendererWidget }) {
  const cfg = (widget.config ?? {}) as { collection?: string; label?: string; aggregate?: string }
  const { data, isLoading, error } = useWidgetData(slug, widget, !!cfg.collection)
  if (!cfg.collection) return <div className='p-3 text-[12px] text-slate-400'>Select a collection</div>
  if (error) return <WidgetError error={error} />
  return (
    <div className='flex h-full flex-col items-start justify-center px-4'>
      {isLoading ? (
        <div className='h-9 w-24 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
      ) : (
        <span className='text-[32px] font-semibold leading-none tracking-tight text-slate-900 dark:text-slate-100'>
          {data?.value != null ? formatNumber(Number(data.value)) : '—'}
        </span>
      )}
      <span className='mt-1.5 text-[12px] text-slate-400'>
        {cfg.label || `${cfg.aggregate ?? 'count'} of ${cfg.collection}`}
      </span>
    </div>
  )
}

function ActivityWidgetBody({ slug, widget }: { slug: string; widget: PageRendererWidget }) {
  const { data, isLoading, error } = useWidgetData(slug, widget, true)
  if (isLoading) return <LoadingRows />
  if (error) return <WidgetError error={error} />
  const rows = (data?.rows ?? []) as Array<{
    id: number
    action: string
    collection: string | null
    item: string | null
    timestamp: string
  }>
  if (!rows.length) return <div className='p-3 text-[12px] text-slate-400'>No activity</div>
  return (
    <div className='h-full overflow-auto px-3 py-1.5'>
      {rows.map((a) => (
        <div
          key={a.id}
          className='flex items-center gap-2 border-b border-slate-50 py-1.5 text-[12px] last:border-0 dark:border-border/50'
        >
          <span className='font-medium text-slate-700 dark:text-slate-300'>{a.action}</span>
          {a.collection && (
            <span className='truncate font-mono text-[11px] text-slate-400'>
              {a.collection}
              {a.item ? ` · ${a.item}` : ''}
            </span>
          )}
          <span className='ml-auto shrink-0 text-[11px] text-slate-400'>{formatRelative(a.timestamp)}</span>
        </div>
      ))}
    </div>
  )
}

function IframeWidgetBody({ widget }: { widget: PageRendererWidget }) {
  const url = String((widget.config as { url?: string })?.url ?? '')
  if (!url) return <div className='p-3 text-[12px] text-slate-400'>Set an iframe URL</div>
  if (!/^https?:\/\//i.test(url)) {
    return <div className='p-3 text-[12px] text-amber-600'>URL must start with http(s)://</div>
  }
  return (
    <iframe
      src={url}
      title={`widget-${widget.id}`}
      sandbox='allow-scripts allow-forms allow-popups'
      className='h-full w-full border-0'
    />
  )
}

// ─── Matrix sheet (drawer host) ───────────────────────────────────────────────

function MatrixSheet({
  config,
  initialScope,
  width,
  title,
  onClose
}: {
  config: MatrixEditorConfig
  initialScope?: Record<string, unknown>
  width?: number | string
  title?: string
  onClose: () => void
}) {
  const w = typeof width === 'number' ? `${width}px` : (width ?? '85%')
  return (
    <div className='fixed inset-0 z-50 flex justify-end bg-black/30' onClick={onClose}>
      <div
        className='flex h-full flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-border dark:bg-background'
        style={{ width: w, maxWidth: '96%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-border'>
          <p className='text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
            {title ?? config.title ?? 'Manage'}
          </p>
          <button
            type='button'
            onClick={onClose}
            className='rounded px-2 py-1 text-[12px] text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
          >
            Close
          </button>
        </div>
        <div className='min-h-0 flex-1 overflow-auto'>
          <MatrixEditor config={config} initialScope={initialScope} />
        </div>
      </div>
    </div>
  )
}

function MatrixWidgetBody({ widget }: { widget: PageRendererWidget }) {
  const cfg = (widget.config ?? {}) as Partial<MatrixEditorConfig> & {
    display?: 'inline' | 'drawer'
    button_label?: string
    sheet_width?: number | string
  }
  const [open, setOpen] = useState(false)
  if (!cfg.target_collection || !cfg.option_collection || !cfg.key_field || !cfg.value_field) {
    return <div className='p-3 text-[12px] text-slate-400'>Matrix editor not configured</div>
  }
  if (cfg.display === 'drawer') {
    return (
      <div className='flex h-full items-center'>
        <button
          type='button'
          onClick={() => setOpen(true)}
          className='inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-700 shadow-sm transition-colors hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:bg-card dark:text-slate-200 dark:hover:text-nvr-cyan'
        >
          {cfg.button_label ?? cfg.title ?? 'Manage'}
        </button>
        {open && (
          <MatrixSheet config={cfg as MatrixEditorConfig} width={cfg.sheet_width} onClose={() => setOpen(false)} />
        )}
      </div>
    )
  }
  return <MatrixEditor config={cfg as MatrixEditorConfig} />
}

// ─── Query widget (param filters + row_click picker/drill/matrix) ─────────────

type QueryWidgetFilter = {
  param: string
  label?: string
  collection: string
  value_field?: string
  label_field?: string
  sort?: string
  /** Option fetch cap (default 500) — bump for big pick lists (projects). */
  limit?: number
  /** Pre-selected values on load. '$current_year' resolves to the current
   *  calendar year (EFP default-funding-year behavior). */
  default_values?: Array<string | number>
}

function defaultFilterSelection(
  filters: QueryWidgetFilter[] | undefined
): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {}
  for (const f of filters ?? []) {
    if (!f.default_values?.length) continue
    const vf = f.value_field ?? 'id'
    out[f.param] = f.default_values.map((v) => ({
      [vf]: v === '$current_year' ? new Date().getFullYear() : v
    }))
  }
  return out
}

type QueryRowClick = {
  picker?: { collection: string; filter?: Record<string, unknown>; title?: string }
  drill?: { collection?: string; layout_id?: number; width?: number | string }
  matrix?: { config: MatrixEditorConfig; scope_field: string; width?: number | string; title?: string }
  /** Open a nested query sheet for the clicked row. */
  sheet?: QuerySheetDef
}

/** A right-hand sheet hosting one (or tabbed) nested query views. Nested
 *  config `params` values may use '$row.<field>' (clicked row), '$rows.<field>'
 *  (comma-join over all visible rows — footer/'View All' drills),
 *  '$param.<name>' (parent widget's effective params) and '$filters.<param>'
 *  (parent filter selections, comma-joined). Title supports {{field}} tokens
 *  from the clicked row. */
export interface QuerySheetDef {
  title?: string
  width?: number | string
  config?: QueryWidgetConfig
  tabs?: Array<{ label: string; config: QueryWidgetConfig }>
}

export interface QueryWidgetConfig {
  query_slug?: string
  params?: Record<string, unknown>
  table?: QueryTableConfig
  row_click?: QueryRowClick
  filters?: QueryWidgetFilter[]
  stats?: QueryWidgetStat[]
  /** Trailing action buttons per row (and totals row) opening nested sheets. */
  row_actions?: Array<{ label: string; sheet: QuerySheetDef }>
  /** Toolbar action buttons running a (write) custom query — params support
   *  the same tokens as sheets ('$filters.<param>' / '$param.<name>' /
   *  '$rows.<field>'); an unresolved param blocks the run with a message.
   *  EFP 'Run Reforecasting'. */
  actions?: Array<{
    label: string
    query_slug: string
    params?: Record<string, unknown>
    confirm?: string
    success_message?: string
  }>
}

function resolveSheetValue(
  v: unknown,
  row: Record<string, unknown> | null,
  rows: Array<Record<string, unknown>>,
  effectiveParams: Record<string, unknown>,
  filterSel: Record<string, Array<Record<string, unknown>>>,
  filterDefs: QueryWidgetFilter[] | undefined
): unknown {
  if (typeof v !== 'string') return v
  if (v.startsWith('$row.')) return row?.[v.slice('$row.'.length)]
  if (v.startsWith('$rows.')) {
    const f = v.slice('$rows.'.length)
    const vals = [...new Set(rows.map((r) => r[f]).filter((x) => x != null && x !== ''))]
    return vals.length ? vals.join(',') : undefined
  }
  if (v.startsWith('$param.')) return effectiveParams[v.slice('$param.'.length)]
  if (v.startsWith('$filters.')) {
    const p = v.slice('$filters.'.length)
    const def = filterDefs?.find((f) => f.param === p)
    const sel = filterSel[p] ?? []
    return sel.length ? sel.map((r) => String(r[def?.value_field ?? 'id'] ?? '')).join(',') : undefined
  }
  return v
}

/** Resolve a nested sheet config's params against the opening context;
 *  unresolved tokens are dropped (proc-side NULL = unfiltered). */
function resolveSheetConfig(
  config: QueryWidgetConfig,
  row: Record<string, unknown> | null,
  rows: Array<Record<string, unknown>>,
  effectiveParams: Record<string, unknown>,
  filterSel: Record<string, Array<Record<string, unknown>>>,
  filterDefs: QueryWidgetFilter[] | undefined
): QueryWidgetConfig {
  const params: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config.params ?? {})) {
    const r = resolveSheetValue(v, row, rows, effectiveParams, filterSel, filterDefs)
    if (r !== undefined) params[k] = r
  }
  return { ...config, params }
}

function QuerySheet({
  def,
  row,
  onClose
}: {
  def: QuerySheetDef & { resolvedTabs: Array<{ label: string; config: QueryWidgetConfig }> }
  row: Record<string, unknown> | null
  onClose: () => void
}) {
  const [tab, setTab] = useState(0)
  const title = def.title
    ? def.title.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, f: string) => {
        const v = row?.[f]
        return v == null ? '' : String(v)
      })
    : 'Details'
  const w = typeof def.width === 'number' ? `${def.width}px` : (def.width ?? '90%')
  const active = def.resolvedTabs[tab]
  return (
    <div className='fixed inset-0 z-50 flex justify-end bg-black/30' onClick={onClose}>
      <div
        className='flex h-full flex-col border-l border-slate-200 bg-slate-50 shadow-2xl dark:border-border dark:bg-background'
        style={{ width: w, maxWidth: '96%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5 dark:border-border dark:bg-card'>
          <div className='flex items-center gap-3'>
            <p className='text-[13px] font-semibold text-slate-700 dark:text-slate-200'>{title}</p>
            {def.resolvedTabs.length > 1 && (
              <div className='flex gap-1'>
                {def.resolvedTabs.map((t, i) => (
                  <button
                    key={t.label}
                    type='button'
                    onClick={() => setTab(i)}
                    className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                      i === tab
                        ? 'bg-[#00ceff1a] text-slate-800 dark:text-slate-100'
                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type='button'
            onClick={onClose}
            className='rounded px-2 py-1 text-[12px] text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
          >
            Close
          </button>
        </div>
        <div className='min-h-0 flex-1 overflow-auto'>
          {active ? (
            <QueryWidgetView key={tab} config={active.config} />
          ) : (
            <p className='p-4 text-[12px] text-slate-400'>Sheet not configured</p>
          )}
        </div>
      </div>
    </div>
  )
}

/** '$row.<field>' tokens resolve from the clicked row; '$filters.<param>' /
 *  '$filters.<param>.<field>' resolve to arrays off the active filter
 *  selections. Empty selection → the containing top-level `_and` entry is
 *  pruned; any remaining unresolved token drops the whole filter. */
function resolveRowTokens(
  filter: Record<string, unknown> | undefined,
  row: Record<string, unknown>,
  filterSel?: Record<string, Array<Record<string, unknown>>>,
  filterDefs?: QueryWidgetFilter[]
): Record<string, unknown> | undefined {
  if (!filter) return undefined
  const filterToken = (token: string): unknown => {
    const m = /^\$filters\.(\w+)(?:\.(\w+))?$/.exec(token)
    if (!m) return undefined
    const def = filterDefs?.find((f) => f.param === m[1])
    const rows = filterSel?.[m[1]] ?? []
    if (rows.length === 0) return undefined
    const field = m[2] ?? def?.value_field ?? 'id'
    return rows.map((r) => r[field])
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('$row.')) return row[v.slice('$row.'.length)]
    if (typeof v === 'string' && v.startsWith('$filters.')) return filterToken(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
    return v
  }
  const hasUndef = (v: unknown): boolean => {
    if (v === undefined) return true
    if (Array.isArray(v)) return v.some(hasUndef)
    if (v && typeof v === 'object') return Object.values(v).some(hasUndef)
    return false
  }
  const resolved = walk(filter) as Record<string, unknown>
  if (Array.isArray(resolved._and)) {
    resolved._and = (resolved._and as unknown[]).filter((entry) => !hasUndef(entry))
  }
  return hasUndef(resolved) ? undefined : resolved
}

function QueryFilterSelect({
  filter,
  selected,
  onChange,
  allowedIds,
  scopeDefault
}: {
  filter: QueryWidgetFilter
  selected: Array<Record<string, unknown>>
  onChange: (rows: Array<Record<string, unknown>>) => void
  /** Restricted-scope ids for this dimension — narrows visible options
   *  (the items service enforces the restriction server-side regardless). */
  allowedIds?: Array<string | number>
  /** True when the selection was seeded from the user's default scopes. */
  scopeDefault?: boolean
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const valueField = filter.value_field ?? 'id'
  const labelField = filter.label_field ?? valueField
  const { data: options = [] } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['page-renderer-filter', filter.collection, valueField, labelField, filter.sort],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${filter.collection}`, {
            fields: [...new Set(['id', valueField, labelField])].join(','),
            limit: filter.limit ?? 500,
            ...(filter.sort ? { sort: filter.sort } : {})
          })
        )
        .then((r) => r.data ?? []),
    staleTime: 60_000
  })
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const label = filter.label ?? titleCase(filter.param)
  // Restricted scope narrows the option list before the search filter.
  const scoped = allowedIds?.length
    ? options.filter((o) => allowedIds.some((id) => String(id) === String(o.id)))
    : options
  const visible = scoped.filter((o) =>
    search ? String(o[labelField] ?? '').toLowerCase().includes(search.toLowerCase()) : true
  )
  const badge = allowedIds?.length
    ? {
        label: 'restricted',
        cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
        title: `Options limited to your restricted ${label} scope${scopeDefault ? '; selection seeded from your defaults' : ''}`
      }
    : scopeDefault && selected.length > 0
      ? {
          label: 'default',
          cls: 'bg-[#00ceff1f] text-[#0284a8] dark:text-[#00ceff]',
          title: `Pre-selected from your default ${label} scope — adjust freely`
        }
      : null
  return (
    <div ref={rootRef} className='relative'>
      <button
        type='button'
        onClick={() => setOpen((p) => !p)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors ${
          selected.length > 0
            ? 'border-[#00ceff] bg-[#00ceff1a] text-slate-700 dark:text-slate-200'
            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400 dark:border-border dark:bg-card dark:text-slate-300'
        }`}
      >
        <span className='font-medium'>{label}</span>
        {badge && (
          <span
            title={badge.title}
            className={`rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${badge.cls}`}
          >
            {badge.label}
          </span>
        )}
        <span className='text-slate-400'>
          {selected.length === 0
            ? 'All'
            : selected.length === 1
              ? String(selected[0][labelField] ?? selected[0][valueField] ?? '')
              : `${selected.length} selected`}
        </span>
        <span className='text-slate-400'>⌃</span>
      </button>
      {open && (
        <div className='absolute left-0 top-9 z-40 w-56 rounded-md border border-slate-200 bg-white p-1 shadow-md dark:border-border dark:bg-popover'>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search…'
            className='mb-1 h-7 w-full rounded border border-slate-200 bg-white px-2 text-[12px] outline-none dark:border-border dark:bg-background'
          />
          <div className='max-h-64 overflow-y-auto'>
            {selected.length > 0 && (
              <button
                type='button'
                onClick={() => onChange([])}
                className='flex w-full items-center rounded px-2 py-1 text-left text-[12px] text-slate-500 hover:bg-slate-100 dark:hover:bg-muted'
              >
                Clear selection
              </button>
            )}
            {visible.map((o) => {
              const v = String(o[valueField] ?? '')
              const on = selected.some((s) => String(s[valueField] ?? '') === v)
              return (
                <button
                  key={v}
                  type='button'
                  onClick={() =>
                    onChange(on ? selected.filter((s) => String(s[valueField] ?? '') !== v) : [...selected, o])
                  }
                  className='flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-muted'
                >
                  <span className={`w-3.5 shrink-0 text-[#00ceff] ${on ? '' : 'invisible'}`}>✓</span>
                  <span className='truncate'>{String(o[labelField] ?? v)}</span>
                </button>
              )
            })}
            {visible.length === 0 && <p className='px-2 py-1.5 text-[12px] text-slate-400'>No options</p>}
          </div>
        </div>
      )}
    </div>
  )
}

function QueryWidgetBody({ widget }: { widget: PageRendererWidget }) {
  return <QueryWidgetView config={(widget.config ?? {}) as QueryWidgetConfig} />
}

/** Editable record grid widget — 'drawer' display renders a lone button
 *  opening the editor in a right sheet (Manage Production Numbers pattern). */
export function RecordGridWidgetBody({ widget }: { widget: PageRendererWidget }) {
  const cfg = (widget.config ?? {}) as unknown as RecordGridEditorConfig & {
    display?: 'inline' | 'drawer'
    button_label?: string
    sheet_width?: number | string
  }
  const [open, setOpen] = useState(false)
  if (!cfg.collection) {
    return <div className='p-3 text-[12px] text-slate-400'>Configure the record grid (collection)</div>
  }
  if (cfg.display === 'drawer') {
    return (
      <div className='flex h-full items-center'>
        <button
          type='button'
          onClick={() => setOpen(true)}
          className='inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-700 shadow-sm transition-colors hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:bg-card dark:text-slate-200 dark:hover:text-nvr-cyan'
        >
          {cfg.button_label ?? cfg.title ?? 'Manage'}
        </button>
        {open && (
          <div className='fixed inset-0 z-50 flex justify-end bg-black/30' onClick={() => setOpen(false)}>
            <div
              className='flex h-full flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-border dark:bg-background'
              style={{
                width:
                  typeof cfg.sheet_width === 'number'
                    ? `${cfg.sheet_width}px`
                    : (cfg.sheet_width ?? '92%'),
                maxWidth: '96%'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className='flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-border'>
                <p className='text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
                  {cfg.button_label ?? cfg.title ?? 'Manage'}
                </p>
                <button
                  type='button'
                  onClick={() => setOpen(false)}
                  className='rounded px-2 py-1 text-[12px] text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
                >
                  Close
                </button>
              </div>
              <div className='min-h-0 flex-1 overflow-auto'>
                <RecordGridEditor config={cfg} />
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }
  return <RecordGridEditor config={cfg} />
}

/** Drawer-display query widgets render a lone button that opens the query
 *  view in a right sheet (chromeless in the grid, like drawer matrix
 *  widgets). Handled inside QueryWidgetView so every host gets it. */
function QueryDrawerButton({
  cfg
}: {
  cfg: QueryWidgetConfig & { button_label?: string; sheet_width?: number | string; label?: string }
}) {
  const [open, setOpen] = useState(false)
  const inner: QueryWidgetConfig = { ...cfg }
  delete (inner as { display?: string }).display
  return (
    <div className='flex h-full items-center'>
      <button
        type='button'
        onClick={() => setOpen(true)}
        className='inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-700 shadow-sm transition-colors hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:bg-card dark:text-slate-200 dark:hover:text-nvr-cyan'
      >
        {cfg.button_label ?? cfg.label ?? 'View'}
      </button>
        {open && (
          <div className='fixed inset-0 z-50 flex justify-end bg-black/30' onClick={() => setOpen(false)}>
            <div
              className='flex h-full flex-col border-l border-slate-200 bg-slate-50 shadow-2xl dark:border-border dark:bg-background'
              style={{
                width:
                  typeof cfg.sheet_width === 'number'
                    ? `${cfg.sheet_width}px`
                    : (cfg.sheet_width ?? '90%'),
                maxWidth: '96%'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className='flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5 dark:border-border dark:bg-card'>
                <p className='text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
                  {cfg.button_label ?? cfg.label ?? 'View'}
                </p>
                <button
                  type='button'
                  onClick={() => setOpen(false)}
                  className='rounded px-2 py-1 text-[12px] text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
                >
                  Close
                </button>
              </div>
              <div className='min-h-0 flex-1 overflow-auto'>
                <QueryWidgetInner config={inner} />
              </div>
            </div>
          </div>
        )}
      </div>
    )
}

/** The full query-widget surface (filters, stats, table, row actions, drill
 *  sheets) — shared by page renderers and nested drill sheets. A config with
 *  display:'drawer' renders as a lone trigger button instead. */
export function QueryWidgetView({ config }: { config: QueryWidgetConfig }) {
  if ((config as { display?: string }).display === 'drawer') {
    return <QueryDrawerButton cfg={config} />
  }
  return <QueryWidgetInner config={config} />
}

function QueryWidgetInner({ config: cfg }: { config: QueryWidgetConfig }) {
  const client = useNivaroClient()
  const drill = useDrilldown()
  const [pickerRow, setPickerRow] = useState<Record<string, unknown> | null>(null)
  const [matrixScopeId, setMatrixScopeId] = useState<unknown>(null)
  const [sheetState, setSheetState] = useState<{
    def: QuerySheetDef & { resolvedTabs: Array<{ label: string; config: QueryWidgetConfig }> }
    row: Record<string, unknown> | null
  } | null>(null)
  const [filterSel, setFilterSel] = useState<Record<string, Array<Record<string, unknown>>>>(() =>
    defaultFilterSelection(cfg.filters)
  )
  const [actionStatus, setActionStatus] = useState<string | null>(null)
  const [actionRun, setActionRun] = useState<ActionRunState | null>(null)
  const actionBusy = actionRun?.phase === 'running'
  const qcRef = useQueryClient()
  // Live elapsed ticker while an action runs — visible progress for the long
  // stored-proc actions (Reforecast runs for tens of seconds).
  useEffect(() => {
    if (actionRun?.phase !== 'running') return
    const t = window.setInterval(() => {
      setActionRun((cur) =>
        cur?.phase === 'running' ? { ...cur, elapsedMs: Date.now() - cur.startedAt } : cur
      )
    }, 250)
    return () => window.clearInterval(t)
  }, [actionRun?.phase])

  // Seed filters from the user's scope defaults/restrictions (Phase-2
  // semantics, same as CollectionBrowserView quick filters): config
  // default_values win, untouched filters matching a scope dimension pre-fill
  // once, and the first data fetch waits for seeding so it is already scoped.
  const { scopes, ready: scopesReady } = useMyScopes()
  const scopeSeededRef = useRef(false)
  const [scopeGateOpen, setScopeGateOpen] = useState(false)
  // Params whose selection came from default scopes — drives the visible
  // "default" badge on the filter chip so seeding isn't silent.
  const [scopeSeededParams, setScopeSeededParams] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (scopeSeededRef.current) return
    if (!scopesReady) return
    scopeSeededRef.current = true
    const specs = (cfg.filters ?? []).filter((f) => !(filterSel[f.param] ?? []).length)
    if (!scopes || !specs.length) {
      setScopeGateOpen(true)
      return
    }
    void (async () => {
      try {
        const patch: Record<string, Array<Record<string, unknown>>> = {}
        for (const f of specs) {
          const dim = matchScopeDimension(scopes, { key: f.param, collection: f.collection })
          if (!dim) continue
          const ids = effectiveScopeSeedIds(scopes, dim.name)
          if (!ids.length) continue
          const vf = f.value_field ?? 'id'
          const values = await translateScopeValues(
            client as unknown as { request: (c: unknown) => Promise<unknown> },
            dim,
            ids,
            vf
          )
          if (values.length) {
            patch[f.param] = values.map((v, i) => ({ [vf]: v, id: ids[i] }))
          }
        }
        if (Object.keys(patch).length) {
          setFilterSel((p) => {
            const next = { ...p }
            for (const [k, v] of Object.entries(patch)) {
              if (!(next[k] ?? []).length) next[k] = v
            }
            return next
          })
          setScopeSeededParams(new Set(Object.keys(patch)))
        }
      } finally {
        setScopeGateOpen(true)
      }
    })()
  }, [scopesReady, scopes, cfg.filters, filterSel, client])
  const effectiveParams = useMemo(() => {
    const p: Record<string, unknown> = { ...(cfg.params ?? {}) }
    for (const f of cfg.filters ?? []) {
      const sel = filterSel[f.param] ?? []
      if (sel.length > 0) p[f.param] = sel.map((r) => String(r[f.value_field ?? 'id'] ?? '')).join(',')
    }
    return p
  }, [cfg.params, cfg.filters, filterSel])
  // isPending, NOT isLoading: while the scope gate holds `enabled: false`,
  // isLoading is false (pending-but-not-fetching), so the widget fell through
  // and flashed "No data" before the gate opened and the loader appeared.
  // isPending stays true from mount until data actually lands; the gate always
  // settles (it opens on scope errors too), so this cannot spin forever.
  const { data, isPending, error } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['page-renderer-query', cfg.query_slug, JSON.stringify(effectiveParams)],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          post(`/custom-queries/${cfg.query_slug}/execute`, { params: effectiveParams })
        )
        .then((r) => r.data),
    enabled: !!cfg.query_slug && scopeGateOpen,
    staleTime: 60_000
  })
  const isLoading = isPending
  if (!cfg.query_slug) return <div className='p-3 text-[12px] text-slate-400'>Set a query slug</div>
  // Widget actions (e.g. "Run Reforecast") run through a styled dialog:
  // confirm → live run timer → result summary — replacing window.confirm and
  // giving long stored-proc runs visible progress instead of a frozen button.
  const runAction = (a: NonNullable<QueryWidgetConfig['actions']>[number]) => {
    const params: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(a.params ?? {})) {
      const r = resolveSheetValue(v, null, data ?? [], effectiveParams, filterSel, cfg.filters)
      if (r === undefined) {
        setActionStatus(`Select a value for "${k}" first`)
        return
      }
      params[k] = r
    }
    const confirmText = a.confirm?.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''))
    const run: ActionRunState = { action: a, params, phase: confirmText ? 'confirm' : 'running', confirmText: confirmText ?? null, startedAt: Date.now(), elapsedMs: 0 }
    setActionRun(run)
    if (!confirmText) void executeAction(run)
  }
  const executeAction = async (run: ActionRunState) => {
    const startedAt = Date.now()
    setActionRun({ ...run, phase: 'running', startedAt, elapsedMs: 0 })
    try {
      const res = (await client.request(
        post(`/custom-queries/${run.action.query_slug}/execute`, { params: run.params })
      )) as { data?: Array<Record<string, unknown>> }
      const rows = Array.isArray(res?.data) ? res.data : []
      setActionRun((cur) =>
        cur && cur.action === run.action
          ? {
              ...cur,
              phase: 'done',
              elapsedMs: Date.now() - startedAt,
              resultRows: rows.length,
              resultSample: rows[0] ?? null
            }
          : cur
      )
      setActionStatus(`${run.action.success_message ?? `${run.action.label} completed`} · ${fmtElapsed(Date.now() - startedAt)}`)
      // A run typically mutates what the widget shows — refresh it.
      void qcRef.invalidateQueries({ queryKey: ['page-renderer-query', cfg.query_slug] })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      setActionRun((cur) =>
        cur && cur.action === run.action
          ? { ...cur, phase: 'error', elapsedMs: Date.now() - startedAt, error: message }
          : cur
      )
      setActionStatus(`${run.action.label} failed: ${message}`)
    }
  }
  const filterBar =
    (cfg.filters && cfg.filters.length > 0) || cfg.actions?.length ? (
      <div className='flex flex-wrap items-center gap-2 pb-2'>
        {(cfg.filters ?? []).map((f) => {
          const dim = matchScopeDimension(scopes, { key: f.param, collection: f.collection })
          const restrictedIds = dim ? (scopes?.restricted[dim.name] ?? []) : []
          return (
            <QueryFilterSelect
              key={f.param}
              filter={f}
              selected={filterSel[f.param] ?? []}
              allowedIds={restrictedIds.length > 0 ? restrictedIds : undefined}
              scopeDefault={scopeSeededParams.has(f.param)}
              onChange={(rows) => setFilterSel((p) => ({ ...p, [f.param]: rows }))}
            />
          )
        })}
        {(cfg.actions ?? []).map((a) => (
          <button
            key={a.label}
            type='button'
            disabled={actionBusy}
            onClick={() => void runAction(a)}
            className='ml-auto inline-flex h-8 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50'
          >
            {actionBusy ? 'Running…' : a.label}
          </button>
        ))}
        {actionStatus && <span className='text-[12px] text-slate-500'>{actionStatus}</span>}
      </div>
    ) : null
  const statStrip = cfg.stats?.length ? (
    <QueryStatStrip
      stats={cfg.stats}
      rows={data ?? []}
      effectiveParams={effectiveParams}
      loading={isLoading}
    />
  ) : null
  if (isLoading)
    return (
      <div className='p-3'>
        {filterBar}
        {statStrip}
        <LoadingRows />
      </div>
    )
  if (error)
    return (
      <div className='p-3'>
        {filterBar}
        <WidgetError error={error} />
      </div>
    )
  const rc = cfg.row_click
  const openSheet = (def: QuerySheetDef, row: Record<string, unknown> | null) => {
    const rawTabs = def.tabs ?? (def.config ? [{ label: 'View', config: def.config }] : [])
    const resolvedTabs = rawTabs.map((t) => ({
      label: t.label,
      config: resolveSheetConfig(t.config, row, data ?? [], effectiveParams, filterSel, cfg.filters)
    }))
    setSheetState({ def: { ...def, resolvedTabs }, row })
  }
  const handleRow = rc
    ? (row: Record<string, unknown>) => {
        if (rc.picker) setPickerRow(row)
        else if (rc.sheet) openSheet(rc.sheet, row)
        else if (rc.matrix && row.id != null) setMatrixScopeId(row.id)
        else if (rc.drill && row.id != null) {
          drill?.open({
            collection: rc.drill.collection ?? '',
            itemId: String(row.id),
            layoutId: rc.drill.layout_id,
            width: rc.drill.width
          })
        }
      }
    : undefined
  const rowActions = cfg.row_actions?.length
    ? cfg.row_actions.map((a) => ({
        label: a.label,
        onClick: (row: Record<string, unknown> | null) => openSheet(a.sheet, row)
      }))
    : undefined
  return (
    <div
      className={
        cfg.table?.sticky
          ? // Sticky grids own their scroll: filters/stats stay pinned above a
            // scrolling table region (header/first-column/totals pin inside it).
            'flex h-full min-h-0 flex-col overflow-hidden p-3'
          : 'h-full overflow-auto p-3'
      }
    >
      {filterBar}
      {statStrip}
      <QueryTable
        rows={data ?? []}
        config={
          // Current-month highlight only applies when the selected year param
          // IS the current year (EFP guard) — otherwise strip it.
          cfg.table?.highlight_group && cfg.table.highlight_year_param
            ? Number(
                  String(effectiveParams[cfg.table.highlight_year_param] ?? '').split(',')[0]
                ) === new Date().getFullYear()
              ? cfg.table
              : { ...cfg.table, highlight_group: undefined }
            : cfg.table
        }
        onRowClick={handleRow}
        rowActions={rowActions}
        pivotYear={
          cfg.table?.pivot?.year_param
            ? Number(String(effectiveParams[cfg.table.pivot.year_param] ?? '').split(',')[0]) ||
              undefined
            : undefined
        }
      />
      {rc?.picker && pickerRow && (
        <div
          className='fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-32'
          onClick={() => setPickerRow(null)}
        >
          <div
            className='w-[420px] rounded-lg border border-slate-200 bg-white p-4 shadow-xl dark:border-border dark:bg-background'
            onClick={(e) => e.stopPropagation()}
          >
            <p className='mb-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
              {rc.picker.title ?? 'Choose a record'}
            </p>
            <RelationCombobox
              collection={rc.picker.collection}
              value={null}
              onChange={(id: unknown) => {
                setPickerRow(null)
                if (id == null) return
                if (rc.matrix) {
                  setMatrixScopeId(id)
                  return
                }
                drill?.open({
                  collection: rc.drill?.collection ?? rc.picker?.collection ?? '',
                  itemId: String(id),
                  layoutId: rc.drill?.layout_id,
                  width: rc.drill?.width
                })
              }}
              extraFilter={resolveRowTokens(rc.picker.filter, pickerRow, filterSel, cfg.filters)}
              placeholder='Search…'
            />
            <button
              type='button'
              onClick={() => setPickerRow(null)}
              className='mt-3 h-7 rounded px-2 text-[12px] text-slate-500 hover:text-slate-700'
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {rc?.matrix && matrixScopeId != null && (
        <MatrixSheet
          config={rc.matrix.config}
          initialScope={{ [rc.matrix.scope_field]: matrixScopeId }}
          width={rc.matrix.width}
          title={rc.matrix.title}
          onClose={() => setMatrixScopeId(null)}
        />
      )}
      {sheetState && (
        <QuerySheet def={sheetState.def} row={sheetState.row} onClose={() => setSheetState(null)} />
      )}
      {actionRun && (
        <ActionRunDialog
          run={actionRun}
          onConfirm={() => void executeAction(actionRun)}
          onClose={() => {
            // Running actions keep going server-side; closing just hides the
            // dialog — the inline status line still reports the outcome.
            setActionRun(null)
          }}
        />
      )}
    </div>
  )
}

// ─── Widget action run dialog ─────────────────────────────────────────────────

interface ActionRunState {
  action: { label: string; query_slug: string; success_message?: string }
  params: Record<string, unknown>
  confirmText: string | null
  phase: 'confirm' | 'running' | 'done' | 'error'
  startedAt: number
  elapsedMs: number
  resultRows?: number
  resultSample?: Record<string, unknown> | null
  error?: string
}

const fmtElapsed = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)

function ActionRunDialog({
  run,
  onConfirm,
  onClose
}: {
  run: ActionRunState
  onConfirm: () => void
  onClose: () => void
}) {
  const paramEntries = Object.entries(run.params)
  return createPortal(
    <>
      <div
        role='presentation'
        className='fixed inset-0 z-40 bg-slate-950/40'
        onClick={run.phase === 'running' ? undefined : onClose}
      />
      <div
        role='dialog'
        aria-label={run.action.label}
        aria-busy={run.phase === 'running'}
        className='fixed left-1/2 top-[24vh] z-50 w-[min(400px,92vw)] -translate-x-1/2 rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-border dark:bg-card'
      >
        <p className='text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>
          {run.action.label}
        </p>

        {paramEntries.length > 0 && (
          <dl className='mt-2 space-y-0.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11.5px] dark:bg-muted'>
            {paramEntries.map(([k, v]) => (
              <div key={k} className='flex gap-2'>
                <dt className='text-slate-500 dark:text-slate-400'>{titleCase(k)}</dt>
                <dd className='ml-auto font-medium tabular-nums text-slate-800 dark:text-slate-100'>
                  {String(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {run.phase === 'confirm' && (
          <>
            <p className='mt-2 text-[12.5px] text-slate-600 dark:text-slate-300'>{run.confirmText}</p>
            <div className='mt-3 flex gap-2'>
              <button
                type='button'
                onClick={onConfirm}
                className='h-8 flex-1 rounded-md bg-nvr-cyan text-[12.5px] font-semibold text-white hover:opacity-90'
              >
                Run
              </button>
              <button
                type='button'
                onClick={onClose}
                className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 dark:border-border dark:text-slate-300'
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {run.phase === 'running' && (
          <div className='mt-3 flex items-center gap-2.5 text-[12.5px] text-slate-600 dark:text-slate-300'>
            <span className='h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-nvr-cyan border-t-transparent' />
            Running… <span className='tabular-nums'>{fmtElapsed(run.elapsedMs)}</span>
          </div>
        )}

        {run.phase === 'done' && (
          <>
            <p className='mt-2 text-[12.5px] font-medium text-emerald-600 dark:text-emerald-400'>
              {run.action.success_message ?? 'Completed'} · {fmtElapsed(run.elapsedMs)}
            </p>
            {run.resultRows != null && run.resultRows > 0 && run.resultSample && (
              <dl className='mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11.5px] dark:bg-muted'>
                {Object.entries(run.resultSample).slice(0, 8).map(([k, v]) => (
                  <div key={k} className='flex gap-2'>
                    <dt className='text-slate-500 dark:text-slate-400'>{titleCase(k)}</dt>
                    <dd className='ml-auto font-medium tabular-nums text-slate-800 dark:text-slate-100'>
                      {String(v ?? '—')}
                    </dd>
                  </div>
                ))}
                {run.resultRows > 1 && (
                  <p className='pt-0.5 text-slate-400'>…{run.resultRows} result rows</p>
                )}
              </dl>
            )}
            <button
              type='button'
              onClick={onClose}
              className='mt-3 h-8 w-full rounded-md border border-slate-200 text-[12.5px] font-medium text-slate-600 dark:border-border dark:text-slate-300'
            >
              Close
            </button>
          </>
        )}

        {run.phase === 'error' && (
          <>
            <p className='mt-2 text-[12.5px] font-medium text-red-600 dark:text-red-400'>
              Failed after {fmtElapsed(run.elapsedMs)}: {run.error}
            </p>
            <div className='mt-3 flex gap-2'>
              <button
                type='button'
                onClick={onConfirm}
                className='h-8 flex-1 rounded-md bg-nvr-cyan text-[12.5px] font-semibold text-white hover:opacity-90'
              >
                Retry
              </button>
              <button
                type='button'
                onClick={onClose}
                className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 dark:border-border dark:text-slate-300'
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </>,
    document.body
  )
}

// ─── Widget body dispatch ─────────────────────────────────────────────────────

function WidgetBody({ slug, widget }: { slug: string; widget: PageRendererWidget }) {
  switch (widget.type) {
    case 'table':
      return <TableWidgetBody slug={slug} widget={widget} />
    case 'kpi':
      return <KpiWidgetBody slug={slug} widget={widget} />
    case 'markdown':
      return <MarkdownBody content={String((widget.config as { content?: string })?.content ?? '')} />
    case 'iframe':
      return <IframeWidgetBody widget={widget} />
    case 'query':
      return <QueryWidgetBody widget={widget} />
    case 'matrix':
      return <MatrixWidgetBody widget={widget} />
    case 'record-grid':
      return <RecordGridWidgetBody widget={widget} />
    case 'recent-activity':
      return <ActivityWidgetBody slug={slug} widget={widget} />
    default:
      return <div className='p-3 text-[12px] text-slate-400'>Unknown widget</div>
  }
}

// ─── Page renderer ────────────────────────────────────────────────────────────

export interface PageRendererProps {
  /** nivaro_pages slug to render. */
  slug: string
  /** Hide the page-name header row (host renders its own chrome). */
  hideHeader?: boolean
  className?: string
}

export function PageRenderer({ slug, hideHeader, className }: PageRendererProps) {
  const client = useNivaroClient()
  const outerDrill = useDrilldown()
  // The stack for the sheet PageRenderer hosts itself (see the outerDrill guard
  // below). It lives in the host's overlay history when one is provided, so the
  // browser's Back button steps down a drill level instead of abandoning the
  // page behind the sheet; without a host adapter this is plain state and
  // behaves exactly as it did.
  const drill = useOverlayState<DrilldownTarget[]>('drill.page')
  const drillStack = drill.value
  const { data: page, isLoading, error } = useQuery<PageRendererPage>({
    queryKey: ['page-renderer', slug],
    queryFn: () => client.request<{ data: PageRendererPage }>(get(`/pages/${slug}`)).then((r) => r.data),
    enabled: !!slug,
    retry: false
  })

  if (isLoading) {
    return (
      <div className={className ?? 'p-6'}>
        <LoadingRows />
      </div>
    )
  }
  if (error || !page) {
    return (
      <div className={`flex flex-col items-center justify-center p-10 text-center ${className ?? ''}`}>
        <p className='text-sm font-medium text-slate-600 dark:text-slate-300'>Page not found</p>
        <p className='mt-1 text-xs text-slate-400'>This page does not exist or you do not have access to it.</p>
      </div>
    )
  }

  const columns = page.layout?.columns ?? 12
  const widgets = page.layout?.widgets ?? []

  // Bands occupied only by chromeless drawer buttons collapse out of the
  // fixed-height grid into a compact flex toolbar row (mirrors PageView).
  const isToolbarBtn = (w: PageRendererWidget) =>
    (w.type === 'matrix' || w.type === 'query' || w.type === 'record-grid') &&
    (w.config as { display?: string })?.display === 'drawer'
  const toolbarYs = [...new Set(widgets.filter(isToolbarBtn).map((w) => w.y))]
    .filter((y) => widgets.every((w) => isToolbarBtn(w) || y < w.y || y >= w.y + Math.max(w.h, 1)))
    .sort((a, b) => a - b)
  const toolbarRows = toolbarYs.map((y) => ({
    y,
    items: widgets.filter((w) => w.y === y && isToolbarBtn(w)).sort((a, b) => a.x - b.x)
  }))
  const gridWidgets = widgets.filter((w) => !(isToolbarBtn(w) && toolbarYs.includes(w.y)))
  const yShift = (y: number) => y - toolbarYs.filter((ty) => ty < y).length

  const fillWidget = gridWidgets.find((w) => (w.config as { full_height?: boolean })?.full_height)

  const body = (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      {!hideHeader && (
        <div className='shrink-0 pb-4'>
          <h1 className='text-lg font-semibold text-slate-900 dark:text-slate-100'>{page.name}</h1>
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-y-auto ${fillWidget ? 'flex flex-col' : ''}`}>
        {widgets.length === 0 ? (
          <p className='p-6 text-center text-[13px] text-slate-400'>This page has no widgets yet.</p>
        ) : (
          <>
          {toolbarRows.map((row) => (
            <div key={row.y} className='mb-3 flex shrink-0 flex-wrap items-center gap-2'>
              {row.items.map((w) => (
                <WidgetBody key={w.id} slug={page.slug} widget={w} />
              ))}
            </div>
          ))}
          <div
            // Same sizing rules as the admin PageView: a full_height widget
            // needs a DEFINITE grid height so its final 1fr band resolves to
            // leftover space instead of growing to content.
            className={fillWidget ? 'grid min-h-0 flex-1 gap-4' : 'grid gap-4'}
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              // repeat(0, …) is INVALID CSS (count must be ≥1) and drops the
              // whole declaration — a fill widget in the first row band emits
              // just the stretching track.
              ...(fillWidget
                ? {
                    gridTemplateRows: `${yShift(fillWidget.y) > 0 ? `repeat(${yShift(fillWidget.y)}, ${ROW_HEIGHT}px) ` : ''}minmax(${ROW_HEIGHT * 3}px, 1fr)`
                  }
                : {}),
              gridAutoRows: `${ROW_HEIGHT}px`
            }}
          >
            {gridWidgets.map((w) => {
              const chromeless =
                (w.type === 'matrix' || w.type === 'query' || w.type === 'record-grid') &&
                (w.config as { display?: string })?.display === 'drawer'
              const fills = w === fillWidget
              return (
                <div
                  key={w.id}
                  className={
                    chromeless
                      ? 'flex min-h-0 flex-col'
                      : 'flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-border dark:bg-card'
                  }
                  style={{
                    gridColumn: `${Math.min(w.x, columns - 1) + 1} / span ${Math.min(w.w, columns)}`,
                    gridRow: fills
                      ? `${yShift(w.y) + 1} / -1`
                      : `${yShift(w.y) + 1} / span ${Math.max(w.h, 1)}`
                  }}
                >
                  {!chromeless &&
                    w.type !== 'kpi' &&
                    w.type !== 'markdown' &&
                    (w.config as { hide_label?: boolean })?.hide_label !== true && (
                      <div className='shrink-0 border-b border-slate-100 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:border-border'>
                        {String((w.config as { label?: string })?.label ?? '') ||
                          (typeof (w.config as { collection?: string })?.collection === 'string'
                            ? titleCase(String((w.config as { collection?: string }).collection))
                            : titleCase(w.type))}
                      </div>
                    )}
                  <div className='min-h-0 flex-1'>
                    <WidgetBody slug={page.slug} widget={w} />
                  </div>
                </div>
              )
            })}
          </div>
          </>
        )}
      </div>
    </div>
  )

  // Host a drill sheet when the consumer didn't provide one.
  if (outerDrill) return body
  return (
    <DrilldownContext.Provider value={{ open: (t) => drill.push([t]) }}>
      {drillStack?.length ? (
        <RecordDrilldownSheet
          collection={drillStack[0].collection}
          itemId={drillStack[0].itemId}
          layoutId={drillStack[0].layoutId}
          width={drillStack[0].width}
          title={drillStack[0].title}
          stack={drillStack}
          onPush={(target) => drill.push([...drillStack, target])}
          onPop={() => drill.back()}
          // Explicit dismissal unwinds every level in one go.
          onClose={() => drill.back(drillStack.length)}
        />
      ) : null}
      {body}
    </DrilldownContext.Provider>
  )
}
