import { db } from '../../../db/index.js'
import { hubLinkOrigin } from '../move/link-client.js'
import { openSecret } from '../secrets.js'
import {
  deploymentLinkBearer,
  getShared,
  linkUrlOrigin,
  openSharedToken,
  tenantIdFor
} from '../shared/store.js'

/**
 * Hub providers (Task 13): the Hub's call that sets allow-listed app settings on an environment —
 * the app's hub link (`/api/hub-link/settings/apply`, a dedicated app) or its shared deployment's
 * link (`/api/hub-deployment/apps/<tenant>/settings/apply`). Same rules as the config calls
 * (services/hub/config/channel.ts): the address must be one the Hub sends its token to, no
 * redirects, the bearer only in its header, 30 s, the answer read up to 64 KB, a refusal answered as
 * its short code. Never puts a value in an error.
 */

export class AppSettingsLinkError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AppSettingsLinkError'
    this.code = code
  }
}

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const TIMEOUT_MS = 30_000
const MAX_ANSWER = 64 * 1024

type Fetch = typeof fetch
// Hub-only (HUB=on, never a shared deployment): the test seam for the app call.
let fetchImpl: Fetch = (url, init) => fetch(url, init)

/** Test seam. */
export function _setAppSettingsFetchForTests(f: Fetch | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init))
}

async function where(envId: number): Promise<{ url: string; bearer: string }> {
  const e = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .where('e.id', envId)
    .first('e.id', 'e.base_url', 'e.hub_token', 'e.placement_id', 'a.key as app_key')) as
    | Record<string, unknown>
    | undefined
  if (!e) throw new AppSettingsLinkError('NOT_FOUND', 'No such environment.')
  if (e.placement_id != null) {
    const p = (await db('nivaro_hub_placements')
      .where({ id: e.placement_id })
      .first('kind', 'shared_deployment_id')) as
      | { kind: string; shared_deployment_id: number | null }
      | undefined
    if (p?.kind === 'shared' && p.shared_deployment_id != null) {
      const s = await getShared(Number(p.shared_deployment_id))
      const origin = s ? linkUrlOrigin(s.link_url) : null
      const token = s ? await openSharedToken(s.id) : null
      if (!s || !origin || !token)
        throw new AppSettingsLinkError(
          'APP_UNREACHABLE',
          'The shared deployment’s link is not set up in the Hub.'
        )
      const tenant = tenantIdFor({ key: String(e.app_key) }, { id: envId })
      return {
        url: `${origin}/api/hub-deployment/apps/${encodeURIComponent(tenant)}/settings/apply`,
        bearer: deploymentLinkBearer(token)
      }
    }
  }
  const origin = hubLinkOrigin(String(e.base_url ?? ''))
  if (!origin)
    throw new AppSettingsLinkError(
      'APP_UNREACHABLE',
      'The app’s address is not one the Hub sends its token to.'
    )
  const token = openSecret((e.hub_token as string | null) ?? null)
  if (!token)
    throw new AppSettingsLinkError(
      'APP_UNREACHABLE',
      'The Hub holds no hub token for this environment.'
    )
  return { url: `${origin}/api/hub-link/settings/apply`, bearer: token }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_ANSWER) {
      void reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Sets `settings` on the environment's app. Throws AppSettingsLinkError (code + short text). */
export async function pushAppSettings(
  envId: number,
  settings: Record<string, string | null>
): Promise<{ applied: string[] }> {
  const { url, bearer } = await where(envId)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
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
        body: JSON.stringify({ settings }),
        redirect: 'error',
        signal: ctl.signal
      })
    } catch {
      throw new AppSettingsLinkError('APP_UNREACHABLE', 'The app did not answer in time.')
    }
    let parsed: Record<string, unknown> = {}
    try {
      const v = JSON.parse((await readCapped(res)) || '{}') as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>
    } catch {
      parsed = {}
    }
    if (res.status >= 200 && res.status < 300)
      return {
        applied: Array.isArray(parsed.applied)
          ? parsed.applied.filter((k): k is string => typeof k === 'string')
          : []
      }
    const code =
      typeof parsed.code === 'string' && CODE_RE.test(parsed.code)
        ? parsed.code
        : `HTTP_${res.status}`
    if (res.status === 404 && (code === 'HTTP_404' || code === 'NOT_FOUND'))
      throw new AppSettingsLinkError(
        'LINK_MISSING',
        'The app has no settings link (a Nivaro version without it, or no HUB_TOKEN there).'
      )
    const said =
      res.status < 500 && typeof parsed.message === 'string' ? parsed.message.slice(0, 300) : null
    throw new AppSettingsLinkError(code, said ?? 'The app refused the settings.')
  } finally {
    clearTimeout(timer)
  }
}
