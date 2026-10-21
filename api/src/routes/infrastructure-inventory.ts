import type { FastifyInstance } from 'fastify'
import {
  loadContainers,
  loadImages,
  loadProvenance,
  loadVolumes
} from '../services/docker-inventory.js'
import { dockerHosts, forEachDockerHost } from '../services/docker-source.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * Docker inventory (#2830 containers, #2832 volumes, #2833 images, #2840 provenance), read-only.
 * Registered by infrastructure.ts, which carries the requireAdmin hook.
 */
export async function infrastructureInventoryRoutes(app: FastifyInstance): Promise<void> {
  const reply = async <T>(load: (h: Parameters<typeof loadContainers>[0]) => Promise<T>) => ({
    data: {
      configured: dockerHosts().length > 0,
      hosts: await forEachDockerHost(load)
    }
  })

  app.get('/inventory/containers', () => reply(loadContainers))
  app.get('/inventory/volumes', () => reply(loadVolumes))
  app.get('/inventory/images', () => reply(loadImages))
  app.get('/inventory/provenance', async () => {
    const out = await reply(loadProvenance)
    return { data: { ...out.data, version: NIVARO_VERSION } }
  })
}
