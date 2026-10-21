import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { dockerGet, dockerHosts, forEachDockerHost } from '../services/docker-source.js'
import { storeEnabled } from '../services/telemetry-store.js'
import { infrastructureEdgeRoutes } from './infrastructure-edge.js'
import { infrastructureHostRoutes } from './infrastructure-host.js'
import { infrastructureInventoryRoutes } from './infrastructure-inventory.js'

/**
 * Infrastructure (Docker hosts, stacks, containers, the proxy, host health), read-only.
 * Administrators only; nothing here in cloud mode (docker-source returns no hosts there).
 * Each area registers its own routes below under this prefix.
 */
export async function infrastructureRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  // Which sources are configured and whether each Docker host answers.
  app.get('/status', async () => {
    const hosts = await forEachDockerHost(async (h) => {
      const v = await dockerGet<{ Version?: string; ApiVersion?: string }>(h, '/version', {
        cacheMs: 10_000
      })
      const info = await dockerGet<{
        Name?: string
        OperatingSystem?: string
        KernelVersion?: string
        NCPU?: number
        MemTotal?: number
        Swarm?: { LocalNodeState?: string; ControlAvailable?: boolean }
      }>(h, '/info', { cacheMs: 10_000 })
      return {
        engine: v.Version ?? null,
        api: v.ApiVersion ?? null,
        hostname: info.Name ?? null,
        os: info.OperatingSystem ?? null,
        kernel: info.KernelVersion ?? null,
        cpus: info.NCPU ?? null,
        memory_bytes: info.MemTotal ?? null,
        swarm: info.Swarm?.LocalNodeState ?? null,
        manager: !!info.Swarm?.ControlAvailable
      }
    })
    return {
      data: {
        cloud: !!process.env.CLOUD_META_DB_URL,
        docker: { configured: dockerHosts().length > 0, hosts },
        metrics_store: storeEnabled()
      }
    }
  })

  // Area routes (one line each).
  await app.register(infrastructureInventoryRoutes)
  await app.register(infrastructureEdgeRoutes)
  await app.register(infrastructureHostRoutes)
}
