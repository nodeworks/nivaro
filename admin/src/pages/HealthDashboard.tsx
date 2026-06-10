import { useQuery } from '@tanstack/react-query'
import { Activity, Cpu, Database, GitBranch, HeartPulse, Wifi, Zap } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface DetailedHealth {
  db: { ok: boolean; latency_ms: number }
  redis: { ok: boolean; latency_ms: number }
  inngest: { ok: boolean | 'unknown' }
  migrations: { latest: string | null; count: number }
  sockets: { connections: number | null }
  uptime_s: number
  node_version: string
  memory_mb: number
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
          </div>
        )}
      </div>
    </div>
  )
}
