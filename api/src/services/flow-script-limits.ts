/**
 * Whether this shared deployment runs flow script steps at all: an OPERATOR OPT-IN, off by default
 * (FLOW_SCRIPTS_ON_SHARED=on). The child sandbox (flow-script-isolated.ts) cannot have the network
 * cut by the operating system on Node 22 (no `--allow-net` before Node 25), so only an operator who
 * trusts every app on the deployment turns it on. The Hub sets it from the deployment's settings
 * (Docker) or the operator sets it (registered); the deployment reports it on its link status.
 * Read only on a multi-tenant process; a dedicated app runs its scripts whatever it says.
 */
export function flowScriptsOnShared(): boolean {
  const v = (process.env.FLOW_SCRIPTS_ON_SHARED ?? '').trim().toLowerCase()
  return v === 'on' || v === 'true' || v === '1'
}

/**
 * Limits of flow script steps on a Hub shared deployment (flow-script-isolated.ts), read from the
 * environment of the deployment — never from an app. Plain numbers, clamped:
 *
 *   FLOW_SCRIPT_CONCURRENCY  script steps at once on one process (default 4, 1–32)
 *   FLOW_SCRIPT_PER_APP      of those, for one app (default 2, at most the process cap)
 *   FLOW_SCRIPT_MEMORY_MB    heap of one step's child process (default 64, 16–1024)
 *   FLOW_SCRIPT_MAX_WAIT_MS  how long a step waits for a slot before it is refused (default 30 s)
 */

function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const v = Number(raw)
  return Number.isFinite(v) && v >= min ? Math.min(Math.floor(v), max) : fallback
}

export interface ScriptLimits {
  total: number
  perApp: number
  memoryMb: number
  maxWaitMs: number
}

export function scriptLimits(): ScriptLimits {
  const total = envInt(process.env.FLOW_SCRIPT_CONCURRENCY, 4, 1, 32)
  return {
    total,
    perApp: Math.min(envInt(process.env.FLOW_SCRIPT_PER_APP, 2, 1, 32), total),
    memoryMb: envInt(process.env.FLOW_SCRIPT_MEMORY_MB, 64, 16, 1024),
    maxWaitMs: envInt(process.env.FLOW_SCRIPT_MAX_WAIT_MS, 30_000, 0, 600_000)
  }
}
