import type { ExtensionRunbookDecl } from '@nivaro/extension-kit'
import { type ArmedFault, registerFault } from '../catalog.js'
import { ChaosError } from '../gate.js'

/**
 * Game-day faults (#2816). "Kill a web task" is the one fault the API cannot do itself: the
 * API never writes to Docker (docker-source.ts is GET-only). Arming it QUEUES a host runbook
 * in the Runbooks host-run queue (runbook-queue.ts, migration 403); the host agent on the
 * swarm manager claims the row and runs the kill (`docker service update --force` or one task's
 * container stop), streaming its output back to the Runbooks console. The fault's window is
 * the observation time: swarm restarts the task by itself, the run's hypothesis and samplers
 * measure how long the instance takes to look healthy again. Stopping the fault cancels the
 * host run while it is still queued; a kill that already ran is not undone (swarm heals it).
 *
 * The runbook is declared by a deployment extension under the fixed key below, `runs_on:
 * 'host'`, `skip_dry_gate: true` (it writes nothing to a database), with a `target_env` so the
 * agent knows which stack. Without it the fault refuses with a clear reason.
 */

export const KILL_TASK_RUNBOOK = 'chaos-kill-web-task'

export interface KillTaskRunbook {
  extension: string
  decl: ExtensionRunbookDecl
}

/** The declared kill runbook, first extension by id. */
export async function killTaskRunbook(): Promise<KillTaskRunbook | null> {
  const { extensionRunbooks } = await import('../../../extensions/loader.js')
  for (const [extension, decls] of [...extensionRunbooks].sort(([a], [b]) => a.localeCompare(b))) {
    const decl = decls.find((d) => d.key === KILL_TASK_RUNBOOK && d.runs_on === 'host')
    if (decl) return { extension, decl }
  }
  return null
}

/** Null when the kill can be queued for `env`, otherwise why not (the console shows it). */
export async function killTaskRefusal(env: string): Promise<string | null> {
  const rb = await killTaskRunbook()
  if (!rb)
    return `No host runbook "${KILL_TASK_RUNBOOK}" is declared by a loaded extension — the task kill runs only through the Runbooks host queue`
  const { hostQueueAvailable, listHostRuns } = await import('../../runbook-queue.js')
  if (!(await hostQueueAvailable())) return 'The runbook host queue is not set up on this database'
  const { hostRunRefusal } = await import('../../runbook-admission.js')
  const prior = (await listHostRuns(200)) as never[]
  return hostRunRefusal(
    rb.decl,
    {
      extension: rb.extension,
      runbook: rb.decl.key,
      mode: 'go',
      target: env || null,
      from_step: null
    },
    prior
  )
}

async function queueKill(fault: ArmedFault): Promise<(() => Promise<void>) | undefined> {
  const env = String(fault.params.env ?? '')
  const why = await killTaskRefusal(env)
  if (why) throw new ChaosError(why, 409, 'CHAOS_RUNBOOK')
  const rb = (await killTaskRunbook()) as KillTaskRunbook
  const { runbookArgv } = await import('../../runbook-runs.js')
  const { cancelHostRun, queueHostRun } = await import('../../runbook-queue.js')
  const argv = runbookArgv(rb.decl, 'go')
  const service = String(fault.params.service ?? 'api')
  const hostRun = await queueHostRun({
    extension: rb.extension,
    runbook: rb.decl.key,
    mode: 'go',
    target: env || null,
    args: [argv.file, ...argv.args, `--service=${service}`],
    from: null,
    resumeOf: null,
    user: fault.started_by ?? 'chaos'
  })
  if (fault.run_id) {
    const { addRunEvent } = await import('../drill.js')
    await addRunEvent(fault.run_id, 'step', {
      host_run_id: hostRun.id,
      runbook: `${rb.extension}:${rb.decl.key}`,
      outcome: 'queued'
    })
  }
  return async () => {
    // A kill still waiting in the queue is withdrawn; one that ran is healed by swarm.
    await cancelHostRun(hostRun.id).catch(() => null)
  }
}

registerFault({
  key: 'kill_web_task',
  label: 'Kill a web task',
  area: 'process',
  proves:
    'Losing one API task is a blip: swarm replaces it, the other replicas carry the traffic, sockets reconnect and catch up, nobody loses a save.',
  claim_keys: ['process.task_loss'],
  targets: ['all'],
  params: {
    env: {
      type: 'string',
      label: 'Environment (runbook target)',
      default: 'staging',
      max_length: 64,
      pattern: '^[A-Za-z0-9_-]{1,64}$'
    },
    service: { type: 'enum', label: 'Service', options: ['api', 'worker'], default: 'api' }
  },
  max_seconds: 900,
  default_seconds: 300,
  points: [],
  danger: 'high',
  apply_scope: 'origin',
  apply: (fault) => queueKill(fault),
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 2, tolerance: 1 }]
})
