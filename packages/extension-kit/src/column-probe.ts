import type { Knex } from 'knex'

/**
 * "Does this column exist yet?" — asked by writers that must keep working on
 * a database that has not run the migration adding it (a cloud tenant, an
 * image ahead of its ledger, a teammate's dev API restarting under you).
 *
 * A hit is kept for the life of the process: a column, once added, is never
 * dropped from under a running process. A miss is asked again after a
 * minute, so a database that catches up is picked up without a restart.
 *
 * Probes are kept per database. Pass `scope` when the process serves several
 * databases through one knex (cloud mode: the tenant id); otherwise the knex
 * client's own connection config keys the probe.
 */
const MISS_TTL_MS = 60_000

interface ProbeState {
  hit: boolean
  at: number
  inflight: Promise<boolean> | null
}

const probes = new Map<string, ProbeState>()

/** server/database of a knex client's connection config — the default probe scope. */
export function databaseKey(db: Knex): string {
  try {
    const conn = (db as unknown as { client?: { config?: { connection?: unknown } } }).client
      ?.config?.connection
    if (!conn) return ''
    if (typeof conn === 'string') return conn
    const c = conn as { server?: string; host?: string; database?: string }
    return `${c.server ?? c.host ?? ''}/${c.database ?? ''}`
  } catch {
    return ''
  }
}

export async function hasColumn(
  db: Knex,
  table: string,
  column: string,
  opts: { scope?: string } = {}
): Promise<boolean> {
  const key = `${opts.scope ?? databaseKey(db)}\u0000${table}\u0000${column}`
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

/** Test-only: forget every probed result so the next call re-checks. */
export function resetColumnProbes(): void {
  probes.clear()
}
