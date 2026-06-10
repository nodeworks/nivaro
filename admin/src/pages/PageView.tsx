import { useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, LayoutDashboard } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatNumber, formatRelative, titleCase } from '@/lib/utils'
import type { CmsPage, PageWidget } from './PagesAdmin'

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
  'recent-activity': 'Recent Activity'
}

// ─── Page view ────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 76

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

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-slate-800 dark:bg-slate-950'>
        <div className='flex items-center gap-2.5'>
          <LayoutDashboard className='h-5 w-5 text-nvr-cyan' />
          <h1 className='text-lg font-semibold text-slate-900 dark:text-slate-100'>{page.name}</h1>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {widgets.length === 0 ? (
          <div className='flex h-full flex-col items-center justify-center text-center'>
            <LayoutDashboard className='mb-3 h-8 w-8 text-slate-200 dark:text-slate-700' />
            <p className='text-[13px] text-slate-400'>This page has no widgets yet.</p>
          </div>
        ) : (
          <div
            className='grid gap-4'
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              gridAutoRows: `${ROW_HEIGHT}px`
            }}
          >
            {widgets.map((w) => (
              <div
                key={w.id}
                className='flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950'
                style={{
                  gridColumn: `${Math.min(w.x, columns - 1) + 1} / span ${Math.min(w.w, columns)}`,
                  gridRow: `${w.y + 1} / span ${Math.max(w.h, 1)}`
                }}
              >
                {w.type !== 'kpi' && w.type !== 'markdown' && (
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
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
