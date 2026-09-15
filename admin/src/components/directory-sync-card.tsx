import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookUser, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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

type Status = { configured: boolean; granted: boolean; roles: string[]; reason: string | null }
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
