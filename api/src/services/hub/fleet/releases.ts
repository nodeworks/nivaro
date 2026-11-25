import { db } from '../../../db/index.js'
import { knownReleases } from './rules.js'
import { type FleetState, loadFleetState, saveFleetState } from './settings.js'

/**
 * The releases the Hub KNOWS exist (what "newest" and "N behind" count in, rules.ts):
 *
 *  - every version a Hub promotion or rollback deployed successfully (nivaro_hub_deploys) and every
 *    version a shared deployment ran successfully (nivaro_hub_shared_deploys, upgrades and observed
 *    changes the Hub verified through the deployment link);
 *  - the image's published x.y.z tags (HUB_IMAGE on Docker Hub), cached in the fleet state and
 *    refreshed at most hourly by the alerts job — a page load never calls the registry.
 *
 * Never the Hub's own version and never an app's self-reported version: an app answering a
 * version above all of these is "unverified" (flagged, not counted).
 */

export const REGISTRY_REFRESH_MS = 60 * 60_000

async function deployedVersions(): Promise<string[]> {
  const read = async (table: string) => {
    try {
      return (
        (await db(table).where('status', 'success').distinct('version')) as Array<{
          version: string | null
        }>
      ).map((r) => r.version ?? '')
    } catch {
      return []
    }
  }
  const [a, b] = await Promise.all([read('nivaro_hub_deploys'), read('nivaro_hub_shared_deploys')])
  return [...a, ...b]
}

/** Known releases, newest first (registry cache + verified deploys). */
export async function loadKnownReleases(state?: FleetState): Promise<string[]> {
  const s = state ?? (await loadFleetState())
  return knownReleases([...s.registry.versions, ...(await deployedVersions())])
}

export type RegistryReader = () => Promise<{ versions: string[]; error: string | null }>

async function defaultRegistry(): Promise<{ versions: string[]; error: string | null }> {
  const [{ listImageVersions }, { hubImage }] = await Promise.all([
    import('../docker/image-tags.js'),
    import('../registry.js')
  ])
  return listImageVersions(hubImage(), 100)
}

/**
 * Refreshes the cached published tags when they are older than an hour. A registry that does not
 * answer keeps the last good list (never an empty one).
 */
export async function refreshRegistryCache(
  now: Date,
  read: RegistryReader = defaultRegistry
): Promise<FleetState> {
  const state = await loadFleetState()
  const at = state.registry.read_at ? new Date(state.registry.read_at).getTime() : 0
  if (Number.isFinite(at) && now.getTime() - at < REGISTRY_REFRESH_MS) return state
  const out = await read().catch(() => ({ versions: [] as string[], error: 'failed' }))
  if (out.error || !out.versions.length) return state
  const next = { ...state, registry: { versions: out.versions, read_at: now.toISOString() } }
  await saveFleetState(next)
  return next
}
