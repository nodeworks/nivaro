import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Play } from 'lucide-react'
import { useEffect } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import type { ErrorDescription } from '../../lib/error-message'
import type {
  OpsBugKind,
  OpsReport,
  OpsReportListRow,
  OpsTrackedBug
} from '../../lib/ops-report-types'
import { cn, formatDate } from '../../lib/utils'
import { AiMarkdown } from '../ai/AiMarkdown'
import { ErrorNotice } from '../ErrorNotice'
import { QueryErrorState } from '../QueryErrorState'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import { DigestSections } from './DigestSections'
import { Drillable, DrillProvider } from './drill'
import {
  arr,
  changeText,
  cost,
  type DrillRef,
  dr,
  drillForKpi,
  formatKpi,
  goodClass,
  NO_VERDICT_DOT,
  num,
  reportTokens,
  STRIP_KEYS,
  shortDay,
  statusLabel,
  VERDICT,
  weekday
} from './format'
import { Chip, MiniTable, Section, SubTitle } from './ui'

export function VerdictDot({
  verdict,
  className
}: {
  verdict: OpsReportListRow['verdict']
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        verdict ? VERDICT[verdict].dot : NO_VERDICT_DOT,
        className
      )}
    />
  )
}

/** Left column: one row per day, newest first. */
function DayList({
  rows,
  selected,
  onSelect
}: {
  rows: OpsReportListRow[]
  selected: number | null
  onSelect: (id: number) => void
}) {
  return (
    <ul className='divide-y divide-slate-100 dark:divide-border/60' data-ops-list=''>
      {rows.map((r) => (
        <li key={r.id}>
          <button
            type='button'
            data-ops-day={r.day}
            aria-current={r.id === selected ? 'true' : undefined}
            onClick={() => onSelect(r.id)}
            className={cn(
              'flex w-full flex-col gap-0.5 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50',
              r.id === selected ? 'bg-accent' : 'hover:bg-muted'
            )}
          >
            <span className='flex items-center gap-2'>
              <VerdictDot verdict={r.verdict} />
              <span className='text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                {weekday(r.day)} · {shortDay(r.day)}
              </span>
              {r.status !== 'ready' && (
                <span
                  className={cn(
                    'rounded px-1 text-[10px] font-medium',
                    r.status === 'failed'
                      ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                      : 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
                  )}
                >
                  {statusLabel(r.status)}
                </span>
              )}
              {r.status === 'running' && (
                <Loader2 className='h-3 w-3 animate-spin text-slate-400' aria-hidden />
              )}
              <span className='ml-auto text-[12px] font-semibold tabular-nums text-slate-600 dark:text-muted-foreground'>
                {r.score ?? ''}
              </span>
            </span>
            {r.headline && (
              <span className='line-clamp-2 pl-[18px] text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
                {r.headline}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

const BUG_STATUS: Record<OpsTrackedBug['status'], { label: string; cls: string }> = {
  new: {
    label: 'New',
    cls: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300'
  },
  open: {
    label: 'Open',
    cls: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
  },
  fixed: {
    label: 'Fixed',
    cls: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
  },
  came_back: {
    label: 'Came back',
    cls: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
  }
}

const BUG_KIND: Record<OpsBugKind, string> = {
  needs_dev: 'Needs a developer',
  data_fix: 'Data fix',
  partner: 'Partner',
  config: 'Config'
}

function Card({ title, children, id }: { title?: string; children: React.ReactNode; id?: string }) {
  return (
    <section
      data-ops-card={id}
      className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
    >
      {title && (
        <h3 className='mb-2 text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
          {title}
        </h3>
      )}
      {children}
    </section>
  )
}

function KpiStrip({ report }: { report: OpsReport }) {
  const deltas = arr(report.comparison?.deltas)
  const tiles = STRIP_KEYS.map((k) => deltas.find((d) => d.key === k)).filter(
    (d): d is NonNullable<typeof d> => !!d
  )
  const prevDay = report.comparison?.prev_day
  if (!tiles.length) {
    // Older report without a comparison: show the raw numbers.
    const keys = STRIP_KEYS.filter((k) => report.kpis?.[k] != null)
    if (!keys.length) return null
    return (
      <div className='grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2' data-ops-kpis=''>
        {keys.map((k) => (
          <div
            key={k}
            className='rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'
          >
            <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>
              {k.replace(/_/g, ' ')}
            </div>
            <div className='text-[18px] font-semibold tabular-nums'>{num(report.kpis[k])}</div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className='grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2' data-ops-kpis=''>
      {tiles.map((d) => (
        <Drillable key={d.key} target={drillForKpi(d.key)} className='block w-full'>
          <div
            data-ops-kpi={d.key}
            className='h-full rounded-lg border border-slate-200 bg-white px-3 py-2 hover:border-slate-300 dark:border-border dark:bg-card dark:hover:border-slate-600'
          >
            <div className='truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
              {d.label}
            </div>
            <div className='text-[18px] font-semibold leading-tight tabular-nums text-slate-900 dark:text-foreground'>
              {formatKpi(d.today, d.unit)}
            </div>
            <div className={cn('mt-0.5 text-[11px] tabular-nums', goodClass(d.good))}>
              {changeText(d)}
              <span className='text-slate-400 dark:text-muted-foreground'>
                {prevDay ? ` vs ${shortDay(prevDay)}` : ''}
              </span>
            </div>
            <div className='text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'>
              {d.week_avg == null
                ? 'no 7-day average'
                : `7-day avg ${formatKpi(d.week_avg, d.unit)}`}
            </div>
          </div>
        </Drillable>
      ))}
    </div>
  )
}

function PeopleBlock({ report }: { report: OpsReport }) {
  const p = report.digest?.people
  const k = report.kpis ?? {}
  const active = p?.active ?? k.active_people
  const today = p?.signed_in_today ?? k.signed_in_today
  const carried = p?.carried_sessions ?? k.carried_sessions
  if (active == null && today == null) return null
  const adds = active != null && today != null && carried != null && today + carried === active
  const cell = (
    label: string,
    value: number | null | undefined,
    sub: string,
    metric: Parameters<typeof dr>[0],
    strong?: boolean
  ) => (
    <Drillable target={dr(metric, null, label)} className='min-w-0 flex-1'>
      <div
        className={cn(
          'h-full rounded-md px-3 py-2',
          strong ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/15' : 'bg-slate-50 dark:bg-muted/40'
        )}
      >
        <div className='text-[11px] font-medium text-slate-600 dark:text-muted-foreground'>
          {label}
        </div>
        <div className='text-[22px] font-semibold leading-tight tabular-nums text-slate-900 dark:text-foreground'>
          {num(value)}
        </div>
        <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>{sub}</div>
      </div>
    </Drillable>
  )
  const glyph = (g: string) => (
    <span aria-hidden className='self-center text-[16px] text-slate-400'>
      {g}
    </span>
  )
  return (
    <Card title='People' id='people'>
      <div className='flex flex-wrap items-stretch gap-2'>
        {cell('Active people', active, 'did anything today', 'active_people', true)}
        {adds && glyph('=')}
        {cell('Signed in today', today, 'through Microsoft', 'signed_in_today')}
        {adds && glyph('+')}
        {cell('Still signed in', carried, 'from an earlier day', 'carried_sessions')}
      </div>
      <div className='mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4'>
        {[
          [
            'Sign-ins',
            p?.sign_ins ?? k.sign_ins,
            'one person can sign in twice',
            'signed_in_today'
          ],
          ['New accounts', p?.first_time ?? k.new_accounts, 'first time today', 'new_accounts'],
          [
            'View-as',
            p?.view_as_sessions ?? k.view_as_sessions,
            'admin sessions as someone',
            'view_as_sessions'
          ],
          [
            'Machine callers',
            arr(p?.machine_callers).length,
            'integrations and keys',
            'machine_callers'
          ]
        ].map(([label, v, sub, metric]) => (
          <Drillable
            key={label as string}
            target={dr(metric as Parameters<typeof dr>[0], null, label as string)}
            className='block w-full'
          >
            <div className='h-full rounded-md bg-slate-50 px-3 py-1.5 dark:bg-muted/40'>
              <div className='text-[11px] text-slate-600 dark:text-muted-foreground'>{label}</div>
              <div className='text-[15px] font-semibold tabular-nums'>
                {num(v as number | undefined)}
              </div>
              <div className='text-[10.5px] text-slate-500 dark:text-muted-foreground'>{sub}</div>
            </div>
          </Drillable>
        ))}
      </div>
      {arr(p?.explain).length > 0 && (
        <ul className='mt-2.5 space-y-1 border-t border-slate-100 pt-2 text-[12px] leading-relaxed text-slate-700 dark:border-border dark:text-foreground'>
          {arr(p?.explain).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
      {(arr(p?.trouble).length > 0 ||
        arr(p?.machine_callers).length > 0 ||
        arr(p?.by_role).length > 0) && (
        <div className='mt-3 grid gap-3 lg:grid-cols-3'>
          <MiniTable
            title='Hit trouble'
            rows={arr(p?.trouble)}
            drill={(r) => dr('person', r.person, r.person)}
            cols={[
              { h: 'Person', cell: (r) => r.person },
              { h: 'Errors', cell: (r) => num(r.errors), num: true },
              { h: 'Slow', cell: (r) => num(r.slow), num: true },
              { h: 'Blocked', cell: (r) => num(r.blocked), num: true }
            ]}
          />
          <MiniTable
            title='Machine callers'
            rows={arr(p?.machine_callers)}
            drill={(r) => dr('machine_callers', r.name, r.name)}
            cols={[
              { h: 'Name', cell: (r) => r.name },
              { h: 'Requests', cell: (r) => num(r.requests), num: true },
              { h: 'Errors', cell: (r) => num(r.errors), num: true }
            ]}
          />
          <MiniTable
            title='By role'
            rows={arr(p?.by_role)}
            drill={(r) => dr('active_people', r.role, r.role)}
            cols={[
              { h: 'Role', cell: (r) => r.role },
              { h: 'People', cell: (r) => num(r.people), num: true }
            ]}
          />
        </div>
      )}
    </Card>
  )
}

const SEVERITY: Record<string, string> = {
  high: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300',
  medium:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  low: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-border dark:bg-muted dark:text-muted-foreground'
}

/** Which rows sit behind one line of the health score. */
function scorePartDrill(label: string): DrillRef {
  if (/server errors/.test(label)) return dr('server_errors', null, label)
  if (/deadlocks/.test(label)) return dr('deadlocks', null, label)
  if (/over 5 s/.test(label)) return dr('over5s', null, label)
  if (/^p95/.test(label)) return dr('latency', null, label)
  if (/partner sends/.test(label)) return dr('integration_failures', null, label)
  if (/integration alarms/.test(label)) return dr('open_alarms', null, label)
  if (/failed jobs/.test(label)) return dr('job_failures', null, label)
  if (/freezes/.test(label)) return dr('issues', null, label)
  if (/hit trouble/.test(label)) return dr('trouble_people', null, label)
  if (/browser errors/.test(label)) return dr('browser_errors', null, label)
  return dr('score', null, label)
}

function ScoreBlock({ report }: { report: OpsReport }) {
  const sc = report.digest?.score
  const value = sc?.value ?? report.kpis?.health_score
  if (value == null) return null
  const parts = arr(sc?.parts).filter((p) => p.points !== 0)
  const tone = value >= 85 ? 'bg-emerald-500' : value >= 65 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <Card id='score'>
      <div className='flex flex-wrap items-start gap-x-6 gap-y-3'>
        <Drillable target={dr('score', null, 'Health score')} className='min-w-[150px]'>
          <div className='text-[11px] font-medium text-slate-600 dark:text-muted-foreground'>
            Health score
          </div>
          <div className='flex items-baseline gap-1'>
            <span className='text-[32px] font-semibold leading-none tabular-nums text-slate-900 dark:text-foreground'>
              {value}
            </span>
            <span className='text-[12px] text-slate-400'>/ 100</span>
          </div>
          <div
            className='mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
            role='img'
            aria-label={`Health score ${value} out of 100`}
          >
            <div
              className={cn('h-full rounded-full', tone)}
              style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
            />
          </div>
          <p className='mt-1.5 text-[10.5px] text-slate-500 dark:text-muted-foreground'>
            Worked out from the numbers, no AI.
          </p>
        </Drillable>
        <div className='min-w-0 flex-1'>
          <SubTitle>What took points off</SubTitle>
          {parts.length ? (
            <ul
              className='grid grid-cols-1 gap-x-6 gap-y-0.5 text-[12px] sm:grid-cols-2'
              data-ops-score-parts=''
            >
              {parts.map((p) => (
                <li key={p.label}>
                  <Drillable
                    target={scorePartDrill(p.label)}
                    className='flex w-full items-baseline justify-between gap-3'
                  >
                    <span className='truncate text-slate-700 dark:text-foreground'>{p.label}</span>
                    <span className='tabular-nums text-red-600 dark:text-red-400'>
                      −{Math.abs(p.points)}
                    </span>
                  </Drillable>
                </li>
              ))}
            </ul>
          ) : (
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              Nothing took points off.
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

function AnalysisBlock({ report }: { report: OpsReport }) {
  const a = report.analysis
  if (!a) return null
  return (
    <>
      <Card title='Summary' id='summary'>
        <div className='text-[12.5px] leading-relaxed text-slate-800 dark:text-foreground'>
          <AiMarkdown content={a.summary_md ?? ''} autolink={false} />
        </div>
      </Card>
      {arr(a.incidents).length > 0 && (
        <Card title={`Incidents (${arr(a.incidents).length})`} id='incidents'>
          <ul className='space-y-3'>
            {arr(a.incidents).map((i) => (
              <li key={i.title} data-ops-incident='' className='text-[12px]'>
                <div className='flex flex-wrap items-center gap-2'>
                  <Chip className={SEVERITY[i.severity] ?? SEVERITY.low}>{i.severity}</Chip>
                  <span className='font-semibold text-slate-900 dark:text-foreground'>
                    {i.title}
                  </span>
                  <span className='text-slate-500 dark:text-muted-foreground'>{i.when}</span>
                </div>
                <dl className='mt-1 grid grid-cols-[72px_1fr] gap-x-2 gap-y-0.5 text-slate-700 dark:text-foreground'>
                  <dt className='text-slate-500 dark:text-muted-foreground'>Impact</dt>
                  <dd>{i.impact}</dd>
                  <dt className='text-slate-500 dark:text-muted-foreground'>Cause</dt>
                  <dd>{i.cause}</dd>
                  <dt className='text-slate-500 dark:text-muted-foreground'>Evidence</dt>
                  <dd>{i.evidence}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {(arr(a.people_to_contact).length > 0 || arr(a.watch_tomorrow).length > 0) && (
        <div className='grid gap-3 lg:grid-cols-2'>
          {arr(a.people_to_contact).length > 0 && (
            <Card title='People to contact' id='contact'>
              <ul className='space-y-1.5 text-[12px]'>
                {arr(a.people_to_contact).map((p) => (
                  <li key={p.person}>
                    <span className='font-medium text-slate-900 dark:text-foreground'>
                      {p.person}
                    </span>
                    <span className='text-slate-600 dark:text-muted-foreground'> — {p.why}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {arr(a.watch_tomorrow).length > 0 && (
            <Card title='Watch tomorrow' id='watch-tomorrow'>
              <ul className='list-disc space-y-1 pl-4 text-[12px] text-slate-700 dark:text-foreground'>
                {arr(a.watch_tomorrow).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </>
  )
}

function BugTracker({ bugs }: { bugs: OpsTrackedBug[] }) {
  if (!bugs.length) return null
  return (
    <Card title={`Bug tracker (${bugs.length})`} id='tracker'>
      <MiniTable
        rows={bugs}
        drill={(b) => dr('issues', b.key, b.title)}
        cols={[
          {
            h: 'Status',
            cell: (b) => (
              <Chip className={BUG_STATUS[b.status]?.cls}>
                {BUG_STATUS[b.status]?.label ?? b.status}
              </Chip>
            )
          },
          {
            h: 'Bug',
            cell: (b) => (
              <div>
                <div className='font-medium text-slate-900 dark:text-foreground'>{b.title}</div>
                {b.impact && (
                  <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {b.impact}
                  </div>
                )}
              </div>
            )
          },
          { h: 'Kind', cell: (b) => BUG_KIND[b.kind] ?? b.kind },
          { h: 'First seen', cell: (b) => shortDay(b.first_seen) },
          { h: 'Last seen', cell: (b) => shortDay(b.last_seen) },
          { h: 'Days', cell: (b) => num(b.days_seen), num: true },
          { h: 'Today', cell: (b) => num(b.today_count), num: true },
          { h: 'Fixed in', cell: (b) => b.fixed_in ?? '', className: 'font-mono text-[11.5px]' }
        ]}
      />
    </Card>
  )
}

function AllNumbers({ report }: { report: OpsReport }) {
  const deltas = arr(report.comparison?.deltas)
  return (
    <Section
      id='all-numbers'
      title='Every number, against yesterday and the week'
      empty={!deltas.length}
      gist={`${deltas.length} numbers`}
    >
      <MiniTable
        rows={deltas}
        limit={80}
        drill={(x) => drillForKpi(x.key)}
        cols={[
          { h: 'Number', cell: (d) => d.label },
          { h: 'Today', cell: (d) => formatKpi(d.today, d.unit), num: true },
          { h: 'Yesterday', cell: (d) => formatKpi(d.prev, d.unit), num: true },
          {
            h: 'Change',
            num: true,
            cell: (d) => <span className={goodClass(d.good)}>{changeText(d)}</span>
          },
          { h: '7-day avg', cell: (d) => formatKpi(d.week_avg, d.unit), num: true }
        ]}
      />
    </Section>
  )
}

function ReportDetail({
  id,
  onRun,
  running,
  linkTo
}: {
  id: number
  onRun: (day: string) => void
  running: boolean
  linkTo?: (path: string) => string | null
}) {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: ['ops-report', id],
    queryFn: () =>
      client.request<{ data: OpsReport }>(get(`/ops-reports/${id}`)).then((r) => r.data),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 3000 : false)
  })
  const qc = useQueryClient()
  const status = q.data?.status
  // A run that just finished moves the list row from "Building" to its verdict.
  useEffect(() => {
    if (status && status !== 'running') void qc.invalidateQueries({ queryKey: ['ops-reports'] })
  }, [status, qc])

  if (q.isLoading)
    return (
      <div className='space-y-3 p-4' aria-busy='true'>
        <Skeleton className='h-24 w-full' />
        <Skeleton className='h-20 w-full' />
        <Skeleton className='h-40 w-full' />
      </div>
    )
  if (q.error || !q.data)
    return (
      <div className='p-4'>
        <QueryErrorState error={q.error} what='this report' onRetry={() => void q.refetch()} />
      </div>
    )
  const r = q.data
  const v = r.verdict ? VERDICT[r.verdict] : null
  const tokens = reportTokens(r)
  const failedDescription: ErrorDescription | null = r.error
    ? {
        title:
          r.status === 'failed'
            ? 'This report could not be built'
            : 'The AI write-up did not finish',
        hint:
          r.status === 'failed'
            ? 'Run it again. If it keeps failing, ask for help.'
            : 'The numbers below are still complete. Run it again to get the write-up.',
        technical: r.error,
        kind: 'bug'
      }
    : null

  return (
    <DrillProvider reportId={r.id} linkTo={linkTo}>
      <div className='space-y-3 p-4' data-ops-report={r.id}>
        <header className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <div className='flex flex-wrap items-start gap-3'>
            <div className='min-w-0 flex-1'>
              <div className='flex flex-wrap items-center gap-2'>
                <h2 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                  {weekday(r.day)} {formatDate(r.day)}
                </h2>
                <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                  {r.window?.label ?? ''}
                </span>
                {v ? (
                  <Chip className={cn('px-2.5 py-0.5 text-[11.5px]', v.badge)}>{v.label}</Chip>
                ) : (
                  <Chip className='border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-muted-foreground'>
                    {statusLabel(r.status)}
                  </Chip>
                )}
                {r.score != null && (
                  <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                    score{' '}
                    <span className='text-[15px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
                      {r.score}
                    </span>
                    <span className='text-slate-400'> / 100</span>
                  </span>
                )}
              </div>
              {r.headline && (
                <p className='mt-1.5 text-[13.5px] font-medium leading-snug text-slate-800 dark:text-foreground'>
                  {r.headline}
                </p>
              )}
              {(r.model || tokens != null || r.cost_usd != null) && (
                <p className='mt-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {[
                    r.model,
                    tokens != null ? `${num(tokens)} tokens` : null,
                    r.cost_usd != null ? cost(r.cost_usd) : null,
                    r.trigger === 'manual' ? 'run by hand' : null
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </div>
            <Button
              size='sm'
              variant='outline'
              className='h-8 gap-1.5 text-[12.5px]'
              disabled={running || r.status === 'running'}
              data-tip="Build this day's report again"
              onClick={() => onRun(r.day)}
            >
              {running || r.status === 'running' ? (
                <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden />
              ) : (
                <Play className='h-3.5 w-3.5' aria-hidden />
              )}
              {r.status === 'running' ? 'Building…' : 'Run now'}
            </Button>
          </div>
          {failedDescription && <ErrorNotice description={failedDescription} className='mt-3' />}
          {r.status === 'running' && (
            <p className='mt-3 text-[12px] text-slate-500 dark:text-muted-foreground' role='status'>
              The server is gathering the numbers and writing the summary. This page updates by
              itself.
            </p>
          )}
        </header>

        <ScoreBlock report={r} />
        <KpiStrip report={r} />
        <PeopleBlock report={r} />
        <AnalysisBlock report={r} />
        <BugTracker bugs={arr(r.tracker)} />

        <div>
          <SubTitle>The numbers behind it</SubTitle>
          <div className='space-y-1.5'>
            <AllNumbers report={r} />
          </div>
          <div className='mt-1.5'>
            <DigestSections report={r} />
          </div>
        </div>
      </div>
    </DrillProvider>
  )
}

export function ReportTab({
  rows,
  selected,
  onSelect,
  onRunDay,
  linkTo
}: {
  rows: OpsReportListRow[]
  selected: number | null
  onSelect: (id: number) => void
  onRunDay: (day?: string) => void
  linkTo?: (path: string) => string | null
}) {
  const running = rows.some((r) => r.status === 'running')
  if (!rows.length)
    return (
      <div className='flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center'>
        <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
          No daily reports yet
        </p>
        <p className='max-w-sm text-[12px] text-slate-500 dark:text-muted-foreground'>
          The report is built each night after the window closes. Build today's now to see what it
          looks like.
        </p>
        <Button size='sm' className='gap-1.5' onClick={() => onRunDay()} disabled={running}>
          <Play className='h-3.5 w-3.5' aria-hidden />
          Run now
        </Button>
      </div>
    )
  const current = selected ?? rows[0]?.id ?? null
  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
        <DayList rows={rows} selected={current} onSelect={onSelect} />
      </aside>
      <div className='min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        {current != null && (
          <ReportDetail id={current} onRun={onRunDay} running={running} linkTo={linkTo} />
        )}
      </div>
    </div>
  )
}
