import { ConfirmButton, ErrorNotice } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, ExternalLink, KeyRound, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ProductionGuard } from '@/components/hub-brand/HubBits'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { ResourceCostChip } from '../costs/RowCosts'
import type { HubAppFull, HubEnvironment } from '../hub-api'
import { dangerArmed, dangerGhost, ghostButton, SectionCard, ToneChip } from '../hub-parts'
import { ChangesList, ChangeView } from './ChangeView'
import { OutputsCard } from './OutputsCard'
import {
  type ChangeModel,
  changeAction,
  changeFromPlan,
  discardCreate,
  fetchAppConnections,
  fetchConnections,
  fetchProviderTypes,
  fetchResources,
  groupByCategory,
  type HubResource,
  healthTone,
  type PlanAction,
  planChange,
  providerError,
  providerKeys,
  providerToast,
  RESOURCE_STATE_COPY,
  type ResourceTypeInfo,
  resourceName,
  resourceState,
  saveAppConnections,
  statusWords,
  typeIndex
} from './providers-api'
import { ResourceForm } from './ResourceForm'

/**
 * Resources (one per environment row of an app): what this environment owns outside Nivaro —
 * a GitHub repository, an S3 bucket, a Vercel project — grouped by what it is for (the Hub's
 * homes: Code and deploys, Databases, Domains…), each with whether
 * the provider still has it as the Hub set it (drift) and the provider's own state (health).
 * Owners act through the connections an administrator allowed for their app; nothing changes
 * at the provider without a plan they read and start in the change view.
 */
export function ResourcesPanel({
  app,
  env,
  isAdmin,
  canDeploy,
  layout,
  idPrefix = ''
}: {
  app: HubAppFull
  env: HubEnvironment
  isAdmin: boolean
  /** Plan and start changes here (admins; owners where they may deploy this environment). */
  canDeploy: boolean
  /** 'row' = a full-width table row (desktop table); 'card' = under the phone entry. */
  layout: 'row' | 'card'
  idPrefix?: string
}) {
  // One read per app (every environment row shares it), filtered here per environment.
  const filter = { app: app.id }
  const resources = useQuery({
    queryKey: providerKeys.resources(filter),
    queryFn: () => fetchResources(filter),
    retry: false
  })
  const allowed = useQuery({
    queryKey: providerKeys.appConnections(app.id),
    queryFn: () => fetchAppConnections(app.id),
    retry: false
  })
  // `?resources=<environment id>` opens this environment's panel and brings it into view: the
  // link every Hub home and the app's own summary use to get to where a change is planned.
  const [params] = useSearchParams()
  const wanted = params.get('resources') === String(env.id)
  const [open, setOpen] = useState(wanted)
  const boxRef = useRef<HTMLDivElement>(null)
  const ready = !resources.isPending && !allowed.isPending
  useEffect(() => {
    if (!wanted || !ready) return
    setOpen(true)
    const box = boxRef.current
    // Only the copy this screen size shows (the table row, or the phone card).
    if (box && box.offsetParent !== null) box.scrollIntoView?.({ block: 'nearest' })
  }, [wanted, ready])

  if (resources.isPending || allowed.isPending) return null
  const rows = (resources.data ?? []).filter((r) => r.environment_id === env.id && !r.deleted_at)
  const connections = allowed.data?.connections ?? []
  // Nothing managed and nothing this person could add: no panel (the env table stays calm).
  // A read that failed (a Hub without provider routes, the Hub busy) shows no panel either: the
  // environment row is not the place to report it, and the next live refresh tries again.
  if (resources.isError && !resources.data) return null
  if (rows.length === 0 && (!canDeploy || connections.length === 0)) return null

  const drifted = rows.filter((r) => resourceState(r) === 'drift').length
  const gone = rows.filter((r) => resourceState(r) === 'gone').length
  const panelId = `hub-res-${env.id}${idPrefix}`
  const body = (
    <div
      ref={boxRef}
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <button
        type='button'
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className='flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-90'
          )}
          aria-hidden
        />
        <span className='text-[12px] font-semibold text-slate-800 dark:text-foreground'>
          Outside resources
        </span>
        <span className='text-[12px] tabular-nums text-slate-500 dark:text-muted-foreground'>
          {rows.length === 0 ? 'none yet' : rows.length}
        </span>
        {drifted > 0 && (
          <ToneChip tone='warn' compact>
            {drifted} drifted
          </ToneChip>
        )}
        {gone > 0 && (
          <ToneChip tone='down' compact>
            {gone} gone
          </ToneChip>
        )}
      </button>
      {open && (
        <div id={panelId} className='space-y-3 border-t border-slate-200 p-3 dark:border-border'>
          {resources.isError ? (
            <ErrorNotice
              description={providerError(resources.error, 'Could not read the resources')}
              onRetry={() => void resources.refetch()}
            />
          ) : (
            <PanelBody
              app={app}
              env={env}
              rows={rows}
              connections={connections}
              isAdmin={isAdmin}
              canDeploy={canDeploy}
              idPrefix={panelId}
            />
          )}
        </div>
      )}
    </div>
  )
  return layout === 'row' ? (
    <tr className='border-b border-slate-100 last:border-0 dark:border-border'>
      <td colSpan={6} className='px-4 pb-3'>
        {body}
      </td>
    </tr>
  ) : (
    <div className='mt-2'>{body}</div>
  )
}

export type RowAction =
  | { kind: 'edit'; resource: HubResource }
  | {
      kind: 'plan'
      resource: HubResource
      action: PlanAction
      /** An update planned at once (an outputs rotation). */
      fields?: Record<string, unknown>
    }
  | { kind: 'outputs'; resource: HubResource }
  | { kind: 'add' }
  | null

function PanelBody({
  app,
  env,
  rows,
  connections,
  isAdmin,
  canDeploy,
  idPrefix
}: {
  app: HubAppFull
  env: HubEnvironment
  rows: HubResource[]
  connections: Array<{ id: number; name: string; provider: string; provider_label: string }>
  isAdmin: boolean
  canDeploy: boolean
  idPrefix: string
}) {
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const idx = typeIndex(types.data)
  const [action, setAction] = useState<RowAction>(null)
  const [showChanges, setShowChanges] = useState(false)
  const groups = groupByCategory(rows, types.data)
  const guard = (child: ReactNode) => (
    <ProductionGuard envKey={env.key} what='change'>
      {child}
    </ProductionGuard>
  )
  const close = () => setAction(null)
  const isOpen = (r: HubResource) =>
    action != null && action.kind !== 'add' && action.resource.id === r.id

  return (
    <>
      {groups.length === 0 ? (
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          This environment owns nothing outside Nivaro yet.
          {canDeploy ? ' Add a resource, or adopt one an administrator finds on a connection.' : ''}
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.key} aria-label={g.label} className='space-y-1'>
            <h6 className='m-0 text-[11px] font-semibold text-slate-600 dark:text-muted-foreground'>
              {g.label}
              <span className='ml-1.5 font-normal tabular-nums'>{g.rows.length}</span>
            </h6>
            <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
              {g.rows.map((r) => (
                <li key={r.id} className='py-1.5'>
                  <ResourceRow
                    resource={r}
                    type={idx.type(r.type)}
                    canDeploy={canDeploy}
                    active={isOpen(r) ? action : null}
                    onAction={(a) => setAction(isOpen(r) && sameAction(action, a) ? null : a)}
                    showOutputs
                    providerLabel={idx.providerLabel(r.provider)}
                  />
                  {isOpen(r) && action?.kind === 'edit' && idx.type(r.type) && (
                    <div className='mt-2'>
                      <ResourceForm
                        type={idx.type(r.type) as ResourceTypeInfo}
                        resource={r}
                        connectionId={r.connection_id}
                        scope='app'
                        appId={app.id}
                        environmentId={env.id}
                        idPrefix={`${idPrefix}-edit-${r.id}`}
                        isAdmin={isAdmin}
                        onClose={close}
                        confirmFrame={guard}
                      />
                    </div>
                  )}
                  {isOpen(r) && action?.kind === 'plan' && (
                    <div className='mt-2'>
                      {guard(
                        <PlanNow
                          key={`${action.action}${action.fields ? '+' : ''}`}
                          resource={r}
                          action={action.action}
                          fields={action.fields}
                          appId={app.id}
                          environmentId={env.id}
                          isAdmin={isAdmin}
                          onClose={close}
                        />
                      )}
                    </div>
                  )}
                  {isOpen(r) && action?.kind === 'outputs' && idx.type(r.type) && (
                    <div className='mt-2'>
                      <OutputsCard
                        resource={r}
                        type={idx.type(r.type) as ResourceTypeInfo}
                        environments={app.environments}
                        canDeploy={canDeploy}
                        idPrefix={`${idPrefix}-out-${r.id}`}
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
              ))}
            </ul>
          </section>
        ))
      )}

      {action?.kind === 'add' && (
        <AddResource
          app={app}
          env={env}
          connections={connections}
          isAdmin={isAdmin}
          idPrefix={`${idPrefix}-add`}
          onClose={close}
          frame={guard}
        />
      )}

      <div className='flex flex-wrap items-center gap-1'>
        {canDeploy && connections.length > 0 && action?.kind !== 'add' && (
          <button type='button' className={ghostButton} onClick={() => setAction({ kind: 'add' })}>
            <Plus className='h-3.5 w-3.5' aria-hidden /> Add resource
          </button>
        )}
        <button
          type='button'
          className={ghostButton}
          aria-expanded={showChanges}
          onClick={() => setShowChanges((s) => !s)}
        >
          {showChanges ? 'Hide recent changes' : 'Recent changes'}
        </button>
      </div>
      {showChanges && (
        <ChangesList
          filter={{ app: app.id, environment: env.id, limit: 10 }}
          isAdmin={isAdmin}
          label={`Recent changes on ${env.key}`}
          empty='No changes on this environment yet.'
        />
      )}
    </>
  )
}

export const sameAction = (a: RowAction, b: RowAction) =>
  !!a &&
  !!b &&
  a.kind === b.kind &&
  (a.kind !== 'plan' || (b.kind === 'plan' && a.action === b.action && !!a.fields === !!b.fields))

/** One resource: name, type, state, provider status, and what may be done. */
export function ResourceRow({
  resource: r,
  type,
  canDeploy,
  active,
  onAction,
  extra,
  deleteBlocked,
  showOutputs,
  providerLabel
}: {
  resource: HubResource
  type: ResourceTypeInfo | null
  canDeploy: boolean
  active: RowAction
  onAction: (a: RowAction) => void
  /** More facts after the chips (Shared infra: "used by 3"). */
  extra?: ReactNode
  /** Why a delete cannot be planned now (a shared resource still in use), or undefined. */
  deleteBlocked?: string
  /** Offer the Outputs button when the type hands out values (Task 13). */
  showOutputs?: boolean
  /** Named after the kind where the list is not grouped by provider ("Bucket · AWS"). */
  providerLabel?: string
}) {
  const state = resourceState(r)
  const copy = RESOURCE_STATE_COPY[state]
  const status = r.observed?.status ?? null
  const name = resourceName(r)
  const pending = r.pending_create ?? null
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['hub-providers', 'resources'] })
    void qc.invalidateQueries({ queryKey: ['hub-providers', 'changes'] })
    if (pending?.change_id != null)
      void qc.invalidateQueries({ queryKey: providerKeys.change(pending.change_id) })
  }
  const resume = useMutation({
    mutationFn: () => changeAction(pending?.change_id as number, 'resume'),
    onSuccess: refresh,
    onError: (e) => {
      providerToast(e, 'Could not resume the create')
      refresh()
    }
  })
  const discard = useMutation({
    mutationFn: () => discardCreate(r.id),
    onSuccess: refresh,
    onError: (e) => {
      providerToast(e, 'Could not discard it')
      refresh()
    }
  })
  const busy = resume.isPending || discard.isPending
  const pressed = (a: RowAction) => sameAction(active, a)
  const edit: RowAction = { kind: 'edit', resource: r }
  const del: RowAction = { kind: 'plan', resource: r, action: 'delete' }
  const reapply: RowAction = { kind: 'plan', resource: r, action: 'reapply' }
  const accept: RowAction = { kind: 'plan', resource: r, action: 'accept' }
  const outputs: RowAction = { kind: 'outputs', resource: r }
  const hasOutputs = showOutputs && !pending && (type?.outputs?.length ?? 0) > 0
  return (
    <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
      <div className='min-w-0 flex-[1_1_220px]'>
        <p className='m-0 flex min-w-0 items-baseline gap-1.5'>
          <span className='truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
            {name}
          </span>
          <span className='shrink-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
            {type?.label ?? r.type}
            {providerLabel ? ` · ${providerLabel}` : ''}
          </span>
        </p>
        {r.external_id && r.external_id !== name && (
          <p className='m-0 truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
            {r.external_id}
          </p>
        )}
      </div>
      <div className='flex flex-wrap items-center gap-1'>
        <ToneChip
          tone={copy.tone}
          compact
          tip={
            pending
              ? state === 'create_failed' && !pending.resumable
                ? 'The provider never made it, and a retry will not fix what stopped it. Fix the cause, discard this entry, then add it again.'
                : copy.tip
              : r.observed_at
                ? `${copy.tip} Checked ${formatRelative(r.observed_at)} (${formatDateTime(r.observed_at)}).`
                : copy.tip
          }
        >
          {copy.label}
        </ToneChip>
        {status && state !== 'gone' && (
          <ToneChip tone={healthTone(status)} compact tip='What the provider says about it'>
            {statusWords(status)}
          </ToneChip>
        )}
        {r.adopted && (
          <ToneChip tone='neutral' compact tip='Made outside the Hub, then adopted'>
            Adopted
          </ToneChip>
        )}
        {!pending && r.external_id && (
          <ResourceCostChip resourceId={r.id} appId={r.scope === 'app' ? r.app_id : null} />
        )}
        {!pending && extra}
      </div>
      <div className='ml-auto flex flex-wrap items-center gap-0'>
        {canDeploy && state === 'create_failed' && pending && (
          <>
            {pending.resumable && pending.change_id != null && (
              <button
                type='button'
                className={ghostButton}
                disabled={busy}
                data-tip='Run the create again'
                onClick={() => resume.mutate()}
              >
                <RotateCcw className='h-3.5 w-3.5' aria-hidden />{' '}
                {resume.isPending ? 'Resuming…' : 'Resume'}
              </button>
            )}
            <ConfirmButton
              title={`Discard ${name} (nothing exists at the provider)`}
              confirmLabel={`Discard ${name}?`}
              className={dangerGhost}
              armedClassName={dangerArmed}
              disabled={busy}
              onConfirm={() => discard.mutate()}
            >
              <Trash2 className='h-3.5 w-3.5' aria-hidden /> Discard
            </ConfirmButton>
          </>
        )}
        {r.observed?.url && (
          <a
            href={r.observed.url}
            target='_blank'
            rel='noreferrer'
            aria-label={`Open ${name} at the provider`}
            data-tip='Open at the provider'
            className={cn(ghostButton, 'w-8 px-0')}
          >
            <ExternalLink className='h-3.5 w-3.5' aria-hidden />
          </a>
        )}
        {canDeploy && !pending && state === 'drift' && (
          <>
            <button
              type='button'
              aria-pressed={pressed(reapply)}
              data-tip='Plan it back to how the Hub set it'
              className={cn(ghostButton, pressed(reapply) && 'bg-accent')}
              onClick={() => onAction(reapply)}
            >
              <RotateCcw className='h-3.5 w-3.5' aria-hidden /> Re-apply
            </button>
            <button
              type='button'
              aria-pressed={pressed(accept)}
              data-tip='Keep what the provider has now'
              className={cn(ghostButton, pressed(accept) && 'bg-accent')}
              onClick={() => onAction(accept)}
            >
              Accept
            </button>
          </>
        )}
        {hasOutputs && (
          <button
            type='button'
            aria-label={`Outputs of ${name}`}
            aria-pressed={pressed(outputs)}
            data-tip='What it hands out, and where it goes'
            className={cn(ghostButton, 'w-8 px-0', pressed(outputs) && 'bg-accent')}
            onClick={() => onAction(outputs)}
          >
            <KeyRound className='h-3.5 w-3.5' aria-hidden />
          </button>
        )}
        {canDeploy && !pending && type?.capabilities.update && state !== 'gone' && (
          <button
            type='button'
            aria-label={`Change ${name}`}
            aria-pressed={pressed(edit)}
            data-tip='Change'
            className={cn(ghostButton, 'w-8 px-0', pressed(edit) && 'bg-accent')}
            onClick={() => onAction(edit)}
          >
            <Pencil className='h-3.5 w-3.5' aria-hidden />
          </button>
        )}
        {canDeploy && !pending && type?.capabilities.delete && (
          <button
            type='button'
            aria-label={`Delete ${name}`}
            aria-pressed={pressed(del)}
            aria-disabled={deleteBlocked ? true : undefined}
            data-tip={deleteBlocked ?? 'Plan a delete'}
            className={cn(
              dangerGhost,
              'w-8 px-0',
              pressed(del) && 'bg-red-50 dark:bg-red-950/40',
              deleteBlocked && 'cursor-not-allowed opacity-50'
            )}
            onClick={() => {
              if (!deleteBlocked) onAction(del)
            }}
          >
            <Trash2 className='h-3.5 w-3.5' aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}

/** Plans one action on a resource as soon as it opens (delete, re-apply, accept), then the view. */
export function PlanNow({
  resource,
  action,
  appId,
  environmentId,
  isAdmin,
  onClose,
  fields
}: {
  resource: HubResource
  action: PlanAction
  appId?: number
  environmentId?: number
  isAdmin: boolean
  onClose: () => void
  /** Fields of an update planned at once (an outputs rotation). */
  fields?: Record<string, unknown>
}) {
  const [change, setChange] = useState<ChangeModel | null>(null)
  const plan = useMutation({
    mutationFn: () =>
      planChange({
        connectionId: resource.connection_id,
        scope: resource.scope,
        ...(resource.scope === 'app' && appId != null ? { appId } : {}),
        ...(resource.scope === 'app' && environmentId != null ? { environmentId } : {}),
        ops: [{ action, resourceId: resource.id, ...(fields ? { fields } : {}) }]
      }),
    onSuccess: (p) => setChange(changeFromPlan(p))
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: plan once when opened
  useEffect(() => {
    plan.mutate()
  }, [])
  if (change)
    return <ChangeView initial={change} isAdmin={isAdmin} onClose={onClose} onReplace={setChange} />
  if (plan.isError)
    return (
      <ErrorNotice
        description={providerError(plan.error, 'Could not plan the change')}
        onRetry={() => plan.mutate()}
      />
    )
  return (
    <div role='status' className='space-y-1.5'>
      <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
        Reading the provider to plan it…
      </p>
      <Skeleton className='h-12 w-full' />
    </div>
  )
}

function AddResource({
  app,
  env,
  connections,
  isAdmin,
  idPrefix,
  onClose,
  frame
}: {
  app: HubAppFull
  env: HubEnvironment
  connections: Array<{ id: number; name: string; provider: string; provider_label: string }>
  isAdmin: boolean
  idPrefix: string
  onClose: () => void
  frame: (child: ReactNode) => ReactNode
}) {
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const idx = typeIndex(types.data)
  const [connectionId, setConnectionId] = useState(
    connections.length === 1 ? String(connections[0]?.id) : ''
  )
  const conn = connections.find((c) => String(c.id) === connectionId) ?? null
  const creatable = (conn ? (idx.provider(conn.provider)?.types ?? []) : []).filter(
    (t) => t.scope === 'app' && t.capabilities.create
  )
  const [typeKey, setTypeKey] = useState('')
  const type = creatable.find((t) => t.key === typeKey) ?? null
  return (
    <div className='space-y-3 rounded-lg border border-dashed border-slate-300 p-3 dark:border-border'>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
        <div className='space-y-1.5'>
          <label
            htmlFor={`${idPrefix}-conn`}
            className='block text-[12px] font-medium text-slate-700 dark:text-foreground'
          >
            Connection
          </label>
          <SimpleSelect
            value={connectionId}
            onChange={(v) => {
              setConnectionId(v)
              setTypeKey('')
            }}
            options={[
              { value: '', label: 'Pick a connection' },
              ...connections.map((c) => ({
                value: String(c.id),
                label: `${c.name} · ${c.provider_label}`
              }))
            ]}
            ariaLabel='Connection'
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: `${idPrefix}-conn` }}
          />
        </div>
        <div className='space-y-1.5'>
          <label
            htmlFor={`${idPrefix}-type`}
            className='block text-[12px] font-medium text-slate-700 dark:text-foreground'
          >
            What to create
          </label>
          <SimpleSelect
            value={typeKey}
            onChange={setTypeKey}
            options={[
              {
                value: '',
                label: !conn
                  ? 'Pick a connection first'
                  : creatable.length
                    ? 'Pick a kind'
                    : 'This provider creates nothing per app'
              },
              ...creatable.map((t) => ({ value: t.key, label: t.label }))
            ]}
            ariaLabel='What to create'
            disabled={!conn || creatable.length === 0}
            className='h-8 bg-white text-left text-[13px] dark:bg-background'
            triggerProps={{ id: `${idPrefix}-type` }}
          />
        </div>
      </div>
      {type && conn ? (
        <ResourceForm
          key={`${conn.id}-${type.key}`}
          type={type}
          resource={null}
          connectionId={conn.id}
          scope='app'
          appId={app.id}
          environmentId={env.id}
          idPrefix={idPrefix}
          isAdmin={isAdmin}
          onClose={onClose}
          onDone={onClose}
          confirmFrame={frame}
        />
      ) : (
        <Button size='sm' variant='ghost' className='h-8' onClick={onClose}>
          Cancel
        </Button>
      )}
    </div>
  )
}

/**
 * The connections this app's owners may use (administrators: any). Admin-set, on the app page,
 * so who may change what outside Nivaro is decided where the app is.
 */
export function AppConnectionsCard({ appId }: { appId: number }) {
  const qc = useQueryClient()
  const all = useQuery({ queryKey: providerKeys.connections(), queryFn: fetchConnections })
  const allowed = useQuery({
    queryKey: providerKeys.appConnections(appId),
    queryFn: () => fetchAppConnections(appId)
  })
  const [picked, setPicked] = useState<Set<number> | null>(null)
  const stored = new Set(allowed.data?.connection_ids ?? [])
  const current = picked ?? stored
  const dirty =
    picked != null && (picked.size !== stored.size || [...picked].some((id) => !stored.has(id)))
  const save = useMutation({
    mutationFn: () =>
      saveAppConnections(
        appId,
        [...current].sort((a, b) => a - b)
      ),
    onSuccess: () => {
      setPicked(null)
      void qc.invalidateQueries({ queryKey: providerKeys.appConnections(appId) })
    },
    onError: (e) => providerToast(e, 'Could not save the allowed connections')
  })
  // No connection on this Hub yet: nothing to allow (the Connections tab is where they start).
  if (all.data && all.data.length === 0) return null
  const toggle = (id: number, on: boolean) => {
    const next = new Set(current)
    if (on) next.add(id)
    else next.delete(id)
    setPicked(next)
  }

  return (
    <SectionCard
      title='Outside services'
      description='The connections this app’s owners may use to manage its resources. Administrators can use any.'
      actions={
        dirty ? (
          <>
            <Button
              size='sm'
              className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button size='sm' variant='ghost' className='h-8' onClick={() => setPicked(null)}>
              Discard
            </Button>
          </>
        ) : undefined
      }
    >
      <div className='px-4 py-3'>
        {all.isPending || allowed.isPending ? (
          <Skeleton className='h-8 w-full' />
        ) : all.isError || allowed.isError ? (
          <ErrorNotice
            description={providerError(
              all.error ?? allowed.error,
              'Could not read the connections'
            )}
            onRetry={() => {
              void all.refetch()
              void allowed.refetch()
            }}
          />
        ) : (
          <ul className='m-0 grid list-none grid-cols-1 gap-x-4 gap-y-2 p-0 sm:grid-cols-2'>
            {all.data.map((c) => {
              const id = `hub-app-${appId}-conn-${c.id}`
              return (
                <li key={c.id} className='flex items-start gap-2'>
                  <Checkbox
                    id={id}
                    checked={current.has(c.id)}
                    disabled={save.isPending}
                    onCheckedChange={(v) => toggle(c.id, v === true)}
                    className='mt-0.5'
                  />
                  <label htmlFor={id} className='min-w-0 text-[12px]'>
                    <span className='font-medium text-slate-800 dark:text-foreground'>
                      {c.name}
                    </span>{' '}
                    <span className='text-slate-500 dark:text-muted-foreground'>
                      {c.provider_label}
                    </span>
                    {c.description && (
                      <span className='block truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
                        {c.description}
                      </span>
                    )}
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </SectionCard>
  )
}
