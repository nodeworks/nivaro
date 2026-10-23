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
import { db } from '../db/index.js'
import { isPlainObject, isRecord, PLACEHOLDER_RE, SECRET_PLACEHOLDER } from './secret-markers.js'

export {
  isRecord,
  neutralizeSecretMarkers,
  protectTemplatePlaceholders,
  restrictPlaceholders,
  secretPathsOf
} from './secret-markers.js'

export function secretPlaceholder(name: string): string {
  return SECRET_PLACEHOLDER(name)
}

export class BodySecretError extends Error {
  constructor(apiName: string, secretName: string) {
    super(`${apiName} API has no body secret '${secretName}'`)
    this.name = 'BodySecretError'
  }
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
 * What is STORED in place of a partner answer whose body secrets could not be checked (the API's
 * config could not be read at that moment): never the raw value, which may echo a credential.
 */
export const SCRUB_FAILED: Readonly<{ _scrub_failed: true }> = Object.freeze({
  _scrub_failed: true as const
})
export type ScrubFailed = { _scrub_failed: true }
/** SCRUB_FAILED as stored in a text column (`{"_scrub_failed":true}`). */
export const SCRUB_FAILED_TEXT = JSON.stringify(SCRUB_FAILED)
/** A logged response header's value when the scrub could not run: names stay, values never do. */
export const SCRUB_FAILED_HEADER = '[not stored: secret scrub failed]'

/**
 * The fail-closed stand-in for `value`: a string becomes SCRUB_FAILED_TEXT, an object / array /
 * anything else that can carry text becomes a fresh `{ _scrub_failed: true }`. null / undefined,
 * numbers, booleans and bigints cannot hold a secret's text and pass through.
 */
export function scrubFailedValue<T>(value: T): T | ScrubFailed {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return SCRUB_FAILED_TEXT as T
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return value
  return { ...SCRUB_FAILED }
}

/** Response headers to log when the scrub could not run: every name kept, every value dropped. */
export function scrubFailedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(headers).map((k) => [k, SCRUB_FAILED_HEADER]))
}

/** An API's auth_config text could not be read, so its body secrets are unknown. */
export class BodySecretsUnreadableError extends Error {
  constructor() {
    super('auth_config is not readable JSON')
    this.name = 'BodySecretsUnreadableError'
  }
}

/**
 * The body secrets in an auth_config TEXT, strictly: empty / absent config = none; text that
 * does not parse throws BodySecretsUnreadableError (the secrets are unknown, not absent).
 */
export function bodySecretsFromConfigText(text: string | null | undefined): Record<string, string> {
  if (text == null || String(text).trim() === '') return {}
  let cfg: unknown
  try {
    cfg = JSON.parse(String(text))
  } catch {
    throw new BodySecretsUnreadableError()
  }
  return bodySecretsOf(isRecord(cfg) ? cfg : null)
}

/**
 * The API's body secrets for a scrub, or null when they cannot be resolved (the config read
 * throws, or its auth_config is unreadable) — logged here with the error text only, never a
 * value. `{}` = found with none, or no such API. Never throws.
 */
export async function secretsForScrub(
  apiNameOrId: string | number
): Promise<Record<string, string> | null> {
  try {
    return await resolvedSecrets(apiNameOrId, true)
  } catch (err) {
    console.warn(
      `body-secrets: API ${String(apiNameOrId).slice(0, 100)} — secret scrub failed, storing the marker: ${
        err instanceof Error ? err.message : String(err)
      }`.slice(0, 300)
    )
    return null
  }
}

/**
 * `value` scrubbed with already-resolved secrets: null secrets (cannot tell) = the fail-closed
 * stand-in (scrubFailedValue), `{}` = unchanged, else every secret value back as its placeholder.
 */
export function applyScrub<T>(value: T, secrets: Record<string, string> | null): T | ScrubFailed {
  if (value === null || value === undefined) return value
  if (secrets === null) return scrubFailedValue(value)
  if (Object.keys(secrets).length === 0) return value
  return scrubDeep(value, secrets) as T
}

/**
 * `value` with every body secret of this API (instance-resolved) put back as its placeholder —
 * for what gets STORED from a partner's answer (nivaro_erp_submissions.response, attempt rows).
 * Never use it on the body handed back to a caller (ack parsing reads that).
 *
 * Fails CLOSED: when the API's secrets cannot be resolved (the config read throws, or its
 * auth_config is unreadable) it returns the SCRUB_FAILED stand-in (scrubFailedValue) and logs
 * the failure without the value. An API that is found and has no body secrets (or no such API)
 * returns the value unchanged. Never throws.
 */
export async function scrubSecretsFor(apiNameOrId: string | number, value: string): Promise<string>
export async function scrubSecretsFor(
  apiNameOrId: string | number,
  value: string | null
): Promise<string | null>
export async function scrubSecretsFor<T>(
  apiNameOrId: string | number,
  value: T
): Promise<T | ScrubFailed>
export async function scrubSecretsFor<T>(
  apiNameOrId: string | number,
  value: T
): Promise<T | ScrubFailed> {
  if (value === null || value === undefined) return value
  return applyScrub(value, await secretsForScrub(apiNameOrId))
}

/** A response body as excerpt text: a string as-is, anything else as JSON ('' for undefined). */
function bodyText(body: unknown): string {
  if (typeof body === 'string') return body
  return JSON.stringify(body ?? null) ?? ''
}

/**
 * An excerpt of a partner's response body for STORED error text (last_error, attempt error,
 * obligation reason, flow $error): the WHOLE body text is scrubbed first, then cut to `max` — a
 * secret straddling the cut can never survive half-scrubbed. Cannot tell = SCRUB_FAILED_TEXT.
 * `secrets` may be passed when the caller already resolved them (undefined = look them up).
 */
export async function scrubbedExcerpt(
  apiNameOrId: string | number,
  body: unknown,
  max = 500,
  secrets?: Record<string, string> | null
): Promise<string> {
  const text = bodyText(body)
  if (!text) return text
  const s = secrets === undefined ? await secretsForScrub(apiNameOrId) : secrets
  if (s === null) return SCRUB_FAILED_TEXT
  return scrubSecretValues(text, s).slice(0, max)
}

/**
 * A message built FROM a partner's body (detectDefaultBodyRejection / detectConfiguredBodyError
 * quote its fields) for stored error text. The decision is made on the raw body (null = no
 * message, nothing looked up); the message is then rebuilt from the scrubbed body, so any cut
 * the builder makes happens after the scrub. Cannot tell = SCRUB_FAILED_TEXT.
 */
export async function scrubbedBodyMessage(
  apiNameOrId: string | number,
  body: unknown,
  build: (body: unknown) => string | null
): Promise<string | null> {
  const raw = build(body)
  if (raw == null) return null
  const secrets = await secretsForScrub(apiNameOrId)
  if (secrets === null) return SCRUB_FAILED_TEXT
  if (Object.keys(secrets).length === 0) return raw
  const scrubbedBody =
    typeof body === 'string' ? scrubSecretValues(body, secrets) : scrubDeep(body, secrets)
  return scrubSecretValues(build(scrubbedBody) ?? raw, secrets)
}

/**
 * For writing a partner's answer to the call log / flight recorder from a row already in hand:
 * the secrets are read strictly from its (instance-resolved) auth_config TEXT. Unreadable =
 * fail closed: `text` gives SCRUB_FAILED_TEXT and `headers` keeps every name with its value
 * dropped. Never throws.
 */
export function responseLogScrubber(authConfigText: string | null | undefined): {
  secrets: Record<string, string>
  unknown: boolean
  text: (t: string) => string
  headers: (h: Record<string, string>) => Record<string, string>
} {
  let secrets: Record<string, string> = {}
  let unknown = false
  try {
    secrets = bodySecretsFromConfigText(authConfigText)
  } catch {
    unknown = true
  }
  const has = Object.keys(secrets).length > 0
  return {
    secrets,
    unknown,
    text: (t) =>
      unknown ? (scrubFailedValue(t) as string) : has ? scrubSecretValues(t, secrets) : t,
    headers: (h) =>
      unknown
        ? scrubFailedHeaders(h)
        : has
          ? Object.fromEntries(
              Object.entries(h).map(([k, v]) => [k, scrubSecretValues(v, secrets)])
            )
          : h
  }
}

async function resolvedSecrets(
  apiNameOrId: string | number,
  strict = false
): Promise<Record<string, string>> {
  const byId = typeof apiNameOrId === 'number' || /^\d+$/.test(String(apiNameOrId))
  const stored = await db('nivaro_external_apis')
    .where(byId ? { id: Number(apiNameOrId) } : { name: apiNameOrId })
    .first()
  if (!stored) return {}
  // Lazy: external-apis.ts imports this module.
  const { resolveInstanceRow } = await import('./external-apis.js')
  const row = resolveInstanceRow(stored)
  if (strict) return bodySecretsFromConfigText(row.auth_config)
  try {
    return bodySecretsFromConfigText(row.auth_config)
  } catch {
    return {}
  }
}

/** Names of the body secrets this API has on THIS instance (overrides folded in). Never values. */
export async function bodySecretNames(apiName: string): Promise<string[]> {
  return Object.keys(await resolvedSecrets(apiName))
}

export async function hasBodySecret(apiName: string, name: string): Promise<boolean> {
  return Object.hasOwn(await resolvedSecrets(apiName), name)
}
