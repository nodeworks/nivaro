import { ErrorNotice } from '@nivaro/shared'
import { useQueries, useQuery } from '@tanstack/react-query'
import { ArrowRight, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { formatRelative } from '@/lib/utils'
import { ResourceCostChip } from '../costs/RowCosts'
import { fetchHubApp, fetchHubApps, hubKeys } from '../hub-api'
import { ghostButton, SectionCard, ToneChip } from '../hub-parts'
import { homeOfCategory, providerIn } from './category-homes'
import { ConnectionCard, ConnectionForm, UnmanagedCard } from './HubConnections'
import {
  fetchConnections,
  fetchProviderTypes,
  fetchResources,
  type HubResource,
  isFullConnection,
  providerError,
  providerKeys,
  RESOURCE_STATE_COPY,
  resourceName,
  resourceState,
  typeIndex
} from './providers-api'
import { ConnectionGroup } from './SharedInfra'

const ALL = {}

/**
 * The outside half of a Hub home (docs spec 2026-11-27-hub-navigation-design): on the page for a
 * kind of thing — Databases, Domains, Messaging… — the provider accounts of that kind, what they
 * share between apps, and what each app holds there, with state, drift and cost. Connecting an
 * account is a step here, already narrowed to providers of the kind; the full list of accounts
 * stays on Outside accounts.
 *
 * `groups` are provider group keys (api providers/categories.ts). A provider shows when its own
 * group is one of them or when it holds a kind of thing that is (AWS on Databases, for RDS); a
 * resource shows by its own kind, whichever account holds it.
 */
export function ProviderHome({
  groups,
  isAdmin,
  idPrefix
}: {
  groups: string[]
  isAdmin: boolean
  idPrefix: string
}) {
  const home = homeOfCategory(groups[0] ?? 'other')
  const set = useMemo(() => new Set(groups), [groups])
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const connections = useQuery({ queryKey: providerKeys.connections(), queryFn: fetchConnections })
  const resources = useQuery({
    queryKey: providerKeys.resources(ALL),
    queryFn: () => fetchResources(ALL)
  })
  const [picked, setPicked] = useState<number | 'new' | null>(null)

  if (types.isPending || connections.isPending) return <Skeleton className='h-28 w-full' />
  if (types.isError || connections.isError)
    return (
      <ErrorNotice
        description={providerError(
          types.error ?? connections.error,
          'Could not read the provider accounts'
        )}
        onRetry={() => {
          void types.refetch()
          void connections.refetch()
        }}
      />
    )

  // A Hub without provider routes answers no list: there is no outside half to show.
  if (!Array.isArray(types.data?.providers) || !Array.isArray(connections.data)) return null

  const idx = typeIndex(types.data)
  const providers = types.data.providers.filter((p) => providerIn(p, set))
  const providerKeysHere = new Set(providers.map((p) => p.key))
  const inGroup = (r: HubResource) => set.has(idx.categoryOf(r.type, r.provider))
  const rows = (resources.data ?? []).filter((r) => !r.deleted_at && inGroup(r))
  const accounts = connections.data
    .filter(isFullConnection)
    .filter((c) => providerKeysHere.has(c.provider) || rows.some((r) => r.connection_id === c.id))
  const current = picked === 'new' ? null : (accounts.find((c) => c.id === picked) ?? null)
  const currentProvider = current
    ? (types.data.providers.find((p) => p.key === current.provider) ?? null)
    : null
  const sharedTypes = (provider: string) =>
    (idx.provider(provider)?.types ?? []).filter(
      (t) => t.scope === 'shared' && set.has(t.category ?? idx.categoryOf(t.key, provider))
    )
  const sharedRows = rows.filter((r) => r.scope === 'shared')
  const appRows = rows.filter((r) => r.scope === 'app')

  return (
    <>
      {isAdmin && (
        <SectionCard
          title={home.accounts}
          description={
            accounts.length === 0
              ? `No ${home.noun} connected yet. Connect ${home.examples} and the Hub can plan changes there for your apps.`
              : `${accounts.length} connected. Each app is allowed the accounts its owners may use, on the app’s page.`
          }
          actions={
            <>
              <Link to='/hub/connections' className={ghostButton}>
                All outside accounts
              </Link>
              <button
                type='button'
                aria-pressed={picked === 'new'}
                className={ghostButton}
                disabled={providers.length === 0}
                onClick={() => setPicked(picked === 'new' ? null : 'new')}
              >
                <Plus className='h-3.5 w-3.5' aria-hidden /> {home.connect}
              </button>
            </>
          }
        >
          {(accounts.length > 0 || picked != null) && (
            <div className='space-y-3 p-4'>
              {accounts.length > 0 && (
                <ul className='m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3'>
                  {accounts.map((c) => (
                    <li key={c.id}>
                      <ConnectionCard
                        connection={c}
                        active={c.id === picked}
                        onSelect={() => setPicked(c.id === picked ? null : c.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {picked === 'new' ? (
                <ConnectionForm
                  key='new'
                  connection={null}
                  providers={providers}
                  categories={types.data.categories}
                  onClose={() => setPicked(null)}
                  onSaved={setPicked}
                />
              ) : current ? (
                <>
                  <ConnectionForm
                    key={current.id}
                    connection={current}
                    providers={types.data.providers}
                    onClose={() => setPicked(null)}
                    onSaved={setPicked}
                  />
                  <UnmanagedCard
                    key={`u-${current.id}`}
                    connection={current}
                    provider={
                      currentProvider && {
                        ...currentProvider,
                        types: currentProvider.types.filter((t) =>
                          set.has(t.category ?? currentProvider.category ?? 'other')
                        )
                      }
                    }
                  />
                </>
              ) : null}
            </div>
          )}
        </SectionCard>
      )}

      {isAdmin &&
        accounts
          // An account with nothing shared yet shows its (empty) list only while it is picked,
          // so the page is not a column of empty cards; "Add shared resource" is there then.
          .filter(
            (c) =>
              sharedRows.some((r) => r.connection_id === c.id) ||
              (c.id === picked && sharedTypes(c.provider).length > 0)
          )
          .map((c) => (
            <ConnectionGroup
              key={c.id}
              connection={c}
              rows={sharedRows.filter((r) => r.connection_id === c.id)}
              all={resources.data ?? []}
              types={sharedTypes(c.provider)}
              typeOf={idx.type}
            />
          ))}

      <AppResources
        rows={appRows}
        typeLabel={idx.typeLabel}
        providerLabel={idx.providerLabel}
        pending={resources.isPending}
        idPrefix={idPrefix}
      />
    </>
  )
}

/**
 * What apps hold of this kind, app by app: name, kind, environment, state, drift and cost. A row
 * opens the app on that environment's outside resources, where a change is planned.
 */
function AppResources({
  rows,
  typeLabel,
  providerLabel,
  pending,
  idPrefix
}: {
  rows: HubResource[]
  typeLabel: (k: string) => string
  providerLabel: (k: string) => string
  pending: boolean
  idPrefix: string
}) {
  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps })
  const appIds = [...new Set(rows.map((r) => r.app_id).filter((x): x is number => x != null))]
  const full = useQueries({
    queries: appIds.map((id) => ({ queryKey: hubKeys.app(id), queryFn: () => fetchHubApp(id) }))
  })
  const envKey = (envId: number | null) => {
    for (const q of full) {
      const e = q.data?.environments.find((x) => x.id === envId)
      if (e) return e.key
    }
    return null
  }
  const byApp = appIds
    .map((id) => ({
      id,
      name: apps.data?.find((a) => a.id === id)?.name ?? `App ${id}`,
      rows: rows
        .filter((r) => r.app_id === id)
        .sort((a, b) => resourceName(a).localeCompare(resourceName(b)))
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  if (pending) return <Skeleton className='h-20 w-full' />
  return (
    <SectionCard
      title='In your apps'
      description={
        rows.length === 0
          ? `No app holds anything here yet. Add one from an app’s environment, under Outside resources.`
          : `${rows.length} managed by the Hub across ${byApp.length} ${byApp.length === 1 ? 'app' : 'apps'}. Open one to plan a change on its app.`
      }
    >
      {byApp.length > 0 && (
        <div className='divide-y divide-slate-100 dark:divide-border'>
          {byApp.map((a) => (
            <section key={a.id} aria-labelledby={`${idPrefix}-app-${a.id}`} className='px-4 py-3'>
              <h4
                id={`${idPrefix}-app-${a.id}`}
                className='m-0 mb-1 text-[12px] font-semibold text-slate-800 dark:text-foreground'
              >
                <Link to={`/hub?app=${a.id}`} className='hover:underline'>
                  {a.name}
                </Link>
              </h4>
              <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
                {a.rows.map((r) => {
                  const state = resourceState(r)
                  const copy = RESOURCE_STATE_COPY[state]
                  const env = envKey(r.environment_id)
                  return (
                    <li key={r.id} className='flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5'>
                      <p className='m-0 flex min-w-0 flex-[1_1_240px] items-baseline gap-1.5'>
                        <span className='truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                          {resourceName(r)}
                        </span>
                        <span className='shrink-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {typeLabel(r.type)} · {providerLabel(r.provider)}
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
                        <ResourceCostChip resourceId={r.id} appId={r.app_id} />
                        <Link
                          to={`/hub?app=${a.id}${r.environment_id ? `&resources=${r.environment_id}` : ''}`}
                          className={ghostButton}
                          aria-label={`Open ${resourceName(r)} on ${a.name}`}
                        >
                          Open <ArrowRight className='h-3.5 w-3.5' aria-hidden />
                        </Link>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </SectionCard>
  )
}
