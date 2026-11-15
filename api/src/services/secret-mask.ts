/**
 * One rule for "this name looks like it carries a credential", shared by the
 * call-log header masking and the call-log BODY masking below. Broad on
 * purpose: masked-and-wrong costs nothing on a log screen, shown-and-a-real-
 * leak costs everything. A leaf module — no db, no imports — so any reader
 * can mask on the way out.
 */

export const SENSITIVE_KEY_PATTERN =
  /secret|token|password|passwd|key|cookie|auth|session|signature|credential/

export const MASK = '••••••'

/** Header names that always carry a credential — the explicit baseline the pattern widens. */
export const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'cookie',
  'set-cookie',
  'proxy-authorization'
])

/** True when a header name carries (or looks like it carries) a credential — the one rule the
 *  call-log masking (maskHeaders) and config-snapshot redaction both use. */
export function isSensitiveHeaderName(name: string): boolean {
  const lk = name.toLowerCase()
  return SENSITIVE_HEADER_NAMES.has(lk) || SENSITIVE_KEY_PATTERN.test(lk)
}

/** True when a header or JSON key name looks like it holds a credential. */
export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(name.toLowerCase())
}

function maskValue(v: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(v)) {
    let changed = false
    const out = v.map((x) => {
      const m = maskValue(x)
      if (m.changed) changed = true
      return m.value
    })
    return { value: changed ? out : v, changed }
  }
  if (v && typeof v === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (isSensitiveKey(k) && x != null && x !== '') {
        out[k] = MASK
        changed = true
        continue
      }
      const m = maskValue(x)
      if (m.changed) changed = true
      out[k] = m.value
    }
    return { value: changed ? out : v, changed }
  }
  return { value: v, changed: false }
}

/** `"<sensitive key>": "<string>"` inside JSON that no longer parses. */
const PAIR = /"((?:[^"\\]|\\.)*)"(\s*:\s*)"(?:[^"\\]|\\.)*"/g

/**
 * A stored request or response body with every value under a sensitive-looking
 * key (any depth, arrays included) replaced by `••••••`. A body with nothing
 * to mask comes back byte-for-byte; a non-JSON body (XML, plain text) is left
 * alone; JSON that no longer parses (cut off by the log's size cap) gets a
 * best-effort pass over its `"key": "value"` string pairs.
 *
 * For the call LOG only — a submission's stored payload stays whole, because
 * Retry re-sends exactly that payload.
 */
export function maskBodySecrets(body: string | null | undefined): string | null {
  if (body == null) return null
  const trimmed = body.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return body
  try {
    const m = maskValue(JSON.parse(body))
    return m.changed ? JSON.stringify(m.value) : body
  } catch {
    return body.replace(PAIR, (whole, key: string, sep: string) =>
      isSensitiveKey(key) ? `"${key}"${sep}"${MASK}"` : whole
    )
  }
}

function canonical(v: unknown): string | null {
  if (v == null) return null
  try {
    return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v)
  } catch {
    return String(v)
  }
}

/**
 * True when a call-log body is the log's copy of `sent` (a submission's
 * stored payload body, kept whole). The log masks its bodies, so the two are
 * compared in their MASKED, canonical form — a payload carrying a token still
 * matches its own call.
 */
export function sameLoggedBody(logged: string | null | undefined, sent: unknown): boolean {
  if (logged == null || sent == null) return false
  const sentText = typeof sent === 'string' ? sent : JSON.stringify(sent)
  const a = canonical(maskBodySecrets(logged))
  return a != null && a === canonical(maskBodySecrets(sentText))
}

/** Longest query string the request log keeps. */
export const QUERY_CAP = 500

/**
 * Query parameter names that carry a credential although their name does not say so: the
 * Command Center wallboard link token rides `?kiosk=` (CC-23), a help-video media ticket
 * `?st=` (stream / captions / poster), and the signed stream tickets of the SSE routes
 * (`?ticket=` on /api/events, /api/view-stream, /api/graphql/stream).
 */
export const SENSITIVE_QUERY_NAMES = new Set(['kiosk', 'st', 'ticket'])

/**
 * Names too short or too common to mask everywhere that carry a credential on ONE route: the
 * Teams bot's account-link page takes its signed link token as `?t=` (/api/teams/connect).
 * Matched against the request path (query string dropped, /api prefix optional).
 */
const PATH_SENSITIVE_QUERY_NAMES: Array<{ path: RegExp; names: Set<string> }> = [
  { path: /^(?:\/api)?\/teams\/connect\/?$/i, names: new Set(['t']) }
]

const isSensitiveQueryName = (name: string, path?: string | null) => {
  const lk = name.toLowerCase()
  if (isSensitiveKey(name) || SENSITIVE_QUERY_NAMES.has(lk)) return true
  if (!path) return false
  return PATH_SENSITIVE_QUERY_NAMES.some((r) => r.names.has(lk) && r.path.test(path))
}

/**
 * A request's query string for the log: values under credential-looking names
 * become `••••••`, the rest is kept as sent. Cut at QUERY_CAP with a trailing
 * `…`. Returns null for no query. `path` (the request path the query rode on) also masks
 * the per-route credential names (PATH_SENSITIVE_QUERY_NAMES).
 */
export function maskQueryString(
  raw: string | null | undefined,
  path?: string | null
): string | null {
  if (!raw) return null
  const q = raw.startsWith('?') ? raw.slice(1) : raw
  if (!q) return null
  const out = q
    .split('&')
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq < 0) return part
      const name = part.slice(0, eq)
      let plain = name
      try {
        plain = decodeURIComponent(name.replace(/\+/g, ' '))
      } catch {
        /* keep the raw name */
      }
      return isSensitiveQueryName(plain, path) && part.length > eq + 1 ? `${name}=${MASK}` : part
    })
    .join('&')
  return out.length > QUERY_CAP ? `${out.slice(0, QUERY_CAP - 1)}…` : out
}

/**
 * A credential that rides the URL PATH: the old Command Center wallboard page address
 * `/command/kiosk/<token>` (current links keep the token in the #fragment, which no server
 * ever receives). The segment after /command/kiosk/ is masked wherever a path is logged.
 */
const KIOSK_PATH_RE = /(\/command\/kiosk\/)[^/?#]+/gi
/** A public form submitter's status-page link (realtime round 9, #22): `/form-status/<token>`. */
const FORM_STATUS_PATH_RE = /(\/form-status\/)[^/?#]+/gi

/** A record share link (`/share/<token>`, its `/share/<token>/stream`) — the token IS the
 *  access, so it never reaches a log. */
const SHARE_PATH_RE = /(\/share\/)[^/?#]+/gi
/** A shared session-replay link (`/api/session-replay-shares/view/<token>`). */
const REPLAY_SHARE_PATH_RE = /(\/session-replay-shares\/view\/)[^/?#]+/gi
/** Published-by-token reads: a public dashboard link (`/api/dashboard-links/public/<token>`),
 *  a public custom query (`/api/custom-queries/public/<token>`) and a submission form's
 *  public read/submit (`/api/submission-forms/public/<token>`). */
const PUBLIC_TOKEN_PATH_RE =
  /(\/(?:dashboard-links|custom-queries|submission-forms)\/public\/)[^/?#]+/gi
/** An embeddable widget feed (`/api/widget/public/feed/<token>`, its `/stream`). */
const WIDGET_FEED_PATH_RE = /(\/widget\/public\/feed\/)[^/?#]+/gi
/** The hosted public form page (`/form/<token>`, root level, outside /api). */
const PUBLIC_FORM_PATH_RE = /^(\/form\/)[^/?#]+/i
/** A layout preview link (`/api/form-preview/<token>`, its `/comments`). */
const FORM_PREVIEW_PATH_RE = /(\/form-preview\/)[^/?#]+/gi
/** A help-video package download link (`/api/help-videos/packages/<token>`, single use). */
const HELP_VIDEO_PACKAGE_PATH_RE = /(\/help-videos\/packages\/)[^/?#]+/gi

/** Every path whose segment IS the access (a link token): the segment becomes `••••••`. */
const TOKEN_PATH_RES = [
  KIOSK_PATH_RE,
  FORM_STATUS_PATH_RE,
  SHARE_PATH_RE,
  REPLAY_SHARE_PATH_RE,
  PUBLIC_TOKEN_PATH_RE,
  WIDGET_FEED_PATH_RE,
  PUBLIC_FORM_PATH_RE,
  FORM_PREVIEW_PATH_RE,
  HELP_VIDEO_PACKAGE_PATH_RE
]

export function maskUrlPath(path: string): string {
  let out = path
  for (const re of TOKEN_PATH_RES) out = out.replace(re, `$1${MASK}`)
  return out
}

/** A URL (path + query) with its path credential and query string masked — for logs and traces. */
export function maskUrlQuery(url: string): string {
  const mark = url.indexOf('?')
  if (mark < 0) return maskUrlPath(url)
  const rawPath = url.slice(0, mark)
  const q = maskQueryString(url.slice(mark + 1), rawPath)
  const path = maskUrlPath(rawPath)
  return q ? `${path}?${q}` : path
}

/** Whether a stored query string can be sent again as it is. */
export function queryIsReplayable(stored: string | null | undefined): boolean {
  if (!stored) return true
  return !stored.endsWith('…') && !stored.includes(MASK)
}
