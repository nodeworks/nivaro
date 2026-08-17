import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  GitBranch,
  HeartPulse,
  ShieldAlert,
  Wifi,
  Zap
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface DetailedHealth {
  db: { ok: boolean; latency_ms: number }
  redis: { ok: boolean; latency_ms: number }
  inngest: { ok: boolean | 'unknown' }
  migrations: { latest: string | null; count: number }
  sockets: { connections: number | null }
  uptime_s: number
  version?: string
  node_version: string
  memory_mb: number
}

type Severity = 'ok' | 'warn' | 'fail'

interface PreflightCheck {
  id: string
  status: Severity
  summary: string
  detail?: Record<string, unknown>
}

interface Preflight {
  status: Severity
  version: string
  environment: string
  checks: PreflightCheck[]
}

const SEVERITY_STYLE: Record<Severity, { dot: string; text: string; card: string; label: string }> =
  {
    ok: {
      dot: 'bg-green-500',
      text: 'text-green-600 dark:text-green-400',
      card: 'border-slate-200 dark:border-border',
      label: 'Deploy consistent'
    },
    warn: {
      dot: 'bg-amber-400',
      text: 'text-amber-600 dark:text-amber-400',
      card: 'border-amber-300 dark:border-amber-500/40',
      label: 'Deploy needs attention'
    },
    fail: {
      dot: 'bg-red-500',
      text: 'text-red-600 dark:text-red-400',
      card: 'border-red-300 dark:border-red-500/40',
      label: 'Deploy is inconsistent'
    }
  }

/**
 * Render the lists a failing check carries (missing migration files, pending
 * ones, absent extensions). These are the actual names an operator needs to
 * act on, so they are shown rather than hidden behind a toggle — a failing
 * preflight is rare and always worth reading in full.
 */
function CheckDetail({ detail }: { detail?: Record<string, unknown> }) {
  if (!detail) return null
  const lists: Array<{ key: string; values: string[] }> = []
  for (const key of ['missing_files', 'pending', 'absent']) {
    const values = detail[key]
    if (Array.isArray(values) && values.length > 0) {
      lists.push({ key, values: values.map(String) })
    }
  }
  if (lists.length === 0) return null

  return (
    <div className='mt-1.5 space-y-1'>
      {lists.map(({ key, values }) => (
        <div key={key} className='text-[11px]'>
          <span className='text-muted-foreground'>{key.replace(/_/g, ' ')}:</span>{' '}
          <span className='font-mono text-[10.5px]'>{values.join(', ')}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Deploy preflight. Distinct from the subsystem cards below: those answer "is
 * this instance up", this answers "did the deploy land coherently" — a
 * container can be perfectly healthy right up until the restart that kills it
 * because the database is ahead of the image.
 */
function PreflightPanel({ data }: { data: Preflight }) {
  const style = SEVERITY_STYLE[data.status]
  const Icon =
    data.status === 'ok' ? CheckCircle2 : data.status === 'warn' ? AlertTriangle : ShieldAlert

  return (
    <div className={cn('mb-4 rounded-lg border bg-white p-4 dark:bg-card', style.card)}>
      <div className='mb-3 flex items-center gap-2'>
        <Icon className={cn('h-4 w-4', style.text)} />
        <span className='text-[13px] font-medium'>Deploy preflight</span>
        <span className={cn('text-[13px] font-semibold', style.text)}>{style.label}</span>
      </div>

      <div className='grid gap-2 sm:grid-cols-2'>
        {data.checks.map((check) => (
          <div key={check.id} className='flex gap-2'>
            <span
              className={cn(
                'mt-[5px] inline-block h-2 w-2 shrink-0 rounded-full',
                SEVERITY_STYLE[check.status].dot
              )}
            />
            <div className='min-w-0'>
              <p className='text-[12px] font-medium capitalize'>{check.id}</p>
              <p className='text-[11px] leading-snug text-muted-foreground'>{check.summary}</p>
              {check.status !== 'ok' && <CheckDetail detail={check.detail} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${Math.floor(seconds % 60)}s`
}

function StatusDot({ ok }: { ok: boolean | 'unknown' }) {
  return (
    <span
      className={cn(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        ok === 'unknown' ? 'bg-amber-400' : ok ? 'bg-green-500' : 'bg-red-500'
      )}
    />
  )
}

function statusLabel(ok: boolean | 'unknown'): string {
  if (ok === 'unknown') return 'Unknown'
  return ok ? 'Healthy' : 'Down'
}

function SubsystemCard({
  icon: Icon,
  title,
  ok,
  detail
}: {
  icon: typeof Database
  title: string
  ok: boolean | 'unknown'
  detail?: string
}) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='mb-2 flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <Icon className='h-4 w-4 text-muted-foreground' />
          <span className='text-[13px] font-medium'>{title}</span>
        </div>
        <StatusDot ok={ok} />
      </div>
      <p
        className={cn(
          'text-[18px] font-semibold',
          ok === 'unknown'
            ? 'text-amber-600 dark:text-amber-400'
            : ok
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400'
        )}
      >
        {statusLabel(ok)}
      </p>
      {detail && <p className='mt-0.5 text-[11px] text-muted-foreground'>{detail}</p>}
    </div>
  )
}

function InfoCard({
  icon: Icon,
  title,
  value,
  detail
}: {
  icon: typeof Database
  title: string
  value: string
  detail?: string
}) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='mb-2 flex items-center gap-2'>
        <Icon className='h-4 w-4 text-muted-foreground' />
        <span className='text-[13px] font-medium'>{title}</span>
      </div>
      <p className='truncate text-[18px] font-semibold'>{value}</p>
      {detail && <p className='mt-0.5 truncate text-[11px] text-muted-foreground'>{detail}</p>}
    </div>
  )
}

export function HealthDashboardPage() {
  const { data, isLoading, dataUpdatedAt } = useQuery<DetailedHealth>({
    queryKey: ['health-detailed'],
    queryFn: () => api.get<{ data: DetailedHealth }>('/health/detailed').then((r) => r.data.data),
    refetchInterval: 15_000
  })

  // A failing preflight answers with 503 and a body — axios rejects on the
  // status, so read the payload back off the error rather than losing exactly
  // the response that matters most.
  const { data: preflight } = useQuery<Preflight | null>({
    queryKey: ['preflight'],
    queryFn: () =>
      api
        .get<{ data: Preflight }>('/preflight')
        .then((r) => r.data.data)
        .catch((err: { response?: { data?: { data?: Preflight } } }) => {
          return err.response?.data?.data ?? null
        }),
    refetchInterval: 60_000
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-border'>
        <div className='flex items-center gap-2.5'>
          <HeartPulse className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Health Dashboard</h1>
        </div>
        {dataUpdatedAt > 0 && (
          <span className='text-[11px] text-muted-foreground'>
            Updated {new Date(dataUpdatedAt).toLocaleTimeString()} · refreshes every 15s
          </span>
        )}
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {preflight && <PreflightPanel data={preflight} />}
        {isLoading || !data ? (
          <div className='grid grid-cols-2 gap-4 lg:grid-cols-4'>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <div key={i} className='h-24 animate-pulse rounded-lg bg-muted' />
            ))}
          </div>
        ) : (
          <div className='grid grid-cols-2 gap-4 lg:grid-cols-4'>
            <SubsystemCard
              icon={Database}
              title='Database'
              ok={data.db.ok}
              detail={`${data.db.latency_ms} ms`}
            />
            <SubsystemCard
              icon={Zap}
              title='Redis'
              ok={data.redis.ok}
              detail={`${data.redis.latency_ms} ms`}
            />
            <SubsystemCard
              icon={Activity}
              title='Inngest'
              ok={data.inngest.ok}
              detail={data.inngest.ok === 'unknown' ? 'No health URL configured' : undefined}
            />
            <InfoCard
              icon={Wifi}
              title='Socket connections'
              value={data.sockets.connections != null ? String(data.sockets.connections) : '—'}
              detail='Active websocket clients'
            />
            <InfoCard
              icon={GitBranch}
              title='Migrations'
              value={String(data.migrations.count)}
              detail={data.migrations.latest ?? 'none'}
            />
            <InfoCard icon={Activity} title='Uptime' value={formatUptime(data.uptime_s)} />
            <InfoCard icon={Cpu} title='Memory (RSS)' value={`${data.memory_mb} MB`} />
            <InfoCard icon={Cpu} title='Node.js' value={data.node_version} />
            <InfoCard icon={Activity} title='Nivaro version' value={data.version ?? '—'} />
          </div>
        )}
      </div>
    </div>
  )
}
