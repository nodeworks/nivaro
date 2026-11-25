import { db } from '../../../db/index.js'
import { hubLinkOrigin } from '../move/link-client.js'
import { openSecret } from '../secrets.js'
import { deploymentClient } from '../shared/deployment-client.js'
import {
  deploymentLinkBearer,
  getShared,
  linkUrlOrigin,
  openSharedToken,
  type SharedDeployment,
  tenantIdFor
} from '../shared/store.js'
import { DataError } from './types.js'

/**
 * Hub data care: the calls the Hub makes to an APP for its data — over the app's hub link
 * (`/api/hub-link/data/*`, a dedicated app) or its shared deployment's link
 * (`/api/hub-deployment/apps/<tenant>/data/*`). The app does the work on its own storage and its
 * own database; the Hub only asks and reads counts:
 *
 *   GET    refresh-keeps            → {version, keeps}   what the app keeps on a refresh
 *   POST   files-backup             → {run_id}           copy every stored file to a target
 *   GET    files-backup/:runId      → status
 *   POST   files-backup/delete      → {deleted}          remove one earlier backup set
 *   DELETE files                    → {deleted}          (deployment link, rehearsal apps only)
 *
 * Same rules as the move's link client: https (plain http only to this machine / .test /
 * .localhost for a hub link; a private address for a deployment link), no redirects, bounded
 * time and answer size, the bearer only in its header, and a refusal answered as a short code.
 */

const TIMEOUT_MS = 15_000
const MAX_BYTES = 2 * 1024 * 1024
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

export interface AppChannel {
  kind: 'dedicated' | 'shared'
  /** The app's tenant id on its shared deployment; null for a dedicated app. */
  tenantId: string | null
  shared: SharedDeployment | null
  call(method: 'GET' | 'POST' | 'DELETE', sub: string, body?: unknown): Promise<unknown>
  /** The Nivaro version the app runs (its hub link status / deployment app status). */
  version(): Promise<string | null>
}

export type Fetch = typeof fetch
let fetchImpl: Fetch = (url, init) => fetch(url, init)

/** Test seam. */
export function _setAppCallFetchForTests(f: Fetch | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init))
}

export class AppCallError extends DataError {
  reason: string | null
  constructor(message: string, reason: string | null = null, status = 502) {
    super('APP_UNREACHABLE', reason ? `${message} (${reason})` : message, status)
    this.reason = reason
  }
}

async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function bearerCall(
  url: string,
  bearer: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown
): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${bearer}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: ctl.signal
      })
    } catch {
      throw new AppCallError('The app did not answer.')
    }
    const text = await readCapped(res)
    if (text === null) throw new AppCallError('The app answered with too much data.')
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (res.status >= 200 && res.status < 300) return parsed
    const c = (parsed as { code?: unknown } | null)?.code
    const code = typeof c === 'string' && CODE_RE.test(c) ? c : `HTTP_${res.status}`
    if (res.status === 404 && (code === 'HTTP_404' || code === 'NOT_FOUND'))
      throw new AppCallError(
        'The app has no data link (a Nivaro version older than 0.3.215, or no HUB_TOKEN there).',
        'LINK_MISSING'
      )
    throw new AppCallError('The app refused the request.', code, res.status === 409 ? 409 : 502)
  } finally {
    clearTimeout(timer)
  }
}

/** How the Hub reaches an environment's app for data work. */
export async function appChannelFor(envId: number): Promise<AppChannel> {
  const e = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .where('e.id', envId)
    .first('e.id', 'e.base_url', 'e.hub_token', 'e.placement_id', 'a.key as app_key')) as
    | Record<string, unknown>
    | undefined
  if (!e) throw new DataError('NOT_FOUND', 'No such environment.', 404)
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
      tenantId,
      shared: s,
      async call(method, sub, body) {
        const origin = linkUrlOrigin(s.link_url)
        const token = await openSharedToken(s.id)
        if (!origin || !token)
          throw new AppCallError('The shared deployment’s link is not set up in the Hub.')
        return bearerCall(
          `${origin}/api/hub-deployment/apps/${encodeURIComponent(tenantId)}/data/${sub}`,
          deploymentLinkBearer(token),
          method,
          body
        )
      },
      async version() {
        try {
          return (await deploymentClient(s).appStatus(tenantId)).version
        } catch {
          return null
        }
      }
    }
  }
  const origin = hubLinkOrigin(String(e.base_url ?? ''))
  const token = openSecret((e.hub_token as string | null) ?? null)
  return {
    kind: 'dedicated',
    tenantId: null,
    shared: null,
    async call(method, sub, body) {
      if (!origin)
        throw new AppCallError('The app’s address is not one the Hub sends its token to.')
      if (!token) throw new AppCallError('The Hub holds no hub token for this environment.')
      return bearerCall(`${origin}/api/hub-link/${sub}`, token, method, body)
    },
    async version() {
      if (!origin || !token) return null
      try {
        const b = (await bearerCall(`${origin}/api/hub-link/status`, token, 'GET')) as {
          version?: unknown
        } | null
        return typeof b?.version === 'string' ? b.version.slice(0, 64) : null
      } catch {
        return null
      }
    }
  }
}

/** The data sub-path on a channel: a hub link prefixes `data/`, a deployment link already has. */
export function dataPath(ch: Pick<AppChannel, 'kind'>, sub: string): string {
  return ch.kind === 'dedicated' ? `data/${sub}` : sub
}

/** A rehearsal app's files go (deployment link, `rh-` apps only — the deployment refuses others). */
export async function purgeRehearsalFiles(
  shared: SharedDeployment,
  tenantId: string
): Promise<{ deleted: number }> {
  const origin = linkUrlOrigin(shared.link_url)
  const token = await openSharedToken(shared.id)
  if (!origin || !token)
    throw new AppCallError('The shared deployment’s link is not set up in the Hub.')
  const a = (await bearerCall(
    `${origin}/api/hub-deployment/apps/${encodeURIComponent(tenantId)}/data/files`,
    deploymentLinkBearer(token),
    'DELETE'
  )) as { deleted?: unknown } | null
  return { deleted: Number(a?.deleted ?? 0) }
}
