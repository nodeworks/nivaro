import { pagePattern } from './page-context'
import type { ReplayLink } from './replay-capture'
import { isCodeError } from './safe-error'

/**
 * Front-end crash reporter (Issue Log → Crashes). One per tab: every uncaught render error (an
 * error boundary calls `report(err, 'render', componentStack)`), window `error` and
 * `unhandledrejection` becomes ONE POST /issues/client with:
 *
 *   message, name, stack (scrubbed), kind, app, screen (route PATTERN, never ids or query),
 *   release (the build), and the replay link when error replay is on.
 *
 * The server groups by signature + screen + release, counts people and alerts admins when a
 * release brings a new crash (api services/crash-tracking.ts) — this side only decides what is
 * worth sending:
 *
 * - window errors and rejections only when they are bugs in our code: an Error that is not the
 *   network, carries no HTTP status and is not an abort/cancel (the server already logged its
 *   own answers). Render errors always are.
 * - never a browser extension's script, never a cross-origin "Script error." without an Error.
 * - deduped per tab: the same error is re-sent at most once per `dedupeMs` (5 minutes), so a
 *   render loop is one report and a crash that keeps happening still counts.
 * - rate-limited per tab: at most `maxPerMinute` (6) a minute and `maxPerTab` (30) per page load.
 * - scrubbed (`scrubCrashText`): tokens, passwords, emails, long opaque strings, URL query strings
 *   and quoted values that are not identifiers. Form values never leave the tab. The server
 *   scrubs again; its pass is the one that counts.
 *
 * Never throws; a failed send is dropped.
 */

export type CrashKind = 'render' | 'error' | 'rejection'

export interface CrashBody {
  message: string
  name: string
  stack?: string
  kind: CrashKind
  app: string
  screen: string
  /** Kept for servers before crash grouping (they file by `url`); a route pattern too. */
  url: string
  release?: string
  recording_id?: string
  recording_offset_ms?: number | null
}

const REPLACERS: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  // First: a URL keeps its path (the bundle file a frame names) and loses its query and
  // fragment, before any key=value rule reads a query parameter as a secret.
  [/(\bhttps?:\/\/[^\s?#'"<>)]*)[?#][^\s:'"<>)]*/gi, '$1'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer <redacted>'],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}/g, '<jwt>'],
  [/\bnv[a-z]{1,3}_[A-Za-z0-9_-]{6,}/g, '<token>'],
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|cookie|session(?:id)?)(["']?\s*[:=]\s*)(["']?)[^\s"'&,;)}\]]+/gi,
    (_m, k: string, sep: string, q: string) => `${k}${sep}${q}<redacted>`
  ],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>'],
  [
    /[A-Za-z0-9+/_-]{32,}={0,2}/g,
    (m: string) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<redacted>' : m)
  ],
  [
    /(["'`])((?:(?!\1)[^\\\n]|\\.){0,300})\1/g,
    (m: string, q: string, inner: string) =>
      /^[A-Za-z_$][\w$.-]{0,59}$/.test(inner) || inner === '' ? m : `${q}…${q}`
  ]
]

/**
 * Text with secrets and typed values replaced, capped at `max`. Twin of api
 * services/crash-signature.ts `scrubCrashText` (keep the rules the same).
 */
export function scrubCrashText(text: string | null | undefined, max = 6000): string {
  let s = String(text ?? '')
  for (const [re, rep] of REPLACERS) s = s.replace(re, rep as never)
  return s.slice(0, max)
}

const NETWORKISH = /failed to fetch|load failed|networkerror|network request failed|network error/i
const STALE_CHUNK =
  /dynamically imported module|importing a module script failed|loading (?:css )?chunk \S+ failed|error loading dynamically/i
const IGNORED_NAMES = new Set(['AbortError', 'CanceledError', 'ChunkLoadError', 'TimeoutError'])
const EXTENSION = /(chrome|moz|safari(-web)?)-extension:\/\//

/** Is a window error / unhandled rejection a crash in our own code worth filing? */
export function isCrashWorthy(err: unknown): err is Error {
  if (!(err instanceof Error)) return false
  if (isCodeError(err)) return !EXTENSION.test(err.stack ?? '')
  const e = err as Error & { status?: unknown; response?: unknown; code?: unknown }
  if (e.status != null || e.response != null) return false
  if (IGNORED_NAMES.has(e.name) || e.code === 'ERR_CANCELED') return false
  if (NETWORKISH.test(e.message) || STALE_CHUNK.test(e.message)) return false
  if (EXTENSION.test(e.stack ?? '')) return false
  // A plain Error (or a subclass we threw) that nobody caught.
  return true
}

/** The per-tab dedupe key: name, message and the first stack frame. */
export function crashKey(err: Error): string {
  const frame = (err.stack ?? '').split('\n').find((l) => /^\s*at\s|@/.test(l)) ?? ''
  return `${err.name}|${err.message}|${frame.trim()}`.slice(0, 500)
}

export interface CrashReporterOptions {
  app: string
  /** The build this tab runs (also sent as x-nivaro-client by the page-context fetch). */
  release?: string | (() => string | undefined)
  send: (body: CrashBody) => Promise<unknown>
  /** The error replay clip (or live recording offset); null when replay is off. */
  captureReplay?: () => Promise<ReplayLink | null>
  /** The current screen's route pattern; default `pagePattern(location.pathname)`. */
  screen?: () => string
  maxPerMinute?: number
  maxPerTab?: number
  dedupeMs?: number
  now?: () => number
}

export interface CrashReporter {
  /** File one crash; false when it was dropped (not worth it, a repeat, or over the limit). */
  report(err: unknown, kind: CrashKind, componentStack?: string | null): boolean
  /** Window `error` + `unhandledrejection` listeners; returns the uninstaller. */
  install(target?: Window): () => void
  /** Tests: how many reports this tab has sent. */
  readonly sent: number
}

export function buildCrashBody(
  err: Error,
  kind: CrashKind,
  ctx: {
    app: string
    screen: string
    release?: string
    componentStack?: string | null
    replay?: ReplayLink | null
  }
): CrashBody {
  const stack = scrubCrashText(
    [err.stack, ctx.componentStack].filter(Boolean).join('\n---\n'),
    6000
  )
  const screen = pagePattern(ctx.screen)
  return {
    message: scrubCrashText(err.message || err.name || 'Unknown error', 400),
    name: String(err.name || 'Error').slice(0, 60),
    ...(stack ? { stack } : {}),
    kind,
    app: ctx.app,
    screen,
    url: screen,
    ...(ctx.release ? { release: String(ctx.release).slice(0, 60) } : {}),
    ...(ctx.replay
      ? { recording_id: ctx.replay.recording_id, recording_offset_ms: ctx.replay.offset_ms }
      : {})
  }
}

export function createCrashReporter(opts: CrashReporterOptions): CrashReporter {
  const now = opts.now ?? (() => Date.now())
  const maxPerMinute = opts.maxPerMinute ?? 6
  const maxPerTab = opts.maxPerTab ?? 30
  const dedupeMs = opts.dedupeMs ?? 5 * 60_000
  const lastSent = new Map<string, number>()
  const window60: number[] = []
  let sent = 0

  const screenNow = () => {
    try {
      return opts.screen ? opts.screen() : typeof location !== 'undefined' ? location.pathname : '/'
    } catch {
      return '/'
    }
  }

  const take = (err: Error): boolean => {
    if (sent >= maxPerTab) return false
    const t = now()
    while (window60.length && t - window60[0] >= 60_000) window60.shift()
    if (window60.length >= maxPerMinute) return false
    const key = crashKey(err)
    const last = lastSent.get(key)
    if (last != null && t - last < dedupeMs) return false
    lastSent.set(key, t)
    if (lastSent.size > 200) lastSent.delete(lastSent.keys().next().value as string)
    window60.push(t)
    sent++
    return true
  }

  const send = async (err: Error, kind: CrashKind, componentStack?: string | null) => {
    try {
      // The screen is read at the moment of the crash, before the replay wait.
      const screen = screenNow()
      const replay = opts.captureReplay ? await opts.captureReplay().catch(() => null) : null
      const release = typeof opts.release === 'function' ? opts.release() : opts.release
      await opts.send(
        buildCrashBody(err, kind, { app: opts.app, screen, release, componentStack, replay })
      )
    } catch {
      /* reporting a crash must never raise another one */
    }
  }

  const reporter: CrashReporter = {
    report(raw, kind, componentStack) {
      // Outside a render only a real Error is ours to file (a library rejecting with a plain
      // object or string is its own answer); a render can throw anything and it still crashed.
      if (kind !== 'render' && !(raw instanceof Error)) return false
      const err =
        raw instanceof Error
          ? raw
          : new Error(typeof raw === 'string' ? raw : 'Non-error value thrown')
      if (kind !== 'render' && !isCrashWorthy(err)) return false
      if (kind === 'render' && EXTENSION.test(err.stack ?? '')) return false
      if (!take(err)) return false
      void send(err, kind, componentStack)
      return true
    },
    install(target = window) {
      const onError = (event: ErrorEvent) => {
        // A cross-origin "Script error." has no Error object: nothing to file.
        if (event.error) reporter.report(event.error, 'error')
      }
      const onRejection = (event: PromiseRejectionEvent) => {
        reporter.report(event.reason, 'rejection')
      }
      target.addEventListener('error', onError)
      target.addEventListener('unhandledrejection', onRejection)
      return () => {
        target.removeEventListener('error', onError)
        target.removeEventListener('unhandledrejection', onRejection)
      }
    },
    get sent() {
      return sent
    }
  }
  return reporter
}
