import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { formatFileSize } from '@/lib/utils'
import {
  duration,
  FactsNotCollected,
  HostSection,
  HostSkeletons,
  MetaGrid,
  StoreNotConfigured,
  TabError,
  type Tone,
  ToneBanner,
  ToneChip
} from './host-ui'
import { useInfraStatus } from './ui'

/** GET /api/infrastructure/hosts (#2836 #2837). */
interface HostsData {
  store: boolean
  error: string | null
  hosts: Array<{
    host: string
    docker: boolean
    collected_at: number | null
    stale: boolean
    swarm_cert_expiry: number | null
    patch: {
      level: Tone
      kernel_running: string | null
      kernel_installed: string | null
      kernel_pending: boolean
      reboot_required: boolean | null
      days_since_boot: number | null
      boot_free_bytes: number | null
      boot_low: boolean
      security_updates: number | null
      notes: string[]
    }
    hung: {
      level: Tone
      headline: string | null
      dstate_processes: number | null
      hung_task_events: number | null
      load1: number | null
      cpus: number | null
      idle_pct: number | null
      iowait_pct: number | null
      nfs_not_responding: Array<{ server: string; mountpoint: string | null }>
      device_errors: string[]
      suspect_mount: string | null
    }
  }>
}

const PATCH_LABEL: Record<Tone, string> = {
  ok: 'Up to date',
  warning: 'Needs attention',
  critical: 'Action needed',
  unknown: 'Not collected'
}
const IO_LABEL: Record<Tone, string> = {
  ok: 'IO healthy',
  warning: 'IO warning',
  critical: 'Waiting on IO',
  unknown: 'IO unknown'
}

const dash = (v: number | string | null | undefined) => (v == null || v === '' ? '—' : v)

/** Host health: patch and reboot status, and whether the host is stuck waiting on IO. */
export function HostsTab() {
  const status = useInfraStatus()
  const { data, isLoading, error } = useQuery({
    queryKey: ['infrastructure', 'hosts'],
    queryFn: async () => (await api.get('/infrastructure/hosts')).data.data as HostsData,
    refetchInterval: 60_000,
    staleTime: 20_000
  })
  if (isLoading) return <HostSkeletons />
  if (error || !data) return <TabError what='host health' />
  if (status.data?.cloud)
    return (
      <p className='text-[13px] text-slate-600 dark:text-muted-foreground'>
        Infrastructure is managed by the platform in cloud mode.
      </p>
    )
  if (!data.store) return <StoreNotConfigured />
  if (data.hosts.length === 0)
    return (
      <div className='space-y-3'>
        <p className='text-[13px] text-slate-600 dark:text-muted-foreground'>
          No host has reported yet. Hosts appear here once a Docker host is connected or the host
          facts collector sends its first figures.
        </p>
        <FactsNotCollected title='Install the host facts collector on each host' />
      </div>
    )
  return (
    <div className='space-y-4'>
      {data.error && (
        <ToneBanner tone='warning'>
          The metrics store answered with an error: {data.error}
        </ToneBanner>
      )}
      {data.hosts.map((h) => (
        <HostCard key={h.host} h={h} />
      ))}
    </div>
  )
}

function HostCard({ h }: { h: HostsData['hosts'][number] }) {
  const now = Date.now()
  const collected = h.collected_at != null
  const p = h.patch
  const io = h.hung
  const certDays =
    h.swarm_cert_expiry != null ? Math.floor((h.swarm_cert_expiry - now) / 86_400_000) : null
  return (
    <HostSection
      host={h.host}
      aside={
        collected ? (
          <>
            <span data-tip={new Date(h.collected_at as number).toLocaleString()}>
              {h.stale ? 'Last collected ' : 'Collected '}
              {duration(now - (h.collected_at as number))} ago
            </span>
            <ToneChip tone={p.level}>{PATCH_LABEL[p.level]}</ToneChip>
            <ToneChip tone={io.level}>{IO_LABEL[io.level]}</ToneChip>
          </>
        ) : (
          <FactsNotCollected compact />
        )
      }
    >
      {!collected ? (
        <FactsNotCollected />
      ) : (
        <>
          {h.stale && (
            <ToneBanner tone='warning'>
              The collector has not reported for {duration(now - (h.collected_at as number))}; the
              figures below are the last ones it sent.
            </ToneBanner>
          )}
          {io.headline && <ToneBanner tone={io.level}>{io.headline}</ToneBanner>}

          <div className='space-y-2'>
            <h3 className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
              Patches and reboot
            </h3>
            <MetaGrid
              items={[
                { label: 'Running kernel', value: dash(p.kernel_running), mono: true },
                {
                  label: 'Installed kernel',
                  value: dash(p.kernel_installed),
                  mono: true,
                  tone: p.kernel_pending ? 'warning' : undefined
                },
                {
                  label: 'Reboot',
                  value:
                    p.reboot_required == null ? '—' : p.reboot_required ? 'Needed' : 'Not needed',
                  tone: p.reboot_required ? 'warning' : undefined
                },
                {
                  label: 'Up for',
                  value:
                    p.days_since_boot == null
                      ? '—'
                      : `${p.days_since_boot} day${p.days_since_boot === 1 ? '' : 's'}`
                },
                {
                  label: '/boot free',
                  value: formatFileSize(p.boot_free_bytes),
                  tone: p.boot_low ? 'critical' : undefined
                },
                {
                  label: 'Security updates',
                  value: dash(p.security_updates),
                  tone: (p.security_updates ?? 0) > 0 ? 'warning' : undefined
                }
              ]}
            />
            {p.notes.filter((n) => !n.startsWith('Host facts are out of date')).length > 0 && (
              <ul className='list-disc space-y-0.5 pl-5 text-[12px] text-slate-600 dark:text-muted-foreground'>
                {p.notes
                  .filter((n) => !n.startsWith('Host facts are out of date'))
                  .map((n) => (
                    <li key={n}>{n}</li>
                  ))}
              </ul>
            )}
          </div>

          <div className='space-y-2'>
            <h3 className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
              IO and load
            </h3>
            <MetaGrid
              items={[
                {
                  label: 'Load (1 min)',
                  value:
                    io.load1 == null
                      ? '—'
                      : `${io.load1.toFixed(1)}${io.cpus ? ` on ${io.cpus} CPUs` : ''}`
                },
                { label: 'CPU idle', value: io.idle_pct == null ? '—' : `${io.idle_pct}%` },
                { label: 'IO wait', value: io.iowait_pct == null ? '—' : `${io.iowait_pct}%` },
                {
                  label: 'Stuck on IO (D state)',
                  value: dash(io.dstate_processes),
                  tone: (io.dstate_processes ?? 0) >= 5 ? 'warning' : undefined
                },
                {
                  label: 'Hung tasks (15 min)',
                  value: dash(io.hung_task_events),
                  tone: (io.hung_task_events ?? 0) > 0 ? 'warning' : undefined
                },
                {
                  label: 'NFS not responding',
                  value: io.nfs_not_responding.length
                    ? io.nfs_not_responding.map((n) => n.server).join(', ')
                    : 'None',
                  tone: io.nfs_not_responding.length ? 'critical' : undefined,
                  mono: io.nfs_not_responding.length > 0
                }
              ]}
            />
            {certDays != null && (
              <p
                className={
                  certDays < 14
                    ? 'text-[12px] text-amber-700 dark:text-amber-300'
                    : 'text-[12px] text-slate-500 dark:text-muted-foreground'
                }
              >
                Swarm node certificate {certDays < 0 ? 'expired' : 'expires'}{' '}
                {new Date(h.swarm_cert_expiry as number).toLocaleDateString()}
                {certDays >= 0 ? ` (in ${certDays} day${certDays === 1 ? '' : 's'})` : ''}.
              </p>
            )}
          </div>
        </>
      )}
    </HostSection>
  )
}
