import { lookup as dnsLookup } from 'node:dns/promises'
import { db } from '../../../db/index.js'
import { readServedField } from '../promote-gather.js'
import type { HubEnvironmentRow } from '../promote-types.js'
import type { DockerDriverConfig } from './driver-config.js'
import { stackHostnames } from './render-spec.js'

/**
 * Does an environment's name serve yet (Hub phase 4, Decision 13)? A Docker deploy with manual
 * DNS may end before someone has added the name: the deploy then succeeds with a warning and the
 * environment waits for its name.
 *
 * Phase 3 owns the `waiting_for_name` status, the name-check cron and the "Check name" button
 * (cross-phase ruling: services/hub/name-check.ts). This module is only what the Docker verify
 * step needs: one look at the name now, and the copy a manual-DNS admin passes on.
 */

export type NameState = 'serving' | 'not_resolving' | 'not_serving'

/** One read of a JSON URL's field (promote-gather.ts readServedField). */
export type ServedFieldReader = (
  url: string,
  field: string
) => Promise<{ value: string | null; error: string | null }>

/** How long one DNS look may take before the name counts as not resolving. */
export const NAME_LOOKUP_TIMEOUT_MS = 5_000

export interface NameCheckDeps {
  /** Resolves a host name; rejects when it does not resolve. */
  lookup?: (host: string) => Promise<unknown>
  readServedField?: ServedFieldReader
}

function baseOf(raw: string): URL | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/** Rejects when `p` takes longer than `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('lookup timed out')), ms)
      timer.unref?.()
    })
  ]).finally(() => clearTimeout(timer))
}

/**
 * One look at the name (named apart from phase 3's `checkName(envId)`): the base_url host
 * resolves (DNS, ≤ 5 s), then `<base_url>/api/version` answers `version` — any version when
 * `version` is null. Never throws.
 */
export async function lookName(
  env: { base_url: string },
  version: string | null,
  deps: NameCheckDeps = {}
): Promise<NameState> {
  const base = baseOf(env.base_url)
  if (!base) return 'not_resolving'
  const lookup = deps.lookup ?? ((host: string) => dnsLookup(host))
  try {
    await within(Promise.resolve(lookup(base.hostname)), NAME_LOOKUP_TIMEOUT_MS)
  } catch {
    return 'not_resolving'
  }
  const read: ServedFieldReader =
    deps.readServedField ?? ((url, field) => readServedField(url, field))
  try {
    const r = await read(`${base.origin}/api/version`, 'version')
    if (!r.value) return 'not_serving'
    return version == null || r.value === version ? 'serving' : 'not_serving'
  } catch {
    return 'not_serving'
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
    out.push(`Ask for DNS name ${host} pointing at ${target}`)
    out.push(`and a TLS certificate for ${host}`)
  }
  return out
}

/** A waiting_for_name environment whose name now serves becomes active. */
// biome-ignore format: one line, swapped for phase 3's name check at merge
export const markNameServing = (envId: number) => db('nivaro_hub_environments').where({ id: envId, status: 'waiting_for_name' }).update({ status: 'active' }) // merge: use phase 3 name-check

/** Sets an environment's status to waiting_for_name (manual DNS, the name does not serve yet). */
// biome-ignore format: one line, swapped for phase 3's name check at merge
export const markWaitingForName = (envId: number) => db('nivaro_hub_environments').where({ id: envId }).update({ status: 'waiting_for_name' }) // merge: use phase 3 name-check
