import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { useAuth } from '@/lib/auth'
import { hubPageForEveryone } from '@/lib/hubs'
import { formatRelative } from '@/lib/utils'
import { ResourceCostChip } from './costs/RowCosts'
import type { HubAppFull, HubEnvironment } from './hub-api'
import { ghostButton, SectionCard, ToneChip } from './hub-parts'
import { homeOfCategory } from './providers/category-homes'
import {
  fetchProviderTypes,
  fetchResources,
  groupByCategory,
  providerKeys,
  RESOURCE_STATE_COPY,
  resourceName,
  resourceState,
  typeIndex
} from './providers/providers-api'

/**
 * From an app to everything about that app (navigation spec 2026-11-27): the Hub pages that hold
 * this app's side of things, each already narrowed to it (`?app=<id>`, or `?env=<id>` on the
 * pages that work per environment). An owner never
 * has to know which section a page lives in to get from their app to its backups or its issues.
 */
export function AppShortcuts({
  app,
  envs,
  isAdmin
}: {
  app: HubAppFull
  envs: HubEnvironment[]
  /** Not an administrator = an owner: pages only administrators can use are not linked. */
  isAdmin: boolean
}) {
  // Pages that work per environment open on the last one in the chain (production, as a rule).
  const env = envs[envs.length - 1]
  const byApp = `?app=${app.id}`
  const byEnv = env ? `?env=${env.id}` : ''
  const groups: Array<{ label: string; links: Array<{ to: string; label: string }> }> = [
    {
      label: 'Deploys',
      links: [
        { to: `/hub/releases${byApp}`, label: 'Releases' },
        { to: `/hub/smoke${byEnv}`, label: 'Smoke checks' },
        { to: `/hub/config${byApp}`, label: 'Config promotion' }
      ]
    },
    {
      label: 'Monitoring',
      links: [
        { to: `/hub/fleet${byApp}`, label: 'Versions and uptime' },
        { to: `/hub/health${byApp}`, label: 'Health' },
        { to: `/hub/issues${byApp}`, label: 'Issues' },
        { to: `/hub/incidents${byApp}`, label: 'Incidents' }
      ]
    },
    {
      label: 'Data and people',
      links: [
        { to: `/hub/data${byEnv}`, label: 'Backups' },
        { to: `/hub/usage${byEnv}`, label: 'Usage' },
        { to: `/hub/costs${byApp}`, label: 'Costs' },
        { to: `/hub/on-call${byApp}`, label: 'On-call' }
      ]
    }
  ]
  const usable = (l: { to: string }) => isAdmin || hubPageForEveryone(l.to.split('?')[0])
  return (
    <nav
      aria-label={`More about ${app.name}`}
      className='flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 dark:border-border dark:bg-card'
    >
      {groups.map((g) => (
        <div key={g.label} className='flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1'>
          <span className='mr-1 text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
            {g.label}
          </span>
          {g.links.filter(usable).map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className='rounded px-1.5 py-0.5 text-[12px] text-nvr-navy hover:bg-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-nvr-cyan'
            >
              {l.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}

/**
 * Everything this app holds outside the Hub, across its environments, grouped by what it is for
 * (the same groups as the Hub's homes and the provider picker): state, drift and cost per
 * resource. "Change" opens that environment's outside resources, where a change is planned; the
 * group's name opens its home, where the accounts are. Nothing shows until the app holds one.
 */
export function AppOutsideResources({ app, envs }: { app: HubAppFull; envs: HubEnvironment[] }) {
  const [, setParams] = useSearchParams()
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const filter = { app: app.id }
  const resources = useQuery({
    queryKey: providerKeys.resources(filter),
    queryFn: () => fetchResources(filter),
    retry: false
  })
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const rows = (Array.isArray(resources.data) ? resources.data : []).filter((r) => !r.deleted_at)
  if (rows.length === 0 || !types.data) return null
  const idx = typeIndex(types.data)
  const groups = groupByCategory(rows, types.data)
  const envKey = (id: number | null) => envs.find((e) => e.id === id)?.key ?? null
  const drifted = rows.filter((r) => resourceState(r) === 'drift').length
  const gone = rows.filter((r) => resourceState(r) === 'gone').length
  const attention = [drifted && `${drifted} drifted`, gone && `${gone} gone`].filter(Boolean)
  const open = (envId: number | null) => {
    if (envId == null) return
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        out.set('resources', String(envId))
        return out
      },
      { replace: true }
    )
  }
  return (
    <SectionCard
      title='Outside resources'
      description={`${rows.length} held at outside providers, by what they are for${attention.length ? `: ${attention.join(', ')}` : ''}. Change one from its environment.`}
    >
      <div className='divide-y divide-slate-100 dark:divide-border'>
        {groups.map((g) => {
          const home = homeOfCategory(g.key)
          return (
            <section key={g.key} aria-label={g.label} className='px-4 py-3'>
              <h4 className='m-0 mb-1 flex flex-wrap items-baseline gap-x-2 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
                {g.label}
                <span className='font-normal tabular-nums text-slate-500 dark:text-muted-foreground'>
                  {g.rows.length}
                </span>
                {(isAdmin || hubPageForEveryone(home.path)) && (
                  <Link
                    to={home.path}
                    className='ml-auto inline-flex items-center gap-1 text-[11px] font-normal text-nvr-navy hover:underline dark:text-nvr-cyan'
                  >
                    {home.page} <ArrowRight className='h-3 w-3' aria-hidden />
                  </Link>
                )}
              </h4>
              <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
                {g.rows.map((r) => {
                  const copy = RESOURCE_STATE_COPY[resourceState(r)]
                  const env = envKey(r.environment_id)
                  return (
                    <li key={r.id} className='flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5'>
                      <p className='m-0 flex min-w-0 flex-[1_1_240px] items-baseline gap-1.5'>
                        <span className='truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                          {resourceName(r)}
                        </span>
                        <span className='shrink-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {idx.typeLabel(r.type)} · {idx.providerLabel(r.provider)}
                        </span>
                      </p>
                      <span className='flex flex-wrap items-center gap-1'>
                        {env && (
                          <code className='rounded border border-slate-200 px-1.5 py-px font-mono text-[11px] text-slate-600 dark:border-border dark:text-slate-300'>
                            {env}
                          </code>
                        )}
                        <ToneChip
                          tone={copy.tone}
                          compact
                          tip={
                            r.observed_at
                              ? `${copy.tip} Checked ${formatRelative(r.observed_at)}.`
                              : copy.tip
                          }
                        >
                          {copy.label}
                        </ToneChip>
                        <ResourceCostChip resourceId={r.id} appId={app.id} />
                        {env && (
                          <button
                            type='button'
                            className={ghostButton}
                            aria-label={`Change ${resourceName(r)} on ${env}`}
                            onClick={() => open(r.environment_id)}
                          >
                            Change
                          </button>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </SectionCard>
  )
}
