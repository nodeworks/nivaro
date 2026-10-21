import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, CircleDashed, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'

/**
 * Settings → Huddles → "Server health" (#2850): the result of the 5-minute `huddle-turn-probe`
 * cron (a real TURN allocation with the credential a browser would get), a day of history,
 * and what the credential lifetime means for long calls.
 */

interface ProbeResult {
  url: string
  kind: 'turn' | 'stun'
  ok: boolean
  ms: number
  address: string | null
  error: string | null
}

interface TurnHealth {
  configured: boolean
  enabled: boolean
  turn_urls: number
  stun_urls: number
  last: { at: string; ok: boolean; ms: number | null; results: ProbeResult[] } | null
  history: Array<{ at: string; ok: boolean; ms: number | null }>
  consecutive_failures: number
  failures_to_raise: number
  issue_id: number | null
  credential_ttl_s: number
  credential_kind: 'rest-secret' | 'static' | 'none'
  longest_huddle_minutes: number
}

function Sparkline({ history }: { history: TurnHealth['history'] }) {
  const okMs = history.filter((h) => h.ok && h.ms != null).map((h) => h.ms as number)
  const top = Math.max(100, ...okMs)
  return (
    <div
      className='flex h-8 items-end gap-px'
      role='img'
      aria-label={`Last ${history.length} checks: ${history.filter((h) => h.ok).length} passed`}
      data-huddle-probe-history
    >
      {history.map((h) => (
        <div
          key={h.at}
          className={
            h.ok
              ? 'min-w-px flex-1 rounded-t-[1px] bg-emerald-500/70 dark:bg-emerald-400/70'
              : 'min-w-px flex-1 rounded-t-[1px] bg-red-500 dark:bg-red-400'
          }
          style={{ height: h.ok ? `${Math.max(18, ((h.ms ?? 0) / top) * 100)}%` : '100%' }}
          data-tip={`${new Date(h.at).toLocaleString()}: ${h.ok ? `answered in ${h.ms} ms` : 'failed'}`}
        />
      ))}
    </div>
  )
}

function ttlText(s: number): string {
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? '' : 's'}`
  return `${Math.round(s / 60)} minutes`
}

export function HuddleTurnHealth({ disabled }: { disabled?: boolean }) {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['huddle-turn-health'],
    queryFn: () =>
      api.get<{ data: TurnHealth }>('/chat/huddle/settings/turn-health').then((r) => r.data.data),
    refetchInterval: 60_000
  })
  const run = useMutation({
    mutationFn: () => api.post('/chat/huddle/settings/turn-health/run'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['huddle-turn-health'] })
  })

  let tone: 'good' | 'bad' | 'none' = 'none'
  let headline = 'Not checked yet'
  if (data) {
    if (!data.configured) headline = 'Nothing to check: no STUN or TURN server is saved'
    else if (data.last) {
      tone = data.last.ok ? 'good' : 'bad'
      headline = data.last.ok
        ? `Answering${data.last.ms != null ? ` in ${data.last.ms} ms` : ''}`
        : data.consecutive_failures >= data.failures_to_raise
          ? `Not answering: ${data.consecutive_failures} checks failed in a row`
          : `Last check failed (${data.consecutive_failures} in a row)`
    }
  }
  const Icon = tone === 'good' ? CircleCheck : tone === 'none' ? CircleDashed : CircleAlert
  const ttl = data?.credential_ttl_s ?? 0
  const longUse = data && ttl > 0 && data.longest_huddle_minutes * 60 >= ttl * 0.8

  return (
    <div className='space-y-3 rounded-lg border border-slate-200 px-4 py-3 dark:border-border'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <p className='text-[13px] font-medium text-slate-900 dark:text-foreground'>
            Server health
          </p>
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Every 5 minutes the server asks each saved TURN server for a relay, the way a browser
            would, and each STUN server for its address. Three failures in a row raise an issue.
          </p>
        </div>
        <Button
          size='sm'
          variant='outline'
          onClick={() => run.mutate()}
          disabled={disabled || run.isPending || !data?.configured}
          data-tip={
            disabled ? 'Save your changes first — the check uses the saved servers' : undefined
          }
        >
          {run.isPending && <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />}
          {run.isPending ? 'Checking…' : 'Check now'}
        </Button>
      </div>

      {isLoading && <Skeleton className='h-12 w-full rounded-md' />}
      {isError && (
        <p className='text-[12px] text-red-700 dark:text-red-300'>
          The health history could not be loaded.
        </p>
      )}
      {data && (
        <>
          <p
            className={
              tone === 'good'
                ? 'flex items-start gap-1.5 text-[12.5px] font-medium text-emerald-700 dark:text-emerald-300'
                : tone === 'bad'
                  ? 'flex items-start gap-1.5 text-[12.5px] font-medium text-red-700 dark:text-red-300'
                  : 'flex items-start gap-1.5 text-[12.5px] text-slate-600 dark:text-muted-foreground'
            }
            role='status'
            data-huddle-turn-health={tone}
          >
            <Icon className='mt-px h-3.5 w-3.5 shrink-0' strokeWidth={2} />
            <span>
              {headline}
              {data.last && (
                <span className='ml-1.5 font-normal text-slate-500 dark:text-muted-foreground'>
                  checked {formatRelative(data.last.at)}
                </span>
              )}
            </span>
          </p>
          {data.last && data.last.results.some((r) => !r.ok) && (
            <ul className='space-y-0.5 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
              {data.last.results
                .filter((r) => !r.ok)
                .map((r) => (
                  <li key={r.url}>
                    <span className='font-mono'>{r.url}</span>: {r.error}
                  </li>
                ))}
            </ul>
          )}
          {data.issue_id != null && (
            <p className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>
              An issue is open for this (#{data.issue_id}); it closes once you resolve it in the
              issue log.
            </p>
          )}
          {data.history.length > 0 ? (
            <div className='space-y-1'>
              <Sparkline history={data.history} />
              <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                The last {data.history.length} checks (a day is 288). Taller bars are slower
                answers; red bars failed.
              </p>
            </div>
          ) : (
            data.configured && (
              <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                No history yet. Checks run on deployed instances; use Check now to run one here.
              </p>
            )
          )}
          {data.credential_kind === 'rest-secret' && (
            <div className='border-t border-slate-100 pt-3 dark:border-border'>
              <p className='text-[12px] font-medium text-slate-800 dark:text-foreground'>
                Credential lifetime
              </p>
              <p className='mt-0.5 max-w-[70ch] text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                With a shared secret, each person gets a username that carries an expiry time (
                {ttlText(ttl)} from when they join). coturn checks that time again every time it
                renews a relay, about every 10 minutes, so a call that runs past it and is using the
                relay can drop. Keep the lifetime longer than your longest huddle.
                {data.longest_huddle_minutes > 0 &&
                  ` The longest huddle in the last 30 days ran ${data.longest_huddle_minutes} minutes.`}
              </p>
              {longUse && (
                <p
                  className='mt-1 flex items-start gap-1.5 text-[11.5px] text-amber-700 dark:text-amber-300'
                  data-huddle-ttl-warning
                >
                  <CircleAlert className='mt-px h-3.5 w-3.5 shrink-0' />
                  Your longest huddle is close to the lifetime. Raise it above.
                </p>
              )}
            </div>
          )}
          {data.credential_kind === 'static' && (
            <p className='border-t border-slate-100 pt-3 text-[11.5px] text-slate-600 dark:border-border dark:text-muted-foreground'>
              A static username and password never expire, so long calls are not cut by a credential
              timeout.
            </p>
          )}
        </>
      )}
    </div>
  )
}
