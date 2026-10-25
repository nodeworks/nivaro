import { isCodeError, SOMETHING_WENT_WRONG } from './safe-error'

/**
 * One plain sentence for a read that failed (#2858), whatever shape the error came in: an SDK
 * error (`status`), an axios error (`response.status`) or a fetch that never reached anything
 * (a TypeError with no status). Used where a widget or panel used to print the raw error.
 */
export function loadErrorStatus(err: unknown): number | null {
  const e = err as { status?: unknown; response?: { status?: unknown } } | null
  const s = e?.status ?? e?.response?.status
  return typeof s === 'number' ? s : null
}

export function loadErrorText(err: unknown, what = 'this'): string {
  const status = loadErrorStatus(err)
  if (status == null) {
    const msg = err instanceof Error ? err.message : String(err ?? '')
    if (
      /timed? ?out|timeout/i.test(msg) ||
      (err as { name?: string } | null)?.name === 'TimeoutError'
    )
      return `Couldn’t load ${what}: it is taking too long to answer.`
    if (/network|failed to fetch|load failed/i.test(msg))
      return 'Can’t reach the server. Check the connection.'
    // A bug in our own code ("Cannot read properties of null") is not a
    // connection problem — say so plainly; never its raw text.
    if (isCodeError(err)) return SOMETHING_WENT_WRONG
    return `Couldn’t load ${what}.`
  }
  if (status === 502 || status === 503 || status === 504)
    return 'The service behind this is unavailable right now.'
  if (status === 401) return 'Your sign-in has ended. Sign in again to see it.'
  if (status === 403) return 'You don’t have access to this.'
  if (status === 404)
    return `${what === 'this' ? 'This' : what[0].toUpperCase() + what.slice(1)} no longer exists.`
  if (status === 429) return 'Too many requests just now. Try again in a moment.'
  if (status >= 500) return `The server hit an error loading ${what}.`
  return `Couldn’t load ${what}.`
}

const BARE_STATUS =
  /^(service unavailable|internal server error|bad gateway|gateway timeout|not found|forbidden|unauthorized)$/i

/**
 * The server's own explanation, when it gave one worth showing (`{error}` in the body, through
 * axios's `response.data` or the SDK's `response`); null for a bare status text.
 */
export function serverErrorText(err: unknown): string | null {
  const e = err as { response?: { data?: { error?: unknown }; error?: unknown } } | null
  const raw = e?.response?.data?.error ?? e?.response?.error
  if (typeof raw !== 'string') return null
  const msg = raw.trim()
  if (!msg || BARE_STATUS.test(msg)) return null
  return msg.length > 200 ? `${msg.slice(0, 197)}…` : msg
}

/** The body of a failed read, whichever client carried it (SDK `response`, axios `response.data`). */
function errorBody(err: unknown): { code?: unknown; message?: unknown } | null {
  const e = err as { response?: { data?: unknown } & Record<string, unknown> } | null
  const r = e?.response
  if (!r || typeof r !== 'object') return null
  const data = (r as { data?: unknown }).data
  return (data && typeof data === 'object' ? data : r) as { code?: unknown; message?: unknown }
}

/**
 * A list or search the server gave up on: 503 with code LIST_TIMEOUT, or (5xx
 * bodies carry no code) its "took too long" sentence. Distinct from the busy
 * pool's 503 SERVER_BUSY only in wording — both read as "try again", never as
 * an empty list.
 */
export function isListTimeout(err: unknown): boolean {
  if (loadErrorStatus(err) !== 503) return false
  const body = errorBody(err)
  if (body?.code === 'LIST_TIMEOUT') return true
  return typeof body?.message === 'string' && /took too long/i.test(body.message)
}

/**
 * What a list shows in place of its rows when the read failed: a 503's own
 * words ("This search took too long to finish…", "The server is busy right
 * now…"), else the plain load-error sentence. Never "0 items".
 */
export function listLoadErrorText(err: unknown): string {
  if (loadErrorStatus(err) === 503) {
    const msg = errorBody(err)?.message
    if (typeof msg === 'string' && msg.trim()) return msg.trim()
    return 'The server is busy right now. Please try again in a few seconds.'
  }
  return loadErrorText(err, 'this list')
}
