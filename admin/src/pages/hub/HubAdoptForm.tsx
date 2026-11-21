import { ErrorNotice } from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import {
  fetchDrivers,
  HUB_KEY_PATTERN,
  type HubApp,
  type HubDriver,
  hubError,
  hubKeys,
  hubToast,
  isBaseUrl
} from './hub-api'
import { Field, ghostButton, SecretInput } from './hub-parts'

/**
 * Adopt an app that already runs: the Hub only records it — its environments' addresses, an
 * optional hub token each, and which GitLab driver deploys it. Nothing is sent to the app,
 * deployed or restarted.
 */

export interface EnvDraft {
  key: string
  base_url: string
  hub_token: string
  /** '' = no driver. */
  driver_id: string
  branch: string
}

export const emptyEnvDraft = (key = ''): EnvDraft => ({
  key,
  base_url: '',
  hub_token: '',
  driver_id: '',
  branch: ''
})

const ENV_KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/

/** What is wrong with one environment row, by field ('' = fine). */
export function envDraftErrors(d: EnvDraft, taken: string[] = []) {
  const key = d.key.trim()
  return {
    key: !key
      ? 'Give the environment a key'
      : !ENV_KEY_PATTERN.test(key)
        ? 'Lower-case letters, digits and dashes, starting with a letter'
        : taken.includes(key)
          ? 'Another environment uses this key'
          : '',
    base_url: !d.base_url.trim()
      ? 'Enter the address people open'
      : !isBaseUrl(d.base_url)
        ? 'Only the address: http(s)://host[:port], no path'
        : ''
  }
}

/**
 * Store one environment: a dedicated placement first when it names a driver, then the
 * environment itself. Never calls the app.
 */
export async function createEnvironment(appId: number, d: EnvDraft, position: number) {
  let placementId: number | null = null
  if (d.driver_id) {
    const branch = d.branch.trim()
    const placement = await api
      .post<{ data: { id: number } }>('/hub/placements', {
        kind: 'dedicated',
        driver_id: Number(d.driver_id),
        target: branch ? { branch } : {}
      })
      .then((r) => r.data.data)
    placementId = placement.id
  }
  const token = d.hub_token.trim()
  await api.post(`/hub/apps/${appId}/environments`, {
    key: d.key.trim(),
    base_url: d.base_url.trim().replace(/\/+$/, ''),
    position,
    ...(token ? { hub_token: token } : {}),
    ...(placementId != null ? { placement_id: placementId } : {})
  })
}

/** The drivers an environment may name (admins only; empty for everyone else). */
export function useDriverOptions(enabled: boolean) {
  return useQuery({ queryKey: hubKeys.drivers(), queryFn: fetchDrivers, enabled })
}

export function EnvDraftFields({
  idPrefix,
  draft,
  onChange,
  drivers,
  errors,
  onRemove
}: {
  idPrefix: string
  draft: EnvDraft
  onChange: (d: EnvDraft) => void
  drivers: HubDriver[]
  errors?: { key: string; base_url: string }
  onRemove?: () => void
}) {
  const set = (patch: Partial<EnvDraft>) => onChange({ ...draft, ...patch })
  const driver = drivers.find((x) => String(x.id) === draft.driver_id)
  return (
    <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(120px,0.6fr)_minmax(220px,1.4fr)_minmax(160px,1fr)]'>
      <Field id={`${idPrefix}-key`} label='Environment' error={errors?.key || null}>
        <Input
          id={`${idPrefix}-key`}
          value={draft.key}
          onChange={(e) => set({ key: e.target.value })}
          placeholder='production'
          className='h-8 font-mono text-[13px]'
        />
      </Field>
      <Field id={`${idPrefix}-url`} label='Address' error={errors?.base_url || null}>
        <Input
          id={`${idPrefix}-url`}
          value={draft.base_url}
          onChange={(e) => set({ base_url: e.target.value })}
          placeholder='https://app.example.com'
          inputMode='url'
          className='h-8 text-[13px]'
        />
      </Field>
      <Field
        id={`${idPrefix}-token`}
        label='Hub token (optional)'
        hint='The HUB_TOKEN set on that environment. Without one, the Hub reads only its public version and health.'
      >
        <SecretInput
          id={`${idPrefix}-token`}
          value={draft.hub_token}
          onChange={(v) => set({ hub_token: v })}
          stored={false}
        />
      </Field>
      <Field
        id={`${idPrefix}-driver`}
        label='Deploys through'
        hint={
          drivers.length === 0 ? 'Add a GitLab driver under Drivers to see deploys.' : undefined
        }
      >
        <SimpleSelect
          value={draft.driver_id}
          onChange={(v) => set({ driver_id: v })}
          options={[
            { value: '', label: 'No driver' },
            ...drivers.map((x) => ({ value: String(x.id), label: x.name }))
          ]}
          ariaLabel='Deploys through'
          className='h-8 text-[13px]'
          triggerProps={{ id: `${idPrefix}-driver` }}
        />
      </Field>
      {draft.driver_id && (
        <Field
          id={`${idPrefix}-branch`}
          label='Branch'
          hint={
            driver ? `Leave empty to use the driver's branch (${driver.config.branch}).` : undefined
          }
        >
          <Input
            id={`${idPrefix}-branch`}
            value={draft.branch}
            onChange={(e) => set({ branch: e.target.value })}
            placeholder={driver?.config.branch || 'production'}
            className='h-8 font-mono text-[13px]'
          />
        </Field>
      )}
      {onRemove && (
        <div className='flex items-end'>
          <button type='button' className={ghostButton} onClick={onRemove}>
            <Trash2 className='h-3.5 w-3.5' aria-hidden /> Remove environment
          </button>
        </div>
      )}
    </div>
  )
}

export function HubAdoptForm({
  onDone,
  onCancel
}: {
  onDone: (appId: number) => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const drivers = useDriverOptions(true)
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [envs, setEnvs] = useState<EnvDraft[]>([emptyEnvDraft('production')])
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)

  const keyError = !key.trim()
    ? 'Give the app a key'
    : !HUB_KEY_PATTERN.test(key.trim())
      ? 'Lower-case letters, digits and dashes, starting with a letter (2–63)'
      : ''
  const nameError = name.trim() ? '' : 'Give the app a name'
  const envErrors = envs.map((d, i) =>
    envDraftErrors(
      d,
      envs.slice(0, i).map((x) => x.key.trim())
    )
  )
  const invalid = !!keyError || !!nameError || envErrors.some((e) => e.key || e.base_url)

  const save = async () => {
    setTried(true)
    if (invalid) return
    setSaving(true)
    setFailure(null)
    let app: HubApp
    try {
      app = await api
        .post<{ data: HubApp }>('/hub/apps', { key: key.trim(), name: name.trim(), adopted: true })
        .then((r) => r.data.data)
    } catch (err) {
      setFailure(err)
      setSaving(false)
      return
    }
    // The app exists now: an environment that fails is reported, and can be added on its page.
    for (const [i, d] of envs.entries()) {
      try {
        await createEnvironment(app.id, d, i)
      } catch (err) {
        hubToast(err, `Could not add the ${d.key.trim()} environment`)
      }
    }
    await qc.invalidateQueries({ queryKey: hubKeys.apps() })
    setSaving(false)
    onDone(app.id)
  }

  return (
    <div className='p-4 sm:p-6'>
      <div className='max-w-[960px] space-y-5'>
        <div>
          <h2 className='m-0 text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
            Adopt an existing app
          </h2>
          <p className='m-0 mt-1 max-w-[72ch] text-[12px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
            The Hub only records the app: where each environment answers and how it is deployed.
            Nothing is sent to the app, and nothing is deployed or restarted.
          </p>
        </div>

        <div className='grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 dark:border-border dark:bg-card'>
          <Field
            id='hub-adopt-key'
            label='Key'
            hint='Short and permanent, e.g. efp.'
            error={tried ? keyError : null}
          >
            <Input
              id='hub-adopt-key'
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder='efp'
              className='h-8 font-mono text-[13px]'
            />
          </Field>
          <Field id='hub-adopt-name' label='Name' error={tried ? nameError : null}>
            <Input
              id='hub-adopt-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Field Planning'
              className='h-8 text-[13px]'
            />
          </Field>
        </div>

        <div className='space-y-3'>
          <h3 className='m-0 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            Environments
          </h3>
          {drivers.isError && (
            <ErrorNotice
              description={hubError(drivers.error, 'Could not load the drivers')}
              onRetry={() => void drivers.refetch()}
            />
          )}
          {envs.map((d, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved; order is stable
              key={i}
              className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
            >
              <EnvDraftFields
                idPrefix={`hub-adopt-env-${i}`}
                draft={d}
                onChange={(next) => setEnvs((all) => all.map((x, j) => (j === i ? next : x)))}
                drivers={drivers.data ?? []}
                errors={tried ? envErrors[i] : undefined}
                onRemove={
                  envs.length > 1
                    ? () => setEnvs((all) => all.filter((_, j) => j !== i))
                    : undefined
                }
              />
            </div>
          ))}
          <button
            type='button'
            className={ghostButton}
            onClick={() =>
              setEnvs((all) => [...all, emptyEnvDraft(all.length === 1 ? 'staging' : '')])
            }
          >
            <Plus className='h-3.5 w-3.5' aria-hidden /> Add an environment
          </button>
        </div>

        {failure != null && (
          <ErrorNotice description={hubError(failure, 'Could not adopt the app')} />
        )}

        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? 'Adopting…' : 'Adopt app'}
          </Button>
          <Button size='sm' variant='ghost' className='h-8' onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
