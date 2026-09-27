/**
 * Cache console (#236): one registry of the process's in-memory caches with a
 * bust button each. Caches self-register at module load with their existing
 * bust function — the registry never owns cache logic, it only names it.
 * The maps are per process; a bust asked for here also moves the database's
 * configuration epoch, so every other process follows within its poll.
 */
import { bumpConfigEpoch } from '../db/config-epoch.js'

export interface RegisteredCache {
  name: string
  description: string
  bust: () => void
}

const registry = new Map<string, RegisteredCache>()

export function registerCache(name: string, description: string, bust: () => void): void {
  registry.set(name, { name, description, bust })
}

export function listCaches(): Array<{ name: string; description: string }> {
  return [...registry.values()]
    .map(({ name, description }) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function bustCache(name: string): boolean {
  const c = registry.get(name)
  if (!c) return false
  c.bust()
  return true
}

export function bustAllCaches(): string[] {
  const names: string[] = []
  for (const c of registry.values()) {
    try {
      c.bust()
      names.push(c.name)
    } catch {
      /* one broken bust must not stop the rest */
    }
  }
  return names
}

/** Clear here, then tell every other process on this database. */
export async function bustEverywhere(
  name: string
): Promise<{ busted: string[]; epoch: number | null }> {
  const busted = name === '__all__' ? bustAllCaches() : bustCache(name) ? [name] : []
  const epoch = busted.length ? await bumpConfigEpoch() : null
  return { busted, epoch }
}
