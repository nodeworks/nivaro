import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as any }))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'ADMIN-1' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../config.js', () => ({ config: { NODE_ENV: 'test' } }))
vi.mock('../../../db/index.js', () => ({
  db: new Proxy(() => {}, {
    apply: (_t, _this, args: unknown[]) => h.db(...args),
    get: (_t, p) => h.db[p]
  })
}))
vi.mock('../../../extensions/loader.js', () => {
  const host = {
    runs_on: 'host',
    command: ['bash', 'extensions/efp-ops/scripts/job.sh'],
    dry_args: ['--dry'],
    go_args: [],
    target_env: 'TARGET',
    refuse_targets: ['EFP']
  }
  return {
    extensionRunbooks: new Map([
      [
        'efp-ops',
        [
          { ...host, key: 'quality-rerun', label: 'Re-run', skip_dry_gate: true },
          { ...host, key: 'staging-rebuild', label: 'Rebuild' }
        ]
      ]
    ])
  }
})

import { createTestDb } from '@nivaro/extension-kit'
import { runbookRoutes } from '../../../routes/runbooks.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(runbookRoutes, { prefix: '/runbooks' })
  return app
}

const go = (key: string, extra: Record<string, unknown> = {}) =>
  buildApp().inject({
    method: 'POST',
    url: `/runbooks/efp-ops/${key}/runs`,
    payload: { mode: 'go', target: 'EFP_Staging', ...extra }
  })

beforeEach(() => {
  h.db = createTestDb({
    tables: { nivaro_runbook_queue: [], nivaro_runbook_agents: [], nivaro_runbook_step_timings: [] }
  })
})

describe('runbooks route — skip_dry_gate', () => {
  it('does not ask a skip_dry_gate runbook for a dry run, but still asks for confirm', async () => {
    const res = await go('quality-rerun')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('type EFP_Staging to confirm')
    const ok = await go('quality-rerun', { confirm: 'EFP_Staging' })
    expect(ok.statusCode).toBe(201)
    expect(h.db.state.tables.nivaro_runbook_queue).toHaveLength(1)
  })

  it('still refuses a real run of any other runbook without a dry run', async () => {
    const res = await go('staging-rebuild', { confirm: 'EFP_Staging' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/dry run/)
    expect(h.db.state.tables.nivaro_runbook_queue).toHaveLength(0)
  })
})
