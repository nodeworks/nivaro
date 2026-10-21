import type { FastifyInstance } from 'fastify'
import { dockerConfigured, dockerHostByName, forEachDockerHost } from '../services/docker-source.js'
import {
  type HealthStore,
  loadHealthDetail,
  loadHealthList,
  sampleAllHosts
} from '../services/infra-swarm/health.js'
import { loadSecrets } from '../services/infra-swarm/secrets.js'
import { loadStacks } from '../services/infra-swarm/stacks.js'
import { loadSwarm, readCertMetrics } from '../services/infra-swarm/swarm.js'
import { loadUpdates } from '../services/infra-swarm/updates.js'

/**
 * Stacks (#2826), rolling updates (#2827), healthcheck history (#2828), swarm internals (#2838)
 * and the secret/config usage map (#2839) — all read-only, per Docker host. Registered under
 * /api/infrastructure, whose requireAdmin hook covers every route here.
 */
export async function infrastructureSwarmRoutes(app: FastifyInstance): Promise<void> {
  const store = (): HealthStore | null => (app.redis as unknown as HealthStore) ?? null

  app.get('/stacks', async () => ({ data: { hosts: await forEachDockerHost(loadStacks) } }))

  app.get('/updates', async () => ({
    data: { hosts: await forEachDockerHost((h) => loadUpdates(store(), h)) }
  }))

  app.get('/health', async (_req, reply) => {
    const s = store()
    if (!s) return reply.code(503).send({ error: 'Redis is not available' })
    return { data: { hosts: await forEachDockerHost((h) => loadHealthList(s, h)) } }
  })

  app.get<{ Params: { host: string; container: string } }>(
    '/health/:host/:container',
    async (req, reply) => {
      const host = dockerHostByName(req.params.host)
      if (!host) return reply.code(404).send({ error: 'Unknown Docker host' })
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(req.params.container))
        return reply.code(400).send({ error: 'Invalid container id' })
      const s = store()
      if (!s) return reply.code(503).send({ error: 'Redis is not available' })
      try {
        return { data: await loadHealthDetail(s, host, req.params.container) }
      } catch (err) {
        const status = (err as { status?: number | null }).status
        return reply
          .code(status === 404 ? 404 : 502)
          .send({ error: String((err as Error)?.message ?? err) })
      }
    }
  )

  app.get('/swarm', async () => {
    const certs = await readCertMetrics()
    return {
      data: {
        hosts: await forEachDockerHost((h) => loadSwarm(h, certs)),
        host_facts: certs.size > 0
      }
    }
  })

  app.get('/secrets', async () => ({ data: { hosts: await forEachDockerHost(loadSecrets) } }))

  // #2828 — health transitions between reads. Scheduled only where a Docker host is configured;
  // the scheduler fires it only where cronTicksEnabled().
  if (dockerConfigured() && app.cron) {
    app.cron.schedule(
      'infra-health-sample',
      '*/2 * * * *',
      async () => {
        const s = store()
        if (!s) return
        const r = await sampleAllHosts(s)
        if (r.failed) app.log.warn(`infra-health-sample: ${r.failed} of ${r.hosts} hosts failed`)
      },
      {
        idempotent: 'safe',
        // 720 ticks a day that mostly find nothing new: only failures go to the run history.
        quiet: true,
        description:
          "Every 2 minutes — reads each Docker host's container list and records healthcheck changes (healthy, unhealthy, starting) in a short Redis history per container (3 days), so Infrastructure → Health can say how often a container flapped. Reads only."
      }
    )
  }
}
