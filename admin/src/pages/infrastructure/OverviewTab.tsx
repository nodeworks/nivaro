import { Server } from 'lucide-react'
import { formatFileSize } from '@/lib/utils'
import {
  Chip,
  Code,
  Dash,
  DockerNotConfigured,
  LoadError,
  Note,
  StatStrip,
  TabSkeleton,
  useInfraStatus
} from './ui'

type StatusHost = NonNullable<ReturnType<typeof useInfraStatus>['data']>['docker']['hosts'][number]

const role = (d: NonNullable<StatusHost['data']>) =>
  d.swarm === 'active' ? (d.manager ? 'Swarm manager' : 'Swarm worker') : 'Not in a swarm'

/** Which infrastructure sources are connected, and each Docker host's engine. */
export function OverviewTab() {
  const { data, isLoading, error, refetch } = useInfraStatus()
  if (isLoading) return <TabSkeleton />
  if (error || !data) return <LoadError what='the infrastructure status' onRetry={refetch} />
  if (data.cloud)
    return (
      <Note>
        Infrastructure is managed by the platform in cloud mode, so this page has nothing to show.
      </Note>
    )
  const hosts = data.docker.hosts
  const up = hosts.filter((h) => !h.error && h.data)
  const down = hosts.length - up.length
  return (
    <div className='space-y-5'>
      {!data.docker.configured && <DockerNotConfigured />}
      {hosts.length > 0 && (
        <StatStrip
          items={[
            {
              label: 'Docker hosts answering',
              value: `${up.length} of ${hosts.length}`,
              tone: down ? 'bad' : undefined
            },
            {
              label: 'Swarm managers',
              value: up.filter((h) => h.data?.swarm === 'active' && h.data.manager).length
            },
            { label: 'CPUs', value: up.reduce((n, h) => n + (h.data?.cpus ?? 0), 0) },
            {
              label: 'Memory',
              value: formatFileSize(up.reduce((n, h) => n + (h.data?.memory_bytes ?? 0), 0))
            },
            {
              label: 'Telemetry store',
              value: data.metrics_store ? 'Connected' : 'Not set',
              tone: data.metrics_store ? undefined : 'warn'
            }
          ]}
        />
      )}
      {hosts.length > 0 && (
        <ul className='grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))]'>
          {hosts.map((h) => (
            <HostCard key={h.host} h={h} />
          ))}
        </ul>
      )}
      {!data.metrics_store && (
        <Note>
          Host health, resources, log growth and the reboot check's mount facts read the telemetry
          store. Set <Code>TELEMETRY_STORE_URL</Code> to see them.
        </Note>
      )}
    </div>
  )
}

function HostCard({ h }: { h: StatusHost }) {
  const d = h.data
  return (
    <li
      aria-label={`Host ${h.host}`}
      className='min-w-0 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
    >
      <div className='flex items-center gap-2'>
        <Server className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
        <span className='min-w-0 truncate font-mono text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          {h.host}
        </span>
        <span className='ml-auto'>
          {h.error || !d ? (
            <Chip tone='bad' icon>
              Not answering
            </Chip>
          ) : (
            <Chip tone='ok' icon>
              {role(d)}
            </Chip>
          )}
        </span>
      </div>
      {h.error || !d ? (
        <p className='mt-3 break-words text-[12px] leading-5 text-slate-600 dark:text-muted-foreground'>
          {h.error ?? 'The host sent no data.'}
        </p>
      ) : (
        <dl className='mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px]'>
          <Row label='Hostname' value={d.hostname} mono />
          <Row
            label='Engine'
            value={d.engine ? `${d.engine}${d.api ? ` · API ${d.api}` : ''}` : null}
            mono
          />
          <Row label='OS' value={d.os} />
          <Row label='Kernel' value={d.kernel} mono />
          <Row
            label='Size'
            value={`${d.cpus ?? '?'} CPUs · ${d.memory_bytes ? formatFileSize(d.memory_bytes) : '?'}`}
          />
        </dl>
      )}
    </li>
  )
}

function Row({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <>
      <dt className='text-slate-500 dark:text-muted-foreground'>{label}</dt>
      <dd
        className={
          mono
            ? 'truncate font-mono text-slate-800 dark:text-foreground'
            : 'truncate text-slate-800 dark:text-foreground'
        }
        data-tip={value && value.length > 28 ? value : undefined}
      >
        {value ?? <Dash />}
      </dd>
    </>
  )
}
