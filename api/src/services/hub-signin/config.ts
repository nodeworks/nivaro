import { isMultiTenant } from '../deployment-mode.js'
import { hubModeEnabled, hubUrl } from '../hub/mode.js'

/**
 * Nivaro Hub phase 7 (plan Decision 14): an app's config for signing in through the Hub. Env
 * only — the Hub link never writes app config:
 *
 *   HUB_URL            the Hub's origin (the one HUB_URL rule: services/deployment-mode.ts)
 *   HUB_CLIENT_ID      this environment's client at the Hub (hubc_…)
 *   HUB_CLIENT_SECRET  its secret (≥ 32 characters; HUB_CLIENT_SECRET_FILE works)
 *   HUB_IDP_AUDIENCE   the Hub's own Entra client id (the `aud` of the Entra evidence)
 *   HUB_SIGNIN=off     turns the Hub path off on this app without touching the Hub
 *
 * Hub sign-in also needs this app's primary OIDC (OIDC_ISSUER + OIDC_CLIENT_ID) with a
 * tenant-specific issuer: the evidence is checked against it. A Hub never signs in through a
 * Hub (HUB=on → null) and a multi-tenant deployment (cloud mode or a Hub shared deployment,
 * isMultiTenant) ignores all of it. Phase 6 (shared deployments) swaps the
 * source of this config; everything else reads it through hubSigninConfig() only.
 */

export type HubSigninConfig = {
  hubUrl: string
  issuer: string
  clientId: string
  clientSecret: string
  idpAudience: string
  allowInsecure: boolean
}

const MIN_SECRET = 32
const MULTI_TENANT = new Set(['common', 'organizations', 'consumers'])
/**
 * Entra sign-in hosts (public, v1 sts.windows.net, US government, China (both names), Germany):
 * the evidence is an Entra token.
 */
const ENTRA_HOSTS = new Set([
  'login.microsoftonline.com',
  'sts.windows.net',
  'login.microsoftonline.us',
  'login.chinacloudapi.cn',
  'login.partner.microsoftonline.cn',
  'login.microsoftonline.de'
])

/** A setting's trimmed value. Callers name the variable literally (env.X), so the Hub's
 *  known-env generator (scripts/hub-known-env.mts) sees every name this file reads. */
const val = (v: string | undefined) => (v ?? '').trim()

function signinOff(env: NodeJS.ProcessEnv): boolean {
  return val(env.HUB_SIGNIN).toLowerCase() === 'off'
}

/** The primary issuer is a tenant-specific https Entra issuer (never common / organizations). */
function primaryIssuerUsable(env: NodeJS.ProcessEnv): boolean {
  const raw = val(env.OIDC_ISSUER)
  if (!raw) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || !ENTRA_HOSTS.has(u.hostname.toLowerCase())) return false
  const tenant = u.pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? ''
  return !!tenant && !MULTI_TENANT.has(tenant)
}

/** Every missing / unusable piece, in a fixed order. */
function problems(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = []
  if (hubModeEnabled(env)) out.push('HUB')
  if (signinOff(env)) out.push('HUB_SIGNIN')
  if (!hubUrl(env)) out.push('HUB_URL')
  if (!val(env.HUB_CLIENT_ID)) out.push('HUB_CLIENT_ID')
  if (val(env.HUB_CLIENT_SECRET).length < MIN_SECRET) out.push('HUB_CLIENT_SECRET')
  if (!val(env.HUB_IDP_AUDIENCE)) out.push('HUB_IDP_AUDIENCE')
  if (!val(env.OIDC_ISSUER) || !primaryIssuerUsable(env)) out.push('OIDC_ISSUER')
  if (!val(env.OIDC_CLIENT_ID)) out.push('OIDC_CLIENT_ID')
  return out
}

export function hubSigninConfig(env: NodeJS.ProcessEnv = process.env): HubSigninConfig | null {
  if (isMultiTenant(env)) return null
  if (problems(env).length > 0) return null
  const origin = hubUrl(env) as string
  return {
    hubUrl: origin,
    issuer: `${origin}/api/hub/oidc`,
    clientId: val(env.HUB_CLIENT_ID),
    clientSecret: val(env.HUB_CLIENT_SECRET),
    idpAudience: val(env.HUB_IDP_AUDIENCE),
    allowInsecure: origin.startsWith('http:')
  }
}

/**
 * What stops Hub sign-in on an app that looks like it meant to use it (any HUB_CLIENT_* set):
 * the names of the settings to fix. Empty when nothing is set, when it works, or on a
 * multi-tenant deployment.
 */
export function hubSigninProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (isMultiTenant(env)) return []
  if (!val(env.HUB_CLIENT_ID) && !val(env.HUB_CLIENT_SECRET)) return []
  return problems(env)
}
