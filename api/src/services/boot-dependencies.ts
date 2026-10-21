/**
 * Boot waits for its dependencies instead of exiting on the first refusal.
 *
 * After a host reboot (IT patching) the API, the database server and Redis come
 * back in no particular order. Exiting at once on an unreachable database made
 * the container a tight crash loop, and the orchestrator gave up after its
 * restart budget (Swarm max_attempts) — the stack stayed down until someone
 * forced it. Instead, boot probes the database and Redis with backoff for up to
 * BOOT_DEPS_WAIT_MS (default 2 minutes, under the production health check's
 * start period), then exits non-zero so the orchestrator restarts it cleanly.
 * BOOT_DEPS_WAIT_MS=0 turns the wait off (old behaviour: fail on first use).
 */

export interface DependencyProbe {
  name: string
  /** Resolves when the dependency answers; rejects with the reason otherwise. */
  check: () => Promise<void>
}

export interface WaitOptions {
  budgetMs: number
  log: (msg: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 1 s, 2 s, 4 s … capped at 15 s. */
export function backoffMs(attempt: number): number {
  return Math.min(15_000, 1_000 * 2 ** Math.max(0, attempt - 1))
}

/**
 * Probe every dependency until all answer or the budget runs out. Returns the
 * names still failing (empty = all up). Never throws.
 */
export async function waitForDependencies(
  probes: DependencyProbe[],
  { budgetMs, log, sleep = defaultSleep, now = Date.now }: WaitOptions
): Promise<string[]> {
  const began = now()
  let pending = probes
  for (let attempt = 1; ; attempt++) {
    const results = await Promise.all(
      pending.map(async (p) => {
        try {
          await p.check()
          return { p, err: null as string | null }
        } catch (e) {
          return { p, err: e instanceof Error ? e.message : String(e) }
        }
      })
    )
    const failing = results.filter((r) => r.err !== null)
    if (failing.length === 0) {
      if (attempt > 1)
        log(`Boot dependencies: all reachable after ${Math.round((now() - began) / 1000)} s`)
      return []
    }
    const elapsed = now() - began
    const wait = backoffMs(attempt)
    if (elapsed + wait > budgetMs) {
      for (const f of failing) log(`Boot dependencies: ${f.p.name} still unreachable — ${f.err}`)
      return failing.map((f) => f.p.name)
    }
    for (const f of failing)
      log(`Boot dependencies: waiting for ${f.p.name} (${f.err}); retry in ${wait / 1000} s`)
    pending = failing.map((f) => f.p)
    await sleep(wait)
  }
}

/** Budget from BOOT_DEPS_WAIT_MS (default 120 000; 0 = no wait). */
export function bootDepsBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BOOT_DEPS_WAIT_MS
  if (raw === undefined || raw === '') return 120_000
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 120_000
}

/** The real probes: one `select 1` on the main pool, one PING on a throwaway Redis client. */
export async function bootDependencyProbes(redisUrl: string): Promise<DependencyProbe[]> {
  const { db } = await import('../db/index.js')
  const { Redis } = await import('ioredis')
  return [
    { name: 'database', check: async () => void (await db.raw('select 1')) },
    {
      name: 'redis',
      check: async () => {
        const client = new Redis(redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 0,
          retryStrategy: () => null,
          connectTimeout: 5_000
        })
        // connect() rejects with a bare "Connection is closed."; the socket error says why.
        let cause: Error | null = null
        client.on('error', (e: Error) => {
          cause = e
        })
        try {
          await client.connect()
          await client.ping()
        } catch (e) {
          throw cause ?? e
        } finally {
          client.disconnect()
        }
      }
    }
  ]
}
