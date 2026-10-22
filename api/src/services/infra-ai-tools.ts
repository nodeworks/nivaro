// api/src/services/infra-ai-tools.ts
/**
 * Infrastructure tools for Ask AI and the ops assistant (#2842): read-only answers to "what
 * restarted today and why", "what is eating /var", "would anything stay down after a reboot",
 * "which routers have no healthy backend", "which containers are throttled".
 *
 * Every tool calls the infrastructure SERVICES directly (the same ones behind the admin
 * /api/infrastructure routes), so nothing here goes over HTTP and nothing here can write. Output
 * is compact (counts plus the top N rows), error text is scrubbed, and no tool ever returns a
 * secret value, a config body, a swarm join token, an environment block or a label value:
 * the secrets tool returns names and used-by only. A tool whose source is not set up answers
 * `{ configured: false, note }` instead of failing.
 *
 * telemetry-ai.ts offers these beside the telemetry tools; the callers (the Telemetry page and
 * the admin-only ops chat) have already checked the asker is an administrator.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { scrubText } from './ai-explain.js'
import { loadContainerResources, resourcesAvailable } from './container-resources.js'
import { loadContainers, loadImages, loadVolumes } from './docker-inventory.js'
import { type DockerHost, dockerHosts } from './docker-source.js'
import { gitlabTarget, loadGitlabHealth } from './gitlab-health.js'
import { hungStatus, patchStatus, readHostFacts } from './host-facts.js'
import { logsReport, rebootReport } from './infra-host-checks.js'
import { type HealthStore, loadHealthDetail, loadHealthList } from './infra-swarm/health.js'
import { loadSecrets } from './infra-swarm/secrets.js'
import { loadStacks } from './infra-swarm/stacks.js'
import { loadSwarm, readCertMetrics } from './infra-swarm/swarm.js'
import { loadUpdates } from './infra-swarm/updates.js'
import { loadProxyView, traefikConfigured } from './traefik-source.js'

export class InfraToolError extends Error {}

export interface InfraToolContext {
  /** The Redis the health and rollout history rings live in (app.redis). */
  redis?: HealthStore | null
}

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 25
const NO_DOCKER = 'No Docker host is connected to this instance (DOCKER_HOSTS is not set).'

// ── Helpers ──────────────────────────────────────────────────────────────────

const limitOf = (input: Record<string, unknown>): number => {
  const n = Number(input.limit)
  return Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(1, Math.round(n))) : DEFAULT_LIMIT
}

/** Plain text from an engine: scrubbed and cut. */
function txt(v: unknown, max = 200): string | null {
  if (v == null || v === '') return null
  const s = scrubText(String(v)).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

const notConfigured = (note: string) => ({ configured: false, note })

/** Runs `fn` on every Docker host (or the one named in `host`); a host that fails reports its error. */
async function perHost<T>(
  input: Record<string, unknown>,
  fn: (host: DockerHost) => Promise<T>
): Promise<{ configured: boolean; note?: string; hosts?: Array<Record<string, unknown>> }> {
  const all = dockerHosts()
  if (all.length === 0) return notConfigured(NO_DOCKER)
  const want = typeof input.host === 'string' && input.host.trim() ? input.host.trim() : null
  const chosen = want ? all.filter((h) => h.name === want) : all
  if (chosen.length === 0)
    throw new InfraToolError(`Unknown host "${want}". Hosts: ${all.map((h) => h.name).join(', ')}`)
  const hosts = await Promise.all(
    chosen.map(async (h) => {
      try {
        return { host: h.name, ...(((await fn(h)) as object) ?? {}) }
      } catch (err) {
        return { host: h.name, error: txt((err as Error)?.message ?? err, 240) }
      }
    })
  )
  return { configured: true, hosts }
}

const iso = (ms: number | null | undefined): string | null =>
  ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString()

/** `Up 5 minutes` / `Up About an hour` → seconds, else null. */
export function uptimeSeconds(status: string | null | undefined): number | null {
  const m = /^Up (?:(\d+)|(a|an|about an?)) (second|minute|hour|day|week|month)s?/i.exec(
    status ?? ''
  )
  if (!m) return null
  const n = m[1] ? Number(m[1]) : 1
  const unit = { second: 1, minute: 60, hour: 3600, day: 86_400, week: 604_800, month: 2_592_000 }[
    m[3].toLowerCase() as 'second'
  ]
  return n * unit
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const common = {
  host: { type: 'string', description: 'Only this Docker host (its name); default all hosts.' },
  limit: {
    type: 'integer',
    description: `How many rows to list per host, ${DEFAULT_LIMIT} by default, up to ${MAX_LIMIT}.`
  }
} as const

export const INFRA_TOOLS: Anthropic.Tool[] = [
  {
    name: 'infra_stacks',
    description:
      'Swarm stacks and compose projects per Docker host: service and container counts, which services are failing and why, and each failing service\'s newest failed tasks (node, state, engine error, exit code, when). Start here for "is anything down?".',
    input_schema: { type: 'object', properties: { ...common } }
  },
  {
    name: 'infra_containers',
    description:
      'Container health and restarts per host: containers that are unhealthy or flapped in the last 24 hours (with restart count and the last failing probe), containers that started in the last 24 hours (a restart or a deploy), and containers that are not running with their exit status. Use for "what restarted today and why".',
    input_schema: { type: 'object', properties: { ...common } }
  },
  {
    name: 'infra_updates',
    description:
      'Swarm rolling updates: services mid-update, updates that paused or rolled back (and what the failure action did), and replacements that failed or needed retries. Use for "did the deploy go cleanly?".',
    input_schema: { type: 'object', properties: { ...common } }
  },
  {
    name: 'infra_swarm',
    description:
      'Swarm nodes per manager host: managers and workers, availability, state, reachability, the leader, and the node certificate expiry from the host facts. Use for "is the swarm healthy?" and "when do node certificates expire?".',
    input_schema: { type: 'object', properties: { host: common.host } }
  },
  {
    name: 'infra_storage',
    description:
      'Docker disk use per host: volumes (largest, orphaned ones, reclaimable bytes), images (in use / unused / dangling bytes), build cache and what a prune would free. Use for "what is eating disk" and "what can be reclaimed". For container log growth use infra_logs.',
    input_schema: { type: 'object', properties: { ...common } }
  },
  {
    name: 'infra_logs',
    description:
      'Container log volume per host: the filesystem under Docker (free, size), total log bytes, growth per day, days until full, containers without log rotation (json-file with no max-size) and the biggest logs. Use for "what is eating /var" and "which containers have no rotation".',
    input_schema: { type: 'object', properties: { ...common } }
  },
  {
    name: 'infra_reboot',
    description:
      'Reboot survivability per host: for every running container whether it would come back after a host reboot (restart policy or swarm service, remote mounts Docker does not wait for), the ones that would stay down or come back broken with the reason, and host-level boot risks. Use for "would anything stay down after a reboot".',
    input_schema: { type: 'object', properties: { ...common } }
  },
  {
    name: 'infra_hosts',
    description:
      'Host health from the host facts collector: kernel running vs installed, reboot required, days since boot, free space on /boot, security updates, processes stuck in IO wait, kernel hung-task messages and NFS servers not responding, per host. Use for "does any host need a reboot / is any host hung".',
    input_schema: { type: 'object', properties: { host: common.host } }
  },
  {
    name: 'infra_proxy',
    description:
      'Traefik routers and services: routers whose service has no healthy backend, routers shadowed by another, provider errors and routers returning 5xx. Use for "which routers have no healthy backend".',
    input_schema: { type: 'object', properties: { limit: common.limit } }
  },
  {
    name: 'infra_resources',
    description:
      'Container CPU and memory from cAdvisor (24 hours or 7 days): containers being CPU throttled, close to their memory limit or with out-of-memory kills, with the share of time throttled and memory headroom. Use for "which containers are throttled / short on memory".',
    input_schema: {
      type: 'object',
      properties: {
        window: { type: 'string', enum: ['24h', '7d'] },
        limit: common.limit
      }
    }
  },
  {
    name: 'infra_secrets',
    description:
      'Swarm secrets and configs by NAME only, never contents: which services use each, which are unused, and which services still use an older version while a newer one exists. Use for "is any secret unused / stale".',
    input_schema: { type: 'object', properties: { ...common } }
  },
  {
    name: 'infra_gitlab',
    description:
      'The self-hosted GitLab: health checks, version, CI runners (online / offline / stale), pending job queue and the GitLab container\'s resources. Use for "is CI healthy?".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'infra_drift',
    description:
      'Stack drift: per stack and environment, the last deploy baseline (version, release, when), the last nightly check, and each service field whose live spec no longer matches it (image, env variable NAMES, mounts, secrets, replicas, limits, placement, healthcheck, update config, labels), marked hand-run when a docker service update changed it after the deploy. Env values are never returned. Use for "did anyone change production by hand?".',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: `How many findings to list per stack, ${DEFAULT_LIMIT} by default, up to ${MAX_LIMIT}.`
        }
      }
    }
  }
]

export const INFRA_TOOL_NAMES = new Set(INFRA_TOOLS.map((t) => t.name))

// ── Tools ────────────────────────────────────────────────────────────────────

async function stacksTool(input: Record<string, unknown>) {
  const n = limitOf(input)
  return perHost(input, async (h) => {
    const s = await loadStacks(h)
    const failing = s.stacks
      .flatMap((g) => g.services.map((svc) => ({ stack: g.name, svc })))
      .filter((x) => x.svc.failing)
      .slice(0, n)
      .map(({ stack, svc }) => ({
        stack,
        service: svc.short_name,
        mode: svc.mode,
        running: svc.running,
        desired: svc.desired,
        reason: txt(svc.failing_reason),
        update: svc.update_status
          ? { state: svc.update_status.state, message: txt(svc.update_status.message) }
          : null,
        failed_tasks: svc.tasks
          .filter((t) => t.error || ['failed', 'rejected', 'orphaned'].includes(t.state ?? ''))
          .slice(0, 3)
          .map((t) => ({
            slot: t.slot,
            node: t.node,
            state: t.state,
            error: txt(t.error ?? t.message),
            exit_code: t.exit_code,
            at: t.state_at
          }))
      }))
    const failingContainers = s.projects
      .flatMap((p) => p.containers.filter((c) => c.failing).map((c) => ({ p, c })))
      .slice(0, n)
      .map(({ p, c }) => ({
        project: p.name,
        container: c.name,
        state: c.state,
        status: txt(c.status),
        health: c.health,
        exit_code: c.exit_code
      }))
    return {
      swarm: s.swarm,
      counts: s.counts,
      failing_services: failing,
      failing_containers: failingContainers
    }
  })
}

async function containersTool(input: Record<string, unknown>, ctx: InfraToolContext) {
  const n = limitOf(input)
  return perHost(input, async (h) => {
    const out: Record<string, unknown> = {}
    const rows = await loadContainers(h).catch(() => null)
    if (rows) {
      const started = rows
        .map((c) => ({ c, up: c.state === 'running' ? uptimeSeconds(c.status) : null }))
        .filter((x): x is { c: (typeof rows)[number]; up: number } => x.up != null && x.up < 86_400)
        .sort((a, b) => a.up - b.up)
      out.started_last_24h = {
        total: started.length,
        rows: started.slice(0, n).map(({ c, up }) => ({
          name: c.name,
          owner: c.owner.label,
          status: txt(c.status),
          up_seconds: up,
          restart_policy: c.restart_policy
        }))
      }
      const stopped = rows.filter((c) => c.state !== 'running')
      out.not_running = {
        total: stopped.length,
        rows: stopped.slice(0, n).map((c) => ({
          name: c.name,
          owner: c.owner.label,
          state: c.state,
          status: txt(c.status),
          restart_policy: c.restart_policy
        }))
      }
    }
    if (!ctx.redis) {
      out.health_history = 'Health history is not available (Redis is not connected).'
      return out
    }
    const health = await loadHealthList(ctx.redis, h)
    const bad = health.containers
      .filter((c) => c.health === 'unhealthy' || c.unhealthy_24h > 0)
      .sort((a, b) => b.unhealthy_24h - a.unhealthy_24h)
    const detail = await Promise.all(
      bad.slice(0, 3).map((c) =>
        loadHealthDetail(ctx.redis as HealthStore, h, c.id)
          .then((d) => ({
            name: c.name,
            restart_count: d.restart_count,
            started_at: d.started_at,
            failing_streak: d.failing_streak,
            last_probe: d.probes.length
              ? {
                  exit_code: d.probes[d.probes.length - 1].exit_code,
                  output: txt(d.probes[d.probes.length - 1].output)
                }
              : null
          }))
          .catch(() => null)
      )
    )
    out.health = {
      counts: health.counts,
      unhealthy_or_flapping: {
        total: bad.length,
        rows: bad.slice(0, n).map((c) => ({
          name: c.name,
          stack: c.stack,
          service: c.service ?? c.project,
          version: c.version,
          health: c.health,
          unhealthy_24h: c.unhealthy_24h,
          last_change_at: c.last_change_at
        }))
      },
      worst_detail: detail.filter(Boolean),
      versions_with_failures: health.trend
        .filter((t) => t.unhealthy_3d > 0)
        .slice(0, 5)
        .map((t) => ({
          version: t.version,
          unhealthy_now: t.unhealthy_now,
          unhealthy_3d: t.unhealthy_3d
        }))
    }
    return out
  })
}

async function updatesTool(input: Record<string, unknown>, ctx: InfraToolContext) {
  const n = limitOf(input)
  return perHost(input, async (h) => {
    const u = await loadUpdates(ctx.redis ?? null, h)
    if (!u.manager) return { manager: false, note: 'Not a swarm manager; nothing to report.' }
    const interesting = u.services
      .map((s) => {
        const trouble = s.replacements.filter((r) => r.new.error || r.new.attempts > 1)
        return { s, trouble }
      })
      .filter(
        ({ s, trouble }) =>
          s.in_flight ||
          s.failure_fired ||
          trouble.length > 0 ||
          ['paused', 'rollback_started', 'rollback_completed', 'rollback_paused'].includes(
            s.update?.state ?? ''
          )
      )
    return {
      manager: true,
      in_flight: u.in_flight,
      services: u.services.length,
      attention: interesting.slice(0, n).map(({ s, trouble }) => ({
        service: s.name,
        stack: s.stack,
        image: s.image,
        state: s.update?.state ?? null,
        message: txt(s.update?.message),
        in_flight: s.in_flight,
        failure_action: s.policy.failure_action,
        failure_fired: txt(s.failure_fired),
        last_run: s.history[0]
          ? {
              started_at: s.history[0].started_at,
              duration_ms: s.history[0].duration_ms,
              failed_tasks: s.history[0].failed,
              tasks: s.history[0].tasks
            }
          : null,
        problem_replacements: trouble.slice(0, 3).map((r) => ({
          slot: r.slot,
          node: r.node,
          state: r.new.state,
          error: txt(r.new.error),
          attempts: r.new.attempts
        }))
      }))
    }
  })
}

async function swarmTool(input: Record<string, unknown>) {
  const certs = await readCertMetrics()
  return perHost(input, async (h) => {
    const s = await loadSwarm(h, certs)
    return {
      state: s.state,
      manager: s.manager,
      counts: s.counts,
      // No node or cluster labels, addresses or join details: only roles and health.
      nodes: s.nodes.map((nd) => ({
        hostname: nd.hostname,
        role: nd.role,
        availability: nd.availability,
        state: nd.state,
        reachability: nd.reachability,
        leader: nd.leader,
        engine: nd.engine
      })),
      cert: s.cert,
      cert_source: s.cert_source,
      warnings: s.warnings.slice(0, 8).map((w) => txt(w))
    }
  })
}

async function storageTool(input: Record<string, unknown>) {
  const n = limitOf(input)
  return perHost(input, async (h) => {
    const [vol, img] = await Promise.all([
      loadVolumes(h).catch((e) => ({ error: txt((e as Error).message) })),
      loadImages(h).catch((e) => ({ error: txt((e as Error).message) }))
    ])
    const volumes =
      'volumes' in vol
        ? {
            reclaimable_bytes: vol.reclaimable_bytes,
            orphan_count: vol.orphan_count,
            largest: [...vol.volumes]
              .sort((a, b) => (b.size_bytes ?? -1) - (a.size_bytes ?? -1))
              .slice(0, n)
              .map((v) => ({
                name: v.name,
                kind: v.kind,
                size_bytes: v.size_bytes,
                owner: v.owner,
                orphaned: v.orphaned,
                backup: v.backup,
                flags: v.flags.map((f) => f.code)
              }))
          }
        : vol
    const images =
      'images' in img
        ? {
            totals: img.totals,
            build_cache: img.build_cache,
            prune_frees_bytes: img.prune.plain_bytes,
            prune_all_frees_bytes: img.prune.all_bytes,
            largest_unused: img.images
              .filter((i) => i.status !== 'in-use')
              .sort((a, b) => b.unique_bytes - a.unique_bytes)
              .slice(0, n)
              .map((i) => ({
                tags: i.tags.slice(0, 2),
                status: i.status,
                size_bytes: i.size_bytes,
                unique_bytes: i.unique_bytes
              }))
          }
        : img
    return { volumes, images }
  })
}

async function logsTool(input: Record<string, unknown>) {
  const n = limitOf(input)
  const want = typeof input.host === 'string' && input.host.trim() ? input.host.trim() : null
  if (dockerHosts().length === 0) return notConfigured(NO_DOCKER)
  const { hosts } = await logsReport()
  return {
    configured: true,
    hosts: hosts
      .filter((r) => !want || r.host === want)
      .map((r) => {
        if (!r.data) return { host: r.host, error: txt(r.error, 240) }
        const d = r.data
        return {
          host: r.host,
          facts_collected: d.facts_collected,
          filesystem: d.filesystem,
          total_log_bytes: d.total_bytes,
          growth_per_day: d.growth_per_day,
          days_until_full: d.days_until_full,
          without_rotation: d.unbounded,
          unbounded_containers: d.containers
            .filter((c) => c.unbounded)
            .slice(0, n)
            .map((c) => c.name),
          biggest: d.containers.slice(0, n).map((c) => ({
            name: c.name,
            bytes: c.bytes,
            growth_per_day: c.growth_per_day,
            driver: c.driver,
            max_size: c.max_size,
            unbounded: c.unbounded
          }))
        }
      })
  }
}

async function rebootTool(input: Record<string, unknown>) {
  const n = limitOf(input)
  const want = typeof input.host === 'string' && input.host.trim() ? input.host.trim() : null
  if (dockerHosts().length === 0) return notConfigured(NO_DOCKER)
  const { hosts } = await rebootReport()
  return {
    configured: true,
    hosts: hosts
      .filter((r) => !want || r.host === want)
      .map((r) => {
        if (!r.data) return { host: r.host, error: txt(r.error, 240) }
        const d = r.data
        return {
          host: r.host,
          summary: d.summary,
          counts: d.counts,
          stopped_containers: d.stopped,
          facts_collected: d.facts_collected,
          host_notes: d.host_notes.slice(0, 5).map((x) => txt(x, 240)),
          at_risk: d.containers
            .filter((c) => c.verdict !== 'comes_back')
            .slice(0, n)
            .map((c) => ({
              name: c.name,
              verdict: c.verdict,
              managed_by: c.managed_by,
              restart_policy: c.restart_policy,
              reason: txt(c.reason, 240),
              remote_mounts: c.remote_mounts.map((m) => m.mountpoint)
            }))
        }
      })
  }
}

async function hostsTool(input: Record<string, unknown>) {
  const want = typeof input.host === 'string' && input.host.trim() ? input.host.trim() : null
  const read = await readHostFacts()
  if (!read.store)
    return notConfigured('The telemetry store is not configured, so host facts are not collected.')
  const names = [...new Set([...dockerHosts().map((h) => h.name), ...read.facts.keys()])]
  const hosts = names
    .filter((name) => !want || name === want)
    .map((name) => {
      const f = read.facts.get(name) ?? null
      const sig = read.signals.get(name) ?? null
      if (!f || f.collected_at == null) return { host: name, collected: false }
      const p = patchStatus(f)
      const hung = hungStatus(f, sig)
      return {
        host: name,
        collected: true,
        stale: f.stale,
        collected_at: iso(f.collected_at),
        kernel_running: p.kernel_running,
        kernel_installed: p.kernel_installed,
        reboot_required: p.reboot_required,
        days_since_boot: p.days_since_boot,
        boot_free_bytes: p.boot_free_bytes,
        security_updates: p.security_updates,
        patch_level: p.level,
        patch_notes: p.notes.slice(0, 4).map((x) => txt(x, 240)),
        io: {
          level: hung.level,
          headline: txt(hung.headline, 240),
          dstate_processes: hung.dstate_processes,
          hung_task_events: hung.hung_task_events,
          nfs_not_responding: hung.nfs_not_responding.slice(0, 5),
          suspect_mount: hung.suspect_mount
        }
      }
    })
  if (want && hosts.length === 0) throw new InfraToolError(`Unknown host "${want}"`)
  return { configured: true, error: txt(read.error), hosts }
}

async function proxyTool(input: Record<string, unknown>) {
  if (!traefikConfigured())
    return notConfigured('Traefik is not connected (TRAEFIK_URL is not set).')
  const n = limitOf(input)
  const v = await loadProxyView()
  const unhealthy = v.routers.filter((r) => r.no_healthy_backend)
  return {
    configured: true,
    version: v.version,
    routers: v.routers.length,
    services: v.services.length,
    no_healthy_backend: {
      total: unhealthy.length,
      rows: unhealthy.slice(0, n).map((r) => ({
        router: r.name,
        rule: txt(r.rule, 140),
        service: r.service,
        servers: r.servers.length,
        servers_up: r.healthy,
        status: r.status,
        errors: r.errors.slice(0, 2).map((e) => txt(e))
      }))
    },
    services_with_down_servers: v.services
      .filter((s) => s.servers.length > 0 && s.healthy < s.servers.length)
      .slice(0, n)
      .map((s) => ({
        service: s.name,
        servers: s.servers.length,
        up: s.healthy,
        used_by: s.used_by.slice(0, 3)
      })),
    shadowed: v.shadowing.slice(0, n).map((s) => txt(s.sentence, 240)),
    provider_errors: v.provider_errors.slice(0, n).map((e) => ({
      router: e.router,
      provider: e.provider,
      errors: e.errors.slice(0, 2).map((x) => txt(x))
    })),
    returning_5xx: v.routers
      .filter((r) => (r.rps_5xx ?? 0) > 0)
      .sort((a, b) => (b.rps_5xx ?? 0) - (a.rps_5xx ?? 0))
      .slice(0, 5)
      .map((r) => ({ router: r.name, rps: r.rps, rps_5xx: r.rps_5xx }))
  }
}

async function resourcesTool(input: Record<string, unknown>) {
  if (!resourcesAvailable())
    return notConfigured(
      'The telemetry store is not configured, so container metrics are not collected.'
    )
  const n = limitOf(input)
  const window = input.window === '7d' ? '7d' : '24h'
  const rows = await loadContainerResources(window, null, false)
  const flagged = rows.filter((r) => r.flags.length > 0 || (r.oom_events ?? 0) > 0)
  const pick = (r: (typeof rows)[number]) => ({
    container: r.container,
    host: r.host,
    flags: r.flags,
    throttled_share: r.throttled_share,
    mem_share: r.mem_share,
    mem_bytes: r.mem_bytes,
    mem_limit_bytes: r.mem_limit_bytes,
    oom_events: r.oom_events,
    cpu_cores: r.cpu_cores
  })
  return {
    configured: true,
    window,
    containers: rows.length,
    throttled: rows
      .filter((r) => r.flags.includes('throttled'))
      .sort((a, b) => (b.throttled_share ?? 0) - (a.throttled_share ?? 0))
      .slice(0, n)
      .map(pick),
    near_memory_limit: rows
      .filter((r) => r.flags.includes('memory'))
      .sort((a, b) => (b.mem_share ?? 0) - (a.mem_share ?? 0))
      .slice(0, n)
      .map(pick),
    oom_kills: rows
      .filter((r) => (r.oom_events ?? 0) > 0)
      .slice(0, n)
      .map(pick),
    flagged_total: flagged.length
  }
}

async function secretsTool(input: Record<string, unknown>) {
  const n = limitOf(input)
  return perHost(input, async (h) => {
    const s = await loadSecrets(h)
    if (!s.manager) return { manager: false, note: 'Not a swarm manager; nothing to report.' }
    return {
      manager: true,
      counts: s.counts,
      unavailable: s.unavailable,
      // Names and used-by only; versions list ids and dates, never contents.
      groups: s.groups
        .filter((g) => g.stale.length > 0 || g.versions.some((v) => v.unused))
        .slice(0, n)
        .map((g) => ({
          kind: g.kind,
          name: g.base,
          versions: g.versions.length,
          latest: g.versions.find((v) => v.latest)?.name ?? null,
          used_by: [...new Set(g.versions.flatMap((v) => v.used_by.map((u) => u.service)))].slice(
            0,
            6
          ),
          unused_versions: g.versions
            .filter((v) => v.unused)
            .map((v) => v.name)
            .slice(0, 4),
          stale: g.stale
            .slice(0, 4)
            .map((x) => ({ service: x.service, uses: x.uses, latest: x.latest }))
        }))
    }
  })
}

/**
 * #2798 — stored drift findings (no live read: the nightly check and Check now do that). Env
 * fields name the variable only; no value of any env field is returned, secret or not.
 */
async function driftTool(input: Record<string, unknown>) {
  const n = limitOf(input)
  const { driftStatus } = await import('./infra-drift/store.js')
  const st = await driftStatus()
  if (!st.available)
    return notConfigured('Stack drift is not set up on this database (migration 500 not run).')
  if (st.stacks.length === 0)
    return {
      configured: true,
      note: `No baseline stored yet — the deploy script posts one after each deploy.${st.source_note ? ` ${st.source_note}` : ''}`,
      stacks: []
    }
  return {
    configured: true,
    live_source: st.docker_configured,
    note: st.source_note,
    stacks: st.stacks.map((s) => ({
      stack: s.stack,
      environment: s.environment,
      baseline: s.baseline,
      last_check: { ...s.last_check, message: txt(s.last_check.message, 240) },
      live_note: s.live_note,
      drift: s.drift,
      findings: s.findings.slice(0, n).map((f) => {
        const hide = f.secret || f.field.startsWith('env.')
        return {
          service: f.service,
          field: f.field,
          kind: f.kind,
          ...(hide ? {} : { expected: txt(f.expected, 160), actual: txt(f.actual, 160) }),
          origin: f.origin,
          first_seen: f.first_seen
        }
      })
    }))
  }
}

async function gitlabTool() {
  const target = await gitlabTarget()
  if (!target)
    return notConfigured('GitLab is not connected (no GitLab component in Environments).')
  const g = await loadGitlabHealth(target)
  const part = <T>(p: { ok: boolean; error: string | null; data: T | null } | null) =>
    p && !p.ok ? { unavailable: txt(p.error, 240) } : null
  return {
    configured: true,
    version: g.version?.data?.version ?? part(g.version),
    health: g.health?.data
      ? {
          ready: g.health.data.readiness?.ok ?? null,
          live: g.health.data.liveness,
          failing_checks: (g.health.data.readiness?.checks ?? [])
            .filter((c) => c.status !== 'ok')
            .map((c) => ({ name: c.name, status: c.status }))
        }
      : part(g.health),
    runners: g.runners?.data
      ? {
          counts: g.runners.data.counts,
          flagged: g.runners.data.runners
            .filter((r) => r.flagged)
            .slice(0, 8)
            .map((r) => ({ name: r.name, state: r.state, contacted_at: r.contacted_at }))
        }
      : part(g.runners),
    pending_jobs: g.pending?.data
      ? {
          count: g.pending.data.count,
          at_least: g.pending.data.at_least,
          oldest_age_s: g.pending.data.oldest_age_s
        }
      : part(g.pending),
    container: g.container?.data
      ? {
          registry_bytes: g.container.data.registry_bytes,
          containers: g.container.data.containers.slice(0, 3).map((c) => ({
            container: c.container,
            flags: c.flags,
            throttled_share: c.throttled_share,
            mem_share: c.mem_share,
            oom_events: c.oom_events
          }))
        }
      : part(g.container)
  }
}

/** Run one infrastructure tool. Throws InfraToolError for bad input (shown to the model). */
export async function executeInfraTool(
  name: string,
  input: Record<string, unknown>,
  ctx: InfraToolContext = {}
): Promise<unknown> {
  switch (name) {
    case 'infra_stacks':
      return stacksTool(input)
    case 'infra_containers':
      return containersTool(input, ctx)
    case 'infra_updates':
      return updatesTool(input, ctx)
    case 'infra_swarm':
      return swarmTool(input)
    case 'infra_storage':
      return storageTool(input)
    case 'infra_logs':
      return logsTool(input)
    case 'infra_reboot':
      return rebootTool(input)
    case 'infra_hosts':
      return hostsTool(input)
    case 'infra_proxy':
      return proxyTool(input)
    case 'infra_resources':
      return resourcesTool(input)
    case 'infra_secrets':
      return secretsTool(input)
    case 'infra_gitlab':
      return gitlabTool()
    case 'infra_drift':
      return driftTool(input)
    default:
      throw new InfraToolError(`Unknown infrastructure tool ${name}`)
  }
}

/** True when this instance has any infrastructure source to ask about. */
export function infraAvailable(): boolean {
  return dockerHosts().length > 0 || traefikConfigured() || resourcesAvailable()
}

export const INFRA_PROMPT = `Infrastructure tools (infra_*) read the Docker hosts, swarm, proxy and host health directly:
- "what restarted today and why": infra_containers (started in the last 24 hours, exit status, flapping health), then infra_stacks (failed tasks and engine errors) and infra_updates (rollouts that paused or rolled back).
- "what is eating /var / disk": infra_logs (log growth, containers without rotation, days until full), then infra_storage (volumes, images, reclaimable bytes).
- "would anything stay down after a reboot": infra_reboot; add infra_hosts for pending kernels and hung IO.
- "which routers have no healthy backend": infra_proxy.
- "which containers are throttled / short on memory": infra_resources.
- swarm nodes, manager reachability and certificate expiry: infra_swarm; secrets or configs unused or stale: infra_secrets (names only); CI health: infra_gitlab.
- "did anyone change a running service by hand / does production match the last deploy": infra_drift.
A tool that answers "configured: false" means that source is not set up on this instance: say so and do not guess. Never ask for or repeat secret values.`
