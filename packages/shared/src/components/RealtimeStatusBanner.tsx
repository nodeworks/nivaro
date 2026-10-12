import { RefreshCw, Unplug } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useRealtimeStatus } from '../lib/realtime'

/** A drop shorter than this is a blip (a redeploy, a network handover) — no banner for it. */
const SHOW_AFTER_MS = 3000
/** How long the "caught up" line stays after a reconnect. */
const RESUMED_MS = 6000

/**
 * Reconnect banner (#1725): while the host's live connection is down, a small strip says live
 * updates are paused; after the reconnect and catch-up it says so (and, when catch-up had to
 * reload, what was refreshed), then clears itself. Renders nothing for hosts without a
 * realtime status, and nothing while the browser is offline (OfflineBanner says that).
 */
export function RealtimeStatusBanner() {
  const status = useRealtimeStatus()
  const [paused, setPaused] = useState(false)
  const [resumed, setResumed] = useState<string | null>(null)
  const pausedRef = useRef(false)
  const down = status?.state === 'reconnecting'

  useEffect(() => {
    if (!down) return
    const t = setTimeout(() => {
      pausedRef.current = true
      setPaused(true)
    }, SHOW_AFTER_MS)
    return () => clearTimeout(t)
  }, [down])

  useEffect(() => {
    if (down) {
      setResumed(null)
      return
    }
    // Only a banner that was showing earns a "resumed" line; a blip stays silent unless
    // catch-up had to reload, which the viewer should hear about either way.
    const refreshed = status?.refreshed ?? null
    if (!pausedRef.current && !refreshed) return
    pausedRef.current = false
    setPaused(false)
    setResumed(refreshed ?? 'Live updates resumed.')
    const t = setTimeout(() => setResumed(null), RESUMED_MS)
    return () => clearTimeout(t)
  }, [down, status?.refreshed])

  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null
  if (paused && down)
    return (
      <div
        role='status'
        data-realtime-banner='paused'
        className='flex items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
      >
        <Unplug className='h-3.5 w-3.5' />
        Live updates paused, reconnecting. Lists may be out of date until then.
      </div>
    )
  if (resumed)
    return (
      <div
        role='status'
        data-realtime-banner='resumed'
        className='flex items-center justify-center gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-1.5 text-[12px] text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
      >
        <RefreshCw className='h-3.5 w-3.5' />
        {resumed}
      </div>
    )
  return null
}

/**
 * The stale mark lists and queues show while live updates are paused (#1725): what is on
 * screen may be behind. Nothing while live, or for a host without a realtime status.
 */
export function RealtimeStaleMark({ className }: { className?: string }) {
  const status = useRealtimeStatus()
  if (status?.state !== 'reconnecting') return null
  return (
    <span
      data-realtime-stale
      data-tip='Live updates are paused while the connection comes back. Refresh to see the latest.'
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 text-[11px] font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200 ${className ?? ''}`}
    >
      <Unplug className='h-3 w-3' />
      May be stale
    </span>
  )
}
