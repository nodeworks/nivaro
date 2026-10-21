import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  FactsNotCollected,
  HostSection,
  HostSkeletons,
  TabError,
  type Tone,
  ToneBanner,
  ToneChip
} from './host-ui'
import { DockerNotConfigured, HostError, useInfraStatus } from './ui'

type Verdict = 'comes_back' | 'stays_down' | 'may_break'

/** GET /api/infrastructure/reboot (#2829). */
interface RebootData {
  hosts: Array<{
    host: string
    error: string | null
    data: {
      facts_collected: boolean
      stopped: number
      counts: Record<Verdict, number>
      host_notes: string[]
      summary: string
      containers: Array<{
        name: string
        image: string | null
        managed_by: 'swarm' | 'compose' | 'none'
        stack: string | null
        service: string | null
        restart_policy: string | null
        verdict: Verdict
        reason: string
        remote_mounts: Array<{
          mountpoint: string
          destination: string
          nofail: boolean
          docker_waits: boolean | null
        }>
      }>
    } | null
  }>
}

const VERDICT: Record<Verdict, { tone: Tone; label: string }> = {
  comes_back: { tone: 'ok', label: 'Comes back' },
  stays_down: { tone: 'critical', label: 'Stays down' },
  may_break: { tone: 'warning', label: 'May come back broken' }
}

const MANAGED: Record<string, string> = { swarm: 'Swarm', compose: 'Compose', none: 'Docker run' }

/** Per host, per running container: does it come back on its own after the host reboots? */
export function RebootTab() {
  const status = useInfraStatus()
  const { data, isLoading, error } = useQuery({
    queryKey: ['infrastructure', 'reboot'],
    queryFn: async () => (await api.get('/infrastructure/reboot')).data.data as RebootData,
    staleTime: 30_000
  })
  if (isLoading || status.isLoading) return <HostSkeletons />
  if (error || !data) return <TabError what='the reboot check' />
  if (status.data && !status.data.docker.configured) return <DockerNotConfigured />
  return (
    <div className='space-y-4'>
      <p className='max-w-prose text-[12px] text-slate-500 dark:text-muted-foreground'>
        What happens to each running container when its host reboots (for example after patching),
        judged on its restart policy or swarm service and on the remote mounts it uses.
      </p>
      {data.hosts.map((h) =>
        h.error || !h.data ? (
          <HostError key={h.host} host={h.host} error={h.error ?? 'No answer'} />
        ) : (
          <RebootHost key={h.host} host={h.host} d={h.data} />
        )
      )}
    </div>
  )
}

function RebootHost({
  host,
  d
}: {
  host: string
  d: NonNullable<RebootData['hosts'][number]['data']>
}) {
  const tone: Tone = d.counts.stays_down ? 'critical' : d.counts.may_break ? 'warning' : 'ok'
  return (
    <HostSection
      host={host}
      aside={
        <>
          {d.counts.stays_down > 0 && (
            <ToneChip tone='critical'>{d.counts.stays_down} stay down</ToneChip>
          )}
          {d.counts.may_break > 0 && (
            <ToneChip tone='warning'>{d.counts.may_break} may break</ToneChip>
          )}
          {d.counts.comes_back > 0 && (
            <ToneChip tone='ok'>{d.counts.comes_back} come back</ToneChip>
          )}
        </>
      }
    >
      <ToneBanner tone={d.containers.length ? tone : 'unknown'}>{d.summary}</ToneBanner>
      {!d.facts_collected && <FactsNotCollected />}
      {d.host_notes.filter((n) => !n.startsWith('Host facts are not collected')).length > 0 && (
        <ul className='list-disc space-y-0.5 pl-5 text-[12px] text-amber-800 dark:text-amber-200'>
          {d.host_notes
            .filter((n) => !n.startsWith('Host facts are not collected'))
            .map((n) => (
              <li key={n}>{n}</li>
            ))}
        </ul>
      )}
      {d.containers.length > 0 && (
        <div className='overflow-x-auto rounded-md border border-slate-200 dark:border-border'>
          <table className='w-full min-w-[720px] text-[12px]'>
            <thead>
              <tr className='border-b border-slate-200 text-left text-[11px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'>
                <th className='px-3 py-2 font-medium'>Container</th>
                <th className='px-3 py-2 font-medium'>Managed by</th>
                <th className='px-3 py-2 font-medium'>Restart</th>
                <th className='px-3 py-2 font-medium'>Remote mounts</th>
                <th className='px-3 py-2 font-medium'>After a reboot</th>
              </tr>
            </thead>
            <tbody>
              {d.containers.map((c) => (
                <tr
                  key={c.name}
                  className='border-b border-slate-100 align-top last:border-0 hover:bg-slate-50 dark:border-border/60 dark:hover:bg-muted/40'
                >
                  <td className='max-w-[260px] px-3 py-2'>
                    <div className='truncate font-mono text-slate-900 dark:text-foreground'>
                      {c.name}
                    </div>
                    {c.image && (
                      <div className='truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                        {c.image}
                      </div>
                    )}
                  </td>
                  <td className='px-3 py-2 text-slate-700 dark:text-foreground'>
                    {MANAGED[c.managed_by]}
                    {(c.stack || c.service) && (
                      <div className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                        {[c.stack, c.service].filter(Boolean).join(' / ')}
                      </div>
                    )}
                  </td>
                  <td className='px-3 py-2 font-mono text-slate-700 dark:text-foreground'>
                    {c.restart_policy ?? '—'}
                  </td>
                  <td className='px-3 py-2'>
                    {c.remote_mounts.length === 0 ? (
                      <span className='text-slate-500 dark:text-muted-foreground'>None</span>
                    ) : (
                      <ul className='space-y-0.5'>
                        {c.remote_mounts.map((m) => (
                          <li key={m.mountpoint} className='font-mono'>
                            <span
                              className={cn(
                                m.docker_waits === false
                                  ? 'text-amber-700 dark:text-amber-300'
                                  : 'text-slate-700 dark:text-foreground'
                              )}
                            >
                              {m.mountpoint}
                            </span>
                            <span className='ml-1 font-sans text-[11px] text-slate-500 dark:text-muted-foreground'>
                              {m.docker_waits === false
                                ? 'Docker does not wait'
                                : m.docker_waits
                                  ? 'Docker waits'
                                  : ''}
                              {!m.nofail ? `${m.docker_waits == null ? '' : ' · '}no nofail` : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className='px-3 py-2'>
                    <ToneChip tone={VERDICT[c.verdict].tone}>{VERDICT[c.verdict].label}</ToneChip>
                    <p className='mt-1 max-w-[320px] text-[11px] leading-snug text-slate-500 dark:text-muted-foreground'>
                      {c.reason}
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.stopped > 0 && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          {d.stopped} stopped container{d.stopped === 1 ? ' is' : 's are'} not judged — they are
          down already.
        </p>
      )}
    </HostSection>
  )
}
