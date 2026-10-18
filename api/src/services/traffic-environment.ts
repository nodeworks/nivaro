// api/src/services/traffic-environment.ts
/**
 * #2242 — which environment this map is looking at, so two open maps are never confused.
 * The name comes from the Environments registry when one of its API components lives at this
 * instance's own address (PUBLIC_URL / ADMIN_URL), else from NIVARO_INSTANCE (else NODE_ENV).
 * The tier (production / staging / development / other) picks the colour on the page.
 */
import { db } from '../db/index.js'
import { instanceKey } from './instance-key.js'

export type EnvTier = 'production' | 'staging' | 'development' | 'other'
export interface MapEnvironment {
  /** The deployment slot (NIVARO_INSTANCE, else NODE_ENV). */
  instance: string
  /** What the band says: the registry name, else the instance, title-cased. */
  name: string
  tier: EnvTier
  source: 'registry' | 'instance'
}

/** The tier a name stands for (pure): production, staging, development, or other. */
export function tierOf(name: string): EnvTier {
  const n = name.trim().toLowerCase()
  if (/pre-?prod|stag|uat|\bqa\b|rehears/.test(n)) return 'staging'
  if (/prod|\blive\b/.test(n)) return 'production'
  if (/dev|local|test|sandbox|demo/.test(n)) return 'development'
  return 'other'
}

function titleCase(s: string): string {
  const t = s.trim().replace(/[-_]+/g, ' ')
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Default'
}

function hostOf(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

/** Pure: pick the registry environment whose api component sits at one of `hosts`. */
export function matchRegistry(
  hosts: string[],
  envs: Array<{ id: number; name: string }>,
  comps: Array<{ environment: number | null; base_url: string | null }>
): string | null {
  const mine = new Set(hosts.filter(Boolean))
  if (mine.size === 0) return null
  for (const c of comps) {
    const h = hostOf(c.base_url)
    if (!h || !mine.has(h)) continue
    const e = envs.find((x) => x.id === c.environment)
    if (e?.name) return e.name
  }
  return null
}

const TTL_MS = 60_000
let cache: { at: number; value: MapEnvironment } | null = null

/** This instance's environment (60 s cache; never throws). */
export async function mapEnvironment(): Promise<MapEnvironment> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  const instance = instanceKey()
  let value: MapEnvironment = {
    instance,
    name: titleCase(instance),
    tier: tierOf(instance),
    source: 'instance'
  }
  try {
    const envs = (await db('nivaro_environments').select('id', 'name')) as Array<{
      id: number
      name: string
    }>
    const comps = (await db('nivaro_environment_components')
      .where('kind', 'api')
      .select('environment', 'base_url')) as Array<{
      environment: number | null
      base_url: string | null
    }>
    const hosts = [hostOf(process.env.PUBLIC_URL), hostOf(process.env.ADMIN_URL)].filter(
      (h): h is string => !!h
    )
    const name = matchRegistry(hosts, envs, comps)
    if (name) {
      // The registry's own name decides the tier; the instance key breaks a tie ('other').
      const tier = tierOf(name) === 'other' ? tierOf(instance) : tierOf(name)
      value = { instance, name, tier, source: 'registry' }
    }
  } catch {
    /* no registry: the instance key is the answer */
  }
  cache = { at: Date.now(), value }
  return value
}
