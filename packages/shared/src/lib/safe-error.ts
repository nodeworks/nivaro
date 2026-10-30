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
 * error's own message (or `fallback`). Never raw text: a status line, a
 * stack, SQL, a driver error or a JavaScript error reads as what it means.
 */
export function userErrorMessage(err: unknown, fallback = 'Failed'): string {
  const status = statusOf(err)
  const fromServer = serverText(err)
  if (fromServer && !isRawErrorText(fromServer) && !isCrashBody(err, status)) return fromServer
  if (isCodeError(err)) return SOMETHING_WENT_WRONG
  const own = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (!status && NETWORKISH.test(own)) return 'Cannot reach the server'
  if (own.trim() && !isRawErrorText(own)) return own.trim()
  // "Request failed with status code 409" / a bare "Conflict" / SQL text says
  // nothing a person can use: what the status means, in plain words.
  if (own.trim()) return plainErrorText(own, fallback || SOMETHING_WENT_WRONG, status)
  if (fromServer) return statusTitle(status) ?? (fallback || SOMETHING_WENT_WRONG)
  return fallback
}

/**
 * A 500 from the global error handler (`{statusCode: 500, error, message}`)
 * with no refusal code is a crash: its message is the server's own error
 * text, written for the log, not for a person.
 */
function isCrashBody(err: unknown, status: number | null): boolean {
  if (status !== 500) return false
  const e = err as { response?: Record<string, unknown> & { data?: unknown } } | null
  const r = e?.response
  const body = (r && typeof r.data === 'object' && r.data ? r.data : r) as
    | Record<string, unknown>
    | undefined
  return !!body && typeof body.statusCode === 'number' && typeof body.code !== 'string'
}

/** What a status means, when the answer carried no explanation of its own. */
export const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'That request could not be completed',
  401: 'You’ve been signed out',
  403: 'You do not have access to do this',
  404: 'This could not be found',
  408: 'The server took too long to answer',
  409: 'Someone else changed this',
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
    // apiFetch-style "Request failed (500)", the SDK's "HTTP 500", "Error 404", "500 Internal Server Error"
    /^(\w+ )?failed \(\d{3}\)$/i.test(t) ||
    /^(http|error|status)( code)?:? ?\d{3}$/i.test(t) ||
    /^\d{3}( [a-z][a-z ]+)?$/i.test(t) ||
    BARE_STATUS.test(t) ||
    /^(payload too large|request entity too large|locked|request timeout|method not allowed|not acceptable|precondition failed|unsupported media type)$/i.test(
      t
    )
  )
}

/** The status a raw status line names ("Request failed with status code 403" → 403). */
export function statusInText(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const m = /\b([45]\d{2})\b/.exec(text)
  return m ? Number(m[1]) : null
}

const RAW_MARKERS: RegExp[] = [
  // Status lines inside a sentence ("Not saved — Request failed (500)")
  /request failed( with status( code)?)? ?\(?\d{3}\)?/i,
  /\bHTTP\/?\d?(\.\d)? ?[45]\d{2}\b/,
  /\bstatus( code)? [45]\d{2}\b/i,
  /\((HTTP )?[45]\d{2}\)\.?$/,
  // JavaScript / runtime errors
  /^(TypeError|ReferenceError|RangeError|SyntaxError|EvalError|URIError|AxiosError|FetchError|AbortError)\b/,
  /cannot read propert(y|ies) of/i,
  /cannot set propert(y|ies) of/i,
  /\bis not a function\b/i,
  /\bis not defined\b/i,
  /\bis not iterable\b/i,
  /\bundefined is not\b/i,
  /unexpected (token|end of (json|input))/i,
  /\bJSON\.parse\b|is not valid JSON/i,
  /Minified React error/i,
  /Maximum call stack/i,
  /\[object \w+\]/,
  /^(undefined|null|NaN|true|false|\{\}|\[\])$/,
  // Stack frames and source paths
  /\n\s*at\s+\S/,
  /\bat\s+[\w$.<>]+\s+\(.*:\d+:\d+\)/,
  /\.(m?[jt]sx?|cjs):\d+(:\d+)?\b/,
  /node_modules\//,
  // SQL and the database's own words
  /\b(select\s[\s\S]+\sfrom|insert\s+into|update\s+\[?[\w.]+\]?\s+set|delete\s+from|merge\s+(into\s+)?\[?[\w.]+\]?\s+(as\s+)?\w*\s*using|exec(ute)?\s+\[?dbo)\b/i,
  /invalid (column|object) name/i,
  /conflicted with the (FOREIGN KEY|REFERENCE|CHECK) constraint/i,
  /violation of (UNIQUE|PRIMARY) KEY/i,
  /cannot insert (the value NULL|duplicate key|explicit value)/i,
  /conversion failed when converting/i,
  /arithmetic overflow/i,
  /string or binary data would be truncated/i,
  /\bdeadlock(ed)? victim/i,
  /incorrect syntax near/i,
  /\bmust declare the scalar variable/i,
  /\b(dbo|sys)\.\w+/i,
  /\b(nivaro|directus)_\w+/i,
  /\bknex\b/i,
  // Drivers, sockets and the network stack
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|ERR_[A-Z_]+)\b/,
  /socket hang up/i,
  /\b(ConnectionError|RequestError|TediousError|SequelizeError|PrismaClient\w*)\b/,
  /timeout: request failed to complete in \d+ms/i,
  /failed to connect to [\w.-]+:\d+/i,
  /\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/,
  /^(failed to fetch|load failed|network ?error|network request failed)$/i,
  // Internal ids
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
]

/**
 * Text a person should never see: a bare status line, a JavaScript or driver
 * error, a stack, SQL or the database's own names, or an internal id. The
 * reader shows what it means instead (`plainErrorText`) and keeps the text
 * itself for the "Details for support" copy.
 */
export function isRawErrorText(text: unknown): boolean {
  if (typeof text !== 'string') return text != null
  const t = text.trim()
  if (!t) return false
  if (isBareStatusText(t)) return true
  return RAW_MARKERS.some((re) => re.test(t))
}

const SEPARATORS = /\s+[—–-]\s+|:\s+|\.\s+/

/**
 * A message as a person may read it: unchanged when it is plain; the plain
 * part kept when only its tail is raw ("Not saved — Request failed (500)" →
 * "Not saved"); else what its status means ("Request failed with status code
 * 403" → "You do not have access to do this"), else `fallback`.
 */
export function plainErrorText(
  text: unknown,
  fallback = SOMETHING_WENT_WRONG,
  status?: number | null
): string {
  if (typeof text !== 'string' || !text.trim()) return fallback
  const t = text.trim()
  if (!isRawErrorText(t)) return t
  if (!status && NETWORKISH.test(t) && !/\d{3}/.test(t)) return 'Cannot reach the server'
  // "Document autofill failed (500)": the sentence, then what the status means.
  const tail = /^(.*\S)\s*\((?:HTTP )?([45]\d{2})\)\.?$/.exec(t)
  if (tail) {
    const head = tail[1].replace(/\s*[—–:-]?\s*request failed$/i, '').trim()
    const why = statusTitle(status ?? Number(tail[2]))
    if (!head) return why ?? fallback
    if (!isRawErrorText(head)) return why ? `${head.replace(/[.!?]\s*$/, '')}. ${why}` : head
  }
  // Keep the leading plain clauses ("Density not saved — <raw>").
  const parts = t.split(SEPARATORS)
  const kept: string[] = []
  for (const p of parts) {
    if (!p.trim() || isRawErrorText(p)) break
    kept.push(p.trim())
  }
  if (kept.length && kept.join(' ').length >= 4 && parts.length > kept.length) {
    const named = status ?? statusInText(t.slice(kept.join(' ').length))
    const why = named ? statusTitle(named) : null
    const head = kept.join('. ').replace(/[.!?]\s*$/, '')
    return why && why.toLowerCase() !== head.toLowerCase() ? `${head}. ${why}` : head
  }
  return statusTitle(status ?? statusInText(t)) ?? fallback
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
