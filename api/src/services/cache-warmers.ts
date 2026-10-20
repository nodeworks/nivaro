/**
 * Extension cache warmers (#2445 follow-up): `ctx.cache.registerWarm(name, fn,
 * {budgetMs})`. The usage-ranked cache warm (boot once per cluster per
 * version, 06:30 weekdays) calls every registered warmer AFTER the core
 * queries, inside the same overall budget and the same heavy-job slot.
 *
 * Each warmer runs holding ONE heavy-read slot (gated reads it makes run
 * straight through, re-entrant), with its own timeout = min(budgetMs, what is
 * left of the run's budget). On timeout its AbortSignal fires and the run
 * moves on — the promise is abandoned, never awaited further, so a warmer
 * that ignores the signal cannot hold the warm up (its statement still needs
 * its own timeout: use `ctx.sql.runLong(sql, {timeoutMs})`). Errors are
 * logged, never thrown. Warmers must be READ-ONLY: the warm never runs
 * anything that can write; an extension's warmer is held to the same rule by
 * contract (it is the extension's own expensive read, run early).
 *
 * Leaf-ish: the registry imports nothing of the app; the gate is injected.
 */

export interface CacheWarmContext {
  /** Fires when this warmer's time is up. */
  signal: AbortSignal
  /** Milliseconds this warmer may take. */
  budgetMs: number
}

export type CacheWarmFn = (ctx: CacheWarmContext) => Promise<unknown> | unknown

export interface CacheWarmerDef {
  /** `<extension>:<name>`. */
  id: string
  extension: string
  fn: CacheWarmFn
  budgetMs?: number
}

/** One warmer's default timeout. */
export const CACHE_WARMER_DEFAULT_MS = 60_000

const warmers = new Map<string, CacheWarmerDef>()

/** Register (or replace, on a reload) one warmer. Throws on a malformed call — the loader catches. */
export function registerCacheWarmer(
  extension: string,
  name: string,
  fn: CacheWarmFn,
  opts: { budgetMs?: number } = {}
): string {
  if (typeof name !== 'string' || !/^[\w.:-]{1,80}$/.test(name))
    throw new Error('cache warmer name must be 1-80 characters of letters, digits, . : _ -')
  if (typeof fn !== 'function') throw new Error('cache warmer must be a function')
  const budget = opts?.budgetMs
  if (budget != null && !(Number.isFinite(budget) && budget > 0))
    throw new Error('cache warmer budgetMs must be a positive number')
  const id = `${extension}:${name}`
  warmers.set(id, { id, extension, fn, budgetMs: budget ?? undefined })
  return id
}

export function listCacheWarmers(): CacheWarmerDef[] {
  return [...warmers.values()]
}

/** Drop an extension's warmers (reload/unload) — or every one (tests). */
export function clearCacheWarmers(extension?: string): void {
  if (!extension) {
    warmers.clear()
    return
  }
  for (const [id, w] of warmers) if (w.extension === extension) warmers.delete(id)
}

export interface WarmerOutcome {
  id: string
  status: 'ok' | 'failed' | 'timeout' | 'skipped'
  ms: number
  error?: string
}

export interface RunWarmersOptions {
  deadline: number
  now?: () => number
  /** Hold a heavy-read slot around one warmer (services/read-gate withReadGate). */
  gate?: <T>(fn: () => Promise<T>) => Promise<T>
  log?: (outcome: WarmerOutcome) => void
  list?: CacheWarmerDef[]
}

/** Run every warmer in turn. Never throws. */
export async function runCacheWarmers(opts: RunWarmersOptions): Promise<WarmerOutcome[]> {
  const now = opts.now ?? Date.now
  const gate = opts.gate ?? (<T>(fn: () => Promise<T>) => fn())
  const out: WarmerOutcome[] = []
  for (const w of opts.list ?? listCacheWarmers()) {
    const started = now()
    const remaining = opts.deadline - started
    if (remaining <= 0) {
      const o: WarmerOutcome = { id: w.id, status: 'skipped', ms: 0 }
      out.push(o)
      opts.log?.(o)
      continue
    }
    const budgetMs = Math.max(1, Math.min(w.budgetMs ?? CACHE_WARMER_DEFAULT_MS, remaining))
    const ac = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ac.abort()
        resolve('timeout')
      }, budgetMs)
      timer.unref?.()
    })
    let o: WarmerOutcome
    try {
      const run = gate(async () => {
        await w.fn({ signal: ac.signal, budgetMs })
        return 'ok' as const
      })
      // An abandoned run's late rejection must not surface as unhandled.
      run.catch(() => {})
      const res = await Promise.race([run, timedOut])
      o = { id: w.id, status: res, ms: now() - started }
    } catch (err) {
      o = {
        id: w.id,
        status: 'failed',
        ms: now() - started,
        error: String((err as Error)?.message ?? err).slice(0, 300)
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
    out.push(o)
    opts.log?.(o)
  }
  return out
}
