import { fieldsFromBody, hintFor } from './error-hints'
import {
  errorStatusOf,
  isBareStatusText,
  isCodeError,
  isRawErrorText,
  plainErrorText,
  SOMETHING_WENT_WRONG,
  STATUS_TITLES,
  statusTitle
} from './safe-error'

/**
 * One reading of a failed request for every screen: what happened, what to do,
 * the one action that helps, which fields it is about, and the reference
 * "Details for support" carries.
 *
 * Works on the SDK's errors (`{status, response: body}`, and NivaroError's
 * `code` / `requestId`), axios errors (`response.data`, the request id header),
 * a portal's own ApiError (`status`, `response`), a GraphQL error
 * (`extensions.code`), a plain body, or anything thrown.
 *
 *   title   what happened, in plain words: the server's own sentence when it
 *           wrote one for people; else a plain status sentence ("Someone else
 *           changed this", never "Request failed with status code 409")
 *   hint    what to do: the answer's `hint` (or `explanation`) exactly as
 *           sent, else the shared table by code, then by status
 *           (lib/error-hints.ts, twin of the API's); 422s list the fields
 *   action  the one button that helps: retry, sign in, reload, ask for help,
 *           go back (lib/error-actions.ts runs it)
 *   fields  field keys the refusal names, for the form to mark
 *
 * Never in the title or hint: a status code, a stack, SQL, a driver or
 * JavaScript error, an internal id. Those stay in `technical`, `code`,
 * `status` and `requestId`, which only the collapsed "Details for support"
 * shows and copies.
 */
export type ErrorActionKind = 'retry' | 'sign-in' | 'reload' | 'contact' | 'go-back'

export interface ErrorAction {
  label: string
  kind: ErrorActionKind
}

export type ErrorKind =
  | 'offline'
  | 'network'
  | 'timeout'
  | 'signed-out'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'locked'
  | 'too-large'
  | 'validation'
  | 'rate-limited'
  | 'maintenance'
  | 'unavailable'
  | 'server'
  | 'bug'
  | 'refused'
  | 'unknown'

export interface ErrorDescription {
  title: string
  hint?: string
  action?: ErrorAction
  kind?: ErrorKind
  fields?: string[]
  requestId?: string
  code?: string
  status?: number
  /** The raw text the error carried, for the support copy only — never shown as the title. */
  technical?: string
}

export interface DescribeErrorOptions {
  /** Field labels for a refusal that names fields: key → "Supplier site". */
  fieldLabels?: Record<string, string> | ((key: string) => string | null | undefined)
}

const REQUEST_ID_HEADER = 'x-nivaro-request-id'
const REFUSAL_CODE = /^[A-Z][A-Z0-9_]{2,}$/
/** Transport codes (axios ERR_*, node E*) are not refusals. */
const TRANSPORT_CODE = /^(ERR_|E[A-Z]+$)/
const NETWORK =
  /failed to fetch|load failed|networkerror|network request failed|network error|cannot reach/i

/** What to do when nothing more specific is known. */
export const ASK_FOR_HELP_HINT = 'Try again. If it keeps happening, ask for help.'

const ACTIONS = {
  retry: { kind: 'retry', label: 'Try again' },
  signIn: { kind: 'sign-in', label: 'Sign in again' },
  reload: { kind: 'reload', label: 'Reload' },
  reloadPage: { kind: 'reload', label: 'Reload the page' },
  askAccess: { kind: 'contact', label: 'Ask for access' },
  help: { kind: 'contact', label: 'Get help' },
  back: { kind: 'go-back', label: 'Go back' }
} as const satisfies Record<string, ErrorAction>

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
  if (isBag(headers)) {
    const get = (headers as { get?: (k: string) => unknown }).get
    if (typeof get === 'function') return stringOf(get.call(headers, REQUEST_ID_HEADER))
    return stringOf(headers[REQUEST_ID_HEADER])
  }
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
    /timed out|timeout of \d+ms exceeded|took too long/i.test(String(err.message ?? ''))
  )
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * A 500 from the global error handler (`{statusCode: 500, error, message}`)
 * with no refusal code is a crash: its message is written for the log.
 */
function isCrash(status: number | undefined, body: Bag | null, code: string | undefined): boolean {
  return status === 500 && !!body && typeof body.statusCode === 'number' && !code
}

/** "supplier_site" → "Supplier site"; "lines.0.qty" → "Qty". */
export function errorFieldName(key: string, labels?: DescribeErrorOptions['fieldLabels']): string {
  const own = typeof labels === 'function' ? labels(key) : labels?.[key]
  if (own) return own
  const last =
    key
      .split('.')
      .filter((p) => !/^\d+$/.test(p))
      .pop() ?? key
  const words = last
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_$]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : key
}

/** "Supplier site", "Supplier site and Zone", "A, B, C and 2 more". */
export function errorFieldList(
  keys: string[],
  labels?: DescribeErrorOptions['fieldLabels']
): string {
  const names = [...new Set(keys.map((k) => errorFieldName(k, labels)))]
  const shown = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} more`] : names
  return shown.length < 2
    ? (shown[0] ?? '')
    : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

function clip(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The plain reading of a failed request. `fallback` is the title when nothing says more. */
export function describeError(
  err: unknown,
  fallback = 'Something went wrong',
  opts: DescribeErrorOptions = {}
): ErrorDescription {
  const body = bodyOf(err)
  const own = isBag(err) && typeof err.message === 'string' ? err.message : undefined
  // A portal's ApiError says status 0 for a request that never got an answer.
  const status0 = isBag(err) && err.status === 0
  const status = statusFrom(err, body)
  const code = codeOf(err, body)
  const requestId = requestIdOf(err, body)
  const out: ErrorDescription = { title: fallback }
  if (status) out.status = status
  if (code) out.code = code
  if (requestId) out.requestId = requestId
  const finish = (d: ErrorDescription): ErrorDescription => {
    const raw = [
      body ? stringOf(body.message) : undefined,
      body ? stringOf(body.error) : undefined,
      own,
      typeof err === 'string' ? err : ''
    ]
      .filter((t): t is string => !!t?.trim() && !isBareStatusText(t))
      .find((t) => isRawErrorText(t) || (!!status && status >= 500 && t !== d.title))
    if (raw && raw !== d.title) d.technical = clip(raw.trim())
    // Belt and braces: nothing raw reaches the title or the hint.
    if (isRawErrorText(d.title)) d.title = plainErrorText(d.title, fallback, status)
    if (d.hint && (isRawErrorText(d.hint) || d.title.includes(d.hint))) delete d.hint
    return d
  }

  if (isCodeError(err)) {
    return finish({
      ...out,
      kind: 'bug',
      title: SOMETHING_WENT_WRONG,
      hint: 'Try again. If it keeps happening, reload the page.',
      action: ACTIONS.reloadPage
    })
  }

  // No answer at all: offline, the network, or a request that was given up on.
  const message = own ?? (typeof err === 'string' ? err : '')
  if (!status && !code) {
    if (isTimeout(err)) {
      return finish({
        ...out,
        kind: 'timeout',
        title: 'The server took too long to answer',
        hint: 'Try again in a minute. If it keeps happening, ask for less at once.',
        action: ACTIONS.retry
      })
    }
    if (isOffline() && (status0 || !body)) {
      return finish({
        ...out,
        kind: 'offline',
        title: 'You’re offline',
        hint: 'Check your internet connection, then try again. Nothing you entered is lost.',
        action: ACTIONS.retry
      })
    }
    if (status0 || (!body && NETWORK.test(message))) {
      return finish({
        ...out,
        kind: 'network',
        title: 'Cannot reach the server',
        hint: 'Check your connection, then try again.',
        action: ACTIONS.retry
      })
    }
  }

  // The server's own sentence, when it wrote one for people.
  const said0 = (body ? sentenceOf(body) : undefined) ?? (own && !body ? own : undefined)
  const said =
    said0 && !isRawErrorText(said0) && !isCrash(status, body, code) ? said0.trim() : undefined
  const sentHint = stringOf(body?.hint) ?? stringOf(body?.explanation)
  const tableHint = status || code ? hintFor(code, status ?? 400) : undefined
  const fields = body ? fieldsFromBody(body) : []
  if (fields.length) out.fields = fields
  const pick = (title: string, kind: ErrorKind, hint?: string, action?: ErrorAction) =>
    finish({
      ...out,
      kind,
      title,
      ...(hint ? { hint } : {}),
      ...(action ? { action } : {})
    })

  if (code === 'MAINTENANCE')
    return pick(
      said ?? 'The system is down for maintenance',
      'maintenance',
      sentHint ?? tableHint,
      ACTIONS.reload
    )

  if (status === 401)
    return pick(
      said ?? STATUS_TITLES[401],
      'signed-out',
      sentHint ?? tableHint ?? 'Sign in again, then try once more.',
      ACTIONS.signIn
    )

  if (status === 403)
    return pick(
      said ?? STATUS_TITLES[403],
      'forbidden',
      sentHint ?? tableHint,
      code && !/ask/i.test(sentHint ?? tableHint ?? '') ? undefined : ACTIONS.askAccess
    )

  if (status === 404 || status === 410)
    return pick(said ?? STATUS_TITLES[404], 'not-found', sentHint ?? tableHint, ACTIONS.back)

  if (status === 409 || status === 412) {
    const hint =
      sentHint ?? (code ? tableHint : 'Reload to see their changes, then make yours again.')
    return pick(
      said ?? STATUS_TITLES[409],
      'conflict',
      hint,
      !hint || /\breload\b/i.test(hint) ? ACTIONS.reload : undefined
    )
  }

  if (status === 423)
    return pick(said ?? STATUS_TITLES[423], 'locked', sentHint ?? tableHint, ACTIONS.reload)

  if (status === 413) return pick(said ?? STATUS_TITLES[413], 'too-large', sentHint ?? tableHint)

  if (status === 429)
    return pick(said ?? STATUS_TITLES[429], 'rate-limited', sentHint ?? tableHint, ACTIONS.retry)

  if (status === 400 || status === 422) {
    const listed = fields.length ? errorFieldList(fields, opts.fieldLabels) : ''
    const hint =
      sentHint ??
      (listed && (!code || /highlighted/i.test(tableHint ?? ''))
        ? `Check ${listed}, then try again.`
        : tableHint)
    const validation = fields.length > 0 || /^(VALIDATION|REQUIRED)/.test(code ?? '')
    return pick(
      said ?? (validation ? STATUS_TITLES[422] : STATUS_TITLES[400]),
      validation ? 'validation' : 'refused',
      hint
    )
  }

  if (status === 502 || status === 503 || status === 504)
    return pick(
      said ?? STATUS_TITLES[status],
      status === 504 ? 'timeout' : 'unavailable',
      sentHint ?? tableHint,
      ACTIONS.retry
    )

  if (status && status >= 500)
    return pick(
      said ?? STATUS_TITLES[500],
      'server',
      sentHint && !/copy the details/i.test(sentHint) ? sentHint : ASK_FOR_HELP_HINT,
      ACTIONS.retry
    )

  if (status && status >= 400)
    return pick(said ?? statusTitle(status) ?? fallback, 'refused', sentHint ?? tableHint)

  // No status: a GraphQL refusal by code, an app's own plain message, or nothing.
  if (said) return pick(said, code ? 'refused' : 'unknown', sentHint ?? tableHint)
  const plain = message.trim() ? plainErrorText(message, fallback) : fallback
  return pick(plain, 'unknown', sentHint ?? tableHint ?? ASK_FOR_HELP_HINT, ACTIONS.retry)
}

/**
 * A read that failed, said for its place: "Couldn’t load the dashboard" with
 * what to do, where the generic reading would only say "Something went wrong".
 * Signed out, no access, not found, offline and the like keep their own words.
 */
export function describeLoadError(
  err: unknown,
  what = 'this',
  opts: DescribeErrorOptions = {}
): ErrorDescription {
  const title = `Couldn’t load ${what}`
  const d = describeError(err, title, opts)
  const generic =
    d.kind === 'bug' || (d.kind === 'server' && d.title === STATUS_TITLES[500]) || d.title === title
  if (generic && (d.kind === 'server' || d.kind === 'bug' || d.kind === 'unknown')) {
    d.title = title
    d.hint = d.kind === 'bug' ? d.hint : ASK_FOR_HELP_HINT
    if (d.kind !== 'bug') d.action = ACTIONS.retry
  }
  return d
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
    d.technical ? `Technical: ${d.technical}` : null,
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
