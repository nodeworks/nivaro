import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft, CalendarClock, Check, Download, Link2, Siren } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { useGoBack } from '@/lib/nav'
import { cn, formatDateTime } from '@/lib/utils'
import { chaosKeys, describeTarget, errText, fetchRun } from './api'
import { ChartKey, ReportCharts } from './ReportCharts'
import { RunDetail, Timeline } from './RunDetail'
import {
  downloadPostmortem,
  type FullReport,
  fetchReport,
  fmtSeconds,
  type RunReport,
  reportKeys
} from './report-api'

/**
 * Run report (#2849) at /chaos/runs/:id — what a finished drill showed: the verdict and the
 * sampler that broke it, before / during / after charts against the normal range, how fast
 * people found out and how fast things came back, the alerts and readiness verdicts, the
 * errors people actually saw (counts and route templates only), the participants' notes and
 * the timeline. Copy link shares this page with other administrators; Export postmortem
 * downloads the same as Markdown. While the run is still going the page shows the cockpit.
 */
export function RunReportPage() {
  const { id = '' } = useParams<{ id: string }>()
  const goBack = useGoBack(`/chaos?tab=runs&run=${id}`)
  const { data, isLoading, isError, error } = useQuery<FullReport>({
    queryKey: reportKeys.report(id),
    queryFn: () => fetchReport(id),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.run.status === 'running' ? 10_000 : false)
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6 sm:py-4 dark:border-border dark:bg-card'>
        <button
          type='button'
          onClick={goBack}
          aria-label='Back'
          className='inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
        >
          <ArrowLeft className='h-4 w-4' />
        </button>
        <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nvr-cyan/15'>
          <Siren className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' />
        </div>
        <div className='min-w-0 flex-1'>
          {data ? (
            <>
              <h1 className='truncate text-base font-semibold'>{data.run.label}</h1>
              <p className='truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
                Drill report · {formatDateTime(data.run.started_at ?? data.run.created_at)}
                {typeof data.run.meta.started_by_name === 'string'
                  ? ` · started by ${data.run.meta.started_by_name}`
                  : ''}
              </p>
            </>
          ) : (
            <>
              <h1 className='text-base font-semibold'>Drill report</h1>
              <Skeleton className='mt-1 h-3 w-48' />
            </>
          )}
        </div>
        {data && data.run.status !== 'running' && <Actions data={data} />}
      </header>
      <div className='flex-1 min-h-0 overflow-y-auto bg-slate-50 dark:bg-background'>
        {isLoading ? (
          <ReportSkeleton />
        ) : isError || !data ? (
          <div className='p-6 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
            <p>{errText(error, 'This run could not be read.')}</p>
            <Link
              to='/chaos?tab=runs'
              className='mt-2 inline-block font-medium text-slate-900 underline-offset-2 hover:underline dark:text-foreground'
            >
              All runs
            </Link>
          </div>
        ) : data.run.status === 'running' ? (
          <div>
            <p className='border-b border-slate-200 bg-white px-4 py-2.5 text-[12.5px] text-slate-600 sm:px-6 dark:border-border dark:bg-card dark:text-muted-foreground'>
              This run is still going. The report fills in once the fault is disarmed.
            </p>
            <RunDetail id={id} />
          </div>
        ) : (
          <Report data={data} />
        )}
      </div>
    </div>
  )
}

function Actions({ data }: { data: FullReport }) {
  const [copied, setCopied] = useState(false)
  const exportMd = useMutation({
    mutationFn: () => downloadPostmortem(data.run.id),
    onError: (e) => toast.error(errText(e, 'The postmortem could not be exported'))
  })
  const copy = () => {
    const url = data.link ?? `${window.location.origin}/chaos/runs/${data.run.id}`
    void navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      },
      () => toast.error('The link could not be copied')
    )
  }
  const btn =
    'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:pointer-events-none disabled:opacity-40 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
  // #2852: a game day's report (or one of its fault runs) links back to the plan.
  const gamedayId = data.run.gameday_id ?? (data.run.kind === 'gameday' ? data.run.id : null)
  return (
    <div className='flex w-full items-center gap-2 sm:w-auto'>
      {gamedayId && (
        <Link to={`/chaos?tab=gamedays&gameday=${gamedayId}`} className={btn}>
          <CalendarClock className='h-3.5 w-3.5' />
          Game day plan
        </Link>
      )}
      <button
        type='button'
        onClick={copy}
        className={btn}
        data-tip='Administrators who open it see this report'
      >
        {copied ? <Check className='h-3.5 w-3.5' /> : <Link2 className='h-3.5 w-3.5' />}
        {copied ? 'Copied' : 'Copy link'}
      </button>
      <button
        type='button'
        onClick={() => exportMd.mutate()}
        disabled={exportMd.isPending}
        className={btn}
        data-tip='Markdown: timeline, figures and notes, no record data'
      >
        <Download className='h-3.5 w-3.5' />
        Export postmortem
      </button>
    </div>
  )
}

function ReportSkeleton() {
  return (
    <div className='space-y-5 p-4 sm:p-6'>
      <Skeleton className='h-14 w-full' />
      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg sm:grid-cols-3 lg:grid-cols-6'>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className='h-14 rounded-none' />
        ))}
      </div>
      <div className='grid gap-4 lg:grid-cols-2'>
        <Skeleton className='h-56' />
        <Skeleton className='h-56' />
      </div>
    </div>
  )
}

// ─── The report ───────────────────────────────────────────────────────────────

function Report({ data }: { data: FullReport }) {
  const { run, report, errors, names } = data
  const ranFor =
    report.armed_at && report.disarmed_at
      ? Math.round(
          (new Date(report.disarmed_at).getTime() - new Date(report.armed_at).getTime()) / 1000
        )
      : null
  return (
    <div className='space-y-6 p-4 sm:p-6'>
      <VerdictHeader data={data} />

      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 xl:grid-cols-6 dark:border-border dark:bg-border'>
        <Stat
          label='Time to detect'
          value={fmtSeconds(report.ttd_s)}
          hint={
            report.ttd_source === 'alert'
              ? 'first alert'
              : report.ttd_source === 'noticed'
                ? 'first "noticed" note'
                : report.ttd_source === 'declared'
                  ? 'incident declared'
                  : report.ttd_source === 'recorded'
                    ? 'recorded by the run'
                    : 'no alert or note'
          }
        />
        <Stat
          label='Time to fix'
          value={fmtSeconds(report.ttf_s)}
          hint={report.ttf_s == null ? 'no "fixed" note' : 'first "fixed" note'}
        />
        <Stat
          label='Time to recover'
          value={report.ttr_state === 'recovered' ? fmtSeconds(report.ttr_s) : '—'}
          hint={
            report.ttr_state === 'recovered'
              ? 'back in the normal range'
              : report.ttr_state === 'not_recovered'
                ? 'not back while watched'
                : 'no samples afterwards'
          }
          tone={report.ttr_state === 'not_recovered' ? 'warn' : undefined}
        />
        <Stat label='Fault ran' value={fmtSeconds(ranFor)} hint={describeTarget(run.target)} />
        <Stat
          label='Alerts'
          value={String(report.alerts.length)}
          hint={report.alerts.length ? 'fired during the run' : 'none fired'}
        />
        <Stat
          label='Errors people saw'
          value={errors?.available ? String(errors.server_total) : '—'}
          hint={
            errors?.available
              ? `${errors.people} ${errors.people === 1 ? 'person' : 'people'} · server errors`
              : 'not readable here'
          }
          tone={errors?.available && errors.server_total > 0 ? 'warn' : undefined}
        />
      </div>

      <Section title='Before, during and after' aside={<ChartKey />}>
        <ReportCharts report={report} />
      </Section>

      <div className='grid gap-6 xl:grid-cols-2'>
        <Section title='Alerts'>
          <AlertsList report={report} />
        </Section>
        <Section title='Readiness during the run'>
          <ReadinessList report={report} />
        </Section>
      </div>

      <div className='grid gap-6 xl:grid-cols-2'>
        <Section title='Errors people saw'>
          <ErrorsPanel data={data} />
        </Section>
        <Section title='Notes'>
          <NotesList report={report} names={names} />
        </Section>
      </div>

      <RunTimeline id={run.id} />
    </div>
  )
}

/** The full event timeline (the run store's own read, shared with the Runs tab cache). */
function RunTimeline({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: chaosKeys.run(id), queryFn: () => fetchRun(id) })
  if (!data) return <Skeleton className='h-32 w-full' />
  return <Timeline events={data.events} />
}

function VerdictHeader({ data }: { data: FullReport }) {
  const { run, report } = data
  const b = report.broke_by
  const tone =
    run.verdict === 'held'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100'
      : run.verdict === 'broke'
        ? 'border-red-200 bg-red-50 text-red-950 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-100'
        : run.verdict === 'aborted'
          ? 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100'
          : 'border-slate-200 bg-white text-slate-800 dark:border-border dark:bg-card dark:text-foreground'
  const title =
    run.status === 'refused'
      ? 'Refused before anything was armed'
      : run.verdict === 'held'
        ? 'Held'
        : run.verdict === 'broke'
          ? 'Broke'
          : run.verdict === 'aborted'
            ? 'Aborted'
            : 'No verdict'
  const sentence =
    run.status === 'refused'
      ? 'Pre-flight said no, so nothing ran.'
      : run.verdict === 'held'
        ? 'Every limit stayed true for the whole window.'
        : run.verdict === 'broke'
          ? 'A limit was crossed while the fault ran.'
          : run.verdict === 'aborted'
            ? 'A limit was crossed past its tolerance and the fault stopped itself.'
            : 'The run ended without a verdict.'
  return (
    <div className={cn('rounded-lg border px-4 py-3', tone)}>
      <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
        <span className='text-[18px] font-semibold tracking-[-0.01em]'>{title}</span>
        <span className='text-[13px]'>{sentence}</span>
      </div>
      {b && (
        <p className='mt-1 text-[12.5px]'>
          Broken by <span className='font-mono text-[12px]'>{b.sampler}</span>
          {b.value != null && (
            <>
              {' '}
              at <span className='font-mono tabular-nums'>{b.value}</span>
            </>
          )}
          {b.op && b.limit != null && (
            <>
              {' '}
              (limit{' '}
              <span className='font-mono tabular-nums'>
                {b.op} {b.limit}
              </span>
              )
            </>
          )}
          .
        </p>
      )}
      <p className='mt-1 text-[12px] opacity-80'>
        <span className='font-mono'>{run.fault_key ?? run.kind}</span> on{' '}
        {describeTarget(run.target)}
        {report.armed_at ? ` · armed ${formatDateTime(report.armed_at)}` : ''}
        {report.disarmed_at ? ` · ended ${formatDateTime(report.disarmed_at)}` : ''}
      </p>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone
}: {
  label: string
  value: string
  hint?: string
  tone?: 'warn'
}) {
  return (
    <div className='min-w-0 bg-white px-3 py-2.5 dark:bg-card'>
      <div className='text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
        {label}
      </div>
      <div
        className={cn(
          'mt-0.5 text-[17px] font-semibold tabular-nums',
          tone === 'warn'
            ? 'text-amber-800 dark:text-amber-300'
            : 'text-slate-900 dark:text-foreground'
        )}
      >
        {value}
      </div>
      {hint && (
        <div className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {hint}
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  aside,
  children
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className='min-w-0'>
      <div className='mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5'>
        <h2 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

const listCls =
  'divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'
const emptyCls =
  'rounded-lg border border-slate-200 bg-white px-3 py-4 text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })

function After({ s }: { s: number | null }) {
  return (
    <span className='w-14 shrink-0 font-mono text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'>
      {s == null ? '' : `+${fmtSeconds(s)}`}
    </span>
  )
}

function AlertsList({ report }: { report: RunReport }) {
  if (!report.alerts.length)
    return (
      <p className={emptyCls}>
        No alert fired while the fault was armed. If something should have noticed, that is the
        finding.
      </p>
    )
  return (
    <ul className={listCls}>
      {report.alerts.map((a, i) => (
        <li key={`${a.at}-${i}`} className='flex items-start gap-3 px-3 py-2 text-[12.5px]'>
          <After s={a.after_s} />
          <div className='min-w-0 flex-1'>
            <div className='truncate text-slate-900 dark:text-foreground'>{a.label}</div>
            <div className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {clock(a.at)}
              {a.source ? ` · ${a.source}` : ''}
              {a.severity ? ` · ${a.severity}` : ''}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

function ReadinessList({ report }: { report: RunReport }) {
  if (!report.readiness.length)
    return <p className={emptyCls}>No readiness verdicts were recorded during this run.</p>
  return (
    <ul className={listCls}>
      {report.readiness.map((r, i) => (
        <li key={`${r.at}-${i}`} className='px-3 py-2 text-[12.5px]'>
          <div className='flex items-center gap-2'>
            <span className='font-mono text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'>
              {clock(r.at)}
            </span>
            <span className='font-medium capitalize text-slate-900 dark:text-foreground'>
              {r.status}
            </span>
            {r.score != null && (
              <span className='text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                score {r.score}
              </span>
            )}
          </div>
          {r.failing.length > 0 && (
            <p className='mt-0.5 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
              Failing: {r.failing.join(', ')}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

function ErrorsPanel({ data }: { data: FullReport }) {
  const e = data.errors
  if (!e?.available)
    return (
      <p className={emptyCls}>
        The request log could not be read for this window, so the errors people saw are unknown.
      </p>
    )
  const extras = [
    `${e.client_errors} client error report${e.client_errors === 1 ? '' : 's'}`,
    `${e.rage_clicks} rage click${e.rage_clicks === 1 ? '' : 's'}`,
    `${e.dead_clicks} dead click${e.dead_clicks === 1 ? '' : 's'}`
  ].join(' · ')
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <p className='border-b border-slate-100 px-3 py-2 text-[12.5px] text-slate-700 dark:border-border/60 dark:text-foreground'>
        {e.server_total === 0
          ? 'Nobody got a server error during the drill or the two minutes after.'
          : `${e.server_total} server error${e.server_total === 1 ? '' : 's'} reached ${e.people} ${e.people === 1 ? 'person' : 'people'}.`}{' '}
        <span className='text-slate-500 dark:text-muted-foreground'>{extras}</span>
      </p>
      {e.server.length > 0 && (
        <table className='w-full text-[12px]'>
          <thead>
            <tr className='text-left text-[11px] text-slate-500 dark:text-muted-foreground'>
              <th className='px-3 py-1.5 font-medium'>Route</th>
              <th className='w-20 px-3 py-1.5 text-right font-medium'>Errors</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
            {e.server.map((r) => (
              <tr key={r.route}>
                <td className='max-w-0 truncate px-3 py-1.5 font-mono text-[11.5px] text-slate-800 dark:text-foreground'>
                  {r.route}
                </td>
                <td className='px-3 py-1.5 text-right tabular-nums text-slate-800 dark:text-foreground'>
                  {r.count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

const MARK_TONE: Record<string, string> = {
  noticed: 'bg-sky-50 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300',
  declared: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  found_cause: 'bg-slate-100 text-slate-700 dark:bg-muted dark:text-foreground',
  fixed: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
}
const MARK_WORD: Record<string, string> = {
  noticed: 'Noticed',
  declared: 'Declared',
  found_cause: 'Found cause',
  fixed: 'Fixed'
}

function NotesList({ report, names }: { report: RunReport; names: Record<string, string> }) {
  if (!report.notes.length)
    return (
      <p className={emptyCls}>
        Nobody left a note. During a run, the scribe button stamps "noticed", "found cause" and
        "fixed" onto the timeline — they become the detect and fix times above.
      </p>
    )
  return (
    <ul className={listCls}>
      {report.notes.map((n, i) => (
        <li key={`${n.at}-${i}`} className='flex items-start gap-3 px-3 py-2 text-[12.5px]'>
          <After s={n.after_s} />
          <div className='min-w-0 flex-1'>
            <div className='flex flex-wrap items-center gap-1.5'>
              <span className='font-medium text-slate-900 dark:text-foreground'>
                {n.actor ? (names[n.actor] ?? 'Someone') : 'System'}
              </span>
              {n.mark && (
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10.5px] font-medium',
                    MARK_TONE[n.mark] ??
                      'bg-slate-100 text-slate-700 dark:bg-muted dark:text-foreground'
                  )}
                >
                  {MARK_WORD[n.mark] ?? n.mark.replace(/_/g, ' ')}
                </span>
              )}
            </div>
            <p className='mt-0.5 whitespace-pre-wrap break-words text-slate-700 dark:text-foreground'>
              {n.text}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}
