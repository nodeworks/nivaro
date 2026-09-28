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

