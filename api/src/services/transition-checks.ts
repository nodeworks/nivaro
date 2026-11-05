import { db } from '../db/index.js'
import { tenantState } from './ai-tenant-state.js'
import type { TransitionRefusal } from './manual-transition-gate.js'

/**
 * Extension veto over manual transitions (`ctx.transitions.registerCheck`).
 * Every manual path (record panel, branch, bulk, schema-builder mutation,
 * GraphQL) asks `registeredTransitionRefusal` right after the admin-only gate.
 * Engine-driven (automatic) transitions never come through here.
 */

export interface TransitionCheckArgs {
  collection: string
  item: string
  transitionId: string
  /** State KEY the record is leaving (null when unknown). */
  fromState: string | null
  /** State KEY the move is heading to (null when unknown or branch-resolved). */
  toState: string | null
  user: { id?: string; role?: string | null } | undefined
  isAdmin: boolean
}

export interface TransitionCheckRefusal {
  status: number
  error: string
  code: string
}

export type TransitionCheck = (args: TransitionCheckArgs) => Promise<TransitionCheckRefusal | null>

// Map keeps registration order; re-setting an existing owner keeps its slot but replaces the fn.
const checks = new Map<string, TransitionCheck>()

export function registerTransitionCheck(owner: string, fn: TransitionCheck): void {
  checks.set(owner, fn)
}

export function clearTransitionChecks(): void {
  checks.clear()
  keyCache().clear()
}

const KEY_TTL_MS = 60_000
const keyCache = tenantState(() => new Map<string, { key: string; at: number }>())

/** State id → state key, cached 60 s. An id with no row gives null (and is not cached). */
async function stateKeyOf(id: string | null | undefined): Promise<string | null> {
  if (id === null || id === undefined || id === '') return null
  const cache = keyCache()
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.key
  const row = (await db('nivaro_workflow_states').where({ id }).first('key')) as
    | { key?: string | null }
    | undefined
  if (!row?.key) return null
  const key = String(row.key)
  cache.set(id, { key, at: Date.now() })
  return key
}

/**
 * Run the registered checks. `fromState` / `toState` are state IDS (what the
 * transition and instance rows hold); the checks receive their KEYS. No checks
 * registered = no database read.
 */
export async function registeredTransitionRefusal(
  args: Omit<TransitionCheckArgs, 'fromState' | 'toState'> & {
    fromState: string | null
    toState: string | null
  }
): Promise<TransitionRefusal | null> {
  if (checks.size === 0) return null
  let full: TransitionCheckArgs
  try {
    full = {
      ...args,
      fromState: await stateKeyOf(args.fromState),
      toState: await stateKeyOf(args.toState)
    }
  } catch (err) {
    console.warn(
      `[transition-checks] state lookup failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return {
      status: 503,
      body: { error: 'A transition check failed — try again', code: 'TRANSITION_CHECK_FAILED' }
    }
  }
  for (const [owner, fn] of checks) {
    try {
      const r = await fn(full)
      if (r) return { status: r.status, body: { error: r.error, code: r.code } }
    } catch (err) {
      console.warn(
        `[transition-checks] check from "${owner}" threw: ${err instanceof Error ? err.message : String(err)}`
      )
      return {
        status: 503,
        body: {
          error: 'A transition check failed — try again',
          code: 'TRANSITION_CHECK_FAILED'
        }
      }
    }
  }
  return null
}
