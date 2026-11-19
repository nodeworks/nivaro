// api/src/services/pool-holder-context.ts
/**
 * Who is borrowing a database connection (#pool-holders): captured once per pool acquire by
 * services/pool-attribution.ts and read only when an admin opens Database → Connections.
 *
 * The capture is the hot path, so it does no I/O and no string work: three AsyncLocalStorage
 * lookups (the request trace, the Traffic Map source — cron job, flow, import worker — and an
 * explicit feature label) plus "inside a read-gate slot", into one small object. Everything a
 * person reads (route template, caller, names) is derived later from those references.
 *
 * `withPoolFeature(label, fn)` names work that has neither a request nor a source (a warm, an
 * export run): every connection it borrows reads as that feature.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { holdsReadSlot } from './read-gate.js'
import { currentTraceHandle } from './request-trace.js'
import { currentTrafficSource, type TrafficSource } from './traffic-source.js'

export interface HolderCtx {
  /** The request trace context (opaque; read through traceHandleFacts). */
  trace: object | undefined
  /** Cron job / flow / import worker the work belongs to. */
  source: TrafficSource | undefined
  /** An explicit feature label (withPoolFeature). */
  feature: string | undefined
  /** Borrowed inside a held read-gate slot (a gated heavy read). */
  gate: boolean
}

const featureStore = new AsyncLocalStorage<string>()

/** Run `fn` with every connection it borrows attributed to `label` (≤ 80 chars). */
export function withPoolFeature<T>(label: string, fn: () => T): T {
  return featureStore.run(String(label).slice(0, 80), fn)
}

/** The current async context's holder facts. Never throws. */
export function captureHolder(): HolderCtx {
  try {
    return {
      trace: currentTraceHandle(),
      source: currentTrafficSource() ?? undefined,
      feature: featureStore.getStore(),
      gate: holdsReadSlot()
    }
  } catch {
    return { trace: undefined, source: undefined, feature: undefined, gate: false }
  }
}
