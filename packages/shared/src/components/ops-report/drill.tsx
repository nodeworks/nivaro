import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight, ExternalLink } from 'lucide-react'
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'
import { useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import type { OpsDrill, OpsDrillColumn, OpsDrillMetric } from '../../lib/ops-report-types'
import { cn } from '../../lib/utils'

const RecordDrilldownSheet = lazy(() =>
  import('../RecordDrilldownSheet').then((m) => ({ default: m.RecordDrilldownSheet }))
)

import { QueryErrorState } from '../QueryErrorState'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'
import { Chip } from './chip'
import { ms, num } from './format'

export interface DrillTarget {
  metric: OpsDrillMetric
  key?: string | null
  /** What the breadcrumb calls this level until its title arrives. */
  label?: string
}

interface DrillCtx {
  open: (t: DrillTarget) => void
}
const Ctx = createContext<DrillCtx | null>(null)

export function useDrill(): DrillCtx | null {
  return useContext(Ctx)
}

/** Any number or row that can be opened. Plain content when there is no panel above it. */
export function Drillable({
  target,
  children,
  className,
  tip
}: {
  target: DrillTarget | null
  children: ReactNode
  className?: string
  tip?: string
}) {
  const drill = useDrill()
  if (!drill || !target) return <>{children}</>
  return (
    <button
      type='button'
      data-ops-drill={target.metric}
      data-tip={tip ?? 'Show the rows behind this'}
      onClick={() => drill.open(target)}
      className={cn(
        'cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        className
      )}
    >
      {children}
    </button>
  )
}

const STATUS_TONE: Array<[RegExp, string]> = [
  [
    /^(failed|error|bad|breached|open|refused|rejected|critical|high)/i,
    'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
  ],
  [
    /^(pending|waiting|deferred|slow|medium|watch|running|queued)/i,
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
  ],
  [
    /^(ok|done|sent|accepted|ready|success|healthy|closed|fixed)/i,
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
  ]
]

function Cell({ col, value }: { col: OpsDrillColumn; value: string | number | null | undefined }) {
  if (value == null || value === '') return <span className='text-slate-400'>–</span>
  const n = typeof value === 'number' ? value : Number(value)
  switch (col.type) {
    case 'number':
      return <>{Number.isFinite(n) ? num(n, Number.isInteger(n) ? 0 : 1) : String(value)}</>
    case 'ms':
      return <>{Number.isFinite(n) ? ms(n) : String(value)}</>
    case 'usd':
      return (
        <>
          {Number.isFinite(n)
            ? `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 0 })}`
            : String(value)}
        </>
      )
    case 'status': {
      const text = String(value)
      const tone = STATUS_TONE.find(([re]) => re.test(text))?.[1]
      return (
        <Chip
          className={
            tone ??
            'border-slate-200 bg-slate-50 text-slate-700 dark:border-border dark:bg-muted dark:text-muted-foreground'
          }
        >
          {text}
        </Chip>
      )
    }
    default:
      return <>{String(value)}</>
  }
}

function prettyBlock(text: string, kind?: string): string {
  if (kind !== 'json') return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** One level of the stack: description, detail fields and blocks, then the rows. */
function DrillLevel({
  reportId,
  target,
  onTitle,
  onDrill,
  onLink,
  onRecord
}: {
  reportId: number
  target: DrillTarget
  onTitle: (t: string) => void
  onDrill: (t: DrillTarget) => void
  onLink: (path: string) => void
  onRecord: (collection: string, id: string, title?: string) => void
}) {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: ['ops-drill', reportId, target.metric, target.key ?? null],
    queryFn: () =>
      client
        .request<{ data: OpsDrill }>(
          get(`/ops-reports/${reportId}/drill`, {
            metric: target.metric,
            ...(target.key ? { key: target.key } : {}),
            limit: 200
          })
        )
        .then((r) => r.data),
    staleTime: 60_000
  })
  const title = q.data?.title
  // biome-ignore lint/correctness/useExhaustiveDependencies: onTitle is a stable functional setState
  useEffect(() => {
    if (title) onTitle(title)
  }, [title])

  if (q.isLoading)
    return (
      <div className='space-y-2 p-5' aria-busy='true'>
        <Skeleton className='h-4 w-2/3' />
        <Skeleton className='h-32 w-full' />
      </div>
    )
  if (q.error || !q.data)
    return (
      <div className='p-5'>
        <QueryErrorState error={q.error} what='these rows' onRetry={() => void q.refetch()} />
      </div>
    )
  const d = q.data
  const cols = d.columns ?? []
  const rows = d.rows ?? []
  const anyLink = rows.some((r) => typeof r._link === 'string' && r._link)
  return (
    <div className='space-y-4 p-5' data-ops-drill-level={d.metric}>
      {d.description && (
        <SheetDescription className='text-[12.5px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
          {d.description}
        </SheetDescription>
      )}

      {d.detail && (d.detail.fields?.length ?? 0) > 0 && (
        <dl className='grid grid-cols-[130px_1fr] gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[12px] dark:border-border dark:bg-muted/40'>
          {d.detail.fields.map((f) => (
            <div key={f.label} className='contents'>
              <dt className='text-slate-500 dark:text-muted-foreground'>{f.label}</dt>
              <dd className='min-w-0 break-words text-slate-900 dark:text-foreground'>
                {f.link ? (
                  <button
                    type='button'
                    onClick={() => onLink(f.link as string)}
                    className='inline-flex items-center gap-1 text-sky-700 hover:underline dark:text-nvr-cyan'
                  >
                    {f.value ?? 'Open'}
                    <ExternalLink className='h-3 w-3' aria-hidden />
                  </button>
                ) : (
                  (f.value ?? '–')
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {(d.detail?.blocks ?? []).map((b) => (
        <div key={b.title}>
          <h4 className='mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
            {b.title}
          </h4>
          {b.kind === 'text' ? (
            <p className='whitespace-pre-wrap text-[12px] text-slate-800 dark:text-foreground'>
              {b.text}
            </p>
          ) : (
            <pre
              data-ops-block={b.kind ?? 'code'}
              className='max-h-72 overflow-auto rounded-md bg-[#0f172a] p-3 font-mono text-[11.5px] leading-relaxed text-slate-100'
            >
              {prettyBlock(b.text, b.kind)}
            </pre>
          )}
        </div>
      ))}

      {rows.length > 0 && (
        <div>
          <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
            <table className='w-full text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-slate-500 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'>
                  {cols.map((c) => (
                    <th
                      key={c.key}
                      className={cn(
                        'px-2.5 py-1.5 font-medium',
                        (c.type === 'number' || c.type === 'ms' || c.type === 'usd') && 'text-right'
                      )}
                    >
                      {c.label}
                    </th>
                  ))}
                  {anyLink && <th className='w-8' />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const dm = r._drill_metric as OpsDrillMetric | null | undefined
                  const dk = r._drill_key as string | null | undefined
                  const link = typeof r._link === 'string' && r._link ? r._link : null
                  const first = cols[0] ? r[cols[0].key] : null
                  const rc = r._record_collection
                  const ri = r._record_id
                  const isRecord = typeof rc === 'string' && rc !== '' && ri != null && ri !== ''
                  const label = first == null ? undefined : String(first)
                  const go = isRecord
                    ? () => onRecord(rc as string, String(ri), label)
                    : dm
                      ? () =>
                          onDrill({
                            metric: dm,
                            key: dk == null ? null : String(dk),
                            label: first == null ? undefined : String(first)
                          })
                      : undefined
                  return (
                    <tr
                      // biome-ignore lint/suspicious/noArrayIndexKey: drill rows have no id
                      key={i}
                      data-ops-drill-row={isRecord ? 'record' : (dm ?? undefined)}
                      tabIndex={go ? 0 : undefined}
                      onClick={go}
                      onKeyDown={
                        go
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                go()
                              }
                            }
                          : undefined
                      }
                      className={cn(
                        'border-b border-slate-100 last:border-0 dark:border-border/60',
                        go &&
                          'cursor-pointer hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50'
                      )}
                    >
                      {cols.map((c, ci) => (
                        <td
                          key={c.key}
                          className={cn(
                            'px-2.5 py-1.5 align-top text-slate-700 dark:text-foreground',
                            (c.type === 'number' || c.type === 'ms' || c.type === 'usd') &&
                              'text-right tabular-nums'
                          )}
                        >
                          <span className='inline-flex items-center gap-1'>
                            <Cell col={c} value={r[c.key]} />
                            {go && ci === 0 && (
                              <ChevronRight className='h-3 w-3 text-slate-400' aria-hidden />
                            )}
                          </span>
                        </td>
                      ))}
                      {anyLink && (
                        <td className='px-1 text-right'>
                          {link && (
                            <button
                              type='button'
                              aria-label='Open in the app'
                              data-tip='Open in the app'
                              onClick={(e) => {
                                e.stopPropagation()
                                onLink(link)
                              }}
                              className='rounded p-1 text-slate-400 hover:bg-muted hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
                            >
                              <ExternalLink className='h-3.5 w-3.5' />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p
            className='mt-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'
            data-ops-drill-total=''
          >
            {d.truncated
              ? `Showing the first ${num(rows.length)} of ${num(d.total)}`
              : `${num(d.total || rows.length)} ${(d.total || rows.length) === 1 ? 'row' : 'rows'}`}
          </p>
        </div>
      )}

      {rows.length === 0 && !d.detail && (
        <p className='py-6 text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          Nothing behind this number.
        </p>
      )}
    </div>
  )
}

/** The side panel: a stack of levels with a breadcrumb and a back step. */
export function DrillProvider({
  reportId,
  linkTo,
  children
}: {
  reportId: number
  /** Map an app path onto the host's own routes; null = the host has no such page. */
  linkTo?: (path: string) => string | null
  children: ReactNode
}) {
  const nav = useNavigation()
  const [stack, setStack] = useState<Array<DrillTarget & { title?: string }>>([])
  const [record, setRecord] = useState<{
    collection: string
    itemId: string
    title?: string
  } | null>(null)
  const open = useCallback((t: DrillTarget) => setStack([t]), [])
  const ctx = useMemo<DrillCtx>(() => ({ open }), [open])
  const top = stack[stack.length - 1]
  const onLink = useCallback(
    (path: string) => {
      let to: string | null = path
      const m = path.match(/^\/collections\/([^/?#]+)\/([^/?#]+)/)
      if (m && nav.itemUrl) to = nav.itemUrl({ collection: m[1] as string, itemId: m[2] as string })
      if (linkTo) to = linkTo(path) ?? (m ? to : null)
      if (!to) return
      // An explicit "Open": a new tab, so the report and the drawers stay where they are.
      window.open(to, '_blank', 'noopener')
    },
    [nav, linkTo]
  )

  return (
    <Ctx.Provider value={ctx}>
      {children}
      <Sheet open={stack.length > 0} onOpenChange={(o) => !o && setStack([])}>
        <SheetContent
          side='right'
          data-ops-drill-panel=''
          aria-describedby={undefined}
          className='flex w-[94vw] flex-col gap-0 p-0 sm:max-w-[760px]'
        >
          <div className='shrink-0 border-b border-slate-200 px-5 pb-3 pt-3 pr-12 dark:border-border'>
            <nav
              aria-label='Drill path'
              className='mb-1 flex min-h-[20px] flex-wrap items-center gap-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'
            >
              {stack.length > 1 && (
                <button
                  type='button'
                  data-ops-drill-back=''
                  onClick={() => setStack((s) => s.slice(0, -1))}
                  className='mr-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium text-sky-700 hover:bg-muted dark:text-nvr-cyan'
                >
                  <ArrowLeft className='h-3 w-3' aria-hidden />
                  Back
                </button>
              )}
              {stack.map((s, i) => (
                <span
                  key={`${s.metric}:${s.key ?? ''}:${i}`}
                  className='inline-flex items-center gap-1'
                >
                  {i > 0 && <ChevronRight className='h-3 w-3' aria-hidden />}
                  {i < stack.length - 1 ? (
                    <button
                      type='button'
                      onClick={() => setStack((st) => st.slice(0, i + 1))}
                      className='max-w-[160px] truncate hover:text-slate-800 hover:underline dark:hover:text-foreground'
                    >
                      {s.title ?? s.label ?? s.metric}
                    </button>
                  ) : (
                    <span className='max-w-[220px] truncate font-medium text-slate-700 dark:text-foreground'>
                      {s.title ?? s.label ?? s.metric}
                    </span>
                  )}
                </span>
              ))}
            </nav>
            <SheetTitle className='truncate text-[15px]'>
              {top?.title ?? top?.label ?? 'Loading…'}
            </SheetTitle>
          </div>
          <div className='min-h-0 flex-1 overflow-y-auto bg-white dark:bg-background'>
            {top && (
              <DrillLevel
                key={`${top.metric}:${top.key ?? ''}:${stack.length}`}
                reportId={reportId}
                target={top}
                onTitle={(title) =>
                  setStack((st) =>
                    st.map((s, i) =>
                      i === st.length - 1 && s.title !== title ? { ...s, title } : s
                    )
                  )
                }
                onDrill={(t) => setStack((st) => [...st, t])}
                onLink={onLink}
                onRecord={(collection, itemId, title) => setRecord({ collection, itemId, title })}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
      {record && (
        <Suspense fallback={null}>
          <RecordDrilldownSheet
            collection={record.collection}
            itemId={record.itemId}
            title={record.title}
            onClose={() => setRecord(null)}
          />
        </Suspense>
      )}
    </Ctx.Provider>
  )
}
