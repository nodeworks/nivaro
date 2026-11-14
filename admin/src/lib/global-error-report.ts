import { type CrashReporter, createCrashReporter } from '@nivaro/shared'
import { api } from './api'

/**
 * The admin's crash reporter (Issue Log → Crashes): every uncaught render error (AppLayout's
 * PageErrorBoundary calls `reportRenderCrash`), window error and unhandled rejection goes to
 * POST /issues/client as one report — scrubbed, deduped and rate-limited per tab by the shared
 * reporter (packages/shared lib/crash-report.ts), with the replay link when a recorder runs.
 * The server groups it by signature + screen + release and alerts admins when a release brings
 * a new crash (api services/crash-tracking.ts).
 */

const RELEASE = typeof __NIVARO_ADMIN_BUILD__ === 'string' ? __NIVARO_ADMIN_BUILD__ : 'dev'

let reporter: CrashReporter | null = null

export function adminCrashReporter(): CrashReporter {
  reporter ??= createCrashReporter({
    app: 'admin',
    release: RELEASE,
    send: (body) => api.post('/issues/client', body),
    captureReplay: async () => {
      const { captureErrorClip } = await import('./use-session-recorder')
      return captureErrorClip()
    }
  })
  return reporter
}

/** A render crash caught by an error boundary (componentDidCatch). */
export function reportRenderCrash(error: unknown, componentStack?: string | null): void {
  adminCrashReporter().report(error, 'render', componentStack)
}

/** Installs the window `error` + `unhandledrejection` listeners; returns the uninstaller. */
export function installGlobalErrorReport(target: Window = window): () => void {
  return adminCrashReporter().install(target)
}
