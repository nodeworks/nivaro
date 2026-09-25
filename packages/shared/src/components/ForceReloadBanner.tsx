import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'

export interface ForceReloadDetail {
  seconds?: number
  message?: string
}

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
 * newer duration — the later instruction wins.
 */
export function ForceReloadBanner() {
  const [refresh, setRefresh] = useState<{ seconds: number; message: string } | null>(null)
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    const onForce = (e: Event) => {
      const d = ((e as CustomEvent).detail ?? {}) as ForceReloadDetail
      const seconds = Math.max(5, Number(d.seconds) || 30)
      setRefresh({ seconds, message: String(d.message ?? '') })
      setRemaining(seconds)
    }
    window.addEventListener(FORCE_RELOAD_EVENT, onForce)
    return () => window.removeEventListener(FORCE_RELOAD_EVENT, onForce)
  }, [])

  useEffect(() => {
    if (!refresh) return
    const t = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          window.location.reload()
          return 0
        }
        return r - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [refresh])

  if (!refresh) return null
  return (
    <div
      role='alert'
      data-nvr-force-reload={remaining}
      className='fixed inset-x-0 top-0 z-[150] flex items-center justify-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900 dark:border-amber-500/40 dark:bg-[#3a2e10] dark:text-amber-200'
    >
      <RotateCw className='h-4 w-4 animate-spin' />
      <span>
        <span className='font-semibold'>This page will reload in {remaining}s</span>
        {refresh.message ? ` — ${refresh.message}` : ' — an administrator pushed an update.'}
      </span>
      <button
        type='button'
        onClick={() => window.location.reload()}
        className='rounded-md border border-amber-400 bg-white px-2.5 py-1 text-[12px] font-medium text-amber-800 hover:bg-amber-100 dark:bg-transparent dark:text-amber-200'
      >
        Reload now
      </button>
    </div>
  )
}
