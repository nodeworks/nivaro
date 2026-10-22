import { db } from '../../db/index.js'
import { chaosRefusal } from './gate.js'
import { armedFaults } from './registry.js'

/**
 * Pre-flight checklist (#2848): the green ticks that gate the Run button, re-run server-side
 * inside POST /runs. Each check is {key, label, ok, why}; a failed one says why. Only the
 * working-hours check may be overridden (an admin's explicit `override.working_hours`, recorded
 * on the run). Other chaos areas add checks with `registerPreflightCheck`.
 */

export interface PreflightCheck {
  key: string
  label: string
  ok: boolean
  why: string | null
  overridable?: boolean
}

export interface PreflightContext {
  env: NodeJS.ProcessEnv
  now: Date
  override: { working_hours?: boolean } | null
}

export interface PreflightCheckDef {
  key: string
  label: string
  /** True / a reason string when it fails. */
  run: (ctx: PreflightContext) => Promise<true | string> | true | string
  /** Admins may run anyway with `override[key]`; the run records it. */
  overridable?: boolean
}

const checks = new Map<string, PreflightCheckDef>()

export function registerPreflightCheck(def: PreflightCheckDef): void {
  checks.set(def.key, def)
}

export function listPreflightChecks(): PreflightCheckDef[] {
  return [...checks.values()]
}

/** Tests only: drop every check (built-ins re-register on `registerBuiltInPreflight`). */
export function _resetPreflightForTests(): void {
  checks.clear()
  builtIns = false
}

export interface PreflightResult {
  ok: boolean
  checks: PreflightCheck[]
  /** Checks that failed but the caller overrode (recorded on the run). */
  overridden: string[]
}

export async function runPreflight(
  opts: Partial<PreflightContext> = {},
  deps: PreflightDeps = defaultDeps
): Promise<PreflightResult> {
  activeDeps = deps
  registerBuiltInPreflight()
  const ctx: PreflightContext = {
    env: opts.env ?? process.env,
    now: opts.now ?? new Date(),
    override: opts.override ?? null
  }
  const out: PreflightCheck[] = []
  const overridden: string[] = []
  let ok = true
  for (const def of checks.values()) {
    let r: true | string
    try {
      r = await Promise.race([
        Promise.resolve(def.run(ctx)),
        new Promise<string>((res) => setTimeout(() => res('the check did not answer in 4 s'), 4000))
      ])
    } catch (err) {
      r = `the check failed: ${(err as Error)?.message ?? err}`
    }
    const reason = r === true ? null : r
    const forced =
      reason != null && !!def.overridable && ctx.override?.[def.key as 'working_hours'] === true
    if (reason != null && !forced) ok = false
    if (forced) overridden.push(def.key)
    out.push({
      key: def.key,
      label: def.label,
      ok: reason == null,
      why: reason == null ? null : forced ? `${reason} — overridden` : reason,
      overridable: def.overridable
    })
  }
  return { ok, checks: out, overridden }
}

// ─── Built-ins (data sources injectable for tests) ────────────────────────────

export interface PreflightDeps {
  productionTier(): Promise<string | null>
  mixedVersions(): Promise<string[]>
  migrationLocked(): Promise<boolean>
  maintenance(): Promise<{ on: boolean; until: string | null }>
  openIncident(): Promise<string | null>
  poolHealth(): Promise<{ wait_p95_ms: number; saturated_pct: number }>
  loopLagMs(): Promise<number>
  armedCount(): number
}

const defaultDeps: PreflightDeps = {
  async productionTier() {
    // The Environments registry (#226): an environment whose name says production and one of
    // whose components answers on this instance's own host.
    try {
      const { selfOrLoopback } = await import('../environment-self.js')
      const { config } = await import('../../config.js')
      const envs = (await db('nivaro_environments').select('id', 'name')) as Array<{
        id: number
        name: string
      }>
      const prod = envs.filter((e) => /prod/i.test(String(e.name)))
      if (!prod.length) return null
      const comps = (await db('nivaro_environment_components')
        .whereIn(
          'environment',
          prod.map((e) => e.id)
        )
        .whereNotNull('base_url')
        .select('environment', 'base_url')) as Array<{ environment: number; base_url: string }>
      let host = ''
      try {
        host = new URL(config.PUBLIC_URL).host
      } catch {
        /* no host */
      }
      for (const c of comps) {
        if (selfOrLoopback(c.base_url, host) === 'self')
          return prod.find((e) => e.id === c.environment)?.name ?? 'Production'
      }
      return null
    } catch {
      return null
    }
  },
  async mixedVersions() {
    try {
      const { listInstances } = await import('../instance-roster.js')
      const versions = new Set<string>()
      for (const row of await listInstances()) if (row.version) versions.add(String(row.version))
      return [...versions]
    } catch {
      return []
    }
  },
  async migrationLocked() {
    try {
      const row = (await db('nivaro_migrations_lock').first('is_locked')) as
        | { is_locked?: number | boolean }
        | undefined
      return !!row?.is_locked
    } catch {
      return false
    }
  },
  async maintenance() {
    try {
      const { maintenanceState } = await import('../security.js')
      const m = await maintenanceState()
      return { on: !!m.on, until: m.until ?? null }
    } catch {
      return { on: false, until: null }
    }
  },
  async openIncident() {
    try {
      const { currentIncident } = await import('../ops-incidents.js')
      const inc = await currentIncident()
      return inc ? inc.title : null
    } catch {
      return null
    }
  },
  async poolHealth() {
    const { poolPressure } = await import('../pool-attribution.js')
    const p = poolPressure('main')
    return { wait_p95_ms: p.wait_p95_ms, saturated_pct: p.saturated_pct }
  },
  async loopLagMs() {
    const { runtimeStats } = await import('../runtime-monitor.js')
    return runtimeStats().event_loop_lag_ms.max_1m
  },
  armedCount: () => armedFaults().length
}

/** The data sources the built-ins read; `runPreflight` sets it per call (tests inject fakes). */
let activeDeps: PreflightDeps = defaultDeps

export const WORKING_HOURS = { tz: 'America/New_York', from: 8, to: 18 }

/** Mon–Fri 08:00–18:00 in the configured zone (pure). */
export function insideWorkingHours(now: Date, hours = WORKING_HOURS): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: hours.tz,
    weekday: 'short',
    hour: 'numeric',
    hour12: false
  }).formatToParts(now)
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? ''
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24
  if (weekday === 'Sat' || weekday === 'Sun') return false
  return hour >= hours.from && hour < hours.to
}

let builtIns = false
export function registerBuiltInPreflight(): void {
  if (builtIns) return
  builtIns = true
  const deps = new Proxy({} as PreflightDeps, {
    get: (_t, k) => activeDeps[k as keyof PreflightDeps]
  })
  registerPreflightCheck({
    key: 'gate',
    label: 'Chaos is allowed on this instance',
    run: ({ env }) => chaosRefusal(env) ?? true
  })
  registerPreflightCheck({
    key: 'tier',
    label: 'Not a production instance',
    run: async ({ env }) => {
      const tier = await deps.productionTier()
      if (tier) return `this instance is registered under "${tier}" in Environments`
      if (env.NODE_ENV === 'production' && env.CHAOS_ENABLED === 'true') return true
      return true
    }
  })
  registerPreflightCheck({
    key: 'deploy',
    label: 'No deploy or migration running',
    run: async () => {
      const versions = await deps.mixedVersions()
      if (versions.length > 1) return `two API versions are serving (${versions.join(', ')})`
      if (await deps.migrationLocked()) return 'the migration table is locked'
      return true
    }
  })
  registerPreflightCheck({
    key: 'maintenance',
    label: 'No maintenance window',
    run: async () => {
      const m = await deps.maintenance()
      return m.on ? `maintenance is on${m.until ? ` until ${m.until}` : ''}` : true
    }
  })
  registerPreflightCheck({
    key: 'incident',
    label: 'No open incident',
    run: async () => {
      const inc = await deps.openIncident()
      return inc ? `an incident is open: ${inc}` : true
    }
  })
  registerPreflightCheck({
    key: 'working_hours',
    label: `Inside working hours (Mon–Fri ${WORKING_HOURS.from}:00–${WORKING_HOURS.to}:00 Eastern)`,
    overridable: true,
    run: ({ now }) => (insideWorkingHours(now) ? true : 'outside working hours')
  })
  registerPreflightCheck({
    key: 'health',
    label: 'Main pool and event loop healthy',
    run: async () => {
      const pool = await deps.poolHealth()
      if (pool.saturated_pct >= 50)
        return `the main pool was saturated ${pool.saturated_pct}% of the last window`
      if (pool.wait_p95_ms >= 2000) return `main pool wait p95 is ${pool.wait_p95_ms} ms`
      const lag = await deps.loopLagMs()
      if (lag >= 1000) return `event-loop lag reached ${Math.round(lag)} ms in the last minute`
      return true
    }
  })
  registerPreflightCheck({
    key: 'armed',
    label: 'No other drill armed',
    run: () => {
      const n = deps.armedCount()
      return n ? `${n} fault${n === 1 ? ' is' : 's are'} armed — one drill at a time` : true
    }
  })
}
