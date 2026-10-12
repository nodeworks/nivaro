import { useEffect, useState } from 'react'
import { cn } from '../../lib/utils'
import type { ImportRunStatus } from './types'

/** The poll is the safety net under the socket, not the primary signal. */
export const LIVE_POLL_MS = 5_000

export const STATUS_STYLE: Record<ImportRunStatus, { dot: string; text: string; label: string }> = {
  queued: { dot: 'bg-slate-400', text: 'text-slate-600 dark:text-slate-300', label: 'Queued' },
  running: { dot: 'bg-nvr-cyan', text: 'text-[#0284a8] dark:text-nvr-cyan', label: 'Running' },
  completed: {
    dot: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-400',
    label: 'Completed'
  },
  error: { dot: 'bg-red-500', text: 'text-red-700 dark:text-red-400', label: 'Error' },
  canceled: { dot: 'bg-slate-300', text: 'text-slate-400 dark:text-slate-500', label: 'Canceled' }
}

export function StatusPill({ status }: { status: ImportRunStatus }) {
  const s = STATUS_STYLE[status]
  return (
    <span className={cn('flex items-center gap-1.5 text-[12px] font-medium', s.text)}>
      <span className='relative flex h-1.5 w-1.5 shrink-0'>
        {status === 'running' && (
          <span
            className={cn(
              'absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping',
              s.dot
            )}
          />
        )}
        <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', s.dot)} />
      </span>
      {s.label}
    </span>
  )
}

/** Seconds since a start point, ticking. Used only while something runs. */
export function useElapsed(startedAt: string | null | undefined, active: boolean): number | null {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
  if (!startedAt || !active) return null
  const seconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
  return seconds >= 0 ? seconds : null
}

/** 1 → "next up", 3 → "3rd in line". */
export function ordinalInLine(position: number): string {
  if (position <= 1) return 'Next up'
  const mod100 = position % 100
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? 'th'
      : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[position % 10] ?? 'th')
  return `${position}${suffix} in line`
}

/** "about 4 minutes" / "under a minute" from an estimate in seconds. */
export function waitEstimate(seconds: number | null | undefined): string | null {
  if (seconds == null) return null
  if (seconds < 60) return 'under a minute'
  const m = Math.round(seconds / 60)
  if (m < 60) return `about ${m} minute${m === 1 ? '' : 's'}`
  const h = Math.round((seconds / 3600) * 10) / 10
  return `about ${h} hour${h === 1 ? '' : 's'}`
}

/** Where a queued run stands: "3rd in line, about 4 minutes" (#1753). */
export function queueStanding(
  q: { position: number; eta_seconds: number | null } | undefined
): string | null {
  if (!q) return null
  const wait = waitEstimate(q.eta_seconds)
  return wait ? `${ordinalInLine(q.position)}, ${wait}` : ordinalInLine(q.position)
}
