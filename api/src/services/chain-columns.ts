import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { currentChain } from './chain.js'

/**
 * Chain column probe (migration 351). Same contract as erp-requester-columns:
 * a hit is permanent, a miss is remembered for a minute, per tenant — so a
 * database that has not run 351 keeps writing and simply stamps nothing.
 */
export type ChainTable =
  | 'nivaro_activity'
  | 'nivaro_api_logs'
  | 'nivaro_erp_submissions'
  | 'nivaro_erp_submission_attempts'
  | 'nivaro_external_api_logs'
  | 'nivaro_workflow_history'
  | 'nivaro_flow_runs'

const MISS_TTL_MS = 60_000

interface ProbeState {
  hit: boolean
  at: number
  inflight: Promise<boolean> | null
}

const probes = new Map<string, ProbeState>()

export async function hasChainColumns(table: ChainTable): Promise<boolean> {
  const key = `${getTenantId() ?? ''}\u0000${table}`
  const state = probes.get(key)
  if (state?.hit) return true
  if (state?.inflight) return state.inflight
  if (state && Date.now() - state.at < MISS_TTL_MS) return false
  const inflight = (async () => {
    try {
      return await db.schema.hasColumn(table, 'chain_id')
    } catch {
      return false
    }
  })()
  probes.set(key, { hit: false, at: state?.at ?? 0, inflight })
  const hit = await inflight
  probes.set(key, { hit, at: Date.now(), inflight: null })
  return hit
}

/** The two columns to spread into an insert, or {} (no chain / no columns). */
export async function chainFields(
  table: ChainTable,
  opts: { parent?: string | null } = {}
): Promise<Record<string, string | null>> {
  const chain = currentChain()
  if (!chain) return {}
  if (!(await hasChainColumns(table))) return {}
  const parent = opts.parent !== undefined ? opts.parent : chain.parent
  return { chain_id: chain.chain_id, chain_parent: parent ? parent.slice(0, 120) : null }
}

export function resetChainColumnProbe(): void {
  probes.clear()
}
