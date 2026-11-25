import { createHmac } from 'node:crypto'
import { isOutboundOptionKey } from '../env-refresh/flow-ops.js'
import { appBoundSigInput } from '../tenancy/credential-binding.js'

/**
 * Hub config promotion, the secret rules of the PROMOTION path only (never the stored restore
 * points, Config download / diff, restore or Changed here — those keep their own redaction).
 *
 *  - isSecretKey: a JSON key that holds a credential (token, key, secret, password, auth,
 *    authorization, api_key, cookie, signature, credential, bearer …; `tokens`, an AI token count,
 *    is not). Exact `key` counts too (a query `key=…`).
 *  - SECRET_CONTAINERS: an object under one of these keys (headers, query, params, auth,
 *    credentials …) is taken off whole, at any depth: every value in it may be a credential.
 *  - outbound keys (env-refresh/flow-ops isOutboundOptionKey: URLs, endpoints, hosts, headers,
 *    auth, webhook, path override) are this environment's: taken off at EVERY depth, in step AND
 *    trigger options alike;
 *  - embedded secrets: a string value that is a URL with userinfo (scheme://user:pass@host) or
 *    holds an auth-scheme token (Bearer / Basic / Digest / Token / ApiKey + a token; unanchored)
 *    is taken off wherever it sits (an array element becomes null, keeping positions);
 *  - deepStrip: walks every nested object and array and takes off all of the above;
 *  - the target merges its OWN values back at the same path (mergeOwn), so it keeps its own
 *    nested URLs, headers and secrets.
 *  - Webhook trigger inbound auth (`auth_type`, `secret`, `require_timestamp`, any secret key) is
 *    ONE kept group: it never travels, and the target keeps its own. A webhook flow new on the
 *    target arrives with bearer auth and a fresh secret (newInboundAuth), never `none`.
 */

const SECRET_KEY_RE =
  /secret|token(?!s)|passw|pwd|private_?key|credential|api_?key|access_?key|client_?secret|auth|cookie|signature|bearer|session/i
const EXACT_SECRET = new Set(['key', 'apikey', 'sig', 'pass'])
export const SECRET_CONTAINERS = new Set([
  'headers',
  'header',
  'query',
  'params',
  'auth',
  'auth_config',
  'credentials',
  'cookies'
])
/** The inbound-auth group of a webhook trigger: kept by the target, never carried. */
export const INBOUND_AUTH_KEYS = new Set(['auth_type', 'secret', 'require_timestamp'])

export function isSecretKey(k: string): boolean {
  const lk = k.toLowerCase()
  return EXACT_SECRET.has(lk) || SECRET_KEY_RE.test(lk)
}

/** A key a promotion never carries (a secret, a secret container or an outbound key), any depth. */
export function isTakenOffKey(k: string): boolean {
  return isSecretKey(k) || SECRET_CONTAINERS.has(k.toLowerCase()) || isOutboundOptionKey(k)
}

const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]+(?::[^\s/?#@]*)?@/i
const AUTH_SCHEME = /\b(?:bearer|basic|digest|token|apikey|api-key)\s+([A-Za-z0-9._~+/=-]{8,})/gi

/** A token, not a word: a digit in it, mixed case and 12+ characters, or 20+ characters. */
function tokenish(t: string): boolean {
  if (/\d/.test(t)) return true
  if (t.length >= 12 && /[A-Z]/.test(t) && /[a-z]/.test(t)) return true
  return t.length >= 20
}

/** A string that carries a credential inside it (a userinfo URL, an auth-scheme token). */
export function isEmbeddedSecret(v: unknown): boolean {
  if (typeof v !== 'string') return false
  if (URL_USERINFO.test(v)) return true
  for (const m of v.matchAll(AUTH_SCHEME)) if (tokenish(m[1])) return true
  return false
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

export function parseJsonObject(v: unknown): Record<string, unknown> | null {
  if (isObj(v)) return v
  if (typeof v !== 'string' || !v.trim()) return null
  try {
    const o = JSON.parse(v)
    return isObj(o) ? o : null
  } catch {
    return null
  }
}

/**
 * Every secret key, secret container, outbound key and embedded secret taken off, through every
 * nested object and array. `found` collects the dotted paths taken off.
 */
export function deepStrip(v: unknown, path: string[] = [], found: string[] = []): unknown {
  if (Array.isArray(v))
    return v.map((x, i) => {
      if (isEmbeddedSecret(x)) {
        found.push([...path, String(i)].join('.'))
        return null
      }
      return deepStrip(x, [...path, String(i)], found)
    })
  if (!isObj(v)) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    if (isTakenOffKey(k) || isEmbeddedSecret(x)) {
      found.push([...path, k].join('.'))
      continue
    }
    out[k] = deepStrip(x, [...path, k], found)
  }
  return out
}

/** The value at a dotted path (undefined when it is not there). */
export function atPath(v: unknown, dotted: string): unknown {
  let cur: unknown = v
  for (const part of dotted.split('.')) {
    if (Array.isArray(cur)) cur = cur[Number(part)]
    else if (isObj(cur)) cur = cur[part]
    else return undefined
  }
  return cur
}

/** A JSON text / object column with deepStrip applied; not JSON = dropped (cannot be vouched for). */
export function stripJsonColumn(v: unknown, found: string[] = []): unknown {
  if (v === null || v === undefined) return v
  if (typeof v !== 'string') return deepStrip(v, [], found)
  const t = v.trim()
  if (!t) return v
  if (t[0] !== '{' && t[0] !== '[') return v
  try {
    return JSON.stringify(deepStrip(JSON.parse(t), [], found))
  } catch {
    found.push('(unreadable JSON)')
    return null
  }
}

/**
 * Flow step options as they leave the source: every outbound key, secret and embedded secret
 * taken off at every depth. `stripped` = the dotted paths taken off (the target uses them to tell
 * a step that needs its own values: a URL, headers, a key).
 */
export function exportStepOptions(v: unknown): { options: unknown; stripped: string[] } {
  if (v === null || v === undefined) return { options: v, stripped: [] }
  const o = parseJsonObject(v)
  if (!o) return { options: null, stripped: typeof v === 'string' && v.trim() ? ['(options)'] : [] }
  const stripped: string[] = []
  const out = deepStrip(o, [], stripped)
  return { options: JSON.stringify(out), stripped }
}

/**
 * Trigger options as they leave the source: the inbound-auth group, and every outbound key,
 * secret and embedded secret at every depth (exactly like step options).
 */
export function exportTriggerOptions(v: unknown): unknown {
  if (v === null || v === undefined) return v
  const o = parseJsonObject(v)
  if (!o) return null
  const top: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(o)) if (!INBOUND_AUTH_KEYS.has(k)) top[k] = x
  return JSON.stringify(deepStrip(top))
}

/** The parts of `own` (the target's live value) a promotion must never change. */
function ownParts(
  own: Record<string, unknown>,
  top: (k: string) => boolean
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(own)) if (top(k) || isTakenOffKey(k)) out[k] = x
  return out
}

/**
 * The target's own taken-off values (outbound keys, secrets, embedded secrets) put back under
 * `incoming` at the same path, at every depth.
 */
const ID_KEYS = ['key', 'name', 'id'] as const

/** An array element's identity: its key / name / id (objects only), else null. */
function identityOf(v: unknown): string | null {
  if (!isObj(v)) return null
  for (const k of ID_KEYS) {
    const x = (v as Record<string, unknown>)[k]
    if (typeof x === 'string' || typeof x === 'number') return `${k}:${String(x)}`
  }
  return null
}

/**
 * The target's own element for an incoming one: objects matched by key / name / id (a header list
 * reordered or grown on the source keeps each header's own secret), anything else by position.
 */
function ownElement(x: unknown, i: number, own: unknown[]): unknown {
  const id = identityOf(x)
  if (id) return own.find((o) => identityOf(o) === id)
  return own[i]
}

function mergeNested(incoming: unknown, own: unknown): unknown {
  if (Array.isArray(incoming) && Array.isArray(own))
    return incoming.map((x, i) => {
      const mine = ownElement(x, i, own)
      return x === null && isEmbeddedSecret(mine) ? mine : mergeNested(x, mine)
    })
  if (!isObj(incoming) || !isObj(own)) return incoming
  const out: Record<string, unknown> = { ...incoming }
  for (const [k, x] of Object.entries(own)) {
    if (isTakenOffKey(k)) out[k] = x
    else if (isEmbeddedSecret(x) && !(k in out)) out[k] = x
    else if (k in out) out[k] = mergeNested(out[k], x)
  }
  return out
}

/**
 * Target side: the incoming (stripped) value with the TARGET's own kept parts put back — the
 * top-level keys `top` names (a step's outbound part, a trigger's inbound auth group) and every
 * nested secret at the same path. `own` null = a row new here (nothing to put back). JSON text.
 */
export function mergeOwn(incoming: unknown, own: unknown, top: (k: string) => boolean): unknown {
  if (incoming === null || incoming === undefined) return incoming
  const inc = parseJsonObject(incoming)
  if (!inc) return incoming
  const mine = parseJsonObject(own)
  if (!mine) return JSON.stringify(inc)
  return JSON.stringify({ ...(mergeNested(inc, mine) as object), ...ownParts(mine, top) })
}

export const stepTop = (k: string) => isOutboundOptionKey(k)
export const triggerTop = (k: string) => INBOUND_AUTH_KEYS.has(k)

/**
 * A webhook flow new on the target: bearer auth with a secret only this environment knows. The
 * secret is derived (HMAC with this environment's own SESSION_SECRET over the promotion's run
 * key and the flow) so the plan and the apply agree; it is shown masked and read on the target's
 * flow page.
 */
export function newInboundAuth(
  sessionSecret: string,
  runKey: string,
  flowKey: string
): { auth_type: 'bearer'; secret: string } {
  const secret = createHmac('sha256', sessionSecret)
    // The app is in the HMAC input on a Hub shared deployment (one SESSION_SECRET, many apps).
    .update(appBoundSigInput(`hub-config-promote:${runKey}:${flowKey}`))
    .digest('base64url')
  return { auth_type: 'bearer', secret }
}
