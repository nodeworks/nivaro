import { useOverflowTip } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  Database,
  HardDrive,
  Network,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Telescope,
  Timer,
  XCircle
} from 'lucide-react'
import type { ReactNode } from 'react'
import { DrillTag, useAdminDrillWindows } from '@/components/chaos-drill-tag'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatDate, formatNumber, formatRelative } from '@/lib/utils'
import { AskTelemetry } from './telemetry/AskTelemetry'
import { RecoveryPanel } from './telemetry/Recovery'
import { SlowestRequests } from './telemetry/SlowestRequests'
import { Card, Dot, PartError, TONE, type Tone } from './telemetry/ui'

/**
 * Telemetry (#2544) — the monitoring stack that runs beside this instance, seen from Nivaro:
 * what this process sends (request log lines, traces), what actually arrived in the stores, the
 * stack's own health (alerts, uptime checks, collected sources, backups, disk and share space)
 * and how this instance is configured. GET /api/telemetry/status, administrators only. The
 * Disaster recovery panel (#2801 / #2802, ./telemetry/Recovery) reads GET /api/telemetry/recovery.
 */

interface StackPart<T> {
  items: T[]
  error: string | null
}
type ExportReason = 'slow' | 'error' | 'kept' | 'sampled'
interface TelemetryStatus {
  settings: {
    access_log: boolean
    store: { configured: boolean; host: string | null; env: string | null; token_set: boolean }
    traces: {
      configured: boolean
      host: string | null
      token_set: boolean
      sample: number | null
      env: string | null
      service: string | null
    }
    grafana_url: string | null
    cloud: boolean
  }
  egress: {
    instance: string
    access_lines: { written: number; since: string }
    traces: {
      enabled: boolean
      queued: number
      traces_sent: number
      spans_sent: number
      dropped: number
      failed_batches: number
      by_reason: Record<ExportReason, number>
      last_ok_at: string | null
      last_error: string | null
      last_error_at: string | null
    }
  }
  arrival: {
    store: {
      configured: boolean
      reachable: boolean | null
      latency_ms: number | null
      oldest: string | null
      error: string | null
    }
    access_lines_1h: number | null
    traces_1h: number | null
    error: string | null
  }
  stack: {
    targets: StackPart<{ job: string; instance: string; host: string | null; up: boolean }>
    alerts: StackPart<{
      name: string
      severity: string
      host: string | null
      subject: string | null
    }>
    uptime: StackPart<{ group: string; name: string; ok: boolean }>
    backups: StackPart<{ part: string; age_s: number }>
    space: StackPart<{ host: string | null; mountpoint: string; fstype: string; free_pct: number }>
  }
  computed_at: string
}

const REASONS: Array<{ key: ExportReason; label: string; color: string }> = [
  { key: 'error', label: 'Server error', color: 'bg-red-500' },
  { key: 'slow', label: 'Slow', color: 'bg-amber-500' },
  { key: 'kept', label: 'Marked to keep', color: 'bg-violet-500' },
  { key: 'sampled', label: 'Sampled', color: 'bg-slate-400 dark:bg-slate-500' }
]

const CHIP_OK = 'border-slate-200 dark:border-border'
const CHIP_BAD =
  'border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-400'

function fmtAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86_400)} d`
}

/** Truncated text that shows its full value on hover when it is cut off. */
function Clip({ text, className }: { text: string; className?: string }) {
  const ref = useOverflowTip<HTMLSpanElement>(text)
  return (
    <span ref={ref} className={cn('block min-w-0 truncate', className)}>
      {text}
    </span>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className='m-0 text-[12.5px] text-muted-foreground'>{children}</p>
}

/** One headline figure in the strip at the top. */
function Tile({
  label,
  tone,
  value,
  note
}: {
  label: string
  tone: Tone
  value: string
  note?: string
}) {
  return (
    <div
      className={cn('min-w-0 rounded-lg border bg-white px-4 py-3 dark:bg-card', TONE[tone].ring)}
    >
      <div className='flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground'>
        <Dot tone={tone} />
        {label}
      </div>
      <div className={cn('mt-1 text-[18px] font-semibold tabular-nums', TONE[tone].text)}>
        {value}
      </div>
      {note && <Clip text={note} className='mt-0.5 text-[11.5px] text-muted-foreground' />}
    </div>
  )
}

function Row({
  label,
  hint,
  children,
  valueClass
}: {
  label: string
  hint?: string
  children: ReactNode
  valueClass?: string
}) {
  return (
    <div className='flex items-baseline justify-between gap-3 py-1.5 text-[12.5px]'>
      <span className='min-w-0 text-muted-foreground'>
        {label}
        {hint && (
          <span className='block break-all font-mono text-[10.5px] text-muted-foreground/80'>
            {hint}
          </span>
        )}
      </span>
      <span className={cn('min-w-0 text-right font-medium tabular-nums', valueClass)}>
        {typeof children === 'string' ? <Clip text={children} /> : children}
      </span>
    </div>
  )
}

const OnOff = ({
  on,
  onText = 'On',
  offText = 'Off'
}: {
  on: boolean
  onText?: string
  offText?: string
}) => (
  <span
    className={cn('inline-flex items-center gap-1.5', on ? TONE.ok.text : 'text-muted-foreground')}
  >
    <Dot tone={on ? 'ok' : 'off'} />
    {on ? onText : offText}
  </span>
)

function Egress({ s }: { s: TelemetryStatus }) {
  const t = s.egress.traces
  const total = Object.values(t.by_reason).reduce((a, b) => a + b, 0)
  return (
    <Card
      title='Sent and arrived'
      icon={Send}
      aside={
        <>
          This process · <span className='font-mono'>{s.egress.instance}</span>
        </>
      }
    >
      <div className='grid gap-x-6 gap-y-3 sm:grid-cols-2'>
        <div className='min-w-0'>
          <h3 className='m-0 mb-1 text-[12px] font-semibold'>Request log lines</h3>
          <Row label='Written by this process'>
            {s.settings.access_log ? formatNumber(s.egress.access_lines.written) : 'Off'}
          </Row>
          <Row label='Counting since'>{formatRelative(s.egress.access_lines.since)}</Row>
          <Row label='Arrived in the store, last hour'>
            {s.arrival.access_lines_1h == null ? '—' : formatNumber(s.arrival.access_lines_1h)}
          </Row>
          <Row label='Store reaches back to'>
            {s.arrival.store.oldest ? formatDate(s.arrival.store.oldest) : '—'}
          </Row>
        </div>
        <div className='min-w-0'>
          <h3 className='m-0 mb-1 text-[12px] font-semibold'>Request traces</h3>
          <Row label='Sent'>
            {`${formatNumber(t.traces_sent)} traces · ${formatNumber(t.spans_sent)} spans`}
          </Row>
          <Row label='Waiting to send'>{formatNumber(t.queued)}</Row>
          <Row label='Dropped' valueClass={t.dropped > 0 ? TONE.warn.text : undefined}>
            {formatNumber(t.dropped)}
          </Row>
          <Row label='Arrived in the store, last hour'>
            {s.arrival.traces_1h == null ? '—' : formatNumber(s.arrival.traces_1h)}
          </Row>
          <Row label='Last sent'>{t.last_ok_at ? formatRelative(t.last_ok_at) : 'Not yet'}</Row>
        </div>
      </div>
      {total > 0 && (
        <div className='mt-3'>
          <div className='mb-1 text-[11.5px] text-muted-foreground'>Why traces were sent</div>
          <div className='flex h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
            {REASONS.map((r) =>
              t.by_reason[r.key] ? (
                <span
                  key={r.key}
                  className={cn('h-full', r.color)}
                  style={{ width: `${(t.by_reason[r.key] / total) * 100}%` }}
                />
              ) : null
            )}
          </div>
          <div className='mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground'>
            {REASONS.map((r) => (
              <span key={r.key} className='inline-flex items-center gap-1.5 tabular-nums'>
                <span
                  aria-hidden='true'
                  className={cn('inline-block h-2 w-2 rounded-sm', r.color)}
                />
                {r.label} {formatNumber(t.by_reason[r.key])}
              </span>
            ))}
          </div>
        </div>
      )}
      {(t.last_error || s.arrival.error) && (
        <div className='mt-3 space-y-1'>
          {t.last_error && (
            <PartError
              error={`Last send failed${t.last_error_at ? ` ${formatRelative(t.last_error_at)}` : ''}: ${t.last_error}`}
            />
          )}
          <PartError error={s.arrival.error} />
        </div>
      )}
    </Card>
  )
}

function Settings({ s }: { s: TelemetryStatus }) {
  const st = s.settings
  return (
    <Card title='Settings' icon={SlidersHorizontal} aside='From this server’s environment'>
      <div className='divide-y divide-slate-100 dark:divide-border'>
        <div className='pb-2'>
          <Row label='Request log lines' hint='TELEMETRY_ACCESS_LOG'>
            <OnOff on={st.access_log} />
          </Row>
        </div>
        <div className='py-2'>
          <Row label='History store' hint='TELEMETRY_STORE_URL'>
            {st.store.configured ? (st.store.host ?? '—') : 'Not set'}
          </Row>
          <Row label='Environment label' hint='TELEMETRY_STORE_ENV'>
            {st.store.env ?? '—'}
          </Row>
          <Row label='Read token' hint='TELEMETRY_STORE_TOKEN'>
            <OnOff on={st.store.token_set} onText='Set' offText='Not set' />
          </Row>
        </div>
        <div className='pt-2'>
          <Row label='Trace export' hint='TRACE_EXPORT_URL'>
            {st.traces.configured ? (st.traces.host ?? '—') : 'Not set'}
          </Row>
          <Row label='Share of other requests traced' hint='TRACE_EXPORT_SAMPLE'>
            {st.traces.sample == null ? '—' : `${Math.round(st.traces.sample * 1000) / 10}%`}
          </Row>
          <Row label='Service · environment' hint='TRACE_EXPORT_SERVICE · TRACE_EXPORT_ENV'>
            {`${st.traces.service ?? '—'} · ${st.traces.env ?? '—'}`}
          </Row>
          <Row label='Send token' hint='TRACE_EXPORT_TOKEN'>
            <OnOff on={st.traces.token_set} onText='Set' offText='Not set' />
          </Row>
        </div>
      </div>
      {st.cloud && (
        <p className='m-0 mt-3 text-[12px] text-muted-foreground'>
          Not available on cloud instances. The monitoring stack can’t tell tenants apart.
        </p>
      )}
    </Card>
  )
}

function Alerts({
  part,
  grafanaUrl
}: {
  part: TelemetryStatus['stack']['alerts']
  grafanaUrl: string | null
}) {
  const critical = part.items.filter((a) => a.severity === 'critical').length
  // #2847 — firing while a chaos drill runs reads "Drill".
  const drills = useAdminDrillWindows()
  return (
    <Card
      title='Firing alerts'
      icon={BellRing}
      aside={part.error ? undefined : `${part.items.length} firing`}
      asideTone={critical ? 'bad' : part.items.length ? 'warn' : 'off'}
    >
      <PartError error={part.error} />
      {!part.error && part.items.length === 0 && (
        <p className='m-0 flex items-center gap-1.5 text-[12.5px] text-muted-foreground'>
          <CheckCircle2 className='h-4 w-4 text-emerald-500' aria-hidden='true' />
          Nothing firing.
        </p>
      )}
      <ul className='m-0 list-none space-y-1.5 p-0'>
        {part.items.map((a) => (
          <li
            key={`${a.name}|${a.subject}|${a.host}`}
            className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]'
          >
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide',
                a.severity === 'critical'
                  ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400'
                  : a.severity === 'warning'
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400'
                    : 'bg-slate-100 text-slate-700 dark:bg-muted dark:text-muted-foreground'
              )}
            >
              {a.severity}
            </span>
            <Clip text={a.name} className='font-medium' />
            <DrillTag windows={drills} />
            {a.subject && (
              <Clip text={a.subject} className='font-mono text-[11.5px] text-muted-foreground' />
            )}
            {a.host && (
              <span className='ml-auto shrink-0 text-[11.5px] text-muted-foreground'>{a.host}</span>
            )}
          </li>
        ))}
      </ul>
      {part.items.length > 0 && (
        <p className='m-0 mt-3 text-[11.5px] text-muted-foreground'>
          Silenced alerts still appear here; they just stop sending email.{' '}
          {grafanaUrl ? (
            <a
              href={`${grafanaUrl.replace(/\/$/, '')}/alerting/silences?alertmanager=am`}
              target='_blank'
              rel='noopener noreferrer'
              className='font-medium text-nvr-navy underline underline-offset-2 dark:text-nvr-cyan'
            >
              Manage silences in Grafana
            </a>
          ) : (
            'Manage silences in Grafana → Alerting.'
          )}
        </p>
      )}
    </Card>
  )
}

function Uptime({ part }: { part: TelemetryStatus['stack']['uptime'] }) {
  const groups = new Map<string, Array<{ name: string; ok: boolean }>>()
  for (const u of part.items) groups.set(u.group, [...(groups.get(u.group) ?? []), u])
  const failing = part.items.filter((u) => !u.ok).length
  return (
    <Card
      title='Uptime checks'
      icon={Timer}
      aside={
        part.error || !part.items.length
          ? undefined
          : failing
            ? `${failing} failing`
            : `${part.items.length} passing`
      }
      asideTone={failing ? 'bad' : 'off'}
    >
      <PartError error={part.error} />
      {!part.error && part.items.length === 0 && <Empty>No uptime checks reported.</Empty>}
      <div className='space-y-2.5'>
        {[...groups].map(([group, items]) => (
          <div key={group}>
            <div className='mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
              {group || 'Other'}
            </div>
            <div className='flex flex-wrap gap-1.5'>
              {items.map((u) => (
                <span
                  key={u.name}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[12px]',
                    u.ok ? CHIP_OK : CHIP_BAD
                  )}
                >
                  {u.ok ? <Dot tone='ok' /> : <XCircle className='h-3 w-3' aria-hidden='true' />}
                  {u.name}
                  {!u.ok && <span className='sr-only'>(failing)</span>}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function Targets({ part }: { part: TelemetryStatus['stack']['targets'] }) {
  const down = part.items.filter((t) => !t.up).length
  return (
    <Card
      title='Collected sources'
      icon={Network}
      aside={
        part.error || !part.items.length
          ? undefined
          : down
            ? `${down} not answering`
            : `${part.items.length} answering`
      }
      asideTone={down ? 'bad' : 'off'}
    >
      <PartError error={part.error} />
      {!part.error && part.items.length === 0 && <Empty>No sources reported.</Empty>}
      <div className='flex flex-wrap gap-1.5'>
        {part.items.map((t) => (
          <span
            key={`${t.job}-${t.instance}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[12px]',
              t.up ? CHIP_OK : CHIP_BAD
            )}
          >
            {t.up ? <Dot tone='ok' /> : <XCircle className='h-3 w-3' aria-hidden='true' />}
            {t.job}
            <span className='text-muted-foreground'>· {t.instance}</span>
            {!t.up && <span className='sr-only'>(not answering)</span>}
          </span>
        ))}
      </div>
    </Card>
  )
}

function Backups({ part }: { part: TelemetryStatus['stack']['backups'] }) {
  return (
    <Card
      title='Monitoring-stack backups'
      icon={Database}
      aside='Metrics and logs stores · expected daily'
    >
      <PartError error={part.error} />
      {!part.error && part.items.length === 0 && <Empty>No backup has reported yet.</Empty>}
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
        {part.items.map((b) => {
          const tone: Tone = b.age_s > 36 * 3600 ? 'bad' : b.age_s > 30 * 3600 ? 'warn' : 'ok'
          return (
            <div
              key={b.part}
              className='min-w-0 rounded-md border border-slate-200 px-3 py-2 dark:border-border'
            >
              <div className='flex items-center gap-1.5 text-[11.5px] capitalize text-muted-foreground'>
                <Dot tone={tone} />
                {b.part}
              </div>
              <div className={cn('mt-0.5 text-[13px] font-semibold tabular-nums', TONE[tone].text)}>
                {fmtAge(b.age_s)} ago
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function Space({ part }: { part: TelemetryStatus['stack']['space'] }) {
  return (
    <Card title='Disk and file share space' icon={HardDrive}>
      <PartError error={part.error} />
      {!part.error && part.items.length === 0 && <Empty>No disks reported.</Empty>}
      <ul className='m-0 list-none space-y-2.5 p-0'>
        {part.items.map((d) => {
          const used = Math.round(Math.max(0, Math.min(100, 100 - d.free_pct)))
          const tone: Tone = d.free_pct < 10 ? 'bad' : d.free_pct < 20 ? 'warn' : 'ok'
          return (
            <li key={`${d.host}-${d.mountpoint}`} className='min-w-0 text-[12.5px]'>
              <div className='mb-1 flex min-w-0 items-baseline gap-2'>
                <Clip text={d.mountpoint} className='font-mono' />
                <span className='shrink-0 text-[11px] text-muted-foreground'>
                  {d.fstype}
                  {d.host ? ` · ${d.host}` : ''}
                </span>
                <span className={cn('ml-auto shrink-0 tabular-nums', TONE[tone].text)}>
                  {d.free_pct}% free
                </span>
              </div>
              <div
                aria-hidden='true'
                className='h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
              >
                <span
                  className={cn(
                    'block h-full rounded-full',
                    tone === 'bad'
                      ? 'bg-red-500'
                      : tone === 'warn'
                        ? 'bg-amber-500'
                        : 'bg-emerald-500'
                  )}
                  style={{ width: `${used}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

export function TelemetryPage() {
  const q = useQuery({
    queryKey: ['telemetry', 'status'],
    queryFn: () => api.get<{ data: TelemetryStatus }>('/telemetry/status').then((r) => r.data.data),
    refetchInterval: 30_000
  })
  const s = q.data

  const store = s?.arrival.store
  const storeTone: Tone = !s?.settings.store.configured
    ? 'off'
    : store?.reachable == null
      ? 'off'
      : store.reachable
        ? 'ok'
        : 'bad'
  const storeValue = !s?.settings.store.configured
    ? 'Not set up'
    : store?.reachable == null
      ? 'Not checked'
      : store.reachable
        ? 'Answering'
        : 'Not answering'

  const tr = s?.egress.traces
  const failingNow = !!tr?.last_error_at && (!tr.last_ok_at || tr.last_error_at > tr.last_ok_at)
  const traceTone: Tone = !s?.settings.traces.configured
    ? 'off'
    : failingNow
      ? 'bad'
      : tr?.last_ok_at
        ? 'ok'
        : 'off'
  const traceValue = !s?.settings.traces.configured
    ? 'Off'
    : failingNow
      ? 'Failing'
      : tr?.last_ok_at
        ? 'Sending'
        : 'Waiting'
  const traceNote = failingNow
    ? (tr?.last_error ?? undefined)
    : tr?.last_ok_at
      ? `Last sent ${formatRelative(tr.last_ok_at)}`
      : s?.settings.traces.configured
        ? 'Nothing sent yet'
        : undefined

  const alerts = s?.stack.alerts
  const firing = alerts?.items ?? []
  const critical = firing.filter((a) => a.severity === 'critical').length
  const checks = s?.stack.uptime.items ?? []
  const failingChecks = checks.filter((u) => !u.ok).length

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-4 sm:px-6 dark:border-border'>
        <div className='flex min-w-0 items-center gap-2.5'>
          <Telescope className='h-5 w-5 shrink-0 text-muted-foreground' aria-hidden='true' />
          <div className='min-w-0'>
            <h1 className='m-0 text-lg font-semibold'>Telemetry</h1>
            <p className='m-0 text-[12px] text-muted-foreground'>
              The monitoring stack beside this instance: what Nivaro sends, what arrived, and how
              the stack is doing.
            </p>
          </div>
        </div>
        <div className='ml-auto flex flex-wrap items-center gap-2'>
          {q.dataUpdatedAt > 0 && (
            <span className='text-[11px] text-muted-foreground'>
              Updated {new Date(q.dataUpdatedAt).toLocaleTimeString()} · refreshes every 30s
            </span>
          )}
          <Button
            size='sm'
            variant='outline'
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
            className='h-8 text-[12.5px] [&_svg]:size-3.5'
          >
            <RefreshCw className={cn(q.isFetching && 'animate-spin')} aria-hidden='true' />
            Refresh
          </Button>
          {s?.settings.grafana_url && (
            <Button
              asChild
              size='sm'
              className='h-8 bg-nvr-cyan text-[12.5px] text-white hover:bg-nvr-cyan/90 [&_svg]:size-3.5'
            >
              <a href={s.settings.grafana_url} target='_blank' rel='noopener noreferrer'>
                Open Grafana
                <ArrowUpRight aria-hidden='true' />
              </a>
            </Button>
          )}
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        {q.isLoading ? (
          <div className='grid gap-4' role='status' aria-label='Loading'>
            <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className='h-[84px] rounded-lg' />
              ))}
            </div>
            <Skeleton className='h-[220px] rounded-lg' />
          </div>
        ) : !s ? (
          <div className='flex items-center gap-2 rounded-lg border border-red-300 bg-white p-4 text-[13px] text-red-700 dark:border-red-500/40 dark:bg-card dark:text-red-400'>
            <XCircle className='h-4 w-4 shrink-0' aria-hidden='true' />
            The telemetry status could not be read. Try Refresh in a moment.
          </div>
        ) : (
          <div className='grid gap-4'>
            {q.isError && (
              <div
                role='status'
                className='flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-4 py-2.5 text-[12.5px] text-amber-800 dark:border-amber-500/40 dark:bg-card dark:text-amber-400'
              >
                <AlertTriangle className='h-4 w-4 shrink-0' aria-hidden='true' />
                Couldn’t refresh. Showing data from {new Date(q.dataUpdatedAt).toLocaleTimeString()}
                .
              </div>
            )}
            <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
              <Tile
                label='History store'
                tone={storeTone}
                value={storeValue}
                note={
                  storeTone === 'ok' && store?.latency_ms != null
                    ? `${store.latency_ms} ms`
                    : (store?.error ?? undefined)
                }
              />
              <Tile label='Trace export' tone={traceTone} value={traceValue} note={traceNote} />
              <Tile
                label='Firing alerts'
                tone={alerts?.error ? 'off' : critical ? 'bad' : firing.length ? 'warn' : 'ok'}
                value={alerts?.error ? '—' : String(firing.length)}
                note={
                  alerts?.error
                    ? 'Couldn’t reach the alert service'
                    : critical
                      ? `${critical} critical`
                      : firing.length
                        ? 'Warnings only'
                        : 'All quiet'
                }
              />
              <Tile
                label='Uptime checks'
                tone={
                  s.stack.uptime.error || checks.length === 0 ? 'off' : failingChecks ? 'bad' : 'ok'
                }
                value={
                  s.stack.uptime.error
                    ? '—'
                    : checks.length === 0
                      ? 'None'
                      : `${checks.length - failingChecks} / ${checks.length}`
                }
                note={
                  s.stack.uptime.error
                    ? 'Couldn’t reach the uptime checker'
                    : checks.length === 0
                      ? 'No checks reported'
                      : failingChecks
                        ? `${failingChecks} failing`
                        : 'All passing'
                }
              />
            </div>

            {s.settings.store.configured && <AskTelemetry grafanaUrl={s.settings.grafana_url} />}

            <div className='grid gap-4 xl:grid-cols-2'>
              <Alerts part={s.stack.alerts} grafanaUrl={s.settings.grafana_url} />
              <Uptime part={s.stack.uptime} />
            </div>

            <RecoveryPanel />

            {s.settings.store.configured && <SlowestRequests grafanaUrl={s.settings.grafana_url} />}

            <div className='grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'>
              <Egress s={s} />
              <Settings s={s} />
            </div>

            <div className='grid gap-4 xl:grid-cols-2'>
              <Space part={s.stack.space} />
              <div className='grid content-start gap-4'>
                <Backups part={s.stack.backups} />
                <Targets part={s.stack.targets} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
