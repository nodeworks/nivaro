import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from '@/lib/api'
import { cn, formatFileSize, formatRelative } from '@/lib/utils'
import { Code, NotConfigured, Pill } from './edge-ui'
import { Dash, LoadError, Note, PANEL, PANEL_TITLE, TABLE, TabSkeleton, TD, TH } from './ui'

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
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['infrastructure', 'gitlab'],
    queryFn: async () => (await api.get('/infrastructure/gitlab')).data.data as View,
    refetchInterval: 60_000
  })
  if (isLoading) return <TabSkeleton />
  if (error || !data) return <LoadError what='GitLab' onRetry={refetch} />
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
        <span className='font-mono text-slate-700 dark:text-foreground'>{data.base}</span>
        {version?.data ? (
          <>
            {' · GitLab '}
            <span className='font-mono'>{version.data.version}</span>
          </>
        ) : null}
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
                  <span
                    key={c.name}
                    className={cn(
                      'font-mono text-[11px]',
                      c.status === 'ok'
                        ? 'text-slate-500 dark:text-muted-foreground'
                        : 'font-medium text-red-700 dark:text-red-300'
                    )}
                  >
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
                  <span className='font-mono font-medium'>{c.container}</span> on{' '}
                  <span className='font-mono'>{c.host}</span>: CPU {c.cpu_cores?.toFixed(2) ?? '—'}{' '}
                  cores, memory {c.mem_bytes == null ? '—' : formatFileSize(c.mem_bytes)}
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
        <div className={PANEL}>
          <div className={PANEL_TITLE}>
            <span className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
              All runners
            </span>
            <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
              {runners.data.runners.length}
            </span>
          </div>
          <table className={cn(TABLE, 'min-w-[640px]')}>
            <thead>
              <tr>
                <th className={TH}>Runner</th>
                <th className={TH}>State</th>
                <th className={TH}>Type</th>
                <th className={TH}>Last contact</th>
                <th className={TH}>Version</th>
              </tr>
            </thead>
            <tbody>
              {runners.data.runners.map((r) => (
                <tr key={r.id}>
                  <td className={cn(TD, 'font-mono font-medium [overflow-wrap:anywhere]')}>
                    {r.name}
                  </td>
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
                  <td className={cn(TD, 'whitespace-nowrap')}>
                    {r.contacted_at ? (
                      <span data-tip={new Date(r.contacted_at).toLocaleString()}>
                        {formatRelative(r.contacted_at)}
                      </span>
                    ) : (
                      'never'
                    )}
                  </td>
                  <td className={cn(TD, 'font-mono')}>{r.version ?? <Dash />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {flaggedRunners.length > 0 && (
        <Note tone='warn'>
          {flaggedRunners.length} {flaggedRunners.length === 1 ? 'runner needs' : 'runners need'} a
          look: offline, stale (no contact for a day) or never contacted.
        </Note>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='min-w-0 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <h2 className='mb-2 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
        {title}
      </h2>
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
