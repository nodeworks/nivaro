/**
 * Stale code chunks after a deploy. Screens load lazily by hashed file names, and a new
 * release no longer serves the previous build's files — so a tab opened before the deploy
 * failed to open any screen it had not visited yet ("Failed to fetch dynamically imported
 * module") until someone reloaded. During a rolling deploy one replica briefly serves the new
 * build while another still serves the old one, which makes it likelier.
 *
 * `installStaleChunkRecovery()` reloads the tab onto the current build when a chunk fails to
 * load. A second failure within the window means a reload does not help (the server really
 * is missing the file, or the network is down): it stops reloading and calls `onGiveUp`, so
 * the host can say so instead of looping.
 */

const KEY = 'nvr-stale-chunk-reload'
const WINDOW_MS = 60_000

const STALE_CHUNK_MESSAGES = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /Importing a module script failed/i, // Safari
  /error loading dynamically imported module/i, // Firefox
  /Unable to preload CSS/i // Vite's CSS preload
]

/** Whether an error (or a rejection reason) is a code chunk that could not be loaded. */
export function isStaleChunkError(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : reason && typeof reason === 'object' && 'message' in reason
          ? String((reason as { message: unknown }).message)
          : ''
  return STALE_CHUNK_MESSAGES.some((re) => re.test(message))
}

export interface StaleChunkRecoveryOptions {
  /** Called instead of a second reload inside the window. */
  onGiveUp?: () => void
  /** Test seams. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  reload?: () => void
  now?: () => number
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

/**
 * One recovery step: reload, or give up when the last reload was less than a minute ago.
 * Returns what it did. Exported for the tests; hosts use `installStaleChunkRecovery`.
 */
export function recoverFromStaleChunk(opts: StaleChunkRecoveryOptions = {}): 'reload' | 'gave-up' {
  const now = (opts.now ?? Date.now)()
  const storage = opts.storage === undefined ? safeSessionStorage() : opts.storage
  let last = 0
  try {
    last = Number(storage?.getItem(KEY)) || 0
  } catch {
    last = 0
  }
  if (last && now - last < WINDOW_MS) {
    opts.onGiveUp?.()
    return 'gave-up'
  }
  try {
    storage?.setItem(KEY, String(now))
  } catch {
    /* storage off: still reload once — the next failure reloads again, at worst every load */
  }
  ;(opts.reload ?? (() => window.location.reload()))()
  return 'reload'
}

/** Listen for chunk-load failures (Vite's preload error and unhandled import rejections). */
export function installStaleChunkRecovery(opts: StaleChunkRecoveryOptions = {}): () => void {
  const target = opts.target ?? (typeof window !== 'undefined' ? window : undefined)
  if (!target) return () => {}
  let handled = false
  const handle = () => {
    if (handled) return
    handled = true
    if (recoverFromStaleChunk(opts) === 'gave-up') handled = false
  }
  const onPreloadError = (event: Event) => {
    // Vite rethrows the import error unless the event is cancelled.
    event.preventDefault()
    handle()
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!isStaleChunkError(event.reason)) return
    event.preventDefault()
    handle()
  }
  target.addEventListener('vite:preloadError', onPreloadError)
  target.addEventListener('unhandledrejection', onRejection as EventListener)
  return () => {
    target.removeEventListener('vite:preloadError', onPreloadError)
    target.removeEventListener('unhandledrejection', onRejection as EventListener)
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    return null
  }
}
