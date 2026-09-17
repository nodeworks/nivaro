import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookUser, KeyRound, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Settings → Microsoft → Directory sync. Owns its own reads and writes (the
 * page's Save button saves the other Microsoft fields; these two switches
 * commit on flip). Shows the token's real permission, the last nightly run,
 * how the user table currently reads, and a Run-now.
 */

type Status = {
  configured: boolean
  granted: boolean
  roles: string[]
  reason: string | null
  auth_mode: AuthMode
  username: string | null
  connected_user: string | null
  connected_at: string | null
}
type AuthMode = 'app' | 'service_account' | 'connected'
type Report = {
  enabled: boolean
  suspend: boolean
  last_run: string | null
  summary: {
    checked: number
    active: number
    disabled: number
    missing: number
    suspended: number
  } | null
  counts: Record<string, number>
}

export function DirectorySyncCard() {
  const qc = useQueryClient()
  const status = useQuery<Status>({
    queryKey: ['directory-status'],
    queryFn: () => api.get('/directory/status').then((r) => r.data.data),
    staleTime: 5 * 60_000
  })
  const report = useQuery<Report>({
    queryKey: ['directory-report'],
    queryFn: () => api.get('/directory/report').then((r) => r.data.data)
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['directory-report'] })
    qc.invalidateQueries({ queryKey: ['settings'] })
    qc.invalidateQueries({ queryKey: ['users'] })
  }
  const patch = useMutation({
    mutationFn: (body: Record<string, boolean>) => api.patch('/settings', body),
    onSuccess: invalidate,
    onError: () => toast.error('Could not save the directory sync setting')
  })
  const settingsQ = useQuery<Record<string, unknown>>({
    queryKey: ['settings'],
    queryFn: () => api.get('/settings').then((r) => r.data.data)
  })
  const [mode, setMode] = useState<AuthMode>('app')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (seeded || !settingsQ.data) return
    const m = settingsQ.data.directory_auth_mode
    setMode(m === 'service_account' || m === 'connected' ? m : 'app')
    setUsername(String(settingsQ.data.directory_username ?? ''))
    setPassword(String(settingsQ.data.directory_password ?? ''))
    setSeeded(true)
  }, [seeded, settingsQ.data])
  const recheckFresh = async () => {
    const s = await api
      .get('/directory/status', { params: { fresh: '1' } })
      .then((r) => r.data.data as Status)
    qc.setQueryData(['directory-status'], s)
    return s
  }
  // Landing back from the Microsoft connect round-trip.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('directory')
    if (!outcome) return
    if (outcome === 'connected') {
      toast.success(`Directory connected as ${params.get('user') ?? 'the service account'}`)
    } else {
      toast.error(params.get('reason') ?? 'Directory connect failed', { duration: 12000 })
    }
    for (const k of ['directory', 'user', 'reason']) params.delete(k)
    const qs = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
    invalidate()
    void recheckFresh().then((s) => {
      if (outcome === 'connected' && !s.granted && s.reason)
        toast.error(s.reason, { duration: 12000 })
    })
    // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on mount
  }, [])
  const startConnect = () => {
    const q = new URLSearchParams({ returnTo: `${window.location.origin}/settings` })
    if (username.trim()) q.set('login_hint', username.trim())
    window.location.href = `/api/directory/connect?${q.toString()}`
  }
  const disconnect = useMutation({
    mutationFn: () => api.post('/directory/disconnect'),
    onSuccess: async () => {
      setMode('app')
      invalidate()
      await recheckFresh()
      toast.success('Directory account disconnected')
    },
    onError: () => toast.error('Could not disconnect')
  })
  const saveIdentity = useMutation({
    mutationFn: () =>
      api.patch('/settings', {
        directory_auth_mode: mode,
        directory_username: username.trim() || null,
        directory_password: password || null
      }),
    onSuccess: async () => {
      invalidate()
      const s = await api
        .get('/directory/status', { params: { fresh: '1' } })
        .then((r) => r.data.data as Status)
      qc.setQueryData(['directory-status'], s)
      if (s.granted) toast.success(`Directory access works as ${s.username ?? 'the app'}`)
      else toast.error(s.reason ?? 'Directory access still not granted')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Could not save the directory identity')
    }
  })
  const recheck = useMutation({
    mutationFn: () => api.get('/directory/status', { params: { fresh: '1' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['directory-status'] })
  })
  const runNow = useMutation({
    mutationFn: () =>
      api.post('/directory/check', {}).then((r) => r.data.data as Report['summary']),
    onSuccess: (s) => {
      invalidate()
      if (s)
        toast.success(
          `Checked ${s.checked} users — ${s.disabled} disabled, ${s.missing} not in the directory, ${s.suspended} suspended`
        )
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Directory check failed')
    }
  })

  if (status.isLoading || !status.data?.configured) return null
  const granted = status.data.granted
  const r = report.data
  const counts = r?.counts ?? {}

  return (
    <div className='space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex items-start justify-between gap-3'>
        <div>
          <p className='flex items-center gap-1.5 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            <BookUser className='h-3.5 w-3.5 text-slate-400' />
            Directory sync
          </p>
          <p className='mt-0.5 max-w-[64ch] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Checks every user against the Microsoft directory: still there, disabled, or gone. Runs
            nightly at 04:15 when switched on; the Users page can run it any time.
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
            granted
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300'
              : 'bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200'
          )}
        >
          {granted ? 'Access granted' : 'Waiting on User.Read.All'}
        </span>
      </div>

      <div
        className='space-y-2 rounded-md border border-slate-200 px-3 py-2.5 dark:border-border'
        data-directory-identity
      >
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <Label className='flex items-center gap-1.5 text-[12px] font-medium text-slate-700 dark:text-foreground'>
            <KeyRound className='h-3.5 w-3.5 text-slate-400' />
            Sign in to the directory as
          </Label>
          <div className='inline-flex rounded-md border border-slate-200 p-0.5 text-[11.5px] dark:border-border'>
            {(
              [
                ['app', 'App registration'],
                ['service_account', 'Service account'],
                ['connected', 'Connected account']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type='button'
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                data-directory-mode={value}
                className={cn(
                  'rounded px-2.5 py-1 transition-colors',
                  mode === value
                    ? 'bg-nvr-navy text-white dark:bg-nvr-cyan dark:text-[#172940]'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {mode === 'connected' ? (
          <div className='space-y-2' data-directory-connected>
            <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
              Sign in as the service account once in the browser (multi-factor prompts work there).
              Nivaro keeps the sign-in and renews it silently from then on. The connection lapses if
              the account goes unused for about 90 days or an admin revokes its sessions — reconnect
              from here when that happens.
            </p>
            {status.data.connected_user ? (
              <div className='flex flex-wrap items-center gap-2 text-[12px]'>
                <span className='text-slate-700 dark:text-foreground' data-directory-connected-user>
                  Connected as <span className='font-medium'>{status.data.connected_user}</span>
                  {status.data.connected_at && (
                    <span className='text-slate-400'>
                      {' '}
                      · {formatRelative(status.data.connected_at)}
                    </span>
                  )}
                </span>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  className='h-7 text-[12px]'
                  onClick={startConnect}
                  data-directory-reconnect
                >
                  Reconnect…
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  className='h-7 text-[12px] text-rose-600 hover:text-rose-700'
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                  data-directory-disconnect
                >
                  Disconnect
                </Button>
              </div>
            ) : (
              <div className='flex flex-wrap items-center gap-2'>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder='svc-account@company.com (sign-in hint, optional)'
                  autoComplete='off'
                  className='h-8 max-w-[320px] text-[12px]'
                  data-directory-username
                />
                <Button
                  type='button'
                  size='sm'
                  className='h-7 text-[12px]'
                  onClick={startConnect}
                  data-directory-connect
                >
                  Connect service account…
                </Button>
              </div>
            )}
          </div>
        ) : mode === 'service_account' ? (
          <>
            <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
              A named account with a password whose delegated User.Read.All was granted through IAM.
              The sign-in name is its user principal name (usually the email form).
            </p>
            <div className='grid gap-2 sm:grid-cols-2'>
              <div className='space-y-1'>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder='svc-account@company.com'
                  autoComplete='off'
                  className='h-8 text-[12px]'
                  data-directory-username
                />
                {username.trim() && !username.includes('@') && (
                  <p
                    className='text-[11px] text-amber-700 dark:text-amber-300'
                    data-directory-username-hint
                  >
                    Use the full sign-in name (name@domain) — Microsoft rejects the bare account
                    name.
                  </p>
                )}
              </div>
              <Input
                type='password'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder='Password'
                autoComplete='new-password'
                className='h-8 text-[12px]'
                data-directory-password
              />
            </div>
          </>
        ) : (
          <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
            The app registration's own credentials (from the server environment). Needs
            User.Read.All as an APPLICATION permission with admin consent.
          </p>
        )}
        {mode !== 'connected' && (
          <div className='flex items-center gap-2'>
            <Button
              type='button'
              size='sm'
              onClick={() => saveIdentity.mutate()}
              disabled={
                saveIdentity.isPending ||
                (mode === 'service_account' && (!username.trim() || !password))
              }
              className='h-7 text-[12px]'
              data-directory-save
            >
              {saveIdentity.isPending ? 'Saving and testing…' : 'Save and test'}
            </Button>
            {status.data.username && status.data.auth_mode === 'service_account' && (
              <span className='text-[11px] text-slate-400'>
                Currently signing in as {status.data.username}
              </span>
            )}
          </div>
        )}
      </div>

      {!granted && (
        <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200'>
          <p>{status.data.reason}</p>
          <button
            type='button'
            onClick={() => recheck.mutate()}
            disabled={recheck.isPending}
            className='mt-1 text-[11.5px] font-medium underline underline-offset-2'
          >
            {recheck.isPending ? 'Checking…' : 'Re-check the permission'}
          </button>
        </div>
      )}

      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='flex items-start justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 dark:border-border'>
          <div>
            <Label className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
              Nightly check
            </Label>
            <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
              Off until the permission is approved — the job skips itself either way.
            </p>
          </div>
          <Switch
            checked={Boolean(r?.enabled)}
            onCheckedChange={(v) => patch.mutate({ directory_sync_enabled: v })}
            disabled={patch.isPending || !r}
          />
        </div>
        <div className='flex items-start justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 dark:border-border'>
          <div>
            <Label className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
              Suspend people the directory no longer has
            </Label>
            <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
              Missing or disabled accounts are suspended. Never un-suspended, never redacted.
            </p>
          </div>
          <Switch
            checked={r?.suspend ?? true}
            onCheckedChange={(v) => patch.mutate({ directory_sync_suspend: v })}
            disabled={patch.isPending || !r}
          />
        </div>
      </div>

      <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-slate-600 dark:text-muted-foreground'>
        <span>
          Last full run:{' '}
          <span className='font-medium text-slate-800 dark:text-foreground'>
            {r?.last_run ? formatRelative(r.last_run) : 'never'}
          </span>
          {r?.summary && (
            <span className='text-slate-400'>
              {' '}
              · {r.summary.checked} checked · {r.summary.disabled} disabled · {r.summary.missing}{' '}
              missing · {r.summary.suspended} suspended
            </span>
          )}
        </span>
        <span className='text-slate-400'>
          Users now: {counts.active ?? 0} active · {counts.disabled ?? 0} disabled ·{' '}
          {counts.missing ?? 0} missing · {counts.unchecked ?? 0} unchecked
        </span>
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={() => runNow.mutate()}
          disabled={!granted || runNow.isPending}
          className='ml-auto gap-1.5 text-[12px]'
        >
          <RefreshCw className={cn('h-3.5 w-3.5', runNow.isPending && 'animate-spin')} />
          {runNow.isPending ? 'Checking every user…' : 'Run now'}
        </Button>
      </div>
    </div>
  )
}
