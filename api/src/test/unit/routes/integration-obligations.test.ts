import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same route-harness idiom as transition-requirements.test.ts. Neither
// handler this file exercises is ever invoked over HTTP — only the note
// source's onReady side effect is under test — but the route file's module
// scope still references these at import time.
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  }),
  requireAuth: vi.fn(async (req: { user?: { id: string; role?: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-user', role: 'user' }
    req.isAdmin = false
  })
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { relatedNoteRegistry } from '../../../extensions/related-notes.js'
import { integrationObligationsRoutes } from '../../../routes/integration-obligations.js'
import { clearObligationKinds, registerObligationKind } from '../../../services/integration-obligations.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(integrationObligationsRoutes, { prefix: '/integration-obligations' })
  return app
}

afterEach(() => {
  vi.clearAllMocks()
  clearObligationKinds()
  // relatedNoteRegistry is a module-level singleton with no per-test reset
  // of its own — clean up what this file's one test registers so a later
  // test file (or a future test added here) never sees a stale provider.
  relatedNoteRegistry.unregister('integrations:workflows')
})

// One app instance, one test: the note-source registration function is
// guarded by a module-level boolean (same pattern as
// registerIntegrationObligationsReadiness in the route file) — in
// production that is correct, since integrationObligationsRoutes registers
// exactly once, on the one long-lived app. A second Fastify() instance in a
// second `it()` block would find the guard already tripped and never get
// its own onReady hook attached at all, which would make a "nothing
// registers with no kinds" test pass for the wrong reason. One scenario,
// asserted at both points in the lifecycle, covers the real behavior.
describe('integrationObligationsRoutes — Notes-thread source registration', () => {
  it('registers a provider per collection with an obligation kind, deferred until the app is ready', async () => {
    registerObligationKind({
      api: 'Partner',
      kind: 'wf.state',
      collection: 'workflows',
      label: 'Workflow state',
      expect: async () => []
    })

    const app = buildApp()
    // The registration is a deferred onReady hook, not a side effect of
    // app.register() itself — this is the whole point of round 1's fix
    // (server.ts's self-hosted-only onReady never runs in cloud mode; this
    // plugin's onReady hook always does, but it still has to wait for
    // loadExtensions()/loadCloudExtensions() to finish before it can
    // snapshot allObligationKinds()).
    expect(relatedNoteRegistry.get('integrations:workflows')).toBeUndefined()

    await app.ready()

    expect(relatedNoteRegistry.get('integrations:workflows')).toBeDefined()
    expect(relatedNoteRegistry.get('integrations:workflows')?.collection).toBe('workflows')
  })
})
