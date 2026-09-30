/**
 * Redaction for recorded outbound calls (#605) and Copy as curl.
 *
 * Every header and body the flight recorder keeps goes through two layers:
 *   1. the platform-wide rule (secret-mask.ts) — anything whose NAME looks
 *      like it carries a credential is masked, headers and JSON keys alike;
 *   2. the API's own rules, `nivaro_external_apis.redaction` =
 *      {headers: string[], body_paths: string[]} — header / query names and
 *      JSON body paths an admin names for that partner (a customer's email,
 *      a card number, a partner session id under an innocent name).
 *
 * Body paths: dotted segments; `[]` or `*` after a segment walks every array
 * element or every key — `customer.email`, `items[].card`, `*.ssn`.
 *
 * A leaf module — no db, no imports beyond secret-mask — so readers can
 * re-apply the rules on the way out.
 */
import { isSensitiveKey, MASK, maskBodySecrets, maskQueryString } from './secret-mask.js'

export interface RedactionRules {
  headers: string[]
  body_paths: string[]
}

export const EMPTY_REDACTION: RedactionRules = { headers: [], body_paths: [] }

/** Longest body the recorder keeps per side. */
export const RECORDER_BODY_CAP = 16_000

const EXPLICIT_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token'
])

/** Parse the stored column (or a request body) into clean rules. */
export function parseRedaction(raw: unknown): RedactionRules {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return { ...EMPTY_REDACTION }
    }
  }
  if (!v || typeof v !== 'object') return { ...EMPTY_REDACTION }
  const o = v as { headers?: unknown; body_paths?: unknown }
  const clean = (list: unknown, max: number, lower: boolean) =>
    Array.isArray(list)
      ? [
          ...new Set(
            list
              .map((x) => String(x ?? '').trim())
              .map((x) => (lower ? x.toLowerCase() : x))
              .filter((x) => x.length > 0 && x.length <= 200)
          )
        ].slice(0, max)
      : []
  return {
    headers: clean(o.headers, 50, true),
    body_paths: clean(o.body_paths, 50, false)
  }
}

/** Headers with credentials (platform rule) and the API's named headers masked. */
export function redactHeaders(
  headers: Record<string, string> | null | undefined,
  rules: RedactionRules = EMPTY_REDACTION
): Record<string, string> | null {
  if (!headers) return null
  const custom = new Set(rules.headers)
  const out: Record<string, string> = {}
  for (const [k, raw] of Object.entries(headers)) {
    const v = raw == null ? '' : String(raw)
    const lk = k.toLowerCase()
    const masked = EXPLICIT_HEADER_NAMES.has(lk) || isSensitiveKey(lk) || custom.has(lk)
    if (!masked || !v) {
      out[k] = v
      continue
    }
    if (lk === 'authorization' || lk === 'proxy-authorization') {
      const parts = v.split(' ')
      out[k] = parts.length > 1 ? `${parts[0]} ${MASK}` : MASK
    } else out[k] = MASK
  }
  return out
}

type Seg = { key: string; all: boolean }

function parsePath(path: string): Seg[] {
  return path
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (s === '*' || s === '[]') return { key: '*', all: true }
      if (s.endsWith('[]')) return { key: s.slice(0, -2), all: true }
      return { key: s, all: false }
    })
}

function maskAt(node: unknown, segs: Seg[]): boolean {
  if (!segs.length || node == null || typeof node !== 'object') return false
  const [head, ...rest] = segs
  let changed = false
  const visitChild = (container: Record<string, unknown>, k: string) => {
    if (!(k in container)) return
    if (rest.length === 0) {
      if (container[k] != null && container[k] !== '') {
        container[k] = MASK
        changed = true
      }
      return
    }
    if (maskAt(container[k], rest)) changed = true
  }
  if (head.key === '*') {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (rest.length === 0) {
          if (node[i] != null) {
            node[i] = MASK
            changed = true
          }
        } else if (maskAt(node[i], rest)) changed = true
      }
    } else {
      for (const k of Object.keys(node as Record<string, unknown>))
        visitChild(node as Record<string, unknown>, k)
    }
    return changed
  }
  const container = node as Record<string, unknown>
  if (!head.all) {
    visitChild(container, head.key)
    return changed
  }
  // `items[]` — walk every element of the array under `items`.
  const arr = container[head.key]
  if (!Array.isArray(arr)) return false
  for (let i = 0; i < arr.length; i++) {
    if (rest.length === 0) {
      if (arr[i] != null) {
        arr[i] = MASK
        changed = true
      }
    } else if (maskAt(arr[i], rest)) changed = true
  }
  return changed
}

/** A JSON body with the named paths masked; anything that does not parse is returned as is. */
export function maskJsonPaths(body: string | null | undefined, paths: string[]): string | null {
  if (body == null) return null
  if (!paths.length) return body
  const t = body.trimStart()
  if (!t.startsWith('{') && !t.startsWith('[')) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  let changed = false
  for (const p of paths) if (maskAt(parsed, parsePath(p))) changed = true
  return changed ? JSON.stringify(parsed) : body
}

function cap(s: string | null, max: number): string | null {
  if (s == null) return null
  return s.length > max ? `${s.slice(0, max)}… [truncated]` : s
}

/** A stored body: platform secret masking, the API's paths, capped. */
export function redactBody(
  body: string | null | undefined,
  rules: RedactionRules = EMPTY_REDACTION,
  max = RECORDER_BODY_CAP
): string | null {
  if (body == null) return null
  return cap(maskJsonPaths(maskBodySecrets(body), rules.body_paths), max)
}

/** A url with credential-looking and API-named query parameters masked. */
export function redactUrl(
  url: string | null | undefined,
  rules: RedactionRules = EMPTY_REDACTION
): string | null {
  if (!url) return url ?? null
  const q = url.indexOf('?')
  if (q < 0) return url
  const base = url.slice(0, q)
  const masked = maskQueryString(url.slice(q + 1)) ?? ''
  const custom = new Set(rules.headers)
  const out = masked
    .split('&')
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq < 0) return part
      const name = part.slice(0, eq)
      return custom.has(name.toLowerCase()) ? `${name}=${MASK}` : part
    })
    .join('&')
  return out ? `${base}?${out}` : base
}

function parseHeaders(h: unknown): Record<string, string> {
  if (!h) return {}
  if (typeof h === 'string') {
    try {
      const v = JSON.parse(h) as unknown
      return v && typeof v === 'object' ? (v as Record<string, string>) : {}
    } catch {
      return {}
    }
  }
  return typeof h === 'object' ? (h as Record<string, string>) : {}
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * A copy-paste curl for a recorded call. Masked values become
 * `<REDACTED:name>` placeholders the operator fills in — the recorder never
 * held the real secret, so neither does the command.
 */
export function buildCurl(call: {
  method?: string | null
  url?: string | null
  request_headers?: unknown
  request_body?: string | null
}): string {
  const method = (call.method ?? 'GET').toUpperCase()
  const placeholders = new Set<string>()
  const fill = (text: string, name: string) =>
    text.includes(MASK)
      ? text.split(MASK).join(
          (() => {
            const p = `<REDACTED:${name}>`
            placeholders.add(p)
            return p
          })()
        )
      : text
  const url = fill(call.url ?? '', 'query')
  const lines = [`curl -X ${method} ${shellQuote(url)}`]
  for (const [k, v] of Object.entries(parseHeaders(call.request_headers))) {
    if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'host') continue
    lines.push(`-H ${shellQuote(`${k}: ${fill(String(v ?? ''), k.toLowerCase())}`)}`)
  }
  const body = call.request_body
  if (body != null && body !== '' && method !== 'GET' && method !== 'HEAD') {
    const b = fill(body, 'body')
    lines.push(`--data-raw ${shellQuote(b)}`)
  }
  const cmd = lines.join(' \\\n  ')
  if (!placeholders.size) return cmd
  return `# Replace ${[...placeholders].join(', ')} with the real value(s) before running.\n${cmd}`
}
