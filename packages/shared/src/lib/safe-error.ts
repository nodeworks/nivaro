import { reportClientCrash } from './client-crash'

/**
 * No raw JavaScript error text on screen, ever. "Cannot read properties of
 * null (reading 'id')" told a person nothing and invited them to press Save
 * again (2026-10-23: a duplicate workflow). A code error (a TypeError,
 * ReferenceError or RangeError that is not a network failure and carries no
 * HTTP status) shows one plain sentence instead, and the real error goes to
 * the issue log through the client crash report. A SyntaxError is left alone:
 * at runtime it comes from JSON.parse / RegExp on what a person typed, and its
 * text tells them what to fix.
 */

export const SOMETHING_WENT_WRONG = 'Something went wrong — it’s been reported'

const NETWORKISH = /failed to fetch|load failed|networkerror|network request failed|network error/i

function statusOf(err: unknown): number | null {
  const e = err as { status?: unknown; response?: { status?: unknown } } | null
  const s = e?.status ?? e?.response?.status
  return typeof s === 'number' ? s : null
}

/** A bug in our own code (not the server's answer, not the network). */
export function isCodeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (statusOf(err) != null) return false
  if ((err as { response?: unknown }).response != null) return false
  if (NETWORKISH.test(err.message)) return false
  return err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError
}

const BARE_STATUS =
  /^(bad request|unauthorized|forbidden|not found|conflict|unprocessable entity|too many requests|internal server error|bad gateway|service unavailable|gateway timeout)$/i

/**
 * The server's own explanation, through the SDK (`response`) or axios
 * (`response.data`): `error` when it says something, else `message` (a coded
 * refusal answers `{error: 'Unprocessable Entity', message: '<why>'}`).
 */
function serverText(err: unknown): string | null {
  const e = err as {
    response?: { data?: { error?: unknown; message?: unknown }; error?: unknown; message?: unknown }
  } | null
  const bodies = [e?.response?.data, e?.response]
  for (const b of bodies) {
    const raw = b?.error
    if (typeof raw === 'string' && raw.trim() && !BARE_STATUS.test(raw.trim())) return raw.trim()
  }
  for (const b of bodies) {
    const raw = b?.message
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return null
}

/**
 * The sentence to show for a failed action: the server's explanation when it
 * gave one, the plain "something went wrong" for a code error, else the
 * error's own message (or `fallback`).
 */
export function userErrorMessage(err: unknown, fallback = 'Failed'): string {
  const fromServer = serverText(err)
  if (fromServer) return fromServer
  if (isCodeError(err)) return SOMETHING_WENT_WRONG
  if (err instanceof Error) {
    // "Request failed with status code 409" / a bare "Conflict" says nothing:
    // what the status means, in plain words.
    if (isBareStatusText(err.message)) return statusTitle(statusOf(err)) ?? fallback
    return err.message || fallback
  }
  if (typeof err === 'string' && err.trim()) return err
  return fallback
}

/** What a status means, when the answer carried no explanation of its own. */
export const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'That request could not be completed',
  401: 'You are signed out',
  403: 'You do not have access to do this',
  404: 'That could not be found',
  408: 'The server took too long to answer',
  409: 'This changed while you were working on it',
  413: 'That is too large to send',
  422: 'Some values need fixing',
  423: 'Someone else is working on this',
  429: 'Too many requests in a short time',
  500: 'Something went wrong on the server',
  502: 'The server is not answering right now',
  503: 'The server is not answering right now',
  504: 'The server took too long to answer'
}

export function statusTitle(status: number | null | undefined): string | null {
  if (status == null) return null
  return (
    STATUS_TITLES[status] ??
    (status >= 500 ? STATUS_TITLES[500] : status >= 400 ? STATUS_TITLES[400] : null)
  )
}

/** An HTTP client's own status sentence (axios, fetch, the SDK's statusText). */
export function isBareStatusText(text: unknown): boolean {
  if (typeof text !== 'string') return false
  const t = text.trim()
  return (
    /^request failed with status( code)? \d{3}$/i.test(t) ||
    BARE_STATUS.test(t) ||
    /^(payload too large|request entity too large|locked|request timeout)$/i.test(t)
  )
}

export { statusOf as errorStatusOf }

const reported = new WeakSet<object>()

/**
 * Send a code error to the issue log once (POST /issues/client, with the
 * replay when a recorder is running). Anything else is the server's answer and
 * already logged there. Never throws.
 */
export function reportCodeError(
  client: Parameters<typeof reportClientCrash>[0] | null | undefined,
  err: unknown
): void {
  if (!client || !isCodeError(err)) return
  if (reported.has(err as object)) return
  reported.add(err as object)
  void reportClientCrash(client, err, null).catch(() => {})
}
