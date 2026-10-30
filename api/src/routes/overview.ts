import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import {
  loadConfigChanges,
  loadFollowing,
  loadHealth,
  loadNeedsYou,
  loadPeopleWaiting,
  loadProblems,
  loadTimeline,
  loadUsage
} from '../services/overview/data.js'

/**
 * The admin Overview page's sections (route `/`), one read each. needs-you, health and following
 * are for everyone and count AS the caller; the rest are administrator-only and refused (403)
 * server-side for anyone else. Read-only and unlogged — a home page someone refreshes.
 */
export async function overviewRoutes(app: FastifyInstance): Promise<void> {
  /** Things waiting on the caller as sentences with one action each. `today` + `tz` = their day. */
  app.get<{ Querystring: { today?: string; tz?: string } }>(
    '/needs-you',
    { preHandler: requireAuth },
    async (req) => ({
      data: await loadNeedsYou(req.user!, !!req.isAdmin, {
        today: req.query?.today,
        tzOffset: req.query?.tz != null ? Number(req.query.tz) : undefined
      })
    })
  )

  /** One line in words: running / slow / down; administrators also get version + readiness. */
  app.get('/health', { preHandler: requireAuth }, async (req) => ({
    data: await loadHealth(!!req.isAdmin)
  }))

  /** Records, collections, field watches and queues the caller follows, with unread counts. */
  app.get('/following', { preHandler: requireAuth }, async (req) => ({
    data: { items: await loadFollowing(req.user!, !!req.isAdmin) }
  }))

  app.get('/timeline', { preHandler: requireAdmin }, async () => ({
    data: await loadTimeline()
  }))

  /** Ranked open problems from jobs, SQL checks and readiness (integrations merge in the UI). */
  app.get('/problems', { preHandler: requireAdmin }, async () => ({
    data: { items: await loadProblems() }
  }))

  app.get('/config-changes', { preHandler: requireAdmin }, async () => ({
    data: { items: await loadConfigChanges(5) }
  }))

  app.get('/people-waiting', { preHandler: requireAdmin }, async () => ({
    data: await loadPeopleWaiting()
  }))

  app.get('/usage', { preHandler: requireAdmin }, async () => ({
    data: await loadUsage()
  }))
}
