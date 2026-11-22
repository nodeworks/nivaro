import { getDriver, STACK_NAME_RE } from '../drivers.js'
import { agentStack } from './agent-client.js'
import type { StackState } from './agent-types.js'

/**
 * Healing a promotion whose docker step was running when its process went away (Hub phase 4).
 * Phase 2's heal deletes temporary GitLab branches; a docker step has none, and nothing on the
 * Docker host is ever deleted, stopped or re-applied by a heal. The only call is a READ of the
 * stack's status through the Hub agent, so the interrupted row can say where swarm stands — the
 * next plan reads the live stack anyway. Never through driverCtx (it refuses docker rows).
 */

/** Reads a stack's state through the agent; null = no such stack. */
export type StackStateReader = (driverId: number, name: string) => Promise<StackState | null>

export const readStackState: StackStateReader = async (driverId, name) => {
  const d = await getDriver(driverId)
  if (d?.kind !== 'docker') return null
  return (await agentStack(d, name))?.state ?? null
}

/** The docker steps of a stored plan: driver id + stack name (well-formed ones only). */
export function dockerStepsOf(planText: string | null): Array<{ driverId: number; name: string }> {
  let steps: unknown[] = []
  try {
    const plan = JSON.parse(String(planText ?? '')) as { steps?: unknown }
    steps = Array.isArray(plan?.steps) ? plan.steps : []
  } catch {
    return []
  }
  const out: Array<{ driverId: number; name: string }> = []
  for (const raw of steps) {
    const s = raw as { driver?: unknown; driverId?: unknown; stack?: { name?: unknown } } | null
    if (s?.driver !== 'docker') continue
    const driverId = Number(s.driverId)
    const name = s.stack?.name
    if (Number.isInteger(driverId) && typeof name === 'string' && STACK_NAME_RE.test(name))
      out.push({ driverId, name })
  }
  return out
}

const STATE_WORDS: Record<StackState, string> = {
  converged: 'runs a converged spec',
  updating: 'is still updating',
  rolled_back: 'was rolled back by swarm',
  paused: 'has a paused update',
  degraded: 'is degraded'
}

/**
 * One sentence per docker step of the plan saying what the agent reports now, for the
 * interrupted row's error; '' when the plan has no docker step. A read that fails says so.
 * Never throws.
 */
export async function dockerHealNote(
  planText: string | null,
  read: StackStateReader = readStackState
): Promise<string> {
  const parts: string[] = []
  for (const s of dockerStepsOf(planText)) {
    let state: StackState | null | 'unread'
    try {
      state = await read(s.driverId, s.name)
    } catch {
      state = 'unread'
    }
    parts.push(
      state === 'unread'
        ? `the Hub agent could not say how ${s.name} stands`
        : state === null
          ? `the swarm has no stack ${s.name}`
          : `the Hub agent reports ${s.name} ${STATE_WORDS[state] ?? state}`
    )
  }
  if (!parts.length) return ''
  return `${parts.join('; ')} — nothing was re-applied; the next plan reads the stack as it is`
}
