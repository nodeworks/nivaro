import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatFileSize, formatRelative } from '@/lib/utils'
import { Code, NotConfigured, Pill, TABLE_WRAP, TD, TH } from './edge-ui'

interface Part<T> {
  ok: boolean
  error: string | null
  data: T | null
}
interface Runner {
  id: number
  name: string
  type: string
  state: 'online' | 'offline' | 'stale' | 'never_contacted' | 'paused'
  flagged: boolean
  contacted_at: string | null
  version: string | null
}
interface Container {
  host: string
  container: string
  cpu_cores: number | null
  mem_bytes: number | null
  mem_limit_bytes: number | null
  mem_share: number | null
  flags: string[]
}
interface View {
  configured: boolean
  base: string | null
  health: Part<{
    readiness: { ok: boolean; checks: Array<{ name: string; status: string }> } | null
    liveness: boolean | null
  }> | null
  version: Part<{ version: string; revision: string | null }> | null
  runners: Part<{
    runners: Runner[]
    counts: Record<string, number>
    scope: 'all' | 'visible'
  }> | null
  pending: Part<{
    count: number
    at_least: boolean
    oldest_age_s: number | null
    source: 'instance' | 'projects'
  }> | null
  container: Part<{ containers: Container[]; registry_bytes: number | null }> | null
}

const STATE_LABEL: Record<Runner['state'], string> = {
  online: 'online',
  offline: 'offline',
  stale: 'stale',
  never_contacted: 'never contacted',
  paused: 'paused'
}

function age(s: number | null): string {
  if (s == null) return '—'
  if (s < 90) return `${s} s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 172800) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} days`
}

/** Self-hosted GitLab: health checks, runners, queue and its container (#2841). */
export function GitlabTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['infrastructure', 'gitlab'],
    queryFn: async () => (await api.get('/infrastructure/gitlab')).data.data as View,
    refetchInterval: 60_000
  })
  if (isLoading) return <Skeleton className='h-64' />
  if (error || !data)
    return <p className='text-[13px] text-red-600 dark:text-red-400'>Could not read GitLab.</p>
  if (!data.configured)
    return (
      <NotConfigured title='No GitLab is connected'>
        Add a component with the GitLab provider, its URL and an access token on the Environments
        page. This tab reuses that connection and never shows the token. Health checks may also need{' '}
        <Code>GITLAB_HEALTH_TOKEN</Code>.
      </NotConfigured>
    )
  const { health, version, runners, pending, container } = data
  const flaggedRunners = runners?.data?.runners.filter((r) => r.flagged) ?? []
  return (
    <div className='space-y-4'>
      <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
        {data.base}
        {version?.data ? ` · GitLab ${version.data.version}` : ''}
      </p>

      <div className='grid gap-3 md:grid-cols-2'>
        <Section title='Health'>
          {health?.ok && health.data ? (
            <ul className='space-y-1 text-[12px]'>
              <li className='flex items-center gap-2'>
                Liveness{' '}
                <Pill tone={health.data.liveness ? 'ok' : 'bad'}>
                  {health.data.liveness ? 'alive' : 'failing'}
                </Pill>
              </li>
              <li className='flex flex-wrap items-center gap-2'>
                Readiness{' '}
                <Pill tone={health.data.readiness?.ok ? 'ok' : 'bad'}>
                  {health.data.readiness?.ok ? 'ready' : 'not ready'}
                </Pill>
                {health.data.readiness?.checks.map((c) => (
                  <span key={c.name} className='text-slate-500 dark:text-muted-foreground'>
                    {c.name}: {c.status}
                  </span>
                ))}
              </li>
            </ul>
          ) : (
            <Unavailable error={health?.error} />
          )}
        </Section>

        <Section title='Job queue'>
          {pending?.ok && pending.data ? (
            <p className='text-[12px]'>
              {pending.data.at_least ? 'At least ' : ''}
              <b>{pending.data.count}</b> pending {pending.data.count === 1 ? 'job' : 'jobs'}
              {pending.data.count > 0 && <>, oldest waiting {age(pending.data.oldest_age_s)}</>}
              {pending.data.source === 'projects' && (
                <span className='text-slate-500 dark:text-muted-foreground'>
                  {' '}
                  (mapped projects only; an administrator token counts the whole instance)
                </span>
              )}
            </p>
          ) : (
            <Unavailable error={pending?.error} />
          )}
        </Section>

        <Section title='GitLab container'>
          {container?.ok && container.data ? (
            <ul className='space-y-1 text-[12px]'>
              {container.data.containers.map((c) => (
                <li key={`${c.host}-${c.container}`}>
                  <b>{c.container}</b> on {c.host}: CPU {c.cpu_cores?.toFixed(2) ?? '—'} cores,
                  memory {c.mem_bytes == null ? '—' : formatFileSize(c.mem_bytes)}
                  {c.mem_limit_bytes != null
                    ? ` of ${formatFileSize(c.mem_limit_bytes)}`
                    : ' (no limit)'}{' '}
                  {c.flags.includes('memory') && <Pill tone='warn'>near limit</Pill>}
                </li>
              ))}
              {container.data.registry_bytes != null && (
                <li>Registry on disk: {formatFileSize(container.data.registry_bytes)}</li>
              )}
            </ul>
          ) : (
            <Unavailable error={container?.error} />
          )}
        </Section>

        <Section title='Runners'>
          {runners?.ok && runners.data ? (
            <p className='text-[12px]'>
              {Object.entries(runners.data.counts)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${n} ${STATE_LABEL[k as Runner['state']]}`)
                .join(' · ') || 'No runners'}
              {runners.data.scope === 'visible' && (
                <span className='text-slate-500 dark:text-muted-foreground'>
                  {' '}
                  (only runners this token can see)
                </span>
              )}
            </p>
          ) : (
            <Unavailable error={runners?.error} />
          )}
        </Section>
      </div>

      {runners?.ok && runners.data && runners.data.runners.length > 0 && (
        <div className={TABLE_WRAP}>
          <table className='w-full min-w-[640px]'>
            <thead className='border-b border-slate-200 dark:border-border'>
              <tr>
                <th className={TH}>Runner</th>
                <th className={TH}>State</th>
                <th className={TH}>Type</th>
                <th className={TH}>Last contact</th>
                <th className={TH}>Version</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {runners.data.runners.map((r) => (
                <tr key={r.id}>
                  <td className={`${TD} font-medium`}>{r.name}</td>
                  <td className={TD}>
                    <Pill
                      tone={
                        r.state === 'online'
                          ? 'ok'
                          : r.state === 'paused'
                            ? 'muted'
                            : r.state === 'offline'
                              ? 'bad'
                              : 'warn'
                      }
                    >
                      {STATE_LABEL[r.state]}
                    </Pill>
                  </td>
                  <td className={TD}>{r.type.replace('_type', '').replace('_', ' ') || '—'}</td>
                  <td className={TD}>
                    {r.contacted_at ? formatRelative(r.contacted_at) : 'never'}
                  </td>
                  <td className={TD}>{r.version ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {flaggedRunners.length > 0 && (
        <p className='text-[12px] text-amber-800 dark:text-amber-200'>
          {flaggedRunners.length} {flaggedRunners.length === 1 ? 'runner needs' : 'runners need'} a
          look: offline, stale (no contact for a day) or never contacted.
        </p>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <h2 className='mb-2 text-[13px] font-semibold'>{title}</h2>
      {children}
    </section>
  )
}

function Unavailable({ error }: { error?: string | null }) {
  return (
    <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
      {error ?? 'Not available.'}
    </p>
  )
}
