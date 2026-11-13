import { EnvironmentBand } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Show = 'auto' | 'on' | 'off'

interface NoticeSettings {
  show: Show
  label: string | null
  message: string | null
  production_url: string | null
  in_admin_app: boolean
}

interface NoticeAnswer {
  settings: NoticeSettings
  instance_key: string
  environment: string
  env_switch: boolean | null
  shown: { label: string; message: string; production_url: string | null } | null
}

const ENV_NAME: Record<string, string> = {
  production: 'Production',
  staging: 'Staging',
  development: 'Development',
  test: 'Test',
  other: 'Test environment'
}
const DEFAULT_MESSAGE = 'This is a test copy. Nothing you do here reaches production.'

/**
 * Settings → This Instance: the "this is staging" notice for THIS environment
 * (services/environment-notice.ts). The sign-in pages show it across the top; the admin app
 * can also carry a thin edge. Each environment keeps its own.
 */
export function EnvironmentNoticeSettingsCard() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['environment-notice'],
    queryFn: () => api.get<{ data: NoticeAnswer }>('/environment-notice').then((r) => r.data.data)
  })
  const [draft, setDraft] = useState<NoticeSettings | null>(null)
  useEffect(() => {
    if (data) setDraft(data.settings)
  }, [data])

  const save = useMutation({
    mutationFn: (next: NoticeSettings) =>
      api.patch<{ data: NoticeAnswer }>('/environment-notice', next).then((r) => r.data.data),
    onSuccess: (answer) => {
      qc.setQueryData(['environment-notice'], answer)
      toast.success(answer.shown ? 'Environment notice saved' : 'Environment notice turned off')
    },
    onError: () => toast.error('Could not save the environment notice')
  })

  if (!data || !draft) return null
  const envName = ENV_NAME[data.environment] ?? data.environment
  const isProd = data.environment === 'production'
  const showsNow =
    data.env_switch ?? (draft.show === 'on' ? true : draft.show === 'off' ? false : !isProd)
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings)
  const set = (patch: Partial<NoticeSettings>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  const urlBad = !!draft.production_url && !/^https:\/\/[^\s]+$/.test(draft.production_url.trim())

  const options: Array<{ value: Show; label: string; hint: string }> = [
    {
      value: 'auto',
      label: 'Automatic',
      hint: isProd ? 'Off here: this is production' : `On here: this is ${envName.toLowerCase()}`
    },
    { value: 'on', label: 'Always show', hint: 'On this environment' },
    { value: 'off', label: 'Never show', hint: 'On this environment' }
  ]

  return (
    <div
      data-environment-notice-settings
      className='mt-6 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
    >
      <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
        Environment notice
      </h3>
      <p className='mt-1 max-w-[68ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        A band across the top of the sign-in pages so nobody mistakes{' '}
        <span className='font-medium text-slate-700 dark:text-slate-300'>{envName}</span> for the
        real thing. Each environment keeps its own setting.
      </p>

      <div className='mt-4 inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-border dark:bg-muted/40'>
        {options.map((o) => (
          <button
            key={o.value}
            type='button'
            aria-pressed={draft.show === o.value}
            data-tip={o.hint}
            onClick={() => set({ show: o.value })}
            className={cn(
              'rounded px-3 py-1 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
              draft.show === o.value
                ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {data.env_switch !== null && (
        <p className='mt-2 text-[12px] text-amber-700 dark:text-amber-400'>
          ENVIRONMENT_NOTICE={data.env_switch ? 'on' : 'off'} is set on this server and wins over
          this choice.
        </p>
      )}

      <div className='mt-4 grid max-w-[720px] gap-3 sm:grid-cols-[160px_1fr]'>
        <label
          className='text-[12.5px] font-medium text-slate-700 dark:text-slate-300'
          htmlFor='env-notice-label'
        >
          Label
        </label>
        <Input
          id='env-notice-label'
          value={draft.label ?? ''}
          maxLength={40}
          placeholder={envName}
          onChange={(e) => set({ label: e.target.value || null })}
          className='h-8 text-[12.5px]'
        />
        <label
          className='text-[12.5px] font-medium text-slate-700 dark:text-slate-300'
          htmlFor='env-notice-message'
        >
          Sentence
        </label>
        <Input
          id='env-notice-message'
          value={draft.message ?? ''}
          maxLength={200}
          placeholder={DEFAULT_MESSAGE}
          onChange={(e) => set({ message: e.target.value || null })}
          className='h-8 text-[12.5px]'
        />
        <label
          className='text-[12.5px] font-medium text-slate-700 dark:text-slate-300'
          htmlFor='env-notice-url'
        >
          Production link
        </label>
        <div>
          <Input
            id='env-notice-url'
            value={draft.production_url ?? ''}
            placeholder='https://…  (adds a “Go to production” button)'
            disabled={isProd}
            onChange={(e) => set({ production_url: e.target.value || null })}
            aria-invalid={urlBad || undefined}
            className={cn(
              'h-8 text-[12.5px]',
              urlBad && 'border-red-400 focus-visible:ring-red-300'
            )}
          />
          {urlBad && (
            <p className='mt-1 text-[11.5px] text-red-600 dark:text-red-400'>
              Use a full https:// address.
            </p>
          )}
        </div>
        <span className='text-[12.5px] font-medium text-slate-700 dark:text-slate-300'>
          Admin app
        </span>
        <div className='flex items-center gap-2 text-[12.5px] text-slate-600 dark:text-slate-400'>
          <Switch
            checked={draft.in_admin_app}
            onCheckedChange={(v) => set({ in_admin_app: v })}
            aria-label='Also mark the admin app'
          />
          Also mark the admin app after sign-in: a striped edge on top and the label in the tab
          title
        </div>
      </div>

      <div className='mt-5'>
        <p className='mb-1.5 text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
          {showsNow ? 'Sign-in pages will show' : 'Nothing shows on this environment'}
        </p>
        {showsNow ? (
          <div className='overflow-hidden rounded-md border border-slate-200 dark:border-border'>
            <EnvironmentBand
              preview
              label={(draft.label ?? '').trim() || envName}
              message={(draft.message ?? '').trim() || DEFAULT_MESSAGE}
              productionUrl={
                isProd || urlBad || !draft.production_url ? null : draft.production_url.trim()
              }
            />
          </div>
        ) : (
          <div className='rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-[12px] text-slate-400 dark:border-border'>
            The sign-in pages look as they do on production.
          </div>
        )}
      </div>

      <div className='mt-4 flex items-center gap-2'>
        <Button
          type='button'
          size='sm'
          disabled={!dirty || urlBad || save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {dirty && (
          <Button type='button' size='sm' variant='ghost' onClick={() => setDraft(data.settings)}>
            Discard
          </Button>
        )}
      </div>
    </div>
  )
}
