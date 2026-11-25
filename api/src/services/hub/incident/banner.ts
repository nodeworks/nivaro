import { plainBannerText } from '../../hub-link/status-banner.js'
import { hubLinkOrigin } from '../move/link-client.js'
import { type PeopleTarget, peopleTargetOf } from '../people/link-calls.js'
import { openSecret } from '../secrets.js'
import {
  deploymentLinkBearer,
  linkUrlOrigin,
  openSharedPrevToken,
  openSharedToken
} from '../shared/store.js'

/**
 * Hub side of the incident status banner (services/hub-link/status-banner.ts on the app):
 *
 *   dedicated  PUT | DELETE {base_url}/api/hub-link/status-banner                bearer = hub token
 *   shared     PUT | DELETE {link_url}/api/hub-deployment/apps/<tenant>/status-banner
 *              bearer = HMAC of the deployment token (the previous one once on a 401)
 *
 * The target is found the way the people calls find it (peopleTargetOf: placement first, then
 * the hub token). Bounded (BANNER_CALL_TIMEOUT_MS), redirects refused, the answer is never read
 * back into the Hub beyond its status. The outcome is a fixed word: shown | cleared | no_link |
 * too_old (an app before 0.3.215 has no such route) | refused | unreachable | failed.
 */

export const BANNER_CALL_TIMEOUT_MS = 10_000

export type BannerState =
  | 'shown'
  | 'cleared'
  | 'no_link'
  | 'too_old'
  | 'refused'
  | 'unreachable'
  | 'failed'

export interface BannerCallDeps {
  fetch?: typeof fetch
  timeoutMs?: number
  sharedTokens?: (id: number) => Promise<{ current: string | null; previous: string | null }>
  targetOf?: typeof peopleTargetOf
}

export interface BannerEnv {
  id: number
  app_id: number
  base_url: string
  hub_token?: string | null
  placement_id?: number | null
}

async function callOnce(
  doFetch: typeof fetch,
  method: 'PUT' | 'DELETE',
  url: string,
  bearer: string,
  body: unknown,
  ms: number
): Promise<number | 'timeout' | 'unreachable' | 'redirect'> {
  const ctl = new AbortController()
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      (async () => {
        const res = await doFetch(url, {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: ctl.signal
        })
        void res.body?.cancel().catch(() => {})
        if (res.status >= 300 && res.status < 400) return 'redirect' as const
        return res.status
      })(),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          ctl.abort()
          resolve('timeout')
        }, ms)
      })
    ])
  } catch {
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}

function stateOf(r: number | 'timeout' | 'unreachable' | 'redirect', ok: BannerState): BannerState {
  if (r === 'timeout' || r === 'unreachable') return 'unreachable'
  if (r === 'redirect') return 'refused'
  if (r >= 200 && r < 300) return ok
  if (r === 401 || r === 403 || r === 429) return 'refused'
  if (r === 404 || r === 405) return 'too_old'
  return 'failed'
}

/** Sets (text) or clears (text null) the banner on one environment. Never throws. */
export async function pushBanner(
  env: BannerEnv,
  banner:
    | { text: string; tone: string; incident_id: number }
    | { clear: true; incident_id: number },
  deps: BannerCallDeps = {}
): Promise<BannerState> {
  const doFetch = deps.fetch ?? fetch
  const ms = deps.timeoutMs ?? BANNER_CALL_TIMEOUT_MS
  const clear = 'clear' in banner
  const method = clear ? 'DELETE' : 'PUT'
  const ok: BannerState = clear ? 'cleared' : 'shown'
  let body: Record<string, unknown>
  if (clear) body = { incident_id: banner.incident_id }
  else {
    const text = plainBannerText(banner.text)
    if (!text) return 'failed'
    body = { text, tone: banner.tone, incident_id: banner.incident_id }
  }
  let target: PeopleTarget | null
  try {
    target = await (deps.targetOf ?? peopleTargetOf)(env)
  } catch {
    return 'failed'
  }
  if (!target) return 'no_link'
  try {
    if (target.kind === 'dedicated') {
      const base = hubLinkOrigin(target.base_url)
      if (!base) return 'no_link'
      let token: string | null
      try {
        token = openSecret(target.token)
      } catch {
        return 'refused'
      }
      if (!token) return 'no_link'
      return stateOf(
        await callOnce(doFetch, method, `${base}/api/hub-link/status-banner`, token, body, ms),
        ok
      )
    }
    const base = linkUrlOrigin(target.link_url)
    if (!base) return 'no_link'
    const tokens = deps.sharedTokens
      ? await deps.sharedTokens(target.sharedId)
      : {
          current: await openSharedToken(target.sharedId),
          previous: await openSharedPrevToken(target.sharedId)
        }
    if (!tokens.current) return 'refused'
    const url = `${base}/api/hub-deployment/apps/${encodeURIComponent(target.tenantId)}/status-banner`
    let r = await callOnce(doFetch, method, url, deploymentLinkBearer(tokens.current), body, ms)
    if (r === 401 && tokens.previous && tokens.previous !== tokens.current)
      r = await callOnce(doFetch, method, url, deploymentLinkBearer(tokens.previous), body, ms)
    return stateOf(r, ok)
  } catch {
    return 'unreachable'
  }
}
