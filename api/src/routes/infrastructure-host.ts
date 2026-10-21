import type { FastifyInstance } from 'fastify'
import { dockerHosts } from '../services/docker-source.js'
import { hungStatus, patchStatus, readHostFacts } from '../services/host-facts.js'
import { logsReport, rebootReport } from '../services/infra-host-checks.js'
import { type ReadinessCheck, registerReadinessCheck } from '../services/readiness.js'

/**
 * Host health (#2836 #2837), reboot survivability (#2829) and container logs (#2831) under
 * /api/infrastructure (admin only via the parent's hook). Host facts come from the telemetry
 * store (deploy/host-facts/nivaro-host-facts.sh on each host); containers from the read-only
 * Docker source.
 */

/** Hosts tab: every Docker host plus any host the collector reports, with its verdicts. */
export async function hostsReport(nowMs = Date.now()) {
  const read = await readHostFacts(nowMs)
  const names = [
    ...new Set([...dockerHosts().map((h) => h.name), ...read.facts.keys(), ...read.signals.keys()])
  ]
  return {
    store: read.store,
    error: read.error,
    hosts: names.map((host) => {
      const f = read.facts.get(host) ?? null
      const s = read.signals.get(host) ?? null
      return {
        host,
        docker: dockerHosts().some((h) => h.name === host),
        collected_at: f?.collected_at ?? null,
        stale: f ? f.stale : true,
        swarm_cert_expiry: f?.swarm_cert_expiry ?? null,
        patch: patchStatus(f, nowMs),
        hung: hungStatus(f, s)
      }
    })
  }
}

export const rebootSurvivabilityCheck: ReadinessCheck = {
  id: 'reboot-survivability',
  label: 'Containers come back after a host reboot',
  group: 'Infrastructure',
  description:
    'Every running container on each Docker host, judged on its restart policy (or its swarm service) and on remote mounts Docker does not wait for at boot.',
  ttlMs: 15 * 60_000,
  run: async () => {
    if (dockerHosts().length === 0)
      return { status: 'skip', detail: 'No Docker host is connected (DOCKER_HOSTS).' }
    const { hosts } = await rebootReport()
    const blockers: string[] = []
    let down = 0
    let broken = 0
    let total = 0
    const failed: string[] = []
    for (const h of hosts) {
      if (!h.data) {
        failed.push(`${h.host}: ${h.error}`)
        continue
      }
      total += h.data.containers.length
      broken += h.data.counts.may_break
      for (const c of h.data.containers)
        if (c.verdict === 'stays_down') {
          down++
          blockers.push(`${h.host} / ${c.name}: ${c.reason}`)
        }
    }
    if (down > 0)
      return {
        status: 'warn',
        detail: `${down} of ${total} running container(s) would stay down after a reboot${broken ? `; ${broken} may come back broken` : ''}.`,
        blockers: blockers.slice(0, 30)
      }
    if (failed.length && total === 0)
      return { status: 'skip', detail: `No Docker host answered: ${failed.join('; ')}` }
    return {
      status: 'pass',
      detail: `All ${total} running container(s) come back after a reboot${broken ? `; ${broken} depend on a remote mount Docker does not wait for` : ''}.`
    }
  }
}

export const hostHungIoCheck: ReadinessCheck = {
  id: 'host-hung-io',
  label: 'No host is stuck waiting on IO',
  group: 'Infrastructure',
  description:
    'Processes stuck in D state, kernel hung-task messages, NFS servers that stopped answering and a high load with an idle CPU, from the host facts collector and node_exporter.',
  ttlMs: 2 * 60_000,
  run: async () => {
    const r = await hostsReport()
    if (!r.store) return { status: 'skip', detail: 'The telemetry store is not configured.' }
    const judged = r.hosts.filter((h) => h.hung.level !== 'unknown')
    if (judged.length === 0)
      return { status: 'skip', detail: 'Host facts are not collected on any host yet.' }
    const bad = judged.filter((h) => h.hung.level === 'warning' || h.hung.level === 'critical')
    if (bad.length === 0)
      return { status: 'pass', detail: `${judged.length} host(s), none waiting on IO.` }
    return {
      status: 'warn',
      detail: `${bad.length} host(s) show signs of waiting on IO.`,
      blockers: bad.map((h) => `${h.host}: ${h.hung.headline}`)
    }
  }
}

let checksRegistered = false

export async function infrastructureHostRoutes(app: FastifyInstance): Promise<void> {
  if (!checksRegistered) {
    checksRegistered = true
    registerReadinessCheck(rebootSurvivabilityCheck)
    registerReadinessCheck(hostHungIoCheck)
  }

  app.get('/hosts', async () => ({ data: await hostsReport() }))
  app.get('/reboot', async () => ({ data: await rebootReport() }))
  app.get('/logs', async () => ({ data: await logsReport() }))
}
