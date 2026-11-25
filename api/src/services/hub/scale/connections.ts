/**
 * Nivaro Hub scaling: the database connection math a scale plan shows and judges. Pure.
 *
 * Every Nivaro process opens its own pools, so connections grow with processes:
 *   - a dedicated stack: per process DB_POOL_MAX (main pool, default 60) + DB_POOL_BACKGROUND_MAX
 *     (background pool, default 10; 0 = it shares the main pool) — the stack's settings, else the
 *     defaults the API boots with (config.ts);
 *   - a shared deployment: per process, one pool per app of `pool_max` (the placement's, default
 *     5). The deployment's pool budget caps that sum for ONE process (place.ts checks it when an
 *     app is placed); scaling multiplies it by the processes.
 * The total lands on each app's database server. With the server's `max_connections` known
 * (nivaro_hub_db_servers, set by the operator), every other Hub stack whose database lives there
 * is counted too (its processes × its pools) and a plan whose total would pass the limit is
 * refused (DB_CONNECTIONS) — unless the change lowers the connections (a scale-in always passes).
 * An unknown limit, or a database the Hub has no record of, only warns: nothing to judge by.
 */

export const DEDICATED_MAIN_POOL = 60
export const DEDICATED_BACKGROUND_POOL = 10

export interface ServerLoad {
  id: number
  name: string
  /** null = the operator has not set it. */
  max_connections: number | null
  /** Connections every OTHER Hub stack on this server may open now. */
  others: number
}

export interface DedicatedPools {
  main: number
  background: number
}

export interface SharedAppPool {
  env_id: number
  label: string
  pool_max: number
  server: ServerLoad | null
}

export type ConnInput =
  | {
      kind: 'environment'
      processes: { from: number; to: number }
      pools: DedicatedPools
      server: ServerLoad | null
    }
  | {
      kind: 'shared'
      processes: { from: number; to: number }
      budget: number
      apps: SharedAppPool[]
    }

export interface ServerMath {
  id: number
  name: string
  max_connections: number | null
  others: number
  /** This stack's connections there, before and after. */
  from: number
  to: number
  /** others + to. */
  after: number
  /** null = no limit set (not judged). */
  fits: boolean | null
}

export interface ConnMath {
  kind: 'environment' | 'shared'
  processes: { from: number; to: number }
  /** Connections one process may open (dedicated: main + background; shared: Σ pool_max). */
  per_process: number
  /** Dedicated only. */
  pools?: DedicatedPools
  /** Shared only: the pool budget of one process and what the apps take of it. */
  budget?: { per_process: number; used: number }
  total: { from: number; to: number }
  servers: ServerMath[]
  /** Databases the Hub has no server record for (shared: app labels; dedicated: 1 entry). */
  unknown: string[]
  refusals: { code: 'DB_CONNECTIONS'; text: string }[]
  warnings: { code: string; text: string }[]
}

function judge(
  s: ServerLoad,
  from: number,
  to: number
): { row: ServerMath; refusal: string | null; warning: string | null } {
  const after = s.others + to
  const max = s.max_connections
  const fits = max == null ? null : after <= max
  const row: ServerMath = {
    id: s.id,
    name: s.name,
    max_connections: max,
    others: s.others,
    from,
    to,
    after,
    fits
  }
  if (max == null)
    return {
      row,
      refusal: null,
      warning: `${s.name} has no connection limit on record: set it on the Databases tab to have the Hub check ${to} connections against it.`
    }
  // A change that lowers this stack's connections is never refused, even on a crowded server.
  if (!fits && to > from)
    return {
      row,
      refusal: `${s.name} allows ${max} connections; this change takes ${to} there (from ${from}) and the other Hub stacks on it ${s.others}: ${after} in all.`,
      warning: null
    }
  if (!fits)
    return {
      row,
      refusal: null,
      warning: `${s.name} is over its limit (${after} of ${max}); this change lowers it.`
    }
  return { row, refusal: null, warning: null }
}

export function connectionMath(input: ConnInput): ConnMath {
  const { processes } = input
  const refusals: ConnMath['refusals'] = []
  const warnings: ConnMath['warnings'] = []
  if (input.kind === 'environment') {
    const per = input.pools.main + input.pools.background
    const total = { from: processes.from * per, to: processes.to * per }
    const servers: ServerMath[] = []
    const unknown: string[] = []
    if (input.server) {
      const j = judge(input.server, total.from, total.to)
      servers.push(j.row)
      if (j.refusal) refusals.push({ code: 'DB_CONNECTIONS', text: j.refusal })
      if (j.warning) warnings.push({ code: 'DB_LIMIT', text: j.warning })
    } else {
      unknown.push('this environment')
      warnings.push({
        code: 'DB_UNKNOWN',
        text: 'The Hub has no record of this environment’s database server, so it cannot check the connections against the server’s limit.'
      })
    }
    return {
      kind: 'environment',
      processes,
      per_process: per,
      pools: { ...input.pools },
      total,
      servers,
      unknown,
      refusals,
      warnings
    }
  }

  const used = input.apps.reduce((n, a) => n + a.pool_max, 0)
  const total = { from: processes.from * used, to: processes.to * used }
  if (used > input.budget)
    warnings.push({
      code: 'POOL_BUDGET',
      text: `The apps here take ${used} connections per process, past the deployment's budget of ${input.budget}.`
    })
  const byServer = new Map<number, { s: ServerLoad; pool: number }>()
  const unknown: string[] = []
  for (const a of input.apps) {
    if (!a.server) {
      unknown.push(a.label)
      continue
    }
    const cur = byServer.get(a.server.id)
    if (cur) cur.pool += a.pool_max
    else byServer.set(a.server.id, { s: a.server, pool: a.pool_max })
  }
  const servers: ServerMath[] = []
  for (const { s, pool } of [...byServer.values()].sort((a, b) => a.s.id - b.s.id)) {
    const j = judge(s, processes.from * pool, processes.to * pool)
    servers.push(j.row)
    if (j.refusal) refusals.push({ code: 'DB_CONNECTIONS', text: j.refusal })
    if (j.warning) warnings.push({ code: 'DB_LIMIT', text: j.warning })
  }
  if (unknown.length)
    warnings.push({
      code: 'DB_UNKNOWN',
      text: `The Hub has no database server record for ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ', …' : ''}: their connections are not checked against a limit.`
    })
  return {
    kind: 'shared',
    processes,
    per_process: used,
    budget: { per_process: input.budget, used },
    total,
    servers,
    unknown,
    refusals,
    warnings
  }
}

/** A stack setting read as a pool size (DB_POOL_MAX / DB_POOL_BACKGROUND_MAX), else the default. */
export function poolSetting(raw: unknown, dflt: number): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : dflt
}
