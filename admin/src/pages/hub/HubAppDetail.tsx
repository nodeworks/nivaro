import { ConfirmButton, ErrorNotice, QueryErrorState, useOverflowTip } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRightLeft,
  ExternalLink,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Trash2,
  X
} from 'lucide-react'
import { Fragment, useId, useState } from 'react'
import { envTone } from '@/components/hub-brand/env-tone'
import { HubEnvTag, ProductionGuard } from '@/components/hub-brand/HubBits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { UserCombobox } from '@/components/user-combobox'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { AppOutsideResources, AppShortcuts } from './AppAtAGlance'
import { EnvironmentCostChip } from './costs/RowCosts'
import { HubCreationPanel } from './create/HubCreationPanel'
import { HubStackPanel } from './docker/HubStackPanel'
import {
  createEnvironment,
  type EnvDraft,
  EnvDraftFields,
  emptyEnvDraft,
  envDraftErrors,
  useDriverOptions
} from './HubAdoptForm'
import { HubComponentsEditor } from './HubComponentsEditor'
import { HubPromotePanel, PromotionsCard } from './HubPromotePanel'
import {
  fetchDeploys,
  fetchEnvStatus,
  HUB_MASK,
  type HubAppFull,
  type HubEnvironment,
  hubDeleteToast,
  hubError,
  hubKeys,
  hubToast,
  isBaseUrl,
  SHARED_PLACEMENT_TIP,
  STATUS_COPY,
  statusHint,
  useEnvStatus,
  useHubApp
} from './hub-api'
import {
  dangerArmed,
  dangerGhost,
  Field,
  ghostButton,
  SecretInput,
  SectionCard,
  StatusChip
} from './hub-parts'
import { HubAppKeyField } from './move/HubAppKeyField'
import { HubMovePanel } from './move/HubMovePanel'
import { HubPlaceSharedForm } from './move/HubPlaceSharedForm'
import {
  fetchMoves,
  isOpenMove,
  moveBadge,
  moveKeys,
  newestMove,
  placementLabel,
  useDrivers,
  usePlacement,
  useSharedList
} from './move/move-api'
import { movePrefill } from './move/move-prefill'
import { mayDeploy, OwnerPolicyCard, useAppAccess } from './owner-access'
import { NotifyRoutesCard } from './providers/NotifyRoutes'
import { AppConnectionsCard, ResourcesPanel } from './providers/ResourcesPanel'
import { HubAppSigninCard } from './signin/HubEnvSigninPanel'

/**
 * One app in the Hub: its environments with their live status (read by the Hub through the
 * hub link or the public version/health), the deploys GitLab ran for each, and who owns it.
 * Administrators edit; owners read. Administrators and the app's owners promote and roll back.
 */
export function HubAppDetail({
  appId,
  isAdmin,
  userId,
  onDeleted
}: {
  appId: number
  isAdmin: boolean
  /** The signed-in person: an owner of the app may promote and roll back it. */
  userId?: string | null
  onDeleted: () => void
}) {
  const app = useHubApp(appId)

  if (app.isPending) {
    return (
      <div className='space-y-4 p-4 sm:p-6'>
        <Skeleton className='h-8 w-64' />
        <Skeleton className='h-40 w-full' />
        <Skeleton className='h-40 w-full' />
      </div>
    )
  }
  if (app.isError) {
    return (
      <QueryErrorState
        error={app.error}
        what='this app'
        onRetry={() => void app.refetch()}
        className='m-4 sm:m-6'
      />
    )
  }

  const data = app.data
  const envs = [...data.environments].sort((a, b) => a.position - b.position || a.id - b.id)
  const canPromote = isAdmin || (!!userId && data.owners.some((o) => o.user_id === userId))
  return (
    <div className='space-y-5 p-4 sm:p-6'>
      <AppHeader app={data} isAdmin={isAdmin} onDeleted={onDeleted} />
      <AppShortcuts app={data} envs={envs} isAdmin={isAdmin} />
      {envs.map((e) => (
        <HubCreationPanel
          key={e.id}
          envId={e.id}
          envStatus={e.status}
          appId={data.id}
          isAdmin={isAdmin}
        />
      ))}
      <EnvironmentsCard app={data} envs={envs} isAdmin={isAdmin} canPromote={canPromote} />
      <AppOutsideResources app={data} envs={envs} />
      {isAdmin && <AppConnectionsCard appId={data.id} />}
      <PromotionsCard envs={envs} canPromote={canPromote} appId={data.id} />
      {canPromote && <HubAppSigninCard app={data} envs={envs} />}
      <DeploysCard envs={envs} />
      <OwnersCard app={data} isAdmin={isAdmin} />
      {canPromote && <OwnerPolicyCard appId={data.id} isAdmin={isAdmin} />}
      {canPromote && (
        <NotifyRoutesCard app={{ id: data.id, owners: data.owners.length }} isAdmin={isAdmin} />
      )}
    </div>
  )
}

// ─── Header: name, key, edit, delete ──────────────────────────────────────────

function AppHeader({
  app,
  isAdmin,
  onDeleted
}: {
  app: HubAppFull
  isAdmin: boolean
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(app.name)

  const save = useMutation({
    mutationFn: () => api.patch(`/hub/apps/${app.id}`, { name: name.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hubKeys.app(app.id) })
      void qc.invalidateQueries({ queryKey: hubKeys.apps() })
      setEditing(false)
    },
    onError: (err) =>
      hubToast(err, 'Could not save the app', { fieldLabels: { key: 'the app key' } })
  })
  const remove = useMutation({
    mutationFn: () => api.delete(`/hub/apps/${app.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hubKeys.apps() })
      qc.removeQueries({ queryKey: hubKeys.app(app.id) })
      onDeleted()
    },
    onError: (err) => hubDeleteToast(err, 'Could not delete the app')
  })

  const nameTip = useOverflowTip<HTMLHeadingElement>(app.name)

  if (editing) {
    return (
      <div className='flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='min-w-[220px] flex-1'>
          <Field id='hub-app-name' label='Name' error={name.trim() ? null : 'Give the app a name'}>
            <Input
              id='hub-app-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              className='h-8 text-[13px]'
              autoFocus
            />
          </Field>
        </div>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!name.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='h-8'
          onClick={() => {
            setName(app.name)
            setEditing(false)
          }}
        >
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <div className='flex flex-wrap items-start gap-3'>
      <div className='min-w-0 flex-1'>
        <h2
          ref={nameTip}
          className='m-0 line-clamp-2 break-words text-[18px] font-semibold tracking-[-0.015em] text-slate-900 sm:line-clamp-1 dark:text-foreground'
        >
          {app.name}
        </h2>
        <div className='mt-1 flex flex-wrap items-center gap-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
          <code className='rounded bg-slate-100 px-1.5 py-px font-mono text-[11px] text-slate-700 dark:bg-muted dark:text-slate-300'>
            {app.key}
          </code>
          {app.adopted && (
            <span
              data-tip='Recorded by the Hub as it already ran; the Hub has never deployed it.'
              className='rounded-full border border-slate-200 px-1.5 py-px text-[10px] font-medium text-slate-600 dark:border-border dark:text-slate-300'
            >
              Adopted
            </span>
          )}
        </div>
      </div>
      {isAdmin && (
        <div className='flex items-center gap-1'>
          <button
            type='button'
            aria-label='Edit app'
            className={ghostButton}
            onClick={() => {
              setName(app.name)
              setEditing(true)
            }}
          >
            <Pencil className='h-3.5 w-3.5' aria-hidden /> Edit
          </button>
          <ConfirmButton
            title='Delete app'
            confirmLabel='Delete this app?'
            className={dangerGhost}
            armedClassName={dangerArmed}
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          >
            <Trash2 className='h-3.5 w-3.5' aria-hidden /> Delete
          </ConfirmButton>
        </div>
      )}
    </div>
  )
}

// ─── Environments ─────────────────────────────────────────────────────────────

function EnvironmentsCard({
  app,
  envs,
  isAdmin,
  canPromote
}: {
  app: HubAppFull
  envs: HubEnvironment[]
  isAdmin: boolean
  canPromote: boolean
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  // Owners deploy non-production only, unless an admin allows production (owner-access.tsx).
  const access = useAppAccess(app.id)
  const deployHere = (envId: number) => canPromote && mayDeploy(access.data, envId)

  const refreshAll = async () => {
    setRefreshingAll(true)
    const results = await Promise.allSettled(
      envs.map((e) =>
        fetchEnvStatus(e.id, true).then((s) => qc.setQueryData(hubKeys.envStatus(e.id), s))
      )
    )
    setRefreshingAll(false)
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed.length > 0) {
      const title =
        failed.length === 1
          ? 'Could not check 1 environment'
          : `Could not check ${failed.length} environments`
      hubToast(failed[0].reason, title, { title })
    }
  }

  return (
    <SectionCard
      title='Environments'
      description='Checked every minute while this page is open.'
      actions={
        <>
          {envs.length > 1 && (
            <button
              type='button'
              className={ghostButton}
              onClick={() => void refreshAll()}
              disabled={refreshingAll}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', refreshingAll && 'animate-spin')}
                aria-hidden
              />
              Refresh all
            </button>
          )}
          {isAdmin && !adding && (
            <button type='button' className={ghostButton} onClick={() => setAdding(true)}>
              <Plus className='h-3.5 w-3.5' aria-hidden /> Add environment
            </button>
          )}
        </>
      }
    >
      {envs.length === 0 && !adding ? (
        <p className='m-0 px-4 py-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
          No environments yet.
        </p>
      ) : (
        <>
          {/* Phone: one stacked entry per environment (the table needs ~640px). */}
          <ul
            aria-label='Environments'
            className='m-0 list-none divide-y divide-slate-100 p-0 sm:hidden dark:divide-border'
          >
            {envs.map((env) => (
              <EnvItem
                key={env.id}
                app={app}
                env={env}
                envs={envs}
                isAdmin={isAdmin}
                canPromote={deployHere(env.id)}
              />
            ))}
          </ul>
          <div className='hidden overflow-x-auto sm:block'>
            {/* Fixed layout (P4-25): a long status, address or stack panel wraps or truncates
                inside its column; the table never scrolls sideways on a desktop screen. */}
            <table className='w-full min-w-[640px] table-fixed text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 text-left text-[11px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'>
                  <th className='w-[20%] px-4 py-2 font-medium'>Environment</th>
                  <th className='px-4 py-2 font-medium'>Address</th>
                  <th className='w-[11%] px-4 py-2 font-medium'>Version</th>
                  <th className='w-[20%] px-4 py-2 font-medium'>Status</th>
                  <th className='w-[10%] px-4 py-2 font-medium'>Checked</th>
                  {/* Design B1: icons only (each has its name and a tip), five at most, so the
                      column always holds them; it never paints over Checked. */}
                  <th className='w-[192px] px-2 py-2'>
                    <span className='sr-only'>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {envs.map((env) => (
                  <EnvRow
                    key={env.id}
                    app={app}
                    env={env}
                    envs={envs}
                    isAdmin={isAdmin}
                    canPromote={deployHere(env.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {adding && <AddEnvironment app={app} envs={envs} onClose={() => setAdding(false)} />}
    </SectionCard>
  )
}

/** One environment's status read, Refresh and Remove: shared by the table row and the phone entry. */
function useEnvRow(app: HubAppFull, env: HubEnvironment, isAdmin: boolean) {
  const qc = useQueryClient()
  const status = useEnvStatus(env.id)
  // Phase 6: where the environment runs (Hub admins only — placements are an admin read).
  const placement = usePlacement(env.placement_id, isAdmin)
  // Owners cannot read placements: the app read's own `on_shared` says it for them (parked C3).
  const isShared = placement.data?.kind === 'shared' || env.on_shared === true
  // Admins: until the placement is read, neither Promote nor the stack panel can be judged.
  const placementPending = isAdmin && env.placement_id != null && placement.isPending
  const shared = useSharedList(isAdmin && isShared)
  const drivers = useDrivers(isAdmin && placement.data?.kind === 'dedicated')
  const placementText = placementLabel(placement.data, shared.data, drivers.data)
  // Design B4: the newest move of this environment (Hub admins; moves are an admin read).
  const moves = useQuery({
    queryKey: moveKeys.moves(env.id),
    queryFn: () => fetchMoves(env.id),
    enabled: isAdmin && env.placement_id != null,
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.some((m) => isOpenMove(m.status)) ? 10_000 : q.state.error ? false : 60_000
  })
  const lastMove = newestMove(moves.data)
  const moveOpen = !!lastMove && isOpenMove(lastMove.status)
  const badge = moveBadge(lastMove)
  // Opened from the Capacity tab's move advisor (`?move=<envId>`): the panel starts open.
  const [moving, setMoving] = useState(() => isAdmin && movePrefill(env.id).open)
  // A start or a stack-placement request is out in the move panel: the row keeps it mounted.
  const [moveBusy, setMoveBusy] = useState(false)
  const [placing, setPlacing] = useState(false)
  const [editing, setEditing] = useState(false)
  const refresh = useMutation({
    mutationFn: () => fetchEnvStatus(env.id, true),
    onSuccess: (s) => qc.setQueryData(hubKeys.envStatus(env.id), s),
    onError: (err) => hubToast(err, `Could not check ${env.key}`)
  })
  const remove = useMutation({
    mutationFn: () => api.delete(`/hub/environments/${env.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hubKeys.app(app.id) })
      qc.removeQueries({ queryKey: hubKeys.envStatus(env.id) })
      qc.removeQueries({ queryKey: hubKeys.deploys(env.id) })
    },
    onError: (err) => hubDeleteToast(err, `Could not remove ${env.key}`)
  })
  const [promoting, setPromoting] = useState(false)
  return {
    status,
    refresh,
    remove,
    editing,
    setEditing,
    promoting,
    setPromoting,
    isShared,
    placementPending,
    moveOpen,
    badge,
    placementText,
    moving,
    setMoving,
    moveBusy,
    setMoveBusy,
    placing,
    setPlacing
  }
}

/** `Shared · <key>` / `Dedicated · <driver>`: where the environment runs. */
function PlacementChip({ text, shared }: { text: string | null; shared: boolean }) {
  if (!text) return null
  return (
    <span
      data-tip={
        shared
          ? 'Runs inside a shared deployment with other apps'
          : 'Runs on its own stack or pipeline'
      }
      className={cn(
        'inline-flex min-w-0 max-w-full shrink-0 items-center gap-1 truncate rounded-full border px-1.5 py-px font-sans text-[10px] font-medium',
        shared
          ? 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300'
          : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-slate-300'
      )}
    >
      <Layers className='h-2.5 w-2.5 shrink-0' aria-hidden />
      <span className='truncate'>{text}</span>
    </span>
  )
}

const MOVE_OPEN_TIP =
  'A move of this environment is open: Promote waits until it ends (open Move… to follow it).'

/** Why Promote is off on this row, or null when it is not held. */
const promoteBlockedReason = (row: EnvRowState): string | null =>
  row.isShared ? SHARED_PLACEMENT_TIP : row.moveOpen ? MOVE_OPEN_TIP : null

const BADGE_TONE = {
  live: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300',
  attention:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
  halted:
    'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300'
} as const

/** Design B4: the environment's move as a chip that opens the move panel. */
function MoveBadgeChip({ env, row }: { env: HubEnvironment; row: EnvRowState }) {
  if (!row.badge) return null
  return (
    <button
      type='button'
      aria-label={`Move of ${env.key}: ${row.badge.text}. Open it`}
      data-tip='Open the move'
      onClick={() => row.setMoving(true)}
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1 truncate rounded-full border px-1.5 py-px font-sans text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        BADGE_TONE[row.badge.tone]
      )}
    >
      <ArrowRightLeft className='h-2.5 w-2.5 shrink-0' aria-hidden />
      <span className='truncate'>{row.badge.text}</span>
    </button>
  )
}

/**
 * Place on shared is for an environment that never served (status provisioning) — also one whose
 * earlier placement on a shared deployment did not finish (placing it again retries); one that
 * served moves instead.
 */
const placeable = (env: HubEnvironment) => env.status === 'provisioning'
const movable = (env: HubEnvironment) => env.placement_id != null && env.status !== 'provisioning'

type EnvRowState = ReturnType<typeof useEnvRow>

function EnvStatus({ status }: { status: EnvRowState['status'] }) {
  if (status.isPending) return <StatusChip state='checking' />
  if (status.isError) return <StatusChip state='failed' tip='The Hub could not read its status' />
  const s = status.data
  const hint = statusHint(s)
  const source =
    s.source === 'public'
      ? 'From its public version and health (no hub token set)'
      : 'From the hub link'
  return (
    <StatusChip
      state={s.state}
      tip={hint ? `${hint}. ${source}` : source}
      ariaLabel={hint ? `${STATUS_COPY[s.state]}: ${hint}` : undefined}
    />
  )
}

/** The small muted line under a status that says why (nothing when all is fine). */
function EnvStatusHint({
  status,
  className
}: {
  status: EnvRowState['status']
  className?: string
}) {
  const hint = status.data ? statusHint(status.data) : null
  if (!hint) return null
  return (
    <p
      aria-hidden
      className={cn(
        'm-0 text-[11px] leading-snug text-slate-500 dark:text-muted-foreground',
        className
      )}
    >
      {hint}
    </p>
  )
}

function EnvActions({
  env,
  row,
  isAdmin,
  canPromote
}: {
  env: HubEnvironment
  row: EnvRowState
  isAdmin: boolean
  canPromote: boolean
}) {
  // The table row and the phone entry both render actions: ids unique per mount.
  const whyId = useId()
  const promoteBlocked = promoteBlockedReason(row)
  return (
    <div className='flex flex-wrap items-center justify-end gap-0'>
      {canPromote && env.placement_id != null && promoteBlocked && (
        // A shared-placed environment's version follows its deployment, and an open move holds
        // the environment: say so, don't open a panel that can only refuse.
        <span data-tip={promoteBlocked} className='inline-flex'>
          <button
            type='button'
            aria-label={`Promote ${env.key}`}
            aria-describedby={whyId}
            className={ghostButton}
            disabled
          >
            <Rocket className='h-3.5 w-3.5' aria-hidden />
          </button>
          {/* The reason for assistive tech too (the tip is pointer-only). */}
          <span id={whyId} className='sr-only'>
            {promoteBlocked}
          </span>
        </span>
      )}
      {canPromote && env.placement_id != null && row.placementPending && (
        <button
          type='button'
          aria-label={`Promote ${env.key}`}
          aria-busy
          className={ghostButton}
          disabled
        >
          <Rocket className='h-3.5 w-3.5' aria-hidden />
        </button>
      )}
      {canPromote && env.placement_id != null && !promoteBlocked && !row.placementPending && (
        <button
          type='button'
          aria-label={`Promote ${env.key}`}
          aria-expanded={row.promoting}
          data-tip='Promote a version here'
          className={cn(ghostButton, row.promoting && 'bg-accent')}
          onClick={() => row.setPromoting(!row.promoting)}
        >
          <Rocket className='h-3.5 w-3.5' aria-hidden />
        </button>
      )}
      <button
        type='button'
        aria-label={`Refresh ${env.key}`}
        data-tip='Check now'
        className={ghostButton}
        disabled={row.refresh.isPending}
        onClick={() => row.refresh.mutate()}
      >
        <RefreshCw
          className={cn('h-3.5 w-3.5', row.refresh.isPending && 'animate-spin')}
          aria-hidden
        />
      </button>
      {isAdmin && movable(env) && (
        <button
          type='button'
          aria-label={`Move ${env.key}`}
          aria-expanded={row.moving}
          data-tip='Move to a shared deployment or another stack'
          className={cn(ghostButton, row.moving && 'bg-accent')}
          disabled={row.moveBusy}
          onClick={() => row.setMoving(!row.moving)}
        >
          <ArrowRightLeft className='h-3.5 w-3.5' aria-hidden />
        </button>
      )}
      {isAdmin && placeable(env) && (
        <button
          type='button'
          aria-label={`Place ${env.key} on a shared deployment`}
          aria-expanded={row.placing}
          data-tip='Place on shared deployment… (a new environment)'
          className={cn(ghostButton, row.placing && 'bg-accent')}
          disabled={row.moveBusy}
          onClick={() => row.setPlacing(!row.placing)}
        >
          <Layers className='h-3.5 w-3.5' aria-hidden />
        </button>
      )}
      {isAdmin && (
        <>
          <button
            type='button'
            aria-label={`Edit ${env.key}`}
            data-tip={row.moveBusy ? 'Wait for the request to finish' : 'Edit'}
            className={ghostButton}
            disabled={row.moveBusy}
            onClick={() => row.setEditing(true)}
          >
            <Pencil className='h-3.5 w-3.5' aria-hidden />
          </button>
          <ConfirmButton
            title={`Remove ${env.key}`}
            confirmLabel='Remove?'
            className={dangerGhost}
            armedClassName={dangerArmed}
            disabled={row.remove.isPending}
            onConfirm={() => row.remove.mutate()}
          >
            <Trash2 className='h-3.5 w-3.5' aria-hidden />
          </ConfirmButton>
        </>
      )}
    </div>
  )
}

const hostOf = (url: string) => url.replace(/^https?:\/\//, '')

/** Table row (sm and up). */
function EnvRow({
  app,
  env,
  envs,
  isAdmin,
  canPromote
}: {
  app: HubAppFull
  env: HubEnvironment
  envs: HubEnvironment[]
  isAdmin: boolean
  canPromote: boolean
}) {
  const row = useEnvRow(app, env, isAdmin)

  if (row.editing) {
    return (
      <tr className='border-b border-slate-100 last:border-0 dark:border-border'>
        <td colSpan={6} className='px-4 py-3'>
          <EditEnvironment
            app={app}
            env={env}
            idPrefix={`hub-env-${env.id}`}
            taken={envs.filter((e) => e.id !== env.id).map((e) => e.key)}
            onClose={() => row.setEditing(false)}
            shared={row.isShared}
          />
        </td>
      </tr>
    )
  }

  const s = row.status.data
  return (
    <Fragment>
      <tr
        className='border-b border-slate-100 last:border-0 dark:border-border'
        data-env-tone={envTone(env.key)}
      >
        <td className='truncate px-4 py-2.5 font-mono text-[12px] font-medium text-slate-800 dark:text-foreground'>
          {env.key}
          <HubEnvTag envKey={env.key} className='ml-1.5 align-[1px]' />
          <div className='mt-0.5 flex flex-wrap gap-1 empty:hidden'>
            {(row.placementText || row.badge) && (
              <>
                <PlacementChip text={row.placementText} shared={row.isShared} />
                <MoveBadgeChip env={env} row={row} />
              </>
            )}
            <EnvironmentCostChip appId={app.id} envId={env.id} />
          </div>
        </td>
        <td className='max-w-[280px] px-4 py-2.5'>
          <a
            href={env.base_url}
            target='_blank'
            rel='noreferrer'
            className='hub-fact block truncate text-slate-600 hover:text-nvr-navy hover:underline dark:text-slate-300 dark:hover:text-nvr-cyan'
          >
            {hostOf(env.base_url)}
          </a>
        </td>
        <td className='hub-fact px-4 py-2.5 font-mono tabular-nums text-slate-700 dark:text-slate-300'>
          {s?.version ?? '—'}
        </td>
        <td className='min-w-0 px-4 py-2.5'>
          <EnvStatus status={row.status} />
          <EnvStatusHint status={row.status} className='mt-1' />
        </td>
        <td
          className='truncate px-4 py-2.5 text-slate-500 dark:text-muted-foreground'
          data-tip={s?.checked_at ? formatDateTime(s.checked_at) : undefined}
        >
          {s?.checked_at ? formatRelative(s.checked_at) : '—'}
        </td>
        <td className='overflow-hidden px-2 py-2.5'>
          <EnvActions env={env} row={row} isAdmin={isAdmin} canPromote={canPromote} />
        </td>
      </tr>
      {env.placement_id != null && !row.isShared && !row.placementPending && (
        <HubStackPanel
          env={env}
          appId={app.id}
          isAdmin={isAdmin}
          canDeploy={canPromote}
          layout='row'
        />
      )}
      <ResourcesPanel app={app} env={env} isAdmin={isAdmin} canDeploy={canPromote} layout='row' />
      {row.moving && (
        <tr className='border-b border-slate-100 last:border-0 dark:border-border'>
          <td colSpan={6} className='px-4 pb-3'>
            <ProductionGuard envKey={env.key} what='move'>
              <HubMovePanel
                appKey={app.key}
                env={env}
                idPrefix={`hub-move-${env.id}`}
                onClose={() => row.setMoving(false)}
                onBusy={row.setMoveBusy}
              />
            </ProductionGuard>
          </td>
        </tr>
      )}
      {row.placing && (
        <tr className='border-b border-slate-100 last:border-0 dark:border-border'>
          <td colSpan={6} className='px-4 pb-3'>
            <ProductionGuard envKey={env.key} what='placement'>
              <HubPlaceSharedForm
                appId={app.id}
                env={env}
                idPrefix={`hub-place-${env.id}`}
                onClose={() => row.setPlacing(false)}
                onBusy={row.setMoveBusy}
              />
            </ProductionGuard>
          </td>
        </tr>
      )}
      {row.promoting && (
        <tr className='border-b border-slate-100 last:border-0 dark:border-border'>
          <td colSpan={6} className='px-4 pb-3'>
            <ProductionGuard envKey={env.key} what='promotion'>
              <HubPromotePanel
                env={env}
                kind='promote'
                idPrefix={`hub-promote-${env.id}`}
                onClose={() => row.setPromoting(false)}
              />
            </ProductionGuard>
          </td>
        </tr>
      )}
    </Fragment>
  )
}

/** Phone entry (below sm): key, status and actions, then address · version · checked. */
function EnvItem({
  app,
  env,
  envs,
  isAdmin,
  canPromote
}: {
  app: HubAppFull
  env: HubEnvironment
  envs: HubEnvironment[]
  isAdmin: boolean
  canPromote: boolean
}) {
  const row = useEnvRow(app, env, isAdmin)
  if (row.editing) {
    return (
      <li className='px-4 py-3'>
        <EditEnvironment
          app={app}
          env={env}
          idPrefix={`hub-env-${env.id}-m`}
          taken={envs.filter((e) => e.id !== env.id).map((e) => e.key)}
          onClose={() => row.setEditing(false)}
          shared={row.isShared}
        />
      </li>
    )
  }
  const s = row.status.data
  return (
    <li className='px-4 py-2.5' data-env-tone={envTone(env.key)}>
      {/* Design S1: name and status on the first line, chips wrap below at their full width,
          the actions get a line of their own under the facts (nothing runs off the card). */}
      <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
        <span className='font-mono text-[12px] font-medium text-slate-800 dark:text-foreground'>
          {env.key}
        </span>
        <HubEnvTag envKey={env.key} />
        <EnvStatus status={row.status} />
      </div>
      <div className='mt-1 flex flex-wrap items-center gap-1 empty:hidden'>
        {(row.placementText || row.badge) && (
          <>
            <PlacementChip text={row.placementText} shared={row.isShared} />
            <MoveBadgeChip env={env} row={row} />
          </>
        )}
        <EnvironmentCostChip appId={app.id} envId={env.id} />
      </div>
      <p className='m-0 mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
        <a
          href={env.base_url}
          target='_blank'
          rel='noreferrer'
          className='min-w-0 truncate hover:text-nvr-navy hover:underline dark:hover:text-nvr-cyan'
        >
          {hostOf(env.base_url)}
        </a>
        <span aria-hidden>·</span>
        <span className='hub-fact shrink-0 font-mono tabular-nums'>{s?.version ?? '—'}</span>
        <span aria-hidden>·</span>
        <span className='shrink-0'>{s?.checked_at ? formatRelative(s.checked_at) : '—'}</span>
      </p>
      <EnvStatusHint status={row.status} className='mt-0.5' />
      <div className='mt-1 flex justify-start [&>div]:justify-start'>
        <EnvActions env={env} row={row} isAdmin={isAdmin} canPromote={canPromote} />
      </div>
      {canPromote && env.placement_id != null && promoteBlockedReason(row) && (
        // Design N-r2-6: a phone has no hover, so the off Promote's reason is a line of its own
        // (assistive tech already reads it as the button's description).
        <p
          aria-hidden
          data-testid='promote-blocked-line'
          className='m-0 mt-0.5 text-[11px] leading-snug text-slate-500 dark:text-muted-foreground'
        >
          {promoteBlockedReason(row)}
        </p>
      )}
      {env.placement_id != null && !row.isShared && !row.placementPending && (
        <HubStackPanel
          env={env}
          appId={app.id}
          isAdmin={isAdmin}
          canDeploy={canPromote}
          layout='card'
          idPrefix='-m'
        />
      )}
      <ResourcesPanel
        app={app}
        env={env}
        isAdmin={isAdmin}
        canDeploy={canPromote}
        layout='card'
        idPrefix='-m'
      />
      {row.moving && (
        <div className='mt-2'>
          <ProductionGuard envKey={env.key} what='move'>
            <HubMovePanel
              appKey={app.key}
              env={env}
              idPrefix={`hub-move-${env.id}-m`}
              onClose={() => row.setMoving(false)}
              onBusy={row.setMoveBusy}
            />
          </ProductionGuard>
        </div>
      )}
      {row.placing && (
        <div className='mt-2'>
          <ProductionGuard envKey={env.key} what='placement'>
            <HubPlaceSharedForm
              appId={app.id}
              env={env}
              idPrefix={`hub-place-${env.id}-m`}
              onClose={() => row.setPlacing(false)}
              onBusy={row.setMoveBusy}
            />
          </ProductionGuard>
        </div>
      )}
      {row.promoting && (
        <div className='mt-2'>
          <ProductionGuard envKey={env.key} what='promotion'>
            <HubPromotePanel
              env={env}
              kind='promote'
              idPrefix={`hub-promote-${env.id}-m`}
              onClose={() => row.setPromoting(false)}
            />
          </ProductionGuard>
        </div>
      )}
    </li>
  )
}

function EditEnvironment({
  app,
  env,
  idPrefix,
  taken,
  onClose,
  shared = false
}: {
  app: HubAppFull
  env: HubEnvironment
  /** It runs on a shared deployment (the key field then speaks of a lost key). */
  shared?: boolean
  /** Unique per layout (the table and the phone list can both hold a form). */
  idPrefix: string
  taken: string[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const stored = !!env.hub_token
  const [key, setKey] = useState(env.key)
  const [baseUrl, setBaseUrl] = useState(env.base_url)
  const [token, setToken] = useState(stored ? HUB_MASK : '')
  const errors = envDraftErrors({ ...emptyEnvDraft(key), base_url: baseUrl }, taken)

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/hub/environments/${env.id}`, {
        key: key.trim(),
        base_url: baseUrl.trim().replace(/\/+$/, ''),
        // Unchanged = not sent (the stored token stays); cleared = removed.
        ...(token !== (stored ? HUB_MASK : '') ? { hub_token: token.trim() } : {})
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hubKeys.app(app.id) })
      void qc.invalidateQueries({ queryKey: hubKeys.envStatus(env.id) })
      onClose()
    },
    onError: (err) =>
      hubToast(err, `Could not save ${env.key}`, {
        fieldLabels: { key: 'the environment name', placement_id: 'the placement' }
      })
  })

  return (
    <div className='space-y-3'>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-[minmax(120px,0.6fr)_minmax(220px,1.4fr)_minmax(160px,1fr)]'>
        <Field id={`${idPrefix}-key`} label='Environment' error={errors.key || null}>
          <Input
            id={`${idPrefix}-key`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className='h-8 font-mono text-[13px]'
          />
        </Field>
        <Field id={`${idPrefix}-url`} label='Address' error={errors.base_url || null}>
          <Input
            id={`${idPrefix}-url`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            inputMode='url'
            className='h-8 text-[13px]'
          />
        </Field>
        <Field
          id={`${idPrefix}-token`}
          label='Hub token'
          hint={stored ? 'Leave as is to keep it; clear it to remove it.' : 'Optional.'}
        >
          <SecretInput id={`${idPrefix}-token`} value={token} onChange={setToken} stored={stored} />
        </Field>
      </div>
      <div className='flex items-center gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!!errors.key || !!errors.base_url || !isBaseUrl(baseUrl) || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onClose}>
          Cancel
        </Button>
      </div>
      <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
        Save and Cancel cover the fields above. The switch and the components below save on their
        own as you change them.
      </p>
      <HubComponentsEditor appId={app.id} env={env} idPrefix={idPrefix} />
      <HubAppKeyField envId={env.id} idPrefix={idPrefix} shared={shared} />
    </div>
  )
}

function AddEnvironment({
  app,
  envs,
  onClose
}: {
  app: HubAppFull
  envs: HubEnvironment[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const drivers = useDriverOptions(true)
  const [draft, setDraft] = useState<EnvDraft>(emptyEnvDraft())
  const [tried, setTried] = useState(false)
  const errors = envDraftErrors(
    draft,
    envs.map((e) => e.key)
  )

  const save = useMutation({
    mutationFn: () =>
      createEnvironment(app.id, draft, Math.max(-1, ...envs.map((e) => e.position)) + 1),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hubKeys.app(app.id) })
      void qc.invalidateQueries({ queryKey: hubKeys.apps() })
      onClose()
    },
    onError: (err) => hubToast(err, 'Could not add the environment')
  })

  return (
    <div className='space-y-3 border-t border-slate-200 px-4 py-4 dark:border-border'>
      <div className='flex items-center'>
        <h4 className='m-0 flex-1 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
          New environment
        </h4>
        <button type='button' aria-label='Close' className={ghostButton} onClick={onClose}>
          <X className='h-3.5 w-3.5' aria-hidden />
        </button>
      </div>
      {drivers.isError && (
        <ErrorNotice
          description={hubError(drivers.error, 'Could not load the drivers')}
          onRetry={() => void drivers.refetch()}
        />
      )}
      <EnvDraftFields
        idPrefix='hub-env-new'
        draft={draft}
        onChange={setDraft}
        drivers={drivers.data ?? []}
        errors={tried ? errors : undefined}
      />
      <div className='flex items-center gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={save.isPending}
          onClick={() => {
            setTried(true)
            if (!errors.key && !errors.base_url) save.mutate()
          }}
        >
          {save.isPending ? 'Adding…' : 'Add environment'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ─── Deploy history ───────────────────────────────────────────────────────────

const PIPELINE_TONE: Record<string, string> = {
  success: 'text-emerald-700 dark:text-emerald-300',
  failed: 'text-red-700 dark:text-red-300',
  running: 'text-sky-700 dark:text-sky-300',
  pending: 'text-amber-700 dark:text-amber-300',
  created: 'text-amber-700 dark:text-amber-300',
  manual: 'text-amber-700 dark:text-amber-300'
}

const PIPELINE_WORDS: Record<string, string> = {
  success: 'Succeeded',
  failed: 'Failed',
  running: 'Running',
  pending: 'Waiting',
  created: 'Waiting',
  manual: 'Waiting for someone',
  canceled: 'Cancelled',
  skipped: 'Skipped'
}

const pipelineWords = (s: string) => PIPELINE_WORDS[s] ?? s.replace(/_/g, ' ')

function DeploysCard({ envs }: { envs: HubEnvironment[] }) {
  return (
    <SectionCard
      title='Deploys'
      description='The last 20 deploy pipelines per environment, read from GitLab.'
    >
      {envs.length === 0 ? (
        <p className='m-0 px-4 py-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
          No environments yet.
        </p>
      ) : (
        <div className='divide-y divide-slate-200 dark:divide-border'>
          {envs.map((env) => (
            <EnvDeploys key={env.id} env={env} />
          ))}
        </div>
      )}
    </SectionCard>
  )
}

const DEPLOYS_SHOWN = 5

function EnvDeploys({ env }: { env: HubEnvironment }) {
  const [all, setAll] = useState(false)
  const q = useQuery({
    queryKey: hubKeys.deploys(env.id),
    queryFn: () => fetchDeploys(env.id),
    staleTime: 60_000
  })

  return (
    <div className='px-4 py-3' data-env-tone={envTone(env.key)}>
      <h4 className='m-0 mb-2 font-mono text-[12px] font-semibold text-slate-800 dark:text-foreground'>
        {env.key}
        <HubEnvTag envKey={env.key} className='ml-1.5 align-[1px]' />
      </h4>
      {q.isPending ? (
        <Skeleton className='h-14 w-full' />
      ) : q.isError ? (
        <ErrorNotice
          description={hubError(q.error, 'Could not load the deploys')}
          onRetry={() => void q.refetch()}
        />
      ) : q.data.reason === 'NO_DRIVER' ? (
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No GitLab driver deploys this environment, so there is no history to show.
        </p>
      ) : q.data.data.length === 0 ? (
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No deploys on this branch yet.
        </p>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {(all ? q.data.data : q.data.data.slice(0, DEPLOYS_SHOWN)).map((d) => (
            <li key={d.pipeline_id} className='flex flex-wrap items-center gap-x-4 gap-y-1 py-2'>
              <span className='hub-fact min-w-[84px] font-mono text-[12px] font-medium text-slate-900 dark:text-foreground'>
                {d.version ?? d.sha.slice(0, 8)}
              </span>
              <span
                className={cn(
                  'text-[12px] font-medium',
                  PIPELINE_TONE[d.status] ?? 'text-slate-600 dark:text-slate-300'
                )}
              >
                {pipelineWords(d.status)}
              </span>
              {d.deploy_job && d.deploy_job.status !== d.status && (
                <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                  deploy job: {pipelineWords(d.deploy_job.status).toLowerCase()}
                </span>
              )}
              <span
                className='text-[11px] text-slate-500 dark:text-muted-foreground'
                data-tip={d.started_at ? formatDateTime(d.started_at) : undefined}
              >
                {d.started_at ? formatRelative(d.started_at) : 'not started'}
              </span>
              <a
                href={d.deploy_job?.web_url ?? d.web_url}
                target='_blank'
                rel='noreferrer'
                className='inline-flex w-full items-center gap-1 text-left text-[11px] text-slate-600 hover:text-nvr-navy hover:underline sm:ml-auto sm:w-auto sm:justify-end sm:text-right dark:text-slate-300 dark:hover:text-nvr-cyan'
              >
                Pipeline #{d.pipeline_id}
                <ExternalLink className='h-3 w-3' aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      )}
      {q.data && !all && q.data.data.length > DEPLOYS_SHOWN && (
        <button type='button' className={cn(ghostButton, 'mt-1')} onClick={() => setAll(true)}>
          Show {q.data.data.length - DEPLOYS_SHOWN} more
        </button>
      )}
    </div>
  )
}

// ─── Owners ───────────────────────────────────────────────────────────────────

function OwnersCard({ app, isAdmin }: { app: HubAppFull; isAdmin: boolean }) {
  const qc = useQueryClient()
  const ids = app.owners.map((o) => o.user_id)
  const save = useMutation({
    mutationFn: (userIds: string[]) => api.put(`/hub/apps/${app.id}/owners`, { user_ids: userIds }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: hubKeys.app(app.id) }),
    onError: (err) => hubToast(err, 'Could not save the owners')
  })

  return (
    <SectionCard
      title='Owners'
      description='Owners see this app in the Hub. Administrators see every app.'
    >
      <div className='flex flex-wrap items-center gap-2 px-4 py-3'>
        {app.owners.length === 0 && (
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            No owners yet.
          </span>
        )}
        {app.owners.map((o) => (
          <span
            key={o.user_id}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2.5 text-[12px] text-slate-700 dark:border-border dark:bg-muted dark:text-slate-200',
              isAdmin ? 'pr-1' : 'pr-2.5'
            )}
          >
            {o.name}
            {isAdmin && (
              <button
                type='button'
                aria-label={`Remove ${o.name}`}
                className='inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-500 hover:bg-slate-200 hover:text-slate-800 disabled:opacity-50 dark:text-muted-foreground dark:hover:bg-slate-700 dark:hover:text-foreground'
                disabled={save.isPending}
                onClick={() => save.mutate(ids.filter((id) => id !== o.user_id))}
              >
                <X className='h-3 w-3' aria-hidden />
              </button>
            )}
          </span>
        ))}
        {isAdmin && (
          <div className='w-full max-w-[280px]'>
            <UserCombobox
              value={null}
              onChange={(id) => {
                if (id && !ids.includes(id)) save.mutate([...ids, id])
              }}
              placeholder='Add an owner'
              searchServer
              hideNone
              disabled={save.isPending}
              className='h-8'
            />
          </div>
        )}
      </div>
    </SectionCard>
  )
}

/** For the list: an environment's key coloured by its live status, with a glyph when not fine. */
export function EnvStatusDot({ env }: { env: HubEnvironment }) {
  const s = useEnvStatus(env.id)
  const state = s.data?.state ?? (s.isError ? 'failed' : 'checking')
  const hint = s.data ? statusHint(s.data) : null
  const tipText = s.data
    ? `${STATUS_COPY[s.data.state]}${hint ? `: ${hint}` : ''}`
    : s.isError
      ? 'Could not check'
      : 'Checking…'
  return (
    <StatusChip
      compact
      glyph
      state={state}
      label={env.key}
      tip={tipText}
      ariaLabel={`${env.key}: ${tipText}`}
    />
  )
}
