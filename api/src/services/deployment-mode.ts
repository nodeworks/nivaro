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
    hubUrl: (env.HUB_URL ?? '').trim(),
    token: (env.HUB_DEPLOYMENT_TOKEN ?? '').trim()
  }
}

function hubUrlOk(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return true
  if (u.protocol !== 'http:') return false
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
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
  if (!hubUrlOk(url))
    return 'HUB_URL must be an https address (plain http only for localhost or 127.0.0.1).'
  if ((env.HUB_DEPLOYMENT_TOKEN ?? '').trim().length < 32)
    return 'HUB_SHARED_DEPLOYMENT needs HUB_DEPLOYMENT_TOKEN of at least 32 characters.'
  return null
}
