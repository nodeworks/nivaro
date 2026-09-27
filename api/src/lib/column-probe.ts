/**
 * "Does this column exist yet?" — asked by writers that must keep working on a
 * database that has not run the migration adding it (a cloud tenant, an image
 * ahead of its ledger). A hit is kept for the life of the process; a miss is
 * asked again after a minute. Per tenant.
 */
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'

const MISS_TTL_MS = 60_000

interface ProbeState {
  hit: boolean
  at: number
  inflight: Promise<boolean> | null
}

const probes = new Map<string, ProbeState>()

export async function hasColumn(table: string, column: string): Promise<boolean> {
  const key = `${getTenantId() ?? ''}\u0000${table}\u0000${column}`
  const state = probes.get(key)
  if (state?.hit) return true
  if (state?.inflight) return state.inflight
  if (state && Date.now() - state.at < MISS_TTL_MS) return false
  const inflight = (async () => {
    try {
      return await db.schema.hasColumn(table, column)
    } catch {
      return false
    }
  })()
  probes.set(key, { hit: false, at: state?.at ?? 0, inflight })
  const hit = await inflight
  probes.set(key, { hit, at: Date.now(), inflight: null })
  return hit
}

export function resetColumnProbes(): void {
  probes.clear()
}
