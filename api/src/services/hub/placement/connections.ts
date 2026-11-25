import { type ConnMath, connectionMath } from '../scale/connections.js'
import { processCount } from '../scale/shape.js'
import { environmentTarget, otherLoads, type ScaleTarget } from '../scale/target.js'

/**
 * Hub placement (idea 48): the database connections a move between two Docker stacks needs.
 *
 * While such a move runs, BOTH stacks of the environment are up (the new one is deployed and held
 * in maintenance while the old one still serves, or the other way round at release), and each
 * opens its own pools on the same database. The figure is the scaling tab's own math
 * (scale/connections.ts, scale/target.ts): processes × (main + background pool + the health
 * probe), with every OTHER Hub stack on that server counted as the scaling plan counts it. The
 * new stack runs the environment's own stack settings and kept shape, so it opens what the old
 * one opens: the move asks for twice the stack's connections for its length.
 *
 * Answers `refusal` (DB_CONNECTIONS) when the two together pass the server's `max_connections`,
 * `warning` (DB_LIMIT_UNKNOWN) when the limit or the database record is not known, else nulls.
 * Reads only; the agent is asked for its health once (the size template depends on its version).
 */

export interface OverlapDeps {
  target?: (envId: number) => Promise<ScaleTarget | null>
  others?: typeof otherLoads
}

/** The pure part: the math for a stack running twice. */
export function overlapMath(t: ScaleTarget, others: number): ConnMath {
  const procs = Math.max(1, processCount(t.roles))
  return connectionMath({
    kind: 'environment',
    processes: { from: procs, to: procs * 2 },
    pools: t.pools ?? { main: 60, background: 10 },
    server: t.server ? { ...t.server, others } : null
  })
}

export async function overlapConnections(
  envId: number,
  deps: OverlapDeps = {}
): Promise<{ refusal: string | null; warning: string | null }> {
  const t = await (deps.target ?? environmentTarget)(envId)
  if (!t) return { refusal: null, warning: null }
  const serverId = t.server?.id
  const loads =
    serverId != null
      ? await (deps.others ?? otherLoads)([serverId], { kind: 'environment', id: envId })
      : new Map<number, number>()
  const math = overlapMath(t, serverId != null ? (loads.get(serverId) ?? 0) : 0)
  const lead = `While the move runs, both stacks are up (${math.total.from} connections each): `
  const refusal = math.refusals[0]?.text ?? null
  if (refusal) return { refusal: lead + refusal, warning: null }
  if (math.limit_unknown)
    return {
      refusal: null,
      warning: `${lead}${
        t.server
          ? `${t.server.name} has no connection limit on record, so the Hub cannot check ${math.total.to} connections against it. Set the limit under Database server limits on the Scaling tab.`
          : 'the Hub has no record of this environment’s database server, so it cannot check them against a limit.'
      }`
    }
  return { refusal: null, warning: null }
}
