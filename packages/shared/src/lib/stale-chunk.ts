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
 * the host can say so instead of looping. A tab holding unsaved work is never reloaded: the
 * host is told (`onHeld`) and the person reloads when they have saved.
 *
 * `guardLazyImport()` wraps a lazily loaded screen so the same failure never reaches the
 * error boundary as a crash: the screen stays loading while the tab reloads, and when no
 * reload can happen it renders the host's "updated, reload" notice in the screen's place.
 */
import { unsavedWorkLabels } from './unsaved-work'

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

/** What one recovery step did: reloaded, would only loop, or held back for unsaved work. */
export type StaleChunkOutcome = 'reload' | 'gave-up' | 'held'

export interface StaleChunkRecoveryOptions {
  /** Called instead of a second reload inside the window. */
  onGiveUp?: () => void
  /** Called instead of a reload while the tab holds unsaved work (the labels say what).
   *  A host without one gets `onGiveUp`. */
  onHeld?: (labels: string[]) => void
  /** Test seams. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  reload?: () => void
  now?: () => number
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  /** What a reload would lose, by label; the unsaved-work registry when not given. */
  unsaved?: () => string[]
}

/**
 * One recovery step: reload, give up when the last reload was less than a minute ago, or
 * hold back while the tab has unsaved work. Returns what it did. Exported for the tests;
 * hosts use `installStaleChunkRecovery`.
 */
export function recoverFromStaleChunk(opts: StaleChunkRecoveryOptions = {}): StaleChunkOutcome {
  let unsaved: string[] = []
  try {
    unsaved = (opts.unsaved ?? unsavedWorkLabels)()
  } catch {
    unsaved = []
  }
  if (unsaved.length > 0) {
    // Not counted as the one reload: once the work is saved, the next failure reloads.
    if (opts.onHeld) opts.onHeld(unsaved)
    else opts.onGiveUp?.()
    return 'held'
  }
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

/** One failure reaches us several ways within a moment (Vite's event, the import's own
 *  rejection, the screen guard): they share one decision. */
const BURST_MS = 2000
/** How long a started reload is given to take the page away before it counts as not
 *  having happened (blocked, or a leave prompt answered "stay"). */
const RELOAD_GRACE_MS = 10_000

function burstRecovery(opts: StaleChunkRecoveryOptions): () => StaleChunkOutcome {
  let last: { outcome: StaleChunkOutcome; at: number } | null = null
  return () => {
    const now = (opts.now ?? Date.now)()
    // A reload is under way, or this is the same failure again.
    const holds = last?.outcome === 'reload' ? RELOAD_GRACE_MS : BURST_MS
    if (last && now - last.at < holds) return last.outcome
    const outcome = recoverFromStaleChunk(opts)
    last = { outcome, at: now }
    return outcome
  }
}

/** The recovery the host installed; screen guards decide through it. */
let installed: (() => StaleChunkOutcome) | null = null
let uninstalled: (() => StaleChunkOutcome) | null = null

/** Listen for chunk-load failures (Vite's preload error and unhandled import rejections). */
export function installStaleChunkRecovery(opts: StaleChunkRecoveryOptions = {}): () => void {
  const target = opts.target ?? (typeof window !== 'undefined' ? window : undefined)
  if (!target) return () => {}
  const handle = burstRecovery(opts)
  installed = handle
  const onPreloadError = () => {
    // The event is left alone on purpose. Cancelling it makes Vite swallow the failure and
    // RESOLVE the import with nothing, and the caller then crashes on its first read of the
    // module ("Cannot read properties of undefined (reading 'CollectionsPage')", 2026-11-11).
    // Uncancelled, the import fails as a failed import, which every caller can tell.
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
    if (installed === handle) installed = null
  }
}

/**
 * Wrap the loader of a lazily shown screen (`React.lazy(guardLazyImport(load, Notice))`).
 *
 * A chunk that cannot be fetched, or that loads without the screen it should export, means
 * this tab runs a build the server no longer serves. The tab reloads once and the screen
 * stays in its loading state meanwhile. When no reload can happen (it was just tried, the
 * tab holds unsaved work, or the reload did not go through) the loader resolves with
 * `fallback`, the host's notice, so the rest of the page stays as it is. Any other error is
 * the screen's own and is rethrown.
 */
export function guardLazyImport<T>(
  load: () => Promise<{ default: T }>,
  fallback: T,
  opts?: StaleChunkRecoveryOptions
): () => Promise<{ default: T }> {
  const own = opts ? burstRecovery(opts) : null
  const stale = (): Promise<{ default: T }> => {
    uninstalled ??= burstRecovery({})
    const recover = own ?? installed ?? uninstalled
    if (recover() !== 'reload') return Promise.resolve({ default: fallback })
    // Reloading: the screen stays loading while the page is on its way out. Should the
    // reload not happen after all, the notice appears instead of a screen that never loads.
    return new Promise<{ default: T }>((resolve) => {
      const timer = setTimeout(() => resolve({ default: fallback }), RELOAD_GRACE_MS)
      ;(timer as { unref?: () => void }).unref?.()
    })
  }
  return () =>
    load().then(
      (mod) => (mod && mod.default !== undefined ? mod : stale()),
      (err: unknown) => {
        if (!isStaleChunkError(err)) throw err
        return stale()
      }
    )
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    return null
  }
}
