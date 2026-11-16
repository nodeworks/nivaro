import { useLiveEvent, useLiveWatchRoom } from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'

/**
 * "System busy: nightly reforecast running, about 12 minutes left" (#2024).
 * Administrators only: while a heavy background job, bulk run or import is in
 * flight a small pill says so, so a slow screen has an explanation. The
 * estimate is the median of the same job's last completed runs
 * (`GET /job-runs/busy`); no history means no estimate, only "running".
 *
 * What keeps it current: the jobs watch room says when heavy work starts and
 * ends (`job:update` with `busy: true`), and only those events re-read. Every
 * other run's start and finish is ignored: a busy instance records over a
 * thousand light cron ticks an hour, and re-reading for each made every open
 * admin tab call this route every ten seconds, day and night. A slow poll
 * covers what the room does not carry (a collection import starting) and the
 * "minutes left" text. A hidden tab asks nothing and reads once when it shows
 * again.
 */

interface BusyItem {
  id: number
  kind: string
  label: string
  elapsed_ms: number
  expected_ms: number | null
  remaining_ms: number | null
  overrun: boolean
}

interface BusyPayload {
  busy: boolean
  items: BusyItem[]
}

/** "about 12 minutes left", "less than a minute left", "taking longer than usual". */
export function busyEstimate(item: Pick<BusyItem, 'remaining_ms' | 'overrun'>): string {
  if (item.remaining_ms == null) return ''
  if (item.overrun) return 'taking longer than usual'
  const min = Math.ceil(item.remaining_ms / 60_000)
  if (min <= 1) return 'less than a minute left'
  if (min < 90) return `about ${min} minutes left`
  const h = Math.round(min / 60)
  return `about ${h} hours left`
}

/** The pill's sentence for the running heavy work. */
export function busyText(items: BusyItem[]): string {
  const first = items[0]
  const rest = items.length - 1
  const name = rest > 0 ? `${first.label} and ${rest} more` : first.label
  const est = busyEstimate(first)
  return `System busy: ${name} running${est ? `, ${est}` : ''}`
}

/** A `job:update` payload: the run, its state, and whether the pill counts it. */
export interface JobUpdateEvent {
  id?: unknown
  status?: unknown
  progress?: unknown
  busy?: unknown
}

/**
 * Does this `job:update` change what the pill shows? A run the server marks `busy` starting
 * or ending does; so does the end of a run already on the pill. Progress reports and every
 * other run do not.
 */
export function busyEventMatters(
  p: JobUpdateEvent | null | undefined,
  shownIds: readonly number[]
): boolean {
  if (!p || p.progress) return false
  if (p.busy === true) return true
  return typeof p.id === 'number' && shownIds.includes(p.id)
}

/** The backstop poll: a minute or slower with the watch room, never under 30 s without it. */
export function busyPollMs(live: boolean, busy: boolean | undefined): number {
  if (live) return busy ? 60_000 : 120_000
  return busy ? 30_000 : 60_000
}

export function SystemBusy() {
  const { user } = useAuth()
  if (!user?.is_admin) return null
  return <SystemBusyPill />
}

function SystemBusyPill() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const live = useLiveWatchRoom('jobs')
  const q = useQuery({
    queryKey: ['system-busy'],
    queryFn: () => api.get<{ data: BusyPayload }>('/job-runs/busy').then((r) => r.data.data),
    refetchInterval: (query) => busyPollMs(live, query.state.data?.busy),
    // The poll stops while the tab is hidden; coming back to it reads once.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    // The chip is decoration: a failed read never toasts or retries loudly.
    retry: false
  })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const shownIds = useRef<number[]>([])
  shownIds.current = (q.data?.items ?? []).map((i) => i.id)
  useLiveEvent(
    'job:update',
    (p: JobUpdateEvent) => {
      if (timer.current || document.visibilityState === 'hidden') return
      if (!busyEventMatters(p, shownIds.current)) return
      timer.current = setTimeout(() => {
        timer.current = null
        void qc.invalidateQueries({ queryKey: ['system-busy'] })
      }, 800)
    },
    { includeOwn: true }
  )

  const items = q.data?.items ?? []
  if (items.length === 0) return null
  // A strip in the page's top status stack (with the reconnect strip), never a pill floating
  // over it or over the environment tag (review r-1116b). The tag hangs over the window's top
  // centre, so the first strip's text starts below it; a strip after the reconnect strip
  // (which already makes that room) keeps the normal padding.
  const underEdge =
    typeof document !== 'undefined' && !!document.querySelector('[data-environment-edge]')
  return (
    <div
      role='status'
      aria-live='polite'
      data-system-busy-strip
      className={cn(
        'flex justify-center border-b border-amber-200 bg-amber-50 px-4 pb-1.5 dark:border-amber-500/30 dark:bg-amber-500/10',
        underEdge ? 'pt-[26px] [[data-realtime-banner]~&]:pt-1.5' : 'pt-1.5'
      )}
    >
      <button
        type='button'
        data-system-busy
        onClick={() => navigate('/jobs')}
        data-tip='Open Jobs'
        className='flex min-w-0 max-w-full items-center gap-2 rounded text-[12px] font-medium text-amber-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-amber-200'
      >
        <Loader2
          className='h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none'
          aria-hidden
        />
        <span className='min-w-0 text-left'>{busyText(items)}</span>
      </button>
    </div>
  )
}
