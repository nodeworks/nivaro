import {
  clampSeconds,
  type FaultDefinition,
  type FaultParams,
  type FaultTarget,
  validateParams,
  validateTarget
} from './catalog.js'
import { ChaosError } from './gate.js'
import { CHAOS_NODE } from './registry.js'
import { type ChaosEnvCaps, capsFor, getChaosSettings } from './settings.js'

/**
 * Blast-radius caps (#2862), enforced on the server inside the run start path (drill.ts
 * `startDrill`) whatever the builder, a game day, the monkey or a script sends. Numbers are
 * clamped down to the cap and the clamp is recorded on the run (`meta.caps`); what cannot be
 * clamped is refused with 403 `CHAOS_CAP` naming the cap.
 *
 *  - `allowed_faults`: a fault off the list is refused.
 *  - `max_replicas`: a fault reaching every replica of a bigger cluster is narrowed to this
 *    replica when it can target one, else refused.
 *  - `max_share_pct`: a share target is clamped; an "everything" target becomes that share when
 *    the fault can target a share. A fault that cannot be split (no share target) is governed by
 *    the allowlist and the replica cap instead.
 *  - `max_latency_ms`: every number parameter measured in ms is clamped (refused when the cap is
 *    under the fault's own minimum).
 *  - `max_seconds`: the window is clamped (never under the 5 s floor).
 */

export interface CappedSpec {
  target: FaultTarget
  params: FaultParams
  seconds: number
  /** What was clamped, as short sentences naming the cap (empty = nothing changed). */
  applied: string[]
}

export function applyCaps(
  def: FaultDefinition,
  input: { target?: unknown; params?: unknown; seconds?: unknown },
  caps: ChaosEnvCaps,
  opts: { nodes: number; node?: string } = { nodes: 1 }
): CappedSpec {
  const applied: string[] = []
  if (caps.allowed_faults !== '*' && !caps.allowed_faults.includes(def.key))
    throw new ChaosError(
      `${def.label} is not on this environment's allowed faults (allowed_faults)`,
      403,
      'CHAOS_CAP',
      { cap: 'allowed_faults' }
    )

  let target = validateTarget(def, input.target)
  const reachesEveryReplica = target.kind !== 'node' && def.apply_scope !== 'origin'
  if (caps.max_replicas != null && opts.nodes > caps.max_replicas && reachesEveryReplica) {
    if (target.kind === 'all' && def.targets.includes('node')) {
      target = { kind: 'node', node: opts.node ?? CHAOS_NODE }
      applied.push(`target narrowed to this replica (max_replicas ${caps.max_replicas})`)
    } else {
      throw new ChaosError(
        `This run would reach ${opts.nodes} replicas; this environment allows ${caps.max_replicas} (max_replicas)`,
        403,
        'CHAOS_CAP',
        { cap: 'max_replicas' }
      )
    }
  }

  const share = caps.max_share_pct
  if (share != null && share < 100) {
    if (target.kind === 'share' && target.share_pct > share) {
      applied.push(`share ${target.share_pct}% → ${share}% (max_share_pct)`)
      target = { kind: 'share', share_pct: share }
    } else if (target.kind === 'all' && def.targets.includes('share')) {
      applied.push(`everything → ${share}% of traffic (max_share_pct)`)
      target = { kind: 'share', share_pct: share }
    }
  }

  const params = validateParams(def, input.params)
  if (caps.max_latency_ms != null) {
    for (const [name, spec] of Object.entries(def.params)) {
      if (spec.type !== 'number' || spec.unit !== 'ms') continue
      const v = Number(params[name])
      if (!(v > caps.max_latency_ms)) continue
      if (caps.max_latency_ms < spec.min)
        throw new ChaosError(
          `${spec.label} cannot go under ${spec.min} ms; this environment allows ${caps.max_latency_ms} ms (max_latency_ms)`,
          403,
          'CHAOS_CAP',
          { cap: 'max_latency_ms' }
        )
      params[name] = caps.max_latency_ms
      applied.push(`${spec.label} ${v} ms → ${caps.max_latency_ms} ms (max_latency_ms)`)
    }
  }

  let seconds = clampSeconds(def, input.seconds)
  if (caps.max_seconds != null && seconds > caps.max_seconds) {
    const next = Math.max(5, caps.max_seconds)
    applied.push(`${seconds}s → ${next}s (max_seconds)`)
    seconds = next
  }
  return { target, params, seconds, applied }
}

async function replicaCount(): Promise<number> {
  try {
    const { listInstances } = await import('../instance-roster.js')
    const n = (await listInstances()).filter((r) => r.id).length
    return Math.max(1, n)
  } catch {
    return 1
  }
}

/** The caps of this instance applied to a start request (drill.ts calls this before arming). */
export async function enforceChaosCaps(
  def: FaultDefinition,
  input: { target?: unknown; params?: unknown; seconds?: unknown }
): Promise<CappedSpec> {
  const caps = capsFor(await getChaosSettings())
  return applyCaps(def, input, caps, { nodes: await replicaCount() })
}
