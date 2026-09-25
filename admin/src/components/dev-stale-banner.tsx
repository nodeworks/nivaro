import { useEffect, useState } from 'react'

/**
 * Development only: says when the running API is on code older than what is
 * on disk (tsx watch missed a restart, or an extension changed). The dev API
 * reports its start time and the newest source file changed after it as `dev`
 * on /api/version. Production builds never render it.
 */

interface DevInfo {
  started_at: string
  api_stale: { file: string; changed_at: string } | null
}

const POLL_MS = 30_000
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** Pure: the sentences to show, empty when everything is current. */
export function staleMessages(dev: DevInfo | null): string[] {
  if (!dev) return []
  const out: string[] = []
  if (dev.api_stale) {
    out.push(
      `The API is running code loaded at ${time(dev.started_at)} — ${dev.api_stale.file} changed at ${time(dev.api_stale.changed_at)}. Restart the API.`
    )
  }
  return out
}

type Restart =
  | { state: 'idle' }
  | { state: 'restarting'; from: string }
  | { state: 'failed'; text: string }

export function DevStaleBanner() {
  const [dev, setDev] = useState<DevInfo | null>(null)
  const [hidden, setHidden] = useState(false)
  const [restart, setRestart] = useState<Restart>({ state: 'idle' })

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

  // After a restart request, poll every 2s until a process with a different
  // started_at answers; the banner then clears on its own (fresh code, not
  // stale). 60s without a new process = the restart did not happen.
  useEffect(() => {
    if (restart.state !== 'restarting') return
    let stop = false
    const started = Date.now()
    const tick = () => {
      if (stop) return
      fetch('/api/version', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (stop) return
          const now = (j?.dev as DevInfo | undefined) ?? null
          if (now && now.started_at !== restart.from) {
            setDev(now)
            setRestart({ state: 'idle' })
            return
          }
          if (Date.now() - started > 60_000) {
            setRestart({
              state: 'failed',
              text: 'No new process answered in 60s — restart it by hand.'
            })
            return
          }
          setTimeout(tick, 2_000)
        })
        .catch(() => setTimeout(tick, 2_000))
    }
    setTimeout(tick, 2_000)
    return () => {
      stop = true
    }
  }, [restart])

  const requestRestart = () => {
    if (!dev) return
    fetch('/api/dev/restart', { method: 'POST', credentials: 'include' })
      .then(async (r) => {
        if (r.ok) setRestart({ state: 'restarting', from: dev.started_at })
        else {
          const j = await r.json().catch(() => null)
          setRestart({ state: 'failed', text: j?.error ?? `restart refused (${r.status})` })
        }
      })
      .catch((e) => setRestart({ state: 'failed', text: String(e) }))
  }

  const lines = staleMessages(dev)
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
        {restart.state === 'failed' && (
          <p className='text-rose-700 dark:text-rose-300' data-dev-stale-restart-error>
            {restart.text}
          </p>
        )}
      </div>
      <button
        type='button'
        onClick={requestRestart}
        disabled={restart.state === 'restarting'}
        className='shrink-0 rounded border border-amber-400 bg-white px-2 py-0.5 text-[12px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-500/50 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-400/10'
        data-dev-stale-restart
      >
        {restart.state === 'restarting' ? 'Restarting…' : 'Restart the API'}
      </button>
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
