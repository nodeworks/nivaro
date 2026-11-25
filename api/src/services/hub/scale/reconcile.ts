import { agentStack } from '../docker/agent-client.js'
import type { StackStatus } from '../docker/agent-types.js'
import type { DockerDriverRow } from '../drivers.js'
import { isScalable, type RoleFigures } from './shape.js'
import { listRuns, type ScaleRun, updateRun, writeShape } from './store.js'
import type { ScaleTarget } from './target.js'

/**
 * Nivaro Hub scaling: the Hub's record follows what swarm actually runs. After a step whose
 * outcome the Hub could not see (a timeout, the agent unreachable, the lock lost, swarm rolling
 * back), and before a later scale or restart is retried after SPEC_MISMATCH, the live stack is
 * read and adopted:
 *
 *   step       the live stack hash is one a scale step got from the agent (or, for the step that
 *              was in flight, any new hash other than the one read just before it was sent):
 *              that step's numbers are kept and its run carries the hash, so `deployedStack`
 *              expects it and the next Apply now renders what runs instead of scaling back;
 *   replicas   no step matches, but swarm runs other replica counts than the Hub keeps for a
 *              scalable role: those counts are kept (limits are not visible in a status);
 *   none       the record already matches; unknown = the agent could not be read (nothing kept).
 */

export type Adopted = 'step' | 'replicas' | 'none' | 'unknown'

export interface ReconcileHint {
  run: ScaleRun
  stepIndex: number
  /** The live stack hash read right before the step was sent (null = not read). */
  fromHash: string | null
}

export interface ReconcileDeps {
  agentStack?: (d: DockerDriverRow, name: string, expect?: string) => Promise<StackStatus | null>
}

const changed = (from: RoleFigures[], to: RoleFigures[]) =>
  to.filter((t) => {
    const f = from.find((x) => x.role === t.role)
    return !f || f.replicas !== t.replicas || f.cpus !== t.cpus || f.memory_mb !== t.memory_mb
  })

/** What the live stack runs now; null when the agent does not answer. */
export async function liveStatus(
  t: ScaleTarget,
  deps: ReconcileDeps = {}
): Promise<StackStatus | null> {
  if (!t.driver || !t.stack) return null
  try {
    return await (deps.agentStack ?? agentStack)(t.driver, t.stack)
  } catch {
    return null
  }
}

async function adoptStep(run: ScaleRun, index: number, hash: string, by: string | null) {
  const step = run.steps[index]
  await writeShape(run.target_kind, run.target_id, changed(run.from, step.to), by)
  const steps = run.steps.map((s, i) => (i === index ? { ...s, spec_hash: hash } : s))
  await updateRun(run.id, { spec_hash: hash, steps })
}

export async function reconcileFromLive(
  t: ScaleTarget,
  hint: ReconcileHint | null,
  deps: ReconcileDeps = {}
): Promise<{ adopted: Adopted; hash: string | null }> {
  const st = await liveStatus(t, deps)
  if (!st) return { adopted: 'unknown', hash: null }
  const live = st.spec_hash
  if (live && /^[0-9a-f]{64}$/.test(live)) {
    if (hint) {
      const step = hint.run.steps[hint.stepIndex]
      const applied = step?.spec_hash === live || (hint.fromHash !== null && live !== hint.fromHash)
      if (step && applied) {
        await adoptStep(hint.run, hint.stepIndex, live, hint.run.started_by)
        return { adopted: 'step', hash: live }
      }
    }
    for (const run of await listRuns(t.kind, t.id, 10)) {
      const at = run.steps.findIndex((s) => s.spec_hash === live)
      if (at >= 0) {
        if (run.spec_hash !== live) await adoptStep(run, at, live, run.started_by)
        return { adopted: run.spec_hash === live ? 'none' : 'step', hash: live }
      }
    }
  }
  const keep: RoleFigures[] = []
  const services = Array.isArray(st.services) ? st.services : []
  for (const r of t.roles) {
    if (!isScalable(r.role)) continue
    const svc = services.find((s) => s.role === r.role)
    const desired = Number(svc?.replicas?.desired)
    if (svc && Number.isInteger(desired) && desired >= 1 && desired !== r.replicas)
      keep.push({
        role: r.role,
        replicas: desired,
        cpus: r.cpus ?? null,
        memory_mb: r.memory_mb ?? null
      })
  }
  if (keep.length) {
    await writeShape(t.kind, t.id, keep, null)
    return { adopted: 'replicas', hash: live }
  }
  return { adopted: 'none', hash: live }
}

/**
 * For a restart refused SPEC_MISMATCH (routes/hub-docker.ts): adopt what an environment's stack
 * runs. true = the record changed (the caller renders again and retries once).
 */
export async function reconcileEnvironment(
  envId: number,
  deps: ReconcileDeps = {}
): Promise<boolean> {
  const { environmentTarget } = await import('./target.js')
  const t = await environmentTarget(envId)
  if (!t || t.unusable) return false
  const r = await reconcileFromLive(t, null, deps)
  return r.adopted === 'step' || r.adopted === 'replicas'
}
