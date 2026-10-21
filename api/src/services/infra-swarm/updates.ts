import { type DockerHost, dockerGet } from '../docker-source.js'
import {
  type EngineContainerInspect,
  type EngineContainerSummary,
  type EngineInfo,
  type EngineService,
  type EngineTask,
  type EngineUpdateConfig,
  iso,
  ms,
  shortId,
  splitImage
} from './engine.js'
import { firstHealthyAt, type HealthStore, readTransitions } from './health.js'
import { loadSwarmObjects, nodeNames, slotKey } from './stacks.js'

/**
 * #2827 Rolling update tracker. A service's current update comes from its UpdateStatus; its past
 * updates are read back from task history, where every task carries the image (and force-update
 * counter) it was created for — tasks grouped by that key are one rollout. History is as long as
 * the swarm's TaskHistoryRetentionLimit (default 5 tasks per slot).
 */

export const IN_FLIGHT_STATES = new Set(['updating', 'rollback_started'])
const STOPPED = new Set(['shutdown', 'complete', 'failed', 'rejected', 'orphaned', 'remove'])
const HISTORY_RUNS = 5
const NS_PER_MS = 1_000_000

export interface UpdatePolicy {
  order: string
  failure_action: string
  parallelism: number
  delay_ms: number
  monitor_ms: number
  max_failure_ratio: number
}

export interface Replacement {
  slot: string
  node: string | null
  old: {
    task_id: string
    image: string | null
    digest: string | null
    state: string | null
    ended_at: string | null
  } | null
  new: {
    task_id: string
    image: string | null
    digest: string | null
    state: string | null
    error: string | null
    created_at: string | null
    running_at: string | null
    healthy_at: string | null
    /** Tasks the rollout needed in this slot (more than 1 = it retried). */
    attempts: number
  }
  to_running_ms: number | null
  to_healthy_ms: number | null
  /** start-first: how long old and new ran side by side. */
  overlap_ms: number | null
}

export interface UpdateRun {
  image: string | null
  digest: string | null
  force: number
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  /** True when a task's running time was lost (it has since stopped): duration is a lower bound. */
  approx: boolean
  tasks: number
  failed: number
  current: boolean
}

export interface UpdateService {
  id: string
  name: string
  stack: string | null
  image: string | null
  digest: string | null
  update: {
    state: string | null
    started_at: string | null
    completed_at: string | null
    message: string | null
    duration_ms: number | null
  } | null
  in_flight: boolean
  policy: UpdatePolicy
  rollback_policy: UpdatePolicy | null
  auto_rollback: boolean
  /** What the failure action did, in words, when it fired. */
  failure_fired: string | null
  replacements: Replacement[]
  history: UpdateRun[]
}

export interface HostUpdates {
  manager: boolean
  in_flight: boolean
  services: UpdateService[]
}

function policy(c: EngineUpdateConfig | undefined): UpdatePolicy {
  return {
    order: c?.Order ?? 'stop-first',
    failure_action: c?.FailureAction ?? 'pause',
    parallelism: c?.Parallelism ?? 1,
    delay_ms: Math.round((c?.Delay ?? 0) / NS_PER_MS),
    monitor_ms: Math.round((c?.Monitor ?? 5_000_000_000) / NS_PER_MS),
    max_failure_ratio: c?.MaxFailureRatio ?? 0
  }
}

const runKey = (t: EngineTask): string =>
  `${t.Spec?.ContainerSpec?.Image ?? ''}|${t.Spec?.ForceUpdate ?? 0}`

/** When a task reached `running`, if it is still there (the timestamp moves on each change). */
const runningAt = (t: EngineTask): number | null =>
  t.Status?.State === 'running' ? ms(t.Status.Timestamp) : null

const endedAt = (t: EngineTask): number | null =>
  STOPPED.has(t.Status?.State ?? '') ? ms(t.Status?.Timestamp) : null

const isoMs = (v: number | null): string | null => (v == null ? null : new Date(v).toISOString())

const byCreated = (a: EngineTask, b: EngineTask) => (ms(a.CreatedAt) ?? 0) - (ms(b.CreatedAt) ?? 0)

/**
 * Tasks grouped into rollouts (oldest first). Within a slot, consecutive tasks with the same
 * image + force counter are one rollout; a rollback back to an earlier image is a NEW rollout.
 * Keys count occurrences from the NEWEST end, because history is trimmed at the oldest end and
 * slots trim independently.
 */
export function rolloutGroups(tasks: EngineTask[]): Array<{ key: string; tasks: EngineTask[] }> {
  const groups = new Map<string, EngineTask[]>()
  const bySlot = new Map<string, EngineTask[]>()
  for (const t of tasks) {
    const list = bySlot.get(slotKey(t)) ?? []
    list.push(t)
    bySlot.set(slotKey(t), list)
  }
  for (const list of bySlot.values()) {
    const seen = new Map<string, number>()
    let prev: string | null = null
    let key = ''
    for (const t of [...list].sort(byCreated).reverse()) {
      const k = runKey(t)
      if (k !== prev) {
        const n = seen.get(k) ?? 0
        seen.set(k, n + 1)
        key = `${k}#${n}`
        prev = k
      }
      const g = groups.get(key) ?? []
      g.push(t)
      groups.set(key, g)
    }
  }
  const first = (list: EngineTask[]) => Math.min(...list.map((t) => ms(t.CreatedAt) ?? Infinity))
  return [...groups.entries()]
    .map(([key, list]) => ({ key, tasks: list }))
    .sort((a, b) => first(a.tasks) - first(b.tasks))
}

export function deriveRun(
  group: { key: string; tasks: EngineTask[] },
  current: boolean
): UpdateRun {
  const img = splitImage(group.tasks[0]?.Spec?.ContainerSpec?.Image)
  // The first task per slot is the rollout itself; later ones in the slot are restarts.
  const firstPerSlot = new Map<string, EngineTask>()
  for (const t of [...group.tasks].sort(byCreated))
    if (!firstPerSlot.has(slotKey(t))) firstPerSlot.set(slotKey(t), t)
  const wave = [...firstPerSlot.values()]
  const starts = wave.map((t) => ms(t.CreatedAt)).filter((v): v is number => v != null)
  let approx = false
  const ends = wave.map((t) => {
    const r = runningAt(t)
    if (r != null) return r
    approx = true
    return ms(t.CreatedAt) ?? 0
  })
  const started = starts.length ? Math.min(...starts) : null
  const finished = ends.length ? Math.max(...ends) : null
  return {
    image: img.image,
    digest: img.digest,
    force: group.tasks[0]?.Spec?.ForceUpdate ?? 0,
    started_at: isoMs(started),
    finished_at: isoMs(finished),
    duration_ms: started != null && finished != null ? Math.max(0, finished - started) : null,
    approx,
    tasks: group.tasks.length,
    failed: group.tasks.filter((t) => ['failed', 'rejected'].includes(t.Status?.State ?? ''))
      .length,
    current
  }
}

export function deriveReplacements(
  tasks: EngineTask[],
  order: string,
  nodes: Map<string, string>,
  healthyAt: Map<string, string | null>
): Replacement[] {
  const groups = rolloutGroups(tasks)
  if (groups.length < 2) return []
  const latest = new Set(groups[groups.length - 1].tasks.map((t) => t.ID))
  const out: Replacement[] = []
  const bySlot = new Map<string, EngineTask[]>()
  for (const t of tasks) {
    const list = bySlot.get(slotKey(t)) ?? []
    list.push(t)
    bySlot.set(slotKey(t), list)
  }
  for (const [slot, list] of bySlot) {
    const sorted = [...list].sort(byCreated)
    const idx = sorted.findIndex((t) => latest.has(t.ID))
    const prev = idx > 0 ? sorted[idx - 1] : null
    if (!prev) continue
    // Timed from the rollout's first task in the slot to the one that runs now (retries count).
    const attempts = sorted.slice(idx).filter((t) => latest.has(t.ID))
    const fresh = attempts[attempts.length - 1]
    const created = ms(sorted[idx].CreatedAt)
    const running = runningAt(fresh)
    const cid = shortId(fresh.Status?.ContainerStatus?.ContainerID)
    const healthy = cid ? (healthyAt.get(cid) ?? null) : null
    const healthyMs = ms(healthy)
    const oldEnd = endedAt(prev)
    const imgNew = splitImage(fresh.Spec?.ContainerSpec?.Image)
    const imgOld = splitImage(prev.Spec?.ContainerSpec?.Image)
    out.push({
      slot,
      node: fresh.NodeID ? (nodes.get(fresh.NodeID) ?? shortId(fresh.NodeID)) : null,
      old: {
        task_id: prev.ID,
        image: imgOld.image,
        digest: imgOld.digest,
        state: prev.Status?.State ?? null,
        ended_at: isoMs(oldEnd)
      },
      new: {
        task_id: fresh.ID,
        image: imgNew.image,
        digest: imgNew.digest,
        state: fresh.Status?.State ?? null,
        error: fresh.Status?.Err?.trim() || null,
        created_at: iso(sorted[idx].CreatedAt),
        running_at: isoMs(running),
        healthy_at: healthy,
        attempts: attempts.length
      },
      to_running_ms: created != null && running != null ? running - created : null,
      to_healthy_ms: created != null && healthyMs != null ? healthyMs - created : null,
      overlap_ms:
        order === 'start-first' && oldEnd != null && running != null
          ? Math.max(0, oldEnd - running)
          : null
    })
  }
  return out.sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }))
}

function failureFired(s: EngineService, p: UpdatePolicy): string | null {
  const st = s.UpdateStatus?.State
  if (st === 'paused' && p.failure_action === 'pause') return 'Paused after a task failed'
  if (st === 'rollback_started') return 'Rolling back after a failure'
  if (st === 'rollback_completed') return 'Rolled back'
  if (st === 'rollback_paused') return 'Rollback paused'
  return null
}

export function deriveUpdates(input: {
  info: EngineInfo
  services: EngineService[] | null
  tasks: EngineTask[] | null
  nodes: Map<string, string>
  healthyAt?: Map<string, string | null>
}): HostUpdates {
  if (!input.services) return { manager: false, in_flight: false, services: [] }
  const byService = new Map<string, EngineTask[]>()
  for (const t of input.tasks ?? []) {
    if (!t.ServiceID) continue
    const list = byService.get(t.ServiceID) ?? []
    list.push(t)
    byService.set(t.ServiceID, list)
  }
  const services = input.services.map((s): UpdateService => {
    const tasks = byService.get(s.ID) ?? []
    const p = policy(s.Spec?.UpdateConfig)
    const groups = rolloutGroups(tasks)
    const img = splitImage(s.Spec?.TaskTemplate?.ContainerSpec?.Image)
    const u = s.UpdateStatus
    const startedMs = ms(u?.StartedAt)
    const completedMs = ms(u?.CompletedAt)
    const inFlight = IN_FLIGHT_STATES.has(u?.State ?? '')
    return {
      id: s.ID,
      name: s.Spec?.Name ?? s.ID,
      stack: s.Spec?.Labels?.['com.docker.stack.namespace'] ?? null,
      image: img.image,
      digest: img.digest,
      update: u
        ? {
            state: u.State ?? null,
            started_at: iso(u.StartedAt),
            completed_at: iso(u.CompletedAt),
            message: u.Message ?? null,
            duration_ms:
              startedMs != null
                ? (completedMs ?? (inFlight ? Date.now() : startedMs)) - startedMs
                : null
          }
        : null,
      in_flight: inFlight,
      policy: p,
      rollback_policy: s.Spec?.RollbackConfig ? policy(s.Spec.RollbackConfig) : null,
      auto_rollback: p.failure_action === 'rollback',
      failure_fired: failureFired(s, p),
      replacements: deriveReplacements(tasks, p.order, input.nodes, input.healthyAt ?? new Map()),
      history: groups
        .slice(-HISTORY_RUNS)
        .map((g, i, arr) => deriveRun(g, i === arr.length - 1))
        .reverse()
    }
  })
  services.sort(
    (a, b) =>
      Number(b.in_flight) - Number(a.in_flight) ||
      (ms(b.update?.started_at) ?? 0) - (ms(a.update?.started_at) ?? 0) ||
      a.name.localeCompare(b.name)
  )
  return { manager: true, in_flight: services.some((s) => s.in_flight), services }
}

/** Most containers inspected per read for time-to-healthy (only those on this host). */
const MAX_INSPECTS = 20

export async function loadUpdates(
  store: HealthStore | null,
  host: DockerHost
): Promise<HostUpdates> {
  const info = await dockerGet<EngineInfo>(host, '/info', { cacheMs: 4_000 })
  const swarm = await loadSwarmObjects(host, info, 4_000)
  if (!swarm) return { manager: false, in_flight: false, services: [] }
  const nodes = nodeNames(swarm.nodes)
  // Time to healthy needs the container, which only its own node can inspect: look up the newest
  // task per slot whose container runs on this host.
  const healthyAt = new Map<string, string | null>()
  const local = await dockerGet<EngineContainerSummary[]>(host, '/containers/json', {
    cacheMs: 4_000
  }).catch(() => [] as EngineContainerSummary[])
  const localIds = new Set(local.map((c) => shortId(c.Id)))
  const wanted = swarm.tasks
    .filter((t) => t.Status?.State === 'running')
    .map((t) => shortId(t.Status?.ContainerStatus?.ContainerID))
    .filter((id): id is string => !!id && localIds.has(id))
    .slice(0, MAX_INSPECTS)
  await Promise.all(
    wanted.map(async (id) => {
      try {
        const c = await dockerGet<EngineContainerInspect>(host, `/containers/${id}/json`, {
          cacheMs: 30_000
        })
        const ring = store ? await readTransitions(store, host.name, id) : []
        healthyAt.set(id, c.State?.Health ? firstHealthyAt(c, ring) : null)
      } catch {
        healthyAt.set(id, null)
      }
    })
  )
  return deriveUpdates({ info, services: swarm.services, tasks: swarm.tasks, nodes, healthyAt })
}
