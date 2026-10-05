import type { TuningObserverDef } from '@nivaro/extension-kit'
import { OBSERVER_TIMEOUT_MS, withTimeout } from '../deadline.js'
import {
  type ApplySpec,
  type Candidate,
  KIND_RISK,
  TUNING_KINDS,
  type TuningKind
} from '../types.js'

/**
 * Observers extensions contribute through `ctx.tuning.registerObserver` (#996). Their
 * candidates go through the same proof and ledger as core's: the kind and its risk are the
 * registration's, never the candidate's, and nothing an extension returns can mark a
 * candidate proven or apply it.
 */

const registry = new Map<string, { def: TuningObserverDef; owner: string }>()

export function registerTuningObserver(def: TuningObserverDef, owner: string): void {
  if (!def?.id || !/^[a-z0-9-]+:[a-z0-9-]+$/i.test(def.id))
    throw new Error(`tuning observer id must be <owner>:<name>: ${def?.id}`)
  if (typeof def.observe !== 'function')
    throw new Error(`tuning observer ${def.id} has no observe()`)
  if (!(TUNING_KINDS as readonly string[]).includes(def.kind))
    throw new Error(`tuning observer ${def.id} has an unknown kind: ${def.kind}`)
  registry.set(def.id, { def, owner })
}

export function listTuningObservers(): Array<{ id: string; owner: string; kind: string }> {
  return [...registry.values()].map((r) => ({ id: r.def.id, owner: r.owner, kind: r.def.kind }))
}

/** Tests only. */
export function unregisterTuningObservers(): void {
  registry.clear()
}

/** The only change shape each kind may carry — an index candidate never ships a proc body. */
export const SPEC_FOR_KIND: Record<TuningKind, ApplySpec['type']> = {
  index_create: 'sql',
  index_drop: 'sql',
  proc_rewrite: 'proc_body',
  rollup_store: 'field_patch',
  query_cache: 'query_patch'
}

const isSpec = (v: unknown, type: ApplySpec['type']): boolean =>
  !!v && typeof v === 'object' && (v as { type?: unknown }).type === type

/** Enough shape to fingerprint, prove and store, with apply/undo of the kind's type. */
function wellFormed(c: unknown, kind: TuningKind): c is Candidate {
  const x = c as Partial<Candidate> | null
  return (
    !!x &&
    typeof x.target === 'string' &&
    typeof x.change_key === 'string' &&
    typeof x.title === 'string' &&
    Number.isFinite(x.estimate_ms_per_day) &&
    isSpec(x.apply, SPEC_FOR_KIND[kind]) &&
    isSpec(x.undo, SPEC_FOR_KIND[kind])
  )
}

/** Each observer gets `timeoutMs()` at its start (the run passes what its wall budget leaves). */
export async function runExtensionObservers(
  timeoutMs: () => number = () => OBSERVER_TIMEOUT_MS
): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const { def } of registry.values()) {
    const ms = timeoutMs()
    if (ms <= 0) {
      console.warn(`[db-tuning] observer ${def.id} skipped: the run's time budget is spent`)
      continue
    }
    try {
      const cands = await withTimeout(def.observe(), ms, `observer ${def.id}`)
      for (const c of Array.isArray(cands) ? cands : []) {
        if (!wellFormed(c, def.kind)) {
          console.warn(`[db-tuning] observer ${def.id}: a malformed candidate was dropped`)
          continue
        }
        out.push({
          ...c,
          kind: def.kind,
          risk: KIND_RISK[def.kind],
          evidence: { ...(c.evidence ?? {}), observer: def.id }
        })
      }
    } catch (err) {
      console.warn(
        `[db-tuning] observer ${def.id} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return out
}
