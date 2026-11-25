import { db } from '../../../db/index.js'
import { type FetchJsonOptions, fetchJson } from '../../gitlab-client.js'
import { openSecret } from '../secrets.js'
import {
  deploymentLinkBearer,
  linkUrlOrigin,
  openSharedPrevToken,
  openSharedToken,
  tenantIdFor
} from '../shared/store.js'

/**
 * Hub operations: read one environment's ops aggregates (services/hub-link/ops-report.ts on the
 * app) over the link the Hub has to it.
 *
 *  - placed on a Hub shared deployment: `{link_url}/api/hub-deployment/ops/apps/<tenant>/<what>`
 *    with the deployment bearer (the HMAC of its token; the previous token's while its grace
 *    lasts, as the deployment client does);
 *  - else, with a hub token: `{base_url}/api/hub-link/ops/<what>` with the opened token;
 *  - else: `no_link` (nothing is called; the public routes never answer this).
 *
 * Every call: 10 s, redirects refused (a bearer never follows one), never logged. The outcome is
 * a fixed state word — never the app's text: ok | no_link | refused | too_old | unreachable |
 * failed. `too_old` = the app answers but has no such route (a version before 0.3.215).
 */

export type LinkReadState = 'ok' | 'no_link' | 'refused' | 'too_old' | 'unreachable' | 'failed'

export interface LinkReadResult {
  state: LinkReadState
  body: unknown
}

export type OpsWhat = 'issues' | 'files'

export interface LinkReadDeps {
  fetch?: (
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    opts: FetchJsonOptions
  ) => Promise<{ ok: boolean; status: number; body: unknown }>
  timeoutMs?: number
}

export const OPS_LINK_TIMEOUT_MS = 10_000

export interface OpsEnvTarget {
  id: number
  app_key: string
  base_url: string
  hub_token: string | null
  shared_deployment_id: number | null
  link_url: string | null
}

/** The environments to read, with what the link needs (one query). */
export async function opsTargets(envIds?: number[]): Promise<OpsEnvTarget[]> {
  const q = db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .leftJoin('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
    .leftJoin('nivaro_hub_shared_deployments as s', function () {
      this.on('s.id', '=', 'p.shared_deployment_id')
    })
    .select(
      'e.id',
      'a.key as app_key',
      'e.base_url',
      'e.hub_token',
      'p.kind as placement_kind',
      'p.shared_deployment_id',
      's.link_url'
    )
  if (envIds?.length) q.whereIn('e.id', envIds)
  const rows = (await q) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    app_key: String(r.app_key),
    base_url: String(r.base_url ?? ''),
    hub_token: (r.hub_token as string | null) ?? null,
    shared_deployment_id:
      r.placement_kind === 'shared' && r.shared_deployment_id != null
        ? Number(r.shared_deployment_id)
        : null,
    link_url: (r.link_url as string | null) ?? null
  }))
}

function baseOf(raw: string): string | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.search = ''
    u.hash = ''
    return u.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

function stateOf(status: number, body: unknown): LinkReadState {
  const code = (body as { code?: unknown } | null)?.code
  if (status === 401 || status === 403) return 'refused'
  if (status === 429 && (code === 'HUB_LINK_REFUSED' || code === 'DEPLOYMENT_LINK_REFUSED'))
    return 'refused'
  if (status === 404 && code !== 'UNKNOWN_APP') return 'too_old'
  return 'failed'
}

/** One ops read for one environment. Never throws. */
export async function readOps(
  env: OpsEnvTarget,
  what: OpsWhat,
  query: Record<string, string> = {},
  deps: LinkReadDeps = {}
): Promise<LinkReadResult> {
  const get = deps.fetch ?? fetchJson
  const timeoutMs = deps.timeoutMs ?? OPS_LINK_TIMEOUT_MS
  const qs = new URLSearchParams(query).toString()
  const suffix = qs ? `?${qs}` : ''
  const call = async (url: string, bearer: string) => {
    try {
      return await get(
        url,
        { Accept: 'application/json', Authorization: `Bearer ${bearer}` },
        timeoutMs,
        { redirect: 'error' }
      )
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'FETCH_REDIRECT')
        return { ok: false, status: 401, body: null }
      return null
    }
  }

  if (env.shared_deployment_id != null) {
    const origin = linkUrlOrigin(env.link_url)
    if (!origin) return { state: 'no_link', body: null }
    const tenant = tenantIdFor({ key: env.app_key }, { id: env.id })
    const url = `${origin}/api/hub-deployment/ops/apps/${encodeURIComponent(tenant)}/${what}${suffix}`
    let current: string | null = null
    try {
      current = await openSharedToken(env.shared_deployment_id)
    } catch {
      current = null
    }
    if (!current) return { state: 'refused', body: null }
    let res = await call(url, deploymentLinkBearer(current))
    if (res && res.status === 401) {
      const prev = await openSharedPrevToken(env.shared_deployment_id).catch(() => null)
      if (prev) res = await call(url, deploymentLinkBearer(prev))
    }
    if (!res) return { state: 'unreachable', body: null }
    if (res.ok) return { state: 'ok', body: res.body }
    return { state: stateOf(res.status, res.body), body: null }
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
  const res = await call(`${base}/api/hub-link/ops/${what}${suffix}`, token)
  if (!res) return { state: 'unreachable', body: null }
  if (res.ok) return { state: 'ok', body: res.body }
  return { state: stateOf(res.status, res.body), body: null }
}
