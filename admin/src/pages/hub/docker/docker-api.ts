import { type DataTag, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { HubDockerDriverConfig } from '../hub-api'

/**
 * Nivaro Hub (phase 4) — the Docker driver: types mirroring what the API answers for a Docker
 * driver and its agent check, the query key (all under ['hub','docker',…]) and the draft helpers
 * the driver form uses. Nothing here ever holds a stored token: the API only shows a mask.
 */

export type DnsMode = 'automatic' | 'manual'

/** `GET /api/hub/drivers/:id/agent` — what the Hub agent reports about itself. */
export interface HubAgentHealth {
  api: number
  agent_version: string
  engine_api: string
  /** nodes: how many nodes the swarm has (absent/null: an older agent or not read). */
  swarm: { manager: boolean; node_id: string; nodes?: number | null }
  /** The volume driver stacks get (`local` = one copy per node). */
  volume_driver?: string
  /** The Nivaro image repositories the agent may run. */
  images: string[]
  /** Host-name suffixes the agent routes (traefik edge). */
  host_suffixes: string[]
  edge: 'traefik' | 'publish'
  publish_ports: [number, number] | null
  extensions_shared: boolean
  redis_bundled: boolean
  /** Agent 0.2.2: uploads sit on an NFS export, one folder per stack (shared by every node). */
  volume_nfs?: boolean
  /** Agent 0.2.2: the agent sees the export (HUB_AGENT_VOLUME_EXPORT_MOUNT). */
  export_mount?: boolean
  /** Agent 0.2.2: bundled Redis's volume driver (never NFS). */
  redis_volume_driver?: string
}

/**
 * P4-33: a swarm of more than one node where stack volumes are `local` (one copy per node) —
 * not when the agent (0.2.2+) keeps uploads on an NFS export every node mounts.
 */
export const multiNodeLocal = (
  h: Pick<HubAgentHealth, 'swarm' | 'volume_driver' | 'volume_nfs'>
): boolean =>
  typeof h.swarm?.nodes === 'number' &&
  h.swarm.nodes > 1 &&
  (h.volume_driver ?? 'local') === 'local' &&
  h.volume_nfs !== true

export const MULTI_NODE_VOLUMES_TEXT =
  "This swarm has more than one node and stack volumes are local: each node keeps its own uploads and Redis data, and Remove stack deletes only the agent node's copies. Pin the stack to one node, or set a shared volume driver on the agent."

export const dockerKeys: {
  agent: (driverId: number) => DataTag<readonly ['hub', 'docker', 'agent', number], HubAgentHealth>
} = {
  agent: (driverId) =>
    ['hub', 'docker', 'agent', driverId] as unknown as DataTag<
      readonly ['hub', 'docker', 'agent', number],
      HubAgentHealth
    >
}

export const fetchAgentHealth = (driverId: number) =>
  api.get<{ data: HubAgentHealth }>(`/hub/drivers/${driverId}/agent`).then((r) => r.data.data)

/** The agent check is on demand (a button), never on a timer. */
export function useAgentCheck(driverId: number | null) {
  return useQuery({
    queryKey: dockerKeys.agent(driverId ?? 0),
    queryFn: () => fetchAgentHealth(driverId as number),
    enabled: false,
    retry: false,
    staleTime: 0
  })
}

/** What the driver form edits (strings only, so inputs stay controlled). */
export interface DockerDraft {
  agent_url: string
  dns_mode: DnsMode
  wildcard_domain: string
  edge_target: string
}

export const EMPTY_DOCKER_DRAFT: DockerDraft = {
  agent_url: '',
  dns_mode: 'automatic',
  wildcard_domain: '',
  edge_target: ''
}

export const dockerDraftOf = (c: Partial<HubDockerDriverConfig> | undefined): DockerDraft => ({
  agent_url: c?.agent_url ?? '',
  dns_mode: c?.dns_mode === 'manual' ? 'manual' : 'automatic',
  wildcard_domain: c?.wildcard_domain ?? '',
  edge_target: c?.edge_target ?? ''
})

/** The config body a docker driver save sends (the field the other DNS mode needs is omitted). */
export const dockerConfigBody = (d: DockerDraft) => ({
  agent_url: d.agent_url.trim().replace(/\/+$/, ''),
  dns_mode: d.dns_mode,
  wildcard_domain: d.dns_mode === 'automatic' ? d.wildcard_domain.trim() : null,
  edge_target: d.dns_mode === 'manual' ? d.edge_target.trim() : null
})

export function dockerDraftErrors(d: DockerDraft) {
  return {
    agent_url: /^https?:\/\/[^/\s?#]+\/?$/i.test(d.agent_url.trim())
      ? ''
      : "The Hub agent's address, e.g. https://swarm.example.com:8443",
    wildcard_domain:
      d.dns_mode === 'automatic' && !d.wildcard_domain.trim()
        ? 'The domain every stack name ends with, e.g. apps.example.com'
        : '',
    edge_target:
      d.dns_mode === 'manual' && !d.edge_target.trim()
        ? 'What each new name must point at, e.g. edge.example.com or an address'
        : ''
  }
}

/** 64 hex characters from the browser's secure random source (the agent token). */
export function generateAgentToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
