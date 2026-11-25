import { config } from '../../../config.js'
import { db } from '../../../db/index.js'
import { sealForApp } from '../../tenancy/app-sealed.js'
import { openSecret } from '../secrets.js'
import { deploymentClient } from './deployment-client.js'
import { getShared } from './store.js'
import type { SharedTenantRow } from './tenants.js'

/**
 * The Hub link a shared deployment hands each app it serves (the tenant list's `hub_link`,
 * services/tenancy/hub-contract.ts): what a dedicated app reads from HUB_TOKEN, HUB_CLIENT_ID,
 * HUB_CLIENT_SECRET and HUB_IDP_AUDIENCE. JSON, sealed with the app's own key
 * (tenancy/app-sealed.ts, synthetic IV, so the list's ETag only moves when a value does). The seal
 * binds the value to that app; it is not what keeps it secret (the same body carries the app key):
 * the tenants route is (bearer only, TLS, `no-store`, never logged).
 *
 *   token          the environment's hub token, when it has one
 *   client_id      the environment's Hub sign-in client, only when it can sign people in now:
 *   client_secret  active, the app in `hub` mode, the environment neither archived nor suspended
 *                  (clientUsable in services/hub/oidc/clients.ts). Any other app signs in directly.
 *   idp_audience   the Hub's own Microsoft client id (OIDC_CLIENT_ID), the evidence's `aud`
 *
 * No key, nothing to say, or a seal that cannot be opened here: no `hub_link` (the app signs in
 * directly and has no switcher). A database failure throws (the tenants route answers 500 and the
 * deployment keeps its last good list). Never logs a value.
 */

const ENVS = 'nivaro_hub_environments'
const CLIENTS = 'nivaro_hub_oidc_clients'
const CLOSED = new Set(['archived', 'suspended'])

const truthy = (v: unknown) => v === true || v === 1 || v === '1'

function opened(sealed: unknown): string | null {
  try {
    return openSecret(typeof sealed === 'string' ? sealed : null)
  } catch {
    return null
  }
}

/** env id → the plain JSON to seal, for every listed environment that has something to say. */
export async function hubLinksFor(rows: readonly SharedTenantRow[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (!rows.length) return out
  const ids = rows.map((r) => r.env.id)
  const [tokens, clients] = await Promise.all([
    db(ENVS).whereIn('id', ids).select('id', 'hub_token') as Promise<
      { id: number; hub_token: string | null }[]
    >,
    db(CLIENTS)
      .whereIn('environment_id', ids)
      .select('environment_id', 'client_id', 'client_secret', 'active') as Promise<
      { environment_id: number; client_id: string; client_secret: string; active: unknown }[]
    >
  ])
  const tokenOf = new Map(tokens.map((t) => [Number(t.id), t.hub_token]))
  const clientOf = new Map(clients.map((c) => [Number(c.environment_id), c]))
  const audience = (config.OIDC_CLIENT_ID ?? '').trim() || null

  for (const { env, app, wireStatus } of rows) {
    const link: Record<string, string> = {}
    const token = opened(tokenOf.get(env.id))
    if (token) link.token = token
    const c = clientOf.get(env.id)
    const usable =
      !!c &&
      truthy(c.active) &&
      app.signin_mode === 'hub' &&
      !CLOSED.has(env.status) &&
      wireStatus !== 'suspended'
    const secret = usable ? opened(c?.client_secret) : null
    if (c && secret) {
      link.client_id = String(c.client_id)
      link.client_secret = secret
    }
    if (!link.token && !link.client_id) continue
    if (audience) link.idp_audience = audience
    out.set(env.id, JSON.stringify({ v: 1, ...link }))
  }
  return out
}

/** The `hub_link` wire value: the plain JSON sealed with the app key (64 hex). */
export function sealHubLink(plain: string, appKey: string): string {
  return sealForApp(plain, appKey)
}

/**
 * Best effort, never awaited by a person: ask every shared deployment serving one of these
 * environments (or every environment of `appId`) to re-read its tenant list now, so a new,
 * rotated or switched-off sign-in client reaches the app at once instead of within 30 s. A
 * deployment that does not take the kick re-reads on its own timer. Never throws, never logs a
 * value.
 */
export async function kickSharedServing(which: {
  envIds?: number[]
  appId?: number
}): Promise<void> {
  try {
    const q = db(`${ENVS} as e`)
      .join('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
      .where('p.kind', 'shared')
      .whereNotNull('p.shared_deployment_id')
    if (which.appId != null) q.where('e.app_id', which.appId)
    else if (which.envIds?.length) q.whereIn('e.id', which.envIds)
    else return
    const rows = (await q.distinct('p.shared_deployment_id as sid')) as { sid: number }[]
    await Promise.all(
      rows.map(async (r) => {
        const shared = await getShared(Number(r.sid))
        if (shared) await deploymentClient(shared).refresh()
      })
    )
  } catch {
    // The deployment re-reads its list within 30 s anyway.
  }
}
