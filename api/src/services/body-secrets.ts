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
