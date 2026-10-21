import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Ago,
  Chip,
  EmptyNote,
  FilterChip,
  fmtDuration,
  ImageRef,
  InfraHostsView,
  matches,
  PANEL,
  SearchBox,
  StateChip,
  StatStrip,
  TABLE,
  TD,
  TH,
  useInfraHosts
} from './swarm-ui'

/** #2828 — GET /api/infrastructure/health, one host. */
interface HealthRow {
  id: string
  name: string
  image: string | null
  version: string | null
  stack: string | null
  service: string | null
  project: string | null
  health: 'healthy' | 'unhealthy' | 'starting'
  status: string | null
  unhealthy_24h: number
  last_change_at: string | null
}
interface HostHealth {
  containers: HealthRow[]
  trend: Array<{
    version: string
    image: string | null
    containers: number
    unhealthy_now: number
    unhealthy_3d: number
    avg_to_healthy_ms: number | null
  }>
  counts: { with_healthcheck: number; healthy: number; unhealthy: number; starting: number }
}
interface HealthDetail {
  health: string | null
  failing_streak: number
  restart_count: number
  started_at: string | null
  first_healthy_at: string | null
  to_healthy_ms: number | null
  unhealthy_24h: number
  probes: Array<{
    start: string | null
    duration_ms: number | null
    exit_code: number | null
    output: string
  }>
  transitions: Array<{ status: string; at: string }>
}

/** Healthcheck history: every container with a healthcheck, its flaps, and a trend by release. */
export function HealthTab() {
  const query = useInfraHosts<HostHealth>('health', { refetchInterval: 60_000 })
  const [q, setQ] = useState('')
  const [badOnly, setBadOnly] = useState(false)
  return (
    <InfraHostsView<HostHealth>
      query={query}
      toolbar={
        <div className='flex flex-wrap items-center gap-2'>
          <SearchBox value={q} onChange={setQ} placeholder='Filter containers and images' />
          <FilterChip on={badOnly} onToggle={() => setBadOnly((v) => !v)}>
            Not healthy or flapping
          </FilterChip>
        </div>
      }
    >
      {(data, host) => <HostHealthView data={data} host={host} q={q} badOnly={badOnly} />}
    </InfraHostsView>
  )
}

function HostHealthView({
  data,
  host,
  q,
  badOnly
}: {
  data: HostHealth
  host: string
  q: string
  badOnly: boolean
}) {
  const rows = data.containers.filter(
    (r) =>
      (!badOnly || r.health !== 'healthy' || r.unhealthy_24h > 0) &&
      matches(q, r.name, r.image, r.version, r.service, r.stack, r.project)
  )
  const c = data.counts
  if (c.with_healthcheck === 0)
    return (
      <EmptyNote>
        No container on this host has a healthcheck. Add one (HEALTHCHECK in the image or
        healthcheck in compose) to see its history here.
      </EmptyNote>
    )
  return (
    <div className='space-y-4'>
      <StatStrip
        items={[
          { label: 'With a healthcheck', value: c.with_healthcheck },
          { label: 'Healthy', value: c.healthy },
          { label: 'Unhealthy', value: c.unhealthy, tone: c.unhealthy ? 'bad' : undefined },
          { label: 'Starting', value: c.starting, tone: c.starting ? 'warn' : undefined }
        ]}
      />
      <div className={PANEL}>
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>Container</th>
              <th className={TH}>Health</th>
              <th className={TH}>Unhealthy in 24 h</th>
              <th className={TH}>Last change</th>
              <th className={TH}>Image</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className='hover:bg-slate-50 dark:hover:bg-muted/40'>
                <td className={TD}>
                  <HealthDetailPopover host={host} row={r} />
                  {(r.stack || r.project) && (
                    <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                      {r.stack ? `stack ${r.stack}` : `compose ${r.project}`}
                    </span>
                  )}
                </td>
                <td className={TD}>
                  <StateChip state={r.health} tip={r.status ?? undefined} />
                </td>
                <td className={cn(TD, 'tabular-nums')}>
                  {r.unhealthy_24h ? (
                    <span className='text-red-600 dark:text-red-400'>
                      {r.unhealthy_24h} time{r.unhealthy_24h === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className='text-slate-500 dark:text-muted-foreground'>none</span>
                  )}
                </td>
                <td className={TD}>
                  <Ago at={r.last_change_at} />
                </td>
                <td className={cn(TD, 'max-w-[280px]')}>
                  <ImageRef image={r.image} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className={cn(TD, 'py-6 text-center text-slate-500 dark:text-muted-foreground')}
                >
                  Nothing matches this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data.trend.length > 0 && (
        <div className={PANEL}>
          <table className={TABLE}>
            <caption className='px-4 pt-2 text-left text-[12px] font-medium text-slate-700 dark:text-foreground'>
              By release (image version label), last 3 days
            </caption>
            <thead>
              <tr>
                <th className={TH}>Version</th>
                <th className={TH}>Image</th>
                <th className={TH}>Containers</th>
                <th className={TH}>Unhealthy now</th>
                <th className={TH}>Turned unhealthy</th>
                <th className={TH}>Average start to healthy</th>
              </tr>
            </thead>
            <tbody>
              {data.trend.map((t) => (
                <tr key={`${t.image}|${t.version}`}>
                  <td className={cn(TD, 'font-mono')}>{t.version}</td>
                  <td className={cn(TD, 'max-w-[280px]')}>
                    <ImageRef image={t.image} />
                  </td>
                  <td className={cn(TD, 'tabular-nums')}>{t.containers}</td>
                  <td
                    className={cn(
                      TD,
                      'tabular-nums',
                      t.unhealthy_now ? 'text-red-600 dark:text-red-400' : ''
                    )}
                  >
                    {t.unhealthy_now}
                  </td>
                  <td className={cn(TD, 'tabular-nums')}>{t.unhealthy_3d}</td>
                  <td className={cn(TD, 'tabular-nums')}>{fmtDuration(t.avg_to_healthy_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
        Changes are sampled every 2 minutes and whenever this tab is read, and kept for 3 days. A
        flap shorter than that can be missed.
      </p>
    </div>
  )
}

function HealthDetailPopover({ host, row }: { host: string; row: HealthRow }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='rounded text-left font-mono font-medium text-slate-900 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-foreground'
        >
          {row.name}
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[min(520px,calc(100vw-32px))] p-0'>
        {open && <HealthDetailBody host={host} id={row.id} />}
      </PopoverContent>
    </Popover>
  )
}

function HealthDetailBody({ host, id }: { host: string; id: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['infrastructure', 'health-detail', host, id],
    queryFn: async () =>
      (
        await api.get(
          `/infrastructure/health/${encodeURIComponent(host)}/${encodeURIComponent(id)}`
        )
      ).data.data as HealthDetail,
    staleTime: 5_000
  })
  if (isLoading)
    return (
      <div className='space-y-2 p-4'>
        <Skeleton className='h-4 w-40' />
        <Skeleton className='h-16' />
      </div>
    )
  if (error || !data)
    return (
      <p className='p-4 text-[12px] text-red-600 dark:text-red-400'>
        Could not inspect this container — it may have been replaced since the list was read.
      </p>
    )
  return (
    <div className='max-h-[min(70vh,560px)] overflow-y-auto text-[12px]'>
      <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-b border-slate-200 p-4 dark:border-border'>
        <dt className='text-slate-500 dark:text-muted-foreground'>Health</dt>
        <dd>
          <StateChip state={data.health} />
          {data.failing_streak > 0 && (
            <span className='ml-2 text-red-600 dark:text-red-400'>
              {data.failing_streak} failed probe{data.failing_streak === 1 ? '' : 's'} in a row
            </span>
          )}
        </dd>
        <dt className='text-slate-500 dark:text-muted-foreground'>Started</dt>
        <dd>
          <Ago at={data.started_at} />
          {data.restart_count > 0 && ` · restarted ${data.restart_count} times`}
        </dd>
        <dt className='text-slate-500 dark:text-muted-foreground'>Start to healthy</dt>
        <dd>
          {data.to_healthy_ms != null
            ? fmtDuration(data.to_healthy_ms)
            : 'Not seen (older probes are no longer kept)'}
        </dd>
        <dt className='text-slate-500 dark:text-muted-foreground'>Last 24 hours</dt>
        <dd>
          {data.unhealthy_24h
            ? `Unhealthy ${data.unhealthy_24h} time${data.unhealthy_24h === 1 ? '' : 's'}`
            : 'Never unhealthy'}
        </dd>
      </dl>
      <div className='p-4'>
        <h3 className='mb-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Last probes
        </h3>
        {data.probes.length === 0 ? (
          <p className='text-slate-500 dark:text-muted-foreground'>No probe has run yet.</p>
        ) : (
          <ul className='space-y-2'>
            {data.probes.map((p) => (
              <li key={`${p.start}|${p.duration_ms}|${p.exit_code}`} className='space-y-1'>
                <div className='flex items-center gap-2'>
                  <Chip tone={p.exit_code === 0 ? 'ok' : 'bad'}>
                    {p.exit_code === 0 ? 'passed' : `exit ${p.exit_code ?? '?'}`}
                  </Chip>
                  <Ago at={p.start} />
                  <span className='text-slate-500 dark:text-muted-foreground'>
                    {fmtDuration(p.duration_ms)}
                  </span>
                </div>
                {p.output && (
                  <pre className='whitespace-pre-wrap break-all rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-700 dark:bg-muted dark:text-muted-foreground'>
                    {p.output}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
        {data.transitions.length > 0 && (
          <>
            <h3 className='mb-2 mt-4 text-[12px] font-medium text-slate-700 dark:text-foreground'>
              Changes (last 3 days)
            </h3>
            <ol className='flex flex-wrap gap-1.5'>
              {[...data.transitions].reverse().map((t) => (
                <li key={`${t.at}-${t.status}`}>
                  <StateChip state={t.status} tip={new Date(t.at).toLocaleString()} />
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  )
}
