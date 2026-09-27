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
 * A request's query string for the log: values under credential-looking names
 * become `••••••`, the rest is kept as sent. Cut at QUERY_CAP with a trailing
 * `…`. Returns null for no query.
 */
export function maskQueryString(raw: string | null | undefined): string | null {
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
      return isSensitiveKey(plain) && part.length > eq + 1 ? `${name}=${MASK}` : part
    })
    .join('&')
  return out.length > QUERY_CAP ? `${out.slice(0, QUERY_CAP - 1)}…` : out
}

/** Whether a stored query string can be sent again as it is. */
export function queryIsReplayable(stored: string | null | undefined): boolean {
  if (!stored) return true
  return !stored.endsWith('…') && !stored.includes(MASK)
}
