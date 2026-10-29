import { isCodeError } from '@nivaro/shared'
import { api } from './api'

/**
 * Code errors that never reach a React error boundary — a throw in a click handler, a timer, a
 * socket callback or a promise nobody awaited — go to the issue log too (logging audit
 * 2026-10-29: only render crashes were reported, everything else died in the console).
 *
 * Same pipeline as AppLayout's PageErrorBoundary: POST /issues/client (deduped server-side by
 * fingerprint), with the replay link when a recorder is running. Code errors only (isCodeError:
 * a TypeError/ReferenceError/RangeError that is not the network and carries no HTTP status), once
 * per fingerprint and at most MAX_PER_PAGE per page load, never from a browser extension.
 */

const MAX_PER_PAGE = 10

export function errorFingerprint(err: Error): string {
  const frame = (err.stack ?? '').split('\n')[1]?.trim() ?? ''
  return `${err.name}|${err.message}|${frame}`.slice(0, 500)
}

export interface ReportState {
  seen: Set<string>
  sent: number
}

/** Whether a window-level error goes to the issue log; records it as seen when it does. */
export function takeGlobalError(err: unknown, state: ReportState): err is Error {
  if (!isCodeError(err)) return false
  const e = err as Error
  // A browser extension's own script failing is not ours to file.
  if (/(chrome|moz|safari(-web)?)-extension:\/\//.test(e.stack ?? '')) return false
  if (state.sent >= MAX_PER_PAGE) return false
  const key = errorFingerprint(e)
  if (state.seen.has(key)) return false
  state.seen.add(key)
  state.sent++
  return true
}

async function report(err: Error): Promise<void> {
  try {
    const { captureErrorClip } = await import('./use-session-recorder')
    const replay = await captureErrorClip().catch(() => null)
    await api.post('/issues/client', {
      message: err.message || err.name,
      stack: (err.stack ?? '').slice(0, 6000),
      url: window.location.pathname,
      ...(replay
        ? { recording_id: replay.recording_id, recording_offset_ms: replay.offset_ms }
        : {})
    })
  } catch {
    /* reporting an error must never raise another one */
  }
}

/** Installs the window `error` + `unhandledrejection` listeners; returns the uninstaller. */
export function installGlobalErrorReport(target: Window = window): () => void {
  const state: ReportState = { seen: new Set(), sent: 0 }
  const onError = (event: ErrorEvent) => {
    if (takeGlobalError(event.error, state)) void report(event.error)
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    if (takeGlobalError(event.reason, state)) void report(event.reason)
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
