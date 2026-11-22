import { isIP } from 'node:net'
import type { fetchJson } from '../../gitlab-client.js'
import { checkName } from '../create/name-check.js'
import type { HubEnvironmentRow } from '../promote-types.js'
import type { DockerDriverConfig } from './driver-config.js'
import { stackHostnames } from './render-spec.js'

/**
 * Does an environment's name serve yet (Hub phase 4, Decision 13)? A Docker deploy with manual
 * DNS may end before someone has added the name: the deploy then succeeds with a warning and the
 * environment waits for its name.
 *
 * Phase 3 owns the name check, the `waiting_for_name` status, the name-check cron and the
 * "Check name" button (cross-phase ruling: services/hub/name-check.ts, create/name-check.ts).
 * This module is only what the Docker verify step needs on top: phase 3's check answered as
 * three states, and the copy a manual-DNS admin passes on.
 */

export type NameState = 'serving' | 'not_resolving' | 'not_serving'

/** One read of a JSON URL's field (promote-gather.ts readServedField). */
export type ServedFieldReader = (
  url: string,
  field: string
) => Promise<{ value: string | null; error: string | null }>

export interface NameCheckDeps {
  /** Resolves a host name; rejects when it does not resolve. */
  lookup?: (host: string) => Promise<unknown>
  readServedField?: ServedFieldReader
}

/**
 * One look at the name (named apart from phase 3's `checkName(envId)`): phase 3's one name check
 * (create/name-check.ts checkName) on the base_url host and `<base_url>/api/version`, answered as
 * the Docker verify step's three states. `version` null accepts any version. Never throws.
 * `readServedField`, when given, is how /api/version is read (the verify step passes its own
 * reader in tests); otherwise phase 3's bounded, no-redirect fetch.
 */
export async function lookName(
  env: { base_url: string },
  version: string | null,
  deps: NameCheckDeps = {}
): Promise<NameState> {
  let host: string
  try {
    const u = new URL(String(env.base_url ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'not_resolving'
    host = u.hostname
  } catch {
    return 'not_resolving'
  }
  const read = deps.readServedField
  try {
    const check = await checkName(host, String(env.base_url), version ?? '', {
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
      ...(read ? { fetchJson: servedFieldAsFetch(read) } : {})
    })
    if (!check.resolves) return 'not_resolving'
    return check.serves ? 'serving' : 'not_serving'
  } catch {
    return 'not_serving'
  }
}

/** A served-field reader in the shape phase 3's checkName fetches with. */
function servedFieldAsFetch(read: ServedFieldReader): typeof fetchJson {
  return async (url: string) => {
    const r = await read(url, 'version')
    return r.value
      ? { ok: true, status: 200, body: { version: r.value } }
      : { ok: false, status: 0, body: null }
  }
}

/**
 * What a manual-DNS admin asks their DNS people for, per name the stack routes: the DNS name
 * pointing at the driver's edge target, and a TLS certificate for it. Empty for automatic DNS.
 */
export function nameRequest(
  env: Pick<HubEnvironmentRow, 'base_url' | 'hostnames'>,
  driver: DockerDriverConfig
): string[] {
  if (driver.dns_mode !== 'manual') return []
  const target = driver.edge_target ?? '(the edge target is not set)'
  const out: string[] = []
  for (const host of stackHostnames(env, 'traefik')) {
    // An IP address needs no DNS name and gets no certificate for itself (P4-34).
    if (isIpAddress(host)) {
      out.push(`${host} is an IP address — no DNS name or TLS certificate is needed`)
      continue
    }
    out.push(`Ask for DNS name ${host} pointing at ${target}`)
    out.push(`and a TLS certificate for ${host}`)
  }
  return out
}

/** An IPv4 or (bracketed or bare) IPv6 address. */
function isIpAddress(host: string): boolean {
  return isIP(host.replace(/^\[|\]$/g, '')) !== 0
}
