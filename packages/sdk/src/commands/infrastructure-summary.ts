/**
 * Infrastructure summaries (admin, read-only): the compact answers behind Ask AI's infra_*
 * tools — stacks, container restarts, rolling updates, swarm nodes, disk use, log growth,
 * reboot survivability, host health, proxy routers, container throttling, secret usage by
 * name, GitLab, stack drift. Secret values are never returned.
 */
import { type Command, cmd } from '../command.js'

export type InfrastructureSummaryTool =
  | 'infra_stacks'
  | 'infra_containers'
  | 'infra_updates'
  | 'infra_swarm'
  | 'infra_storage'
  | 'infra_logs'
  | 'infra_reboot'
  | 'infra_hosts'
  | 'infra_proxy'
  | 'infra_resources'
  | 'infra_secrets'
  | 'infra_gitlab'
  | 'infra_drift'

/** One summary. `host` limits it to a Docker host, `limit` caps the rows, `window` is 24h or 7d (resources). */
export function readInfrastructureSummary(
  tool: InfrastructureSummaryTool,
  query?: { host?: string; limit?: number; window?: '24h' | '7d' }
): Command<{ data: Record<string, unknown> }> {
  const params: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') params[k] = v
  return cmd('GET', `/infrastructure/summary/${tool}`, params)
}
