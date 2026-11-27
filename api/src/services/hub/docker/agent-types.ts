/**
 * Wire contract of the Hub agent, API v1 (Hub phase 4, plan "Wire contract"). The agent
 * (packages/hub-agent) is built separately; these are the Hub's copies of the shapes it answers
 * and accepts. Types only — importing this file runs nothing.
 */

/** The agent API version this Hub speaks. `GET /v1/health` answering another one is refused. */
export const AGENT_API_VERSION = 1

export type StackRoleName = 'all' | 'web' | 'worker' | 'realtime' | 'importer' | 'exporter'

export interface StackRole {
  role: StackRoleName
  /** 0..10; the total over roles ≤ 30; roles unique; 'all' alone. */
  replicas: number
  /** 0.1..16 */
  cpus?: number
  /** 128..65536 */
  memory_mb?: number
  /** Only SOCKETS, CRON_TICKS, IMPORT_WORKER, MEDIA_WORKER, VIDEO_RENDER. */
  env?: Record<string, string>
}

/** What the Hub asks the agent to run as one stack (`PUT /v1/stacks/:name`). */
export interface StackSpec {
  /** ^[a-z][a-z0-9-]{1,62}$ */
  owner: { app: string } | { shared: string }
  /** Same rule as the owner key. */
  environment: string
  /** <repo>@sha256:<64 hex>, repo in the agent's allow-list. */
  image: string
  roles: StackRole[]
  /** Keys ^[A-Z][A-Z0-9_]{0,63}$, ≤ 200 keys, values ≤ 4 KB. */
  env: Record<string, string>
  /** Same key rule, ≤ 50, values ≤ 64 KB. Mounted as swarm secrets at /run/secrets/<KEY>. */
  secrets: Record<string, string>
  /** ≤ 10 DNS names, each ending with an agent suffix (traefik mode); may be empty (B5). */
  hostnames: string[]
  redis: 'bundled' | 'external'
  /** ^[a-z0-9][a-z0-9-]{0,62}$ → <repo>@sha256:<64 hex>. */
  extensions: Record<string, string>
  /** Publish mode only, inside HUB_AGENT_PUBLISH_PORTS. */
  publish_port?: number
  /**
   * Phase 6, `owner.shared` + traefik edge only: `*.<name>` with <name> equal to or under an agent
   * suffix (e.g. '*.apps.example.com'). The agent renders a Traefik v3 HostRegexp router with
   * priority=1 (any Host() router beats it) and, with a cert resolver, a wildcard TLS domain
   * (needs a DNS challenge). Not a host claim. On a shared owner the traefik edge takes
   * `hostnames: []` only with a pattern (ruling B5); app owners may send `[]` (no router).
   */
  host_pattern?: string
  /** Agent 0.2.3: an EXISTING folder under the agent's NFS export used as-is for uploads. */
  uploads_folder?: string
  /** Agent 0.2.3: STORAGE_LOCAL_ROOT = `/app/uploads/<files_subfolder>`. */
  files_subfolder?: string
  /** Agent 0.2.3: the app services run as uid 1000 from the start (ContainerSpec.User). */
  run_as?: 'app'
  /**
   * Agent 0.2.5 (gap G-D): the certificate Traefik serves for this stack's names — the PEM chain
   * and its unencrypted key (an ACME certificate bound to EDGE_TLS_CERT / EDGE_TLS_KEY). The agent
   * writes it to the stack's file in HUB_AGENT_TRAEFIK_DYNAMIC_DIR; the routers carry `tls=true`
   * and no cert resolver. App owners, traefik edge; the leaf covers every hostname.
   */
  edge_tls?: { cert: string; key: string }
}

/** `GET /v1/health` */
export interface AgentHealth {
  api: number
  agent_version: string
  engine_api: string
  /** nodes (P4-33): how many nodes the swarm has; null/absent = unknown (an older agent). */
  swarm: { manager: boolean; node_id: string; nodes?: number | null }
  /** P4-33: HUB_AGENT_VOLUME_DRIVER (`local` = one copy per node). Absent on an older agent. */
  volume_driver?: string
  /** Hub gap sqlite (M5): the uploads volume is an NFS export. Absent on an older agent. */
  uploads_network?: boolean
  images: string[]
  host_suffixes: string[]
  edge: 'traefik' | 'publish'
  publish_ports: [number, number] | null
  extensions_shared: boolean
  redis_bundled: boolean
  /**
   * HUB_AGENT_ENV_PREFIXES (ruling P4-23): env key prefixes a stack may set on top of the Nivaro
   * app's known config keys. Absent on an agent before P4-23 = none.
   */
  env_prefixes?: string[]
  /** HUB_AGENT_TRAEFIK_VERSION (final review M-7). Absent on an older agent (= 3, its default). */
  traefik_version?: 2 | 3
  /**
   * Agent 0.2.3: uploads sit on an NFS export, one folder per stack (every node mounts the same
   * files, so a `local` volume_driver is not per node then). Absent on an older agent.
   */
  volume_nfs?: boolean
  /** Agent 0.2.3: the agent sees the export (HUB_AGENT_VOLUME_EXPORT_MOUNT) to check folders. */
  export_mount?: boolean
  /** Agent 0.2.3: bundled Redis's volume driver (never NFS). */
  redis_volume_driver?: string
  /** Agent 0.2.3: bundled Redis runs only on nodes with this label (`key=value`); null = any. */
  redis_pin_label?: string | null
  /** Agent 0.2.4: POST /v1/stacks/:name/scale and the bounds it holds every role to. */
  scale?: AgentScaleCaps
  /** Agent 0.2.5: HUB_AGENT_TRAEFIK_DYNAMIC_DIR is set, so a stack may carry `edge_tls`. */
  edge_tls?: boolean
}

/** Agent 0.2.4 (`GET /v1/health` `scale`). */
export interface AgentScaleCaps {
  max_replicas: number
  max_total_replicas: number
  cpus: [number, number]
  memory_mb: [number, number]
  /** Roles whose replica count a scale never changes (worker, all). */
  fixed_replica_roles: string[]
}

/** One row of `GET /v1/stacks` (Hub-managed stacks only). */
export interface StackSummary {
  name: string
  owner: { app: string } | { shared: string }
  environment: string
  image: string | null
  services: number
}

export type StackState = 'converged' | 'updating' | 'rolled_back' | 'paused' | 'degraded'

export type StackServiceUpdate =
  | 'none'
  | 'updating'
  | 'completed'
  | 'paused'
  | 'rollback_started'
  | 'rollback_completed'
  | 'rollback_paused'

export interface StackServiceStatus {
  name: string
  role: string
  image: string
  replicas: { desired: number; running: number }
  update: StackServiceUpdate
  message: string | null
}

/** `GET /v1/stacks/:name?expect=<hash>` */
export interface StackStatus {
  name: string
  owner: { app: string } | { shared: string }
  environment: string
  spec_hash: string | null
  image: string | null
  state: StackState
  published_port: number | null
  services: StackServiceStatus[]
}

/** `PUT /v1/stacks/:name` → 202 */
export interface StackApplyResult {
  spec_hash: string
  changed: string[]
  unchanged: string[]
  /** Agent 0.2.5: what the apply did to the stack's certificate file (never its text). */
  edge_tls?: 'written' | 'unchanged' | 'removed'
}

/** One role a scale changes (agent 0.2.4): only replicas and limits. */
export interface StackScaleChange {
  role: StackRoleName
  replicas?: number
  cpus?: number
  memory_mb?: number
}

/** `POST /v1/stacks/:name/scale` → 202 (changed) or 200 (`already`: it ran that spec). */
export interface StackScaleResult extends StackApplyResult {
  already: boolean
}

/** `POST /v1/stacks/:name/restart` → 202 */
export interface StackRestartResult {
  services: string[]
}

/** The contract names the removed kinds, not their shape: the names, or a count. */
export type RemovedObjects = string[] | number

/** `DELETE /v1/stacks/:name?confirm=<name>[&remove_volumes=1]` → 200 */
export interface StackRemoveResult {
  removed: {
    services: RemovedObjects
    secrets: RemovedObjects
    networks: RemovedObjects
    volumes: RemovedObjects
  }
  /** Agent 0.2.3: volumes on an NFS export, kept (their files are on the share). */
  kept_volumes?: string[]
}

/**
 * `GET /v1/stacks/:name/leftovers?app=<app>&environment=<env>` → 200: what of a stack is still
 * there (names), services gone or not; the extensions folder on the agent's host as a flag.
 */
export interface StackLeftovers {
  services: string[]
  secrets: string[]
  networks: string[]
  volumes: string[]
  /**
   * Agent 0.2.3: the stack's volumes on an NFS export. Not leftovers to clear: the agent never
   * removes them (their files are on the share) and they never block a delete.
   */
  share_volumes?: string[]
  extensions: boolean
  /**
   * Agent 0.2.1: the stack's tasks whose containers have not ended (draining ones included),
   * across the swarm. Absent from an older agent.
   */
  tasks_active?: number
}

/** One refused field of a 400 `SPEC_INVALID`. */
export interface AgentFieldError {
  field: string
  code: string
}
