/**
 * Body secrets — partner credentials a request BODY must carry (MWF takes its token in the JSON
 * payload, not a header). They live only in `nivaro_external_apis.auth_config.body_secrets`
 * ({name: value}, masked on every read). Payload templates, previews, stored submissions and call
 * logs carry the placeholder `⟦nvr-secret:<name>⟧`; `callExternalApi` swaps the real value in at
 * send time — only for callers that opt in with `bodySecrets: true` — after the body is resolved
 * and before it is serialized and signed. A retry re-sends the stored body through the same path,
 * so it is substituted again.
 *
 * Only ADMIN-AUTHORED template text may carry a real placeholder. Record, trigger and response
 * data is passed through `neutralizeSecretMarkers` before it is merged into a body, so a record
 * field holding `⟦nvr-secret:token⟧` is sent as inert text and never pulls the secret in.
 */
import { randomBytes } from 'node:crypto'
import { db } from '../db/index.js'

/** Matches one placeholder; group 1 = the secret name. */
const PLACEHOLDER_RE = /⟦nvr-secret:([^⟧]*)⟧/g
const MARKER = '⟦nvr-secret:'
/** The marker with a zero-width space after "secret": reads the same, never matches. */
const NEUTRAL_MARKER = '⟦nvr-secret\u200b:'

export function secretPlaceholder(name: string): string {
  return `⟦nvr-secret:${name}⟧`
}

export class BodySecretError extends Error {
  constructor(apiName: string, secretName: string) {
    super(`${apiName} API has no body secret '${secretName}'`)
    this.name = 'BodySecretError'
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const neutralString = (s: string): string =>
  s.includes(MARKER) ? s.split(MARKER).join(NEUTRAL_MARKER) : s

/**
 * Deep copy with `valueFn` applied to every string value and `keyFn` to every object key — the
 * same walk as the payload evaluator's (Task 3): Dates are copied, Map / Set / ArrayBuffer and
 * typed-array views (Buffer) are opaque, plain records AND class instances become plain copies of
 * their own enumerable keys, cycles keep their shape, `__proto__` stays an own key.
 */
function mapStrings(
  value: unknown,
  valueFn: (s: string) => string,
  keyFn: (s: string) => string = valueFn
): unknown {
  const seen = new WeakMap<object, unknown>()
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return valueFn(v)
    if (v === null || typeof v !== 'object') return v
    if (v instanceof Date) return new Date(v.getTime())
    if (v instanceof Map || v instanceof Set || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      return v
    }
    const hit = seen.get(v)
    if (hit !== undefined) return hit
    if (Array.isArray(v)) {
      const out: unknown[] = []
      seen.set(v, out)
      for (const x of v) out.push(walk(x))
      return out
    }
    const out: Record<string, unknown> =
      Object.getPrototypeOf(v) === null ? Object.create(null) : {}
    seen.set(v, out)
    for (const k of Object.keys(v)) {
      const key = keyFn(k)
      const x = walk((v as Record<string, unknown>)[k])
      if (key === '__proto__') {
        Object.defineProperty(out, key, {
          value: x,
          enumerable: true,
          writable: true,
          configurable: true
        })
      } else out[key] = x
    }
    return out
  }
  return walk(value)
}

/**
 * A deep copy of `value` in which no string — value or object key — can pass for a secret
 * placeholder: every `⟦nvr-secret:` becomes `⟦nvr-secret<ZWSP>:`. Walk semantics: mapStrings.
 * Use it on record / trigger / response data that becomes (part of) a body.
 */
export function neutralizeSecretMarkers(value: unknown): unknown {
  return mapStrings(value, neutralString)
}

/**
 * Protects the placeholders an ADMIN wrote in a JSON body template from everything data can do
 * while it is rendered into that template — including JSON-escaped markers (`\u27e6nvr-secret:`)
 * that JSON.parse would decode into a real one, and adjacent interpolations that only form a
 * marker together. Before the render, every exact placeholder in the template text is swapped for
 * a per-call unforgeable token (random digits: case filters leave it alone, data cannot guess
 * it); `finish(parsed)` then neutralizes every string value and key of the PARSED body and only
 * after that turns the tokens back into the real placeholders (in string values; a token in an
 * object key comes back neutral — placeholders are honoured in values only).
 *
 *   const p = protectTemplatePlaceholders(template)
 *   const body = p.finish(JSON.parse(render(p.text, data)))
 */
export function protectTemplatePlaceholders(templateText: string): {
  text: string
  finish: (parsed: unknown) => unknown
} {
  const nonce = Array.from(randomBytes(24), (b) => String(b % 10)).join('')
  const names: string[] = []
  const text = templateText.replace(PLACEHOLDER_RE, (_m, name: string) => {
    names.push(name)
    return `${nonce}${String(names.length - 1).padStart(4, '0')}`
  })
  const tokenRe = new RegExp(`${nonce}(\\d{4})`, 'g')
  const back = (s: string, neutral: boolean): string =>
    names.length === 0 || !s.includes(nonce)
      ? s
      : s.replace(tokenRe, (m, idx: string) => {
          const name = names[Number(idx)]
          if (name === undefined) return m
          const ph = secretPlaceholder(name)
          return neutral ? neutralString(ph) : ph
        })
  return {
    text,
    finish: (parsed) =>
      mapStrings(
        parsed,
        (s) => back(neutralString(s), false),
        (k) => back(neutralString(k), true)
      )
  }
}

/** JSON Pointer (RFC 6901) of one path segment. */
const pointerSeg = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1')

function hasPlaceholder(s: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0
  const hit = PLACEHOLDER_RE.test(s)
  PLACEHOLDER_RE.lastIndex = 0
  return hit
}

/**
 * JSON Pointers of every string value in `body` that holds a real placeholder. Run it on the
 * FINAL sanitized body (after protectTemplatePlaceholders / neutralizeSecretMarkers) — only the
 * template's own placeholders remain there — and store the list beside the body, so a later
 * resend honours exactly those (restrictPlaceholders). A top-level string body is pointer "".
 */
export function secretPathsOf(body: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown, at: string, depth: number): void => {
    if (depth > 200) return
    if (typeof v === 'string') {
      if (hasPlaceholder(v)) out.push(at)
      return
    }
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, `${at}/${i}`, depth + 1)
      return
    }
    if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) walk(x, `${at}/${pointerSeg(k)}`, depth + 1)
    }
  }
  walk(body, '', 0)
  return out
}

/**
 * A stored body made safe to resend with bodySecrets: true — every placeholder NOT at one of
 * `secretPaths` (and every one in an object key) is neutralized. No list (a row stored before
 * secret_paths existed, or written by something that did not record them) = every placeholder is
 * neutralized: fail closed, nothing is substituted.
 */
export function restrictPlaceholders(body: unknown, secretPaths: unknown): unknown {
  if (!Array.isArray(secretPaths)) return neutralizeSecretMarkers(body)
  const allowed = new Set(secretPaths.filter((p): p is string => typeof p === 'string'))
  if (allowed.size === 0) return neutralizeSecretMarkers(body)
  const walk = (v: unknown, at: string): unknown => {
    if (typeof v === 'string') return allowed.has(at) ? v : neutralString(v)
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}/${i}`))
    if (v !== null && typeof v === 'object') {
      if (!isPlainObject(v)) return neutralizeSecretMarkers(v)
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) {
        const key = neutralString(k)
        const val = walk(x, `${at}/${pointerSeg(k)}`)
        if (key === '__proto__') {
          Object.defineProperty(out, key, {
            value: val,
            enumerable: true,
            writable: true,
            configurable: true
          })
        } else out[key] = val
      }
      return out
    }
    return v
  }
  return walk(body, '')
}

/** The usable `{name: value}` map from a parsed auth_config (empty / non-string values dropped). */
export function bodySecretsOf(authConfig: Record<string, unknown> | null): Record<string, string> {
  const raw = authConfig?.body_secrets
  if (!isRecord(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v !== '') out[k] = v
  }
  return out
}

function replaceIn(
  s: string,
  secrets: Record<string, string>,
  apiName: string,
  jsonEscape: boolean
): string {
  if (!s.includes('⟦nvr-secret:')) return s
  return s.replace(PLACEHOLDER_RE, (_m, name: string) => {
    if (!Object.hasOwn(secrets, name) || !secrets[name]) throw new BodySecretError(apiName, name)
    const v = secrets[name]
    // Inside JSON text the placeholder sits in a string literal — escape the value for it.
    return jsonEscape ? JSON.stringify(v).slice(1, -1) : v
  })
}

function isJsonText(s: string): boolean {
  const t = s.trimStart()
  if (t[0] !== '{' && t[0] !== '[' && t[0] !== '"') return false
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

function walk(v: unknown, secrets: Record<string, string>, apiName: string): unknown {
  if (typeof v === 'string') return replaceIn(v, secrets, apiName, false)
  if (Array.isArray(v)) {
    let changed = false
    const out = v.map((x) => {
      const y = walk(x, secrets, apiName)
      if (y !== x) changed = true
      return y
    })
    return changed ? out : v
  }
  if (isPlainObject(v)) {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const nk = replaceIn(k, secrets, apiName, false)
      const y = walk(x, secrets, apiName)
      if (nk !== k || y !== x) changed = true
      out[nk] = y
    }
    return changed ? out : v
  }
  return v
}

/**
 * Deep-replaces every `⟦nvr-secret:<name>⟧` in the body with that secret's value — in any string
 * value or key; a string body that is JSON text gets JSON-escaped values. Never mutates the input
 * and returns the same reference when there is nothing to replace. An unknown name throws
 * BodySecretError ("MWF API has no body secret 'token'") — the call must not go out.
 */
export function substituteBodySecrets(
  body: unknown,
  secrets: Record<string, string>,
  apiName: string
): unknown {
  if (typeof body === 'string') return replaceIn(body, secrets, apiName, isJsonText(body))
  return walk(body, secrets, apiName)
}

/**
 * For logs and stored responses: every occurrence of a secret's exact value (raw or JSON-escaped)
 * in a partner's response text becomes its placeholder again, so an API that echoes the request
 * back cannot leave the credential on a log screen or a submission row. The empty string is
 * never a secret value.
 */
export function scrubSecretValues(text: string, secrets: Record<string, string>): string {
  if (!text) return text
  let out = text
  // Longest first, so a secret that contains another is replaced whole.
  const entries = Object.entries(secrets).sort((a, b) => b[1].length - a[1].length)
  for (const [name, value] of entries) {
    if (typeof value !== 'string' || value.length === 0) continue
    const ph = secretPlaceholder(name)
    out = out.split(value).join(ph)
    const escaped = JSON.stringify(value).slice(1, -1)
    if (escaped !== value) out = out.split(escaped).join(ph)
  }
  return out
}

/** Deep scrub: strings via scrubSecretValues, arrays / plain objects walked, the rest as-is. */
function scrubDeep(v: unknown, secrets: Record<string, string>): unknown {
  if (typeof v === 'string') return scrubSecretValues(v, secrets)
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, secrets))
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = scrubDeep(x, secrets)
    return out
  }
  return v
}

/**
 * `value` with every body secret of this API (instance-resolved) put back as its placeholder —
 * for what gets STORED from a partner's answer (nivaro_erp_submissions.response, attempt rows).
 * Never use it on the body handed back to a caller (ack parsing reads that). A failed lookup
 * returns the value unchanged; it never throws.
 */
export async function scrubSecretsFor<T>(apiNameOrId: string | number, value: T): Promise<T> {
  if (value === null || value === undefined) return value
  try {
    const secrets = await resolvedSecrets(apiNameOrId)
    if (Object.keys(secrets).length === 0) return value
    return scrubDeep(value, secrets) as T
  } catch {
    return value
  }
}

async function resolvedSecrets(apiNameOrId: string | number): Promise<Record<string, string>> {
  const byId = typeof apiNameOrId === 'number' || /^\d+$/.test(String(apiNameOrId))
  const stored = await db('nivaro_external_apis')
    .where(byId ? { id: Number(apiNameOrId) } : { name: apiNameOrId })
    .first()
  if (!stored) return {}
  // Lazy: external-apis.ts imports this module.
  const { resolveInstanceRow } = await import('./external-apis.js')
  const row = resolveInstanceRow(stored)
  let cfg: Record<string, unknown> | null = null
  try {
    cfg = row.auth_config ? JSON.parse(row.auth_config) : null
  } catch {
    cfg = null
  }
  return bodySecretsOf(cfg)
}

/** Names of the body secrets this API has on THIS instance (overrides folded in). Never values. */
export async function bodySecretNames(apiName: string): Promise<string[]> {
  return Object.keys(await resolvedSecrets(apiName))
}

export async function hasBodySecret(apiName: string, name: string): Promise<boolean> {
  return Object.hasOwn(await resolvedSecrets(apiName), name)
}
