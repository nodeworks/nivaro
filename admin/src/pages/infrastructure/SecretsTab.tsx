import { Fragment, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Ago,
  Chip,
  EmptyNote,
  FilterChip,
  InfraHostsView,
  matches,
  PANEL,
  SearchBox,
  StatStrip,
  TABLE,
  TD,
  TH,
  useInfraHosts
} from './swarm-ui'

/** #2839 — GET /api/infrastructure/secrets, one host. Names and metadata only. */
interface Version {
  id: string
  name: string
  version: number | null
  created_at: string | null
  updated_at: string | null
  used_by: Array<{ service_id: string; service: string; target: string | null }>
  unused: boolean
  latest: boolean
}
interface Group {
  kind: 'secret' | 'config'
  /** service-specs: configs are never read, only the names services reference. */
  source: 'swarm' | 'service-specs'
  base: string
  versions: Version[]
  stale: Array<{ service_id: string; service: string; uses: string; latest: string }>
}
interface HostSecrets {
  manager: boolean
  groups: Group[]
  counts: { secrets: number; configs: number; unused: number; stale: number }
  unavailable: string[]
}

/** Secret and config usage map: which services use which version; unused and stale flagged. */
export function SecretsTab() {
  const query = useInfraHosts<HostSecrets>('secrets', { refetchInterval: 60_000 })
  const [q, setQ] = useState('')
  const [issues, setIssues] = useState(false)
  return (
    <InfraHostsView<HostSecrets>
      query={query}
      toolbar={
        <div className='flex flex-wrap items-center gap-2'>
          <SearchBox value={q} onChange={setQ} placeholder='Filter names and services' />
          <FilterChip on={issues} onToggle={() => setIssues((v) => !v)}>
            Unused or stale only
          </FilterChip>
        </div>
      }
    >
      {(data) => <HostSecretsView data={data} q={q} issues={issues} />}
    </InfraHostsView>
  )
}

function HostSecretsView({ data, q, issues }: { data: HostSecrets; q: string; issues: boolean }) {
  if (!data.manager)
    return (
      <EmptyNote>
        Secrets and configs are read from a swarm manager; this host is not one (or is not in a
        swarm).
      </EmptyNote>
    )
  const groups = data.groups.filter(
    (g) =>
      (!issues || g.stale.length > 0 || g.versions.some((v) => v.unused)) &&
      matches(
        q,
        g.base,
        ...g.versions.map((v) => v.name),
        ...g.versions.flatMap((v) => v.used_by.map((r) => r.service))
      )
  )
  const c = data.counts
  return (
    <div className='space-y-4'>
      <StatStrip
        items={[
          { label: 'Secrets', value: c.secrets },
          { label: 'Configs referenced by services', value: c.configs },
          { label: 'Unused', value: c.unused, tone: c.unused ? 'warn' : undefined },
          {
            label: 'Services on an older version',
            value: c.stale,
            tone: c.stale ? 'warn' : undefined
          }
        ]}
      />
      {data.unavailable.length > 0 && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          The proxy does not allow the {data.unavailable.join(' and ')} section
          {data.unavailable.length === 1 ? '' : 's'}, so{' '}
          {data.unavailable.length === 1 ? 'it is' : 'they are'} not listed.
        </p>
      )}
      {groups.length === 0 ? (
        <EmptyNote>
          {q || issues ? 'Nothing matches this filter.' : 'This swarm has no secrets or configs.'}
        </EmptyNote>
      ) : (
        <div className={PANEL}>
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Kind</th>
                <th className={TH}>Used by</th>
                <th className={TH}>Created</th>
                <th className={TH}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={`${g.kind}:${g.base}`}>
                  {g.versions.map((v, i) => {
                    const staleHere = g.stale.filter((s) => s.uses === v.name)
                    return (
                      <tr
                        key={v.id}
                        className={cn(i > 0 && 'text-slate-600 dark:text-muted-foreground')}
                      >
                        <td className={cn(TD, i > 0 && 'pl-7')}>
                          <span className='font-mono'>{v.name}</span>
                        </td>
                        <td className={TD}>
                          {i === 0 &&
                            (g.source === 'service-specs' ? (
                              <span data-tip='Listed from the services that reference it; config contents are never read'>
                                config
                              </span>
                            ) : (
                              g.kind
                            ))}
                        </td>
                        <td className={TD}>
                          {v.used_by.length ? (
                            <span className='flex flex-wrap gap-x-3 gap-y-0.5'>
                              {v.used_by.map((r) => (
                                <span
                                  key={`${r.service_id}|${r.target}`}
                                  className='font-mono'
                                  data-tip={r.target ? `Mounted at ${r.target}` : undefined}
                                >
                                  {r.service}
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className='text-slate-400'>no service</span>
                          )}
                        </td>
                        <td className={TD}>
                          <Ago at={v.created_at} />
                        </td>
                        <td className={TD}>
                          <span className='flex flex-wrap gap-1'>
                            {g.versions.length > 1 && v.latest && <Chip tone='info'>latest</Chip>}
                            {v.unused && (
                              <Chip
                                tone='warn'
                                tip='No service references it; it can be removed once nothing needs it'
                              >
                                unused
                              </Chip>
                            )}
                            {staleHere.length > 0 && (
                              <Chip
                                tone='warn'
                                tip={`${staleHere.map((s) => s.service).join(', ')} still use this; ${staleHere[0].latest} is newer`}
                              >
                                older version in use
                              </Chip>
                            )}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className='max-w-prose text-[12px] leading-5 text-slate-500 dark:text-muted-foreground'>
        Names and dates only. Docker never returns secret values. Configs are never read at all
        (their contents can hold credentials): they are listed by the names services reference, so a
        config no service uses does not appear.
      </p>
    </div>
  )
}
