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
    command: ['bash', 'extensions/acme-ops/scripts/job.sh'],
    dry_args: ['--dry'],
    go_args: [],
    target_env: 'TARGET',
    refuse_targets: ['Prod_DB']
  }
  return {
    extensionRunbooks: new Map([
      [
        'acme-ops',
        [
          { ...host, key: 'checks-rerun', label: 'Re-run', skip_dry_gate: true },
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
    url: `/runbooks/acme-ops/${key}/runs`,
    payload: { mode: 'go', target: 'Mirror_DB', ...extra }
  })

beforeEach(() => {
  h.db = createTestDb({
    tables: { nivaro_runbook_queue: [], nivaro_runbook_agents: [], nivaro_runbook_step_timings: [] }
  })
})

describe('runbooks route — skip_dry_gate', () => {
  it('does not ask a skip_dry_gate runbook for a dry run, but still asks for confirm', async () => {
    const res = await go('checks-rerun')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('type Mirror_DB to confirm')
    const ok = await go('checks-rerun', { confirm: 'Mirror_DB' })
    expect(ok.statusCode).toBe(201)
    expect(h.db.state.tables.nivaro_runbook_queue).toHaveLength(1)
  })

  it('still refuses a real run of any other runbook without a dry run', async () => {
    const res = await go('staging-rebuild', { confirm: 'Mirror_DB' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/dry run/)
    expect(h.db.state.tables.nivaro_runbook_queue).toHaveLength(0)
  })

  it('refuses a dry run of a skip_dry_gate runbook (it has none: it would run for real)', async () => {
    const res = await go('checks-rerun', { mode: 'dry' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('this runbook has no dry run — it only reads its target')
    expect(h.db.state.tables.nivaro_runbook_queue).toHaveLength(0)
  })

  it('lists skip_dry_gate on every runbook', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/runbooks' })
    const list = res.json().runbooks as Array<{ key: string; skip_dry_gate: boolean }>
    expect(list.find((r) => r.key === 'checks-rerun')?.skip_dry_gate).toBe(true)
    expect(list.find((r) => r.key === 'staging-rebuild')?.skip_dry_gate).toBe(false)
  })
})

