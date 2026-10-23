import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Sticky force refresh (api/src/services/sticky-refresh.ts), on the Realtime console header:
 *  - RememberedRefreshes: the pushes still being delivered to tabs that reconnect (Stop each);
 *  - MinBuildControl: an optional minimum client build per app. Off until set; any tab of that
 *    app on an older build reloads (after a countdown, held while it has unsaved edits).
 */

const INPUT =
  'h-7 w-full rounded-md border border-slate-200 bg-background px-2 text-[12px] dark:border-border'
const MUTED = 'text-slate-500 dark:text-muted-foreground'

interface Remembered {
  id: string
  issued_at: number
  issuer_name: string | null
  seconds: number
  message: string
  target: { app: string | null; user_ids: string[]; older: boolean }
}

function targetText(t: Remembered['target']): string {
  const who = t.user_ids.length
    ? `${t.user_ids.length} ${t.user_ids.length === 1 ? 'person' : 'people'}`
    : t.app
      ? `everyone on ${t.app}`
      : 'everyone'
  return t.older ? `${who} on an older version` : who
}

/** Inside the Force refresh popover: what is still being delivered to tabs that reconnect. */
export function RememberedRefreshes({ open }: { open: boolean }) {
  const qc = useQueryClient()
  const { data } = useQuery<{ hours: number; instructions: Remembered[] }>({
    queryKey: ['realtime-remembered-refreshes'],
    queryFn: () => api.get('/realtime/force-refresh/remembered').then((r) => r.data.data),
    enabled: open,
    staleTime: 5_000
  })
  const stop = useMutation({
    mutationFn: (id: string) => api.delete(`/realtime/force-refresh/remembered/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['realtime-remembered-refreshes'] })
      toast.success('Stopped — tabs that reconnect will not get it')
    },
    onError: () => toast.error('Could not stop it')
  })
  if (!data) return null
  if (data.hours <= 0)
    return (
      <p className={cn('mt-2 text-[11px]', MUTED)}>
        Only tabs connected right now are reached (remembering is off on this server).
      </p>
    )
  return (
    <div className='mt-2 border-t border-slate-100 pt-2 dark:border-border'>
      <p className={cn('text-[11px]', MUTED)}>
        Tabs that are asleep or offline get it when they connect again, for {data.hours} h.
      </p>
      {data.instructions.length > 0 && (
        <ul className='mt-1.5 space-y-1' data-remembered-refreshes={data.instructions.length}>
          {data.instructions.slice(0, 5).map((r) => (
            <li key={r.id} className='flex items-center gap-2 text-[11.5px]'>
              <span className='min-w-0 flex-1 truncate'>
                {targetText(r.target)} · {formatRelative(new Date(r.issued_at))}
                {r.issuer_name ? ` · ${r.issuer_name}` : ''}
              </span>
              <button
                type='button'
                disabled={stop.isPending}
                onClick={() => stop.mutate(r.id)}
                className='shrink-0 rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-muted hover:text-slate-800 dark:hover:text-foreground'
              >
                Stop
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface MinRule {
  app: string
  build: string
  seconds: number
  message: string
  set_at: number
  set_by_name: string | null
}

interface MinBuildData {
  rules: MinRule[]
  below: Record<string, { tabs: number; people: number }>
  builds: Record<string, string[]>
  partial: boolean
  default_seconds: number
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/** Header button + popover: the minimum client build per app. */
export function MinBuildControl() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [app, setApp] = useState('admin')
  const [build, setBuild] = useState('')
  const [seconds, setSeconds] = useState('30')
  const [message, setMessage] = useState('')
  const [debounced, setDebounced] = useState('')
  const { data } = useQuery<MinBuildData>({
    queryKey: ['realtime-min-build'],
    queryFn: () => api.get('/realtime/min-build').then((r) => r.data.data),
    enabled: open,
    staleTime: 5_000
  })
  const rules = data?.rules ?? []
  const rule = rules.find((r) => r.app === app) ?? null
  const apps = useMemo(() => {
    const seen = new Set<string>(['admin'])
    for (const a of Object.keys(data?.builds ?? {})) seen.add(a)
    for (const r of rules) seen.add(r.app)
    return [...seen]
  }, [data, rules])

  // Switching app loads that app's rule into the form (or a blank one); a saved rule reloads it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on open / app / rule change, never while typing
  useEffect(() => {
    if (!open) return
    setBuild(rule?.build ?? '')
    setSeconds(String(rule?.seconds ?? data?.default_seconds ?? 30))
    setMessage(rule?.message ?? '')
  }, [open, app, rule?.set_at])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(build.trim()), 300)
    return () => clearTimeout(t)
  }, [build])

  const { data: preview } = useQuery<{ tabs: number; people: number; partial: boolean }>({
    queryKey: ['realtime-min-build-preview', app, debounced],
    queryFn: () =>
      api
        .get('/realtime/min-build/preview', { params: { app, build: debounced } })
        .then((r) => r.data.data),
    enabled: open && !!debounced,
    staleTime: 5_000
  })

  const refresh = () => void qc.invalidateQueries({ queryKey: ['realtime-min-build'] })
  const save = useMutation({
    mutationFn: () =>
      api
        .put(`/realtime/min-build/${encodeURIComponent(app)}`, {
          build: build.trim(),
          seconds: Number(seconds) || 30,
          message
        })
        .then((r) => r.data.data as { sockets: number; partial?: boolean }),
    onSuccess: ({ sockets, partial }) => {
      refresh()
      toast.success(
        `Minimum ${app} build is ${build.trim()}. ${sockets > 0 ? `${plural(sockets, 'open tab')} below it told to reload` : 'No open tab is below it'}${partial ? ' (another API replica did not answer)' : ''}; older tabs that connect later reload too.`
      )
    },
    onError: (e: unknown) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Could not save the minimum build'
      )
  })
  const clear = useMutation({
    mutationFn: () => api.delete(`/realtime/min-build/${encodeURIComponent(app)}`),
    onSuccess: () => {
      refresh()
      setBuild('')
      toast.success(`No minimum ${app} build — nothing is reloaded for its version`)
    },
    onError: () => toast.error('Could not turn it off')
  })

  const suggestions = (data?.builds[app] ?? []).slice(0, 6)
  const ruleBelow = rule ? data?.below[rule.app] : null
  const unchanged =
    !!rule &&
    rule.build === build.trim() &&
    String(rule.seconds) === seconds &&
    rule.message === message
  const activeCount = rules.length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-min-build-rules={activeCount}
          className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-700 hover:bg-muted dark:border-border dark:bg-card dark:text-foreground'
        >
          <ShieldCheck className='h-3.5 w-3.5' />
          Minimum build
          {activeCount > 0 && (
            <span className='rounded-full bg-amber-100 px-1.5 text-[11px] text-amber-900 dark:bg-amber-500/20 dark:text-amber-200'>
              {activeCount} on
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[360px] p-3'>
        <p className={cn('text-[12px]', MUTED)}>
          Optional. Any tab of the app on an older build reloads after a countdown — now and
          whenever one connects. Tabs with unsaved edits wait until they are saved.
        </p>
        <div className='mt-2 flex flex-wrap gap-1'>
          {apps.map((a) => {
            const on = rules.some((r) => r.app === a)
            return (
              <button
                key={a}
                type='button'
                onClick={() => setApp(a)}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11.5px]',
                  app === a
                    ? 'border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200'
                    : 'border-slate-200 text-slate-500 hover:bg-muted dark:border-border'
                )}
              >
                {a}
                {on ? ' · on' : ''}
              </button>
            )
          })}
        </div>

        <div
          className='mt-2 rounded-md bg-slate-50 px-2 py-1.5 text-[11.5px] dark:bg-muted/40'
          data-min-build-state={rule ? 'on' : 'off'}
        >
          {rule ? (
            <div className='flex items-start gap-2'>
              <span className='min-w-0 flex-1'>
                Minimum <span className='font-mono'>{rule.build}</span> since{' '}
                {formatRelative(new Date(rule.set_at))}
                {rule.set_by_name ? ` (${rule.set_by_name})` : ''}.{' '}
                {ruleBelow && ruleBelow.tabs > 0
                  ? `${plural(ruleBelow.tabs, 'open tab')} still below it.`
                  : 'No open tab is below it.'}
              </span>
              <button
                type='button'
                disabled={clear.isPending}
                onClick={() => clear.mutate()}
                className='shrink-0 rounded-md border border-slate-200 px-2 py-0.5 text-[11.5px] font-medium hover:bg-muted dark:border-border'
              >
                Turn off
              </button>
            </div>
          ) : (
            <span className={MUTED}>
              Off — no minimum for {app}; tabs are never reloaded for it.
            </span>
          )}
        </div>

        <label className='mt-2 block text-[12px]'>
          Minimum build
          <input
            value={build}
            onChange={(e) => setBuild(e.target.value)}
            placeholder='e.g. 0.3.12'
            className={cn(INPUT, 'mt-1 font-mono')}
          />
        </label>
        {suggestions.length > 0 && (
          <div className='mt-1 flex flex-wrap gap-1'>
            {suggestions.map((b) => (
              <button
                key={b}
                type='button'
                onClick={() => setBuild(b)}
                className='rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 hover:bg-muted dark:border-border dark:text-muted-foreground'
              >
                {b}
              </button>
            ))}
            <span className={cn('w-full text-[11px]', MUTED)}>Builds open now, newest first.</span>
          </div>
        )}
        <label className='mt-2 flex items-center gap-2 text-[12px]'>
          Countdown
          <input
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
            inputMode='numeric'
            className='h-7 w-16 rounded-md border border-slate-200 bg-background px-2 text-right text-[12px] dark:border-border'
          />
          seconds (5–300)
        </label>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder='Optional message shown in the banner'
          className={cn(INPUT, 'mt-2')}
        />
        {debounced && preview && (
          <p className='mt-2 text-[11.5px]' data-min-build-preview={preview.tabs}>
            {preview.tabs > 0
              ? `Saving reloads ${plural(preview.tabs, 'open tab')} (${plural(preview.people, 'person', 'people')}) below ${debounced} now.`
              : `No open ${app} tab is below ${debounced} right now.`}
            {preview.partial ? ' Another API replica did not answer — there may be more.' : ''}
          </p>
        )}
        <div className='mt-2 flex justify-end gap-2'>
          <button
            type='button'
            onClick={() => setOpen(false)}
            className='rounded-md px-2.5 py-1 text-[12px] text-slate-500 hover:bg-muted'
          >
            Close
          </button>
          <button
            type='button'
            disabled={!build.trim() || save.isPending || unchanged}
            onClick={() => save.mutate()}
            className='rounded-md bg-amber-500 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50'
          >
            {save.isPending ? 'Saving…' : rule ? 'Update minimum' : 'Set minimum'}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
