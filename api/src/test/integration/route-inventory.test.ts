import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    DB_DATABASE: 'testdb',
    DB_HOST: 'localhost',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: null,
    PUBLIC_URL: 'http://localhost:3055',
    ADMIN_URL: 'http://localhost:3056',
    SESSION_SECRET: 'x'.repeat(32),
    OIDC_ISSUER: 'https://login.example.com',
    OIDC_CLIENT_ID: 'test',
    OIDC_CLIENT_SECRET: 'test',
    OIDC_REDIRECT_URI: 'http://localhost:3055/api/auth/callback',
    STORAGE_LOCAL_ROOT: '/tmp',
  },
}))

import Fastify from 'fastify'

/**
 * Frontend-called routes that MUST exist. This is the regression net for the
 * "refactor silently deleted live routes" bug class (3db6431 removed
 * generate-pdf / generate-and-attach / preview-html while ItemEditForm,
 * GroupSection and TableEditor still called them).
 *
 * When a route here is intentionally removed, delete its caller(s) first,
 * then update this list in the same commit.
 */
const REQUIRED_ROUTES: Array<{ method: string; path: string }> = [
  // Items — core CRUD + relation-path resolution (ItemEditForm, InlineTableField)
  { method: 'GET', path: '/api/items/:collection' },
  { method: 'POST', path: '/api/items/:collection' },
  { method: 'GET', path: '/api/items/:collection/:id' },
  { method: 'PATCH', path: '/api/items/:collection/:id' },
  { method: 'DELETE', path: '/api/items/:collection/:id' },
  { method: 'GET', path: '/api/items/:collection/resolve-paths' },
  { method: 'GET', path: '/api/items/:collection/:id/resolve-paths' },

  // Files — list/filter (FileM2MField meta batch), serve/download, upload
  { method: 'GET', path: '/api/files/' },
  { method: 'GET', path: '/api/files/:id' },
  { method: 'GET', path: '/api/files/:id/meta' },
  { method: 'POST', path: '/api/files/upload' },

  // Collection layouts — PDF trio (ItemEditForm pdf slot, GroupSection widget,
  // TableEditor preview) + the layout resolution endpoints shared components use
  { method: 'GET', path: '/api/collection-layouts/active' },
  { method: 'GET', path: '/api/collection-layouts/detail/:collection' },
  { method: 'GET', path: '/api/collection-layouts/:id/preview-html' },
  { method: 'POST', path: '/api/collection-layouts/:id/generate-pdf' },
  { method: 'POST', path: '/api/collection-layouts/:id/generate-and-attach' },
  { method: 'PUT', path: '/api/collection-layouts/:id/assignments' },

  // Field config — ItemEditForm schema fetch
  { method: 'GET', path: '/api/field-config/:collection' },

  // Pipelines — instance panel + owners (PipelinePanel, queue sheet)
  { method: 'GET', path: '/api/pipelines/instance/:collection/:item' },
  { method: 'GET', path: '/api/pipelines/instance/:collection/:item/owners' },

  // Queues — worklist reads (QueueWorklist)
  { method: 'GET', path: '/api/queues/:id/items' },
  { method: 'POST', path: '/api/queues/:id/claim' },
  { method: 'POST', path: '/api/queues/:id/release' },

  // Retention / alerts / analytics — this week's insert-identity fixes
  { method: 'POST', path: '/api/retention/' },
  { method: 'POST', path: '/api/retention/:id/run' },
  { method: 'POST', path: '/api/analytics/pageview' },
  { method: 'PATCH', path: '/api/analytics/pageview/:id' },

  // Auth — session + ws token (socket clients)
  { method: 'GET', path: '/api/auth/ws-token' },

  // Batch 2 (2026-07): simulator, chat, reports, forms, SSO discovery
  { method: 'POST', path: '/api/pipelines/simulate' },
  { method: 'POST', path: '/api/ai/chat' },
  { method: 'GET', path: '/api/data-model/:table/fields/:field/impact' },
  { method: 'GET', path: '/api/scheduled-reports/' },
  { method: 'POST', path: '/api/scheduled-reports/:id/run' },
  { method: 'GET', path: '/api/auth/providers' },
  { method: 'GET', path: '/api/submission-forms/public/:token' },

  // Batch 3 (2026-07): timeline, share links, blueprints, AI proposals
  { method: 'GET', path: '/api/timeline/:collection/:item' },
  { method: 'POST', path: '/api/share-links/' },
  { method: 'GET', path: '/api/share-links/for/:collection/:item' },
  { method: 'POST', path: '/api/blueprints/export' },
  { method: 'POST', path: '/api/blueprints/install' },
  { method: 'POST', path: '/api/ai/proposals/:id/approve' },
  { method: 'POST', path: '/api/ai/proposals/:id/reject' },
  { method: 'POST', path: '/api/ai/navigate' },

  // Batch 4 (2026-07): record graph, pipeline flow map + replay, web push
  { method: 'GET', path: '/api/record-graph/:collection/:id' },
  { method: 'GET', path: '/api/pipelines/:id/flow-map' },
  { method: 'GET', path: '/api/pipelines/:id/replay' },
  { method: 'GET', path: '/api/push/vapid-public-key' },
  { method: 'POST', path: '/api/push/subscribe' },
  { method: 'POST', path: '/api/push/unsubscribe' },
  { method: 'GET', path: '/api/push/status' },

  // Batch 5 (2026-07): trash, merge, schema graph, dashboard links, issues
  { method: 'GET', path: '/api/trash/' },
  { method: 'POST', path: '/api/trash/:id/restore' },
  { method: 'GET', path: '/api/merge/preview' },
  { method: 'POST', path: '/api/merge/' },
  { method: 'GET', path: '/api/data-model/graph-stats' },
  { method: 'POST', path: '/api/dashboard-links/' },
  { method: 'GET', path: '/api/dashboard-links/for/:dashboardId' },
  { method: 'GET', path: '/api/dashboard-links/public/:token' },
  { method: 'GET', path: '/api/journeys/user/:id' },
  { method: 'GET', path: '/api/journeys/days/:id' },

  // Operations tooling (2026-07 batch)
  { method: 'GET', path: '/api/files/:id/usage' },
  { method: 'GET', path: '/api/files/usage/orphans' },
  { method: 'POST', path: '/api/roles/:id/simulate' },
  { method: 'GET', path: '/api/backups/export' },
  { method: 'GET', path: '/api/backups/manifest' },
  { method: 'POST', path: '/api/promotion/export' },
  { method: 'POST', path: '/api/promotion/preview' },
  { method: 'POST', path: '/api/promotion/apply' },
  { method: 'POST', path: '/api/issues/client' },

  // Comments / tasks — panels
  { method: 'GET', path: '/api/comments/' },
  { method: 'POST', path: '/api/comments/' },
  { method: 'GET', path: '/api/tasks/' },
]

describe('Route inventory — frontend-called routes must exist', () => {
  it('registers every required route', async () => {
    const app = Fastify({ logger: false })
    const seen = new Set<string>()
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const m of methods) seen.add(`${m} ${route.path}`)
    })

    const { registerRoutes } = await import('../../routes/index.js')
    await app.register(registerRoutes, { prefix: '/api' })
    await app.ready()

    const missing = REQUIRED_ROUTES.filter((r) => {
      // Fastify may register '/x' and '/x/' variants — accept either
      const key = `${r.method} ${r.path}`
      const alt = r.path.endsWith('/')
        ? `${r.method} ${r.path.slice(0, -1)}`
        : `${r.method} ${r.path}/`
      return !seen.has(key) && !seen.has(alt)
    })

    if (missing.length > 0) {
      const inventory = [...seen].sort().join('\n')
      throw new Error(
        `Missing ${missing.length} required route(s):\n` +
          missing.map((r) => `  ${r.method} ${r.path}`).join('\n') +
          `\n\nRegistered routes:\n${inventory}`
      )
    }
    expect(missing).toHaveLength(0)
    await app.close()
  }, 60_000)
})
