/**
 * Reboot survivability (#2829) and container log audit (#2831), per Docker host. Reads the
 * read-only Docker source (container list + per-container inspect, swarm services) and the host
 * facts in the telemetry store; never writes anything anywhere.
 */
import { type DockerHost, dockerGet, forEachDockerHost, ownerOf } from './docker-source.js'
import { filesystemFor, type HostFacts, type HostMount, readHostFacts } from './host-facts.js'
import { metricsQuery, storeEnabled } from './telemetry-store.js'

interface ContainerSummary {
  Id: string
  Names?: string[]
  Image?: string
  State?: string
  Labels?: Record<string, string>
  Mounts?: Array<{ Type?: string; Name?: string; Source?: string; Destination?: string }>
}

interface ContainerInspect {
  Id: string
  Name?: string
  HostConfig?: {
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number }
    LogConfig?: { Type?: string; Config?: Record<string, string> }
  }
}

interface ServiceSummary {
  ID: string
  Spec?: { Name?: string; TaskTemplate?: { RestartPolicy?: { Condition?: string } } }
}

const nameOf = (c: ContainerSummary) => (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '')

/** Inspect every container, 6 at a time; a container that vanished meanwhile is left out. */
async function inspectAll(
  host: DockerHost,
  list: ContainerSummary[]
): Promise<Map<string, ContainerInspect>> {
  const out = new Map<string, ContainerInspect>()
  let i = 0
  const worker = async () => {
    while (i < list.length) {
      const c = list[i++]
      try {
        out.set(
          c.Id,
          await dockerGet<ContainerInspect>(host, `/containers/${c.Id}/json`, { cacheMs: 60_000 })
        )
      } catch {
        // Removed between the list and the inspect, or the proxy refused: judged without it.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker))
  return out
}

async function containers(host: DockerHost): Promise<ContainerSummary[]> {
  return dockerGet<ContainerSummary[]>(host, '/containers/json', {
    query: { all: true },
    cacheMs: 15_000
  })
}

// ── #2829 Reboot survivability ─────────────────────────────────────────────────────────────

export type RebootVerdict = 'comes_back' | 'stays_down' | 'may_break'

export interface RebootContainer {
  name: string
  image: string | null
  managed_by: 'swarm' | 'compose' | 'none'
  stack: string | null
  service: string | null
  restart_policy: string | null
  verdict: RebootVerdict
  reason: string
  remote_mounts: Array<{
    mountpoint: string
    destination: string
    nofail: boolean
    docker_waits: boolean | null
  }>
}

export interface RebootHost {
  facts_collected: boolean
  containers: RebootContainer[]
  stopped: number
  counts: Record<RebootVerdict, number>
  /** Host-level problems: remote mounts without nofail can stop the boot itself. */
  host_notes: string[]
  summary: string
}

/** The remote fstab mount a path lives on, if any. */
export function remoteMountFor(mounts: HostMount[], path: string): HostMount | null {
  return filesystemFor(
    mounts.filter((m) => m.mountpoint !== '/'),
    path
  )
}

/** Judges one running container (pure). `serviceCondition` = its swarm service's restart condition. */
export function judgeReboot(input: {
  name: string
  image?: string | null
  labels?: Record<string, string>
  restartPolicy: string | null
  serviceCondition: string | null | undefined
  mounts: Array<{ Source?: string; Destination?: string }>
  hostMounts: HostMount[]
}): RebootContainer {
  const own = ownerOf(input.labels)
  const managed: RebootContainer['managed_by'] = own.service
    ? 'swarm'
    : own.compose_project
      ? 'compose'
      : 'none'
  const policy = input.restartPolicy || 'no'
  const remote: RebootContainer['remote_mounts'] = []
  for (const m of input.mounts) {
    if (!m.Source) continue
    const hm = remoteMountFor(input.hostMounts, m.Source)
    if (hm && !remote.some((r) => r.mountpoint === hm.mountpoint))
      remote.push({
        mountpoint: hm.mountpoint,
        destination: m.Destination ?? '',
        nofail: hm.nofail,
        docker_waits: hm.docker_waits
      })
  }

  let verdict: RebootVerdict
  let reason: string
  if (managed === 'swarm') {
    const cond = (input.serviceCondition ?? 'any').toLowerCase()
    if (cond === 'none') {
      verdict = 'stays_down'
      reason = `Swarm service ${own.service} has restart condition "none".`
    } else {
      verdict = 'comes_back'
      reason =
        input.serviceCondition == null
          ? 'Swarm reschedules its tasks after a reboot.'
          : `Swarm reschedules it (restart condition "${cond}").`
    }
  } else if (policy === 'always' || policy === 'unless-stopped') {
    verdict = 'comes_back'
    reason = `Restart policy "${policy}": Docker starts it again at boot.`
  } else {
    verdict = 'stays_down'
    reason =
      policy === 'on-failure'
        ? 'Restart policy "on-failure" does not start a container after a reboot.'
        : 'No restart policy: it stays down after a reboot.'
  }
  const unsafe = remote.filter((r) => r.docker_waits === false)
  if (verdict === 'comes_back' && unsafe.length) {
    verdict = 'may_break'
    reason = `Uses ${unsafe.map((r) => r.mountpoint).join(', ')}, a remote mount Docker does not wait for at boot — it can start against the empty mount point.`
  }
  return {
    name: input.name,
    image: input.image ?? null,
    managed_by: managed,
    stack: own.stack ?? own.compose_project,
    service: own.service ?? own.compose_service,
    restart_policy: managed === 'swarm' ? (input.serviceCondition ?? 'any') : policy,
    verdict,
    reason,
    remote_mounts: remote
  }
}

const ORDER: Record<RebootVerdict, number> = { stays_down: 0, may_break: 1, comes_back: 2 }

export function summarizeReboot(
  list: RebootContainer[],
  stopped: number,
  facts: HostFacts | null
): RebootHost {
  const counts: Record<RebootVerdict, number> = { comes_back: 0, stays_down: 0, may_break: 0 }
  for (const c of list) counts[c.verdict]++
  const collected = !!facts && facts.collected_at != null
  const notes: string[] = []
  for (const m of facts?.mounts ?? [])
    if (!m.nofail)
      notes.push(
        `${m.mountpoint} (${m.fstype}) has no nofail in /etc/fstab: if its server is down at boot, the host can stop in emergency mode.`
      )
  if (!collected) notes.push('Host facts are not collected, so remote mounts were not checked.')
  const total = list.length
  const parts: string[] = []
  if (counts.stays_down)
    parts.push(`${counts.stays_down} stay${counts.stays_down === 1 ? 's' : ''} down`)
  if (counts.may_break) parts.push(`${counts.may_break} may come back broken`)
  const summary =
    total === 0
      ? 'No running containers.'
      : parts.length === 0
        ? `All ${total} running container${total === 1 ? '' : 's'} come back after a reboot.`
        : `${counts.comes_back} of ${total} running containers come back after a reboot; ${parts.join(', ')}.`
  return {
    facts_collected: collected,
    containers: [...list].sort(
      (a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.name.localeCompare(b.name)
    ),
    stopped,
    counts,
    host_notes: notes,
    summary
  }
}

export async function rebootReport(): Promise<{
  hosts: Array<{ host: string; data: RebootHost | null; error: string | null }>
}> {
  const read = await readHostFacts().catch(() => null)
  const hosts = await forEachDockerHost(async (h) => {
    const facts = read?.facts.get(h.name) ?? null
    const list = await containers(h)
    const running = list.filter((c) => c.State === 'running')
    const inspected = await inspectAll(
      h,
      running.filter((c) => !ownerOf(c.Labels).service)
    )
    let services: ServiceSummary[] | null = null
    if (running.some((c) => ownerOf(c.Labels).service)) {
      // Only a manager answers /services; elsewhere swarm tasks are judged on swarm's default.
      services = await dockerGet<ServiceSummary[]>(h, '/services', { cacheMs: 30_000 }).catch(
        () => null
      )
    }
    const cond = new Map<string, string | null>()
    for (const s of services ?? [])
      if (s.Spec?.Name)
        cond.set(s.Spec.Name, s.Spec.TaskTemplate?.RestartPolicy?.Condition ?? 'any')
    const judged = running.map((c) => {
      const svc = ownerOf(c.Labels).service
      return judgeReboot({
        name: nameOf(c),
        image: c.Image ?? null,
        labels: c.Labels,
        restartPolicy: inspected.get(c.Id)?.HostConfig?.RestartPolicy?.Name ?? null,
        serviceCondition: svc ? (services ? (cond.get(svc) ?? null) : null) : undefined,
        mounts: c.Mounts ?? [],
        hostMounts: facts?.mounts ?? []
      })
    })
    return summarizeReboot(judged, list.length - running.length, facts)
  })
  return { hosts }
}

// ── #2831 Container log volume and rotation ────────────────────────────────────────────────

export interface LogContainer {
  name: string
  running: boolean
  driver: string | null
  max_size: string | null
  max_file: string | null
  /** json-file without max-size grows until the disk is full. */
  unbounded: boolean
  bytes: number | null
  growth_per_day: number | null
}

export interface LogHost {
  facts_collected: boolean
  docker_root: string | null
  filesystem: { mountpoint: string; avail_bytes: number; size_bytes: number | null } | null
  total_bytes: number | null
  growth_per_day: number | null
  days_until_full: number | null
  unbounded: number
  containers: LogContainer[]
}

export function judgeLogConfig(
  cfg: { Type?: string; Config?: Record<string, string> } | undefined
): {
  driver: string | null
  max_size: string | null
  max_file: string | null
  unbounded: boolean
} {
  const driver = cfg?.Type ?? null
  const maxSize = cfg?.Config?.['max-size'] ?? null
  const maxFile = cfg?.Config?.['max-file'] ?? null
  // json-file keeps one ever-growing file unless max-size is set; `local` rotates by default and
  // the remote drivers keep nothing on the host.
  return {
    driver,
    max_size: maxSize,
    max_file: maxFile,
    unbounded: driver === 'json-file' && !maxSize
  }
}

/** Days until `avail` is gone at `perDay` growth (null when not growing). */
export function daysUntilFull(avail: number | null, perDay: number | null): number | null {
  if (avail == null || perDay == null || perDay <= 0) return null
  return Math.round((avail / perDay) * 10) / 10
}

export async function logsReport(): Promise<{
  hosts: Array<{ host: string; data: LogHost | null; error: string | null }>
}> {
  const read = await readHostFacts().catch(() => null)
  const growth = new Map<string, number>()
  if (storeEnabled()) {
    const rows = await metricsQuery(
      'max by (host, container) (increase(nivaro_host_container_log_bytes[1d]))'
    ).catch(() => [])
    for (const r of rows)
      if (r.labels.host && r.labels.container && Number.isFinite(r.value))
        growth.set(`${r.labels.host}|${r.labels.container}`, Math.max(0, Math.round(r.value)))
  }
  const hosts = await forEachDockerHost(async (h) => {
    const facts = read?.facts.get(h.name) ?? null
    const signals = read?.signals.get(h.name) ?? null
    const info = await dockerGet<{ DockerRootDir?: string }>(h, '/info', { cacheMs: 60_000 }).catch(
      () => null
    )
    const root = info?.DockerRootDir ?? '/var/lib/docker'
    const list = await containers(h)
    const inspected = await inspectAll(h, list)
    const rows: LogContainer[] = list.map((c) => {
      const name = nameOf(c)
      const cfg = judgeLogConfig(inspected.get(c.Id)?.HostConfig?.LogConfig)
      const bytes = facts?.container_log_bytes[name] ?? null
      const g = growth.get(`${h.name}|${name}`)
      return {
        name,
        running: c.State === 'running',
        ...cfg,
        bytes,
        growth_per_day: g ?? null
      }
    })
    rows.sort(
      (a, b) =>
        Number(b.unbounded) - Number(a.unbounded) ||
        (b.growth_per_day ?? -1) - (a.growth_per_day ?? -1) ||
        (b.bytes ?? -1) - (a.bytes ?? -1) ||
        a.name.localeCompare(b.name)
    )
    const fs = signals ? filesystemFor(signals.space, root) : null
    const anyBytes = rows.some((r) => r.bytes != null)
    const anyGrowth = rows.some((r) => r.growth_per_day != null)
    const total = anyBytes ? rows.reduce((s, r) => s + (r.bytes ?? 0), 0) : null
    const perDay = anyGrowth ? rows.reduce((s, r) => s + (r.growth_per_day ?? 0), 0) : null
    return {
      facts_collected: !!facts && facts.collected_at != null,
      docker_root: root,
      filesystem: fs
        ? { mountpoint: fs.mountpoint, avail_bytes: fs.avail_bytes, size_bytes: fs.size_bytes }
        : null,
      total_bytes: total,
      growth_per_day: perDay,
      days_until_full: daysUntilFull(fs?.avail_bytes ?? null, perDay),
      unbounded: rows.filter((r) => r.unbounded).length,
      containers: rows
    } satisfies LogHost
  })
  return { hosts }
}
