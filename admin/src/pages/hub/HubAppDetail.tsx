import { ConfirmButton, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { UserCombobox } from '@/components/user-combobox'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import {
  createEnvironment,
  type EnvDraft,
  EnvDraftFields,
  emptyEnvDraft,
  envDraftErrors,
  useDriverOptions
} from './HubAdoptForm'
import {
  fetchDeploys,
  fetchEnvStatus,
  HUB_MASK,
  type HubAppFull,
  type HubEnvironment,
  hubError,
  hubKeys,
  hubToast,
  isBaseUrl,
  STATUS_COPY,
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

/**
 * One app in the Hub: its environments with their live status (read by the Hub through the
 * hub link or the public version/health), the deploys GitLab ran for each, and who owns it.
 * Administrators edit; owners read.
 */
export function HubAppDetail({
  appId,
  isAdmin,
  onDeleted
}: {
  appId: number
  isAdmin: boolean
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
  return (
    <div className='space-y-5 p-4 sm:p-6'>
      <AppHeader app={data} isAdmin={isAdmin} onDeleted={onDeleted} />
      <EnvironmentsCard app={data} envs={envs} isAdmin={isAdmin} />
      <DeploysCard envs={envs} />
      <OwnersCard app={data} isAdmin={isAdmin} />
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
    onError: (err) => hubToast(err, 'Could not save the app')
  })
  const remove = useMutation({
    mutationFn: () => api.delete(`/hub/apps/${app.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hubKeys.apps() })
      qc.removeQueries({ queryKey: hubKeys.app(app.id) })
      onDeleted()
    },
    onError: (err) => hubToast(err, 'Could not delete the app')
  })

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
        <h2 className='m-0 truncate text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
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
  isAdmin
}: {
  app: HubAppFull
  envs: HubEnvironment[]
  isAdmin: boolean
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)

  const refreshAll = async () => {
    setRefreshingAll(true)
    await Promise.allSettled(
      envs.map((e) =>
        fetchEnvStatus(e.id, true).then((s) => qc.setQueryData(hubKeys.envStatus(e.id), s))
      )
    )
    setRefreshingAll(false)
  }

  return (
    <SectionCard
      title='Environments'
      description='Checked by the Hub every minute; Refresh asks again now.'
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
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[640px] text-[12px]'>
            <thead>
              <tr className='border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:border-border dark:text-muted-foreground'>
                <th className='px-4 py-2 font-medium'>Environment</th>
                <th className='px-4 py-2 font-medium'>Address</th>
                <th className='px-4 py-2 font-medium'>Version</th>
                <th className='px-4 py-2 font-medium'>Status</th>
                <th className='px-4 py-2 font-medium'>Checked</th>
                <th className='px-4 py-2'>
                  <span className='sr-only'>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {envs.map((env) => (
                <EnvRow key={env.id} app={app} env={env} envs={envs} isAdmin={isAdmin} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddEnvironment app={app} envs={envs} onClose={() => setAdding(false)} />}
    </SectionCard>
  )
}

function EnvRow({
  app,
  env,
  envs,
  isAdmin
}: {
  app: HubAppFull
  env: HubEnvironment
  envs: HubEnvironment[]
  isAdmin: boolean
}) {
  const qc = useQueryClient()
  const status = useEnvStatus(env.id)
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
    onError: (err) => hubToast(err, `Could not remove ${env.key}`)
  })

  if (editing) {
    return (
      <tr className='border-b border-slate-100 last:border-0 dark:border-border'>
        <td colSpan={6} className='px-4 py-3'>
          <EditEnvironment
            app={app}
            env={env}
            taken={envs.filter((e) => e.id !== env.id).map((e) => e.key)}
            onClose={() => setEditing(false)}
          />
        </td>
      </tr>
    )
  }

  const s = status.data
  return (
    <tr className='border-b border-slate-100 last:border-0 dark:border-border'>
      <td className='px-4 py-2.5 font-mono text-[12px] font-medium text-slate-800 dark:text-foreground'>
        {env.key}
      </td>
      <td className='max-w-[280px] px-4 py-2.5'>
        <a
          href={env.base_url}
          target='_blank'
          rel='noreferrer'
          className='block truncate text-slate-600 hover:text-nvr-navy hover:underline dark:text-slate-300 dark:hover:text-nvr-cyan'
        >
          {env.base_url.replace(/^https?:\/\//, '')}
        </a>
      </td>
      <td className='px-4 py-2.5 font-mono tabular-nums text-slate-700 dark:text-slate-300'>
        {s?.version ?? '—'}
      </td>
      <td className='px-4 py-2.5'>
        {status.isPending ? (
          <StatusChip state='checking' />
        ) : status.isError ? (
          <StatusChip state='checking' label='Could not check' />
        ) : s ? (
          <StatusChip
            state={s.state}
            tip={
              s.source === 'public'
                ? 'From its public version and health (no hub token set)'
                : 'From the hub link'
            }
          />
        ) : null}
      </td>
      <td
        className='whitespace-nowrap px-4 py-2.5 text-slate-500 dark:text-muted-foreground'
        data-tip={s?.checked_at ? formatDateTime(s.checked_at) : undefined}
      >
        {s?.checked_at ? formatRelative(s.checked_at) : '—'}
      </td>
      <td className='px-4 py-2.5'>
        <div className='flex items-center justify-end gap-0.5'>
          <button
            type='button'
            aria-label={`Refresh ${env.key}`}
            data-tip='Check now'
            className={ghostButton}
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', refresh.isPending && 'animate-spin')}
              aria-hidden
            />
          </button>
          {isAdmin && (
            <>
              <button
                type='button'
                aria-label={`Edit ${env.key}`}
                data-tip='Edit'
                className={ghostButton}
                onClick={() => setEditing(true)}
              >
                <Pencil className='h-3.5 w-3.5' aria-hidden />
              </button>
              <ConfirmButton
                title={`Remove ${env.key}`}
                confirmLabel='Remove?'
                className={dangerGhost}
                armedClassName={dangerArmed}
                disabled={remove.isPending}
                onConfirm={() => remove.mutate()}
              >
                <Trash2 className='h-3.5 w-3.5' aria-hidden />
              </ConfirmButton>
            </>
          )}
        </div>
      </td>
    </tr>
  )
}

function EditEnvironment({
  app,
  env,
  taken,
  onClose
}: {
  app: HubAppFull
  env: HubEnvironment
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
    onError: (err) => hubToast(err, `Could not save ${env.key}`)
  })

  return (
    <div className='space-y-3'>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-[minmax(120px,0.6fr)_minmax(220px,1.4fr)_minmax(160px,1fr)]'>
        <Field id={`hub-env-${env.id}-key`} label='Environment' error={errors.key || null}>
          <Input
            id={`hub-env-${env.id}-key`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className='h-8 font-mono text-[13px]'
          />
        </Field>
        <Field id={`hub-env-${env.id}-url`} label='Address' error={errors.base_url || null}>
          <Input
            id={`hub-env-${env.id}-url`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            inputMode='url'
            className='h-8 text-[13px]'
          />
        </Field>
        <Field
          id={`hub-env-${env.id}-token`}
          label='Hub token'
          hint={stored ? 'Leave as is to keep it; clear it to remove it.' : 'Optional.'}
        >
          <SecretInput
            id={`hub-env-${env.id}-token`}
            value={token}
            onChange={setToken}
            stored={stored}
          />
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

function EnvDeploys({ env }: { env: HubEnvironment }) {
  const q = useQuery({
    queryKey: hubKeys.deploys(env.id),
    queryFn: () => fetchDeploys(env.id),
    staleTime: 60_000
  })

  return (
    <div className='px-4 py-3'>
      <h4 className='m-0 mb-2 font-mono text-[12px] font-semibold text-slate-800 dark:text-foreground'>
        {env.key}
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
          {q.data.data.map((d) => (
            <li key={d.pipeline_id} className='flex flex-wrap items-center gap-x-4 gap-y-1 py-2'>
              <span className='min-w-[84px] font-mono text-[12px] font-medium text-slate-900 dark:text-foreground'>
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
                className='ml-auto inline-flex items-center gap-1 text-[11px] text-slate-600 hover:text-nvr-navy hover:underline dark:text-slate-300 dark:hover:text-nvr-cyan'
              >
                Pipeline #{d.pipeline_id}
                <ExternalLink className='h-3 w-3' aria-hidden />
              </a>
            </li>
          ))}
        </ul>
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

/** For the list: an environment's key coloured by its live status. */
export function EnvStatusDot({ env }: { env: HubEnvironment }) {
  const s = useEnvStatus(env.id)
  const state = s.data?.state ?? 'checking'
  return (
    <StatusChip
      compact
      state={state}
      label={env.key}
      tip={s.data ? STATUS_COPY[s.data.state] : s.isError ? 'Could not check' : 'Checking…'}
    />
  )
}
