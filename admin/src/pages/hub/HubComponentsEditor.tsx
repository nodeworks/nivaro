import { ConfirmButton, ErrorNotice } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useDriverOptions } from './HubAdoptForm'
import {
  type ComponentKind,
  fetchComponents,
  type HubComponent,
  type HubDriver,
  type HubEnvironment,
  hubError,
  hubKeys,
  hubToast
} from './hub-api'
import { dangerArmed, dangerGhost, Field, ghostButton } from './hub-parts'

/**
 * What the Hub deploys for one environment (Hub admins): the "Hub deploys this environment"
 * switch and the placement's ordered components — each with its own driver, branches, jobs and
 * check address. Deploy order is the list order; each waits for the one before it to pass.
 */

const KIND_LABEL: Record<ComponentKind, string> = {
  api: 'API',
  frontend: 'Frontend',
  stack: 'Docker stack'
}

/** http(s)://host/anything (the API refuses anything else with BAD_VERIFY_URL). */
const isVerifyUrl = (v: string) => /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(v.trim())

interface Draft {
  name: string
  kind: ComponentKind
  driver_id: string
  source_branch: string
  target_branch: string
  before_job: string
  deploy_job: string
  verify_url: string
  verify_field: string
}

const draftOf = (c: HubComponent): Draft => ({
  name: c.name,
  kind: c.kind,
  driver_id: String(c.driver_id),
  source_branch: c.source_branch,
  target_branch: c.target_branch ?? '',
  before_job: c.before_job ?? '',
  deploy_job: c.deploy_job ?? '',
  verify_url: c.verify_url ?? '',
  verify_field: c.verify_field || 'version'
})

function draftErrors(d: Draft) {
  const stack = d.kind === 'stack'
  return {
    name: !d.name.trim()
      ? 'Give the component a name'
      : d.name.trim().length > 64
        ? 'At most 64 characters'
        : '',
    driver_id: d.driver_id ? '' : 'Pick the driver that deploys it',
    source_branch: stack || d.source_branch.trim() ? '' : 'Name the branch releases land on',
    verify_url:
      d.verify_url.trim() && !isVerifyUrl(d.verify_url)
        ? 'Use a full http(s) address, for example https://app.example.com/api/version'
        : ''
  }
}

const orNull = (v: string) => v.trim() || null

/** The body the components routes take (position only on create and reorder). */
const bodyOf = (d: Draft) =>
  d.kind === 'stack'
    ? {
        // A stack has no branches or jobs: the Docker driver deploys it through the Hub agent.
        name: d.name.trim(),
        kind: d.kind,
        driver_id: Number(d.driver_id),
        target_branch: null,
        before_job: null,
        deploy_job: null,
        verify_url: orNull(d.verify_url),
        verify_field: d.verify_field.trim() || 'version'
      }
    : gitlabBodyOf(d)

const gitlabBodyOf = (d: Draft) => ({
  name: d.name.trim(),
  kind: d.kind,
  driver_id: Number(d.driver_id),
  source_branch: d.source_branch.trim(),
  target_branch: orNull(d.target_branch),
  before_job: orNull(d.before_job),
  deploy_job: orNull(d.deploy_job),
  verify_url: orNull(d.verify_url),
  verify_field: d.verify_field.trim() || 'version'
})

const createComponent = (placementId: number, position: number, d: Draft) =>
  api.post(`/hub/placements/${placementId}/components`, { ...bodyOf(d), position })

export function HubComponentsEditor({
  appId,
  env,
  idPrefix
}: {
  appId: number
  env: HubEnvironment
  /** Unique per layout (the table and the phone list can both hold an edit panel). */
  idPrefix: string
}) {
  const placementId = env.placement_id
  return (
    <div className='space-y-3 border-t border-slate-200 pt-3 dark:border-border'>
      <HubManagedSwitch appId={appId} env={env} idPrefix={idPrefix} />
      {placementId == null ? (
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No driver deploys this environment, so there is nothing for the Hub to promote.
        </p>
      ) : (
        <ComponentsList appId={appId} placementId={placementId} idPrefix={idPrefix} />
      )}
    </div>
  )
}

function HubManagedSwitch({
  appId,
  env,
  idPrefix
}: {
  appId: number
  env: HubEnvironment
  idPrefix: string
}) {
  const qc = useQueryClient()
  const [on, setOn] = useState(!!env.hub_managed)
  const save = useMutation({
    mutationFn: (next: boolean) => api.patch(`/hub/environments/${env.id}`, { hub_managed: next }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: hubKeys.app(appId) }),
    onError: (err, next) => {
      setOn(!next)
      hubToast(err, 'Could not change who deploys this environment')
    }
  })
  const id = `${idPrefix}-hub-managed`
  return (
    <div className='flex items-start gap-3'>
      <Switch
        id={id}
        checked={on}
        disabled={save.isPending}
        aria-describedby={`${id}-hint`}
        onCheckedChange={(next) => {
          setOn(next)
          save.mutate(next)
        }}
        className='mt-0.5 data-[state=checked]:bg-nvr-cyan'
      />
      <div className='min-w-0'>
        <label
          htmlFor={id}
          className='block text-[12px] font-medium text-slate-800 dark:text-foreground'
        >
          The Hub deploys this environment
        </label>
        <p id={`${id}-hint`} className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
          When on, Hub admins and the app's owners can promote and roll back here. Leave it off
          while another release tool still deploys it.
        </p>
      </div>
    </div>
  )
}

function ComponentsList({
  appId,
  placementId,
  idPrefix
}: {
  appId: number
  placementId: number
  idPrefix: string
}) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: hubKeys.components(placementId),
    queryFn: () => fetchComponents(placementId)
  })
  const drivers = useDriverOptions(true)
  /** The row being edited: a stored id, 'implicit', 'new', or nothing. */
  const [editing, setEditing] = useState<number | 'implicit' | 'new' | null>(null)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: hubKeys.components(placementId) })
    void qc.invalidateQueries({ queryKey: hubKeys.app(appId) })
  }

  const rows = [...(q.data ?? [])].sort((a, b) => a.position - b.position)
  const implicit = rows.find((r) => r.implicit || r.id == null) ?? null
  /**
   * The driver's stand-in was stored by an add whose second step failed: never store it again
   * (POSITION_TAKEN) while the list still shows the old read.
   */
  const implicitStored = useRef(false)
  useEffect(() => {
    if (!implicit) implicitStored.current = false
  }, [implicit])
  const nextPosition = Math.max(0, ...rows.map((r) => r.position)) + 1

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/hub/components/${id}`),
    onSuccess: refresh,
    onError: (err) => hubToast(err, 'Could not remove the component')
  })

  // Swap with the row above through a free position (positions are unique per placement).
  const moveUp = useMutation({
    mutationFn: async (i: number) => {
      const a = rows[i - 1]
      const b = rows[i]
      if (a.id == null || b.id == null) return
      const at = (id: number, position: number) => api.patch(`/hub/components/${id}`, { position })
      // Best effort: put a row back where it was; the refresh after shows what is stored.
      const putBack = (id: number, position: number) => at(id, position).catch(() => undefined)
      await at(a.id, nextPosition)
      try {
        await at(b.id, a.position)
      } catch (err) {
        await putBack(a.id, a.position)
        throw err
      }
      try {
        await at(a.id, b.position)
      } catch (err) {
        // The deploy order never changes silently: both rows go back to where they were.
        await putBack(b.id, b.position)
        await putBack(a.id, a.position)
        throw err
      }
    },
    onSettled: refresh,
    onError: (err) => hubToast(err, 'Could not move the component')
  })

  if (q.isPending || drivers.isPending) return <Skeleton className='h-20 w-full' />
  if (q.isError)
    return (
      <ErrorNotice
        description={hubError(q.error, 'Could not load the components')}
        onRetry={() => void q.refetch()}
      />
    )
  const driverList = drivers.data ?? []
  const fallbackDriver = implicit?.driver_id ?? rows[0]?.driver_id ?? driverList[0]?.id

  return (
    <div className='space-y-2'>
      <div>
        <h5 className='m-0 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
          Components
        </h5>
        <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
          Deployed in this order; each waits for the one before it to pass.
        </p>
      </div>
      {drivers.isError && (
        <ErrorNotice
          description={hubError(drivers.error, 'Could not load the drivers')}
          onRetry={() => void drivers.refetch()}
        />
      )}
      <ol aria-label='Deploy components' className='m-0 list-none space-y-2 p-0'>
        {rows.map((c, i) => {
          const rowKey = c.id ?? 'implicit'
          return (
            <li
              key={String(rowKey)}
              className='min-w-0 rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'
            >
              {editing === rowKey ? (
                <ComponentForm
                  idPrefix={`${idPrefix}-comp-${rowKey}`}
                  initial={draftOf(c)}
                  drivers={driverList}
                  onCancel={() => setEditing(null)}
                  onSave={async (d) => {
                    if (c.id == null) await createComponent(placementId, c.position, d)
                    else await api.patch(`/hub/components/${c.id}`, bodyOf(d))
                  }}
                  onSaved={() => {
                    setEditing(null)
                    refresh()
                  }}
                  onFailed={refresh}
                />
              ) : (
                <ComponentRow
                  c={c}
                  drivers={driverList}
                  canMoveUp={i > 0 && c.id != null && rows[i - 1].id != null}
                  busy={moveUp.isPending || remove.isPending}
                  onMoveUp={() => moveUp.mutate(i)}
                  onEdit={() => setEditing(rowKey)}
                  onRemove={() => c.id != null && remove.mutate(c.id)}
                />
              )}
            </li>
          )
        })}
        {editing === 'new' && (
          <li className='min-w-0 rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 dark:border-border dark:bg-card'>
            <ComponentForm
              idPrefix={`${idPrefix}-comp-new`}
              initial={{
                name: '',
                kind:
                  driverList.find((x) => x.id === fallbackDriver)?.kind === 'docker'
                    ? 'stack'
                    : rows.some((r) => r.kind === 'api')
                      ? 'frontend'
                      : 'api',
                driver_id: fallbackDriver != null ? String(fallbackDriver) : '',
                source_branch: 'main',
                target_branch: '',
                before_job: '',
                deploy_job: '',
                verify_url: '',
                verify_field: 'version'
              }}
              drivers={driverList}
              onCancel={() => setEditing(null)}
              onSave={async (d) => {
                // Stored components replace the driver's stand-in, so store it first — and
                // read the list again at once, so a failed second step can be retried.
                if (implicit && !implicitStored.current) {
                  await createComponent(placementId, implicit.position, draftOf(implicit))
                  implicitStored.current = true
                  refresh()
                }
                await createComponent(placementId, nextPosition, d)
              }}
              onSaved={() => {
                setEditing(null)
                refresh()
              }}
              onFailed={refresh}
            />
          </li>
        )}
      </ol>
      {editing !== 'new' && (
        <button type='button' className={ghostButton} onClick={() => setEditing('new')}>
          <Plus className='h-3.5 w-3.5' aria-hidden /> Add component
        </button>
      )}
    </div>
  )
}

function ComponentRow({
  c,
  drivers,
  canMoveUp,
  busy,
  onMoveUp,
  onEdit,
  onRemove
}: {
  c: HubComponent
  drivers: HubDriver[]
  canMoveUp: boolean
  busy: boolean
  onMoveUp: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const driver = drivers.find((d) => d.id === c.driver_id)
  const target = c.target_branch ?? driver?.config.branch ?? 'driver branch'
  const deployJob = c.deploy_job ?? driver?.config.deploy_job ?? 'driver deploy job'
  const isImplicit = c.implicit || c.id == null
  return (
    <div className='min-w-0'>
      <div className='flex min-w-0 items-center gap-2'>
        <span className='inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold tabular-nums text-slate-600 dark:bg-muted dark:text-slate-300'>
          {c.position}
        </span>
        <span className='min-w-0 truncate font-mono text-[12px] font-medium text-slate-900 dark:text-foreground'>
          {c.name}
        </span>
        <span className='shrink-0 rounded-full border border-slate-200 px-1.5 py-px text-[10px] font-medium text-slate-600 dark:border-border dark:text-slate-300'>
          {KIND_LABEL[c.kind] ?? c.kind}
        </span>
        <div className='ml-auto flex shrink-0 items-center gap-0.5'>
          {canMoveUp && (
            <button
              type='button'
              aria-label={`Move ${c.name} up`}
              data-tip='Deploy earlier'
              className={ghostButton}
              disabled={busy}
              onClick={onMoveUp}
            >
              <ArrowUp className='h-3.5 w-3.5' aria-hidden />
            </button>
          )}
          <button
            type='button'
            aria-label={`Edit ${c.name}`}
            data-tip='Edit'
            className={ghostButton}
            onClick={onEdit}
          >
            <Pencil className='h-3.5 w-3.5' aria-hidden />
          </button>
          {!isImplicit && (
            <ConfirmButton
              title={`Remove ${c.name}`}
              confirmLabel='Remove?'
              className={dangerGhost}
              armedClassName={dangerArmed}
              disabled={busy}
              onConfirm={onRemove}
            >
              <Trash2 className='h-3.5 w-3.5' aria-hidden />
            </ConfirmButton>
          )}
        </div>
      </div>
      <p className='m-0 mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
        <span>{driver?.name ?? 'Driver not found'}</span>
        {c.kind === 'stack' ? (
          <>
            <span aria-hidden>·</span>
            <span>deployed by the Hub agent</span>
          </>
        ) : (
          <>
            <span aria-hidden>·</span>
            <span className='break-all font-mono'>
              {c.source_branch} → {target}
            </span>
            <span aria-hidden>·</span>
            <span className='break-all font-mono'>
              {c.before_job ? `${c.before_job}, ` : ''}
              {deployJob}
            </span>
          </>
        )}
        {c.verify_url && (
          <>
            <span aria-hidden>·</span>
            <span className='min-w-0 break-all'>checks {c.verify_url}</span>
          </>
        )}
      </p>
      {isImplicit && (
        <p className='m-0 mt-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
          From the environment's driver. Edit it to store it, or add components.
        </p>
      )}
    </div>
  )
}

function ComponentForm({
  idPrefix,
  initial,
  drivers,
  onSave,
  onSaved,
  onFailed,
  onCancel
}: {
  idPrefix: string
  initial: Draft
  drivers: HubDriver[]
  onSave: (d: Draft) => Promise<void>
  onSaved: () => void
  /** After a failed save: read the stored list again (a first step may have landed). */
  onFailed?: () => void
  onCancel: () => void
}) {
  const [d, setD] = useState<Draft>(initial)
  const [tried, setTried] = useState(false)
  /** The last api / frontend kind picked, restored when the driver goes back to GitLab. */
  const lastGitlabKind = useRef<ComponentKind>(initial.kind === 'stack' ? 'api' : initial.kind)
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }))
  const errors = draftErrors(d)
  const driver = drivers.find((x) => String(x.id) === d.driver_id)
  const isStack = d.kind === 'stack'
  const dockerDriver = driver?.kind === 'docker'
  const save = useMutation({
    mutationFn: () => onSave(d),
    onSuccess: onSaved,
    onError: (err) => {
      onFailed?.()
      hubToast(err, 'Could not save the component')
    }
  })
  // The check address is judged as it is typed; the rest once Save is pressed.
  const shown = (k: keyof typeof errors) => (k === 'verify_url' || tried ? errors[k] || null : null)
  const invalid = Object.values(errors).some(Boolean)

  return (
    <div className='space-y-3 py-1'>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'>
        <Field id={`${idPrefix}-name`} label='Name' error={shown('name')}>
          <Input
            id={`${idPrefix}-name`}
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder='api'
            className='h-8 font-mono text-[13px]'
          />
        </Field>
        <Field id={`${idPrefix}-kind`} label='Kind'>
          <SimpleSelect
            value={d.kind}
            onChange={(v) => {
              if (v !== 'stack') lastGitlabKind.current = v as ComponentKind
              set({ kind: v as ComponentKind })
            }}
            options={
              dockerDriver
                ? [{ value: 'stack', label: 'Stack (Nivaro app on the Docker host)' }]
                : [
                    { value: 'api', label: 'API (Nivaro image, pinned by version)' },
                    { value: 'frontend', label: 'Frontend (what the environment before serves)' }
                  ]
            }
            ariaLabel='Kind'
            className='h-8 text-[13px]'
            triggerProps={{ id: `${idPrefix}-kind` }}
          />
        </Field>
        <Field id={`${idPrefix}-driver`} label='Driver' error={shown('driver_id')}>
          <SimpleSelect
            value={d.driver_id}
            onChange={(v) => {
              // A stack belongs to a Docker driver, api and frontend to a GitLab one.
              const next = drivers.find((x) => String(x.id) === v)
              set({
                driver_id: v,
                kind:
                  next?.kind === 'docker'
                    ? 'stack'
                    : d.kind === 'stack'
                      ? lastGitlabKind.current
                      : d.kind
              })
            }}
            options={drivers.map((x) => ({ value: String(x.id), label: x.name }))}
            ariaLabel='Driver'
            className='h-8 text-[13px]'
            triggerProps={{ id: `${idPrefix}-driver` }}
          />
        </Field>
        {!isStack && (
          <>
            <Field id={`${idPrefix}-source`} label='Source branch' error={shown('source_branch')}>
              <Input
                id={`${idPrefix}-source`}
                value={d.source_branch}
                onChange={(e) => set({ source_branch: e.target.value })}
                className='h-8 font-mono text-[13px]'
              />
            </Field>
            <Field
              id={`${idPrefix}-target`}
              label='Target branch'
              hint={driver ? `Empty = the driver's branch (${driver.config.branch}).` : undefined}
            >
              <Input
                id={`${idPrefix}-target`}
                value={d.target_branch}
                onChange={(e) => set({ target_branch: e.target.value })}
                placeholder={driver?.config.branch}
                className='h-8 font-mono text-[13px]'
              />
            </Field>
            <Field
              id={`${idPrefix}-before`}
              label='Before job'
              hint='Optional, e.g. build_extension.'
            >
              <Input
                id={`${idPrefix}-before`}
                value={d.before_job}
                onChange={(e) => set({ before_job: e.target.value })}
                className='h-8 font-mono text-[13px]'
              />
            </Field>
            <Field
              id={`${idPrefix}-deploy`}
              label='Deploy job'
              hint={driver ? `Empty = the driver's job (${driver.config.deploy_job}).` : undefined}
            >
              <Input
                id={`${idPrefix}-deploy`}
                value={d.deploy_job}
                onChange={(e) => set({ deploy_job: e.target.value })}
                placeholder={driver?.config.deploy_job}
                className='h-8 font-mono text-[13px]'
              />
            </Field>
          </>
        )}
        <Field
          id={`${idPrefix}-verify`}
          label='Check address'
          error={shown('verify_url')}
          hint='Answers the deployed version after the deploy. Optional.'
        >
          <Input
            id={`${idPrefix}-verify`}
            value={d.verify_url}
            onChange={(e) => set({ verify_url: e.target.value })}
            inputMode='url'
            placeholder='https://app.example.com/api/version'
            className='h-8 text-[13px]'
          />
        </Field>
        <Field id={`${idPrefix}-field`} label='Version field' hint='The field the check reads.'>
          <Input
            id={`${idPrefix}-field`}
            value={d.verify_field}
            onChange={(e) => set({ verify_field: e.target.value })}
            className='h-8 font-mono text-[13px]'
          />
        </Field>
      </div>
      <div className='flex items-center gap-2'>
        <Button
          size='sm'
          aria-label='Save component'
          className={cn('h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90')}
          disabled={save.isPending || !!errors.verify_url || (tried && invalid)}
          onClick={() => {
            setTried(true)
            if (!invalid) save.mutate()
          }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
