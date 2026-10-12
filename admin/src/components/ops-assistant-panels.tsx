import { createNivaro } from '@nivaro/sdk'
import { AskTheLogs, NivaroProvider } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellPlus, Siren } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Ops Console panels for the ops assistant cluster: Ask the logs (#1914,
 * #1960), suggested log alerts (#2013), incident mode + the ops channel
 * incident threads open in (#2016).
 */

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

const errorOf = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? fallback

function Frame({
  title,
  sub,
  right,
  children,
  testId
}: {
  title: string
  sub?: string
  right?: React.ReactNode
  children: React.ReactNode
  testId?: string
}) {
  return (
    <section
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-ops-panel={testId}
    >
      <header className='flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <div className='min-w-0'>
          <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>{title}</h2>
          {sub && <p className='mt-0.5 text-[11px] text-slate-400'>{sub}</p>}
        </div>
        {right}
      </header>
      <div className='p-4'>{children}</div>
    </section>
  )
}

export function AskTheLogsPanel() {
  return (
    <NivaroProvider client={sharedClient}>
      <AskTheLogs />
    </NivaroProvider>
  )
}

interface Suggestion {
  key: string
  name: string
  pattern: string | null
  level: string | null
  filters: Record<string, unknown>
  threshold: number
  window_minutes: number
  cooldown_minutes: number
  evidence: { count: number; spread: number; first_at: string; last_at: string; sample: string }
}

const DISMISSED_KEY = 'nvr-log-rule-suggestions-dismissed'
function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

/** #2013 — recurring errors with no rule watching them; Accept saves the rule as shown. */
export function LogRuleSuggestionsCard() {
  const qc = useQueryClient()
  const [dismissed, setDismissed] = useState<string[]>(readDismissed)
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['ops-log-rule-suggestions'],
    queryFn: () =>
      api.get<{ data: Suggestion[] }>('/ops-logs/rule-suggestions').then((r) => r.data.data),
    staleTime: 5 * 60_000
  })
  const accept = useMutation({
    mutationFn: (s: Suggestion) =>
      api.post('/ops-logs/rules', {
        name: s.name,
        ...(s.pattern ? { pattern: s.pattern, level: s.level } : {}),
        filters: s.filters,
        threshold: s.threshold,
        window_minutes: s.window_minutes,
        cooldown_minutes: s.cooldown_minutes,
        origin: 'suggested'
      }),
    onSuccess: () => {
      toast.success('Alert rule added')
      void qc.invalidateQueries({ queryKey: ['ops-log-rules'] })
      void qc.invalidateQueries({ queryKey: ['ops-log-rule-suggestions'] })
    },
    onError: (e) => toast.error(errorOf(e, 'The rule was not saved'))
  })
  const dismiss = (key: string) => {
    const next = [...new Set([...dismissed, key])].slice(-200)
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      /* per-browser convenience only */
    }
  }
  const shown = (data ?? []).filter((s) => !dismissed.includes(s.key))
  return (
    <Frame
      title='Suggested log alerts'
      sub='Errors that keep coming back with no rule watching them — last 24h of requests and this server’s log'
      testId='rule-suggestions'
      right={
        <Button
          size='sm'
          variant='outline'
          className='h-7 text-[11.5px]'
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          {isFetching ? 'Looking…' : 'Look again'}
        </Button>
      }
    >
      {isLoading ? (
        <div className='h-12 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
      ) : shown.length === 0 ? (
        <p className='text-[12px] text-slate-400'>
          Nothing recurring without a rule. Failures need to repeat across at least two hours (or
          two minutes in the log) to show here.
        </p>
      ) : (
        <ul className='space-y-2'>
          {shown.map((s) => (
            <li
              key={s.key}
              className='rounded-md border border-slate-200 p-2.5 text-[12px] dark:border-border'
              data-rule-suggestion={s.key}
            >
              <div className='flex items-start gap-2'>
                <div className='min-w-0 flex-1'>
                  <p className='truncate font-medium text-slate-800 dark:text-slate-100'>
                    {s.name}
                  </p>
                  <p className='truncate font-mono text-[11px] text-slate-500'>
                    {s.pattern ? `/${s.pattern}/i` : s.evidence.sample}
                  </p>
                  <p className='text-[11px] text-slate-400'>
                    {s.evidence.count}× across {s.evidence.spread} {s.pattern ? 'minutes' : 'hours'}{' '}
                    · alert at {s.threshold} in {s.window_minutes} min, then quiet{' '}
                    {s.cooldown_minutes} min
                  </p>
                </div>
                <Button
                  size='sm'
                  className='h-7 shrink-0 gap-1 text-[11.5px]'
                  disabled={accept.isPending}
                  onClick={() => accept.mutate(s)}
                >
                  <BellPlus className='h-3.5 w-3.5' /> Accept
                </Button>
                <button
                  type='button'
                  className='h-7 shrink-0 px-1.5 text-[11px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                  onClick={() => dismiss(s.key)}
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  )
}

interface IncidentRow {
  id: number
  kind: 'incident' | 'alert'
  title: string
  status: 'open' | 'closed'
  room: string | null
  started_at: string
  ended_at: string | null
  summary: string | null
}

/** #2016 — incident mode on/off, and the admin-only channel its threads open in. */
export function IncidentModeCard() {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const { data: incident } = useQuery({
    queryKey: ['ops-incident'],
    queryFn: () =>
      api
        .get<{ data: { current: IncidentRow | null; recent: IncidentRow[] } }>(
          '/ops-assistant/incident'
        )
        .then((r) => r.data.data),
    refetchInterval: 30_000
  })
  const { data: channel } = useQuery({
    queryKey: ['ops-channel'],
    queryFn: () =>
      api
        .get<{ data: { room: string | null; verdict: { ok: boolean; reason?: string } | null } }>(
          '/ops-assistant/channel'
        )
        .then((r) => r.data.data)
  })
  const { data: rooms = [] } = useQuery({
    queryKey: ['ops-channel-candidates'],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            room: string
            kind: string
            label: string | null
            channel: { visibility: string; is_direct: boolean } | null
          }>
        }>('/chat/rooms')
        .then((r) =>
          r.data.data.filter(
            (x) =>
              x.kind === 'channel' &&
              x.channel &&
              x.channel.visibility !== 'open' &&
              !x.channel.is_direct
          )
        ),
    staleTime: 60_000
  })
  const setChannel = useMutation({
    mutationFn: (room: string) => api.put('/ops-assistant/channel', { room: room || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ops-channel'] })
      toast.success('Ops channel saved')
    },
    onError: (e) => toast.error(errorOf(e, 'That channel cannot be used'))
  })
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.post('/ops-assistant/incident', { on, title: title || null }),
    onSuccess: (_r, on) => {
      setTitle('')
      void qc.invalidateQueries({ queryKey: ['ops-incident'] })
      toast.success(on ? 'Incident mode is on' : 'Incident mode ended — summary posted')
    },
    onError: (e) => toast.error(errorOf(e, 'Failed'))
  })
  const current = incident?.current ?? null
  return (
    <Frame
      title='Incident mode'
      sub='Opens a thread in the ops channel and posts new errors, recoveries and approved actions until it ends'
      testId='incident-mode'
      right={
        current ? (
          <span className='inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-300'>
            <Siren className='h-3.5 w-3.5' /> On
          </span>
        ) : null
      }
    >
      <div className='space-y-3 text-[12px]'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-slate-500'>Ops channel</span>
          <SimpleSelect
            value={channel?.room ?? ''}
            onChange={(v) => setChannel.mutate(v)}
            options={[
              { value: '', label: 'None — no incident threads' },
              ...rooms.map((r) => ({ value: r.room, label: r.label ?? r.room }))
            ]}
            ariaLabel='Ops channel'
            className='h-7 w-64 text-[12px]'
          />
          {channel?.room && channel.verdict && !channel.verdict.ok && (
            <span className='text-[11px] text-amber-700 dark:text-amber-300'>
              Not admin-only any more ({channel.verdict.reason}) — threads are paused
            </span>
          )}
        </div>
        {current ? (
          <div className='flex flex-wrap items-center gap-2'>
            <span className='font-medium text-slate-800 dark:text-slate-100'>{current.title}</span>
            <span className='text-slate-400'>
              since {new Date(current.started_at).toLocaleString()}
            </span>
            <Button
              size='sm'
              variant='outline'
              className='ml-auto h-7 text-[11.5px]'
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(false)}
            >
              End incident
            </Button>
          </div>
        ) : (
          <form
            className='flex items-center gap-2'
            onSubmit={(e) => {
              e.preventDefault()
              toggle.mutate(true)
            }}
          >
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder='What is going on? e.g. Partner pushes failing'
              className='h-7 flex-1 text-[12px]'
              maxLength={200}
            />
            <Button
              type='submit'
              size='sm'
              className='h-7 gap-1 text-[11.5px]'
              disabled={toggle.isPending}
            >
              <Siren className='h-3.5 w-3.5' /> Start incident
            </Button>
          </form>
        )}
        {(incident?.recent ?? []).filter((r) => r.status === 'closed').length > 0 && (
          <ul className='space-y-1 border-t border-slate-100 pt-2 dark:border-border/60'>
            {(incident?.recent ?? [])
              .filter((r) => r.status === 'closed')
              .slice(0, 5)
              .map((r) => (
                <li key={r.id} className='flex gap-2 text-[11.5px]'>
                  <span
                    className={cn(
                      'shrink-0 font-medium',
                      r.kind === 'incident' ? 'text-red-600 dark:text-red-400' : 'text-amber-600'
                    )}
                  >
                    {r.kind}
                  </span>
                  <span className='min-w-0 flex-1 truncate' title={r.summary ?? ''}>
                    {r.title}
                  </span>
                  <span className='shrink-0 text-slate-400'>
                    {new Date(r.started_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </Frame>
  )
}
