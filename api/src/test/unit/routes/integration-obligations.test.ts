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

import { db } from '../../../db/index.js'
import { relatedNoteRegistry } from '../../../extensions/related-notes.js'
import { integrationObligationsRoutes } from '../../../routes/integration-obligations.js'
import {
  clearObligationKinds,
  registerObligationKind
} from '../../../services/integration-obligations.js'
import { runReadinessChecks } from '../../../services/readiness.js'

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

// ─── I4: the scorecard counts `failed`, and says something true ────────────

describe('the integration-obligations readiness check', () => {
  const mockedDb = () => vi.mocked(db as unknown as (table: string) => unknown)

  /** The grouped counts query, then the narrow "gave up" count. */
  function mockLedger(groups: unknown[], gaveUp: number) {
    const grouped: Record<string, unknown> = {
      select: vi.fn(),
      count: vi.fn(),
      min: vi.fn(),
      whereIn: vi.fn(),
      groupBy: vi.fn().mockResolvedValue(groups)
    }
    for (const k of ['select', 'count', 'min', 'whereIn']) {
      ;(grouped[k] as ReturnType<typeof vi.fn>).mockReturnValue(grouped)
    }
    const gaveUpChain: Record<string, unknown> = {
      where: vi.fn(),
      count: vi.fn(),
      first: vi.fn().mockResolvedValue({ c: gaveUp })
    }
    for (const k of ['where', 'count']) {
      ;(gaveUpChain[k] as ReturnType<typeof vi.fn>).mockReturnValue(gaveUpChain)
    }
    const queue: unknown[] = [grouped, gaveUpChain]
    mockedDb().mockImplementation(((table: string) => {
      if (table !== 'nivaro_integration_obligations') throw new Error(`unexpected: ${table}`)
      return queue.shift() ?? gaveUpChain
    }) as never)
  }

  async function runCheck() {
    const app = buildApp()
    await app.ready()
    registerObligationKind({
      api: 'Partner',
      kind: 'push',
      collection: 'workflows',
      label: 'x',
      expect: async () => []
    })
    const report = await runReadinessChecks()
    await app.close()
    return report.checks.find((c) => c.id === 'integration-obligations-health')
  }

  const day = new Date(Date.now() - 86_400_000 * 2)

  it('WARNS on failed rows, which used to read as a clean PASS', async () => {
    mockLedger([{ api: 'Partner', kind: 'push', outcome: 'failed', c: 100, oldest: new Date() }], 0)
    const r = await runCheck()
    expect(r?.status).toBe('warn')
    expect(r?.detail).toBe('100 unmet obligation(s) — failed, overdue or missing.')
  })

  it('FAILS on a row remediation gave up on over a day ago', async () => {
    mockLedger([{ api: 'Partner', kind: 'push', outcome: 'failed', c: 3, oldest: day }], 3)
    const r = await runCheck()
    expect(r?.status).toBe('fail')
    expect(r?.detail).toMatch(/3 given up on and older than 24 hours/)
    expect(r?.blockers?.some((b) => /gave up on, older than 24 hours/.test(b))).toBe(true)
  })

  it('FAILS on a missing row older than a day, as it always did', async () => {
    mockLedger([{ api: 'Partner', kind: 'push', outcome: 'missing', c: 1, oldest: day }], 0)
    const r = await runCheck()
    expect(r?.status).toBe('fail')
    expect(r?.detail).toMatch(/"missing" group\(s\) older than 24 hours/)
  })

  it('PASSES with wording that claims nothing about a window it does not query', async () => {
    mockLedger([], 0)
    const r = await runCheck()
    expect(r?.status).toBe('pass')
    expect(r?.detail).toBe('No open failed, overdue or missing obligations.')
  })
})
