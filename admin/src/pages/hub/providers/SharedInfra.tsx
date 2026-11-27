import { QueryErrorState } from '@nivaro/shared'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { fetchHubApp, fetchHubApps, hubKeys } from '../hub-api'
import { ghostButton, SectionCard, ToneChip } from '../hub-parts'
import { LinkedChange, OpenChanges } from './ChangeView'
import { OutputsCard } from './OutputsCard'
import {
  fetchConnections,
  fetchProviderTypes,
  fetchResources,
  type HubConnection,
  type HubResource,
  isFullConnection,
  providerKeys,
  type ResourceTypeInfo,
  resourceName,
  typeIndex,
  usedBy
} from './providers-api'
import { ResourceForm } from './ResourceForm'
import { PlanNow, ResourceRow, type RowAction, sameAction } from './ResourcesPanel'

/**
 * Shared infrastructure (Hub tab, administrators): what belongs to a connection rather than to one
 * app — a VPC and its subnets, a Route 53 hosted zone, an organisation setting. Each shows which
 * app resources use it; deleting one that is still used is refused (SHARED_IN_USE, never
 * overridable), and the "used by" count says so before anyone plans it.
 */
export default function SharedInfraTab() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  if (!isAdmin)
    return (
      <div className='flex flex-1 flex-col items-center justify-center gap-4 bg-slate-50 p-8 text-center dark:bg-background'>
        <p className='m-0 max-w-[48ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
          Shared infrastructure is managed by Hub administrators.
        </p>
        <div className='w-full max-w-3xl text-left'>
          <LinkedChange isAdmin={false} />
        </div>
      </div>
    )
  return <SharedInfra />
}

const SHARED = { scope: 'shared' as const }
const ALL = {}

export function SharedInfra() {
  const connections = useQuery({ queryKey: providerKeys.connections(), queryFn: fetchConnections })
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const shared = useQuery({
    queryKey: providerKeys.resources(SHARED),
    queryFn: () => fetchResources(SHARED)
  })
  // Every managed resource: what points at each shared one.
  const all = useQuery({
    queryKey: providerKeys.resources(ALL),
    queryFn: () => fetchResources(ALL)
  })
  const idx = typeIndex(types.data)
  const full = (connections.data ?? []).filter(isFullConnection)
  // Connections whose provider has shared types, plus any that already hold shared resources.
  const holding = new Set((shared.data ?? []).map((r) => r.connection_id))
  const relevant = full.filter(
    (c) =>
      holding.has(c.id) || (idx.provider(c.provider)?.types ?? []).some((t) => t.scope === 'shared')
  )
  const pending = connections.isPending || shared.isPending || types.isPending
  const error = connections.error ?? shared.error ?? types.error

  return (
    <section aria-label='Shared infrastructure' className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description={
          <>
            Networks, zones and settings that belong to a connection, not to one app. App resources
            point at them; one in use cannot be deleted.
            {shared.data && (
              <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
                {' '}
                {shared.data.length} shared {shared.data.length === 1 ? 'resource' : 'resources'}.
              </span>
            )}
          </>
        }
      />
      <div className='relative min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='space-y-4 p-4 sm:p-6'>
          <LinkedChange isAdmin />
          <OpenChanges
            filter={SHARED}
            description='Shared changes not finished yet: plans nobody started, failed or stopped runs. Open one to start, resume or close it.'
            connectionName={(id) => full.find((c) => c.id === id)?.name ?? null}
          />
          {pending ? (
            <div className='space-y-3'>
              <Skeleton className='h-24 w-full' />
              <Skeleton className='h-24 w-full' />
            </div>
          ) : error ? (
            <QueryErrorState
              error={error}
              what='the shared infrastructure'
              onRetry={() => {
                void connections.refetch()
                void shared.refetch()
                void types.refetch()
              }}
            />
          ) : relevant.length === 0 ? (
            <div className='rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center dark:border-border'>
              <p className='m-0 text-[13px] font-medium text-slate-700 dark:text-foreground'>
                No shared infrastructure
              </p>
              <p className='m-0 mx-auto mt-1 max-w-[56ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
                Shared resources come with a connection whose provider has them (an AWS account’s
                networks, a hosted zone).{' '}
                <Link to='/hub/connections' className='text-nvr-navy underline dark:text-nvr-cyan'>
                  Add a connection
                </Link>{' '}
                first, or adopt what an account already has from its page.
              </p>
            </div>
          ) : (
            relevant.map((c) => (
              <ConnectionGroup
                key={c.id}
                connection={c}
                rows={(shared.data ?? []).filter((r) => r.connection_id === c.id)}
                all={all.data ?? []}
                types={(idx.provider(c.provider)?.types ?? []).filter((t) => t.scope === 'shared')}
                typeOf={idx.type}
              />
            ))
          )}
        </div>
      </div>
    </section>
  )
}

function ConnectionGroup({
  connection,
  rows,
  all,
  types,
  typeOf
}: {
  connection: HubConnection
  rows: HubResource[]
  all: HubResource[]
  types: ResourceTypeInfo[]
  typeOf: (key: string) => ResourceTypeInfo | null
}) {
  const [action, setAction] = useState<RowAction>(null)
  const creatable = types.filter((t) => t.capabilities.create)
  const [typeKey, setTypeKey] = useState(creatable.length === 1 ? (creatable[0]?.key ?? '') : '')
  const addType = creatable.find((t) => t.key === typeKey) ?? null
  const close = () => setAction(null)
  const forRow = (r: HubResource) =>
    action && action.kind !== 'add' && action.resource.id === r.id ? action : null
  const sorted = [...rows].sort(
    (a, b) => a.type.localeCompare(b.type) || resourceName(a).localeCompare(resourceName(b))
  )
  return (
    <SectionCard
      title={connection.name}
      description={[connection.provider_label, connection.description].filter(Boolean).join(' · ')}
      actions={
        creatable.length > 0 && action?.kind !== 'add' ? (
          <button type='button' className={ghostButton} onClick={() => setAction({ kind: 'add' })}>
            <Plus className='h-3.5 w-3.5' aria-hidden /> Add shared resource
          </button>
        ) : undefined
      }
    >
      <div className='space-y-3 px-4 py-3'>
        {sorted.length === 0 ? (
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            The Hub manages no shared resources on this connection yet.
          </p>
        ) : (
          <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
            {sorted.map((r) => {
              const users = usedBy(r.id, all)
              const a = forRow(r)
              const type = typeOf(r.type)
              return (
                <li key={r.id} className='py-1.5'>
                  <ResourceRow
                    resource={r}
                    type={type}
                    canDeploy
                    active={a}
                    onAction={(next) => setAction(sameAction(a, next) ? null : next)}
                    showOutputs
                    deleteBlocked={
                      users.length
                        ? `Used by ${users.length}: remove what points at it first`
                        : undefined
                    }
                    extra={
                      <ToneChip
                        tone='neutral'
                        compact
                        tip={
                          users.length
                            ? `Used by ${users
                                .slice(0, 5)
                                .map(resourceName)
                                .join(
                                  ', '
                                )}${users.length > 5 ? '…' : ''}. It cannot be deleted while they point at it.`
                            : 'No app resource points at it.'
                        }
                      >
                        {users.length ? `Used by ${users.length}` : 'Not used'}
                      </ToneChip>
                    }
                  />
                  {a?.kind === 'edit' && type && (
                    <div className='mt-2'>
                      <ResourceForm
                        type={type}
                        resource={r}
                        connectionId={connection.id}
                        scope='shared'
                        idPrefix={`hub-shared-edit-${r.id}`}
                        isAdmin
                        onClose={close}
                      />
                    </div>
                  )}
                  {a?.kind === 'plan' && (
                    <div className='mt-2'>
                      <PlanNow
                        key={`${a.action}${a.fields ? '+' : ''}`}
                        resource={r}
                        action={a.action}
                        fields={a.fields}
                        isAdmin
                        onClose={close}
                      />
                    </div>
                  )}
                  {a?.kind === 'outputs' && type && (
                    <div className='mt-2'>
                      <SharedOutputs
                        resource={r}
                        type={type}
                        onRotate={() =>
                          setAction({
                            kind: 'plan',
                            resource: r,
                            action: 'update',
                            fields: { rotate_outputs: true }
                          })
                        }
                        onClose={close}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {action?.kind === 'add' && (
          <div className='space-y-3 rounded-lg border border-dashed border-slate-300 p-3 dark:border-border'>
            <div className='max-w-[320px] space-y-1.5'>
              <label
                htmlFor={`hub-shared-${connection.id}-type`}
                className='block text-[12px] font-medium text-slate-700 dark:text-foreground'
              >
                What to create
              </label>
              <SimpleSelect
                value={typeKey}
                onChange={setTypeKey}
                options={[
                  { value: '', label: 'Pick a kind' },
                  ...creatable.map((t) => ({ value: t.key, label: t.label }))
                ]}
                ariaLabel='What to create'
                className='h-8 bg-white text-left text-[13px] dark:bg-background'
                triggerProps={{ id: `hub-shared-${connection.id}-type` }}
              />
            </div>
            {addType ? (
              <ResourceForm
                key={addType.key}
                type={addType}
                resource={null}
                connectionId={connection.id}
                scope='shared'
                idPrefix={`hub-shared-add-${connection.id}`}
                isAdmin
                onClose={close}
                onDone={close}
              />
            ) : (
              <Button size='sm' variant='ghost' className='h-8' onClick={close}>
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  )
}

/**
 * The outputs card of a shared resource (Task 33b): the same card an app resource opens, fed by
 * every app's environments — a shared resource may feed any of them (administrators only) — each
 * named "<app> · <environment>" so a binding says which app it writes to.
 */
function SharedOutputs({
  resource,
  type,
  onRotate,
  onClose
}: {
  resource: HubResource
  type: ResourceTypeInfo
  onRotate: () => void
  onClose: () => void
}) {
  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps })
  const details = useQueries({
    queries: (apps.data ?? []).map((a) => ({
      queryKey: hubKeys.app(a.id),
      queryFn: () => fetchHubApp(a.id)
    }))
  })
  const environments = details.flatMap((d) =>
    d.data
      ? [...d.data.environments]
          .sort((x, y) => x.position - y.position || x.id - y.id)
          .map((e) => ({ id: e.id, key: `${d.data.name || d.data.key} · ${e.key}` }))
      : []
  )
  if (apps.isPending || details.some((d) => d.isPending))
    return <Skeleton className='h-24 w-full' />
  return (
    <OutputsCard
      resource={resource}
      type={type}
      environments={environments}
      canDeploy
      idPrefix={`hub-shared-out-${resource.id}`}
      onRotate={onRotate}
      onClose={onClose}
    />
  )
}
