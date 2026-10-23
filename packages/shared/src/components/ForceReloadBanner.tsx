import { PauseCircle, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { markReloadFor } from '../lib/client-version'
import {
  type ForceReloadDetail,
  shouldObeyForceReload,
  thisTabForReload
} from '../lib/force-reload'
import { subscribeUnsavedWork, unsavedWorkLabels } from '../lib/unsaved-work'

export type { ForceReloadDetail }

/** The window event a host's socket layer dispatches on `client:force-refresh`. */
export const FORCE_RELOAD_EVENT = 'nvr:force-refresh'

/**
 * Remote client reload: an admin pushed `POST /realtime/force-refresh` (to
 * everyone, to one app, or to named people) and this tab was told. Shows a
 * countdown, then reloads — the "Reload now" button skips the wait.
 *
 * The socket listener lives in each host (admin `lib/socket.ts`, efp-new
 * `lib/socket.ts`): it turns the socket event into the `nvr:force-refresh`
 * window event, so this component needs no client and mounts anywhere near
 * the app root. Mount it once per host.
 *
 * A second push while a countdown is running restarts the clock with the
 * newer duration — the later instruction wins. The same instruction arriving
 * twice (live, then again on a reconnect) is ignored.
 *
 * The countdown runs against a wall-clock deadline, not a count of timer
 * ticks: a background tab's timers wake about once a minute, so counting 15
 * ticks took 15 minutes there (staging, 2026-10-23 — idle tabs on an old
 * build never reloaded while the admin watched). A throttled tab reloads at
 * its first wake past the deadline, and a frozen one the moment it is shown
 * or focused again.
 *
 * Sticky refresh: a tab that was asleep or offline is told when it reconnects,
 * and a tab below an app's minimum build is told on connect
 * (api/src/services/sticky-refresh.ts). Each checks for itself first
 * (lib/force-reload.ts) and marks the instruction before reloading, so it
 * never reloads twice for one instruction (twice at most for a minimum build).
 *
 * Unsaved work (lib/unsaved-work.ts) holds the reload: past the deadline the
 * banner says a reload is waiting and reloads the moment the edits are saved
 * or discarded — or when the person clicks Reload now.
 */
export function ForceReloadBanner() {
  const [refresh, setRefresh] = useState<{
    deadline: number
    message: string
    id: string | null
  } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [held, setHeld] = useState<string[]>([])
  const reloading = useRef(false)
  const declined = useRef(false)
  const seen = useRef(new Set<string>())

  useEffect(() => {
    const onForce = (e: Event) => {
      const d = ((e as CustomEvent).detail ?? {}) as ForceReloadDetail
      const id = typeof d.id === 'string' && d.id ? d.id : null
      if (id && seen.current.has(id)) return
      if (!shouldObeyForceReload(d, thisTabForReload())) return
      if (id) seen.current.add(id)
      declined.current = false
      setHeld([])
      const seconds = Math.max(5, Number(d.seconds) || 30)
      const at = Date.now()
      setRefresh({ deadline: at + seconds * 1000, message: String(d.message ?? ''), id })
      setNow(at)
    }
    window.addEventListener(FORCE_RELOAD_EVENT, onForce)
    return () => window.removeEventListener(FORCE_RELOAD_EVENT, onForce)
  }, [])

  useEffect(() => {
    if (!refresh) return
    const reload = () => {
      if (reloading.current) return
      reloading.current = true
      if (refresh.id) markReloadFor(refresh.id)
      window.location.reload()
      // A page's own leave prompt answered "stay" keeps the page: never ask again on a timer —
      // the banner waits for Reload now.
      setTimeout(() => {
        reloading.current = false
        declined.current = true
        setHeld(['unsaved changes on this page'])
      }, 1500)
    }
    const check = () => {
      const t = Date.now()
      setNow(t)
      if (t < refresh.deadline || reloading.current || declined.current) return
      const waiting = unsavedWorkLabels()
      setHeld((cur) => (cur.join('|') === waiting.join('|') ? cur : waiting))
      if (waiting.length === 0) reload()
    }
    const timer = setInterval(check, 1000)
    // A frozen or long-throttled tab: decide the moment it wakes, not a tick later.
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('pageshow', check)
    // Saved or discarded: reload at once instead of on the next tick.
    const offUnsaved = subscribeUnsavedWork(() => setTimeout(check, 0))
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('pageshow', check)
      offUnsaved()
    }
  }, [refresh])

  const remaining = refresh ? Math.max(0, Math.ceil((refresh.deadline - now) / 1000)) : 0
  const waiting = remaining === 0 && held.length > 0

  if (!refresh) return null
  return (
    <div
      role='alert'
      data-nvr-force-reload={remaining}
      data-nvr-force-reload-held={waiting ? 'true' : undefined}
      data-nvr-recording-hide
      className='fixed inset-x-0 top-0 z-[150] flex items-center justify-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900 dark:border-amber-500/40 dark:bg-[#3a2e10] dark:text-amber-200'
    >
      {waiting ? (
        <PauseCircle className='h-4 w-4 shrink-0' />
      ) : (
        <RotateCw className='h-4 w-4 shrink-0 animate-spin' />
      )}
      <span>
        {waiting ? (
          <>
            <span className='font-semibold'>A reload is waiting</span> — save or discard your
            changes ({held.join(', ').toLowerCase()}) and the page reloads.
          </>
        ) : (
          <>
            <span className='font-semibold'>This page will reload in {remaining}s</span>
            {refresh.message ? ` — ${refresh.message}` : ' — an administrator pushed an update.'}
          </>
        )}
      </span>
      <button
        type='button'
        onClick={() => {
          reloading.current = true
          if (refresh.id) markReloadFor(refresh.id)
          window.location.reload()
          // A form's leave prompt may keep the page: let the hold pick up again.
          setTimeout(() => {
            reloading.current = false
          }, 1500)
        }}
        className='shrink-0 rounded-md border border-amber-400 bg-white px-2.5 py-1 text-[12px] font-medium text-amber-800 hover:bg-amber-100 dark:bg-transparent dark:text-amber-200'
      >
        Reload now
      </button>
    </div>
  )
}
