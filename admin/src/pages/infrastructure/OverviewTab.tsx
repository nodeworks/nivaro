import { CheckCircle2, Server, XCircle } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { formatFileSize } from '@/lib/utils'
import { DockerNotConfigured, useInfraStatus } from './ui'

/** Which infrastructure sources are connected, and each Docker host's engine. */
export function OverviewTab() {
  const { data, isLoading, error } = useInfraStatus()
  if (isLoading)
    return (
      <div className='grid gap-3 sm:grid-cols-2'>
        <Skeleton className='h-28' />
        <Skeleton className='h-28' />
      </div>
    )
  if (error || !data)
    return (
      <p className='text-[13px] text-red-600 dark:text-red-400'>
        Could not read the infrastructure status.
      </p>
    )
  if (data.cloud)
    return (
      <p className='text-[13px] text-slate-600 dark:text-muted-foreground'>
        Infrastructure is managed by the platform in cloud mode.
      </p>
    )
  return (
    <div className='space-y-4'>
      {!data.docker.configured && <DockerNotConfigured />}
      {data.docker.hosts.length > 0 && (
        <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
          {data.docker.hosts.map((h) => (
            <div
              key={h.host}
              className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
            >
              <div className='flex items-center gap-2'>
                <Server className='h-4 w-4 text-slate-400' />
                <span className='text-[13px] font-semibold'>{h.host}</span>
                {h.error ? (
                  <XCircle className='ml-auto h-4 w-4 text-red-500' aria-label='not answering' />
                ) : (
                  <CheckCircle2
                    className='ml-auto h-4 w-4 text-emerald-600 dark:text-emerald-400'
                    aria-label='answering'
                  />
                )}
              </div>
              {h.error ? (
                <p className='mt-2 text-[12px] text-red-600 dark:text-red-400'>{h.error}</p>
              ) : (
                h.data && (
                  <dl className='mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]'>
                    <dt className='text-slate-500 dark:text-muted-foreground'>Host</dt>
                    <dd className='truncate'>{h.data.hostname ?? '—'}</dd>
                    <dt className='text-slate-500 dark:text-muted-foreground'>Engine</dt>
                    <dd>
                      {h.data.engine ?? '—'} (API {h.data.api ?? '—'})
                    </dd>
                    <dt className='text-slate-500 dark:text-muted-foreground'>OS</dt>
                    <dd className='truncate'>{h.data.os ?? '—'}</dd>
                    <dt className='text-slate-500 dark:text-muted-foreground'>Kernel</dt>
                    <dd className='truncate'>{h.data.kernel ?? '—'}</dd>
                    <dt className='text-slate-500 dark:text-muted-foreground'>Size</dt>
                    <dd>
                      {h.data.cpus ?? '—'} CPUs ·{' '}
                      {h.data.memory_bytes ? formatFileSize(h.data.memory_bytes) : '—'}
                    </dd>
                    <dt className='text-slate-500 dark:text-muted-foreground'>Swarm</dt>
                    <dd>
                      {h.data.swarm === 'active'
                        ? h.data.manager
                          ? 'Manager'
                          : 'Worker'
                        : (h.data.swarm ?? 'Not in a swarm')}
                    </dd>
                  </dl>
                )
              )}
            </div>
          ))}
        </div>
      )}
      <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
        Host metrics {data.metrics_store ? 'come from' : 'need'} the telemetry store
        {data.metrics_store ? '' : ' (TELEMETRY_STORE_URL is not set)'}.
      </p>
    </div>
  )
}
