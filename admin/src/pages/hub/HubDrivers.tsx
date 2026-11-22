import { ConfirmButton, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, GitBranch, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { HubTargets } from './create/HubTargets'
import { useDriverOptions } from './HubAdoptForm'
import {
  HUB_MASK,
  type HubDriver,
  type HubDriverConfig,
  hubError,
  hubKeys,
  hubToast
} from './hub-api'
import { dangerArmed, dangerGhost, Field, ghostButton, SecretInput } from './hub-parts'

/**
 * Drivers (Hub tab, administrators): how the Hub reaches the GitLab project that deploys an
 * app — API URL, project, branch, the file that pins the version, the deploy job, and a
 * token the API keeps sealed and only ever shows as '••••••'.
 */
export default function HubDrivers() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  if (!isAdmin) {
    return (
      <div className='flex flex-1 items-center justify-center bg-slate-50 p-8 text-center dark:bg-background'>
        <p className='m-0 max-w-[48ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
          Only administrators manage drivers.
        </p>
      </div>
    )
  }
  return (
    <>
      <DriversAdmin />
      <HubTargets />
    </>
  )
}

function DriversAdmin() {
  const drivers = useDriverOptions(true)
  const [params, setParams] = useSearchParams()
  const selected = Number(params.get('driver')) || null
  const creating = params.get('new') === '1'
  const show = (next: { driver?: number | null; create?: boolean }) =>
    setParams((p) => {
      const out = new URLSearchParams(p)
      out.delete('driver')
      out.delete('new')
      if (next.driver) out.set('driver', String(next.driver))
      if (next.create) out.set('new', '1')
      return out
    })
  const current = drivers.data?.find((d) => d.id === selected) ?? null
  const detailOpen = creating || current != null

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside
        className={cn(
          'w-full shrink-0 flex-col overflow-y-auto border-slate-200 bg-white md:flex md:w-[272px] md:border-r dark:border-border dark:bg-card',
          detailOpen ? 'hidden' : 'flex'
        )}
      >
        <div className='flex items-center gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-border'>
          <p className='m-0 flex-1 text-[12px] font-medium text-slate-500 dark:text-muted-foreground'>
            GitLab drivers
          </p>
          <button
            type='button'
            className={cn(ghostButton, creating && 'bg-accent')}
            onClick={() => show({ create: true })}
          >
            <Plus className='h-3.5 w-3.5' aria-hidden /> New driver
          </button>
        </div>
        {drivers.isPending ? (
          <div className='space-y-2 p-3'>
            {[0, 1].map((i) => (
              <Skeleton key={i} className='h-12 w-full' />
            ))}
          </div>
        ) : drivers.isError ? (
          <QueryErrorState
            error={drivers.error}
            what='the drivers'
            onRetry={() => void drivers.refetch()}
            className='m-3'
          />
        ) : drivers.data.length === 0 ? (
          <p className='m-0 px-4 py-8 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
            No drivers yet. Add one to see an app's deploys.
          </p>
        ) : (
          <ul className='m-0 list-none space-y-0.5 p-2'>
            {drivers.data.map((d) => (
              <li key={d.id}>
                <button
                  type='button'
                  onClick={() => show({ driver: d.id })}
                  aria-current={d.id === selected && !creating ? 'true' : undefined}
                  className={cn(
                    'w-full rounded-md px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                    d.id === selected && !creating ? 'bg-accent' : 'hover:bg-muted'
                  )}
                >
                  <span className='block truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
                    {d.name}
                  </span>
                  <span className='mt-0.5 flex items-center gap-1 truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                    <GitBranch className='h-3 w-3 shrink-0' aria-hidden />
                    {d.config.project} · {d.config.branch}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div
        className={cn(
          'min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background',
          detailOpen ? 'block' : 'hidden md:block'
        )}
      >
        {detailOpen && (
          <div className='border-b border-slate-200 bg-white px-2 py-1.5 md:hidden dark:border-border dark:bg-card'>
            <button type='button' className={ghostButton} onClick={() => show({})}>
              <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> All drivers
            </button>
          </div>
        )}
        {creating ? (
          <DriverForm
            key='new'
            driver={null}
            onSaved={(id) => show({ driver: id })}
            onCancel={() => show({})}
          />
        ) : current ? (
          <DriverForm
            key={current.id}
            driver={current}
            onSaved={() => {}}
            onCancel={() => show({})}
            onDeleted={() => show({})}
          />
        ) : (
          <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
              <GitBranch
                className='h-5 w-5 text-slate-400 dark:text-muted-foreground'
                aria-hidden
              />
            </div>
            <p className='mt-3 mb-0 text-[13px] font-medium text-slate-700 dark:text-foreground'>
              Pick a driver
            </p>
            <p className='m-0 mt-1 max-w-[44ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
              A driver tells the Hub which GitLab project deploys an app, so it can show the deploy
              history of each environment.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

const EMPTY_CONFIG: HubDriverConfig = {
  api: '',
  project: '',
  branch: 'production',
  pin_file: '.docker/nivaro-version',
  deploy_job: 'deploy_production'
}

function DriverForm({
  driver,
  onSaved,
  onCancel,
  onDeleted
}: {
  driver: HubDriver | null
  onSaved: (id: number) => void
  onCancel: () => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const stored = !!driver?.secret
  const [name, setName] = useState(driver?.name ?? '')
  const [config, setConfig] = useState<HubDriverConfig>({ ...EMPTY_CONFIG, ...driver?.config })
  const [token, setToken] = useState(stored ? HUB_MASK : '')
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const set = (patch: Partial<HubDriverConfig>) => setConfig((c) => ({ ...c, ...patch }))

  const errors = {
    name: name.trim() ? '' : 'Give the driver a name',
    api: /^https?:\/\/\S+$/i.test(config.api.trim())
      ? ''
      : 'The GitLab API address, e.g. https://gitlab.example.com/api/v4',
    project: config.project.trim() ? '' : 'The project path, e.g. group/repo',
    branch: config.branch.trim() ? '' : 'The branch deploys run on'
  }
  const invalid = Object.values(errors).some(Boolean)

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        config: {
          api: config.api.trim().replace(/\/+$/, ''),
          project: config.project.trim(),
          branch: config.branch.trim(),
          pin_file: config.pin_file.trim(),
          deploy_job: config.deploy_job.trim()
        },
        // Unchanged = not sent (the stored token stays); cleared = removed.
        ...(token !== (stored ? HUB_MASK : '') ? { secret: token.trim() } : {})
      }
      return driver
        ? api.patch<{ data: HubDriver }>(`/hub/drivers/${driver.id}`, body).then((r) => r.data.data)
        : api
            .post<{ data: HubDriver }>('/hub/drivers', { kind: 'gitlab', ...body })
            .then((r) => r.data.data)
    },
    onSuccess: (saved) => {
      setFailure(null)
      setToken(token.trim() ? HUB_MASK : '')
      void qc.invalidateQueries({ queryKey: hubKeys.drivers() })
      onSaved(saved?.id ?? driver?.id ?? 0)
    },
    onError: (err) => setFailure(err)
  })
  const remove = useMutation({
    mutationFn: () => api.delete(`/hub/drivers/${driver?.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hubKeys.drivers() })
      onDeleted?.()
    },
    onError: (err) => hubToast(err, 'Could not delete the driver')
  })

  const id = (f: string) => `hub-driver-${driver?.id ?? 'new'}-${f}`
  return (
    <div className='p-4 sm:p-6'>
      <div className='max-w-[720px] space-y-5'>
        <div className='flex flex-wrap items-start gap-3'>
          <h2 className='m-0 min-w-0 flex-1 truncate text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
            {driver ? driver.name : 'New GitLab driver'}
          </h2>
          {driver && (
            <ConfirmButton
              title='Delete driver'
              confirmLabel='Delete this driver?'
              className={dangerGhost}
              armedClassName={dangerArmed}
              disabled={remove.isPending}
              onConfirm={() => remove.mutate()}
            >
              <Trash2 className='h-3.5 w-3.5' aria-hidden /> Delete
            </ConfirmButton>
          )}
        </div>

        <div className='grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 dark:border-border dark:bg-card'>
          <Field id={id('name')} label='Name' error={tried ? errors.name : null}>
            <Input
              id={id('name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='EFP deploy repo'
              className='h-8 text-[13px]'
            />
          </Field>
          <Field id={id('api')} label='GitLab API URL' error={tried ? errors.api : null}>
            <Input
              id={id('api')}
              value={config.api}
              onChange={(e) => set({ api: e.target.value })}
              placeholder='https://gitlab.example.com/api/v4'
              inputMode='url'
              className='h-8 text-[13px]'
            />
          </Field>
          <Field id={id('project')} label='Project' error={tried ? errors.project : null}>
            <Input
              id={id('project')}
              value={config.project}
              onChange={(e) => set({ project: e.target.value })}
              placeholder='group/repo'
              className='h-8 font-mono text-[13px]'
            />
          </Field>
          <Field id={id('branch')} label='Branch' error={tried ? errors.branch : null}>
            <Input
              id={id('branch')}
              value={config.branch}
              onChange={(e) => set({ branch: e.target.value })}
              placeholder='production'
              className='h-8 font-mono text-[13px]'
            />
          </Field>
          <Field id={id('pin')} label='Version pin file' hint='The file that names the version.'>
            <Input
              id={id('pin')}
              value={config.pin_file}
              onChange={(e) => set({ pin_file: e.target.value })}
              placeholder='.docker/nivaro-version'
              className='h-8 font-mono text-[13px]'
            />
          </Field>
          <Field id={id('job')} label='Deploy job' hint='The pipeline job that deploys.'>
            <Input
              id={id('job')}
              value={config.deploy_job}
              onChange={(e) => set({ deploy_job: e.target.value })}
              placeholder='deploy_production'
              className='h-8 font-mono text-[13px]'
            />
          </Field>
          <div className='sm:col-span-2'>
            <Field
              id={id('token')}
              label='Access token'
              hint={
                stored
                  ? 'Stored sealed. Leave as is to keep it; clear it to remove it.'
                  : 'A GitLab token that can read pipelines (read_api). Stored sealed.'
              }
            >
              <SecretInput id={id('token')} value={token} onChange={setToken} stored={stored} />
            </Field>
          </div>
        </div>

        {failure != null && (
          <ErrorNotice description={hubError(failure, 'Could not save the driver')} />
        )}

        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={save.isPending}
            onClick={() => {
              setTried(true)
              if (!invalid) save.mutate()
            }}
          >
            {save.isPending ? 'Saving…' : driver ? 'Save' : 'Add driver'}
          </Button>
          <Button size='sm' variant='ghost' className='h-8' onClick={onCancel}>
            {driver ? 'Close' : 'Cancel'}
          </Button>
        </div>
      </div>
    </div>
  )
}
