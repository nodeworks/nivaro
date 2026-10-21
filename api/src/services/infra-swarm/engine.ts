/**
 * The slice of the Docker Engine API (v1.41+) the Stacks / Updates / Health / Swarm / Secrets
 * tabs read (#2826–#2828, #2838, #2839), plus small helpers they share. Every field is optional:
 * engines differ by version and a socket proxy may hide sections.
 */

export interface EngineVersion {
  Index?: number
}

export interface EnginePort {
  Protocol?: string
  TargetPort?: number
  PublishedPort?: number
  PublishMode?: string
}

export interface EngineSecretRef {
  SecretID?: string
  SecretName?: string
  File?: { Name?: string }
}

export interface EngineConfigRef {
  ConfigID?: string
  ConfigName?: string
  File?: { Name?: string }
}

export interface EngineUpdateConfig {
  Parallelism?: number
  Delay?: number
  FailureAction?: string
  Monitor?: number
  MaxFailureRatio?: number
  Order?: string
}

export interface EngineServiceSpec {
  Name?: string
  Labels?: Record<string, string>
  TaskTemplate?: {
    ContainerSpec?: {
      Image?: string
      Secrets?: EngineSecretRef[]
      Configs?: EngineConfigRef[]
    }
    ForceUpdate?: number
  }
  Mode?: {
    Replicated?: { Replicas?: number }
    Global?: Record<string, never>
    ReplicatedJob?: { MaxConcurrent?: number; TotalCompletions?: number }
    GlobalJob?: Record<string, never>
  }
  UpdateConfig?: EngineUpdateConfig
  RollbackConfig?: EngineUpdateConfig
  EndpointSpec?: { Ports?: EnginePort[] }
}

export interface EngineService {
  ID: string
  Version?: EngineVersion
  CreatedAt?: string
  UpdatedAt?: string
  Spec?: EngineServiceSpec
  PreviousSpec?: EngineServiceSpec
  Endpoint?: { Ports?: EnginePort[] }
  UpdateStatus?: { State?: string; StartedAt?: string; CompletedAt?: string; Message?: string }
  ServiceStatus?: { RunningTasks?: number; DesiredTasks?: number; CompletedTasks?: number }
}

export interface EngineTask {
  ID: string
  Version?: EngineVersion
  CreatedAt?: string
  UpdatedAt?: string
  ServiceID?: string
  Slot?: number
  NodeID?: string
  Labels?: Record<string, string>
  Spec?: { ContainerSpec?: { Image?: string }; ForceUpdate?: number }
  Status?: {
    Timestamp?: string
    State?: string
    Message?: string
    Err?: string
    ContainerStatus?: { ContainerID?: string; PID?: number; ExitCode?: number }
  }
  DesiredState?: string
}

export interface EngineNode {
  ID: string
  Version?: EngineVersion
  CreatedAt?: string
  UpdatedAt?: string
  Spec?: { Name?: string; Labels?: Record<string, string>; Role?: string; Availability?: string }
  Description?: {
    Hostname?: string
    Platform?: { Architecture?: string; OS?: string }
    Resources?: { NanoCPUs?: number; MemoryBytes?: number }
    Engine?: { EngineVersion?: string; Labels?: Record<string, string> }
  }
  Status?: { State?: string; Message?: string; Addr?: string }
  ManagerStatus?: { Leader?: boolean; Reachability?: string; Addr?: string }
}

export interface EngineClusterSpec {
  Name?: string
  Orchestration?: { TaskHistoryRetentionLimit?: number }
  Raft?: {
    SnapshotInterval?: number
    KeepOldSnapshots?: number
    LogEntriesForSlowFollowers?: number
    ElectionTick?: number
    HeartbeatTick?: number
  }
  Dispatcher?: { HeartbeatPeriod?: number }
  CAConfig?: { NodeCertExpiry?: number; ExternalCAs?: unknown[] }
  EncryptionConfig?: { AutoLockManagers?: boolean }
}

export interface EngineCluster {
  ID?: string
  Version?: EngineVersion
  CreatedAt?: string
  UpdatedAt?: string
  Spec?: EngineClusterSpec
  RootRotationInProgress?: boolean
  DataPathPort?: number
  DefaultAddrPool?: string[]
  SubnetSize?: number
}

export interface EngineInfo {
  Name?: string
  Swarm?: {
    NodeID?: string
    NodeAddr?: string
    LocalNodeState?: string
    ControlAvailable?: boolean
    Error?: string
    Nodes?: number
    Managers?: number
    Cluster?: EngineCluster
  }
}

export interface EngineContainerSummary {
  Id: string
  Names?: string[]
  Image?: string
  ImageID?: string
  Created?: number
  Ports?: Array<{ IP?: string; PrivatePort?: number; PublicPort?: number; Type?: string }>
  Labels?: Record<string, string>
  State?: string
  Status?: string
}

export interface EngineHealthLog {
  Start?: string
  End?: string
  ExitCode?: number
  Output?: string
}

export interface EngineContainerInspect {
  Id: string
  Created?: string
  Name?: string
  RestartCount?: number
  Image?: string
  State?: {
    Status?: string
    Running?: boolean
    Restarting?: boolean
    ExitCode?: number
    Error?: string
    StartedAt?: string
    FinishedAt?: string
    Health?: { Status?: string; FailingStreak?: number; Log?: EngineHealthLog[] }
  }
  Config?: { Image?: string; Labels?: Record<string, string> }
}

export interface EngineSecret {
  ID: string
  Version?: EngineVersion
  CreatedAt?: string
  UpdatedAt?: string
  Spec?: { Name?: string; Labels?: Record<string, string>; Driver?: unknown; Data?: string }
}

/** `repo/name:tag@sha256:<hex>` → name without the digest, and a 12-character digest. */
export function splitImage(ref: string | null | undefined): {
  image: string | null
  digest: string | null
} {
  if (!ref) return { image: null, digest: null }
  const at = ref.indexOf('@')
  if (at < 0) return { image: ref, digest: null }
  const hex = ref.slice(at + 1).replace(/^sha256:/, '')
  return { image: ref.slice(0, at) || null, digest: hex ? hex.slice(0, 12) : null }
}

export const shortId = (id: string | null | undefined): string | null =>
  id ? id.replace(/^sha256:/, '').slice(0, 12) : null

/** Swarm published ports as `8080:80/tcp (ingress)`. */
export function formatSwarmPorts(ports: EnginePort[] | null | undefined): string[] {
  return (ports ?? [])
    .filter((p) => p.TargetPort != null)
    .map((p) => {
      const left = p.PublishedPort ? `${p.PublishedPort}:` : ''
      const mode = p.PublishMode && p.PublishMode !== 'ingress' ? ` (${p.PublishMode})` : ''
      return `${left}${p.TargetPort}/${p.Protocol ?? 'tcp'}${mode}`
    })
}

/** Container ports as `0.0.0.0:8080:80/tcp`, de-duplicated across IPv4/IPv6 bindings. */
export function formatContainerPorts(ports: EngineContainerSummary['Ports']): string[] {
  const out = new Set<string>()
  for (const p of ports ?? []) {
    if (p.PrivatePort == null) continue
    out.add(
      p.PublicPort
        ? `${p.PublicPort}:${p.PrivatePort}/${p.Type ?? 'tcp'}`
        : `${p.PrivatePort}/${p.Type ?? 'tcp'}`
    )
  }
  return [...out]
}

export const ms = (iso: string | null | undefined): number | null => {
  if (!iso || iso.startsWith('0001-')) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** A real timestamp or null (Docker writes 0001-01-01 for "never"). */
export const iso = (v: string | null | undefined): string | null =>
  ms(v) == null ? null : (v as string)

export function containerName(c: { Names?: string[]; Name?: string }): string {
  const n = c.Names?.[0] ?? c.Name ?? ''
  return n.replace(/^\//, '')
}

/** Desired replica count from the service mode (global = one per eligible node, unknown here). */
export function desiredReplicas(s: EngineService): number | null {
  if (s.ServiceStatus?.DesiredTasks != null) return s.ServiceStatus.DesiredTasks
  return s.Spec?.Mode?.Replicated?.Replicas ?? null
}

export function serviceMode(s: EngineService): 'replicated' | 'global' | 'job' {
  const m = s.Spec?.Mode
  if (m?.Global) return 'global'
  if (m?.ReplicatedJob || m?.GlobalJob) return 'job'
  return 'replicated'
}
