import { type DockerHost, dockerGet, ownerOf } from '../docker-source.js'
import {
  containerName,
  desiredReplicas,
  type EngineContainerSummary,
  type EngineInfo,
  type EngineNode,
  type EngineService,
  type EngineTask,
  formatContainerPorts,
  formatSwarmPorts,
  iso,
  ms,
  serviceMode,
  shortId,
  splitImage
} from './engine.js'

/**
 * #2826 Stack map: per host, swarm stacks → services → tasks → node, and compose projects →
 * containers. Pure derivation (`deriveStacks`) over what the Engine returns, plus the loader.
 */

/** Tasks kept per slot (newest first), including failed history. */
export const TASKS_PER_SLOT = 4

const FAILED_STATES = new Set(['failed', 'rejected', 'orphaned'])
const BAD_UPDATE_STATES = new Set(['paused', 'rollback_started', 'rollback_paused'])

export interface StackTask {
  id: string
  slot: number | null
  node_id: string | null
  node: string | null
  state: string | null
  desired_state: string | null
  /** The engine's error (e.g. "No such container", "no suitable node (…)"), else null. */
  error: string | null
  message: string | null
  image: string | null
  digest: string | null
  container_id: string | null
  exit_code: number | null
  created_at: string | null
  updated_at: string | null
  /** When the task reached its current state. */
  state_at: string | null
}

export interface StackService {
  id: string
  name: string
  /** The name without the `<stack>_` prefix. */
  short_name: string
  mode: 'replicated' | 'global' | 'job'
  desired: number | null
  running: number
  image: string | null
  digest: string | null
  ports: string[]
  created_at: string | null
  updated_at: string | null
  update_status: {
    state: string | null
    started_at: string | null
    completed_at: string | null
    message: string | null
  } | null
  failing: boolean
  failing_reason: string | null
  tasks: StackTask[]
  task_total: number
}

export interface StackGroup {
  name: string
  services: StackService[]
}

export interface StackContainer {
  id: string
  name: string
  service: string | null
  image: string | null
  state: string | null
  status: string | null
  health: 'healthy' | 'unhealthy' | 'starting' | null
  exit_code: number | null
  ports: string[]
  created_at: string | null
  failing: boolean
}

export interface ContainerGroup {
  /** compose = a compose project; swarm-local = this node's tasks of a stack (worker node). */
  kind: 'compose' | 'swarm-local' | 'standalone'
  name: string
  containers: StackContainer[]
}

export interface HostStacks {
  swarm: 'manager' | 'worker' | 'none'
  stacks: StackGroup[]
  projects: ContainerGroup[]
  counts: {
    services: number
    running: number
    desired: number
    failing: number
    containers: number
    containers_running: number
    containers_failing: number
  }
}

/** `Up 3 hours (healthy)` → healthy; `(health: starting)` → starting. */
export function healthFromStatus(status: string | null | undefined): StackContainer['health'] {
  if (!status) return null
  if (/\(unhealthy\)/i.test(status)) return 'unhealthy'
  if (/\(healthy\)/i.test(status)) return 'healthy'
  if (/\(health: starting\)/i.test(status)) return 'starting'
  return null
}

function exitCodeFromStatus(status: string | null | undefined): number | null {
  const m = /^Exited \((\d+)\)/i.exec(status ?? '')
  return m ? Number(m[1]) : null
}

function toTask(t: EngineTask, nodes: Map<string, string>): StackTask {
  const img = splitImage(t.Spec?.ContainerSpec?.Image)
  const state = t.Status?.State ?? null
  return {
    id: t.ID,
    slot: t.Slot ?? null,
    node_id: t.NodeID ?? null,
    node: t.NodeID ? (nodes.get(t.NodeID) ?? shortId(t.NodeID)) : null,
    state,
    desired_state: t.DesiredState ?? null,
    error: t.Status?.Err?.trim() || null,
    message: t.Status?.Message?.trim() || null,
    image: img.image,
    digest: img.digest,
    container_id: shortId(t.Status?.ContainerStatus?.ContainerID),
    exit_code: t.Status?.ContainerStatus?.ExitCode ?? null,
    created_at: iso(t.CreatedAt),
    updated_at: iso(t.UpdatedAt),
    state_at: iso(t.Status?.Timestamp)
  }
}

/** Slot key: replicated tasks share a slot number; global tasks are one per node. */
export const slotKey = (t: EngineTask): string =>
  t.Slot != null && t.Slot > 0 ? `s${t.Slot}` : `n${t.NodeID ?? t.ID}`

const createdDesc = (a: EngineTask, b: EngineTask) =>
  (ms(b.CreatedAt) ?? 0) - (ms(a.CreatedAt) ?? 0)

export function deriveService(
  s: EngineService,
  tasks: EngineTask[],
  nodes: Map<string, string>
): StackService {
  const name = s.Spec?.Name ?? s.ID
  const stack = s.Spec?.Labels?.['com.docker.stack.namespace'] ?? null
  const img = splitImage(s.Spec?.TaskTemplate?.ContainerSpec?.Image)
  const bySlot = new Map<string, EngineTask[]>()
  for (const t of [...tasks].sort(createdDesc)) {
    const k = slotKey(t)
    const list = bySlot.get(k) ?? []
    list.push(t)
    bySlot.set(k, list)
  }
  const running =
    s.ServiceStatus?.RunningTasks ??
    tasks.filter((t) => t.Status?.State === 'running' && t.DesiredState === 'running').length
  const mode = serviceMode(s)
  // Global services without ServiceStatus: one task per node that wants one.
  const desired =
    desiredReplicas(s) ??
    (mode === 'global' ? tasks.filter((t) => t.DesiredState === 'running').length : null)

  // A slot is failing when nothing in it runs and its newest task failed or cannot schedule.
  let failedSlots = 0
  let slotError: string | null = null
  for (const list of bySlot.values()) {
    const newest = list[0]
    if (list.some((t) => t.Status?.State === 'running')) continue
    if (newest.DesiredState === 'shutdown' && !FAILED_STATES.has(newest.Status?.State ?? ''))
      continue
    if (
      FAILED_STATES.has(newest.Status?.State ?? '') ||
      (newest.Status?.State === 'pending' && newest.Status?.Err)
    ) {
      failedSlots++
      slotError ??= newest.Status?.Err?.trim() || newest.Status?.Message?.trim() || null
    }
  }
  const updateState = s.UpdateStatus?.State ?? null
  let failingReason: string | null = null
  if (mode !== 'job' && desired != null && running < desired)
    failingReason = `${running} of ${desired} running${slotError ? ` — ${slotError}` : ''}`
  else if (updateState && BAD_UPDATE_STATES.has(updateState))
    failingReason = `Update ${updateState.replace('_', ' ')}${s.UpdateStatus?.Message ? ` — ${s.UpdateStatus.Message}` : ''}`
  else if (failedSlots > 0 && mode !== 'job')
    failingReason = `${failedSlots} slot${failedSlots === 1 ? '' : 's'} failing${slotError ? ` — ${slotError}` : ''}`

  const kept: StackTask[] = []
  const slotOrder = [...bySlot.entries()].sort(([a, la], [b, lb]) => {
    const sa = la[0].Slot ?? 0
    const sb = lb[0].Slot ?? 0
    return sa - sb || a.localeCompare(b)
  })
  for (const [, list] of slotOrder)
    for (const t of list.slice(0, TASKS_PER_SLOT)) kept.push(toTask(t, nodes))

  return {
    id: s.ID,
    name,
    short_name: stack && name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : name,
    mode,
    desired,
    running,
    image: img.image,
    digest: img.digest,
    ports: formatSwarmPorts(s.Endpoint?.Ports ?? s.Spec?.EndpointSpec?.Ports),
    created_at: iso(s.CreatedAt),
    updated_at: iso(s.UpdatedAt),
    update_status: s.UpdateStatus
      ? {
          state: updateState,
          started_at: iso(s.UpdateStatus.StartedAt),
          completed_at: iso(s.UpdateStatus.CompletedAt),
          message: s.UpdateStatus.Message ?? null
        }
      : null,
    failing: failingReason != null,
    failing_reason: failingReason,
    tasks: kept,
    task_total: tasks.length
  }
}

function toContainer(c: EngineContainerSummary): StackContainer {
  const o = ownerOf(c.Labels)
  const health = healthFromStatus(c.Status)
  const exit = exitCodeFromStatus(c.Status)
  const state = c.State ?? null
  return {
    id: shortId(c.Id) ?? c.Id,
    name: containerName(c),
    service: o.compose_service ?? o.service,
    image: splitImage(c.Image).image,
    state,
    status: c.Status ?? null,
    health,
    exit_code: exit,
    ports: formatContainerPorts(c.Ports),
    created_at: c.Created ? new Date(c.Created * 1000).toISOString() : null,
    failing:
      health === 'unhealthy' ||
      state === 'restarting' ||
      state === 'dead' ||
      (state === 'exited' && exit != null && exit !== 0)
  }
}

export function nodeNames(nodes: EngineNode[]): Map<string, string> {
  return new Map(
    nodes.map((n) => [n.ID, n.Description?.Hostname ?? n.Spec?.Name ?? shortId(n.ID) ?? n.ID])
  )
}

export function deriveStacks(input: {
  info: EngineInfo
  services: EngineService[] | null
  tasks: EngineTask[] | null
  nodes: EngineNode[] | null
  containers: EngineContainerSummary[]
}): HostStacks {
  const sw = input.info.Swarm
  const swarm: HostStacks['swarm'] =
    sw?.LocalNodeState === 'active' ? (sw.ControlAvailable ? 'manager' : 'worker') : 'none'
  const names = nodeNames(input.nodes ?? [])
  const tasksBySvc = new Map<string, EngineTask[]>()
  for (const t of input.tasks ?? []) {
    if (!t.ServiceID) continue
    const list = tasksBySvc.get(t.ServiceID) ?? []
    list.push(t)
    tasksBySvc.set(t.ServiceID, list)
  }

  const stackMap = new Map<string, StackService[]>()
  for (const s of input.services ?? []) {
    const stack = s.Spec?.Labels?.['com.docker.stack.namespace'] ?? ''
    const list = stackMap.get(stack) ?? []
    list.push(deriveService(s, tasksBySvc.get(s.ID) ?? [], names))
    stackMap.set(stack, list)
  }
  const stacks = [...stackMap.entries()]
    .map(([name, services]) => ({
      name,
      services: services.sort((a, b) => a.name.localeCompare(b.name))
    }))
    // Services outside any stack (`docker service create`) sort last under an empty name.
    .sort((a, b) => (a.name === '' ? 1 : b.name === '' ? -1 : a.name.localeCompare(b.name)))

  const groups = new Map<string, ContainerGroup>()
  for (const c of input.containers) {
    const o = ownerOf(c.Labels)
    let kind: ContainerGroup['kind']
    let name: string
    if (o.service) {
      // A manager already shows its tasks under the service; a worker shows its local tasks.
      if (swarm === 'manager') continue
      kind = 'swarm-local'
      name = o.stack ?? o.service
    } else if (o.compose_project) {
      kind = 'compose'
      name = o.compose_project
    } else {
      kind = 'standalone'
      name = ''
    }
    const key = `${kind}|${name}`
    const g = groups.get(key) ?? { kind, name, containers: [] }
    g.containers.push(toContainer(c))
    groups.set(key, g)
  }
  const kindOrder = { compose: 0, 'swarm-local': 1, standalone: 2 }
  const projects = [...groups.values()]
    .map((g) => ({ ...g, containers: g.containers.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name))

  const allServices = stacks.flatMap((s) => s.services)
  const allContainers = projects.flatMap((p) => p.containers)
  return {
    swarm,
    stacks,
    projects,
    counts: {
      services: allServices.length,
      running: allServices.reduce((n, s) => n + s.running, 0),
      desired: allServices.reduce((n, s) => n + (s.desired ?? 0), 0),
      failing: allServices.filter((s) => s.failing).length,
      containers: allContainers.length,
      containers_running: allContainers.filter((c) => c.state === 'running').length,
      containers_failing: allContainers.filter((c) => c.failing).length
    }
  }
}

/** The swarm reads a manager answers (services with status, tasks, nodes); null off a manager. */
export async function loadSwarmObjects(
  host: DockerHost,
  info: EngineInfo,
  cacheMs = 10_000
): Promise<{ services: EngineService[]; tasks: EngineTask[]; nodes: EngineNode[] } | null> {
  if (info.Swarm?.LocalNodeState !== 'active' || !info.Swarm.ControlAvailable) return null
  const [services, tasks, nodes] = await Promise.all([
    dockerGet<EngineService[]>(host, '/services', { query: { status: true }, cacheMs }),
    dockerGet<EngineTask[]>(host, '/tasks', { cacheMs }),
    // Nodes only label tasks; a proxy without the section still shows everything else.
    dockerGet<EngineNode[]>(host, '/nodes', { cacheMs }).catch(() => [] as EngineNode[])
  ])
  return { services, tasks, nodes }
}

export async function loadStacks(host: DockerHost): Promise<HostStacks> {
  const info = await dockerGet<EngineInfo>(host, '/info', { cacheMs: 10_000 })
  const [swarm, containers] = await Promise.all([
    loadSwarmObjects(host, info),
    dockerGet<EngineContainerSummary[]>(host, '/containers/json', {
      query: { all: true },
      cacheMs: 10_000
    })
  ])
  return deriveStacks({
    info,
    services: swarm?.services ?? null,
    tasks: swarm?.tasks ?? null,
    nodes: swarm?.nodes ?? null,
    containers
  })
}
