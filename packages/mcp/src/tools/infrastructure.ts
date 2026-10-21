/**
 * Infrastructure tools (#2842) — read-only answers about the Docker hosts, swarm, proxy and
 * host health, for administrators. Each rides GET /api/infrastructure/summary/:tool, which the
 * app gates to admins and serves the same compact figures Ask AI uses. Nothing here starts,
 * stops or changes anything, and no tool returns a secret value or config body (the secrets
 * tool lists names and which services use them).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type InfrastructureSummaryTool,
  type NivaroClient,
  readInfrastructureSummary
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ } from '../annotations.js'
import { fail, ok } from '../result.js'

const host = z.string().min(1).max(80).optional().describe('Only this Docker host (its name).')
const limit = z
  .number()
  .int()
  .min(1)
  .max(25)
  .optional()
  .describe('Rows to list per host, 8 by default.')

interface InfraToolSpec {
  name: InfrastructureSummaryTool
  title: string
  description: string
  inputs: Array<'host' | 'limit' | 'window'>
}

const SPECS: InfraToolSpec[] = [
  {
    name: 'infra_stacks',
    title: 'Stacks and failing services',
    description:
      'Swarm stacks and compose projects per Docker host: counts, the services that are failing and why, and each failing service\'s newest failed tasks (node, state, engine error, exit code). Start here for "is anything down?". Admin only.',
    inputs: ['host', 'limit']
  },
  {
    name: 'infra_containers',
    title: 'Container restarts and health',
    description:
      'Per Docker host: containers that started in the last 24 hours (a restart or deploy), containers that are not running with their exit status, and unhealthy or flapping containers with restart count and the last failing probe. Use for "what restarted today and why". Admin only.',
    inputs: ['host', 'limit']
  },
  {
    name: 'infra_updates',
    title: 'Rolling updates',
    description:
      'Swarm services mid-update, updates that paused or rolled back (and what the failure action did), and replacement tasks that failed or needed retries. Admin only.',
    inputs: ['host', 'limit']
  },
  {
    name: 'infra_swarm',
    title: 'Swarm nodes and certificates',
    description:
      'Swarm nodes per manager host: role, availability, state, reachability, the leader, and the node certificate expiry (from the host facts collector). No labels, addresses or join details. Admin only.',
    inputs: ['host']
  },
  {
    name: 'infra_storage',
    title: 'Docker disk use',
    description:
      'Per Docker host: the largest and orphaned volumes with reclaimable bytes, images by in-use / unused / dangling bytes, build cache and what a prune would free. For log growth use infra_logs. Admin only.',
    inputs: ['host', 'limit']
  },
  {
    name: 'infra_logs',
    title: 'Container log volume',
    description:
      'Per Docker host: free and total space under Docker, total log bytes, growth per day, days until full, containers with no log rotation (json-file without max-size) and the biggest logs. Use for "what is eating /var". Admin only.',
    inputs: ['host', 'limit']
  },
  {
    name: 'infra_reboot',
    title: 'Reboot survivability',
    description:
      'Per Docker host: whether each running container would come back after a host reboot (restart policy or swarm service, remote mounts Docker does not wait for), the ones that would stay down or come back broken with the reason, and host-level boot risks. Admin only.',
    inputs: ['host', 'limit']
  },
  {
    name: 'infra_hosts',
    title: 'Host health',
    description:
      'From the host facts collector, per host: kernel running vs installed, reboot required, days since boot, free space on /boot, security updates, processes stuck in IO wait, hung-task messages and NFS servers not responding. Admin only.',
    inputs: ['host']
  },
  {
    name: 'infra_proxy',
    title: 'Proxy routers',
    description:
      'Traefik routers whose service has no healthy backend, services with servers down, shadowed routers, provider errors and routers returning 5xx. Admin only.',
    inputs: ['limit']
  },
  {
    name: 'infra_resources',
    title: 'Container CPU and memory',
    description:
      'Containers being CPU throttled, close to their memory limit or killed for memory (cAdvisor, 24 hours or 7 days), with the share of time throttled and memory headroom. Admin only.',
    inputs: ['window', 'limit']
  },
  {
    name: 'infra_secrets',
    title: 'Secret and config usage',
    description:
      'Swarm secrets and configs by name only, never contents: which services use each, which are unused, and which services use an older version while a newer one exists. Admin only.',
    inputs: ['host', 'limit']
  },
  {
    name: 'infra_gitlab',
    title: 'GitLab health',
    description:
      "The self-hosted GitLab: health checks, version, CI runners (online / offline / stale), pending job queue and the GitLab container's resources. Admin only.",
    inputs: []
  }
]

/** The infrastructure tool names, registered with the admin tools (`adminTools: true`). */
export const INFRA_TOOL_NAMES = SPECS.map((s) => s.name)

export function registerInfrastructureTools(server: McpServer, client: NivaroClient) {
  for (const spec of SPECS) {
    const inputSchema: Record<string, z.ZodTypeAny> = {}
    if (spec.inputs.includes('host')) inputSchema.host = host
    if (spec.inputs.includes('limit')) inputSchema.limit = limit
    if (spec.inputs.includes('window'))
      inputSchema.window = z
        .enum(['24h', '7d'])
        .optional()
        .describe('Metrics window, 24h by default.')
    server.registerTool(
      spec.name,
      { title: spec.title, description: spec.description, inputSchema, annotations: READ },
      async (args: Record<string, unknown>) => {
        try {
          const res = await client.request(
            readInfrastructureSummary(
              spec.name,
              args as { host?: string; limit?: number; window?: '24h' | '7d' }
            )
          )
          return ok(res.data)
        } catch (err) {
          return fail(err)
        }
      }
    )
  }
}
