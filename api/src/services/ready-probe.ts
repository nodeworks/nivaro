/**
 * GET /api/ready (#1081) — "may the proxy send this process traffic now?"
 *
 * Different from the other probes on purpose:
 *   /version   — the process is alive (the container health check). No I/O.
 *   /health    — reports latency as 'degraded'. Wrong for routing: a slow
 *                database is not a reason to pull every replica at once.
 *   /preflight — admin-only deploy coherence, with warnings.
 *   /ready     — boot finished, nothing pending, dependencies answer within a
 *                bound. Never 'degraded': it is ready or it is not. The proxy
 *                health check and the deploy gate read it.
 *
 * A process that is shutting down answers 503 at once, so the proxy stops
 * routing to it while in-flight requests drain.
 */

export interface ReadyCheck {
  id: 'boot' | 'migrations' | 'extensions' | 'database' | 'redis'
  ok: boolean
  ms?: number
  summary: string
}

export interface ReadyReport {
  ready: boolean
  checks: ReadyCheck[]
}

export const REDIS_BUDGET_MS = 500
export const DB_BUDGET_MS = 2_000

/** Resolve `work` within `ms`, else reject with a timeout. */
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms)
    t.unref?.()
    work.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/** Time one dependency answer against its budget. */
export async function timedCheck(
  id: 'database' | 'redis',
  label: string,
  budgetMs: number,
  work: () => Promise<unknown>
): Promise<ReadyCheck> {
  const began = Date.now()
  try {
    await within(work(), budgetMs)
    const ms = Date.now() - began
    return { id, ok: true, ms, summary: `${label} answered in ${ms}ms.` }
  } catch (err) {
    const ms = Date.now() - began
    const why = err instanceof Error ? err.message : String(err)
    return { id, ok: false, ms, summary: `${label} did not answer (${why}).` }
  }
}

export function judgeReady(checks: ReadyCheck[]): ReadyReport {
  return { ready: checks.every((c) => c.ok), checks }
}
