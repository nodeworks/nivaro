import { isFatalStatus } from './partQueue'

/** A failed save, as the error view shows it. */
export type Failure = PlainFailure & {
  uploadId: string
  /** The server has the start of the recording but the end never reached it. */
  partial?: boolean
}

export type PlainFailure = {
  message: string
  /** Trying again could help (an outage, not a refusal). */
  retryable: boolean
  /** The server no longer holds this upload open: it can never be saved. */
  closed: boolean
}

/** Ends the text with a full stop unless it already ends a sentence. */
export function sentence(text: string): string {
  const t = text.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}

/** A refusal's plain sentence. Errors thrown by a service arrive in Fastify's
 *  shape (`error` is the HTTP reason, e.g. "Conflict"; the sentence is in
 *  `message`); a route's own reply carries the sentence in `error`. */
export function serverMessage(body: { error?: unknown; message?: unknown }): string | undefined {
  if (typeof body.message === 'string' && body.message.trim()) return body.message
  if (typeof body.error === 'string' && body.error.trim()) return body.error
  return undefined
}

/** The server's own plain message for a refusal (never a raw code), and
 *  whether trying again could help. No status means the request never got
 *  an answer: the network or the server is down. */
export function plainFailure(err: unknown): PlainFailure {
  const e = (err ?? {}) as {
    message?: unknown
    status?: unknown
    code?: unknown
    response?: { code?: unknown; error?: unknown; message?: unknown }
  }
  const status = typeof e.status === 'number' ? e.status : undefined
  if (status === undefined) {
    return { message: 'The server could not be reached.', retryable: true, closed: false }
  }
  const code =
    typeof e.code === 'string'
      ? e.code
      : typeof e.response?.code === 'string'
        ? e.response.code
        : undefined
  const text = (e.response && serverMessage(e.response)) ?? e.message
  const message =
    typeof text === 'string' && text.trim()
      ? sentence(text)
      : 'The server did not accept the recording.'
  return {
    message,
    retryable: !isFatalStatus(status, code),
    closed: status === 404 || code === 'UPLOAD_CLOSED' || code === 'UPLOAD_NOT_FOUND'
  }
}

/** Only a refusal stops a live recording; an outage keeps it going while the
 *  parts wait in the browser. */
export function stopsRecording(err: unknown): boolean {
  return !plainFailure(err).retryable
}
