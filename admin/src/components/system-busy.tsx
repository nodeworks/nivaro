import { useLiveEvent, useLiveWatchRoom } from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/**
 * "System busy: nightly reforecast running, about 12 minutes left" (#2024).
 * Administrators only: while a heavy background job, bulk run or import is in
 * flight a small pill says so, so a slow screen has an explanation. The
 * estimate is the median of the same job's last completed runs
 * (`GET /job-runs/busy`); no history means no estimate, only "running".
 * Start/finish events from the jobs watch room refresh it; the poll is the
 * safety net and pauses with the tab.
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
    refetchInterval: (query) => {
      const busy = query.state.data?.busy
      if (live) return busy ? 30_000 : 120_000
      return busy ? 10_000 : 45_000
    },
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
  useLiveEvent(
    'job:update',
    (p: { progress?: unknown }) => {
      // Progress reports do not change what is running; starts and finishes do.
      if (p?.progress || timer.current) return
      timer.current = setTimeout(() => {
        timer.current = null
        void qc.invalidateQueries({ queryKey: ['system-busy'] })
      }, 800)
    },
    { includeOwn: true }
  )

  const items = q.data?.items ?? []
  if (items.length === 0) return null
  return createPortal(
    <div
      role='status'
      aria-live='polite'
      className='fixed left-1/2 top-2 z-[60] max-w-[min(92vw,640px)] -translate-x-1/2'
    >
      <button
        type='button'
        data-system-busy
        onClick={() => navigate('/background-jobs')}
        className='flex w-full items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[12px] font-medium text-amber-800 shadow-sm transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300 dark:hover:bg-amber-500/20'
      >
        <Loader2 className='h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none' aria-hidden />
        <span className='truncate'>{busyText(items)}</span>
      </button>
    </div>,
    document.body
  )
}
