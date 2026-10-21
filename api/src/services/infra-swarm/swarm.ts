import { type DockerHost, dockerGet } from '../docker-source.js'
import { type MetricSample, metricsQuery, storeEnabled } from '../telemetry-store.js'
import { type EngineCluster, type EngineInfo, type EngineNode, iso, shortId } from './engine.js'

/**
 * #2838 Swarm internals: managers, nodes and the cluster's Raft / CA / orchestration settings,
 * read from /info → Swarm.Cluster (Spec, TLSInfo, RootRotationInProgress…) and /nodes. /swarm is
 * never read: it carries the join tokens (docker-source refuses it). A field /info leaves out shows
 * as unknown. Autolock is shown as information only: the deployment keeps it off on purpose so
 * hosts restart unattended.
 */

const NS_PER_MS = 1_000_000
const DAY_MS = 24 * 3600 * 1000
export const CERT_WARN_DAYS = 14

export interface SwarmNode {
  id: string
  hostname: string
  role: string | null
  availability: string | null
  state: string | null
  message: string | null
  addr: string | null
  engine: string | null
  platform: string | null
  cpus: number | null
  memory_bytes: number | null
  labels: Record<string, string>
  engine_labels: Record<string, string>
  leader: boolean
  reachability: string | null
  manager_addr: string | null
  self: boolean
}

export interface SwarmCluster {
  id: string | null
  created_at: string | null
  updated_at: string | null
  node_cert_expiry_ms: number | null
  task_history_limit: number | null
  autolock: boolean
  external_ca: boolean
  root_rotation: boolean
  raft: {
    snapshot_interval: number | null
    keep_old_snapshots: number | null
    log_entries_for_slow_followers: number | null
    election_tick: number | null
    heartbeat_tick: number | null
  }
  dispatcher_heartbeat_ms: number | null
  data_path_port: number | null
  default_addr_pool: string[]
  subnet_size: number | null
}

export interface HostSwarm {
  state: string | null
  manager: boolean
  node_id: string | null
  error: string | null
  counts: { nodes: number | null; managers: number | null; reachable_managers: number | null }
  nodes: SwarmNode[]
  cluster: SwarmCluster | null
  /** This host's node certificate, from the host-facts collector. */
  cert: { expires_at: string; days_left: number; warn: boolean } | null
  cert_source: 'metric' | 'not-collected'
  warnings: string[]
}

function pickCluster(c: EngineCluster): SwarmCluster {
  const sp = c.Spec ?? {}
  return {
    id: c.ID ?? null,
    created_at: iso(c.CreatedAt),
    updated_at: iso(c.UpdatedAt),
    node_cert_expiry_ms:
      sp.CAConfig?.NodeCertExpiry != null
        ? Math.round(sp.CAConfig.NodeCertExpiry / NS_PER_MS)
        : null,
    task_history_limit: sp.Orchestration?.TaskHistoryRetentionLimit ?? null,
    autolock: !!sp.EncryptionConfig?.AutoLockManagers,
    external_ca: (sp.CAConfig?.ExternalCAs?.length ?? 0) > 0,
    root_rotation: !!c.RootRotationInProgress,
    raft: {
      snapshot_interval: sp.Raft?.SnapshotInterval ?? null,
      keep_old_snapshots: sp.Raft?.KeepOldSnapshots ?? null,
      log_entries_for_slow_followers: sp.Raft?.LogEntriesForSlowFollowers ?? null,
      election_tick: sp.Raft?.ElectionTick ?? null,
      heartbeat_tick: sp.Raft?.HeartbeatTick ?? null
    },
    dispatcher_heartbeat_ms:
      sp.Dispatcher?.HeartbeatPeriod != null
        ? Math.round(sp.Dispatcher.HeartbeatPeriod / NS_PER_MS)
        : null,
    data_path_port: c.DataPathPort ?? null,
    default_addr_pool: Array.isArray(c.DefaultAddrPool) ? c.DefaultAddrPool.map(String) : [],
    subnet_size: c.SubnetSize ?? null
  }
}

/**
 * The metric is the certificate's notAfter as Unix seconds. A small value is read as seconds
 * remaining instead, so either collector convention shows the right date.
 */
export function certFromMetric(
  value: number | null | undefined,
  now = Date.now()
): HostSwarm['cert'] {
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  const at = value > 1e9 ? value * 1000 : now + value * 1000
  const days = Math.floor((at - now) / DAY_MS)
  return { expires_at: new Date(at).toISOString(), days_left: days, warn: days < CERT_WARN_DAYS }
}

export function deriveSwarm(input: {
  info: EngineInfo
  nodes: EngineNode[] | null
  cluster: EngineCluster | null
  certSeconds: number | null
  now?: number
}): HostSwarm {
  const sw = input.info.Swarm ?? {}
  const manager = sw.LocalNodeState === 'active' && !!sw.ControlAvailable
  const nodes: SwarmNode[] = (input.nodes ?? []).map((n) => ({
    id: n.ID,
    hostname: n.Description?.Hostname ?? n.Spec?.Name ?? shortId(n.ID) ?? n.ID,
    role: n.Spec?.Role ?? null,
    availability: n.Spec?.Availability ?? null,
    state: n.Status?.State ?? null,
    message: n.Status?.Message?.trim() || null,
    addr: n.Status?.Addr ?? null,
    engine: n.Description?.Engine?.EngineVersion ?? null,
    platform: n.Description?.Platform
      ? [n.Description.Platform.OS, n.Description.Platform.Architecture].filter(Boolean).join('/')
      : null,
    cpus: n.Description?.Resources?.NanoCPUs ? n.Description.Resources.NanoCPUs / 1e9 : null,
    memory_bytes: n.Description?.Resources?.MemoryBytes ?? null,
    labels: n.Spec?.Labels ?? {},
    engine_labels: n.Description?.Engine?.Labels ?? {},
    leader: !!n.ManagerStatus?.Leader,
    reachability: n.ManagerStatus?.Reachability ?? null,
    manager_addr: n.ManagerStatus?.Addr ?? null,
    self: n.ID === sw.NodeID
  }))
  nodes.sort(
    (a, b) =>
      Number(b.role === 'manager') - Number(a.role === 'manager') ||
      Number(b.leader) - Number(a.leader) ||
      a.hostname.localeCompare(b.hostname)
  )

  const warnings: string[] = []
  const managers = nodes.filter((n) => n.role === 'manager')
  const reachable = managers.filter((n) => n.reachability === 'reachable').length
  if (input.nodes) {
    const total = managers.length
    if (total > 0 && reachable <= total / 2)
      warnings.push(
        `Only ${reachable} of ${total} managers are reachable: the swarm has lost quorum and cannot change services.`
      )
    else if (total > 0 && reachable < total)
      warnings.push(
        `${total - reachable} of ${total} managers are unreachable; one more loss may cost quorum.`
      )
    if (total === 2)
      warnings.push(
        'Two managers tolerate no manager failure (the same as one). Three tolerate one.'
      )
    if (total > 0 && !managers.some((n) => n.leader))
      warnings.push('No manager reports itself as leader.')
    for (const n of nodes)
      if (n.state && n.state !== 'ready')
        warnings.push(`Node ${n.hostname} is ${n.state}${n.message ? ` — ${n.message}` : ''}.`)
  }
  if (sw.Error) warnings.push(`Swarm error on this node: ${sw.Error}`)

  const cert = certFromMetric(input.certSeconds, input.now)
  if (cert?.warn)
    warnings.push(
      cert.days_left < 0
        ? 'This node’s swarm certificate has expired.'
        : `This node’s swarm certificate expires in ${cert.days_left} day${cert.days_left === 1 ? '' : 's'}.`
    )
  const cluster = input.cluster ? pickCluster(input.cluster) : null
  if (cluster?.root_rotation) warnings.push('A root CA rotation is in progress.')

  return {
    state: sw.LocalNodeState ?? null,
    manager,
    node_id: sw.NodeID ?? null,
    error: sw.Error?.trim() || null,
    counts: {
      // The node list wins when it was readable: it is what the warnings above are built from.
      nodes: input.nodes ? nodes.length : (sw.Nodes ?? null),
      managers: input.nodes ? managers.length : (sw.Managers ?? null),
      reachable_managers: input.nodes ? reachable : null
    },
    nodes,
    cluster,
    cert,
    cert_source: cert ? 'metric' : 'not-collected',
    warnings
  }
}

/** host label → the certificate metric value; empty when the store or the metric is missing. */
export async function readCertMetrics(): Promise<Map<string, number>> {
  if (!storeEnabled()) return new Map()
  let rows: MetricSample[] = []
  try {
    rows = await metricsQuery('max by (host) (nivaro_host_swarm_node_cert_expiry_seconds)')
  } catch {
    return new Map()
  }
  return new Map(
    rows
      .filter((r) => r.labels.host && Number.isFinite(r.value))
      .map((r) => [r.labels.host, r.value])
  )
}

export async function loadSwarm(host: DockerHost, certs: Map<string, number>): Promise<HostSwarm> {
  const info = await dockerGet<EngineInfo>(host, '/info', { cacheMs: 10_000 })
  const manager = info.Swarm?.LocalNodeState === 'active' && !!info.Swarm.ControlAvailable
  // Only a manager's /info carries Swarm.Cluster; a worker shows what it knows about itself.
  const cluster: EngineCluster | null = info.Swarm?.Cluster ?? null
  const nodes = manager
    ? await dockerGet<EngineNode[]>(host, '/nodes', { cacheMs: 10_000 }).catch(() => null)
    : null
  return deriveSwarm({ info, nodes, cluster, certSeconds: certs.get(host.name) ?? null })
}
