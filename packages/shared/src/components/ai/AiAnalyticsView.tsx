import { useQuery } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  MessagesSquare,
  RotateCw,
  Search,
  ThumbsDown,
  ThumbsUp,
  X
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useApiFetchConfig, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { OutcomeChip, Panel, Segmented, ShareBar } from '../delivery-analytics/ui'
import { useParamState } from '../delivery-analytics/url'
import { QueryErrorState } from '../QueryErrorState'
import { Skeleton } from '../ui/skeleton'
import { CallDrawer } from './call-log/CallDrawer'
import { MoreFilters, MultiPicker, SavedViews } from './call-log/controls'
import {
  bucketLabel,
  bucketRange,
  featureLabel,
  num,
  pctOf,
  resultLabel,
  resultOf,
  secs,
  tok,
  usd,
  whenShort
} from './call-log/format'
import type { Breakdown, CallPage, CallRow, CallSummary } from './call-log/types'
import {
  activeChips,
  apiFilter,
  clearFilters,
  FILTER_KEYS,
  listOf,
  toggleIn,
  WINDOWS
} from './call-log/url'

/**
 * AI usage and the call log (admin AI hub → Usage). One filter drives
 * everything on the page: the figures, the trend, the breakdowns and the
 * call list all count exactly the same calls, and clicking any breakdown row
 * or trend bar narrows the filter to it. Every call opens in a drawer as a
 * readable transcript (or the raw bodies), and an Ask AI call opens its whole
 * conversation. The filter, sort, page and the open call live in the URL.
 * Reads GET /ai/call-log/* (admin; reads of people's questions are logged).
 */

const PAGE = 50

const RESULT_TONE: Record<string, string> = {
  error: 'failed',
  max_tokens: 'dropped',
  stopped: 'suppressed',
  end_turn: 'delivered',
  tool_use: 'deferred'
}

const RESULT_CHOICES = ['ok', 'error', 'end_turn', 'tool_use', 'max_tokens', 'stopped'] as const

type SortKey =
  | 'when'
  | 'feature'
  | 'person'
  | 'model'
  | 'in'
  | 'cached'
  | 'out'
  | 'cost'
  | 'time'
  | 'result'
  | 'tools'

const COLUMNS: Array<{ key: SortKey; label: string; right?: boolean; tip?: string }> = [
  { key: 'when', label: 'When' },
  { key: 'feature', label: 'Question / feature' },
  { key: 'person', label: 'Person' },
  { key: 'model', label: 'Model' },
  { key: 'in', label: 'In', right: true, tip: 'Input tokens (cached ones included)' },
  { key: 'cached', label: 'Cached', right: true, tip: 'Input tokens read from the prompt cache' },
  { key: 'out', label: 'Out', right: true, tip: 'Output tokens' },
  { key: 'cost', label: 'Cost', right: true, tip: 'At list price' },
  { key: 'time', label: 'Time', right: true },
  { key: 'result', label: 'Result' }
]

function Stat({
  label,
  value,
  sub,
  onClick,
  active,
  tip,
  className
}: {
  label: string
  value: string
  sub?: string
  onClick?: () => void
  active?: boolean
  tip?: string
  className?: string
}) {
  const body = (
    <>
      <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</div>
      <div className='mt-0.5 text-[17px] font-semibold tabular-nums tracking-[-0.01em] text-slate-900 dark:text-foreground'>
        {value}
      </div>
      {sub ? (
        <div className='truncate text-[11px] text-slate-500 dark:text-muted-foreground'>{sub}</div>
      ) : null}
    </>
  )
  const cls = cn(
    'min-w-0 bg-white px-3 py-2.5 text-left dark:bg-card',
    className,
    active && 'bg-nvr-cyan/10 dark:bg-nvr-cyan/10'
  )
  return onClick ? (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={active}
      data-tip={tip}
      className={cn(
        cls,
        'transition-colors hover:bg-slate-50 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted/50'
      )}
    >
      {body}
    </button>
  ) : (
    <div className={cls} data-tip={tip}>
      {body}
    </div>
  )
}

/** Every bucket of the window, empty ones included, so the bars read as a timeline. */
function fillSeries(s: CallSummary): CallSummary['series'] {
  const step = s.bucket === 'hour' ? 3_600_000 : 86_400_000
  const keyOf = (t: number) => {
    const iso = new Date(t).toISOString()
    return s.bucket === 'hour' ? iso.slice(0, 13) : iso.slice(0, 10)
  }
  const from = new Date(s.from).getTime()
  const to = new Date(s.to).getTime()
  const start = Math.floor(from / step) * step
  if (!Number.isFinite(start) || (to - start) / step > 2200) return s.series
  const have = new Map(s.series.map((b) => [b.bucket, b]))
  const out: CallSummary['series'] = []
  for (let t = start; t < to; t += step) {
    const k = keyOf(t)
    out.push(have.get(k) ?? { bucket: k, calls: 0, errors: 0, cost_usd: 0 })
  }
  return out
}

function Trend({ s, onPick }: { s: CallSummary; onPick: (bucket: string) => void }) {
  const series = fillSeries(s)
  const max = Math.max(1, ...series.map((x) => x.calls))
  if (!s.series.length)
    return (
      <p className='px-4 py-8 text-center text-[12px] text-slate-500'>No calls in this window.</p>
    )
  return (
    <div className='flex h-28 items-end gap-px overflow-x-auto px-4 pb-3 pt-2' data-ai-series>
      {series.map((b) => {
        const label = bucketLabel(b.bucket, s.bucket)
        const h = (b.calls / max) * 100
        return (
          <button
            key={b.bucket}
            type='button'
            disabled={b.calls === 0}
            onClick={() => onPick(b.bucket)}
            aria-label={`${label}: ${num(b.calls)} calls, ${num(b.errors)} errors, ${usd(b.cost_usd)}. Show only these calls`}
            data-tip={`${label} · ${num(b.calls)} calls${b.errors ? ` · ${num(b.errors)} errors` : ''} · ${usd(b.cost_usd)}`}
            className='group flex h-full min-w-[3px] flex-1 flex-col justify-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:cursor-default'
          >
            {b.calls > 0 && (
              <span
                className='flex flex-col overflow-hidden rounded-t-sm'
                style={{ height: `${Math.max(3, h)}%` }}
              >
                {b.errors > 0 && (
                  <span
                    className='block bg-amber-500/90'
                    style={{ height: `${Math.max(8, (b.errors / b.calls) * 100)}%` }}
                  />
                )}
                <span className='block flex-1 bg-nvr-cyan/60 transition-colors group-hover:bg-nvr-cyan' />
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function BreakdownPanel({
  title,
  rows,
  label,
  activeKeys,
  onPick,
  extra
}: {
  title: string
  rows: Breakdown[]
  label: (r: Breakdown) => string
  activeKeys: string[]
  onPick: (key: string) => void
  extra?: (r: Breakdown) => ReactNode
}) {
  const max = Math.max(1, ...rows.map((r) => r.calls))
  return (
    <Panel title={title} id={title}>
      {rows.length === 0 ? (
        <p className='px-4 py-6 text-center text-[12px] text-slate-500'>Nothing in this filter.</p>
      ) : (
        <ul className='max-h-[300px] divide-y divide-slate-100 overflow-y-auto dark:divide-border/60'>
          {rows.map((r) => {
            const key = r.key ?? 'system'
            const on = activeKeys.includes(key)
            return (
              <li key={key}>
                <button
                  type='button'
                  onClick={() => onPick(key)}
                  aria-pressed={on}
                  className={cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 text-left text-[12px] transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted/40',
                    on && 'bg-nvr-cyan/10 hover:bg-nvr-cyan/15 dark:bg-nvr-cyan/10'
                  )}
                >
                  <span className='min-w-0 truncate font-medium text-slate-800 dark:text-slate-100'>
                    {label(r)}
                  </span>
                  <span className='tabular-nums text-slate-600 dark:text-muted-foreground'>
                    {num(r.calls)} · {usd(r.cost_usd)}
                    {r.errors ? (
                      <span className='ml-1 text-red-700 dark:text-[#eaa3a3]'>
                        · {num(r.errors)} err
                      </span>
                    ) : null}
                  </span>
                  <span className='col-span-2'>
                    <ShareBar value={r.calls} max={max} />
                  </span>
                  {extra && (
                    <span className='col-span-2 text-[11px] text-slate-500'>{extra(r)}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function SortHead({
  col,
  sort,
  onSort
}: {
  col: (typeof COLUMNS)[number]
  sort: { key: SortKey; dir: 'asc' | 'desc' }
  onSort: (k: SortKey) => void
}) {
  const on = sort.key === col.key
  const Icon = on ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <th
      scope='col'
      aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('whitespace-nowrap px-2 py-2 font-semibold', col.right && 'text-right')}
    >
      <button
        type='button'
        onClick={() => onSort(col.key)}
        data-tip={col.tip}
        className={cn(
          'inline-flex items-center gap-1 rounded hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:text-foreground',
          on && 'text-slate-900 dark:text-foreground',
          col.right && 'flex-row-reverse'
        )}
      >
        {col.label}
        <Icon className={cn('h-3 w-3', on ? 'opacity-90' : 'opacity-30')} aria-hidden />
      </button>
    </th>
  )
}

function Thumbs({ fb }: { fb: CallRow['feedback'] }) {
  if (!fb || (!fb.up && !fb.down)) return null
  return (
    <span className='ml-1 inline-flex items-center gap-1 align-middle'>
      {fb.up > 0 && (
        <ThumbsUp
          className='h-3 w-3 text-green-700 dark:text-[#b9d3a6]'
          aria-label={`${fb.up} thumbs up`}
        />
      )}
      {fb.down > 0 && (
        <ThumbsDown
          className='h-3 w-3 text-red-700 dark:text-[#eaa3a3]'
          aria-label={`${fb.down} thumbs down`}
        />
      )}
    </span>
  )
}

function ResultCell({ r }: { r: CallRow }) {
  const key = resultOf(r)
  return (
    <span className='inline-flex items-center gap-1 whitespace-nowrap'>
      <OutcomeChip outcome={RESULT_TONE[key] ?? 'neutral'}>{resultLabel(key)}</OutcomeChip>
      {r.tool_calls ? (
        <span className='text-[11px] text-slate-500' data-tip={r.tools.join(', ') || undefined}>
          {r.tool_calls} tool{r.tool_calls === 1 ? '' : 's'}
        </span>
      ) : null}
      <Thumbs fb={r.feedback} />
    </span>
  )
}

function QuestionCell({ r, onRequest }: { r: CallRow; onRequest: (id: string) => void }) {
  return (
    <span className='flex min-w-0 flex-col gap-0.5'>
      {r.question ? (
        <span
          className='line-clamp-1 text-slate-900 dark:text-foreground'
          data-tip={r.question.length > 80 ? r.question : undefined}
        >
          {r.question}
        </span>
      ) : null}
      <span className='flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
        <span className='rounded bg-slate-100 px-1.5 py-px text-slate-700 dark:bg-muted dark:text-slate-300'>
          {featureLabel(r.feature)}
        </span>
        {r.request_id ? (
          <button
            type='button'
            className='rounded underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:text-foreground'
            data-tip='Show every call of this question'
            onClick={(e) => {
              e.stopPropagation()
              onRequest(r.request_id as string)
            }}
          >
            #{r.request_id.slice(0, 6)}
          </button>
        ) : null}
        {r.conversation_id ? (
          <MessagesSquare className='h-3 w-3' aria-label='Part of a saved conversation' />
        ) : null}
      </span>
    </span>
  )
}

export function AiAnalyticsView({
  search,
  onSearchChange
}: {
  /** The host's URL query; pass it with `onSearchChange` so filters and open calls are links. */
  search?: URLSearchParams
  onSearchChange?: (next: URLSearchParams, opts: { replace?: boolean }) => void
} = {}) {
  const client = useNivaroClient()
  const fetchCfg = useApiFetchConfig()
  const [params, setParams] = useParamState(search, onSearchChange)
  const filter = useMemo(() => apiFilter(params).toString(), [params])
  const sortRaw = params.get('sort') ?? '-when'
  const sort = {
    key: (sortRaw.replace(/^[+-]/, '') || 'when') as SortKey,
    dir: sortRaw.startsWith('+') ? ('asc' as const) : ('desc' as const)
  }
  const page = Math.max(1, Number(params.get('page')) || 1)
  const callId = Number(params.get('call')) || null
  const win = params.get('window') ?? '7d'

  const summary = useQuery({
    queryKey: ['nvr-ai-call-log-summary', filter],
    queryFn: () =>
      client.request<{ data: CallSummary }>(
        get('/ai/call-log/summary', Object.fromEntries(new URLSearchParams(filter)))
      ),
    placeholderData: (prev) => prev,
    refetchInterval: 120_000
  })
  const calls = useQuery({
    queryKey: ['nvr-ai-call-log', filter, sortRaw, page],
    queryFn: () =>
      client.request<CallPage>(
        get('/ai/call-log', {
          ...Object.fromEntries(new URLSearchParams(filter)),
          sort: sortRaw,
          page,
          limit: PAGE
        })
      ),
    placeholderData: (prev) => prev
  })
  const s = summary.data?.data
  const rows = calls.data?.data ?? []
  const total = calls.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const stale = summary.isPlaceholderData || calls.isPlaceholderData

  // The search box types freely; the URL follows after a pause.
  const [qText, setQText] = useState(params.get('q') ?? '')
  useEffect(() => setQText(params.get('q') ?? ''), [params])
  useEffect(() => {
    const cur = params.get('q') ?? ''
    if (qText.trim() === cur) return
    const t = setTimeout(
      () =>
        setParams(
          (p) => {
            if (qText.trim()) p.set('q', qText.trim())
            else p.delete('q')
            p.delete('page')
          },
          { replace: true }
        ),
      350
    )
    return () => clearTimeout(t)
  }, [qText, params, setParams])

  const people = useMemo(
    () => new Map((s?.facets.people ?? []).map((o) => [o.value, o.label])),
    [s?.facets.people]
  )
  const chips = activeChips(params, { people })
  const toggle = (key: string, value: string) => setParams((p) => toggleIn(p, key, value))
  const onSort = (k: SortKey) =>
    setParams(
      (p) => {
        const next = sort.key === k ? (sort.dir === 'desc' ? `+${k}` : `-${k}`) : `-${k}`
        if (next === '-when') p.delete('sort')
        else p.set('sort', next)
        p.delete('page')
      },
      { replace: true }
    )
  const openCall = (id: number) =>
    setParams((p) => {
      p.set('call', String(id))
      p.delete('thread')
    })
  const pickBucket = (b: string) => {
    if (!s) return
    const r = bucketRange(b, s.bucket)
    if (!r) return
    setParams((p) => {
      p.set('window', 'custom')
      p.set('from', r.from)
      p.set('to', r.to)
      p.delete('page')
    })
  }
  const [downloading, setDownloading] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const download = async () => {
    setDownloading(true)
    setDownloadFailed(false)
    try {
      const resp = await fetch(`${fetchCfg.apiBase}/ai/call-log/export?${filter}`, {
        headers: fetchCfg.authHeaders,
        credentials: fetchCfg.credentials
      })
      if (!resp.ok) throw new Error(String(resp.status))
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ai-calls-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch {
      setDownloadFailed(true)
    } finally {
      setDownloading(false)
    }
  }
  const customLabel =
    win === 'custom' && params.get('from')
      ? `${whenShort(params.get('from'))} – ${params.get('to') ? whenShort(params.get('to')) : 'now'}`
      : null

  return (
    <div className='flex flex-col gap-4' data-ai-analytics>
      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <div className='flex flex-col gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <Segmented
            ariaLabel='Window'
            value={win === 'custom' ? 'custom' : win}
            onChange={(v) =>
              setParams((p) => {
                if (v === 'custom') return
                p.set('window', v)
                p.delete('from')
                p.delete('to')
                p.delete('page')
              })
            }
            options={[
              ...WINDOWS.map((w) => ({ value: w.value as string, label: w.label })),
              ...(customLabel ? [{ value: 'custom', label: customLabel }] : [])
            ]}
          />
          <label className='relative flex min-w-[200px] flex-1 items-center sm:max-w-[360px]'>
            <span className='sr-only'>Search the questions people asked</span>
            <Search
              className='pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400'
              aria-hidden
            />
            <input
              type='search'
              value={qText}
              onChange={(e) => setQText(e.target.value)}
              placeholder={
                s && !s.search_ready
                  ? 'Search needs migration 539'
                  : 'Search the questions people asked'
              }
              disabled={!!s && !s.search_ready}
              data-ai-search
              className='h-8 w-full rounded-md border border-slate-200 bg-white pl-8 pr-2 text-[12.5px] text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:opacity-60 dark:border-border dark:bg-card dark:text-foreground'
            />
          </label>
          <div className='ml-auto flex items-center gap-2'>
            <SavedViews params={params} setParams={setParams} />
            <button
              type='button'
              onClick={() => void download()}
              disabled={downloading || total === 0}
              data-tip={
                downloadFailed
                  ? 'The download failed. Try again.'
                  : 'Every call in this filter, newest first'
              }
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:opacity-50',
                downloadFailed
                  ? 'border-red-300 text-red-700 dark:border-[#e08383]/40 dark:text-[#eaa3a3]'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-muted-foreground dark:hover:bg-muted'
              )}
            >
              <Download className='h-3.5 w-3.5' aria-hidden />
              {downloading ? 'Preparing…' : 'CSV'}
            </button>
            <button
              type='button'
              aria-label='Refresh'
              data-tip='Refresh'
              onClick={() => {
                void summary.refetch()
                void calls.refetch()
              }}
              className='inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-card dark:hover:bg-muted'
            >
              <RotateCw
                className={cn(
                  'h-3.5 w-3.5',
                  (summary.isFetching || calls.isFetching) &&
                    'animate-spin motion-reduce:animate-none'
                )}
                aria-hidden
              />
            </button>
          </div>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <MultiPicker
            label='Feature'
            paramKey='feature'
            params={params}
            setParams={setParams}
            options={s?.facets.features ?? []}
            render={(o) => featureLabel(o.value)}
          />
          <MultiPicker
            label='Model'
            paramKey='model'
            params={params}
            setParams={setParams}
            options={s?.facets.models ?? []}
          />
          <MultiPicker
            label='Person'
            paramKey='user'
            params={params}
            setParams={setParams}
            options={s?.facets.people ?? []}
          />
          <MultiPicker
            label='Tool'
            paramKey='tool'
            params={params}
            setParams={setParams}
            options={s?.facets.tools ?? []}
          />
          <MultiPicker
            label='Result'
            paramKey='result'
            params={params}
            setParams={setParams}
            options={RESULT_CHOICES.map((r) => ({
              value: r,
              label: resultLabel(r),
              count:
                (s?.by_result ?? []).find((x) => x.key === r)?.calls ??
                (r === 'ok' ? (s?.calls ?? 0) - (s?.errors ?? 0) : 0)
            }))}
          />
          <MoreFilters params={params} setParams={setParams} />
        </div>
        {chips.length > 0 && (
          <ul className='flex flex-wrap items-center gap-1.5' aria-label='Filters that are on'>
            {chips.map((c) => (
              <li
                key={c.key}
                className='inline-flex h-6 items-center gap-1 rounded-full border border-nvr-cyan/50 bg-nvr-cyan/10 pl-2.5 pr-1 text-[11.5px] text-slate-800 animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none dark:text-foreground'
              >
                {c.label}
                <button
                  type='button'
                  aria-label={`Remove the filter ${c.label}`}
                  onClick={() => setParams((p) => c.clear(p), { replace: true })}
                  className='inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-500 hover:bg-nvr-cyan/20 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:text-foreground'
                >
                  <X className='h-3 w-3' aria-hidden />
                </button>
              </li>
            ))}
            <li>
              <button
                type='button'
                onClick={() => setParams((p) => clearFilters(p), { replace: true })}
                className='rounded px-1.5 text-[11.5px] text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:text-foreground'
              >
                Clear all
              </button>
            </li>
          </ul>
        )}
      </div>

      {summary.isError && !s ? (
        <QueryErrorState
          error={summary.error}
          what='the AI figures'
          onRetry={() => void summary.refetch()}
        />
      ) : (
        <>
          {/* ── Figures for exactly this filter ─────────────────────── */}
          <div
            className={cn(
              'grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 transition-opacity sm:grid-cols-4 xl:grid-cols-7 dark:border-border dark:bg-border',
              stale && 'opacity-60'
            )}
            data-ai-stat-strip
            aria-busy={stale}
          >
            {s ? (
              <>
                <Stat
                  label='Questions'
                  value={num(s.questions)}
                  sub={`${(s.calls / Math.max(1, s.questions)).toFixed(1)} calls each`}
                />
                <Stat
                  label='Model calls'
                  value={num(s.calls)}
                  sub={`${num(s.tool_calls)} tool calls`}
                />
                <Stat label='Spend' value={usd(s.cost_usd)} sub='at list price' />
                <Stat
                  label='Tokens'
                  value={tok(s.input_tokens + s.output_tokens)}
                  sub={`${tok(s.cache_read_tokens)} cached · ${tok(s.output_tokens)} out`}
                />
                <Stat
                  label='Time p50 / p95'
                  value={`${secs(s.p50)} / ${secs(s.p95)}`}
                  sub={`avg ${secs(s.avg_latency)}`}
                />
                <Stat
                  label='Error rate'
                  value={pctOf(s.errors, s.calls)}
                  sub={`${num(s.errors)} failed`}
                  active={listOf(params, 'result').includes('error')}
                  onClick={
                    s.errors || listOf(params, 'result').includes('error')
                      ? () => toggle('result', 'error')
                      : undefined
                  }
                  tip='Show only the calls that failed'
                />
                <Stat
                  className='col-span-2 xl:col-span-1'
                  label='Helpful'
                  value={
                    s.feedback.up + s.feedback.down
                      ? pctOf(s.feedback.up, s.feedback.up + s.feedback.down)
                      : '–'
                  }
                  sub={`${num(s.feedback.up)} up · ${num(s.feedback.down)} down`}
                  active={params.get('feedback') === 'any'}
                  onClick={() =>
                    setParams((p) => {
                      if (p.get('feedback') === 'any') p.delete('feedback')
                      else p.set('feedback', 'any')
                      p.delete('page')
                    })
                  }
                  tip='Show only the questions people rated'
                />
              </>
            ) : (
              Array.from({ length: 7 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton cells
                <div key={i} className='bg-white px-3 py-2.5 dark:bg-card'>
                  <Skeleton className='h-3 w-16' />
                  <Skeleton className='mt-2 h-5 w-20' />
                </div>
              ))
            )}
          </div>

          {s && (
            <Panel
              title={s.bucket === 'hour' ? 'Calls per hour' : 'Calls per day'}
              hint='The amber part of a bar is calls that failed. Click a bar to see only its calls.'
            >
              <Trend s={s} onPick={pickBucket} />
            </Panel>
          )}

          {s && (
            <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-4'>
              <BreakdownPanel
                title='By feature'
                rows={s.by_feature}
                label={(r) => featureLabel(r.key ?? '')}
                activeKeys={listOf(params, 'feature')}
                onPick={(k) => toggle('feature', k)}
              />
              <BreakdownPanel
                title='By model'
                rows={s.by_model}
                label={(r) => r.key ?? ''}
                activeKeys={listOf(params, 'model')}
                onPick={(k) => toggle('model', k)}
              />
              <BreakdownPanel
                title='By person'
                rows={s.by_person}
                label={(r) => (r as Breakdown & { name?: string }).name ?? ''}
                activeKeys={listOf(params, 'user')}
                onPick={(k) => toggle('user', k)}
              />
              <BreakdownPanel
                title='By result'
                rows={s.by_result}
                label={(r) => resultLabel(r.key)}
                activeKeys={listOf(params, 'result')}
                onPick={(k) => toggle('result', k)}
              />
            </div>
          )}
        </>
      )}

      {/* ── The calls ──────────────────────────────────────────────── */}
      <section
        className='min-w-0 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
        data-ai-call-log
        aria-label='Call log'
      >
        <header className='flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
          <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>Call log</h3>
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            {num(total)} {total === 1 ? 'call' : 'calls'}
            {total > PAGE ? ` · page ${page} of ${num(pages)}` : ''}
          </span>
          <span className='ml-auto hidden text-[11.5px] text-slate-500 sm:inline dark:text-muted-foreground'>
            Click a call to read it. Bodies are kept 30 days.
          </span>
        </header>
        {calls.isError && !calls.data ? (
          <QueryErrorState
            error={calls.error}
            what='the call log'
            onRetry={() => void calls.refetch()}
          />
        ) : (
          <>
            {/* Wide screens: the table. */}
            <div
              className={cn(
                'hidden overflow-x-auto md:block',
                calls.isPlaceholderData && 'opacity-60'
              )}
            >
              <table className='w-full text-left text-[12px]'>
                <thead className='border-b border-slate-100 text-[11px] text-slate-500 dark:border-border/60 dark:text-muted-foreground'>
                  <tr>
                    {COLUMNS.map((c) => (
                      <SortHead key={c.key} col={c} sort={sort} onSort={onSort} />
                    ))}
                  </tr>
                </thead>
                <tbody className='divide-y divide-slate-100 tabular-nums dark:divide-border/60'>
                  {calls.isLoading && !rows.length
                    ? Array.from({ length: 8 }, (_, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows
                        <tr key={i}>
                          <td colSpan={COLUMNS.length} className='px-2 py-2'>
                            <Skeleton className='h-4 w-full' />
                          </td>
                        </tr>
                      ))
                    : rows.map((r) => (
                        <tr
                          key={r.id}
                          data-ai-call={r.id}
                          tabIndex={0}
                          onClick={() => openCall(r.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              openCall(r.id)
                            }
                          }}
                          aria-label={`Open call ${r.id}`}
                          className={cn(
                            'cursor-pointer transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-muted/40 dark:focus-visible:bg-muted/40',
                            callId === r.id && 'bg-nvr-cyan/10 hover:bg-nvr-cyan/10'
                          )}
                        >
                          <td
                            className='whitespace-nowrap px-2 py-2 text-slate-600 dark:text-muted-foreground'
                            data-tip={new Date(r.created_at).toLocaleString()}
                          >
                            {whenShort(r.created_at)}
                          </td>
                          <td className='max-w-[380px] px-2 py-2'>
                            <QuestionCell
                              r={r}
                              onRequest={(id) =>
                                setParams((p) => {
                                  p.set('request_id', id)
                                  p.delete('page')
                                })
                              }
                            />
                          </td>
                          <td className='max-w-[160px] truncate px-2 py-2'>
                            {r.user_name ?? 'System'}
                          </td>
                          <td className='whitespace-nowrap px-2 py-2 font-mono text-[11px]'>
                            {r.model}
                            {r.tier && (
                              <span
                                className='ml-1.5 rounded bg-slate-100 px-1 py-px font-sans text-[10px] text-slate-500 dark:bg-muted'
                                data-tip={
                                  r.tier === 'cheap'
                                    ? 'Started cheap: the small model'
                                    : `Moved up to the main model${r.tier_reason ? ` (${r.tier_reason.replace(/_/g, ' ')})` : ''}`
                                }
                              >
                                {r.tier === 'cheap' ? 'quick' : 'moved up'}
                              </span>
                            )}
                          </td>
                          <td className='px-2 py-2 text-right'>{tok(r.input_tokens)}</td>
                          <td className='px-2 py-2 text-right text-slate-500 dark:text-muted-foreground'>
                            {tok(r.cache_read_tokens)}
                          </td>
                          <td className='px-2 py-2 text-right'>{tok(r.output_tokens)}</td>
                          <td className='px-2 py-2 text-right'>{usd(r.cost_usd, 3)}</td>
                          <td className='px-2 py-2 text-right'>{secs(r.latency_ms)}</td>
                          <td className='px-2 py-2'>
                            <ResultCell r={r} />
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
            {/* Phone: one card per call, the sort as a picker. */}
            <div className='md:hidden'>
              <div className='flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-[12px] dark:border-border/60'>
                <span className='text-slate-500'>Sort</span>
                <Segmented
                  ariaLabel='Sort'
                  value={sort.key}
                  onChange={(k) => onSort(k as SortKey)}
                  options={[
                    { value: 'when', label: 'When' },
                    { value: 'cost', label: 'Cost' },
                    { value: 'time', label: 'Time' }
                  ]}
                />
                <span className='text-slate-400'>{sort.dir === 'asc' ? '↑' : '↓'}</span>
              </div>
              <ul
                className={cn(
                  'divide-y divide-slate-100 dark:divide-border/60',
                  calls.isPlaceholderData && 'opacity-60'
                )}
              >
                {rows.map((r) => (
                  <li key={r.id}>
                    <button
                      type='button'
                      onClick={() => openCall(r.id)}
                      className='flex w-full flex-col gap-1 px-3 py-2.5 text-left text-[12px] hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted/40'
                    >
                      <span className='line-clamp-2 font-medium text-slate-900 dark:text-foreground'>
                        {r.question || `${featureLabel(r.feature)} call`}
                      </span>
                      <span className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
                        <span>{whenShort(r.created_at)}</span>
                        <span>{r.user_name ?? 'System'}</span>
                        <span className='tabular-nums'>
                          {usd(r.cost_usd, 3)} · {secs(r.latency_ms)}
                        </span>
                        <ResultCell r={r} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            {rows.length === 0 && !calls.isLoading && (
              <div className='px-4 py-10 text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                {chips.length ? (
                  <>
                    No calls match these filters.{' '}
                    <button
                      type='button'
                      className='text-nvr-cyan underline-offset-2 hover:underline'
                      onClick={() => setParams((p) => clearFilters(p))}
                    >
                      Clear the filters
                    </button>
                  </>
                ) : (
                  'No AI calls in this window. Calls appear here as people use Ask AI and the other AI features.'
                )}
              </div>
            )}
            {pages > 1 && (
              <nav
                aria-label='Pages'
                className='flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-2 text-[12px] dark:border-border/60'
              >
                <button
                  type='button'
                  disabled={page <= 1}
                  onClick={() =>
                    setParams((p) => {
                      if (page - 1 <= 1) p.delete('page')
                      else p.set('page', String(page - 1))
                    })
                  }
                  className='rounded-md border border-slate-200 px-2.5 py-1 hover:bg-slate-50 disabled:opacity-40 dark:border-border dark:hover:bg-muted'
                >
                  Previous
                </button>
                <span className='tabular-nums text-slate-500'>
                  {page} / {num(pages)}
                </span>
                <button
                  type='button'
                  disabled={page >= pages}
                  onClick={() => setParams((p) => p.set('page', String(page + 1)))}
                  className='rounded-md border border-slate-200 px-2.5 py-1 hover:bg-slate-50 disabled:opacity-40 dark:border-border dark:hover:bg-muted'
                >
                  Next
                </button>
              </nav>
            )}
          </>
        )}
      </section>

      <AutofillScorecard
        days={Math.max(
          1,
          Math.round(
            (s ? new Date(s.to).getTime() - new Date(s.from).getTime() : 7 * 86_400_000) /
              86_400_000
          )
        )}
      />

      <CallDrawer
        callId={callId}
        threadOpen={params.get('thread') === '1'}
        onClose={() =>
          setParams((p) => {
            p.delete('call')
            p.delete('thread')
          })
        }
        onOpenCall={openCall}
        onThread={(open) =>
          setParams((p) => {
            if (open) p.set('thread', '1')
            else p.delete('thread')
          })
        }
      />
    </div>
  )
}

// Keys a host may want to keep when it rewrites its own query (e.g. a tab switch).
export const AI_CALL_LOG_KEYS = [...FILTER_KEYS, 'sort', 'page', 'call', 'thread'] as const

function BreakdownTable({
  title,
  heads,
  rows,
  onPick,
  active
}: {
  title: string
  heads: string[]
  rows: Array<{ key: string; label: string; cells: string[] }>
  onPick?: (key: string) => void
  active?: string
}) {
  return (
    <div
      className='overflow-x-auto rounded-lg border border-border bg-card'
      data-ai-breakdown={title}
    >
      <table className='w-full text-left text-[12px]'>
        <thead className='text-[10.5px] uppercase tracking-wide text-muted-foreground'>
          <tr className='border-b border-border'>
            <th className='px-3 py-1.5'>{title}</th>
            {heads.map((h) => (
              <th key={h} className='px-2 py-1.5 text-right'>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className='divide-y divide-border tabular-nums'>
          {rows.map((r) => (
            <tr
              key={r.key}
              className={cn(
                onPick && 'cursor-pointer hover:bg-muted/50',
                active === r.key && 'bg-nvr-cyan/10'
              )}
              onClick={() => onPick?.(r.key)}
            >
              <td className='max-w-[220px] truncate px-3 py-1.5'>{r.label}</td>
              {r.cells.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed column order
                <td key={i} className='px-2 py-1.5 text-right'>
                  {c}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={heads.length + 1}
                className='px-3 py-4 text-center text-muted-foreground'
              >
                Nothing yet
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}

// ─── Document autofill scorecard (#703) ──────────────────────────────────────

type AutofillAnalytics = {
  days: number
  documents: number
  cost_usd: number
  avg_latency_ms: number | null
  by_collection: Array<{
    collection: string
    documents: number
    fields_proposed: number
    fields_kept: number
    fields_overridden: number
    lines_proposed: number
    lines_kept: number
    asks: number
    asks_resolved: number
    cost_usd: number
    rounds: number
  }>
  by_field: Array<{
    collection: string
    field: string
    proposed: number
    kept: number
    overridden: number
    avg_confidence: number | null
  }>
  recent: Array<{
    id: number
    created_at: string
    collection: string
    document_name: string | null
    model: string | null
    rounds: number
    latency_ms: number | null
    cost_usd: number | null
    fields_proposed: number
    fields_kept: number
    fields_overridden: number
    asks: number
    asks_resolved: number
    record_id: string | null
  }>
}

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : '—'
}

/** What "Fill from document" proposed, what people kept, what they changed
 *  before Create, what it asked — per collection and per field. */
function AutofillScorecard({ days }: { days: number }) {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: ['nvr-ai-autofill-analytics', days],
    queryFn: () =>
      client.request<{ data: AutofillAnalytics }>(get('/ai/extract-record/analytics', { days })),
    refetchInterval: 60_000
  })
  const d = q.data?.data
  if (!d || d.documents === 0) return null
  return (
    <div className='flex flex-col gap-3' data-ai-autofill-scorecard>
      <div className='flex items-baseline gap-2'>
        <span className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
          Document autofill · last {d.days} days
        </span>
        <span className='text-[11.5px] text-muted-foreground'>
          {num(d.documents)} document{d.documents === 1 ? '' : 's'} · {usd(d.cost_usd)}
          {d.avg_latency_ms ? ` · ${(d.avg_latency_ms / 1000).toFixed(0)}s per document` : ''}
        </span>
      </div>
      <div className='grid gap-3 lg:grid-cols-2'>
        <BreakdownTable
          title='By collection'
          heads={['Docs', 'Kept', 'Changed', 'Lines kept', 'Asked', 'Spend']}
          rows={d.by_collection.map((r) => ({
            key: r.collection,
            label: r.collection,
            cells: [
              num(r.documents),
              `${pct(r.fields_kept, r.fields_proposed)} of ${num(r.fields_proposed)}`,
              pct(r.fields_overridden, r.fields_kept),
              `${pct(r.lines_kept, r.lines_proposed)} of ${num(r.lines_proposed)}`,
              `${num(r.asks_resolved)}/${num(r.asks)}`,
              usd(r.cost_usd)
            ]
          }))}
        />
        <BreakdownTable
          title='By field'
          heads={['Proposed', 'Kept', 'Changed', 'Conf.']}
          rows={d.by_field.slice(0, 25).map((r) => ({
            key: `${r.collection}:${r.field}`,
            label: `${r.collection} · ${r.field}`,
            cells: [
              num(r.proposed),
              pct(r.kept, r.proposed),
              pct(r.overridden, r.proposed),
              r.avg_confidence == null ? '—' : `${Math.round(r.avg_confidence * 100)}%`
            ]
          }))}
        />
      </div>
    </div>
  )
}
