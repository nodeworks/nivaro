/**
 * Whether this shared deployment runs flow script steps at all: an OPERATOR OPT-IN, off by default
 * (FLOW_SCRIPTS_ON_SHARED=on). The child sandbox (flow-script-isolated.ts) cannot have the network
 * blocked in JavaScript only — nothing in the operating system stops a script that breaks out of
 * the sandbox (Node 25's `--allow-net` adds a check inside Node, still not an OS boundary) — so
 * only an operator who trusts every app on the deployment turns it on. The Hub sets it from the deployment's settings
 * (Docker) or the operator sets it (registered); the deployment reports it on its link status.
 * Read only on a multi-tenant process; a dedicated app runs its scripts whatever it says.
 */
export function flowScriptsOnShared(): boolean {
  const v = (process.env.FLOW_SCRIPTS_ON_SHARED ?? '').trim().toLowerCase()
  return v === 'on' || v === 'true' || v === '1'
}

/**
 * Limits of flow script steps (flow-script-isolated.ts) on every deployment, read from the
 * environment of the process — never from an app. Plain numbers, clamped:
 *
 *   FLOW_SCRIPT_CONCURRENCY  script steps at once on one process (default 4 on a shared
 *                            deployment, 2 on a dedicated app; 1–32)
 *   FLOW_SCRIPT_PER_APP      shared deployment: of those, for one app (default 2, ≤ the process cap)
 *   FLOW_SCRIPT_MEMORY_MB    shared deployment: heap of one step's child (default 64, 16–1024)
 *   FLOW_SCRIPT_MAX_MB       dedicated app: heap of one step's child (default 256, 64–2048)
 *   FLOW_SCRIPT_MAX_WAIT_MS  shared deployment: how long a step waits for a slot or memory before it
 *                            is refused (default 30 s). A dedicated app's step waits up to 10 min;
 *                            a step of a flow that runs before a record is saved waits at most 10 s
 *                            on either (flow-script-isolated.ts BLOCKING_WAIT_MS).
 */

function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const v = Number(raw)
  return Number.isFinite(v) && v >= min ? Math.min(Math.floor(v), max) : fallback
}

export interface ScriptLimits {
  total: number
  perApp: number
  /** The child's V8 heap cap (MB) for this kind of deployment. */
  memoryMb: number
  maxWaitMs: number
}

export function scriptLimits(dedicated = false): ScriptLimits {
  const total = envInt(process.env.FLOW_SCRIPT_CONCURRENCY, dedicated ? 2 : 4, 1, 32)
  return {
    total,
    perApp: dedicated ? total : Math.min(envInt(process.env.FLOW_SCRIPT_PER_APP, 2, 1, 32), total),
    memoryMb: dedicated
      ? envInt(process.env.FLOW_SCRIPT_MAX_MB, 256, 64, 2048)
      : envInt(process.env.FLOW_SCRIPT_MEMORY_MB, 64, 16, 1024),
    maxWaitMs: envInt(process.env.FLOW_SCRIPT_MAX_WAIT_MS, 30_000, 0, 600_000)
  }
}
