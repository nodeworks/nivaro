import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigation, useOptionalNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useLiveAvailable, useLiveEvent } from '../../lib/live'
import { DeclareIncidentButton } from './DeclareIncidentButton'
import { GameDayStrip } from './GameDayStrip'

/**
 * "Drill running" banner (#2846): while any chaos fault is armed on this instance, every app
 * shows a striped, calm-but-unmissable strip — which fault, on what, who started it, when it
 * ends, and a Stop link for chaos operators — so nobody debugs a fake outage or files a ticket
 * about it. Data: `GET /api/chaos/armed` (labels, names and end times only) plus the
 * `chaos:armed` socket event; once the server says chaos is refused here, the banner asks
 * nothing more. Mount once per app shell inside a NivaroProvider; renders nothing when idle.
 */

export interface PublicArmedFault {
  id: string
  fault_key: string
  label: string
  /** Wording, never an id or pattern: "everything", "10% of traffic", "one person"… */
  target: string
  started_by_name: string | null
  started_at: number
  ends_at: number
  run_id: string | null
}

export interface ArmedFaultsState {
  allowed: boolean
  armed: PublicArmedFault[]
}

export const ARMED_FAULTS_KEY = ['chaos-armed'] as const

/**
 * The armed faults every signed-in person may see. Polls slowly (the socket event is the
 * fast path) and stops altogether once the gate said no.
 */
export function useArmedFaults(): ArmedFaultsState & { ready: boolean } {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const live = useLiveAvailable()
  const { data } = useQuery<ArmedFaultsState>({
    queryKey: ARMED_FAULTS_KEY,
    queryFn: () =>
      client!
        .request<{ data: ArmedFaultsState }>(get('/chaos/armed'))
        .then((r) => r.data ?? { allowed: false, armed: [] })
        .catch(() => ({ allowed: false, armed: [] })),
    enabled: !!client,
    staleTime: 15_000,
    refetchInterval: (q) => {
      const d = q.state.data
      if (d && !d.allowed) return false
      return live ? 120_000 : 30_000
    }
  })
  useLiveEvent(
    'chaos:armed',
    (p: { armed?: PublicArmedFault[] }) => {
      if (Array.isArray(p?.armed))
        qc.setQueryData<ArmedFaultsState>(ARMED_FAULTS_KEY, { allowed: true, armed: p.armed })
      else void qc.invalidateQueries({ queryKey: ARMED_FAULTS_KEY })
    },
    { includeOwn: true, enabled: !!client && data?.allowed !== false }
  )
  return { allowed: data?.allowed ?? true, armed: data?.armed ?? [], ready: !!data }
}

/** mm:ss until `endsAt`, never negative. */
export function drillCountdown(endsAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((endsAt - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export interface DrillBannerProps {
  /** Where Stop sends operators (the chaos console). Default `/chaos`. */
  stopHref?: string
  /** Show the Stop link (chaos operators / administrators). */
  canStop?: boolean
}

export function DrillBanner({ stopHref = '/chaos', canStop = false }: DrillBannerProps) {
  const { armed, allowed } = useArmedFaults()
  const { navigate, consoleUrl } = useNavigation()
  const [now, setNow] = useState(() => Date.now())
  const live = armed.filter((f) => f.ends_at > now)
  useEffect(() => {
    if (!armed.length) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [armed.length])
  // Nothing this person may see is armed: a running game day they take part in still gets a
  // calm strip with Declare incident (#2854 — in blind mode that is all a responder sees).
  if (live.length === 0) return <GameDayStrip enabled={allowed} />
  const first = live[0]
  const href = consoleUrl ? consoleUrl(stopHref) : stopHref
  const soonest = live.reduce((m, f) => Math.min(m, f.ends_at), Number.POSITIVE_INFINITY)
  return (
    <div
      role='status'
      aria-live='polite'
      data-drill-banner
      data-nvr-recording-hide
      className='relative flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-red-200 bg-red-50 px-4 py-1.5 text-[12.5px] text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200'
    >
      <span
        aria-hidden
        className='pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-[repeating-linear-gradient(135deg,rgb(239_68_68)_0_8px,transparent_8px_16px)] opacity-70 dark:bg-[repeating-linear-gradient(135deg,rgb(248_113_113)_0_8px,transparent_8px_16px)]'
      />
      {/* The dot rides the first line of the title, so a narrow screen never strands it alone. */}
      <span className='flex min-w-0 items-start gap-2 font-medium'>
        <span className='relative mt-[5px] flex h-2 w-2 shrink-0' aria-hidden>
          <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75 motion-reduce:animate-none' />
          <span className='relative inline-flex h-2 w-2 rounded-full bg-red-500' />
        </span>
        <span className='min-w-0'>
          Drill running: {first.label}
          <span className='font-normal'> on {first.target}</span>
          {live.length > 1 && (
            <span
              className='font-normal underline decoration-red-300 decoration-dotted underline-offset-2 dark:decoration-red-700'
              data-tip={live
                .slice(1)
                .map((f) => `${f.label} on ${f.target}`)
                .join(' · ')}
            >
              {' '}
              and {live.length - 1} more fault{live.length > 2 ? 's' : ''}
            </span>
          )}
        </span>
      </span>
      <span className='min-w-0 text-red-800/80 dark:text-red-300/80'>
        {first.started_by_name ? `started by ${first.started_by_name} · ` : ''}
        ends in <span className='font-mono tabular-nums'>{drillCountdown(soonest, now)}</span>
        {' · '}this is a planned test, not an outage
      </span>
      <DeclareIncidentButton className='ml-auto' />
      {canStop && href && (
        <a
          href={href}
          onClick={(e) => {
            if (/^https?:/i.test(href)) return
            e.preventDefault()
            navigate(href)
          }}
          data-tip='Open the chaos console to stop it'
          className='inline-flex h-7 shrink-0 items-center rounded-md border border-red-300 bg-white px-2.5 text-[12px] font-medium text-red-700 transition-colors duration-150 hover:border-red-400 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200 dark:hover:border-red-700 dark:hover:bg-red-900/50'
        >
          Stop
        </a>
      )}
    </div>
  )
}
