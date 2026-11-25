import { type FetchJsonOptions, fetchJson } from '../../gitlab-client.js'
import { prevSealedHubToken } from '../ops/hub-token-grace.js'
import { type OpsEnvTarget, opsTargets } from '../ops/link-read.js'
import { openSecret } from '../secrets.js'
import {
  deploymentLinkBearer,
  linkUrlOrigin,
  openSharedPrevToken,
  openSharedToken,
  tenantIdFor
} from '../shared/store.js'

/**
 * Hub side of the verification link (app side: routes/hub-verify-link.ts): one call to an
 * environment's app over the link the Hub has to it, the same way ops reads go (ops/link-read.ts):
 *
 *  - placed on a Hub shared deployment: `{link_url}/api/hub-deployment/verify/apps/<tenant>/<sub>`
 *    with the deployment bearer (the previous token's while its grace lasts);
 *  - else, with a hub token: `{base_url}/api/hub-link/verify/<sub>` with the opened token (the
 *    previous one inside its 24 h grace, only to the address the grace was given for);
 *  - else `no_link` — nothing is called.
 *
 * Redirects refused, 30 s per call (a run of reads waits on the app), never logged. The outcome is
 * a fixed state word, never the app's text: ok | no_link | refused | too_old | unreachable |
 * failed | bad_request.
 */

export type VerifyLinkState =
  | 'ok'
  | 'no_link'
  | 'refused'
  | 'too_old'
  | 'unreachable'
  | 'failed'
  | 'bad_request'

export interface VerifyLinkResult {
  state: VerifyLinkState
  body: unknown
  /** The app's short refusal code, when it sent one. */
  code?: string | null
}

export type VerifyFetch = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  opts: FetchJsonOptions
) => Promise<{ ok: boolean; status: number; body: unknown }>

export interface VerifyLinkDeps {
  fetch?: VerifyFetch
  timeoutMs?: number
}

export const VERIFY_LINK_TIMEOUT_MS = 30_000
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

export { opsTargets as verifyTargets }
export type VerifyEnvTarget = OpsEnvTarget

function baseOf(raw: string): string | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

function stateOf(status: number, body: unknown): VerifyLinkState {
  const code = (body as { code?: unknown } | null)?.code
  if (status === 401 || status === 403) return 'refused'
  if (status === 429 && (code === 'HUB_LINK_REFUSED' || code === 'DEPLOYMENT_LINK_REFUSED'))
    return 'refused'
  if (status === 400) return 'bad_request'
  if (status === 404 && code !== 'UNKNOWN_APP') return 'too_old'
  return 'failed'
}

function codeOf(body: unknown): string | null {
  const c = (body as { code?: unknown } | null)?.code
  return typeof c === 'string' && CODE_RE.test(c) ? c : null
}

/** One verify call for one environment (`sub` = run | extensions). Never throws. */
export async function callVerify(
  env: VerifyEnvTarget,
  sub: 'run' | 'extensions',
  body?: unknown,
  deps: VerifyLinkDeps = {}
): Promise<VerifyLinkResult> {
  const send = deps.fetch ?? fetchJson
  const timeoutMs = deps.timeoutMs ?? VERIFY_LINK_TIMEOUT_MS
  const call = async (url: string, bearer: string) => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${bearer}`
    }
    const opts: FetchJsonOptions =
      body === undefined ? { redirect: 'error' } : { redirect: 'error', method: 'POST', body }
    try {
      return await send(url, headers, timeoutMs, opts)
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'FETCH_REDIRECT')
        return { ok: false, status: 401, body: null }
      return null
    }
  }
  const settle = (res: { ok: boolean; status: number; body: unknown } | null) => {
    if (!res) return { state: 'unreachable' as const, body: null }
    if (res.ok) return { state: 'ok' as const, body: res.body }
    return { state: stateOf(res.status, res.body), body: null, code: codeOf(res.body) }
  }

  if (env.shared_deployment_id != null) {
    const origin = linkUrlOrigin(env.link_url)
    if (!origin) return { state: 'no_link', body: null }
    const tenant = tenantIdFor({ key: env.app_key }, { id: env.id })
    const url = `${origin}/api/hub-deployment/verify/apps/${encodeURIComponent(tenant)}/${sub}`
    const current = await openSharedToken(env.shared_deployment_id).catch(() => null)
    if (!current) return { state: 'refused', body: null }
    let res = await call(url, deploymentLinkBearer(current))
    if (res && res.status === 401) {
      const prev = await openSharedPrevToken(env.shared_deployment_id).catch(() => null)
      if (prev) res = await call(url, deploymentLinkBearer(prev))
    }
    return settle(res)
  }

  if (!env.hub_token) return { state: 'no_link', body: null }
  const base = baseOf(env.base_url)
  if (!base) return { state: 'no_link', body: null }
  let token: string | null
  try {
    token = openSecret(env.hub_token)
  } catch {
    token = null
  }
  if (!token) return { state: 'refused', body: null }
  const url = `${base}/api/hub-link/verify/${sub}`
  let res = await call(url, token)
  if (res && res.status === 401) {
    const sealed = await prevSealedHubToken(env.id, { origin: base }).catch(() => null)
    let prev: string | null = null
    try {
      prev = sealed ? openSecret(sealed) : null
    } catch {
      prev = null
    }
    if (prev) res = await call(url, prev)
  }
  return settle(res)
}

/** The verification target of one environment, or null when it does not exist. */
export async function verifyTarget(envId: number): Promise<VerifyEnvTarget | null> {
  return (await opsTargets([envId]))[0] ?? null
}
