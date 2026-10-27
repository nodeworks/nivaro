import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Settings → Microsoft → Teams bot. Saves its own keys (teams_bot_*), like the channel test-mode
 * card; the rest of the page is untouched. The secret arrives masked and is preserved when the
 * mask is posted back.
 */
const MASK = '••••••'

type AppType = 'MultiTenant' | 'SingleTenant'

interface Row {
  teams_bot_enabled?: boolean | number | null
  teams_bot_app_id?: string | null
  teams_bot_app_secret?: string | null
  teams_bot_tenant_id?: string | null
  teams_bot_app_type?: string | null
}

interface Status {
  enabled: boolean
  reason: 'cloud' | 'off' | 'disabled' | 'not_configured' | null
  source: 'env' | 'settings' | 'sign_in_app' | null
  app_type: AppType
  linked: number
  sent_today: number
  failed_today: number
  last_inbound_at: string | null
  last_error: string | null
}

const REASON: Record<string, string> = {
  cloud: 'Not available in cloud mode',
  off: 'Turned off by TEAMS_BOT=off',
  disabled: 'Off',
  not_configured: 'Needs app id, secret and tenant'
}
const SOURCE: Record<string, string> = {
  sign_in_app: 'Using the sign-in app',
  env: 'From server settings (env)',
  settings: 'From this page'
}
const TYPES: Array<{ value: AppType; label: string; hint: string }> = [
  { value: 'MultiTenant', label: 'Multi-tenant', hint: 'The app is registered for any tenant' },
  { value: 'SingleTenant', label: 'Single-tenant', hint: 'The app is registered for one tenant' }
]

const isOn = (v: unknown) => v === true || v === 1
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never')

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <div className='text-[10.5px] uppercase tracking-wide text-slate-400 dark:text-muted-foreground'>
        {label}
      </div>
      <div className='mt-0.5 break-words text-[12.5px] text-slate-800 dark:text-foreground'>
        {value}
      </div>
    </div>
  )
}

export function TeamsBotCard() {
  const qc = useQueryClient()
  const settings = useQuery({
    queryKey: ['settings', 'teams-bot'],
    queryFn: () => api.get<{ data: Row }>('/settings').then((r) => r.data.data)
  })
  const status = useQuery({
    queryKey: ['teams-bot', 'status'],
    queryFn: () => api.get<Status>('/teams/status').then((r) => r.data),
    retry: false
  })
  const [draft, setDraft] = useState({
    enabled: false,
    appId: '',
    secret: '',
    tenantId: '',
    appType: 'MultiTenant' as AppType
  })
  useEffect(() => {
    const s = settings.data
    if (!s) return
    setDraft({
      enabled: isOn(s.teams_bot_enabled),
      appId: s.teams_bot_app_id ?? '',
      secret: s.teams_bot_app_secret ?? '',
      tenantId: s.teams_bot_tenant_id ?? '',
      appType: s.teams_bot_app_type === 'SingleTenant' ? 'SingleTenant' : 'MultiTenant'
    })
  }, [settings.data])

  const save = useMutation({
    mutationFn: () =>
      api.patch('/settings', {
        teams_bot_enabled: draft.enabled,
        teams_bot_app_id: draft.appId.trim() || null,
        // posting the mask back keeps the stored secret
        teams_bot_app_secret: draft.secret || null,
        teams_bot_tenant_id: draft.tenantId.trim() || null,
        teams_bot_app_type: draft.appType
      }),
    onSuccess: () => {
      toast.success('Teams bot saved')
      void qc.invalidateQueries({ queryKey: ['settings'] })
      void qc.invalidateQueries({ queryKey: ['teams-bot'] })
    },
    onError: () => toast.error('Could not save the Teams bot')
  })

  const test = useMutation({
    mutationFn: () =>
      api.post<{ outcome: string; message: string }>('/teams/test').then((r) => r.data),
    onSuccess: (r) => (r.outcome === 'sent' ? toast.success(r.message) : toast.error(r.message)),
    onError: () => toast.error('Could not send the test message'),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['teams-bot'] })
  })

  const download = useMutation({
    mutationFn: async () => {
      const r = await api.get('/teams/package', { responseType: 'blob' })
      const cd = String(r.headers['content-disposition'] ?? '')
      const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? 'nivaro-teams.zip'
      const url = URL.createObjectURL(r.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { status?: number } })?.response?.status === 409
          ? 'Save the app (client) ID first, then download the package'
          : 'Could not build the Teams app package. Try again; the API log has the reason.'
      )
  })

  // The endpoints answer 404 in cloud mode: the card is simply not offered there.
  if ((status.error as { response?: { status?: number } } | null)?.response?.status === 404)
    return null

  const st = status.data
  const label = 'text-[12px] font-medium text-slate-700 dark:text-foreground'
  const hint = 'text-[11px] text-slate-400 dark:text-muted-foreground'

  return (
    <div
      className='space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-border dark:bg-muted/30'
      data-teams-bot-card
    >
      <div>
        <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>Teams bot</h3>
        <p className={cn(hint, 'mt-0.5')}>
          Notifications, approvals and questions about records, in Teams. Register a bot in Azure,
          fill in its details here, then give IT the app package to upload.
        </p>
      </div>

      {status.isLoading || settings.isLoading ? (
        <Skeleton className='h-20 w-full' />
      ) : status.isError ? (
        <p className='text-[12px] text-red-600 dark:text-red-400' data-teams-bot-status-error>
          Could not load the Teams bot status. Reload the page; if it keeps failing, check the API
          log.
        </p>
      ) : (
        st && (
          <div
            className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'
            data-teams-bot-status
          >
            <Stat label='Status' value={st.enabled ? 'On' : (REASON[st.reason ?? ''] ?? 'Off')} />
            <Stat label='Credentials' value={st.source ? SOURCE[st.source] : 'None'} />
            <Stat
              label='App type'
              value={st.app_type === 'SingleTenant' ? 'Single-tenant' : 'Multi-tenant'}
            />
            <Stat label='Linked people' value={String(st.linked)} />
            <Stat label='Sent today' value={String(st.sent_today)} />
            <Stat label='Failed today' value={String(st.failed_today)} />
            <Stat label='Last message received' value={when(st.last_inbound_at)} />
            <Stat label='Last error' value={st.last_error ?? 'None'} />
          </div>
        )
      )}

      <div className='flex items-center justify-between gap-3'>
        <Label className={label}>Send notifications and answer questions in Teams</Label>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
          aria-label='Send notifications and answer questions in Teams'
        />
      </div>

      <div className='space-y-1.5'>
        <Label className={label}>App (client) ID</Label>
        <Input
          value={draft.appId}
          onChange={(e) => setDraft({ ...draft, appId: e.target.value })}
          placeholder='00000000-0000-0000-0000-000000000000'
          className='h-8 font-mono text-[13px]'
        />
      </div>
      <div className='space-y-1.5'>
        <Label className={label}>Client secret</Label>
        <Input
          type='password'
          autoComplete='new-password'
          value={draft.secret}
          onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
          placeholder={MASK}
          className='h-8 font-mono text-[13px]'
        />
        <p className={hint}>Shown as •••••• once saved. Leave it as is to keep the saved secret.</p>
      </div>
      <div className='space-y-1.5'>
        <Label className={label}>Directory (tenant) ID</Label>
        <Input
          value={draft.tenantId}
          onChange={(e) => setDraft({ ...draft, tenantId: e.target.value })}
          placeholder='00000000-0000-0000-0000-000000000000'
          className='h-8 font-mono text-[13px]'
        />
        <p className={hint}>
          Your own tenant. Messages from any other tenant are refused, for both app types.
        </p>
      </div>
      <div className='space-y-1.5'>
        <Label className={label}>App type</Label>
        <fieldset aria-label='App type' className='m-0 inline-flex gap-1 border-0 p-0'>
          {TYPES.map((t) => {
            const active = draft.appType === t.value
            return (
              <button
                key={t.value}
                type='button'
                aria-pressed={active}
                title={t.hint}
                onClick={() => setDraft({ ...draft, appType: t.value })}
                className={cn(
                  'h-8 rounded-md border px-3 text-[12px] font-medium transition-colors',
                  active
                    ? 'border-nvr-cyan bg-nvr-cyan text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
                )}
              >
                {t.label}
              </button>
            )
          })}
        </fieldset>
        <p className={hint}>
          Pick what the app registration in Azure says (Supported account types).
        </p>
      </div>

      <div className='flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 dark:border-border'>
        <Button
          size='sm'
          className='bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save Teams bot'}
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={() => download.mutate()}
          disabled={download.isPending}
        >
          <Download className='mr-1 h-3.5 w-3.5' /> Download Teams app package
        </Button>
        <Button size='sm' variant='outline' onClick={() => test.mutate()} disabled={test.isPending}>
          <Send className='mr-1 h-3.5 w-3.5' /> Send me a test message
        </Button>
      </div>
    </div>
  )
}
