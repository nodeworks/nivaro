import { reportClientCrash } from './client-crash'

/**
 * No raw JavaScript error text on screen, ever. "Cannot read properties of
 * null (reading 'id')" told a person nothing and invited them to press Save
 * again (2026-10-23: a duplicate workflow). A code error (TypeError,
 * ReferenceError, RangeError, SyntaxError that is not a network failure and
 * carries no HTTP status) shows one plain sentence instead, and the real error
 * goes to the issue log through the client crash report.
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
  return (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof RangeError ||
    err instanceof SyntaxError
  )
}

/** The server's own `{error}` text, through the SDK (`response.error`) or axios (`response.data.error`). */
function serverText(err: unknown): string | null {
  const e = err as {
    response?: { data?: { error?: unknown; message?: unknown }; error?: unknown }
  } | null
  const raw = e?.response?.data?.error ?? e?.response?.error ?? e?.response?.data?.message
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
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
  if (err instanceof Error) return err.message || fallback
  if (typeof err === 'string' && err.trim()) return err
  return fallback
}

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
