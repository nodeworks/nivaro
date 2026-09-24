import { SHARED_BUILT_AT } from '@nivaro/shared'
import { useEffect, useState } from 'react'

/**
 * Development only: says when the running API or this admin tab is on code
 * older than what is on disk (a watcher that missed a restart, or vite serving
 * a stale build of @nivaro/shared). The dev API reports its own start time,
 * the newest source file changed after it, and the shared build stamp on disk
 * as `dev` on /api/version; this compares that stamp with the one this tab
 * actually loaded. Production builds never render it.
 */

interface DevInfo {
  started_at: string
  api_stale: { file: string; changed_at: string } | null
  shared_built_at: string | null
}

const POLL_MS = 30_000
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** Pure: the sentences to show, empty when everything is current. */
export function staleMessages(dev: DevInfo | null, loadedShared: string | null): string[] {
  if (!dev) return []
  const out: string[] = []
  if (dev.api_stale) {
    out.push(
      `The API is running code loaded at ${time(dev.started_at)} — ${dev.api_stale.file} changed at ${time(dev.api_stale.changed_at)}. Restart the API.`
    )
  }
  if (loadedShared && dev.shared_built_at && dev.shared_built_at > loadedShared) {
    out.push(
      `This tab is running shared code built at ${time(loadedShared)}; the build on disk is from ${time(dev.shared_built_at)}. Reload — if this stays, restart the admin dev server.`
    )
  }
  return out
}

export function DevStaleBanner() {
  const [dev, setDev] = useState<DevInfo | null>(null)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    let stop = false
    const check = () => {
      if (document.hidden) return
      fetch('/api/version', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!stop) setDev((j?.dev as DevInfo | undefined) ?? null)
        })
        .catch(() => {})
    }
    check()
    const t = setInterval(check, POLL_MS)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [])

  const lines = staleMessages(dev, SHARED_BUILT_AT)
  if (!import.meta.env.DEV || hidden || lines.length === 0) return null
  return (
    <div
      data-dev-stale
      className='flex items-start gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-400/10 dark:text-amber-200'
    >
      <span className='mt-px font-semibold'>Dev</span>
      <div className='flex-1 space-y-0.5'>
        {lines.map((l) => (
          <p key={l} data-dev-stale-line>
            {l}
          </p>
        ))}
      </div>
      <button
        type='button'
        onClick={() => setHidden(true)}
        className='text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100'
        aria-label='Hide until the next reload'
      >
        ✕
      </button>
    </div>
  )
}
