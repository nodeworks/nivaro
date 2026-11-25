import { db } from '../../../db/index.js'
import { hubLinkOrigin } from '../move/link-client.js'
import { openSecret } from '../secrets.js'
import {
  deploymentLinkBearer,
  getShared,
  linkUrlOrigin,
  openSharedToken,
  type SharedDeployment,
  tenantIdFor
} from '../shared/store.js'
import { ConfigPromotionError } from './types.js'

/**
 * Hub config promotion: how the Hub reaches an environment's app for its config calls — the
 * app's hub link (`/api/hub-link/config/<call>`, a dedicated app) or its shared deployment's link
 * (`/api/hub-deployment/config/apps/<tenant>/<call>`). Same rules as the data calls
 * (services/hub/data/app-calls.ts): https (plain http only to this machine / .test / .localhost
 * for a hub link; a private address for a deployment link), no redirects, the bearer only in its
 * header, a refusal answered as its short code — but a snapshot is bigger than a status, so the
 * answer cap and the time limit are per call (a snapshot or a plan up to 64 MB, two minutes).
 */

export type ConfigCall = 'snapshot' | 'plan' | 'apply' | 'status' | 'undo'

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const LIMITS: Record<ConfigCall, { bytes: number; ms: number }> = {
  snapshot: { bytes: 64 * 1024 * 1024, ms: 120_000 },
  plan: { bytes: 16 * 1024 * 1024, ms: 150_000 },
  apply: { bytes: 4 * 1024 * 1024, ms: 170_000 },
  status: { bytes: 4 * 1024 * 1024, ms: 30_000 },
  undo: { bytes: 16 * 1024 * 1024, ms: 170_000 }
}

export type Fetch = typeof fetch
let fetchImpl: Fetch = (url, init) => fetch(url, init)

/** Test seam. */
export function _setConfigFetchForTests(f: Fetch | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init))
}

export interface ConfigChannel {
  kind: 'dedicated' | 'shared'
  call(name: ConfigCall, body: unknown): Promise<unknown>
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One call. Throws ConfigPromotionError: APP_UNREACHABLE (502), LINK_MISSING, or the app's code. */
export async function postConfig(
  url: string,
  bearer: string,
  name: ConfigCall,
  body: unknown
): Promise<unknown> {
  const lim = LIMITS[name]
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), lim.ms)
  try {
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body ?? {}),
        redirect: 'error',
        signal: ctl.signal
      })
    } catch {
      throw new ConfigPromotionError('APP_UNREACHABLE', 'The app did not answer in time.', 502)
    }
    const text = await readCapped(res, lim.bytes)
    if (text === null)
      throw new ConfigPromotionError(
        'ANSWER_TOO_LARGE',
        'The app answered with more than the Hub reads at once — promote fewer groups at a time.',
        502
      )
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (res.status >= 200 && res.status < 300) return parsed
    const p = (parsed ?? {}) as { code?: unknown; message?: unknown; error?: unknown }
    const code = typeof p.code === 'string' && CODE_RE.test(p.code) ? p.code : `HTTP_${res.status}`
    if (res.status === 404 && (code === 'HTTP_404' || code === 'NOT_FOUND'))
      throw new ConfigPromotionError(
        'LINK_MISSING',
        'The app has no config link (a Nivaro version older than 0.3.215, or no HUB_TOKEN there).',
        502
      )
    // The app's own words for a refusal it explains (a 4xx with a short code), capped.
    const said = typeof p.message === 'string' ? p.message.slice(0, 500) : null
    const extra: Record<string, unknown> = {}
    const pp = parsed as Record<string, unknown> | null
    if (pp && Array.isArray(pp.items)) extra.items = pp.items.slice(0, 200)
    if (pp && Array.isArray(pp.lines)) extra.lines = pp.lines.slice(0, 200)
    if (pp?.preview && typeof pp.preview === 'object') extra.preview = pp.preview
    if (pp && Array.isArray(pp.cascade)) extra.cascade = pp.cascade.slice(0, 200)
    throw new ConfigPromotionError(
      code,
      said && (res.status < 500 || res.status === 501) ? said : 'The app refused the request.',
      (res.status >= 400 && res.status < 500) || res.status === 501 ? 409 : 502,
      extra
    )
  } finally {
    clearTimeout(timer)
  }
}

/** How the Hub reaches an environment's app for config work. */
export async function configChannelFor(envId: number): Promise<ConfigChannel> {
  const e = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .where('e.id', envId)
    .first('e.id', 'e.base_url', 'e.hub_token', 'e.placement_id', 'a.key as app_key')) as
    | Record<string, unknown>
    | undefined
  if (!e) throw new ConfigPromotionError('NOT_FOUND', 'No such environment.', 404)
  let shared: SharedDeployment | null = null
  if (e.placement_id != null) {
    const p = (await db('nivaro_hub_placements')
      .where({ id: e.placement_id })
      .first('kind', 'shared_deployment_id')) as
      | { kind: string; shared_deployment_id: number | null }
      | undefined
    if (p?.kind === 'shared' && p.shared_deployment_id != null)
      shared = await getShared(Number(p.shared_deployment_id))
  }
  if (shared) {
    const s = shared
    const tenantId = tenantIdFor({ key: String(e.app_key) }, { id: envId })
    return {
      kind: 'shared',
      async call(name, body) {
        const origin = linkUrlOrigin(s.link_url)
        const token = await openSharedToken(s.id)
        if (!origin || !token)
          throw new ConfigPromotionError(
            'APP_UNREACHABLE',
            'The shared deployment’s link is not set up in the Hub.',
            502
          )
        return postConfig(
          `${origin}/api/hub-deployment/config/apps/${encodeURIComponent(tenantId)}/${name}`,
          deploymentLinkBearer(token),
          name,
          body
        )
      }
    }
  }
  const origin = hubLinkOrigin(String(e.base_url ?? ''))
  const token = openSecret((e.hub_token as string | null) ?? null)
  return {
    kind: 'dedicated',
    async call(name, body) {
      if (!origin)
        throw new ConfigPromotionError(
          'APP_UNREACHABLE',
          'The app’s address is not one the Hub sends its token to.',
          502
        )
      if (!token)
        throw new ConfigPromotionError(
          'APP_UNREACHABLE',
          'The Hub holds no hub token for this environment.',
          502
        )
      return postConfig(`${origin}/api/hub-link/config/${name}`, token, name, body)
    }
  }
}
