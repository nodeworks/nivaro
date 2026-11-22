/**
 * Deployment-mode predicates (Hub phase 5) — the ONE place that reads CLOUD_META_DB_URL,
 * HUB_SHARED_DEPLOYMENT and HUB_DEPLOYMENT_TOKEN.
 *
 *   isNivaroCloud  = the old cloud test, exactly: a non-empty CLOUD_META_DB_URL (' ' counts)
 *   isMultiTenant  = cloud, or a Hub shared deployment (HUB_SHARED_DEPLOYMENT=<key>)
 *   perAppJobs     = multi-tenant with the Hub as tenant source: crons run once per tenant
 *
 * With HUB_SHARED_DEPLOYMENT unset, isMultiTenant === isNivaroCloud === the old expression.
 */
export type TenantSource = 'cloud-meta' | 'hub'

const KEY_RE = /^[a-z0-9-]{1,64}$/

function sharedKey(env: NodeJS.ProcessEnv): string {
  return (env.HUB_SHARED_DEPLOYMENT ?? '').trim()
}

export function isNivaroCloud(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.CLOUD_META_DB_URL
}

export function isMultiTenant(env: NodeJS.ProcessEnv = process.env): boolean {
  return isNivaroCloud(env) || sharedKey(env) !== ''
}

export function perAppJobs(env: NodeJS.ProcessEnv = process.env): boolean {
  return isMultiTenant(env) && !isNivaroCloud(env)
}

export function tenantSource(env: NodeJS.ProcessEnv = process.env): TenantSource | null {
  if (isNivaroCloud(env)) return 'cloud-meta'
  return sharedKey(env) !== '' ? 'hub' : null
}

export function cloudMetaDbUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CLOUD_META_DB_URL ? env.CLOUD_META_DB_URL : null
}

export function hubSharedConfig(
  env: NodeJS.ProcessEnv = process.env
): { deployment: string; hubUrl: string; token: string } | null {
  const deployment = sharedKey(env)
  if (!deployment || isNivaroCloud(env)) return null
  return {
    deployment,
    // The origin only (P5-17's one HUB_URL rule); '' when unset or refused.
    hubUrl: hubUrlOrigin(env) ?? '',
    token: (env.HUB_DEPLOYMENT_TOKEN ?? '').trim()
  }
}

/** A plain sentence when the shared-deployment settings cannot run; null when fine. Never holds the token. */
export function deploymentModeProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = sharedKey(env)
  if (!key) return null
  if (isNivaroCloud(env))
    return 'HUB_SHARED_DEPLOYMENT cannot be combined with CLOUD_META_DB_URL. Unset one of them.'
  const hub = (env.HUB ?? '').trim().toLowerCase()
  if (hub === 'on' || hub === 'true' || hub === '1')
    return 'HUB_SHARED_DEPLOYMENT cannot be combined with HUB=on. A Hub does not run as a shared deployment.'
  if (!KEY_RE.test(key))
    return 'HUB_SHARED_DEPLOYMENT must be 1 to 64 characters: lowercase letters, digits and dashes.'
  const url = (env.HUB_URL ?? '').trim()
  if (!url) return 'HUB_SHARED_DEPLOYMENT needs HUB_URL, the origin of the Nivaro Hub.'
  if (!hubUrlOrigin(env)) return HUB_URL_RULE
  if ((env.HUB_DEPLOYMENT_TOKEN ?? '').trim().length < 32)
    return 'HUB_SHARED_DEPLOYMENT needs HUB_DEPLOYMENT_TOKEN of at least 32 characters.'
  return null
}

// ─── The one HUB_URL rule (ruling P5-17) ───────────────────────────────────
// Phase 5 (the shared deployment's tenant list) and phase 7 (sign-in through the Hub) read the
// same variable; both call this and nothing else.

/** The origins a plain-http HUB_URL may name, outside production only. */
const HUB_URL_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The plain sentence for a HUB_URL that does not pass: what a good one looks like. */
export const HUB_URL_RULE =
  'HUB_URL must be the https origin of the Nivaro Hub (no path, user or password); plain http only for localhost, 127.0.0.1 or [::1] outside production.'

export interface HubUrlCheck {
  /** The Hub's origin (scheme://host[:port]), or null when unset or refused. */
  origin: string | null
  /** Why a value that was set is refused (one sentence, never the value), else null. */
  problem: string | null
}

/**
 * Validate HUB_URL. Blank = unset. Accepted: an https origin, or plain http to a loopback host
 * (localhost, 127.0.0.1, [::1]) when NODE_ENV is not production. Refused: a user or password,
 * a path other than `/`, a query or fragment, any other scheme, or something that is not a URL.
 * A refused value counts as unset (origin null) with a reason; it never stops a boot by itself
 * (a shared deployment, which needs a Hub, refuses through deploymentModeProblem()).
 */
export function hubUrlCheck(env: NodeJS.ProcessEnv = process.env): HubUrlCheck {
  const raw = (env.HUB_URL ?? '').trim()
  if (!raw) return { origin: null, problem: null }
  const refused = { origin: null, problem: HUB_URL_RULE }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return refused
  }
  if (u.username || u.password) return refused
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return refused
  if (u.protocol === 'https:') return { origin: u.origin, problem: null }
  if (
    u.protocol === 'http:' &&
    env.NODE_ENV !== 'production' &&
    HUB_URL_LOOPBACK_HOSTS.has(u.hostname.toLowerCase())
  )
    return { origin: u.origin, problem: null }
  return refused
}

/** The Hub's origin from HUB_URL, or null (unset or refused). */
export function hubUrlOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  return hubUrlCheck(env).origin
}

/** The one boot warning for a HUB_URL that is set but refused (null when fine or unset). */
export function hubUrlBootWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const { problem } = hubUrlCheck(env)
  return problem ? `HUB_URL is ignored. ${problem}` : null
}

// ─── The Hub's own address (ruling X-5) ─────────────────────────────────────

/** config.ts's PUBLIC_URL default: a Hub with no PUBLIC_URL serves (and issues) on it. */
const DEFAULT_PUBLIC_URL = 'http://localhost:3055'

/**
 * The ONE address a Hub hands out as its own: HUB_URL by the one HUB_URL rule when it is set and
 * passes, else the origin of PUBLIC_URL. It is the Hub's OpenID issuer origin and every Hub URL
 * it gives out (phase 7), the HUB_URL a created app is told (phase 3) and the HUB_URL a Docker
 * stack gets (phase 4), so an app always computes the issuer the Hub issues. Null only when
 * PUBLIC_URL is not an http(s) URL.
 */
export function hubPublicOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const hub = hubUrlOrigin(env)
  if (hub) return hub
  const raw = (env.PUBLIC_URL ?? '').trim() || DEFAULT_PUBLIC_URL
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}
