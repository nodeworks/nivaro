import { fieldsFromBody, hintFor } from './error-hints'
import {
  errorStatusOf,
  isBareStatusText,
  isCodeError,
  SOMETHING_WENT_WRONG,
  statusTitle,
  userErrorMessage
} from './safe-error'

/**
 * One reading of a failed request for every screen: what happened, what to do,
 * which fields it is about, and the request id "Copy details" carries.
 *
 * Works on the SDK's errors (`{status, response: body}`, and NivaroError's
 * `code` / `requestId`), axios errors (`response.data`, the request id header),
 * a GraphQL error (`extensions.code`), a plain body, or anything thrown.
 *
 *   title   the server's own sentence; a plain status sentence when it gave
 *           none ("This changed while you were working on it", never
 *           "Request failed with status code 409")
 *   hint    the answer's `hint` (or `explanation`) exactly as sent, else the
 *           shared table by code, then by status (lib/error-hints.ts, twin of
 *           the API's)
 *   fields  field keys the refusal names, for the form to mark
 */
export interface ErrorDescription {
  title: string
  hint?: string
  fields?: string[]
  requestId?: string
  code?: string
  status?: number
}

const REQUEST_ID_HEADER = 'x-nivaro-request-id'
const REFUSAL_CODE = /^[A-Z][A-Z0-9_]{2,}$/
/** Transport codes (axios ERR_*, node E*) are not refusals. */
const TRANSPORT_CODE = /^(ERR_|E[A-Z]+$)/
const NETWORK = /failed to fetch|load failed|networkerror|network request failed|network error/i

type Bag = Record<string, unknown>

const isBag = (v: unknown): v is Bag => !!v && typeof v === 'object' && !Array.isArray(v)

/** The answer's JSON body: axios `response.data`, the SDK's `response`, or the error itself. */
function bodyOf(err: unknown): Bag | null {
  if (!isBag(err)) return null
  const response = err.response
  if (isBag(response)) {
    if (isBag(response.data)) return response.data
    if ('data' in response && typeof response.data === 'string') return null
    return response
  }
  // A GraphQL error (the SDK copies `extensions` onto it), or a body handed in as it is.
  if (isBag(err.extensions)) return err
  if (!(err instanceof Error) && ('error' in err || 'message' in err || 'code' in err)) return err
  return null
}

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function codeOf(err: unknown, body: Bag | null): string | undefined {
  const ext = isBag(body?.extensions) ? body.extensions : null
  for (const c of [body?.code, ext?.code, isBag(err) ? err.code : undefined]) {
    if (typeof c === 'string' && REFUSAL_CODE.test(c) && !TRANSPORT_CODE.test(c)) return c
  }
  return undefined
}

function requestIdOf(err: unknown, body: Bag | null): string | undefined {
  const fromBody = stringOf(body?.request_id) ?? stringOf(body?.requestId)
  if (fromBody) return fromBody
  if (!isBag(err)) return undefined
  const own = stringOf(err.requestId) ?? stringOf(err.request_id)
  if (own) return own
  const headers = isBag(err.response) ? err.response.headers : undefined
  if (isBag(headers)) return stringOf(headers[REQUEST_ID_HEADER])
  const get = (headers as { get?: (k: string) => unknown } | undefined)?.get
  if (typeof get === 'function') return stringOf(get.call(headers, REQUEST_ID_HEADER))
  return undefined
}

function statusFrom(err: unknown, body: Bag | null): number | undefined {
  const s = errorStatusOf(err) ?? body?.statusCode ?? body?.status
  const ext = isBag(body?.extensions) ? body.extensions.status : undefined
  const n = typeof s === 'number' ? s : typeof ext === 'number' ? ext : undefined
  return n && n >= 100 && n < 600 ? n : undefined
}

/** The body's own sentence: `error` when it explains, else `message`. */
function sentenceOf(body: Bag): string | undefined {
  for (const k of ['error', 'message'] as const) {
    const t = stringOf(body[k])
    if (t && !isBareStatusText(t)) return t
  }
  return undefined
}

function isTimeout(err: unknown): boolean {
  if (!isBag(err)) return false
  return (
    err.name === 'TimeoutError' ||
    err.code === 'ECONNABORTED' ||
    err.code === 'ETIMEDOUT' ||
    /timed out|timeout of \d+ms exceeded/i.test(String(err.message ?? ''))
  )
}

/** The plain reading of a failed request. `fallback` is the title when nothing says more. */
export function describeError(err: unknown, fallback = 'Something went wrong'): ErrorDescription {
  const body = bodyOf(err)
  const status = statusFrom(err, body)
  const code = codeOf(err, body)
  const requestId = requestIdOf(err, body)
  const out: ErrorDescription = { title: fallback }
  if (status) out.status = status
  if (code) out.code = code
  if (requestId) out.requestId = requestId

  if (isCodeError(err)) {
    out.title = SOMETHING_WENT_WRONG
    return out
  }

  // No answer at all: the network, or a request that was given up on.
  const message = isBag(err) ? String(err.message ?? '') : typeof err === 'string' ? err : ''
  if (!status && !body && NETWORK.test(message)) {
    out.title = 'Cannot reach the server'
    out.hint = 'Check your connection, then try again.'
    return out
  }
  if (!status && isTimeout(err)) {
    out.title = 'The server took too long to answer'
    out.hint = 'Try again in a minute. Narrow the request if it keeps happening.'
    return out
  }

  // The server's own sentence wins; a bare status line becomes a plain one.
  const said = (body ? sentenceOf(body) : undefined) ?? userErrorMessage(err, '')
  out.title = said && !isBareStatusText(said) ? said : (statusTitle(status) ?? (said || fallback))
  if (!out.title) out.title = fallback

  // The hint as sent — a partner explanation from the integrations layer
  // included — else the shared table.
  const sentHint = stringOf(body?.hint) ?? stringOf(body?.explanation)
  const tableHint = status || code ? hintFor(code, status ?? 400) : undefined
  const hint = sentHint ?? tableHint
  if (hint && hint !== out.title) out.hint = hint

  const fields = body ? fieldsFromBody(body) : []
  if (fields.length) out.fields = fields
  return out
}

/** The text "Copy details" puts on the clipboard: enough for an administrator to find it. */
export function errorDetailsText(
  input: ErrorDescription | unknown,
  extra: { action?: string; now?: Date; page?: string } = {}
): string {
  const d = isDescription(input) ? input : describeError(input)
  const page =
    extra.page ??
    (typeof window !== 'undefined' && window.location ? window.location.pathname : undefined)
  const lines = [
    extra.action ? `Action: ${extra.action}` : null,
    `What happened: ${d.title}`,
    d.hint ? `What to do: ${d.hint}` : null,
    d.code || d.status
      ? `Code: ${[d.code, d.status ? `HTTP ${d.status}` : null].filter(Boolean).join(' · ')}`
      : null,
    d.fields?.length ? `Fields: ${d.fields.join(', ')}` : null,
    d.requestId ? `Request id: ${d.requestId}` : null,
    page ? `Page: ${page}` : null,
    `When: ${(extra.now ?? new Date()).toISOString()}`
  ]
  return lines.filter((l): l is string => !!l).join('\n')
}

function isDescription(v: unknown): v is ErrorDescription {
  return isBag(v) && typeof v.title === 'string' && !('response' in v) && !('stack' in v)
}

/** Copy the details; resolves false when the clipboard refused. Never throws. */
export async function copyErrorDetails(
  input: ErrorDescription | unknown,
  extra?: { action?: string }
): Promise<boolean> {
  try {
    const text = errorDetailsText(input, extra)
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * A stored import row error as a plain sentence. New runs store one already
 * (api services/db-refusal-labels.ts importRowErrorText); rows from older runs
 * may still carry the statement the database refused ("insert into [x] … -
 * The INSERT statement conflicted …") — the reason is kept, the statement and
 * the database's object names are not.
 */
export function rowErrorSentence(text: unknown): string {
  const raw = typeof text === 'string' ? text.trim() : String(text ?? '').trim()
  if (!raw) return 'This row was not imported'
  let reason = raw
  const cut = raw.lastIndexOf(' - ')
  if (cut > 0 && /^(insert|update|delete|merge|select|exec)\s/i.test(raw))
    reason = raw.slice(cut + 3)
  if (/conflicted with the (FOREIGN KEY|REFERENCE)/i.test(reason))
    return 'A linked value in this row does not exist — check the spelling or add that record first'
  if (/Violation of (UNIQUE KEY|PRIMARY KEY)|Cannot insert duplicate key/i.test(reason))
    return 'Another record already has a value from this row — change it in the file, or import with Overwrite'
  const nul = /Cannot insert the value NULL into column '([^']+)'/i.exec(reason)
  if (nul)
    return `${nul[1].replace(/_/g, ' ')} is empty — fill it in the file or map a column to it`
  return reason
    .replace(/,? table '[^']*'/gi, '')
    .replace(/\s*(INSERT|UPDATE) fails\./gi, '')
    .trim()
}

/** Title and hint as one sentence pair, for places with room for a single line. */
export function errorSentence(err: unknown, fallback?: string): string {
  const d = describeError(err, fallback)
  return d.hint ? `${d.title.replace(/[.!?]\s*$/, '')}. ${d.hint}` : d.title
}
