import { useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, Check, ChevronsUpDown, LayoutDashboard } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { useContext, useEffect, useMemo, useRef } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatNumber, formatRelative, titleCase } from '@/lib/utils'
import type { CmsPage, PageWidget } from './PagesAdmin'
import {
  DrilldownContext,
  type DrilldownTarget,
  ItemEditAuthContext,
  MatrixEditor,
  type MatrixEditorConfig,
  NavigationContext,
  NivaroProvider,
  QueryStatStrip,
  QueryTable,
  type QueryTableConfig,
  type QueryWidgetConfig,
  QueryWidgetView,
  type QueryWidgetStat,
  RecordGridWidgetBody,
  RecordDrilldownSheet,
  RelationCombobox
} from '@nivaro/shared'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/lib/auth'
import { createNivaro } from '@nivaro/sdk'

const matrixClient = createNivaro(window.location.origin)

// ─── Simple markdown renderer ─────────────────────────────────────────────────
// No markdown dependency exists in the admin bundle, so this renders a safe
// subset (headings, lists, bold/italic/code, links, paragraphs) as React nodes.

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // Split on **bold**, *italic*, `code`, [text](url)
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  const parts = text.split(re)
  parts.forEach((part, i) => {
    const key = `${keyPrefix}-${i}`
    if (!part) return
    if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(<strong key={key}>{part.slice(2, -2)}</strong>)
    } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      nodes.push(<em key={key}>{part.slice(1, -1)}</em>)
    } else if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code
          key={key}
          className='rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em] dark:bg-slate-800'
        >
          {part.slice(1, -1)}
        </code>
      )
    } else {
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (link) {
        const href = link[2]
        const safe = /^https?:\/\//i.test(href) || href.startsWith('/')
        nodes.push(
          safe ? (
            <a
              key={key}
              href={href}
              target={href.startsWith('/') ? undefined : '_blank'}
              rel='noreferrer'
              className='text-nvr-cyan underline-offset-2 hover:underline'
            >
              {link[1]}
            </a>
          ) : (
            <span key={key}>{link[1]}</span>
          )
        )
      } else {
        nodes.push(<span key={key}>{part}</span>)
      }
    }
  })
  return nodes
}

export function SimpleMarkdown({ content }: { content: string }) {
  const lines = (content ?? '').split('\n')
  const blocks: ReactNode[] = []
  let listItems: string[] = []
  let listOrdered = false
  let para: string[] = []

  const flushList = (key: string) => {
    if (!listItems.length) return
    const items = listItems.map((li, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: static markdown content
      <li key={i}>{renderInline(li, `${key}-li-${i}`)}</li>
    ))
    blocks.push(
      listOrdered ? (
        <ol key={key} className='ml-5 list-decimal space-y-0.5'>
          {items}
        </ol>
      ) : (
        <ul key={key} className='ml-5 list-disc space-y-0.5'>
          {items}
        </ul>
      )
    )
    listItems = []
  }

  const flushPara = (key: string) => {
    if (!para.length) return
    blocks.push(
      <p key={key} className='leading-relaxed'>
        {renderInline(para.join(' '), `${key}-p`)}
      </p>
    )
    para = []
  }

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trimEnd()
    const key = `md-${idx}`
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    const ul = line.match(/^[-*]\s+(.*)$/)
    const ol = line.match(/^\d+[.)]\s+(.*)$/)

    if (heading) {
      flushList(`${key}-flush`)
      flushPara(`${key}-pf`)
      const level = heading[1].length
      const cls =
        level === 1
          ? 'text-[17px] font-semibold'
          : level === 2
            ? 'text-[15px] font-semibold'
            : 'text-[13.5px] font-semibold'
      blocks.push(
        <div key={key} className={cn(cls, 'text-slate-900 dark:text-slate-100')}>
          {renderInline(heading[2], `${key}-h`)}
        </div>
      )
    } else if (ul || ol) {
      flushPara(`${key}-pf`)
      const ordered = !!ol
      if (listItems.length && listOrdered !== ordered) flushList(`${key}-flush`)
      listOrdered = ordered
      listItems.push((ul?.[1] ?? ol?.[1]) as string)
    } else if (line.trim() === '') {
      flushList(`${key}-flush`)
      flushPara(`${key}-pf`)
    } else {
      flushList(`${key}-flush`)
      para.push(line.trim())
    }
  })
  flushList('md-end-list')
  flushPara('md-end-para')

  return <div className='space-y-2 text-[13px] text-slate-700 dark:text-slate-300'>{blocks}</div>
}

// ─── Widget data hook + bodies ────────────────────────────────────────────────

interface TableConfig {
  collection?: string
  columns?: string[]
  limit?: number
}

interface KpiConfig {
  label?: string
  aggregate?: string
}

function useWidgetData(slug: string, widget: PageWidget, enabled: boolean) {
  return useQuery({
    queryKey: ['page-widget-data', slug, widget.id],
    queryFn: () =>
      api
        .post<{
          data: { rows?: Record<string, unknown>[]; value?: number | null; label?: string | null }
        }>(`/pages/${slug}/widget-data`, { widget_id: widget.id })
        .then((r) => r.data.data),
    enabled,
    retry: false,
    staleTime: 30_000
  })
}

function WidgetError({ error }: { error: unknown }) {
  const msg =
    (error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
    'Failed to load widget data'
  return (
    <div className='flex h-full items-center justify-center gap-1.5 p-3 text-[12px] text-amber-600 dark:text-amber-500'>
      <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
      {msg}
    </div>
  )
}

function rowDisplayColumns(rows: Record<string, unknown>[], cfg: TableConfig): string[] {
  if (cfg.columns?.length) return cfg.columns
  const first = rows[0]
  if (!first) return []
  return Object.keys(first)
    .filter((k) => {
      const v = first[k]
      return v === null || ['string', 'number', 'boolean'].includes(typeof v)
    })
    .slice(0, 5)
}

function cellText(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v instanceof Date) return v.toLocaleString()
  const s = String(v)
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

function TableWidgetBody({ slug, widget }: { slug: string; widget: PageWidget }) {
  const cfg = (widget.config ?? {}) as TableConfig
  const { data, isLoading, error } = useWidgetData(slug, widget, !!cfg.collection)

  if (!cfg.collection) {
    return <div className='p-3 text-[12px] text-slate-400'>Select a collection</div>
  }
  if (isLoading) {
    return (
      <div className='space-y-1.5 p-3'>
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className='h-5 w-full' />
        ))}
      </div>
    )
  }
  if (error) return <WidgetError error={error} />

  const rows = data?.rows ?? []
  const cols = rowDisplayColumns(rows, cfg)

  if (!rows.length) {
    return <div className='p-3 text-[12px] text-slate-400'>No records</div>
  }

  return (
    <div className='h-full overflow-auto'>
      <table className='w-full text-[12px]'>
        <thead>
          <tr className='border-b border-slate-100 dark:border-slate-800'>
            {cols.map((c) => (
              <th
                key={c}
                className='whitespace-nowrap px-3 py-1.5 text-left font-medium text-slate-400'
              >
                {titleCase(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const id = row.id
            const cells = cols.map((c) => (
              <td
                key={c}
                className='whitespace-nowrap px-3 py-1.5 text-slate-700 dark:text-slate-300'
              >
                {cellText(row[c])}
              </td>
            ))
            return id != null ? (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: rows may lack unique keys
                key={`${id}-${i}`}
                className='border-b border-slate-50 last:border-0 hover:bg-slate-50 dark:border-slate-900 dark:hover:bg-slate-900'
              >
                {cols.map((c) => (
                  <td key={c} className='whitespace-nowrap p-0'>
                    <Link
                      to={`/collections/${cfg.collection}/${id}`}
                      className='block px-3 py-1.5 text-slate-700 dark:text-slate-300'
                    >
                      {cellText(row[c])}
                    </Link>
                  </td>
                ))}
              </tr>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows may lack unique keys
              <tr key={i} className='border-b border-slate-50 last:border-0 dark:border-slate-900'>
                {cells}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function KpiWidgetBody({ slug, widget }: { slug: string; widget: PageWidget }) {
  const cfg = (widget.config ?? {}) as KpiConfig & TableConfig
  const { data, isLoading, error } = useWidgetData(slug, widget, !!cfg.collection)

  if (!cfg.collection) {
    return <div className='p-3 text-[12px] text-slate-400'>Select a collection</div>
  }
  if (error) return <WidgetError error={error} />

  return (
    <div className='flex h-full flex-col items-start justify-center px-4'>
      {isLoading ? (
        <Skeleton className='h-9 w-24' />
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

function ActivityWidgetBody({ slug, widget }: { slug: string; widget: PageWidget }) {
  const { data, isLoading, error } = useWidgetData(slug, widget, true)

  if (isLoading) {
    return (
      <div className='space-y-1.5 p-3'>
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className='h-5 w-full' />
        ))}
      </div>
    )
  }
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
          className='flex items-center gap-2 border-b border-slate-50 py-1.5 text-[12px] last:border-0 dark:border-slate-900'
        >
          <Activity className='h-3 w-3 shrink-0 text-nvr-cyan' />
          <span className='font-medium text-slate-700 dark:text-slate-300'>{a.action}</span>
          {a.collection && (
            <span className='truncate font-mono text-[11px] text-slate-400'>
              {a.collection}
              {a.item ? ` · ${a.item}` : ''}
            </span>
          )}
          <span className='ml-auto shrink-0 text-[11px] text-slate-400'>
            {formatRelative(a.timestamp)}
          </span>
        </div>
      ))}
    </div>
  )
}

function IframeWidgetBody({ widget }: { widget: PageWidget }) {
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

/** Shared widget body renderer — used by the public page view and the builder preview. */
export function WidgetBody({ slug, widget }: { slug: string; widget: PageWidget }) {
/** Right-side sheet hosting a MatrixEditor — the EFP drawer pattern. */
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
        className='flex h-full flex-col border-l border-border bg-background shadow-2xl'
        style={{ width: w, maxWidth: '96%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5'>
          <p className='text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
            {title ?? config.title ?? 'Manage'}
          </p>
          <button
            type='button'
            onClick={onClose}
            className='rounded px-2 py-1 text-[12px] text-slate-500 hover:bg-muted hover:text-slate-700'
          >
            Close
          </button>
        </div>
        <div className='min-h-0 flex-1 overflow-auto'>
          <NivaroProvider client={matrixClient}>
            <MatrixEditor config={config} initialScope={initialScope} />
          </NivaroProvider>
        </div>
      </div>
    </div>
  )
}

function MatrixWidgetBody({ widget }: { widget: PageWidget }) {
  const cfg = (widget.config ?? {}) as Partial<MatrixEditorConfig> & {
    /** 'drawer' renders a button that opens the editor in a right sheet
     *  (EFP drill-down pattern) instead of inlining it on the page. */
    display?: 'inline' | 'drawer'
    button_label?: string
    sheet_width?: number | string
  }
  const [open, setOpen] = useState(false)
  if (!cfg.target_collection || !cfg.option_collection || !cfg.key_field || !cfg.value_field) {
    return <div className='p-3 text-[12px] text-slate-400'>Configure the matrix editor (target/option collections, key + value fields)</div>
  }
  if (cfg.display === 'drawer') {
    return (
      <div className='flex h-full items-center'>
        <button
          type='button'
          onClick={() => setOpen(true)}
          className='inline-flex h-9 items-center rounded-md border border-input bg-white px-3 text-[13px] text-slate-700 shadow-sm transition-colors hover:border-slate-400 dark:bg-card dark:text-slate-200'
        >
          {cfg.button_label ?? cfg.title ?? 'Manage'}
        </button>
        {open && (
          <MatrixSheet
            config={cfg as MatrixEditorConfig}
            width={cfg.sheet_width}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    )
  }
  return (
    <NivaroProvider client={matrixClient}>
      <MatrixEditor config={cfg as MatrixEditorConfig} />
    </NivaroProvider>
  )
}

/** Declarative param filter above a query table: options fetched from a
 *  collection, selections comma-joined into the named query param (matches the
 *  STRING_SPLIT convention the EFP procs use). */
type QueryWidgetFilter = {
  param: string
  label?: string
  collection: string
  /** Option value written into the param. Default 'id'. */
  value_field?: string
  /** Option display label. Default same as value_field. */
  label_field?: string
  sort?: string
}

function QueryFilterSelect({
  filter,
  selected,
  onChange
}: {
  filter: QueryWidgetFilter
  /** Selected OPTION ROWS (not bare values) — row_click picker filters need
   *  other fields off the selection (e.g. division id when the param carries
   *  short_name). */
  selected: Array<Record<string, unknown>>
  onChange: (rows: Array<Record<string, unknown>>) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const valueField = filter.value_field ?? 'id'
  const labelField = filter.label_field ?? valueField
  const { data: options = [] } = useQuery({
    queryKey: ['page-query-filter', filter.collection, valueField, labelField, filter.sort],
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>> }>(`/items/${filter.collection}`, {
          params: {
            fields: [...new Set(['id', valueField, labelField])].join(','),
            limit: 500,
            ...(filter.sort ? { sort: filter.sort } : {})
          }
        })
        .then((r) => r.data.data ?? []),
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
  const visible = options.filter((o) =>
    search ? String(o[labelField] ?? '').toLowerCase().includes(search.toLowerCase()) : true
  )
  return (
    <div ref={rootRef} className='relative'>
      <button
        type='button'
        onClick={() => setOpen((p) => !p)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors ${
          selected.length > 0
            ? 'border-[#00ceff] bg-[#00ceff1a] text-slate-700 dark:text-slate-200'
            : 'border-input bg-white text-slate-600 hover:border-slate-400 dark:bg-card dark:text-slate-300'
        }`}
      >
        <span className='font-medium'>{label}</span>
        <span className='text-slate-400'>
          {selected.length === 0
            ? 'All'
            : selected.length === 1
              ? String(selected[0][labelField] ?? selected[0][valueField] ?? '')
              : `${selected.length} selected`}
        </span>
        <ChevronsUpDown className='h-3 w-3 text-slate-400' />
      </button>
      {open && (
        <div className='absolute left-0 top-9 z-40 w-56 rounded-md border border-border bg-popover p-1 shadow-md'>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search…'
            className='mb-1 h-7 w-full rounded border border-input bg-background px-2 text-[12px] outline-none'
          />
          <div className='max-h-64 overflow-y-auto'>
            {selected.length > 0 && (
              <button
                type='button'
                onClick={() => onChange([])}
                className='flex w-full items-center rounded px-2 py-1 text-left text-[12px] text-slate-500 hover:bg-muted'
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
                    onChange(
                      on
                        ? selected.filter((s) => String(s[valueField] ?? '') !== v)
                        : [...selected, o]
                    )
                  }
                  className='flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-slate-200'
                >
                  <Check className={`h-3.5 w-3.5 shrink-0 ${on ? 'text-[#00ceff]' : 'invisible'}`} />
                  <span className='truncate'>{String(o[labelField] ?? v)}</span>
                </button>
              )
            })}
            {visible.length === 0 && (
              <p className='px-2 py-1.5 text-[12px] text-slate-400'>No options</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

type QueryRowClick = {
  /** Optional intermediate record picker before drilling (EFP ManageAllocations:
   *  click a project type → choose a project → open it). Filter values may use
   *  '$row.<field>' tokens resolved from the clicked row. */
  picker?: { collection: string; filter?: Record<string, unknown>; title?: string }
  drill?: { collection?: string; layout_id?: number; width?: number | string }
  /** Open a MatrixEditor sheet scoped to the chosen record instead of (or the
   *  picker result feeding) a record drill — {scope_field} names the matrix
   *  scope field the picked/clicked id lands in. */
  matrix?: {
    config: MatrixEditorConfig
    scope_field: string
    width?: number | string
    title?: string
  }
}

/** Resolve '$row.<field>' tokens from the clicked row and
 *  '$filters.<param>' / '$filters.<param>.<field>' tokens from the widget's
 *  active filter selections (array of the value_field values, or of the named
 *  field off each selected option row). A token over an EMPTY selection
 *  resolves to undefined; top-level `_and` entries containing undefined are
 *  PRUNED (no selection = clause doesn't apply — option_filter semantics). */
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

function QueryWidgetBody({ widget }: { widget: PageWidget }) {
  // Full implementation lives in @nivaro/shared (QueryWidgetView) — one code
  // path for admin pages, headless pages, and nested drill sheets. The
  // provider wrapper matters for hosts OUTSIDE PageDrillHost (PageEdit's
  // builder preview) — without it useNivaroClient throws.
  return (
    <NivaroProvider client={matrixClient}>
      <QueryWidgetView config={(widget.config ?? {}) as QueryWidgetConfig} />
    </NivaroProvider>
  )
}

  switch (widget.type) {
    case 'table':
      return <TableWidgetBody slug={slug} widget={widget} />
    case 'kpi':
      return <KpiWidgetBody slug={slug} widget={widget} />
    case 'markdown':
      return (
        <div className='h-full overflow-auto p-4'>
          <SimpleMarkdown
            content={String((widget.config as { content?: string })?.content ?? '')}
          />
        </div>
      )
    case 'iframe':
      return <IframeWidgetBody widget={widget} />
    case 'query':
      return <QueryWidgetBody widget={widget} />
    case 'matrix':
      return <MatrixWidgetBody widget={widget} />
    case 'record-grid':
      return (
        <NivaroProvider client={matrixClient}>
          <RecordGridWidgetBody widget={widget} />
        </NivaroProvider>
      )
    case 'recent-activity':
      return <ActivityWidgetBody slug={slug} widget={widget} />
    default:
      return <div className='p-3 text-[12px] text-slate-400'>Unknown widget</div>
  }
}

export const WIDGET_TYPE_LABELS: Record<PageWidget['type'], string> = {
  table: 'Table',
  kpi: 'KPI',
  markdown: 'Markdown',
  iframe: 'Iframe',
  'recent-activity': 'Recent Activity',
  query: 'Query Table',
  matrix: 'Matrix Editor',
  'record-grid': 'Record Grid'
}

// ─── Page view ────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 76

function PageDrillHost({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null)
  const drillCtx = { open: (t: DrilldownTarget) => setDrilldown(t) }
  return (
    <NivaroProvider client={matrixClient}>
      <NavigationContext.Provider value={{ navigate }}>
        <ItemEditAuthContext.Provider
          value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
        >
          <DrilldownContext.Provider value={drillCtx}>
            {drilldown && (
              <RecordDrilldownSheet
                collection={drilldown.collection}
                itemId={drilldown.itemId}
                layoutId={drilldown.layoutId}
                width={drilldown.width}
                title={drilldown.title}
                onClose={() => setDrilldown(null)}
              />
            )}
            {children}
          </DrilldownContext.Provider>
        </ItemEditAuthContext.Provider>
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}

export function PageViewPage() {
  const { slug } = useParams<{ slug: string }>()

  const {
    data: page,
    isLoading,
    error
  } = useQuery({
    queryKey: ['page', slug],
    queryFn: () => api.get<{ data: CmsPage }>(`/pages/${slug}`).then((r) => r.data.data),
    enabled: !!slug,
    retry: false
  })

  if (isLoading) {
    return (
      <div className='flex flex-1 min-h-0 flex-col p-8'>
        <Skeleton className='mb-6 h-8 w-64' />
        <div className='grid grid-cols-3 gap-4'>
          {[1, 2, 3].map((k) => (
            <Skeleton key={k} className='h-40 rounded-xl' />
          ))}
        </div>
      </div>
    )
  }

  if (error || !page) {
    return (
      <div className='flex flex-1 flex-col items-center justify-center text-center'>
        <LayoutDashboard className='mb-3 h-10 w-10 text-slate-200 dark:text-slate-700' />
        <p className='text-sm font-medium text-slate-600 dark:text-slate-300'>Page not found</p>
        <p className='mt-1 text-xs text-slate-400'>
          This page does not exist or you do not have access to it.
        </p>
      </div>
    )
  }

  const columns = page.layout?.columns ?? 12
  const widgets = page.layout?.widgets ?? []

  // Chromeless drawer-trigger buttons (query/matrix/record-grid with
  // display:'drawer') marooned in their own 76px grid band waste most of it —
  // a 32px button in an 92px-tall row. Bands occupied ONLY by such buttons
  // collapse out of the grid into a compact flex toolbar row above it.
  const isToolbarBtn = (w: PageWidget) =>
    (w.type === 'matrix' || w.type === 'query' || w.type === 'record-grid') &&
    (w.config as { display?: string })?.display === 'drawer'
  const toolbarYs = [...new Set(widgets.filter(isToolbarBtn).map((w) => w.y))]
    .filter((y) =>
      widgets.every((w) => isToolbarBtn(w) || y < w.y || y >= w.y + Math.max(w.h, 1))
    )
    .sort((a, b) => a - b)
  const toolbarRows = toolbarYs.map((y) => ({
    y,
    items: widgets.filter((w) => w.y === y && isToolbarBtn(w)).sort((a, b) => a.x - b.x)
  }))
  const gridWidgets = widgets.filter((w) => !(isToolbarBtn(w) && toolbarYs.includes(w.y)))
  // Remaining widgets shift up past the removed bands.
  const yShift = (y: number) => y - toolbarYs.filter((ty) => ty < y).length

  const fillWidget = gridWidgets.find((w) => (w.config as { full_height?: boolean })?.full_height)

  return (
    <PageDrillHost>
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-slate-800 dark:bg-slate-950'>
        <div className='flex items-center gap-2.5'>
          <LayoutDashboard className='h-5 w-5 text-nvr-cyan' />
          <h1 className='text-lg font-semibold text-slate-900 dark:text-slate-100'>{page.name}</h1>
        </div>
      </header>

      <div
        className={`flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background ${
          fillWidget ? 'flex min-h-0 flex-col' : ''
        }`}
      >
        {widgets.length === 0 ? (
          <div className='flex h-full flex-col items-center justify-center text-center'>
            <LayoutDashboard className='mb-3 h-8 w-8 text-slate-200 dark:text-slate-700' />
            <p className='text-[13px] text-slate-400'>This page has no widgets yet.</p>
          </div>
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
            // With a full_height widget the grid gets a DEFINITE height
            // (flex-1 in the flex-col scroll container) so its final 1fr band
            // resolves to leftover viewport space — under an indefinite
            // height, fr bands grow to fit content instead.
            className={fillWidget ? 'grid min-h-0 flex-1 gap-4' : 'grid gap-4'}
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              // A widget flagged full_height stretches to the bottom of the
              // viewport: fixed 76px bands above it, final band fills the rest.
              // Such a widget must sit in the LAST row band of the page.
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
              // Drawer-display matrix widgets are a lone trigger button — no
              // card chrome or label, just the button sitting in the grid.
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
                      : 'flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950'
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
                      <div className='shrink-0 border-b border-slate-100 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:border-slate-800'>
                        {String((w.config as { label?: string })?.label ?? '') ||
                          (typeof (w.config as { collection?: string })?.collection === 'string'
                            ? titleCase(String((w.config as { collection?: string }).collection))
                            : WIDGET_TYPE_LABELS[w.type])}
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
    </PageDrillHost>
  )
}
