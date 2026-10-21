import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn, formatFileSize } from '@/lib/utils'
import {
  FactsNotCollected,
  HostSection,
  HostSkeletons,
  MetaGrid,
  TabError,
  type Tone,
  ToneBanner,
  ToneChip
} from './host-ui'
import { DockerNotConfigured, HostError, useInfraStatus } from './ui'

/** GET /api/infrastructure/logs (#2831). */
interface LogsData {
  hosts: Array<{
    host: string
    error: string | null
    data: {
      facts_collected: boolean
      docker_root: string | null
      filesystem: { mountpoint: string; avail_bytes: number; size_bytes: number | null } | null
      total_bytes: number | null
      growth_per_day: number | null
      days_until_full: number | null
      unbounded: number
      containers: Array<{
        name: string
        running: boolean
        driver: string | null
        max_size: string | null
        max_file: string | null
        unbounded: boolean
        bytes: number | null
        growth_per_day: number | null
      }>
    } | null
  }>
}

/** Fill-up within a week is urgent; within a month worth planning for. */
const fillTone = (days: number | null): Tone | undefined =>
  days == null ? undefined : days < 7 ? 'critical' : days < 30 ? 'warning' : undefined

/** Container log files per host: how big, how fast they grow, and whether Docker rotates them. */
export function LogsTab() {
  const status = useInfraStatus()
  const { data, isLoading, error } = useQuery({
    queryKey: ['infrastructure', 'logs'],
    queryFn: async () => (await api.get('/infrastructure/logs')).data.data as LogsData,
    staleTime: 60_000
  })
  if (isLoading || status.isLoading) return <HostSkeletons />
  if (error || !data) return <TabError what='container logs' />
  if (status.data && !status.data.docker.configured) return <DockerNotConfigured />
  return (
    <div className='space-y-4'>
      {data.hosts.map((h) =>
        h.error || !h.data ? (
          <HostError key={h.host} host={h.host} error={h.error ?? 'No answer'} />
        ) : (
          <LogsHost key={h.host} host={h.host} d={h.data} />
        )
      )}
    </div>
  )
}

function LogsHost({
  host,
  d
}: {
  host: string
  d: NonNullable<LogsData['hosts'][number]['data']>
}) {
  const tone = fillTone(d.days_until_full)
  return (
    <HostSection
      host={host}
      aside={
        d.unbounded > 0 ? (
          <ToneChip tone='warning'>{d.unbounded} without max-size</ToneChip>
        ) : d.containers.length ? (
          <ToneChip tone='ok'>All rotated</ToneChip>
        ) : null
      }
    >
      {d.days_until_full != null && tone && (
        <ToneBanner tone={tone}>
          At the current growth of {formatFileSize(d.growth_per_day)} a day,{' '}
          {d.filesystem?.mountpoint} fills in about {d.days_until_full} day
          {d.days_until_full === 1 ? '' : 's'}.
        </ToneBanner>
      )}
      {d.unbounded > 0 && (
        <p className='max-w-prose text-[12px] text-slate-600 dark:text-muted-foreground'>
          A json-file log without <code className='font-mono text-[11px]'>max-size</code> keeps one
          file that grows until the disk is full. Set{' '}
          <code className='font-mono text-[11px]'>log-opts</code> in{' '}
          <code className='font-mono text-[11px]'>/etc/docker/daemon.json</code> (new containers) or{' '}
          <code className='font-mono text-[11px]'>logging.options</code> on the service.
        </p>
      )}
      <MetaGrid
        items={[
          { label: 'Log files', value: formatFileSize(d.total_bytes) },
          {
            label: 'Growth per day',
            value: d.growth_per_day == null ? '—' : formatFileSize(d.growth_per_day)
          },
          {
            label: `Free on ${d.filesystem?.mountpoint ?? 'the Docker disk'}`,
            value: d.filesystem ? formatFileSize(d.filesystem.avail_bytes) : '—'
          },
          {
            label: 'Full in',
            value: d.days_until_full == null ? 'Not growing' : `${d.days_until_full} days`,
            tone
          },
          { label: 'Docker root', value: d.docker_root ?? '—', mono: true },
          { label: 'Containers', value: d.containers.length }
        ]}
      />
      {!d.facts_collected && <FactsNotCollected />}
      {d.containers.length > 0 && (
        <div className='overflow-x-auto rounded-md border border-slate-200 dark:border-border'>
          <table className='w-full min-w-[640px] text-[12px]'>
            <thead>
              <tr className='border-b border-slate-200 text-left text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                <th className='px-3 py-2 font-medium'>Container</th>
                <th className='px-3 py-2 font-medium'>Driver</th>
                <th className='px-3 py-2 font-medium'>Rotation</th>
                <th className='px-3 py-2 text-right font-medium'>Size</th>
                <th className='px-3 py-2 text-right font-medium'>Per day</th>
              </tr>
            </thead>
            <tbody>
              {d.containers.map((c) => (
                <tr
                  key={c.name}
                  className='border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-border/60 dark:hover:bg-muted/40'
                >
                  <td className='max-w-[280px] px-3 py-2'>
                    <span className='block truncate font-mono text-slate-900 dark:text-foreground'>
                      {c.name}
                    </span>
                    {!c.running && (
                      <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                        Stopped
                      </span>
                    )}
                  </td>
                  <td className='px-3 py-2 font-mono text-slate-700 dark:text-foreground'>
                    {c.driver ?? '—'}
                  </td>
                  <td className='px-3 py-2'>
                    {c.unbounded ? (
                      <ToneChip tone='warning'>No max-size</ToneChip>
                    ) : c.max_size ? (
                      <span className='font-mono text-slate-700 dark:text-foreground'>
                        {c.max_size}
                        {c.max_file ? ` × ${c.max_file}` : ''}
                      </span>
                    ) : (
                      <span className='text-slate-500 dark:text-muted-foreground'>
                        {c.driver === 'local' ? 'Driver default' : 'Not kept on the host'}
                      </span>
                    )}
                  </td>
                  <td className='px-3 py-2 text-right tabular-nums text-slate-700 dark:text-foreground'>
                    {formatFileSize(c.bytes)}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right tabular-nums',
                      c.unbounded && (c.growth_per_day ?? 0) > 100 * 1048576
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-slate-700 dark:text-foreground'
                    )}
                  >
                    {c.growth_per_day == null ? '—' : formatFileSize(c.growth_per_day)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </HostSection>
  )
}
