// api/src/services/traffic-source.ts
/**
 * Traffic Map source attribution (#1105 / #1106 / #1143): which non-request source — a cron job,
 * a flow run, the staged-import worker — the current async work belongs to.
 *
 * Its own AsyncLocalStorage, deliberately apart from the request trace (that context is the
 * request's SQL and timings) and the integration chain (its `parent` moves with every nested step,
 * so the root that started the work is gone by the time a write lands). The Traffic Map reads
 * `currentTrafficSource()` when a write or partner call happens: a source wins over the request
 * behind it, so a flow fired inside a request reads "flow → collection", not "person →
 * collection".
 *
 * Cost: one ALS frame per run (never per write); nothing here touches the database.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type TrafficSourceKind = 'cron' | 'flow' | 'import' | 'socket'

export interface TrafficSource {
  /** Callers-ring key: `cron:<job>`, `flow:<id>`, `import:worker`. Always contains a colon. */
  id: string
  label: string
  kind: TrafficSourceKind
  /** What set it off, for the map's trigger edge (`items/<collection>`, `cron:<job>`, `schedule`…). */
  trigger?: string | null
}

const als = new AsyncLocalStorage<TrafficSource>()

export function currentTrafficSource(): TrafficSource | null {
  return als.getStore() ?? null
}

/** Run `fn` attributed to `source`. A nested source (a flow a cron job starts) replaces it. */
export function withTrafficSource<T>(source: TrafficSource, fn: () => T): T {
  return als.run(source, fn)
}

type RunListener = (source: TrafficSource, ok: boolean, ms: number, at: number) => void
const runListeners: RunListener[] = []

/** The Traffic Map's source tap listens here for run outcomes (one listener per id). */
export function onTrafficSourceRun(fn: RunListener): void {
  if (!runListeners.includes(fn)) runListeners.push(fn)
}

/** Tell the listeners a run finished (flows call this themselves: a failed flow does not throw). */
export function noteTrafficSourceRun(source: TrafficSource, ok: boolean, ms: number): void {
  const at = Date.now()
  for (const l of runListeners) {
    try {
      l(source, ok, ms, at)
    } catch {
      /* a listener must never affect the run */
    }
  }
}

/**
 * Run an async job as a source and record its outcome (a throw = failed, rethrown). The cron
 * manager and the import worker wrap their runs with it.
 */
export async function runAsTrafficSource<T>(
  source: TrafficSource,
  fn: () => Promise<T> | T
): Promise<T> {
  const started = Date.now()
  try {
    const v = await withTrafficSource(source, fn)
    noteTrafficSourceRun(source, true, Date.now() - started)
    return v
  } catch (err) {
    noteTrafficSourceRun(source, false, Date.now() - started)
    throw err
  }
}
