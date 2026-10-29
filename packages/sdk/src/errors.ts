// ─── Errors ───────────────────────────────────────────────────────────────────
//
// Every non-2xx answer the client reads becomes a NivaroError. It keeps the
// properties earlier SDK versions put on a plain Error (`status`, `response`,
// `issues` on import parse refusals), so existing `catch` blocks keep working,
// and adds what a caller needs to act on or report the failure: the API's
// machine code, the request id the server stamped, and the Retry-After wait.

/** Response header the API stamps on every traced /api answer (plugins/request-trace.ts). */
export const REQUEST_ID_HEADER = 'x-nivaro-request-id'

/** A non-2xx answer from the Nivaro API. */
export class NivaroError extends Error {
  /** HTTP status of the answer. */
  readonly status: number
  /** The API's machine code (`body.code`, e.g. `QUOTA_EXCEEDED`, `SERVER_BUSY`), else null. */
  readonly code: string | null
  /**
   * The `x-nivaro-request-id` the server stamped — the id its slow-trace buffer, access
   * log and API request log carry. Null when the header was absent or unreadable (a
   * cross-origin browser call only sees it if the API exposes the header through CORS).
   */
  readonly requestId: string | null
  /** The parsed JSON body (or `{ error: statusText }` when the body was not JSON). */
  readonly response: unknown
  readonly method: string
  /** Path under `/api` (no query string). */
  readonly path: string
  /** Milliseconds from a `Retry-After` header (429 / 503), else null. */
  readonly retryAfterMs: number | null
  /** Import parse refusals: the per-row problems the API listed. */
  readonly issues?: unknown

  constructor(init: {
    message: string
    status: number
    code?: string | null
    requestId?: string | null
    response?: unknown
    method: string
    path: string
    retryAfterMs?: number | null
    issues?: unknown
  }) {
    super(init.message)
    this.name = 'NivaroError'
    this.status = init.status
    this.code = init.code ?? null
    this.requestId = init.requestId ?? null
    this.response = init.response
    this.method = init.method
    this.path = init.path
    this.retryAfterMs = init.retryAfterMs ?? null
    if (init.issues !== undefined) this.issues = init.issues
  }
}

/** True for a NivaroError (also across bundled copies of the SDK). */
export function isNivaroError(err: unknown): err is NivaroError {
  return (
    err instanceof NivaroError ||
    (!!err &&
      typeof err === 'object' &&
      (err as { name?: unknown }).name === 'NivaroError' &&
      typeof (err as { status?: unknown }).status === 'number')
  )
}

/**
 * The human message of an error body. Route handlers answer `{ error: 'Not found' }`;
 * Fastify's own errors (validation, the SERVER_BUSY 503) answer
 * `{ statusCode, error: 'Bad Request', message: '…' }`, where `error` is only the status
 * phrase and `message` is the reason.
 */
export function errorBodyMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { error?: unknown; message?: unknown; statusCode?: unknown }
  const fastifyShaped = typeof b.statusCode === 'number' && typeof b.message === 'string'
  if (fastifyShaped && b.message) return b.message as string
  if (typeof b.error === 'string' && b.error) return b.error
  if (typeof b.message === 'string' && b.message) return b.message
  return null
}

/** `Retry-After` as milliseconds (seconds or an HTTP date), else null. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null
  const secs = Number(value)
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}
