import { isSensitiveKey, MASK, maskBodySecrets } from '../secret-mask.js'

/** Longest error summary a non-admin viewer sees. */
export const ERROR_SUMMARY_CHARS = 160

/**
 * A partner call's URL for the path. Credential-shaped query parameters
 * (an `api_key` placed `in: 'query'`) are masked for every viewer; a viewer
 * without body access gets scheme + host + path only.
 */
export function redactUrl(raw: unknown, withBodies: boolean): string {
  const text = raw == null ? '' : String(raw)
  if (!text) return ''
  let url: URL
  try {
    url = new URL(text)
  } catch {
    // Not absolute: split the query off by hand.
    const q = text.indexOf('?')
    if (q < 0) return text
    if (!withBodies) return text.slice(0, q)
    const params = new URLSearchParams(text.slice(q + 1))
    for (const k of [...params.keys()]) if (isSensitiveKey(k)) params.set(k, MASK)
    return `${text.slice(0, q)}?${params.toString()}`
  }
  if (!withBodies) return `${url.protocol}//${url.host}${url.pathname}`
  for (const k of [...url.searchParams.keys()]) {
    if (isSensitiveKey(k)) url.searchParams.set(k, MASK)
  }
  // Userinfo can carry a credential too.
  if (url.username || url.password) {
    url.username = ''
    url.password = ''
  }
  return url.toString()
}

/** "key": "value" pairs anywhere in free text (maskBodySecrets only masks a bare JSON body). */
const JSON_PAIR = /"((?:[^"\\]|\\.)*)"(\s*:\s*)"(?:[^"\\]|\\.)*"/g
/** key=value / key: value pairs in prose or a query string. */
const TEXT_PAIR = /\b([A-Za-z0-9_.-]+)(\s*[=:]\s*)([^\s&,;"'}]+)/g
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi

function maskInline(text: string): string {
  return text
    .replace(JSON_PAIR, (whole, key: string, sep: string) =>
      isSensitiveKey(key) ? `"${key}"${sep}"${MASK}"` : whole
    )
    .replace(TEXT_PAIR, (whole, key: string, sep: string) =>
      isSensitiveKey(key) ? `${key}${sep}${MASK}` : whole
    )
    .replace(BEARER, (_w, scheme: string) => `${scheme} ${MASK}`)
}

/**
 * Error text from a partner reply. Admins keep it whole; everyone else gets a
 * status-level summary: the first line, secrets masked, capped.
 */
export function redactError(raw: unknown, withBodies: boolean): string | null {
  if (raw == null || raw === '') return null
  const text = String(raw)
  if (withBodies) return text
  // Mask the whole text first (a JSON pair can straddle the cut), then keep
  // the first line.
  const first = maskInline(maskBodySecrets(text) ?? '')
    .split(/\r?\n/, 1)[0]
    .trim()
  return first.length > ERROR_SUMMARY_CHARS ? `${first.slice(0, ERROR_SUMMARY_CHARS - 1)}…` : first
}
