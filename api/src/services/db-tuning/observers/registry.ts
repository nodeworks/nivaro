import type { TuningObserverDef } from '@nivaro/extension-kit'
import { type Candidate, KIND_RISK, TUNING_KINDS } from '../types.js'

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

const isSpec = (v: unknown): boolean =>
  !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'

/** Enough shape to fingerprint, prove and store; anything else is dropped. */
function wellFormed(c: unknown): c is Candidate {
  const x = c as Partial<Candidate> | null
  return (
    !!x &&
    typeof x.target === 'string' &&
    typeof x.change_key === 'string' &&
    typeof x.title === 'string' &&
    Number.isFinite(x.estimate_ms_per_day) &&
    isSpec(x.apply) &&
    isSpec(x.undo)
  )
}

export async function runExtensionObservers(): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const { def } of registry.values()) {
    try {
      const cands = await def.observe()
      for (const c of Array.isArray(cands) ? cands : []) {
        if (!wellFormed(c)) continue
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
