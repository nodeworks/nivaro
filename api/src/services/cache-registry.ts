/**
 * Cache console (#236): one registry of the process's in-memory caches with a
 * bust button each. Caches self-register at module load with their existing
 * bust function — the registry never owns cache logic, it only names it.
 * Per-replica by nature (these are in-process maps), which the UI says.
 */

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
