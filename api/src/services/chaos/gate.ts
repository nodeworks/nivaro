/**
 * The chaos gate (#2827) — the ONE answer to "may a fault run in this process". Every chaos
 * route, the socket drills (#2463) and the HTTP drills (#333) ask it; the console shows the
 * reason instead of a 404.
 *
 *   - cloud mode (CLOUD_META_DB_URL set): never — faults are instance-wide and tenants share
 *     a process
 *   - NODE_ENV=production: only when CHAOS_ENABLED=true was set on purpose
 *   - anywhere else (dev, staging, test): allowed
 */

/** Why chaos may not run here, or null when it may (pure). */
export function chaosRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLOUD_META_DB_URL) return 'Chaos drills never run in cloud mode'
  if (env.NODE_ENV === 'production' && env.CHAOS_ENABLED !== 'true')
    return 'Chaos drills are refused in production unless CHAOS_ENABLED=true'
  return null
}

export function chaosAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return chaosRefusal(env) == null
}

/** A refusal or a bad request from the chaos services; routes answer its status code. */
export class ChaosError extends Error {
  statusCode: number
  code: string
  details?: unknown
  constructor(message: string, statusCode = 400, code = 'CHAOS_REFUSED', details?: unknown) {
    super(message)
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

/** Throws the gate's refusal as a 403. */
export function assertChaosAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const why = chaosRefusal(env)
  if (why) throw new ChaosError(why, 403, 'CHAOS_GATE')
}
