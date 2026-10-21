import type { FastifyInstance } from 'fastify'
import {
  loadContainerResources,
  type ResourceWindow,
  resourcesAvailable
} from '../services/container-resources.js'
import { gitlabTarget, loadGitlabHealth } from '../services/gitlab-health.js'
import { loadProxyView, traefikConfigured } from '../services/traefik-source.js'

/**
 * Infrastructure: the proxy (#2834), per-container resources (#2835) and self-hosted GitLab
 * (#2841). Read-only; the parent plugin's requireAdmin hook covers every route here.
 */
export async function infrastructureEdgeRoutes(app: FastifyInstance): Promise<void> {
  // Traefik routers, services, middlewares and shadowing.
  app.get('/proxy', async () => {
    if (!traefikConfigured()) return { data: { configured: false } }
    try {
      return { data: { configured: true, error: null, view: await loadProxyView() } }
    } catch (err) {
      return { data: { configured: true, error: (err as Error).message, view: null } }
    }
  })

  // cAdvisor figures per container, from the telemetry store.
  app.get<{ Querystring: { window?: string } }>('/resources', async (req) => {
    if (!resourcesAvailable()) return { data: { configured: false } }
    const window: ResourceWindow = req.query.window === '7d' ? '7d' : '24h'
    try {
      return {
        data: {
          configured: true,
          window,
          error: null,
          containers: await loadContainerResources(window)
        }
      }
    } catch (err) {
      return { data: { configured: true, window, error: (err as Error).message, containers: [] } }
    }
  })

  // Runners, pending jobs, health and the GitLab container.
  app.get('/gitlab', async () => ({ data: await loadGitlabHealth(await gitlabTarget()) }))
}
